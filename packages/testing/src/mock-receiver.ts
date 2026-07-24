/** @fileoverview Scriptable HTTP target used as an injected HttpClient in tests. @module @anyhook/testing */
import type { HttpClient, HttpResult, Clock } from '@anyhook/core';

export type Script =
  | { kind: 'ok' }
  | { kind: 'permanent'; status: number }
  | { kind: 'failThenOk'; n: number }
  | { kind: 'timeout' }
  | { kind: 'network' }
  | { kind: 'slow'; ms: number };

/** Script constructors matching the §12 MockReceiver matrix. */
export const Receiver = {
  ok: (): Script => ({ kind: 'ok' }),
  permanent: (status = 404): Script => ({ kind: 'permanent', status }),
  failThenOk: (n: number): Script => ({ kind: 'failThenOk', n }),
  timeout: (): Script => ({ kind: 'timeout' }),
  network: (): Script => ({ kind: 'network' }),
  slow: (ms: number): Script => ({ kind: 'slow', ms }),
};

export interface RecordedCall {
  url: string;
  body: string;
  headers: Record<string, string>;
  ts: number;
}

/**
 * Deterministic HttpClient shim. Route a URL to a Script with `.on(url, script)`
 * (unrouted URLs use `.default`). `slow(ms)` returns a timeout iff `ms > timeoutMs`.
 * Records every call for assertions (headers/body/order/count).
 */
export class MockReceiver implements HttpClient {
  default: Script = { kind: 'ok' };
  readonly calls: RecordedCall[] = [];
  private routes = new Map<string, Script>();
  private counters = new Map<string, number>();

  constructor(private readonly clock?: Clock) {}

  on(url: string, script: Script): this {
    this.routes.set(url, script);
    return this;
  }

  async post(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<HttpResult> {
    this.calls.push({ url, body, headers, ts: this.clock ? this.clock.now() : Date.now() });
    const script = this.routes.get(url) ?? this.default;
    const n = this.counters.get(url) ?? 0;
    this.counters.set(url, n + 1);

    switch (script.kind) {
      case 'ok':
        return { status: 200, body: 'ok' };
      case 'permanent':
        return { status: script.status, body: 'rejected' };
      case 'failThenOk':
        return n < script.n ? { status: 500, body: 'err' } : { status: 200, body: 'ok' };
      case 'timeout':
        return { status: 'timeout' };
      case 'network':
        return { status: 'network' };
      case 'slow':
        return script.ms > timeoutMs ? { status: 'timeout' } : { status: 200, body: 'ok' };
    }
  }

  callCount(url?: string): number {
    return url ? this.calls.filter((c) => c.url === url).length : this.calls.length;
  }
}
