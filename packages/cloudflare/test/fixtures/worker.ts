/** @fileoverview Miniflare test-fixture worker: hosts the real DO classes + a queue-sink for assertions. @module @anyhook/cloudflare */
import type { Message } from '@anyhook/core';
import type { Env } from '../../src/env.js';

export { TenantIndexDurableObject } from '../../src/tenant-do.js';
export { EndpointDurableObject } from '../../src/endpoint-do.js';

interface FixtureEnv extends Env {
  /** Test-only sink: the queue consumer below writes every message it receives here, keyed by
   * a monotonic counter, so the Node-side test can assert what the alarm's re-enqueue produced. */
  QUEUE_SINK: KVNamespace;
}

export default {
  async fetch(): Promise<Response> {
    return new Response('ok');
  },

  async queue(batch: MessageBatch<Message>, env: FixtureEnv): Promise<void> {
    for (const msg of batch.messages) {
      const seq = await env.QUEUE_SINK.get('seq');
      const next = (seq ? Number(seq) : 0) + 1;
      await env.QUEUE_SINK.put('seq', String(next));
      await env.QUEUE_SINK.put(`m:${next.toString().padStart(8, '0')}`, JSON.stringify(msg.body));
      msg.ack();
    }
  },
};
