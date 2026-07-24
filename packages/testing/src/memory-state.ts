/** @fileoverview In-memory, tenant-scoped StateStore (G7). @module @anyhook/testing */
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
  type Clock,
} from '@anyhook/core';
import { generateSecret } from '@anyhook/signing';

interface EventRecord {
  eventId: string;
  messageCount: number;
}
interface TenantData {
  events: Map<string, EventRecord>; // idemKey -> record
  endpoints: Map<string, Endpoint>;
  messages: Map<string, Message>;
  attempts: Map<string, Attempt[]>;
  circuits: Map<string, CircuitRecord>;
  dlq: { message: Message; reason: DlqReason }[];
}

function newTenant(): TenantData {
  return { events: new Map(), endpoints: new Map(), messages: new Map(), attempts: new Map(), circuits: new Map(), dlq: [] };
}

let endpointCounter = 0;

/**
 * In-memory StateStore. Every read/write is keyed by tenant first, so no query can ever
 * observe another tenant's rows (the cross-tenant no-leak invariant, G7).
 */
export class MemoryStateStore implements StateStore {
  private tenants = new Map<string, TenantData>();

  constructor(private readonly clock?: Clock) {}

  private t(tenant: string): TenantData {
    let d = this.tenants.get(tenant);
    if (!d) {
      d = newTenant();
      this.tenants.set(tenant, d);
    }
    return d;
  }

  private now(): number {
    return this.clock ? this.clock.now() : Date.now();
  }

  async recordEvent(tenant: string, eventId: string, idemKey: string) {
    const d = this.t(tenant);
    const existing = d.events.get(idemKey);
    if (existing) {
      return { isNew: false, eventId: existing.eventId, messageCount: existing.messageCount };
    }
    d.events.set(idemKey, { eventId, messageCount: 0 });
    return { isNew: true, eventId, messageCount: 0 };
  }

  async finalizeEvent(tenant: string, idemKey: string, eventId: string, messageCount: number) {
    this.t(tenant).events.set(idemKey, { eventId, messageCount });
  }

  async createEndpoint(e: Omit<Endpoint, 'endpointId' | 'createdAt' | 'secrets' | 'disabled'>) {
    const d = this.t(e.tenant);
    const secret = generateSecret();
    const endpoint: Endpoint = {
      endpointId: `ep_${(++endpointCounter).toString(36)}${Math.floor(this.now()).toString(36)}`,
      tenant: e.tenant,
      url: e.url,
      eventTypes: [...e.eventTypes],
      description: e.description,
      disabled: false,
      rateLimit: e.rateLimit,
      createdAt: this.now(),
      secrets: [secret],
    };
    d.endpoints.set(endpoint.endpointId, endpoint);
    return { endpoint, secret };
  }

  async getEndpoint(tenant: string, endpointId: string): Promise<Endpoint | null> {
    return this.t(tenant).endpoints.get(endpointId) ?? null;
  }

  async listEndpoints(tenant: string): Promise<Endpoint[]> {
    return [...this.t(tenant).endpoints.values()];
  }

  async matchEndpoints(tenant: string, eventType: string): Promise<Endpoint[]> {
    return [...this.t(tenant).endpoints.values()].filter((e) => subscribes(e, eventType));
  }

  async updateEndpoint(
    tenant: string,
    endpointId: string,
    patch: Partial<Pick<Endpoint, 'url' | 'eventTypes' | 'disabled'>>,
  ): Promise<Endpoint> {
    const d = this.t(tenant);
    const existing = d.endpoints.get(endpointId);
    if (!existing) throw new Error(`endpoint not found: ${endpointId}`);
    const updated: Endpoint = {
      ...existing,
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.eventTypes !== undefined ? { eventTypes: [...patch.eventTypes] } : {}),
      ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
    };
    d.endpoints.set(endpointId, updated);
    return updated;
  }

  async rotateSecret(tenant: string, endpointId: string): Promise<{ secret: string }> {
    const d = this.t(tenant);
    const existing = d.endpoints.get(endpointId);
    if (!existing) throw new Error(`endpoint not found: ${endpointId}`);
    const secret = generateSecret();
    // dual-secret window: new primary, keep the previous primary for verification
    d.endpoints.set(endpointId, { ...existing, secrets: [secret, existing.secrets[0]!] });
    return { secret };
  }

  async deleteEndpoint(tenant: string, endpointId: string): Promise<void> {
    this.t(tenant).endpoints.delete(endpointId);
  }

  async putMessage(m: Message): Promise<void> {
    this.t(m.tenant).messages.set(m.messageId, { ...m });
  }

  async getMessage(tenant: string, messageId: string): Promise<Message | null> {
    return this.t(tenant).messages.get(messageId) ?? null;
  }

  async appendAttempt(a: Attempt): Promise<void> {
    const d = this.t(a.tenant);
    const list = d.attempts.get(a.messageId) ?? [];
    list.push({ ...a });
    d.attempts.set(a.messageId, list);
  }

  async listDeliveries(q: DeliveryQuery): Promise<{ message: Message; attempts: Attempt[] }[]> {
    const d = this.t(q.tenant);
    let rows = [...d.messages.values()];
    if (q.endpointId) rows = rows.filter((m) => m.endpointId === q.endpointId);
    if (q.eventType) rows = rows.filter((m) => m.eventType === q.eventType);
    if (q.status) rows = rows.filter((m) => m.status === q.status);
    if (q.before !== undefined) rows = rows.filter((m) => m.createdAt < q.before!);
    if (q.after !== undefined) rows = rows.filter((m) => m.createdAt > q.after!);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    if (q.limit !== undefined) rows = rows.slice(0, q.limit);
    return rows.map((m) => ({ message: { ...m }, attempts: [...(d.attempts.get(m.messageId) ?? [])] }));
  }

  async getCircuit(tenant: string, endpointId: string): Promise<CircuitRecord> {
    const d = this.t(tenant);
    return d.circuits.get(endpointId) ?? initialCircuit();
  }

  async putCircuit(tenant: string, endpointId: string, rec: CircuitRecord): Promise<void> {
    this.t(tenant).circuits.set(endpointId, { ...rec });
  }

  async addToDlq(m: Message, reason: DlqReason): Promise<void> {
    this.t(m.tenant).dlq.push({ message: { ...m }, reason });
  }

  async listDlq(tenant: string, endpointId?: string): Promise<{ message: Message; reason: DlqReason }[]> {
    const rows = this.t(tenant).dlq;
    return (endpointId ? rows.filter((r) => r.message.endpointId === endpointId) : rows).map((r) => ({
      message: { ...r.message },
      reason: r.reason,
    }));
  }
}
