import { request } from 'undici';
import robotsParser from 'robots-parser';
import { safeCanonicalizeUrl } from '@/core/normalize/url';

/**
 * robots.txt handling: fetched with a plain, honest User-Agent, cached per
 * domain with a TTL, and consulted before every crawl (never before API calls
 * to the engine's own providers).
 */
export interface RobotsVerdict {
  allowed: boolean;
  reason: string;
  /** Crawl-delay parsed from robots.txt (seconds), if the site declares one. */
  crawlDelaySeconds: number | null;
}

interface CacheEntry {
  fetchedAt: number;
  url: string;
  body: string | null;
}

export interface RobotsOptions {
  userAgent: string;
  ttlMs?: number;
  timeoutMs?: number;
  /** Test seam: replaces the network fetch. */
  fetcher?: (url: string, userAgent: string) => Promise<string | null>;
}

const DEFAULT_TTL = 6 * 60 * 60_000;

async function defaultFetcher(url: string, userAgent: string): Promise<string | null> {
  try {
    const response = await request(url, {
      method: 'GET',
      headers: { 'user-agent': userAgent, accept: 'text/plain' },
      headersTimeout: 8_000,
      bodyTimeout: 8_000,
    });
    if (response.statusCode >= 400) {
      await response.body.dump();
      return null;
    }
    const text = await response.body.text();
    return text.slice(0, 200_000);
  } catch {
    return null;
  }
}

export class RobotsCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly options: Required<RobotsOptions>;

  constructor(options: RobotsOptions) {
    this.options = {
      userAgent: options.userAgent,
      ttlMs: options.ttlMs ?? DEFAULT_TTL,
      timeoutMs: options.timeoutMs ?? 8_000,
      fetcher: options.fetcher ?? defaultFetcher,
    };
  }

  private async load(domain: string, scheme: 'http' | 'https'): Promise<CacheEntry> {
    const cached = this.cache.get(domain);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < this.options.ttlMs) return cached;
    const robotsUrl = `${scheme}://${domain}/robots.txt`;
    let body: string | null = null;
    try {
      body = await Promise.race([
        this.options.fetcher(robotsUrl, this.options.userAgent),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), this.options.timeoutMs)),
      ]);
    } catch {
      body = null;
    }
    const entry: CacheEntry = { fetchedAt: now, url: robotsUrl, body };
    this.cache.set(domain, entry);
    return entry;
  }

  /** Fails open only for unreachable robots.txt — never for an explicit Disallow. */
  async check(rawUrl: string, now = Date.now()): Promise<RobotsVerdict> {
    const canonical = safeCanonicalizeUrl(rawUrl);
    if (!canonical) return { allowed: false, reason: 'invalid URL', crawlDelaySeconds: null };
    const entry = await this.load(canonical.host, canonical.scheme);
    if (entry.body === null) {
      return {
        allowed: false,
        reason: 'robots.txt unreachable — failing closed, no crawl',
        crawlDelaySeconds: null,
      };
    }
    const parser = robotsParser(entry.url, entry.body);
    const allowed = parser.isAllowed(rawUrl, this.options.userAgent);
    if (allowed === false) {
      return { allowed: false, reason: 'disallowed by robots.txt', crawlDelaySeconds: null };
    }
    const crawlDelay = parser.getCrawlDelay(this.options.userAgent);
    void now;
    return {
      allowed: true,
      reason: 'allowed by robots.txt',
      crawlDelaySeconds: typeof crawlDelay === 'number' ? crawlDelay : null,
    };
  }

  setForTesting(domain: string, body: string | null): void {
    this.cache.set(domain, { fetchedAt: Date.now(), url: `https://${domain}/robots.txt`, body });
  }
}
