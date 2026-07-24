/** @fileoverview createAdapter: assembles the AWS port implementations for the engine. @module @anyhook/aws */
import { defaultUrlPolicy, WebhookEngine, type UrlPolicy } from '@anyhook/core';
import { createSigner } from '@anyhook/signing';
import { resolveEnv, AWS_MAX_PAYLOAD_BYTES, type AwsConfig, type Env } from './config.js';
import { SqsTransport } from './transport-sqs.js';
import { DynamoStateStore } from './state-dynamo.js';
import { DynamoScheduler } from './scheduler.js';
import { createFetchHttpClient } from './http-fetch.js';

export interface AwsAdapter {
  transport: SqsTransport;
  state: DynamoStateStore;
  scheduler: DynamoScheduler;
  http: ReturnType<typeof createFetchHttpClient>;
  env: Env;
}

export interface CreateAdapterOptions {
  /** URL policy for delivery targets. Defaults to the SSRF-safe deny-list (G6). */
  urlPolicy?: UrlPolicy;
}

/**
 * Build the four engine ports for the AWS runtime from `AwsConfig`. The returned pieces are passed
 * to `new WebhookEngine({ ...adapter, signer })` — see `buildEngine` below, which every Lambda
 * handler uses. The `http` client re-checks the URL policy at dispatch time (defense-in-depth for
 * SSRF, G6).
 */
export function createAdapter(config: AwsConfig, opts: CreateAdapterOptions = {}): AwsAdapter {
  const env = resolveEnv(config);
  const urlPolicy = opts.urlPolicy ?? defaultUrlPolicy();
  return {
    transport: new SqsTransport({ queueUrl: env.queueUrl, region: config.region, endpoint: config.endpoint }),
    state: new DynamoStateStore(env),
    scheduler: new DynamoScheduler(env),
    http: createFetchHttpClient({ urlPolicy }),
    env,
  };
}

/** Build a ready-to-use `WebhookEngine` wired to the AWS adapter (used by every Lambda handler in `handlers.ts`). */
export function buildEngine(config: AwsConfig, opts: CreateAdapterOptions = {}): { engine: WebhookEngine; adapter: AwsAdapter } {
  const adapter = createAdapter(config, opts);
  const engine = new WebhookEngine({
    transport: adapter.transport,
    state: adapter.state,
    scheduler: adapter.scheduler,
    http: adapter.http,
    signer: createSigner(),
    maxPayloadBytes: AWS_MAX_PAYLOAD_BYTES, // leave SQS-body headroom for the message envelope
  });
  return { engine, adapter };
}
