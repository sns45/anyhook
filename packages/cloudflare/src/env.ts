/** @fileoverview Cloudflare Worker environment bindings (D3: one Durable Object per endpoint). @module @anyhook/cloudflare */
import type { Message } from '@anyhook/core';
import type { TenantIndexDurableObject } from './tenant-do.js';
import type { EndpointDurableObject } from './endpoint-do.js';

/**
 * Worker bindings wired by the deploying application (wrangler config / Worker template).
 * `TENANT_INDEX` and `ENDPOINT` are Durable Object namespaces bound to the two DO classes
 * exported from this package; `QUEUE` is the Cloudflare Queue used as the delivery transport.
 */
export interface Env {
  /** One Durable Object instance per tenant (id = `idFromName(tenant)`): endpoints, idempotency, message index. */
  TENANT_INDEX: DurableObjectNamespace<TenantIndexDurableObject>;
  /** One Durable Object instance per endpoint (id = `idFromName(`${tenant}:${endpointId}`)`): messages, attempts, circuit, DLQ, retry alarms. */
  ENDPOINT: DurableObjectNamespace<EndpointDurableObject>;
  /** Delivery transport; retry alarms re-enqueue onto this queue. */
  QUEUE: Queue<Message>;
}

/**
 * Deterministic name for an endpoint's Durable Object. Length-prefixes the tenant so the
 * `tenant`/`endpointId` boundary is unambiguous even if a tenant identifier contains a `:` —
 * `endpointDoName('a:b','x')` and `endpointDoName('a','b:x')` can never collide (G7).
 */
export function endpointDoName(tenant: string, endpointId: string): string {
  return `${tenant.length}:${tenant}:${endpointId}`;
}
