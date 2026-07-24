/** @fileoverview Token-bucket rate-limit policy tests (§10). @module @anyhook/core */
import { describe, test, expect } from 'bun:test';
import { consumeToken, initialBucket, capacityFor } from '../src/policy/ratelimit.js';

describe('rate-limit token bucket (§10)', () => {
  test('capacity is ~1s of tokens, minimum 1', () => {
    expect(capacityFor(0.5)).toBe(1);
    expect(capacityFor(5)).toBe(5);
  });

  test('a full bucket allows immediately and decrements', () => {
    const b = initialBucket(1, 1000);
    const d = consumeToken(b, 1, 1000);
    expect(d.allowed).toBe(true);
    expect(d.bucket.tokens).toBeCloseTo(0, 5);
    expect(d.retryAfterMs).toBe(0);
  });

  test('an empty bucket throttles with the correct retry-after', () => {
    const empty = { tokens: 0, lastRefillMs: 1000 };
    const d = consumeToken(empty, 1, 1000); // no time elapsed → still empty
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(1000); // 1 token/sec → 1s until the next token
  });

  test('refills over elapsed time, capped at capacity', () => {
    const empty = { tokens: 0, lastRefillMs: 1000 };
    const d = consumeToken(empty, 2, 1000 + 1000); // 1s @ 2/sec → +2 tokens, consume 1
    expect(d.allowed).toBe(true);
    expect(d.bucket.tokens).toBeCloseTo(1, 5);

    const overfull = consumeToken({ tokens: 0, lastRefillMs: 0 }, 2, 10_000); // huge elapsed
    expect(overfull.bucket.tokens).toBeLessThanOrEqual(capacityFor(2)); // capped
  });
});
