import * as cheerio from 'cheerio';
import { normalizeHandle } from '@/core/normalize/handles';
import { extractAllAlgerianPhones } from '@/core/normalize/phone';
import { extractEmails } from '@/core/normalize/handles';
import { safeCanonicalizeUrl, sameEtld1 } from '@/core/normalize/url';
import type { RawCandidate } from '@/core/types';
import { uniqueBy } from '@/core/util';
import { isExcludedDomain } from '@/adapters/sources/directory';
import { SourceNotReadyError, type DiscoveryContext, type DiscoverySource } from '@/adapters/sources/types';

/**
 * Site crawl expansion: from a known merchant site, follow outbound social
 * links, link-in-bio pages, sitemap and contact/about pages, at depth <= 2 and
 * always through the safe fetcher (robots-aware, rate limited).
 */
const CONTACT_PATHS = [
  '/contact',
  '/contact-us',
  '/pages/contact',
  '/a-propos',
  '/about',
  '/pages/about',
  '/nous-contacter',
  '/اتصل-بنا',
];

const LINK_IN_BIO_HOSTS = [
  'linktr.ee',
  'linktree.com',
  'bio.link',
  'taplink.cc',
  'beacons.ai',
  'linkin.bio',
  'msha.ke',
  'lnk.bio',
];

export interface CrawlExtraction {
  socialLinks: { network: 'facebook' | 'instagram' | 'tiktok'; value: string; url: string }[];
  phones: string[];
  emails: string[];
  linkInBio: string[];
  internalPaths: string[];
}

export function extractCrawlTargets(baseUrl: string, html: string): CrawlExtraction {
  const $ = cheerio.load(html);
  const socialLinks: CrawlExtraction['socialLinks'] = [];
  const linkInBio: string[] = [];
  const internalPaths: string[] = [];

  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    const canonical = safeCanonicalizeUrl(href, baseUrl);
    if (!canonical) return;
    const handle = normalizeHandle(canonical.canonical);
    if (handle && handle.network !== 'whatsapp' && handle.network !== 'messenger') {
      socialLinks.push({ network: handle.network, value: handle.value, url: handle.profileUrl });
      return;
    }
    if (LINK_IN_BIO_HOSTS.some((host) => canonical.host.includes(host))) {
      linkInBio.push(canonical.canonical);
      return;
    }
    if (sameEtld1(canonical.canonical, baseUrl)) {
      internalPaths.push(canonical.pathSegments.join('/'));
    }
  });

  const text = $('body').text().slice(0, 400_000);
  return {
    socialLinks: uniqueBy(socialLinks, (link) => `${link.network}:${link.value}`),
    phones: extractAllAlgerianPhones(text).map((phone) => phone.e164),
    emails: extractEmails(text).slice(0, 5),
    linkInBio: Array.from(new Set(linkInBio)).slice(0, 3),
    internalPaths: Array.from(new Set(internalPaths)).slice(0, 40),
  };
}

export function crawlExpansionSource(): DiscoverySource {
  const id = 'site_crawl_expansion';
  return {
    id,
    label: 'Site crawl expansion (depth <= 2, robots-aware)',
    capabilities: {
      network: true,
      paidApi: false,
      requiresCredentials: false,
      robotsRespect: true,
      costUnitsPerCall: 1,
      note: 'Follows outbound socials, link-in-bio, sitemap and contact/about pages of a merchant site.',
    },
    ensureReady(ctx) {
      if (!(ctx.params['url'] ?? '').trim()) throw new SourceNotReadyError(id, 'pass --url <merchant site>');
    },
    async *discover(ctx: DiscoveryContext) {
      const start = safeCanonicalizeUrl(ctx.params['url'] ?? '');
      if (!start) throw new SourceNotReadyError(id, 'not a valid URL');
      const maxDepth = Math.min(2, Number.parseInt(ctx.params['depth'] ?? '1', 10) || 1);

      const queue: { url: string; depth: number }[] = [{ url: start.canonical, depth: 0 }];
      const visited = new Set<string>();
      const emittedSocial = new Set<string>();

      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        if (visited.has(next.url) || next.depth > maxDepth) continue;
        visited.add(next.url);
        if (!ctx.budget.consume(1)) {
          ctx.logger.warn({}, 'crawl budget exhausted');
          return;
        }
        if (ctx.dryRun) {
          const preview: RawCandidate = {
            sourceId: id,
            url: next.url,
            provenance: { origin: 'site_crawl_expansion', depth: next.depth, dryRun: true },
            costUnits: 0,
          };
          yield preview;
          continue;
        }
        let html = '';
        try {
          const response = await ctx.http.fetch({ url: next.url, purpose: 'crawl' });
          html = response.body;
        } catch (error) {
          ctx.logger.warn({ url: next.url, error: (error as Error).message }, 'crawl fetch skipped');
          continue;
        }
        const extraction = extractCrawlTargets(next.url, html);
        for (const social of extraction.socialLinks) {
          if (emittedSocial.has(`${social.network}:${social.value}`)) continue;
          emittedSocial.add(`${social.network}:${social.value}`);
          const candidate: RawCandidate = {
            sourceId: id,
            name: social.value,
            handles: [{ network: social.network, value: social.value }],
            provenance: { origin: 'site_crawl_expansion', foundOn: next.url, depth: next.depth },
            costUnits: 0,
          };
          yield candidate;
        }
        if (next.depth === 0) {
          for (const path of [...CONTACT_PATHS.slice(0, 3), ...extraction.internalPaths.slice(0, 3)]) {
            const target = safeCanonicalizeUrl(path.startsWith('/') ? `${next.url.replace(/\/$/, '')}${path}` : path, next.url);
            if (!target || visited.has(target.canonical)) continue;
            queue.push({ url: target.canonical, depth: next.depth + 1 });
          }
          const sitemapUrl = `${start.scheme}://${start.host}/sitemap.xml`;
          queue.push({ url: sitemapUrl, depth: next.depth + 1 });
          for (const bio of extraction.linkInBio) {
            queue.push({ url: bio, depth: next.depth + 1 });
          }
        }
        ctx.logger.info({ url: next.url, visited: visited.size, queued: queue.length }, 'crawl step');
      }
    },
  };
}

/** Sitemap product URL discovery for a known merchant site. */
export function sitemapProductUrls(xml: string, limit = 5000): string[] {
  const locs = xml.match(/<loc>([^<]+)<\/loc>/gi) ?? [];
  const out: string[] = [];
  for (const loc of locs) {
    const url = loc.replace(/<\/?loc>/gi, '').trim();
    if (/\/products?\//i.test(url) || /\/produit\//i.test(url)) out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

export function isMerchantOwned(url: string): boolean {
  return !isExcludedDomain(url);
}
