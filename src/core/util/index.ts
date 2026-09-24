import { createHash, randomUUID } from 'node:crypto';

/** Indexed access helper that keeps `noUncheckedIndexedAccess` ergonomics sane. */
export function at<T>(arr: readonly T[], index: number): T | undefined {
  if (index < 0 || index >= arr.length) return undefined;
  return arr[index];
}

export function requireAt<T>(arr: readonly T[], index: number, what = 'element'): T {
  const value = at(arr, index);
  if (value === undefined) throw new Error(`missing ${what} at index ${index}`);
  return value;
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Probability-safe clamp to (eps, 1-eps) so logarithms never explode. */
export const EPSILON = 1e-9;

export function safeProb(p: number, eps = EPSILON): number {
  if (!Number.isFinite(p)) return 0.5;
  return clamp(p, eps, 1 - eps);
}

export function logit(p: number): number {
  const q = safeProb(p);
  return Math.log(q / (1 - q));
}

export function sigmoid(z: number): number {
  if (z >= 0) {
    return 1 / (1 + Math.exp(-z));
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

export function logSumExp(values: readonly number[]): number {
  if (values.length === 0) return Number.NEGATIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) if (v > max) max = v;
  if (!Number.isFinite(max)) return max;
  let sum = 0;
  for (const v of values) sum += Math.exp(v - max);
  return max + Math.log(sum);
}

export function softmax(values: readonly number[], temperature = 1): number[] {
  const t = temperature <= 0 ? 1 : temperature;
  const scaled = values.map((v) => (Number.isFinite(v) ? v / t : 0));
  const lse = logSumExp(scaled);
  if (!Number.isFinite(lse)) {
    const n = values.length;
    return new Array<number>(n).fill(n === 0 ? 0 : 1 / n);
  }
  return scaled.map((v) => Math.exp(v - lse));
}

export function hashedId(...parts: (string | number)[]): string {
  const h = createHash('sha256');
  h.update(parts.join('|'));
  return h.digest('hex').slice(0, 32);
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function newId(): string {
  return randomUUID();
}

export function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

export function uniqueBy<T, K>(values: readonly T[], key: (value: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const value of values) {
    const k = key(value);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(value);
  }
  return out;
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return sum(values) / values.length;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return requireAt(sorted, mid);
  const low = requireAt(sorted, mid - 1);
  const high = requireAt(sorted, mid);
  return (low + high) / 2;
}

export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loV = requireAt(sorted, lo);
  const hiV = requireAt(sorted, hi);
  return loV + (hiV - loV) * (pos - lo);
}

export function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 86_400_000;
}

export function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 3_600_000;
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60_000;
}

export function isoDate(date: Date): string {
  return date.toISOString();
}

export function nonEmpty<T>(values: readonly (T | undefined | null)[]): T[] {
  const out: T[] = [];
  for (const value of values) {
    if (value === undefined || value === null) continue;
    out.push(value);
  }
  return out;
}

/** Deterministic stable stringify (sorted keys) used for hashing/idempotency. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}
