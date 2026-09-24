import { buildCliDeps } from '@/cli/index';
import { buildQueue, senderSnapshot } from '@/adapters/pipeline/index';
import { CopyButton } from '@/app/components/ui';

export const dynamic = 'force-dynamic';

type QueueData = {
  items: Awaited<ReturnType<typeof buildQueue>>;
  senderLine: string;
  senderWindow: string;
};

async function loadQueue(): Promise<{ ok: true; data: QueueData } | { ok: false; error: string }> {
  try {
    const deps = buildCliDeps();
    const [items, sender] = await Promise.all([buildQueue(deps, { n: 20 }), senderSnapshot(deps)]);
    return {
      ok: true,
      data: {
        items,
        senderLine: `${sender.sentToday}/${sender.dailyCap}`,
        senderWindow: new Date(sender.nextAllowedAt).toISOString().slice(11, 16),
      },
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export default async function QueuePage() {
  const loaded = await loadQueue();
  if (!loaded.ok) return <p className="text-sm text-rose-300">خطأ في القراءة: {loaded.error}</p>;
  const { items, senderLine, senderWindow } = loaded.data;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">طابور اليوم — {items.length} تجّار مرتبين</h1>
          <p className="text-xs text-slate-400">
            ترتيب MMR (المنصة × الفئة × الولاية) + حصة استكشاف 10%.
            المحرك لا يرسل أبداً: انسخ النص، افتح الرابط، أرسل بنفسك.
          </p>
        </div>
        <p className="text-xs text-slate-400">
          المرسل: {senderLine} اليوم · النافذة القادمة {senderWindow}
        </p>
      </header>

      {items.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-sm text-slate-300">
          الطابور فارغ: شغّل «تشغيل التجربة» من الرئيسية، أو{' '}
          <code className="font-mono">pnpm cli enrich --all</code> ثم <code className="font-mono">pnpm cli score --all</code>.
        </p>
      ) : null}

      <div className="space-y-4">
        {items.map((item, index) => (
          <article key={`${item.leadId}-${item.templateId}`} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-white">
                  #{index + 1} {item.leadName ?? item.domain ?? item.leadId.slice(0, 8)}
                  {item.exploration ? (
                    <span className="mr-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">استكشاف</span>
                  ) : null}
                </h2>
                <p className="text-xs text-slate-400">
                  {item.platform} · {item.category} · {item.wilaya} · القناة {item.channel} ← {item.target}
                </p>
              </div>
              <div className="text-xs text-slate-400">
                <p className="text-emerald-300">
                  احتمال الرد {item.pReply.toFixed(3)} · UCB {item.ucb.toFixed(3)}
                </p>
                <p>
                  القيمة {item.ev.toFixed(2)} دج · الأولوية {item.priority.toFixed(4)}
                </p>
                <p>
                  الإرسال:{' '}
                  <span className={item.sendableNow ? 'text-emerald-300' : 'text-rose-300'}>
                    {item.sendableNow ? 'مسموح' : item.policyReason}
                  </span>
                </p>
              </div>
            </header>

            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-100">{item.message}</pre>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <CopyButton text={item.message} label="نسخ الرسالة" />
                {item.waLink ? (
                  <a
                    href={item.waLink}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-200 hover:bg-emerald-500/20"
                  >
                    فتح واتساب (النص جاهز)
                  </a>
                ) : (
                  <a
                    href={item.handoffUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:border-emerald-400/60"
                  >
                    فتح الملف الشخصي
                  </a>
                )}
                <span className="text-xs text-slate-500">{item.sendInstructions}</span>
              </div>
            </div>

            <details className="mt-3 text-xs text-slate-400">
              <summary className="cursor-pointer text-slate-300">لماذا هذا التاجر؟ (المساهمات والأدلة)</summary>
              <ul className="mt-2 list-disc space-y-0.5 pr-5">
                {item.explanation.map((line) => (
                  <li key={line} className="font-mono">
                    {line}
                  </li>
                ))}
              </ul>
              {item.warnings.length > 0 ? (
                <p className="mt-2 text-amber-300">تحذيرات الصياغة: {item.warnings.join(' · ')}</p>
              ) : null}
              <p className="mt-2">
                القالب: {item.templateId} · المتغير {item.variantId} · السياسة: {item.policyCode}
                {item.nextAllowedAt ? ` · أقرب إرسال ممكن ${item.nextAllowedAt}` : ''}
              </p>
            </details>
          </article>
        ))}
      </div>
    </div>
  );
}
