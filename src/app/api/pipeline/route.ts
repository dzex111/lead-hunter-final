import { NextResponse } from 'next/server';
import { z } from 'zod';
import { buildCliDeps } from '@/cli/index';
import {
  buildQueue,
  countLeadsByState,
  enrichLead,
  fetchDemoCandidates,
  ingestCandidates,
  refitModels,
  resolveEntities,
  scoreLead,
  senderSnapshot,
} from '@/adapters/pipeline/index';
import { ensureTemplatesFromCatalog } from '@/adapters/db/repo-extra';
import { TEMPLATES } from '@/core/messaging/templates';
import { desc, isNull, and, inArray } from 'drizzle-orm';
import { leads as leadsTable } from '@/adapters/db/tables';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  action: z.enum(['demo', 'enrich', 'score', 'refit', 'queue']),
  limit: z.number().int().min(1).max(200).optional(),
});

/** Operator console: run pipeline steps. Never sends anything. */
export async function POST(request: Request) {
  const deps = buildCliDeps();
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json({ error: `invalid request: ${(error as Error).message}` }, { status: 400 });
  }

  try {
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
      deps.db,
    );

    if (parsed.action === 'demo') {
      const size = parsed.limit ?? 24;
      const candidates = await fetchDemoCandidates(deps, size);
      const ingested = await ingestCandidates(candidates, deps);
      let qualified = 0;
      for (const leadId of ingested.leadIds) {
        const outcome = await enrichLead(leadId, deps, { offline: true });
        if (outcome?.qualified) qualified += 1;
      }
      const resolution = await resolveEntities(deps);
      for (const leadId of ingested.leadIds) {
        await scoreLead(leadId, deps);
      }
      const queue = await buildQueue(deps, { n: 12 });
      return NextResponse.json({
        message: `demo: ${ingested.created} new leads, ${qualified} qualified, ${resolution.autoMerges} merges, ${queue.length} drafted in the queue`,
      });
    }

    if (parsed.action === 'enrich') {
      const rows = await deps.db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(and(isNull(leadsTable.deletedAt), isNull(leadsTable.mergedIntoId), inArray(leadsTable.state, ['new'])))
        .orderBy(desc(leadsTable.firstSeenAt))
        .limit(parsed.limit ?? 20);
      let qualified = 0;
      for (const row of rows) {
        const outcome = await enrichLead(row.id, deps, { offline: true });
        if (outcome?.qualified) qualified += 1;
      }
      return NextResponse.json({ message: `enriched ${rows.length} leads (${qualified} qualified)` });
    }

    if (parsed.action === 'score') {
      const rows = await deps.db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(
          and(
            isNull(leadsTable.deletedAt),
            inArray(leadsTable.state, ['enriched', 'qualified', 'queued', 'drafted']),
          ),
        )
        .limit(parsed.limit ?? 50);
      for (const row of rows) await scoreLead(row.id, deps);
      const sender = await senderSnapshot(deps);
      return NextResponse.json({
        message: `scored ${rows.length} leads · sender ${sender.sentToday}/${sender.dailyCap} today`,
      });
    }

    if (parsed.action === 'refit') {
      const result = await refitModels(deps);
      return NextResponse.json({ message: result.modelSummary.split('\n').join(' · ') });
    }

    const queue = await buildQueue(deps, { n: parsed.limit ?? 12 });
    const states = await countLeadsByState(deps);
    return NextResponse.json({ message: `queue rebuilt: ${queue.length} items · states ${JSON.stringify(states)}` });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
