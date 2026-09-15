import { LayoutDashboard, ArrowLeftRight, Gauge, Sparkles, TrendingUp, ArrowUpRight } from 'lucide-react';

// Pure-CSS/SVG dashboard mock for the hero — no external image, so it is fast,
// crisp at any resolution, and never causes layout shift (good Core Web Vitals).
const KPIS = [
  { label: 'Revenue', value: '$1.84M', delta: '+12.4%' },
  { label: 'Expenses', value: '$612K', delta: '+3.1%' },
  { label: 'Net cash flow', value: '$1.23M', delta: '+18.9%' },
  { label: 'Current ratio', value: '2.41', delta: '+0.12' },
];

const NAV = [
  { icon: LayoutDashboard, label: 'Dashboard', active: true },
  { icon: ArrowLeftRight, label: 'Transactions' },
  { icon: Gauge, label: 'Ratios' },
  { icon: Sparkles, label: 'AI Analytics' },
];

export default function ProductMock() {
  return (
    <div className="browser-frame mx-auto max-w-5xl">
      {/* Title bar */}
      <div className="flex items-center gap-2 border-b border-navy-100 bg-navy-50/70 px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-red-400" />
        <span className="h-3 w-3 rounded-full bg-amber-400" />
        <span className="h-3 w-3 rounded-full bg-green-400" />
        <div className="ml-3 hidden flex-1 sm:block">
          <div className="mx-auto w-64 rounded-md bg-white px-3 py-1 text-center text-xs text-navy-400 shadow-soft">
            app.oremusai.com/dashboard
          </div>
        </div>
      </div>

      <div className="grid grid-cols-12">
        {/* Sidebar */}
        <aside className="col-span-3 hidden flex-col gap-1 border-r border-navy-100 bg-white p-4 sm:flex">
          {NAV.map((n) => (
            <div
              key={n.label}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium ${
                n.active ? 'nav-item-active text-brand-700' : 'text-navy-500'
              }`}
            >
              <n.icon size={15} />
              {n.label}
            </div>
          ))}
        </aside>

        {/* Body */}
        <div className="col-span-12 bg-navy-50/40 p-4 sm:col-span-9 sm:p-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {KPIS.map((k) => (
              <div key={k.label} className="rounded-xl border border-navy-100 bg-white p-3 shadow-soft">
                <p className="text-[11px] font-medium text-navy-400">{k.label}</p>
                <p className="mt-1 text-lg font-bold tracking-tight text-navy-900">{k.value}</p>
                <p className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-semibold text-green-600">
                  <ArrowUpRight size={11} /> {k.delta}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <div className="rounded-xl border border-navy-100 bg-white p-4 shadow-soft lg:col-span-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-navy-700">Revenue trend</p>
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-600">
                  <TrendingUp size={12} /> Last 12 months
                </span>
              </div>
              <svg viewBox="0 0 320 110" className="mt-3 h-28 w-full" preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <linearGradient id="mockArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2563EB" stopOpacity="0.28" />
                    <stop offset="100%" stopColor="#2563EB" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path
                  d="M0,86 L29,78 L58,82 L87,64 L116,70 L145,52 L174,58 L203,40 L232,46 L261,28 L290,34 L320,16"
                  fill="none" stroke="#2563EB" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                />
                <path
                  d="M0,86 L29,78 L58,82 L87,64 L116,70 L145,52 L174,58 L203,40 L232,46 L261,28 L290,34 L320,16 L320,110 L0,110 Z"
                  fill="url(#mockArea)"
                />
              </svg>
            </div>
            <div className="rounded-xl border border-navy-100 bg-white p-4 shadow-soft">
              <p className="text-xs font-semibold text-navy-700">Expense mix</p>
              <div className="mt-4 flex flex-col gap-2.5">
                {[
                  { l: 'Payroll', w: '64%', c: 'bg-brand-500' },
                  { l: 'Software', w: '22%', c: 'bg-cyan-500' },
                  { l: 'Office', w: '38%', c: 'bg-brand-300' },
                  { l: 'Travel', w: '14%', c: 'bg-navy-300' },
                ].map((b) => (
                  <div key={b.l}>
                    <div className="flex justify-between text-[11px] text-navy-500"><span>{b.l}</span><span>{b.w}</span></div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-navy-100">
                      <div className={`h-full rounded-full ${b.c}`} style={{ width: b.w }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
