# @anyhook/cloudflare

Cloudflare adapter for [anyhook](https://github.com/sns45/anyhook): deploy the outbound webhook engine as a Worker with **no server and no database**.

- **Transport:** [`@anyq/cloudflare-queues`](https://www.npmjs.com/package/@anyq/cloudflare-queues) over a Cloudflare Queue.
- **State:** one **Durable Object per endpoint** (circuit + messages + attempts + DLQ) and one index DO per tenant (endpoints + idempotency).
- **Scheduler:** Durable Object **Alarms** (the state store is the schedule).
- Ships a **deployable Worker template** + `wrangler.toml`.

## Install

```bash
npm i @anyhook/core @anyhook/cloudflare
```

## Overview

```ts
import { WebhookEngine, createPortalRouter } from '@anyhook/core';
import { createSigner } from '@anyhook/signing';
import { createAdapter, TenantIndexDurableObject, EndpointDurableObject } from '@anyhook/cloudflare';

export { TenantIndexDurableObject, EndpointDurableObject };

export default {
  async fetch(req, env) {
    const engine = new WebhookEngine({ ...createAdapter(env), signer: createSigner() });
    return createPortalRouter(engine)(req);
  },
  async queue(batch, env) {
    const { transport, ...ports } = createAdapter(env);
    const engine = new WebhookEngine({ transport, ...ports, signer: createSigner() });
    await transport.subscribe((m) => engine.processMessage(m));
    await transport.dispatchBatch(batch);
  },
};
```

The Worker `queue()` export drives delivery; retries are re-enqueued by DO Alarms. Enable `nodejs_compat` (signing uses `node:crypto`). Mount behind your own auth (see the root `docs/composition-auth.md`). MIT.
