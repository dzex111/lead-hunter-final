import { db as defaultDb } from '@/db';
import {
  buildQueue,
  countLeadsByState,
  fetchDemoCandidates,
  ingestCandidates,
  enrichLead,
  recordLeadOutcome,
  refitModels,
  resolveEntities,
  scoreLead,
  senderSnapshot,
} from '@/adapters/pipeline/index';
import { ensureTemplatesFromCatalog } from '@/adapters/db/repo-extra';
import { loadFunnel } from '@/adapters/pipeline/funnel';
import { loadActiveModel, modelSummary } from '@/adapters/pipeline/model';
import { LAW_18_07_NOTE } from '@/adapters/pipeline/privacy';
import { DEFAULT_CONTACT_POLICY, cusumReplyRate } from '@/core/policy/contact';
import { TEMPLATES } from '@/core/messaging/templates';
import type { PipelineDeps } from '@/adapters/pipeline/index';

/**
 * Offline end-to-end demo: uses the synthetic population + the real extractor
 * (synthetic HTML built from the same fixtures' structure), writes to the real
 * Postgres schema and produces the same ranked queue the operator would see.
 * No network access is required.
 */
export async function runDemo(deps: PipelineDeps, options: { size?: number } = {}): Promise<string> {
  const db = deps.db ?? defaultDb;
  const size = options.size ?? 24;
  const lines: string[] = [];
  lines.push('Lead Hunter offline demo (fixtures + synthetic population, zero network)');
  lines.push('');

  await ensureTemplatesFromCatalog(
    TEMPLATES.map((template) => ({
      id: template.id,
      stage: template.stage,
      label: template.label,
      description: template.description,
      slots: template.slots,
      channels: template.channels,
      platforms: template.platforms ?? null,
      requiresLink: template.requiresLink ?? false,
      variants: template.variants,
    })),
    db,
  );

  const candidates = await fetchDemoCandidates(deps, size);
  const ingested = await ingestCandidates(candidates, deps);
  lines.push(`1. discover+ingest : ${candidates.length} candidates → ${ingested.created} new leads, ${ingested.updated} updated`);

  let qualified = 0;
  let disqualified = 0;
  for (const leadId of ingested.leadIds) {
    const outcome = await enrichLead(leadId, deps, { offline: true });
    if (!outcome) continue;
    if (outcome.qualified) qualified += 1;
    else disqualified += 1;
  }
  lines.push(`2. enrich+qualify  : ${qualified} qualified, ${disqualified} disqualified`);

  const resolution = await resolveEntities(deps);
  lines.push(
    `3. resolve         : ${resolution.pairs} candidate pairs, ${resolution.autoMerges} auto-merged, ${resolution.reviews} in review queue`,
  );

  for (const leadId of ingested.leadIds) {
    await scoreLead(leadId, deps);
  }
  const model = await loadActiveModel(deps.clock, db);
  lines.push(`4. score           : ${ingested.leadIds.length} scored`);
  lines.push(`   ${modelSummary(model).split('\n')[0]}`);

  const queue = await buildQueue(deps, { n: 5 });
  lines.push(`5. queue           : top ${queue.length} of the ranked daily batch`);
  queue.forEach((item, index) => {
    lines.push(
      `   #${index + 1} ${item.leadName ?? item.domain} · ${item.platform}/${item.category} · ${item.wilaya} · ${item.channel}${
        item.exploration ? ' [exploration]' : ''
      }`,
    );
    lines.push(`      p(reply)=${item.pReply.toFixed(3)} EV=${item.ev.toFixed(2)} DZD priority=${item.priority.toFixed(4)}`);
    lines.push(`      link: ${item.waLink ?? item.handoffUrl}`);
    lines.push(`      draft: ${item.message.split('\n')[0] ?? ''}`);
  });

  if (queue[0]) {
    await recordLeadOutcome(queue[0].leadId, 'contacted', deps);
    await recordLeadOutcome(queue[0].leadId, 'replied', deps, { note: 'demo outcome' });
    if (queue[1]) await recordLeadOutcome(queue[1].leadId, 'contacted', deps);
    if (queue[2]) {
      await recordLeadOutcome(queue[2].leadId, 'contacted', deps);
      await recordLeadOutcome(queue[2].leadId, 'not_interested', deps, { note: 'demo suppression' });
    }
    lines.push('6. outcomes        : contacted x3, replied x1, not_interested x1 (auto-suppressed)');
  }

  const funnel = await loadFunnel(db);
  lines.push('7. funnel (Beta-Binomial, hierarchical):');
  for (const stage of funnel.stages) {
    lines.push(
      `   ${stage.stage.padEnd(12)} n=${stage.n} rate=${stage.posteriorMean.toFixed(3)} lower95=${stage.posteriorLower.toFixed(3)}`,
    );
  }

  const sender = await senderSnapshot(deps);
  const cusum = cusumReplyRate(sender.state.dailyReplyRates, 0.12, DEFAULT_CONTACT_POLICY);
  lines.push(
    `8. sender guard    : ${sender.sentToday}/${sender.dailyCap} today (warm-up ramp), next send window ${sender.nextAllowedAt}`,
  );
  lines.push(`   CUSUM reply-rate statistic=${cusum.statistic.toFixed(2)} alarm=${cusum.alarm ? 'YES (possible throttling)' : 'no'}`);
  lines.push(`   quiet hours ${DEFAULT_CONTACT_POLICY.quietHourStart}:00-0${DEFAULT_CONTACT_POLICY.quietHourEnd}:00 Africa/Algiers, Friday 11:30-14:30 blackout`);

  const states = await countLeadsByState(deps);
  lines.push(`9. states          : ${JSON.stringify(states)}`);

  const refit = await refitModels(deps);
  lines.push(`10. model refit    : ${refit.modelSummary.split('\n')[0]}`);

  lines.push('');
  lines.push('PRIVACY: only business-public contact data is stored.');
  lines.push(LAW_18_07_NOTE);
  lines.push('REMINDER: the engine never sends. Copy the draft, open the link, send it yourself.');
  return lines.join('\n');
}
