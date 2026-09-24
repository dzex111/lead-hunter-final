import { syntheticPopulation, type SyntheticMerchant } from '@/adapters/sources/demo';
import { FEATURE_NAMES, EXPERT_PRIORS, buildFeatureVector, type FeatureInput, type FeatureName } from '@/core/features';
import { fitLogistic, predictiveProbability, ucbScore } from '@/core/math/logistic';
import { brierScore, expectedCalibrationError, logLoss, reliabilityBins } from '@/core/math/metrics';
import { createRng, type Rng } from '@/core/random';
import { clamp, sigmoid } from '@/core/util';
import type { CategoryId, PlatformId } from '@/core/types';

/**
 * Simulation harness: a synthetic merchant population with HIDDEN ground-truth
 * coefficients (`TRUE_BETA`, never shown to the model). The loop runs the real
 * cold-start → MAP-refit → ranking machinery for N sends and reports:
 *   - calibration (Brier / log-loss / ECE + reliability bins)
 *   - learned-vs-true beta error
 *   - uplift and cumulative regret of the ranked queue vs uniform random
 */
export interface SimOptions {
  sends: number;
  population: number;
  seed: number;
}

/** Hidden ground truth: the model never sees these numbers. */
export const TRUE_BETA: Record<FeatureName, number> = {
  bias: -2.35,
  is_advertiser_fresh: 0.95,
  log_ad_count: 0.28,
  sells_cod: 0.75,
  has_direct_whatsapp: 0.85,
  has_messenger_or_ig: -0.15,
  platform_shopify: 0.2,
  platform_youcan: 0.42,
  platform_woocommerce: 0.1,
  platform_other: -0.05,
  category_fashion: 0.3,
  category_beauty: 0.45,
  category_phones: 0.15,
  category_other: 0.0,
  maturity_index: -0.3,
  log_catalog_size: 0.35,
  pixel_meta: 0.5,
  pixel_tiktok: 0.35,
  language_arabic: 0.55,
  language_french: -0.2,
  channel_whatsapp: 0.7,
  channel_social: -0.35,
  hour_afternoon: 0.12,
  hour_evening: 0.08,
  sender_warmup: -0.4,
};

function toFeatureInput(merchant: SyntheticMerchant, now: Date, seed: number): FeatureInput {
  const rng = createRng(seed + merchant.id.length * 7919 + merchant.products);
  return {
    isAdvertiser: merchant.isAdvertiser,
    advertiserFirstSeenAt: merchant.isAdvertiser ? new Date(now.getTime() - rng.next() * 40 * 86_400_000) : null,
    adCount: merchant.isAdvertiser ? 1 + rng.int(12) : null,
    sellsCod: merchant.sellsCod,
    directWhatsapp: merchant.hasWhatsapp,
    platform: merchant.platform as PlatformId,
    category: merchant.category as CategoryId,
    maturityIndex: merchant.maturityIndex,
    productCount: merchant.products,
    pixelMeta: merchant.pixelMeta,
    pixelTiktok: merchant.pixelTiktok,
    languageDominant: merchant.language,
    preferredChannel: merchant.hasWhatsapp ? 'whatsapp' : 'instagram',
    hourOfDayAlgiers: 9 + (merchant.products % 12),
    senderWarmupProgress: 1,
    now,
  };
}

export function runSimulation(options: SimOptions): string {
  const { sends, population, seed } = options;
  const merchants = syntheticPopulation(population, seed);
  const now = new Date('2026-01-15T10:00:00.000Z');
  const trueBeta = FEATURE_NAMES.map((name) => TRUE_BETA[name]);
  const priors = FEATURE_NAMES.map((name) => EXPERT_PRIORS[name]);
  const priorBeta = priors.map((prior) => prior.mean);

  const X = merchants.map((merchant) => buildFeatureVector(toFeatureInput(merchant, now, seed)).values);
  const dimension = X[0]?.length ?? FEATURE_NAMES.length;
  const identity: number[][] = Array.from({ length: dimension }, (_value, i) =>
    Array.from({ length: dimension }, (_other, j) => (i === j ? 1 : 0)),
  );
  const trueP = X.map((row) => clamp(predictiveProbability(row, trueBeta, identity), 0.02, 0.95));
  const bestP = Math.max(...trueP);

  interface Observation {
    x: number[];
    y: 0 | 1;
    pPred: number;
  }
  const observations: Observation[] = [];
  let model = { beta: [...priorBeta], covariance: identity };

  const warmupSends = 30;
  const refitEvery = 50;
  const rankedRng: Rng = createRng(seed + 13);
  const uniformRng: Rng = createRng(seed + 29);
  const outcomeRng: Rng = createRng(seed + 97);

  const regretRanked: number[] = [];
  const regretUniform: number[] = [];
  let rankedReward = 0;
  let uniformReward = 0;
  const poolOffsets: number[] = [];

  for (let round = 0; round < sends; round += 1) {
    if (round === warmupSends || round % refitEvery === 0) {
      if (observations.length >= warmupSends) {
        const fit = fitLogistic(
          observations.map((entry) => entry.x),
          observations.map((entry) => entry.y),
          { priors, maxIterations: 150 },
        );
        if (fit.beta.every((value) => Number.isFinite(value))) {
          model = { beta: fit.beta, covariance: fit.covariance };
        }
      }
    }

    // ---- Ranked arm: UCB over the pool (rank + decayed exploration) ----
    let rankedIndex = 0;
    let bestPrediction = -1;
    let bestUcb = -1;
    for (let index = 0; index < X.length; index += 1) {
      const row = X[index];
      if (!row) continue;
      const score = ucbScore(row, model.beta, model.covariance, observations.length);
      if (score.ucb > bestUcb) {
        bestUcb = score.ucb;
        rankedIndex = index;
        bestPrediction = score.p;
      }
    }
    poolOffsets.push(rankedIndex);
    const rankedTruth = trueP[rankedIndex] ?? 0.1;
    const rankedOutcome = outcomeRng.next() < rankedTruth ? 1 : 0;
    rankedReward += rankedOutcome;
    const rankedRow = X[rankedIndex];
    if (rankedRow) {
      observations.push({ x: rankedRow, y: rankedOutcome as 0 | 1, pPred: bestPrediction });
    }

    // ---- Uniform arm: same population, random pick ----
    const uniformIndex = uniformRng.int(X.length);
    const uniformTruth = trueP[uniformIndex] ?? 0.1;
    const uniformOutcome = uniformRng.next() < uniformTruth ? 1 : 0;
    uniformReward += uniformOutcome;

    regretRanked.push(Math.max(0, bestP - rankedTruth));
    regretUniform.push(Math.max(0, bestP - uniformTruth));
  }
  const distinctPicks = new Set(poolOffsets).size;

  const labeled = observations.map((entry) => ({ p: entry.pPred, y: entry.y }));
  const bins = reliabilityBins(labeled, 10).filter((bin) => bin.count > 0);
  const betaError =
    model.beta.reduce((acc, value, index) => acc + Math.abs(value - (trueBeta[index] ?? 0)), 0) / model.beta.length;
  const priorError =
    model.beta.reduce((acc, value, index) => acc + Math.abs(value - (priorBeta[index] ?? 0)), 0) / model.beta.length;
  const rankedAvg = rankedReward / sends;
  const uniformAvg = uniformReward / sends;
  const meanTrue = trueP.reduce((acc, value) => acc + value, 0) / trueP.length;

  const lines: string[] = [];
  lines.push('Lead Hunter simulation report (hidden ground truth)');
  lines.push(`population=${population} merchants · sends=${sends} · seed=${seed}`);
  lines.push('');
  lines.push('calibration (ranked arm, out-of-sample after each refit):');
  lines.push(`  Brier      = ${brierScore(labeled).toFixed(4)}`);
  lines.push(`  log-loss   = ${logLoss(labeled).toFixed(4)}`);
  lines.push(`  ECE (10b)  = ${expectedCalibrationError(labeled, 10).toFixed(4)}`);
  lines.push('  reliability bins (predicted → observed, n):');
  for (const bin of bins.slice(0, 6)) {
    lines.push(
      `    ${bin.lower.toFixed(1)}-${bin.upper.toFixed(1)}  ${bin.meanPredicted.toFixed(3)} → ${bin.observedRate.toFixed(3)}  gap=${bin.gap >= 0 ? '+' : ''}${bin.gap.toFixed(3)}  n=${bin.count}`,
    );
  }
  lines.push('');
  lines.push('learning:');
  lines.push(`  mean |β_learned − β_true|  = ${betaError.toFixed(4)}  (25 features, hidden ground truth)`);
  lines.push(`  mean |β_learned − β_prior| = ${priorError.toFixed(4)}  (β moved away from the priors)`);
  lines.push('');
  lines.push('queue strategy (same population, same horizon):');
  lines.push(`  ranked/UCB average true reply rate = ${rankedAvg.toFixed(4)}`);
  lines.push(`  uniform random average             = ${uniformAvg.toFixed(4)}`);
  lines.push(`  population average                 = ${meanTrue.toFixed(4)}`);
  lines.push(`  uplift ranked vs uniform           = ${(((rankedAvg - uniformAvg) / Math.max(uniformAvg, 1e-9)) * 100).toFixed(1)}%`);
  lines.push(
    `  cumulative regret ranked=${regretRanked.reduce((acc, value) => acc + value, 0).toFixed(2)} vs uniform=${regretUniform.reduce((acc, value) => acc + value, 0).toFixed(2)} (vs best-known arm ${bestP.toFixed(3)})`,
  );
  lines.push(`  exploration still alive: ${distinctPicks} distinct merchants picked by the ranked/UCB arm`);
  lines.push('');
  lines.push(`sigmoid sanity: σ(prior bias)=${sigmoid(EXPERT_PRIORS.bias.mean).toFixed(3)} (documented cold-start reply rate)`);
  return lines.join('\n');
}


