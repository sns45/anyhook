/** @fileoverview Full-jitter backoff helper (§9.1). @module @anyhook/core */
import type { Rng } from '../ports/index.js';

/**
 * Full jitter: a uniform random delay in `[0, baseMs]`.
 * Avoids thundering herds when a receiver recovers (§9.1).
 */
export function fullJitter(baseMs: number, rng: Rng): number {
  return baseMs * rng.next();
}
