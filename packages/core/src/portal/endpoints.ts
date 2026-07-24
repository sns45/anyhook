/** @fileoverview Endpoint CRUD handlers (§7.2). Mount behind the producer's own auth (G8). @module @anyhook/core */
import type { StateStore } from '../ports/index.js';
import type { Endpoint } from '../types/endpoint.js';

export interface CreateEndpointInput {
  tenant: string;
  url: string;
  eventTypes: string[];
  description?: string;
  rateLimit?: number;
}

export interface EndpointApi {
  /** Create an endpoint; the signing secret is returned ONCE (never stored in plaintext logs, G10). */
  create(i: CreateEndpointInput): Promise<{ endpointId: string; secret: string }>;
  list(i: { tenant: string }): Promise<Endpoint[]>;
  get(i: { tenant: string; endpointId: string }): Promise<Endpoint | null>;
  update(i: {
    tenant: string;
    endpointId: string;
    url?: string;
    eventTypes?: string[];
    disabled?: boolean;
  }): Promise<Endpoint>;
  /** Rotate to a new secret; the previous secret stays valid during a dual-secret window. */
  rotateSecret(i: { tenant: string; endpointId: string }): Promise<{ secret: string }>;
  delete(i: { tenant: string; endpointId: string }): Promise<void>;
}

export function createEndpointApi(state: StateStore): EndpointApi {
  return {
    async create(i) {
      const { endpoint, secret } = await state.createEndpoint({
        tenant: i.tenant,
        url: i.url,
        eventTypes: i.eventTypes,
        description: i.description,
        rateLimit: i.rateLimit,
      });
      return { endpointId: endpoint.endpointId, secret };
    },
    list: (i) => state.listEndpoints(i.tenant),
    get: (i) => state.getEndpoint(i.tenant, i.endpointId),
    update: (i) =>
      state.updateEndpoint(i.tenant, i.endpointId, {
        ...(i.url !== undefined ? { url: i.url } : {}),
        ...(i.eventTypes !== undefined ? { eventTypes: i.eventTypes } : {}),
        ...(i.disabled !== undefined ? { disabled: i.disabled } : {}),
      }),
    rotateSecret: (i) => state.rotateSecret(i.tenant, i.endpointId),
    delete: (i) => state.deleteEndpoint(i.tenant, i.endpointId),
  };
}
