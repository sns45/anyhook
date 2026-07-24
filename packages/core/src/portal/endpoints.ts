/** @fileoverview Endpoint CRUD handlers (§7.2). Mount behind the producer's own auth (G8). @module @anyhook/core */
import type { StateStore } from '../ports/index.js';
import type { Endpoint } from '../types/endpoint.js';

/** An endpoint as exposed through the portal — signing secrets are NEVER included (G10). */
export type PublicEndpoint = Omit<Endpoint, 'secrets'>;

/** Strip signing secrets before an endpoint crosses the portal boundary. */
function redact(e: Endpoint): PublicEndpoint {
  const clone: Partial<Endpoint> = { ...e };
  delete clone.secrets;
  return clone as PublicEndpoint;
}

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
  list(i: { tenant: string }): Promise<PublicEndpoint[]>;
  get(i: { tenant: string; endpointId: string }): Promise<PublicEndpoint | null>;
  update(i: {
    tenant: string;
    endpointId: string;
    url?: string;
    eventTypes?: string[];
    disabled?: boolean;
  }): Promise<PublicEndpoint>;
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
    list: async (i) => (await state.listEndpoints(i.tenant)).map(redact),
    get: async (i) => {
      const e = await state.getEndpoint(i.tenant, i.endpointId);
      return e ? redact(e) : null;
    },
    update: async (i) =>
      redact(
        await state.updateEndpoint(i.tenant, i.endpointId, {
          ...(i.url !== undefined ? { url: i.url } : {}),
          ...(i.eventTypes !== undefined ? { eventTypes: i.eventTypes } : {}),
          ...(i.disabled !== undefined ? { disabled: i.disabled } : {}),
        }),
      ),
    rotateSecret: (i) => state.rotateSecret(i.tenant, i.endpointId),
    delete: (i) => state.deleteEndpoint(i.tenant, i.endpointId),
  };
}
