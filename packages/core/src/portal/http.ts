/** @fileoverview Framework-agnostic portal HTTP router (Web Request/Response). Mount behind the producer's auth (G8). @module @anyhook/core */
import type { WebhookEngine } from '../engine.js';

/** Thrown by a handler to produce a specific HTTP status (e.g. 404). */
export class PortalHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PortalHttpError';
  }
}

export interface PortalRouterOptions {
  /**
   * Resolve the tenant for a request. anyhook does NOT authenticate end customers (G8): mount this
   * router behind the producer's own auth, which sets a trusted signal. Default reads the
   * `x-anyhook-tenant` header — NEVER a request-body field, so a request bypassing auth cannot
   * name an arbitrary tenant.
   */
  resolveTenant?: (req: Request) => string | undefined;
  /** Route prefix (default `/v1`). */
  basePath?: string;
}

const jsonRes = (data: unknown, status = 200): Response =>
  new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function parseLimit(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseTs(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build a `(Request) => Promise<Response>` covering the full portal + ingest surface (§7.1/7.2/7.3):
 *
 *   POST   {base}/events                                  ingest an event (202)
 *   POST   {base}/endpoints                               create endpoint (201; secret returned ONCE)
 *   GET    {base}/endpoints                               list endpoints (secrets redacted, G10)
 *   GET    {base}/endpoints/:id                           get one endpoint
 *   PATCH  {base}/endpoints/:id                           update (url/eventTypes/disabled)
 *   POST   {base}/endpoints/:id/rotate-secret             rotate signing secret (new secret ONCE)
 *   DELETE {base}/endpoints/:id                           delete endpoint
 *   POST   {base}/endpoints/:id/replay                    bulk-replay this endpoint's DLQ (?since=)
 *   GET    {base}/deliveries                              delivery log (filters via query string)
 *   GET    {base}/deliveries/:messageId                   one message + its attempt history
 *   POST   {base}/deliveries/:messageId/replay            re-enqueue a single message
 *
 * Runtime-agnostic: works in any environment with Web `Request`/`Response` (Workers, Bun, Node 18+,
 * Lambda via an adapter). Keeps `@anyhook/core` dependency-free (no HTTP framework).
 */
export function createPortalRouter(engine: WebhookEngine, opts: PortalRouterOptions = {}): (req: Request) => Promise<Response> {
  const base = opts.basePath ?? '/v1';
  const resolveTenant = opts.resolveTenant ?? ((req: Request) => req.headers.get('x-anyhook-tenant') ?? undefined);

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(base + '/')) return jsonRes({ error: 'not found' }, 404);
    const segs = url.pathname.slice(base.length + 1).split('/').filter(Boolean);
    const m = req.method.toUpperCase();

    const tenant = resolveTenant(req);
    if (!tenant) return jsonRes({ error: 'unauthenticated: missing tenant' }, 401);

    try {
      // ---- ingest ----
      if (m === 'POST' && segs.length === 1 && segs[0] === 'events') {
        const body = (await req.json()) as { type: string; payload: unknown; idempotencyKey?: string; metadata?: Record<string, string> };
        if (!body?.type) throw new PortalHttpError(400, 'type is required');
        const receipt = await engine.send({ type: body.type, tenant, payload: body.payload, idempotencyKey: body.idempotencyKey, metadata: body.metadata });
        return jsonRes(receipt, 202);
      }

      // ---- endpoints collection ----
      if (segs[0] === 'endpoints' && segs.length === 1) {
        if (m === 'POST') {
          const body = (await req.json()) as { url: string; eventTypes: string[]; description?: string; rateLimit?: number };
          if (!body?.url || !Array.isArray(body?.eventTypes)) throw new PortalHttpError(400, 'url and eventTypes are required');
          const created = await engine.endpoints.create({ tenant, url: body.url, eventTypes: body.eventTypes, description: body.description, rateLimit: body.rateLimit });
          return jsonRes(created, 201);
        }
        if (m === 'GET') return jsonRes(await engine.endpoints.list({ tenant }));
      }

      // ---- endpoints/:id (+ sub-actions) ----
      if (segs[0] === 'endpoints' && segs.length >= 2) {
        const endpointId = segs[1]!;
        if (segs.length === 2 && m === 'GET') {
          const ep = await engine.endpoints.get({ tenant, endpointId });
          if (!ep) throw new PortalHttpError(404, 'endpoint not found');
          return jsonRes(ep);
        }
        if (segs.length === 2 && m === 'PATCH') {
          const body = (await req.json()) as { url?: string; eventTypes?: string[]; disabled?: boolean };
          return jsonRes(await engine.endpoints.update({ tenant, endpointId, ...body }));
        }
        if (segs.length === 2 && m === 'DELETE') {
          await engine.endpoints.delete({ tenant, endpointId });
          return jsonRes({ deleted: true }, 200);
        }
        if (segs.length === 3 && segs[2] === 'rotate-secret' && m === 'POST') {
          return jsonRes(await engine.endpoints.rotateSecret({ tenant, endpointId }), 200);
        }
        if (segs.length === 3 && segs[2] === 'replay' && m === 'POST') {
          const since = parseTs(url.searchParams.get('since'));
          return jsonRes(await engine.deliveries.replayEndpoint({ tenant, endpointId, since }), 202);
        }
      }

      // ---- deliveries ----
      if (segs[0] === 'deliveries' && segs.length === 1 && m === 'GET') {
        const q = url.searchParams;
        return jsonRes(
          await engine.deliveries.list({
            tenant,
            endpointId: q.get('endpointId') ?? undefined,
            eventType: q.get('eventType') ?? undefined,
            status: (q.get('status') as never) ?? undefined,
            before: parseTs(q.get('before')),
            after: parseTs(q.get('after')),
            limit: parseLimit(q.get('limit')),
          }),
        );
      }
      if (segs[0] === 'deliveries' && segs.length === 2 && m === 'GET') {
        const rec = await engine.deliveries.get({ tenant, messageId: segs[1]! });
        if (!rec) throw new PortalHttpError(404, 'message not found');
        return jsonRes(rec);
      }
      if (segs[0] === 'deliveries' && segs.length === 3 && segs[2] === 'replay' && m === 'POST') {
        const res = await engine.deliveries.replay({ tenant, messageId: segs[1]! });
        return jsonRes(res, res.replayed ? 202 : 404);
      }

      return jsonRes({ error: 'not found' }, 404);
    } catch (err) {
      if (err instanceof PortalHttpError) return jsonRes({ error: err.message }, err.status);
      if (err instanceof SyntaxError) return jsonRes({ error: 'invalid JSON body' }, 400);
      const msg = (err as Error).message ?? 'error';
      if (/not found/i.test(msg)) return jsonRes({ error: msg }, 404);
      return jsonRes({ error: msg }, 500);
    }
  };
}
