import type { PlatformId } from '@/core/types';

/**
 * Data-driven, versioned platform fingerprint registry.
 * Every rule carries a likelihood ratio (log-space) and a cluster id: evidence
 * inside the same cluster is capped during fusion so correlated markers cannot
 * fake independence. Rules were derived from real fetched pages — see
 * docs/SOURCES.md and tests/fixtures/raw/*.
 */
export const FINGERPRINT_REGISTRY_VERSION = '2026-01-fp-1';

export type FingerprintLocation = 'html' | 'header' | 'url';

export interface FingerprintRule {
  id: string;
  platform: PlatformId;
  where: FingerprintLocation;
  /** Case-insensitive regex source. For `header`, matched against the header value. */
  pattern: string;
  /** For `where: 'header'` — the header name to inspect. */
  headerName?: string;
  /** log(p(evidence|platform) / p(evidence|not platform)) */
  logLr: number;
  cluster: string;
  note: string;
}

export const FINGERPRINT_RULES: readonly FingerprintRule[] = [
  // ---------- Shopify ----------
  { id: 'shopify.theme-js', platform: 'shopify', where: 'html', pattern: 'Shopify\\.theme', logLr: 4.2, cluster: 'shopify-inline', note: 'window.Shopify.theme inline payload' },
  { id: 'shopify.cdn', platform: 'shopify', where: 'html', pattern: 'cdn\\.shopify\\.com', logLr: 3.2, cluster: 'shopify-assets', note: 'Shopify CDN assets' },
  { id: 'shopify.cdn-shop-path', platform: 'shopify', where: 'html', pattern: '/cdn/shop/(?:files|products)', logLr: 2.0, cluster: 'shopify-assets', note: 'Shopify asset path' },
  { id: 'shopify.myshopify-host', platform: 'shopify', where: 'html', pattern: 'myshopify\\.com', logLr: 3.0, cluster: 'shopify-inline', note: '*.myshopify.com canonical host in markup' },
  { id: 'shopify.features', platform: 'shopify', where: 'html', pattern: 'shopify-features', logLr: 2.6, cluster: 'shopify-inline', note: 'Shopify feature flags script' },
  { id: 'shopify.checkout-route', platform: 'shopify', where: 'html', pattern: '/checkouts?/|shopify-section', logLr: 1.9, cluster: 'shopify-inline', note: 'Shopify checkout route / section wrapper' },
  { id: 'shopify.header-shopid', platform: 'shopify', where: 'header', headerName: 'x-shopid', pattern: '.+', logLr: 4.6, cluster: 'shopify-header', note: 'x-shopid response header' },
  { id: 'shopify.header-hat', platform: 'shopify', where: 'header', headerName: 'x-sorting-hat-shopid', pattern: '.+', logLr: 4.6, cluster: 'shopify-header', note: 'x-sorting-hat-shopid response header' },
  { id: 'shopify.products-json', platform: 'shopify', where: 'url', pattern: '/products\\.json', logLr: 3.4, cluster: 'shopify-api', note: 'Shopify products.json endpoint' },

  // ---------- WooCommerce ----------
  { id: 'woo.generator', platform: 'woocommerce', where: 'html', pattern: 'WooCommerce\\s+[0-9]', logLr: 4.6, cluster: 'woo-generator', note: 'meta generator "WooCommerce x.y"' },
  { id: 'woo.plugin-path', platform: 'woocommerce', where: 'html', pattern: 'wp-content/plugins/woocommerce', logLr: 4.2, cluster: 'woo-assets', note: 'WooCommerce plugin asset path' },
  { id: 'woo.body-class', platform: 'woocommerce', where: 'html', pattern: 'class="[^"]*\\bwoocommerce\\b', logLr: 3.0, cluster: 'woo-assets', note: 'woocommerce body class' },
  { id: 'woo.ajax', platform: 'woocommerce', where: 'html', pattern: 'wc-ajax|wc_add_to_cart', logLr: 2.6, cluster: 'woo-assets', note: 'WooCommerce AJAX endpoint' },
  { id: 'woo.cart-fragment', platform: 'woocommerce', where: 'html', pattern: 'woocommerce-cart-fragments|woocommerce\\-mini\\-cart', logLr: 2.4, cluster: 'woo-assets', note: 'cart fragment script' },
  { id: 'woo.add-to-cart', platform: 'woocommerce', where: 'html', pattern: '\\?add-to-cart=', logLr: 1.8, cluster: 'woo-assets', note: 'add-to-cart query form' },

  // ---------- WordPress (non-Woo) ----------
  { id: 'wp.generator', platform: 'wordpress', where: 'html', pattern: 'name="generator" content="WordPress', logLr: 4.4, cluster: 'wp-generator', note: 'meta generator "WordPress"' },
  { id: 'wp.assets', platform: 'wordpress', where: 'html', pattern: 'wp-content/(?:themes|plugins)', logLr: 2.4, cluster: 'wp-assets', note: 'wp-content asset path' },
  { id: 'wp.api', platform: 'wordpress', where: 'html', pattern: 'wp-json', logLr: 2.0, cluster: 'wp-assets', note: 'WordPress REST route' },

  // ---------- YouCan ----------
  { id: 'youcan.domain', platform: 'youcan', where: 'html', pattern: 'youcan\\.shop|youcan\\.store', logLr: 3.6, cluster: 'youcan-domain', note: 'YouCan storefront domain' },
  { id: 'youcan.asset', platform: 'youcan', where: 'html', pattern: 'cdn\\.youcan\\.store|youcan-?cdn|youcanapp', logLr: 3.4, cluster: 'youcan-assets', note: 'YouCan CDN asset' },
  { id: 'youcan.brand', platform: 'youcan', where: 'html', pattern: '\\bYouCan\\b|youcan\\.shop', logLr: 1.4, cluster: 'youcan-brand', note: 'YouCan brand string on page' },

  // ---------- LightFunnels ----------
  { id: 'lightfunnels.asset', platform: 'lightfunnels', where: 'html', pattern: 'cdn\\.lightfunnels\\.com|lightfunnels\\.com/(?:assets|static)', logLr: 3.4, cluster: 'lf-assets', note: 'LightFunnels CDN asset' },
  { id: 'lightfunnels.brand', platform: 'lightfunnels', where: 'html', pattern: 'lightfunnels', logLr: 1.6, cluster: 'lf-brand', note: 'LightFunnels reference' },

  // ---------- Wix ----------
  { id: 'wix.cdn', platform: 'wix', where: 'html', pattern: 'wixstatic\\.com', logLr: 3.6, cluster: 'wix-assets', note: 'Wix static CDN' },
  { id: 'wix.parastorage', platform: 'wix', where: 'html', pattern: 'static\\.parastorage\\.com', logLr: 3.0, cluster: 'wix-assets', note: 'Wix parastorage asset host' },
  { id: 'wix.runtime', platform: 'wix', where: 'html', pattern: '_wixCIDX|wix-code|viewerModel', logLr: 2.6, cluster: 'wix-inline', note: 'Wix runtime markers' },
  { id: 'wix.header', platform: 'wix', where: 'header', headerName: 'x-wix-request-id', pattern: '.+', logLr: 3.8, cluster: 'wix-header', note: 'Wix response header' },

  // ---------- Squarespace ----------
  { id: 'sqs.cdn', platform: 'squarespace', where: 'html', pattern: 'static1\\.squarespace\\.com|images\\.squarespace-cdn\\.com', logLr: 3.8, cluster: 'sqs-assets', note: 'Squarespace CDN asset' },
  { id: 'sqs.block', platform: 'squarespace', where: 'html', pattern: 'sqs-block|squarespace-cdn|sqsp-', logLr: 3.0, cluster: 'sqs-assets', note: 'Squarespace block wrapper' },
  { id: 'sqs.brand', platform: 'squarespace', where: 'html', pattern: 'squarespace', logLr: 1.4, cluster: 'sqs-brand', note: 'Squarespace reference' },
  { id: 'sqs.header', platform: 'squarespace', where: 'header', headerName: 'x-squarespace-dynamic', pattern: '.+', logLr: 3.6, cluster: 'sqs-header', note: 'Squarespace response header' },

  // ---------- Webflow ----------
  { id: 'wf.assets', platform: 'webflow', where: 'html', pattern: 'assets(?:-cdn|\\.global)?\\.website-files\\.com|assets\\.webflow\\.com', logLr: 3.6, cluster: 'wf-assets', note: 'Webflow asset host' },
  { id: 'wf.data-attrs', platform: 'webflow', where: 'html', pattern: 'data-wf-page|data-wf-site|data-wf-domain', logLr: 3.0, cluster: 'wf-inline', note: 'Webflow data attributes' },
  { id: 'wf.brand', platform: 'webflow', where: 'html', pattern: 'webflow', logLr: 1.2, cluster: 'wf-brand', note: 'Webflow reference' },

  // ---------- PrestaShop ----------
  { id: 'ps.brand', platform: 'prestashop', where: 'html', pattern: 'prestashop', logLr: 2.8, cluster: 'ps-brand', note: 'PrestaShop reference' },
  { id: 'ps.theme', platform: 'prestashop', where: 'html', pattern: '/themes/(?:classic|default-bootstrap)', logLr: 2.2, cluster: 'ps-assets', note: 'PrestaShop default theme path' },
  { id: 'ps.params', platform: 'prestashop', where: 'html', pattern: 'id_product=|controller=product|prestashop-', logLr: 2.4, cluster: 'ps-inline', note: 'PrestaShop URL/JS parameter' },
  { id: 'ps.header', platform: 'prestashop', where: 'header', headerName: 'x-powered-by', pattern: 'PrestaShop', logLr: 3.4, cluster: 'ps-header', note: 'x-powered-by: PrestaShop' },

  // ---------- Magento ----------
  { id: 'mage.static-version', platform: 'magento', where: 'html', pattern: 'static/version\\d+|Magento_[A-Z]', logLr: 3.2, cluster: 'mage-assets', note: 'Magento static version path / module namespace' },
  { id: 'mage.cookies', platform: 'magento', where: 'html', pattern: 'mage/cookies|mage-init|requirejs', logLr: 2.2, cluster: 'mage-inline', note: 'Magento JS runtime' },
  { id: 'mage.header', platform: 'magento', where: 'header', headerName: 'x-magento-tags', pattern: '.+', logLr: 3.8, cluster: 'mage-header', note: 'Magento response header' },

  // ---------- Salla / Zid ----------
  { id: 'salla.domain', platform: 'salla', where: 'html', pattern: 'salla\\.sa|cdn\\.salla\\.sa|salla-', logLr: 3.4, cluster: 'salla-assets', note: 'Salla storefront asset' },
  { id: 'zid.domain', platform: 'zid', where: 'html', pattern: 'zid\\.store|cdn\\.zid\\.store|zid-', logLr: 3.4, cluster: 'zid-assets', note: 'Zid storefront asset' },

  // ---------- Generic e-commerce (drives `custom`) ----------
  { id: 'generic.cart', platform: 'custom', where: 'html', pattern: 'add to cart|ajouter au panier|اشتري الان|أضف إلى السلة|acheter maintenant', logLr: 2.4, cluster: 'generic-store', note: 'cart CTA in ar/fr/en' },
  { id: 'generic.checkout', platform: 'custom', where: 'html', pattern: '/checkout|commander|طلب الآن|finaliser la commande', logLr: 2.0, cluster: 'generic-store', note: 'checkout route or CTA' },
  { id: 'generic.cod-form', platform: 'custom', where: 'html', pattern: 'paiement a la livraison|الدفع عند الاستلام|nom complet|full name', logLr: 2.2, cluster: 'generic-cod', note: 'COD order form fields' },
];

/** Platform priors (share of DZ storefronts by stack estimate, see docs/MATH.md). */
export const PLATFORM_PRIORS: Record<PlatformId, number> = {
  shopify: 0.28,
  youcan: 0.09,
  woocommerce: 0.13,
  wordpress: 0.04,
  prestashop: 0.03,
  lightfunnels: 0.06,
  wix: 0.05,
  squarespace: 0.02,
  webflow: 0.02,
  magento: 0.01,
  salla: 0.01,
  zid: 0.01,
  custom: 0.17,
  none: 0.08,
};

/**
 * Parent/child relations: WooCommerce runs on WordPress, so WordPress evidence
 * must not be double-counted as an independent alternative hypothesis.
 */
export const PLATFORM_PARENT_PENALTIES: readonly {
  child: PlatformId;
  parent: PlatformId;
  logPenalty: number;
}[] = [{ child: 'woocommerce', parent: 'wordpress', logPenalty: -2.3 }];

/** Minimum markup evidence required before `custom` can be believed. */
export const CUSTOM_MIN_LOG_LR = 2.0;

export interface PlatformEvidence {
  ruleId: string;
  platform: PlatformId;
  logLr: number;
  clusterId: string;
  location: FingerprintLocation;
  matched: string;
  note: string;
}

export interface FingerprintInput {
  url: string;
  html: string;
  headers: Record<string, string>;
}

const ruleCache = new Map<string, RegExp>();

function ruleRegex(rule: FingerprintRule): RegExp {
  const cached = ruleCache.get(rule.id);
  if (cached) return cached;
  const compiled = new RegExp(rule.pattern, 'i');
  ruleCache.set(rule.id, compiled);
  return compiled;
}

export function extractPlatformEvidence(input: FingerprintInput): PlatformEvidence[] {
  const out: PlatformEvidence[] = [];
  const url = input.url;
  for (const rule of FINGERPRINT_RULES) {
    const regex = ruleRegex(rule);
    let haystack: string | null = null;
    if (rule.where === 'html') haystack = input.html;
    else if (rule.where === 'url') haystack = url;
    else if (rule.where === 'header') {
      if (!rule.headerName) continue;
      haystack = input.headers[rule.headerName.toLowerCase()] ?? null;
    }
    if (haystack === null || haystack === undefined) continue;
    const match = haystack.match(regex);
    if (!match) continue;
    const matched = (match[0] ?? '').slice(0, 120);
    out.push({
      ruleId: rule.id,
      platform: rule.platform,
      logLr: rule.logLr,
      clusterId: rule.cluster,
      location: rule.where,
      matched,
      note: rule.note,
    });
  }
  return out;
}
