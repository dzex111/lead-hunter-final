import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fuseEvidence, logLrToConfidence } from '@/core/math/fusion';
import {
  fitLogistic,
  linearPredictor,
  predictiveProbability,
  predictiveVariance,
  samplePosterior,
  ucbScore,
} from '@/core/math/logistic';
import {
  betaLowerBound,
  betaMean,
  betaQuantile,
  betaVariance,
  empiricalBayesKappa,
  partialPool,
  regularizedIncompleteBeta,
  selectVariantThompson,
  shouldRetireVariant,
  wilsonInterval,
} from '@/core/math/beta';
import {
  brierScore,
  expectedCalibrationError,
  logLoss,
  reliabilityBins,
  rocAuc,
} from '@/core/math/metrics';
import { DEFAULT_EV_CONFIG, effortForChannel, expectedValue, priorityScore } from '@/core/math/ev';
import { buildFeatureVector, contributionsOf } from '@/core/features';
import { createRng } from '@/core/random';
import { sigmoid } from '@/core/util';

describe('evidence fusion', () => {
  it('produces a normalized posterior for every hypothesis', () => {
    const result = fuseEvidence(
      [
        { hypothesis: 'shopify', logLr: 3.2, clusterId: 'assets' },
        { hypothesis: 'shopify', logLr: 4.2, clusterId: 'inline' },
        { hypothesis: 'youcan', logLr: 1.2, clusterId: 'brand' },
      ],
      { priors: { shopify: 0.28, youcan: 0.09, custom: 0.17, none: 0.08 } },
    );
    const total = Object.values(result.probabilities).reduce((acc, value) => acc + value, 0);
    expect(total).toBeCloseTo(1, 8);
    expect(result.best).toBe('shopify');
    expect(result.entropyBits).toBeGreaterThanOrEqual(0);
    expect(result.margin).toBeCloseTo(
      (result.probabilities['shopify'] ?? 0) - (result.probabilities['youcan'] ?? 0),
      8,
    );
  });

  it('is monotone in supporting evidence (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.1, max: 5, noNaN: true }), (logLr) => {
        const base = fuseEvidence([{ hypothesis: 'a', logLr: 1, clusterId: 'x' }], { priors: { a: 0.5, b: 0.5 } });
        const more = fuseEvidence(
          [
            { hypothesis: 'a', logLr: 1, clusterId: 'x' },
            { hypothesis: 'a', logLr, clusterId: 'y' },
          ],
          { priors: { a: 0.5, b: 0.5 } },
        );
        expect(more.probabilities['a'] ?? 0).toBeGreaterThanOrEqual(base.probabilities['a'] ?? 0);
      }),
      { numRuns: 100 },
    );
  });

  it('caps correlated evidence inside one cluster', () => {
    const capped = fuseEvidence(
      [
        { hypothesis: 'a', logLr: 4, clusterId: 'same' },
        { hypothesis: 'a', logLr: 4, clusterId: 'same' },
        { hypothesis: 'a', logLr: 4, clusterId: 'same' },
      ],
      { priors: { a: 0.5, b: 0.5 }, clusterCapLogLr: 4.5 },
    );
    expect(capped.contributions['a']).toBeCloseTo(4.5, 8);
    const uncapped = fuseEvidence(
      [
        { hypothesis: 'a', logLr: 4, clusterId: 'c1' },
        { hypothesis: 'a', logLr: 4, clusterId: 'c2' },
        { hypothesis: 'a', logLr: 4, clusterId: 'c3' },
      ],
      { priors: { a: 0.5, b: 0.5 }, clusterCapLogLr: 4.5 },
    );
    expect(uncapped.probabilities['a'] ?? 0).toBeGreaterThan(capped.probabilities['a'] ?? 0);
  });

  it('abstains on weak or ambiguous evidence', () => {
    const ambiguous = fuseEvidence(
      [
        { hypothesis: 'a', logLr: 0.2, clusterId: 'x' },
        { hypothesis: 'b', logLr: 0.2, clusterId: 'y' },
      ],
      { priors: { a: 0.5, b: 0.5 } },
    );
    expect(ambiguous.abstained).toBe(true);
    expect(logLrToConfidence(4.5)).toBeGreaterThan(0.95);
  });
});

describe('Bayesian logistic regression', () => {
  const rng = createRng(7);
  const truth = [-1.6, 1.1, -0.5];
  const rows = Array.from({ length: 4000 }, () => {
    const x1 = rng.normal();
    const x2 = rng.normal() * 0.6;
    const z = truth[0]! * 1 + truth[1]! * x1 + truth[2]! * x2;
    const p = sigmoid(z);
    return { x: [1, x1, x2], y: rng.next() < p ? 1 : 0 };
  });

  it('recovers known betas from synthetic data', () => {
    const fit = fitLogistic(rows.map((row) => row.x), rows.map((row) => row.y), {
      priors: [
        { mean: 0, sd: 5 },
        { mean: 0, sd: 5 },
        { mean: 0, sd: 5 },
      ],
      maxIterations: 200,
    });
    expect(fit.converged).toBe(true);
    truth.forEach((value, index) => {
      expect(Math.abs((fit.beta[index] ?? 0) - value)).toBeLessThan(0.2);
    });
    expect(fit.standardErrors.every((value) => value >= 0 && Number.isFinite(value))).toBe(true);
  });

  it('shrinks toward the prior when data is scarce', () => {
    const fit = fitLogistic(
      [
        [1, 1],
        [1, -1],
        [1, 0.5],
      ],
      [1, 1, 1],
      {
        priors: [
          { mean: -2, sd: 0.4 },
          { mean: 0, sd: 0.4 },
        ],
      },
    );
    expect(fit.beta[1] ?? 0).toBeGreaterThan(-1);
  });

  it('predicts with the probit approximation: variance shrinks predictions toward 0.5', () => {
    const tight = [
      [0.01, 0],
      [0, 0.01],
    ];
    const wide = [
      [1, 0],
      [0, 1],
    ];
    const x = [1, 0.5];
    const positiveBeta = [1.9, 0.8];
    const negativeBeta = [-1.9, 0.8];
    expect(predictiveProbability(x, positiveBeta, tight)).toBeGreaterThan(
      predictiveProbability(x, positiveBeta, wide),
    );
    expect(predictiveProbability(x, negativeBeta, tight)).toBeLessThan(
      predictiveProbability(x, negativeBeta, wide),
    );
    expect(predictiveVariance(x, wide)).toBeGreaterThan(predictiveVariance(x, tight));
    expect(linearPredictor(x, negativeBeta)).toBeCloseTo(-1.5, 8);
  });

  it('UCB bonus decays as observations accumulate and sampling is deterministic', () => {
    const beta = [-2, 0.5];
    const cov = [
      [0.5, 0],
      [0, 0.5],
    ];
    const early = ucbScore([1, 1], beta, cov, 0);
    const late = ucbScore([1, 1], beta, cov, 300);
    expect(early.kappa).toBeGreaterThan(late.kappa);
    expect(early.ucb).toBeGreaterThan(late.ucb);
    const a = samplePosterior(beta, cov, createRng(3));
    const b = samplePosterior(beta, cov, createRng(3));
    expect(a).toEqual(b);
  });
});

describe('Beta-Binomial, Wilson and template bandit', () => {
  it('matches reference values', () => {
    expect(betaMean(2, 3)).toBeCloseTo(0.4, 10);
    expect(betaVariance(2, 3)).toBeCloseTo(0.04, 10);
    expect(regularizedIncompleteBeta(0.5, 2, 2)).toBeCloseTo(0.5, 6);
    expect(betaQuantile(2, 2, 0.5)).toBeCloseTo(0.5, 4);
    expect(betaLowerBound(2, 2, 0.95)).toBeLessThan(0.5);

    const wilson = wilsonInterval(1, 10);
    expect(wilson.lower).toBeCloseTo(0.0179, 3);
    expect(wilson.upper).toBeCloseTo(0.4042, 3);
    expect(wilsonInterval(0, 10).lower).toBe(0);
    expect(wilsonInterval(0, 0).upper).toBe(1);

    const posterior = partialPool(5, 10, 0.2, 20);
    expect(posterior.mean).toBeGreaterThan(0.2);
    expect(posterior.mean).toBeLessThan(0.5);
  });

  it('estimates kappa by method of moments', () => {
    const homogeneous = empiricalBayesKappa([
      { key: 'a', successes: 50, n: 100 },
      { key: 'b', successes: 51, n: 100 },
      { key: 'c', successes: 49, n: 100 },
    ]);
    const heterogeneous = empiricalBayesKappa([
      { key: 'a', successes: 5, n: 100 },
      { key: 'b', successes: 50, n: 100 },
      { key: 'c', successes: 95, n: 100 },
    ]);
    expect(homogeneous).toBeLessThan(heterogeneous);
    expect(heterogeneous).toBeGreaterThan(0);
  });

  it('assembles a Beta-Binomial funnel with partial pooling', () => {
    const mean = betaMean(1 + 10, 1 + 90);
    expect(mean).toBeGreaterThan(0.05);
    expect(mean).toBeLessThan(0.2);
  });

  it('Thompson-selects variants with an exploration floor and retires only with evidence', () => {
    const variants = [
      { id: 'a', successes: 20, failures: 5 },
      { id: 'b', successes: 3, failures: 20 },
    ];
    const counts: Record<string, number> = { a: 0, b: 0 };
    const rng = createRng(11);
    for (let i = 0; i < 400; i += 1) {
      const chosen = selectVariantThompson(variants, rng, { explorationRate: 0.1 });
      counts[chosen.id] = (counts[chosen.id] ?? 0) + 1;
    }
    expect(counts['a'] ?? 0).toBeGreaterThan(counts['b'] ?? 0);
    expect(counts['b'] ?? 0).toBeGreaterThan(10); // exploration floor keeps it alive

    expect(shouldRetireVariant({ successes: 1, failures: 60 }, { successes: 40, failures: 60 }, 40)).toBe(true);
    expect(shouldRetireVariant({ successes: 1, failures: 5 }, { successes: 40, failures: 60 }, 40)).toBe(false);
  });
});

describe('calibration metrics', () => {
  const items = [
    { p: 0.1, y: 0 as const },
    { p: 0.2, y: 0 as const },
    { p: 0.8, y: 1 as const },
    { p: 0.9, y: 1 as const },
  ];

  it('computes Brier, log-loss, ECE, AUC and reliability bins', () => {
    expect(brierScore(items)).toBeCloseTo((0.01 + 0.04 + 0.04 + 0.01) / 4, 8);
    expect(logLoss(items)).toBeGreaterThan(0);
    expect(expectedCalibrationError(items, 10)).toBeGreaterThanOrEqual(0);
    expect(rocAuc(items)).toBe(1);
    const bins = reliabilityBins(items, 5);
    expect(bins.reduce((acc, bin) => acc + bin.count, 0)).toBe(4);
  });
});

describe('expected value and priority', () => {
  it('multiplies the funnel and values paid customers with the ORDELY PRO baseline', () => {
    const ev = expectedValue(
      {
        pReply: 0.12,
        pInterestedGivenReply: 0.5,
        pSignupGivenInterested: 0.4,
        pActivateGivenSignup: 0.6,
        pPaidGivenActivate: 0.3,
      },
      DEFAULT_EV_CONFIG,
    );
    const expectedValuePerLead =
      0.12 * 0.5 * 0.4 * 0.6 * (0.3 * 899 * 3 + 0.7 * 0);
    expect(ev).toBeCloseTo(expectedValuePerLead, 6);
    expect(priorityScore(ev, 12)).toBeCloseTo(ev / 12, 10);
    expect(effortForChannel('whatsapp', { whatsapp: 40 })).toBeGreaterThan(DEFAULT_EV_CONFIG.effortSeconds.whatsapp);
    expect(effortForChannel('whatsapp', {})).toBe(12);
  });

  it('explains scores with per-feature contributions', () => {
    const vector = buildFeatureVector({
      isAdvertiser: true,
      advertiserFirstSeenAt: new Date('2026-01-01T00:00:00.000Z'),
      adCount: 4,
      sellsCod: true,
      directWhatsapp: true,
      platform: 'shopify',
      category: 'beauty',
      maturityIndex: 60,
      productCount: 80,
      pixelMeta: true,
      pixelTiktok: false,
      languageDominant: 'ar_dz',
      preferredChannel: 'whatsapp',
      hourOfDayAlgiers: 13,
      senderWarmupProgress: 1,
      now: new Date('2026-01-22T00:00:00.000Z'),
    });
    const contribution = vector.values[vector.names.indexOf('is_advertiser_fresh')];
    expect(contribution).toBeCloseTo(0.5, 2); // 21 days since first seen with a 21-day half-life
    const contributions = contributionsOf(vector, vector.values.map(() => 0.5));
    expect(contributions).toHaveLength(vector.names.length);
    expect(contributions.every((entry) => entry.contribution === 0.5 * entry.value)).toBe(true);
  });
});
