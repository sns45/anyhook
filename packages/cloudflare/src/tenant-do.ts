/** @fileoverview TenantIndexDurableObject: one per tenant — endpoints, idempotency, message→endpoint index (D3). @module @anyhook/cloudflare */
import { DurableObject } from 'cloudflare:workers';
import { subscribes, type Endpoint } from '@anyhook/core';
import { generateSecret } from '@anyhook/signing';
import type { Env } from './env.js';

interface EventRecord {
  eventId: string;
  messageCount: number;
}

const ENDPOINT_PREFIX = 'ep:';
const EVENT_PREFIX = 'evt:';
const MSG_INDEX_PREFIX = 'msgidx:';

/**
 * One Durable Object per tenant (id = `idFromName(tenant)`, see `DoStateStore`). Owns endpoint
 * CRUD, idempotency records, and the message→endpoint index that lets tenant-wide reads
 * (`getMessage`, `listDeliveries` without an `endpointId`) route to the right
 * `EndpointDurableObject`. All state lives in `this.ctx.storage` (the DO KV API); every method
 * here is implicitly tenant-scoped because the DO instance itself is one tenant.
 */
export class TenantIndexDurableObject extends DurableObject<Env> {
  async createEndpoint(
    e: Omit<Endpoint, 'endpointId' | 'createdAt' | 'secrets' | 'disabled'>,
  ): Promise<{ endpoint: Endpoint; secret: string }> {
    const secret = generateSecret();
    const endpoint: Endpoint = {
      endpointId: crypto.randomUUID(),
      tenant: e.tenant,
      url: e.url,
      eventTypes: [...e.eventTypes],
      description: e.description,
      disabled: false,
      rateLimit: e.rateLimit,
      createdAt: Date.now(),
      secrets: [secret],
    };
    await this.ctx.storage.put(ENDPOINT_PREFIX + endpoint.endpointId, endpoint);
    return { endpoint, secret };
  }

  async getEndpoint(endpointId: string): Promise<Endpoint | null> {
    return (await this.ctx.storage.get<Endpoint>(ENDPOINT_PREFIX + endpointId)) ?? null;
  }

  async listEndpoints(): Promise<Endpoint[]> {
    const rows = await this.ctx.storage.list<Endpoint>({ prefix: ENDPOINT_PREFIX });
    return [...rows.values()];
  }

  async matchEndpoints(eventType: string): Promise<Endpoint[]> {
    const all = await this.listEndpoints();
    return all.filter((e) => subscribes(e, eventType));
  }

  async updateEndpoint(
    endpointId: string,
    patch: Partial<Pick<Endpoint, 'url' | 'eventTypes' | 'disabled'>>,
  ): Promise<Endpoint> {
    const existing = await this.getEndpoint(endpointId);
    if (!existing) throw new Error(`endpoint not found: ${endpointId}`);
    const updated: Endpoint = {
      ...existing,
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.eventTypes !== undefined ? { eventTypes: [...patch.eventTypes] } : {}),
      ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
    };
    await this.ctx.storage.put(ENDPOINT_PREFIX + endpointId, updated);
    return updated;
  }

  /** Dual-secret rotation window: `secrets = [newPrimary, oldPrimary]`. */
  async rotateSecret(endpointId: string): Promise<{ secret: string }> {
    const existing = await this.getEndpoint(endpointId);
    if (!existing) throw new Error(`endpoint not found: ${endpointId}`);
    const secret = generateSecret();
    await this.ctx.storage.put(ENDPOINT_PREFIX + endpointId, {
      ...existing,
      secrets: [secret, existing.secrets[0]!],
    });
    return { secret };
  }

  async deleteEndpoint(endpointId: string): Promise<void> {
    await this.ctx.storage.delete(ENDPOINT_PREFIX + endpointId);
  }

  /** Idempotency: `{ isNew: false }` if `idemKey` was already accepted for this tenant. */
  async recordEvent(
    eventId: string,
    idemKey: string,
  ): Promise<{ isNew: boolean; eventId: string; messageCount: number }> {
    const existing = await this.ctx.storage.get<EventRecord>(EVENT_PREFIX + idemKey);
    if (existing) {
      return { isNew: false, eventId: existing.eventId, messageCount: existing.messageCount };
    }
    await this.ctx.storage.put(EVENT_PREFIX + idemKey, { eventId, messageCount: 0 });
    return { isNew: true, eventId, messageCount: 0 };
  }

  /** Persist the acceptance result so replays of `send()` return the same receipt. */
  async finalizeEvent(idemKey: string, eventId: string, messageCount: number): Promise<void> {
    await this.ctx.storage.put(EVENT_PREFIX + idemKey, { eventId, messageCount });
  }

  /** Record that `messageId` belongs to `endpointId`, so tenant-wide reads can route to it. */
  async registerMessage(messageId: string, endpointId: string): Promise<void> {
    await this.ctx.storage.put(MSG_INDEX_PREFIX + messageId, endpointId);
  }

  async lookupMessageEndpoint(messageId: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(MSG_INDEX_PREFIX + messageId)) ?? null;
  }
}
