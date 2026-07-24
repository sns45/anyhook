/** @fileoverview In-memory Transport (anyq stand-in) for tests. @module @anyhook/testing */
import type { Transport, Message } from '@anyhook/core';

/**
 * In-process FIFO transport. `send()` enqueues; `drain()` invokes the subscribed
 * handler for every queued message (including any enqueued while draining).
 */
export class MemoryTransport implements Transport {
  private queue: Message[] = [];
  private handler?: (m: Message) => Promise<void>;

  async send(m: Message): Promise<void> {
    // clone so callers can't mutate an enqueued message in place
    this.queue.push({ ...m });
  }

  async subscribe(handler: (m: Message) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  /** Process all currently-queued messages (and any enqueued during processing). Returns count processed. */
  async drain(): Promise<number> {
    if (!this.handler) throw new Error('MemoryTransport.drain called before subscribe()');
    let count = 0;
    while (this.queue.length > 0) {
      const m = this.queue.shift()!;
      await this.handler(m);
      count++;
    }
    return count;
  }

  get size(): number {
    return this.queue.length;
  }
}
