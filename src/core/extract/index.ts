import * as cheerio from 'cheerio';
import { classifyCategories } from '@/core/classify/categories';
import { maturityIndex } from '@/core/classify/maturity';
import { detectAdTech } from '@/core/extract/adtech';
import {
  catalogFreshnessDays,
  catalogFromHtml,
  mergeCatalog,
} from '@/core/extract/catalog';
import { extractContacts } from '@/core/extract/contacts';
import {
  CUSTOM_MIN_LOG_LR,
  FINGERPRINT_REGISTRY_VERSION,
  PLATFORM_PARENT_PENALTIES,
  PLATFORM_PRIORS,
  extractPlatformEvidence,
  type PlatformEvidence,
} from '@/core/extract/fingerprints';
import { assessMarket } from '@/core/extract/market';
import { fuseEvidence, logLrToConfidence } from '@/core/math/fusion';
import { detectLanguage } from '@/core/normalize/lang';
import { canonicalizeUrl } from '@/core/normalize/url';
import {
  PLATFORM_IDS,
  type CatalogStats,
  type PlatformId,
  type PlatformPrediction,
  type Signal,
  type SiteFacts,
} from '@/core/types';
import { clamp, uniqueBy } from '@/core/util';

export interface ExtractionInput {
  url: string;
  html: string;
  headers: Record<string, string>;
  now: Date;
  /** Catalog stats already fetched by the adapter (products.json / store API / sitemap). */
  catalog?: CatalogStats;
}

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  shopify: 'Shopify',
  youcan: 'YouCan',
  woocommerce: 'WooCommerce',
  wordpress: 'WordPress',
  prestashop: 'PrestaShop',
  lightfunnels: 'LightFunnels',
  wix: 'Wix',
  squarespace: 'Squarespace',
  webflow: 'Webflow',
  magento: 'Magento',
  salla: 'Salla',
  zid: 'Zid',
  custom: 'منصة خاصة',
  none: 'متجر',
};

export function fusePlatform(evidence: readonly PlatformEvidence[]): PlatformPrediction {
  const result = fuseEvidence(
    evidence.map((item) => ({
      hypothesis: item.platform,
      logLr: item.logLr,
      clusterId: item.clusterId,
    })),
    {
      priors: PLATFORM_PRIORS,
      clusterCapLogLr: 4.5,
      postPenalties: PLATFORM_PARENT_PENALTIES.map((penalty) => ({
        hypothesis: penalty.parent,
        logPenalty: penalty.logPenalty,
      })),
      abstainThreshold: 0.5,
      marginThreshold: 0.08,
    },
  );

  let best = result.best as PlatformId;
  if (best === 'custom' && (result.contributions['custom'] ?? 0) < CUSTOM_MIN_LOG_LR) {
    best = 'none';
  }
  // Abstain instead of reporting the highest *prior*: weak/ambiguous markup must
  // surface as "unknown" (platform `none`), never as a confident guess.
  if (result.abstained && best !== 'custom') best = 'none';
  // `custom` must never win purely by default: require real storefront evidence.
  const probabilities: Record<string, number> = { ...result.probabilities };
  return {
    platform: best,
    probability: clamp(probabilities[best] ?? 0, 0, 1),
    entropy: result.entropyBits,
    margin: result.margin,
    abstained: result.abstained,
    probabilities,
  };
}

export function buildTextCorpus(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();
  const title = $('title').text();
  const metaDescription = $('meta[name="description"]').attr('content') ?? '';
  const ogTitle = $('meta[property="og:title"]').attr('content') ?? '';
  const ogDescription = $('meta[property="og:description"]').attr('content') ?? '';
  const headings = $('h1, h2, h3')
    .slice(0, 25)
    .map((_i, element) => $(element).text().trim())
    .get()
    .join(' · ');
  const productAnchors = $('a[href*="/product"], a[href*="/produit"], a[href*="/boutique"]')
    .slice(0, 60)
    .map((_i, element) => $(element).text().trim())
    .get()
    .join(' · ');
  const body = $('body').text().slice(0, 20_000);
  return [title, metaDescription, ogTitle, ogDescription, headings, productAnchors, body]
    .filter((part) => part.length > 0)
    .join('\n')
    .slice(0, 120_000);
}

/** Pure extraction: (html + headers + url) → facts. No network, no clock reads. */
export function extractSiteFacts(input: ExtractionInput): SiteFacts {
  const canonical = canonicalizeUrl(input.url);
  const html = input.html;
  const headers = Object.fromEntries(
    Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]),
  );

  const platformEvidence = extractPlatformEvidence({ url: canonical.canonical, html, headers });
  const platformPosterior = fusePlatform(platformEvidence);
  const platform = platformPosterior.platform;

  const contacts = extractContacts({ url: canonical.canonical, html });
  const adTech = detectAdTech(html);
  const corpus = buildTextCorpus(html);
  const language = detectLanguage(corpus);

  const htmlCatalog = catalogFromHtml(html);
  const catalog = input.catalog ? mergeCatalog(input.catalog, htmlCatalog) : htmlCatalog;

  const market = assessMarket({
    url: canonical.canonical,
    text: corpus,
    language,
    productCount: catalog.productCount,
    hasCart: /add to cart|ajouter au panier|اشتري الان|أضف إلى السلة/i.test(html),
    hasCheckout: /\/checkout|commander|finaliser la commande|إتمام الطلب/i.test(html),
    hasPrices: catalog.medianPrice !== null,
    dzPhoneCount: contacts.filter((channel) => channel.kind === 'phone' || channel.kind === 'whatsapp').length,
  });

  const categories = classifyCategories({ text: `${corpus}\n${canonical.canonical.replace(/[-/.]/g, ' ')}` });

  const signals: Signal[] = [];

  const platformRules = platformEvidence.filter((item) => item.platform === platform);
  signals.push({
    key: `platform:${platform}`,
    kind: 'platform',
    value: platform,
    confidence: platformPosterior.probability,
    clusterId: platform === 'none' ? 'platform-none' : `platform-${platform}`,
    evidence: platformRules.slice(0, 6).map((item) => ({
      location: `${FINGERPRINT_REGISTRY_VERSION}:${item.location}`,
      detail: `${item.ruleId} → "${item.matched}" (logLR ${item.logLr.toFixed(1)}): ${item.note}`,
    })),
  });

  for (const channel of contacts) {
    signals.push({
      key: `contact:${channel.kind}`,
      kind: 'contact',
      value: channel.value,
      confidence: channel.confidence,
      clusterId: `contact-${channel.kind}`,
      evidence: channel.evidence,
    });
  }

  for (const hit of adTech) {
    signals.push({
      key: `adtech:${hit.id}`,
      kind: 'adtech',
      value: hit.label,
      confidence: hit.serverSide === true ? 0.8 : 0.9,
      clusterId: 'adtech',
      evidence: [hit.evidence],
    });
  }

  if (market.codPhrases.length > 0) {
    signals.push({
      key: 'market:cod',
      kind: 'market',
      value: market.codPhrases.join(' | '),
      confidence: clamp(market.pAlgeria, 0, 1),
      clusterId: 'market-cod',
      evidence: market.codPhrases.map((phrase) => ({ location: 'html:text', detail: `COD phrase "${phrase}"` })),
    });
  }
  if (market.currency === 'DZD') {
    signals.push({
      key: 'market:currency',
      kind: 'market',
      value: 'DZD',
      confidence: clamp(0.6 + market.currencyConfidence / 2, 0, 1),
      clusterId: 'market-currency',
      evidence: [{ location: 'html:text', detail: 'prices in DZD / DA / دج' }],
    });
  }
  if (market.wilayaMatches.length > 0) {
    signals.push({
      key: 'market:wilaya_coverage',
      kind: 'market',
      value: String(market.wilayaMatches.length),
      confidence: clamp(market.wilayaCoverage * 3, 0, 0.95),
      clusterId: 'market-wilaya',
      evidence: [{ location: 'html:text', detail: `wilaya names referenced: ${market.wilayaMatches.join(', ')}` }],
    });
  }
  if (market.isDzTld) {
    signals.push({
      key: 'market:dz_tld',
      kind: 'market',
      value: canonical.host,
      confidence: 0.9,
      clusterId: 'market-tld',
      evidence: [{ location: 'url', detail: '.dz TLD' }],
    });
  }
  signals.push({
    key: 'market:p_algeria',
    kind: 'market',
    value: market.pAlgeria.toFixed(4),
    confidence: clamp(market.pAlgeria, 0, 1),
    clusterId: 'market-algeria',
    evidence: [
      {
        location: 'model:market',
        detail: `log-odds ${market.algeriaLogOdds.toFixed(2)} → P(Algeria)=${market.pAlgeria.toFixed(3)}`,
      },
    ],
  });

  if (catalog.productCount !== null) {
    signals.push({
      key: 'catalog:product_count',
      kind: 'catalog',
      value: String(catalog.productCount),
      confidence: catalog.source === 'html' ? 0.5 : 0.95,
      clusterId: 'catalog-count',
      evidence: [{ location: `catalog:${catalog.source}`, detail: `${catalog.productCount} products enumerated` }],
    });
  }
  if (catalog.medianPrice !== null) {
    signals.push({
      key: 'catalog:median_price',
      kind: 'catalog',
      value: String(Math.round(catalog.medianPrice)),
      confidence: 0.8,
      clusterId: 'catalog-price',
      evidence: [
        {
          location: `catalog:${catalog.source}`,
          detail: `median price ${Math.round(catalog.medianPrice)} ${catalog.currency ?? ''}`.trim(),
        },
      ],
    });
  }

  for (const score of categories.top) {
    signals.push({
      key: `category:${score.category}`,
      kind: 'category',
      value: score.category,
      confidence: clamp(score.probability, 0, 1),
      clusterId: `category-${score.category}`,
      evidence: [
        {
          location: 'model:cat-nb-2026-01',
          detail: `p(${score.category})=${score.probability.toFixed(3)}${categories.abstained ? ' (abstained)' : ''}`,
        },
      ],
    });
  }

  const freshDays = catalogFreshnessDays(catalog, input.now);
  const maturity = maturityIndex({
    productCount: catalog.productCount,
    freshnessDays: freshDays,
    pixelCount: adTech.filter((hit) => hit.serverSide !== true).length,
    hasServerSidePixel: adTech.some((hit) => hit.serverSide === true),
    distinctChannelCount: new Set(contacts.map((channel) => channel.kind)).size,
    platform,
  });

  return {
    url: input.url,
    canonicalUrl: canonical.canonical,
    domain: canonical.host,
    etld1: canonical.etld1,
    platform,
    platformConfidence: platformPosterior.probability,
    platformPosterior,
    contacts,
    adtech: Array.from(new Set(adTech.map((hit) => hit.id))),
    market,
    catalog,
    categories,
    language,
    maturityIndex: maturity,
    signals: uniqueBy(signals, (signal) => `${signal.key}:${signal.value}`),
  };
}

export function platformEvidenceConfidence(evidence: readonly PlatformEvidence[]): number {
  return evidence.reduce((max, item) => Math.max(max, logLrToConfidence(item.logLr)), 0);
}

export const ALL_PLATFORMS = PLATFORM_IDS;
