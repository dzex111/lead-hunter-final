import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { LeadState, PlatformId, CategoryId, ChannelId } from '@/core/types';

/**
 * Lead Hunter schema. Independent database, zero coupling to ORDELY.
 * Every timestamp is timestamptz; append-only tables (observations, outcomes,
 * audit_log, merge_log) are never mutated in place.
 */
export const leads = pgTable(
  'leads',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    domain: text('domain'),
    state: text('state').$type<LeadState>().notNull().default('new'),
    platform: text('platform').$type<PlatformId>(),
    category: text('category').$type<CategoryId>(),
    wilaya: text('wilaya'),
    primaryChannel: text('primary_channel').$type<ChannelId>(),
    primaryTarget: text('primary_target'),
    pAlgeria: doublePrecision('p_algeria'),
    pReply: doublePrecision('p_reply'),
    maturityIndex: doublePrecision('maturity_index'),
    ev: doublePrecision('ev'),
    priority: doublePrecision('priority'),
    sourceId: text('source_id'),
    provenance: jsonb('provenance').$type<Record<string, unknown>>(),
    annotations: jsonb('annotations').$type<Record<string, unknown>>(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    qualifiedAt: timestamp('qualified_at', { withTimezone: true }),
    disqualifiedReason: text('disqualified_reason'),
    mergedIntoId: text('merged_into_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('leads_state_idx').on(table.state),
    index('leads_priority_idx').on(table.priority),
    index('leads_domain_idx').on(table.domain),
  ],
);

export const leadIdentities = pgTable(
  'lead_identities',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id').notNull(),
    type: text('type').notNull(), // domain | phone | whatsapp | email | facebook | instagram | tiktok | etld1
    value: text('value').notNull(),
    normalizedValue: text('normalized_value').notNull(),
    source: text('source'),
    confidence: doublePrecision('confidence'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('lead_identities_type_value_uq').on(table.type, table.normalizedValue),
    index('lead_identities_lead_idx').on(table.leadId),
  ],
);

export const observations = pgTable(
  'observations',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    confidence: doublePrecision('confidence').notNull().default(0.5),
    evidence: jsonb('evidence').$type<unknown[]>().notNull().default([]),
    source: text('source').notNull(),
    sourceUrl: text('source_url'),
    contentHash: text('content_hash'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    index('observations_lead_idx').on(table.leadId, table.key),
    index('observations_observed_idx').on(table.observedAt),
  ],
);

export const scores = pgTable(
  'scores',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id').notNull(),
    modelVersion: text('model_version').notNull(),
    features: jsonb('features').$type<Record<string, number>>().notNull(),
    contributions: jsonb('contributions').$type<unknown[]>().notNull().default([]),
    pReply: doublePrecision('p_reply').notNull(),
    pInterested: doublePrecision('p_interested').notNull(),
    pSignup: doublePrecision('p_signup').notNull(),
    pActivate: doublePrecision('p_activate').notNull(),
    pPaid: doublePrecision('p_paid').notNull(),
    ev: doublePrecision('ev').notNull(),
    effortSeconds: doublePrecision('effort_seconds').notNull(),
    priority: doublePrecision('priority').notNull(),
    ucb: doublePrecision('ucb').notNull(),
    exploration: boolean('exploration').notNull().default(false),
    explanation: jsonb('explanation').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('scores_lead_idx').on(table.leadId, table.createdAt)],
);

export const templates = pgTable('templates', {
  id: text('id').primaryKey(),
  stage: text('stage').notNull(),
  label: text('label').notNull(),
  description: text('description').notNull(),
  slots: jsonb('slots').$type<string[]>().notNull().default([]),
  channels: jsonb('channels').$type<string[]>().notNull().default([]),
  platforms: jsonb('platforms').$type<string[]>(),
  requiresLink: boolean('requires_link').notNull().default(false),
  version: text('version').notNull().default('v1'),
  active: boolean('active').notNull().default(true),
});

export const templateVariants = pgTable(
  'template_variants',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id').notNull(),
    language: text('language').notNull(),
    body: text('body').notNull(),
    priorSuccesses: doublePrecision('prior_successes').notNull().default(1),
    priorFailures: doublePrecision('prior_failures').notNull().default(1),
    sends: integer('sends').notNull().default(0),
    replies: integer('replies').notNull().default(0),
    retired: boolean('retired').notNull().default(false),
    retireFlaggedForApproval: boolean('retire_flagged_for_approval').notNull().default(false),
  },
  (table) => [index('template_variants_template_idx').on(table.templateId)],
);

export const outreachAttempts = pgTable(
  'outreach_attempts',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id').notNull(),
    channel: text('channel').$type<ChannelId>().notNull(),
    target: text('target').notNull(),
    templateId: text('template_id').notNull(),
    variantId: text('variant_id').notNull(),
    body: text('body').notNull(),
    handoff: jsonb('handoff').$type<Record<string, unknown>>(),
    status: text('status').notNull().default('drafted'), // drafted | sent_by_human | skipped
    stage: text('stage').notNull().default('first_contact'), // first_contact | followup | reply | post_signup
    policyReason: text('policy_reason'),
    validationWarnings: jsonb('validation_warnings').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [
    index('outreach_attempts_lead_idx').on(table.leadId, table.createdAt),
    index('outreach_attempts_status_idx').on(table.status),
  ],
);

export const outcomes = pgTable(
  'outcomes',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id').notNull(),
    attemptId: text('attempt_id'),
    stage: text('stage').notNull(), // contacted | replied | interested | signed_up | activated | paid | lost | blocked | reported | stop | not_interested
    note: text('note'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    variantId: text('variant_id'),
    channel: text('channel').$type<ChannelId>(),
  },
  (table) => [
    index('outcomes_lead_idx').on(table.leadId, table.occurredAt),
    index('outcomes_stage_idx').on(table.stage),
  ],
);

export const suppression = pgTable(
  'suppression',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(), // lead | phone | email | domain | handle
    value: text('value').notNull(),
    reason: text('reason').notNull(),
    createdBy: text('created_by').notNull().default('operator'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('suppression_type_value_uq').on(table.type, table.value)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('pending'), // pending | running | done | failed | dead
    priority: integer('priority').notNull().default(100),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    idempotencyKey: text('idempotency_key'),
    lastError: text('last_error'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('jobs_idempotency_uq').on(table.idempotencyKey),
    index('jobs_status_runat_idx').on(table.status, table.runAt),
  ],
);

export const searchQueries = pgTable(
  'search_queries',
  {
    id: text('id').primaryKey(),
    query: text('query').notNull(),
    provider: text('provider').notNull(),
    language: text('language'),
    wilaya: text('wilaya'),
    vertical: text('vertical'),
    calls: integer('calls').notNull().default(0),
    newQualified: integer('newQualified').notNull().default(0),
    alpha: doublePrecision('alpha').notNull().default(1),
    beta: doublePrecision('beta').notNull().default(1),
    retired: boolean('retired').notNull().default(false),
    pinnedOff: boolean('pinned_off').notNull().default(false),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('search_queries_query_provider_uq').on(table.query, table.provider)],
);

export const modelVersions = pgTable('model_versions', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(), // p_reply | funnel | category
  version: text('version').notNull(),
  weights: jsonb('weights').$type<Record<string, number>>().notNull().default({}),
  priors: jsonb('priors').$type<Record<string, { mean: number; sd: number }>>().notNull().default({}),
  metrics: jsonb('metrics').$type<Record<string, number>>().notNull().default({}),
  nObservations: integer('n_observations').notNull().default(0),
  fittedAt: timestamp('fitted_at', { withTimezone: true }).notNull().defaultNow(),
  active: boolean('active').notNull().default(true),
  // Full Laplace covariance matrix (row-major, aligned with FEATURE_NAMES order).
  // Added so the UCB exploration term survives a refit/restart instead of being
  // crammed into `weights` as `cov:i:j` keys (legacy rows keep working: readers
  // fall back to the legacy keys when this column is null).
  covariance: jsonb('covariance').$type<number[][]>(),
});

export const mergeLog = pgTable('merge_log', {
  id: text('id').primaryKey(),
  action: text('action').notNull(), // merge | split | review_decision
  keptLeadId: text('kept_lead_id').notNull(),
  mergedLeadId: text('merged_lead_id'),
  decision: jsonb('decision').$type<Record<string, unknown>>(),
  operator: text('operator').notNull().default('operator'),
  reversible: boolean('reversible').notNull().default(true),
  revertedAt: timestamp('reverted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    actor: text('actor').notNull().default('engine'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_log_entity_idx').on(table.entityType, table.entityId)],
);

export const senderState = pgTable('sender_state', {
  id: text('id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  dailyCap: integer('daily_cap').notNull().default(40),
  platformCap: integer('platform_cap').notNull().default(6),
  throttleUntil: timestamp('throttle_until', { withTimezone: true }),
  sentByDay: jsonb('sent_by_day').$type<Record<string, number>>().notNull().default({}),
  sentByHour: jsonb('sent_by_hour').$type<Record<string, number>>().notNull().default({}),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
  lastChannel: text('last_channel'),
  dailyReplyRates: jsonb('daily_reply_rates')
    .$type<{ day: string; sends: number; replies: number }[]>()
    .notNull()
    .default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const recurringSchedules = pgTable('recurring_schedules', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  schedule: text('schedule').notNull(), // e.g. "15m", "1h", "1d@07:30"
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean('enabled').notNull().default(true),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull().defaultNow(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
});

/**
 * DB-backed customer exclusion list (ORDELY customers + manual operator entries).
 * Checked during enrichment next to the read-only CSV list (D6) and the
 * suppression hard-stop: a hit disqualifies the lead the same way.
 */
export const customerExclusions = pgTable(
  'customer_exclusions',
  {
    id: text('id').primaryKey(),
    identityType: text('identity_type').notNull(), // domain | phone | whatsapp | email | handle
    identityValue: text('identity_value').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('customer_exclusions_type_value_uq').on(table.identityType, table.identityValue)],
);

/**
 * Per-day sender aggregates (queryable history of what sender_state keeps as
 * jsonb blobs). Written on every recorded outcome; powers daily activity views
 * and future per-day throttling rules without scanning outcomes.
 */
export const senderDays = pgTable(
  'sender_days',
  {
    id: text('id').primaryKey(),
    day: text('day').notNull().unique(), // Africa/Algiers YYYY-MM-DD (algiersDayKey)
    sent: integer('sent').notNull().default(0),
    replies: integer('replies').notNull().default(0),
    blockedReported: integer('blocked_reported').notNull().default(0),
  },
  (table) => [index('sender_days_day_idx').on(table.day)],
);
