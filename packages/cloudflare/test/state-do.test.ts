/** @fileoverview DO-backed StateStore + Alarms-scheduler behavior via Miniflare (real workerd, real Durable Objects). @module @anyhook/cloudflare */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Miniflare } from 'miniflare';
import type { Message, Attempt } from '@anyhook/core';
import { initialCircuit } from '@anyhook/core';
import { DoStateStore } from '../src/state-do.js';
import { DoScheduler } from '../src/scheduler-alarms.js';
import type { Env } from '../src/env.js';

let mf: Miniflare;
let store: DoStateStore;
let scheduler: DoScheduler;
let env: Env;
let sink: KVNamespace;

/** Bundle the DO-hosting test-fixture worker fresh on every run (no separate build step needed). */
async function buildFixture(): Promise<string> {
  const entry = new URL('./fixtures/worker.ts', import.meta.url);
  const outdir = new URL('./fixtures/dist/', import.meta.url);
  const result = await Bun.build({
    entrypoints: [entry.pathname],
    outdir: outdir.pathname,
    target: 'bun',
    format: 'esm',
    external: ['cloudflare:workers'],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, 'failed to bundle test/fixtures/worker.ts');
  }
  return new URL('./fixtures/dist/worker.js', import.meta.url).pathname;
}

beforeAll(async () => {
  const scriptPath = await buildFixture();
  mf = new Miniflare({
    modules: true,
    scriptPath,
    compatibilityDate: '2024-11-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: {
      TENANT_INDEX: 'TenantIndexDurableObject',
      ENDPOINT: 'EndpointDurableObject',
    },
    kvNamespaces: ['QUEUE_SINK'],
    queueProducers: { QUEUE: 'anyhook' },
    queueConsumers: ['anyhook'],
  });
  await mf.ready;

  const TENANT_INDEX = await mf.getDurableObjectNamespace('TENANT_INDEX');
  const ENDPOINT = await mf.getDurableObjectNamespace('ENDPOINT');
  const QUEUE = await mf.getQueueProducer('QUEUE');
  sink = await mf.getKVNamespace('QUEUE_SINK');

  env = { TENANT_INDEX, ENDPOINT, QUEUE } as unknown as Env;
  store = new DoStateStore(env);
  scheduler = new DoScheduler(env);
});

afterAll(async () => {
  await mf.dispose();
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

describe('DoStateStore: endpoint CRUD + tenant scoping (G7)', () => {
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
    const { endpoint } = await store.createEndpoint({
      tenant: 'tenant-a',
      url: 'https://example.com/orig',
      eventTypes: ['a'],
    });
    const updated = await store.updateEndpoint('tenant-a', endpoint.endpointId, {
      url: 'https://example.com/new',
      disabled: true,
    });
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
    const { endpoint } = await store.createEndpoint({
      tenant: 'tenant-a',
      url: 'https://example.com/gone',
      eventTypes: ['a'],
    });
    await store.deleteEndpoint('tenant-a', endpoint.endpointId);
    expect(await store.getEndpoint('tenant-a', endpoint.endpointId)).toBeNull();
  });

  test('tenant scoping: tenant B cannot see tenant A endpoints (G7)', async () => {
    const { endpoint } = await store.createEndpoint({
      tenant: 'tenant-a',
      url: 'https://example.com/private',
      eventTypes: ['a'],
    });
    expect(await store.getEndpoint('tenant-b', endpoint.endpointId)).toBeNull();
    const listedB = await store.listEndpoints('tenant-b');
    expect(listedB.some((e) => e.endpointId === endpoint.endpointId)).toBe(false);
  });
});

describe('DoStateStore: idempotency', () => {
  test('recordEvent: duplicate idemKey returns isNew:false with the original receipt', async () => {
    const idemKey = `idem_${crypto.randomUUID()}`;
    const first = await store.recordEvent('tenant-a', 'evt_1', idemKey);
    expect(first).toEqual({ isNew: true, eventId: 'evt_1', messageCount: 0 });

    await store.finalizeEvent('tenant-a', idemKey, 'evt_1', 3);

    const second = await store.recordEvent('tenant-a', 'evt_should_be_ignored', idemKey);
    expect(second).toEqual({ isNew: false, eventId: 'evt_1', messageCount: 3 });
  });
});

describe('DoStateStore: messages, attempts, circuit, DLQ', () => {
  test('putMessage + getMessage round-trip (routes via the message->endpoint index)', async () => {
    const { endpoint } = await store.createEndpoint({
      tenant: 'tenant-a',
      url: 'https://example.com/msg',
      eventTypes: ['a'],
    });
    const m = makeMessage({ tenant: 'tenant-a', endpointId: endpoint.endpointId });
    await store.putMessage(m);
    const fetched = await store.getMessage('tenant-a', m.messageId);
    expect(fetched).toEqual(m);
  });

  test('getMessage returns null for an unknown messageId', async () => {
    expect(await store.getMessage('tenant-a', 'msg_does_not_exist')).toBeNull();
  });

  test('appendAttempt + listDeliveries returns attempts attached to the message', async () => {
    const { endpoint } = await store.createEndpoint({
      tenant: 'tenant-a',
      url: 'https://example.com/attempts',
      eventTypes: ['a'],
    });
    const m = makeMessage({ tenant: 'tenant-a', endpointId: endpoint.endpointId, eventType: 'attempts.test' });
    await store.putMessage(m);
    const attempt: Attempt = {
      messageId: m.messageId,
      endpointId: endpoint.endpointId,
      tenant: 'tenant-a',
      eventType: m.eventType,
      attemptNo: 0,
      status: 500,
      latencyMs: 12,
      respSnippet: 'err',
      ts: Date.now(),
      outcome: 'retried',
    };
    await store.appendAttempt(attempt);

    const rows = await store.listDeliveries({ tenant: 'tenant-a', endpointId: endpoint.endpointId, eventType: 'attempts.test' });
    const row = rows.find((r) => r.message.messageId === m.messageId);
    expect(row).toBeDefined();
    expect(row?.attempts).toEqual([attempt]);
  });

  test('listDeliveries fans out across endpoints when endpointId is omitted, sorted by createdAt desc', async () => {
    const tenant = `tenant-fanout-${crypto.randomUUID()}`;
    const { endpoint: e1 } = await store.createEndpoint({ tenant, url: 'https://example.com/1', eventTypes: ['a'] });
    const { endpoint: e2 } = await store.createEndpoint({ tenant, url: 'https://example.com/2', eventTypes: ['a'] });
    const older = makeMessage({ tenant, endpointId: e1.endpointId, createdAt: 1000 });
    const newer = makeMessage({ tenant, endpointId: e2.endpointId, createdAt: 2000 });
    await store.putMessage(older);
    await store.putMessage(newer);

    const rows = await store.listDeliveries({ tenant });
    const ids = rows.map((r) => r.message.messageId);
    expect(ids.indexOf(newer.messageId)).toBeLessThan(ids.indexOf(older.messageId));
  });

  test('circuit: getCircuit defaults to initialCircuit(), putCircuit persists', async () => {
    const { endpoint } = await store.createEndpoint({
      tenant: 'tenant-a',
      url: 'https://example.com/circuit',
      eventTypes: ['a'],
    });
    const initial = await store.getCircuit('tenant-a', endpoint.endpointId);
    expect(initial).toEqual(initialCircuit());

    const rec = { state: 'open' as const, consecutiveFailures: 5, openedAt: 12345, cooldownMs: 30_000 };
    await store.putCircuit('tenant-a', endpoint.endpointId, rec);
    expect(await store.getCircuit('tenant-a', endpoint.endpointId)).toEqual(rec);
  });

  test('addToDlq + listDlq (endpoint-scoped and tenant-wide fan-out)', async () => {
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

describe('DoScheduler + Alarms: the state store IS the schedule (P2)', () => {
  test('scheduleRetry persists the entry but a far-future retry is NOT due yet', async () => {
    const { endpoint } = await store.createEndpoint({
      tenant: 'tenant-a',
      url: 'https://example.com/sched',
      eventTypes: ['a'],
    });
    const m = makeMessage({ tenant: 'tenant-a', endpointId: endpoint.endpointId, status: 'retrying' });
    const farFuture = Date.now() + 3_600_000;
    await scheduler.scheduleRetry(m, farFuture);

    // Firing "due schedules" right now must be a no-op: the entry is persisted (scheduleRetry
    // resolved without error) but not yet due, so the alarm-fired path must not re-enqueue it.
    const stub = env.ENDPOINT.get(env.ENDPOINT.idFromName(`tenant-a:${endpoint.endpointId}`));
    const result = await stub.processDueSchedules();
    expect(result.enqueued).toBe(0);
  });

  test('a real Durable Object alarm fires and re-enqueues the message onto QUEUE', async () => {
    const { endpoint } = await store.createEndpoint({
      tenant: 'tenant-a',
      url: 'https://example.com/sched-real-alarm',
      eventTypes: ['a'],
    });
    const m = makeMessage({ tenant: 'tenant-a', endpointId: endpoint.endpointId, status: 'retrying', attemptNo: 1 });
    // Due (near) immediately: `scheduleRetry` calls `storage.setAlarm`, and Miniflare's real
    // workerd-backed alarm clock fires it — this is the platform invoking the real `alarm()`
    // method (not a test double), which delegates to `processDueSchedules()` and calls
    // `env.QUEUE.send(...)`. We assert on the effect (the fixture's queue consumer recording the
    // message into KV) because `alarm()` is deliberately excluded from the RPC-callable stub
    // surface, so it can't be awaited directly from the test.
    await scheduler.scheduleRetry(m, Date.now() + 20);

    const found = await waitForQueuedMessage(m.messageId, 10_000);
    expect(found).toBe(true);

    // The alarm already drained everything due for this DO; calling `processDueSchedules()`
    // directly (the same method `alarm()` delegates to) must be safe and idempotent — no crash,
    // nothing left to enqueue.
    const stub = env.ENDPOINT.get(env.ENDPOINT.idFromName(`tenant-a:${endpoint.endpointId}`));
    const result = await stub.processDueSchedules();
    expect(result.enqueued).toBe(0);
  });
});

/**
 * Poll the fixture's `QUEUE_SINK` KV namespace (written by the worker's `queue()` consumer) until
 * a record for `messageId` shows up, or `timeoutMs` elapses.
 */
async function waitForQueuedMessage(messageId: string, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { keys } = await sink.list({ prefix: 'm:' });
    for (const { name } of keys) {
      const raw = await sink.get(name);
      if (raw && (JSON.parse(raw) as Message).messageId === messageId) return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
