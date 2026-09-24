import type { CatalogStats } from '@/core/types';
import { median, sum } from '@/core/util';

export type { CatalogStats };

/**
 * Catalog parsers. Everything here is pure: the adapters are responsible for
 * fetching `/products.json`, the WooCommerce store API or `sitemap.xml`.
 */
export function emptyCatalog(source: CatalogStats['source'] = 'none'): CatalogStats {
  return { productCount: null, medianPrice: null, currency: null, latestProductUpdate: null, source };
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.replace(/[^0-9.]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toIsoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

interface ProductsShape {
  [key: string]: unknown;
}

/**
 * Shopify `/products.json` — verified shape: { products: [{ id, title, handle,
 * body_html, published_at, created_at, updated_at, variants: [{ price }], ... }] }
 */
export function parseShopifyProductsJson(json: unknown, cap = 250): CatalogStats {
  const products = (json as ProductsShape | null)?.['products'];
  if (!Array.isArray(products)) return emptyCatalog('products_json');
  const prices: number[] = [];
  const updates: string[] = [];
  for (const raw of products.slice(0, cap)) {
    const product = raw as ProductsShape;
    const variants = product['variants'];
    if (Array.isArray(variants)) {
      for (const variant of variants) {
        const price = toNumber((variant as ProductsShape)['price']);
        if (price !== null && price > 0) prices.push(price);
      }
    }
    const updated = toIsoDate(product['updated_at'] ?? product['published_at']);
    if (updated) updates.push(updated);
  }
  updates.sort();
  return {
    productCount: products.length,
    medianPrice: prices.length > 0 ? median(prices) : null,
    currency: prices.length > 0 ? 'DZD?' : null,
    latestProductUpdate: updates.length > 0 ? (updates[updates.length - 1] ?? null) : null,
    source: 'products_json',
  };
}

/** WooCommerce Store API `/wp-json/wc/store/v1/products` — array of products with `prices`. */
export function parseWooStoreApi(json: unknown, cap = 250): CatalogStats {
  if (!Array.isArray(json)) return emptyCatalog('woo_store_api');
  const prices: number[] = [];
  let currency: string | null = null;
  const updates: string[] = [];
  for (const raw of json.slice(0, cap)) {
    const product = raw as ProductsShape;
    const priceValue = toNumber(
      (product['prices'] as ProductsShape | undefined)?.['price'] ?? product['price'],
    );
    if (priceValue !== null && priceValue > 0) prices.push(priceValue);
    const symbol = (product['prices'] as ProductsShape | undefined)?.['currency_code'];
    if (typeof symbol === 'string') currency = symbol;
    const updated = toIsoDate(product['date_created'] ?? product['date_modified']);
    if (updated) updates.push(updated);
  }
  updates.sort();
  return {
    productCount: json.length,
    medianPrice: prices.length > 0 ? median(prices) : null,
    currency,
    latestProductUpdate: updates.length > 0 ? (updates[updates.length - 1] ?? null) : null,
    source: 'woo_store_api',
  };
}

/** Counts product-like URLs inside a sitemap (or sitemap index). */
export function countSitemapProductUrls(xml: string): { count: number; latest: string | null } {
  const locs = xml.match(/<loc>([^<]+)<\/loc>/gi) ?? [];
  let count = 0;
  let latest: string | null = null;
  for (const loc of locs) {
    const url = loc.replace(/<\/?loc>/gi, '').trim();
    if (/\/products?\/|\/produit\/|\/boutique\//i.test(url) && !/\/products?\.json/i.test(url)) count += 1;
  }
  const lastmods = xml.match(/<lastmod>([^<]+)<\/lastmod>/gi) ?? [];
  for (const raw of lastmods) {
    const iso = toIsoDate(raw.replace(/<\/?lastmod>/gi, '').trim());
    if (iso && (latest === null || iso > latest)) latest = iso;
  }
  return { count, latest };
}

/** Falls back to visible prices when no catalog endpoint is reachable. */
export function extractPricesFromHtml(html: string, cap = 400): { prices: number[]; currency: string | null } {
  const priceRegex = /(\d[\d\s.,]{1,12})\s*(dzd|da\b|دج|د\.ج|dinars?)/gi;
  const prices: number[] = [];
  let currency: string | null = null;
  let match = priceRegex.exec(html);
  while (match !== null && prices.length < cap) {
    const raw = (match[1] ?? '').replace(/[\s.]/g, '').replace(',', '.');
    const value = toNumber(raw);
    const unit = (match[2] ?? '').toLowerCase();
    if (value !== null && value >= 100 && value <= 500_000) {
      prices.push(value);
      if (unit.includes('دج') || unit === 'dzd') currency = 'DZD';
      else if (currency === null) currency = 'DZD';
    }
    match = priceRegex.exec(html);
  }
  return { prices, currency };
}

export function catalogFromHtml(html: string, cap = 400): CatalogStats {
  const { prices, currency } = extractPricesFromHtml(html, cap);
  if (prices.length === 0) return emptyCatalog('html');
  return {
    productCount: null,
    medianPrice: median(prices),
    currency,
    latestProductUpdate: null,
    source: 'html',
  };
}

export function mergeCatalog(primary: CatalogStats, fallback: CatalogStats): CatalogStats {
  return {
    productCount: primary.productCount ?? fallback.productCount,
    medianPrice: primary.medianPrice ?? fallback.medianPrice,
    currency: primary.currency ?? fallback.currency,
    latestProductUpdate: primary.latestProductUpdate ?? fallback.latestProductUpdate,
    source: primary.source !== 'none' ? primary.source : fallback.source,
  };
}

export function catalogPriceSum(stats: CatalogStats): number {
  return stats.medianPrice === null ? 0 : sum([stats.medianPrice]);
}

/** Freshness in days; `null` when unknown. */
export function catalogFreshnessDays(stats: CatalogStats, now: Date): number | null {
  if (!stats.latestProductUpdate) return null;
  const updated = new Date(stats.latestProductUpdate);
  if (Number.isNaN(updated.getTime())) return null;
  return Math.max(0, (now.getTime() - updated.getTime()) / 86_400_000);
}
