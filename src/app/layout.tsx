import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'صياد الزبائن — لوحة ORDELY',
  description: 'لوحة المشغّل لمحرّك صياد الزبائن (لا يوجد إرسال تلقائي أبداً — أنت ترسل بنفسك)',
};

const navigation = [
  { href: '/', label: 'الرئيسية' },
  { href: '/queue', label: 'طابور اليوم' },
  { href: '/leads', label: 'التجّار' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        <header className="border-b border-slate-800 bg-slate-900/60">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-6 py-4">
            <div className="ml-auto">
              <p className="text-lg font-bold tracking-tight">
                صياد الزبائن <span className="text-emerald-400">ORDELY</span>
              </p>
              <p className="text-xs text-slate-400">
                المحرّك يجهّز كل شيء · وأنت ترسل كل رسالة بنفسك · لا توجد أي أتمتة للإرسال
              </p>
            </div>
            <nav className="flex gap-2 text-sm">
              {navigation.map((entry) => (
                <Link
                  key={entry.href}
                  href={entry.href}
                  className="rounded-lg border border-slate-700 px-4 py-1.5 font-medium text-slate-200 transition hover:border-emerald-400/60 hover:text-white"
                >
                  {entry.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
        <footer className="mx-auto max-w-7xl px-6 pb-10 pt-4 text-xs text-slate-500">
          قواعد لا تقبل المساومة: لا إرسال تلقائي أبداً، احترام robots.txt، هوية User-Agent صادقة،
          الحظر = توقف نهائي، بيانات مهنية عامة فقط (القانون 18-07).
        </footer>
      </body>
    </html>
  );
}
