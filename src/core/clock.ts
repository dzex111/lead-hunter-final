/**
 * Injectable clock. Nothing in src/core reads the wall clock directly; every
 * time-dependent decision is a pure function of an explicitly supplied Date.
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date | string | number = '2026-01-01T09:00:00.000Z') {
    this.current = start instanceof Date ? new Date(start.getTime()) : new Date(start);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  /** Advance the fake clock; used by time-travel policy tests. */
  advanceMs(ms: number): Date {
    this.current = new Date(this.current.getTime() + ms);
    return this.now();
  }

  advanceMinutes(minutes: number): Date {
    return this.advanceMs(minutes * 60_000);
  }

  advanceHours(hours: number): Date {
    return this.advanceMs(hours * 3_600_000);
  }

  advanceDays(days: number): Date {
    return this.advanceMs(days * 86_400_000);
  }

  set(date: Date | string | number): Date {
    this.current = date instanceof Date ? new Date(date.getTime()) : new Date(date);
    return this.now();
  }
}

/**
 * Africa/Algiers is UTC+1 all year (Algeria has no DST since 1981).
 * Keeping the offset fixed avoids ICU/timezone-data dependencies.
 */
export const ALGIERS_UTC_OFFSET_MINUTES = 60;

export interface AlgiersWallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  /** 0 = Sunday .. 5 = Friday, 6 = Saturday */
  weekday: number;
}

export function toAlgiersWallTime(instant: Date): AlgiersWallTime {
  const shifted = new Date(instant.getTime() + ALGIERS_UTC_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

export function algiersDayKey(instant: Date): string {
  const w = toAlgiersWallTime(instant);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

export function algiersHourKey(instant: Date): string {
  const w = toAlgiersWallTime(instant);
  return `${algiersDayKey(instant)}T${String(w.hour).padStart(2, '0')}`;
}
