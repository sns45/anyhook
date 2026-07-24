/** @fileoverview runSweeper: fixed-interval discovery of due SCHED# rows via the due_at GSI, claimed via a conditional write before enqueueing (D2/ADR-0001, P2). @module @anyhook/aws */
import { QueryCommand, UpdateCommand, DeleteCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Message } from '@anyhook/core';
import { SCHED_GSI_PK, type Env } from './config.js';

export interface SweeperResult {
  /** Rows found due (`due_at <= now`) across all pages this run scanned. */
  due: number;
  /** Rows this run successfully claimed (won the compare-and-set). */
  claimed: number;
  /** Rows sent to SQS and cleaned up (== claimed, barring a send/delete throw). */
  sent: number;
}

function isConditionalCheckFailed(e: unknown): boolean {
  return (e as { name?: string } | undefined)?.name === 'ConditionalCheckFailedException';
}

/**
 * Discover every `SCHED#` row whose `due_at <= now` via the `due_at` GSI, claim each with a
 * conditional `UpdateItem` (`attribute_not_exists(claimed)`) BEFORE sending it to SQS, then delete
 * the row. The claim is what makes two concurrent sweeper invocations safe: only one can win the
 * conditional write for a given row, so a message is enqueued at most once from this path — the
 * other invocation's `ConditionalCheckFailedException` is caught and treated as "someone else has
 * it" rather than retried (D2/ADR-0001). DynamoDB's `ttl` attribute on the row is garbage-collection
 * only; this sweeper — not TTL expiry — is the actual scheduling trigger.
 */
export async function runSweeper(env: Env, now: number = Date.now()): Promise<SweeperResult> {
  const nowSec = Math.floor(now / 1000);
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
    const items = (page.Items as { PK: string; SK: string; message: Message; claimed?: boolean }[]) ?? [];

    for (const item of items) {
      if (item.claimed) continue; // already claimed by an earlier page/run; the row will be deleted or TTL'd
      result.due++;

      try {
        await env.ddb.send(
          new UpdateCommand({
            TableName: env.tableName,
            Key: { PK: item.PK, SK: item.SK },
            UpdateExpression: 'SET claimed = :true',
            ConditionExpression: 'attribute_not_exists(claimed)',
            ExpressionAttributeValues: { ':true': true },
          }),
        );
      } catch (e) {
        if (isConditionalCheckFailed(e)) continue; // a concurrent sweeper invocation won the claim first
        throw e;
      }
      result.claimed++;

      // Claimed and already due: enqueue with no additional SQS-side delay.
      await env.sqs.send(new SendMessageCommand({ QueueUrl: env.queueUrl, MessageBody: JSON.stringify(item.message), DelaySeconds: 0 }));
      await env.ddb.send(new DeleteCommand({ TableName: env.tableName, Key: { PK: item.PK, SK: item.SK } }));
      result.sent++;
    }

    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return result;
}
