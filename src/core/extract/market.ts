import { COD_PHRASES, CURRENCY_PATTERNS } from '@/core/data/lexicons';
import { WILAYA_ALIASES, WILAYAS } from '@/core/data/wilayas';
import { matchKey } from '@/core/normalize/text';
import { extractAllAlgerianPhones } from '@/core/normalize/phone';
import { safeCanonicalizeUrl } from '@/core/normalize/url';
import type { LanguageDistribution } from '@/core/types';
import { logit, safeProb, sigmoid, sum } from '@/core/util';

export interface MarketAssessment {
  pAlgeria: number;
  pSellsPhysicalGoodsOnline: number;
  codPhrases: string[];
  currency: string | null;
  currencyConfidence: number;
  wilayaCoverage: number;
  wilayaMatches: number[];
  isDzTld: boolean;
  dzPhoneCount: number;
  /** log-odds contributions, kept for explainability + unit tests. */
  algeriaLogOdds: number;
  storeLogOdds: number;
}

export interface MarketInput {
  url: string;
  text: string;
  language: LanguageDistribution;
  /** Catalog-derived hints. */
  productCount: number | null;
  hasCart: boolean;
  hasCheckout: boolean;
  hasPrices: boolean;
  dzPhoneCount: number;
}

export function detectCodPhrases(text: string): { phrase: string; weight: number }[] {
  const key = matchKey(text);
  const found: { phrase: string; weight: number }[] = [];
  for (const entry of COD_PHRASES) {
    if (key.includes(matchKey(entry.phrase))) found.push({ phrase: entry.phrase, weight: entry.weight });
  }
  return found;
}

export function detectCurrency(text: string): { currency: string | null; confidence: number; matches: string[] } {
  const matches: string[] = [];
  let best: { currency: string; weight: number } | null = null;
  for (const entry of CURRENCY_PATTERNS) {
    const regex = new RegExp(entry.pattern, 'i');
    for (const line of text.split(/\n/).slice(0, 4000)) {
      const match = line.match(regex);
      if (!match) continue;
      matches.push((match[0] ?? '').trim());
      if (!best || entry.weight > best.weight) best = { currency: entry.currency, weight: entry.weight };
    }
  }
  return {
    currency: best?.currency ?? null,
    confidence: best ? safeProb(sigmoid(best.weight)) : 0,
    matches: matches.slice(0, 20),
  };
}

export function wilayaCoverage(text: string): { coverage: number; matched: number[] } {
  const key = ` ${matchKey(text)} `;
  const matched: number[] = [];
  for (const [alias, code] of Object.entries(WILAYA_ALIASES)) {
    if (key.includes(` ${alias} `) || key.includes(` ${alias}.`) || key.includes(` ${alias},`)) {
      if (!matched.includes(code)) matched.push(code);
    }
  }
  for (const wilaya of WILAYAS) {
    if (key.includes(` ${matchKey(wilaya.ar)} `) && !matched.includes(wilaya.code)) matched.push(wilaya.code);
  }
  return { coverage: matched.length / WILAYAS.length, matched };
}

export function assessMarket(input: MarketInput): MarketAssessment {
  const url = safeCanonicalizeUrl(input.url);
  const isDzTld = url?.host.endsWith('.dz') ?? false;

  let algeriaLogOdds = logit(0.12); // prior: ~12% of arbitrary crawled storefronts are Algerian
  const algeriaReasons: string[] = [];

  if (isDzTld) {
    algeriaLogOdds += 1.7;
    algeriaReasons.push('.dz TLD');
  }

  const cod = detectCodPhrases(input.text);
  const codWeight = sum(cod.map((entry) => entry.weight));
  if (cod.length > 0) {
    algeriaLogOdds += Math.min(codWeight, 4.0);
    algeriaReasons.push(`COD phrases: ${cod.map((c) => c.phrase).join(', ')}`);
  }

  const currency = detectCurrency(input.text);
  if (currency.currency === 'DZD') {
    algeriaLogOdds += 2.1;
    algeriaReasons.push('DZD currency');
  }

  const wilaya = wilayaCoverage(input.text);
  const wilayaCount = wilaya.matched.length;
  if (wilayaCount >= 5) {
    algeriaLogOdds += Math.min(2.6, 1.1 + 0.09 * wilayaCount);
    algeriaReasons.push(`${wilayaCount} wilayas referenced`);
  } else if (wilayaCount >= 2) {
    algeriaLogOdds += 0.9;
    algeriaReasons.push(`${wilayaCount} wilayas referenced`);
  }

  const dzPhones = extractAllAlgerianPhones(input.text);
  const dzPhoneCount = Math.max(input.dzPhoneCount, dzPhones.length);
  if (dzPhoneCount > 0) {
    algeriaLogOdds += dzPhoneCount >= 2 ? 2.4 : 1.8;
    algeriaReasons.push(`${dzPhoneCount} DZ phone(s)`);
  }

  if (input.language.dominant === 'ar_dz') {
    algeriaLogOdds += 1.2;
    algeriaReasons.push('Darija-dominant content');
  } else if (input.language.dominant === 'fr') {
    algeriaLogOdds += 0.4;
    algeriaReasons.push('French-dominant content');
  } else if (input.language.dominant === 'ar_msa') {
    algeriaLogOdds += 0.6;
    algeriaReasons.push('Arabic content');
  }

  let storeLogOdds = logit(0.2);
  const products = input.productCount ?? 0;
  if (products > 0) {
    storeLogOdds += Math.min(3.4, 0.9 + Math.log1p(products) / 2.2);
  }
  if (input.hasCart) storeLogOdds += 1.3;
  if (input.hasCheckout) storeLogOdds += 1.1;
  if (input.hasPrices) storeLogOdds += 0.9;
  if (cod.length > 0) storeLogOdds += 1.2;
  if (currency.currency === 'DZD') storeLogOdds += 0.8;

  return {
    pAlgeria: safeProb(sigmoid(Math.max(-8, Math.min(8, algeriaLogOdds)))),
    pSellsPhysicalGoodsOnline: safeProb(sigmoid(Math.max(-8, Math.min(8, storeLogOdds)))),
    codPhrases: cod.map((entry) => entry.phrase),
    currency: currency.currency,
    currencyConfidence: currency.confidence,
    wilayaCoverage: wilaya.coverage,
    wilayaMatches: wilaya.matched,
    isDzTld,
    dzPhoneCount,
    algeriaLogOdds,
    storeLogOdds,
  };
}
