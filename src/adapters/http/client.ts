import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { request } from 'undici';
import type { HttpClient, HttpRequestSpec, HttpResponse } from '@/core/ports';
import type { Clock } from '@/core/clock';
import { contentHashOf } from '@/adapters/http/hash';
import { DomainLimiter, DEFAULT_DOMAIN_POLICY } from '@/adapters/http/rate-limiter';
import { RobotsCache } from '@/adapters/http/robots';
import { SsrfError, assertPublicHost } from '@/adapters/http/ssrf';

/**
 * Safe HTTP fetcher: SSRF-checked (DNS resolved and re-checked after every
 * redirect), robots.txt aware, per-domain rate limited + circuit broken,
 * conditional GET, 2 MB body cap, content-type allowlist, retries with
 * exponential backoff + full jitter, and optional HTML snapshot saving.
 */
export interface SafeFetchOptions {
  userAgent: string;
  clock: Clock;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  contentTypeAllowlist: string[];
  ratePerSecond: number;
  concurrencyPerDomain: number;
  maxRetries?: number;
  respectRobots?: boolean;
  saveSnapshots?: boolean;
  snapshotDir?: string;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
}

export class SafeFetcher implements HttpClient {
  private readonly limiter: DomainLimiter;
  private readonly robots: RobotsCache;
  private readonly conditionalCache = new Map<string, { etag: string | null; lastModified: string | null; body: string; meta: HttpResponse['meta']; headers: Record<string, string> }>();
  private readonly options: SafeFetchOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;

  constructor(options: SafeFetchOptions) {
    this.options = options;
    this.limiter = new DomainLimiter({
      ...DEFAULT_DOMAIN_POLICY,
      ratePerSecond: options.ratePerSecond,
      maxConcurrency: options.concurrencyPerDomain,
    });
    this.robots = new RobotsCache({ userAgent: options.userAgent });
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.jitter = options.jitter ?? Math.random;
  }

  async fetch(spec: HttpRequestSpec): Promise<HttpResponse> {
    const maxRetries = this.options.maxRetries ?? 3;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await this.attempt(spec);
      } catch (error) {
        lastError = error as Error;
        const retryable = !(error instanceof SsrfError) && !(error instanceof RobotsBlockedError);
        if (!retryable || attempt === maxRetries) break;
        const backoff = Math.min(30_000, 500 * Math.pow(2, attempt));
        await this.sleep(Math.floor(backoff * (0.5 + 0.5 * this.jitter())));
      }
    }
    throw lastError ?? new Error('fetch failed');
  }

  private async attempt(spec: HttpRequestSpec): Promise<HttpResponse> {
    let currentUrl = spec.url;
    let redirects = 0;
    let referer: string | null = null;

    for (;;) {
      const target = await assertPublicHost(new URL(currentUrl).host);
      const domain = target.host;

      if (this.options.respectRobots !== false && spec.method !== 'POST') {
        const verdict = await this.robots.check(currentUrl);
        if (!verdict.allowed) throw new RobotsBlockedError(currentUrl, verdict.reason);
      }

      const cacheKey = `${spec.method ?? 'GET'} ${currentUrl}`;
      const cached = this.conditionalCache.get(cacheKey);

      await this.limiter.acquire(domain);
      let ok = false;
      try {
        const headers: Record<string, string> = {
          'user-agent': this.options.userAgent,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5',
          'accept-language': 'ar,fr;q=0.8,en;q=0.6',
          ...(spec.headers ?? {}),
        };
        if (referer) headers['referer'] = referer;
        if (cached?.etag) headers['if-none-match'] = cached.etag;
        if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified;

        const response = await request(currentUrl, {
          method: spec.method ?? 'GET',
          headers,
          body: spec.body,
          headersTimeout: this.options.timeoutMs,
          bodyTimeout: this.options.timeoutMs,
        });

        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const location = response.headers['location'];
          await response.body.dump();
          const next = Array.isArray(location) ? location[0] : location;
          if (!next || redirects >= this.options.maxRedirects) {
            throw new Error(`too many redirects (${redirects}) or missing location for ${currentUrl}`);
          }
          const resolved = new URL(next, currentUrl).toString();
          // Re-check the redirect target against the SSRF guard immediately.
          await assertPublicHost(new URL(resolved).host);
          referer = currentUrl;
          currentUrl = resolved;
          redirects += 1;
          ok = true;
          continue;
        }

        if (response.statusCode === 304 && cached) {
          await response.body.dump();
          ok = true;
          return {
            meta: { ...cached.meta, fromCache: true, fetchedAt: this.options.clock.now().toISOString() },
            body: cached.body,
            headers: cached.headers,
          };
        }

        const contentTypeHeader = response.headers['content-type'];
        const contentType = (Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader) ?? null;
        const allowed =
          contentType === null ||
          this.options.contentTypeAllowlist.some((prefix) => contentType.toLowerCase().includes(prefix));
        if (!allowed) {
          await response.body.dump();
          throw new Error(`blocked content-type ${contentType} for ${currentUrl}`);
        }

        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of response.body) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > this.options.maxBytes) {
            response.body.destroy();
            throw new Error(`body exceeds ${this.options.maxBytes} bytes for ${currentUrl}`);
          }
          chunks.push(buffer);
        }
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const headerRecord: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          headerRecord[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
        }
        const meta: HttpResponse['meta'] = {
          status: response.statusCode,
          finalUrl: currentUrl,
          contentType,
          bytes,
          contentHash: contentHashOf(bodyText),
          fetchedAt: this.options.clock.now().toISOString(),
          fromCache: false,
          redirects,
          robotsAllowed: true,
          domain,
          costUnits: 1,
        };
        const etagHeader = response.headers['etag'];
        const lastModifiedHeader = response.headers['last-modified'];
        this.conditionalCache.set(cacheKey, {
          etag: etagHeader ? (Array.isArray(etagHeader) ? etagHeader[0] ?? null : etagHeader) : null,
          lastModified: lastModifiedHeader
            ? Array.isArray(lastModifiedHeader)
              ? lastModifiedHeader[0] ?? null
              : lastModifiedHeader
            : null,
          body: bodyText,
          meta,
          headers: headerRecord,
        });
        if (this.options.saveSnapshots === true && (spec.purpose ?? '').includes('fixture')) {
          await this.saveSnapshot(currentUrl, bodyText);
        }
        ok = true;
        return { meta, body: bodyText, headers: headerRecord };
      } finally {
        this.limiter.release(domain, { ok });
      }
    }
  }

  async saveSnapshot(url: string, body: string): Promise<string | null> {
    try {
      const dir = this.options.snapshotDir ?? path.join(process.cwd(), 'var', 'snapshots');
      await mkdir(dir, { recursive: true });
      const name = `${new URL(url).host.replace(/[^a-z0-9.-]/gi, '_')}-${createHash('sha1').update(url).digest('hex').slice(0, 10)}.html`;
      const file = path.join(dir, name);
      await writeFile(file, body, 'utf8');
      return file;
    } catch {
      return null;
    }
  }

  limiterStats(domain: string): ReturnType<DomainLimiter['stats']> {
    return this.limiter.stats(domain);
  }
}

export class RobotsBlockedError extends Error {
  readonly url: string;

  constructor(url: string, reason: string) {
    super(`robots.txt disallows fetching ${url}: ${reason}`);
    this.name = 'RobotsBlockedError';
    this.url = url;
  }
}
