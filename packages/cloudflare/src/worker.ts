/** @fileoverview Deployable Worker template: ingest + queue consumer + portal (G8 auth seam). @module @anyhook/cloudflare */
import { WebhookEngine, createPortalRouter } from '@anyhook/core';
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

export default {
  /**
   * Portal + ingest HTTP surface, delegated to core's framework-agnostic router. anyhook does NOT
   * authenticate end customers (G8): the router trusts ONLY the `x-anyhook-tenant` header that the
   * upstream auth layer (e.g. auth-gateway) sets/verifies. Deployers MUST enforce auth in front of
   * this Worker. See docs/composition-auth.md.
   */
  async fetch(req: Request, env: Env): Promise<Response> {
    const { engine } = buildEngine(env);
    return createPortalRouter(engine)(req);
  },

  /** Queue consumer: each delivered message drives one engine delivery attempt. */
  async queue(batch: MessageBatch<Message>, env: Env): Promise<void> {
    const { engine, transport } = buildEngine(env);
    await transport.subscribe((m) => engine.processMessage(m));
    await transport.dispatchBatch(batch);
  },
};
