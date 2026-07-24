/** @fileoverview Per-endpoint circuit-breaker state machine (§9.2, G13, D4). @module @anyhook/core */
import type { CircuitRecord } from '../types/endpoint.js';

/** D4: open the circuit after 5 consecutive failed messages. */
export const DEFAULT_FAILURE_THRESHOLD = 5;
export const DEFAULT_COOLDOWN_MS = 30_000;

/** A fresh, closed circuit. */
export function initialCircuit(cooldownMs = DEFAULT_COOLDOWN_MS): CircuitRecord {
  return { state: 'closed', consecutiveFailures: 0, cooldownMs };
}

/**
 * Apply a delivery failure. A failure in `half-open` re-opens immediately and resets the cooldown.
 * Otherwise increments the consecutive count and opens once it reaches `threshold`.
 */
export function onFailure(
  rec: CircuitRecord,
  now: number,
  threshold = DEFAULT_FAILURE_THRESHOLD,
): CircuitRecord {
  if (rec.state === 'half-open') {
    return { ...rec, state: 'open', consecutiveFailures: rec.consecutiveFailures + 1, openedAt: now };
  }
  const consecutiveFailures = rec.consecutiveFailures + 1;
  if (consecutiveFailures >= threshold) {
    return { ...rec, state: 'open', consecutiveFailures, openedAt: now };
  }
  return { ...rec, state: 'closed', consecutiveFailures, openedAt: undefined };
}

/** Apply a delivery success: reset to closed. */
export function onSuccess(rec: CircuitRecord): CircuitRecord {
  return { ...rec, state: 'closed', consecutiveFailures: 0, openedAt: undefined };
}

/** Transition an `open` circuit whose cooldown elapsed into `half-open`. */
export function toHalfOpen(rec: CircuitRecord): CircuitRecord {
  return { ...rec, state: 'half-open' };
}

/**
 * Whether a delivery may be attempted now.
 * - `closed`    → allowed (not a probe)
 * - `open`      → allowed only once the cooldown elapsed, as a single probe (caller then `toHalfOpen`)
 * - `half-open` → allowed as the single probe
 */
export function canAttempt(rec: CircuitRecord, now: number): { allow: boolean; probe: boolean } {
  if (rec.state === 'closed') return { allow: true, probe: false };
  if (rec.state === 'half-open') return { allow: true, probe: true };
  // open
  const elapsed = now - (rec.openedAt ?? 0);
  if (elapsed >= rec.cooldownMs) return { allow: true, probe: true };
  return { allow: false, probe: false };
}
