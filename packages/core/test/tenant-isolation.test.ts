/** @fileoverview REQUIRED: no state/data bleed across tenants (§10, G7). @module @anyhook/core */
import { describe, test, expect } from 'bun:test';
import { MockReceiver, Receiver, TestClock } from '@anyhook/testing';
import { makeEngine } from './_harness.js';

describe('cross-tenant isolation (G7)', () => {
  test('listings, gets, and replay never cross the tenant boundary', async () => {
    const clock = new TestClock(1_000);
    const acmeUrl = 'https://acme.example.com/hook';
    const globexUrl = 'https://globex.example.com/hook';
    const receiver = new MockReceiver(clock).on(acmeUrl, Receiver.ok()).on(globexUrl, Receiver.ok());
    const h = makeEngine({ clock, receiver });
    await h.engine.start();

    await h.engine.endpoints.create({ tenant: 'acme', url: acmeUrl, eventTypes: ['*'] });
    await h.engine.endpoints.create({ tenant: 'globex', url: globexUrl, eventTypes: ['*'] });
    await h.engine.send({ type: 'e.t', tenant: 'acme', payload: { who: 'acme' } });
    await h.engine.send({ type: 'e.t', tenant: 'globex', payload: { who: 'globex' } });
    await h.transport.drain();

    const acmeEndpoints = await h.engine.endpoints.list({ tenant: 'acme' });
    const globexEndpoints = await h.engine.endpoints.list({ tenant: 'globex' });
    expect(acmeEndpoints).toHaveLength(1);
    expect(globexEndpoints).toHaveLength(1);
    expect(acmeEndpoints[0]!.url).toBe(acmeUrl);

    // acme cannot fetch globex's endpoint by id
    expect(await h.engine.endpoints.get({ tenant: 'acme', endpointId: globexEndpoints[0]!.endpointId })).toBeNull();

    const acmeDeliveries = await h.engine.deliveries.list({ tenant: 'acme' });
    const globexDeliveries = await h.engine.deliveries.list({ tenant: 'globex' });
    expect(acmeDeliveries).toHaveLength(1);
    expect(globexDeliveries).toHaveLength(1);
    expect(acmeDeliveries[0]!.message.tenant).toBe('acme');

    // acme cannot replay globex's message id
    const globexMessageId = globexDeliveries[0]!.message.messageId;
    expect(await h.engine.deliveries.replay({ tenant: 'acme', messageId: globexMessageId })).toEqual({ replayed: false });
    // globex CAN replay its own
    expect(await h.engine.deliveries.replay({ tenant: 'globex', messageId: globexMessageId })).toEqual({ replayed: true });
  });
});
