/** @fileoverview Drives the in-memory delivery loop to quiescence for integration tests. @module @anyhook/testing */
import type { MemoryTransport } from './memory-transport.js';
import type { MemoryScheduler } from './memory-scheduler.js';
import type { TestClock } from './test-clock.js';

export interface RunOptions {
  transport: MemoryTransport;
  scheduler: MemoryScheduler;
  clock: TestClock;
  /** Safety cap on delivery rounds (defends against a non-converging schedule). */
  maxRounds?: number;
}

/**
 * Repeatedly drain the transport, then jump the clock to the next scheduled retry and
 * release it, until nothing is queued or scheduled. This is the in-memory analogue of a
 * worker + the durable scheduler firing over time. Throws if `maxRounds` is exceeded.
 */
export async function runDeliveries(opts: RunOptions): Promise<void> {
  const { transport, scheduler, clock, maxRounds = 200 } = opts;
  for (let round = 0; round < maxRounds; round++) {
    await transport.drain();
    if (scheduler.size === 0) return;
    const next = scheduler.nextDueAt();
    if (next !== undefined) clock.set(next);
    await scheduler.advance();
  }
  throw new Error(`runDeliveries exceeded maxRounds=${maxRounds} (schedule not converging)`);
}
