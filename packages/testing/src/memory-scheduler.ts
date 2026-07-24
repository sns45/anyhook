/** @fileoverview In-memory Scheduler driven by a TestClock. @module @anyhook/testing */
import type { Scheduler, Message } from '@anyhook/core';
import type { MemoryTransport } from './memory-transport.js';
import type { TestClock } from './test-clock.js';

/**
 * Records scheduled retries and re-enqueues them onto the transport once due.
 * Embodies P2 ("the state store is the schedule"): a message is re-delivered only
 * after the clock reaches its scheduled time.
 */
export class MemoryScheduler implements Scheduler {
  private pending: { at: number; m: Message }[] = [];

  constructor(
    private readonly transport: MemoryTransport,
    private readonly clock: TestClock,
  ) {}

  async scheduleRetry(m: Message, at: number): Promise<void> {
    this.pending.push({ at, m: { ...m } });
  }

  /** Re-enqueue every message whose scheduled time is <= now. Returns count released. */
  async advance(): Promise<number> {
    const now = this.clock.now();
    const due = this.pending.filter((p) => p.at <= now);
    this.pending = this.pending.filter((p) => p.at > now);
    for (const p of due) await this.transport.send(p.m);
    return due.length;
  }

  get size(): number {
    return this.pending.length;
  }

  /** Earliest scheduled time still pending, or undefined. */
  nextDueAt(): number | undefined {
    if (this.pending.length === 0) return undefined;
    return Math.min(...this.pending.map((p) => p.at));
  }
}
