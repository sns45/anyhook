/** @fileoverview Fan-out, subscription-matching, idempotency-derivation tests (§12, G3). @module @anyhook/core */
import { describe, test, expect } from 'bun:test';
import { fanout, subscribes } from '../src/fanout.js';
import { deriveIdempotencyKey, newId } from '../src/id.js';
import type { Endpoint } from '../src/types/endpoint.js';
import type { SendEvent } from '../src/types/event.js';
import type { Rng } from '../src/ports/index.js';

// deterministic-but-varying rng so generated ids differ per call
function seq(): Rng {
  let i = 0;
  return { next: () => ((i = (i * 1103515245 + 12345 + 1) % 2147483648), (i % 997) / 997) };
}

function ep(id: string, eventTypes: string[], disabled = false): Endpoint {
  return { endpointId: id, tenant: 'acme', url: `https://x/${id}`, eventTypes, disabled, createdAt: 0, secrets: ['whsec_x'] };
}

describe('fan-out (G3)', () => {
  const event: SendEvent = { type: 'payment.succeeded', tenant: 'acme', payload: { a: 1 } };

  test('one message per matching enabled endpoint; skips non-subscribers and disabled', () => {
    const endpoints = [
      ep('e1', ['payment.succeeded']),
      ep('e2', ['payment.*']),
      ep('e3', ['user.created']), // not subscribed
      ep('e4', ['*'], true), // disabled
    ];
    const msgs = fanout(event, 'evt_1', endpoints, seq(), 1000);
    expect(msgs.map((m) => m.endpointId).sort()).toEqual(['e1', 'e2']);
    expect(new Set(msgs.map((m) => m.messageId)).size).toBe(2); // independent ids
    expect(msgs.every((m) => m.attemptNo === 0 && m.status === 'pending' && m.createdAt === 1000)).toBe(true);
  });

  test('empty match is valid (messageCount 0)', () => {
    expect(fanout(event, 'evt_1', [ep('e3', ['user.created'])], seq(), 0)).toHaveLength(0);
  });

  test('subscribes: exact, wildcard, prefix', () => {
    expect(subscribes(ep('e', ['*']), 'anything.x')).toBe(true);
    expect(subscribes(ep('e', ['payment.*']), 'payment.succeeded')).toBe(true);
    expect(subscribes(ep('e', ['payment.*']), 'user.created')).toBe(false);
    expect(subscribes(ep('e', ['user.created']), 'user.created')).toBe(true);
  });
});

describe('idempotency derivation (§9)', () => {
  test('stable for identical events, differs on payload/tenant/type', () => {
    const base: SendEvent = { type: 'payment.succeeded', tenant: 'acme', payload: { amount: 10 } };
    const k = deriveIdempotencyKey(base);
    expect(deriveIdempotencyKey({ ...base })).toBe(k);
    expect(deriveIdempotencyKey({ ...base, payload: { amount: 11 } })).not.toBe(k);
    expect(deriveIdempotencyKey({ ...base, tenant: 'globex' })).not.toBe(k);
    expect(deriveIdempotencyKey({ ...base, type: 'payment.failed' })).not.toBe(k);
    expect(k.startsWith('idem_')).toBe(true);
  });

  test('newId is prefixed and unique across draws', () => {
    const r = seq();
    const a = newId('msg', r);
    const b = newId('msg', r);
    expect(a.startsWith('msg_')).toBe(true);
    expect(a).not.toBe(b);
  });
});
