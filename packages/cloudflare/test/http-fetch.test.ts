/** @fileoverview HttpClient (fetch) behavior: status mapping, manual redirect, timeout, network, SSRF (G6/G9). @module @anyhook/cloudflare */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { defaultUrlPolicy } from '@anyhook/core';
import { createFetchHttpClient } from '../src/http-fetch.js';

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/ok') return new Response('yay', { status: 200 });
      if (path === '/notfound') return new Response('nope', { status: 404 });
      if (path === '/boom') return new Response('err', { status: 500 });
      if (path === '/redirect') return new Response(null, { status: 302, headers: { location: '/ok' } });
      if (path === '/ratelimited') return new Response('slow down', { status: 429, headers: { 'retry-after': '7' } });
      if (path === '/slow') {
        await Bun.sleep(300);
        return new Response('late', { status: 200 });
      }
      return new Response('?', { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

describe('createFetchHttpClient (G9)', () => {
  const http = createFetchHttpClient();

  test('2xx returns status + body', async () => {
    const r = await http.post(`${base}/ok`, '{}', {}, 5000);
    expect(r).toMatchObject({ status: 200, body: 'yay' });
  });

  test('404 returns 404', async () => {
    expect((await http.post(`${base}/notfound`, '{}', {}, 5000)).status).toBe(404);
  });

  test('500 returns 500', async () => {
    expect((await http.post(`${base}/boom`, '{}', {}, 5000)).status).toBe(500);
  });

  test('redirect is NOT followed → reported as 3xx', async () => {
    const r = await http.post(`${base}/redirect`, '{}', {}, 5000);
    expect(typeof r.status === 'number' && r.status >= 300 && r.status < 400).toBe(true);
  });

  test('429 surfaces retry-after header', async () => {
    const r = await http.post(`${base}/ratelimited`, '{}', {}, 5000);
    expect(r.status).toBe(429);
    expect('headers' in r && r.headers?.['retry-after']).toBe('7');
  });

  test('timeout maps to {status:"timeout"}', async () => {
    expect((await http.post(`${base}/slow`, '{}', {}, 50)).status).toBe('timeout');
  });

  test('connection failure maps to {status:"network"}', async () => {
    // port 1 is not listening
    expect((await http.post('http://127.0.0.1:1/x', '{}', {}, 2000)).status).toBe('network');
  });

  test('urlPolicy refusal short-circuits to network without dispatch', async () => {
    const guarded = createFetchHttpClient({ urlPolicy: defaultUrlPolicy() });
    expect((await guarded.post('http://169.254.169.254/meta', '{}', {}, 2000)).status).toBe('network');
  });
});
