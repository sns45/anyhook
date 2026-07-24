/** @fileoverview AWS runtime config: table/queue/GSI names, injectable SDK clients, single-table key helpers. @module @anyhook/aws */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';

/** Default name of the GSI indexing `due_at` (partition key `gsi1pk`, sort key `gsi1sk`) that the sweeper queries (D2/ADR-0001, P2). */
export const DEFAULT_DUE_AT_INDEX_NAME = 'due_at-index';
/** Constant GSI partition key value every `SCHED#` row is written under. A single logical partition is
 * an accepted v0.1 scale tradeoff (see `sweeper.ts`); revisit with a bucketed key if volume demands it. */
export const SCHED_GSI_PK = 'SCHED';
/** SQS's hard cap on native `DelaySeconds`. Retries due sooner than this use SQS delay directly (D2). */
export const SQS_MAX_DELAY_MS = 900_000;
/** How long a swept `SCHED#` row survives before DynamoDB TTL reclaims it. GC only — never the scheduling trigger (D2). */
export const SCHED_TTL_GRACE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Deploy-time configuration for the AWS adapter. `tableName`/`queueUrl` name the single DynamoDB
 * table and SQS queue this adapter owns. SDK clients can be pre-built and injected — required for
 * tests (`aws-sdk-client-mock`) and useful for LocalStack (`endpoint`) or a custom credential chain.
 */
export interface AwsConfig {
  tableName: string;
  queueUrl: string;
  /** Name of the GSI indexing `due_at` (partition key `gsi1pk`, sort key `gsi1sk`). Defaults to `due_at-index`. */
  dueAtIndexName?: string;
  region?: string;
  /** Endpoint override (e.g. LocalStack `http://localhost:4566`). Ignored for a client that was injected directly. */
  endpoint?: string;
  /** Pre-built DynamoDB Document client. Inject in tests via `aws-sdk-client-mock`. */
  ddbDocClient?: DynamoDBDocumentClient;
  /** Pre-built SQS client. Inject in tests via `aws-sdk-client-mock`. */
  sqsClient?: SQSClient;
}

/** Resolved runtime environment: config plus the concrete SDK clients every port implementation shares. */
export interface Env {
  tableName: string;
  queueUrl: string;
  dueAtIndexName: string;
  ddb: DynamoDBDocumentClient;
  sqs: SQSClient;
}

/** Build the resolved `Env` from `AwsConfig`, constructing default SDK clients only when none are injected. */
export function resolveEnv(config: AwsConfig): Env {
  const region = config.region ?? process.env.AWS_REGION ?? 'us-east-1';
  const ddb =
    config.ddbDocClient ??
    DynamoDBDocumentClient.from(new DynamoDBClient({ region, endpoint: config.endpoint }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  const sqs = config.sqsClient ?? new SQSClient({ region, endpoint: config.endpoint });
  return {
    tableName: config.tableName,
    queueUrl: config.queueUrl,
    dueAtIndexName: config.dueAtIndexName ?? DEFAULT_DUE_AT_INDEX_NAME,
    ddb,
    sqs,
  };
}

/** Read `AwsConfig` from the conventional Lambda environment variables (used by the deployed handlers' entrypoint). */
export function configFromEnv(env: Record<string, string | undefined> = process.env): AwsConfig {
  const tableName = env.ANYHOOK_TABLE_NAME;
  const queueUrl = env.ANYHOOK_QUEUE_URL;
  if (!tableName) throw new Error('configFromEnv: ANYHOOK_TABLE_NAME is required');
  if (!queueUrl) throw new Error('configFromEnv: ANYHOOK_QUEUE_URL is required');
  return {
    tableName,
    queueUrl,
    dueAtIndexName: env.ANYHOOK_DUE_AT_INDEX_NAME,
    region: env.AWS_REGION,
  };
}

// ---- Single-table key helpers (shared by state-dynamo.ts / scheduler.ts / sweeper.ts) ----
//
// PK = `TENANT#<tenant>` for every item (G7: every query is tenant-partitioned by construction).
// SK is prefixed by item type:
//   EP#<endpointId>          endpoint
//   MSG#<messageId>          message
//   MIDX#<messageId>         message->endpoint index (write-only seam for a future by-endpoint GSI)
//   ATT#<messageId>#<seq>    one delivery attempt (zero-padded seq preserves insertion order on read)
//   ATTCOUNT#<messageId>     atomic attempt-sequence counter
//   CIRCUIT#<endpointId>     circuit-breaker record (+ internal `_version` for optimistic concurrency)
//   DLQ#<seq>                one dead-lettered message (zero-padded global-per-tenant seq)
//   DLQSEQ                   atomic DLQ-sequence counter
//   IDEM#<idemKey>           idempotency record
//   SCHED#<messageId>        a scheduled-in-the-future retry, discovered via the `due_at` GSI

/** Every item for a tenant lives under this partition key (G7: tenant scoping by construction). */
export function tenantPk(tenant: string): string {
  return `TENANT#${tenant}`;
}

export const endpointSk = (endpointId: string): string => `EP#${endpointId}`;
export const messageSk = (messageId: string): string => `MSG#${messageId}`;
export const messageIndexSk = (messageId: string): string => `MIDX#${messageId}`;
export const attemptSk = (messageId: string, seq: number): string => `ATT#${messageId}#${String(seq).padStart(10, '0')}`;
export const attemptSkPrefix = (messageId: string): string => `ATT#${messageId}#`;
export const attemptCounterSk = (messageId: string): string => `ATTCOUNT#${messageId}`;
export const circuitSk = (endpointId: string): string => `CIRCUIT#${endpointId}`;
export const dlqSk = (seq: number): string => `DLQ#${String(seq).padStart(16, '0')}`;
export const dlqCounterSk = (): string => 'DLQSEQ';
export const idemSk = (idemKey: string): string => `IDEM#${idemKey}`;
export const schedSk = (messageId: string): string => `SCHED#${messageId}`;
