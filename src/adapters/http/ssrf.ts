import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { safeCanonicalizeUrl } from '@/core/normalize/url';

/**
 * SSRF protection: a URL is only fetchable when it is http(s), resolves to a
 * public IP, and stays public after every redirect hop.
 */
export class SsrfError extends Error {
  readonly url: string;

  constructor(url: string, reason: string) {
    super(`blocked by SSRF guard: ${reason} (${url})`);
    this.name = 'SsrfError';
    this.url = url;
  }
}

const BLOCKED_V4 = [
  { base: '0.0.0.0', bits: 8 },
  { base: '10.0.0.0', bits: 8 },
  { base: '100.64.0.0', bits: 10 },
  { base: '127.0.0.0', bits: 8 },
  { base: '169.254.0.0', bits: 16 },
  { base: '172.16.0.0', bits: 12 },
  { base: '192.0.0.0', bits: 24 },
  { base: '192.0.2.0', bits: 24 },
  { base: '192.168.0.0', bits: 16 },
  { base: '198.18.0.0', bits: 15 },
  { base: '198.51.100.0', bits: 24 },
  { base: '203.0.113.0', bits: 24 },
  { base: '224.0.0.0', bits: 4 },
  { base: '240.0.0.0', bits: 4 },
];

const BLOCKED_V6_PREFIXES = ['::1', '::', 'fc', 'fd', 'fe80', 'ff', '64:ff9b', '2001:db8', '2002'];

export function isBlockedHostname(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.internal')) return true;
  if (lower === 'metadata.google.internal' || lower === 'instance-data') return true;
  return false;
}

export function ipToLong(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

export function isBlockedIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const value = ipToLong(ip);
    if (value === null) return true;
    for (const range of BLOCKED_V4) {
      const base = ipToLong(range.base);
      if (base === null) continue;
      const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
      if ((value & mask) >>> 0 === (base & mask) >>> 0) return true;
    }
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.replace('::ffff:', '');
    return isIP(mapped) === 4 ? isBlockedIp(mapped) : true;
  }
  return BLOCKED_V6_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export interface ResolvedTarget {
  host: string;
  addresses: string[];
}

/** Resolves DNS and rejects any private/loopback/link-local/metadata address. */
export async function assertPublicHost(host: string): Promise<ResolvedTarget> {
  if (isBlockedHostname(host)) throw new SsrfError(host, 'blocked hostname');
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) throw new SsrfError(host, 'IP literal in a private range');
    return { host, addresses: [host] };
  }
  let records: { address: string; family: number }[];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new SsrfError(host, `DNS resolution failed: ${(error as Error).message}`);
  }
  if (records.length === 0) throw new SsrfError(host, 'no DNS records');
  const addresses = records.map((record) => record.address);
  for (const address of addresses) {
    if (isBlockedIp(address)) throw new SsrfError(host, `resolves to blocked address ${address}`);
  }
  return { host, addresses };
}

export async function assertFetchableUrl(rawUrl: string): Promise<{ url: string; host: string }> {
  const canonical = safeCanonicalizeUrl(rawUrl);
  if (!canonical) throw new SsrfError(rawUrl, 'not an absolute http(s) URL');
  if (canonical.scheme !== 'https' && canonical.scheme !== 'http') {
    throw new SsrfError(rawUrl, 'only http(s) is allowed');
  }
  if (canonical.host.includes('@')) throw new SsrfError(rawUrl, 'credentials in URL are not allowed');
  await assertPublicHost(canonical.host);
  return { url: canonical.canonical, host: canonical.host };
}
