import { jaroWinkler, tokenSetSimilarity } from '@/core/normalize/text';
import { clamp, sigmoid, stableStringify } from '@/core/util';

/**
 * Entity resolution: blocking keys → candidate pairs → Fellegi-Sunter
 * log-likelihood weights → auto-merge / review / distinct, with union-find
 * clustering and a reversible merge log.
 *
 * Thresholds: posterior >= 0.97 auto-merge, 0.60–0.97 review, < 0.60 distinct.
 * A pair with conflicting strong identities (two different storefront domains or
 * two different phone numbers) is ALWAYS sent to review, never auto-merged.
 */
export interface ResolveRecord {
  id: string;
  name?: string;
  domain?: string;
  phones?: string[];
  emails?: string[];
  handles?: string[];
  wilaya?: string | null;
  category?: string | null;
}

export interface FieldModel {
  /** m = P(field agrees | same entity) */
  m: number;
  /** u = P(field agrees | different entity) */
  u: number;
}

export const FS_CONFIDENCE = 0.99;
export const FS_FIELD_MODELS: Record<string, FieldModel> = {
  domain: { m: 0.55 * FS_CONFIDENCE, u: 0.004 },
  phone: { m: 0.4 * FS_CONFIDENCE, u: 0.0012 },
  whatsapp: { m: 0.36 * FS_CONFIDENCE, u: 0.0016 },
  email: { m: 0.3 * FS_CONFIDENCE, u: 0.0008 },
  handle: { m: 0.42 * FS_CONFIDENCE, u: 0.0022 },
  name: { m: 0.5 * FS_CONFIDENCE, u: 0.28 },
  wilaya: { m: 0.55, u: 0.16 },
  category: { m: 0.6, u: 0.2 },
};

export const FS_THRESHOLDS = {
  autoMerge: 0.97,
  review: 0.6,
} as const;

/**
 * Conflict rule: a pair with conflicting strong identities (two storefront
 * domains or two phone numbers) can never auto-merge — the evidence that would
 * otherwise merge it (>= autoMerge posterior) is downgraded to the review queue.
 * Pairs below autoMerge follow the normal 0.60 / 0.97 thresholds, which keeps
 * the review queue from being flooded by weakly-similar blocked pairs.
 */
export const CONFLICT_DOWNGRADES_TO_REVIEW = true;

/** Prior odds that a random pair of blocked candidates is the same entity. */
export const FS_PRIOR_PROBABILITY = 0.05;

export interface PairDecision {
  leftId: string;
  rightId: string;
  logWeight: number;
  posterior: number;
  matchedOn: string[];
  blockers: string[];
  conflicting: boolean;
  decision: 'auto_merge' | 'review' | 'distinct';
  explanation: string;
}

export function blockingKeys(record: ResolveRecord): string[] {
  const keys: string[] = [];
  if (record.domain) keys.push(`domain:${record.domain.toLowerCase()}`);
  for (const phone of record.phones ?? []) keys.push(`phone:${phone}`);
  for (const email of record.emails ?? []) keys.push(`email:${email.toLowerCase()}`);
  for (const handle of record.handles ?? []) keys.push(`handle:${handle.toLowerCase()}`);
  if (record.name) {
    for (const token of record.name.toLowerCase().split(/\s+/).filter((t) => t.length > 3)) {
      keys.push(`token:${token}`);
    }
  }
  return keys;
}

export function blockingIndex(records: readonly ResolveRecord[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const record of records) {
    for (const key of blockingKeys(record)) {
      const bucket = index.get(key);
      if (bucket) bucket.push(record.id);
      else index.set(key, [record.id]);
    }
  }
  return index;
}

export function candidatePairs(
  records: readonly ResolveRecord[],
): { left: ResolveRecord; right: ResolveRecord; blockers: string[] }[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const index = blockingIndex(records);
  const seen = new Set<string>();
  const pairs: { left: ResolveRecord; right: ResolveRecord; blockers: string[] }[] = [];
  for (const [key, ids] of index) {
    const unique = Array.from(new Set(ids));
    if (unique.length < 2 || unique.length > 400) continue;
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const leftId = unique[i];
        const rightId = unique[j];
        if (!leftId || !rightId) continue;
        const pairKey = leftId < rightId ? `${leftId}|${rightId}` : `${rightId}|${leftId}`;
        if (seen.has(pairKey)) {
          const existing = pairs.find(
            (pair) =>
              (pair.left.id === leftId && pair.right.id === rightId) ||
              (pair.left.id === rightId && pair.right.id === leftId),
          );
          if (existing && !existing.blockers.includes(key)) existing.blockers.push(key);
          continue;
        }
        const left = byId.get(leftId);
        const right = byId.get(rightId);
        if (!left || !right) continue;
        seen.add(pairKey);
        pairs.push({ left, right, blockers: [key] });
      }
    }
  }
  return pairs;
}

function agreement(field: string, agrees: boolean): number {
  const model = FS_FIELD_MODELS[field];
  if (!model) return 0;
  const agreementWeight = Math.log2(model.m / model.u);
  const disagreementWeight = Math.log2((1 - model.m) / (1 - model.u));
  return agrees ? agreementWeight : disagreementWeight;
}

export interface FsConfig {
  nameJaroThreshold: number;
  nameTokenThreshold: number;
  autoMerge: number;
  review: number;
  priorProbability: number;
}

export const FS_CONFIG: FsConfig = {
  nameJaroThreshold: 0.9,
  nameTokenThreshold: 0.85,
  autoMerge: FS_THRESHOLDS.autoMerge,
  review: FS_THRESHOLDS.review,
  priorProbability: FS_PRIOR_PROBABILITY,
};

export function comparePair(
  left: ResolveRecord,
  right: ResolveRecord,
  blockers: readonly string[],
  config: FsConfig = FS_CONFIG,
): PairDecision {
  let logWeight = 0;
  const matchedOn: string[] = [];

  const leftDomains = left.domain ? [left.domain.toLowerCase()] : [];
  const rightDomains = right.domain ? [right.domain.toLowerCase()] : [];
  const sameDomain = leftDomains.some((domain) => rightDomains.includes(domain));
  if (leftDomains.length > 0 && rightDomains.length > 0) {
    logWeight += agreement('domain', sameDomain);
    if (sameDomain) matchedOn.push('domain');
  }
  const conflictingDomains = leftDomains.length > 0 && rightDomains.length > 0 && !sameDomain;

  const leftPhones = left.phones ?? [];
  const rightPhones = right.phones ?? [];
  const sharedPhones = leftPhones.filter((phone) => rightPhones.includes(phone));
  if (leftPhones.length > 0 && rightPhones.length > 0) {
    logWeight += agreement('phone', sharedPhones.length > 0);
    logWeight += agreement('whatsapp', sharedPhones.length > 1);
    if (sharedPhones.length > 0) matchedOn.push('phone');
  }
  const conflictingPhones = leftPhones.length > 0 && rightPhones.length > 0 && sharedPhones.length === 0;

  const leftEmails = (left.emails ?? []).map((email) => email.toLowerCase());
  const rightEmails = (right.emails ?? []).map((email) => email.toLowerCase());
  if (leftEmails.length > 0 && rightEmails.length > 0) {
    const shared = leftEmails.some((email) => rightEmails.includes(email));
    logWeight += agreement('email', shared);
    if (shared) matchedOn.push('email');
  }

  const leftHandles = (left.handles ?? []).map((handle) => handle.toLowerCase());
  const rightHandles = (right.handles ?? []).map((handle) => handle.toLowerCase());
  if (leftHandles.length > 0 && rightHandles.length > 0) {
    const shared = leftHandles.filter((handle) => rightHandles.includes(handle));
    logWeight += agreement('handle', shared.length > 0);
    if (shared.length > 0) matchedOn.push('handle');
  }

  if (left.name && right.name) {
    const jaro = jaroWinkler(left.name, right.name);
    const token = tokenSetSimilarity(left.name, right.name);
    const agrees = jaro >= config.nameJaroThreshold || token >= config.nameTokenThreshold;
    logWeight += agreement('name', agrees);
    if (agrees) matchedOn.push('name');
    if (!agrees && (sameDomain || sharedPhones.length > 0)) {
      // Weak name disagreement cannot override a strong identity match.
      logWeight += Math.max(-1.2, agreement('name', false) / 3);
    }
  }

  if (left.wilaya && right.wilaya) {
    logWeight += agreement('wilaya', left.wilaya === right.wilaya);
    if (left.wilaya === right.wilaya) matchedOn.push('wilaya');
  }
  if (left.category && right.category) {
    logWeight += agreement('category', left.category === right.category);
    if (left.category === right.category) matchedOn.push('category');
  }

  const priorLogOdds = Math.log(
    config.priorProbability / (1 - clamp(config.priorProbability, 0, 0.999)),
  );
  const posterior = sigmoid(priorLogOdds + logWeight * Math.log(2));

  const conflicting = conflictingDomains || conflictingPhones;
  let decision: PairDecision['decision'];
  if (conflicting && posterior >= config.autoMerge) {
    // Never auto-merge on conflicting strong identities: a human decides.
    decision = 'review';
  } else if (posterior >= config.autoMerge) decision = 'auto_merge';
  else if (posterior >= config.review) decision = 'review';
  else decision = 'distinct';

  return {
    leftId: left.id,
    rightId: right.id,
    logWeight,
    posterior,
    matchedOn,
    blockers: [...blockers],
    conflicting,
    decision,
    explanation: buildExplanation({
      matchedOn,
      conflicting,
      conflictingDomains,
      conflictingPhones,
      posterior,
      decision,
      logWeight,
      blockers,
    }),
  };
}

function buildExplanation(input: {
  matchedOn: string[];
  conflicting: boolean;
  conflictingDomains: boolean;
  conflictingPhones: boolean;
  posterior: number;
  decision: PairDecision['decision'];
  logWeight: number;
  blockers: readonly string[];
}): string {
  const parts: string[] = [];
  parts.push(`blocked by ${input.blockers.join(', ')}`);
  if (input.matchedOn.length > 0) parts.push(`agreement on ${input.matchedOn.join(', ')}`);
  if (input.conflictingDomains) parts.push('CONFLICT: two different storefront domains');
  if (input.conflictingPhones) parts.push('CONFLICT: two different phone numbers');
  parts.push(`log2 weight ${input.logWeight.toFixed(2)} → P(same)=${input.posterior.toFixed(3)}`);
  parts.push(`decision: ${input.decision}`);
  return parts.join(' · ');
}

export interface UnionFindMerge {
  clusterOf: Map<string, string>;
  merges: PairDecision[];
  reviews: PairDecision[];
}

/**
 * Union-find clustering over auto-merge decisions only; review-queue pairs are
 * returned untouched for the human operator.
 */
export function clusterRecords(
  records: readonly ResolveRecord[],
  decisions: readonly PairDecision[],
): UnionFindMerge {
  const parent = new Map<string, string>();
  for (const record of records) parent.set(record.id, record.id);

  const find = (id: string): string => {
    let root = parent.get(id) ?? id;
    while (root !== (parent.get(root) ?? root)) {
      root = parent.get(root) ?? root;
    }
    // Path compression.
    let cursor = id;
    while (cursor !== root) {
      const next = parent.get(cursor) ?? root;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    const [keep, drop] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
    parent.set(drop, keep);
  };

  const merges: PairDecision[] = [];
  const reviews: PairDecision[] = [];
  for (const decision of decisions) {
    if (decision.decision === 'auto_merge') {
      union(decision.leftId, decision.rightId);
      merges.push(decision);
    } else if (decision.decision === 'review') {
      reviews.push(decision);
    }
  }

  const clusterOf = new Map<string, string>();
  for (const record of records) clusterOf.set(record.id, find(record.id));
  return { clusterOf, merges, reviews };
}

export function clusters(merge: UnionFindMerge): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, root] of merge.clusterOf) {
    const bucket = out.get(root);
    if (bucket) bucket.push(id);
    else out.set(root, [id]);
  }
  return out;
}

export interface MergeLogEntry {
  id: string;
  action: 'merge' | 'split' | 'review_decision';
  keptId: string;
  mergedId: string | null;
  decision: PairDecision | null;
  at: Date;
  operator: string;
  reversible: boolean;
}

export function makeMergeLogEntry(input: {
  id: string;
  action: MergeLogEntry['action'];
  keptId: string;
  mergedId?: string | null;
  decision?: PairDecision | null;
  at: Date;
  operator: string;
}): MergeLogEntry {
  return {
    id: input.id,
    action: input.action,
    keptId: input.keptId,
    mergedId: input.mergedId ?? null,
    decision: input.decision ?? null,
    at: input.at,
    operator: input.operator,
    reversible: true,
  };
}

export function mergeLogSignature(entry: MergeLogEntry): string {
  return stableStringify({
    action: entry.action,
    keptId: entry.keptId,
    mergedId: entry.mergedId,
  });
}

/** Precision/recall evaluation helper used by the synthetic labeled test set. */
export function evaluateDecisions(
  decisions: readonly PairDecision[],
  truth: Set<string>,
): { precision: number; recall: number; truePositives: number; falsePositives: number; falseNegatives: number } {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  const predicted = new Set<string>();
  for (const decision of decisions) {
    if (decision.decision === 'distinct') continue;
    const key = decision.leftId < decision.rightId ? `${decision.leftId}|${decision.rightId}` : `${decision.rightId}|${decision.leftId}`;
    predicted.add(key);
    if (truth.has(key)) truePositives += 1;
    else falsePositives += 1;
  }
  for (const key of truth) {
    if (!predicted.has(key)) falseNegatives += 1;
  }
  const precision = predicted.size === 0 ? 1 : truePositives / predicted.size;
  const recall = truth.size === 0 ? 1 : truePositives / (truePositives + falseNegatives);
  return { precision, recall, truePositives, falsePositives, falseNegatives };
}
