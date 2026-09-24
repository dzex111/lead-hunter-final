import { createHash } from 'node:crypto';
import { getDomain } from 'tldts';

/**
 * URL canonicalization. Guarantees:
 *  - idempotence (canonicalize(canonicalize(u)) === canonicalize(u))
 *  - lowercase host, `www.` stripped, fragment dropped
 *  - tracking params removed, remaining params sorted
 *  - platform subdomains keep their identity (x.youcan.shop != youcan.shop)
 */
export const TRACKING_PARAMS: readonly string[] = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'utm_name', 'utm_cid', 'utm_reader', 'utm_referrer', 'fbclid', 'gclid', 'dclid',
  'msclkid', 'ttclid', 'twclid', 'yclid', 'igshid', 'igsh', 'ref', 'ref_src',
  'mc_cid', 'mc_eid', 'gclsrc', 'wbraid', 'gbraid', 'si', 'spm', '_ga', '_gl',
  'sc_cid', 'campaign', 'fb_action_ids', 'fb_action_types',
];

const TRACKING_SET = new Set(TRACKING_PARAMS);
const PLATFORM_ROOTS = ['youcan.shop', 'myshopify.com', 'lightfunnels.com', 'youcan.store'];

export interface CanonicalUrl {
  original: string;
  canonical: string;
  host: string;
  domain: string;
  etld1: string;
  isSubdomainOfPlatformHost: boolean;
  scheme: 'http' | 'https';
  pathSegments: string[];
}

function stripWww(host: string): string {
  return host.replace(/^www\./, '');
}

export function canonicalizeUrl(input: string, base?: string): CanonicalUrl {
  const raw = input.trim();
  let parsed: URL;
  try {
    parsed = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new Error(`not an absolute URL: ${input}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported scheme: ${parsed.protocol}`);
  }
  const scheme: 'http' | 'https' = parsed.protocol === 'http:' ? 'http' : 'https';
  const host = stripWww(parsed.hostname.toLowerCase());
  const domain = (getDomain(host, { allowPrivateDomains: true }) ?? host).toLowerCase();

  const params = Array.from(parsed.searchParams.entries())
    .filter(([key]) => !TRACKING_SET.has(key.toLowerCase()) && !key.toLowerCase().startsWith('utm_'))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const search = new URLSearchParams(params).toString();

  let pathname = parsed.pathname || '/';
  pathname = pathname.replace(/\/{2,}/g, '/');
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (pathname === '') pathname = '/';

  const isSubdomainOfPlatformHost = PLATFORM_ROOTS.some(
    (root) => host.endsWith(`.${root}`) && host !== root,
  );

  return {
    original: raw,
    canonical: `${scheme}://${host}${pathname}${search ? `?${search}` : ''}`,
    host,
    domain,
    etld1: domain,
    isSubdomainOfPlatformHost,
    scheme,
    pathSegments: pathname.split('/').filter((segment) => segment.length > 0),
  };
}

export function safeCanonicalizeUrl(input: string, base?: string): CanonicalUrl | null {
  try {
    return canonicalizeUrl(input, base);
  } catch {
    return null;
  }
}

export function urlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 24);
}

export function hostOf(input: string): string | null {
  return safeCanonicalizeUrl(input)?.host ?? null;
}

export function sameSite(a: string, b: string): boolean {
  const ua = safeCanonicalizeUrl(a);
  const ub = safeCanonicalizeUrl(b);
  if (!ua || !ub) return false;
  return ua.host === ub.host;
}

export function sameEtld1(a: string, b: string): boolean {
  const ua = safeCanonicalizeUrl(a);
  const ub = safeCanonicalizeUrl(b);
  if (!ua || !ub) return false;
  return ua.etld1 === ub.etld1;
}

export function extractUrlsFromText(text: string): string[] {
  const matches = text.match(/\bhttps?:\/\/[^\s<>"')]+/gi) ?? [];
  const bare =
    text.match(/\b(?:[a-z0-9-]+\.)+(?:dz|com|shop|store|net|fr|io|co|org)\b(?:\/[^\s<>"')]*)?/gi) ?? [];
  const out: string[] = [];
  for (const candidate of [...matches, ...bare]) {
    const normalized = candidate.startsWith('http') ? candidate : `https://${candidate}`;
    const canonical = safeCanonicalizeUrl(normalized);
    if (canonical) out.push(canonical.canonical);
  }
  return Array.from(new Set(out));
}

export function resolveUrl(href: string, base: string): string | null {
  return safeCanonicalizeUrl(href, base)?.canonical ?? null;
}
