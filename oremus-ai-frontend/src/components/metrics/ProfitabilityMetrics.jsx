import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, BarChart2, Percent } from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';
import axiosClient from '../../services/axiosClient.js';
import MetricSection, { MiniKpi, fmtINR, fmtFull, AXIS_STYLE, SectionSkeleton, SectionError } from './MetricSection.jsx';

// Build floating-bar waterfall steps. Each step draws from `a` to `b`:
// base = min(a,b) (transparent), delta = |b-a| (colored).
function waterfall(pl) {
  const { revenue = 0, cogs = 0, grossProfit = 0, opex = 0, operatingProfit = 0, netProfit = 0 } = pl;
  const seg = (name, a, b, color, isTotal) => ({
    name, base: Math.min(a, b), delta: Math.abs(b - a), color, isTotal,
    tip: isTotal ? b : b - a, // total → level; delta → signed change
  });
  return [
    seg('Revenue',   0, revenue,          '#2563EB', true),
    seg('− COGS',    revenue, grossProfit, '#EF4444', false),
    seg('Gross',     0, grossProfit,       '#06B6D4', true),
    seg('− OpEx',    grossProfit, operatingProfit, '#EF4444', false),
    seg('Operating', 0, operatingProfit,   '#8B5CF6', true),
    seg('− Int/Tax', operatingProfit, netProfit, '#EF4444', false),
    seg('Net',       0, netProfit,         netProfit >= 0 ? '#10B981' : '#EF4444', true),
  ];
}

export default function ProfitabilityMetrics({ from, to, basis, customer, currency }) {
  const [m, setM] = useState(null);       // /metrics/profitability
  const [trend, setTrend] = useState([]);  // 12-mo trend (unchanged endpoint)
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setM(null); setTrend([]);   // show skeleton while the new period loads
    const params = {
      from, to,
      ...(basis ? { basis } : {}),
      ...(customer ? { customer_id: customer } : {}),
      ...(currency ? { currency_id: currency } : {}),
    };
    Promise.all([
      axiosClient.get('/metrics/profitability', { params }),
      axiosClient.get('/dashboard/profitability', { params: { from, to, ...(basis ? { basis } : {}) } }),
    ]).then(([mRes, tRes]) => {
      if (cancelled) return;
      setM(mRes.data?.data || {});
      setTrend(tRes.data?.data?.trend || []);
    }).catch((e) => { if (!cancelled) setError(e?.response?.data?.error || e.message || 'Failed to load'); });
    return () => { cancelled = true; };
  }, [from, to, basis, customer, currency, attempt]);

  if (error) return <SectionError message={error} onRetry={() => setAttempt(a => a + 1)} />;
  if (!m) return <SectionSkeleton />;

  const gm = m.grossMargin, om = m.operatingMargin, nm = m.netMargin;
  const netProfit = m.netProfit ?? 0;
  const ebitdaMargin = m.ebitdaMargin;

  const badge = {
    text: nm != null ? `Net margin ${nm}%` : 'Margin data',
    color: nm != null && nm > 15 ? '#10B981' : nm != null && nm > 0 ? '#F59E0B' : '#EF4444',
  };

  const wf = waterfall(m);

  return (
    <MetricSection num={2} title="Profitability Metrics" subtitle="Margins at every layer of the P&L" badge={badge}>
      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <MiniKpi label="Gross Margin"     value={gm == null ? '—' : `${gm}%`} sub={fmtFull(m.grossProfit ?? 0)}     color="#2563EB" icon={Percent} isText />
        <MiniKpi label="Operating Margin" value={om == null ? '—' : `${om}%`} sub={fmtFull(m.operatingProfit ?? 0)} color="#06B6D4" icon={Percent} isText />
        <MiniKpi label="EBITDA"           value={m.ebitda ?? 0} sub={ebitdaMargin == null ? 'margin —' : `${ebitdaMargin}% margin`} color="#8B5CF6" icon={BarChart2} />
        <MiniKpi label="Net Margin"       value={nm == null ? '—' : `${nm}%`} sub={fmtFull(netProfit)} color={netProfit >= 0 ? '#10B981' : '#EF4444'} icon={netProfit >= 0 ? TrendingUp : TrendingDown} isText />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Net profit trend */}
        <div className="lg:col-span-3">
          <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2">
            Net Profit Trend · 12 months
          </div>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.07} vertical={false} />
                <XAxis dataKey="month" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} tickFormatter={v => fmtINR(v)} width={55} />
                <Tooltip formatter={(v, n) => [fmtFull(v), n === 'revenue' ? 'Revenue' : n === 'expenses' ? 'Expenses' : 'Net Profit']}
                  contentStyle={{ borderRadius: 8, border: '1px solid rgba(100,116,139,.2)', fontSize: 12 }} />
                <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.2} />
                <Line isAnimationActive={false} type="linear" dataKey="revenue"   stroke="#2563EB" strokeWidth={2} dot={{ r: 3, fill: '#2563EB', strokeWidth: 0 }} activeDot={{ r: 5, strokeWidth: 0 }} />
                <Line isAnimationActive={false} type="linear" dataKey="expenses"  stroke="#EF4444" strokeWidth={2} dot={{ r: 3, fill: '#EF4444', strokeWidth: 0 }} activeDot={{ r: 5, strokeWidth: 0 }} />
                <Line isAnimationActive={false} type="linear" dataKey="netProfit" stroke="#10B981" strokeWidth={2} strokeDasharray="6 4" dot={{ r: 3, fill: '#10B981', strokeWidth: 0 }} activeDot={{ r: 5, strokeWidth: 0 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-4 mt-1.5 justify-center">
            {[['#2563EB','Revenue'],['#EF4444','Expenses'],['#10B981','Net Profit']].map(([c,l]) => (
              <div key={l} className="flex items-center gap-1.5 text-[10px] text-navy-500">
                <div className="w-3 h-0.5 rounded" style={{ background: c }} />
                {l}
              </div>
            ))}
          </div>
        </div>

        {/* P&L waterfall */}
        <div className="lg:col-span-2">
          <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2">
            P&amp;L Waterfall
          </div>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={wf} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.07} vertical={false} />
                <XAxis dataKey="name" tick={{ ...AXIS_STYLE, fontSize: 8 }} interval={0} axisLine={false} tickLine={false} angle={-30} textAnchor="end" height={42} />
                <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} tickFormatter={v => fmtINR(v)} width={55} />
                <Tooltip formatter={(v, n, p) => [fmtFull(p?.payload?.tip), p?.payload?.name]}
                  contentStyle={{ borderRadius: 8, border: '1px solid rgba(100,116,139,.2)', fontSize: 12 }} />
                <Bar isAnimationActive={false} dataKey="base" stackId="w" fill="transparent" />
                <Bar isAnimationActive={false} dataKey="delta" stackId="w" radius={[2, 2, 0, 0]}>
                  {wf.map((s, i) => <Cell key={i} fill={s.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </MetricSection>
  );
}
