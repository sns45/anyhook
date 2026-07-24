# @anyhook/core

The runtime-agnostic heart of [anyhook](https://github.com/sns45/anyhook): the outbound webhook delivery engine. Defines the ports that adapters implement and owns all webhook-specific logic — fan-out, Standard Webhooks signing hooks, the retry/backoff + circuit-breaker + DLQ state machine, the delivery log, and the portal HTTP router.

**Zero runtime-SDK dependencies.** Core defines interfaces; `@anyhook/cloudflare` / `@anyhook/aws` implement them. This is what makes the engine portable.

## Install

```bash
npm i @anyhook/core
```

## Overview

- **Ports** (`Transport`, `StateStore`, `Scheduler`, `HttpClient`, `WebhookSigner`, `UrlPolicy`, `Clock`, `Rng`) — injected by an adapter.
- **`WebhookEngine`** — `send()` (async acceptance, never blocks on delivery) + `processMessage()` (deliver → classify → retry/DLQ/circuit).
- **Policy** — backoff schedule with full jitter, outcome classification, circuit-breaker state machine.
- **Portal** — endpoint CRUD + delivery-log/replay handlers and a framework-agnostic `createPortalRouter`.
- **Security** — SSRF-safe `defaultUrlPolicy` (blocks private/loopback/link-local + obfuscated-IP targets).

```ts
import { WebhookEngine, createPortalRouter } from '@anyhook/core';

const engine = new WebhookEngine({ transport, state, scheduler, http, signer });
const receipt = await engine.send({ type: 'payment.succeeded', tenant: 'acme', payload });
```

Wire it to a runtime with `@anyhook/cloudflare` or `@anyhook/aws`. MIT.
