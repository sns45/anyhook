/** @fileoverview Integration: per-endpoint rate limiting throttles (reschedules) delivery, never drops (§10). @module @anyhook/core */
import { describe, test, expect } from 'bun:test';
import { MockReceiver, Receiver, runDeliveries, TestClock } from '@anyhook/testing';
import { makeEngine } from './_harness.js';

describe('per-endpoint rate limiting (§10)', () => {
  test('3 events to a 1/sec endpoint all deliver, spaced ~1s apart (throttled, not dropped)', async () => {
    const clock = new TestClock(1_000);
    const url = 'https://slow.example.com/hook';
    const receiver = new MockReceiver(clock).on(url, Receiver.ok());
    const h = makeEngine({ clock, receiver });
    await h.engine.start();

    // rateLimit = 1 delivery/sec, capacity 1.
    await h.engine.endpoints.create({ tenant: 'acme', url, eventTypes: ['*'], rateLimit: 1 });

    for (let i = 0; i < 3; i++) {
      await h.engine.send({ type: 'e.t', tenant: 'acme', payload: { i } });
    }
    await runDeliveries({ transport: h.transport, scheduler: h.scheduler, clock: h.clock });

    // All three delivered — throttling reschedules, never drops.
    const delivered = await h.engine.deliveries.list({ tenant: 'acme', status: 'delivered' });
    expect(delivered).toHaveLength(3);
    expect(await h.state.listDlq('acme')).toHaveLength(0);

    // Deliveries are spaced by ~1s (the rate). 3 deliveries at 1/sec span ~2s.
    const ts = receiver.calls.map((c) => c.ts).sort((a, b) => a - b);
    expect(receiver.callCount(url)).toBe(3);
    expect(ts[ts.length - 1]! - ts[0]!).toBeGreaterThanOrEqual(1_900);

    // Each throttled attempt did NOT count as a delivery attempt (no wasted attempts on the log).
    for (const d of delivered) {
      expect(d.attempts).toHaveLength(1);
      expect(d.attempts[0]!.outcome).toBe('delivered');
    }
  });

  test('no rateLimit → no throttling (delivers immediately)', async () => {
    const clock = new TestClock(1_000);
    const url = 'https://fast.example.com/hook';
    const receiver = new MockReceiver(clock).on(url, Receiver.ok());
    const h = makeEngine({ clock, receiver });
    await h.engine.start();
    await h.engine.endpoints.create({ tenant: 'acme', url, eventTypes: ['*'] }); // no rateLimit
    await h.engine.send({ type: 'e.t', tenant: 'acme', payload: {} });
    await h.transport.drain();
    expect(receiver.calls[0]!.ts).toBe(1_000); // delivered at t0, unthrottled
  });
});
