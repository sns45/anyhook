/** @fileoverview Subscription matching + fan-out (1 event → N independent messages) (§3, G3). @module @anyhook/core */
import type { Rng } from './ports/index.js';
import type { SendEvent } from './types/event.js';
import type { Endpoint } from './types/endpoint.js';
import type { Message } from './types/message.js';
import { newId } from './id.js';

/**
 * Whether an endpoint subscribes to an event type. Supports exact match, the `*` wildcard,
 * and dot-prefixed wildcards such as `payment.*` (matches `payment.succeeded`).
 */
export function subscribes(endpoint: Endpoint, eventType: string): boolean {
  return endpoint.eventTypes.some((pattern) => {
    if (pattern === '*' || pattern === eventType) return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -1); // keep the trailing dot: "payment."
      return eventType.startsWith(prefix);
    }
    return false;
  });
}

/**
 * Fan an accepted event out to one INDEPENDENT message per matching, enabled endpoint.
 * Disabled endpoints and non-subscribers are skipped. `messageCount = result.length` (0 is valid).
 */
export function fanout(
  event: SendEvent,
  eventId: string,
  endpoints: Endpoint[],
  rng: Rng,
  now: number,
): Message[] {
  return endpoints
    .filter((e) => !e.disabled && subscribes(e, event.type))
    .map((e) => ({
      messageId: newId('msg', rng),
      tenant: event.tenant,
      endpointId: e.endpointId,
      eventId,
      eventType: event.type,
      payload: event.payload,
      attemptNo: 0,
      status: 'pending' as const,
      createdAt: now,
    }));
}
