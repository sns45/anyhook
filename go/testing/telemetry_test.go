package testing_test

import (
	"context"
	"testing"

	"github.com/sns45/anyhook/go/core"
	"github.com/sns45/anyhook/go/signing"
	anyhooktesting "github.com/sns45/anyhook/go/testing"
)

// capturingTelemetry is a core.Telemetry sink that records every attempt it
// is given, for assertions in these tests.
type capturingTelemetry struct {
	seen []core.Attempt
}

// RecordAttempt implements core.Telemetry.
func (c *capturingTelemetry) RecordAttempt(a core.Attempt) {
	c.seen = append(c.seen, a)
}

// newTelemetryHarness builds a harness wired like newHarness but with a
// caller-supplied Telemetry sink (and optional circuit override), so tests
// can observe every attempt emitted to telemetry (§11) independent of the
// delivery log.
func newTelemetryHarness(t *testing.T, seed uint32, telemetry core.Telemetry, circuit *core.CircuitConfig) *harness {
	t.Helper()
	clock := anyhooktesting.NewTestClock(1_000)
	transport := anyhooktesting.NewMemoryTransport()
	scheduler := anyhooktesting.NewMemoryScheduler(transport, clock)
	state := anyhooktesting.NewMemoryStateStore(clock)
	receiver := anyhooktesting.NewMockReceiver(clock)

	engine := core.NewEngine(core.EngineOptions{
		Transport: transport,
		State:     state,
		Scheduler: scheduler,
		HTTP:      receiver,
		Signer:    signing.CoreSigner{},
		Telemetry: telemetry,
		Clock:     clock,
		Rng:       anyhooktesting.SeededRng(seed),
		Circuit:   circuit,
	})
	if err := engine.Start(context.Background()); err != nil {
		t.Fatalf("engine.Start: %v", err)
	}
	return &harness{engine: engine, transport: transport, state: state, scheduler: scheduler, clock: clock, receiver: receiver}
}

// TestTelemetryEmitsOneAttemptPerDeliveryDelivered mirrors
// packages/core/test/telemetry.test.ts "emits one attempt per delivery with
// outcome=delivered".
func TestTelemetryEmitsOneAttemptPerDeliveryDelivered(t *testing.T) {
	tel := &capturingTelemetry{}
	h := newTelemetryHarness(t, 21, tel, nil)
	url := "https://x/hook"
	h.receiver.On(url, anyhooktesting.ReceiverOK())
	h.createEndpoint(t, "acme", url, "*")
	h.send(t, "acme", "e.t", `{}`)
	if _, err := h.transport.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}

	if len(tel.seen) != 1 {
		t.Fatalf("seen = %d attempts, want 1", len(tel.seen))
	}
	if tel.seen[0].Outcome != core.AttemptDelivered {
		t.Errorf("seen[0].Outcome = %v, want delivered", tel.seen[0].Outcome)
	}
	if tel.seen[0].Tenant != "acme" || tel.seen[0].EventType != "e.t" {
		t.Errorf("seen[0] = %+v, want tenant=acme eventType=e.t", tel.seen[0])
	}
}

// TestTelemetryEmitsRetriedThenDelivered mirrors the TS "emits retried then
// delivered for a 500-then-200" case.
func TestTelemetryEmitsRetriedThenDelivered(t *testing.T) {
	tel := &capturingTelemetry{}
	h := newTelemetryHarness(t, 22, tel, &core.CircuitConfig{FailureThreshold: 100})
	url := "https://x/hook"
	h.receiver.On(url, anyhooktesting.ReceiverFailThenOK(1))
	h.createEndpoint(t, "acme", url, "*")
	h.send(t, "acme", "e.t", `{}`)
	h.run(t)

	want := []core.AttemptOutcome{core.AttemptRetried, core.AttemptDelivered}
	if len(tel.seen) != len(want) {
		t.Fatalf("seen = %d attempts, want %d", len(tel.seen), len(want))
	}
	for i, w := range want {
		if tel.seen[i].Outcome != w {
			t.Errorf("seen[%d].Outcome = %v, want %v", i, tel.seen[i].Outcome, w)
		}
	}
}

// TestTelemetryEmitsDeadForPermanent4xx mirrors the TS "emits dead for a
// permanent 404" case.
func TestTelemetryEmitsDeadForPermanent4xx(t *testing.T) {
	tel := &capturingTelemetry{}
	h := newTelemetryHarness(t, 23, tel, nil)
	url := "https://x/hook"
	h.receiver.On(url, anyhooktesting.ReceiverPermanent(404))
	h.createEndpoint(t, "acme", url, "*")
	h.send(t, "acme", "e.t", `{}`)
	if _, err := h.transport.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}

	if len(tel.seen) != 1 {
		t.Fatalf("seen = %d attempts, want 1", len(tel.seen))
	}
	if tel.seen[0].Outcome != core.AttemptDead {
		t.Errorf("seen[0].Outcome = %v, want dead", tel.seen[0].Outcome)
	}
}

// TestNoopTelemetryIsSafeDefault mirrors the TS "noopTelemetry is a safe
// default (does nothing, does not throw)" case.
func TestNoopTelemetryIsSafeDefault(t *testing.T) {
	core.NoopTelemetry.RecordAttempt(core.Attempt{})
}
