/** @fileoverview Circuit-breaker transition tests (§12, G13, D4). @module @anyhook/core */
import { describe, test, expect } from 'bun:test';
import {
  initialCircuit,
  onFailure,
  onSuccess,
  toHalfOpen,
  canAttempt,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_COOLDOWN_MS,
} from '../src/policy/index.js';
import type { CircuitRecord } from '../src/types/endpoint.js';

describe('circuit breaker (G13, D4)', () => {
  test('opens after exactly 5 consecutive failures', () => {
    let c = initialCircuit();
    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD - 1; i++) {
      c = onFailure(c, 1000);
      expect(c.state).toBe('closed');
    }
    c = onFailure(c, 1000);
    expect(c.state).toBe('open');
    expect(c.consecutiveFailures).toBe(DEFAULT_FAILURE_THRESHOLD);
    expect(c.openedAt).toBe(1000);
  });

  test('success resets consecutive failures and closes', () => {
    let c: CircuitRecord = { state: 'closed', consecutiveFailures: 3, cooldownMs: DEFAULT_COOLDOWN_MS };
    c = onSuccess(c);
    expect(c.state).toBe('closed');
    expect(c.consecutiveFailures).toBe(0);
  });

  test('open within cooldown blocks; after cooldown allows a probe', () => {
    const opened: CircuitRecord = {
      state: 'open',
      consecutiveFailures: 5,
      openedAt: 1000,
      cooldownMs: DEFAULT_COOLDOWN_MS,
    };
    expect(canAttempt(opened, 1000 + DEFAULT_COOLDOWN_MS - 1)).toEqual({ allow: false, probe: false });
    expect(canAttempt(opened, 1000 + DEFAULT_COOLDOWN_MS)).toEqual({ allow: true, probe: true });
  });

  test('half-open success closes and drains; half-open failure re-opens and resets cooldown', () => {
    let half = toHalfOpen({ state: 'open', consecutiveFailures: 5, openedAt: 1000, cooldownMs: DEFAULT_COOLDOWN_MS });
    expect(half.state).toBe('half-open');
    expect(canAttempt(half, 999_999)).toEqual({ allow: true, probe: true });

    const closed = onSuccess(half);
    expect(closed.state).toBe('closed');
    expect(closed.consecutiveFailures).toBe(0);

    const reopened = onFailure(half, 5000);
    expect(reopened.state).toBe('open');
    expect(reopened.openedAt).toBe(5000);
  });

  test('closed circuit always allows (not a probe)', () => {
    expect(canAttempt(initialCircuit(), 42)).toEqual({ allow: true, probe: false });
  });
});
