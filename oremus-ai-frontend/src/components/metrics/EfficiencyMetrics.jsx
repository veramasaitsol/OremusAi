import { useEffect, useState } from 'react';
import { Clock, Calendar, Percent, RefreshCw, ReceiptText } from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import axiosClient from '../../services/axiosClient.js';
import MetricSection, { MiniKpi, fmtFull, AXIS_STYLE, SectionSkeleton, SectionError } from './MetricSection.jsx';

// Ageing bucket presentation (shared by AR & AP ageing).
const BUCKET_ORDER  = ['not_due', '0_30', '31_60', '61_90', 'over_90'];
const BUCKET_LABELS = { not_due: 'Not due', '0_30': '1–30d', '31_60': '31–60d', '61_90': '61–90d', over_90: '90+d' };
const BUCKET_COLORS = { not_due: '#10B981', '0_30': '#F59E0B', '31_60': '#F97316', '61_90': '#EF4444', over_90: '#991B1B' };

function AgeingPanel({ title, rows }) {
  const byBucket = Object.fromEntries((rows || []).map(r => [r.bucket, r]));
  const total = (rows || []).reduce((s, r) => s + (r.amount || 0), 0);
  return (
    <div className="rounded-xl border border-navy-100 dark:border-navy-800 bg-navy-50/50 dark:bg-navy-800/50 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider">{title}</div>
        <div className="text-[12px] font-bold text-navy-900 dark:text-white tabular-nums">{fmtFull(total)}</div>
      </div>
      {total === 0 ? (
        <div className="text-[12px] text-navy-400 py-4 text-center">Nothing outstanding</div>
      ) : (
        <div className="space-y-2">
          {BUCKET_ORDER.map(bk => {
            const r = byBucket[bk];
            const amount = r?.amount || 0;
            const color = BUCKET_COLORS[bk];
            return (
              <div key={bk} className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between mb-1">
                    <span className="text-[11.5px] font-medium text-navy-700 dark:text-navy-200">{BUCKET_LABELS[bk]}</span>
                    <div className="flex items-center gap-2">
                      {r?.count != null && <span className="text-[10px] text-navy-400">{r.count}</span>}
                      <span className="text-[11.5px] font-bold text-navy-900 dark:text-white">{fmtFull(amount)}</span>
                    </div>
                  </div>
                  <div className="h-1.5 rounded-full bg-navy-100 dark:bg-navy-700 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(amount / total) * 100}%`, background: color }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function EfficiencyMetrics({ from, to }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setData(null);   // show skeleton while the new period loads
    axiosClient.get('/dashboard/efficiency', { params: { from, to } })
      .then(r => { if (!cancelled) setData(r.data.data); })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.error || e.message || 'Failed to load'); });
    return () => { cancelled = true; };
  }, [from, to, attempt]);

  if (error) return <SectionError message={error} onRetry={() => setAttempt(a => a + 1)} />;
  if (!data) return <SectionSkeleton />;

  const arDays = data.arDays || 0;
  const apDays = data.apDays || 0;
  const ccc    = data.ccc ?? (arDays - apDays);

  const badge = {
    text: `CCC ${ccc} days · ${arDays}d AR / ${apDays}d AP`,
    color: ccc <= 0 ? '#10B981' : '#06B6D4',
  };

  const trend = data.trend || [];

  return (
    <MetricSection num={6} title="Efficiency Metrics" subtitle="How well the business collects, pays and converts assets" badge={badge}>
      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
        <MiniKpi label="AR Days"  value={`${arDays} days`} sub="collect receivables" color="#10B981" icon={Clock} isText />
        <MiniKpi label="AP Days"  value={`${apDays} days`} sub="pay vendors"          color="#F59E0B" icon={Calendar} isText />
        <MiniKpi label="Cash Conversion" value={`${ccc} days`} sub="DSO − DPO" color="#06B6D4" icon={RefreshCw} isText />
        <MiniKpi label="Return on Equity" value={data.roe == null ? '—' : `${data.roe}%`} sub="net profit ÷ equity" color="#8B5CF6" icon={Percent} isText />
        <MiniKpi label="Cost to Income"  value={data.costToIncome == null ? '—' : `${data.costToIncome}%`} sub="expenses ÷ revenue" color="#2563EB" icon={Percent} isText />
        <MiniKpi label="Total Payables"  value={data.payables || 0} sub="outstanding AP" color="#EF4444" icon={ReceiptText} />
      </div>

      {/* AR vs AP days — efficiency trend */}
      <div className="mb-5">
        <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2">
          AR vs AP Days · Efficiency Trend
        </div>
        {trend.length === 0 ? (
          <div className="h-[200px] flex items-center justify-center text-[12px] text-navy-400 text-center px-3">
            Trend unavailable
          </div>
        ) : (
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trend} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.07} vertical={false} />
                <XAxis dataKey="month" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} tickFormatter={v => `${v}d`} width={44} />
                <Tooltip formatter={(v, n) => [`${v} days`, n === 'arDays' ? 'AR days' : 'AP days']}
                  contentStyle={{ borderRadius: 8, border: '1px solid rgba(100,116,139,.2)', fontSize: 12 }} />
                <Line isAnimationActive={false} type="linear" dataKey="arDays" stroke="#10B981" strokeWidth={2} dot={{ r: 3, fill: '#10B981', strokeWidth: 0 }} activeDot={{ r: 5, strokeWidth: 0 }} />
                <Line isAnimationActive={false} type="linear" dataKey="apDays" stroke="#F59E0B" strokeWidth={2} dot={{ r: 3, fill: '#F59E0B', strokeWidth: 0 }} activeDot={{ r: 5, strokeWidth: 0 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="flex items-center gap-4 mt-1.5 justify-center">
          {[['#10B981', 'AR days'], ['#F59E0B', 'AP days']].map(([c, l]) => (
            <div key={l} className="flex items-center gap-1.5 text-[10px] text-navy-500">
              <div className="w-3 h-2 rounded-sm" style={{ background: c }} />{l}
            </div>
          ))}
        </div>
        <div className="text-[10px] text-navy-400 mt-1 text-center">
          Cohort by issue month · settlement proxied to due date where payment date is unavailable.
        </div>
      </div>

      {/* AR & AP ageing */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <AgeingPanel title="AR Ageing · receivables" rows={data.arAging} />
        <AgeingPanel title="AP Ageing · payables" rows={data.apAging} />
      </div>

      {/* Insight callout */}
      {arDays > 0 && apDays > 0 && (
        <div className={`rounded-xl p-3.5 text-[12px] border ${
          arDays <= apDays
            ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20 text-emerald-700 dark:text-emerald-300'
            : 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20 text-amber-700 dark:text-amber-300'
        }`}>
          {arDays <= apDays
            ? `✓ Cash cycle is positive — you collect in ${arDays}d but pay suppliers in ${apDays}d, giving you a ${apDays - arDays}d float.`
            : `⚠ Cash cycle gap — you collect in ${arDays}d but pay suppliers in ${apDays}d. Aim to reduce AR below AP days.`
          }
        </div>
      )}
    </MetricSection>
  );
}
