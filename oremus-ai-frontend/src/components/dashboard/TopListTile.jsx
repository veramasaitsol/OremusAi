import Tile from './Tile.jsx';
import CountUpValue from './CountUpValue.jsx';
import { fmt } from '../../utils/fmt.js';

function fmtAmt(n) {
  if (n == null || isNaN(n)) return fmt(0);
  return fmt(n);
}

export default function TopListTile({ title, rows = [], accent = '#2563EB', loading = false, onViewAll }) {
  const max = Math.max(...rows.map((r) => r.amount), 1);
  return (
    <Tile padding="p-4" className="h-full">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <div className="text-[11.5px] font-bold uppercase tracking-[0.14em] text-navy-500">{title}</div>
          {loading && (
            <svg className="animate-spin w-3 h-3 text-brand-500" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
              <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          )}
        </div>
        <button onClick={onViewAll} className="text-[10.5px] font-semibold text-brand-600 hover:underline">All →</button>
      </div>

      {/* Skeleton rows while loading */}
      {loading && rows.length === 0 ? (
        <ul className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-5 h-3 rounded skeleton" />
              <span className="flex-1 h-3 rounded skeleton" />
              <span className="w-14 h-3 rounded skeleton" />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="space-y-2">
          {rows.map((r, i) => {
            const pct = (r.amount / max) * 100;
            const up  = (r.trend || 0) >= 0;
            return (
              <li key={r.id} className="group">
                <div className="flex items-center gap-2">
                  <span className="w-5 text-center text-[10.5px] font-bold tabular-nums text-navy-400">{i + 1}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[12px] font-semibold text-navy-900 dark:text-white truncate">{r.name}</span>
                    <span className="block text-[10.5px] text-navy-500 truncate">{r.sub}</span>
                  </span>
                  <div className="text-right shrink-0">
                    <div className="text-[12px] font-bold tabular-nums text-navy-900 dark:text-white">
                      <CountUpValue value={fmtAmt(r.amount)} />
                    </div>
                    <div className={`text-[10px] font-semibold tabular-nums ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                      {up ? '▲' : '▼'} {Math.abs(r.trend).toFixed(1)}%
                    </div>
                  </div>
                </div>
                <div className="ml-7 mt-1 h-0.5 rounded-full bg-navy-100 dark:bg-navy-800 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: accent }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Tile>
  );
}
