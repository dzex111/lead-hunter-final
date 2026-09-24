import type { PlatformId } from '@/core/types';
import { clamp } from '@/core/util';

/**
 * Maturity index (0-100) — documented formula, see docs/MATH.md §7.
 *
 *   maturity = 100 * ( 0.30 * catalog  + 0.20 * freshness
 *                    + 0.20 * tracking + 0.15 * channels + 0.15 * stack )
 *
 * catalog  = clip(log1p(productCount) / log1p(300), 0, 1)
 * freshness= 2 ^ (-daysSinceLastProductUpdate / 30)          (30-day half-life)
 * tracking = clip(pixels/4, 0, 1) * (serverSidePixel ? 1 : 0.85)
 * channels = clip(distinctContactChannels / 4, 0, 1)
 * stack    = platform sophistication score in [0,1]
 */
export const PLATFORM_SOPHISTICATION: Record<PlatformId, number> = {
  shopify: 1.0,
  magento: 0.95,
  lightfunnels: 0.85,
  woocommerce: 0.8,
  youcan: 0.75,
  prestashop: 0.7,
  squarespace: 0.7,
  webflow: 0.65,
  wix: 0.6,
  zid: 0.6,
  salla: 0.6,
  custom: 0.45,
  wordpress: 0.35,
  none: 0.2,
};

export interface MaturityInput {
  productCount: number | null;
  freshnessDays: number | null;
  pixelCount: number;
  hasServerSidePixel: boolean;
  distinctChannelCount: number;
  platform: PlatformId;
}

export function maturityIndex(input: MaturityInput): number {
  const products = input.productCount ?? 0;
  const catalog = clamp(Math.log1p(products) / Math.log1p(300), 0, 1);

  const freshness =
    input.freshnessDays === null ? 0.35 : clamp(Math.pow(2, -input.freshnessDays / 30), 0, 1);

  const tracking = clamp(input.pixelCount / 4, 0, 1) * (input.hasServerSidePixel ? 1 : 0.85);

  const channels = clamp(input.distinctChannelCount / 4, 0, 1);

  const stack = PLATFORM_SOPHISTICATION[input.platform];

  const raw = 0.3 * catalog + 0.2 * freshness + 0.2 * tracking + 0.15 * channels + 0.15 * stack;
  return Math.round(clamp(raw, 0, 1) * 1000) / 10;
}
