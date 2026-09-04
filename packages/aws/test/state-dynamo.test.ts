/** @fileoverview DynamoStateStore behavior against a fake DynamoDB (aws-sdk-client-mock): tenant scoping (G7), circuit optimistic concurrency, idempotency. @module @anyhook/aws (test) */
import { describe, test, expect, beforeEach } from 'bun:test';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { initialCircuit, type Message, type Attempt } from '@anyhook/core';
import { DynamoStateStore, CircuitWriteConflictError } from '../src/state-dynamo.js';
import { tenantPk, circuitSk, idemSk, type Env } from '../src/config.js';
import { createFakeDynamo, conditionalCheckFailed } from './fake-dynamo.js';

const { ddbMock, table, markStale } = createFakeDynamo();

/** GetItem calls this run made against a given SK (unique per test via random ids), for consistency assertions. */
function getReadsForSk(sk: string) {
  return ddbMock
    .commandCalls(GetCommand)
    .filter((c) => (c.args[0].input.Key as { SK?: string } | undefined)?.SK === sk);
}
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));

const env: Env = {
  tableName: 'anyhook',
  queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789/anyhook',
  dueAtIndexName: 'due_at-index',
  ddb,
  sqs: undefined as never, // not exercised by DynamoStateStore
};

let store: DynamoStateStore;

beforeEach(() => {
  table.clear();
  store = new DynamoStateStore(env);
});

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    messageId: `msg_${crypto.randomUUID()}`,
    tenant: 'tenant-a',
    endpointId: 'ep_unset',
    eventId: `evt_${crypto.randomUUID()}`,
    eventType: 'payment.succeeded',
    payload: { hello: 'world' },
    attemptNo: 0,
    status: 'pending',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('DynamoStateStore: endpoint CRUD + tenant scoping (G7)', () => {
  test('createEndpoint returns a secret and is listable', async () => {
    const { endpoint, secret } = await store.createEndpoint({
      tenant: 'tenant-a',
      url: 'https://example.com/hook',
      eventTypes: ['payment.*'],
    });
    expect(secret).toMatch(/^whsec_/);
    expect(endpoint.secrets).toEqual([secret]);
    expect(endpoint.disabled).toBe(false);

    const fetched = await store.getEndpoint('tenant-a', endpoint.endpointId);
    expect(fetched).toEqual(endpoint);

    const listed = await store.listEndpoints('tenant-a');
    expect(listed.some((e) => e.endpointId === endpoint.endpointId)).toBe(true);
  });

  test('matchEndpoints uses core subscribes() (wildcard + dot-wildcard)', async () => {
    const { endpoint } = await store.createEndpoint({
      tenant: 'tenant-a',
      url: 'https://example.com/match',
      eventTypes: ['order.*'],
    });
    const matched = await store.matchEndpoints('tenant-a', 'order.created');
    expect(matched.some((e) => e.endpointId === endpoint.endpointId)).toBe(true);
    const notMatched = await store.matchEndpoints('tenant-a', 'shipment.created');
    expect(notMatched.some((e) => e.endpointId === endpoint.endpointId)).toBe(false);
  });

  test('updateEndpoint patches fields', async () => {
    const { endpoint } = await store.createEndpoint({ tenant: 'tenant-a', url: 'https://example.com/orig', eventTypes: ['a'] });
    const updated = await store.updateEndpoint('tenant-a', endpoint.endpointId, { url: 'https://example.com/new', disabled: true });
    expect(updated.url).toBe('https://example.com/new');
    expect(updated.disabled).toBe(true);
    expect(updated.eventTypes).toEqual(['a']);
  });

  test('rotateSecret keeps the old primary at secrets[1] (dual-secret window)', async () => {
    const { endpoint, secret: original } = await store.createEndpoint({
      tenant: 'tenant-a',
      url: 'https://example.com/rotate',
      eventTypes: ['a'],
    });
    const { secret: rotated } = await store.rotateSecret('tenant-a', endpoint.endpointId);
    expect(rotated).not.toBe(original);
    const fetched = await store.getEndpoint('tenant-a', endpoint.endpointId);
    expect(fetched?.secrets).toEqual([rotated, original]);
  });

  test('deleteEndpoint removes it', async () => {
    const { endpoint } = await store.createEndpoint({ tenant: 'tenant-a', url: 'https://example.com/gone', eventTypes: ['a'] });
    await store.deleteEndpoint('tenant-a', endpoint.endpointId);
    expect(await store.getEndpoint('tenant-a', endpoint.endpointId)).toBeNull();
  });

  test('tenant scoping: tenant B cannot see tenant A endpoints (G7)', async () => {
    const { endpoint } = await store.createEndpoint({ tenant: 'tenant-a', url: 'https://example.com/private', eventTypes: ['a'] });
    expect(await store.getEndpoint('tenant-b', endpoint.endpointId)).toBeNull();
    const listedB = await store.listEndpoints('tenant-b');
    expect(listedB.some((e) => e.endpointId === endpoint.endpointId)).toBe(false);
  });
});

describe('DynamoStateStore: idempotency (conditional PutItem)', () => {
  test('recordEvent: duplicate idemKey returns isNew:false with the original receipt', async () => {
    const idemKey = `idem_${crypto.randomUUID()}`;
    const first = await store.recordEvent('tenant-a', 'evt_1', idemKey);
    expect(first).toEqual({ isNew: true, eventId: 'evt_1', messageCount: 0 });

    await store.finalizeEvent('tenant-a', idemKey, 'evt_1', 3);

    const second = await store.recordEvent('tenant-a', 'evt_should_be_ignored', idemKey);
    expect(second).toEqual({ isNew: false, eventId: 'evt_1', messageCount: 3 });
  });

  test('recordEvent is tenant-scoped: the same idemKey is independent per tenant (G7)', async () => {
    const idemKey = `idem_${crypto.randomUUID()}`;
    const a = await store.recordEvent('tenant-a', 'evt_a', idemKey);
    const b = await store.recordEvent('tenant-b', 'evt_b', idemKey);
    expect(a).toEqual({ isNew: true, eventId: 'evt_a', messageCount: 0 });
    expect(b).toEqual({ isNew: true, eventId: 'evt_b', messageCount: 0 });
  });

  test('recordEvent: the lost-race read-back uses ConsistentRead (leader read, not a replica)', async () => {
    const idemKey = `idem_${crypto.randomUUID()}`;
    await store.recordEvent('tenant-a', 'evt_1', idemKey); // writer A commits the row
    await store.recordEvent('tenant-a', 'evt_2', idemKey); // writer B loses the condition, reads back

    const readbacks = getReadsForSk(idemSk(idemKey));
    expect(readbacks.length).toBeGreaterThan(0);
    expect(readbacks.every((c) => c.args[0].input.ConsistentRead === true)).toBe(true);
  });

  test('recordEvent: a stale read after a lost race must NOT re-fan-out (ConsistentRead beats replica lag)', async () => {
    const idemKey = `idem_${crypto.randomUUID()}`;
    const first = await store.recordEvent('tenant-a', 'evt_a', idemKey);
    expect(first).toEqual({ isNew: true, eventId: 'evt_a', messageCount: 0 });

    // The idempotency row exists on the leader, but a lagging replica has not caught up yet.
    markStale(tenantPk('tenant-a'), idemSk(idemKey));

    // Writer B's conditional PutItem fails (the row exists on the leader), then it reads back. A
    // default read would hit the stale replica, find nothing, and wrongly report isNew:true, a
    // second fan-out of the same event. ConsistentRead hits the leader and returns the real receipt.
    const second = await store.recordEvent('tenant-a', 'evt_b', idemKey);
    expect(second).toEqual({ isNew: false, eventId: 'evt_a', messageCount: 0 });
  });
});

describe('DynamoStateStore: messages, attempts, DLQ', () => {
  test('putMessage + getMessage round-trip', async () => {
    const { endpoint } = await store.createEndpoint({ tenant: 'tenant-a', url: 'https://example.com/msg', eventTypes: ['a'] });
    const m = makeMessage({ tenant: 'tenant-a', endpointId: endpoint.endpointId });
    await store.putMessage(m);
    expect(await store.getMessage('tenant-a', m.messageId)).toEqual(m);
  });

  test('getMessage returns null for an unknown messageId', async () => {
    expect(await store.getMessage('tenant-a', 'msg_does_not_exist')).toBeNull();
  });

  test('appendAttempt + listDeliveries returns attempts attached to the message, in order', async () => {
    const { endpoint } = await store.createEndpoint({ tenant: 'tenant-a', url: 'https://example.com/attempts', eventTypes: ['a'] });
    const m = makeMessage({ tenant: 'tenant-a', endpointId: endpoint.endpointId, eventType: 'attempts.test' });
    await store.putMessage(m);

    const attempt1: Attempt = {
      messageId: m.messageId, endpointId: endpoint.endpointId, tenant: 'tenant-a', eventType: m.eventType,
      attemptNo: 0, status: 500, latencyMs: 12, respSnippet: 'err', ts: Date.now(), outcome: 'retried',
    };
    const attempt2: Attempt = { ...attempt1, attemptNo: 1, status: 200, outcome: 'delivered' };
    await store.appendAttempt(attempt1);
    await store.appendAttempt(attempt2);

    const rows = await store.listDeliveries({ tenant: 'tenant-a', endpointId: endpoint.endpointId, eventType: 'attempts.test' });
    const row = rows.find((r) => r.message.messageId === m.messageId);
    expect(row?.attempts).toEqual([attempt1, attempt2]);
  });

  test('listDeliveries filters by status/eventType/before/after, sorts by createdAt desc, and respects limit', async () => {
    const tenant = `tenant-filter-${crypto.randomUUID()}`;
    const { endpoint } = await store.createEndpoint({ tenant, url: 'https://example.com/filter', eventTypes: ['a'] });
    const older = makeMessage({ tenant, endpointId: endpoint.endpointId, createdAt: 1000, status: 'delivered', eventType: 'x' });
    const middle = makeMessage({ tenant, endpointId: endpoint.endpointId, createdAt: 2000, status: 'dead', eventType: 'x' });
    const newer = makeMessage({ tenant, endpointId: endpoint.endpointId, createdAt: 3000, status: 'delivered', eventType: 'y' });
    await store.putMessage(older);
    await store.putMessage(middle);
    await store.putMessage(newer);

    const byStatus = await store.listDeliveries({ tenant, status: 'delivered' });
    expect(byStatus.map((r) => r.message.messageId).sort()).toEqual([newer.messageId, older.messageId].sort());

    const byEventType = await store.listDeliveries({ tenant, eventType: 'x' });
    expect(byEventType.map((r) => r.message.messageId).sort()).toEqual([older.messageId, middle.messageId].sort());

    const byWindow = await store.listDeliveries({ tenant, after: 1000, before: 3000 });
    expect(byWindow.map((r) => r.message.messageId)).toEqual([middle.messageId]);

    const all = await store.listDeliveries({ tenant });
    expect(all.map((r) => r.message.messageId)).toEqual([newer.messageId, middle.messageId, older.messageId]);

    const limited = await store.listDeliveries({ tenant, limit: 1 });
    expect(limited.map((r) => r.message.messageId)).toEqual([newer.messageId]);
  });

  test('addToDlq + listDlq (endpoint-scoped and tenant-wide)', async () => {
    const tenant = `tenant-dlq-${crypto.randomUUID()}`;
    const { endpoint } = await store.createEndpoint({ tenant, url: 'https://example.com/dlq', eventTypes: ['a'] });
    const m = makeMessage({ tenant, endpointId: endpoint.endpointId, status: 'dead' });
    await store.addToDlq(m, 'exhausted_retries');

    const scoped = await store.listDlq(tenant, endpoint.endpointId);
    expect(scoped).toEqual([{ message: m, reason: 'exhausted_retries' }]);

    const fannedOut = await store.listDlq(tenant);
    expect(fannedOut).toEqual([{ message: m, reason: 'exhausted_retries' }]);
  });
});

describe('DynamoStateStore: circuit (optimistic concurrency, D2)', () => {
  test('getCircuit defaults to initialCircuit(), putCircuit persists', async () => {
    const { endpoint } = await store.createEndpoint({ tenant: 'tenant-a', url: 'https://example.com/circuit', eventTypes: ['a'] });
    expect(await store.getCircuit('tenant-a', endpoint.endpointId)).toEqual(initialCircuit());

    const rec = { state: 'open' as const, consecutiveFailures: 5, openedAt: 12345, cooldownMs: 30_000 };
    await store.putCircuit('tenant-a', endpoint.endpointId, rec);
    expect(await store.getCircuit('tenant-a', endpoint.endpointId)).toEqual(rec);
  });

  test('putCircuit rejects a stale version with CircuitWriteConflictError (conditional write, D2)', async () => {
    const { endpoint } = await store.createEndpoint({ tenant: 'tenant-a', url: 'https://example.com/circuit-conflict', eventTypes: ['a'] });
    // First write succeeds and establishes _version=1.
    await store.putCircuit('tenant-a', endpoint.endpointId, { state: 'closed', consecutiveFailures: 1, cooldownMs: 30_000 });

    // Simulate a concurrent writer winning the race between OUR read and OUR write: register a
    // payload-specific override (matched on this exact circuit row) so DynamoDB rejects THIS
    // PutItem's ConditionExpression even though our code just re-read the version. A generic
    // `rejectsOnce()` is unreliable here because aws-sdk-client-mock's "once" queues are keyed by
    // registration order across the WHOLE test run, not by "next call after this point" — a
    // payload-specific matcher (matched by PK/SK) is the documented, order-independent way to force
    // one specific call to fail (see "Order of mock behaviors" in the aws-sdk-client-mock README).
    ddbMock
      .on(PutCommand, { Item: { PK: tenantPk('tenant-a'), SK: circuitSk(endpoint.endpointId), state: 'open' } } as never)
      .rejects(conditionalCheckFailed());

    await expect(
      store.putCircuit('tenant-a', endpoint.endpointId, { state: 'open', consecutiveFailures: 5, openedAt: 1, cooldownMs: 30_000 }),
    ).rejects.toThrow(CircuitWriteConflictError);

    // The rejected write must not have landed: the record from the first successful write stands.
    expect(await store.getCircuit('tenant-a', endpoint.endpointId)).toEqual({
      state: 'closed',
      consecutiveFailures: 1,
      cooldownMs: 30_000,
    });
  });

  test('putCircuit on a brand-new endpoint uses attribute_not_exists (no prior version to compare)', async () => {
    const rec = { state: 'closed' as const, consecutiveFailures: 0, cooldownMs: 30_000 };
    await store.putCircuit('tenant-a', 'ep_fresh', rec);
    expect(await store.getCircuit('tenant-a', 'ep_fresh')).toEqual(rec);
  });

  test('getCircuit reads with ConsistentRead (canAttempt must not gate on a stale breaker state)', async () => {
    await store.getCircuit('tenant-a', 'ep_cr_get');
    const reads = getReadsForSk(circuitSk('ep_cr_get'));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => c.args[0].input.ConsistentRead === true)).toBe(true);
  });

  test('putCircuit reads the current _version with ConsistentRead (avoid a spurious write conflict)', async () => {
    await store.putCircuit('tenant-a', 'ep_cr_version', { state: 'closed', consecutiveFailures: 0, cooldownMs: 30_000 });
    const reads = getReadsForSk(circuitSk('ep_cr_version'));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => c.args[0].input.ConsistentRead === true)).toBe(true);
  });
});
