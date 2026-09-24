import Link from 'next/link';
import { buildCliDeps } from '@/cli/index';
import { PipelineControls } from '@/app/components/ui';
import {
  countLeadsByState,
  recentAttempts,
  recentOutcomes,
  searchQueryRows,
  senderSnapshot,
} from '@/adapters/pipeline/index';
import { loadFunnel } from '@/adapters/pipeline/funnel';
import { loadActiveModel } from '@/adapters/pipeline/model';
import { listModelVersions, listSenderDays, listSuppression } from '@/adapters/db/repo';

export const dynamic = 'force-dynamic';

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
      <header className="mb-3">
        <h2 className="text-sm font-bold text-slate-200">{title}</h2>
        {subtitle ? <p className="mt-1 text-xs text-slate-500">{subtitle}</p> : null}
      </header>
      {children}
    </section>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-white">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

type DashboardData = {
  states: Record<string, number>;
  totalLeads: number;
  funnel: Awaited<ReturnType<typeof loadFunnel>>;
  modelVersion: string;
  modelInfo: string;
  modelMetrics: string;
  senderLine: string;
  senderDetail: string;
  cusumDays: number;
  models: { id: string; kind: string; version: string; nObservations: number; active: boolean }[];
  queries: Awaited<ReturnType<typeof searchQueryRows>>;
  outcomes: Awaited<ReturnType<typeof recentOutcomes>>;
  attempts: Awaited<ReturnType<typeof recentAttempts>>;
  suppressionCount: number;
  senderDays: Awaited<ReturnType<typeof listSenderDays>>;
};

/** Data loading lives outside the component so render never swallows errors. */
async function loadDashboard(): Promise<{ ok: true; data: DashboardData } | { ok: false; error: string }> {
  try {
    const deps = buildCliDeps();
    const [states, funnel, model, sender, queries, suppression, models, outcomes, attempts, days] =
      await Promise.all([
        countLeadsByState(deps),
        loadFunnel(deps.db),
        loadActiveModel(deps.clock, deps.db),
        senderSnapshot(deps),
        searchQueryRows(deps),
        listSuppression(10, deps.db),
        listModelVersions(deps.db),
        recentOutcomes(deps, 8),
        recentAttempts(deps, 8),
        listSenderDays(7, deps.db),
      ]);

    const totalLeads = Object.values(states).reduce((acc, value) => acc + value, 0);
    const brier = model.metrics['brier'];
    const ece = model.metrics['ece'];
    return {
      ok: true,
      data: {
        states,
        totalLeads,
        funnel,
        modelVersion: model.coldStart ? 'بداية باردة' : model.version.slice(0, 18),
        modelInfo: `عدد الملاحظات ${model.nObservations} · ${
          model.coldStart ? 'بداية باردة (priors فقط)' : model.calibrated ? 'معايرة Platt مفعّلة' : 'غير معاير (أقل من 200)'
        }`,
        modelMetrics:
          brier !== undefined
            ? `Brier ${brier.toFixed(4)} · log-loss ${(model.metrics['logLoss'] ?? 0).toFixed(4)} · ECE ${(ece ?? 0).toFixed(4)} · AUC ${(model.metrics['auc'] ?? 0).toFixed(3)}`
            : 'لا مقاييس بعد (يلزم 30 نتيجة موسومة على الأقل)',
        senderLine: `${sender.sentToday}/${sender.dailyCap}`,
        senderDetail: `التدرج والحد الأقصى · النافذة القادمة ${new Date(sender.nextAllowedAt).toISOString().slice(11, 16)}`,
        cusumDays: sender.state.dailyReplyRates.length,
        models: models.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          version: entry.version,
          nObservations: entry.nObservations,
          active: entry.active,
        })),
        queries,
        outcomes,
        attempts,
        suppressionCount: suppression.length,
        senderDays: days,
      },
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function DbMissing({ error }: { error: string }) {
  return (
    <div className="space-y-4">
      <Card title="قاعدة البيانات غير مهيأة" subtitle="يجب دفع السكيمة قبل استعمال اللوحة">
        <p className="text-sm text-rose-300">{error}</p>
        <p className="mt-2 text-xs text-slate-400">
          نفّذ <code className="font-mono">npx drizzle-kit push</code> ثم <code className="font-mono">pnpm demo</code>
          (أو زر «تشغيل التجربة» بالأسفل).
        </p>
        <div className="mt-4">
          <PipelineControls />
        </div>
      </Card>
    </div>
  );
}

export default async function DashboardPage() {
  const loaded = await loadDashboard();
  if (!loaded.ok) return <DbMissing error={loaded.error} />;
  const d = loaded.data;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="التجّار"
          value={String(d.totalLeads)}
          hint={`${d.states['qualified'] ?? 0} مؤهّل · ${d.states['drafted'] ?? 0} مسودة`}
        />
        <Kpi
          label="طابور اليوم"
          value={String((d.states['queued'] ?? 0) + (d.states['drafted'] ?? 0))}
          hint="دفعة مرتبة (MMR + حصة استكشاف 10%)"
        />
        <Kpi label="سقف الإرسال" value={d.senderLine} hint={d.senderDetail} />
        <Kpi label="نموذج احتمال الرد" value={d.modelVersion} hint={d.modelInfo} />
      </div>

      <Card title="التحكم في المحرك" subtitle="المحرّك يجهّز كل شيء، وأنت ترسل. لا يوجد إرسال تلقائي في الكود.">
        <PipelineControls />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="القمع (Beta-Binomial)" subtitle="المتوسط البعدي + الحد الأدنى 95%">
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1 text-right">المرحلة</th>
                <th>العدد</th>
                <th>ناجح</th>
                <th>المتوسط</th>
                <th>الحد الأدنى</th>
              </tr>
            </thead>
            <tbody>
              {d.funnel.stages.map((stage) => (
                <tr key={stage.stage} className="border-t border-slate-800">
                  <td className="py-1.5 text-slate-200">{stage.stage}</td>
                  <td className="text-slate-400">{stage.n}</td>
                  <td className="text-slate-400">{stage.successes}</td>
                  <td className="text-emerald-300">{stage.posteriorMean.toFixed(3)}</td>
                  <td className="text-slate-300">{stage.posteriorLower.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="ضوابط المرسل" subtitle="سياسة الاتصال مطبقة في الكود">
          <ul className="space-y-1.5 text-sm text-slate-300">
            <li>رسالة أولى واحدة + متابعة واحدة بعد 3 أيام على الأقل</li>
            <li>ممنوع قناتان مختلفتان خلال 7 أيام</li>
            <li>ساعات الهدوء 22:00–08:00 (الجزائر) · الجمعة 11:30–14:30</li>
            <li>السقف اليومي {d.senderLine} (تدرج من 10 إلى السقف خلال 14 يوماً)</li>
            <li>نصف السقف 7 أيام بعد «حظر / بلاغ»</li>
            <li>مراقبة CUSUM لمعدل الرد: {d.cusumDays} أيام مرصودة</li>
          </ul>
        </Card>

        <Card title="النماذج والإصدارات" subtitle="كل تقييم يخزن مساهماته ومقاييسه">
          <p className="text-sm text-slate-200">{d.modelInfo}</p>
          <p className="mt-2 font-mono text-xs text-slate-400">{d.modelMetrics}</p>
          <ul className="mt-3 space-y-1 text-xs text-slate-400">
            {d.models.map((entry) => (
              <li key={entry.id}>
                {entry.kind} · {entry.version} · عدد {entry.nObservations} · {entry.active ? 'نشط' : 'مؤرشف'}
              </li>
            ))}
            {d.models.length === 0 ? <li>لا يوجد نموذج محفوظ</li> : null}
          </ul>
        </Card>

        <Card title="نشاط المرسل اليومي" subtitle="إحصاءات يومية من جدول sender_days الجديد">
          {d.senderDays.length === 0 ? (
            <p className="text-xs text-slate-500">لا نشاط مسجل بعد — سجّل نتيجة من صفحة التجّار.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 text-right">اليوم</th>
                  <th>مرسَل</th>
                  <th>ردود</th>
                  <th>حظر/بلاغ</th>
                </tr>
              </thead>
              <tbody>
                {d.senderDays.map((row) => (
                  <tr key={row.day} className="border-t border-slate-800">
                    <td className="py-1.5 text-slate-300">{row.day}</td>
                    <td className="text-slate-400">{row.sent}</td>
                    <td className="text-emerald-300">{row.replies}</td>
                    <td className="text-rose-300">{row.blockedReported}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="باندت الاستعلامات" subtitle="العائد المقاس: تجّار مؤهلون جدد لكل استدعاء API">
          <table className="w-full text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1 text-right">المزوّد</th>
                <th>استدعاءات</th>
                <th>مؤهلون</th>
                <th>الحالة</th>
              </tr>
            </thead>
            <tbody>
              {d.queries.slice(0, 8).map((query) => (
                <tr key={query.id} className="border-t border-slate-800">
                  <td className="py-1.5 text-slate-300">{query.provider}</td>
                  <td className="text-slate-400">{query.calls}</td>
                  <td className="text-emerald-300">{query.newQualified}</td>
                  <td className="text-slate-400">{query.retired ? 'متقاعد' : 'نشط'}</td>
                </tr>
              ))}
              {d.queries.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-2 text-slate-500">
                    لا استعلامات مسجلة
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Card>

        <Card title="أحدث النتائج" subtitle="كل حدث يحدّث دورة الحياة والحظر والباندت والنموذج">
          <ul className="space-y-1 text-xs text-slate-300">
            {d.outcomes.map((outcome) => (
              <li key={outcome.id}>
                {outcome.occurredAt.toISOString().slice(0, 16).replace('T', ' ')} · {outcome.stage} · تاجر{' '}
                {outcome.leadId.slice(0, 8)}
                {outcome.note ? ` · ${outcome.note}` : ''}
              </li>
            ))}
            {d.outcomes.length === 0 ? <li className="text-slate-500">لا نتائج مسجلة</li> : null}
          </ul>
        </Card>

        <Card title="أحدث المسودات" subtitle="الحالة «مسودة» حتى يسجّل الإنسان نتيجة «تم الاتصال»">
          <ul className="space-y-1 text-xs text-slate-300">
            {d.attempts.map((attempt) => (
              <li key={attempt.id}>
                {attempt.status} · {attempt.templateId} · {attempt.channel} · تاجر {attempt.leadId.slice(0, 8)}
              </li>
            ))}
            {d.attempts.length === 0 ? <li className="text-slate-500">لا مسودات</li> : null}
          </ul>
          <p className="mt-3 text-xs text-slate-500">
            {d.suppressionCount} مدخلات حظر (توقف نهائي){' '}
            <Link className="text-emerald-300 underline" href="/queue">
              عرض الطابور ←
            </Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
