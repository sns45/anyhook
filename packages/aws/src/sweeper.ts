/** @fileoverview runSweeper: fixed-interval discovery of due SCHED# rows via the due_at GSI, claimed via a lease before enqueueing (D2/ADR-0001, P2). @module @anyhook/aws */
import { QueryCommand, UpdateCommand, DeleteCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Message } from '@anyhook/core';
import { SCHED_GSI_PK, SWEEPER_LEASE_SECONDS, type Env } from './config.js';

export interface SweeperResult {
  /** Rows found due (`due_at <= now`) and not currently lease-held across all pages this run scanned. */
  due: number;
  /** Rows this run successfully claimed (won the lease compare-and-set). */
  claimed: number;
  /** Rows sent to SQS and cleaned up. */
  sent: number;
}

function isConditionalCheckFailed(e: unknown): boolean {
  return (e as { name?: string } | undefined)?.name === 'ConditionalCheckFailedException';
}

/**
 * Discover every `SCHED#` row whose `due_at <= now` via the `due_at` GSI, **lease-claim** each with a
 * conditional `UpdateItem` (stamp `claimed_at`) BEFORE sending it to SQS, then delete the row.
 *
 * The lease is what makes two concurrent sweeper invocations safe AND crash/failure-safe:
 * - Only one invocation can win the conditional write for a given row, so the common path enqueues
 *   a message at most once (the loser's `ConditionalCheckFailedException` is caught and skipped).
 * - Crucially, the claim is a LEASE, not a permanent flag: if `SendMessage` throws after a successful
 *   claim (SQS throttling/outage), the row is neither sent nor deleted, but its `claimed_at` lease
 *   expires after `SWEEPER_LEASE_SECONDS`, so a later sweep re-claims and re-enqueues it. A due retry
 *   is therefore never lost (G5) — at worst delayed by one lease interval, or (rarely, under a claim
 *   race that overlaps a lease boundary) delivered twice, which the stable `webhook-id` dedupes.
 *
 * The `attribute_exists(SK)` guard prevents an `UpdateItem` from resurrecting a row another sweep
 * already sent+deleted (no orphan rows). DynamoDB's `ttl` is garbage-collection only; this sweeper —
 * never TTL expiry — is the scheduling trigger.
 */
export async function runSweeper(env: Env, now: number = Date.now()): Promise<SweeperResult> {
  const nowSec = Math.floor(now / 1000);
  const leaseFloorSec = nowSec - SWEEPER_LEASE_SECONDS;
  const result: SweeperResult = { due: 0, claimed: 0, sent: 0 };

  let exclusiveStartKey: QueryCommandOutput['LastEvaluatedKey'];
  do {
    const page: QueryCommandOutput = await env.ddb.send(
      new QueryCommand({
        TableName: env.tableName,
        IndexName: env.dueAtIndexName,
        KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk <= :now',
        ExpressionAttributeValues: { ':pk': SCHED_GSI_PK, ':now': nowSec },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const items = (page.Items as { PK: string; SK: string; message: Message; claimed_at?: number }[]) ?? [];

    for (const item of items) {
      // Skip a row whose lease is still valid (claimed recently by a concurrent/earlier in-flight run).
      if (typeof item.claimed_at === 'number' && item.claimed_at >= leaseFloorSec) continue;
      result.due++;

      try {
        await env.ddb.send(
          new UpdateCommand({
            TableName: env.tableName,
            Key: { PK: item.PK, SK: item.SK },
            UpdateExpression: 'SET claimed_at = :now',
            ConditionExpression: 'attribute_exists(SK) AND (attribute_not_exists(claimed_at) OR claimed_at < :leaseFloor)',
            ExpressionAttributeValues: { ':now': nowSec, ':leaseFloor': leaseFloorSec },
          }),
        );
      } catch (e) {
        if (isConditionalCheckFailed(e)) continue; // lost the claim race, or someone holds a fresh lease
        throw e;
      }
      result.claimed++;

      // Send-then-delete under the held lease. A throw here leaves the row lease-held; it recovers
      // after the lease expires (never lost, G5). The delete is idempotent (no-op if already gone).
      await env.sqs.send(new SendMessageCommand({ QueueUrl: env.queueUrl, MessageBody: JSON.stringify(item.message), DelaySeconds: 0 }));
      await env.ddb.send(new DeleteCommand({ TableName: env.tableName, Key: { PK: item.PK, SK: item.SK } }));
      result.sent++;
    }

    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return result;
}
