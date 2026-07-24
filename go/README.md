# anyhook (Go)

A Go port of [anyhook](../README.md), a runtime-agnostic webhook delivery
engine: fan-out, Standard Webhooks signing, jittered-backoff retry,
per-endpoint circuit-breaking, and dead-lettering, behind a small set of
injected ports (interfaces) so the delivery logic never touches a broker or
database SDK directly.

This is a faithful behavioral port of the TypeScript implementation under
[`packages/`](../packages) (`@anyhook/core`, `@anyhook/signing`,
`@anyhook/testing`); the TypeScript code remains the source of truth. This Go
module ships at **M1 parity**: the core delivery engine, SSRF policy,
Standard Webhooks signing, and the in-memory testing harness. The AWS runtime
adapters (DynamoDB `StateStore`, SQS/SNS `Transport`, EventBridge
`Scheduler`) are a separate, later track and are not part of this module yet.

- **Module path:** `github.com/sns45/anyhook/go`
- **Go:** 1.23+
- **Version:** 0.1.0 (M1 parity: core + signing + testing)

## Install

```bash
go get github.com/sns45/anyhook/go@latest
```

`core` has zero runtime dependencies beyond the standard library (mirrors the
TS `@anyhook/core` "zero-runtime-dep" goal, G1); `signing` and `testing` are
also standard-library only.

## Layout

```
go/
  core/      ports (interfaces), domain types, retry/jitter/circuit/outcome
             policy, SSRF URL policy, fan-out, id/idempotency-key derivation,
             DeliverOnce, and the Engine (Send + ProcessMessage)
  signing/   Standard Webhooks HMAC-SHA256 sign/verify, secret generation,
             golden-file wire-format tests, interop vector test
  testing/   in-memory Transport/StateStore/Scheduler, a controllable Clock,
             a seeded Rng, a scriptable MockReceiver, and a RunDeliveries
             harness that drives the in-memory delivery loop to quiescence
```

## Quick start

```go
package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/sns45/anyhook/go/core"
	"github.com/sns45/anyhook/go/signing"
	anyhooktesting "github.com/sns45/anyhook/go/testing"
)

func main() {
	ctx := context.Background()
	clock := anyhooktesting.NewTestClock(0)
	transport := anyhooktesting.NewMemoryTransport()
	scheduler := anyhooktesting.NewMemoryScheduler(transport, clock)
	state := anyhooktesting.NewMemoryStateStore(clock)
	receiver := anyhooktesting.NewMockReceiver(clock)
	receiver.Default = anyhooktesting.ReceiverOK()

	engine := core.NewEngine(core.EngineOptions{
		Transport: transport,
		State:     state,
		Scheduler: scheduler,
		HTTP:      receiver,
		Signer:    signing.CoreSigner{}, // Standard Webhooks signing, from package signing
		Clock:     clock,
		Rng:       anyhooktesting.SeededRng(1),
	})
	if err := engine.Start(ctx); err != nil {
		log.Fatal(err)
	}

	res, err := state.CreateEndpoint(ctx, core.CreateEndpointInput{
		Tenant: "acme", URL: "https://example.com/hook", EventTypes: []string{"order.*"},
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("endpoint %s created, secret %s", res.Endpoint.EndpointID, res.Secret)

	receipt, err := engine.Send(ctx, core.SendEvent{
		Tenant: "acme", Type: "order.created", Payload: json.RawMessage(`{"orderId":"1"}`),
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("accepted %s, fanned out to %d message(s)", receipt.EventID, receipt.MessageCount)

	// Drive the in-memory delivery loop to quiescence (real deployments run a
	// worker off Engine.Start instead).
	if err := anyhooktesting.RunDeliveries(ctx, anyhooktesting.RunOptions{
		Transport: transport, Scheduler: scheduler, Clock: clock,
	}); err != nil {
		log.Fatal(err)
	}
}
```

A production deployment swaps `testing`'s in-memory ports for durable
adapters implementing `core.Transport`, `core.StateStore`, and
`core.Scheduler` (e.g. the AWS track's SQS/SNS, DynamoDB, and EventBridge
adapters) — the `Engine` and `DeliverOnce` code never changes.

## Package overview

### `core`

- **Ports:** `Clock`, `Rng`, `HTTPClient`, `URLPolicy`, `WebhookSigner`,
  `Transport`, `Scheduler`, `StateStore` — every adapter dependency is
  injected; `core` imports no broker/crypto SDK.
- **Types:** `SendEvent`, `Receipt`, `Endpoint`, `CircuitState` /
  `CircuitRecord`, `Message` / `MessageStatus`, `Attempt` / `DlqReason`.
- **Policy:** `DefaultScheduleMs` (`5s, 30s, 2m, 10m, 30m, 1h, 3h, 6h`),
  `NextDelayMs` (full jitter over `[0, base)`, `(0, false)` once the schedule
  is exhausted), `ClassifyOutcome` (2xx delivered; 3xx and non-429 4xx
  permanent; 429/5xx/timeout/network retryable), and the circuit-breaker
  state machine (`InitialCircuit`, `OnFailure`, `OnSuccess`, `CanAttempt`,
  `ToHalfOpen`; default threshold 5, cooldown 30s).
- **Fan-out:** `Subscribes` (exact / `*` / `prefix.*`), `Fanout`,
  `DeriveIdempotencyKey`, `NewID`.
- **SSRF:** `DefaultURLPolicy` blocks non-http(s) schemes and
  loopback/private/link-local targets, including obfuscated IPv4
  (decimal/octal/hex) and full-form IPv6 loopback/unspecified literals.
- **Delivery:** `DeliverOnce` (one signed POST + outcome classification) and
  `Engine` (`Send` — durable accept, never blocks on delivery; `ProcessMessage`
  — circuit gate, deliver, classify, retry/DLQ/circuit update).

### `signing`

Standard Webhooks (`https://www.standardwebhooks.com`) HMAC-SHA256 signing:
`Sign`, `Signer` (multi-secret, space-joined `webhook-signature` for
zero-downtime rotation), `Verify` (±300s tolerance, timing-safe compare),
`GenerateSecret`/`ParseSecret`. `Sign`/`Verify` are byte-for-byte compatible
with the official `standardwebhooks` libraries — see the interop vector test
in `signing/sign_test.go`.

### `testing`

In-memory `MemoryTransport`, `MemoryStateStore` (tenant-scoped, so no query
can ever leak across tenants), `MemoryScheduler`; a controllable `TestClock`
and a seeded `SeededRng`; a scriptable `MockReceiver` (`ReceiverOK`,
`ReceiverFailThenOK(n)`, `ReceiverPermanent(status)`, `ReceiverTimeout`,
`ReceiverNetwork`, `ReceiverSlow(ms)`); and `RunDeliveries`, which drains the
transport and advances the scheduler/clock in lockstep until the system is
quiescent.

> **Naming note:** the package is named `testing` to mirror the TS
> `@anyhook/testing` package and this module's sibling `anyq/go` layout. A
> file that needs both the standard library `testing` package and this one
> must import this package under an alias, e.g.
> `anyhooktesting "github.com/sns45/anyhook/go/testing"` (see
> `go/testing/integration_test.go` for the pattern).

## Differences from the TypeScript design (idiomatic Go)

- **Errors, not exceptions.** `Engine.Send` / `ProcessMessage` and every
  `StateStore`/`Transport`/`Scheduler` method return `error`; `HTTPClient`,
  `URLPolicy`, and `WebhookSigner` stay infallible (no error return), mirroring
  the TS ports, which never reject for these three.
- **`context.Context` everywhere** on I/O-shaped ports, in place of any
  implicit cancellation.
- **`AttemptStatus`** is an `int` with two negative sentinels
  (`StatusTimeout = -1`, `StatusNetwork = -2`) standing in for the TS union
  type `number | 'timeout' | 'network'` (Go has no built-in union type; real
  HTTP status codes are always non-negative).
- **`json.RawMessage` payloads.** `SendEvent.Payload` and `Message.Payload`
  are `json.RawMessage` rather than `any`, so the wire body used for HMAC
  signing and idempotency-key derivation is byte-for-byte deterministic —
  the same design choice anyq's Go port makes for message bodies. Callers
  holding a Go value marshal it first: `json.Marshal(v)`. `DeriveIdempotencyKey`
  builds the idempotency key from `tenant + " " + type + " " + string(payload)`
  rather than re-marshaling a Go value (Go's `encoding/json` sorts map keys,
  which V8's `JSON.stringify` does not — matching the TS byte-for-byte here
  isn't possible in general, and isn't required: no cross-language vector
  depends on it).
- **`signing.Verify` returns raw bytes, not `any`.** The TS `verify()`
  returns `JSON.parse()`'d `unknown`; `Verify` returns the validated raw body
  bytes so the caller `json.Unmarshal`s into its own type — more idiomatic Go.
- **Response snippets are byte-sliced, not UTF-16-code-unit-sliced.**
  `DeliverOnce`'s `RespSnippet` truncates with Go's byte-indexed string
  slicing; the TS `.slice(0, limit)` truncates by UTF-16 code unit. Both
  truncate at the same *count*, but a truncation that lands mid-multibyte
  UTF-8 character can differ from a truncation landing mid-surrogate-pair —
  an edge case only reachable with non-ASCII response bodies right at the
  512-byte snippet boundary.
- **No optional/default parameters.** Go has none; `EngineOptions`,
  `URLPolicyOptions`, `DeliverPorts`, etc. use zero-value defaults
  (`0`/`nil`/`""` means "unset, apply the default") instead of the TS
  `= defaultValue` parameter syntax.
- **Portal/HTTP router deferred.** The TS `packages/core/src/portal/*`
  (a framework-agnostic `Request -> Response` router plus `EndpointApi` /
  `DeliveryApi` wrappers around `StateStore`) is out of scope for this M1 Go
  port; `core.StateStore` already exposes every operation those wrappers
  need, so adding a Go router later is additive, not a breaking change.

## Testing

```bash
cd go
go test ./...                          # unit + integration tests, no network
go test -race ./...                    # same, with the race detector
go test ./signing/... -run TestGolden -update   # regenerate signing/testdata/*.golden after an intentional wire-format change
```

Notable coverage:

- **Signing interop vector** (`signing/sign_test.go`): `Sign` reproduces an
  exact signature generated by the official-compatible TS signer, proving
  byte-identical wire compatibility with the `standardwebhooks` ecosystem.
- **Golden wire-format files** (`signing/golden_test.go`,
  `signing/testdata/*.golden`): lock down the full Standard Webhooks header
  set for a few fixed inputs; the `-update` flag is a deliberate anyhook
  addition on top of the TS test suite (which has no golden-file harness).
- **Message-level isolation (G3)** and **cross-tenant no-leak (G7)**
  (`testing/integration_test.go`): a healthy and a permanently-failing
  endpoint fed by the same event must resolve completely independently, and
  no tenant's state is ever visible under another tenant's key.
- **MockReceiver matrix** (`testing/integration_test.go`): `ok` → delivered
  in 1 attempt; `failThenOk(1)` → delivered in 2; `permanent(404)` → dead
  `permanent_4xx` in 1 attempt; `timeout` → dead `exhausted_retries` after the
  full retry schedule.
- **SSRF hardening** (`core/urlpolicy_test.go`): obfuscated IPv4
  (decimal/octal/hex) and full-form IPv6 loopback/unspecified literals are
  refused, not just the plain dotted-decimal/compressed forms.

## Versioning & release tags

This module lives in the `go/` subdirectory of a polyglot repo, so its semver
tags are prefixed with the subdirectory: `go/v0.1.0`. `go get
github.com/sns45/anyhook/go@v0.1.0` resolves it transparently, because the
module path ends in `/go`.
