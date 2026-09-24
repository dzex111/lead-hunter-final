import { NextResponse } from 'next/server';
import { z } from 'zod';
import { buildCliDeps } from '@/cli/index';
import { buildQueue, recordLeadOutcome, senderSnapshot } from '@/adapters/pipeline/index';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  leadId: z.string().min(1),
  action: z.enum(['mark_sent', 'reply', 'interested', 'lost']),
  note: z.string().max(500).optional(),
  channel: z.string().max(20).optional(),
});

/** GET: the ranked daily queue (same computation as `pnpm cli next`). */
export async function GET(request: Request) {
  const deps = buildCliDeps();
  const url = new URL(request.url);
  const n = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('n') ?? '20', 10) || 20));
  try {
    const [items, sender] = await Promise.all([buildQueue(deps, { n }), senderSnapshot(deps)]);
    return NextResponse.json({ items, sender: { ...sender, state: undefined } });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

/** POST: record what the human did (the engine never sends). */
export async function POST(request: Request) {
  const deps = buildCliDeps();
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json({ error: `invalid request: ${(error as Error).message}` }, { status: 400 });
  }
  const stage = parsed.action === 'mark_sent' ? 'contacted' : parsed.action;
  try {
    const result = await recordLeadOutcome(parsed.leadId, stage, deps, {
      ...(parsed.note ? { note: parsed.note } : {}),
      ...(parsed.channel ? { channel: parsed.channel as never } : {}),
    });
    if (!result) return NextResponse.json({ error: 'lead not found' }, { status: 404 });
    return NextResponse.json({
      message: `${result.previousState} → ${result.newState}${result.suppressed ? ' (suppressed)' : ''} ${result.notes.join('; ')}`,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
