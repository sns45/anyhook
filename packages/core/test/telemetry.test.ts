/** @fileoverview Telemetry sink receives every delivery attempt with correct outcomes (§11). @module @anyhook/core */
import { describe, test, expect } from 'bun:test';
import { MockReceiver, Receiver, runDeliveries, TestClock } from '@anyhook/testing';
import type { Attempt, Telemetry } from '../src/index.js';
import { noopTelemetry } from '../src/index.js';
import { makeEngine } from './_harness.js';

function capturing(): { telemetry: Telemetry; seen: Attempt[] } {
  const seen: Attempt[] = [];
  return { telemetry: { recordAttempt: (a) => void seen.push(a) }, seen };
}

describe('telemetry sink (§11)', () => {
  test('emits one attempt per delivery with outcome=delivered', async () => {
    const { telemetry, seen } = capturing();
    const clock = new TestClock(1_000);
    const url = 'https://x/hook';
    const h = makeEngine({ clock, receiver: new MockReceiver(clock).on(url, Receiver.ok()), telemetry });
    await h.engine.start();
    await h.engine.endpoints.create({ tenant: 'acme', url, eventTypes: ['*'] });
    await h.engine.send({ type: 'e.t', tenant: 'acme', payload: {} });
    await h.transport.drain();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ outcome: 'delivered', tenant: 'acme', eventType: 'e.t' });
  });

  test('emits retried then delivered for a 500-then-200', async () => {
    const { telemetry, seen } = capturing();
    const clock = new TestClock(1_000);
    const url = 'https://x/hook';
    const h = makeEngine({ clock, receiver: new MockReceiver(clock).on(url, Receiver.failThenOk(1)), telemetry, circuit: { failureThreshold: 100 } });
    await h.engine.start();
    await h.engine.endpoints.create({ tenant: 'acme', url, eventTypes: ['*'] });
    await h.engine.send({ type: 'e.t', tenant: 'acme', payload: {} });
    await runDeliveries({ transport: h.transport, scheduler: h.scheduler, clock: h.clock });

    expect(seen.map((a) => a.outcome)).toEqual(['retried', 'delivered']);
  });

  test('emits dead for a permanent 404', async () => {
    const { telemetry, seen } = capturing();
    const clock = new TestClock(1_000);
    const url = 'https://x/hook';
    const h = makeEngine({ clock, receiver: new MockReceiver(clock).on(url, Receiver.permanent(404)), telemetry });
    await h.engine.start();
    await h.engine.endpoints.create({ tenant: 'acme', url, eventTypes: ['*'] });
    await h.engine.send({ type: 'e.t', tenant: 'acme', payload: {} });
    await h.transport.drain();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.outcome).toBe('dead');
  });

  test('noopTelemetry is a safe default (does nothing, does not throw)', () => {
    expect(() => noopTelemetry.recordAttempt({} as Attempt)).not.toThrow();
  });
});
