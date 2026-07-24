/** @fileoverview M2.7 end-to-end: deployed Worker → ingest → Queue consumer → signed delivery (§15.1). @module @anyhook/cloudflare */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Miniflare } from 'miniflare';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { verify } from '@anyhook/signing';

interface Delivered {
  url: string;
  headers: Record<string, string>;
  body: string;
}

let mf: Miniflare;
const delivered: Delivered[] = [];

async function bundleWorker(): Promise<string> {
  const outdir = join(import.meta.dir, '.e2e-bundle');
  mkdirSync(outdir, { recursive: true });
  const res = await Bun.build({
    entrypoints: [join(import.meta.dir, '..', 'src', 'worker.ts')],
    outdir,
    target: 'node',
    format: 'esm',
    external: ['cloudflare:workers'],
  });
  if (!res.success) throw new Error('worker bundle failed: ' + res.logs.join('\n'));
  return join(outdir, 'worker.js');
}

beforeAll(async () => {
  const scriptPath = await bundleWorker();
  mf = new Miniflare({
    modules: true,
    scriptPath,
    compatibilityDate: '2024-11-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: {
      TENANT_INDEX: 'TenantIndexDurableObject',
      ENDPOINT: 'EndpointDurableObject',
    },
    queueProducers: { QUEUE: 'anyhook-deliveries' },
    queueConsumers: { 'anyhook-deliveries': { maxBatchSize: 5, maxBatchTimeout: 0 } },
    // Intercept ALL outbound fetch from the Worker (the webhook delivery POST) and record it.
    outboundService(request: Request) {
      return (async () => {
        delivered.push({
          url: request.url,
          headers: Object.fromEntries([...request.headers].map(([k, v]) => [k.toLowerCase(), v])),
          body: await request.text(),
        });
        return new Response('ok', { status: 200 });
      })();
    },
  });
  // Force init.
  await mf.ready;
});

afterAll(async () => {
  await mf?.dispose();
});

const H = { 'content-type': 'application/json', 'x-anyhook-tenant': 'acme' };

describe('Cloudflare end-to-end delivery (§15.1)', () => {
  test('register endpoint → emit event → queue consumer delivers a correctly-signed webhook', async () => {
    // 1. Register an endpoint (secret returned once).
    const createRes = await mf.dispatchFetch('http://w/v1/endpoints', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ url: 'https://receiver.example.com/hook', eventTypes: ['payment.*'] }),
    });
    expect(createRes.status).toBe(201);
    const { endpointId, secret } = (await createRes.json()) as { endpointId: string; secret: string };
    expect(secret.startsWith('whsec_')).toBe(true);

    // 2. Emit an event (async acceptance — 202, never blocks on delivery, G5).
    const sendRes = await mf.dispatchFetch('http://w/v1/events', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ type: 'payment.succeeded', payload: { paymentId: 'p_1', amount: 4200 } }),
    });
    expect(sendRes.status).toBe(202);
    const receipt = (await sendRes.json()) as { accepted: boolean; messageCount: number };
    expect(receipt).toMatchObject({ accepted: true, messageCount: 1 });

    // 3. Wait for the Queue consumer to deliver.
    const deadline = Date.now() + 15_000;
    while (delivered.length === 0 && Date.now() < deadline) {
      await mf.dispatchFetch('http://w/v1/endpoints', { headers: H }); // nudge the runtime
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(delivered.length).toBeGreaterThanOrEqual(1);

    // 4. The delivered webhook is correctly signed and carries the payload.
    const hook = delivered.find((d) => d.url.includes('receiver.example.com'))!;
    expect(hook).toBeDefined();
    expect(JSON.parse(hook.body)).toEqual({ paymentId: 'p_1', amount: 4200 });
    expect(hook.headers['webhook-id']).toBeDefined();
    expect(() => verify(hook.headers, hook.body, secret)).not.toThrow();

    // 5. The delivery is recorded in the delivery log as delivered.
    const logRes = await mf.dispatchFetch(`http://w/v1/deliveries?endpointId=${endpointId}`, { headers: H });
    const rows = (await logRes.json()) as { message: { status: string }; attempts: unknown[] }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.message.status).toBe('delivered');
    expect(rows[0]!.attempts.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
