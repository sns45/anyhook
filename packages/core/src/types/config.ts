/** @fileoverview Engine-level configuration types shared across modules. @module @anyhook/core */

/** Retry backoff configuration. Base delays in ms; full jitter is applied per attempt (§9.1). */
export interface RetryConfig {
  /** Base delay (ms) per attempt index. Length = max attempts before DLQ. */
  scheduleMs: number[];
}

/** Circuit-breaker tuning (per engine; overridable per endpoint). */
export interface CircuitConfig {
  /** Consecutive failed messages before the circuit opens (D4 default: 5). */
  failureThreshold: number;
  /** Cooldown (ms) before an `open` circuit transitions to `half-open`. */
  cooldownMs: number;
}
