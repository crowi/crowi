import { lookup as nodeDnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for the link-card OGP fetch. Rejects any target whose
 * hostname resolves (or is literally) a private / loopback /
 * link-local / unique-local / metadata address, per spec §"SSRF ガード".
 *
 * KNOWN RESIDUAL RISK (DNS rebinding / TOCTOU): this validates the
 * hostname's resolved address at call time via `dns.lookup`, then the
 * caller (`fetch-og.ts`) hands the *hostname* — not the pinned address —
 * to `fetch()`. An attacker who controls DNS for the target hostname
 * could serve a public IP for this lookup and then flip the record to a
 * private/metadata IP before the underlying fetch's own resolution
 * happens a few milliseconds later, defeating the check. Closing this
 * fully requires an undici custom dispatcher that pins the
 * connect-time IP to the address this guard already validated. The spec
 * explicitly allows deferring that (implementer judgement, "lookup +
 * redirect re-validation" is the documented floor) — see this package's
 * README §"Known limitations" for the operator-facing writeup.
 */

/** What `dns.lookup` (or a test double) resolves a hostname to. */
export interface DnsLookupResult {
  address: string;
  family: number;
}

export type DnsLookupFn = (hostname: string) => Promise<DnsLookupResult>;

const defaultDnsLookup: DnsLookupFn = (hostname) => nodeDnsLookup(hostname);

export type SsrfCheckResult = { allowed: true; address: string } | { allowed: false; reason: string };

/**
 * Validate a hostname is safe to connect to — used for the initial
 * `@[card](url)` target AND for every redirect hop's `Location` host
 * (spec: "各 hop で同じ IP 検証をやり直す"). `dnsLookup` is injectable so
 * tests can simulate DNS-based / redirect-induced SSRF without touching
 * real DNS; production code omits it and gets `node:dns/promises`.
 *
 * `hostname` is normalized (bracket-stripped — see {@link stripBrackets})
 * before the literal-IP check, since callers pass WHATWG `URL.hostname`
 * verbatim, which keeps the `[…]` wrapper for IPv6 literals
 * (`new URL('http://[::1]/x').hostname === '[::1]'`). Without this,
 * `net.isIP('[::1]')` returns 0 (not recognised as a literal) and a
 * legitimate public IPv6 URL falls through to a DNS lookup of the
 * literal bracketed string and fails closed.
 */
export async function checkHostnameSsrf(hostname: string, dnsLookup: DnsLookupFn = defaultDnsLookup): Promise<SsrfCheckResult> {
  const normalized = stripBrackets(hostname);
  const literalFamily = isIP(normalized);
  if (literalFamily !== 0) {
    return isBlockedAddress(normalized, literalFamily)
      ? { allowed: false, reason: `address literal is in a blocked range: ${normalized}` }
      : { allowed: true, address: normalized };
  }

  let resolved: DnsLookupResult;
  try {
    resolved = await dnsLookup(normalized);
  } catch {
    return { allowed: false, reason: `DNS lookup failed for hostname: ${normalized}` };
  }

  return isBlockedAddress(resolved.address, resolved.family)
    ? { allowed: false, reason: `resolved address is in a blocked range: ${resolved.address}` }
    : { allowed: true, address: resolved.address };
}

/** Strip a `[…]` bracket wrapper (WHATWG `URL.hostname`'s IPv6 literal shape) down to the bare address. A no-op for anything else (plain hostnames, already-unbracketed literals). */
function stripBrackets(hostname: string): string {
  return hostname.length > 2 && hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** Dispatch to the IPv4 / IPv6 range checker for the family `node:net.isIP` (or `dns.lookup`) reported. */
function isBlockedAddress(address: string, family: number): boolean {
  return family === 6 ? isBlockedIPv6(address) : isBlockedIPv4(address);
}

/**
 * IPv4 private/reserved ranges: RFC 1918 private space, loopback,
 * link-local (incl. the `169.254.169.254` cloud metadata address),
 * CGNAT, IETF special-purpose / documentation / benchmarking blocks,
 * multicast, and reserved/broadcast. Malformed input fails closed
 * (treated as blocked).
 */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  return false;
}

/**
 * IPv6 loopback (`::1`), unspecified (`::`), link-local (`fe80::/10`),
 * unique-local (`fc00::/7`, covers the common `fd00::/8` operator
 * range), and IPv4-mapped (`::ffff:a.b.c.d`) addresses — the latter is
 * unwrapped and re-checked against the IPv4 rules above so a mapped
 * loopback/private address can't slip through. Malformed input fails
 * closed.
 */
function isBlockedIPv6(ip: string): boolean {
  const groups = expandIPv6(ip);
  if (!groups) return true;

  const isMapped = groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff;
  if (isMapped) {
    const v4 = `${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`;
    return isBlockedIPv4(v4);
  }
  if (groups.every((g) => g === 0)) return true; // :: unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 loopback
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  return false;
}

/**
 * Expand a (possibly `::`-compressed, possibly IPv4-mapped-tailed) IPv6
 * literal into its 8 16-bit groups as numbers. Returns `null` for
 * anything that doesn't parse as a syntactically valid IPv6 address —
 * callers treat that as "blocked" (fail closed).
 */
function expandIPv6(address: string): number[] | null {
  const zoneIdx = address.indexOf('%');
  const clean = zoneIdx === -1 ? address : address.slice(0, zoneIdx);
  const parts = clean.split('::');
  if (parts.length > 2) return null;

  const parseGroupList = (s: string): string[] => (s.length === 0 ? [] : s.split(':'));

  // The last group of either half may be an embedded IPv4 literal
  // (`::ffff:127.0.0.1`) — expand it into its two hex-group equivalent.
  const expandV4Tail = (groups: string[]): string[] | null => {
    if (groups.length === 0) return groups;
    const last = groups[groups.length - 1];
    if (!last.includes('.')) return groups;
    if (isIP(last) !== 4) return null;
    const octets = last.split('.').map(Number);
    const g1 = ((octets[0] << 8) | octets[1]).toString(16);
    const g2 = ((octets[2] << 8) | octets[3]).toString(16);
    return [...groups.slice(0, -1), g1, g2];
  };

  const head = expandV4Tail(parseGroupList(parts[0]));
  const tail = parts.length === 2 ? expandV4Tail(parseGroupList(parts[1])) : [];
  if (head === null || tail === null) return null;

  const total = head.length + tail.length;
  let fullGroups: string[];
  if (parts.length === 1) {
    if (total !== 8) return null;
    fullGroups = head;
  } else {
    if (total > 8) return null;
    fullGroups = [...head, ...Array(8 - total).fill('0'), ...tail];
  }

  if (fullGroups.length !== 8) return null;
  const nums = fullGroups.map((g) => (g === '' ? Number.NaN : Number.parseInt(g, 16)));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}
