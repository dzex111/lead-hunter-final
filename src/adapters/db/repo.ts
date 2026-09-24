import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import {
  auditLog,
  customerExclusions,
  jobs,
  leadIdentities,
  leads,
  mergeLog,
  modelVersions,
  observations,
  outcomes,
  outreachAttempts,
  recurringSchedules,
  scores,
  searchQueries,
  senderDays,
  senderState,
  suppression,
  templateVariants,
  templates,
} from '@/adapters/db/tables';
import type { ChannelId, LeadState } from '@/core/types';
import { newId, stableStringify } from '@/core/util';

/**
 * Repository layer. All SQL for the engine lives here; the pure core never
 * imports it. Functions take an optional executor so callers can run inside a
 * transaction.
 */
export type Db = typeof defaultDb;

export interface LeadIdentityInput {
  type: 'domain' | 'phone' | 'whatsapp' | 'email' | 'facebook' | 'instagram' | 'tiktok' | 'etld1';
  value: string;
  normalizedValue: string;
  confidence?: number;
  source?: string;
}

export interface UpsertLeadInput {
  name: string | null;
  domain: string | null;
  sourceId: string;
  provenance: Record<string, unknown>;
  identities: LeadIdentityInput[];
  platform?: string | null;
  category?: string | null;
  wilaya?: string | null;
  primaryChannel?: ChannelId | null;
  primaryTarget?: string | null;
}

export async function findLeadByIdentity(
  identity: LeadIdentityInput,
  db: Db = defaultDb,
): Promise<string | null> {
  const rows = await db
    .select({ leadId: leadIdentities.leadId })
    .from(leadIdentities)
    .where(
      and(eq(leadIdentities.type, identity.type), eq(leadIdentities.normalizedValue, identity.normalizedValue)),
    )
    .limit(1);
  return rows[0]?.leadId ?? null;
}

export async function upsertLead(input: UpsertLeadInput, db: Db = defaultDb): Promise<{ id: string; created: boolean }> {
  for (const identity of input.identities) {
    const existing = await findLeadByIdentity(identity, db);
    if (existing) {
      await db
        .update(leads)
        .set({ lastSeenAt: new Date(), provenance: input.provenance })
        .where(eq(leads.id, existing));
      for (const extra of input.identities) {
        await insertIdentity(existing, extra, db);
      }
      return { id: existing, created: false };
    }
  }
  const id = newId();
  await db.insert(leads).values({
    id,
    name: input.name,
    domain: input.domain,
    state: 'new',
    sourceId: input.sourceId,
    provenance: input.provenance,
    platform: (input.platform ?? null) as never,
    category: (input.category ?? null) as never,
    wilaya: input.wilaya ?? null,
    primaryChannel: (input.primaryChannel ?? null) as never,
    primaryTarget: input.primaryTarget ?? null,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  });
  for (const identity of input.identities) {
    await insertIdentity(id, identity, db);
  }
  return { id, created: true };
}

export async function insertIdentity(
  leadId: string,
  identity: LeadIdentityInput,
  db: Db = defaultDb,
): Promise<void> {
  await db
    .insert(leadIdentities)
    .values({
      id: newId(),
      leadId,
      type: identity.type,
      value: identity.value,
      normalizedValue: identity.normalizedValue,
      source: identity.source ?? null,
      confidence: identity.confidence ?? null,
    })
    .onConflictDoNothing();
}

export async function getLead(id: string, db: Db = defaultDb) {
  const rows = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listLeads(
  options: { state?: LeadState[]; limit?: number; withDomainOnly?: boolean } = {},
  db: Db = defaultDb,
) {
  const limit = options.limit ?? 100;
  const conditions = [isNull(leads.deletedAt)];
  if (options.state && options.state.length > 0) conditions.push(inArray(leads.state, options.state));
  if (options.withDomainOnly === true) conditions.push(sql`${leads.domain} is not null`);
  return db
    .select()
    .from(leads)
    .where(and(...conditions))
    .orderBy(desc(leads.priority), desc(leads.lastSeenAt))
    .limit(limit);
}

export async function queuedLeads(limit = 50, db: Db = defaultDb) {
  return db
    .select()
    .from(leads)
    .where(and(inArray(leads.state, ['qualified', 'queued', 'drafted']), isNull(leads.deletedAt)))
    .orderBy(desc(leads.priority))
    .limit(limit);
}

export async function updateLeadState(
  id: string,
  state: LeadState,
  extra: { reason?: string | null } = {},
  db: Db = defaultDb,
): Promise<void> {
  await db
    .update(leads)
    .set({
      state,
      disqualifiedReason: state === 'disqualified' ? (extra.reason ?? null) : null,
      qualifiedAt: state === 'qualified' ? new Date() : undefined,
    })
    .where(eq(leads.id, id));
}

export async function updateLeadFacts(
  id: string,
  facts: Partial<{
    name: string | null;
    platform: string | null;
    category: string | null;
    wilaya: string | null;
    primaryChannel: ChannelId | null;
    primaryTarget: string | null;
    pAlgeria: number | null;
    pReply: number | null;
    maturityIndex: number | null;
    ev: number | null;
    priority: number | null;
    annotations: Record<string, unknown>;
    mergedIntoId: string | null;
  }>,
  db: Db = defaultDb,
): Promise<void> {
  await db
    .update(leads)
    .set({
      ...facts,
      platform: (facts.platform ?? undefined) as never,
      category: (facts.category ?? undefined) as never,
      primaryChannel: (facts.primaryChannel ?? undefined) as never,
    })
    .where(eq(leads.id, id));
}

export async function softDeleteLead(id: string, db: Db = defaultDb): Promise<void> {
  await db.update(leads).set({ deletedAt: new Date() }).where(eq(leads.id, id));
}

export async function hardDeleteLead(id: string, db: Db = defaultDb): Promise<void> {
  await db.delete(observations).where(eq(observations.leadId, id));
  await db.delete(scores).where(eq(scores.leadId, id));
  await db.delete(outreachAttempts).where(eq(outreachAttempts.leadId, id));
  await db.delete(outcomes).where(eq(outcomes.leadId, id));
  await db.delete(leadIdentities).where(eq(leadIdentities.leadId, id));
  await db.delete(leads).where(eq(leads.id, id));
}

export interface ObservationInput {
  leadId: string;
  key: string;
  value: string;
  confidence: number;
  evidence: unknown[];
  source: string;
  sourceUrl?: string | null;
  contentHash?: string | null;
  observedAt: Date;
  expiresAt?: Date | null;
}

export async function insertObservation(input: ObservationInput, db: Db = defaultDb): Promise<void> {
  await db.insert(observations).values({
    id: newId(),
    leadId: input.leadId,
    key: input.key,
    value: input.value,
    confidence: input.confidence,
    evidence: input.evidence,
    source: input.source,
    sourceUrl: input.sourceUrl ?? null,
    contentHash: input.contentHash ?? null,
    observedAt: input.observedAt,
    expiresAt: input.expiresAt ?? null,
  });
}

export async function listObservations(leadId: string, db: Db = defaultDb) {
  return db
    .select()
    .from(observations)
    .where(eq(observations.leadId, leadId))
    .orderBy(desc(observations.observedAt))
    .limit(500);
}

export async function latestObservations(
  leadIds: readonly string[],
  db: Db = defaultDb,
): Promise<Map<string, { key: string; value: string; confidence: number }[]>> {
  const out = new Map<string, { key: string; value: string; confidence: number }[]>();
  if (leadIds.length === 0) return out;
  const rows = await db
    .select({
      leadId: observations.leadId,
      key: observations.key,
      value: observations.value,
      confidence: observations.confidence,
    })
    .from(observations)
    .where(inArray(observations.leadId, [...leadIds]));
  for (const row of rows) {
    const bucket = out.get(row.leadId) ?? [];
    bucket.push({ key: row.key, value: row.value, confidence: row.confidence });
    out.set(row.leadId, bucket);
  }
  return out;
}

export async function insertScore(input: {
  leadId: string;
  modelVersion: string;
  features: Record<string, number>;
  contributions: unknown[];
  pReply: number;
  pInterested: number;
  pSignup: number;
  pActivate: number;
  pPaid: number;
  ev: number;
  effortSeconds: number;
  priority: number;
  ucb: number;
  exploration: boolean;
  explanation: string[];
}, db: Db = defaultDb): Promise<string> {
  const id = newId();
  await db.insert(scores).values({ id, ...input });
  return id;
}

export async function latestScore(leadId: string, db: Db = defaultDb) {
  const rows = await db
    .select()
    .from(scores)
    .where(eq(scores.leadId, leadId))
    .orderBy(desc(scores.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function latestScoresFor(
  leadIds: readonly string[],
  db: Db = defaultDb,
) {
  if (leadIds.length === 0) return new Map<string, Awaited<ReturnType<typeof latestScore>>>();
  const rows = await db
    .select()
    .from(scores)
    .where(inArray(scores.leadId, [...leadIds]))
    .orderBy(desc(scores.createdAt));
  const out = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!out.has(row.leadId)) out.set(row.leadId, row);
  }
  return out;
}

export async function createAttempt(input: {
  leadId: string;
  channel: ChannelId;
  target: string;
  templateId: string;
  variantId: string;
  body: string;
  handoff: Record<string, unknown>;
  status: 'drafted' | 'sent_by_human' | 'skipped';
  stage: string;
  policyReason: string | null;
  validationWarnings: string[];
}, db: Db = defaultDb): Promise<string> {
  const id = newId();
  await db.insert(outreachAttempts).values({ id, ...input });
  return id;
}

export async function markAttemptSent(attemptId: string, at: Date, db: Db = defaultDb): Promise<void> {
  await db
    .update(outreachAttempts)
    .set({ status: 'sent_by_human', sentAt: at })
    .where(eq(outreachAttempts.id, attemptId));
}

export async function listAttempts(leadId: string, db: Db = defaultDb) {
  return db
    .select()
    .from(outreachAttempts)
    .where(eq(outreachAttempts.leadId, leadId))
    .orderBy(desc(outreachAttempts.createdAt))
    .limit(100);
}

export async function listRecentAttempts(limit = 50, db: Db = defaultDb) {
  return db.select().from(outreachAttempts).orderBy(desc(outreachAttempts.createdAt)).limit(limit);
}

export async function recordOutcome(input: {
  leadId: string;
  attemptId?: string | null;
  stage: string;
  note?: string | null;
  occurredAt: Date;
  variantId?: string | null;
  channel?: ChannelId | null;
}, db: Db = defaultDb): Promise<string> {
  const id = newId();
  await db.insert(outcomes).values({
    id,
    leadId: input.leadId,
    attemptId: input.attemptId ?? null,
    stage: input.stage,
    note: input.note ?? null,
    occurredAt: input.occurredAt,
    variantId: input.variantId ?? null,
    channel: (input.channel ?? null) as never,
  });
  return id;
}

export async function listOutcomes(leadId: string, db: Db = defaultDb) {
  return db.select().from(outcomes).where(eq(outcomes.leadId, leadId)).orderBy(desc(outcomes.occurredAt));
}

export async function recordAudit(input: {
  actor: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
  at?: Date;
}, db: Db = defaultDb): Promise<void> {
  await db.insert(auditLog).values({
    id: newId(),
    actor: input.actor,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    detail: input.detail ?? {},
    at: input.at ?? new Date(),
  });
}

export async function listAudit(limit = 100, entityId?: string, db: Db = defaultDb) {
  const conditions = entityId ? [eq(auditLog.entityId, entityId)] : [];
  return db
    .select()
    .from(auditLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.at))
    .limit(limit);
}

export async function addSuppression(input: {
  type: 'lead' | 'phone' | 'email' | 'domain' | 'handle';
  value: string;
  reason: string;
  createdBy?: string;
}, db: Db = defaultDb): Promise<void> {
  await db
    .insert(suppression)
    .values({
      id: newId(),
      type: input.type,
      value: input.value,
      reason: input.reason,
      createdBy: input.createdBy ?? 'operator',
    })
    .onConflictDoNothing();
}

export async function isSuppressed(input: {
  leadId: string;
  values: readonly { type: string; value: string }[];
}, db: Db = defaultDb): Promise<boolean> {
  const candidates: { type: string; value: string }[] = [{ type: 'lead', value: input.leadId }, ...input.values];
  const pairs = candidates.map((candidate) =>
    and(eq(suppression.type, candidate.type), eq(suppression.value, candidate.value)),
  );
  const rows = await db
    .select({ id: suppression.id })
    .from(suppression)
    .where(or(...pairs))
    .limit(1);
  return rows.length > 0;
}

export async function listSuppression(limit = 200, db: Db = defaultDb) {
  return db.select().from(suppression).orderBy(desc(suppression.createdAt)).limit(limit);
}

export async function recordMergeLog(input: {
  action: 'merge' | 'split' | 'review_decision';
  keptLeadId: string;
  mergedLeadId?: string | null;
  decision?: Record<string, unknown> | null;
  operator?: string;
  at?: Date;
}, db: Db = defaultDb): Promise<string> {
  const id = newId();
  await db.insert(mergeLog).values({
    id,
    action: input.action,
    keptLeadId: input.keptLeadId,
    mergedLeadId: input.mergedLeadId ?? null,
    decision: input.decision ?? null,
    operator: input.operator ?? 'engine',
    createdAt: input.at ?? new Date(),
  });
  return id;
}

export async function listMergeLog(limit = 100, db: Db = defaultDb) {
  return db.select().from(mergeLog).orderBy(desc(mergeLog.createdAt)).limit(limit);
}

export async function revertMerge(mergeId: string, db: Db = defaultDb): Promise<void> {
  const rows = await db.select().from(mergeLog).where(eq(mergeLog.id, mergeId)).limit(1);
  const entry = rows[0];
  if (!entry || !entry.mergedLeadId) return;
  await db.update(leads).set({ mergedIntoId: null }).where(eq(leads.id, entry.mergedLeadId));
  await db.update(mergeLog).set({ revertedAt: new Date() }).where(eq(mergeLog.id, mergeId));
}

export async function ensureTemplates(
  rows: readonly {
    id: string;
    stage: string;
    label: string;
    description: string;
    slots: string[];
    channels: string[];
    platforms?: string[] | null;
    requiresLink: boolean;
    variants: readonly { id: string; language: string; body: string; priorSuccesses: number; priorFailures: number }[];
  }[],
  db: Db = defaultDb,
): Promise<void> {
  for (const template of rows) {
    await db
      .insert(templates)
      .values({
        id: template.id,
        stage: template.stage,
        label: template.label,
        description: template.description,
        slots: template.slots,
        channels: template.channels,
        platforms: template.platforms ?? null,
        requiresLink: template.requiresLink,
        active: true,
      })
      .onConflictDoNothing();
    for (const variant of template.variants) {
      await db
        .insert(templateVariants)
        .values({
          id: variant.id,
          templateId: template.id,
          language: variant.language,
          body: variant.body,
          priorSuccesses: variant.priorSuccesses,
          priorFailures: variant.priorFailures,
        })
        .onConflictDoNothing();
    }
  }
}

export async function listTemplateVariants(db: Db = defaultDb) {
  return db.select().from(templateVariants);
}

export async function bumpVariantStats(
  variantId: string,
  delta: { sends?: number; replies?: number },
  db: Db = defaultDb,
): Promise<void> {
  await db
    .update(templateVariants)
    .set({
      sends: sql`${templateVariants.sends} + ${delta.sends ?? 0}`,
      replies: sql`${templateVariants.replies} + ${delta.replies ?? 0}`,
    })
    .where(eq(templateVariants.id, variantId));
}

export async function setVariantRetired(
  variantId: string,
  retired: boolean,
  flagged: boolean,
  db: Db = defaultDb,
): Promise<void> {
  await db
    .update(templateVariants)
    .set({ retired, retireFlaggedForApproval: flagged })
    .where(eq(templateVariants.id, variantId));
}

export async function upsertSearchQuery(input: {
  query: string;
  provider: string;
  language?: string | null;
  wilaya?: string | null;
  vertical?: string | null;
  calls: number;
  newQualified: number;
  alpha: number;
  beta: number;
  retired: boolean;
  lastRunAt: Date;
}, db: Db = defaultDb): Promise<void> {
  await db
    .insert(searchQueries)
    .values({
      id: newId(),
      query: input.query,
      provider: input.provider,
      language: input.language ?? null,
      wilaya: input.wilaya ?? null,
      vertical: input.vertical ?? null,
      calls: input.calls,
      newQualified: input.newQualified,
      alpha: input.alpha,
      beta: input.beta,
      retired: input.retired,
      lastRunAt: input.lastRunAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [searchQueries.query, searchQueries.provider],
      set: {
        calls: sql`${searchQueries.calls} + ${input.calls}`,
        newQualified: sql`${searchQueries.newQualified} + ${input.newQualified}`,
        alpha: input.alpha,
        beta: input.beta,
        retired: input.retired,
        lastRunAt: input.lastRunAt,
        updatedAt: new Date(),
      },
    });
}

export async function listSearchQueries(db: Db = defaultDb) {
  return db.select().from(searchQueries).orderBy(desc(searchQueries.newQualified)).limit(500);
}

export async function insertModelVersion(input: {
  kind: string;
  version: string;
  weights: Record<string, number>;
  priors: Record<string, { mean: number; sd: number }>;
  metrics: Record<string, number>;
  nObservations: number;
  fittedAt: Date;
  /** Full Laplace covariance (row-major). Optional so legacy callers keep working. */
  covariance?: number[][];
}, db: Db = defaultDb): Promise<void> {
  await db.update(modelVersions).set({ active: false }).where(eq(modelVersions.kind, input.kind));
  await db.insert(modelVersions).values({
    id: newId(),
    kind: input.kind,
    version: input.version,
    weights: input.weights,
    priors: input.priors,
    metrics: input.metrics,
    nObservations: input.nObservations,
    fittedAt: input.fittedAt,
    active: true,
    ...(input.covariance !== undefined ? { covariance: input.covariance } : {}),
  });
}

export async function activeModelVersion(kind: string, db: Db = defaultDb) {
  const rows = await db
    .select()
    .from(modelVersions)
    .where(and(eq(modelVersions.kind, kind), eq(modelVersions.active, true)))
    .orderBy(desc(modelVersions.fittedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function listModelVersions(db: Db = defaultDb) {
  return db.select().from(modelVersions).orderBy(desc(modelVersions.fittedAt)).limit(50);
}

export async function getSenderState(db: Db = defaultDb) {
  const rows = await db.select().from(senderState).where(eq(senderState.id, 'default')).limit(1);
  return rows[0] ?? null;
}

export async function upsertSenderState(
  input: {
    startedAt: Date;
    dailyCap: number;
    platformCap: number;
    throttleUntil: Date | null;
    sentByDay: Record<string, number>;
    sentByHour: Record<string, number>;
    lastSentAt: Date | null;
    lastChannel: string | null;
    dailyReplyRates: { day: string; sends: number; replies: number }[];
  },
  db: Db = defaultDb,
): Promise<void> {
  await db
    .insert(senderState)
    .values({ id: 'default', ...input, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: senderState.id,
      set: { ...input, updatedAt: new Date() },
    });
}

export async function purgeOldData(cutoff: Date, db: Db = defaultDb): Promise<{ observations: number; outcomes: number }> {
  const deletedObservations = await db
    .delete(observations)
    .where(sql`${observations.observedAt} < ${cutoff.toISOString()}`)
    .returning({ id: observations.id });
  const deletedOutcomes = await db
    .delete(outcomes)
    .where(sql`${outcomes.recordedAt} < ${cutoff.toISOString()}`)
    .returning({ id: outcomes.id });
  await db.delete(auditLog).where(sql`${auditLog.at} < ${cutoff.toISOString()}`);
  return { observations: deletedObservations.length, outcomes: deletedOutcomes.length };
}

export async function purgeLead(leadId: string, db: Db = defaultDb): Promise<void> {
  await hardDeleteLead(leadId, db);
  await db.delete(suppression).where(and(eq(suppression.type, 'lead'), eq(suppression.value, leadId)));
}

export async function funnelCounts(db: Db = defaultDb) {
  const rows = await db
    .select({
      stage: outcomes.stage,
      count: sql<number>`count(*)::int`,
    })
    .from(outcomes)
    .groupBy(outcomes.stage);
  return rows;
}

export async function stateCounts(db: Db = defaultDb) {
  const rows = await db
    .select({ state: leads.state, count: sql<number>`count(*)::int` })
    .from(leads)
    .where(isNull(leads.deletedAt))
    .groupBy(leads.state);
  return rows;
}

export async function calibrationRows(db: Db = defaultDb) {
  return db
    .select({
      leadId: outcomes.leadId,
      stage: outcomes.stage,
      pReply: scores.pReply,
      variantId: outcomes.variantId,
      channel: outcomes.channel,
      occurredAt: outcomes.occurredAt,
    })
    .from(outcomes)
    .innerJoin(scores, eq(scores.leadId, outcomes.leadId))
    .where(inArray(outcomes.stage, ['replied', 'interested', 'lost', 'blocked', 'reported']))
    .orderBy(desc(outcomes.occurredAt))
    .limit(5000);
}

export async function outcomesSince(since: Date, db: Db = defaultDb) {
  return db.select().from(outcomes).where(gte(outcomes.occurredAt, since)).orderBy(desc(outcomes.occurredAt));
}

export async function jobsByStatus(db: Db = defaultDb) {
  return db.select({ status: jobs.status, count: sql<number>`count(*)::int` }).from(jobs).groupBy(jobs.status);
}

export function jobSignature(kind: string, payload: Record<string, unknown>): string {
  return `${kind}:${stableStringify(payload)}`.slice(0, 400);
}

export const TABLES = {
  leads,
  leadIdentities,
  observations,
  scores,
  outreachAttempts,
  outcomes,
  suppression,
  jobs,
  searchQueries,
  modelVersions,
  mergeLog,
  auditLog,
  templates,
  templateVariants,
  recurringSchedules,
  customerExclusions,
  senderDays,
};

/**
 * DB-backed customer exclusion list (operator-managed ORDELY customers).
 * Checked during enrichment next to the read-only CSV list.
 */
export async function addCustomerExclusion(
  input: { identityType: string; identityValue: string; note?: string },
  db: Db = defaultDb,
): Promise<void> {
  await db
    .insert(customerExclusions)
    .values({
      id: newId(),
      identityType: input.identityType,
      identityValue: input.identityValue,
      ...(input.note !== undefined ? { note: input.note } : {}),
    })
    .onConflictDoNothing({ target: [customerExclusions.identityType, customerExclusions.identityValue] });
}

export async function isCustomerExcluded(
  values: readonly string[],
  db: Db = defaultDb,
): Promise<boolean> {
  if (values.length === 0) return false;
  const rows = await db
    .select({ value: customerExclusions.identityValue })
    .from(customerExclusions)
    .where(inArray(customerExclusions.identityValue, [...values]))
    .limit(1);
  return rows.length > 0;
}

export async function listCustomerExclusions(limit = 200, db: Db = defaultDb) {
  return db.select().from(customerExclusions).orderBy(desc(customerExclusions.createdAt)).limit(limit);
}

/**
 * Per-day sender aggregates. Written on every recorded outcome; readable
 * history of daily activity without scanning the outcomes table.
 */
export async function recordSenderDay(
  input: { day: string; sent?: number; replies?: number; blockedReported?: number },
  db: Db = defaultDb,
): Promise<void> {
  const sent = input.sent ?? 0;
  const replies = input.replies ?? 0;
  const blockedReported = input.blockedReported ?? 0;
  await db
    .insert(senderDays)
    .values({ id: newId(), day: input.day, sent, replies, blockedReported })
    .onConflictDoUpdate({
      target: senderDays.day,
      set: {
        sent: sql`${senderDays.sent} + ${sent}`,
        replies: sql`${senderDays.replies} + ${replies}`,
        blockedReported: sql`${senderDays.blockedReported} + ${blockedReported}`,
      },
    });
}

export async function getSenderDay(day: string, db: Db = defaultDb) {
  const rows = await db.select().from(senderDays).where(eq(senderDays.day, day)).limit(1);
  return rows[0] ?? null;
}

export async function listSenderDays(limit = 60, db: Db = defaultDb) {
  return db.select().from(senderDays).orderBy(desc(senderDays.day)).limit(limit);
}
