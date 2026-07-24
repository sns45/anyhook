/** @fileoverview Lambda entrypoints: API Gateway ingest (portal), SQS delivery consumer, scheduled sweeper. @module @anyhook/aws */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, SQSEvent, SQSBatchResponse, ScheduledEvent } from 'aws-lambda';
import { createPortalRouter } from '@anyhook/core';
import { buildEngine } from './adapter.js';
import { runSweeper } from './sweeper.js';
import { resolveEnv, type AwsConfig } from './config.js';

/**
 * API Gateway (HTTP API, payload format 2.0) → core's framework-agnostic portal router. Like the
 * Cloudflare Worker template, anyhook does NOT authenticate end customers here (G8): mount this
 * behind the producer's own auth, which must set the trusted `x-anyhook-tenant` header (e.g. via a
 * Lambda authorizer or an upstream auth-gateway). See docs/composition-auth.md.
 */
export function createIngestHandler(config: AwsConfig) {
  return async function ingestHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const { engine } = buildEngine(config);
    const router = createPortalRouter(engine);
    const res = await router(toWebRequest(event));
    return toApiGatewayResult(res);
  };
}

/**
 * SQS event-source Lambda: one invocation per batch. Each record drives one engine delivery
 * attempt via `transport.dispatchRecords`; a throwing record is reported through
 * `batchItemFailures` so only it is redelivered (requires `FunctionResponseTypes:
 * ReportBatchItemFailures` configured on the event source mapping).
 */
export function createDeliverHandler(config: AwsConfig) {
  return async function deliverHandler(event: SQSEvent): Promise<SQSBatchResponse> {
    const { engine, adapter } = buildEngine(config);
    await adapter.transport.subscribe((m) => engine.processMessage(m));
    return adapter.transport.dispatchRecords(event);
  };
}

/**
 * Scheduled (EventBridge, fixed 60s rate per D2/ADR-0001) Lambda: sweeps due `SCHED#` rows and
 * enqueues them to SQS. `_event` is accepted for handler-signature parity with the other entrypoints
 * but unused — the sweeper reads only the clock and the table.
 */
export function createSweeperHandler(config: AwsConfig) {
  return async function sweeperHandler(_event: ScheduledEvent): Promise<void> {
    const env = resolveEnv(config);
    await runSweeper(env);
  };
}

// ---- API Gateway (HTTP API v2) <-> Web Request/Response adapters ----

function toWebRequest(event: APIGatewayProxyEventV2): Request {
  const proto = event.headers?.['x-forwarded-proto'] ?? 'https';
  const host = event.headers?.host ?? event.requestContext?.domainName ?? 'localhost';
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = `${proto}://${host}${event.rawPath}${qs}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (v !== undefined) headers.set(k, v);
  }

  const method = event.requestContext.http.method;
  const hasBody = method !== 'GET' && method !== 'HEAD' && event.body !== undefined;
  const body = hasBody ? (event.isBase64Encoded ? Buffer.from(event.body!, 'base64') : event.body) : undefined;

  return new Request(url, { method, headers, body });
}

async function toApiGatewayResult(res: Response): Promise<APIGatewayProxyResultV2> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const body = await res.text();
  return { statusCode: res.status, headers, body };
}
