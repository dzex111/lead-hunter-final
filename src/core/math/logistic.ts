import type { Rng } from '@/core/core-random-reexport';
import { cholesky, dot, invert, matVec, solve, type Matrix } from '@/core/math/linalg';
import { clamp, safeProb, sigmoid } from '@/core/util';

/**
 * Bayesian logistic regression with Gaussian priors, fitted by MAP via
 * Newton/IRLS with backtracking line search.
 *
 *   penalized log-likelihood:  ℓ(β) = Σ [y_i log p_i + (1-y_i) log(1-p_i)]
 *                                     - ½ Σ ((β_j - m_j) / s_j)²
 *   Newton step:               β ← β + H⁻¹ g
 *   H = XᵀWX + diag(1/s_j²),   g = Xᵀ(y - p) - diag(1/s_j²)(β - m)
 *   W = diag(p_i(1-p_i))
 *   Laplace covariance:        Σ ≈ H⁻¹
 *   Predictive probability:    p ≈ σ( μ / sqrt(1 + π s²/8) )   (probit approximation)
 */
export interface PriorSpec {
  mean: number;
  sd: number;
}

export interface FitOptions {
  priors: PriorSpec[];
  maxIterations?: number;
  tolerance?: number;
  /** Ridge term added to every diagonal entry of H (jitter for stability). */
  jitter?: number;
}

export interface FitResult {
  beta: number[];
  covariance: Matrix;
  standardErrors: number[];
  iterations: number;
  converged: boolean;
  penalizedLogLikelihood: number;
  n: number;
  positiveRate: number;
}

export function penalizedLogLikelihood(
  X: readonly number[][],
  y: readonly number[],
  beta: readonly number[],
  priors: readonly PriorSpec[],
): number {
  let total = 0;
  for (let i = 0; i < X.length; i += 1) {
    const row = X[i] ?? [];
    const p = safeProb(sigmoid(dot(row, beta)));
    const label = y[i] ?? 0;
    total += label === 1 ? Math.log(p) : Math.log(1 - p);
  }
  for (let j = 0; j < beta.length; j += 1) {
    const prior = priors[j] ?? { mean: 0, sd: 1 };
    const sd = Math.max(prior.sd, 1e-6);
    total -= 0.5 * Math.pow(((beta[j] ?? 0) - prior.mean) / sd, 2);
  }
  return total;
}

export function fitLogistic(
  X: readonly number[][],
  y: readonly number[],
  options: FitOptions,
): FitResult {
  const n = X.length;
  const d = X[0]?.length ?? options.priors.length;
  const jitter = options.jitter ?? 1e-6;
  const maxIterations = options.maxIterations ?? 100;
  const tolerance = options.tolerance ?? 1e-8;
  const priors = options.priors.slice(0, d);
  while (priors.length < d) priors.push({ mean: 0, sd: 1 });

  let beta: number[] = priors.map((prior) => prior.mean);
  let penalized = penalizedLogLikelihood(X, y, beta, priors);
  let converged = false;
  let iterations = 0;
  let hessian: Matrix = [];

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    iterations = iteration + 1;
    const gradient = new Array<number>(d).fill(0);
    const H: Matrix = Array.from({ length: d }, () => new Array<number>(d).fill(0));

    for (let i = 0; i < n; i += 1) {
      const row = X[i] ?? [];
      const p = safeProb(sigmoid(dot(row, beta)));
      const residual = (y[i] ?? 0) - p;
      const weight = Math.max(p * (1 - p), 1e-6);
      for (let j = 0; j < d; j += 1) {
        const xj = row[j] ?? 0;
        gradient[j] = (gradient[j] ?? 0) + residual * xj;
        const hRow = H[j] as number[];
        for (let k = 0; k <= j; k += 1) {
          hRow[k] = (hRow[k] ?? 0) + weight * xj * (row[k] ?? 0);
        }
      }
    }
    for (let j = 0; j < d; j += 1) {
      const prior = priors[j] ?? { mean: 0, sd: 1 };
      const precision = 1 / Math.pow(Math.max(prior.sd, 1e-6), 2);
      gradient[j] = (gradient[j] ?? 0) - precision * ((beta[j] ?? 0) - prior.mean);
      const hRow = H[j] as number[];
      hRow[j] = (hRow[j] ?? 0) + precision + jitter;
    }
    for (let j = 0; j < d; j += 1) {
      for (let k = 0; k < j; k += 1) {
        const hRow = H[j] as number[];
        hRow[k] = H[k]?.[j] ?? hRow[k] ?? 0;
      }
    }
    hessian = H;

    const step = solve(H, gradient);
    if (!step) break;

    // Backtracking line search on the penalized likelihood.
    let alpha = 1;
    let improved = false;
    let candidate = beta;
    let candidateLp = penalized;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      candidate = beta.map((value, j) => value + alpha * (step[j] ?? 0));
      candidateLp = penalizedLogLikelihood(X, y, candidate, priors);
      if (Number.isFinite(candidateLp) && candidateLp >= penalized) {
        improved = true;
        break;
      }
      alpha /= 2;
    }
    if (!improved) {
      converged = true;
      break;
    }
    const delta = candidateLp - penalized;
    beta = candidate;
    penalized = candidateLp;
    if (Math.abs(delta) < tolerance) {
      converged = true;
      break;
    }
  }

  const covariance = (invert(hessian) ?? identityMatrix(d)).map((row) =>
    row.map((value) => (Number.isFinite(value) ? value : 0)),
  );
  const standardErrors = covariance.map((row, index) => Math.sqrt(clamp(row[index] ?? 0, 0, 1e9)));

  return {
    beta,
    covariance,
    standardErrors,
    iterations,
    converged,
    penalizedLogLikelihood: penalized,
    n,
    positiveRate: n === 0 ? 0 : y.reduce((acc, value) => acc + value, 0) / n,
  };
}

function identityMatrix(n: number): Matrix {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
}

/** Predictive mean of the linear predictor, μ = xᵀβ. */
export function linearPredictor(x: readonly number[], beta: readonly number[]): number {
  return dot(x, beta);
}

/** Predictive variance s² = xᵀ Σ x. */
export function predictiveVariance(x: readonly number[], covariance: Matrix): number {
  const sigmaX = matVec(covariance, x);
  return Math.max(0, dot(x, sigmaX));
}

/** Probit approximation: p ≈ σ(μ / sqrt(1 + π s² / 8)). */
export function predictiveProbability(
  x: readonly number[],
  beta: readonly number[],
  covariance: Matrix,
): number {
  const mu = linearPredictor(x, beta);
  const s2 = predictiveVariance(x, covariance);
  const denom = Math.sqrt(1 + (Math.PI * s2) / 8);
  return safeProb(sigmoid(mu / denom));
}

/**
 * Upper-confidence-bound bonus with decaying exploration strength:
 *   kappa_t = kappa0 / sqrt(1 + n / n0),  UCB = p + kappa_t * s
 */
export function ucbScore(
  x: readonly number[],
  beta: readonly number[],
  covariance: Matrix,
  nObservations: number,
  kappa0 = 1.0,
  n0 = 30,
): { p: number; s: number; kappa: number; ucb: number } {
  const p = predictiveProbability(x, beta, covariance);
  const s = Math.sqrt(predictiveVariance(x, covariance));
  const kappa = kappa0 / Math.sqrt(1 + nObservations / n0);
  return { p, s, kappa, ucb: clamp(p + kappa * s, 0, 1) };
}

/** Draws a coefficient vector from the Laplace posterior N(β, Σ) deterministically. */
export function samplePosterior(
  beta: readonly number[],
  covariance: Matrix,
  rng: Rng,
): number[] {
  const L = cholesky(covariance);
  const z = beta.map(() => rng.normal());
  if (!L) return [...beta];
  const out = [...beta];
  for (let i = 0; i < out.length; i += 1) {
    let sumValue = 0;
    const row = L[i] ?? [];
    for (let j = 0; j <= i; j += 1) sumValue += (row[j] ?? 0) * (z[j] ?? 0);
    out[i] = (out[i] ?? 0) + sumValue;
  }
  return out;
}
