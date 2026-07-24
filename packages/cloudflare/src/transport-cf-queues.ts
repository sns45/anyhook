/** @fileoverview Transport composing @anyq/cloudflare-queues over a Cloudflare Queue binding (G2/G14, A5). @module @anyhook/cloudflare */
import { createCloudflareQueuesProducer, createCloudflareQueuesConsumer } from '@anyq/cloudflare-queues';
import type { Transport, Message } from '@anyhook/core';

/**
 * anyhook `Transport` backed by `@anyq/cloudflare-queues` (A5): the published anyq driver owns the
 * Cloudflare Queues producer/consumer surface, and anyhook composes it rather than reimplementing
 * queueing. `send` publishes via the anyq producer; `dispatchBatch` (called from the Worker's
 * `queue()` export) hands each delivered batch to the anyq consumer, which wraps CF messages as anyq
 * `IMessage`s and drives the registered handler.
 *
 * Per G2 this layer is pure transport: the anyq consumer auto-acks on handler success and routes a
 * handler throw to its retry strategy (transport-level redelivery) — distinct from anyhook's
 * endpoint retry state machine, which lives in the Durable Objects and has already recorded its
 * decision before the handler returns.
 */
export class CfQueuesTransport implements Transport {
  private readonly producer: ReturnType<typeof createCloudflareQueuesProducer<Message>>;
  private readonly consumer: ReturnType<typeof createCloudflareQueuesConsumer<Message>>;
  private producerConnected = false;

  constructor(queue: Queue<Message>) {
    this.producer = createCloudflareQueuesProducer<Message>({ queue });
    this.consumer = createCloudflareQueuesConsumer<Message>({});
  }

  async send(m: Message): Promise<void> {
    if (!this.producerConnected) {
      await this.producer.connect();
      this.producerConnected = true;
    }
    await this.producer.publish(m);
  }

  async subscribe(handler: (m: Message) => Promise<void>): Promise<void> {
    await this.consumer.connect();
    // anyq auto-acks on success; a throw is handled by the driver's retry strategy (G2 redelivery).
    await this.consumer.subscribe(async (message) => {
      await handler(message.body);
    });
  }

  /** Invoked by the Worker's `queue()` export for each delivered batch. */
  async dispatchBatch(batch: MessageBatch<Message>): Promise<void> {
    await this.consumer.processBatch(batch);
  }
}
