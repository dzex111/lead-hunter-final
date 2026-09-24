import { WILAYAS } from '@/core/data/wilayas';
import type { RawCandidate } from '@/core/types';
import { SourceNotReadyError, type DiscoverySource } from '@/adapters/sources/types';

/**
 * Google Places API (New) — Text Search.
 * VERIFIED endpoint (2026-01-01, docs/SOURCES.md):
 *   POST https://places.googleapis.com/v1/places:searchText
 *   headers: X-Goog-Api-Key, X-Goog-FieldMask (required — controls billing SKU)
 *   body: { textQuery, languageCode?, maxResultCount?, includedType?, locationBias? }
 *   response: { places: [{ id, displayName.text, formattedAddress, nationalPhoneNumber, websiteUri }], nextPageToken }
 * Field masks are deliberately narrow to stay in the Pro SKU.
 */
const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'nextPageToken',
].join(',');

export interface PlacesSearchOptions {
  textQuery: string;
  languageCode: 'ar' | 'fr';
  maxResultCount: number;
}

interface PlacesResponse {
  places?: {
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    internationalPhoneNumber?: string;
    websiteUri?: string;
  }[];
  nextPageToken?: string;
}

export function googlePlacesSource(): DiscoverySource {
  const id = 'google_places';
  return {
    id,
    label: 'Google Places API (New) Text Search',
    capabilities: {
      network: true,
      paidApi: true,
      requiresCredentials: true,
      robotsRespect: false,
      costUnitsPerCall: 1,
      note: 'Official API only. Narrow field mask (Pro SKU). Budget-capped per day.',
    },
    ensureReady(ctx) {
      if (!ctx.config.providers.googlePlacesApiKey) {
        throw new SourceNotReadyError(id, 'GOOGLE_PLACES_API_KEY missing (fail closed)');
      }
      if (ctx.config.budgets.google_places.dailyUnits <= 0) {
        throw new SourceNotReadyError(id, 'LEADHUNTER_PROVIDER_BUDGET_GOOGLE_PLACES is 0 — set a daily cap first');
      }
    },
    async *discover(ctx) {
      const key = ctx.config.providers.googlePlacesApiKey as string;
      const perWilayaCap = Number.parseInt(ctx.params['per_wilaya'] ?? '1', 10) || 1;
      const verticals = (ctx.params['verticals'] ?? 'boutique vetements,parfumerie')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const wilayaCodes = (ctx.params['wilayas'] ?? '16,31,25')
        .split(',')
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value));
      const languageCode = (ctx.params['language'] as 'ar' | 'fr') ?? 'fr';

      for (const code of wilayaCodes) {
        const wilaya = WILAYAS.find((entry) => entry.code === code);
        if (!wilaya) continue;
        for (const vertical of verticals.slice(0, perWilayaCap)) {
          if (!ctx.budget.consume(1)) {
            ctx.logger.warn({}, 'google_places daily budget exhausted');
            return;
          }
          if (ctx.dryRun) {
            const preview: RawCandidate = {
              sourceId: id,
              provenance: { origin: 'google_places', dryRun: true, wilaya: wilaya.fr, vertical },
              costUnits: 0,
            };
            yield preview;
            continue;
          }
          const body: Record<string, unknown> = {
            textQuery: `${vertical} ${wilaya.fr} Algérie`,
            languageCode,
            maxResultCount: 10,
          };
          const response = await ctx.http.fetch({
            url: ENDPOINT,
            method: 'POST',
            headers: { 'x-goog-api-key': key, 'x-goog-fieldmask': FIELD_MASK, 'content-type': 'application/json' },
            body: JSON.stringify(body),
            purpose: 'google_places',
          });
          let parsed: PlacesResponse;
          try {
            parsed = JSON.parse(response.body) as PlacesResponse;
          } catch (error) {
            ctx.logger.error({ error: (error as Error).message }, 'google_places returned non-JSON');
            continue;
          }
          if (response.meta.status !== 200) {
            ctx.logger.error(
              { status: response.meta.status, body: response.body.slice(0, 300) },
              'google_places error',
            );
            continue;
          }
          ctx.logger.info({ wilaya: wilaya.fr, vertical, found: parsed.places?.length ?? 0 }, 'google_places call');
          for (const place of parsed.places ?? []) {
            const candidate: RawCandidate = {
              sourceId: id,
              ...(place.websiteUri ? { url: place.websiteUri } : {}),
              name: place.displayName?.text ?? '',
              ...(place.internationalPhoneNumber ? { phones: [place.internationalPhoneNumber] } : {}),
              provenance: {
                origin: 'google_places',
                placeId: place.id ?? null,
                address: place.formattedAddress ?? null,
                wilaya: wilaya.fr,
                vertical,
              },
              costUnits: 1,
            };
            yield candidate;
          }
        }
      }
    },
  };
}
