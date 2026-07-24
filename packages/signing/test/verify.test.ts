/** @fileoverview Tests for webhook verification. @module @anyhook/signing */
import { describe, test, expect } from 'bun:test';
import { Signer } from '../src/sign.js';
import { verify, WebhookVerificationError } from '../src/verify.js';

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const ID = 'msg_1';
const PAYLOAD = '{"a":1}';

describe('verify', () => {
  test('round-trip sign -> verify returns the parsed body', () => {
    const signer = new Signer(SECRET);
    const headers = signer.headers(ID, PAYLOAD);

    const result = verify(headers, PAYLOAD, SECRET);
    expect(result).toEqual({ a: 1 });
  });

  test('throws WebhookVerificationError when the body is tampered with', () => {
    const signer = new Signer(SECRET);
    const headers = signer.headers(ID, PAYLOAD);

    expect(() => verify(headers, '{"a":2}', SECRET)).toThrow(WebhookVerificationError);
  });

  test('throws WebhookVerificationError when the timestamp is older than 5 minutes', () => {
    const signer = new Signer(SECRET);
    const oldTimestamp = new Date(Date.now() - 6 * 60 * 1000);
    const headers = signer.headers(ID, PAYLOAD, oldTimestamp);

    expect(() => verify(headers, PAYLOAD, SECRET)).toThrow(WebhookVerificationError);
  });

  test('throws WebhookVerificationError when required headers are missing', () => {
    expect(() => verify({}, PAYLOAD, SECRET)).toThrow(WebhookVerificationError);
  });

  test('verifies when multi-sig only the second secret matches', () => {
    const secretA = 'whsec_bm90LXRoZS1zYW1lLXNlY3JldC1hdC1hbGw=';
    const secretB = SECRET;
    const signer = new Signer([secretA, secretB]);
    const headers = signer.headers(ID, PAYLOAD);

    const result = verify(headers, PAYLOAD, secretB);
    expect(result).toEqual({ a: 1 });
  });

  test('lowercases header keys before checking', () => {
    const signer = new Signer(SECRET);
    const headers = signer.headers(ID, PAYLOAD);
    const upperHeaders: Record<string, string> = {
      'Webhook-Id': headers['webhook-id']!,
      'Webhook-Timestamp': headers['webhook-timestamp']!,
      'Webhook-Signature': headers['webhook-signature']!,
    };

    const result = verify(upperHeaders, PAYLOAD, SECRET);
    expect(result).toEqual({ a: 1 });
  });

  test('throws WebhookVerificationError when no signature matches', () => {
    const signer = new Signer('whsec_d3Jvbmctc2VjcmV0LWJ5dGVzLWhlcmU=');
    const headers = signer.headers(ID, PAYLOAD);

    expect(() => verify(headers, PAYLOAD, SECRET)).toThrow(WebhookVerificationError);
  });
});
