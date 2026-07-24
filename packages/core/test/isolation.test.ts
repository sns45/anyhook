/** @fileoverview REQUIRED: a dead endpoint provably cannot delay/fail a healthy one (§3/§8, G3). @module @anyhook/core */
import { describe, test, expect } from 'bun:test';
import { MockReceiver, Receiver, runDeliveries, TestClock } from '@anyhook/testing';
import { makeEngine } from './_harness.js';

describe('message-level isolation (G3)', () => {
  test('one event → healthy endpoint delivered on time; dead endpoint fails independently', async () => {
    const clock = new TestClock(1_000);
    const healthyUrl = 'https://healthy.example.com/hook';
    const deadUrl = 'https://dead.example.com/hook';
    const receiver = new MockReceiver(clock).on(healthyUrl, Receiver.ok()).on(deadUrl, Receiver.timeout());
    const h = makeEngine({ clock, receiver });
    await h.engine.start();

    await h.engine.endpoints.create({ tenant: 'acme', url: healthyUrl, eventTypes: ['*'] });
    await h.engine.endpoints.create({ tenant: 'acme', url: deadUrl, eventTypes: ['*'] });

    const receipt = await h.engine.send({ type: 'order.created', tenant: 'acme', payload: { id: 1 } });
    expect(receipt.messageCount).toBe(2);

    // First drain: healthy delivers at t=1000; dead fails its first attempt and schedules a retry.
    await h.transport.drain();
    const healthyCallAt = receiver.calls.find((c) => c.url === healthyUrl)!.ts;
    expect(healthyCallAt).toBe(1_000);
    expect(receiver.callCount(deadUrl)).toBe(1);

    // Drive the dead endpoint's entire retry schedule to exhaustion.
    await runDeliveries({ transport: h.transport, scheduler: h.scheduler, clock: h.clock });

    // Healthy message: delivered, exactly ONE attempt, unaffected by the dead endpoint's ~12h of retries.
    const healthy = (await h.engine.deliveries.list({ tenant: 'acme', status: 'delivered' }))[0]!;
    expect(healthy.attempts).toHaveLength(1);
    expect(healthy.attempts[0]!.outcome).toBe('delivered');
    expect(receiver.callCount(healthyUrl)).toBe(1);

    // Dead message: independently dead-lettered as exhausted, with many attempts.
    const dlq = await h.state.listDlq('acme');
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.reason).toBe('exhausted_retries');
    expect(receiver.callCount(deadUrl)).toBeGreaterThan(1);
  });
});
