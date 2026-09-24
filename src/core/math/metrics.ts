import { clamp } from '@/core/util';

/** Calibration and discrimination metrics used by `sim` and the CLI `stats` command. */

export interface LabeledProbability {
  p: number;
  y: 0 | 1;
  weight?: number;
}

export function brierScore(items: readonly LabeledProbability[]): number {
  if (items.length === 0) return 0;
  let total = 0;
  let weight = 0;
  for (const item of items) {
    const w = item.weight ?? 1;
    total += w * Math.pow(clamp(item.p, 0, 1) - item.y, 2);
    weight += w;
  }
  return weight === 0 ? 0 : total / weight;
}

export function logLoss(items: readonly LabeledProbability[]): number {
  if (items.length === 0) return 0;
  let total = 0;
  let weight = 0;
  for (const item of items) {
    const w = item.weight ?? 1;
    const p = clamp(item.p, 1e-12, 1 - 1e-12);
    total += -w * (item.y === 1 ? Math.log(p) : Math.log(1 - p));
    weight += w;
  }
  return weight === 0 ? 0 : total / weight;
}

export interface ReliabilityBin {
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number;
  observedRate: number;
  gap: number;
}

export function reliabilityBins(
  items: readonly LabeledProbability[],
  bins = 10,
): ReliabilityBin[] {
  const out: ReliabilityBin[] = [];
  for (let index = 0; index < bins; index += 1) {
    const lower = index / bins;
    const upper = (index + 1) / bins;
    const members = items.filter((item) => {
      const p = clamp(item.p, 0, 1);
      return index === bins - 1 ? p >= lower && p <= upper : p >= lower && p < upper;
    });
    const count = members.length;
    const meanPredicted = count === 0 ? 0 : members.reduce((acc, item) => acc + item.p, 0) / count;
    const observedRate = count === 0 ? 0 : members.reduce((acc, item) => acc + item.y, 0) / count;
    out.push({
      lower,
      upper,
      count,
      meanPredicted,
      observedRate,
      gap: count === 0 ? 0 : observedRate - meanPredicted,
    });
  }
  return out;
}

export function expectedCalibrationError(
  items: readonly LabeledProbability[],
  bins = 10,
): number {
  const total = items.length;
  if (total === 0) return 0;
  const reliability = reliabilityBins(items, bins);
  let ece = 0;
  for (const bin of reliability) {
    ece += (bin.count / total) * Math.abs(bin.gap);
  }
  return ece;
}

export function rocAuc(items: readonly LabeledProbability[]): number {
  const positives = items.filter((item) => item.y === 1);
  const negatives = items.filter((item) => item.y === 0);
  if (positives.length === 0 || negatives.length === 0) return 0.5;
  let concordant = 0;
  let ties = 0;
  for (const p of positives) {
    for (const n of negatives) {
      if (p.p > n.p) concordant += 1;
      else if (p.p === n.p) ties += 1;
    }
  }
  return (concordant + 0.5 * ties) / (positives.length * negatives.length);
}

export function meanAbsoluteError(values: readonly number[], truth: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < values.length; i += 1) {
    total += Math.abs((values[i] ?? 0) - (truth[i] ?? 0));
  }
  return total / values.length;
}

/** Isotonic / Platt calibration are only enabled with n >= 200 outcomes. */
export const CALIBRATION_MIN_SAMPLES = 200;

export function plattScaling(
  items: readonly LabeledProbability[],
): { a: number; b: number; enabled: boolean } {
  if (items.length < CALIBRATION_MIN_SAMPLES) return { a: 1, b: 0, enabled: false };
  // Fit a, b by simple gradient descent on log-loss (logistic on logits).
  let a = 1;
  let b = 0;
  const lr = 0.05;
  for (let step = 0; step < 500; step += 1) {
    let gradA = 0;
    let gradB = 0;
    for (const item of items) {
      const logit = Math.log(clamp(item.p, 1e-6, 1 - 1e-6) / (1 - clamp(item.p, 1e-6, 1 - 1e-6)));
      const z = a * logit + b;
      const p = 1 / (1 + Math.exp(-z));
      const error = p - item.y;
      gradA += error * logit;
      gradB += error;
    }
    a -= (lr * gradA) / items.length;
    b -= (lr * gradB) / items.length;
  }
  return { a, b, enabled: true };
}

export function applyPlatt(item: number, scaling: { a: number; b: number; enabled: boolean }): number {
  if (!scaling.enabled) return item;
  const logit = Math.log(clamp(item, 1e-6, 1 - 1e-6) / (1 - clamp(item, 1e-6, 1 - 1e-6)));
  return clamp(1 / (1 + Math.exp(-(scaling.a * logit + scaling.b))), 0, 1);
}
