/** @fileoverview send() acceptance semantics + async delivery (§7.1/§8, G5). @module @anyhook/core */
import { describe, test, expect } from 'bun:test';
import { MemoryTransport, MemoryScheduler, MemoryStateStore, TestClock, MockReceiver } from '@anyhook/testing';
import { createSigner } from '@anyhook/signing';
import { Webhook } from 'standardwebhooks';
import { WebhookEngine } from '../src/index.js';
import { makeEngine } from './_harness.js';

describe('WebhookEngine.send (G5)', () => {
  test('returns at acceptance with messageCount; does NOT deliver synchronously', async () => {
    const h = makeEngine();
    await h.engine.start();
    const url = 'https://api.customer.com/hook';
    await h.engine.endpoints.create({ tenant: 'acme', url, eventTypes: ['payment.*'] });

    const receipt = await h.engine.send({ type: 'payment.succeeded', tenant: 'acme', payload: { amount: 10 } });
    expect(receipt.accepted).toBe(true);
    expect(receipt.messageCount).toBe(1);
    // Nothing delivered yet — send() only durably accepted (async delivery).
    expect(h.http.callCount()).toBe(0);

    await h.transport.drain();
    expect(h.http.callCount(url)).toBe(1);
  });

  test('messageCount 0 when no endpoint matches is valid, not an error', async () => {
    const h = makeEngine();
    await h.engine.start();
    const r = await h.engine.send({ type: 'nobody.listens', tenant: 'acme', payload: {} });
    expect(r).toMatchObject({ accepted: true, messageCount: 0 });
  });

  test('idempotent send returns the same receipt and does not re-fan-out', async () => {
    const h = makeEngine();
    await h.engine.start();
    await h.engine.endpoints.create({ tenant: 'acme', url: 'https://api.customer.com/hook', eventTypes: ['*'] });

    const first = await h.engine.send({ type: 'x.y', tenant: 'acme', payload: { n: 1 }, idempotencyKey: 'k1' });
    const second = await h.engine.send({ type: 'x.y', tenant: 'acme', payload: { n: 1 }, idempotencyKey: 'k1' });
    expect(second.eventId).toBe(first.eventId);
    expect(second.messageCount).toBe(first.messageCount);
    await h.transport.drain();
    expect(h.http.callCount()).toBe(1); // only the first fan-out was enqueued
  });

  test('validation: missing type/tenant throws; oversized payload throws', async () => {
    const h = makeEngine();
    await h.engine.start();
    // @ts-expect-error intentionally missing type
    expect(h.engine.send({ tenant: 'acme', payload: {} })).rejects.toThrow(/type/);
    // @ts-expect-error intentionally missing tenant
    expect(h.engine.send({ type: 'x', payload: {} })).rejects.toThrow(/tenant/);

    const tiny = makeEngineWith({ maxPayloadBytes: 8 });
    expect(tiny.send({ type: 'x', tenant: 'acme', payload: { big: 'xxxxxxxxxxxxxxxx' } })).rejects.toThrow(/payload/);
  });
});

describe('delivery wire compatibility (G4 end-to-end)', () => {
  test('delivered headers verify with the official standardwebhooks library', async () => {
    // Real clock so the signed webhook-timestamp is within the official ±5min tolerance.
    const clock = { now: () => Date.now() };
    const transport = new MemoryTransport();
    const scheduler = new MemoryScheduler(transport, new TestClock());
    const state = new MemoryStateStore();
    const http = new MockReceiver();
    const engine = new WebhookEngine({ transport, state, scheduler, http, signer: createSigner(), clock });
    await engine.start();

    const url = 'https://api.customer.com/hook';
    const { secret } = await engine.endpoints.create({ tenant: 'acme', url, eventTypes: ['*'] });
    await engine.send({ type: 'x.y', tenant: 'acme', payload: { hello: 'world' } });
    await transport.drain();

    const call = http.calls.find((c) => c.url === url)!;
    expect(() => new Webhook(secret).verify(call.body, call.headers)).not.toThrow();
  });
});

/** Build a minimal engine overriding a single option (used for the payload-cap case). */
function makeEngineWith(over: { maxPayloadBytes?: number }): WebhookEngine {
  const transport = new MemoryTransport();
  const scheduler = new MemoryScheduler(transport, new TestClock());
  return new WebhookEngine({
    transport,
    scheduler,
    state: new MemoryStateStore(),
    http: new MockReceiver(),
    signer: createSigner(),
    ...over,
  });
}
