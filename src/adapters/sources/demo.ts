import type { AppConfig } from '@/config';
import type { RawCandidate } from '@/core/types';
import { createRng } from '@/core/random';
import { asAsyncIterable, type DiscoverySource } from '@/adapters/sources/types';

/**
 * Demo source: deterministic synthetic Algerian COD merchants used by
 * `pnpm demo`, the simulation and the operator console preview so the whole loop
 * works with zero network access. Flagged `demo` in provenance forever, and it
 * never runs in production unless LEADHUNTER_ENABLE_DEMO_SOURCE=true.
 */
export interface SyntheticMerchant {
  id: string;
  name: string;
  url: string;
  platform: 'shopify' | 'youcan' | 'woocommerce' | 'lightfunnels' | 'custom';
  category: string;
  products: number;
  medianPrice: number;
  phone: string | null;
  instagram: string | null;
  facebook: string | null;
  hasWhatsapp: boolean;
  sellsCod: boolean;
  isAdvertiser: boolean;
  pAlgeria: number;
  pixelMeta: boolean;
  pixelTiktok: boolean;
  language: 'ar_dz' | 'ar_msa' | 'fr' | 'mixed';
  wilaya: string;
  maturityIndex: number;
  freshnessDays: number;
}

export const DEMO_WILAYAS = ['Alger', 'Oran', 'Constantine', 'Sétif', 'Blida', 'Tizi Ouzou', 'Béjaïa', 'Annaba', 'Batna', 'Djelfa', 'Tlemcen', 'Ouargla'];

export function syntheticPopulation(size: number, seed = 4242): SyntheticMerchant[] {
  const rng = createRng(seed);
  const platforms: SyntheticMerchant['platform'][] = ['shopify', 'youcan', 'woocommerce', 'lightfunnels', 'custom'];
  const categories = ['fashion', 'beauty', 'phones_accessories', 'home_kitchen', 'kids', 'jewelry_watches', 'electronics', 'auto'];
  const names = ['زين ستور', 'Nour Boutique', 'Dar El Djazair', 'ياسمين شوب', 'Sahara Market', 'Beldi Beauty', 'Tech DZ', 'Rania Kids', 'Ouarsenis Home', 'Amel Bijoux'];
  const out: SyntheticMerchant[] = [];

  for (let index = 0; index < size; index += 1) {
    const platform = rng.pick(platforms);
    const category = rng.pick(categories);
    const wilaya = rng.pick(DEMO_WILAYAS);
    const products = Math.max(3, Math.round(rng.exponential(1 / 28)));
    const hasWhatsapp = rng.bool(0.62);
    const isAdvertiser = rng.bool(0.45);
    const maturity = Math.round(
      Math.min(100, 12 + Math.log1p(products) * 7 + (hasWhatsapp ? 8 : 0) + (isAdvertiser ? 10 : 0) + rng.next() * 22),
    );
    const suffix = platform === 'shopify' ? 'myshopify.com' : platform === 'youcan' ? 'youcan.shop' : 'dz';
    out.push({
      id: `synth-${index}`,
      name: `${rng.pick(names)} ${index}`,
      url: `https://merchant-${index}.${suffix}`,
      platform,
      category,
      products,
      medianPrice: 1500 + Math.round(rng.next() * 9000),
      phone: `0${rng.pick(['5', '6', '7'])}${Math.round(rng.next() * 89_999_999 + 10_000_000)}`.slice(0, 10),
      instagram: rng.bool(0.7) ? `merchant_${index}` : null,
      facebook: rng.bool(0.65) ? `merchantpage${index}` : null,
      hasWhatsapp,
      sellsCod: rng.bool(0.85),
      isAdvertiser,
      pAlgeria: Math.min(0.99, 0.55 + rng.next() * 0.45),
      pixelMeta: rng.bool(0.55),
      pixelTiktok: rng.bool(0.3),
      language: rng.pick(['ar_dz', 'ar_dz', 'fr', 'mixed', 'ar_msa'] as const),
      wilaya,
      maturityIndex: maturity,
      freshnessDays: Math.round(rng.next() * 90),
    });
  }
  return out;
}

export function demoSource(config: AppConfig, size = 24): DiscoverySource {
  const id = 'demo_seed';
  return {
    id,
    label: 'Demo seed (synthetic merchants, offline)',
    capabilities: {
      network: false,
      paidApi: false,
      requiresCredentials: false,
      robotsRespect: true,
      costUnitsPerCall: 0,
      note: 'Synthetic data for demo/sim/preview. Marked demo:<id> in provenance.',
    },
    ensureReady(ctx) {
      if (!ctx.config.flags.demoSource) {
        throw new Error('demo source is disabled (production safety flag)');
      }
    },
    discover(ctx) {
      const requested = Number.parseInt(ctx.params['size'] ?? String(size), 10) || size;
      const merchants = syntheticPopulation(requested, ctx.config.seed);
      return asAsyncIterable(
        merchants.map<RawCandidate>((merchant) => ({
          sourceId: id,
          url: merchant.url,
          name: merchant.name,
          phones: merchant.phone ? [merchant.phone] : [],
          handles: [
            ...(merchant.instagram ? [{ network: 'instagram' as const, value: merchant.instagram }] : []),
            ...(merchant.facebook ? [{ network: 'facebook' as const, value: merchant.facebook }] : []),
          ],
          provenance: { origin: 'demo_seed', demo: true, syntheticId: merchant.id, platform: merchant.platform },
          annotations: {
            has_whatsapp: merchant.hasWhatsapp,
            sells_cod: merchant.sellsCod,
            is_advertiser: merchant.isAdvertiser,
            niche: merchant.category,
          },
          costUnits: 0,
        })),
      );
    },
  };
}

/**
 * Category vocabulary injected into the synthetic storefront so the offline demo
 * exercises the real category classifier (ar + fr lexicons, never a shortcut).
 */
const CATEGORY_COPY: Record<string, { ar: string; fr: string; en: string }> = {
  fashion: { ar: 'فساتين و قمصان و عباية نسائية', fr: 'robes, chemises et abaya', en: 'dresses and shirts' },
  beauty: { ar: 'عطور و مكياج و كريمات', fr: 'parfum, maquillage et crème', en: 'perfume and makeup' },
  phones_accessories: { ar: 'سماعات و شواحن و غطاء هاتف', fr: 'écouteurs, chargeurs et coque', en: 'earbuds and chargers' },
  home_kitchen: { ar: 'ادوات مطبخ و مفارش و ستائر', fr: 'ustensiles de cuisine et tapis', en: 'kitchen and home goods' },
  kids: { ar: 'ملابس اطفال و العاب', fr: 'vêtements bébé et jouets', en: 'baby clothes and toys' },
  jewelry_watches: { ar: 'مجوهرات و ساعات و اسورة', fr: 'bijoux et montres', en: 'jewelry and watches' },
  electronics: { ar: 'الكترونيات و ساعة ذكية', fr: 'électronique et montre connectée', en: 'electronics' },
  auto: { ar: 'اكسسوارات السيارات و قطع غيار', fr: 'accessoires voiture et pièces auto', en: 'car accessories' },
  shoes: { ar: 'احذية و صباط و سنيكرز', fr: 'chaussures et sneakers', en: 'shoes' },
  health_supplements: { ar: 'مكملات غذائية و فيتامين', fr: 'compléments alimentaires et vitamine', en: 'supplements' },
};

/** Synthetic HTML builder so the offline demo exercises the real extractor. */
export function syntheticMerchantHtml(merchant: SyntheticMerchant): string {
  const waLink = merchant.hasWhatsapp && merchant.phone ? `<a href="https://wa.me/213${merchant.phone.slice(1)}" class="whatsapp-float">WhatsApp</a>` : '';
  const instagram = merchant.instagram ? `<a href="https://instagram.com/${merchant.instagram}">@${merchant.instagram}</a>` : '';
  const facebook = merchant.facebook ? `<a href="https://facebook.com/${merchant.facebook}">Page Facebook</a>` : '';
  const pixel = merchant.pixelMeta
    ? `<script>!function(f,b,e,v,n,t,s){fbq('init','${100000000000000 + merchant.id.length}');fbq('track','PageView');}</script><script src="https://connect.facebook.net/en_US/fbevents.js"></script>`
    : '';
  const tiktok = merchant.pixelTiktok ? `<script src="https://analytics.tiktok.com/i18n/pixel/events.js"></script>` : '';
  const platformScript =
    merchant.platform === 'shopify'
      ? '<script>window.Shopify = window.Shopify || {theme:{}};</script><link rel="stylesheet" href="https://cdn.shopify.com/s/files/1/000/theme.css">'
      : merchant.platform === 'youcan'
        ? '<script src="https://cdn.youcan.store/assets/store.js"></script>'
        : merchant.platform === 'woocommerce'
          ? '<meta name="generator" content="WordPress 6.7" /><meta name="generator" content="WooCommerce 9.4" /><script src="/wp-content/plugins/woocommerce/assets/js/frontend.min.js?ver=9.4"></script>'
          : merchant.platform === 'lightfunnels'
            ? '<script src="https://cdn.lightfunnels.com/assets/funnel.js"></script>'
            : '';
  const language =
    merchant.language === 'fr'
      ? 'Paiement à la livraison partout en Algérie — Livraison à domicile'
      : merchant.language === 'ar_msa'
        ? 'الدفع عند الاستلام لجميع الولايات، توصيل لكل ولايات الجزائر'
        : 'الدفع عند الاستلام — التوصيل لكل الولايات، واش راك تحوس تزيد مبيعاتك؟ راني هنا';
  const copy = CATEGORY_COPY[merchant.category] ?? { ar: 'منتجات متنوعة', fr: 'produits variés', en: 'products' };
  const niche = `${copy.fr} — ${copy.ar} · ${copy.en}`;
  return `<!doctype html><html lang="${merchant.language.startsWith('ar') ? 'ar' : 'fr'}"><head>
<meta charset="utf-8"><title>${merchant.name} | ${copy.fr} — Boutique en ligne DZ</title>
<meta name="description" content="${language}. ${niche}. Livraison vers ${merchant.wilaya} et 58 wilayas." />
<meta name="keywords" content="${niche}" />
${platformScript}
${pixel}${tiktok}
</head><body class="${merchant.platform === 'woocommerce' ? 'woocommerce-page' : ''}">
<header><a href="/">${merchant.name}</a><nav><a href="/products">Produits</a></nav></header>
<main><h1>${merchant.name}</h1><p>${language}</p>
${Array.from({ length: Math.min(6, merchant.products) }, (_value, index) => `<div class="product"><h2>${copy.fr} ${index + 1} — ${copy.ar}</h2><span class="price">${merchant.medianPrice + index * 250} DZD</span><button>Ajouter au panier</button><span>${copy.en}</span></div>`).join('\n')}
</main>
<footer><a href="tel:+213${(merchant.phone ?? '0555555555').slice(1)}">Téléphone</a> ${instagram} ${facebook} ${waLink}
<p>Livraison vers ${merchant.wilaya} et 58 wilayas — paiement à la livraison</p></footer>
</body></html>`;
}
