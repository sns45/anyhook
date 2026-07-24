/** @fileoverview Deployable Worker template: ingest + queue consumer + minimal portal (G8 auth seam). @module @anyhook/cloudflare */
import { WebhookEngine } from '@anyhook/core';
import { createSigner } from '@anyhook/signing';
import { createAdapter } from './adapter.js';
import type { Env } from './env.js';
import type { Message } from '@anyhook/core';

// Re-export the Durable Object classes so wrangler can bind them from this entrypoint.
export { TenantIndexDurableObject } from './tenant-do.js';
export { EndpointDurableObject } from './endpoint-do.js';

function buildEngine(env: Env): { engine: WebhookEngine; transport: ReturnType<typeof createAdapter>['transport'] } {
  const adapter = createAdapter(env);
  const engine = new WebhookEngine({
    transport: adapter.transport,
    state: adapter.state,
    scheduler: adapter.scheduler,
    http: adapter.http,
    signer: createSigner(),
  });
  return { engine, transport: adapter.transport };
}

/**
 * Resolve the tenant. anyhook does NOT authenticate end customers (G8): the portal APIs mount behind
 * the PRODUCER's own auth (auth-gateway). This template trusts ONLY the `x-anyhook-tenant` header that
 * the upstream auth layer sets/verifies — never a client-supplied body field, so a request that
 * bypasses the gateway cannot name an arbitrary tenant. Deployers MUST enforce auth in front of this Worker.
 */
function tenantOf(req: Request): string | undefined {
  return req.headers.get('x-anyhook-tenant') ?? undefined;
}

/** Parse a positive integer query param, or undefined when absent/invalid (never NaN → empty result). */
function parseLimit(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { engine } = buildEngine(env);

    try {
      // Ingest: emit an event (async accept, never blocks on delivery — G5).
      if (req.method === 'POST' && url.pathname === '/v1/events') {
        const body = (await req.json()) as { type: string; payload: unknown; idempotencyKey?: string; metadata?: Record<string, string> };
        const tenant = tenantOf(req);
        if (!tenant) return json({ error: 'missing tenant' }, 400);
        const receipt = await engine.send({ type: body.type, tenant, payload: body.payload, idempotencyKey: body.idempotencyKey, metadata: body.metadata });
        return json(receipt, 202);
      }

      // Portal: create endpoint (secret returned once).
      if (req.method === 'POST' && url.pathname === '/v1/endpoints') {
        const body = (await req.json()) as { url: string; eventTypes: string[]; description?: string; rateLimit?: number };
        const tenant = tenantOf(req);
        if (!tenant) return json({ error: 'missing tenant' }, 400);
        const created = await engine.endpoints.create({ tenant, url: body.url, eventTypes: body.eventTypes, description: body.description, rateLimit: body.rateLimit });
        return json(created, 201);
      }

      // Portal: list endpoints.
      if (req.method === 'GET' && url.pathname === '/v1/endpoints') {
        const tenant = tenantOf(req);
        if (!tenant) return json({ error: 'missing tenant' }, 400);
        return json(await engine.endpoints.list({ tenant }));
      }

      // Portal: delivery log (filters via query string).
      if (req.method === 'GET' && url.pathname === '/v1/deliveries') {
        const tenant = tenantOf(req);
        if (!tenant) return json({ error: 'missing tenant' }, 400);
        const q = url.searchParams;
        const rows = await engine.deliveries.list({
          tenant,
          endpointId: q.get('endpointId') ?? undefined,
          eventType: q.get('eventType') ?? undefined,
          limit: parseLimit(q.get('limit')),
        });
        return json(rows);
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: (err as Error).message }, 400);
    }
  },

  /** Queue consumer: each delivered message drives one engine delivery attempt. */
  async queue(batch: MessageBatch<Message>, env: Env): Promise<void> {
    const { engine, transport } = buildEngine(env);
    await transport.subscribe((m) => engine.processMessage(m));
    await transport.dispatchBatch(batch);
  },
};
