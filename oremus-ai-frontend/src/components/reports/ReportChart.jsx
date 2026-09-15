import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell,
  LineChart, Line,
  AreaChart, Area,
} from 'recharts';
import { fmt, fmtCompact, fmtMoneyCompact } from '../../utils/fmt.js';

// Report payloads carry their own currency (rep.currency) — format money in
// THAT currency so a USD QuickBooks report never shows ₹ (which is the app's
// global default), matching the report table exactly.

// Professional palette shared with the rest of the app's charts.
const PALETTE = ['#2563EB', '#06B6D4', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#0EA5E9', '#22C55E'];

// Per-color vertical gradients used for bar fills and area fills.
const GRADIENTS = PALETTE.map((c, i) => (
  <linearGradient key={i} id={`rcg${i}`} x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stopColor={c} stopOpacity={0.95} />
    <stop offset="100%" stopColor={c} stopOpacity={0.45} />
  </linearGradient>
));

const AXIS_TICK = { fontSize: 11, fill: '#64748B' };
const GRID_STROKE = 'rgba(100,116,139,0.15)';
const AXIS_STROKE = 'rgba(100,116,139,0.28)';

function dataValueColumns(data) {
  return data.columns.filter((c) => c.key !== 'label');
}

// Pick the non-aggregated rows for chart input.
function chartableRows(data) {
  return data.rows.filter((r) => r.level !== 0 && !r.isSubtotal && !r.isTotal && r.cells);
}

function toSeries(data) {
  const valueCols = dataValueColumns(data);
  const primaryKey = valueCols[0]?.key || 'cur';
  return chartableRows(data).map((r, i) => ({
    name: r.label,
    value: r.cells?.[primaryKey] ?? 0,
    fill: PALETTE[i % PALETTE.length],
    ...Object.fromEntries(valueCols.map((c) => [c.key, r.cells?.[c.key] ?? 0])),
  }));
}

function truncateTick(v, max = 14) {
  if (v == null) return '';
  const s = String(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Shared professional tooltip: dark card with colored swatch, series name,
// full currency-formatted value, and (for pie) percentage share.
function ChartTooltip({ active, payload, label, columnNames = {}, isPie = false, total = 0, currency = null }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="rounded-lg border border-navy-200/60 dark:border-navy-700 bg-white/95 dark:bg-navy-900/95 backdrop-blur px-3 py-2 shadow-xl shadow-navy-900/10 text-[12px]">
      {!isPie && label != null && label !== '' && (
        <div className="mb-1.5 font-semibold text-navy-800 dark:text-white">{truncateTick(label, 40)}</div>
      )}
      <div className="space-y-1">
        {payload.map((p, i) => {
          const name = isPie ? p.name : (columnNames[p.name] || p.name);
          const value = Number(p.value) || 0;
          const pct = isPie && total ? (Math.abs(value) / Math.abs(total)) * 100 : null;
          return (
            <div key={i} className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ background: p.color || p.payload?.fill }}
              />
              <span className="text-navy-500 dark:text-navy-300">{truncateTick(name, 32)}</span>
              <span className="ml-auto pl-4 font-semibold tabular-nums text-navy-900 dark:text-white">
                {fmt(value, { currency })}
              </span>
              {pct != null && (
                <span className="w-12 text-right tabular-nums text-navy-400">{pct.toFixed(1)}%</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Minimal HTML legend (dot + label [+ compact value]) — cleaner and more
// controllable than the recharts default for a professional sheet look.
function ChartLegend({ items, showValue = false }) {
  if (!items.length) return null;
  return (
    <div className="mt-2.5 flex flex-wrap justify-center gap-x-4 gap-y-1">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-1.5 text-[11px] text-navy-500 dark:text-navy-400">
          <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: it.fill }} />
          <span className="max-w-[160px] truncate font-medium">{it.name}</span>
          {showValue && (
            <span className="font-semibold tabular-nums text-navy-700 dark:text-navy-200">
              {fmtCompact(it.value)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export default function ReportChart({ kind = 'bar', data, height = 360, compact = false }) {
  const series = toSeries(data);
  const valueCols = dataValueColumns(data);
  const columnNames = Object.fromEntries(data.columns.map((c) => [c.key, c.label]));
  const currency = data.currency || null;

  if (kind === 'pie') {
    const total = series.reduce((s, d) => s + (Math.abs(d.value) || 0), 0);
    return (
      <div className="w-full">
        <div className="relative" style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={series}
                dataKey="value"
                nameKey="name"
                innerRadius={compact ? 16 : 52}
                outerRadius={compact ? 30 : 92}
                paddingAngle={2}
                cornerRadius={4}
                stroke="none"
              >
                {series.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
              </Pie>
              {!compact && <Tooltip content={<ChartTooltip isPie total={total} currency={currency} />} />}
            </PieChart>
          </ResponsiveContainer>
          {!compact && total > 0 && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="text-center">
                <div className="text-[10px] uppercase tracking-wider text-navy-400 dark:text-navy-500 font-semibold">Total</div>
                <div className="text-[18px] font-bold tabular-nums text-navy-900 dark:text-white">
                  {fmtMoneyCompact(total, currency)}
                </div>
              </div>
            </div>
          )}
        </div>
        {!compact && <ChartLegend items={series.map((s) => ({ name: s.name, fill: s.fill, value: s.value }))} showValue />}
      </div>
    );
  }

  if (kind === 'line' || kind === 'area') {
    const Chart = kind === 'area' ? AreaChart : LineChart;
    const Series = kind === 'area' ? Area : Line;
    return (
      <div className="w-full">
        <ResponsiveContainer width="100%" height={height}>
          <Chart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>{GRADIENTS}</defs>
            {!compact && <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={GRID_STROKE} />}
            {!compact && (
              <XAxis
                dataKey="name"
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={{ stroke: AXIS_STROKE }}
                tickFormatter={truncateTick}
                interval={Math.ceil(series.length / 10)}
                minTickGap={14}
              />
            )}
            {!compact && (
              <YAxis tickFormatter={fmtCompact} tick={AXIS_TICK} tickLine={false} axisLine={false} width={46} />
            )}
            {!compact && (
              <Tooltip cursor={{ stroke: 'rgba(100,116,139,0.25)', strokeDasharray: '3 3' }} content={<ChartTooltip columnNames={columnNames} currency={currency} />} />
            )}
            {valueCols.map((c, i) => (
              <Series
                key={c.key}
                type="monotone"
                dataKey={c.key}
                stroke={PALETTE[i % PALETTE.length]}
                strokeWidth={2.5}
                strokeLinecap="round"
                fill={kind === 'area' ? `url(#rcg${i % PALETTE.length})` : 'transparent'}
                fillOpacity={1}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
              />
            ))}
          </Chart>
        </ResponsiveContainer>
        {!compact && valueCols.length > 1 && (
          <ChartLegend
            items={valueCols.map((c, i) => ({ name: columnNames[c.key] || c.key, fill: PALETTE[i % PALETTE.length] }))}
          />
        )}
      </div>
    );
  }

  // default: bar
  return (
    <div className="w-full">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
          <defs>{GRADIENTS}</defs>
          {!compact && <CartesianGrid vertical={false} strokeDasharray="3 3" stroke={GRID_STROKE} />}
          {!compact && (
            <XAxis
              dataKey="name"
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: AXIS_STROKE }}
              tickFormatter={truncateTick}
              interval={Math.ceil(series.length / 10)}
              minTickGap={14}
            />
          )}
          {!compact && (
            <YAxis tickFormatter={fmtCompact} tick={AXIS_TICK} tickLine={false} axisLine={false} width={46} />
          )}
          {!compact && (
            <Tooltip cursor={{ fill: 'rgba(100,116,139,0.07)' }} content={<ChartTooltip columnNames={columnNames} currency={currency} />} />
          )}
          {valueCols.map((c, i) => (
            <Bar
              key={c.key}
              dataKey={c.key}
              fill={`url(#rcg${i % PALETTE.length})`}
              radius={[5, 5, 0, 0]}
              maxBarSize={48}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      {!compact && valueCols.length > 1 && (
        <ChartLegend
          items={valueCols.map((c, i) => ({ name: columnNames[c.key] || c.key, fill: PALETTE[i % PALETTE.length] }))}
        />
      )}
    </div>
  );
}
