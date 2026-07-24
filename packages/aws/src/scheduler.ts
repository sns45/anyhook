/** @fileoverview DynamoScheduler: retries ≤900s use native SQS DelaySeconds; longer retries persist a due_at row for the sweeper (D2/ADR-0001, P2). @module @anyhook/aws */
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Scheduler, Message, Clock } from '@anyhook/core';
import { tenantPk, schedSk, SCHED_GSI_PK, SQS_MAX_DELAY_MS, SCHED_TTL_GRACE_SECONDS, type Env } from './config.js';

/**
 * `Scheduler` for AWS (D2 — "the 900-second split, no delay-chaining"): a retry due within SQS's
 * 900s `DelaySeconds` cap is sent immediately with that native delay; anything further out is
 * persisted as a `SCHED#` row carrying a `due_at` (epoch seconds) attribute, indexed by the
 * `due_at` GSI, for `runSweeper` to discover on its fixed interval. Per P2, the DynamoDB item IS
 * the schedule; this class never chains multiple delayed sends to cover a longer delay.
 */
export class DynamoScheduler implements Scheduler {
  constructor(
    private readonly env: Env,
    private readonly clock: Clock = { now: () => Date.now() },
  ) {}

  async scheduleRetry(m: Message, at: number): Promise<void> {
    const delayMs = at - this.clock.now();

    if (delayMs <= SQS_MAX_DELAY_MS) {
      const delaySeconds = Math.min(900, Math.max(0, Math.ceil(delayMs / 1000)));
      await this.env.sqs.send(
        new SendMessageCommand({ QueueUrl: this.env.queueUrl, MessageBody: JSON.stringify(m), DelaySeconds: delaySeconds }),
      );
      return;
    }

    const dueAtSec = Math.floor(at / 1000);
    await this.env.ddb.send(
      new PutCommand({
        TableName: this.env.tableName,
        Item: {
          PK: tenantPk(m.tenant),
          SK: schedSk(m.messageId),
          message: m,
          due_at: dueAtSec,
          ttl: dueAtSec + SCHED_TTL_GRACE_SECONDS, // GC-only (D2) — never the scheduling trigger
          gsi1pk: SCHED_GSI_PK,
          gsi1sk: dueAtSec,
        },
      }),
    );
  }
}
