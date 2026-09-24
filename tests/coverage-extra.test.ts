import { describe, expect, it } from 'vitest';
import { ALGIERS_UTC_OFFSET_MINUTES, FakeClock, SystemClock, algiersDayKey, algiersHourKey, toAlgiersWallTime } from '@/core/clock';
import { createRng, fisherYates } from '@/core/random';
import { SILENT_LOGGER } from '@/core/ports';
import { extractContacts } from '@/core/extract/contacts';
import { extractSiteFacts } from '@/core/extract';
import { parseWooStoreApi, extractPricesFromHtml, catalogFromHtml, catalogPriceSum, catalogFreshnessDays, emptyCatalog } from '@/core/extract/catalog';
import { buildFeatureVector } from '@/core/features';
import { qualifyLead } from '@/core/qualify';
import { buildOutreachLink, buildSocialHandoff, renderMessage } from '@/core/messaging/render';
import { templateById } from '@/core/messaging/templates';
import { betaUpperBound, funnelStagePosterior, thompsonSampleBeta } from '@/core/math/beta';
import { applyPlatt, meanAbsoluteError, plattScaling } from '@/core/math/metrics';
import { combineUcbAndEv, effortForChannel } from '@/core/math/ev';
import { queryPriorFromPattern } from '@/core/math/bandit';
import { canTransition } from '@/core/lifecycle/state';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('clock helpers', () => {
  it('advances a fake clock and formats Algiers wall time (UTC+1, no DST)', () => {
    const clock = new FakeClock('2026-03-05T08:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-03-05T08:00:00.000Z');
    clock.advanceMinutes(30);
    clock.advanceHours(1);
    clock.advanceDays(1);
    clock.advanceMs(1000);
    expect(clock.now().toISOString()).toBe('2026-03-06T09:30:01.000Z');
    const wall = toAlgiersWallTime(clock.now());
    expect(wall.hour).toBe(10);
    expect(ALGIERS_UTC_OFFSET_MINUTES).toBe(60);
    expect(algiersDayKey(clock.now())).toBe('2026-03-06');
    expect(algiersHourKey(clock.now())).toBe('2026-03-06T10');
    clock.set(new Date('2026-01-01T00:00:00.000Z'));
    expect(algiersDayKey(clock.now())).toBe('2026-01-01');
    expect(new SystemClock().now().getTime()).toBeGreaterThan(0);
    expect(SILENT_LOGGER.info({}, 'noop')).toBeUndefined();
  });
});

describe('random utilities', () => {
  it('produces bounded draws and deterministic forks', () => {
    const rng = createRng(1234);
    for (let i = 0; i < 200; i += 1) {
      const u = rng.next();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
    expect(rng.int(5)).toBeLessThan(5);
    expect(rng.bool(1)).toBe(true);
    expect(rng.bool(0)).toBe(false);
    const gamma = rng.gamma(2.5, 1);
    expect(gamma).toBeGreaterThan(0);
    const beta = rng.beta(2, 3);
    expect(beta).toBeGreaterThanOrEqual(0);
    expect(beta).toBeLessThanOrEqual(1);
    expect(rng.exponential(0.5)).toBeGreaterThan(0);
    expect(rng.pick(['a', 'b', 'c'])).toMatch(/[abc]/);
    expect(() => rng.pick([])).toThrow(/empty array/);
    expect(rng.fork(7).next()).toBe(rng.fork(7).next());
    const shuffled = fisherYates([1, 2, 3, 4, 5], createRng(3));
    expect([...shuffled].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(createRng(0).next()).toBe(createRng(0).next());
  });
});

describe('contact extraction edge cases', () => {
  it('finds messenger, tiktok, script-embedded numbers and email text', () => {
    const html = `<html><body>
      <a href="https://m.me/boutiquedz">Messenger</a>
      <a href="https://www.tiktok.com/@boutiquedz">TikTok</a>
      <a href="tel:0770123456">Appel</a>
      <script>var wa = "https://api.whatsapp.com/send?phone=213661234567&text=salut"; var mail = "salam@boutique.dz";</script>
      <p>اتصل 0555123456 أو راسلنا hello@shop.dz</p>
    </body></html>`;
    const contacts = extractContacts({ url: 'https://shop.dz/', html });
    const kinds = contacts.map((channel) => `${channel.kind}:${channel.value}`);
    expect(kinds).toContain('messenger:boutiquedz');
    expect(kinds).toContain('tiktok:boutiquedz');
    expect(kinds).toContain('phone:+213770123456');
    expect(kinds).toContain('whatsapp:+213661234567');
    expect(kinds.some((kind) => kind.startsWith('email:'))).toBe(true);
    expect(kinds.some((kind) => kind === 'phone:+213555123456')).toBe(true);
  });
});

describe('catalogue fallbacks', () => {
  it('falls back to HTML prices and merges catalogues', () => {
    const html = '<div>Prix: 3 500 DZD</div><div>Promo 4 200 دج</div><div>Petit 50 DA (trop bas, ignoré)</div>';
    const parsed = extractPricesFromHtml(html);
    expect(parsed.prices.length).toBeGreaterThanOrEqual(2);
    expect(parsed.currency).toBe('DZD');
    const catalog = catalogFromHtml(html);
    expect(catalog.source).toBe('html');
    expect(catalog.medianPrice).not.toBeNull();
    expect(catalogPriceSum(catalog)).toBeGreaterThan(0);
    expect(catalogFreshnessDays(catalog, new Date())).toBeNull();
    expect(catalogFreshnessDays({ ...catalog, latestProductUpdate: '2026-01-01T00:00:00.000Z' }, new Date('2026-01-11T00:00:00.000Z'))).toBe(10);
    const empty = emptyCatalog();
    expect(empty.productCount).toBeNull();
    const woo = parseWooStoreApi([{ prices: { price: '3500', currency_code: 'DZD' }, date_created: '2026-01-01' }]);
    expect(woo.productCount).toBe(1);
  });
});

describe('features / qualification / messaging tail paths', () => {
  it('builds a French/evening/custom-platform feature vector', () => {
    const vector = buildFeatureVector({
      isAdvertiser: false,
      advertiserFirstSeenAt: null,
      adCount: null,
      sellsCod: true,
      directWhatsapp: false,
      platform: 'custom',
      category: null,
      maturityIndex: 20,
      productCount: null,
      pixelMeta: false,
      pixelTiktok: true,
      languageDominant: 'fr',
      preferredChannel: 'instagram',
      hourOfDayAlgiers: 20,
      senderWarmupProgress: 0.3,
      now: new Date('2026-01-10T19:00:00.000Z'),
    });
    const record = Object.fromEntries(vector.names.map((name, index) => [name, vector.values[index]]));
    expect(record['language_french']).toBe(1);
    expect(record['hour_evening']).toBe(1);
    expect(record['hour_afternoon']).toBe(0);
    expect(record['platform_other']).toBe(1);
    expect(record['channel_social']).toBe(1);
    expect(record['category_other']).toBe(1);
    expect(record['log_ad_count']).toBe(0);
  });

  it('fails qualification without a contactable channel and below the maturity floor', () => {
    const noChannel = qualifyLead({
      facts: {
        contacts: [],
        market: {
          pAlgeria: 0.9,
          pSellsPhysicalGoodsOnline: 0.9,
          codPhrases: ['paiement a la livraison'],
          currency: 'DZD',
          wilayaCoverage: 0.5,
          isDzTld: true,
        },
        platform: 'shopify',
        catalog: { productCount: 10, medianPrice: 3000, currency: 'DZD', latestProductUpdate: null, source: 'products_json' },
        categories: { top: [], abstained: true },
        maturityIndex: 90,
      },
      suppressed: false,
      onOrdelyCustomersList: false,
      policyAllows: true,
    });
    expect(noChannel.qualified).toBe(false);
    expect(noChannel.reasons.join(' ')).toContain('no contactable channel');

    const lowMaturity = qualifyLead({
      facts: {
        contacts: [
          {
            kind: 'whatsapp',
            value: '+213555123456',
            url: 'https://wa.me/213555123456',
            placement: 'footer',
            confidence: 0.9,
            evidence: [],
          },
        ],
        market: {
          pAlgeria: 0.9,
          pSellsPhysicalGoodsOnline: 0.9,
          codPhrases: [],
          currency: 'DZD',
          wilayaCoverage: 0.2,
          isDzTld: false,
        },
        platform: 'custom',
        catalog: { productCount: 3, medianPrice: 1000, currency: 'DZD', latestProductUpdate: null, source: 'html' },
        categories: { top: [], abstained: true },
        maturityIndex: 5,
      },
      suppressed: false,
      onOrdelyCustomersList: false,
      policyAllows: true,
      minimumMaturity: 40,
    });
    expect(lowMaturity.qualified).toBe(false);
    expect(lowMaturity.reasons.join(' ')).toContain('maturity below');
  });

  it('renders follow-up/reply templates and social handoffs for every channel', () => {
    const followup = templateById('followup.once')!;
    const rendered = renderMessage({
      template: followup,
      slots: {},
      language: 'fr',
      channel: 'instagram',
      rng: createRng(1),
      isFirstContact: false,
    });
    expect(rendered.blocked).toBe(false);
    expect(rendered.body).not.toContain('{');
    const reply = renderMessage({
      template: templateById('reply.interested_link')!,
      slots: { link: 'https://app.ordely.example/signup' },
      language: 'ar_dz',
      channel: 'whatsapp',
      rng: createRng(2),
      isFirstContact: false,
    });
    expect(reply.blocked).toBe(false);
    expect(reply.body).toContain('https://app.ordely.example/signup');

    expect(buildOutreachLink('facebook', 'boutiquedz', 'salut').link?.target).toBe('https://www.facebook.com/boutiquedz');
    expect(buildOutreachLink('tiktok', 'boutiquedz', 'salut').link?.instructions).toContain('coller');
    expect(buildOutreachLink('phone', '+213555123456', 'script').link?.instructions).toContain('Appeler');
    expect(buildSocialHandoff({ channel: 'messenger', handleOrUrl: 'boutiquedz', text: 'x' }).profileUrl).toBe('https://m.me/boutiquedz');
  });

  it('covers residual maths helpers', () => {
    expect(betaUpperBound(2, 2, 0.95)).toBeGreaterThan(0.5);
    const stage = funnelStagePosterior('replied', [], { key: 's', successes: 3, n: 10 }, 0.3, 5);
    expect(stage.mean).toBeGreaterThan(0);
    expect(thompsonSampleBeta(2, 2, createRng(4))).toBeGreaterThanOrEqual(0);
    const scaling = plattScaling(Array.from({ length: 250 }, (_value, index) => ({ p: (index % 10) / 10, y: (index % 2) as 0 | 1 })));
    expect(scaling.enabled).toBe(true);
    expect(applyPlatt(0.5, { a: 1, b: 0, enabled: false })).toBe(0.5);
    expect(meanAbsoluteError([1, 2], [1.5, 2.5])).toBeCloseTo(0.5, 8);
    expect(combineUcbAndEv(0.5, 10, true)).toBeGreaterThan(combineUcbAndEv(0.5, 10, false));
    expect(effortForChannel('email')).toBeGreaterThan(effortForChannel('whatsapp'));
    expect(queryPriorFromPattern('paiement à la livraison parfum Alger')).toBeGreaterThan(queryPriorFromPattern('dz'));
    expect(canTransition('lost', 'replied', {
      hasObservations: true,
      hasContactableChannel: true,
      qualified: true,
      suppressed: false,
      hasDraft: false,
      policyAllowed: true,
    }).allowed).toBe(true);
  });
});

describe('extraction on the WooCommerce fixture', () => {
  it('extracts facts from real WooCommerce markup with a Woo catalogue', () => {
    const html = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'raw', 'woo.html'), 'utf8');
    const facts = extractSiteFacts({
      url: 'https://themes.woocommerce.com/storefront/',
      html,
      headers: { 'x-wc-cache': 'hit' },
      now: new Date('2026-09-24T10:00:00.000Z'),
      catalog: parseWooStoreApi([
        { prices: { price: '450000', currency_code: 'DZD' }, date_created: '2026-09-01' },
        { prices: { price: '350000', currency_code: 'DZD' }, date_created: '2026-09-10' },
      ]),
    });
    expect(facts.platformPosterior.probabilities['woocommerce']).toBeGreaterThan(0);
    expect(facts.signals.some((signal) => signal.key.startsWith('platform:'))).toBe(true);
    expect(facts.catalog.medianPrice).toBe(400000);
  });
});
