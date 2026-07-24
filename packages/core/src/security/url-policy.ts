/** @fileoverview SSRF-safe default URL policy (§10, G6). @module @anyhook/core */
import type { UrlPolicy } from '../ports/index.js';

export interface UrlPolicyOptions {
  /** Allow plain `http:` targets (default true; set false to require https). */
  allowHttp?: boolean;
  /** Extra hostnames/IPs to always deny (exact, case-insensitive). */
  extraDeny?: string[];
}

/** Parse one IPv4 field in decimal, octal (`0…`), or hex (`0x…`) — the forms `inet_aton` accepts. */
function parseIpField(s: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^0[0-7]+$/.test(s)) return parseInt(s, 8);
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  return null;
}

/**
 * Parse an IPv4 literal in any common encoding into octets: dotted-decimal, dotted octal/hex
 * (`0177.0.0.1`, `0x7f.0.0.1`), or a single 32-bit integer (`2130706433`, `0x7f000001`).
 * Returns null when the host is not a numeric IPv4 literal in any of these forms.
 */
function ipv4ToOctets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length === 4) {
    const octs = parts.map(parseIpField);
    if (octs.some((o) => o === null || o! < 0 || o! > 255)) return null;
    return octs as number[];
  }
  if (parts.length === 1) {
    const n = parseIpField(parts[0]!);
    if (n === null || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  return null; // 2/3-part inet_aton forms are rare and ambiguous — handled by the numeric-host guard
}

/** A host that looks like an obfuscated numeric IP but did not parse cleanly is refused, not allowed. */
function looksNumeric(host: string): boolean {
  return /[0-9]/.test(host) && /^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+))*$/i.test(host);
}

/** Private / loopback / link-local / reserved IPv4 ranges. */
function isBlockedIpv4([a, b]: number[]): boolean {
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b! >= 16 && b! <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b! >= 64 && b! <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a! >= 224) return true; // multicast / reserved
  return false;
}

function isBlockedIpv6(raw: string): boolean {
  let h = raw.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === '::1' || h === '::') return true; // loopback / unspecified (compressed)
  if (/^(0:){7}1$/.test(h)) return true; // full-form loopback 0:0:0:0:0:0:0:1
  if (/^(0:){7}0$/.test(h) || /^0(:0)*::?0?$/.test(h)) return true; // full-form unspecified
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true; // fe80::/10 link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 unique-local
  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4
  const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mapped) {
    const oct = ipv4ToOctets(mapped[1]!);
    return oct ? isBlockedIpv4(oct) : true;
  }
  return false;
}

/**
 * Default deny-list policy. Refuses non-http(s) schemes and private/loopback/link-local
 * literal-IP targets. Public hostnames are allowed here; connection-time re-validation
 * (DNS-rebinding defense) belongs in the adapter's HttpClient — documented, not done statically.
 */
export function defaultUrlPolicy(opts: UrlPolicyOptions = {}): UrlPolicy {
  const allowHttp = opts.allowHttp ?? true;
  const deny = new Set((opts.extraDeny ?? []).map((s) => s.toLowerCase()));

  return {
    async check(url: string) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { allowed: false, reason: 'invalid_url' };
      }

      const scheme = parsed.protocol;
      if (scheme !== 'https:' && !(allowHttp && scheme === 'http:')) {
        return { allowed: false, reason: `blocked_scheme:${scheme.replace(':', '')}` };
      }

      const host = parsed.hostname.toLowerCase();
      if (deny.has(host)) return { allowed: false, reason: 'denied_host' };
      if (host === 'localhost' || host.endsWith('.localhost')) {
        return { allowed: false, reason: 'loopback_hostname' };
      }

      const v4 = ipv4ToOctets(host);
      if (v4) {
        if (isBlockedIpv4(v4)) return { allowed: false, reason: 'private_or_reserved_ipv4' };
        return { allowed: true };
      }

      // A host that looks like an obfuscated numeric IP but didn't parse to a valid IPv4 is refused,
      // never treated as a public hostname (defends against inet_aton edge encodings).
      if (looksNumeric(host)) {
        return { allowed: false, reason: 'ambiguous_numeric_host' };
      }

      if (host.includes(':') || (parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']'))) {
        if (isBlockedIpv6(parsed.hostname)) return { allowed: false, reason: 'private_or_reserved_ipv6' };
        return { allowed: true };
      }

      // Non-literal hostname: allowed statically; adapter re-checks resolved IP at connect time.
      return { allowed: true };
    },
  };
}
