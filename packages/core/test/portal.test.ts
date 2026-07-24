/** @fileoverview Portal handlers: CRUD, secret rotation, delivery-log filters, replay (§7.2/§7.3). @module @anyhook/core */
import { describe, test, expect } from 'bun:test';
import { MockReceiver, Receiver, TestClock } from '@anyhook/testing';
import { verify } from '@anyhook/signing';
import { makeEngine } from './_harness.js';

describe('endpoint management (§7.2)', () => {
  test('create returns a secret once; rotate keeps the old secret valid (dual-secret window)', async () => {
    const url = 'https://api.customer.com/hook';
    const receiver = new MockReceiver().on(url, Receiver.ok());
    const h = makeEngine({ receiver, realClock: true });
    await h.engine.start();

    const created = await h.engine.endpoints.create({ tenant: 'acme', url, eventTypes: ['*'] });
    expect(created.secret.startsWith('whsec_')).toBe(true);
    const oldSecret = created.secret;

    const { secret: newSecret } = await h.engine.endpoints.rotateSecret({ tenant: 'acme', endpointId: created.endpointId });
    expect(newSecret).not.toBe(oldSecret);

    await h.engine.send({ type: 'x.y', tenant: 'acme', payload: { a: 1 } });
    await h.transport.drain();
    const call = receiver.calls.find((c) => c.url === url)!;

    // During the rotation window BOTH secrets verify the delivered signature.
    expect(() => verify(call.headers, call.body, oldSecret)).not.toThrow();
    expect(() => verify(call.headers, call.body, newSecret)).not.toThrow();
  });

  test('disabling an endpoint stops fan-out to it', async () => {
    const url = 'https://api.customer.com/hook';
    const h = makeEngine({ receiver: new MockReceiver().on(url, Receiver.ok()) });
    await h.engine.start();
    const { endpointId } = await h.engine.endpoints.create({ tenant: 'acme', url, eventTypes: ['*'] });
    await h.engine.endpoints.update({ tenant: 'acme', endpointId, disabled: true });
    const r = await h.engine.send({ type: 'x.y', tenant: 'acme', payload: {} });
    expect(r.messageCount).toBe(0);
  });

  test('list/get/update never expose signing secrets (G10)', async () => {
    const h = makeEngine();
    await h.engine.start();
    const { endpointId } = await h.engine.endpoints.create({ tenant: 'acme', url: 'https://a/h', eventTypes: ['*'] });

    const listed = await h.engine.endpoints.list({ tenant: 'acme' });
    expect(listed[0]).toBeDefined();
    expect('secrets' in listed[0]!).toBe(false);

    const got = await h.engine.endpoints.get({ tenant: 'acme', endpointId });
    expect('secrets' in got!).toBe(false);

    const updated = await h.engine.endpoints.update({ tenant: 'acme', endpointId, disabled: true });
    expect('secrets' in updated).toBe(false);
  });

  test('delete removes the endpoint', async () => {
    const h = makeEngine();
    await h.engine.start();
    const { endpointId } = await h.engine.endpoints.create({ tenant: 'acme', url: 'https://a/h', eventTypes: ['*'] });
    await h.engine.endpoints.delete({ tenant: 'acme', endpointId });
    expect(await h.engine.endpoints.get({ tenant: 'acme', endpointId })).toBeNull();
  });
});

describe('delivery log + replay (§7.3)', () => {
  test('filters by status and event type', async () => {
    const clock = new TestClock(1_000);
    const url = 'https://api.customer.com/hook';
    const h = makeEngine({ clock, receiver: new MockReceiver(clock).on(url, Receiver.ok()) });
    await h.engine.start();
    await h.engine.endpoints.create({ tenant: 'acme', url, eventTypes: ['*'] });
    await h.engine.send({ type: 'payment.succeeded', tenant: 'acme', payload: {} });
    await h.engine.send({ type: 'user.created', tenant: 'acme', payload: {} });
    await h.transport.drain();

    expect(await h.engine.deliveries.list({ tenant: 'acme', status: 'delivered' })).toHaveLength(2);
    const byType = await h.engine.deliveries.list({ tenant: 'acme', eventType: 'payment.succeeded' });
    expect(byType).toHaveLength(1);
    expect(byType[0]!.message.eventType).toBe('payment.succeeded');
  });

  test('replay re-enqueues a fresh delivery (new attempt chain)', async () => {
    const clock = new TestClock(1_000);
    const url = 'https://api.customer.com/hook';
    const receiver = new MockReceiver(clock).on(url, Receiver.ok());
    const h = makeEngine({ clock, receiver });
    await h.engine.start();
    await h.engine.endpoints.create({ tenant: 'acme', url, eventTypes: ['*'] });
    await h.engine.send({ type: 'x.y', tenant: 'acme', payload: {} });
    await h.transport.drain();

    const [row] = await h.engine.deliveries.list({ tenant: 'acme' });
    const messageId = row!.message.messageId;
    expect(receiver.callCount(url)).toBe(1);

    const res = await h.engine.deliveries.replay({ tenant: 'acme', messageId });
    expect(res.replayed).toBe(true);
    await h.transport.drain();
    expect(receiver.callCount(url)).toBe(2); // delivered again on replay
  });
});
