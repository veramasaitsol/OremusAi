import { useEffect } from 'react';
import { X, Users, Truck } from 'lucide-react';
import { fmt } from '../../utils/fmt.js';

// Detail drawer shows full grouped values (e.g. ₹32,90,000), not compact.
function fmtAmt(n) {
  if (n == null || isNaN(n)) return fmt(0);
  return fmt(n);
}

export default function TopListModal({ title, rows = [], accent = '#2563EB', kind = 'customers', onClose }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const Icon = kind === 'vendors' ? Truck : Users;
  const max = Math.max(...rows.map((r) => r.amount), 1);

  return (
    <>
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-40 animate-fadein"
        onClick={onClose}
      />
      <div className="fixed right-0 top-0 h-full w-full max-w-[420px] bg-white dark:bg-navy-950 shadow-2xl z-50 flex flex-col animate-slidein-right">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-navy-100 dark:border-navy-800">
          <div className="w-9 h-9 rounded-xl grid place-items-center" style={{ background: accent + '18' }}>
            <Icon size={16} style={{ color: accent }} />
          </div>
          <div className="flex-1">
            <div className="text-[15px] font-bold text-navy-900 dark:text-white">{title}</div>
            <div className="text-[11px] text-navy-400">{rows.length} {kind} · this period</div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg grid place-items-center text-navy-400 hover:text-navy-700 dark:hover:text-white hover:bg-navy-100 dark:hover:bg-navy-800 transition"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {rows.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-[13px] text-navy-400">No data</div>
          ) : (
            <ul className="space-y-3">
              {rows.map((r, i) => {
                const pct = (r.amount / max) * 100;
                const up  = (r.trend || 0) >= 0;
                return (
                  <li key={r.id ?? i}>
                    <div className="flex items-center gap-3">
                      <span className="w-5 text-center text-[11px] font-bold tabular-nums text-navy-400">{i + 1}</span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] font-semibold text-navy-900 dark:text-white truncate">{r.name}</span>
                        {r.sub && <span className="block text-[11px] text-navy-500 truncate">{r.sub}</span>}
                      </span>
                      <div className="text-right shrink-0">
                        <div className="text-[13px] font-bold tabular-nums text-navy-900 dark:text-white">{fmtAmt(r.amount)}</div>
                        {r.trend != null && (
                          <div className={`text-[10.5px] font-semibold tabular-nums ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                            {up ? '▲' : '▼'} {Math.abs(r.trend).toFixed(1)}%
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="ml-8 mt-1.5 h-1 rounded-full bg-navy-100 dark:bg-navy-800 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: accent }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
