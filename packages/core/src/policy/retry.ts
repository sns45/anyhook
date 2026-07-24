/** @fileoverview Retry backoff schedule + next-delay computation (§9.1, G12). @module @anyhook/core */
import type { Rng } from '../ports/index.js';
import type { RetryConfig } from '../types/config.js';
import { fullJitter } from './jitter.js';

/** Default backoff: ~5s, 30s, 2m, 10m, 30m, 1h, 3h, 6h (8 attempts, ~12h) then DLQ (§9.1). */
export const DEFAULT_SCHEDULE_MS: number[] = [
  5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000,
];

/** Cap for a receiver-supplied `Retry-After` so it cannot push delivery out arbitrarily far (§9.1). */
export const RETRY_AFTER_CAP_MS = 21_600_000; // 6h (largest schedule step)

export const DEFAULT_RETRY_CONFIG: RetryConfig = { scheduleMs: DEFAULT_SCHEDULE_MS };

/**
 * Delay (ms) before the given 0-based attempt, or `null` when the schedule is exhausted (→ DLQ).
 * When `retryAfterMs` is provided (429/503 `Retry-After`), it wins but is capped by `RETRY_AFTER_CAP_MS`.
 * Otherwise full jitter over `[0, base]` for that attempt's base delay.
 */
export function nextDelayMs(
  cfg: RetryConfig,
  attemptNo: number,
  rng: Rng,
  retryAfterMs?: number,
): number | null {
  if (attemptNo < 0 || attemptNo >= cfg.scheduleMs.length) return null;
  if (retryAfterMs != null && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, RETRY_AFTER_CAP_MS);
  }
  return fullJitter(cfg.scheduleMs[attemptNo]!, rng);
}
