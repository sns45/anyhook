/** @fileoverview Delivery outcome classification (§8, G9). @module @anyhook/core */
import type { AttemptStatus } from '../types/attempt.js';

export type Outcome = 'delivered' | 'retryable' | 'permanent';

/**
 * Classify a delivery attempt's transport status (§8):
 * - 2xx                → `delivered`
 * - 3xx                → `permanent` (redirects are not followed; a redirect on a webhook target is misconfiguration)
 * - 429                → `retryable`
 * - other 4xx          → `permanent` (the receiver rejected it; retrying won't help)
 * - 5xx                → `retryable`
 * - timeout / network  → `retryable`
 * - <200 (unexpected)  → `retryable`
 */
export function classifyOutcome(status: AttemptStatus): Outcome {
  if (status === 'timeout' || status === 'network') return 'retryable';
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 429) return 'retryable';
  if (status >= 300 && status < 500) return 'permanent';
  if (status >= 500) return 'retryable';
  return 'retryable'; // 1xx / anomalous
}
