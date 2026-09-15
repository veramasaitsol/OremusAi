import { useEffect, useState, useCallback } from 'react';
import { X, TrendingUp, TrendingDown, Wallet, ReceiptText, Building2, Clock, AlertTriangle, BarChart2 } from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, LineChart, Line,
} from 'recharts';
import axiosClient from '../../services/axiosClient.js';
import { fmt, fmtMoneyCompact } from '../../utils/fmt.js';

const AXIS = { fontSize: 10, fill: '#94a3b8', fillOpacity: 1 };

// Full grouped value (e.g. ₹32,90,000) for displayed amounts, totals & tooltips.
function fmtINR(n) {
  if (n == null || isNaN(n)) return fmt(0);
  return fmt(n);
}

// Compact value (₹/k/L/Cr) used only on the narrow chart Y-axis ticks so the
// axis stays readable; full values would overflow.
function fmtAxis(n) {
  if (n == null || isNaN(n)) return fmtMoneyCompact(0);
  return fmtMoneyCompact(n);
}

function Skeleton({ className = '' }) {
  return <div className={`animate-pulse rounded-lg bg-navy-100 dark:bg-navy-800 ${className}`} />;
}

// Honest failure state — an API error renders as an explicit error + Retry
// instead of a modal full of ₹0s that look like real data.
function DetailError({ message, onRetry }) {
  return (
    <div className="rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 p-5 text-center">
      <AlertTriangle size={18} className="mx-auto mb-2 text-red-500" />
      <div className="text-[12.5px] font-semibold text-red-700 dark:text-red-300 mb-1">Could not load this detail</div>
      {message && <div className="text-[11.5px] text-red-600 dark:text-red-400/80 mb-3 break-words">{message}</div>}
      <button
        onClick={onRetry}
        className="h-8 px-3 rounded-lg bg-red-600 hover:bg-red-700 text-white text-[12px] font-semibold transition"
      >Retry</button>
    </div>
  );
}

// ── Revenue detail ───────────────────────────────────────────────────────────
function RevenueDetail({ from, to }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(null);
    axiosClient.get('/dashboard/kpi/revenue', { params: { from, to } })
      .then(r => setData(r.data.data))
      .catch((e) => setError(e?.response?.data?.error || e.message || 'Failed to load'));
  }, [from, to, attempt]);

  if (error) return <DetailError message={error} onRetry={() => setAttempt(a => a + 1)} />;
  if (!data) return <div className="space-y-3"><Skeleton className="h-32" /><Skeleton className="h-48" /></div>;

  const growth = data.growth ?? 0;
  return (
    <div className="space-y-5">
      {/* Summary row */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'This Period', value: fmtINR(data.current), color: '#2563EB' },
          { label: 'Prior Period', value: fmtINR(data.prior), color: '#64748b' },
          { label: 'Growth', value: `${growth >= 0 ? '+' : ''}${growth?.toFixed(1)}%`, color: growth >= 0 ? '#10B981' : '#EF4444' },
        ].map(k => (
          <div key={k.label} className="rounded-xl bg-navy-50 dark:bg-navy-800 p-2.5 text-center min-w-0">
            <div className="text-[9px] uppercase tracking-wider text-navy-500 mb-1 truncate">{k.label}</div>
            <div className="text-[13px] font-bold tabular-nums leading-tight tracking-tight break-words" style={{ color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Trend chart */}
      <div>
        <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2">Monthly Revenue · Last 12 months</div>
        <div className="h-[160px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.trend || []} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#2563EB" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#2563EB" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.07} vertical={false} />
              <XAxis dataKey="month" tick={AXIS} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} tickFormatter={v => fmtAxis(v)} width={50} />
              <Tooltip formatter={v => [fmtINR(v), 'Revenue']}
                contentStyle={{ borderRadius: 8, border: '1px solid rgba(100,116,139,.2)', fontSize: 12 }} />
              <Area isAnimationActive={false} type="linear" dataKey="revenue" stroke="#2563EB" strokeWidth={2} fill="url(#revGrad)" dot={{ r: 3, fill: '#2563EB', strokeWidth: 0 }} activeDot={{ r: 5, strokeWidth: 0 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Top customers */}
      {(data.topCustomers || []).length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2">Top Customers · This Period</div>
          <div className="space-y-2">
            {data.topCustomers.map((c, i) => {
              const maxAmt = data.topCustomers[0]?.amount || 1;
              return (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-5 text-[10px] text-navy-400 text-right">{i + 1}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between mb-1">
                      <span className="text-[12px] font-medium text-navy-800 dark:text-navy-100 truncate">{c.name}</span>
                      <span className="text-[12px] font-bold text-navy-900 dark:text-white ml-2">{fmtINR(c.amount)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-navy-100 dark:bg-navy-700 overflow-hidden">
                      <div className="h-full rounded-full bg-brand-500" style={{ width: `${(c.amount / maxAmt) * 100}%` }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Cash detail ──────────────────────────────────────────────────────────────
function CashDetail({ from, to }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(null);
    axiosClient.get('/dashboard/kpi/cash', { params: { from, to } })
      .then(r => setData(r.data.data))
      .catch((e) => setError(e?.response?.data?.error || e.message || 'Failed to load'));
  }, [from, to, attempt]);

  if (error) return <DetailError message={error} onRetry={() => setAttempt(a => a + 1)} />;
  if (!data) return <div className="space-y-3"><Skeleton className="h-32" /><Skeleton className="h-48" /></div>;

  return (
    <div className="space-y-5">
      {/* Total */}
      <div className="rounded-xl bg-violet-50 dark:bg-violet-500/10 p-4 text-center">
        <div className="text-[10px] uppercase tracking-widest text-violet-600 dark:text-violet-400 mb-1">Total Cash on Hand</div>
        <div className="text-[32px] font-bold text-violet-700 dark:text-violet-300">{fmtINR(data.total)}</div>
        <div className="text-[11px] text-navy-500 mt-1">across {(data.accounts || []).length} bank account{(data.accounts || []).length !== 1 ? 's' : ''}</div>
      </div>

      {/* Per-account breakdown */}
      {(data.accounts || []).length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2">By Account</div>
          <div className="space-y-2">
            {data.accounts.map((a, i) => {
              const total = data.total || 1;
              return (
                <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg bg-navy-50 dark:bg-navy-800">
                  <div className="w-7 h-7 rounded-lg bg-violet-100 dark:bg-violet-500/20 grid place-items-center flex-shrink-0">
                    <Building2 size={13} className="text-violet-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between mb-1">
                      <span className="text-[12px] font-medium text-navy-800 dark:text-navy-100 truncate">{a.name || 'Bank Account'}</span>
                      <span className="text-[12px] font-bold text-navy-900 dark:text-white ml-2">{fmtINR(a.balance)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-navy-100 dark:bg-navy-700 overflow-hidden">
                      <div className="h-full rounded-full bg-violet-500" style={{ width: `${Math.min(100, (a.balance / total) * 100)}%` }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Trend */}
      {(data.trend || []).length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2">Cash Flow · Last 12 Months</div>
          <div className="h-[150px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.trend} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.07} vertical={false} />
                <XAxis dataKey="month" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} tickFormatter={v => fmtAxis(v)} width={50} />
                <Tooltip formatter={(v, n) => [fmtINR(v), n === 'inflow' ? 'Inflow' : 'Outflow']}
                  contentStyle={{ borderRadius: 8, border: '1px solid rgba(100,116,139,.2)', fontSize: 12 }} />
                <Bar isAnimationActive={false} dataKey="inflow" fill="#10B981" radius={[2, 2, 0, 0]} />
                <Bar isAnimationActive={false} dataKey="outflow" fill="#EF4444" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Burn detail ──────────────────────────────────────────────────────────────
function BurnDetail({ from, to }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(null);
    axiosClient.get('/dashboard/kpi/burn', { params: { from, to } })
      .then(r => setData(r.data.data))
      .catch((e) => setError(e?.response?.data?.error || e.message || 'Failed to load'));
  }, [from, to, attempt]);

  if (error) return <DetailError message={error} onRetry={() => setAttempt(a => a + 1)} />;
  if (!data) return <div className="space-y-3"><Skeleton className="h-32" /><Skeleton className="h-48" /></div>;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Avg Monthly Burn', value: fmtINR(data.avgMonthlyBurn), color: '#EF4444' },
          { label: 'Cash on Hand', value: fmtINR(data.cashOnHand), color: '#8B5CF6' },
          { label: 'Runway', value: data.runwayMonths != null ? (data.runwayMonths >= 60 ? '60+ mo' : `${data.runwayMonths} mo`) : '—', color: '#F59E0B' },
        ].map(k => (
          <div key={k.label} className="rounded-xl bg-navy-50 dark:bg-navy-800 p-2.5 text-center min-w-0">
            <div className="text-[9px] uppercase tracking-wider text-navy-500 mb-1 truncate">{k.label}</div>
            <div className="text-[13px] font-bold tabular-nums leading-tight tracking-tight break-words" style={{ color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Monthly burn trend */}
      {(data.trend || []).length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2">Monthly Burn · Last 12 Months</div>
          <div className="h-[150px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.trend} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="burnGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#EF4444" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#EF4444" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.07} vertical={false} />
                <XAxis dataKey="month" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} tickFormatter={v => fmtAxis(v)} width={50} />
                <Tooltip formatter={v => [fmtINR(v), 'Expenses']}
                  contentStyle={{ borderRadius: 8, border: '1px solid rgba(100,116,139,.2)', fontSize: 12 }} />
                <Area isAnimationActive={false} type="linear" dataKey="expenses" stroke="#EF4444" strokeWidth={2} fill="url(#burnGrad)" dot={{ r: 3, fill: '#EF4444', strokeWidth: 0 }} activeDot={{ r: 5, strokeWidth: 0 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Top expense categories */}
      {(data.topCategories || []).length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2">Top Expense Categories</div>
          <div className="space-y-2">
            {data.topCategories.map((c, i) => {
              const max = data.topCategories[0]?.amount || 1;
              const COLORS = ['#EF4444', '#F59E0B', '#8B5CF6', '#06B6D4', '#10B981', '#64748b'];
              return (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between mb-1">
                      <span className="text-[12px] font-medium text-navy-700 dark:text-navy-200 truncate">{c.name}</span>
                      <span className="text-[12px] font-bold text-navy-900 dark:text-white ml-2">{fmtINR(c.amount)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-navy-100 dark:bg-navy-700 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${(c.amount / max) * 100}%`, background: COLORS[i % COLORS.length] }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Receivables detail ───────────────────────────────────────────────────────
function ReceivablesDetail() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(null);
    axiosClient.get('/dashboard/kpi/receivables')
      .then(r => setData(r.data.data))
      .catch((e) => setError(e?.response?.data?.error || e.message || 'Failed to load'));
  }, [attempt]);

  if (error) return <DetailError message={error} onRetry={() => setAttempt(a => a + 1)} />;
  if (!data) return <div className="space-y-3"><Skeleton className="h-32" /><Skeleton className="h-48" /></div>;

  const BUCKET_LABELS = { not_due: 'Not Due', '0_30': '1–30 days', '31_60': '31–60 days', '61_90': '61–90 days', over_90: '90+ days' };
  const BUCKET_COLORS = { not_due: '#10B981', '0_30': '#F59E0B', '31_60': '#F97316', '61_90': '#EF4444', over_90: '#991B1B' };
  const aging = data.aging || [];
  const total = data.total || 0;

  return (
    <div className="space-y-5">
      {/* Total */}
      <div className="rounded-xl bg-emerald-50 dark:bg-emerald-500/10 p-4 text-center">
        <div className="text-[10px] uppercase tracking-widest text-emerald-600 dark:text-emerald-400 mb-1">Total Outstanding Receivables</div>
        <div className="text-[32px] font-bold text-emerald-700 dark:text-emerald-300">{fmtINR(total)}</div>
      </div>

      {/* Aging buckets */}
      <div>
        <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2">Aging Analysis</div>
        <div className="space-y-2">
          {aging.map((b, i) => {
            const color = BUCKET_COLORS[b.bucket] || '#64748b';
            return (
              <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg bg-navy-50 dark:bg-navy-800">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between mb-1">
                    <span className="text-[12px] font-medium text-navy-700 dark:text-navy-200">{BUCKET_LABELS[b.bucket] || b.bucket}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10.5px] text-navy-400">{b.count} inv</span>
                      <span className="text-[12px] font-bold text-navy-900 dark:text-white">{fmtINR(b.amount)}</span>
                    </div>
                  </div>
                  {total > 0 && (
                    <div className="h-1.5 rounded-full bg-navy-100 dark:bg-navy-700 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${(b.amount / total) * 100}%`, background: color }} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Overdue customers */}
      {(data.overdueCustomers || []).length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <AlertTriangle size={12} className="text-amber-500" />
            <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider">Overdue Customers</div>
          </div>
          <div className="space-y-2">
            {data.overdueCustomers.map((c, i) => (
              <div key={i} className="flex items-center justify-between p-2.5 rounded-lg bg-red-50 dark:bg-red-500/10">
                <div>
                  <div className="text-[12px] font-medium text-navy-800 dark:text-navy-100">{c.name}</div>
                  <div className="text-[10.5px] text-navy-400">{c.invoices} invoice{c.invoices !== 1 ? 's' : ''} · {c.daysOverdue}d overdue</div>
                </div>
                <div className="text-[13px] font-bold text-red-600 dark:text-red-400">{fmtINR(c.amount)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── EBITDA detail ────────────────────────────────────────────────────────────
function EbitdaDetail({ from, to }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(null);
    axiosClient.get('/metrics/profitability', { params: { from, to } })
      .then(r => setData(r.data.data || {}))
      .catch((e) => setError(e?.response?.data?.error || e.message || 'Failed to load'));
  }, [from, to, attempt]);

  if (error) return <DetailError message={error} onRetry={() => setAttempt(a => a + 1)} />;
  if (!data) return <div className="space-y-3"><Skeleton className="h-32" /><Skeleton className="h-48" /></div>;

  const ebitda = data.ebitda ?? 0;
  const operatingProfit = data.operatingProfit ?? 0;
  const da = data.depreciation ?? 0;
  const margin = data.ebitdaMargin;
  // EBITDA = Operating Profit + D&A. Bridge bars are scaled to the largest
  // component so the visual proportions read correctly.
  const bridge = [
    { label: 'Operating Profit', amount: operatingProfit, color: '#8B5CF6' },
    { label: 'Depreciation & Amortization', amount: da, color: '#06B6D4' },
  ];
  const bridgeMax = Math.max(Math.abs(ebitda), ...bridge.map(b => Math.abs(b.amount)), 1);

  const margins = [
    { label: 'Gross Margin', value: data.grossMargin },
    { label: 'Operating Margin', value: data.operatingMargin },
    { label: 'Net Margin', value: data.netMargin },
  ];

  return (
    <div className="space-y-5">
      {/* Total */}
      <div className="rounded-xl bg-violet-50 dark:bg-violet-500/10 p-4 text-center">
        <div className="text-[10px] uppercase tracking-widest text-violet-600 dark:text-violet-400 mb-1">EBITDA · This Period</div>
        <div className="text-[32px] font-bold text-violet-700 dark:text-violet-300">{fmtINR(ebitda)}</div>
        <div className="text-[11px] text-navy-500 mt-1">{margin == null ? 'margin —' : `${margin}% EBITDA margin`}</div>
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Operating Profit', value: fmtINR(operatingProfit), color: '#8B5CF6' },
          { label: 'D&A', value: fmtINR(da), color: '#06B6D4' },
          { label: 'EBITDA Margin', value: margin == null ? '—' : `${margin}%`, color: '#10B981' },
        ].map(k => (
          <div key={k.label} className="rounded-xl bg-navy-50 dark:bg-navy-800 p-2.5 text-center min-w-0">
            <div className="text-[9px] uppercase tracking-wider text-navy-500 mb-1 truncate">{k.label}</div>
            <div className="text-[13px] font-bold tabular-nums leading-tight tracking-tight break-words" style={{ color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* EBITDA bridge */}
      <div>
        <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2">How EBITDA Is Built</div>
        <div className="space-y-2">
          {bridge.map((b, i) => (
            <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg bg-navy-50 dark:bg-navy-800">
              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: b.color }} />
              <div className="flex-1 min-w-0">
                <div className="flex justify-between mb-1">
                  <span className="text-[12px] font-medium text-navy-700 dark:text-navy-200 truncate">{i === 0 ? b.label : `+ ${b.label}`}</span>
                  <span className="text-[12px] font-bold text-navy-900 dark:text-white ml-2">{fmtINR(b.amount)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-navy-100 dark:bg-navy-700 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${Math.min(100, (Math.abs(b.amount) / bridgeMax) * 100)}%`, background: b.color }} />
                </div>
              </div>
            </div>
          ))}
          {/* Total */}
          <div className="flex items-center justify-between p-2.5 rounded-lg bg-violet-50 dark:bg-violet-500/10 border border-violet-100 dark:border-violet-500/20">
            <span className="text-[12px] font-bold text-violet-700 dark:text-violet-300">= EBITDA</span>
            <span className="text-[13px] font-bold text-violet-700 dark:text-violet-300">{fmtINR(ebitda)}</span>
          </div>
        </div>
        {da === 0 && (
          <div className="text-[10.5px] text-navy-400 mt-2 leading-snug">
            No depreciation/amortization reported, so EBITDA equals operating profit.
          </div>
        )}
      </div>

      {/* Margins context */}
      <div>
        <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2">Profitability Margins</div>
        <div className="grid grid-cols-3 gap-3">
          {margins.map(k => (
            <div key={k.label} className="rounded-xl bg-navy-50 dark:bg-navy-800 p-2.5 text-center min-w-0">
              <div className="text-[9px] uppercase tracking-wider text-navy-500 mb-1 truncate">{k.label}</div>
              <div className="text-[13px] font-bold tabular-nums leading-tight tracking-tight text-navy-800 dark:text-navy-100">{k.value == null ? '—' : `${k.value}%`}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Modal shell ──────────────────────────────────────────────────────────────
const MODAL_CONFIG = {
  rev:    { title: 'Total Revenue',   icon: TrendingUp,    color: '#2563EB', Component: RevenueDetail },
  cash:   { title: 'Cash on Hand',    icon: Wallet,        color: '#8B5CF6', Component: CashDetail    },
  burn:   { title: 'Burn / Runway',   icon: TrendingDown,  color: '#EF4444', Component: BurnDetail    },
  rec:    { title: 'Receivables',     icon: ReceiptText,   color: '#10B981', Component: ReceivablesDetail },
  ebitda: { title: 'EBITDA',          icon: BarChart2,     color: '#8B5CF6', Component: EbitdaDetail  },
};

export default function KpiDetailModal({ kpiId, from, to, onClose }) {
  const cfg = MODAL_CONFIG[kpiId];
  if (!cfg) return null;
  const { title, icon: Icon, color, Component } = cfg;

  // Close on Escape
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <>
      {/* Backdrop — z above the sidebar (z-50) so the whole app, including the
          left sidebar, dims and blurs behind the drawer. */}
      <div
        className="fixed inset-0 bg-navy-950/50 backdrop-blur-sm z-[60] animate-fadein"
        onClick={onClose}
      />
      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-full max-w-[420px] bg-white dark:bg-navy-950 shadow-2xl z-[70] flex flex-col animate-slidein-right">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-navy-100 dark:border-navy-800">
          <div className="w-9 h-9 rounded-xl grid place-items-center" style={{ background: color + '18' }}>
            <Icon size={16} style={{ color }} />
          </div>
          <div className="flex-1">
            <div className="text-[15px] font-bold text-navy-900 dark:text-white">{title}</div>
            <div className="text-[11px] text-navy-400">Detailed breakdown</div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg grid place-items-center text-navy-400 hover:text-navy-700 dark:hover:text-white hover:bg-navy-100 dark:hover:bg-navy-800 transition"
          >
            <X size={16} />
          </button>
        </div>
        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <Component from={from} to={to} />
        </div>
      </div>
    </>
  );
}
