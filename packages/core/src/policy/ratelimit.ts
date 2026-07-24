/** @fileoverview Per-endpoint token-bucket rate limiting (§10). @module @anyhook/core */
import type { RateBucket } from '../types/endpoint.js';

/** Bucket capacity (max burst) for a given rate: up to ~1s worth of tokens, minimum 1. */
export function capacityFor(rateLimitPerSec: number): number {
  return Math.max(1, rateLimitPerSec);
}

/** A fresh, full bucket for an endpoint's rate limit. */
export function initialBucket(rateLimitPerSec: number, now: number): RateBucket {
  return { tokens: capacityFor(rateLimitPerSec), lastRefillMs: now };
}

export interface RateDecision {
  /** Whether a delivery token was available (and consumed). */
  allowed: boolean;
  /** The bucket state to persist after this check. */
  bucket: RateBucket;
  /** When not allowed, ms until a token will be available (0 when allowed). */
  retryAfterMs: number;
}

/**
 * Refill the bucket for elapsed time, then try to consume one delivery token.
 * When empty, returns `allowed:false` with `retryAfterMs` = time until the next token — the caller
 * throttles by rescheduling the message (never dropping it). `rateLimitPerSec` is deliveries/second.
 */
export function consumeToken(bucket: RateBucket, rateLimitPerSec: number, now: number): RateDecision {
  const capacity = capacityFor(rateLimitPerSec);
  const elapsedSec = Math.max(0, (now - bucket.lastRefillMs) / 1000);
  const tokens = Math.min(capacity, bucket.tokens + elapsedSec * rateLimitPerSec);

  if (tokens >= 1) {
    return { allowed: true, bucket: { tokens: tokens - 1, lastRefillMs: now }, retryAfterMs: 0 };
  }
  const retryAfterMs = Math.ceil(((1 - tokens) / rateLimitPerSec) * 1000);
  return { allowed: false, bucket: { tokens, lastRefillMs: now }, retryAfterMs };
}
