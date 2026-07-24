/** @fileoverview Retry-schedule, jitter-bound, and outcome-classification tests (§12, G12/G9). @module @anyhook/core */
import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_SCHEDULE_MS,
  DEFAULT_RETRY_CONFIG,
  RETRY_AFTER_CAP_MS,
  nextDelayMs,
  classifyOutcome,
  fullJitter,
} from '../src/policy/index.js';
import type { Rng } from '../src/ports/index.js';

const rng = (v: number): Rng => ({ next: () => v });

describe('retry policy (G12)', () => {
  test('8-attempt schedule, exhaustion returns null', () => {
    expect(DEFAULT_SCHEDULE_MS.length).toBe(8);
    expect(nextDelayMs(DEFAULT_RETRY_CONFIG, 8, rng(0.5))).toBeNull();
    expect(nextDelayMs(DEFAULT_RETRY_CONFIG, -1, rng(0.5))).toBeNull();
  });

  test.each([
    [0, 0],
    [0.5, 0.5],
    [1, 1],
  ])('full jitter bound: rng=%p -> fraction %p of base', (r, frac) => {
    const base = DEFAULT_SCHEDULE_MS[0]!;
    expect(fullJitter(base, rng(r))).toBeCloseTo(base * frac, 5);
  });

  test('nextDelayMs stays within [0, base] for the attempt', () => {
    for (let i = 0; i < DEFAULT_SCHEDULE_MS.length; i++) {
      const d = nextDelayMs(DEFAULT_RETRY_CONFIG, i, rng(0.999))!;
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(DEFAULT_SCHEDULE_MS[i]!);
    }
  });

  test('Retry-After wins and is capped', () => {
    expect(nextDelayMs(DEFAULT_RETRY_CONFIG, 0, rng(0.5), 10_000)).toBe(10_000);
    expect(nextDelayMs(DEFAULT_RETRY_CONFIG, 0, rng(0.5), 999_999_999)).toBe(RETRY_AFTER_CAP_MS);
  });

  test.each([
    [200, 'delivered'],
    [201, 'delivered'],
    [301, 'permanent'],
    [400, 'permanent'],
    [404, 'permanent'],
    [429, 'retryable'],
    [500, 'retryable'],
    [503, 'retryable'],
    ['timeout', 'retryable'],
    ['network', 'retryable'],
  ] as const)('classifyOutcome(%p) === %p', (status, want) => {
    expect(classifyOutcome(status)).toBe(want);
  });
});
