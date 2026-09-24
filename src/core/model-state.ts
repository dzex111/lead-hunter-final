import { EXPERT_PRIORS, FEATURE_NAMES } from '@/core/features';
import type { Matrix } from '@/core/math/linalg';

/**
 * Pure serialization of P(reply) model state for `model_versions` rows.
 * The covariance matrix belongs in the dedicated `covariance` column; legacy
 * `cov:i:j` keys stay in `weights` so old writers remain readable.
 * Lives in core on purpose: zero I/O, fully unit-testable.
 */
export function serializeModelState(model: {
  featureNames: readonly string[];
  beta: readonly number[];
  covariance: Matrix;
}): { weights: Record<string, number>; covariance: Matrix } {
  const weights: Record<string, number> = {};
  model.featureNames.forEach((name, index) => {
    weights[name] = model.beta[index] ?? 0;
  });
  model.covariance.forEach((row, i) => {
    row.forEach((value, j) => {
      weights[`cov:${i}:${j}`] = value;
    });
  });
  return { weights, covariance: model.covariance };
}

export type StoredModelState = {
  weights: Record<string, number>;
  covariance: Matrix | null | undefined;
  nObservations: number;
};

/**
 * Pure deserialization with graceful fallbacks:
 * dedicated column → legacy `cov:i:j` keys → identity (cold prior variance).
 */
export function deserializeModelState(stored: StoredModelState): { beta: number[]; covariance: Matrix } {
  const beta = FEATURE_NAMES.map((name) => stored.weights[name] ?? EXPERT_PRIORS[name].mean);
  const covariance: Matrix = FEATURE_NAMES.map((_name, i) =>
    FEATURE_NAMES.map((_other, j) => {
      const cell = stored.covariance?.[i]?.[j];
      if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
      const legacy = stored.weights[`cov:${i}:${j}`];
      if (typeof legacy === 'number' && Number.isFinite(legacy)) return legacy;
      return i === j ? 1 : 0;
    }),
  );
  return { beta, covariance };
}
