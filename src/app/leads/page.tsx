import { buildCliDeps } from '@/cli/index';
import { listLeads } from '@/adapters/db/repo';
import { latestScoresFor } from '@/adapters/db/repo';
import { LeadActions, arabicState } from '@/app/components/ui';

export const dynamic = 'force-dynamic';

type LeadsData = {
  leads: Awaited<ReturnType<typeof listLeads>>;
  scores: Awaited<ReturnType<typeof latestScoresFor>>;
};

async function loadLeads(): Promise<{ ok: true; data: LeadsData } | { ok: false; error: string }> {
  try {
    const deps = buildCliDeps();
    const leads = await listLeads({ limit: 60 }, deps.db);
    const scores = await latestScoresFor(
      leads.map((lead) => lead.id),
      deps.db,
    );
    return { ok: true, data: { leads, scores } };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export default async function LeadsPage() {
  const loaded = await loadLeads();
  if (!loaded.ok) return <p className="text-sm text-rose-300">خطأ في القراءة: {loaded.error}</p>;
  const { leads, scores } = loaded.data;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-bold">التجّار ({leads.length})</h1>
        <p className="text-xs text-slate-400">
          كل حقيقة ملاحظة لا تُمحى مع الثقة والأدلة. الإجراءات: تعليق، تسجيل نتيجة،
          حظر (توقف نهائي)، تصدير (حق الوصول) أو حذف (حق المحو — مع بقاء الحظر).
        </p>
      </header>

      <div className="space-y-3">
        {leads.map((lead) => {
          const score = scores.get(lead.id);
          return (
            <article key={lead.id} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold text-white">
                    {lead.name ?? lead.domain ?? lead.id.slice(0, 8)}{' '}
                    <span className="mr-1 rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] text-slate-200">
                      {arabicState(lead.state)}
                    </span>
                  </h2>
                  <p className="text-xs text-slate-400">
                    {lead.platform ?? 'غير معروف'} · {lead.category ?? 'أخرى'} · {lead.domain ?? 'بلا نطاق'} ·{' '}
                    {lead.primaryChannel ?? 'بلا قناة'} {lead.primaryTarget ?? ''}
                  </p>
                  <p className="text-xs text-slate-500">
                    احتمال الجزائر {(lead.pAlgeria ?? 0).toFixed(2)} · النضج {(lead.maturityIndex ?? 0).toFixed(1)} ·{' '}
                    {score
                      ? `احتمال الرد ${score.pReply.toFixed(3)} · القيمة ${score.ev.toFixed(2)} دج · النموذج ${score.modelVersion}`
                      : 'غير مقيّم'}
                  </p>
                  {lead.disqualifiedReason ? (
                    <p className="text-xs text-rose-300">الأسباب: {lead.disqualifiedReason}</p>
                  ) : null}
                </div>
                <div className="text-xs text-slate-500">
                  <p>المصدر {lead.sourceId ?? '—'}</p>
                  <p>شوهد {lead.lastSeenAt.toISOString().slice(0, 16).replace('T', ' ')}</p>
                  {lead.provenance?.['demo'] === true ? <p className="text-amber-300">بيانات تجريبية (demo)</p> : null}
                </div>
              </div>
              <div className="mt-3">
                <LeadActions leadId={lead.id} state={lead.state} />
              </div>
            </article>
          );
        })}
        {leads.length === 0 ? (
          <p className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-sm text-slate-300">
            لا تجّار: شغّل «تشغيل التجربة» (بيانات تجريبية) أو استورد من سطر الأوامر (
            <code className="font-mono">pnpm cli import paste --text …</code>).
          </p>
        ) : null}
      </div>
    </div>
  );
}
