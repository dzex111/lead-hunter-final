/** Shared domain types for the Lead Hunter core (pure, dependency-free). */

export const PLATFORM_IDS = [
  'shopify',
  'youcan',
  'woocommerce',
  'wordpress',
  'prestashop',
  'lightfunnels',
  'wix',
  'squarespace',
  'webflow',
  'magento',
  'salla',
  'zid',
  'custom',
  'none',
] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export const CATEGORY_IDS = [
  'fashion',
  'shoes',
  'beauty',
  'phones_accessories',
  'electronics',
  'home_kitchen',
  'kids',
  'auto',
  'health_supplements',
  'jewelry_watches',
  'other',
] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export const LANGUAGE_IDS = ['ar_msa', 'ar_dz', 'fr', 'en', 'mixed'] as const;
export type LanguageId = (typeof LANGUAGE_IDS)[number];

export const CHANNEL_IDS = [
  'whatsapp',
  'messenger',
  'instagram',
  'facebook',
  'email',
  'phone',
  'tiktok',
] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

export type SignalKind = 'platform' | 'contact' | 'adtech' | 'market' | 'catalog' | 'category';

export interface Evidence {
  /** Where the signal was observed, e.g. "html:head", "http-header:x-powered-by". */
  location: string;
  /** Short excerpt or header value proving the signal (never PII beyond published channels). */
  detail: string;
}

export interface Signal {
  /** Stable machine key, e.g. "platform:shopify" or "contact:whatsapp". */
  key: string;
  kind: SignalKind;
  value: string;
  /** Posterior-ish confidence of this single signal in [0,1]. */
  confidence: number;
  /**
   * Correlated-evidence cluster. Evidence inside one cluster is capped during
   * fusion so ten Shopify markers cannot masquerade as ten independent proofs.
   */
  clusterId: string;
  evidence: Evidence[];
}

export interface ContactChannel {
  kind: ChannelId;
  /** Normalized value: E.164 for phones/wa, lowercase handle for socials, email as-is. */
  value: string;
  /** Pre-built deep link (wa.me / m.me / instagram.com/...). */
  url: string;
  /** Where it was found: header | footer | floating | body | link_in_bio. */
  placement: string;
  confidence: number;
  evidence: Evidence[];
}

export interface CatalogStats {
  productCount: number | null;
  medianPrice: number | null;
  currency: string | null;
  latestProductUpdate: string | null;
  source: 'products_json' | 'woo_store_api' | 'sitemap' | 'html' | 'none';
}

export interface LanguageDistribution {
  ar_msa: number;
  ar_dz: number;
  fr: number;
  en: number;
  mixed: number;
  dominant: LanguageId;
}

export interface CategoryScore {
  category: CategoryId;
  probability: number;
}

export interface CategoryPrediction {
  top: CategoryScore[];
  abstained: boolean;
}

export interface PlatformPrediction {
  platform: PlatformId;
  probability: number;
  entropy: number;
  margin: number;
  abstained: boolean;
  probabilities: Record<string, number>;
}

export interface SiteFacts {
  url: string;
  canonicalUrl: string;
  domain: string;
  etld1: string;
  platform: PlatformId;
  platformConfidence: number;
  platformPosterior: PlatformPrediction;
  contacts: ContactChannel[];
  adtech: string[];
  market: {
    pAlgeria: number;
    pSellsPhysicalGoodsOnline: number;
    codPhrases: string[];
    currency: string | null;
    wilayaCoverage: number;
    isDzTld: boolean;
  };
  catalog: CatalogStats;
  categories: CategoryPrediction;
  language: LanguageDistribution;
  maturityIndex: number;
  signals: Signal[];
}

export type LeadKind = 'merchant';

export const LEAD_STATES = [
  'new',
  'enriched',
  'qualified',
  'disqualified',
  'queued',
  'drafted',
  'sent',
  'replied',
  'interested',
  'signed_up',
  'activated',
  'paid',
  'lost',
  'do_not_contact',
] as const;
export type LeadState = (typeof LEAD_STATES)[number];

export interface RawCandidate {
  /** Which discovery adapter produced this candidate. */
  sourceId: string;
  /** Free-form provenance, e.g. the search query or the pasted blob id. */
  provenance: Record<string, string | number | boolean | null>;
  url?: string;
  name?: string;
  phones?: string[];
  emails?: string[];
  handles?: { network: 'facebook' | 'instagram' | 'tiktok'; value: string }[];
  notes?: string;
  /** Operator annotations coming from manual sources. */
  annotations?: Record<string, string | boolean | number>;
  /** Cost accounting unit (API calls / quota). */
  costUnits?: number;
}

export interface QualifyResult {
  qualified: boolean;
  reasons: string[];
  gates: { gate: string; passed: boolean; detail: string }[];
}

export interface FeatureContribution {
  feature: string;
  value: number;
  weight: number;
  contribution: number;
  note?: string;
}

export interface ScoreResult {
  modelVersion: string;
  features: Record<string, number>;
  featureNames: string[];
  contributions: FeatureContribution[];
  pReply: number;
  pInterested: number;
  pSignup: number;
  pActivate: number;
  pPaid: number;
  ev: number;
  effortSeconds: number;
  priority: number;
  ucb: number;
  exploration: boolean;
  explanation: string[];
}

export interface ContactPolicyInput {
  leadId: string;
  channel: ChannelId;
  history: {
    channel: ChannelId;
    stage: string;
    occurredAt: Date;
    templateId?: string;
  }[];
  now: Date;
  state: LeadState;
  suppressed: boolean;
  onOrdelyCustomersList: boolean;
  senderState: SenderState;
}

export interface SenderState {
  /** ISO date when the sender started sending (warm-up anchor). */
  startedAt: Date;
  /** Configured steady-state daily cap. */
  dailyCap: number;
  platformCap: number;
  quietHoursBlockedUntil?: Date | null;
  /** Counts already used, keyed by Algiers day key and hour key. */
  sentByDay: Record<string, number>;
  sentByHour: Record<string, number>;
  lastSentAt: Date | null;
  /** Days of throttle multiplier from blocked/report outcomes. */
  throttleUntil?: Date | null;
  /** Channel of the most recent send (informational). */
  lastChannel?: ChannelId | null;
  /** Recent reply-rate observations for CUSUM. */
  dailyReplyRates: { day: string; sends: number; replies: number }[];
}
