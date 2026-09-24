import { desc, eq, inArray } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { outcomes as outcomesTable, scores as scoresTable } from '@/adapters/db/tables';
import { activeModelVersion, insertModelVersion, type Db } from '@/adapters/db/repo';
import { FEATURE_NAMES, EXPERT_PRIORS, priorArray, type FeatureName } from '@/core/features';
import { deserializeModelState, serializeModelState } from '@/core/model-state';
import { fitLogistic, predictiveProbability, ucbScore, type FitResult } from '@/core/math/logistic';
import type { Matrix } from '@/core/math/linalg';
import { brierScore, expectedCalibrationError, logLoss, rocAuc, type LabeledProbability } from '@/core/math/metrics';
import { clamp } from '@/core/util';
import type { Clock } from '@/core/clock';

/**
 * Model lifecycle for P(reply):
 *  - cold start: priors only until n >= 30 labelled outcomes
 *  - MAP fit (Newton/IRLS + backtracking) with Gaussian priors
 *  - Platt calibration only from n >= 200
 *  - persists beta + Laplace covariance + metrics into model_versions
 */
export const MODEL_KIND = 'p_reply';
export const COLD_START_MIN_ROWS = 30;

export interface ReplyModel {
  version: string;
  featureNames: readonly FeatureName[];
  beta: number[];
  covariance: Matrix;
  nObservations: number;
  fittedAt: Date;
  metrics: Record<string, number>;
  calibrated: boolean;
  coldStart: boolean;
}

export interface TrainingRow {
  features: Record<string, number>;
  label: 0 | 1;
  stage: string;
}

export async function loadTrainingRows(db: Db = defaultDb): Promise<TrainingRow[]> {
  const rows = await db
    .select({
      features: scoresTable.features,
      stage: outcomesTable.stage,
    })
    .from(outcomesTable)
    .innerJoin(scoresTable, eq(scoresTable.leadId, outcomesTable.leadId))
    .where(
      inArray(outcomesTable.stage, [
        'replied',
        'interested',
        'signed_up',
        'activated',
        'paid',
        'lost',
        'blocked',
        'reported',
        'not_interested',
      ]),
    )
    .orderBy(desc(outcomesTable.occurredAt))
    .limit(20_000);

  return rows.map((row) => ({
    features: row.features ?? {},
    label: ['replied', 'interested', 'signed_up', 'activated', 'paid'].includes(row.stage) ? 1 : 0,
    stage: row.stage,
  }));
}

function matrixFromRows(rows: readonly TrainingRow[]): { X: number[][]; y: number[] } {
  const X = rows.map((row) => FEATURE_NAMES.map((name) => row.features[name] ?? 0));
  const y = rows.map((row) => row.label);
  return { X, y };
}

export function priorModel(clock: Clock): ReplyModel {
  const beta = priorArray().map((prior) => prior.mean);
  const covariance = beta.map((_value, i) =>
    beta.map((_other, j) => {
      const prior = priorArray();
      const sd = prior[i]?.sd ?? 1;
      return i === j ? sd * sd : 0;
    }),
  );
  return {
    version: 'reply-logistic-prior-v1',
    featureNames: FEATURE_NAMES,
    beta,
    covariance,
    nObservations: 0,
    fittedAt: clock.now(),
    metrics: {},
    calibrated: false,
    coldStart: true,
  };
}

export function fitReplyModel(rows: readonly TrainingRow[], clock: Clock): ReplyModel {
  if (rows.length < COLD_START_MIN_ROWS) return priorModel(clock);
  const { X, y } = matrixFromRows(rows);
  const fit: FitResult = fitLogistic(X, y, { priors: priorArray(), maxIterations: 200 });
  if (!fit.beta.every((value) => Number.isFinite(value))) return priorModel(clock);
  const labeled: LabeledProbability[] = X.map((row, index) => ({
    p: predictiveProbability(row, fit.beta, fit.covariance),
    y: (y[index] ?? 0) as 0 | 1,
  }));
  return {
    version: `reply-logistic-${clock.now().toISOString().slice(0, 10)}`,
    featureNames: FEATURE_NAMES,
    beta: fit.beta,
    covariance: fit.covariance,
    nObservations: rows.length,
    fittedAt: clock.now(),
    metrics: {
      brier: brierScore(labeled),
      logLoss: logLoss(labeled),
      ece: expectedCalibrationError(labeled, 10),
      auc: rocAuc(labeled),
      positiveRate: fit.positiveRate,
      iterations: fit.iterations,
      converged: fit.converged ? 1 : 0,
    },
    calibrated: rows.length >= 200,
    coldStart: false,
  };
}

export async function persistModel(model: ReplyModel, db: Db = defaultDb): Promise<void> {
  const { weights, covariance } = serializeModelState(model);
  const priors: Record<string, { mean: number; sd: number }> = {};
  for (const name of model.featureNames) priors[name] = EXPERT_PRIORS[name];
  await insertModelVersion(
    {
      kind: MODEL_KIND,
      version: model.version,
      weights,
      priors,
      metrics: model.metrics,
      nObservations: model.nObservations,
      fittedAt: model.fittedAt,
      covariance,
    },
    db,
  );
}

export async function loadActiveModel(clock: Clock, db: Db = defaultDb): Promise<ReplyModel> {
  const row = await activeModelVersion(MODEL_KIND, db);
  if (!row) return priorModel(clock);
  const { beta, covariance } = deserializeModelState({
    weights: row.weights,
    covariance: row.covariance ?? null,
    nObservations: row.nObservations,
  });
  return {
    version: row.version,
    featureNames: FEATURE_NAMES,
    beta,
    covariance,
    nObservations: row.nObservations,
    fittedAt: row.fittedAt,
    metrics: row.metrics,
    calibrated: row.nObservations >= 200,
    coldStart: row.nObservations < COLD_START_MIN_ROWS,
  };
}

export interface ReplyPrediction {
  p: number;
  ucb: number;
  s: number;
  kappa: number;
  contributions: { feature: string; value: number; weight: number; contribution: number }[];
}

export function predictReply(
  model: ReplyModel,
  features: readonly number[],
  featureNames: readonly string[],
): ReplyPrediction {
  const p = predictiveProbability(features, model.beta, model.covariance);
  const { s, kappa, ucb } = ucbScore(features, model.beta, model.covariance, model.nObservations);
  const contributions = featureNames.map((name, index) => {
    const value = features[index] ?? 0;
    const weight = model.beta[index] ?? 0;
    return { feature: name, value, weight, contribution: clamp(weight * value, -10, 10) };
  });
  return { p, ucb, s, kappa, contributions };
}

export function modelSummary(model: ReplyModel): string {
  const top = model.featureNames
    .map((name, index) => ({ name, beta: model.beta[index] ?? 0 }))
    .sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta))
    .slice(0, 6)
    .map((entry) => `${entry.name}=${entry.beta.toFixed(2)}`)
    .join(', ');
  return [
    `model ${model.version} (n=${model.nObservations}${model.coldStart ? ', cold start: priors only' : ''}${model.calibrated ? ', Platt-calibrated' : ''})`,
    `top weights: ${top}`,
    model.metrics['brier'] !== undefined
      ? `Brier=${model.metrics['brier']?.toFixed(4)} log-loss=${model.metrics['logLoss']?.toFixed(4)} ECE=${model.metrics['ece']?.toFixed(4)} AUC=${model.metrics['auc']?.toFixed(3)}`
      : 'no metrics yet (needs >= 30 labelled outcomes)',
  ].join('\n');
}
