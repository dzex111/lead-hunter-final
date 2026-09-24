import type { Rng } from '@/core/random';
import { wilsonUpperBound } from '@/core/math/beta';
import { clamp } from '@/core/util';

/**
 * Query bandit: every generated search query keeps yield statistics
 * (NEW qualified leads per API call). The daily query budget is allocated by
 * Thompson sampling over Beta(α, β) where α counts qualified leads and β counts
 * wasted calls. Dead queries are retired when their Wilson upper bound is below
 * the configured floor at a minimum number of calls.
 */
export interface QueryStats {
  query: string;
  provider: string;
  calls: number;
  newQualified: number;
  /** Beta posterior parameters, updated incrementally and persisted. */
  alpha: number;
  beta: number;
  retired: boolean;
  lastRunAt: Date | null;
  /** Retired-by-human flag; the engine never un-retires automatically. */
  pinnedOff?: boolean;
}

export interface BanditConfig {
  /** Units of yield that count as a full success per call. */
  yieldPerCallTarget: number;
  retireMinCalls: number;
  retireUpperBoundFloor: number;
}

export const DEFAULT_BANDIT_CONFIG: BanditConfig = {
  yieldPerCallTarget: 1,
  retireMinCalls: 8,
  retireUpperBoundFloor: 0.06,
};

export function newQueryStats(query: string, provider: string): QueryStats {
  return { query, provider, calls: 0, newQualified: 0, alpha: 1, beta: 1, retired: false, lastRunAt: null };
}

/** Outcome update: rewards are yield-scaled so multi-lead calls compound. */
export function updateQueryPosterior(
  stats: QueryStats,
  calls: number,
  newQualified: number,
  config: BanditConfig = DEFAULT_BANDIT_CONFIG,
): QueryStats {
  const scale = Math.max(config.yieldPerCallTarget, 1e-6);
  const rewards = newQualified / scale;
  const failures = Math.max(0, calls - rewards);
  return {
    ...stats,
    calls: stats.calls + calls,
    newQualified: stats.newQualified + newQualified,
    alpha: stats.alpha + rewards,
    beta: stats.beta + failures,
    lastRunAt: stats.lastRunAt,
  };
}

export function retireDeadQueries(
  stats: readonly QueryStats[],
  config: BanditConfig = DEFAULT_BANDIT_CONFIG,
): { retired: QueryStats[]; active: QueryStats[] } {
  const retired: QueryStats[] = [];
  const active: QueryStats[] = [];
  for (const item of stats) {
    if (item.pinnedOff === true) {
      retired.push(item);
      continue;
    }
    // Yield is measured per call, so cap successes at the number of calls: a
    // query that produced 24 qualified leads in 10 calls still has a 100% hit rate.
    const wins = Math.min(item.newQualified, item.calls);
    const upper = wilsonUpperBound(wins, Math.max(item.calls, 1));
    const dead = item.calls >= config.retireMinCalls && upper < config.retireUpperBoundFloor;
    if (dead) {
      retired.push({ ...item, retired: true });
    } else {
      active.push({ ...item, retired: false });
    }
  }
  return { retired, active };
}

export function allocateQueryBudget(
  stats: readonly QueryStats[],
  options: {
    totalBudget: number;
    perProviderBudget: Record<string, number>;
    rng: Rng;
    config?: BanditConfig;
  },
): { provider: string; query: string; sampled: number }[] {
  const config = options.config ?? DEFAULT_BANDIT_CONFIG;
  const remaining = new Map<string, number>(
    Object.entries(options.perProviderBudget).map(([provider, budget]) => [provider, budget]),
  );
  const pool = stats.filter((item) => item.retired !== true && item.pinnedOff !== true);
  const allocation: { provider: string; query: string; sampled: number }[] = [];
  for (let step = 0; step < options.totalBudget; step += 1) {
    const eligible = pool.filter((item) => (remaining.get(item.provider) ?? 0) > 0);
    if (eligible.length === 0) break;
    let best: { item: QueryStats; sampled: number } | null = null;
    for (const item of eligible) {
      const sampled = options.rng.beta(item.alpha, item.beta);
      if (!best || sampled > best.sampled) best = { item, sampled };
    }
    if (!best) break;
    allocation.push({ provider: best.item.provider, query: best.item.query, sampled: best.sampled });
    remaining.set(best.item.provider, (remaining.get(best.item.provider) ?? 1) - 1);
  }
  void config;
  return allocation;
}

/**
 * Cumulative regret helper used by the simulation: regret vs an oracle that
 * always plays the best-known arm.
 */
export function cumulativeRegret(observed: readonly number[], bestExpectedRate: number): number {
  let regret = 0;
  for (const rate of observed) regret += Math.max(0, bestExpectedRate - rate);
  return regret;
}

export function queryPriorFromPattern(pattern: string): number {
  // Longer, more specific queries have a slightly higher prior yield.
  const specificity = clamp(pattern.split(/\s+/).length / 12, 0, 1);
  return 0.15 + 0.2 * specificity;
}
