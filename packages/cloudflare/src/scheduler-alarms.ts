/** @fileoverview DoScheduler: routes retry scheduling to the owning EndpointDurableObject's Alarm (P2). @module @anyhook/cloudflare */
import type { Scheduler, Message } from '@anyhook/core';
import { endpointDoName, type Env } from './env.js';

/**
 * `Scheduler` implementation for Cloudflare: "attempt this message again at time T" is owned by
 * the `EndpointDurableObject` for `(m.tenant, m.endpointId)`, backed by its Durable Object Alarm.
 * The state store IS the schedule (P2) — there is no separate timer service.
 */
export class DoScheduler implements Scheduler {
  constructor(private readonly env: Env) {}

  async scheduleRetry(m: Message, at: number): Promise<void> {
    const stub = this.env.ENDPOINT.get(this.env.ENDPOINT.idFromName(endpointDoName(m.tenant, m.endpointId)));
    await stub.scheduleRetry(m, at);
  }
}
