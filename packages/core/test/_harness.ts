/** @fileoverview Shared in-memory engine wiring for core integration tests. @module @anyhook/core */
import { WebhookEngine, type RetryConfig, type CircuitConfig, type Telemetry } from '../src/index.js';
import {
  MemoryTransport,
  MemoryScheduler,
  MemoryStateStore,
  TestClock,
  seededRng,
  MockReceiver,
} from '@anyhook/testing';
import { createSigner } from '@anyhook/signing';

export interface Harness {
  engine: WebhookEngine;
  transport: MemoryTransport;
  scheduler: MemoryScheduler;
  state: MemoryStateStore;
  clock: TestClock;
  http: MockReceiver;
}

export function makeEngine(opts?: {
  clock?: TestClock;
  receiver?: MockReceiver;
  retry?: Partial<RetryConfig>;
  circuit?: Partial<CircuitConfig>;
  /** Sign with wall-clock time so delivered headers pass the official ±5min verify tolerance. */
  realClock?: boolean;
  telemetry?: Telemetry;
}): Harness {
  const clock = opts?.clock ?? new TestClock(1_000);
  const transport = new MemoryTransport();
  const scheduler = new MemoryScheduler(transport, clock);
  const state = new MemoryStateStore(clock);
  const http = opts?.receiver ?? new MockReceiver(clock);
  const engineClock = opts?.realClock ? { now: () => Date.now() } : clock;
  const engine = new WebhookEngine({
    transport,
    state,
    scheduler,
    http,
    signer: createSigner(),
    telemetry: opts?.telemetry,
    clock: engineClock,
    rng: seededRng(42),
    retry: opts?.retry,
    circuit: opts?.circuit,
  });
  return { engine, transport, scheduler, state, clock, http };
}
