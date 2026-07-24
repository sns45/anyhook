/** @fileoverview HttpClient over the platform `fetch`, with manual-redirect + timeout + SSRF re-check (G6). @module @anyhook/cloudflare */
import type { HttpClient, HttpResult, UrlPolicy } from '@anyhook/core';

export interface FetchHttpClientOptions {
  /**
   * Re-run this policy immediately before dispatch (belt-and-suspenders SSRF; DNS-rebinding note:
   * the fetch API does not expose the resolved IP, so this is the static hostname policy re-applied).
   */
  urlPolicy?: UrlPolicy;
  /** Max response-body snippet retained (bytes). */
  snippetLimit?: number;
}

/**
 * HttpClient backed by `fetch`. Redirects are NOT followed (`redirect: 'manual'`): a 3xx on a webhook
 * target is treated as a delivery failure (§8). Timeouts map to `{status:'timeout'}`, other transport
 * errors to `{status:'network'}`.
 */
export function createFetchHttpClient(opts: FetchHttpClientOptions = {}): HttpClient {
  const snippetLimit = opts.snippetLimit ?? 2048;

  return {
    async post(url, body, headers, timeoutMs): Promise<HttpResult> {
      if (opts.urlPolicy) {
        const check = await opts.urlPolicy.check(url);
        if (!check.allowed) return { status: 'network' };
      }

      try {
        const res = await fetch(url, {
          method: 'POST',
          body,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });

        // Normalize redirect responses across runtimes: undici surfaces `opaqueredirect` with status 0
        // (only in the bun-test environment; workerd's `redirect:'manual'` surfaces the real 3xx status).
        // Either way, report a 3xx so the engine classifies it permanent.
        if ((res.type as string) === 'opaqueredirect' || (res.status === 0 && (res.type as string) !== 'error')) {
          return { status: 302, body: '', headers: {} };
        }

        const text = await res.text().catch(() => '');
        const respHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          respHeaders[k.toLowerCase()] = v;
        });
        return { status: res.status, body: text.slice(0, snippetLimit), headers: respHeaders };
      } catch (e) {
        const name = (e as { name?: string })?.name;
        if (name === 'TimeoutError' || name === 'AbortError') return { status: 'timeout' };
        return { status: 'network' };
      }
    },
  };
}
