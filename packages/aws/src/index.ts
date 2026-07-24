/** @fileoverview Public barrel for @anyhook/aws. @module @anyhook/aws */
export {
  resolveEnv,
  configFromEnv,
  tenantPk,
  DEFAULT_DUE_AT_INDEX_NAME,
  SCHED_GSI_PK,
  SQS_MAX_DELAY_MS,
  SCHED_TTL_GRACE_SECONDS,
} from './config.js';
export type { AwsConfig, Env } from './config.js';

export { createFetchHttpClient } from './http-fetch.js';
export type { FetchHttpClientOptions } from './http-fetch.js';

export { SqsTransport } from './transport-sqs.js';
export type { SqsTransportOptions } from './transport-sqs.js';

export { DynamoStateStore, CircuitWriteConflictError } from './state-dynamo.js';

export { DynamoScheduler } from './scheduler.js';

export { runSweeper } from './sweeper.js';
export type { SweeperResult } from './sweeper.js';

export { createAdapter, buildEngine } from './adapter.js';
export type { AwsAdapter, CreateAdapterOptions } from './adapter.js';

export { createIngestHandler, createDeliverHandler, createSweeperHandler } from './handlers.js';
