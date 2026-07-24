/** @fileoverview Producer event + acceptance receipt types. @module @anyhook/core */

/**
 * A single business occurrence emitted by the producer via `engine.send()`.
 */
export interface SendEvent {
  /** Dot-namespaced event type, e.g. `payment.succeeded`. Required. */
  type: string;
  /** Isolation scope (the producer's customer). Required. */
  tenant: string;
  /** JSON-serializable payload. Required. */
  payload: unknown;
  /** Optional idempotency key; auto-derived from the event when omitted (§9). */
  idempotencyKey?: string;
  /** Optional, non-signed routing hints. */
  metadata?: Record<string, string>;
}

/** Returned by `send()` once the event is durably accepted (never blocks on delivery). */
export interface Receipt {
  eventId: string;
  accepted: true;
  /** Matched endpoints at acceptance time. 0 is valid and not an error. */
  messageCount: number;
}
