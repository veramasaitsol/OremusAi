import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';
import Tile from './Tile.jsx';
import CountUpValue from './CountUpValue.jsx';
import { fmtMoneyCompact } from '../../utils/fmt.js';

// amount arrives pre-divided into thousands; scale back up so the shared
// currency-aware formatter applies the right symbol + abbreviations.
function fmtK(v) {
  if (!v && v !== 0) return '—';
  return fmtMoneyCompact(v * 1000);
}

const CustomTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-700 rounded-xl shadow-lift px-3 py-2 text-left">
      <div className="text-[11px] font-semibold text-navy-800 dark:text-white truncate max-w-[160px]">{d.name}</div>
      <div className="flex items-center gap-2 mt-0.5">
        <span className="text-[11px] font-bold text-navy-900 dark:text-white">{d.value}%</span>
        {d.amount != null && (
          <span className="text-[10px] text-navy-400">{fmtK(d.amount)}</span>
        )}
      </div>
    </div>
  );
};

export default function ExpenseMixTile({ data = [], onDetails }) {
  const totalK = data.reduce((s, d) => s + (d.amount || 0), 0);
  const catLabel = `${data.length} categor${data.length === 1 ? 'y' : 'ies'}`;

  return (
    <Tile padding="p-4" className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between mb-3 gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-navy-500 whitespace-nowrap">Expense Mix</div>
          <div className="text-[10px] text-navy-400 whitespace-nowrap">This period · {catLabel}</div>
        </div>
        <button onClick={onDetails} className="text-[10.5px] font-semibold text-brand-600 hover:text-brand-700 whitespace-nowrap flex-shrink-0">
          Details&nbsp;→
        </button>
      </div>

      {data.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-[12px] text-navy-400">No expense data</div>
      ) : (
        <div className="flex-1 flex flex-col sm:flex-row items-center justify-center gap-5">
          {/* Donut chart — left */}
          <div className="relative w-[180px] h-[180px] shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip content={<CustomTooltip />} />
                <Pie
                  isAnimationActive={false}
                  data={data}
                  dataKey="value"
                  innerRadius="55%"
                  outerRadius="80%"
                  stroke="none"
                  paddingAngle={2}
                >
                  {data.map((c, i) => <Cell key={i} fill={c.color} />)}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            {/* Centre label */}
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <div className="text-[8.5px] uppercase tracking-wider text-navy-400">Total</div>
              <div className="text-[14px] font-bold tabular-nums text-navy-900 dark:text-white leading-tight">
                <CountUpValue value={fmtK(totalK)} />
              </div>
            </div>
          </div>

          {/* Legend — right */}
          <ul className="flex-1 w-full space-y-2 min-w-0">
            {data.map((c) => (
              <li key={c.name} className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: c.color }} />
                <span className="flex-1 text-[12px] text-navy-600 dark:text-navy-300 truncate min-w-0">{c.name}</span>
                <span className="text-[12px] font-bold tabular-nums text-navy-800 dark:text-navy-100 shrink-0 ml-1">{c.value}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Tile>
  );
}
