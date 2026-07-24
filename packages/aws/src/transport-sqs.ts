/** @fileoverview SqsTransport: composes @anyq/sqs's producer for send(); Lambda's SQS event source IS the push consumer (D2/P1, A5). @module @anyhook/aws */
import { createSQSProducer, type SQSProducer } from '@anyq/sqs';
import type { Transport, Message } from '@anyhook/core';
import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';

export interface SqsTransportOptions {
  queueUrl: string;
  region?: string;
  endpoint?: string;
}

/**
 * anyhook `Transport` backed by AWS SQS. `send()` composes `@anyq/sqs`'s `createSQSProducer` (P1:
 * transport drivers are named/owned by anyq, never anyhook) for durable, at-least-once enqueue (G5).
 *
 * There is no anyq consumer LOOP here: on AWS, delivery runs on Lambda's native SQS event-source
 * mapping, which is already a push consumer anyq does not need to reimplement (A5). `dispatchRecords`
 * is the seam `deliverHandler` calls once per invocation, mapping each record 1:1 to one
 * `processMessage` call. A record whose handler throws is reported back via `batchItemFailures`
 * (Lambda's `ReportBatchItemFailures` partial-batch-failure mechanism) so ONLY that record is
 * redelivered — we deliberately do NOT let one record's throw fail the whole invocation, which under
 * Lambda's default SQS semantics would redeliver every record in the batch and defeat per-message
 * isolation (G3).
 */
export class SqsTransport implements Transport {
  private readonly producer: SQSProducer<Message>;
  private connected = false;
  private handler?: (m: Message) => Promise<void>;

  constructor(opts: SqsTransportOptions) {
    this.producer = createSQSProducer<Message>({
      queueUrl: opts.queueUrl,
      sqs: { region: opts.region ?? process.env.AWS_REGION ?? 'us-east-1', endpoint: opts.endpoint },
    });
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
  }

  async send(m: Message): Promise<void> {
    await this.ensureConnected();
    await this.producer.publish(m);
  }

  /** Registers the engine's `processMessage` handler; invoked per-record by `dispatchRecords`. */
  async subscribe(handler: (m: Message) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  /**
   * Map one SQS event batch (as delivered to a Lambda by the event-source mapping) to per-record
   * engine deliveries, returning `batchItemFailures` for any record whose handler threw.
   */
  async dispatchRecords(event: SQSEvent, handler?: (m: Message) => Promise<void>): Promise<SQSBatchResponse> {
    const h = handler ?? this.handler;
    if (!h) throw new Error('SqsTransport.dispatchRecords called before subscribe() (and no handler was passed)');

    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      try {
        await h(JSON.parse(record.body) as Message);
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  }
}
