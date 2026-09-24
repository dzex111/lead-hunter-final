import type { RawCandidate } from '@/core/types';
import { SourceNotReadyError, type DiscoverySource } from '@/adapters/sources/types';

/**
 * Meta Ad Library API (`ads_archive`) adapter.
 *
 * Phase-0 verification result (docs/SOURCES.md): the reference documents
 * `ad_reached_countries` as required and includes `DZ` in its enum, and the
 * general fields (id, page_id, page_name, ad_creative_bodies,
 * ad_creation_time, ad_delivery_start_time, ad_snapshot_url,
 * publisher_platforms) exist. What could NOT be verified from official docs is
 * whether *commercial* (non-political) ads for Algeria are returnable at all —
 * the Ad Library API is documented to expose political/issue ads globally and
 * all ads only for EU/UK DSA scopes. Therefore this adapter is:
 *   - feature-flagged OFF by default (`LEADHUNTER_ENABLE_META_AD_LIBRARY`)
 *   - fails closed with a clear error when the flag/token is missing
 *   - never guesses fields or endpoints beyond the documented ones
 * The compliant alternative (`ad_library_manual`) is enabled: the operator
 * pastes what the public Ad Library UI shows.
 */
const ENDPOINT = 'https://graph.facebook.com/v21.0/ads_archive';
const FIELDS = [
  'id',
  'page_id',
  'page_name',
  'ad_creation_time',
  'ad_delivery_start_time',
  'ad_delivery_stop_time',
  'ad_snapshot_url',
  'ad_creative_bodies',
  'publisher_platforms',
].join(',');

interface AdsArchiveResponse {
  data?: {
    id?: string;
    page_id?: string;
    page_name?: string;
    ad_creation_time?: string;
    ad_delivery_start_time?: string;
    ad_snapshot_url?: string;
    ad_creative_bodies?: string[];
    publisher_platforms?: string[];
  }[];
  paging?: { cursors?: { after?: string }; next?: string };
  error?: { message?: string; type?: string; code?: number };
}

export function metaAdLibrarySource(): DiscoverySource {
  const id = 'meta_ad_library_api';
  return {
    id,
    label: 'Meta Ad Library API (ads_archive) — OFF by default, unverified commercial scope',
    capabilities: {
      network: true,
      paidApi: false,
      requiresCredentials: true,
      robotsRespect: false,
      costUnitsPerCall: 1,
      note: 'Official Graph API only. Commercial ad returnability for Algeria is unverified → flagged off.',
    },
    ensureReady(ctx) {
      if (!ctx.config.flags.metaAdLibraryApi) {
        throw new SourceNotReadyError(
          id,
          'disabled: commercial (non-political) ads for DZ could not be verified as returnable from the official docs. ' +
            'Use ad_library_manual, or set LEADHUNTER_ENABLE_META_AD_LIBRARY=true + META_AD_LIBRARY_TOKEN after re-verifying.',
        );
      }
      if (!ctx.config.providers.metaAdLibraryToken) {
        throw new SourceNotReadyError(id, 'META_AD_LIBRARY_TOKEN missing');
      }
    },
    async *discover(ctx) {
      const token = ctx.config.providers.metaAdLibraryToken as string;
      const searchTerms = (ctx.params['terms'] ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      if (searchTerms.length === 0) {
        throw new SourceNotReadyError(id, 'pass --terms "parfum,vetements" (Ad Library requires a search term)');
      }
      const limits = { maxPerTerm: Number.parseInt(ctx.params['limit'] ?? '25', 10) || 25 };

      for (const term of searchTerms) {
        if (!ctx.budget.consume(1)) {
          ctx.logger.warn({}, 'meta ad library budget exhausted');
          return;
        }
        const url = new URL(ENDPOINT);
        url.searchParams.set('access_token', token);
        url.searchParams.set('search_terms', term);
        url.searchParams.set('ad_reached_countries', JSON.stringify(['DZ']));
        url.searchParams.set('ad_type', 'ALL');
        url.searchParams.set('fields', FIELDS);
        url.searchParams.set('limit', String(Math.min(100, limits.maxPerTerm)));
        const response = await ctx.http.fetch({ url: url.toString(), purpose: 'meta_ad_library' });
        let parsed: AdsArchiveResponse;
        try {
          parsed = JSON.parse(response.body) as AdsArchiveResponse;
        } catch {
          ctx.logger.error({ body: response.body.slice(0, 300) }, 'ads_archive returned non-JSON');
          continue;
        }
        if (parsed.error) {
          // Fail loudly and clearly — never silently swallow an API contract change.
          throw new Error(
            `ads_archive error for "${term}": ${parsed.error.message ?? 'unknown'} (code ${parsed.error.code ?? 'n/a'})`,
          );
        }
        ctx.logger.info({ term, ads: parsed.data?.length ?? 0 }, 'ads_archive page fetched');
        for (const ad of parsed.data ?? []) {
          if (!ad.page_id) continue;
          const candidate: RawCandidate = {
            sourceId: id,
            name: ad.page_name ?? `page:${ad.page_id}`,
            handles: [{ network: 'facebook', value: ad.page_id }],
            provenance: {
              origin: 'meta_ad_library_api',
              pageId: ad.page_id,
              adId: ad.id ?? null,
              adCreationTime: ad.ad_creation_time ?? null,
              adDeliveryStartTime: ad.ad_delivery_start_time ?? null,
              adSnapshotUrl: ad.ad_snapshot_url ?? null,
              publisherPlatforms: (ad.publisher_platforms ?? []).join('|'),
              searchTerm: term,
            },
            annotations: {
              is_advertiser: true,
              creativeSample: (ad.ad_creative_bodies?.[0] ?? '').slice(0, 200),
            },
            costUnits: 1,
          };
          yield candidate;
        }
      }
    },
  };
}
