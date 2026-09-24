import { algiersHourKey, toAlgiersWallTime } from '@/core/clock';
import { qualifyLead, type QualifyInput } from '@/core/qualify';
import type {
  CategoryId,
  ChannelId,
  ContactChannel,
  LanguageId,
  PlatformId,
  QualifyResult,
  SiteFacts,
} from '@/core/types';
import { clamp } from '@/core/util';

/**
 * Rebuilds a typed fact bundle from stored observations. The DB is the source of
 * truth; nothing is inferred twice or kept in a hidden in-memory cache.
 */
export interface ObservationRow {
  key: string;
  value: string;
  confidence: number;
  source?: string | null;
  observedAt?: Date;
}

export interface LeadRowShape {
  id: string;
  name: string | null;
  domain: string | null;
  platform: PlatformId | null;
  category: CategoryId | null;
  wilaya: string | null;
  primaryChannel: ChannelId | null;
  primaryTarget: string | null;
  maturityIndex: number | null;
  pAlgeria: number | null;
  annotations: Record<string, unknown> | null;
}

export interface FactsBundle {
  platform: PlatformId;
  platformConfidence: number;
  contacts: ContactChannel[];
  adtech: string[];
  categories: CategoryId[];
  categoryProbabilities: { category: CategoryId; probability: number }[];
  language: LanguageId;
  market: {
    pAlgeria: number;
    pSellsPhysicalGoodsOnline: number;
    codPhrases: string[];
    currency: string | null;
    wilayaCoverage: number;
    isDzTld: boolean;
  };
  catalog: {
    productCount: number | null;
    medianPrice: number | null;
    currency: string | null;
    latestProductUpdate: string | null;
    source: string;
  };
  maturityIndex: number;
  isAdvertiser: boolean;
  advertiserFirstSeenAt: Date | null;
  advertiserLastSeenAt: Date | null;
  adCount: number | null;
  raw: Map<string, ObservationRow>;
}

const CHANNEL_KINDS: ChannelId[] = ['whatsapp', 'messenger', 'instagram', 'facebook', 'email', 'phone', 'tiktok'];

export function buildFactsBundle(lead: LeadRowShape, observations: readonly ObservationRow[]): FactsBundle {
  const latest = new Map<string, ObservationRow>();
  for (const observation of observations) {
    const existing = latest.get(observation.key);
    if (!existing || observation.confidence > existing.confidence) latest.set(observation.key, observation);
  }

  const contacts: ContactChannel[] = [];
  for (const [key, observation] of latest) {
    if (!key.startsWith('contact:')) continue;
    const kind = key.slice('contact:'.length) as ChannelId;
    if (!CHANNEL_KINDS.includes(kind)) continue;
    contacts.push({
      kind,
      value: observation.value,
      url: contactUrl(kind, observation.value),
      placement: 'stored',
      confidence: observation.confidence,
      evidence: [{ location: observation.source ?? 'stored', detail: key }],
    });
  }

  const adtech: string[] = [];
  for (const [key] of latest) {
    if (key.startsWith('adtech:')) adtech.push(key.slice('adtech:'.length));
  }

  const categoryProbabilities: { category: CategoryId; probability: number }[] = [];
  for (const [key, observation] of latest) {
    if (!key.startsWith('category:')) continue;
    categoryProbabilities.push({
      category: key.slice('category:'.length) as CategoryId,
      probability: clamp(observation.confidence, 0, 1),
    });
  }
  categoryProbabilities.sort((a, b) => b.probability - a.probability);
  const categories: CategoryId[] = [];
  if (lead.category !== null) categories.push(lead.category);
  for (const entry of categoryProbabilities.slice(0, 2)) {
    if (!categories.includes(entry.category)) categories.push(entry.category);
  }

  const platformObs = latest.get('platform:none') ?? findByPrefix(latest, 'platform:');
  const platform = (lead.platform ?? (platformObs ? (platformObs.key.slice('platform:'.length) as PlatformId) : 'none')) as PlatformId;

  const pAlgeriaObs = latest.get('market:p_algeria');
  const codObs = latest.get('market:cod');
  const currencyObs = latest.get('market:currency');
  const wilayaObs = latest.get('market:wilaya_coverage');

  const annotations = lead.annotations ?? {};
  const isAdvertiser =
    annotations['is_advertiser'] === true ||
    adtech.includes('meta_pixel') ||
    [...latest.keys()].some((key) => key.startsWith('advertiser:'));

  const firstSeen = annotations['advertiser_first_seen'];
  const lastSeen = annotations['advertiser_last_seen'];
  const adCountRaw = annotations['ad_count'];

  return {
    platform,
    platformConfidence: platformObs?.confidence ?? (lead.platform ? 0.8 : 0.3),
    contacts,
    adtech,
    categories,
    categoryProbabilities,
    language: (latest.get('language:dominant')?.value as LanguageId | undefined) ?? 'mixed',
    market: {
      pAlgeria: clamp(lead.pAlgeria ?? (pAlgeriaObs ? Number.parseFloat(pAlgeriaObs.value) : 0.3), 0, 1),
      pSellsPhysicalGoodsOnline: clamp(
        Number.parseFloat(latest.get('market:p_sells_physical')?.value ?? ''),
        0,
        1,
      ) || inferPhysicalGoods(categories, latest),
      codPhrases: codObs ? codObs.value.split(' | ') : [],
      currency: currencyObs?.value ?? null,
      wilayaCoverage: clamp(Number.parseFloat(wilayaObs?.value ?? '0') / 58, 0, 1),
      isDzTld: latest.has('market:dz_tld'),
    },
    catalog: {
      productCount: latest.has('catalog:product_count')
        ? Number.parseInt(latest.get('catalog:product_count')?.value ?? '0', 10)
        : null,
      medianPrice: latest.has('catalog:median_price')
        ? Number.parseFloat(latest.get('catalog:median_price')?.value ?? '0')
        : null,
      currency: latest.get('catalog:currency')?.value ?? currencyObs?.value ?? null,
      latestProductUpdate: latest.get('catalog:latest_update')?.value ?? null,
      source: latest.get('catalog:source')?.value ?? 'none',
    },
    maturityIndex: clamp(lead.maturityIndex ?? Number.parseFloat(latest.get('maturity:index')?.value ?? '0'), 0, 100),
    isAdvertiser,
    advertiserFirstSeenAt: typeof firstSeen === 'string' ? new Date(firstSeen) : null,
    advertiserLastSeenAt: typeof lastSeen === 'string' ? new Date(lastSeen) : null,
    adCount: typeof adCountRaw === 'number' ? adCountRaw : null,
    raw: latest,
  };
}

function findByPrefix(map: Map<string, ObservationRow>, prefix: string): ObservationRow | null {
  for (const [key, observation] of map) {
    if (key.startsWith(prefix) && key !== 'platform:none') return observation;
  }
  return null;
}

function inferPhysicalGoods(
  categories: readonly CategoryId[],
  latest: Map<string, ObservationRow>,
): number {
  const hasProducts = latest.has('catalog:product_count');
  const hasCart = latest.has('market:cart');
  const hasCod = latest.has('market:cod');
  let odds = 0.3;
  if (hasProducts) odds += 0.3;
  if (hasCart) odds += 0.15;
  if (hasCod) odds += 0.2;
  if (categories.length > 0) odds += 0.1;
  return clamp(odds, 0, 0.95);
}

export function contactUrl(kind: ChannelId, value: string): string {
  switch (kind) {
    case 'whatsapp':
      return `https://wa.me/${value.replace('+', '')}`;
    case 'messenger':
      return `https://m.me/${value}`;
    case 'instagram':
      return `https://www.instagram.com/${value}`;
    case 'facebook':
      return `https://www.facebook.com/${value}`;
    case 'tiktok':
      return `https://www.tiktok.com/@${value}`;
    case 'email':
      return `mailto:${value}`;
    case 'phone':
      return `tel:${value}`;
    default:
      return '';
  }
}

/** Channel preference order: WhatsApp first (12s/msg), then DMs, then email. */
export function preferredChannel(facts: FactsBundle): { channel: ChannelId; target: string } | null {
  const order: ChannelId[] = ['whatsapp', 'messenger', 'instagram', 'facebook', 'tiktok', 'email', 'phone'];
  const sorted = [...facts.contacts].sort((a, b) => {
    const rankA = order.indexOf(a.kind);
    const rankB = order.indexOf(b.kind);
    if (rankA !== rankB) return rankA - rankB;
    return b.confidence - a.confidence;
  });
  const best = sorted[0];
  return best ? { channel: best.kind, target: best.value } : null;
}

export function toQualifyInput(input: {
  facts: FactsBundle;
  suppressed: boolean;
  onOrdelyCustomersList: boolean;
  policyAllows: boolean;
  policyReason?: string;
  minimumMaturity?: number;
}): QualifyInput {
  const siteFacts = {
    contacts: input.facts.contacts,
    market: {
      pAlgeria: input.facts.market.pAlgeria,
      pSellsPhysicalGoodsOnline: input.facts.market.pSellsPhysicalGoodsOnline,
      codPhrases: input.facts.market.codPhrases,
      currency: input.facts.market.currency,
      wilayaCoverage: input.facts.market.wilayaCoverage,
      isDzTld: input.facts.market.isDzTld,
    },
    platform: input.facts.platform,
    catalog: {
      productCount: input.facts.catalog.productCount,
      medianPrice: input.facts.catalog.medianPrice,
      currency: input.facts.catalog.currency,
      latestProductUpdate: input.facts.catalog.latestProductUpdate,
      source: input.facts.catalog.source as SiteFacts['catalog']['source'],
    },
    categories: { top: input.facts.categoryProbabilities.slice(0, 3), abstained: input.facts.categoryProbabilities.length === 0 },
    maturityIndex: input.facts.maturityIndex,
  } satisfies Pick<SiteFacts, 'contacts' | 'market' | 'platform' | 'catalog' | 'categories' | 'maturityIndex'>;

  return {
    facts: siteFacts,
    suppressed: input.suppressed,
    onOrdelyCustomersList: input.onOrdelyCustomersList,
    policyAllows: input.policyAllows,
    ...(input.policyReason !== undefined ? { policyReason: input.policyReason } : {}),
    ...(input.minimumMaturity !== undefined ? { minimumMaturity: input.minimumMaturity } : {}),
  };
}

export function qualifyFromFacts(input: Parameters<typeof toQualifyInput>[0]): QualifyResult {
  return qualifyLead(toQualifyInput(input));
}

export function hourBucket(now: Date): { hour: number; key: string } {
  const wall = toAlgiersWallTime(now);
  return { hour: wall.hour, key: algiersHourKey(now) };
}
