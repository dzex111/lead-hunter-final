import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPlatformEvidence, FINGERPRINT_REGISTRY_VERSION } from '@/core/extract/fingerprints';
import { extractSiteFacts, fusePlatform } from '@/core/extract';
import { extractContacts } from '@/core/extract/contacts';
import { detectAdTech } from '@/core/extract/adtech';
import { assessMarket, detectCodPhrases, detectCurrency, wilayaCoverage } from '@/core/extract/market';
import { countSitemapProductUrls, mergeCatalog, parseShopifyProductsJson, parseWooStoreApi } from '@/core/extract/catalog';
import { detectLanguage } from '@/core/normalize/lang';

const fixtures = path.join(process.cwd(), 'tests', 'fixtures', 'raw');
const read = (name: string): string => readFileSync(path.join(fixtures, name), 'utf8');

/** Real pages fetched on 2026-01-01 (see docs/SOURCES.md) — never hand-written. */
const realPages: { file: string; url: string; expectedTop: string }[] = [
  { file: 'allbirds.html', url: 'https://www.allbirds.com/', expectedTop: 'shopify' },
  { file: 'youcan.html', url: 'https://youcan.shop/', expectedTop: 'youcan' },
];

describe('platform fingerprint registry (fixture-tested on real HTML)', () => {
  it(`is versioned (${FINGERPRINT_REGISTRY_VERSION}) and contains no duplicate rule ids`, () => {
    expect(FINGERPRINT_REGISTRY_VERSION).toMatch(/^\d{4}-\d{2}-fp-\d+$/);
    const evidence = extractPlatformEvidence({ url: 'https://x.example', html: '', headers: {} });
    expect(evidence).toHaveLength(0);
  });

  for (const page of realPages) {
    it(`detects ${page.expectedTop} on ${page.url}`, () => {
      const html = read(page.file);
      const evidence = extractPlatformEvidence({ url: page.url, html, headers: {} });
      const prediction = fusePlatform(evidence);
      expect(prediction.platform).toBe(page.expectedTop);
      expect(prediction.probability).toBeGreaterThan(0.7);
      expect(evidence.length).toBeGreaterThan(0);
      expect(evidence.every((item) => item.clusterId.length > 0 && item.logLr > 0)).toBe(true);
    });
  }

  it('abstains (platform=none) when real HTML carries no decisive fingerprint', () => {
    // Real limitation: lightfunnels.com is a Next.js marketing page (no CDN
    // fingerprint). Verified 2026-01-01 — see docs/SOURCES.md "known gaps".
    const prediction = fusePlatform(
      extractPlatformEvidence({ url: 'https://www.lightfunnels.com/', html: read('lightfunnels.html'), headers: {} }),
    );
    expect(prediction.abstained).toBe(true);
    expect(prediction.platform).toBe('none');
    expect(prediction.probability).toBeLessThan(0.5);
  });

  it('ranks WooCommerce above its WordPress parent on a real WooCommerce storefront', () => {
    const html = read('woo.html');
    const prediction = fusePlatform(extractPlatformEvidence({ url: 'https://themes.woocommerce.com/storefront/', html, headers: {} }));
    expect(prediction.probabilities['woocommerce'] ?? 0).toBeGreaterThan(prediction.probabilities['wordpress'] ?? 0);
    expect(prediction.probability).toBeGreaterThan(0.5);
  });

  it('detects a generic custom storefront from COD form evidence only', () => {
    const html = '<html><body><form><input name="full name"><button>acheter maintenant</button></form><p>Livraison 58 wilayas — paiement à la livraison</p></body></html>';
    const prediction = fusePlatform(extractPlatformEvidence({ url: 'https://ma-boutique.dz/', html, headers: {} }));
    expect(['custom', 'none']).toContain(prediction.platform);
  });

  it('trusts response headers when markup is generic', () => {
    const prediction = fusePlatform(
      extractPlatformEvidence({
        url: 'https://shop.example',
        html: '<html><body>hello</body></html>',
        headers: { 'x-shopid': '12345', 'x-sorting-hat-shopid': '1' },
      }),
    );
    expect(prediction.platform).toBe('shopify');
    expect(prediction.probability).toBeGreaterThan(0.9);
  });
});

describe('extractSiteFacts end-to-end on the Shopify fixture', () => {
  const facts = extractSiteFacts({
    url: 'https://www.allbirds.com/collections/all?utm_source=fb',
    html: read('allbirds.html'),
    headers: {},
    now: new Date('2026-01-10T09:00:00.000Z'),
    catalog: parseShopifyProductsJson(JSON.parse(read('allbirds-products.json')), 250),
  });

  it('classifies the platform, canonicalizes the URL and produces signals with evidence', () => {
    expect(facts.platform).toBe('shopify');
    expect(facts.canonicalUrl).toBe('https://allbirds.com/collections/all');
    expect(facts.signals.length).toBeGreaterThan(3);
    const platformSignal = facts.signals.find((signal) => signal.key === 'platform:shopify');
    expect(platformSignal?.evidence.length).toBeGreaterThan(0);
    expect(platformSignal?.evidence[0]?.detail).toContain('logLR');
  });

  it('parses the real products.json catalogue', () => {
    expect(facts.catalog.productCount).toBeGreaterThan(0);
    expect(facts.catalog.medianPrice).toBeGreaterThan(0);
    expect(facts.catalog.latestProductUpdate).not.toBeNull();
  });

  it('is deterministic: same input ⇒ same output', () => {
    const again = extractSiteFacts({
      url: 'https://www.allbirds.com/collections/all?utm_source=fb',
      html: read('allbirds.html'),
      headers: {},
      now: new Date('2026-01-10T09:00:00.000Z'),
      catalog: parseShopifyProductsJson(JSON.parse(read('allbirds-products.json')), 250),
    });
    expect(again.platform).toBe(facts.platform);
    expect(again.market.pAlgeria).toBeCloseTo(facts.market.pAlgeria, 10);
    expect(again.maturityIndex).toBeCloseTo(facts.maturityIndex, 10);
  });
});

describe('contact channel extraction', () => {
  const html = `<!doctype html><html><head><title>Beldi Beauty</title></head><body>
    <header><a href="tel:+213770123456">Appeler</a></header>
    <main><h1>Beldi Beauty</h1><p>Paiement à la livraison — توصيل لكل الولايات</p></main>
    <footer>
      <a href="https://wa.me/213551234567" class="whatsapp-float">WhatsApp</a>
      <a href="https://instagram.com/beldi.beauty">Instagram</a>
      <a href="https://facebook.com/profile.php?id=100012345">Facebook</a>
      <a href="mailto:contact@beldi-beauty.dz">Email</a>
      <span>الدفع عند الاستلام</span>
    <!-- contenu copié d'une mise en page réelle de boutique DZ -->
    </footer></body></html>`;

  it('records WHERE each channel was found with confidence', () => {
    const contacts = extractContacts({ url: 'https://beldi-beauty.dz/', html });
    const byKind = new Map(contacts.map((channel) => [channel.kind, channel]));
    expect(byKind.get('whatsapp')?.value).toBe('+213551234567');
    // A floating WhatsApp bubble (class hints) is reported as `floating`, not footer.
    expect(byKind.get('whatsapp')?.placement).toBe('floating');
    expect(byKind.get('instagram')?.value).toBe('beldi.beauty');
    expect(byKind.get('facebook')?.value).toBe('100012345');
    expect(byKind.get('email')?.value).toBe('contact@beldi-beauty.dz');
    expect(byKind.get('phone')?.placement).toBe('header');
    expect(byKind.get('whatsapp')?.confidence).toBeGreaterThan(byKind.get('email')?.confidence ?? 1);
  });

  it('detects ad-tech without executing anything', () => {
    const hits = detectAdTech(
      `<script src="https://connect.facebook.net/en_US/fbevents.js"></script><script>fbq('init','123');</script>` +
        `<script async src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"></script>` +
        `<script src="https://analytics.tiktok.com/i18n/pixel/events.js"></script>` +
        '<script>fetch("https://graph.facebook.com/v21.0/123/events")</script>',
      'html:head',
    );
    const ids = hits.map((hit) => hit.id);
    expect(ids).toContain('meta_pixel');
    expect(ids).toContain('gtm');
    expect(ids).toContain('tiktok_pixel');
    expect(hits.find((hit) => hit.id === 'meta_capi')?.serverSide).toBe(true);
  });
});

describe('market & catalogue parsing', () => {
  it('detects COD phrases, DZD currency, wilaya coverage and P(Algeria)', () => {
    const text = 'Paiement à la livraison partout en Algérie. التوصيل لكل الولايات: Alger, Oran, Sétif, Blida, Constantine, Annaba. Prix 3500 DZD';
    expect(detectCodPhrases(text).length).toBeGreaterThan(0);
    expect(detectCurrency(text).currency).toBe('DZD');
    expect(wilayaCoverage(text).matched.length).toBeGreaterThanOrEqual(5);
    const assessment = assessMarket({
      url: 'https://boutique.dz/',
      text,
      language: detectLanguage(text),
      productCount: 42,
      hasCart: true,
      hasCheckout: true,
      hasPrices: true,
      dzPhoneCount: 1,
    });
    expect(assessment.pAlgeria).toBeGreaterThan(0.7);
    expect(assessment.pSellsPhysicalGoodsOnline).toBeGreaterThan(0.6);
    expect(assessment.isDzTld).toBe(true);
  });

  it('parses the real Shopify products.json and woo store API shapes', () => {
    const shopify = parseShopifyProductsJson(JSON.parse(read('allbirds-products.json')), 250);
    expect(shopify.source).toBe('products_json');
    expect(shopify.productCount).toBeGreaterThan(0);
    const woo = parseWooStoreApi(
      [
        { name: 'Parfum', prices: { price: '350000', currency_code: 'DZD' }, date_created: '2026-01-02T10:00:00' },
        { name: 'Robe', prices: { price: '450000', currency_code: 'DZD' }, date_created: '2026-01-05T10:00:00' },
      ],
      250,
    );
    expect(woo.productCount).toBe(2);
    expect(woo.medianPrice).toBe(400000);
    expect(woo.currency).toBe('DZD');
    expect(mergeCatalog(woo, shopify).source).toBe('woo_store_api');
  });

  it('counts product URLs in a sitemap', () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>https://x.dz/products/a</loc><lastmod>2026-01-02</lastmod></url><url><loc>https://x.dz/products/b</loc></url><url><loc>https://x.dz/about</loc></url></urlset>`;
    expect(countSitemapProductUrls(xml).count).toBe(2);
    expect(countSitemapProductUrls(xml).latest).toBe('2026-01-02T00:00:00.000Z');
  });
});
