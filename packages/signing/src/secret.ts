/** @fileoverview Webhook signing secret generation and parsing. @module @anyhook/signing */

const SECRET_PREFIX = 'whsec_';

/**
 * Generates a new Standard Webhooks-compatible signing secret.
 * @param bytes - Number of random bytes to encode (default 24)
 * @returns A `whsec_`-prefixed base64-encoded secret
 */
export function generateSecret(bytes = 24): string {
  const random = new Uint8Array(bytes);
  crypto.getRandomValues(random);
  return `${SECRET_PREFIX}${Buffer.from(random).toString('base64')}`;
}

/**
 * Parses a webhook signing secret into raw HMAC key bytes.
 * Strips the `whsec_` prefix (if present) and base64-decodes the remainder.
 * @param secret - The secret string, with or without the `whsec_` prefix
 * @returns The decoded key bytes
 */
export function parseSecret(secret: string): Uint8Array {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  return new Uint8Array(Buffer.from(raw, 'base64'));
}
