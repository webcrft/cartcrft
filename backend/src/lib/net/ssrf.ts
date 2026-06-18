/**
 * lib/net/ssrf.ts — Reusable outbound-URL SSRF guard.
 *
 * Defends against Server-Side Request Forgery on any code path that fetches a
 * user-/admin-controlled URL (notification webhooks, digital-download redirects,
 * etc). The guard:
 *   - parses the URL and allows only http:/https:
 *   - resolves the hostname via DNS and rejects if ANY resolved address falls in
 *     a loopback / private / link-local / unspecified / CGNAT range (covers the
 *     cloud metadata endpoint 169.254.169.254 and IPv6 equivalents)
 *   - rejects literal-IP hosts in those ranges
 *   - rejects well-known metadata hostnames
 *
 * No new deps: uses node:dns + node:net + the global fetch.
 *
 * IMPORTANT (DNS rebinding / TOCTOU): assertSafeOutboundUrl validates the names
 * resolved at call time. A malicious DNS server can return a public IP to the
 * guard and a private IP to the subsequent fetch. To close that gap, callers
 * MUST disable redirect-following (redirect: 'manual') and treat write-time
 * checks as best-effort; the fetch-time guard via safeFetch (which re-validates
 * any 3xx Location before following once) is authoritative.
 */

import { promises as dns } from "node:dns";
import net from "node:net";

/** Thrown when a URL is blocked by the SSRF guard. */
export class SsrfBlockedError extends Error {
  readonly code = "SSRF_BLOCKED" as const;
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** Hostnames that resolve to cloud metadata / internal services. */
const BLOCKED_HOSTNAMES = new Set<string>([
  "metadata.google.internal",
  "metadata",
  "metadata.goog",
]);

// ── IPv4 helpers ────────────────────────────────────────────────────────────

/** Parse a dotted-quad IPv4 string into a 32-bit unsigned integer, or null. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** True if the IPv4 address is in any blocked range. */
function isBlockedIpv4(ip: string): boolean {
  const v = ipv4ToInt(ip);
  if (v === null) return true; // unparseable → treat as unsafe
  const inRange = (cidrBase: string, prefix: number): boolean => {
    const base = ipv4ToInt(cidrBase);
    if (base === null) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (v & mask) === (base & mask);
  };
  return (
    inRange("0.0.0.0", 8) || // unspecified / "this" network
    inRange("10.0.0.0", 8) || // private
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local (incl. 169.254.169.254 metadata)
    inRange("172.16.0.0", 12) || // private
    inRange("192.168.0.0", 16) // private
  );
}

// ── IPv6 helpers ────────────────────────────────────────────────────────────

/** Expand an IPv6 address (handling :: and embedded IPv4) into 16 bytes, or null. */
function ipv6ToBytes(ip: string): Uint8Array | null {
  let addr = ip;
  // Strip a zone id (e.g. fe80::1%eth0).
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);

  // Handle embedded IPv4 (e.g. ::ffff:1.2.3.4) by converting the tail.
  const lastColon = addr.lastIndexOf(":");
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes(".")) {
    const v4 = addr.slice(lastColon + 1);
    const v4int = ipv4ToInt(v4);
    if (v4int === null) return null;
    const hex =
      ((v4int >>> 16) & 0xffff).toString(16) +
      ":" +
      (v4int & 0xffff).toString(16);
    addr = addr.slice(0, lastColon + 1) + hex;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  const groups: number[] = [];
  for (const h of head) {
    if (h === "") return null;
    groups.push(parseGroup(h));
  }
  const tailGroups: number[] = [];
  for (const t of tail) {
    if (t === "") return null;
    tailGroups.push(parseGroup(t));
  }

  let middle: number[] = [];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    middle = new Array<number>(fill).fill(0);
  }

  const all = [...groups, ...middle, ...tailGroups];
  if (all.length !== 8 || all.some((g) => g < 0 || g > 0xffff || Number.isNaN(g))) {
    return null;
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = all[i] ?? 0;
    bytes[i * 2] = (g >> 8) & 0xff;
    bytes[i * 2 + 1] = g & 0xff;
  }
  return bytes;
}

function parseGroup(g: string): number {
  if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return NaN;
  return parseInt(g, 16);
}

/** True if the IPv6 address is in any blocked range. */
function isBlockedIpv6(ip: string): boolean {
  const bytes = ipv6ToBytes(ip);
  if (bytes === null) return true; // unparseable → treat as unsafe

  // ::  (unspecified) and ::1 (loopback)
  const allZeroExceptLast = bytes.slice(0, 15).every((b) => b === 0);
  if (allZeroExceptLast && (bytes[15] === 0 || bytes[15] === 1)) return true;

  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;

  // fc00::/7 — unique local address (first 7 bits = 1111110)
  if ((b0 & 0xfe) === 0xfc) return true;

  // fe80::/10 — link-local (first 10 bits = 1111111010)
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true;

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible — re-check the embedded v4.
  const firstTenZero = bytes.slice(0, 10).every((b) => b === 0);
  if (firstTenZero) {
    const b10 = bytes[10] ?? 0;
    const b11 = bytes[11] ?? 0;
    const isMapped = b10 === 0xff && b11 === 0xff; // ::ffff:a.b.c.d
    const isCompat = b10 === 0 && b11 === 0; // ::a.b.c.d
    if (isMapped || isCompat) {
      const v4 = `${bytes[12] ?? 0}.${bytes[13] ?? 0}.${bytes[14] ?? 0}.${bytes[15] ?? 0}`;
      return isBlockedIpv4(v4);
    }
  }

  return false;
}

/** True if a literal IP string (v4 or v6) is in a blocked range. */
function isBlockedIpLiteral(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // not a valid literal IP — caller shouldn't pass non-IPs here
}

/** True if any resolved address (from dns.lookup) is in a blocked range. */
function isBlockedResolvedAddress(address: string, family: number): boolean {
  if (family === 6) return isBlockedIpv6(address);
  return isBlockedIpv4(address);
}

/** Options for the SSRF guard. */
export interface SsrfOptions {
  /**
   * When true, skip the private/loopback/link-local/metadata IP blocking and
   * allow any syntactically valid http(s) URL. Scheme + URL validation still
   * apply. Intended for non-production / self-hosted environments where a
   * merchant may legitimately point a webhook at localhost or an internal
   * service. Callers gate this on `config.APP_ENV !== 'production'` so the
   * multi-tenant cloud (production) keeps full SSRF protection.
   */
  allowPrivate?: boolean | undefined;
}

/**
 * Parse and validate an outbound URL, rejecting anything that could be used for
 * SSRF. Resolves the hostname via DNS; throws SsrfBlockedError on any failure.
 *
 * @returns the parsed URL on success.
 */
export async function assertSafeOutboundUrl(
  rawUrl: string,
  opts: SsrfOptions = {}
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`invalid URL: ${String(rawUrl).slice(0, 200)}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError(`disallowed protocol: ${url.protocol}`);
  }

  // Normalise host: strip brackets from IPv6 literals, lowercase.
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }

  if (!host) {
    throw new SsrfBlockedError("missing host");
  }

  // Escape hatch for non-production / self-hosted deploys: a valid http(s) URL
  // is accepted without IP-range checks. Production never sets this.
  if (opts.allowPrivate) {
    return url;
  }

  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new SsrfBlockedError(`blocked metadata hostname: ${host}`);
  }

  // Literal IP host: validate directly, no DNS needed.
  const literalFamily = net.isIP(host);
  if (literalFamily !== 0) {
    if (isBlockedIpLiteral(host)) {
      throw new SsrfBlockedError(`blocked IP address: ${host}`);
    }
    return url;
  }

  // Hostname: resolve every address and reject if ANY is blocked.
  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new SsrfBlockedError(`DNS resolution failed for host: ${host}`);
  }

  if (records.length === 0) {
    throw new SsrfBlockedError(`no DNS records for host: ${host}`);
  }

  for (const rec of records) {
    if (isBlockedResolvedAddress(rec.address, rec.family)) {
      throw new SsrfBlockedError(
        `host ${host} resolves to blocked address ${rec.address}`
      );
    }
  }

  return url;
}

/**
 * Convenience wrapper: validate `url`, then fetch with redirects disabled.
 *
 * If the response is a 3xx with a Location header, the redirect target is
 * re-validated with assertSafeOutboundUrl and followed exactly once (also with
 * redirects disabled). Any further redirect is returned as-is to the caller —
 * we never chase an unbounded redirect chain into internal space.
 *
 * Callers that don't need redirect-following can ignore the convenience and call
 * assertSafeOutboundUrl + fetch(..., { redirect: 'manual' }) directly.
 */
export async function safeFetch(
  rawUrl: string,
  init?: RequestInit,
  opts: SsrfOptions = {}
): Promise<Response> {
  await assertSafeOutboundUrl(rawUrl, opts);

  const first = await fetch(rawUrl, { ...init, redirect: "manual" });

  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (location) {
      const target = new URL(location, rawUrl).toString();
      await assertSafeOutboundUrl(target, opts);
      return fetch(target, { ...init, redirect: "manual" });
    }
  }

  return first;
}
