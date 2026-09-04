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
  // Eventual-consistency knob: keys here are treated as not yet visible to a default (eventually
  // consistent) GetItem, exactly as a not-yet-caught-up replica would behave. A GetItem carrying
  // ConsistentRead:true bypasses this and always sees the leader's value. Writes (Put) evaluate their
  // ConditionExpression against the real table, since DynamoDB checks conditions on the leader.
  const staleKeys = new Set<string>();
  const ddbMock = mockClient(DynamoDBDocumentClient);

  // Split `s` on top-level occurrences of `op` (respecting parentheses).
  function splitTop(s: string, op: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let last = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (depth === 0 && s.startsWith(op, i)) {
        parts.push(s.slice(last, i));
        i += op.length - 1;
        last = i + 1;
      }
    }
    parts.push(s.slice(last));
    return parts;
  }

  function stripOuterParens(s: string): string {
    s = s.trim();
    while (s.startsWith('(') && s.endsWith(')')) {
      let depth = 0;
      let wraps = true;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') {
          depth--;
          if (depth === 0 && i < s.length - 1) { wraps = false; break; }
        }
      }
      if (!wraps) break;
      s = s.slice(1, -1).trim();
    }
    return s;
  }

  const resolveAttr = (raw: string, names?: Record<string, string>) => (raw.startsWith('#') ? names?.[raw] : raw);

  // Minimal boolean-expression evaluator over the vocabulary this adapter emits:
  // attribute_exists / attribute_not_exists, `A = :v`, `A < :v`, combined with AND/OR + parentheses.
  function evalCondition(
    expr: string | undefined,
    existing: FakeItem | undefined,
    names: Record<string, string> | undefined,
    values: Record<string, unknown> | undefined,
  ): boolean {
    if (!expr) return true;
    const s = stripOuterParens(expr);

    const ors = splitTop(s, ' OR ');
    if (ors.length > 1) return ors.some((p) => evalCondition(p, existing, names, values));
    const ands = splitTop(s, ' AND ');
    if (ands.length > 1) return ands.every((p) => evalCondition(p, existing, names, values));

    const p = s.trim();
    if (p.startsWith('attribute_not_exists(')) {
      const attr = resolveAttr(p.slice('attribute_not_exists('.length, -1), names);
      return existing === undefined || existing[attr!] === undefined;
    }
    if (p.startsWith('attribute_exists(')) {
      const attr = resolveAttr(p.slice('attribute_exists('.length, -1), names);
      return existing !== undefined && attr !== undefined && existing[attr] !== undefined;
    }
    if (p.includes('<')) {
      const [rawAttr, rawVal] = p.split('<').map((x) => x.trim());
      const attr = resolveAttr(rawAttr!, names);
      return existing !== undefined && attr !== undefined && (existing[attr] as number) < (values?.[rawVal!] as number);
    }
    if (p.includes('=')) {
      const [rawAttr, rawVal] = p.split('=').map((x) => x.trim());
      const attr = resolveAttr(rawAttr!, names);
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
    const k = keyOf(key.PK, key.SK);
    // Simulate replica lag: a default read of a stale key sees no item; a ConsistentRead sees it.
    if (staleKeys.has(k) && input.ConsistentRead !== true) return { Item: undefined };
    return { Item: table.get(k) };
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
    if (input.UpdateExpression === 'SET claimed_at = :now') {
      const next: FakeItem = { ...(existing as FakeItem), claimed_at: input.ExpressionAttributeValues?.[':now'] as number };
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

  /** Mark a `{PK,SK}` as not yet visible to eventually consistent reads (a lagging replica). */
  const markStale = (pk: string, sk: string): void => void staleKeys.add(keyOf(pk, sk));

  return { ddbMock, table, keyOf, markStale };
}
