/** @fileoverview Portal HTTP router: routing, status codes, tenant-from-auth, filters, replay (§7.2/7.3, G7/G8/G10). @module @anyhook/core */
import { describe, test, expect } from 'bun:test';
import { createPortalRouter } from '../src/portal/http.js';
import { makeEngine } from './_harness.js';

function router() {
  const h = makeEngine();
  const handle = createPortalRouter(h.engine);
  return { h, handle };
}

const req = (method: string, path: string, body?: unknown, tenant = 'acme') =>
  new Request('http://portal' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(tenant ? { 'x-anyhook-tenant': tenant } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('portal HTTP router', () => {
  test('401 when tenant cannot be resolved (no auth header)', async () => {
    const { handle } = router();
    const res = await handle(new Request('http://portal/v1/endpoints', { method: 'GET' }));
    expect(res.status).toBe(401);
  });

  test('endpoint lifecycle: create(201) → list → get → patch → rotate → delete', async () => {
    const { h, handle } = router();
    await h.engine.start();

    const created = await handle(req('POST', '/v1/endpoints', { url: 'https://a/h', eventTypes: ['*'] }));
    expect(created.status).toBe(201);
    const { endpointId, secret } = (await created.json()) as { endpointId: string; secret: string };
    expect(secret.startsWith('whsec_')).toBe(true);

    const list = await (await handle(req('GET', '/v1/endpoints'))).json();
    expect(Array.isArray(list) && list.length).toBe(1);
    expect('secrets' in (list as Record<string, unknown>[])[0]!).toBe(false); // G10

    const got = await handle(req('GET', `/v1/endpoints/${endpointId}`));
    expect(got.status).toBe(200);

    const patched = await handle(req('PATCH', `/v1/endpoints/${endpointId}`, { disabled: true }));
    expect(((await patched.json()) as { disabled: boolean }).disabled).toBe(true);

    const rotated = await handle(req('POST', `/v1/endpoints/${endpointId}/rotate-secret`));
    expect(((await rotated.json()) as { secret: string }).secret.startsWith('whsec_')).toBe(true);

    const del = await handle(req('DELETE', `/v1/endpoints/${endpointId}`));
    expect(del.status).toBe(200);
    expect((await handle(req('GET', `/v1/endpoints/${endpointId}`))).status).toBe(404);
  });

  test('ingest returns 202 with a receipt', async () => {
    const { h, handle } = router();
    await h.engine.start();
    await handle(req('POST', '/v1/endpoints', { url: 'https://a/h', eventTypes: ['*'] }));
    const res = await handle(req('POST', '/v1/events', { type: 'x.y', payload: { a: 1 } }));
    expect(res.status).toBe(202);
    expect((await res.json()) as { accepted: boolean }).toMatchObject({ accepted: true, messageCount: 1 });
  });

  test('delivery log filters + single message get + replay', async () => {
    const { h, handle } = router();
    await h.engine.start();
    await handle(req('POST', '/v1/endpoints', { url: 'https://a/h', eventTypes: ['*'] }));
    await handle(req('POST', '/v1/events', { type: 'payment.succeeded', payload: {} }));
    await handle(req('POST', '/v1/events', { type: 'user.created', payload: {} }));
    await h.transport.drain();

    const filtered = (await (await handle(req('GET', '/v1/deliveries?eventType=payment.succeeded'))).json()) as { message: { messageId: string; eventType: string } }[];
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.message.eventType).toBe('payment.succeeded');

    const messageId = filtered[0]!.message.messageId;
    const one = await handle(req('GET', `/v1/deliveries/${messageId}`));
    expect(one.status).toBe(200);

    const replay = await handle(req('POST', `/v1/deliveries/${messageId}/replay`));
    expect(replay.status).toBe(202);
    expect(await handle(req('GET', '/v1/deliveries/msg_does_not_exist'))).toHaveProperty('status', 404);
  });

  test('tenant isolation: acme cannot read globex deliveries (G7)', async () => {
    const { h, handle } = router();
    await h.engine.start();
    await handle(req('POST', '/v1/endpoints', { url: 'https://g/h', eventTypes: ['*'] }, 'globex'));
    await handle(req('POST', '/v1/events', { type: 'x.y', payload: {} }, 'globex'));
    await h.transport.drain();

    const acmeView = (await (await handle(req('GET', '/v1/deliveries', undefined, 'acme'))).json()) as unknown[];
    expect(acmeView.length).toBe(0);
    const globexView = (await (await handle(req('GET', '/v1/deliveries', undefined, 'globex'))).json()) as unknown[];
    expect(globexView.length).toBe(1);
  });

  test('invalid JSON body → 400; unknown route → 404', async () => {
    const { h, handle } = router();
    await h.engine.start();
    const bad = new Request('http://portal/v1/endpoints', { method: 'POST', headers: { 'x-anyhook-tenant': 'acme', 'content-type': 'application/json' }, body: '{not json' });
    expect((await handle(bad)).status).toBe(400);
    expect((await handle(req('GET', '/v1/nonsense'))).status).toBe(404);
  });
});
