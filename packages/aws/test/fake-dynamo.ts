/** @fileoverview Test-only in-memory DynamoDB fake layered on aws-sdk-client-mock: evaluates the small ConditionExpression/UpdateExpression vocabulary this adapter actually emits. @module @anyhook/aws (test) */
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

export type FakeItem = Record<string, unknown> & { PK: string; SK: string };

export function conditionalCheckFailed(message = 'The conditional request failed'): Error {
  return Object.assign(new Error(message), { name: 'ConditionalCheckFailedException' });
}

function keyOf(pk: string, sk: string): string {
  return `${pk}#${sk}`;
}

/**
 * A minimal fake covering exactly the DynamoDB vocabulary `state-dynamo.ts` / `scheduler.ts` /
 * `sweeper.ts` emit: `Get`/`Put`/`Delete` by `{PK,SK}`, `Query` by `PK + begins_with(SK, prefix)`
 * OR by a GSI (`gsi1pk`/`gsi1sk`), `Update` for the two expressions this adapter writes (`ADD seq
 * :one`, `SET claimed = :true`), and `ConditionExpression` evaluation for
 * `attribute_not_exists(...)` / `#alias = :value` so a genuine optimistic-concurrency race
 * (read stale version, write, get rejected) is reproducible in a unit test, not just mocked away.
 */
export function createFakeDynamo() {
  const table = new Map<string, FakeItem>();
  const ddbMock = mockClient(DynamoDBDocumentClient);

  function evalCondition(
    expr: string | undefined,
    existing: FakeItem | undefined,
    names: Record<string, string> | undefined,
    values: Record<string, unknown> | undefined,
  ): boolean {
    if (!expr) return true;
    if (expr.startsWith('attribute_not_exists(')) {
      const rawAttr = expr.slice('attribute_not_exists('.length, -1);
      const attr = rawAttr.startsWith('#') ? names?.[rawAttr] : rawAttr;
      return existing === undefined || existing[attr!] === undefined;
    }
    if (expr.includes('=')) {
      const [rawAttr, rawVal] = expr.split('=').map((s) => s.trim());
      const attr = rawAttr!.startsWith('#') ? names?.[rawAttr!] : rawAttr;
      return existing !== undefined && attr !== undefined && existing[attr] === values?.[rawVal!];
    }
    return true;
  }

  ddbMock.on(PutCommand).callsFake((input) => {
    const item = input.Item as FakeItem;
    const k = keyOf(item.PK, item.SK);
    const existing = table.get(k);
    if (!evalCondition(input.ConditionExpression, existing, input.ExpressionAttributeNames, input.ExpressionAttributeValues)) {
      throw conditionalCheckFailed();
    }
    table.set(k, item);
    return {};
  });

  ddbMock.on(GetCommand).callsFake((input) => {
    const key = input.Key as { PK: string; SK: string };
    return { Item: table.get(keyOf(key.PK, key.SK)) };
  });

  ddbMock.on(QueryCommand).callsFake((input) => {
    const values = input.ExpressionAttributeValues ?? {};
    if (input.IndexName) {
      const pk = values[':pk'] as string;
      const max = values[':now'] as number;
      const items = [...table.values()].filter((i) => i.gsi1pk === pk && (i.gsi1sk as number) <= max);
      return { Items: items };
    }
    const pk = values[':pk'] as string;
    const prefix = values[':skPrefix'] as string;
    const items = [...table.values()]
      .filter((i) => i.PK === pk && (i.SK as string).startsWith(prefix))
      .sort((a, b) => ((a.SK as string) < (b.SK as string) ? -1 : 1));
    return { Items: items };
  });

  ddbMock.on(UpdateCommand).callsFake((input) => {
    const key = input.Key as { PK: string; SK: string };
    const k = keyOf(key.PK, key.SK);
    const existing = table.get(k);
    if (!evalCondition(input.ConditionExpression, existing, input.ExpressionAttributeNames, input.ExpressionAttributeValues)) {
      throw conditionalCheckFailed();
    }
    if (input.UpdateExpression === 'ADD seq :one') {
      const seq = ((existing?.seq as number | undefined) ?? 0) + 1;
      const next: FakeItem = { ...(existing ?? { PK: key.PK, SK: key.SK }), seq };
      table.set(k, next);
      return { Attributes: { seq } };
    }
    if (input.UpdateExpression === 'SET claimed = :true') {
      const next: FakeItem = { ...(existing as FakeItem), claimed: true };
      table.set(k, next);
      return { Attributes: next };
    }
    throw new Error(`fake-dynamo: unsupported UpdateExpression ${String(input.UpdateExpression)}`);
  });

  ddbMock.on(DeleteCommand).callsFake((input) => {
    const key = input.Key as { PK: string; SK: string };
    table.delete(keyOf(key.PK, key.SK));
    return {};
  });

  return { ddbMock, table, keyOf };
}
