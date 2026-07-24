/** @fileoverview SSRF-safe default URL policy (§10, G6). @module @anyhook/core */
import type { UrlPolicy } from '../ports/index.js';

export interface UrlPolicyOptions {
  /** Allow plain `http:` targets (default true; set false to require https). */
  allowHttp?: boolean;
  /** Extra hostnames/IPs to always deny (exact, case-insensitive). */
  extraDeny?: string[];
}

function ipv4ToOctets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return octets;
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
  if (h === '::1' || h === '::') return true; // loopback / unspecified
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

      if (host.includes(':') || (parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']'))) {
        if (isBlockedIpv6(parsed.hostname)) return { allowed: false, reason: 'private_or_reserved_ipv6' };
        return { allowed: true };
      }

      // Non-literal hostname: allowed statically; adapter re-checks resolved IP at connect time.
      return { allowed: true };
    },
  };
}
