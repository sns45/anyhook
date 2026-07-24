/** @fileoverview Standard Webhooks signature generation. @module @anyhook/signing */
import { createHmac } from 'node:crypto';
import { parseSecret } from './secret.js';

/**
 * Computes a single Standard Webhooks `v1,<sig>` signature.
 * @param secret - The signing secret (with or without `whsec_` prefix)
 * @param id - The webhook delivery id
 * @param timestamp - The delivery timestamp
 * @param payload - The exact raw JSON payload string
 * @returns The `v1,<base64 signature>` string
 */
export function sign(secret: string, id: string, timestamp: Date, payload: string): string {
  const timestampSeconds = Math.floor(timestamp.getTime() / 1000);
  const signedContent = `${id}.${timestampSeconds}.${payload}`;
  const key = parseSecret(secret);
  const digest = createHmac('sha256', key).update(signedContent).digest('base64');
  return `v1,${digest}`;
}

/**
 * Computes Standard Webhooks delivery headers, optionally signing with
 * multiple secrets for zero-downtime key rotation.
 */
export class Signer {
  private readonly secrets: string[];

  constructor(secrets: string | string[]) {
    this.secrets = Array.isArray(secrets) ? secrets : [secrets];
  }

  /**
   * Computes the `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers.
   * @param id - The webhook delivery id
   * @param payload - The exact raw JSON payload string
   * @param timestamp - The delivery timestamp (default: now)
   * @returns A record of the three `webhook-*` headers
   */
  headers(id: string, payload: string, timestamp: Date = new Date()): Record<string, string> {
    const timestampSeconds = Math.floor(timestamp.getTime() / 1000);
    const signatures = this.secrets.map((secret) => sign(secret, id, timestamp, payload));

    return {
      'webhook-id': id,
      'webhook-timestamp': String(timestampSeconds),
      'webhook-signature': signatures.join(' '),
    };
  }
}

/**
 * Structural shape matching anyhook-core's injected `WebhookSigner` port.
 */
interface WebhookSignerPort {
  sign(secrets: string[], id: string, payload: string, timestampMs: number): Record<string, string>;
}

/**
 * Creates a signer matching anyhook-core's `WebhookSigner` port shape.
 * anyhook-core injects this dependency; core itself does NOT import this package.
 * @returns A signer object with a `sign` method
 */
export function createSigner(): WebhookSignerPort {
  return {
    sign(secrets: string[], id: string, payload: string, timestampMs: number): Record<string, string> {
      return new Signer(secrets).headers(id, payload, new Date(timestampMs));
    },
  };
}
