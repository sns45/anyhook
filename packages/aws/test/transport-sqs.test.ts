/** @fileoverview SqsTransport: send() composes the @anyq/sqs producer; dispatchRecords maps an SQS batch to per-record deliveries with partial-batch-failure reporting. @module @anyhook/aws (test) */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import type { SQSEvent } from 'aws-lambda';
import type { Message } from '@anyhook/core';
import { SqsTransport } from '../src/transport-sqs.js';

// NOTE on why this file does NOT use aws-sdk-client-mock for `send()`: `@anyq/sqs` ships a fully
// bundled `dist/index.js` (its own build inlines `@aws-sdk/client-sqs` rather than keeping it
// external), so the `SQSClient` class it constructs internally is a DIFFERENT class object than the
// one this test could import from `@aws-sdk/client-sqs` — `aws-sdk-client-mock` patches a specific
// class's prototype, so it cannot see calls made through that bundled copy. `state-dynamo.test.ts`
// and `scheduler.test.ts` use `aws-sdk-client-mock` freely because `state-dynamo.ts`/`scheduler.ts`
// construct the AWS SDK clients THIS package imports directly (an injectable `Env`). Here we instead
// run a real local HTTP server standing in for the SQS JSON-protocol endpoint (same technique
// `../../cloudflare/test/http-fetch.test.ts` uses for `fetch`) and assert on the real request it received.

let sqsServer: ReturnType<typeof Bun.serve>;
let received: { body: string }[] = [];

beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  sqsServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      received.push({ body });
      const md5 = createHash('md5').update((JSON.parse(body) as { MessageBody: string }).MessageBody).digest('hex');
      return new Response(JSON.stringify({ MD5OfMessageBody: md5, MessageId: `sqs-${received.length}` }), {
        status: 200,
        headers: { 'content-type': 'application/x-amz-json-1.0' },
      });
    },
  });
});

afterAll(() => sqsServer.stop(true));

function endpoint(): string {
  return `http://127.0.0.1:${sqsServer.port}`;
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    messageId: `msg_${crypto.randomUUID()}`,
    tenant: 'tenant-a',
    endpointId: 'ep_1',
    eventId: `evt_${crypto.randomUUID()}`,
    eventType: 'payment.succeeded',
    payload: { hello: 'world' },
    attemptNo: 0,
    status: 'pending',
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeSqsEvent(records: { messageId: string; body: string }[]): SQSEvent {
  return {
    Records: records.map((r) => ({
      messageId: r.messageId,
      receiptHandle: `rh-${r.messageId}`,
      body: r.body,
      attributes: {
        ApproximateReceiveCount: '1',
        SentTimestamp: '0',
        SenderId: 'test',
        ApproximateFirstReceiveTimestamp: '0',
      },
      messageAttributes: {},
      md5OfBody: 'ignored',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:us-east-1:123456789:anyhook',
      awsRegion: 'us-east-1',
    })),
  } as unknown as SQSEvent;
}

describe('SqsTransport.send: composes the @anyq/sqs producer', () => {
  test('publishes the message onto the configured queue', async () => {
    received = [];
    const queueUrl = `${endpoint()}/123456789/anyhook`;
    const transport = new SqsTransport({ queueUrl, region: 'us-east-1', endpoint: endpoint() });
    const m = makeMessage();
    await transport.send(m);

    expect(received.length).toBe(1);
    const sent = JSON.parse(received[0]!.body) as { QueueUrl: string; MessageBody: string };
    expect(sent.QueueUrl).toBe(queueUrl);
    expect(JSON.parse(sent.MessageBody)).toEqual(m);
  });

  test('reuses the connected producer across multiple sends (connects once)', async () => {
    received = [];
    const transport = new SqsTransport({ queueUrl: `${endpoint()}/123456789/anyhook`, endpoint: endpoint() });
    await transport.send(makeMessage());
    await transport.send(makeMessage());
    expect(received.length).toBe(2);
  });
});

describe('SqsTransport.dispatchRecords: per-record delivery + partial-batch-failure reporting', () => {
  test('maps each record through the subscribed handler', async () => {
    const transport = new SqsTransport({ queueUrl: 'https://q' });
    const seen: string[] = [];
    await transport.subscribe(async (m) => {
      seen.push(m.messageId);
    });

    const m1 = makeMessage({ messageId: 'good-1' });
    const m2 = makeMessage({ messageId: 'good-2' });
    const event = makeSqsEvent([
      { messageId: 'r1', body: JSON.stringify(m1) },
      { messageId: 'r2', body: JSON.stringify(m2) },
    ]);

    const res = await transport.dispatchRecords(event);
    expect(seen).toEqual(['good-1', 'good-2']);
    expect(res.batchItemFailures).toEqual([]);
  });

  test('a throwing record is reported in batchItemFailures; the rest of the batch is unaffected', async () => {
    const transport = new SqsTransport({ queueUrl: 'https://q' });
    const seen: string[] = [];
    await transport.subscribe(async (m) => {
      seen.push(m.messageId);
      if (m.messageId === 'bad') throw new Error('delivery blew up');
    });

    const event = makeSqsEvent([
      { messageId: 'r1', body: JSON.stringify(makeMessage({ messageId: 'good' })) },
      { messageId: 'r2', body: JSON.stringify(makeMessage({ messageId: 'bad' })) },
      { messageId: 'r3', body: JSON.stringify(makeMessage({ messageId: 'good-2' })) },
    ]);

    const res = await transport.dispatchRecords(event);
    expect(seen).toEqual(['good', 'bad', 'good-2']); // every record was attempted; the batch did not short-circuit
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'r2' }]);
  });

  test('an explicit handler argument overrides the subscribed one', async () => {
    const transport = new SqsTransport({ queueUrl: 'https://q' });
    const seen: string[] = [];
    const event = makeSqsEvent([{ messageId: 'r1', body: JSON.stringify(makeMessage({ messageId: 'explicit' })) }]);
    const res = await transport.dispatchRecords(event, async (m) => {
      seen.push(m.messageId);
    });
    expect(seen).toEqual(['explicit']);
    expect(res.batchItemFailures).toEqual([]);
  });

  test('throws if dispatched before subscribe() and no handler is passed', async () => {
    const transport = new SqsTransport({ queueUrl: 'https://q' });
    await expect(transport.dispatchRecords(makeSqsEvent([]))).rejects.toThrow(/subscribe/);
  });
});
