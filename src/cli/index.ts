#!/usr/bin/env node
import { Command } from 'commander';
import { and, desc, inArray, isNull } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { leads as leadsTable } from '@/adapters/db/tables';
import {
  addSuppression,
  hardDeleteLead,
  insertObservation,
  purgeOldData,
  recordAudit,
  suppressionsForExport,
  type Db,
} from '@/adapters/db/repo-extra';
import {
  countLeadsByState,
  buildQueue,
  draftLead,
  enrichLead,
  ensureSenderState,
  fetchDemoCandidates,
  ingestCandidates,
  recentAttempts,
  recentObservations,
  recentOutcomes,
  recordLeadOutcome,
  refitModels,
  resolveEntities,
  scoreLead,
  searchQueryRows,
  senderSnapshot,
} from '@/adapters/pipeline/index';
import { exportLeadBundle, purgeLeadData } from '@/adapters/pipeline/privacy';
import { createLogger } from '@/adapters/logging';
import { SafeFetcher } from '@/adapters/http/client';
import { buildRegistry, describeSources, getSource } from '@/adapters/sources/registry';
import { SimpleBudgetGuard } from '@/adapters/sources/types';
import { allocateQueryBudget, newQueryStats, retireDeadQueries, updateQueryPosterior } from '@/core/math/bandit';
import { loadFunnel } from '@/adapters/pipeline/funnel';
import { loadActiveModel, modelSummary } from '@/adapters/pipeline/model';
import { classifyCategories } from '@/core/classify/categories';
import { fuseEvidence } from '@/core/math/fusion';
import { DEFAULT_EV_CONFIG } from '@/core/math/ev';
import { SystemClock } from '@/core/clock';
import { createRng, type Rng } from '@/core/random';
import type { Clock } from '@/core/clock';
import type { HttpClient, Logger } from '@/core/ports';
import type { RawCandidate } from '@/core/types';
import { loadConfig, type AppConfig } from '@/config';
import type { PipelineDeps } from '@/adapters/pipeline/index';

export interface CliDeps extends PipelineDeps {
  http: HttpClient;
  logger: Logger;
  clock: Clock;
  rng: Rng;
  config: AppConfig;
  db: Db;
}

export function buildCliDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  const config = overrides.config ?? loadConfig();
  const clock = overrides.clock ?? new SystemClock();
  const logger = overrides.logger ?? createLogger();
  const http =
    overrides.http ??
    new SafeFetcher({
      userAgent: config.userAgent,
      clock,
      maxBytes: config.fetch.maxBytes,
      timeoutMs: config.fetch.timeoutMs,
      maxRedirects: config.fetch.maxRedirects,
      contentTypeAllowlist: config.fetch.contentTypeAllowlist,
      ratePerSecond: config.fetch.ratePerSecond,
      concurrencyPerDomain: config.fetch.concurrencyPerDomain,
      saveSnapshots: config.flags.saveHtmlSnapshots,
    });
  const rng = overrides.rng ?? createRng(config.seed);
  const deps: CliDeps = {
    db: overrides.db ?? defaultDb,
    clock,
    http,
    logger,
    config,
    rng,
  };
  return deps;
}

async function collect(candidates: AsyncIterable<RawCandidate>, limit: number): Promise<RawCandidate[]> {
  const out: RawCandidate[] = [];
  for await (const candidate of candidates) {
    out.push(candidate);
    if (out.length >= limit) break;
  }
  return out;
}

export function buildProgram(getDeps: () => CliDeps = buildCliDeps): Command {
  const program = new Command();
  program.name('leadhunter').description('Lead Hunter core engine (headless, human-in-the-loop)').version('0.1.0');

  program
    .command('sources')
    .description('List discovery adapters, capabilities and feature-flag status')
    .action(() => {
      const deps = getDeps();
      const registry = buildRegistry(deps.config);
      process.stdout.write(`${describeSources(registry, deps.config)}\n`);
    });

  program
    .command('import')
    .description('Import candidates from a manual surface: paste | csv | social | ad-library | add')
    .argument('<mode>', 'paste | csv | social | ad-library | add')
    .option('--text <text>', 'pasted blob (paste mode)')
    .option('--path <path>', 'CSV path (csv mode)')
    .option('--handles <handles>', 'comma/newline separated handles (social mode)')
    .option('--advertisers <list>', 'page ids/urls (ad-library mode)')
    .option('--url <url>', 'merchant URL (add mode)')
    .option('--phone <phone>', 'phone (add mode)')
    .option('--name <name>', 'display name')
    .option('--notes <notes>', 'notes')
    .option('--is-advertiser <bool>', 'annotation')
    .option('--sells-cod <bool>', 'annotation')
    .option('--has-whatsapp <bool>', 'annotation')
    .option('--niche <niche>', 'annotation')
    .option('--limit <n>', 'max candidates', '200')
    .action(async (mode: string, flags: Record<string, string>) => {
      const deps = getDeps();
      const registry = buildRegistry(deps.config);
      const sourceId =
        mode === 'paste'
          ? 'manual_paste'
          : mode === 'csv'
            ? 'csv_import'
            : mode === 'social'
              ? 'social_paste'
              : mode === 'ad-library'
                ? 'ad_library_manual'
                : 'manual_add';
      const source = getSource(registry, sourceId);
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(flags)) {
        if (key === 'limit') continue;
        if (typeof value === 'string') params[key.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = value;
      }
      const ctx = {
        clock: deps.clock,
        rng: deps.rng,
        http: deps.http,
        logger: deps.logger,
        config: deps.config,
        budget: new SimpleBudgetGuard(100),
        dryRun: false,
        params,
      };
      source.ensureReady(ctx);
      const candidates = await collect(source.discover(ctx), Number.parseInt(flags['limit'] ?? '200', 10));
      const result = await ingestCandidates(candidates, deps);
      process.stdout.write(`imported: ${candidates.length} candidates → ${result.created} new leads, ${result.updated} updated\n`);
    });

  program
    .command('discover')
    .description('Run a discovery adapter (budget-guarded, dry-run supported)')
    .argument('<source>', 'adapter id, see `sources`')
    .option('--budget <units>', 'max cost units for this run', '25')
    .option('--limit <n>', 'max candidates', '100')
    .option('--dry-run', 'no network calls, print what would happen')
    .option('--param <kv...>', 'adapter parameters, e.g. --param url=https://... --param queries=...')
    .action(async (sourceName: string, flags: Record<string, unknown>) => {
      const deps = getDeps();
      const registry = buildRegistry(deps.config);
      const source = getSource(registry, sourceName);
      const paramList = (flags['param'] as string[] | undefined) ?? [];
      const params: Record<string, string> = {};
      for (const entry of paramList) {
        const index = entry.indexOf('=');
        if (index <= 0) continue;
        params[entry.slice(0, index)] = entry.slice(index + 1);
      }
      const ctx = {
        clock: deps.clock,
        rng: deps.rng,
        http: deps.http,
        logger: deps.logger,
        config: deps.config,
        budget: new SimpleBudgetGuard(Number.parseInt(String(flags['budget'] ?? '25'), 10)),
        dryRun: flags['dryRun'] === true,
        params,
      };
      source.ensureReady(ctx);
      const candidates = await collect(source.discover(ctx), Number.parseInt(String(flags['limit'] ?? '100'), 10));
      const result = await ingestCandidates(candidates, deps);
      process.stdout.write(
        `discover ${sourceName}: ${candidates.length} candidates → ${result.created} new, ${result.updated} existing\n`,
      );
    });

  program
    .command('enrich')
    .description('Fetch → extract → classify → qualify (per lead or --all)')
    .option('--all', 'enrich every non-terminal lead')
    .option('--lead <id>', 'single lead id')
    .option('--limit <n>', 'cap when using --all', '25')
    .option('--offline', 'use synthetic HTML (demo/sim only)')
    .action(async (flags: Record<string, unknown>) => {
      const deps = getDeps();
      const leadIds = await selectLeadIds(deps, flags);
      let qualified = 0;
      for (const leadId of leadIds) {
        const outcome = await enrichLead(leadId, deps, { offline: flags['offline'] === true });
        if (!outcome) continue;
        if (outcome.qualified) qualified += 1;
        process.stdout.write(
          `${leadId.slice(0, 8)} ${outcome.platform.padEnd(12)} P(DZ)=${outcome.pAlgeria.toFixed(3)} maturity=${outcome.maturityIndex.toFixed(1)} ${outcome.qualified ? 'QUALIFIED' : 'disqualified'} :: ${outcome.reasons.join('; ')}\n`,
        );
      }
      process.stdout.write(`enriched ${leadIds.length} leads (${qualified} qualified)\n`);
    });

  program
    .command('resolve')
    .description('Entity resolution: blocking → Fellegi-Sunter → merge/review')
    .action(async () => {
      const deps = getDeps();
      const result = await resolveEntities(deps);
      process.stdout.write(
        `pairs=${result.pairs} auto-merged=${result.autoMerges} review-queue=${result.reviews}\n`,
      );
    });

  program
    .command('score')
    .description('Score leads (P(reply), funnel, EV, priority)')
    .option('--all', 'score every qualified/queued lead')
    .option('--lead <id>', 'single lead id')
    .option('--limit <n>', 'cap when using --all', '50')
    .action(async (flags: Record<string, unknown>) => {
      const deps = getDeps();
      const leadIds = await selectLeadIds(deps, flags, ['enriched', 'qualified', 'queued', 'drafted']);
      for (const leadId of leadIds) {
        const outcome = await scoreLead(leadId, deps);
        if (!outcome) continue;
        process.stdout.write(
          `${leadId.slice(0, 8)} p(reply)=${outcome.pReply.toFixed(3)} EV=${outcome.ev.toFixed(2)} DZD priority=${outcome.priority.toFixed(4)} model=${outcome.modelVersion}\n`,
        );
      }
      process.stdout.write(`scored ${leadIds.length} leads\n`);
    });

  program
    .command('next')
    .description('Ranked daily queue with rendered draft + wa.me link + explanation')
    .option('--n <n>', 'batch size', '20')
    .option('--json', 'machine-readable output')
    .action(async (flags: Record<string, unknown>) => {
      const deps = getDeps();
      const items = await buildQueue(deps, { n: Number.parseInt(String(flags['n'] ?? '20'), 10) });
      if (flags['json'] === true) {
        process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
        return;
      }
      items.forEach((item, index) => {
        process.stdout.write(
          [
            `#${index + 1} ${item.leadName ?? item.domain ?? item.leadId} · ${item.platform}/${item.category} · ${item.wilaya}`,
            `   channel=${item.channel} target=${item.target} sendable=${item.sendableNow ? 'YES' : `NO (${item.policyReason})`}${
              item.exploration ? ' [exploration]' : ''
            }`,
            `   p(reply)=${item.pReply.toFixed(3)} EV=${item.ev.toFixed(2)} DZD priority=${item.priority.toFixed(4)}`,
            `   template=${item.templateId} variant=${item.variantId}`,
            `   link: ${item.waLink ?? item.handoffUrl}`,
            `   send: ${item.sendInstructions}`,
            `   draft:\n${item.message
              .split('\n')
              .map((line) => `     ${line}`)
              .join('\n')}`,
            `   why: ${item.explanation.slice(0, 3).join(' | ')}`,
          ].join('\n'),
        );
      });
      const sender = await senderSnapshot(deps);
      process.stdout.write(
        `\nsender: ${sender.sentToday}/${sender.dailyCap} sent today, next window ${sender.nextAllowedAt}\n`,
      );
    });

  program
    .command('outcome')
    .description('Record an outcome event (learning + lifecycle + suppression)')
    .argument('<leadId>')
    .argument('<stage>', 'contacted|replied|interested|signed_up|activated|paid|lost|blocked|reported|stop|not_interested')
    .option('--note <note>')
    .option('--channel <channel>')
    .action(async (leadId: string, stage: string, flags: Record<string, string>) => {
      const deps = getDeps();
      const result = await recordLeadOutcome(leadId, stage, deps, {
        ...(flags['note'] ? { note: flags['note'] } : {}),
        ...(flags['channel'] ? { channel: flags['channel'] as never } : {}),
      });
      if (!result) {
        process.stdout.write('lead not found\n');
        return;
      }
      process.stdout.write(
        `outcome ${stage}: ${result.previousState} → ${result.newState}${result.suppressed ? ' (SUPPRESSED)' : ''}\n${result.notes.join('\n')}\n`,
      );
    });

  program
    .command('suppress')
    .description('Add to the global suppression list (hard stop)')
    .argument('<value>', 'lead id, phone, email, domain or handle')
    .option('--type <type>', 'lead|phone|email|domain|handle', 'lead')
    .option('--reason <reason>', 'why', 'operator request')
    .action(async (value: string, flags: Record<string, string>) => {
      const deps = getDeps();
      await addSuppression(
        {
          type: (flags['type'] ?? 'lead') as 'lead' | 'phone' | 'email' | 'domain' | 'handle',
          value,
          reason: flags['reason'] ?? 'operator request',
          createdBy: deps.config.operator,
        },
        deps.db,
      );
      process.stdout.write(`suppressed ${flags['type'] ?? 'lead'}:${value}\n`);
    });

  program
    .command('annotate')
    .description('Add an operator annotation (stored as an observation)')
    .argument('<leadId>')
    .option('--key <key>', 'annotation key')
    .option('--value <value>', 'annotation value')
    .action(async (leadId: string, flags: Record<string, string>) => {
      const deps = getDeps();
      await insertObservation(
        {
          leadId,
          key: `annotation:${flags['key'] ?? 'note'}`,
          value: flags['value'] ?? '',
          confidence: 0.9,
          evidence: [{ location: 'operator', detail: 'manual annotation' }],
          source: 'operator',
          observedAt: deps.clock.now(),
        },
        deps.db,
      );
      await recordAudit(
        {
          actor: deps.config.operator,
          action: 'annotate',
          entityType: 'lead',
          entityId: leadId,
          detail: { key: flags['key'] ?? 'note' },
          at: deps.clock.now(),
        },
        deps.db,
      );
      process.stdout.write(`annotated ${leadId}\n`);
    });

  program
    .command('queries')
    .description('Query-yield stats + Thompson allocation for today\'s budget')
    .option('--budget <n>', 'total API calls to allocate', '20')
    .action(async (flags: Record<string, unknown>) => {
      const deps = getDeps();
      const rows = await searchQueryRows(deps);
      const stats = rows.map((row) => ({
        query: row.query,
        provider: row.provider,
        calls: row.calls,
        newQualified: row.newQualified,
        alpha: row.alpha,
        beta: row.beta,
        retired: row.retired,
        pinnedOff: row.pinnedOff,
        lastRunAt: row.lastRunAt,
      }));
      const updated = stats.map((stat) => updateQueryPosterior(stat, 0, 0));
      const { active, retired } = retireDeadQueries(updated.length > 0 ? updated : [newQueryStats('example query', 'brave')]);
      const allocation = allocateQueryBudget(active, {
        totalBudget: Number.parseInt(String(flags['budget'] ?? '20'), 10),
        perProviderBudget: Object.fromEntries(
          [...new Set(active.map((item) => item.provider))].map((provider) => [provider, 50]),
        ),
        rng: deps.rng,
      });
      process.stdout.write(`active queries: ${active.length}, retired: ${retired.length}\n`);
      for (const entry of allocation.slice(0, 25)) {
        process.stdout.write(`  ${entry.provider.padEnd(12)} ${entry.query}\n`);
      }
    });

  program
    .command('stats')
    .description('Funnel, calibration, per-template and per-query yield')
    .option('--json', 'machine-readable output')
    .action(async (flags: Record<string, unknown>) => {
      const deps = getDeps();
      const [states, funnel, model, sender, queries, outcomeRows, attemptRows] = await Promise.all([
        countLeadsByState(deps),
        loadFunnel(deps.db),
        loadActiveModel(deps.clock, deps.db),
        senderSnapshot(deps),
        searchQueryRows(deps),
        recentOutcomes(deps, 200),
        recentAttempts(deps, 200),
      ]);
      const payload = {
        states,
        funnel: funnel.stages.map((stage) => ({
          stage: stage.stage,
          n: stage.n,
          successes: stage.successes,
          mean: stage.posteriorMean,
          lower: stage.posteriorLower,
          wilsonLower: stage.wilsonLower,
          kappa: stage.kappa,
        })),
        model: { version: model.version, n: model.nObservations, metrics: model.metrics, coldStart: model.coldStart },
        sender: {
          sentToday: sender.sentToday,
          dailyCap: sender.dailyCap,
          utilisation: sender.utilisation,
          nextAllowedAt: sender.nextAllowedAt,
        },
        templates: attemptRows.reduce<Record<string, { drafted: number; sent: number }>>((acc, attempt) => {
          const entry = acc[attempt.templateId] ?? { drafted: 0, sent: 0 };
          entry.drafted += 1;
          if (attempt.status === 'sent_by_human') entry.sent += 1;
          acc[attempt.templateId] = entry;
          return acc;
        }, {}),
        topQueries: queries.slice(0, 10).map((query) => ({
          query: query.query,
          provider: query.provider,
          calls: query.calls,
          newQualified: query.newQualified,
        })),
        recentOutcomes: outcomeRows.slice(0, 10),
      };
      if (flags['json'] === true) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }
      process.stdout.write(`leads by state: ${JSON.stringify(states)}\n\nfunnel:\n`);
      for (const stage of funnel.stages) {
        process.stdout.write(
          `  ${stage.stage.padEnd(12)} n=${String(stage.n).padStart(4)} rate=${stage.posteriorMean.toFixed(3)} lower95=${stage.posteriorLower.toFixed(3)} kappa=${stage.kappa.toFixed(1)}\n`,
        );
      }
      process.stdout.write(`\n${modelSummary(model)}\n`);
      process.stdout.write(
        `\nsender: ${sender.sentToday}/${sender.dailyCap} today (${(sender.utilisation * 100).toFixed(0)}%), next ${sender.nextAllowedAt}\n`,
      );
      process.stdout.write(`\ntemplates:\n`);
      for (const [templateId, counts] of Object.entries(payload.templates)) {
        process.stdout.write(`  ${templateId.padEnd(34)} drafted=${counts.drafted} sent=${counts.sent}\n`);
      }
      process.stdout.write(`\ntop queries:\n`);
      for (const query of payload.topQueries) {
        process.stdout.write(`  ${query.provider.padEnd(12)} calls=${query.calls} qualified=${query.newQualified} ${query.query}\n`);
      }
    });

  program
    .command('model')
    .description('Model utilities')
    .argument('<action>', 'refit | show')
    .action(async (action: string) => {
      const deps = getDeps();
      if (action === 'refit') {
        const result = await refitModels(deps);
        process.stdout.write(`${result.modelSummary}\n`);
        return;
      }
      const model = await loadActiveModel(deps.clock, deps.db);
      process.stdout.write(`${modelSummary(model)}\n`);
    });

  program
    .command('classify')
    .description('Debug: classify a text blob (category NB + evidence fusion demo)')
    .argument('<text>')
    .action((text: string) => {
      const prediction = classifyCategories({ text });
      process.stdout.write(`top: ${prediction.top.map((entry) => `${entry.category}=${entry.probability.toFixed(3)}`).join(', ')}${prediction.abstained ? ' (abstained)' : ''}\n`);
      const fusion = fuseEvidence(
        [
          { hypothesis: 'a', logLr: 2.2, clusterId: 'c1' },
          { hypothesis: 'b', logLr: 1.1, clusterId: 'c2' },
        ],
        { priors: { a: 0.5, b: 0.5 } },
      );
      process.stdout.write(`fusion demo probabilities: ${JSON.stringify(fusion.probabilities)}\n`);
    });

  program
    .command('export')
    .description('Export a lead (privacy: access request)')
    .argument('<leadId>')
    .option('--out <path>', 'write JSON to a file')
    .action(async (leadId: string, flags: Record<string, string>) => {
      const deps = getDeps();
      const bundle = await exportLeadBundle(leadId, deps.db);
      const serialized = JSON.stringify(bundle, null, 2);
      if (flags['out']) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(flags['out'], serialized, 'utf8');
        process.stdout.write(`exported to ${flags['out']}\n`);
        return;
      }
      process.stdout.write(`${serialized}\n`);
    });

  program
    .command('purge')
    .description('Retention purge (privacy: erasure)')
    .option('--days <n>', 'delete observations/outcomes older than N days')
    .option('--lead <id>', 'hard-delete one lead and all its data')
    .action(async (flags: Record<string, unknown>) => {
      const deps = getDeps();
      if (typeof flags['lead'] === 'string') {
        await purgeLeadData(flags['lead'], deps.db);
        process.stdout.write(`purged lead ${flags['lead']}\n`);
        return;
      }
      const days = Number.parseInt(String(flags['days'] ?? deps.config.retentionDays), 10);
      const cutoff = new Date(deps.clock.now().getTime() - days * 86_400_000);
      const result = await purgeOldData(cutoff, deps.db);
      process.stdout.write(
        `purged observations=${result.observations} outcomes=${result.outcomes} older than ${cutoff.toISOString()} (retention ${days}d, Algerian Law 18-07 note in docs/SOURCES.md)\n`,
      );
    });

  program
    .command('attempts')
    .description('List recent drafts/sends')
    .option('--limit <n>', 'rows', '20')
    .action(async (flags: Record<string, unknown>) => {
      const deps = getDeps();
      const rows = await recentAttempts(deps, Number.parseInt(String(flags['limit'] ?? '20'), 10));
      for (const row of rows) {
        process.stdout.write(
          `${row.createdAt.toISOString()} ${row.status.padEnd(14)} ${row.templateId.padEnd(30)} ${row.leadId.slice(0, 8)} ${row.channel}\n`,
        );
      }
    });

  program
    .command('observations')
    .description('List recent observations (append-only facts)')
    .option('--limit <n>', 'rows', '20')
    .action(async (flags: Record<string, unknown>) => {
      const deps = getDeps();
      const rows = await recentObservations(deps, Number.parseInt(String(flags['limit'] ?? '20'), 10));
      for (const row of rows) {
        process.stdout.write(
          `${row.observedAt.toISOString()} ${row.leadId.slice(0, 8)} ${row.key.padEnd(28)} ${row.value.slice(0, 60)} (c=${row.confidence.toFixed(2)})\n`,
        );
      }
    });

  program
    .command('draft')
    .description('Render (and store) a draft for one lead')
    .argument('<leadId>')
    .option('--json', 'machine-readable output')
    .action(async (leadId: string, flags: Record<string, unknown>) => {
      const deps = getDeps();
      const item = await draftLead(leadId, deps, { forceDraft: true });
      if (!item) {
        process.stdout.write('nothing to draft (no contactable channel)\n');
        return;
      }
      if (flags['json'] === true) {
        process.stdout.write(`${JSON.stringify(item, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `${item.leadName ?? item.leadId}\nchannel=${item.channel} target=${item.target}\nlink=${item.waLink ?? item.handoffUrl}\nsendable=${item.sendableNow} (${item.policyReason})\n\n${item.message}\n`,
      );
    });

  program
    .command('demo-seed')
    .description('Seed the offline synthetic population into the DB (demo/sim only)')
    .option('--size <n>', 'merchants', '24')
    .action(async (flags: Record<string, unknown>) => {
      const deps = getDeps();
      const candidates = await fetchDemoCandidates(deps, Number.parseInt(String(flags['size'] ?? '24'), 10));
      const result = await ingestCandidates(candidates, deps);
      process.stdout.write(`demo seed: ${result.created} new leads, ${result.updated} updated\n`);
    });

  program
    .command('ev-config')
    .description('Show the EV configuration in use (baseline ORDELY PRO pricing)')
    .action(() => {
      process.stdout.write(`${JSON.stringify(DEFAULT_EV_CONFIG, null, 2)}\n`);
    });

  program
    .command('worker')
    .argument('<action>', 'start')
    .description('Worker process control')
    .action(async (action: string) => {
      if (action !== 'start') {
        process.stdout.write('only `worker start` is supported\n');
        return;
      }
      const { startWorker } = await import('@/worker/index');
      await startWorker(getDeps());
    });

  program
    .command('sim')
    .argument('<action>', 'run')
    .option('--sends <n>', 'simulated sends', '1000')
    .option('--population <n>', 'synthetic merchants', '400')
    .description('Synthetic population simulation with hidden ground truth')
    .action(async (action: string, flags: Record<string, unknown>) => {
      if (action !== 'run') {
        process.stdout.write('only `sim run` is supported\n');
        return;
      }
      const { runSimulation } = await import('@/sim/run');
      const report = runSimulation({
        sends: Number.parseInt(String(flags['sends'] ?? '1000'), 10),
        population: Number.parseInt(String(flags['population'] ?? '400'), 10),
        seed: getDeps().config.seed,
      });
      process.stdout.write(`${report}\n`);
    });

  program
    .command('demo')
    .description('Offline end-to-end run on fixtures (no network)')
    .action(async () => {
      const { runDemo } = await import('@/demo/run');
      const report = await runDemo(getDeps());
      process.stdout.write(`${report}\n`);
    });

  return program;
}

async function selectLeadIds(
  deps: CliDeps,
  flags: Record<string, unknown>,
  states: string[] = ['new', 'enriched', 'qualified', 'queued', 'drafted'],
): Promise<string[]> {
  if (typeof flags['lead'] === 'string' && flags['lead'].length > 0) return [flags['lead']];
  const limit = Number.parseInt(String(flags['limit'] ?? '25'), 10);
  const rows = await deps.db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(
      and(
        isNull(leadsTable.deletedAt),
        isNull(leadsTable.mergedIntoId),
        inArray(leadsTable.state, states as never),
      ),
    )
    .orderBy(desc(leadsTable.lastSeenAt))
    .limit(limit);
  return rows.map((row) => row.id);
}

void suppressionsForExport;
void hardDeleteLead;
void ensureSenderState;

export default buildProgram;
