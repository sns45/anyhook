/** @fileoverview createAdapter: assembles the Cloudflare port implementations for the engine. @module @anyhook/cloudflare */
import { defaultUrlPolicy, type UrlPolicy } from '@anyhook/core';
import type { Env } from './env.js';
import { CfQueuesTransport } from './transport-cf-queues.js';
import { DoStateStore } from './state-do.js';
import { DoScheduler } from './scheduler-alarms.js';
import { createFetchHttpClient } from './http-fetch.js';

export interface CfAdapter {
  transport: CfQueuesTransport;
  state: DoStateStore;
  scheduler: DoScheduler;
  http: ReturnType<typeof createFetchHttpClient>;
}

export interface CreateAdapterOptions {
  /** URL policy for delivery targets. Defaults to the SSRF-safe deny-list (G6). */
  urlPolicy?: UrlPolicy;
}

/**
 * Build the four engine ports for the Cloudflare runtime from the Worker `Env`. The returned pieces
 * are passed to `new WebhookEngine({ ...adapter, signer })`. The `http` client re-checks the URL
 * policy at dispatch time (defense-in-depth for SSRF, G6).
 */
export function createAdapter(env: Env, opts: CreateAdapterOptions = {}): CfAdapter {
  const urlPolicy = opts.urlPolicy ?? defaultUrlPolicy();
  return {
    transport: new CfQueuesTransport(env.QUEUE),
    state: new DoStateStore(env),
    scheduler: new DoScheduler(env),
    http: createFetchHttpClient({ urlPolicy }),
  };
}
