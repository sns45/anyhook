/** @fileoverview Delivery-log + replay handlers (§7.3). Tenant-scoped (G7). @module @anyhook/core */
import type { StateStore, Transport, Clock, DeliveryQuery } from '../ports/index.js';
import type { Message } from '../types/message.js';
import type { Attempt } from '../types/attempt.js';

export interface DeliveryRecord {
  message: Message;
  attempts: Attempt[];
}

export interface DeliveryApi {
  list(q: DeliveryQuery): Promise<DeliveryRecord[]>;
  get(i: { tenant: string; messageId: string }): Promise<DeliveryRecord | null>;
  /** Re-enqueue a single message for a fresh delivery chain. Refuses cross-tenant ids (G7). */
  replay(i: { tenant: string; messageId: string }): Promise<{ replayed: boolean }>;
  /** Bulk-replay an endpoint's DLQ (optionally since a createdAt cursor). */
  replayEndpoint(i: { tenant: string; endpointId: string; since?: number }): Promise<{ count: number }>;
}

export function createDeliveryApi(state: StateStore, transport: Transport, clock: Clock): DeliveryApi {
  async function reenqueue(m: Message): Promise<void> {
    const fresh: Message = { ...m, attemptNo: 0, status: 'pending', nextAttemptAt: undefined, createdAt: clock.now() };
    await state.putMessage(fresh);
    await transport.send(fresh);
  }

  return {
    list: (q) => state.listDeliveries(q),

    async get(i) {
      const rows = await state.listDeliveries({ tenant: i.tenant });
      return rows.find((r) => r.message.messageId === i.messageId) ?? null;
    },

    async replay(i) {
      // getMessage is tenant-scoped: a messageId owned by another tenant resolves to null → refused.
      const m = await state.getMessage(i.tenant, i.messageId);
      if (!m) return { replayed: false };
      await reenqueue(m);
      return { replayed: true };
    },

    async replayEndpoint(i) {
      const dead = await state.listDlq(i.tenant, i.endpointId);
      const selected = dead.filter((d) => (i.since === undefined ? true : d.message.createdAt >= i.since));
      for (const d of selected) await reenqueue(d.message);
      return { count: selected.length };
    },
  };
}
