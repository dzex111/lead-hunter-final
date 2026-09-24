import { toAlgiersWallTime } from '@/core/clock';
import { clamp as clampValue, uniqueBy as uniqueByValue } from '@/core/util';

export function clamp(value: number, min: number, max: number): number {
  return clampValue(value, min, max);
}

export function uniqueBy<T, K>(values: readonly T[], key: (value: T) => K): T[] {
  return uniqueByValue(values, key);
}

export function hour0(now: Date): number {
  return toAlgiersWallTime(now).hour;
}
