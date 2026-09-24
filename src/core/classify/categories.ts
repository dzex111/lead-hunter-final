import { CATEGORY_LEXICONS, CATEGORY_PRIORS } from '@/core/data/lexicons';
import { matchKey } from '@/core/normalize/text';
import { CATEGORY_IDS, type CategoryId, type CategoryPrediction, type CategoryScore } from '@/core/types';
import { logSumExp } from '@/core/util';

/**
 * Multi-label naive Bayes category classifier over ar/fr/en lexicons.
 *
 * Bernoulli NB in log-space with presence weights:
 *   log p(c | x) ∝ log π_c + Σ_t w_t [ x_t log(p_tc / (1 - p_tc)) + log(1 - p_tc) ]
 * where p_tc is the token presence probability inside category c (lexicon tokens
 * get a high pseudo-count, everything else the background rate).
 */
export const CATEGORY_MODEL_VERSION = 'cat-nb-2026-01';

export const LEXICON_PRESENCE = 0.32;
export const BACKGROUND_PRESENCE = 0.004;
export const TOKEN_WEIGHT_CAP = 3;

export interface CategoryInput {
  /** Merchant text: product titles, page copy, meta description, handle names. */
  text: string;
  topN?: number;
  abstainThreshold?: number;
  abstainMargin?: number;
}

const LEXICON_MATCH_KEYS: Record<CategoryId, Set<string>> = (() => {
  const out = {} as Record<CategoryId, Set<string>>;
  for (const category of CATEGORY_IDS) {
    const lex = CATEGORY_LEXICONS[category];
    const keys = new Set<string>();
    for (const phrase of [...lex.ar, ...lex.fr, ...lex.en]) keys.add(matchKey(phrase));
    out[category] = keys;
  }
  return out;
})();

export function categoryTokenHits(text: string): Record<CategoryId, string[]> {
  const key = ` ${matchKey(text)} `;
  const out = {} as Record<CategoryId, string[]>;
  for (const category of CATEGORY_IDS) {
    const hits: string[] = [];
    for (const token of LEXICON_MATCH_KEYS[category]) {
      if (token.length < 3) continue;
      if (key.includes(` ${token} `) || key.includes(`${token} `) || key.includes(` ${token}`)) {
        hits.push(token);
      }
    }
    out[category] = hits;
  }
  return out;
}

export function classifyCategories(input: CategoryInput): CategoryPrediction {
  const hits = categoryTokenHits(input.text);
  const scores: CategoryScore[] = [];
  const logLikelihoods: number[] = [];

  for (const category of CATEGORY_IDS) {
    const hitCount = hits[category].length;
    const weight = Math.min(TOKEN_WEIGHT_CAP, hitCount);
    const p = LEXICON_PRESENCE;
    const logLr = Math.log(p / (1 - p)) - Math.log(BACKGROUND_PRESENCE / (1 - BACKGROUND_PRESENCE));
    const logPrior = Math.log(CATEGORY_PRIORS[category]);
    // Phrase evidence only: absence of a token is weak information for 11 labels,
    // so we keep the "absence" term out of the score (documented in docs/MATH.md).
    const score = logPrior + weight * logLr;
    logLikelihoods.push(score);
  }

  const lse = logSumExp(logLikelihoods);
  CATEGORY_IDS.forEach((category, index) => {
    const score = logLikelihoods[index] ?? 0;
    scores.push({ category, probability: Math.exp(score - lse) });
  });

  const ranked = scores.sort((a, b) => b.probability - a.probability).slice(0, input.topN ?? 3);
  const lead = ranked[0]?.probability ?? 0;
  const second = ranked[1]?.probability ?? 0;
  const threshold = input.abstainThreshold ?? 0.35;
  const marginThreshold = input.abstainMargin ?? 0.06;
  const totalHits = CATEGORY_IDS.reduce((acc, category) => acc + hits[category].length, 0);
  const abstained = totalHits === 0 || lead < threshold || lead - second < marginThreshold;

  return { top: ranked, abstained };
}

export function topCategory(prediction: CategoryPrediction): CategoryId {
  return prediction.top[0]?.category ?? 'other';
}
