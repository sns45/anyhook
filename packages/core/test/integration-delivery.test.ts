/** @fileoverview REQUIRED: MockReceiver outcome matrix — delivered/retried/dead + attempt counts (§12). @module @anyhook/core */
import { describe, test, expect } from 'bun:test';
import { MockReceiver, Receiver, runDeliveries, TestClock, type Script } from '@anyhook/testing';
import { makeEngine } from './_harness.js';

async function runScenario(script: Script, circuitThreshold = 100) {
  const clock = new TestClock(1_000);
  const url = 'https://target.example.com/hook';
  const receiver = new MockReceiver(clock).on(url, script);
  const h = makeEngine({ clock, receiver, circuit: { failureThreshold: circuitThreshold } });
  await h.engine.start();
  await h.engine.endpoints.create({ tenant: 'acme', url, eventTypes: ['*'] });
  await h.engine.send({ type: 'e.t', tenant: 'acme', payload: { n: 1 } });
  await runDeliveries({ transport: h.transport, scheduler: h.scheduler, clock: h.clock });

  const [record] = await h.engine.deliveries.list({ tenant: 'acme' });
  const dlq = await h.state.listDlq('acme');
  return { message: record!.message, attempts: record!.attempts, dlq, calls: receiver.callCount(url) };
}

describe('MockReceiver delivery matrix (§12)', () => {
  test('200 → delivered, 1 attempt', async () => {
    const r = await runScenario(Receiver.ok());
    expect(r.message.status).toBe('delivered');
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]!.outcome).toBe('delivered');
    expect(r.dlq).toHaveLength(0);
  });

  test('500-then-200 → delivered, 2 attempts (1 retried + 1 delivered)', async () => {
    const r = await runScenario(Receiver.failThenOk(1));
    expect(r.message.status).toBe('delivered');
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts.map((a) => a.outcome)).toEqual(['retried', 'delivered']);
  });

  test('permanent 404 → dead (permanent_4xx), 1 attempt, no retry', async () => {
    const r = await runScenario(Receiver.permanent(404));
    expect(r.message.status).toBe('dead');
    expect(r.attempts).toHaveLength(1);
    expect(r.dlq).toEqual([expect.objectContaining({ reason: 'permanent_4xx' })]);
  });

  test('persistent timeout → dead (exhausted_retries) after the full schedule', async () => {
    const r = await runScenario(Receiver.timeout());
    expect(r.message.status).toBe('dead');
    expect(r.dlq[0]!.reason).toBe('exhausted_retries');
    // model: 1 initial attempt + 8 scheduled retries = 9 delivery attempts
    expect(r.calls).toBe(9);
    expect(r.attempts).toHaveLength(9);
  });

  test('slow beyond the per-attempt timeout is a retryable timeout', async () => {
    const r = await runScenario(Receiver.slow(20_000)); // > default 15s timeout
    expect(r.attempts[0]!.status).toBe('timeout');
    expect(r.attempts[0]!.outcome).toBe('retried');
  });
});

describe('circuit opens under sustained failure (G13)', () => {
  test('circuit is open after 5 consecutive failed messages to an endpoint', async () => {
    const clock = new TestClock(1_000);
    const url = 'https://flaky.example.com/hook';
    const receiver = new MockReceiver(clock).on(url, Receiver.timeout());
    // threshold 5, but stop after the first attempt of each message by NOT draining retries;
    // instead send 5 distinct events so 5 messages each fail once → 5 consecutive failures.
    const h = makeEngine({ clock, receiver, circuit: { failureThreshold: 5 }, retry: { scheduleMs: [] } });
    await h.engine.start();
    const { endpointId } = await h.engine.endpoints.create({ tenant: 'acme', url, eventTypes: ['*'] });
    for (let i = 0; i < 5; i++) {
      await h.engine.send({ type: 'e.t', tenant: 'acme', payload: { i } });
    }
    await h.transport.drain(); // each of the 5 messages attempts once, fails (schedule empty → straight to DLQ)
    const circuit = await h.state.getCircuit('acme', endpointId);
    expect(circuit.state).toBe('open');
    expect(circuit.consecutiveFailures).toBeGreaterThanOrEqual(5);
  });
});
