/** @fileoverview DynamoStateStore: single-table StateStore on DynamoDB, tenant-partitioned (G7), with conditional writes for circuit + idempotency (D2). @module @anyhook/aws */
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import {
  subscribes,
  initialCircuit,
  type StateStore,
  type DeliveryQuery,
  type Endpoint,
  type CircuitRecord,
  type Message,
  type Attempt,
  type DlqReason,
  type RateBucket,
} from '@anyhook/core';
import { generateSecret } from '@anyhook/signing';
import {
  tenantPk,
  endpointSk,
  messageSk,
  messageIndexSk,
  attemptSk,
  attemptSkPrefix,
  attemptCounterSk,
  circuitSk,
  rateSk,
  dlqSk,
  dlqCounterSk,
  idemSk,
  type Env,
} from './config.js';

/** Thrown by `putCircuit` when a concurrent writer already advanced the circuit's version (optimistic concurrency, D2). */
export class CircuitWriteConflictError extends Error {
  constructor(tenant: string, endpointId: string) {
    super(`circuit write conflict for tenant=${tenant} endpointId=${endpointId}`);
    this.name = 'CircuitWriteConflictError';
  }
}

function isConditionalCheckFailed(e: unknown): boolean {
  return (e as { name?: string } | undefined)?.name === 'ConditionalCheckFailedException';
}

interface StoredEvent {
  eventId: string;
  messageCount: number;
}

/**
 * `StateStore` on a single DynamoDB table (`PK = TENANT#<tenant>`, item-type-prefixed `SK` — see
 * `config.ts` for the full key design). Every method takes/derives `tenant` first and every key is
 * built from it, so no query can address another tenant's rows (G7). Idempotency uses a conditional
 * `PutItem` (`attribute_not_exists(SK)`) so a racing duplicate `recordEvent` is detected atomically.
 *
 * Circuit writes carry an internal `_version` attribute checked via `ConditionExpression`. NOTE: this
 * guards only `putCircuit`'s OWN read→write window, not the engine's full `getCircuit → OnFailure →
 * putCircuit` cycle (`getCircuit` intentionally strips `_version`, so the engine can't round-trip it).
 * Under heavy same-endpoint concurrency a consecutive-failure increment can therefore still be lost —
 * bounded impact: the breaker may trip slightly late, never data corruption or a miscount toward a
 * false trip. A detected conflict throws `CircuitWriteConflictError`, which the SQS consumer turns
 * into a `batchItemFailures` redelivery (at-least-once, self-healing).
 */
export class DynamoStateStore implements StateStore {
  constructor(private readonly env: Env) {}

  // ---- idempotency ----

  async recordEvent(
    tenant: string,
    eventId: string,
    idemKey: string,
  ): Promise<{ isNew: boolean; eventId: string; messageCount: number }> {
    const key = { PK: tenantPk(tenant), SK: idemSk(idemKey) };
    try {
      await this.env.ddb.send(
        new PutCommand({
          TableName: this.env.tableName,
          Item: { ...key, eventId, messageCount: 0 },
          ConditionExpression: 'attribute_not_exists(SK)',
        }),
      );
      return { isNew: true, eventId, messageCount: 0 };
    } catch (e) {
      if (!isConditionalCheckFailed(e)) throw e;
      // Lost the race: another writer's PutItem committed first. Read it back for the original receipt.
      const existing = await this.env.ddb.send(new GetCommand({ TableName: this.env.tableName, Key: key }));
      const item = existing.Item as StoredEvent | undefined;
      if (!item) return { isNew: true, eventId, messageCount: 0 }; // vanishingly unlikely delete race; treat as new
      return { isNew: false, eventId: item.eventId, messageCount: item.messageCount };
    }
  }

  async finalizeEvent(tenant: string, idemKey: string, eventId: string, messageCount: number): Promise<void> {
    await this.env.ddb.send(
      new PutCommand({
        TableName: this.env.tableName,
        Item: { PK: tenantPk(tenant), SK: idemSk(idemKey), eventId, messageCount },
      }),
    );
  }

  // ---- endpoints ----

  async createEndpoint(e: Omit<Endpoint, 'endpointId' | 'createdAt' | 'secrets' | 'disabled'>): Promise<{ endpoint: Endpoint; secret: string }> {
    const secret = generateSecret();
    const endpoint: Endpoint = {
      endpointId: randomUUID(),
      tenant: e.tenant,
      url: e.url,
      eventTypes: [...e.eventTypes],
      description: e.description,
      disabled: false,
      rateLimit: e.rateLimit,
      createdAt: Date.now(),
      secrets: [secret],
    };
    await this.putEndpointItem(endpoint);
    return { endpoint, secret };
  }

  private async putEndpointItem(endpoint: Endpoint): Promise<void> {
    await this.env.ddb.send(
      new PutCommand({
        TableName: this.env.tableName,
        Item: { PK: tenantPk(endpoint.tenant), SK: endpointSk(endpoint.endpointId), ...endpoint },
      }),
    );
  }

  async getEndpoint(tenant: string, endpointId: string): Promise<Endpoint | null> {
    const res = await this.env.ddb.send(
      new GetCommand({ TableName: this.env.tableName, Key: { PK: tenantPk(tenant), SK: endpointSk(endpointId) } }),
    );
    return res.Item ? stripKeys<Endpoint>(res.Item) : null;
  }

  async listEndpoints(tenant: string): Promise<Endpoint[]> {
    const items = await queryAll(this.env, tenantPk(tenant), endpointSk(''));
    return items.map((i) => stripKeys<Endpoint>(i));
  }

  async matchEndpoints(tenant: string, eventType: string): Promise<Endpoint[]> {
    const all = await this.listEndpoints(tenant);
    return all.filter((e) => subscribes(e, eventType));
  }

  async updateEndpoint(
    tenant: string,
    endpointId: string,
    patch: Partial<Pick<Endpoint, 'url' | 'eventTypes' | 'disabled'>>,
  ): Promise<Endpoint> {
    const existing = await this.getEndpoint(tenant, endpointId);
    if (!existing) throw new Error(`endpoint not found: ${endpointId}`);
    const updated: Endpoint = {
      ...existing,
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.eventTypes !== undefined ? { eventTypes: [...patch.eventTypes] } : {}),
      ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
    };
    await this.putEndpointItem(updated);
    return updated;
  }

  async rotateSecret(tenant: string, endpointId: string): Promise<{ secret: string }> {
    const existing = await this.getEndpoint(tenant, endpointId);
    if (!existing) throw new Error(`endpoint not found: ${endpointId}`);
    const secret = generateSecret();
    // dual-secret window: new primary, keep the previous primary for verification
    const updated: Endpoint = { ...existing, secrets: [secret, existing.secrets[0]!] };
    await this.putEndpointItem(updated);
    return { secret };
  }

  async deleteEndpoint(tenant: string, endpointId: string): Promise<void> {
    await this.env.ddb.send(
      new DeleteCommand({ TableName: this.env.tableName, Key: { PK: tenantPk(tenant), SK: endpointSk(endpointId) } }),
    );
  }

  // ---- messages / attempts ----

  async putMessage(m: Message): Promise<void> {
    await this.env.ddb.send(
      new PutCommand({ TableName: this.env.tableName, Item: { PK: tenantPk(m.tenant), SK: messageSk(m.messageId), ...m } }),
    );
    // Message->endpoint index: not needed to READ in this adapter (messages are already keyed by
    // tenant+messageId in this single table, so getMessage below is a direct GetItem), but kept
    // write-only as documented in config.ts — a seam for a future "messages by endpoint" GSI without
    // a migration, mirroring the routing shape other adapters (e.g. Cloudflare's TenantIndexDurableObject) use.
    await this.env.ddb.send(
      new PutCommand({
        TableName: this.env.tableName,
        Item: { PK: tenantPk(m.tenant), SK: messageIndexSk(m.messageId), endpointId: m.endpointId },
      }),
    );
  }

  async getMessage(tenant: string, messageId: string): Promise<Message | null> {
    const res = await this.env.ddb.send(
      new GetCommand({ TableName: this.env.tableName, Key: { PK: tenantPk(tenant), SK: messageSk(messageId) } }),
    );
    return res.Item ? stripKeys<Message>(res.Item) : null;
  }

  /** Atomically increment and return a per-(tenant,sk) counter (used for attempt seq + DLQ seq). */
  private async nextSeq(tenant: string, sk: string): Promise<number> {
    const res = await this.env.ddb.send(
      new UpdateCommand({
        TableName: this.env.tableName,
        Key: { PK: tenantPk(tenant), SK: sk },
        UpdateExpression: 'ADD seq :one',
        ExpressionAttributeValues: { ':one': 1 },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return (res.Attributes as { seq: number }).seq;
  }

  async appendAttempt(a: Attempt): Promise<void> {
    const seq = await this.nextSeq(a.tenant, attemptCounterSk(a.messageId));
    await this.env.ddb.send(
      new PutCommand({
        TableName: this.env.tableName,
        Item: { PK: tenantPk(a.tenant), SK: attemptSk(a.messageId, seq), ...a },
      }),
    );
  }

  private async listAttempts(tenant: string, messageId: string): Promise<Attempt[]> {
    const items = await queryAll(this.env, tenantPk(tenant), attemptSkPrefix(messageId));
    return items.map((i) => stripKeys<Attempt>(i));
  }

  async listDeliveries(q: DeliveryQuery): Promise<{ message: Message; attempts: Attempt[] }[]> {
    const items = await queryAll(this.env, tenantPk(q.tenant), messageSk(''));
    let rows = items.map((i) => stripKeys<Message>(i));
    if (q.endpointId) rows = rows.filter((m) => m.endpointId === q.endpointId);
    if (q.eventType) rows = rows.filter((m) => m.eventType === q.eventType);
    if (q.status) rows = rows.filter((m) => m.status === q.status);
    if (q.before !== undefined) rows = rows.filter((m) => m.createdAt < q.before!);
    if (q.after !== undefined) rows = rows.filter((m) => m.createdAt > q.after!);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    if (q.limit !== undefined) rows = rows.slice(0, q.limit);

    const out: { message: Message; attempts: Attempt[] }[] = [];
    for (const m of rows) {
      out.push({ message: m, attempts: await this.listAttempts(q.tenant, m.messageId) });
    }
    return out;
  }

  // ---- circuit (optimistic concurrency via _version, D2) ----

  async getCircuit(tenant: string, endpointId: string): Promise<CircuitRecord> {
    const res = await this.env.ddb.send(
      new GetCommand({ TableName: this.env.tableName, Key: { PK: tenantPk(tenant), SK: circuitSk(endpointId) } }),
    );
    if (!res.Item) return initialCircuit();
    return stripKeys<CircuitRecord>(res.Item);
  }

  async putCircuit(tenant: string, endpointId: string, rec: CircuitRecord): Promise<void> {
    const key = { PK: tenantPk(tenant), SK: circuitSk(endpointId) };
    const current = await this.env.ddb.send(new GetCommand({ TableName: this.env.tableName, Key: key }));
    const expectedVersion = (current.Item as { _version?: number } | undefined)?._version;
    const nextVersion = (expectedVersion ?? 0) + 1;
    try {
      await this.env.ddb.send(
        new PutCommand({
          TableName: this.env.tableName,
          Item: { ...key, ...rec, _version: nextVersion },
          ConditionExpression: expectedVersion === undefined ? 'attribute_not_exists(#v)' : '#v = :expected',
          ExpressionAttributeNames: { '#v': '_version' },
          ExpressionAttributeValues: expectedVersion === undefined ? undefined : { ':expected': expectedVersion },
        }),
      );
    } catch (e) {
      if (isConditionalCheckFailed(e)) throw new CircuitWriteConflictError(tenant, endpointId);
      throw e;
    }
  }

  // ---- rate limiting (§10) ----

  async getRateBucket(tenant: string, endpointId: string): Promise<RateBucket | null> {
    const res = await this.env.ddb.send(
      new GetCommand({ TableName: this.env.tableName, Key: { PK: tenantPk(tenant), SK: rateSk(endpointId) } }),
    );
    return res.Item ? stripKeys<RateBucket>(res.Item) : null;
  }

  async putRateBucket(tenant: string, endpointId: string, bucket: RateBucket): Promise<void> {
    // Approximate limiter: a plain put is sufficient (no OCC needed — a lost update at most lets one
    // extra delivery through, which throttling tolerates).
    await this.env.ddb.send(
      new PutCommand({
        TableName: this.env.tableName,
        Item: { PK: tenantPk(tenant), SK: rateSk(endpointId), ...bucket },
      }),
    );
  }

  // ---- DLQ ----

  async addToDlq(m: Message, reason: DlqReason): Promise<void> {
    const seq = await this.nextSeq(m.tenant, dlqCounterSk());
    await this.env.ddb.send(
      new PutCommand({
        TableName: this.env.tableName,
        Item: { PK: tenantPk(m.tenant), SK: dlqSk(seq), message: m, reason },
      }),
    );
  }

  async listDlq(tenant: string, endpointId?: string): Promise<{ message: Message; reason: DlqReason }[]> {
    const items = await queryAll(this.env, tenantPk(tenant), 'DLQ#');
    const rows = items.map((i) => ({ message: i.message as Message, reason: i.reason as DlqReason }));
    return endpointId ? rows.filter((r) => r.message.endpointId === endpointId) : rows;
  }
}

/** Strip the table's internal `PK`/`SK`/`_version` attributes before returning a domain object. */
function stripKeys<T>(item: Record<string, unknown>): T {
  const { PK: _PK, SK: _SK, _version: _version, ...rest } = item;
  return rest as T;
}

/** Page through a `Query` for `PK` + `begins_with(SK, prefix)` until exhausted. */
async function queryAll(env: Env, pk: string, skPrefix: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: QueryCommandOutput['LastEvaluatedKey'];
  do {
    const res: QueryCommandOutput = await env.ddb.send(
      new QueryCommand({
        TableName: env.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: { ':pk': pk, ':skPrefix': skPrefix },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((res.Items as Record<string, unknown>[]) ?? []));
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}
