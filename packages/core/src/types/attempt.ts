/** @fileoverview Attempt (one HTTP POST try) + DLQ reason types. @module @anyhook/core */

/** Non-numeric transport outcomes for an attempt. */
export type AttemptStatus = number | 'timeout' | 'network';

/** One HTTP POST try for a message. Append-only in the delivery log. */
export interface Attempt {
  messageId: string;
  endpointId: string;
  tenant: string;
  eventType: string;
  /** 0-based attempt index. */
  attemptNo: number;
  status: AttemptStatus;
  latencyMs: number;
  /** Truncated response body snippet (secrets/configured fields redacted). */
  respSnippet: string;
  ts: number;
  outcome: 'delivered' | 'retried' | 'dead';
}

/**
 * Machine-readable reason a message landed in the DLQ.
 * - `exhausted_retries`   retry schedule ran out
 * - `permanent_4xx`       receiver returned a non-retryable 4xx/3xx
 * - `blocked_ssrf`        target refused by the URL/SSRF policy (never delivered)
 * - `endpoint_gone`       endpoint was deleted/disabled after the message was enqueued
 * - `circuit_open_expired` reserved for a future "parked past max retention" path (not emitted in v0.1)
 */
export type DlqReason =
  | 'exhausted_retries'
  | 'permanent_4xx'
  | 'blocked_ssrf'
  | 'endpoint_gone'
  | 'circuit_open_expired';
