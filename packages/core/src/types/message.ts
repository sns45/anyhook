/** @fileoverview Message (event × endpoint delivery obligation) type. @module @anyhook/core */

/**
 * Delivery status for one message.
 * - `pending`    accepted, not yet attempted
 * - `delivering` attempt in flight
 * - `delivered`  received a 2xx
 * - `retrying`   transient failure, scheduled for a future attempt
 * - `blocked`    endpoint circuit is open; parked, not counted as an attempt
 * - `dead`       moved to the DLQ (exhausted or permanent failure)
 */
export type MessageStatus =
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'retrying'
  | 'blocked'
  | 'dead';

/**
 * One (event × endpoint) delivery obligation. Fan-out turns 1 event into N messages,
 * each with INDEPENDENT retry/circuit state (the key isolation invariant, §3).
 */
export interface Message {
  messageId: string;
  tenant: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  /** 0-based attempt index into the retry schedule. */
  attemptNo: number;
  status: MessageStatus;
  /** Epoch ms of the next scheduled attempt, when `status === 'retrying'`. */
  nextAttemptAt?: number;
  createdAt: number;
}
