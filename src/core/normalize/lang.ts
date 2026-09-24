import {
  DIALECT_MARKERS_AR_DZ,
  MARKERS_AR_MSA,
  MARKERS_EN,
  MARKERS_FR,
} from '@/core/data/lexicons';
import { tokens } from '@/core/normalize/text';
import type { LanguageDistribution, LanguageId } from '@/core/types';
import { softmax } from '@/core/util';

interface Counts {
  arabicChars: number;
  latinChars: number;
  digits: number;
  total: number;
}

export function scriptCounts(input: string): Counts {
  let arabicChars = 0;
  let latinChars = 0;
  let digits = 0;
  let total = 0;
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (/\s/.test(char)) continue;
    total += 1;
    if (code >= 0x0600 && code <= 0x06ff) arabicChars += 1;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x00c0 && code <= 0x024f)) latinChars += 1;
    else if (code >= 0x30 && code <= 0x39) digits += 1;
  }
  return { arabicChars, latinChars, digits, total };
}

function markerHits(wordSet: Set<string>, markers: readonly string[]): number {
  let hits = 0;
  for (const marker of markers) {
    if (wordSet.has(marker)) hits += 1;
  }
  return hits;
}

/**
 * Language / dialect distribution from script ratios + lexicon markers.
 * Returns probabilities over {ar_msa, ar_dz, fr, en, mixed} that always sum to 1.
 */
export function detectLanguage(input: string): LanguageDistribution {
  const counts = scriptCounts(input);
  const wordList = tokens(input);
  const wordSet = new Set(wordList);
  const words = Math.max(1, wordList.length);

  const arabicShare = counts.total === 0 ? 0 : counts.arabicChars / counts.total;
  const latinShare = counts.total === 0 ? 0 : counts.latinChars / counts.total;

  const dzHits = markerHits(wordSet, DIALECT_MARKERS_AR_DZ);
  const msaHits = markerHits(wordSet, MARKERS_AR_MSA);
  const frHits = markerHits(wordSet, MARKERS_FR);
  const enHits = markerHits(wordSet, MARKERS_EN);

  const logits: Record<LanguageId, number> = {
    ar_msa: Math.log(0.05 + arabicShare) + 0.9 * msaHits + (dzHits === 0 ? 0.4 : 0),
    ar_dz: Math.log(0.05 + arabicShare) + 1.25 * dzHits,
    fr: Math.log(0.05 + latinShare) + 0.55 * frHits + (frHits > 0 ? 0.3 : 0),
    en: Math.log(0.05 + latinShare) + 0.5 * enHits,
    mixed: 0.25 + (arabicShare > 0.15 && latinShare > 0.15 ? 2.4 : 0) + (dzHits > 1 && frHits > 1 ? 1.2 : 0),
  };

  const order: LanguageId[] = ['ar_msa', 'ar_dz', 'fr', 'en', 'mixed'];
  const probs = softmax(order.map((key) => logits[key]));
  const distribution: LanguageDistribution = {
    ar_msa: 0,
    ar_dz: 0,
    fr: 0,
    en: 0,
    mixed: 0,
    dominant: 'mixed',
  };
  let best: { id: LanguageId; p: number } = { id: 'mixed', p: -1 };
  order.forEach((id, index) => {
    const p = probs[index] ?? 0;
    distribution[id] = p;
    if (p > best.p) best = { id, p };
  });
  // Arabic script with strong Darija markers should not be labelled "mixed" just
  // because MSA and Darija both score non-zero.
  if (best.id === 'mixed' && arabicShare > 0.35 && dzHits > msaHits) best = { id: 'ar_dz', p: distribution.ar_dz };
  distribution.dominant = best.id;
  return distribution;
}

export function languageOf(input: string): LanguageId {
  return detectLanguage(input).dominant;
}
