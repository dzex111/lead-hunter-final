'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

export function CopyButton({ text, label = 'نسخ' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-200 hover:bg-emerald-500/20"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? 'تم النسخ ✓' : label}
    </button>
  );
}

export function PipelineControls() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (action: string) => {
    setBusy(action);
    setMessage(`${action}…`);
    try {
      const response = await fetch('/api/pipeline', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const payload = (await response.json()) as { message?: string; error?: string };
      setMessage(payload.error ?? payload.message ?? 'تم');
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(`خطأ: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const actions: { action: string; label: string; hint: string }[] = [
    { action: 'demo', label: 'تشغيل التجربة (بدون إنترنت)', hint: 'seed ← enrich ← resolve ← score ← queue (بدون شبكة)' },
    { action: 'enrich', label: 'تخصيب التجّار الجدد', hint: 'جلب + استخراج + تأهيل' },
    { action: 'score', label: 'تقييم التجّار', hint: 'احتمال الرد، القمع، القيمة، الأولوية' },
    { action: 'refit', label: 'إعادة تدريب النموذج', hint: 'إعادة ضبط MAP + مقاييس المعايرة (30 نتيجة على الأقل)' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {actions.map((entry) => (
          <button
            key={entry.action}
            type="button"
            title={entry.hint}
            disabled={busy !== null || pending}
            onClick={() => void run(entry.action)}
            className="rounded-lg border border-slate-600 bg-slate-800/70 px-3 py-2 text-sm font-medium text-slate-100 hover:border-emerald-400/60 hover:bg-slate-700/70 disabled:opacity-50"
          >
            {busy === entry.action ? '…' : entry.label}
          </button>
        ))}
      </div>
      {message ? <p className="text-xs text-slate-400">{message}</p> : null}
    </div>
  );
}

const OUTCOME_LABELS: Record<string, string> = {
  contacted: 'تم الاتصال',
  replied: 'ردّ',
  interested: 'مهتم',
  signed_up: 'سجّل',
  activated: 'فعّل',
  paid: 'دفع',
  lost: 'ضاع',
  not_interested: 'غير مهتم',
  blocked: 'حظرنا',
  reported: 'بلّغ عنا',
  stop: 'طلب التوقف',
};

const STATE_LABELS: Record<string, string> = {
  new: 'جديد',
  enriched: 'مخصّب',
  qualified: 'مؤهّل',
  disqualified: 'مرفوض',
  queued: 'في الطابور',
  drafted: 'مسودة جاهزة',
  contacted: 'تم الاتصال',
  replied: 'ردّ',
  interested: 'مهتم',
  signed_up: 'مسجّل',
  activated: 'مفعّل',
  paid: 'دافع',
  lost: 'ضائع',
  merged: 'مدمج',
};

export function arabicState(state: string): string {
  return STATE_LABELS[state] ?? state;
}

export function LeadActions({ leadId, state }: { leadId: string; state: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [key, setKey] = useState('niche');
  const [value, setValue] = useState('');
  const [result, setResult] = useState<string | null>(null);

  const call = async (body: Record<string, unknown>, label: string) => {
    setBusy(true);
    try {
      const response = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leadId, ...body }),
      });
      const payload = (await response.json()) as { message?: string; error?: string };
      setResult(payload.error ? `خطأ: ${payload.error}` : (payload.message ?? label));
      router.refresh();
    } catch (error) {
      setResult(`خطأ: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const stages = Object.keys(OUTCOME_LABELS);

  return (
    <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-100"
          defaultValue=""
          onChange={(event) => {
            const stage = event.target.value;
            if (stage) void call({ action: 'outcome', stage, note }, `النتيجة: ${OUTCOME_LABELS[stage] ?? stage}`);
            event.target.value = '';
          }}
        >
          <option value="">سجّل نتيجة…</option>
          {stages.map((stage) => (
            <option key={stage} value={stage}>
              {OUTCOME_LABELS[stage] ?? stage}
            </option>
          ))}
        </select>
        <span className="text-xs text-slate-500">الحالة: {arabicState(state)}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void call({ action: 'suppress', reason: 'operator request' }, 'تم الحظر')}
          className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-200 hover:bg-rose-500/20 disabled:opacity-50"
        >
          حظر (توقف نهائي)
        </button>
        <a
          className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-200 hover:border-emerald-400/60"
          href={`/api/leads?export=${leadId}`}
          target="_blank"
          rel="noreferrer"
        >
          تصدير (18-07)
        </a>
        <button
          type="button"
          disabled={busy}
          onClick={() => void call({ action: 'purge' }, 'تم الحذف')}
          className="rounded border border-slate-700 bg-slate-800/60 px-2 py-1 text-xs text-slate-300 hover:border-rose-400/60 disabled:opacity-50"
        >
          حذف (محو البيانات)
        </button>
      </div>
      <input
        className="w-full rounded border border-slate-700 bg-slate-800/60 px-2 py-1 text-xs text-slate-200"
        placeholder="ملاحظة على النتيجة (اختياري)"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="w-28 rounded border border-slate-700 bg-slate-800/60 px-2 py-1 text-xs text-slate-200"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <input
          className="flex-1 rounded border border-slate-700 bg-slate-800/60 px-2 py-1 text-xs text-slate-200"
          placeholder="قيمة التعليق التوضيحي"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          type="button"
          disabled={busy || value.length === 0}
          onClick={() => void call({ action: 'annotate', key, value }, 'تم التعليق')}
          className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-200 hover:border-emerald-400/60 disabled:opacity-50"
        >
          علّق
        </button>
      </div>
      {result ? <p className="text-xs text-emerald-300">{result}</p> : null}
    </div>
  );
}
