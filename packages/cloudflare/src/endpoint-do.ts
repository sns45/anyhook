/** @fileoverview EndpointDurableObject: one per endpoint — messages, attempts, circuit, DLQ, retry alarms (D3, P2). @module @anyhook/cloudflare */
import { DurableObject } from 'cloudflare:workers';
import {
  initialCircuit,
  type Message,
  type Attempt,
  type CircuitRecord,
  type DlqReason,
  type DeliveryQuery,
  type RateBucket,
} from '@anyhook/core';
import type { Env } from './env.js';

const MESSAGE_PREFIX = 'msg:';
const ATTEMPT_PREFIX = 'att:';
const DLQ_PREFIX = 'dlq:';
const SCHED_PREFIX = 'sched:';
const CIRCUIT_KEY = 'circuit';
const RATE_KEY = 'rate';
const DLQ_SEQ_KEY = 'dlqSeq';

interface DlqRow {
  message: Message;
  reason: DlqReason;
}

function schedKey(at: number, messageId: string): string {
  return `${SCHED_PREFIX}${at}:${messageId}`;
}

/** Parse the `at` (epoch ms) out of a `sched:<at>:<messageId>` key. */
function parseSchedAt(key: string): number {
  const rest = key.slice(SCHED_PREFIX.length);
  return Number(rest.slice(0, rest.indexOf(':')));
}

/**
 * One Durable Object per endpoint (id = `idFromName(`${tenant}:${endpointId}`)`, see
 * `DoStateStore` / `DoScheduler`). Owns that endpoint's messages, delivery-attempt log,
 * circuit-breaker record, DLQ, AND the Alarms-backed retry schedule — the state store IS the
 * schedule (P2). Every method here is implicitly scoped to this one (tenant, endpoint) pair
 * because that's the DO's identity; callers (the routing `DoStateStore`) still pass full
 * `Message`/`Attempt`/`DeliveryQuery` objects, which already carry `tenant`/`endpointId`.
 */
export class EndpointDurableObject extends DurableObject<Env> {
  async putMessage(m: Message): Promise<void> {
    await this.ctx.storage.put(MESSAGE_PREFIX + m.messageId, m);
  }

  async getMessage(messageId: string): Promise<Message | null> {
    return (await this.ctx.storage.get<Message>(MESSAGE_PREFIX + messageId)) ?? null;
  }

  async appendAttempt(a: Attempt): Promise<void> {
    const key = ATTEMPT_PREFIX + a.messageId;
    const list = (await this.ctx.storage.get<Attempt[]>(key)) ?? [];
    list.push(a);
    await this.ctx.storage.put(key, list);
  }

  /** Filter by eventType/status/before/after + limit, sorted by `createdAt` desc, attempts attached. */
  async listDeliveries(q: DeliveryQuery): Promise<{ message: Message; attempts: Attempt[] }[]> {
    const all = await this.ctx.storage.list<Message>({ prefix: MESSAGE_PREFIX });
    let rows = [...all.values()];
    if (q.eventType) rows = rows.filter((m) => m.eventType === q.eventType);
    if (q.status) rows = rows.filter((m) => m.status === q.status);
    if (q.before !== undefined) rows = rows.filter((m) => m.createdAt < q.before!);
    if (q.after !== undefined) rows = rows.filter((m) => m.createdAt > q.after!);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    if (q.limit !== undefined) rows = rows.slice(0, q.limit);

    const out: { message: Message; attempts: Attempt[] }[] = [];
    for (const m of rows) {
      const attempts = (await this.ctx.storage.get<Attempt[]>(ATTEMPT_PREFIX + m.messageId)) ?? [];
      out.push({ message: m, attempts });
    }
    return out;
  }

  async getCircuit(): Promise<CircuitRecord> {
    return (await this.ctx.storage.get<CircuitRecord>(CIRCUIT_KEY)) ?? initialCircuit();
  }

  async putCircuit(rec: CircuitRecord): Promise<void> {
    await this.ctx.storage.put(CIRCUIT_KEY, rec);
  }

  async getRateBucket(): Promise<RateBucket | null> {
    return (await this.ctx.storage.get<RateBucket>(RATE_KEY)) ?? null;
  }

  async putRateBucket(bucket: RateBucket): Promise<void> {
    await this.ctx.storage.put(RATE_KEY, bucket);
  }

  async addToDlq(m: Message, reason: DlqReason): Promise<void> {
    const seq = ((await this.ctx.storage.get<number>(DLQ_SEQ_KEY)) ?? 0) + 1;
    await this.ctx.storage.put(DLQ_SEQ_KEY, seq);
    const key = `${DLQ_PREFIX}${seq.toString().padStart(16, '0')}:${m.messageId}`;
    const row: DlqRow = { message: m, reason };
    await this.ctx.storage.put(key, row);
  }

  /** `endpointId` accepted for `StateStore.listDlq` signature parity but ignored (this DO IS one endpoint). */
  async listDlq(endpointId?: string): Promise<{ message: Message; reason: DlqReason }[]> {
    const all = await this.ctx.storage.list<DlqRow>({ prefix: DLQ_PREFIX });
    let rows = [...all.values()];
    if (endpointId) rows = rows.filter((r) => r.message.endpointId === endpointId);
    return rows;
  }

  // ---- Scheduler (Alarms): the state store IS the schedule (P2) ----

  /** Persist `m` under `sched:<at>:<messageId>` and ensure the alarm covers the earliest due time. */
  async scheduleRetry(m: Message, at: number): Promise<void> {
    await this.ctx.storage.put(schedKey(at, m.messageId), m);
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || at < currentAlarm) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  /**
   * Fires when the earliest scheduled retry is due. Delegates to `processDueSchedules` — split out
   * because Durable Object RPC deliberately excludes `alarm` from the caller-visible stub surface,
   * so tests (and any other in-process caller) that need to force the same effect without waiting
   * on a real platform alarm invoke `processDueSchedules` directly.
   */
  async alarm(): Promise<void> {
    await this.processDueSchedules();
  }

  /** Re-enqueue every scheduled message whose time is due onto the Queue, then re-arm the alarm. */
  async processDueSchedules(): Promise<{ enqueued: number }> {
    const now = Date.now();
    const all = await this.ctx.storage.list<Message>({ prefix: SCHED_PREFIX });
    const due: { key: string; message: Message }[] = [];
    let earliestRemaining: number | undefined;
    for (const [key, message] of all) {
      const at = parseSchedAt(key);
      if (at <= now) {
        due.push({ key, message });
      } else if (earliestRemaining === undefined || at < earliestRemaining) {
        earliestRemaining = at;
      }
    }

    // Send-then-delete PER MESSAGE: if a QUEUE.send throws (queue outage/quota), that message's
    // sched entry survives and the alarm retry re-enqueues it — at-least-once, never a lost retry.
    // (A duplicate on the rare send-succeeds-then-throws path is deduped receiver-side via the
    // stable webhook-id = messageId.)
    let enqueued = 0;
    for (const { key, message } of due) {
      await this.env.QUEUE.send(message);
      await this.ctx.storage.delete(key);
      enqueued++;
    }

    if (earliestRemaining !== undefined) {
      await this.ctx.storage.setAlarm(earliestRemaining);
    }
    return { enqueued };
  }
}
