/** @fileoverview Runtime ports (interfaces) implemented by adapters. Core imports NO runtime SDK. @module @anyhook/core */

import type { Endpoint, CircuitRecord } from '../types/endpoint.js';
import type { Message, MessageStatus } from '../types/message.js';
import type { Attempt, DlqReason } from '../types/attempt.js';

/** Monotonic-ish wall clock (epoch ms). Injected for deterministic tests. */
export interface Clock {
  now(): number;
}

/** Uniform random source in [0, 1). Injected so jitter/ids are deterministic in tests. */
export interface Rng {
  next(): number;
}

/** Result of a single delivery POST. `headers` (lowercased keys) let the engine honor `Retry-After` (§9.1). */
export type HttpResult =
  | { status: number; body: string; headers?: Record<string, string> }
  | { status: 'timeout' | 'network' };

/** Outbound HTTP capability. Adapters enforce SSRF/redirect policy at connection time. */
export interface HttpClient {
  post(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<HttpResult>;
}

/** SSRF/scheme policy applied before delivery (§10, G6). */
export interface UrlPolicy {
  check(url: string): Promise<{ allowed: boolean; reason?: string }>;
}

/**
 * Standard Webhooks signing capability, injected so `@anyhook/core` stays zero-runtime-dep (G1).
 * `@anyhook/signing` provides a structurally-compatible implementation via `createSigner()`.
 * `secrets` = the endpoint's active secret(s) (more than one during a rotation window).
 */
export interface WebhookSigner {
  sign(
    secrets: string[],
    id: string,
    payload: string,
    timestampMs: number,
  ): Record<string, string>;
}

/**
 * Transport axis (anyq). Durably buffers messages between ingest and delivery.
 * anyhook composes anyq here; endpoint retry state NEVER lives in the transport (G2).
 */
export interface Transport {
  /** Durably enqueue a message for delivery. Resolves at durable acceptance (G5). */
  send(m: Message): Promise<void>;
  /** Register the delivery handler (the engine's `processMessage`). */
  subscribe(handler: (m: Message) => Promise<void>): Promise<void>;
}

/** Scheduler axis. Owns "attempt this message again at time T" (the state store is the schedule). */
export interface Scheduler {
  scheduleRetry(m: Message, at: number): Promise<void>;
}

/** Query shape for the delivery-log surface. */
export interface DeliveryQuery {
  tenant: string;
  endpointId?: string;
  eventType?: string;
  status?: MessageStatus;
  before?: number;
  after?: number;
  limit?: number;
}

/**
 * Durable state axis: idempotency, endpoints, messages, attempts, circuit state, DLQ.
 * Every method is tenant-scoped (G7). Cloudflare → Durable Objects; AWS → DynamoDB.
 */
export interface StateStore {
  /** Idempotency: returns `{ isNew: false }` if the (tenant, idemKey) was already accepted. */
  recordEvent(tenant: string, eventId: string, idemKey: string): Promise<{ isNew: boolean; eventId: string; messageCount: number }>;
  /** Persist the acceptance result for an idempotency key so replays of `send()` return the same receipt. */
  finalizeEvent(tenant: string, idemKey: string, eventId: string, messageCount: number): Promise<void>;

  createEndpoint(
    e: Omit<Endpoint, 'endpointId' | 'createdAt' | 'secrets' | 'disabled'>,
  ): Promise<{ endpoint: Endpoint; secret: string }>;
  getEndpoint(tenant: string, endpointId: string): Promise<Endpoint | null>;
  listEndpoints(tenant: string): Promise<Endpoint[]>;
  matchEndpoints(tenant: string, eventType: string): Promise<Endpoint[]>;
  updateEndpoint(
    tenant: string,
    endpointId: string,
    patch: Partial<Pick<Endpoint, 'url' | 'eventTypes' | 'disabled'>>,
  ): Promise<Endpoint>;
  rotateSecret(tenant: string, endpointId: string): Promise<{ secret: string }>;
  deleteEndpoint(tenant: string, endpointId: string): Promise<void>;

  putMessage(m: Message): Promise<void>;
  getMessage(tenant: string, messageId: string): Promise<Message | null>;
  appendAttempt(a: Attempt): Promise<void>;
  listDeliveries(q: DeliveryQuery): Promise<{ message: Message; attempts: Attempt[] }[]>;

  getCircuit(tenant: string, endpointId: string): Promise<CircuitRecord>;
  putCircuit(tenant: string, endpointId: string, rec: CircuitRecord): Promise<void>;

  addToDlq(m: Message, reason: DlqReason): Promise<void>;
  listDlq(tenant: string, endpointId?: string): Promise<{ message: Message; reason: DlqReason }[]>;
}
