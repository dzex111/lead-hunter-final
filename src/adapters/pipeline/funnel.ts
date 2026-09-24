import { eq } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { leads as leadsTable, outcomes as outcomesTable } from '@/adapters/db/tables';
import type { Db } from '@/adapters/db/repo';
import { STAGE_RANK } from '@/core/lifecycle/state';
import {
  betaLowerBound,
  betaMean,
  empiricalBayesKappa,
  partialPool,
  wilsonInterval,
  type SegmentCounts,
} from '@/core/math/beta';
import type { LeadState } from '@/core/types';
import { clamp } from '@/core/util';

/**
 * Funnel estimation. Each stage is Beta-Binomial with hierarchical partial
 * pooling across segments (platform × category × channel); kappa comes from
 * empirical Bayes (method of moments). We report the posterior mean *and* the
 * Wilson lower bound so the operator sees how much evidence there really is.
 */
export const FUNNEL_TRANSITIONS = [
  { from: 'sent', to: 'replied', name: 'replied' },
  { from: 'replied', to: 'interested', name: 'interested' },
  { from: 'interested', to: 'signed_up', name: 'signed_up' },
  { from: 'signed_up', to: 'activated', name: 'activated' },
  { from: 'activated', to: 'paid', name: 'paid' },
] as const;

export interface FunnelStageReport {
  stage: string;
  globalRate: number;
  posteriorMean: number;
  posteriorLower: number;
  alpha: number;
  beta: number;
  n: number;
  successes: number;
  kappa: number;
  wilsonLower: number;
  wilsonUpper: number;
  segments: number;
}

export interface FunnelReport {
  stages: FunnelStageReport[];
  segments: { key: string; reached: Record<string, number> }[];
  kappaByStage: Record<string, number>;
  totalLeads: number;
}

interface ReachedRow {
  leadId: string;
  stage: string;
  platform: string;
  category: string;
  channel: string;
}

export function segmentKey(row: { platform: string; category: string; channel: string }): string {
  return `${row.platform}|${row.category}|${row.channel}`;
}

export function computeFunnel(rows: readonly ReachedRow[]): FunnelReport {
  const stageNames = FUNNEL_TRANSITIONS.map((transition) => transition.name);
  const byLead = new Map<string, { maxRank: number; platform: string; category: string; channel: string }>();
  for (const row of rows) {
    const rank = STAGE_RANK[row.stage as LeadState] ?? 0;
    const existing = byLead.get(row.leadId);
    if (!existing) {
      byLead.set(row.leadId, {
        maxRank: rank,
        platform: row.platform,
        category: row.category,
        channel: row.channel,
      });
      continue;
    }
    existing.maxRank = Math.max(existing.maxRank, rank);
  }

  const thresholds = [5, 6, 7, 8, 9, 10]; // sent, replied, interested, signed_up, activated, paid
  const segmentCounters = new Map<string, number[]>();
  let reachedSent = 0;
  for (const entry of byLead.values()) {
    if (entry.maxRank < 5) continue;
    reachedSent += 1;
    const key = segmentKey(entry);
    const counters = segmentCounters.get(key) ?? new Array<number>(thresholds.length).fill(0);
    thresholds.forEach((threshold, index) => {
      if (entry.maxRank >= threshold) counters[index] = (counters[index] ?? 0) + 1;
    });
    segmentCounters.set(key, counters);
  }

  const kappaByStage: Record<string, number> = {};
  const stages: FunnelStageReport[] = [];
  const transitionIndex = [0, 1, 2, 3, 4];

  for (const index of transitionIndex) {
    const transition = FUNNEL_TRANSITIONS[index];
    if (!transition) continue;
    const stageIndex = index + 1;
    const segments: SegmentCounts[] = [];
    let successes = 0;
    let n = 0;
    for (const [key, counters] of segmentCounters) {
      const base = counters[index] ?? 0;
      const next = counters[stageIndex] ?? 0;
      if (base === 0) continue;
      segments.push({ key, successes: next, n: base });
      successes += next;
      n += base;
    }
    const globalRate = n === 0 ? 0 : successes / n;
    const kappa = empiricalBayesKappa(segments);
    kappaByStage[transition.name] = kappa;
    stages.push({
      stage: transition.name,
      globalRate,
      posteriorMean: betaMean(successes + 1, n - successes + 1),
      posteriorLower: betaLowerBound(successes + 1, n - successes + 1, 0.95),
      alpha: successes + 1,
      beta: n - successes + 1,
      n,
      successes,
      kappa,
      wilsonLower: wilsonInterval(successes, n).lower,
      wilsonUpper: wilsonInterval(successes, n).upper,
      segments: segments.length,
    });
  }

  return {
    stages,
    segments: [...segmentCounters.entries()].map(([key, counters]) => ({
      key,
      reached: Object.fromEntries(thresholds.map((threshold, i) => [String(threshold), counters[i] ?? 0])),
    })),
    kappaByStage,
    totalLeads: byLead.size,
  };
}

export async function loadFunnel(db: Db = defaultDb): Promise<FunnelReport> {
  const rows = await db
    .select({
      leadId: outcomesTable.leadId,
      stage: outcomesTable.stage,
      platform: leadsTable.platform,
      category: leadsTable.category,
      channel: outcomesTable.channel,
    })
    .from(outcomesTable)
    .innerJoin(leadsTable, eq(outcomesTable.leadId, leadsTable.id))
    .limit(50_000);

  return computeFunnel(
    rows.map((row) => ({
      leadId: row.leadId,
      stage: row.stage,
      platform: row.platform ?? 'none',
      category: row.category ?? 'other',
      channel: row.channel ?? 'whatsapp',
    })),
  );
}



export interface SegmentPosterior {
  stage: string;
  mean: number;
  lower: number;
  n: number;
  usedSegment: boolean;
}

/** Segment-specific posterior with hierarchical shrinkage toward the global rate. */
export function segmentPosterior(
  report: FunnelReport,
  segment: { platform: string; category: string; channel: string },
): SegmentPosterior[] {
  const key = segmentKey(segment);
  const segmentData = report.segments.find((entry) => entry.key === key);
  const out: SegmentPosterior[] = [];
  FUNNEL_TRANSITIONS.forEach((transition, index) => {
    const stage = report.stages.find((entry) => entry.stage === transition.name);
    if (!stage) return;
    const baseReached = segmentData?.reached[String(5 + index)] ?? 0;
    const nextReached = segmentData?.reached[String(6 + index)] ?? 0;
    const kappa = stage.kappa;
    const own: SegmentCounts = { key, successes: nextReached, n: baseReached };
    const pooled = partialPool(own.successes, own.n, stage.globalRate || 0.1, kappa);
    out.push({
      stage: transition.name,
      mean: clamp(pooled.mean, 0, 1),
      lower: clamp(betaLowerBound(pooled.alpha, pooled.beta, 0.95), 0, 1),
      n: own.n,
      usedSegment: own.n > 0,
    });
  });
  return out;
}
