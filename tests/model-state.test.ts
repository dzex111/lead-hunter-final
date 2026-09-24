import { describe, expect, it } from 'vitest';
import { deserializeModelState, serializeModelState } from '@/core/model-state';
import { EXPERT_PRIORS, FEATURE_NAMES } from '@/core/features';

function identityCovariance(): number[][] {
  return FEATURE_NAMES.map((_name, i) => FEATURE_NAMES.map((_other, j) => (i === j ? 2 : 0)));
}

describe('model state serialization (covariance column)', () => {
  it('round-trips beta and covariance through the dedicated column', () => {
    const beta = FEATURE_NAMES.map((_name, i) => 0.1 * (i + 1));
    const covariance = identityCovariance();
    const { weights, covariance: stored } = serializeModelState({
      featureNames: FEATURE_NAMES,
      beta,
      covariance,
    });
    expect(stored).toEqual(covariance);
    const restored = deserializeModelState({ weights, covariance: stored, nObservations: 120 });
    expect(restored.beta).toEqual(beta);
    expect(restored.covariance).toEqual(covariance);
  });

  it('falls back to legacy cov:i:j keys when the column is null', () => {
    const beta = FEATURE_NAMES.map(() => 0.25);
    const { weights } = serializeModelState({ featureNames: FEATURE_NAMES, beta, covariance: identityCovariance() });
    const restored = deserializeModelState({ weights, covariance: null, nObservations: 40 });
    expect(restored.beta).toEqual(beta);
    expect(restored.covariance[0]?.[0]).toBe(2);
    expect(restored.covariance[0]?.[1]).toBe(0);
  });

  it('falls back to identity when nothing is stored', () => {
    const restored = deserializeModelState({ weights: {}, covariance: null, nObservations: 0 });
    expect(restored.beta).toEqual(FEATURE_NAMES.map((name) => EXPERT_PRIORS[name].mean));
    expect(restored.covariance[0]?.[0]).toBe(1);
    expect(restored.covariance[0]?.[1]).toBe(0);
  });

  it('ignores non-finite stored cells', () => {
    const restored = deserializeModelState({
      weights: {},
      covariance: [[Number.NaN, Number.POSITIVE_INFINITY]],
      nObservations: 5,
    });
    expect(restored.covariance[0]?.[0]).toBe(1);
    expect(restored.covariance[0]?.[1]).toBe(0);
  });
});
