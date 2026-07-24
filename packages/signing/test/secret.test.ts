/** @fileoverview Tests for secret generation and parsing. @module @anyhook/signing */
import { describe, test, expect } from 'bun:test';
import { generateSecret, parseSecret } from '../src/secret.js';

describe('generateSecret', () => {
  test('returns a whsec_-prefixed string', () => {
    const secret = generateSecret();
    expect(secret.startsWith('whsec_')).toBe(true);
  });

  test('produces a secret that parses to at least 24 bytes by default', () => {
    const secret = generateSecret();
    const bytes = parseSecret(secret);
    expect(bytes.length).toBeGreaterThanOrEqual(24);
  });

  test('respects a custom byte length', () => {
    const secret = generateSecret(32);
    const bytes = parseSecret(secret);
    expect(bytes.length).toBe(32);
  });
});

describe('parseSecret', () => {
  test('round-trips a known base64 payload', () => {
    // 'hello world' base64-encoded
    const known = 'aGVsbG8gd29ybGQ=';
    const bytes = parseSecret(`whsec_${known}`);
    expect(Buffer.from(bytes).toString('utf8')).toBe('hello world');
  });

  test('parses a secret without the whsec_ prefix', () => {
    const known = 'aGVsbG8gd29ybGQ=';
    const bytes = parseSecret(known);
    expect(Buffer.from(bytes).toString('utf8')).toBe('hello world');
  });
});
