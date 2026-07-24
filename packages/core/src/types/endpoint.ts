/** @fileoverview Endpoint + circuit-breaker record types. @module @anyhook/core */

/** A customer-registered delivery destination, scoped to a tenant. */
export interface Endpoint {
  endpointId: string;
  tenant: string;
  url: string;
  /** Subscribed event types. An event fans out to endpoints subscribed to its type. */
  eventTypes: string[];
  description?: string;
  disabled: boolean;
  /** Optional per-endpoint delivery rate limit (deliveries/sec). */
  rateLimit?: number;
  createdAt: number;
  /** Active signing secret(s). `secrets[0]` is primary; `secrets[1]` exists during a rotation window. */
  secrets: string[];
}

export type CircuitState = 'closed' | 'open' | 'half-open';

/** Per-endpoint circuit-breaker state (lives in the durable StateStore). */
export interface CircuitRecord {
  state: CircuitState;
  consecutiveFailures: number;
  /** Epoch ms the circuit opened; set while `state === 'open'`. */
  openedAt?: number;
  /** Cooldown before an `open` circuit transitions to `half-open`. */
  cooldownMs: number;
}

/** Per-endpoint token-bucket rate-limit state (lives in the durable StateStore). */
export interface RateBucket {
  /** Available delivery tokens (fractional). */
  tokens: number;
  /** Epoch ms the bucket was last refilled. */
  lastRefillMs: number;
}
