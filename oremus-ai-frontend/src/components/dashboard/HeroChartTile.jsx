import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import Tile from './Tile.jsx';
import CountUpValue from './CountUpValue.jsx';
import { fmt, fmtMoneyCompact } from '../../utils/fmt.js';

// Hero series values are in thousands — multiply back to full rupees for display.
function fmtFull(v) {
  if (v == null) return '—';
  return fmt(v * 1000);
}

export default function HeroChartTile({ data = [] }) {
  const totalRev    = data.reduce((s, d) => s + (d.rev || 0), 0);
  const totalExp    = data.reduce((s, d) => s + (d.exp || 0), 0);
  // The period series is zero-filled to span every month, so a period with no
  // activity (e.g. a fiscal year not yet synced) arrives as all-zero buckets —
  // show the clean empty state instead of a flat-line chart.
  const visibleData = (totalRev === 0 && totalExp === 0) ? [] : data;
  const totalProfit = totalRev - totalExp;
  const latest      = visibleData[visibleData.length - 1];

  const subtitle = latest
    ? `${latest.m}: ${fmtFull(latest.rev)} rev · ${fmtFull(latest.exp)} exp · ${fmtFull(latest.rev - latest.exp)} profit`
    : 'No data for selected period';


  return (
    <Tile padding="p-0" className="row-span-2 h-full">
      <div className="p-6 pb-3">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-navy-500 dark:text-navy-300">
              Revenue · selected period
            </div>
            <div className="mt-1 flex items-baseline gap-2 flex-wrap">
              <div className="text-[clamp(24px,3vw,40px)] font-bold tracking-tighter tabular-nums leading-none text-navy-900 dark:text-white">
                <CountUpValue value={fmtFull(totalRev)} />
              </div>
              {totalRev > 0 && (
                <div className={`text-[14px] font-semibold ${totalProfit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {totalProfit >= 0 ? '▲' : '▼'} {fmtFull(Math.abs(totalProfit))} profit
                </div>
              )}
            </div>
            <div className="text-[12px] text-navy-500 dark:text-navy-300 mt-1">{subtitle}</div>
          </div>
        </div>
      </div>

      {visibleData.length === 0 ? (
        <div className="px-6 flex items-center justify-center h-[280px] text-navy-400 text-[13px]">
          No data for selected period
        </div>
      ) : (
        <div className="px-3 pb-4 h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={visibleData} margin={{ top: 6, right: 10, left: -15, bottom: 0 }}>
              <defs>
                <linearGradient id="hero-rev-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2563EB" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="#2563EB" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#94A3B8" strokeOpacity={0.18} vertical={false} />
              <XAxis dataKey="m" tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} padding={{ left: 6, right: 6 }} />
              <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} tickFormatter={(v) => fmtMoneyCompact(v * 1000)} />
              <Tooltip
                contentStyle={{
                  borderRadius: 8,
                  border: '1px solid rgba(100,116,139,0.2)',
                  fontSize: 12,
                }}
                cursor={{ stroke: '#94A3B8', strokeWidth: 1, strokeDasharray: '4 3' }}
                formatter={(v) => fmt(v * 1000)}
              />
              {/* Revenue — line + shaded margin zone */}
              <Area isAnimationActive={false} type="linear" dataKey="rev" name="Revenue" stroke="#2563EB" strokeWidth={2.5}
                fill="url(#hero-rev-fill)" dot={{ r: 3.5, fill: '#2563EB', strokeWidth: 0 }} activeDot={{ r: 5, strokeWidth: 0 }} />
              {/* Expenses — solid red line */}
              <Line isAnimationActive={false} type="linear" dataKey="exp" name="Expenses" stroke="#EF4444" strokeWidth={2}
                dot={{ r: 3, fill: '#EF4444', strokeWidth: 0 }} activeDot={{ r: 5, strokeWidth: 0 }} />
              {/* Net Profit — green dashed line */}
              <Line isAnimationActive={false} type="linear" dataKey="profit" name="Net Profit" stroke="#10B981" strokeWidth={2} strokeDasharray="6 4"
                dot={{ r: 3, fill: '#10B981', strokeWidth: 0 }} activeDot={{ r: 5, strokeWidth: 0 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="px-6 pb-4 flex items-center gap-4 text-[11.5px] text-navy-600 dark:text-navy-300">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-brand-500" />Revenue</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-red-500" />Expenses</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-0 border-t-2 border-dashed border-emerald-500" />Net Profit</span>
      </div>
    </Tile>
  );
}
