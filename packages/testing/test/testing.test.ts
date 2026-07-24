/** @fileoverview Unit tests for the in-memory test doubles. @module @anyhook/testing */
import { describe, test, expect } from 'bun:test';
import { MockReceiver, Receiver, MemoryStateStore, TestClock, seededRng, MemoryTransport } from '../src/index.js';
import type { Message } from '@anyhook/core';

describe('MockReceiver scripts', () => {
  const url = 'https://x/hook';

  test('ok returns 200', async () => {
    const r = new MockReceiver().on(url, Receiver.ok());
    expect(await r.post(url, 'b', {}, 15000)).toEqual({ status: 200, body: 'ok' });
    expect(r.callCount(url)).toBe(1);
  });

  test('failThenOk(1): 500 then 200', async () => {
    const r = new MockReceiver().on(url, Receiver.failThenOk(1));
    expect((await r.post(url, 'b', {}, 15000)).status).toBe(500);
    expect((await r.post(url, 'b', {}, 15000)).status).toBe(200);
  });

  test('permanent(404)', async () => {
    const r = new MockReceiver().on(url, Receiver.permanent(404));
    expect((await r.post(url, 'b', {}, 15000)).status).toBe(404);
  });

  test('slow beyond timeout returns timeout, within returns 200', async () => {
    const r = new MockReceiver().on(url, Receiver.slow(20000));
    expect((await r.post(url, 'b', {}, 15000)).status).toBe('timeout');
    const r2 = new MockReceiver().on(url, Receiver.slow(1000));
    expect((await r2.post(url, 'b', {}, 15000)).status).toBe(200);
  });

  test('records headers and body', async () => {
    const r = new MockReceiver();
    await r.post(url, '{"a":1}', { 'webhook-id': 'm1' }, 15000);
    expect(r.calls[0]!.headers['webhook-id']).toBe('m1');
    expect(r.calls[0]!.body).toBe('{"a":1}');
  });
});

describe('MemoryStateStore tenant scoping (G7)', () => {
  test('endpoints and messages never leak across tenants', async () => {
    const s = new MemoryStateStore(new TestClock(1000));
    const { endpoint: a } = await s.createEndpoint({ tenant: 'acme', url: 'https://a/h', eventTypes: ['*'] });
    await s.createEndpoint({ tenant: 'globex', url: 'https://g/h', eventTypes: ['*'] });

    expect((await s.listEndpoints('acme')).length).toBe(1);
    expect((await s.listEndpoints('globex')).length).toBe(1);
    // globex cannot see acme's endpoint
    expect(await s.getEndpoint('globex', a.endpointId)).toBeNull();

    const msg: Message = { messageId: 'm1', tenant: 'acme', endpointId: a.endpointId, eventId: 'e1', eventType: 'x', payload: {}, attemptNo: 0, status: 'pending', createdAt: 1000 };
    await s.putMessage(msg);
    expect(await s.getMessage('globex', 'm1')).toBeNull();
    expect((await s.getMessage('acme', 'm1'))!.messageId).toBe('m1');
  });

  test('rotateSecret keeps the old secret in a dual window', async () => {
    const s = new MemoryStateStore();
    const { endpoint } = await s.createEndpoint({ tenant: 'acme', url: 'https://a/h', eventTypes: ['*'] });
    const old = endpoint.secrets[0]!;
    const { secret } = await s.rotateSecret('acme', endpoint.endpointId);
    const updated = (await s.getEndpoint('acme', endpoint.endpointId))!;
    expect(updated.secrets[0]).toBe(secret);
    expect(updated.secrets[1]).toBe(old);
  });

  test('idempotency: recordEvent flags a duplicate key', async () => {
    const s = new MemoryStateStore();
    expect((await s.recordEvent('acme', 'e1', 'k1')).isNew).toBe(true);
    await s.finalizeEvent('acme', 'k1', 'e1', 3);
    const dup = await s.recordEvent('acme', 'e2', 'k1');
    expect(dup).toEqual({ isNew: false, eventId: 'e1', messageCount: 3 });
  });
});

describe('MemoryScheduler + transport smoke', () => {
  test('seededRng is deterministic', () => {
    const a = seededRng(7);
    const b = seededRng(7);
    expect(a.next()).toBe(b.next());
  });

  test('transport drain invokes handler', async () => {
    const t = new MemoryTransport();
    const seen: string[] = [];
    await t.subscribe(async (m) => { seen.push(m.messageId); });
    await t.send({ messageId: 'm1', tenant: 'acme', endpointId: 'e', eventId: 'e1', eventType: 'x', payload: {}, attemptNo: 0, status: 'pending', createdAt: 0 });
    expect(await t.drain()).toBe(1);
    expect(seen).toEqual(['m1']);
  });
});
