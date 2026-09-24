import { NextResponse } from 'next/server';
import { z } from 'zod';
import { buildCliDeps } from '@/cli/index';
import {
  insertObservation,
  addSuppression,
  recordAudit,
} from '@/adapters/db/repo-extra';
import { exportLeadBundle, purgeLeadData } from '@/adapters/pipeline/privacy';
import { recordLeadOutcome } from '@/adapters/pipeline/index';
import { draftLead, recentAttempts, recentOutcomes } from '@/adapters/pipeline/index';

export const dynamic = 'force-dynamic';

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('outcome'), leadId: z.string().min(1), stage: z.string().min(2), note: z.string().max(500).optional() }),
  z.object({ action: z.literal('suppress'), leadId: z.string().min(1), reason: z.string().max(200).optional() }),
  z.object({ action: z.literal('annotate'), leadId: z.string().min(1), key: z.string().min(1).max(40), value: z.string().max(300) }),
  z.object({ action: z.literal('purge'), leadId: z.string().min(1) }),
  z.object({ action: z.literal('draft'), leadId: z.string().min(1) }),
]);

export async function GET(request: Request) {
  const deps = buildCliDeps();
  const url = new URL(request.url);
  const exportId = url.searchParams.get('export');
  try {
    if (exportId) {
      const bundle = await exportLeadBundle(exportId, deps.db);
      return NextResponse.json(bundle);
    }
    const [lastOutcomes, lastAttempts] = await Promise.all([recentOutcomes(deps, 20), recentAttempts(deps, 20)]);
    return NextResponse.json({ lastOutcomes, lastAttempts });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const deps = buildCliDeps();
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json({ error: `invalid request: ${(error as Error).message}` }, { status: 400 });
  }

  try {
    if (parsed.action === 'outcome') {
      const result = await recordLeadOutcome(parsed.leadId, parsed.stage, deps, {
        ...(parsed.note ? { note: parsed.note } : {}),
      });
      if (!result) return NextResponse.json({ error: 'lead not found' }, { status: 404 });
      return NextResponse.json({
        message: `outcome ${parsed.stage}: ${result.previousState} → ${result.newState}${result.suppressed ? ' (suppression automatique)' : ''}`,
      });
    }
    if (parsed.action === 'suppress') {
      await addSuppression(
        {
          type: 'lead',
          value: parsed.leadId,
          reason: parsed.reason ?? 'operator request',
          createdBy: deps.config.operator,
        },
        deps.db,
      );
      await recordAudit(
        {
          actor: deps.config.operator,
          action: 'suppress',
          entityType: 'lead',
          entityId: parsed.leadId,
          detail: { reason: parsed.reason ?? 'operator request' },
          at: deps.clock.now(),
        },
        deps.db,
      );
      return NextResponse.json({ message: 'lead ajouté à la liste de suppression (hard stop)' });
    }
    if (parsed.action === 'annotate') {
      await insertObservation(
        {
          leadId: parsed.leadId,
          key: `annotation:${parsed.key}`,
          value: parsed.value,
          confidence: 0.9,
          evidence: [{ location: 'operator-console', detail: 'manual annotation' }],
          source: 'operator',
          observedAt: deps.clock.now(),
        },
        deps.db,
      );
      return NextResponse.json({ message: `annotation ${parsed.key} enregistrée` });
    }
    if (parsed.action === 'purge') {
      await purgeLeadData(parsed.leadId, deps.db);
      return NextResponse.json({ message: 'lead effacé (la suppression est conservée)' });
    }
    const item = await draftLead(parsed.leadId, deps, { forceDraft: true });
    if (!item) return NextResponse.json({ error: 'no contactable channel to draft for' }, { status: 422 });
    return NextResponse.json({ message: `draft ${item.variantId} ready (sendable=${item.sendableNow})`, item });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
