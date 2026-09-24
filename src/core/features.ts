import type { ChannelId, CategoryId, PlatformId } from '@/core/types';
import { clamp, logit } from '@/core/util';

/**
 * P(reply) feature engineering. Every transform is documented in
 * docs/MATH.md §3; the expert-prior table lives here so the fit and the
 * cold-start prediction share a single source of truth.
 *
 * The intercept prior encodes the base reply rate (~12% on cold WhatsApp
 * outreach to COD merchants): logit(0.12) = -1.99.
 */
export const ADVERTISER_HALF_LIFE_DAYS = 21;

export const FEATURE_NAMES = [
  'bias',
  'is_advertiser_fresh',
  'log_ad_count',
  'sells_cod',
  'has_direct_whatsapp',
  'has_messenger_or_ig',
  'platform_shopify',
  'platform_youcan',
  'platform_woocommerce',
  'platform_other',
  'category_fashion',
  'category_beauty',
  'category_phones',
  'category_other',
  'maturity_index',
  'log_catalog_size',
  'pixel_meta',
  'pixel_tiktok',
  'language_arabic',
  'language_french',
  'channel_whatsapp',
  'channel_social',
  'hour_afternoon',
  'hour_evening',
  'sender_warmup',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

export const EXPERT_PRIORS: Record<FeatureName, { mean: number; sd: number }> = {
  bias: { mean: logit(0.12), sd: 1.0 },
  is_advertiser_fresh: { mean: 0.55, sd: 0.5 },
  log_ad_count: { mean: 0.1, sd: 0.35 },
  sells_cod: { mean: 0.85, sd: 0.5 },
  has_direct_whatsapp: { mean: 0.6, sd: 0.5 },
  has_messenger_or_ig: { mean: 0.15, sd: 0.4 },
  platform_shopify: { mean: 0.15, sd: 0.4 },
  platform_youcan: { mean: 0.3, sd: 0.5 },
  platform_woocommerce: { mean: 0.05, sd: 0.4 },
  platform_other: { mean: 0.0, sd: 0.4 },
  category_fashion: { mean: 0.2, sd: 0.4 },
  category_beauty: { mean: 0.25, sd: 0.4 },
  category_phones: { mean: 0.1, sd: 0.4 },
  category_other: { mean: 0.0, sd: 0.4 },
  maturity_index: { mean: -0.2, sd: 0.4 },
  log_catalog_size: { mean: 0.2, sd: 0.35 },
  pixel_meta: { mean: 0.35, sd: 0.4 },
  pixel_tiktok: { mean: 0.25, sd: 0.4 },
  language_arabic: { mean: 0.3, sd: 0.4 },
  language_french: { mean: -0.1, sd: 0.4 },
  channel_whatsapp: { mean: 0.5, sd: 0.5 },
  channel_social: { mean: -0.25, sd: 0.4 },
  hour_afternoon: { mean: 0.1, sd: 0.3 },
  hour_evening: { mean: 0.05, sd: 0.3 },
  sender_warmup: { mean: -0.3, sd: 0.4 },
};

export interface FeatureInput {
  isAdvertiser: boolean;
  advertiserFirstSeenAt: Date | null;
  adCount: number | null;
  sellsCod: boolean;
  directWhatsapp: boolean;
  platform: PlatformId;
  category: CategoryId | null;
  maturityIndex: number;
  productCount: number | null;
  pixelMeta: boolean;
  pixelTiktok: boolean;
  languageDominant: string;
  preferredChannel: ChannelId;
  hourOfDayAlgiers: number;
  senderWarmupProgress: number;
  now: Date;
}

export interface FeatureVector {
  names: FeatureName[];
  values: number[];
  notes: string[];
}

export function buildFeatureVector(input: FeatureInput): FeatureVector {
  const notes: string[] = [];
  const values: number[] = [];
  const names: FeatureName[] = [];

  const push = (name: FeatureName, value: number, note?: string): void => {
    names.push(name);
    values.push(Number.isFinite(value) ? value : 0);
    if (note) notes.push(`${name}=${value.toFixed(3)} (${note})`);
  };

  push('bias', 1, 'intercept');

  let advertiserFreshness = 0;
  if (input.isAdvertiser) {
    if (input.advertiserFirstSeenAt) {
      const days = Math.max(0, (input.now.getTime() - input.advertiserFirstSeenAt.getTime()) / 86_400_000);
      advertiserFreshness = Math.pow(2, -days / ADVERTISER_HALF_LIFE_DAYS);
      notes.push(
        `advertiser freshness ${advertiserFreshness.toFixed(3)} (${days.toFixed(1)}d since first seen, half-life ${ADVERTISER_HALF_LIFE_DAYS}d)`,
      );
    } else {
      advertiserFreshness = 0.7;
      notes.push('advertiser known but first_seen missing → 0.7 default');
    }
  }
  push('is_advertiser_fresh', advertiserFreshness, '2^(-Δt/half_life)');
  push('log_ad_count', input.adCount === null ? 0 : Math.log1p(Math.max(0, input.adCount)), 'log1p(ads seen)');
  push('sells_cod', input.sellsCod ? 1 : 0, 'COD phrases detected');
  push('has_direct_whatsapp', input.directWhatsapp ? 1 : 0, 'wa.me / api.whatsapp.com found');

  const socialOnly = !input.directWhatsapp && (input.preferredChannel === 'messenger' || input.preferredChannel === 'instagram' || input.preferredChannel === 'facebook');
  push('has_messenger_or_ig', socialOnly ? 1 : 0, 'social-only merchant');

  push('platform_shopify', input.platform === 'shopify' ? 1 : 0);
  push('platform_youcan', input.platform === 'youcan' ? 1 : 0);
  push('platform_woocommerce', input.platform === 'woocommerce' ? 1 : 0);
  push(
    'platform_other',
    !['shopify', 'youcan', 'woocommerce'].includes(input.platform) ? 1 : 0,
  );

  const category = input.category ?? 'other';
  push('category_fashion', category === 'fashion' ? 1 : 0);
  push('category_beauty', category === 'beauty' ? 1 : 0);
  push('category_phones', category === 'phones_accessories' ? 1 : 0);
  push(
    'category_other',
    !['fashion', 'beauty', 'phones_accessories'].includes(category) ? 1 : 0,
  );

  push('maturity_index', clamp(input.maturityIndex / 100, 0, 1), 'maturity index / 100');
  push(
    'log_catalog_size',
    input.productCount === null ? 0 : clamp(Math.log1p(Math.max(0, input.productCount)) / Math.log1p(300), 0, 1),
    'log1p(catalog)/log1p(300)',
  );
  push('pixel_meta', input.pixelMeta ? 1 : 0, 'Meta Pixel present');
  push('pixel_tiktok', input.pixelTiktok ? 1 : 0, 'TikTok Pixel present');
  push('language_arabic', ['ar_dz', 'ar_msa'].includes(input.languageDominant) ? 1 : 0);
  push('language_french', input.languageDominant === 'fr' ? 1 : 0);
  push('channel_whatsapp', input.preferredChannel === 'whatsapp' ? 1 : 0);
  push(
    'channel_social',
    ['messenger', 'instagram', 'facebook'].includes(input.preferredChannel) ? 1 : 0,
  );

  const hour = input.hourOfDayAlgiers;
  push('hour_afternoon', hour >= 11 && hour < 16 ? 1 : 0, 'Algiers 11:00-16:00');
  push('hour_evening', hour >= 16 && hour < 22 ? 1 : 0, 'Algiers 16:00-22:00');
  push('sender_warmup', clamp(input.senderWarmupProgress, 0, 1), 'sender warm-up progress 0..1');

  return { names, values, notes };
}

export function priorArray(): { mean: number; sd: number }[] {
  return FEATURE_NAMES.map((name) => EXPERT_PRIORS[name]);
}

export function vectorToRecord(vector: FeatureVector): Record<string, number> {
  const out: Record<string, number> = {};
  vector.names.forEach((name, index) => {
    out[name] = vector.values[index] ?? 0;
  });
  return out;
}

export function contributionsOf(
  vector: FeatureVector,
  beta: readonly number[],
): { feature: string; value: number; weight: number; contribution: number }[] {
  return vector.names.map((name, index) => {
    const value = vector.values[index] ?? 0;
    const weight = beta[index] ?? 0;
    return { feature: name, value, weight, contribution: weight * value };
  });
}
