/** @fileoverview SSRF default-policy tests (§12, G6). @module @anyhook/core */
import { describe, test, expect } from 'bun:test';
import { defaultUrlPolicy } from '../src/security/url-policy.js';

describe('SSRF default URL policy (G6)', () => {
  const policy = defaultUrlPolicy();

  test.each([
    ['http://169.254.169.254/latest/meta-data', false], // cloud metadata
    ['http://127.0.0.1/hook', false],
    ['http://localhost:8080/hook', false],
    ['http://10.0.0.5/hook', false],
    ['http://172.16.0.1/hook', false],
    ['http://192.168.1.1/hook', false],
    ['file:///etc/passwd', false],
    ['gopher://evil/', false],
    ['http://[::1]/hook', false],
    ['http://[fd00::1]/hook', false],
    ['https://example.com/hook', true],
    ['https://api.customer.com/webhooks/anyhook', true],
    ['http://93.184.216.34/hook', true], // public literal IP
  ] as const)('%s -> allowed=%p', async (url, allowed) => {
    const res = await policy.check(url);
    expect(res.allowed).toBe(allowed);
  });

  test('https-only mode rejects http', async () => {
    const strict = defaultUrlPolicy({ allowHttp: false });
    expect((await strict.check('http://example.com')).allowed).toBe(false);
    expect((await strict.check('https://example.com')).allowed).toBe(true);
  });

  test('extraDeny blocks a specific host', async () => {
    const p = defaultUrlPolicy({ extraDeny: ['blocked.example.com'] });
    expect((await p.check('https://blocked.example.com/x')).allowed).toBe(false);
  });
});
