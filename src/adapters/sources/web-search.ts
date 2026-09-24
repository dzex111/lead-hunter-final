import { MARKETPLACE_BLOCKLIST, NEWS_BLOCKLIST } from '@/core/data/lexicons';
import { WILAYAS } from '@/core/data/wilayas';
import { safeCanonicalizeUrl } from '@/core/normalize/url';
import type { RawCandidate } from '@/core/types';
import { uniqueBy } from '@/core/util';
import { asAsyncIterable, SourceNotReadyError, type DiscoveryContext, type DiscoverySource } from '@/adapters/sources/types';

/**
 * Web search adapter with a provider interface.
 *
 * Verified endpoints (see docs/SOURCES.md):
 *  - Brave:  GET https://api.search.brave.com/res/v1/web/search?q=...  header X-Subscription-Token
 *  - Google CSE: GET https://www.googleapis.com/customsearch/v1?key=&cx=&q=  → items[].link/title/snippet
 *  - Serper: UNVERIFIED against official docs in Phase 0 → feature-flagged OFF and fails closed.
 */
export interface SearchResultItem {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchProvider {
  id: 'brave' | 'google_cse' | 'serper';
  label: string;
  costUnitsPerCall: number;
  ready(ctx: DiscoveryContext): { ready: boolean; reason: string };
  search(ctx: DiscoveryContext, query: string, limit: number): Promise<SearchResultItem[]>;
}

export const braveProvider: SearchProvider = {
  id: 'brave',
  label: 'Brave Search API',
  costUnitsPerCall: 1,
  ready(ctx) {
    const key = ctx.config.providers.braveApiKey;
    if (!key) return { ready: false, reason: 'BRAVE_API_KEY missing (fail closed)' };
    if (ctx.config.budgets.brave.dailyUnits <= 0) {
      return { ready: false, reason: 'LEADHUNTER_PROVIDER_BUDGET_BRAVE is 0' };
    }
    return { ready: true, reason: 'ok' };
  },
  async search(ctx, query, limit) {
    const key = ctx.config.providers.braveApiKey as string;
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(20, limit)));
    url.searchParams.set('country', 'dz');
    url.searchParams.set('search_lang', /[\u0600-\u06FF]/.test(query) ? 'ar' : 'fr');
    const response = await ctx.http.fetch({
      url: url.toString(),
      headers: { 'x-subscription-token': key, accept: 'application/json' },
      purpose: 'web_search:brave',
    });
    const parsed = JSON.parse(response.body) as {
      web?: { results?: { url?: string; title?: string; description?: string }[] };
    };
    return (parsed.web?.results ?? []).map((item) => ({
      url: item.url ?? '',
      title: item.title ?? '',
      snippet: item.description ?? '',
    }));
  },
};

export const googleCseProvider: SearchProvider = {
  id: 'google_cse',
  label: 'Google Programmable Search (Custom Search JSON API)',
  costUnitsPerCall: 1,
  ready(ctx) {
    if (!ctx.config.providers.googleCseKey) return { ready: false, reason: 'GOOGLE_CSE_KEY missing' };
    if (!ctx.config.providers.googleCseCx) return { ready: false, reason: 'GOOGLE_CSE_CX missing' };
    if (ctx.config.budgets.google_cse.dailyUnits <= 0) {
      return { ready: false, reason: 'LEADHUNTER_PROVIDER_BUDGET_GOOGLE_CSE is 0' };
    }
    return { ready: true, reason: 'ok' };
  },
  async search(ctx, query, limit) {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', ctx.config.providers.googleCseKey as string);
    url.searchParams.set('cx', ctx.config.providers.googleCseCx as string);
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(Math.min(10, limit)));
    url.searchParams.set('gl', 'dz');
    const response = await ctx.http.fetch({ url: url.toString(), purpose: 'web_search:cse' });
    const parsed = JSON.parse(response.body) as {
      items?: { link?: string; title?: string; snippet?: string }[];
    };
    return (parsed.items ?? []).map((item) => ({
      url: item.link ?? '',
      title: item.title ?? '',
      snippet: item.snippet ?? '',
    }));
  },
};

export const serperProvider: SearchProvider = {
  id: 'serper',
  label: 'Serper (Google SERP API) — UNVERIFIED, feature-flagged',
  costUnitsPerCall: 1,
  ready(ctx) {
    // Per the non-negotiable rules: an unverifiable source must fail closed.
    if (!ctx.config.flags.serper) {
      return {
        ready: false,
        reason:
          'serper is disabled: its official API documentation could not be fetched during Phase 0 verification (docs/SOURCES.md). Set LEADHUNTER_ENABLE_SERPER=true only after verifying the endpoint yourself.',
      };
    }
    if (!ctx.config.providers.serperApiKey) return { ready: false, reason: 'SERPER_API_KEY missing' };
    if (ctx.config.budgets.serper.dailyUnits <= 0) {
      return { ready: false, reason: 'LEADHUNTER_PROVIDER_BUDGET_SERPER is 0' };
    }
    return { ready: true, reason: 'enabled by operator opt-in' };
  },
  async search(ctx, query, limit) {
    const response = await ctx.http.fetch({
      url: 'https://google.serper.dev/search',
      method: 'POST',
      headers: {
        'x-api-key': ctx.config.providers.serperApiKey as string,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ q: query, gl: 'dz', hl: 'fr', num: Math.min(20, limit) }),
      purpose: 'web_search:serper',
    });
    const parsed = JSON.parse(response.body) as { organic?: { link?: string; title?: string; snippet?: string }[] };
    return (parsed.organic ?? []).map((item) => ({
      url: item.link ?? '',
      title: item.title ?? '',
      snippet: item.snippet ?? '',
    }));
  },
};

export const ALL_PROVIDERS: readonly SearchProvider[] = [braveProvider, googleCseProvider, serperProvider];

/** Query generator: platform footprints × wilayas × verticals × languages. */
export const VERTICAL_TERMS_AR: Record<string, string[]> = {
  fashion: ['ملابس', 'فساتين', 'عبايات'],
  beauty: ['عطور', 'مكياج', 'كريمات'],
  phones_accessories: ['اكسسوارات هاتف', 'سماعات'],
  home_kitchen: ['ادوات المطبخ', 'مستلزمات المنزل'],
  kids: ['ملابس اطفال', 'العاب'],
  electronics: ['الكترونيات', 'ساعات ذكية'],
  auto: ['اكسسوارات السيارات'],
  jewelry_watches: ['مجوهرات', 'ساعات'],
  health_supplements: ['مكملات غذائية'],
  shoes: ['احذية'],
};

export const VERTICAL_TERMS_FR: Record<string, string[]> = {
  fashion: ['vetements', 'robes', 'abaya'],
  beauty: ['parfum', 'maquillage', 'cosmetiques'],
  phones_accessories: ['accessoires telephone', 'ecouteurs'],
  home_kitchen: ['ustensiles cuisine', 'decoration maison'],
  kids: ['vetements enfant', 'jouets'],
  electronics: ['electronique', 'montre connectee'],
  auto: ['accessoires voiture'],
  jewelry_watches: ['bijoux', 'montres'],
  health_supplements: ['complements alimentaires'],
  shoes: ['chaussures'],
};

export const PLATFORM_FOOTPRINTS: Record<string, string[]> = {
  shopify: ['myshopify.com', 'cdn.shopify.com'],
  youcan: ['youcan.shop', 'youcan.store'],
  woocommerce: ['wp-content/plugins/woocommerce', 'woocommerce'],
  lightfunnels: ['lightfunnels'],
  wix: ['wixsite.com', 'wixstatic'],
  squarespace: ['squarespace'],
  webflow: ['webflow.io', 'website-files.com'],
  prestashop: ['prestashop'],
  magento: ['magento'],
};

export const COD_PHRASE_FR = '"paiement à la livraison"';
export const COD_PHRASE_AR = '"الدفع عند الاستلام"';

export interface GeneratedQuery {
  query: string;
  provider: string;
  language: 'ar' | 'fr';
  wilaya: string;
  vertical: string;
}

export interface QueryGeneratorOptions {
  language: 'ar' | 'fr' | 'both';
  verticals: string[];
  wilayaCodes: number[];
  platform?: string;
  extra?: string[];
  max?: number;
}

/** Deterministic query generation; the bandit decides which ones to actually run. */
export function generateQueries(options: QueryGeneratorOptions): GeneratedQuery[] {
  const out: GeneratedQuery[] = [];
  const wilayas = options.wilayaCodes
    .map((code) => WILAYAS.find((wilaya) => wilaya.code === code))
    .filter((wilaya): wilaya is (typeof WILAYAS)[number] => wilaya !== undefined);
  const languages: ('ar' | 'fr')[] = options.language === 'both' ? ['ar', 'fr'] : [options.language];
  const footprint = options.platform ? (PLATFORM_FOOTPRINTS[options.platform] ?? []) : [];

  for (const language of languages) {
    for (const wilaya of wilayas) {
      for (const vertical of options.verticals) {
        const terms = language === 'ar' ? VERTICAL_TERMS_AR[vertical] ?? [] : VERTICAL_TERMS_FR[vertical] ?? [];
        for (const term of terms.slice(0, 2)) {
          const base =
            language === 'ar'
              ? `${COD_PHRASE_AR} ${term} ${wilaya.ar}`
              : `${COD_PHRASE_FR} ${term} ${wilaya.fr}`;
          out.push({
            query: base,
            provider: 'pending',
            language,
            wilaya: wilaya.fr,
            vertical,
          });
          if (footprint.length > 0) {
            for (const marker of footprint.slice(0, 1)) {
              out.push({
                query: `${base} inurl:${marker}`,
                provider: 'pending',
                language,
                wilaya: wilaya.fr,
                vertical,
              });
            }
          }
        }
      }
    }
  }
  for (const extra of options.extra ?? []) {
    out.push({ query: extra, provider: 'pending', language: 'fr', wilaya: 'all', vertical: 'custom' });
  }
  const limited = options.max ? out.slice(0, options.max) : out;
  return uniqueBy(limited, (item) => item.query);
}

export function filterSearchResults(
  items: readonly SearchResultItem[],
  excludeHosts: readonly string[] = [],
): SearchResultItem[] {
  const out: SearchResultItem[] = [];
  for (const item of items) {
    const canonical = safeCanonicalizeUrl(item.url);
    if (!canonical) continue;
    const host = canonical.host;
    const blocked =
      MARKETPLACE_BLOCKLIST.some((needle) => host.includes(needle)) ||
      NEWS_BLOCKLIST.some((needle) => host.includes(needle)) ||
      excludeHosts.some((excluded) => host === excluded);
    if (blocked) continue;
    out.push({ ...item, url: canonical.canonical });
  }
  return uniqueBy(out, (item) => item.url);
}

export function webSearchSource(availableProviders: readonly SearchProvider[] = ALL_PROVIDERS): DiscoverySource {
  const id = 'web_search';
  return {
    id,
    label: 'Web search (Brave / Google CSE; Serper feature-flagged)',
    capabilities: {
      network: true,
      paidApi: true,
      requiresCredentials: true,
      robotsRespect: false,
      costUnitsPerCall: 1,
      note: 'Search APIs only — result URLs are later fetched through the safe fetcher (robots-aware).',
    },
    ensureReady(ctx) {
      const ready = availableProviders.filter((provider) => provider.ready(ctx).ready);
      if (ready.length === 0) {
        throw new SourceNotReadyError(
          id,
          `no search provider is configured. ${availableProviders
            .map((provider) => `${provider.id}: ${provider.ready(ctx).reason}`)
            .join(' | ')}`,
        );
      }
    },
    async *discover(ctx) {
      const limit = Number.parseInt(ctx.params['limit'] ?? '10', 10) || 10;
      const providers = availableProviders.filter((provider) => provider.ready(ctx).ready);
      const queries = (ctx.params['queries'] ?? '')
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean);
      const platform = ctx.params['platform'];
      const generated =
        queries.length > 0
          ? queries.map<GeneratedQuery>((query) => ({
              query,
              provider: 'explicit',
              language: /[\u0600-\u06FF]/.test(query) ? 'ar' : 'fr',
              wilaya: ctx.params['wilaya'] ?? 'all',
              vertical: ctx.params['vertical'] ?? 'explicit',
            }))
          : generateQueries({
              language: (ctx.params['language'] as 'ar' | 'fr' | 'both') ?? 'both',
              verticals: (ctx.params['verticals'] ?? 'fashion,beauty').split(',').filter(Boolean),
              wilayaCodes: (ctx.params['wilayas'] ?? '16,31,25')
                .split(',')
                .map((value) => Number.parseInt(value, 10))
                .filter((value) => Number.isInteger(value)),
              ...(platform ? { platform } : {}),
              max: Number.parseInt(ctx.params['max_queries'] ?? '8', 10) || 8,
            });

      for (const generatedQuery of queries.length > 0 ? generated : generated) {
        for (const provider of providers) {
          if (!ctx.budget.consume(provider.costUnitsPerCall)) {
            ctx.logger.warn({ provider: provider.id }, 'search budget exhausted');
            return;
          }
          if (ctx.dryRun) {
            const preview: RawCandidate = {
              sourceId: id,
              provenance: {
                origin: 'web_search',
                provider: provider.id,
                query: generatedQuery.query,
                dryRun: true,
              },
              costUnits: 0,
            };
            yield preview;
            continue;
          }
          const started = ctx.clock.now();
          const items = await provider.search(ctx, generatedQuery.query, limit);
          const filtered = filterSearchResults(items);
          ctx.logger.info(
            {
              provider: provider.id,
              query: generatedQuery.query,
              results: items.length,
              kept: filtered.length,
              ms: ctx.clock.now().getTime() - started.getTime(),
            },
            'search query executed',
          );
          for (const item of filtered) {
            const candidate: RawCandidate = {
              sourceId: id,
              url: item.url,
              name: item.title.slice(0, 80),
              provenance: {
                origin: 'web_search',
                provider: provider.id,
                query: generatedQuery.query,
                language: generatedQuery.language,
                wilaya: generatedQuery.wilaya,
                vertical: generatedQuery.vertical,
              },
              costUnits: provider.costUnitsPerCall,
            };
            yield candidate;
          }
        }
      }
    },
  };
}

export function staticSearchSource(
  items: readonly SearchResultItem[],
  query = 'fixture',
): DiscoverySource {
  const id = 'web_search';
  return {
    id,
    label: 'Web search (offline fixture provider)',
    capabilities: {
      network: false,
      paidApi: false,
      requiresCredentials: false,
      robotsRespect: false,
      costUnitsPerCall: 0,
      note: 'Deterministic offline provider used by demo/sim.',
    },
    ensureReady: () => undefined,
    discover() {
      return asAsyncIterable(
        filterSearchResults(items).map<RawCandidate>((item) => ({
          sourceId: id,
          url: item.url,
          name: item.title,
          provenance: { origin: 'web_search', provider: 'fixture', query },
          costUnits: 0,
        })),
      );
    },
  };
}
