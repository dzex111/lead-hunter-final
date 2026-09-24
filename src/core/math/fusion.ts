import { logit, safeProb, sigmoid } from '@/core/util';

/**
 * Naive-Bayes evidence fusion in log-odds space.
 *
 *  posterior_log_odds(h) = prior_log_odds(h) + Σ_e logLR_e(h)
 *
 * Correlated evidence is handled per *cluster*: the absolute contribution a
 * cluster may add per hypothesis is capped, so ten Shopify markers inside the
 * same inline payload cannot outvote a single decisive header.
 */
export interface FusionEvidence {
  hypothesis: string;
  logLr: number;
  clusterId: string;
}

export interface FusionOptions {
  /** Prior probabilities per hypothesis (normalized internally). */
  priors: Record<string, number>;
  /** Cap of |Σ logLR| inside one (hypothesis, cluster) group. Default 4.5. */
  clusterCapLogLr?: number;
  /** Optional explicit penalties applied after fusion (parent/child platforms). */
  postPenalties?: readonly { hypothesis: string; logPenalty: number }[];
  /** Abstain below this posterior probability. */
  abstainThreshold?: number;
  /** Abstain below this margin between best and runner-up. */
  marginThreshold?: number;
}

export interface FusionResult {
  probabilities: Record<string, number>;
  logOdds: Record<string, number>;
  contributions: Record<string, number>;
  best: string;
  entropyBits: number;
  margin: number;
  abstained: boolean;
}

export function fuseEvidence(
  evidence: readonly FusionEvidence[],
  options: FusionOptions,
): FusionResult {
  const hypotheses = Object.keys(options.priors);
  const cap = options.clusterCapLogLr ?? 4.5;
  const logOdds: Record<string, number> = {};
  const contributions: Record<string, number> = {};

  const priorTotal = Object.values(options.priors).reduce((acc, p) => acc + Math.max(p, 1e-9), 0);
  for (const hypothesis of hypotheses) {
    const prior = Math.max(options.priors[hypothesis] ?? 1e-9, 1e-9) / priorTotal;
    logOdds[hypothesis] = logit(prior);
  }

  const grouped = new Map<string, number>();
  for (const item of evidence) {
    if (!hypotheses.includes(item.hypothesis)) continue;
    const key = `${item.hypothesis}::${item.clusterId}`;
    grouped.set(key, (grouped.get(key) ?? 0) + item.logLr);
  }
  for (const [key, total] of grouped) {
    const separator = key.indexOf('::');
    const hypothesis = key.slice(0, separator);
    const capped = Math.max(-cap, Math.min(cap, total));
    logOdds[hypothesis] = (logOdds[hypothesis] ?? 0) + capped;
    contributions[hypothesis] = (contributions[hypothesis] ?? 0) + capped;
  }

  for (const penalty of options.postPenalties ?? []) {
    if (logOdds[penalty.hypothesis] === undefined) continue;
    logOdds[penalty.hypothesis] = (logOdds[penalty.hypothesis] ?? 0) + penalty.logPenalty;
    contributions[penalty.hypothesis] =
      (contributions[penalty.hypothesis] ?? 0) + penalty.logPenalty;
  }

  // Numerically stable softmax over log-odds (equivalent to normalizing posteriors).
  let max = Number.NEGATIVE_INFINITY;
  for (const hypothesis of hypotheses) {
    const value = logOdds[hypothesis] ?? 0;
    if (value > max) max = value;
  }
  if (!Number.isFinite(max)) max = 0;
  const exps: number[] = [];
  for (const hypothesis of hypotheses) exps.push(Math.exp((logOdds[hypothesis] ?? 0) - max));
  const denom = exps.reduce((acc, value) => acc + value, 0) || 1;
  const probabilities: Record<string, number> = {};
  hypotheses.forEach((hypothesis, index) => {
    probabilities[hypothesis] = safeProb((exps[index] ?? 0) / denom);
  });

  const ranked = hypotheses
    .map((hypothesis) => ({ hypothesis, probability: probabilities[hypothesis] ?? 0 }))
    .sort((a, b) => b.probability - a.probability);
  const best = ranked[0]?.hypothesis ?? 'none';
  const bestP = ranked[0]?.probability ?? 1 / hypotheses.length;
  const secondP = ranked[1]?.probability ?? 0;
  const margin = bestP - secondP;

  let entropyBits = 0;
  for (const hypothesis of hypotheses) {
    const p = probabilities[hypothesis] ?? 0;
    if (p > 0) entropyBits -= p * Math.log2(p);
  }

  const abstainThreshold = options.abstainThreshold ?? 0.55;
  const marginThreshold = options.marginThreshold ?? 0.1;
  return {
    probabilities,
    logOdds,
    contributions,
    best,
    entropyBits,
    margin,
    abstained: bestP < abstainThreshold || margin < marginThreshold,
  };
}

/** Converts a single log-LR into a 0..1 confidence value for storage as a Signal. */
export function logLrToConfidence(logLr: number): number {
  return safeProb(sigmoid(logLr));
}
