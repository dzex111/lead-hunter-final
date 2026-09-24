import type { Rng } from '@/core/random';
import { clamp } from '@/core/util';

/**
 * Daily batch selection: greedy MMR re-ranking over the
 * (platform, category, wilaya) diversity space, plus an exploration quota drawn
 * by Thompson sampling so the queue is not a pure exploitation loop.
 */
export interface BatchCandidate {
  id: string;
  /** Ranking score (UCB / priority) used by the relevance term. */
  score: number;
  platform: string;
  category: string;
  wilaya: string;
  /** Thompson-sampled probability from the logistic posterior (exploration). */
  sampledP?: number;
  channel?: string;
}

export interface MmrOptions {
  n: number;
  /** 0 = pure diversity, 1 = pure relevance. Default 0.75. */
  lambda?: number;
  explorationQuota?: number;
  rng: Rng;
}

export function diversityDistance(a: BatchCandidate, b: BatchCandidate): number {
  const dims = [
    a.platform !== b.platform ? 1 : 0,
    a.category !== b.category ? 1 : 0,
    a.wilaya !== b.wilaya ? 1 : 0,
  ];
  return dims.reduce((acc, value) => acc + value, 0) / dims.length;
}

export function mmrRank(candidates: readonly BatchCandidate[], options: MmrOptions): BatchCandidate[] {
  const lambda = options.lambda ?? 0.75;
  const pool = [...candidates].sort((a, b) => b.score - a.score);
  const selected: BatchCandidate[] = [];
  while (selected.length < options.n && pool.length > 0) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    pool.forEach((candidate, index) => {
      const maxSimilarity =
        selected.length === 0
          ? 0
          : Math.max(...selected.map((chosen) => 1 - diversityDistance(candidate, chosen)));
      const value = lambda * candidate.score - (1 - lambda) * maxSimilarity;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    });
    const [chosen] = pool.splice(bestIndex, 1);
    if (chosen) selected.push(chosen);
  }
  return selected;
}

export interface BatchSelection extends BatchCandidate {
  exploration: boolean;
}

/**
 * MMR for the exploitation slots; Thompson sampling for the exploration quota.
 * The exploration quota is filled from leads that are *not* already selected,
 * ranked by their sampled posterior probability.
 */
export function selectDailyBatch(
  candidates: readonly BatchCandidate[],
  options: MmrOptions & { explorationRate?: number },
): BatchSelection[] {
  const n = Math.max(1, options.n);
  const rate = options.explorationRate ?? 0.1;
  const explorationSlots = Math.max(1, Math.round(n * rate));
  const exploitationSlots = Math.max(1, n - explorationSlots);

  // The exploitation pass must leave the exploration quota room even when the
  // pool is small (otherwise a thin queue would never explore).
  const exploitationCap = Math.max(1, Math.min(exploitationSlots, candidates.length - explorationSlots));
  const exploitation = mmrRank(candidates, { ...options, n: exploitationCap });
  const chosenIds = new Set(exploitation.map((candidate) => candidate.id));
  const remaining = candidates.filter((candidate) => !chosenIds.has(candidate.id));
  const explorationPool = [...remaining].sort((a, b) => {
    const left = a.sampledP ?? options.rng.next();
    const right = b.sampledP ?? options.rng.next();
    return right - left;
  });
  const exploration = explorationPool.slice(0, explorationSlots);

  return [
    ...exploitation.map((candidate) => ({ ...candidate, exploration: false })),
    ...exploration.map((candidate) => ({ ...candidate, exploration: true })),
  ].slice(0, n);
}

/** Diversity coverage diagnostics for the `stats` command. */
export function diversityReport(batch: readonly BatchCandidate[]): {
  platforms: number;
  categories: number;
  wilayas: number;
  meanPairwiseDistance: number;
} {
  const platforms = new Set(batch.map((item) => item.platform)).size;
  const categories = new Set(batch.map((item) => item.category)).size;
  const wilayas = new Set(batch.map((item) => item.wilaya)).size;
  let pairs = 0;
  let total = 0;
  for (let i = 0; i < batch.length; i += 1) {
    for (let j = i + 1; j < batch.length; j += 1) {
      const a = batch[i];
      const b = batch[j];
      if (!a || !b) continue;
      total += diversityDistance(a, b);
      pairs += 1;
    }
  }
  return {
    platforms,
    categories,
    wilayas,
    meanPairwiseDistance: pairs === 0 ? 0 : clamp(total / pairs, 0, 1),
  };
}
