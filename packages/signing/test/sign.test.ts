/** @fileoverview Tests for webhook signing. @module @anyhook/signing */
import { describe, test, expect } from 'bun:test';
import { createHmac } from 'node:crypto';
import { sign, Signer, createSigner } from '../src/sign.js';
import { parseSecret } from '../src/secret.js';

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const ID = 'msg_1';
const TIMESTAMP = new Date(1700000000000);
const PAYLOAD = '{"a":1}';

function expectedSignature(secret: string, signedContent: string): string {
  const key = parseSecret(secret);
  const digest = createHmac('sha256', key).update(signedContent).digest('base64');
  return `v1,${digest}`;
}

describe('sign', () => {
  test('produces the expected single v1 signature', () => {
    const signedContent = `${ID}.1700000000.${PAYLOAD}`;
    const expected = expectedSignature(SECRET, signedContent);
    expect(sign(SECRET, ID, TIMESTAMP, PAYLOAD)).toBe(expected);
  });
});

describe('Signer', () => {
  test('headers() returns webhook-id, webhook-timestamp, and webhook-signature', () => {
    const signer = new Signer(SECRET);
    const headers = signer.headers(ID, PAYLOAD, TIMESTAMP);

    expect(headers['webhook-id']).toBe(ID);
    expect(headers['webhook-timestamp']).toBe('1700000000');

    const signedContent = `${ID}.1700000000.${PAYLOAD}`;
    expect(headers['webhook-signature']).toBe(expectedSignature(SECRET, signedContent));
  });

  test('defaults timestamp to now', () => {
    const signer = new Signer(SECRET);
    const before = Math.floor(Date.now() / 1000);
    const headers = signer.headers(ID, PAYLOAD);
    const after = Math.floor(Date.now() / 1000);
    const ts = Number(headers['webhook-timestamp']);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test('with multiple secrets, webhook-signature is space-joined', () => {
    const secretA = SECRET;
    const secretB = 'whsec_bm90LXRoZS1zYW1lLXNlY3JldC1hdC1hbGw=';
    const signer = new Signer([secretA, secretB]);
    const headers = signer.headers(ID, PAYLOAD, TIMESTAMP);

    const signedContent = `${ID}.1700000000.${PAYLOAD}`;
    const expectedA = expectedSignature(secretA, signedContent);
    const expectedB = expectedSignature(secretB, signedContent);

    expect(headers['webhook-signature']).toBe(`${expectedA} ${expectedB}`);
  });
});

describe('createSigner', () => {
  test('matches the structural shape used by anyhook-core WebhookSigner port', () => {
    const factory = createSigner();
    const headers = factory.sign([SECRET], ID, PAYLOAD, TIMESTAMP.getTime());

    const signedContent = `${ID}.1700000000.${PAYLOAD}`;
    expect(headers['webhook-id']).toBe(ID);
    expect(headers['webhook-timestamp']).toBe('1700000000');
    expect(headers['webhook-signature']).toBe(expectedSignature(SECRET, signedContent));
  });
});
