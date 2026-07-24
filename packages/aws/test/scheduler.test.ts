/** @fileoverview DynamoScheduler (900s split, D2) + sweeper claim-before-send behavior. @module @anyhook/aws (test) */
import { describe, test, expect, beforeEach } from 'bun:test';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import type { Message } from '@anyhook/core';
import { DynamoScheduler } from '../src/scheduler.js';
import { runSweeper } from '../src/sweeper.js';
import { tenantPk, schedSk, SCHED_GSI_PK, type Env } from '../src/config.js';
import { createFakeDynamo, conditionalCheckFailed } from './fake-dynamo.js';

const { ddbMock, table, keyOf } = createFakeDynamo();
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const sqsMock = mockClient(SQSClient);
const sqs = new SQSClient({ region: 'us-east-1' });

const env: Env = {
  tableName: 'anyhook',
  queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789/anyhook',
  dueAtIndexName: 'due_at-index',
  ddb,
  sqs,
};

beforeEach(() => {
  table.clear();
  sqsMock.reset();
  sqsMock.on(SendMessageCommand).resolves({ MessageId: 'sqs-msg-id' });
});

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    messageId: `msg_${crypto.randomUUID()}`,
    tenant: 'tenant-a',
    endpointId: 'ep_1',
    eventId: `evt_${crypto.randomUUID()}`,
    eventType: 'payment.succeeded',
    payload: { hello: 'world' },
    attemptNo: 1,
    status: 'retrying',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('DynamoScheduler.scheduleRetry: the 900-second split (D2, no delay-chaining)', () => {
  test('delay <= 900s: sends to SQS with native DelaySeconds, no DynamoDB row', async () => {
    const scheduler = new DynamoScheduler(env, { now: () => 1_000_000 });
    const m = makeMessage();
    await scheduler.scheduleRetry(m, 1_000_000 + 500_000); // 500s out

    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls.length).toBe(1);
    expect(calls[0]!.args[0].input.QueueUrl).toBe(env.queueUrl);
    expect(calls[0]!.args[0].input.DelaySeconds).toBe(500);
    expect(JSON.parse(calls[0]!.args[0].input.MessageBody as string).messageId).toBe(m.messageId);

    expect(table.has(keyOf(tenantPk(m.tenant), schedSk(m.messageId)))).toBe(false);
  });

  test('delay exactly at the 900s boundary still uses SQS DelaySeconds (<=, not <)', async () => {
    const scheduler = new DynamoScheduler(env, { now: () => 1_000_000 });
    const m = makeMessage();
    await scheduler.scheduleRetry(m, 1_000_000 + 900_000);

    expect(sqsMock.commandCalls(SendMessageCommand).length).toBe(1);
    expect(sqsMock.commandCalls(SendMessageCommand)[0]!.args[0].input.DelaySeconds).toBe(900);
  });

  test('delay > 900s: persists a SCHED# row with due_at (epoch seconds) and a GC-only ttl, no SQS send', async () => {
    const scheduler = new DynamoScheduler(env, { now: () => 1_000_000 });
    const m = makeMessage();
    const at = 1_000_000 + 3_600_000; // 1 hour out
    await scheduler.scheduleRetry(m, at);

    expect(sqsMock.commandCalls(SendMessageCommand).length).toBe(0);

    const row = table.get(keyOf(tenantPk(m.tenant), schedSk(m.messageId)));
    expect(row).toBeDefined();
    expect(row!.due_at).toBe(Math.floor(at / 1000));
    expect(row!.gsi1pk).toBe(SCHED_GSI_PK);
    expect(row!.gsi1sk).toBe(Math.floor(at / 1000));
    expect(row!.ttl as number).toBeGreaterThan(row!.due_at as number);
    expect((row!.message as Message).messageId).toBe(m.messageId);
  });
});

describe('runSweeper: conditional-write claim before send (D2/ADR-0001)', () => {
  function seedDueRow(tenant: string, m: Message, dueAtSec: number, extra: Record<string, unknown> = {}) {
    table.set(keyOf(tenantPk(tenant), schedSk(m.messageId)), {
      PK: tenantPk(tenant),
      SK: schedSk(m.messageId),
      message: m,
      due_at: dueAtSec,
      ttl: dueAtSec + 1000,
      gsi1pk: SCHED_GSI_PK,
      gsi1sk: dueAtSec,
      ...extra,
    });
  }

  test('claims a due row, sends it to SQS, and deletes the row', async () => {
    const nowMs = 2_000_000_000;
    const m = makeMessage({ tenant: 'tenant-a' });
    seedDueRow('tenant-a', m, Math.floor(nowMs / 1000) - 10);

    const result = await runSweeper(env, nowMs);
    expect(result).toEqual({ due: 1, claimed: 1, sent: 1 });

    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0]!.args[0].input.MessageBody as string).messageId).toBe(m.messageId);

    // Row is gone: neither a duplicate claim nor a duplicate send can happen on a second pass.
    expect(table.has(keyOf(tenantPk('tenant-a'), schedSk(m.messageId)))).toBe(false);
  });

  test('does not enqueue a row that is not yet due', async () => {
    const nowMs = 2_000_000_000;
    const m = makeMessage({ tenant: 'tenant-a' });
    seedDueRow('tenant-a', m, Math.floor(nowMs / 1000) + 10_000); // far in the future

    const result = await runSweeper(env, nowMs);
    expect(result).toEqual({ due: 0, claimed: 0, sent: 0 });
    expect(sqsMock.commandCalls(SendMessageCommand).length).toBe(0);
  });

  test('a row already marked claimed (by a prior/concurrent run) is skipped entirely: no re-claim, no re-send', async () => {
    const nowMs = 2_000_000_000;
    const m = makeMessage({ tenant: 'tenant-a' });
    seedDueRow('tenant-a', m, Math.floor(nowMs / 1000) - 10, { claimed: true });

    const result = await runSweeper(env, nowMs);
    expect(result).toEqual({ due: 0, claimed: 0, sent: 0 });
    expect(sqsMock.commandCalls(SendMessageCommand).length).toBe(0);
  });

  test('losing the claim race (ConditionalCheckFailedException on the claim UpdateItem) does not double-send', async () => {
    const nowMs = 2_000_000_000;
    const m = makeMessage({ tenant: 'tenant-a' });
    seedDueRow('tenant-a', m, Math.floor(nowMs / 1000) - 10);

    // Simulate a concurrent sweeper invocation winning the claim first: register a payload-specific
    // override (matched by this row's exact PK/SK) so its claim UpdateItem is rejected, exactly as
    // DynamoDB would reject a losing compare-and-set on `attribute_not_exists(claimed)`. A generic
    // `rejectsOnce()` is unreliable here — see the note in state-dynamo.test.ts's circuit-conflict
    // test — so this uses the same order-independent payload-matcher technique.
    ddbMock
      .on(UpdateCommand, { Key: { PK: tenantPk('tenant-a'), SK: schedSk(m.messageId) } } as never)
      .rejects(conditionalCheckFailed());

    const result = await runSweeper(env, nowMs);
    expect(result).toEqual({ due: 1, claimed: 0, sent: 0 });
    expect(sqsMock.commandCalls(SendMessageCommand).length).toBe(0);

    // The row is untouched by the loser — it's still there for whoever DID win the claim to clean up.
    expect(table.has(keyOf(tenantPk('tenant-a'), schedSk(m.messageId)))).toBe(true);
  });
});
