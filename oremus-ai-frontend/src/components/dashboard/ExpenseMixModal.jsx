import { useEffect } from 'react';
import { X, PieChart as PieIcon } from 'lucide-react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';
import { fmt } from '../../utils/fmt.js';

// amount arrives pre-divided into thousands (same convention as ExpenseMixTile).
// The detail drawer shows full grouped values (e.g. ₹3,40,000), not compact.
function fmtK(v) {
  if (!v && v !== 0) return '—';
  return fmt(v * 1000);
}

export default function ExpenseMixModal({ data = [], onClose }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const totalK = data.reduce((s, d) => s + (d.amount || 0), 0);
  const rows = [...data].sort((a, b) => (b.amount || 0) - (a.amount || 0));

  return (
    <>
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-40 animate-fadein"
        onClick={onClose}
      />
      <div className="fixed right-0 top-0 h-full w-full max-w-[420px] bg-white dark:bg-navy-950 shadow-2xl z-50 flex flex-col animate-slidein-right">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-navy-100 dark:border-navy-800">
          <div className="w-9 h-9 rounded-xl grid place-items-center" style={{ background: '#F59E0B18' }}>
            <PieIcon size={16} style={{ color: '#F59E0B' }} />
          </div>
          <div className="flex-1">
            <div className="text-[15px] font-bold text-navy-900 dark:text-white">Expense Mix</div>
            <div className="text-[11px] text-navy-400">This period · {rows.length} categor{rows.length === 1 ? 'y' : 'ies'}</div>
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
            <div className="flex items-center justify-center h-40 text-[13px] text-navy-400">No expense data</div>
          ) : (
            <div className="space-y-5">
              {/* Total */}
              <div className="rounded-xl bg-amber-50 dark:bg-amber-500/10 p-4 text-center">
                <div className="text-[10px] uppercase tracking-widest text-amber-600 dark:text-amber-400 mb-1">Total Expenses</div>
                <div className="text-[32px] font-bold text-amber-700 dark:text-amber-300">{fmtK(totalK)}</div>
              </div>

              {/* Donut */}
              <div className="relative w-full h-[180px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Tooltip formatter={(v, n, p) => [`${v}% · ${fmtK(p.payload.amount)}`, p.payload.name]}
                      contentStyle={{ borderRadius: 8, border: '1px solid rgba(100,116,139,.2)', fontSize: 12 }} />
                    <Pie isAnimationActive={false} data={rows} dataKey="value" innerRadius="50%" outerRadius="75%" stroke="none" paddingAngle={2}>
                      {rows.map((c, i) => <Cell key={i} fill={c.color} />)}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>

              {/* Breakdown */}
              <div>
                <div className="text-[11px] font-semibold text-navy-500 uppercase tracking-wider mb-2">By Category</div>
                <div className="space-y-2">
                  {rows.map((c, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: c.color }} />
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between mb-1">
                          <span className="text-[12px] font-medium text-navy-800 dark:text-navy-100 truncate">{c.name}</span>
                          <div className="flex items-center gap-2 ml-2 shrink-0">
                            <span className="text-[12px] font-bold text-navy-900 dark:text-white">{fmtK(c.amount)}</span>
                            <span className="text-[10.5px] text-navy-400 w-9 text-right">{c.value}%</span>
                          </div>
                        </div>
                        <div className="h-1.5 rounded-full bg-navy-100 dark:bg-navy-700 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${c.value}%`, background: c.color }} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
