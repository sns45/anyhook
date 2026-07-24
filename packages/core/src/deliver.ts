/** @fileoverview Single-attempt delivery: SSRF check → sign → POST → classify (§8, G4/G6/G9). @module @anyhook/core */
import type { HttpClient, WebhookSigner, UrlPolicy, Clock } from './ports/index.js';
import type { Endpoint } from './types/endpoint.js';
import type { Message } from './types/message.js';
import type { AttemptStatus } from './types/attempt.js';
import { classifyOutcome, type Outcome } from './policy/outcome.js';

export interface DeliverPorts {
  http: HttpClient;
  signer: WebhookSigner;
  urlPolicy: UrlPolicy;
  clock: Clock;
  timeoutMs: number;
  /** Max response snippet length stored in the delivery log. */
  snippetLimit?: number;
}

export interface DeliveryResult {
  status: AttemptStatus;
  outcome: Outcome;
  latencyMs: number;
  respSnippet: string;
  /** Parsed, capped `Retry-After` in ms (429/503 only), when present. */
  retryAfterMs?: number;
  /** True when the target was refused by the URL policy (SSRF), before any POST. */
  blockedBySsrf?: boolean;
}

/** Parse a `Retry-After` header (integer seconds) into ms. Ignores HTTP-date form for v0.1. */
function parseRetryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  const raw = headers?.['retry-after'];
  if (!raw) return undefined;
  const secs = Number(raw.trim());
  if (!Number.isFinite(secs) || secs < 0) return undefined;
  return secs * 1000;
}

/**
 * Perform ONE delivery POST for a message. Assumes the caller already checked the circuit.
 * Signs the body (Standard Webhooks; `webhook-id` = the stable messageId so retries dedupe),
 * enforces the URL policy first (SSRF → permanent), and classifies the transport outcome.
 */
export async function deliverOnce(m: Message, endpoint: Endpoint, p: DeliverPorts): Promise<DeliveryResult> {
  const limit = p.snippetLimit ?? 512;
  const body = JSON.stringify(m.payload);

  const ssrf = await p.urlPolicy.check(endpoint.url);
  if (!ssrf.allowed) {
    return { status: 'network', outcome: 'permanent', latencyMs: 0, respSnippet: `ssrf_blocked:${ssrf.reason ?? 'denied'}`, blockedBySsrf: true };
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...p.signer.sign(endpoint.secrets, m.messageId, body, p.clock.now()),
  };

  const start = p.clock.now();
  const res = await p.http.post(endpoint.url, body, headers, p.timeoutMs);
  const latencyMs = Math.max(0, p.clock.now() - start);

  if (typeof res.status !== 'number') {
    // 'timeout' | 'network'
    return { status: res.status, outcome: 'retryable', latencyMs, respSnippet: res.status };
  }

  const httpStatus = res.status;
  const outcome = classifyOutcome(httpStatus);
  const retryAfterMs =
    httpStatus === 429 || httpStatus === 503 ? parseRetryAfterMs(res.headers) : undefined;
  return { status: httpStatus, outcome, latencyMs, respSnippet: (res.body ?? '').slice(0, limit), retryAfterMs };
}
