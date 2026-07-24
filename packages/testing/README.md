# @anyhook/testing

In-memory test doubles for [anyhook](https://github.com/sns45/anyhook): drive the engine to real outcomes without any infrastructure.

## Install

```bash
npm i -D @anyhook/testing
```

## Overview

- `MemoryTransport` / `MemoryStateStore` / `MemoryScheduler` — in-process implementations of the core ports (tenant-scoped).
- `TestClock` + `seededRng` — deterministic time and jitter.
- `MockReceiver` — a scriptable `HttpClient`: `ok` / `failThenOk(n)` / `permanent(status)` / `timeout` / `slow(ms)`, recording every call.
- `runDeliveries(...)` — drives the drain + scheduled-retry loop to quiescence over the virtual clock.

```ts
import { MemoryTransport, MemoryStateStore, MemoryScheduler, MockReceiver, TestClock, runDeliveries } from '@anyhook/testing';

const clock = new TestClock(0);
const transport = new MemoryTransport();
const receiver = new MockReceiver(clock).on(url, Receiver.failThenOk(1));
// wire into new WebhookEngine({...}), then:
await runDeliveries({ transport, scheduler, clock });
```

Backbone of anyhook's integration tests (message isolation, delivery matrix, cross-tenant no-leak). MIT.
