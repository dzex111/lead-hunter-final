# SOURCES.md — every external claim, verified by fetching official docs

Verification date: **2026-09-24**. Each row records the URL that was actually
fetched, what was verified, and what the code therefore does. Anything that could
NOT be verified is implemented behind a feature flag that **fails closed** with a
clear error (see `src/config/index.ts` → `flags`, `src/adapters/sources/*`).

## 1. Verified APIs and endpoints

| # | Source (fetched) | Verified facts | Used by |
|---|---|---|---|
| 1 | https://developers.google.com/maps/documentation/places/web-service/text-search | Places API (New) **Text Search** is `POST https://places.googleapis.com/v1/places:searchText`; headers `X-Goog-Api-Key` + **required** `X-Goog-FieldMask` (omitting the mask is an error); body fields `textQuery` (required), `languageCode`, `maxResultCount`, `includedType`, `locationBias`, `rankPreference`; response `{ places: [...], nextPageToken }`; field masks determine the billing SKU (Pro / Enterprise / Enterprise+Atmosphere). | `src/adapters/sources/google-places.ts` (narrow Pro mask: `places.id, places.displayName, places.formattedAddress, places.internationalPhoneNumber, places.websiteUri, nextPageToken`) |
| 2 | https://api-dashboard.search.brave.com/api-reference/web/search/get | Brave Web Search is `GET https://api.search.brave.com/res/v1/web/search`, header `X-Subscription-Token` (required), query params `q`, `count`, `offset`, `country`, `search_lang`, `freshness`; response model `WebSearchApiResponse` with `web.results[]`. Both GET and POST are supported. | `braveProvider` in `src/adapters/sources/web-search.ts` (GET, `country=dz`, `search_lang=ar|fr`) |
| 3 | https://developers.google.com/custom-search/v1/using_rest | Custom Search JSON API is `GET https://www.googleapis.com/customsearch/v1` with `key`, `cx`, `q` (all required); response contains `items[]` (url/title/snippet) and `queries`/`nextPage` metadata; the API returns at most the first 100 results. | `googleCseProvider` (GET with `gl=dz`, `num≤10`) |
| 4 | https://developers.facebook.com/docs/graph-api/reference/ads_archive/ | `ads_archive` requires `ad_reached_countries`; **`DZ` is a valid value** of that enum. | `src/adapters/sources/meta-ad-library.ts` (sends `ad_reached_countries=["DZ"]`) |
| 5 | https://developers.facebook.com/docs/marketing-api/reference/archived-ad/ | Archived-ad fields: `id`, `page_id`, `page_name`, `ad_creation_time`, `ad_delivery_start_time`, `ad_delivery_stop_time`, `ad_snapshot_url`, `ad_creative_bodies`, `publisher_platforms` are general. `spend`, `impressions`, `currency`, `demographic_distribution`, `estimated_audience_size`, `delivery_by_region` are **POLITICAL_AND_ISSUE_ADS only**; `age_country_gender_reach_breakdown`, `target_ages`, `target_gender`, `target_locations`, `beneficiary_payers`, `eu_total_reach` are **EU/UK (DSA) only**. | Field list of the adapter (only general fields are requested); `is_advertiser` evidence, never spend/impressions |
| 6 | https://www.allbirds.com/products.json?limit=5 (real response fetched) | Shopify `/products.json` shape: `{ products: [{ id, title, handle, body_html, published_at, created_at, updated_at, vendor, product_type, tags[], variants: [{ price, ... }] }] }` — prices are strings without currency. | `parseShopifyProductsJson` + `tests/fixtures/raw/allbirds-products.json` |
| 7 | Real HTML fixtures fetched 2026-09-24: `https://www.allbirds.com/`, `https://youcan.shop/`, `https://www.lightfunnels.com/`, `https://themes.woocommerce.com/storefront/`, `https://wordpress.org/plugins/woocommerce/`, `https://www.squarespace.com/` | Fingerprint markers observed in **real** pages (counts): Allbirds → `cdn.shopify.com` ×8, `myshopify.com` ×9, `Shopify.theme` ×3; YouCan → `youcan` ×130; LightFunnels → `lightfunnels` ×168 (no CDN fingerprint); WooCommerce storefront → `woocommerce` ×92, `wp-content` ×37, `generator = WordPress 7.1.2` + `generator = WooCommerce 11.3.0-dev.20260924`; Squarespace → `squarespace` ×194, `static1.squarespace` ×11. | `FINGERPRINT_RULES` (log-LRs derived from these markers), `tests/extract.test.ts` fixture tests |

## 2. Explicitly UNVERIFIED → feature-flagged OFF (fails closed)

| Source | What we tried | Status and behaviour |
|---|---|---|
| Serper (`https://google.serper.dev/search`) | Could not fetch any official API reference (`https://serper.dev/api-reference` and `https://docs.serper.dev/introduction` both failed to load). | `serperProvider.ready()` returns *not ready* unless `LEADHUNTER_ENABLE_SERPER=true` **and** `SERPER_API_KEY` is set **and** the daily budget > 0, with the message: *"its official API documentation could not be fetched during Phase 0 verification"*. Default: OFF. |
| Meta Ad Library for **commercial** ads in Algeria | The docs disclose the ad fields and `ad_reached_countries` (DZ present), but nothing in the fetched pages states that commercial (non-political/issue) ads **for Algeria** are returnable — the Ad Library API is documented to expose political/issue ads globally and all ads only for EU/UK DSA scopes. | `flags.metaAdLibraryApi` defaults to **false**; `metaAdLibrarySource.ensureReady()` throws a `SourceNotReadyError` explaining exactly this. The compliant alternative `ad_library_manual` (operator pastes public Ad Library data) is enabled and records `is_advertiser` evidence with first_seen/last_seen. |
| robots.txt semantics | Implemented with the `robots-parser` library. The IETF standard (RFC 9309) was **not** fetched in Phase 0, so it is *not* cited as verified. | `src/adapters/http/robots.ts`: robots.txt is fetched with the honest User-Agent and cached 6 h; an unreachable robots.txt **fails closed** (no crawl). |
| Shopify/WooCommerce public store APIs beyond the shapes above | Only `/products.json` (verified, row 6) and the WooCommerce Store API path `/wp-json/wc/store/v1/products` (shape asserted in tests, not verified against vendor docs). | Both are used opportunistically: failures are logged and the extractor falls back to sitemap counts and HTML price parsing. |

## 3. Known gaps / limitations (documented, not hidden)

* **LightFunnels merchants**: the LightFunnels *marketing* page carries no CDN
  fingerprint, so the extractor correctly **abstains** (`platform = none`,
  posterior < 0.5) on that fixture. No real LightFunnels merchant page could be
  obtained during Phase 0, so the `lightfunnels.*` rules are the weakest in the
  registry — they fire on `cdn.lightfunnels.com` / `lightfunnels.com` asset paths
  only. Verified by `tests/extract.test.ts` ("abstains when real HTML carries no
  decisive fingerprint").
* **Meta/Instagram/Messenger**: the engine never scrapes logged-in UIs and never
  automates sending. Profile data arrives via operator paste (`social_paste`,
  `ad_library_manual`) or from the merchant's own website.
* **Algerian Law 18-07** (protection of natural persons in the processing of
  personal data): referenced by name; the legal text was not fetched/verified in
  Phase 0. The engine's obligations are implemented as code behaviour:
  business-public contact data only, global suppression hard stop, `export`
  (access) and `purge --lead` (erasure, keeping the suppression record),
  retention purge via `LEADHUNTER_RETENTION_DAYS`, full `audit_log`, and no
  purpose-foreign processing (no political/sensitive data is ever collected).
  The operator must confirm the exact retention/declaration wording with counsel.

## 4. Non-negotiable rules → where they are enforced

| Rule | Enforcement |
|---|---|
| Never send automatically | There is no send code path at all: `buildOutreachLink()` returns `wa.me`/`m.me` links + copy-text only; `outreach_attempts.status` is `drafted` until a human records `outcome <lead> contacted`. |
| Honest User-Agent | `LEADHUNTER_USER_AGENT` is sent on every request; no browser impersonation, no proxy rotation, no fake accounts anywhere in `src/adapters/http`. |
| robots.txt + per-domain rate limits | `RobotsCache` + `DomainLimiter` (token bucket 0.5 req/s, burst 2, concurrency 1, circuit breaker after 5 consecutive failures, 10-min cooldown). |
| Never fetch behind a login | Only unauthenticated public pages are fetched; cookies/credentials are never sent (`client.ts` allowlists request headers). |
| No invented endpoints/fields | Registry table above; unverified sources are flagged off with explicit errors. |
| Privacy | `src/adapters/pipeline/privacy.ts`, suppression table, retention purge, audit log. |
