/** @fileoverview Transport over Cloudflare Queues (composes @anyq/cloudflare-queues' surface) (G2/G14, A5). @module @anyhook/cloudflare */
import type { Transport, Message } from '@anyhook/core';

/**
 * anyhook `Transport` backed by a Cloudflare Queue binding.
 *
 * This presents the exact producer/consumer surface of `@anyq/cloudflare-queues` (producer =
 * `queue.send`; consumer = per-batch dispatch with ack/retry). Cloudflare Queues is a managed push
 * queue with no queue LOGIC to reimplement, so the wrapper is intentionally thin — anyhook composes
 * anyq's transport abstraction here rather than owning queueing (A5). Once `@anyq/cloudflare-queues`
 * is published to npm, `send`/`dispatchBatch` can delegate to its `createCloudflareQueuesProducer` /
 * `CloudflareQueuesConsumer.processBatch` with no behavior change.
 *
 * Per G2, this layer is pure transport: anyq-level `retry()` redelivery is distinct from anyhook's
 * endpoint retry state machine (which lives in the Durable Objects, never here).
 */
export class CfQueuesTransport implements Transport {
  private handler?: (m: Message) => Promise<void>;

  constructor(private readonly queue: Queue<Message>) {}

  async send(m: Message): Promise<void> {
    await this.queue.send(m);
  }

  async subscribe(handler: (m: Message) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  /**
   * Invoked by the Worker's `queue()` export for each delivered batch. Each message is handed to the
   * engine's `processMessage`; on success it is `ack()`ed, on an unexpected throw it is `retry()`ed
   * (anyq transport-level redelivery — the endpoint-level retry decision was already recorded in the
   * Durable Object before any throw could occur).
   */
  async dispatchBatch(batch: MessageBatch<Message>): Promise<void> {
    if (!this.handler) throw new Error('CfQueuesTransport.dispatchBatch called before subscribe()');
    for (const msg of batch.messages) {
      try {
        await this.handler(msg.body);
        msg.ack();
      } catch {
        msg.retry();
      }
    }
  }
}
