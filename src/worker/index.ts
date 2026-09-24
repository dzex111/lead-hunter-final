import { and, eq, isNull, sql } from 'drizzle-orm';
import { leads as leadsTable } from '@/adapters/db/tables';
import { purgeOldData, recordAudit } from '@/adapters/db/repo';
import { JobQueue, type JobRecord } from '@/adapters/queue/jobs';
import {
  buildQueue,
  draftLead,
  enrichLead,
  refitModels,
  resolveEntities,
  scoreLead,
  ingestCandidates,
} from '@/adapters/pipeline/index';
import { getSource, buildRegistry } from '@/adapters/sources/registry';
import { SimpleBudgetGuard, type DiscoveryContext } from '@/adapters/sources/types';
import { createLogger } from '@/adapters/logging';
import { SafeFetcher } from '@/adapters/http/client';
import { SystemClock } from '@/core/clock';
import { createRng } from '@/core/random';
import { loadConfig } from '@/config';
import type { PipelineDeps } from '@/adapters/pipeline/index';
import type { RawCandidate } from '@/core/types';

/**
 * Worker process: separate from the API/console. Claims jobs with
 * FOR UPDATE SKIP LOCKED, heartbeats leases, retries with exponential backoff +
 * full jitter, dead-letters after maxAttempts and shuts down gracefully.
 */
export interface WorkerOptions {
  pollMs: number;
  batch: number;
  registerSchedules: boolean;
}

export const DEFAULT_WORKER_OPTIONS: WorkerOptions = {
  pollMs: 2_000,
  batch: 5,
  registerSchedules: true,
};

export async function handleJob(job: JobRecord, deps: PipelineDeps): Promise<Record<string, unknown>> {
  const payload = job.payload;
  switch (job.kind) {
    case 'discover': {
      const registry = buildRegistry(deps.config);
      const sourceId = String(payload['source'] ?? 'manual_paste');
      const source = getSource(registry, sourceId);
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(payload)) {
        if (key === 'source' || key === 'budget') continue;
        params[key] = String(value);
      }
      const ctx: DiscoveryContext = {
        clock: deps.clock,
        rng: deps.rng ?? createRng(deps.config.seed),
        http: deps.http,
        logger: deps.logger,
        config: deps.config,
        budget: new SimpleBudgetGuard(Number(payload['budget'] ?? 25)),
        dryRun: payload['dryRun'] === true,
        params,
      };
      source.ensureReady(ctx);
      const candidates: RawCandidate[] = [];
      for await (const candidate of source.discover(ctx)) {
        candidates.push(candidate);
        if (candidates.length >= 500) break;
      }
      const result = await ingestCandidates(candidates, deps);
      return { candidates: candidates.length, ...result };
    }
    case 'enrich': {
      const leadIds: string[] = [];
      if (typeof payload['leadId'] === 'string') leadIds.push(payload['leadId']);
      else {
        const limit = Number(payload['limit'] ?? 25);
        const rows = await (deps.db ?? (await import('@/db')).db)
          .select({ id: leadsTable.id })
          .from(leadsTable)
          .where(and(isNull(leadsTable.deletedAt), isNull(leadsTable.mergedIntoId), eq(leadsTable.state, 'new')))
          .limit(limit);
        for (const row of rows) leadIds.push(row.id);
      }
      let qualified = 0;
      for (const leadId of leadIds) {
        const outcome = await enrichLead(leadId, deps, { offline: payload['offline'] === true });
        if (outcome?.qualified) qualified += 1;
      }
      return { enriched: leadIds.length, qualified };
    }
    case 'resolve':
      return await resolveEntities(deps);
    case 'score': {
      const leadIds: string[] = [];
      if (typeof payload['leadId'] === 'string') leadIds.push(payload['leadId']);
      else {
        const rows = await (deps.db ?? (await import('@/db')).db)
          .select({ id: leadsTable.id })
          .from(leadsTable)
          .where(
            and(
              isNull(leadsTable.deletedAt),
              sql`${leadsTable.state} in ('enriched','qualified','queued','drafted')`,
            ),
          )
          .limit(Number(payload['limit'] ?? 50));
        for (const row of rows) leadIds.push(row.id);
      }
      for (const leadId of leadIds) await scoreLead(leadId, deps);
      return { scored: leadIds.length };
    }
    case 'draft': {
      if (typeof payload['leadId'] === 'string') {
        const item = await draftLead(payload['leadId'], deps, { forceDraft: true });
        return { drafted: item ? 1 : 0 };
      }
      const items = await buildQueue(deps, { n: Number(payload['n'] ?? 20) });
      return { drafted: items.length };
    }
    case 'refit_model': {
      const result = await refitModels(deps);
      return { model: result.modelSummary };
    }
    case 'purge': {
      const days = Number(payload['days'] ?? deps.config.retentionDays);
      const cutoff = new Date(deps.clock.now().getTime() - days * 86_400_000);
      const result = await purgeOldData(cutoff, deps.db);
      await recordAudit(
        {
          actor: 'worker',
          action: 'purge',
          entityType: 'system',
          detail: { days, ...result },
          at: deps.clock.now(),
        },
        deps.db,
      );
      return { ...result, days };
    }
    case 'recurring_tick':
      return { tick: deps.clock.now().toISOString() };
    default:
      throw new Error(`unknown job kind: ${job.kind}`);
  }
}

export async function startWorker(
  deps: PipelineDeps,
  options: Partial<WorkerOptions> = {},
  signal?: { stop: () => void; isStopping: () => boolean },
): Promise<void> {
  const opts = { ...DEFAULT_WORKER_OPTIONS, ...options };
  const clock = deps.clock ?? new SystemClock();
  const logger = deps.logger ?? createLogger();
  const rng = deps.rng ?? createRng(deps.config.seed);
  const queue = new JobQueue({ clock, rng, options: { workerId: `worker-${process.pid}` } });
  let running = true;

  if (opts.registerSchedules) {
    await queue.registerSchedule({ id: 'enrich-new', kind: 'enrich', schedule: '15m', payload: { limit: 25 } });
    await queue.registerSchedule({ id: 'resolve-hourly', kind: 'resolve', schedule: '1h' });
    await queue.registerSchedule({ id: 'score-hourly', kind: 'score', schedule: '1h', payload: { limit: 50 } });
    await queue.registerSchedule({ id: 'refit-daily', kind: 'refit_model', schedule: '1d@03:30' });
    await queue.registerSchedule({ id: 'purge-daily', kind: 'purge', schedule: '1d@04:30' });
  }

  const shutdown = (): void => {
    if (!running) return;
    running = false;
    logger.info({}, 'worker shutdown requested — finishing current job');
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info({ worker: process.pid, pollMs: opts.pollMs }, 'worker started');

  while (running) {
    try {
      await queue.ensureRecurringSchedules();
      const claimed = await queue.claim(opts.batch);
      if (claimed.length === 0) {
        await queue.reapExpiredLeases();
        await sleep(opts.pollMs);
        if (signal?.isStopping()) signal.stop();
        continue;
      }
      for (const job of claimed) {
        const heartbeat = setInterval(() => {
          void queue.heartbeat(job.id);
        }, Math.max(5_000, Math.floor(30_000)));
        try {
          const result = await handleJob(job, deps);
          await queue.complete(job.id, result);
          logger.info({ job: job.id, kind: job.kind, attempts: job.attempts }, 'job completed');
        } catch (error) {
          const outcome = await queue.fail(job.id, error as Error, job.attempts, job.maxAttempts);
          logger.error(
            { job: job.id, kind: job.kind, attempts: job.attempts, outcome, error: (error as Error).message },
            'job failed',
          );
        } finally {
          clearInterval(heartbeat);
        }
      }
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'worker loop error');
      await sleep(opts.pollMs);
    }
  }

  process.off('SIGINT', shutdown);
  process.off('SIGTERM', shutdown);
  const stats = await queue.stats();
  logger.info({ stats }, 'worker stopped gracefully');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { JobQueue };
