import { useEffect, useState } from 'react';
import { TrendingUp, Repeat, PlusCircle, Package, UserMinus, MapPin } from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import axiosClient from '../../services/axiosClient.js';
import MetricSection, { MiniKpi, fmtINR, fmtFull, AXIS_STYLE, SectionSkeleton, SectionError } from './MetricSection.jsx';

const DONUT = ['#2563EB', '#94a3b8'];
const GEO_COLORS = ['#2563EB', '#06B6D4', '#8B5CF6', '#10B981', '#F59E0B', '#F97316', '#EF4444', '#64748b', '#0EA5E9'];

export default function RevenueMetrics({ from, to, customer, currency }) {
  const [m, setM] = useState(null);      // /metrics/revenue (headline + breakdowns)
  const [trend, setTrend] = useState([]); // 12-mo trend (warehouse, unchanged endpoint)
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setM(null); setTrend([]);   // show skeleton while the new period loads
    const params = {
      from, to,
      ...(customer ? { customer_id: customer } : {}),
      ...(currency ? { currency_id: currency } : {}),
    };
    Promise.all([
      axiosClient.get('/metrics/revenue', { params }),
      axiosClient.get('/dashboard/profitability', { params: { from, to } }),
    ]).then(([mRes, tRes]) => {
      if (cancelled) return;
      setM(mRes.data?.data || {});
      setTrend(tRes.data?.data?.trend || []);
    }).catch((e) => { if (!cancelled) setError(e?.response?.data?.error || e.message || 'Failed to load'); });
    return () => { cancelled = true; };
  }, [from, to, customer, currency, attempt]);

  if (error) return <SectionError message={error} onRetry={() => setAttempt(a => a + 1)} />;
  if (!m) return <SectionSkeleton />;

  const revenue     = m.revenue ?? 0;
  const growthPct   = m.growth?.growthPct;
  const recurringPct = m.recurring?.recurringPct;
  const churnRate   = m.churn?.churnRate;
  const byProduct   = m.byProduct || [];
  const byGeography = m.byGeography || [];
  const recurringData = [
    { name: 'Recurring', value: m.recurring?.recurring || 0 },
    { name: 'One-time',  value: m.recurring?.oneTime  || 0 },
  ];
  const hasRecurring = (m.recurring?.total || 0) > 0;

  const badge = revenue > 0
    ? { text: `${fmtFull(revenue)} total`, color: '#2563EB' }
    : { text: 'No revenue data', color: '#64748b' };

  return (
    <MetricSection num={1} title="Revenue Metrics" subtitle="Top-line performance · mix · momentum" badge={badge}>
      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
        <MiniKpi label="Total Revenue"  value={revenue}  sub="this period" color="#2563EB" icon={TrendingUp} />
        <MiniKpi label="Revenue Growth" value={growthPct == null ? '—' : `${growthPct}%`} sub="vs prior period" delta={growthPct ?? undefined} color="#10B981" icon={TrendingUp} isText />
        <MiniKpi label="Recurring"      value={recurringPct == null ? '—' : `${recurringPct}%`} sub="of revenue" color="#8B5CF6" icon={Repeat} isText />
        <MiniKpi label="Churn Rate"     value={churnRate == null ? '—' : `${churnRate}%`} sub="customers lapsed" color="#EF4444" icon={UserMinus} isText />
        <MiniKpi label="Other Income"   value={m.otherIncome ?? 0} sub="non-operating" color="#F59E0B" icon={PlusCircle} />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Area chart — revenue trend */}
        <div className="lg:col-span-3">
          <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2">
            Revenue Monthly
          </div>
          <div className="h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="rm-rev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#2563EB" stopOpacity={0.18} />
                    <stop offset="95%" stopColor="#2563EB" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.07} vertical={false} />
                <XAxis dataKey="month" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} tickFormatter={v => fmtINR(v)} width={55} />
                <Tooltip formatter={(v, n) => [fmtFull(v), n === 'revenue' ? 'Revenue' : 'Expenses']}
                  contentStyle={{ borderRadius: 8, border: '1px solid rgba(100,116,139,.2)', fontSize: 12 }} />
                <Area isAnimationActive={false} type="linear" dataKey="revenue" stroke="#2563EB" strokeWidth={2} fill="url(#rm-rev)" dot={{ r: 3, fill: '#2563EB', strokeWidth: 0 }} activeDot={{ r: 5, strokeWidth: 0 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Recurring vs one-time donut */}
        <div className="lg:col-span-2">
          <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2">
            Recurring vs One-time
          </div>
          {!hasRecurring ? (
            <div className="h-[180px] flex items-center justify-center text-[12px] text-navy-400">No invoice data</div>
          ) : (
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie isAnimationActive={false} data={recurringData} dataKey="value" nameKey="name" innerRadius={42} outerRadius={70} paddingAngle={2}>
                    {recurringData.map((_, i) => <Cell key={i} fill={DONUT[i % DONUT.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v, n) => [fmtFull(v), n]}
                    contentStyle={{ borderRadius: 8, border: '1px solid rgba(100,116,139,.2)', fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="flex items-center gap-4 mt-1.5 justify-center">
            {[['#2563EB','Recurring'],['#94a3b8','One-time']].map(([c,l]) => (
              <div key={l} className="flex items-center gap-1.5 text-[10px] text-navy-500">
                <div className="w-3 h-2 rounded-sm" style={{ background: c }} />{l}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Revenue by product / service + by geography */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Product / service */}
        <div>
          <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Package size={12} /> Revenue by Product / Service
          </div>
          {byProduct.length === 0 ? (
            <div className="h-[180px] flex items-center justify-center text-[12px] text-navy-400">No product breakdown for this provider</div>
          ) : (
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byProduct} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.07} horizontal={false} />
                  <XAxis type="number" tick={AXIS_STYLE} axisLine={false} tickLine={false} tickFormatter={v => fmtINR(v)} />
                  <YAxis type="category" dataKey="name" tick={{ ...AXIS_STYLE, fontSize: 9 }} axisLine={false} tickLine={false} width={90} />
                  <Tooltip formatter={v => [fmtFull(v), 'Revenue']}
                    contentStyle={{ borderRadius: 8, border: '1px solid rgba(100,116,139,.2)', fontSize: 12 }} />
                  <Bar isAnimationActive={false} dataKey="amount" fill="#2563EB" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Geography */}
        <div>
          <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <MapPin size={12} /> Revenue by Geography
          </div>
          {byGeography.length === 0 ? (
            <div className="h-[180px] flex items-center justify-center text-[12px] text-navy-400 text-center px-3">No geography breakdown for this provider</div>
          ) : (
            <div className="h-[180px] flex items-center">
              <div className="w-1/2 h-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie isAnimationActive={false} data={byGeography} dataKey="amount" nameKey="name" innerRadius={36} outerRadius={66} paddingAngle={2}>
                      {byGeography.map((_, i) => <Cell key={i} fill={GEO_COLORS[i % GEO_COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v, n) => [fmtFull(v), n]}
                      contentStyle={{ borderRadius: 8, border: '1px solid rgba(100,116,139,.2)', fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="w-1/2 pl-2 space-y-1 overflow-y-auto max-h-full">
                {byGeography.map((g, i) => (
                  <div key={g.name} className="flex items-center gap-1.5 text-[10.5px]">
                    <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: GEO_COLORS[i % GEO_COLORS.length] }} />
                    <span className="text-navy-600 dark:text-navy-300 truncate flex-1">{g.name}</span>
                    <span className="font-semibold text-navy-800 dark:text-navy-100">{fmtINR(g.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </MetricSection>
  );
}
