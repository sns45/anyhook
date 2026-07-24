/** @fileoverview Interop tests against the official standardwebhooks package. @module @anyhook/signing */
import { describe, test, expect } from 'bun:test';
import { Webhook } from 'standardwebhooks';
import { generateSecret } from '../src/secret.js';
import { Signer } from '../src/sign.js';
import { verify } from '../src/verify.js';

const ID = 'msg_interop';
const PAYLOAD = '{"hello":"world"}';

describe('interop with standardwebhooks', () => {
  test('anyhook Signer headers verify against the official Webhook.verify', () => {
    const secret = generateSecret();
    const headers = new Signer(secret).headers(ID, PAYLOAD);

    const official = new Webhook(secret);
    expect(() => official.verify(PAYLOAD, headers)).not.toThrow();
  });

  test('official Webhook.sign headers verify against anyhook verify()', () => {
    const secret = generateSecret();
    const official = new Webhook(secret);
    const timestamp = new Date();
    const signature = official.sign(ID, timestamp, PAYLOAD);

    const headers = {
      'webhook-id': ID,
      'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'webhook-signature': signature,
    };

    expect(() => verify(headers, PAYLOAD, secret)).not.toThrow();
  });
});
