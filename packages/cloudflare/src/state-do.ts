/** @fileoverview DoStateStore: routes each StateStore method to the right tenant/endpoint Durable Object (D3, G7). @module @anyhook/cloudflare */
import type {
  StateStore,
  DeliveryQuery,
  Endpoint,
  CircuitRecord,
  Message,
  Attempt,
  DlqReason,
} from '@anyhook/core';
import type { Env } from './env.js';

/**
 * `StateStore` implementation backed by two Durable Object classes (D3: one DO per endpoint):
 * `TenantIndexDurableObject` owns endpoint CRUD, idempotency, and the message→endpoint index;
 * `EndpointDurableObject` owns messages, attempts, circuit state, DLQ, and retry alarms. This
 * class is pure routing + fan-out/merge — it holds no state of its own and every method is
 * tenant-scoped by construction (G7): each call resolves a DO stub via `idFromName` derived from
 * the tenant (and endpoint), so one tenant can never address another tenant's Durable Object.
 */
export class DoStateStore implements StateStore {
  constructor(private readonly env: Env) {}

  private tenantStub(tenant: string) {
    return this.env.TENANT_INDEX.get(this.env.TENANT_INDEX.idFromName(tenant));
  }

  private endpointStub(tenant: string, endpointId: string) {
    return this.env.ENDPOINT.get(this.env.ENDPOINT.idFromName(`${tenant}:${endpointId}`));
  }

  async recordEvent(
    tenant: string,
    eventId: string,
    idemKey: string,
  ): Promise<{ isNew: boolean; eventId: string; messageCount: number }> {
    return this.tenantStub(tenant).recordEvent(eventId, idemKey);
  }

  async finalizeEvent(tenant: string, idemKey: string, eventId: string, messageCount: number): Promise<void> {
    await this.tenantStub(tenant).finalizeEvent(idemKey, eventId, messageCount);
  }

  async createEndpoint(
    e: Omit<Endpoint, 'endpointId' | 'createdAt' | 'secrets' | 'disabled'>,
  ): Promise<{ endpoint: Endpoint; secret: string }> {
    return this.tenantStub(e.tenant).createEndpoint(e);
  }

  async getEndpoint(tenant: string, endpointId: string): Promise<Endpoint | null> {
    return this.tenantStub(tenant).getEndpoint(endpointId);
  }

  async listEndpoints(tenant: string): Promise<Endpoint[]> {
    return this.tenantStub(tenant).listEndpoints();
  }

  async matchEndpoints(tenant: string, eventType: string): Promise<Endpoint[]> {
    return this.tenantStub(tenant).matchEndpoints(eventType);
  }

  async updateEndpoint(
    tenant: string,
    endpointId: string,
    patch: Partial<Pick<Endpoint, 'url' | 'eventTypes' | 'disabled'>>,
  ): Promise<Endpoint> {
    return this.tenantStub(tenant).updateEndpoint(endpointId, patch);
  }

  async rotateSecret(tenant: string, endpointId: string): Promise<{ secret: string }> {
    return this.tenantStub(tenant).rotateSecret(endpointId);
  }

  async deleteEndpoint(tenant: string, endpointId: string): Promise<void> {
    await this.tenantStub(tenant).deleteEndpoint(endpointId);
  }

  async putMessage(m: Message): Promise<void> {
    await this.endpointStub(m.tenant, m.endpointId).putMessage(m);
    // Idempotent write: harmless to repeat on every putMessage (e.g. retry status updates), so we
    // don't need a "was this the first put" round-trip to keep the message→endpoint index correct.
    await this.tenantStub(m.tenant).registerMessage(m.messageId, m.endpointId);
  }

  async getMessage(tenant: string, messageId: string): Promise<Message | null> {
    const endpointId = await this.tenantStub(tenant).lookupMessageEndpoint(messageId);
    if (!endpointId) return null;
    return this.endpointStub(tenant, endpointId).getMessage(messageId);
  }

  async appendAttempt(a: Attempt): Promise<void> {
    await this.endpointStub(a.tenant, a.endpointId).appendAttempt(a);
  }

  async listDeliveries(q: DeliveryQuery): Promise<{ message: Message; attempts: Attempt[] }[]> {
    if (q.endpointId) {
      return this.endpointStub(q.tenant, q.endpointId).listDeliveries(q);
    }
    const endpoints = await this.tenantStub(q.tenant).listEndpoints();
    // Explicit annotation: the DO-RPC provider type collapses array element types containing
    // `Message` (which has `payload: unknown`) to `never` under bare inference; unknown is not a
    // member of the RPC `Serializable<T>` union, even though `unknown` payloads DO clone fine at
    // runtime (structuredClone handles any structured-cloneable value regardless of static type).
    const perEndpoint: { message: Message; attempts: Attempt[] }[][] = await Promise.all(
      endpoints.map((e) => this.endpointStub(q.tenant, e.endpointId).listDeliveries(q)),
    );
    let rows = perEndpoint.flat();
    rows.sort((a, b) => b.message.createdAt - a.message.createdAt);
    if (q.limit !== undefined) rows = rows.slice(0, q.limit);
    return rows;
  }

  async getCircuit(tenant: string, endpointId: string): Promise<CircuitRecord> {
    return this.endpointStub(tenant, endpointId).getCircuit();
  }

  async putCircuit(tenant: string, endpointId: string, rec: CircuitRecord): Promise<void> {
    await this.endpointStub(tenant, endpointId).putCircuit(rec);
  }

  async addToDlq(m: Message, reason: DlqReason): Promise<void> {
    await this.endpointStub(m.tenant, m.endpointId).addToDlq(m, reason);
  }

  async listDlq(tenant: string, endpointId?: string): Promise<{ message: Message; reason: DlqReason }[]> {
    if (endpointId) {
      return this.endpointStub(tenant, endpointId).listDlq();
    }
    const endpoints = await this.tenantStub(tenant).listEndpoints();
    const perEndpoint = await Promise.all(endpoints.map((e) => this.endpointStub(tenant, e.endpointId).listDlq()));
    return perEndpoint.flat();
  }
}
