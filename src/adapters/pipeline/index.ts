import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import {
  leadIdentities as leadIdentitiesTable,
  leads as leadsTable,
  observations as observationsTable,
  outcomes as outcomesTable,
  outreachAttempts as attemptsTable,
  searchQueries as searchQueriesTable,
  senderState as senderStateTable,
  templateVariants as templateVariantsTable,
} from '@/adapters/db/tables';
import {
  addSuppression,
  createAttempt,
  getLead,
  getSenderState,
  insertObservation,
  insertScore,
  isCustomerExcluded,
  isSuppressed,
  latestScore,
  latestScoresFor,
  listAttempts,
  listObservations,
  markAttemptSent,
  queuedLeads,
  recordAudit,
  recordMergeLog,
  recordOutcome,
  recordSenderDay,
  updateLeadFacts,
  updateLeadState,
  upsertLead,
  upsertSenderState,
  type Db,
} from '@/adapters/db/repo';
import { buildFactsBundle, preferredChannel, qualifyFromFacts, type LeadRowShape, type ObservationRow } from '@/adapters/pipeline/facts';
import { loadActiveModel, modelSummary, predictReply } from '@/adapters/pipeline/model';
import { loadFunnel, segmentPosterior } from '@/adapters/pipeline/funnel';
import { demoSource, syntheticMerchantHtml, syntheticPopulation } from '@/adapters/sources/demo';
import { algiersDayKey } from '@/core/clock';
import { buildFeatureVector, contributionsOf, vectorToRecord } from '@/core/features';
import { DEFAULT_EV_CONFIG, effortForChannel, expectedValue, priorityScore } from '@/core/math/ev';
import { selectDailyBatch, type BatchCandidate } from '@/core/math/mmr';
import { buildOutreachLink, renderMessage } from '@/core/messaging/render';
import { TEMPLATES, type MessageTemplate } from '@/core/messaging/templates';
import { canonicalizeUrl } from '@/core/normalize/url';
import { normalizeAlgerianPhone } from '@/core/normalize/phone';
import {
  DEFAULT_CONTACT_POLICY,
  dailyCapFor,
  evaluateContactPolicy,
  markThrottleAfterBlocked,
  nextAllowedSendTime,
  recordSend,
} from '@/core/policy/contact';
import { canTransition, nextStageFromOutcome } from '@/core/lifecycle/state';
import { createRng, type Rng } from '@/core/random';
import { PLATFORM_LABELS, extractSiteFacts } from '@/core/extract';
import { countSitemapProductUrls, emptyCatalog, parseShopifyProductsJson, parseWooStoreApi, type CatalogStats } from '@/core/extract/catalog';
import { bestChannelOfNetwork } from '@/core/extract/contacts';
import { candidatePairs, clusterRecords, comparePair, type ResolveRecord } from '@/core/entity/resolve';
import type { Clock } from '@/core/clock';
import type { HttpClient, Logger } from '@/core/ports';
import type { ChannelId, LeadState, RawCandidate, SenderState } from '@/core/types';
import { clamp, hour0, uniqueBy } from '@/adapters/pipeline/util';
import type { AppConfig } from '@/config';

/**
 * Pipeline orchestration: discover → fetch → extract → classify → resolve →
 * qualify → score → draft → queue → outcome → learn.
 *
 * Guarantees: every stage is idempotent, only append-only observations are
 * written for new facts, and nothing here can send a message — it produces
 * drafts plus human handoff links.
 */
export interface PipelineDeps {
  db?: Db;
  clock: Clock;
  http: HttpClient;
  logger: Logger;
  config: AppConfig;
  rng?: Rng;
}

export interface IngestResult {
  created: number;
  updated: number;
  leadIds: string[];
}

interface IdentityInput {
  type: 'domain' | 'phone' | 'whatsapp' | 'email' | 'facebook' | 'instagram' | 'tiktok' | 'etld1';
  value: string;
  normalizedValue: string;
  confidence?: number;
  source?: string;
}

export function buildIdentityInputs(candidate: RawCandidate): IdentityInput[] {
  const identities: IdentityInput[] = [];
  if (candidate.url) {
    try {
      const canonical = canonicalizeUrl(candidate.url);
      identities.push({
        type: 'domain',
        value: canonical.host,
        normalizedValue: canonical.host,
        confidence: 0.85,
        source: candidate.sourceId,
      });
      identities.push({
        type: 'etld1',
        value: canonical.etld1,
        normalizedValue: canonical.etld1,
        confidence: 0.6,
        source: candidate.sourceId,
      });
    } catch {
      // not a usable URL: handled by other identities
    }
  }
  for (const phone of candidate.phones ?? []) {
    const normalized = normalizeAlgerianPhone(phone);
    if (!normalized) continue;
    identities.push({
      type: normalized.kind === 'mobile' ? 'whatsapp' : 'phone',
      value: normalized.e164,
      normalizedValue: normalized.e164,
      confidence: 0.9,
      source: candidate.sourceId,
    });
  }
  for (const email of candidate.emails ?? []) {
    identities.push({
      type: 'email',
      value: email.toLowerCase(),
      normalizedValue: email.toLowerCase(),
      confidence: 0.9,
      source: candidate.sourceId,
    });
  }
  for (const handle of candidate.handles ?? []) {
    identities.push({
      type: handle.network,
      value: handle.value,
      normalizedValue: handle.value.toLowerCase(),
      confidence: 0.8,
      source: candidate.sourceId,
    });
  }
  return identities;
}

export async function ingestCandidates(candidates: readonly RawCandidate[], deps: PipelineDeps): Promise<IngestResult> {
  const db = deps.db ?? defaultDb;
  let created = 0;
  let updated = 0;
  const leadIds: string[] = [];
  const observedAt = deps.clock.now();

  for (const candidate of candidates) {
    const identities = buildIdentityInputs(candidate);
    if (identities.length === 0) continue;
    let domain: string | null = null;
    if (candidate.url) {
      try {
        domain = canonicalizeUrl(candidate.url).host;
      } catch {
        domain = null;
      }
    }
    const result = await upsertLead(
      {
        name: candidate.name ?? null,
        domain,
        sourceId: candidate.sourceId,
        provenance: candidate.provenance as Record<string, unknown>,
        identities,
        primaryChannel: null,
        primaryTarget: candidate.url ?? null,
      },
      db,
    );
    if (result.created) created += 1;
    else updated += 1;
    leadIds.push(result.id);

    for (const identity of identities) {
      await insertObservation(
        {
          leadId: result.id,
          key: `identity:${identity.type}`,
          value: identity.value,
          confidence: identity.confidence ?? 0.8,
          evidence: [{ location: candidate.sourceId, detail: `${identity.type} identity` }],
          source: candidate.sourceId,
          observedAt,
        },
        db,
      );
    }
    if (candidate.url) {
      await insertObservation(
        {
          leadId: result.id,
          key: 'url:primary',
          value: candidate.url,
          confidence: 0.95,
          evidence: [{ location: candidate.sourceId, detail: 'primary merchant URL' }],
          source: candidate.sourceId,
          sourceUrl: candidate.url,
          observedAt,
        },
        db,
      );
    }
    const annotations = candidate.annotations ?? {};
    for (const [key, value] of Object.entries(annotations)) {
      if (typeof value !== 'boolean') continue;
      await insertObservation(
        {
          leadId: result.id,
          key: key === 'is_advertiser' ? 'advertiser:flag' : `annotation:${key}`,
          value: value ? 'true' : 'false',
          confidence: 0.9,
          evidence: [{ location: candidate.sourceId, detail: `operator annotation ${key}=${String(value)}` }],
          source: candidate.sourceId,
          observedAt,
        },
        db,
      );
    }
    if (annotations['is_advertiser'] === true) {
      await insertObservation(
        {
          leadId: result.id,
          key: 'advertiser:first_seen',
          value: observedAt.toISOString(),
          confidence: 0.9,
          evidence: [{ location: candidate.sourceId, detail: 'advertiser flag first seen' }],
          source: candidate.sourceId,
          observedAt,
        },
        db,
      );
    }
    await recordAudit(
      {
        actor: 'engine',
        action: 'ingest',
        entityType: 'lead',
        entityId: result.id,
        detail: { sourceId: candidate.sourceId, provenance: candidate.provenance },
        at: observedAt,
      },
      db,
    );
  }
  deps.logger.info({ created, updated }, 'candidates ingested');
  return { created, updated, leadIds: uniqueBy(leadIds, (id) => id) };
}

export interface EnrichOptions {
  offline?: boolean;
}

export interface EnrichOutcome {
  leadId: string;
  platform: string;
  qualified: boolean;
  reasons: string[];
  observationsWritten: number;
  pAlgeria: number;
  maturityIndex: number;
}

export async function enrichLead(
  leadId: string,
  deps: PipelineDeps,
  options: EnrichOptions = {},
): Promise<EnrichOutcome | null> {
  const db = deps.db ?? defaultDb;
  const lead = await getLead(leadId, db);
  if (!lead) return null;
  const stored = await listObservations(leadId, db);
  const urlObs = stored.find((observation) => observation.key === 'url:primary');
  const url = urlObs?.value ?? lead.primaryTarget ?? null;
  if (!url) {
    await updateLeadState(leadId, 'disqualified', { reason: 'no website URL available' }, db);
    deps.logger.warn({ leadId }, 'no URL to enrich — disqualified');
    return null;
  }

  let html = '';
  let headers: Record<string, string> = {};
  let contentHash: string | null = null;
  let catalog: CatalogStats = emptyCatalog();

  if (options.offline === true) {
    const merchant = syntheticPopulation(200, deps.config.seed).find((entry) => entry.url === url);
    if (!merchant) {
      deps.logger.warn({ leadId, url }, 'offline enrichment: URL not in synthetic population');
      return null;
    }
    html = syntheticMerchantHtml(merchant);
    contentHash = `synth-${merchant.id}`;
    catalog = {
      productCount: merchant.products,
      medianPrice: merchant.medianPrice,
      currency: 'DZD',
      latestProductUpdate: new Date(deps.clock.now().getTime() - merchant.freshnessDays * 86_400_000).toISOString(),
      source: 'products_json',
    };
  } else {
    const response = await deps.http.fetch({ url, purpose: 'enrich' });
    html = response.body;
    headers = response.headers;
    contentHash = response.meta.contentHash;
    catalog = await maybeFetchCatalog(deps, response.meta.finalUrl);
  }

  const observedAt = deps.clock.now();
  const facts = extractSiteFacts({
    url,
    html,
    headers,
    now: observedAt,
    ...(catalog.source !== 'none' ? { catalog } : {}),
  });

  const newObservations: ObservationRow[] = [];
  for (const signal of facts.signals) {
    await insertObservation(
      {
        leadId,
        key: signal.key,
        value: signal.value,
        confidence: signal.confidence,
        evidence: signal.evidence,
        source: 'extract',
        sourceUrl: facts.canonicalUrl,
        contentHash,
        observedAt,
        expiresAt: new Date(observedAt.getTime() + 90 * 86_400_000),
      },
      db,
    );
    newObservations.push({ key: signal.key, value: signal.value, confidence: signal.confidence });
  }

  const derived: { key: string; value: string; confidence: number }[] = [
    {
      key: 'market:p_sells_physical',
      value: facts.market.pSellsPhysicalGoodsOnline.toFixed(4),
      confidence: facts.market.pSellsPhysicalGoodsOnline,
    },
    { key: 'maturity:index', value: facts.maturityIndex.toFixed(2), confidence: 0.8 },
    { key: 'language:dominant', value: facts.language.dominant, confidence: 0.7 },
  ];
  if (facts.catalog.source !== 'none') {
    derived.push({ key: 'catalog:source', value: facts.catalog.source, confidence: 0.9 });
  }
  if (facts.catalog.latestProductUpdate) {
    derived.push({ key: 'catalog:latest_update', value: facts.catalog.latestProductUpdate, confidence: 0.9 });
  }
  for (const entry of derived) {
    await insertObservation(
      {
        leadId,
        key: entry.key,
        value: entry.value,
        confidence: entry.confidence,
        evidence: [{ location: 'extract', detail: entry.key }],
        source: 'extract',
        sourceUrl: facts.canonicalUrl,
        contentHash,
        observedAt,
      },
      db,
    );
    newObservations.push(entry);
  }

  const preferred = preferredChannel({
    ...buildFactsBundle(toLeadRow(lead), stored),
    contacts: facts.contacts,
  });
  const category = facts.categories.top[0]?.category ?? null;

  await updateLeadFacts(
    leadId,
    {
      platform: facts.platform,
      category: category ?? null,
      pAlgeria: facts.market.pAlgeria,
      maturityIndex: facts.maturityIndex,
      primaryChannel: preferred?.channel ?? null,
      primaryTarget: preferred?.target ?? url,
    },
    db,
  );

  const suppressed = await isSuppressed(
    {
      leadId,
      values: facts.contacts.map((channel) => ({
        type: channel.kind === 'email' ? 'email' : channel.kind === 'whatsapp' ? 'whatsapp' : 'handle',
        value: channel.value,
      })),
    },
    db,
  );
  const onOrdelyCustomersList =
    (await checkOrdelyCustomers([url, ...facts.contacts.map((channel) => channel.value)], deps)) ||
    // DB-backed exclusion list (operator-managed, same disqualifying effect as the CSV list)
    (await isCustomerExcluded(
      [url, facts.domain ?? '', ...facts.contacts.map((channel) => channel.value)].filter((value) => value.length > 0),
      db,
    ));

  const allObservations: ObservationRow[] = [
    ...stored.map((observation) => ({
      key: observation.key,
      value: observation.value,
      confidence: observation.confidence,
      source: observation.source,
    })),
    ...newObservations,
  ];
  const postFacts = buildFactsBundle(
    { ...toLeadRow(lead), platform: facts.platform, category, maturityIndex: facts.maturityIndex },
    allObservations,
  );
  const qualification = qualifyFromFacts({
    facts: postFacts,
    suppressed,
    onOrdelyCustomersList,
    policyAllows: true,
  });

  await updateLeadState(leadId, 'enriched', {}, db);
  await updateLeadState(leadId, qualification.qualified ? 'qualified' : 'disqualified', {
    reason: qualification.reasons.join('; '),
  }, db);
  const transition = canTransition(
    'enriched',
    qualification.qualified ? 'qualified' : 'disqualified',
    {
      hasObservations: newObservations.length > 0,
      hasContactableChannel: facts.contacts.length > 0,
      qualified: qualification.qualified,
      suppressed,
      hasDraft: false,
      policyAllowed: true,
    },
  );
  if (!transition.allowed) {
    deps.logger.warn({ leadId, reasons: transition.reasons }, 'qualification transition guarded');
  }
  await recordAudit(
    {
      actor: 'engine',
      action: 'enrich',
      entityType: 'lead',
      entityId: leadId,
      detail: {
        platform: facts.platform,
        pAlgeria: facts.market.pAlgeria,
        qualified: qualification.qualified,
        reasons: qualification.reasons,
        observations: newObservations.length,
        gates: qualification.gates,
      },
      at: observedAt,
    },
    db,
  );

  return {
    leadId,
    platform: facts.platform,
    qualified: qualification.qualified,
    reasons: qualification.reasons,
    observationsWritten: newObservations.length,
    pAlgeria: facts.market.pAlgeria,
    maturityIndex: facts.maturityIndex,
  };
}

async function maybeFetchCatalog(deps: PipelineDeps, finalUrl: string): Promise<CatalogStats> {
  const base = finalUrl.replace(/\/$/, '');
  const endpoints: { url: string; parse: (body: string) => CatalogStats }[] = [
    { url: `${base}/products.json?limit=250&page=1`, parse: (body) => parseShopifyProductsJson(JSON.parse(body), 250) },
    { url: `${base}/wp-json/wc/store/v1/products?per_page=100`, parse: (body) => parseWooStoreApi(JSON.parse(body), 250) },
  ];
  for (const endpoint of endpoints) {
    try {
      const response = await deps.http.fetch({ url: endpoint.url, purpose: 'catalog' });
      if (response.meta.status !== 200) continue;
      const parsed = endpoint.parse(response.body);
      if (parsed.productCount !== null && parsed.productCount > 0) {
        deps.logger.info({ url: endpoint.url, products: parsed.productCount }, 'catalog enumerated');
        return parsed;
      }
    } catch (error) {
      deps.logger.debug({ url: endpoint.url, error: (error as Error).message }, 'catalog endpoint unavailable');
    }
  }
  try {
    const sitemap = await deps.http.fetch({ url: `${base}/sitemap.xml`, purpose: 'catalog' });
    const counted = countSitemapProductUrls(sitemap.body);
    if (counted.count > 0) {
      return {
        productCount: counted.count,
        medianPrice: null,
        currency: null,
        latestProductUpdate: counted.latest,
        source: 'sitemap',
      };
    }
  } catch {
    // best effort only
  }
  return emptyCatalog();
}

async function checkOrdelyCustomers(values: readonly string[], deps: PipelineDeps): Promise<boolean> {
  const path = deps.config.ordelyCustomersCsv;
  if (!path) return false;
  try {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(path, 'utf8');
    const haystack = content.toLowerCase();
    return values.some((value) => value.length > 3 && haystack.includes(value.toLowerCase()));
  } catch {
    deps.logger.warn({ path }, 'ORDELY customers CSV unreadable — treated as empty (no coupling)');
    return false;
  }
}

export interface ScoreOutcome {
  leadId: string;
  pReply: number;
  ev: number;
  priority: number;
  ucb: number;
  modelVersion: string;
  explanation: string[];
}

export async function scoreLead(leadId: string, deps: PipelineDeps): Promise<ScoreOutcome | null> {
  const db = deps.db ?? defaultDb;
  const lead = await getLead(leadId, db);
  if (!lead) return null;
  const stored = await listObservations(leadId, db);
  const facts = buildFactsBundle(toLeadRow(lead), stored);
  const preferred = preferredChannel(facts);
  const model = await loadActiveModel(deps.clock, db);
  const sender = await ensureSenderState(deps);

  const vector = buildFeatureVector({
    isAdvertiser: facts.isAdvertiser,
    advertiserFirstSeenAt: facts.advertiserFirstSeenAt,
    adCount: facts.adCount,
    sellsCod: facts.market.codPhrases.length > 0,
    directWhatsapp: bestChannelOfNetwork(facts.contacts, 'whatsapp') !== null,
    platform: facts.platform,
    category: facts.categories[0] ?? null,
    maturityIndex: facts.maturityIndex,
    productCount: facts.catalog.productCount,
    pixelMeta: facts.adtech.includes('meta_pixel'),
    pixelTiktok: facts.adtech.includes('tiktok_pixel'),
    languageDominant: facts.language,
    preferredChannel: preferred?.channel ?? 'whatsapp',
    hourOfDayAlgiers: hour0(deps.clock.now()),
    senderWarmupProgress: warmupProgress(sender, deps),
    now: deps.clock.now(),
  });

  const prediction = predictReply(model, vector.values, vector.names);
  const funnel = await loadFunnel(db);
  const posteriors = segmentPosterior(funnel, {
    platform: facts.platform,
    category: facts.categories[0] ?? 'other',
    channel: preferred?.channel ?? 'whatsapp',
  });
  const stageValue = (stage: string, fallback: number): number =>
    posteriors.find((entry) => entry.stage === stage)?.mean ?? fallback;

  const funnelProbabilities = {
    pReply: prediction.p,
    pInterestedGivenReply: stageValue('interested', 0.45),
    pSignupGivenInterested: stageValue('signed_up', 0.35),
    pActivateGivenSignup: stageValue('activated', 0.6),
    pPaidGivenActivate: stageValue('paid', 0.35),
  };
  const effort = effortForChannel(preferred?.channel ?? 'whatsapp', {}, DEFAULT_EV_CONFIG);
  const ev = expectedValue(funnelProbabilities, DEFAULT_EV_CONFIG);
  const priority = priorityScore(ev, effort);

  const explanation = [
    `P(reply)=${prediction.p.toFixed(3)} via ${model.version}${model.coldStart ? ' (cold start: expert priors)' : ''}`,
    `UCB=${prediction.ucb.toFixed(3)} (kappa=${prediction.kappa.toFixed(3)}, s=${prediction.s.toFixed(3)})`,
    `funnel: interested|reply=${funnelProbabilities.pInterestedGivenReply.toFixed(2)}, signup=${funnelProbabilities.pSignupGivenInterested.toFixed(2)}, activate=${funnelProbabilities.pActivateGivenSignup.toFixed(2)}, paid=${funnelProbabilities.pPaidGivenActivate.toFixed(2)}`,
    `EV=${ev.toFixed(2)} DZD · effort=${effort.toFixed(0)}s · priority=${priority.toFixed(4)}`,
    `platform=${facts.platform} (${PLATFORM_LABELS[facts.platform]}) · category=${facts.categories[0] ?? 'other'} · maturity=${facts.maturityIndex.toFixed(1)}`,
    ...vector.notes.slice(0, 6),
  ];

  await insertScore(
    {
      leadId,
      modelVersion: model.version,
      features: vectorToRecord(vector),
      contributions: contributionsOf(vector, model.beta),
      pReply: prediction.p,
      pInterested: funnelProbabilities.pInterestedGivenReply,
      pSignup: funnelProbabilities.pSignupGivenInterested,
      pActivate: funnelProbabilities.pActivateGivenSignup,
      pPaid: funnelProbabilities.pPaidGivenActivate,
      ev,
      effortSeconds: effort,
      priority,
      ucb: prediction.ucb,
      exploration: false,
      explanation,
    },
    db,
  );
  await updateLeadFacts(leadId, { pReply: prediction.p, ev, priority, pAlgeria: facts.market.pAlgeria }, db);
  if (['enriched', 'qualified'].includes(lead.state)) {
    await updateLeadState(leadId, 'qualified', {}, db);
  }
  return { leadId, pReply: prediction.p, ev, priority, ucb: prediction.ucb, modelVersion: model.version, explanation };
}

export interface QueueItem {
  leadId: string;
  leadName: string | null;
  domain: string | null;
  platform: string;
  category: string;
  wilaya: string;
  channel: string;
  target: string;
  templateId: string;
  variantId: string;
  message: string;
  waLink: string | null;
  handoffUrl: string;
  sendInstructions: string;
  sendableNow: boolean;
  policyReason: string;
  policyCode: string;
  pReply: number;
  ev: number;
  priority: number;
  ucb: number;
  exploration: boolean;
  explanation: string[];
  warnings: string[];
  nextAllowedAt: string | null;
}

export interface NextBatchOptions {
  n?: number;
  variantByTemplate?: Record<string, string>;
}

export async function buildQueue(deps: PipelineDeps, options: NextBatchOptions = {}): Promise<QueueItem[]> {
  const db = deps.db ?? defaultDb;
  const n = options.n ?? 20;
  const rows = await queuedLeads(Math.max(200, n * 6), db);
  const leadIds = rows.map((row) => row.id);
  const scoreMap = await latestScoresFor(leadIds, db);
  const rng = deps.rng ?? createRng(deps.config.seed);
  const candidates: BatchCandidate[] = [];

  for (const row of rows) {
    const observations = await listObservations(row.id, db);
    const facts = buildFactsBundle(toLeadRow(row), observations);
    const preferred = preferredChannel(facts);
    if (!preferred) continue;
    const score = scoreMap.get(row.id);
    const sampledP = clamp((score?.pReply ?? 0.1) + rng.normal() * 0.04, 0, 1);
    candidates.push({
      id: row.id,
      score: score?.ucb ?? 0.1,
      platform: facts.platform,
      category: facts.categories[0] ?? 'other',
      wilaya: row.wilaya ?? 'unknown',
      sampledP,
      channel: preferred.channel,
    });
  }

  const batch = selectDailyBatch(candidates, { n, lambda: 0.75, explorationRate: 0.1, rng });
  const items: QueueItem[] = [];
  for (const chosen of batch) {
    const item = await draftLead(chosen.id, deps, {
      forceDraft: true,
      exploration: chosen.exploration,
      ...(options.variantByTemplate ? { variantByTemplate: options.variantByTemplate } : {}),
    });
    if (item) items.push(item);
  }
  return items;
}

export interface DraftOptions {
  channel?: string;
  forceDraft?: boolean;
  exploration?: boolean;
  variantByTemplate?: Record<string, string>;
}

export async function draftLead(leadId: string, deps: PipelineDeps, options: DraftOptions = {}): Promise<QueueItem | null> {
  const db = deps.db ?? defaultDb;
  const lead = await getLead(leadId, db);
  if (!lead) return null;
  const stored = await listObservations(leadId, db);
  const facts = buildFactsBundle(toLeadRow(lead), stored);
  const preferred = preferredChannel(facts);
  const channel = ((options.channel as ChannelId | undefined) ?? preferred?.channel ?? lead.primaryChannel ?? 'whatsapp') as ChannelId;
  const target = preferred?.target ?? lead.primaryTarget ?? '';
  if (!target) return null;

  const attempts = await listAttempts(leadId, db);
  const history = attempts
    .filter((attempt) => attempt.status === 'sent_by_human')
    .map((attempt) => ({
      channel: attempt.channel,
      stage: attempt.stage,
      occurredAt: attempt.sentAt ?? attempt.createdAt,
      templateId: attempt.templateId,
    }));
  const isFirstContact = !history.some((entry) => entry.stage === 'first_contact');
  const stage = isFirstContact ? 'first_contact' : 'followup';
  const template = isFirstContact ? selectTemplate(facts, channel) : followupTemplate();
  const sender = await ensureSenderState(deps);
  const suppressed = await isSuppressed({ leadId, values: [{ type: 'handle', value: target }] }, db);
  const policy = evaluateContactPolicy(
    {
      leadId,
      channel,
      history,
      now: deps.clock.now(),
      state: lead.state as LeadState,
      suppressed,
      onOrdelyCustomersList: false,
      senderState: sender,
    },
    DEFAULT_CONTACT_POLICY,
  );

  const variantStats = await loadVariantStats(db);
  const rng = createRng(hashSeed(`${leadId}:${algiersDayKey(deps.clock.now())}:${template.id}`));
  const rendered = renderMessage({
    template,
    slots: {
      name: lead.name ?? '',
      product: productLabel(facts.categories[0] ?? 'other'),
      platform: PLATFORM_LABELS[facts.platform],
      link: deps.config.ordelySignupUrl,
    },
    language: facts.language,
    channel,
    rng,
    isFirstContact,
    variantStats,
    ...(options.variantByTemplate?.[template.id] ? { variantId: options.variantByTemplate[template.id] as string } : {}),
  });

  const handoff = buildOutreachLink(channel, target, rendered.body);
  const score = await latestScore(leadId, db);

  if (options.forceDraft !== false) {
    await createAttempt(
      {
        leadId,
        channel,
        target,
        templateId: template.id,
        variantId: rendered.variantId,
        body: rendered.body,
        handoff: handoff.link
          ? { url: handoff.link.waLink ?? handoff.link.target, instructions: handoff.link.instructions }
          : { instructions: handoff.reason ?? 'no handoff generated' },
        status: 'drafted',
        stage,
        policyReason: policy.reason,
        validationWarnings: rendered.warnings,
      },
      db,
    );
    if (lead.state === 'qualified') await updateLeadState(leadId, 'queued', {}, db);
    await updateLeadState(leadId, 'drafted', {}, db);
  }

  return {
    leadId,
    leadName: lead.name,
    domain: lead.domain,
    platform: facts.platform,
    category: facts.categories[0] ?? 'other',
    wilaya: lead.wilaya ?? 'unknown',
    channel,
    target,
    templateId: template.id,
    variantId: rendered.variantId,
    message: rendered.body,
    waLink: handoff.link?.waLink ?? null,
    handoffUrl: handoff.link?.target ?? '',
    sendInstructions: handoff.link?.instructions ?? handoff.reason ?? '',
    sendableNow: policy.allowed,
    policyReason: policy.reason,
    policyCode: policy.code,
    pReply: score?.pReply ?? 0,
    ev: score?.ev ?? 0,
    priority: score?.priority ?? 0,
    ucb: score?.ucb ?? 0,
    exploration: options.exploration ?? false,
    explanation: score?.explanation ?? [],
    warnings: rendered.warnings,
    nextAllowedAt: policy.nextAllowedAt ? policy.nextAllowedAt.toISOString() : null,
  };
}

export function selectTemplate(facts: ReturnType<typeof buildFactsBundle>, channel: ChannelId): MessageTemplate {
  const candidates = TEMPLATES.filter(
    (template) => template.stage === 'first_contact' && template.channels.includes(channel),
  );
  const socialOnly =
    ['messenger', 'instagram', 'facebook'].includes(channel) &&
    !facts.contacts.some((contact) => contact.kind === 'whatsapp');
  const byId = (id: string): MessageTemplate | undefined => candidates.find((template) => template.id === id);
  if (socialOnly) {
    const messaging = byId('first_contact.messaging_only');
    if (messaging) return messaging;
  }
  if (facts.isAdvertiser) {
    const advertiser = byId('first_contact.advertiser');
    if (advertiser) return advertiser;
  }
  const hasStorefront = facts.platform !== 'none' && (facts.catalog.productCount ?? 0) > 0;
  if (hasStorefront) {
    const otherPlatform = byId('first_contact.other_platform');
    if (otherPlatform) return otherPlatform;
  }
  return byId('first_contact.new_small') ?? candidates[0] ?? (TEMPLATES[0] as MessageTemplate);
}

export function followupTemplate(): MessageTemplate {
  return (TEMPLATES.find((template) => template.id === 'followup.once') ?? TEMPLATES[0]) as MessageTemplate;
}

function productLabel(category: string): string {
  const map: Record<string, string> = {
    fashion: 'الملابس',
    shoes: 'الأحذية',
    beauty: 'العطور ومستحضرات التجميل',
    phones_accessories: 'أكسسوارات الهاتف',
    electronics: 'الإلكترونيات',
    home_kitchen: 'مستلزمات المنزل والمطبخ',
    kids: 'منتجات الأطفال',
    auto: 'أكسسوارات السيارات',
    health_supplements: 'المكملات الغذائية',
    jewelry_watches: 'المجوهرات والساعات',
    other: 'منتجك',
  };
  return map[category] ?? 'منتجاتك';
}

async function loadVariantStats(db: Db): Promise<Record<string, { successes: number; failures: number }>> {
  const rows = await db.select().from(templateVariantsTable).limit(200);
  const out: Record<string, { successes: number; failures: number }> = {};
  for (const row of rows) {
    out[row.id] = {
      successes: row.priorSuccesses + row.replies,
      failures: row.priorFailures + Math.max(0, row.sends - row.replies),
    };
  }
  return out;
}

export interface OutcomeResult {
  leadId: string;
  stage: string;
  previousState: LeadState;
  newState: LeadState;
  suppressed: boolean;
  notes: string[];
}

/** Records an outcome event: drives learning, lifecycle and suppression only. */
export async function recordLeadOutcome(
  leadId: string,
  stage: string,
  deps: PipelineDeps,
  options: { note?: string; attemptId?: string; channel?: ChannelId } = {},
): Promise<OutcomeResult | null> {
  const db = deps.db ?? defaultDb;
  const lead = await getLead(leadId, db);
  if (!lead) return null;
  const now = deps.clock.now();
  const attempts = await listAttempts(leadId, db);
  const attempt = attempts.find((candidate) => candidate.id === options.attemptId) ?? attempts[0] ?? null;
  const channel = options.channel ?? attempt?.channel ?? 'whatsapp';
  const notes: string[] = [];

  await recordOutcome(
    {
      leadId,
      attemptId: attempt?.id ?? null,
      stage,
      note: options.note ?? null,
      occurredAt: now,
      variantId: attempt?.variantId ?? null,
      channel,
    },
    db,
  );

  if (attempt && stage === 'contacted') await markAttemptSent(attempt.id, now, db);
  if (attempt && ['replied', 'interested', 'signed_up', 'activated', 'paid'].includes(stage)) {
    await db
      .update(templateVariantsTable)
      .set({
        sends: sql`${templateVariantsTable.sends} + 1`,
        replies: sql`${templateVariantsTable.replies} + 1`,
      })
      .where(eq(templateVariantsTable.id, attempt.variantId));
  } else if (attempt && ['lost', 'blocked', 'reported', 'not_interested'].includes(stage)) {
    await db
      .update(templateVariantsTable)
      .set({ sends: sql`${templateVariantsTable.sends} + 1` })
      .where(eq(templateVariantsTable.id, attempt.variantId));
  }

  let suppressed = false;
  if (['stop', 'not_interested', 'reported'].includes(stage)) {
    suppressed = true;
    await addSuppression({ type: 'lead', value: leadId, reason: `outcome: ${stage}`, createdBy: 'engine' }, db);
    const identityRows = await db
      .select({ type: leadIdentitiesTable.type, value: leadIdentitiesTable.value })
      .from(leadIdentitiesTable)
      .where(eq(leadIdentitiesTable.leadId, leadId));
    for (const identity of identityRows) {
      if (identity.type === 'phone' || identity.type === 'whatsapp') {
        await addSuppression(
          { type: 'phone', value: identity.value, reason: `outcome: ${stage}`, createdBy: 'engine' },
          db,
        );
      }
      if (identity.type === 'email') {
        await addSuppression({ type: 'email', value: identity.value, reason: `outcome: ${stage}`, createdBy: 'engine' }, db);
      }
    }
    notes.push('lead auto-suppressed (hard stop)');
  }

  let sender = await ensureSenderState(deps);
  if (stage === 'contacted') {
    sender = recordSend(sender, now, channel);
    sender = withDailyReplyRate(sender, algiersDayKey(now), { sends: 1, replies: 0 });
    await saveSenderState(sender, deps);
    await recordSenderDay({ day: algiersDayKey(now), sent: 1 }, db);
  }
  if (['replied', 'interested', 'signed_up', 'activated', 'paid'].includes(stage)) {
    sender = withDailyReplyRate(sender, algiersDayKey(now), { sends: 0, replies: 1 });
    await saveSenderState(sender, deps);
    await recordSenderDay({ day: algiersDayKey(now), replies: 1 }, db);
  }
  if (['blocked', 'reported'].includes(stage)) {
    sender = markThrottleAfterBlocked(sender, now);
    await saveSenderState(sender, deps);
    await recordSenderDay({ day: algiersDayKey(now), blockedReported: 1 }, db);
    notes.push(`sender throttled to 50% until ${sender.throttleUntil?.toISOString() ?? 'n/a'}`);
  }

  const target = nextStageFromOutcome(stage) ?? (lead.state as LeadState);
  const check = canTransition(lead.state as LeadState, target, {
    hasObservations: true,
    hasContactableChannel: true,
    qualified: true,
    suppressed,
    hasDraft: true,
    policyAllowed: true,
  });
  const newState = check.allowed ? target : (lead.state as LeadState);
  if (!check.allowed) notes.push(`transition blocked: ${check.reasons.join('; ')}`);
  await updateLeadState(leadId, newState, {}, db);

  const queryYield = await bumpQueryYield(lead.provenance, stage, db);
  if (queryYield > 0) notes.push('search query yield updated (+1 qualified)');

  await recordAudit(
    {
      actor: 'operator',
      action: 'outcome',
      entityType: 'lead',
      entityId: leadId,
      detail: { stage, from: lead.state, to: newState, note: options.note ?? null, suppression: suppressed },
      at: now,
    },
    db,
  );

  return { leadId, stage, previousState: lead.state as LeadState, newState, suppressed, notes };
}

function withDailyReplyRate(
  sender: SenderState,
  dayKey: string,
  delta: { sends: number; replies: number },
): SenderState {
  const rates = [...sender.dailyReplyRates];
  const index = rates.findIndex((entry) => entry.day === dayKey);
  if (index >= 0) {
    const entry = rates[index];
    if (entry) rates[index] = { day: entry.day, sends: entry.sends + delta.sends, replies: entry.replies + delta.replies };
  } else {
    rates.push({ day: dayKey, ...delta });
  }
  return { ...sender, dailyReplyRates: rates.slice(-90) };
}

async function bumpQueryYield(
  provenance: Record<string, unknown> | null,
  stage: string,
  db: Db,
): Promise<number> {
  if (!['interested', 'signed_up', 'activated', 'paid'].includes(stage)) return 0;
  const query = provenance?.['query'];
  const provider = provenance?.['provider'];
  if (typeof query !== 'string' || typeof provider !== 'string') return 0;
  const updated = await db
    .update(searchQueriesTable)
    .set({
      newQualified: sql`${searchQueriesTable.newQualified} + 1`,
      alpha: sql`${searchQueriesTable.alpha} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(searchQueriesTable.query, query), eq(searchQueriesTable.provider, provider)))
    .returning({ id: searchQueriesTable.id });
  return updated.length;
}

export async function ensureSenderState(deps: PipelineDeps): Promise<SenderState> {
  const db = deps.db ?? defaultDb;
  const row = await getSenderState(db);
  if (row) {
    return {
      startedAt: row.startedAt,
      dailyCap: row.dailyCap,
      platformCap: row.platformCap,
      throttleUntil: row.throttleUntil,
      sentByDay: row.sentByDay,
      sentByHour: row.sentByHour,
      lastSentAt: row.lastSentAt,
      lastChannel: row.lastChannel as ChannelId | null,
      dailyReplyRates: row.dailyReplyRates,
    };
  }
  const fresh: SenderState = {
    startedAt: deps.clock.now(),
    dailyCap: deps.config.sender.dailyCap,
    platformCap: deps.config.sender.hourlyCap,
    throttleUntil: null,
    sentByDay: {},
    sentByHour: {},
    lastSentAt: null,
    lastChannel: null,
    dailyReplyRates: [],
  };
  await saveSenderState(fresh, deps);
  return fresh;
}

export async function saveSenderState(state: SenderState, deps: PipelineDeps): Promise<void> {
  const db = deps.db ?? defaultDb;
  await upsertSenderState(
    {
      startedAt: state.startedAt,
      dailyCap: state.dailyCap,
      platformCap: state.platformCap,
      throttleUntil: state.throttleUntil ?? null,
      sentByDay: state.sentByDay,
      sentByHour: state.sentByHour,
      lastSentAt: state.lastSentAt,
      lastChannel: state.lastChannel ?? null,
      dailyReplyRates: state.dailyReplyRates,
    },
    db,
  );
}

export async function senderSnapshot(deps: PipelineDeps): Promise<{
  state: SenderState;
  dailyCap: number;
  sentToday: number;
  nextAllowedAt: string;
  utilisation: number;
}> {
  const state = await ensureSenderState(deps);
  const now = deps.clock.now();
  const cap = dailyCapFor(state, now, DEFAULT_CONTACT_POLICY);
  const sentToday = state.sentByDay[algiersDayKey(now)] ?? 0;
  return {
    state,
    dailyCap: cap,
    sentToday,
    nextAllowedAt: nextAllowedSendTime(now, DEFAULT_CONTACT_POLICY).toISOString(),
    utilisation: clamp(sentToday / cap, 0, 1),
  };
}

export async function resolveEntities(deps: PipelineDeps): Promise<{ pairs: number; autoMerges: number; reviews: number }> {
  const db = deps.db ?? defaultDb;
  const rows = await db
    .select({
      id: leadsTable.id,
      name: leadsTable.name,
      domain: leadsTable.domain,
      wilaya: leadsTable.wilaya,
      category: leadsTable.category,
    })
    .from(leadsTable)
    .where(and(isNull(leadsTable.deletedAt), isNull(leadsTable.mergedIntoId)))
    .limit(5_000);
  const identityRows = await db
    .select({ leadId: leadIdentitiesTable.leadId, type: leadIdentitiesTable.type, value: leadIdentitiesTable.value })
    .from(leadIdentitiesTable);
  const byLead = new Map<string, { type: string; value: string }[]>();
  for (const identity of identityRows) {
    const bucket = byLead.get(identity.leadId) ?? [];
    bucket.push({ type: identity.type, value: identity.value });
    byLead.set(identity.leadId, bucket);
  }
  const records: ResolveRecord[] = rows.map((row) => {
    const identities = byLead.get(row.id) ?? [];
    return {
      id: row.id,
      ...(row.name ? { name: row.name } : {}),
      ...(row.domain ? { domain: row.domain } : {}),
      phones: identities
        .filter((identity) => identity.type === 'phone' || identity.type === 'whatsapp')
        .map((identity) => identity.value),
      emails: identities.filter((identity) => identity.type === 'email').map((identity) => identity.value),
      handles: identities
        .filter((identity) => ['facebook', 'instagram', 'tiktok'].includes(identity.type))
        .map((identity) => identity.value),
      wilaya: row.wilaya,
      category: row.category,
    };
  });

  const pairs = candidatePairs(records);
  const decisions = pairs.map((pair) => comparePair(pair.left, pair.right, pair.blockers));
  const merged = clusterRecords(records, decisions);

  for (const decision of merged.merges) {
    const kept = decision.leftId < decision.rightId ? decision.leftId : decision.rightId;
    const absorbed = kept === decision.leftId ? decision.rightId : decision.leftId;
    await updateLeadFacts(absorbed, { mergedIntoId: kept }, db);
    await recordMergeLog(
      {
        action: 'merge',
        keptLeadId: kept,
        mergedLeadId: absorbed,
        decision: {
          posterior: decision.posterior,
          matchedOn: decision.matchedOn,
          explanation: decision.explanation,
        },
        operator: 'engine',
        at: deps.clock.now(),
      },
      db,
    );
  }
  for (const decision of merged.reviews) {
    await recordMergeLog(
      {
        action: 'review_decision',
        keptLeadId: decision.leftId,
        mergedLeadId: decision.rightId,
        decision: {
          posterior: decision.posterior,
          conflicting: decision.conflicting,
          explanation: decision.explanation,
        },
        operator: 'engine',
        at: deps.clock.now(),
      },
      db,
    );
  }
  deps.logger.info(
    { pairs: decisions.length, merges: merged.merges.length, reviews: merged.reviews.length },
    'entity resolution complete',
  );
  return { pairs: decisions.length, autoMerges: merged.merges.length, reviews: merged.reviews.length };
}

export async function refitModels(deps: PipelineDeps): Promise<{ modelSummary: string; funnelStages: number }> {
  const db = deps.db ?? defaultDb;
  const { fitReplyModel, loadTrainingRows, persistModel } = await import('@/adapters/pipeline/model');
  const rows = await loadTrainingRows(db);
  const model = fitReplyModel(rows, deps.clock);
  await persistModel(model, db);
  const funnel = await loadFunnel(db);
  deps.logger.info({ rows: rows.length, version: model.version }, 'model refit complete');
  return { modelSummary: modelSummary(model), funnelStages: funnel.stages.length };
}

export async function countLeadsByState(deps: PipelineDeps): Promise<Record<string, number>> {
  const db = deps.db ?? defaultDb;
  const rows = await db
    .select({ state: leadsTable.state, count: sql<number>`count(*)::int` })
    .from(leadsTable)
    .where(isNull(leadsTable.deletedAt))
    .groupBy(leadsTable.state);
  const out: Record<string, number> = {};
  for (const row of rows) out[row.state] = row.count;
  return out;
}

export async function recentOutcomes(deps: PipelineDeps, limit = 50) {
  const db = deps.db ?? defaultDb;
  return db.select().from(outcomesTable).orderBy(desc(outcomesTable.occurredAt)).limit(limit);
}

export async function recentObservations(deps: PipelineDeps, limit = 50) {
  const db = deps.db ?? defaultDb;
  return db.select().from(observationsTable).orderBy(desc(observationsTable.observedAt)).limit(limit);
}

export async function recentAttempts(deps: PipelineDeps, limit = 50) {
  const db = deps.db ?? defaultDb;
  return db.select().from(attemptsTable).orderBy(desc(attemptsTable.createdAt)).limit(limit);
}

export async function senderRow(deps: PipelineDeps) {
  const db = deps.db ?? defaultDb;
  const rows = await db.select().from(senderStateTable).where(eq(senderStateTable.id, 'default')).limit(1);
  return rows[0] ?? null;
}

export async function searchQueryRows(deps: PipelineDeps) {
  const db = deps.db ?? defaultDb;
  return db.select().from(searchQueriesTable).orderBy(desc(searchQueriesTable.newQualified)).limit(200);
}

export async function fetchDemoCandidates(deps: PipelineDeps, size = 24): Promise<RawCandidate[]> {
  const source = demoSource(deps.config, size);
  const out: RawCandidate[] = [];
  for await (const candidate of source.discover({
    clock: deps.clock,
    rng: deps.rng ?? createRng(deps.config.seed),
    http: deps.http,
    logger: deps.logger,
    config: deps.config,
    budget: { consume: () => true, remaining: () => 1_000 },
    dryRun: true,
    params: { size: String(size) },
  })) {
    out.push(candidate);
  }
  return out;
}

function toLeadRow(lead: {
  id: string;
  name: string | null;
  domain: string | null;
  platform: string | null;
  category: string | null;
  wilaya: string | null;
  primaryChannel: string | null;
  primaryTarget: string | null;
  maturityIndex: number | null;
  pAlgeria: number | null;
  annotations: Record<string, unknown> | null;
}): LeadRowShape {
  return {
    id: lead.id,
    name: lead.name,
    domain: lead.domain,
    platform: lead.platform as LeadRowShape['platform'],
    category: lead.category as LeadRowShape['category'],
    wilaya: lead.wilaya,
    primaryChannel: lead.primaryChannel as ChannelId | null,
    primaryTarget: lead.primaryTarget,
    maturityIndex: lead.maturityIndex,
    pAlgeria: lead.pAlgeria,
    annotations: lead.annotations,
  };
}

function warmupProgress(sender: SenderState, deps: PipelineDeps): number {
  const days = Math.max(0, (deps.clock.now().getTime() - sender.startedAt.getTime()) / 86_400_000);
  return clamp(days / DEFAULT_CONTACT_POLICY.warmupDays, 0, 1);
}

function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export { buildFactsBundle, preferredChannel, qualifyFromFacts };
