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

/** Machine-readable reason a message landed in the DLQ. */
export type DlqReason = 'exhausted_retries' | 'permanent_4xx' | 'circuit_open_expired';
