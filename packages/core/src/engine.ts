/** @fileoverview WebhookEngine: async send() + fan-out + delivery/retry/circuit/DLQ orchestration. @module @anyhook/core */
import type {
  Transport,
  StateStore,
  Scheduler,
  HttpClient,
  WebhookSigner,
  UrlPolicy,
  Clock,
  Rng,
} from './ports/index.js';
import type { SendEvent, Receipt } from './types/event.js';
import type { Message } from './types/message.js';
import type { Attempt, DlqReason } from './types/attempt.js';
import type { RetryConfig, CircuitConfig } from './types/config.js';
import { DEFAULT_SCHEDULE_MS, nextDelayMs } from './policy/retry.js';
import { fullJitter } from './policy/jitter.js';
import { DEFAULT_FAILURE_THRESHOLD, DEFAULT_COOLDOWN_MS, canAttempt, toHalfOpen, onSuccess, onFailure } from './policy/circuit.js';
import { deriveIdempotencyKey, newId } from './id.js';
import { fanout } from './fanout.js';
import { deliverOnce } from './deliver.js';
import { defaultUrlPolicy } from './security/url-policy.js';
import { createEndpointApi, type EndpointApi } from './portal/endpoints.js';
import { createDeliveryApi, type DeliveryApi } from './portal/deliveries.js';

const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface EngineOptions {
  transport: Transport;
  state: StateStore;
  scheduler: Scheduler;
  http: HttpClient;
  /** Injected so @anyhook/core stays zero-runtime-dep (G1); build from @anyhook/signing's createSigner(). */
  signer: WebhookSigner;
  urlPolicy?: UrlPolicy;
  clock?: Clock;
  rng?: Rng;
  retry?: Partial<RetryConfig>;
  circuit?: Partial<CircuitConfig>;
  maxPayloadBytes?: number;
  timeoutMs?: number;
}

/**
 * The runtime-agnostic webhook delivery engine. Producers call `send()`; the engine fans out,
 * signs, delivers, retries with jittered backoff, circuit-breaks dead endpoints, and dead-letters
 * exhausted messages. All durable state lives behind the injected ports (G1/G2).
 */
export class WebhookEngine {
  private readonly transport: Transport;
  private readonly state: StateStore;
  private readonly scheduler: Scheduler;
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly retry: RetryConfig;
  private readonly circuitCfg: CircuitConfig;
  private readonly maxPayloadBytes: number;
  private readonly deliverPorts: {
    http: HttpClient;
    signer: WebhookSigner;
    urlPolicy: UrlPolicy;
    clock: Clock;
    timeoutMs: number;
  };

  readonly endpoints: EndpointApi;
  readonly deliveries: DeliveryApi;

  constructor(opts: EngineOptions) {
    this.transport = opts.transport;
    this.state = opts.state;
    this.scheduler = opts.scheduler;
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.rng = opts.rng ?? { next: () => Math.random() };
    this.retry = { scheduleMs: opts.retry?.scheduleMs ?? DEFAULT_SCHEDULE_MS };
    this.circuitCfg = {
      failureThreshold: opts.circuit?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
      cooldownMs: opts.circuit?.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    };
    this.maxPayloadBytes = opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.deliverPorts = {
      http: opts.http,
      signer: opts.signer,
      urlPolicy: opts.urlPolicy ?? defaultUrlPolicy(),
      clock: this.clock,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    this.endpoints = createEndpointApi(this.state);
    this.deliveries = createDeliveryApi(this.state, this.transport, this.clock);
  }

  /** Register the delivery handler with the transport (call once at worker startup). */
  async start(): Promise<void> {
    await this.transport.subscribe((m) => this.processMessage(m));
  }

  /**
   * Durably accept an event and return at acceptance — NEVER blocks on delivery (G5).
   * Records idempotency, fans out to matching endpoints, and enqueues one message each.
   */
  async send(event: SendEvent): Promise<Receipt> {
    if (!event.type) throw new Error('send: event.type is required');
    if (!event.tenant) throw new Error('send: event.tenant is required');
    const body = JSON.stringify(event.payload);
    if (Buffer.byteLength(body, 'utf8') > this.maxPayloadBytes) {
      throw new Error(`send: payload exceeds maxPayloadBytes (${this.maxPayloadBytes})`);
    }

    const idemKey = event.idempotencyKey ?? deriveIdempotencyKey(event);
    const eventId = newId('evt', this.rng);
    const rec = await this.state.recordEvent(event.tenant, eventId, idemKey);
    if (!rec.isNew) {
      // Idempotent replay: return the original receipt without re-fanning-out.
      // NOTE: `messageCount` reflects the value at finalizeEvent() time. A duplicate that races the
      // ORIGINAL send (before it finalizes) may observe 0. Correct enforcement of "exactly-once
      // acceptance under concurrency/crash" is the state adapter's job — the Cloudflare Durable Object
      // is single-threaded per (tenant,endpoint) and AWS uses DynamoDB conditional writes (D2/ADR-0001).
      return { eventId: rec.eventId, accepted: true, messageCount: rec.messageCount };
    }

    const endpoints = await this.state.matchEndpoints(event.tenant, event.type);
    const messages = fanout(event, eventId, endpoints, this.rng, this.clock.now());
    for (const m of messages) {
      await this.state.putMessage(m);
      await this.transport.send(m);
    }
    await this.state.finalizeEvent(event.tenant, idemKey, eventId, messages.length);
    return { eventId, accepted: true, messageCount: messages.length };
  }

  /**
   * Deliver one message once, then advance its independent retry/circuit/DLQ state.
   * Called by the transport subscription (a worker) — one message can never affect another (G3).
   */
  async processMessage(m: Message): Promise<void> {
    const endpoint = await this.state.getEndpoint(m.tenant, m.endpointId);
    if (!endpoint || endpoint.disabled) {
      // Endpoint deleted/disabled after enqueue: dead-letter so it is visible, don't retry forever.
      // Append a terminal attempt for delivery-log consistency with every other DLQ path.
      const goneAttempt: Attempt = {
        messageId: m.messageId, endpointId: m.endpointId, tenant: m.tenant, eventType: m.eventType,
        attemptNo: m.attemptNo, status: 'network', latencyMs: 0, respSnippet: 'endpoint_gone', ts: this.clock.now(), outcome: 'dead',
      };
      await this.dlq(m, goneAttempt, 'endpoint_gone');
      return;
    }

    // Circuit gate (normalize cooldown to engine config).
    let circuit = { ...(await this.state.getCircuit(m.tenant, m.endpointId)), cooldownMs: this.circuitCfg.cooldownMs };
    const gate = canAttempt(circuit, this.clock.now());
    if (!gate.allow) {
      // Circuit open within cooldown: park as blocked (NOT an attempt) and re-probe after cooldown.
      // Jitter the wake time so a backlog of parked messages doesn't stampede the moment cooldown ends.
      await this.state.putMessage({ ...m, status: 'blocked' });
      const base = (circuit.openedAt ?? this.clock.now()) + circuit.cooldownMs;
      const probeAt = base + fullJitter(circuit.cooldownMs, this.rng);
      await this.scheduler.scheduleRetry(m, probeAt);
      return;
    }
    if (gate.probe) {
      circuit = toHalfOpen(circuit);
      await this.state.putCircuit(m.tenant, m.endpointId, circuit);
    }

    await this.state.putMessage({ ...m, status: 'delivering' });
    const result = await deliverOnce(m, endpoint, this.deliverPorts);

    const attempt: Attempt = {
      messageId: m.messageId,
      endpointId: m.endpointId,
      tenant: m.tenant,
      eventType: m.eventType,
      attemptNo: m.attemptNo,
      status: result.status,
      latencyMs: result.latencyMs,
      respSnippet: result.respSnippet,
      ts: this.clock.now(),
      outcome: 'retried',
    };

    if (result.outcome === 'delivered') {
      await this.state.putCircuit(m.tenant, m.endpointId, onSuccess(circuit));
      await this.state.putMessage({ ...m, status: 'delivered' });
      attempt.outcome = 'delivered';
      await this.state.appendAttempt(attempt);
      return;
    }

    if (result.outcome === 'permanent') {
      // 4xx (except 429) or SSRF refusal → straight to DLQ, no retry (§8/G9).
      await this.state.putCircuit(m.tenant, m.endpointId, onFailure(circuit, this.clock.now(), this.circuitCfg.failureThreshold));
      await this.dlq(m, attempt, result.blockedBySsrf ? 'blocked_ssrf' : 'permanent_4xx');
      return;
    }

    // retryable: 429 / 5xx / timeout / network
    circuit = onFailure(circuit, this.clock.now(), this.circuitCfg.failureThreshold);
    await this.state.putCircuit(m.tenant, m.endpointId, circuit);

    const delay = nextDelayMs(this.retry, m.attemptNo, this.rng, result.retryAfterMs);
    if (delay === null) {
      await this.dlq(m, attempt, 'exhausted_retries');
      return;
    }

    await this.state.appendAttempt(attempt); // outcome 'retried'
    const at = this.clock.now() + delay;
    const next: Message = { ...m, attemptNo: m.attemptNo + 1, status: 'retrying', nextAttemptAt: at };
    await this.state.putMessage(next);
    await this.scheduler.scheduleRetry(next, at);
  }

  private async dlq(m: Message, attempt: Attempt, reason: DlqReason): Promise<void> {
    await this.state.putMessage({ ...m, status: 'dead' });
    attempt.outcome = 'dead';
    await this.state.appendAttempt(attempt);
    await this.state.addToDlq(m, reason);
  }
}
