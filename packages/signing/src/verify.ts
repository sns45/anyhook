/** @fileoverview Standard Webhooks signature verification. @module @anyhook/signing */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseSecret } from './secret.js';

const TOLERANCE_SECONDS = 300;

/** Thrown when a webhook delivery fails signature or timestamp verification. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

function extractSignatureDigest(entry: string): string | undefined {
  const [scheme, digest] = entry.split(',');
  if (scheme !== 'v1' || !digest) {
    return undefined;
  }
  return digest;
}

function timingSafeEqualBase64(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'base64');
  const bufferB = Buffer.from(b, 'base64');
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Verifies a Standard Webhooks delivery and returns the parsed JSON body.
 * @param headers - The delivery headers (keys are matched case-insensitively)
 * @param rawBody - The exact raw request body string
 * @param secret - The signing secret (with or without `whsec_` prefix)
 * @returns The parsed JSON body
 * @throws {WebhookVerificationError} If headers are missing, the timestamp is
 *   outside tolerance, or no signature matches
 */
export function verify(headers: Record<string, string>, rawBody: string, secret: string): unknown {
  const lower = lowercaseHeaders(headers);
  const id = lower['webhook-id'];
  const timestamp = lower['webhook-timestamp'];
  const signature = lower['webhook-signature'];

  if (!id || !timestamp || !signature) {
    throw new WebhookVerificationError('Missing required webhook headers');
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    throw new WebhookVerificationError('Invalid webhook timestamp');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > TOLERANCE_SECONDS) {
    throw new WebhookVerificationError('Webhook timestamp is outside of tolerance');
  }

  const signedContent = `${id}.${timestampSeconds}.${rawBody}`;
  const key = parseSecret(secret);
  const expectedDigest = createHmac('sha256', key).update(signedContent).digest('base64');

  const providedSignatures = signature.split(' ');
  for (const entry of providedSignatures) {
    const digest = extractSignatureDigest(entry);
    if (digest && timingSafeEqualBase64(digest, expectedDigest)) {
      return JSON.parse(rawBody);
    }
  }

  throw new WebhookVerificationError('No matching signature found');
}
