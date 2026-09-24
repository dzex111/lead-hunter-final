import type { Rng } from '@/core/random';
import { clamp } from '@/core/util';

/**
 * Beta-Binomial machinery: Wilson intervals, empirical-Bayes kappa,
 * hierarchical partial pooling and Thompson sampling.
 */

export function betaMean(a: number, b: number): number {
  const denom = a + b;
  return denom <= 0 ? 0.5 : a / denom;
}

export function betaVariance(a: number, b: number): number {
  const denom = a + b;
  if (denom <= 0) return 0;
  return (a * b) / (denom * denom * (denom + 1));
}

const FPMIN = 1e-30;
const BETA_EPS = 3e-14;
const BETA_MAX_ITER = 400;

/** Lentz continued fraction for the incomplete beta function (Numerical Recipes 6.4). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= BETA_MAX_ITER; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < BETA_EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b): the Beta CDF used for credible bounds. */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logBeta(a, b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta);
  if (x < (a + 1) / (a + b + 2)) {
    return clamp((front * betaContinuedFraction(a, b, x)) / a, 0, 1);
  }
  return clamp(1 - (front * betaContinuedFraction(b, a, 1 - x)) / b, 0, 1);
}

function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

export function logGamma(z: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const zz = z - 1;
  let x = 0.99999999999980993;
  coefficients.forEach((coefficient, index) => {
    x += coefficient / (zz + index + 1);
  });
  const t = zz + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

export function betaQuantile(a: number, b: number, q: number): number {
  const target = clamp(q, 1e-6, 1 - 1e-6);
  let low = 0;
  let high = 1;
  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2;
    const cdf = regularizedIncompleteBeta(mid, a, b);
    if (cdf < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export function betaLowerBound(a: number, b: number, level = 0.95): number {
  return betaQuantile(a, b, 1 - level);
}

export function betaUpperBound(a: number, b: number, level = 0.95): number {
  return betaQuantile(a, b, level);
}

export function wilsonInterval(
  successCount: number,
  n: number,
  z = 1.959964,
): { lower: number; upper: number; centre: number } {
  if (n <= 0 || !Number.isFinite(n)) return { lower: 0, upper: 1, centre: 0.5 };
  // NaN-proof and out-of-range-proof: successes are clamped into [0, n].
  const successes = clamp(Number.isFinite(successCount) ? successCount : 0, 0, n);
  const phat = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (phat + (z * z) / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return { lower: clamp(centre - margin, 0, 1), upper: clamp(centre + margin, 0, 1), centre };
}

export function wilsonLowerBound(successes: number, n: number, z = 1.959964): number {
  return wilsonInterval(successes, n, z).lower;
}

export function wilsonUpperBound(successes: number, n: number, z = 1.959964): number {
  return wilsonInterval(successes, n, z).upper;
}

export interface SegmentCounts {
  key: string;
  successes: number;
  n: number;
}

/**
 * Empirical-Bayes kappa (method of moments) for a Beta-Binomial hierarchy:
 *   Var(segment rates) ≈ p(1-p) * E[1/(n + kappa)]⁻¹ law-of-total-variance style
 * We use the standard MoM approximation with the mean segment size:
 *   kappa ≈ p(1-p) / Var_obs - n̄        (clamped to >= 0)
 */
export function empiricalBayesKappa(segments: readonly SegmentCounts[]): number {
  const usable = segments.filter((segment) => segment.n > 0);
  if (usable.length < 2) return 0;
  const totalN = usable.reduce((acc, segment) => acc + segment.n, 0);
  const totalSuccesses = usable.reduce((acc, segment) => acc + segment.successes, 0);
  if (totalN === 0) return 0;
  const pooled = totalSuccesses / totalN;
  const meanN = totalN / usable.length;
  const rates = usable.map((segment) => segment.successes / segment.n);
  const meanRate = rates.reduce((acc, rate) => acc + rate, 0) / rates.length;
  const variance =
    rates.reduce((acc, rate) => acc + (rate - meanRate) * (rate - meanRate), 0) / Math.max(1, rates.length - 1);
  const samplingVariance = (pooled * (1 - pooled)) / Math.max(meanN, 1);
  const betweenVariance = variance - samplingVariance;
  if (betweenVariance <= 1e-9) return 0;
  // Beta-Binomial MoM: Var_between = p(1-p) / (kappa + 1) ⇒ kappa = p(1-p)/Var_between - 1
  const kappa = (pooled * (1 - pooled)) / betweenVariance - 1;
  return clamp(kappa, 0, 5000);
}

/** Hierarchical partial pooling of a segment toward the global parent rate. */
export function partialPool(
  successes: number,
  n: number,
  globalRate: number,
  kappa: number,
  extraPrior = 0,
): { alpha: number; beta: number; mean: number } {
  const rate = clamp(globalRate, 1e-4, 1 - 1e-4);
  const priorStrength = kappa + extraPrior;
  const alpha = priorStrength * rate + successes + 0.5;
  const beta = priorStrength * (1 - rate) + (n - successes) + 0.5;
  return { alpha, beta, mean: betaMean(alpha, beta) };
}

export interface FunnelStagePosterior {
  stage: string;
  alpha: number;
  beta: number;
  mean: number;
  lower: number;
  upper: number;
  n: number;
  successes: number;
  pooledKappa: number;
}

export function funnelStagePosterior(
  stage: string,
  segments: readonly SegmentCounts[],
  own: SegmentCounts,
  globalRate: number,
  kappa: number,
): FunnelStagePosterior {
  const { alpha, beta } = partialPool(own.successes, own.n, globalRate, kappa);
  void segments;
  return {
    stage,
    alpha,
    beta,
    mean: betaMean(alpha, beta),
    lower: betaLowerBound(alpha, beta, 0.95),
    upper: betaUpperBound(alpha, beta, 0.95),
    n: own.n,
    successes: own.successes,
    pooledKappa: kappa,
  };
}

export function thompsonSampleBeta(a: number, b: number, rng: Rng): number {
  return rng.beta(a, b);
}

/**
 * Thompson sampling for template variants: draw from Beta(posterior), with an
 * exploration floor so a variant never has a zero chance of being tried.
 */
export function selectVariantThompson(
  variants: readonly { id: string; successes: number; failures: number; explorationFloor?: number }[],
  rng: Rng,
  options: { floor?: number; explorationRate?: number } = {},
): { id: string; sampled: number; exploration: boolean } {
  if (variants.length === 0) throw new Error('no variants to select from');
  const explorationRate = options.explorationRate ?? 0.1;
  const exploring = rng.next() < explorationRate;
  if (exploring) {
    const picked = rng.pick(variants);
    return { id: picked.id, sampled: betaMean(picked.successes + 1, picked.failures + 1), exploration: true };
  }
  let best: { id: string; sampled: number } | null = null;
  for (const variant of variants) {
    const sampled = rng.beta(variant.successes + 1, variant.failures + 1);
    if (!best || sampled > best.sampled) best = { id: variant.id, sampled };
  }
  const winner = best ?? { id: variants[0]!.id, sampled: 0 };
  return { id: winner.id, sampled: winner.sampled, exploration: false };
}

/** Retire a variant only when its Wilson upper bound is below the baseline lower bound. */
export function shouldRetireVariant(
  variant: { successes: number; failures: number },
  baseline: { successes: number; failures: number },
  minSamples = 40,
): boolean {
  const n = variant.successes + variant.failures;
  if (n < minSamples) return false;
  const upper = wilsonUpperBound(variant.successes, n);
  const baselineN = baseline.successes + baseline.failures;
  const lower = wilsonInterval(baseline.successes, baselineN).lower;
  return upper < lower;
}
