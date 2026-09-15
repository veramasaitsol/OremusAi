import {
  LayoutDashboard, ArrowLeftRight, Gauge, Sparkles, Users, Search,
  TrendingUp, ArrowUpRight, Lightbulb, AlertTriangle,
} from 'lucide-react';
import Frame from './Frame.jsx';

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
  { icon: Users, label: 'Clients' },
];

const TABS = ['Overview', '01 Revenue', '02 Profitability', '03 Cash Flow'];

const INSIGHTS = [
  { icon: TrendingUp, tone: 'text-emerald-600 bg-emerald-50', tag: 'Trend', title: 'Revenue up 12.4% MoM', body: 'Driven by 3 new enterprise accounts.' },
  { icon: AlertTriangle, tone: 'text-amber-600 bg-amber-50', tag: 'Anomaly', title: 'Duplicate vendor bill flagged', body: '$48k bill matches an earlier entry.' },
  { icon: Lightbulb, tone: 'text-brand-600 bg-brand-50', tag: 'Tip', title: 'AR aging improving', body: 'DSO down 6 days vs last quarter.' },
];

export default function DashboardMock() {
  return (
    <Frame url="app.oremusai.com/dashboard">
      <div className="grid grid-cols-12">
        <aside className="col-span-3 hidden flex-col gap-1 border-r border-navy-100 bg-white p-4 lg:flex">
          <div className="mb-3 flex items-center gap-2 px-1">
            <span className="h-6 w-6 rounded-md bg-gradient-to-br from-brand-500 to-cyan-500" />
            <span className="text-xs font-bold text-navy-900">Oremus AI</span>
          </div>
          {NAV.map((n) => (
            <div key={n.label} className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium ${n.active ? 'nav-item-active text-brand-700' : 'text-navy-500'}`}>
              <n.icon size={15} /> {n.label}
            </div>
          ))}
        </aside>

        <div className="col-span-12 bg-navy-50/40 p-4 lg:col-span-9 lg:p-5">
          {/* top bar: search + Ask Oremus AI + tabs */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2 rounded-lg border border-navy-200 bg-white px-2.5 py-1.5 text-[11px] text-navy-400">
                <Search size={12} /> Search…
              </div>
              <div className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-brand-500 to-cyan-500 px-2.5 py-1.5 text-[11px] font-semibold text-white shadow-glow">
                <Sparkles size={12} /> Ask Oremus AI
              </div>
            </div>
            <div className="hidden items-center gap-1 sm:flex">
              {TABS.map((t, i) => (
                <span key={t} className={`rounded-md px-2 py-1 text-[10px] font-semibold ${i === 0 ? 'bg-navy-900 text-white' : 'text-navy-400'}`}>{t}</span>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {KPIS.map((k) => (
              <div key={k.label} className="rounded-xl border border-navy-100 bg-white p-3 shadow-soft">
                <p className="text-[11px] font-medium text-navy-400">{k.label}</p>
                <p className="mt-1 text-base font-bold tracking-tight text-navy-900">{k.value}</p>
                <p className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-semibold text-green-600"><ArrowUpRight size={11} /> {k.delta}</p>
              </div>
            ))}
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <div className="rounded-xl border border-navy-100 bg-white p-4 shadow-soft lg:col-span-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-navy-700">Revenue trend</p>
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-600"><TrendingUp size={12} /> Last 12 months</span>
              </div>
              <svg viewBox="0 0 320 96" className="mt-3 h-24 w-full" preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <linearGradient id="dashArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2563EB" stopOpacity="0.28" />
                    <stop offset="100%" stopColor="#2563EB" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d="M0,76 L29,68 L58,72 L87,54 L116,60 L145,42 L174,48 L203,32 L232,38 L261,22 L290,28 L320,12" fill="none" stroke="#2563EB" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M0,76 L29,68 L58,72 L87,54 L116,60 L145,42 L174,48 L203,32 L232,38 L261,22 L290,28 L320,12 L320,96 L0,96 Z" fill="url(#dashArea)" />
              </svg>
            </div>

            {/* AI insights card */}
            <div className="rounded-xl border border-navy-100 bg-white p-3 shadow-soft">
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-brand-500 to-cyan-500 text-white"><Sparkles size={12} /></span>
                <div>
                  <p className="text-[11px] font-bold text-navy-900">Oremus AI</p>
                  <p className="text-[9px] text-navy-400">3 insights this period</p>
                </div>
              </div>
              <div className="space-y-2">
                {INSIGHTS.map((ins) => (
                  <div key={ins.title} className="rounded-lg border border-navy-100 bg-navy-50/50 p-2">
                    <div className="flex items-start gap-1.5">
                      <span className={`flex h-5 w-5 items-center justify-center rounded ${ins.tone}`}><ins.icon size={10} /></span>
                      <div>
                        <p className="text-[10.5px] font-semibold leading-tight text-navy-900">{ins.title}</p>
                        <p className="mt-0.5 text-[9.5px] leading-snug text-navy-500">{ins.body}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
