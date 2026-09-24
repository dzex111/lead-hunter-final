import { and, asc, eq, lte, or, sql } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { jobs, recurringSchedules } from '@/adapters/db/tables';
import type { Clock } from '@/core/clock';
import type { Rng } from '@/core/random';
import type { Db } from '@/adapters/db/repo';
import { newId } from '@/core/util';

/**
 * Postgres job queue: FOR UPDATE SKIP LOCKED claiming, leases with heartbeats,
 * retries with exponential backoff + full jitter, idempotency keys, dead-letter
 * and recurring schedules.
 */
export const JOB_KINDS = [
  'discover',
  'enrich',
  'resolve',
  'qualify',
  'score',
  'draft',
  'purge',
  'refit_model',
  'recurring_tick',
] as const;
export type JobKind = (typeof JOB_KINDS)[number] | string;

export interface JobRecord {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueOptions {
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  idempotencyKey?: string;
}

export interface QueueOptions {
  workerId: string;
  leaseMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export class JobQueue {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly options: QueueOptions;

  constructor(deps: { db?: Db; clock: Clock; rng: Rng; options?: Partial<QueueOptions> & { workerId: string } }) {
    this.db = deps.db ?? defaultDb;
    this.clock = deps.clock;
    this.rng = deps.rng;
    this.options = {
      workerId: deps.options?.workerId ?? 'worker-1',
      leaseMs: deps.options?.leaseMs ?? 60_000,
      baseBackoffMs: deps.options?.baseBackoffMs ?? 2_000,
      maxBackoffMs: deps.options?.maxBackoffMs ?? 30 * 60_000,
    };
  }

  /** Returns the new job id, or null when the idempotency key already exists. */
  async enqueue(kind: JobKind, payload: Record<string, unknown>, options: EnqueueOptions = {}): Promise<string | null> {
    const id = newId();
    const now = this.clock.now();
    const inserted = await this.db
      .insert(jobs)
      .values({
        id,
        kind,
        payload,
        status: 'pending',
        priority: options.priority ?? 100,
        runAt: options.runAt ?? now,
        maxAttempts: options.maxAttempts ?? 5,
        idempotencyKey: options.idempotencyKey ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: jobs.id });
    return inserted[0]?.id ?? null;
  }

  async claim(limit = 5): Promise<JobRecord[]> {
    const now = this.clock.now();
    const leaseExpiry = new Date(now.getTime() + this.options.leaseMs);
    const rows = await this.db.execute<{
      id: string;
      kind: string;
      payload: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
    }>(sql`
      with claimed as (
        select id from jobs
        where (
          (status = 'pending' and run_at <= ${now.toISOString()})
          or (status = 'running' and lease_expires_at is not null and lease_expires_at < ${now.toISOString()})
        )
        order by priority asc, run_at asc
        limit ${limit}
        for update skip locked
      )
      update jobs set
        status = 'running',
        lease_owner = ${this.options.workerId},
        lease_expires_at = ${leaseExpiry.toISOString()},
        heartbeat_at = ${now.toISOString()},
        attempts = jobs.attempts + 1,
        updated_at = ${now.toISOString()}
      where jobs.id in (select id from claimed)
      returning jobs.id, jobs.kind, jobs.payload, jobs.attempts, jobs.max_attempts
    `);
    const raw = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
    return (raw as {
      id: string;
      kind: string;
      payload: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
    }[]).map((row) => ({
      id: row.id,
      kind: row.kind,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    }));
  }

  async heartbeat(jobId: string): Promise<void> {
    const now = this.clock.now();
    await this.db
      .update(jobs)
      .set({
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + this.options.leaseMs),
        updatedAt: now,
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.leaseOwner, this.options.workerId)));
  }

  async complete(jobId: string, result: Record<string, unknown> = {}): Promise<void> {
    const now = this.clock.now();
    await this.db
      .update(jobs)
      .set({ status: 'done', result, completedAt: now, updatedAt: now, leaseOwner: null, leaseExpiresAt: null })
      .where(eq(jobs.id, jobId));
  }

  /** Retry with exponential backoff + full jitter; dead-letter after maxAttempts. */
  async fail(jobId: string, error: Error, attempts: number, maxAttempts: number): Promise<'retry' | 'dead'> {
    const now = this.clock.now();
    if (attempts >= maxAttempts) {
      await this.db
        .update(jobs)
        .set({
          status: 'dead',
          lastError: error.message.slice(0, 2_000),
          updatedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        .where(eq(jobs.id, jobId));
      return 'dead';
    }
    const cap = Math.min(this.options.maxBackoffMs, this.options.baseBackoffMs * Math.pow(2, attempts));
    const delay = Math.floor(cap * this.rng.next()); // full jitter
    await this.db
      .update(jobs)
      .set({
        status: 'pending',
        lastError: error.message.slice(0, 2_000),
        runAt: new Date(now.getTime() + Math.max(250, delay)),
        updatedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(jobs.id, jobId));
    return 'retry';
  }

  async reapExpiredLeases(): Promise<number> {
    const now = this.clock.now();
    const rows = await this.db
      .update(jobs)
      .set({ status: 'pending', leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(
        and(
          eq(jobs.status, 'running'),
          or(lte(jobs.leaseExpiresAt, now), sql`${jobs.leaseExpiresAt} is null`),
        ),
      )
      .returning({ id: jobs.id });
    return rows.length;
  }

  async deadLetter(): Promise<JobRecord[]> {
    const rows = await this.db
      .select({ id: jobs.id, kind: jobs.kind, payload: jobs.payload, attempts: jobs.attempts, maxAttempts: jobs.maxAttempts })
      .from(jobs)
      .where(eq(jobs.status, 'dead'))
      .orderBy(asc(jobs.updatedAt))
      .limit(100);
    return rows;
  }

  /** Materializes due recurring jobs and advances their next_run_at. */
  async ensureRecurringSchedules(): Promise<number> {
    const now = this.clock.now();
    const due = await this.db
      .select()
      .from(recurringSchedules)
      .where(and(eq(recurringSchedules.enabled, true), lte(recurringSchedules.nextRunAt, now)));
    let created = 0;
    for (const schedule of due) {
      const id = await this.enqueue(schedule.kind, schedule.payload, {
        priority: 10,
        idempotencyKey: `recurring:${schedule.id}:${schedule.nextRunAt.toISOString()}`,
      });
      if (id) created += 1;
      await this.db
        .update(recurringSchedules)
        .set({ lastRunAt: now, nextRunAt: nextRunAt(schedule.schedule, now) })
        .where(eq(recurringSchedules.id, schedule.id));
    }
    return created;
  }

  async registerSchedule(input: {
    id: string;
    kind: string;
    schedule: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    const now = this.clock.now();
    await this.db
      .insert(recurringSchedules)
      .values({
        id: input.id,
        kind: input.kind,
        schedule: input.schedule,
        payload: input.payload ?? {},
        enabled: true,
        nextRunAt: nextRunAt(input.schedule, now),
      })
      .onConflictDoNothing();
  }

  async stats(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ status: jobs.status, count: sql<number>`count(*)::int` })
      .from(jobs)
      .groupBy(jobs.status);
    const out: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0, dead: 0 };
    for (const row of rows) out[row.status] = row.count;
    return out;
  }
}

/** Schedule grammar: "15m", "1h", "1d", "1d@07:30" (Africa/Algiers wall time). */
export function nextRunAt(schedule: string, from: Date): Date {
  const match = schedule.trim().match(/^(\d+)([mhd])(?:@(\d{1,2}):(\d{2}))?$/);
  if (!match) throw new Error(`unsupported schedule expression: ${schedule}`);
  const value = Number.parseInt(match[1] ?? '1', 10);
  const unit = match[2] ?? 'm';
  const hour = match[3] ? Number.parseInt(match[3], 10) : null;
  const minute = match[4] ? Number.parseInt(match[4], 10) : null;
  const stepMs = unit === 'm' ? value * 60_000 : unit === 'h' ? value * 3_600_000 : value * 86_400_000;
  let next = new Date(from.getTime() + stepMs);
  if (hour !== null && minute !== null) {
    const algiersOffsetMs = 60 * 60_000; // UTC+1, no DST in Algeria
    const target = new Date(next.getTime() + algiersOffsetMs);
    target.setUTCHours(hour, minute, 0, 0);
    next = new Date(target.getTime() - algiersOffsetMs);
    if (next.getTime() <= from.getTime()) next = new Date(next.getTime() + 86_400_000);
  }
  return next;
}
