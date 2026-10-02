import { useEffect, useState } from 'react';
import { X, Users, Truck, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import axiosClient from '../../services/axiosClient.js';
import { fmt } from '../../utils/fmt.js';
import GrowthBadge from './GrowthBadge.jsx';

// Detail drawer shows full grouped values (e.g. ₹32,90,000), not compact.
function fmtAmt(n) {
  if (n == null || isNaN(n)) return fmt(0);
  return fmt(n);
}

const BILLS_PAGE_SIZE = 5;

// One vendor's bills for the selected period, 5 per page — the documents behind
// that vendor's total (GET /dashboard/vendor-bills uses the same source as the
// Top Vendors ranking, so the pages add up to the amount shown).
function VendorBills({ vendor, from, to, accent }) {
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    axiosClient.get('/dashboard/vendor-bills', { params: { vendor, from, to, page, pageSize: BILLS_PAGE_SIZE } })
      .then((r) => { if (!cancelled) setState({ loading: false, error: null, data: r.data?.data }); })
      .catch((e) => { if (!cancelled) setState({ loading: false, error: e?.response?.data?.error || e.message, data: null }); });
    return () => { cancelled = true; };
  }, [vendor, from, to, page]);

  const d = state.data;
  const totalPages = d ? Math.max(1, Math.ceil(d.total / BILLS_PAGE_SIZE)) : 1;

  if (state.error) {
    return <div className="text-[11.5px] text-red-600 dark:text-red-400 py-2">Couldn't load bills: {state.error}</div>;
  }
  if (!d && state.loading) {
    return <div className="space-y-1.5 py-1">{[...Array(3)].map((_, i) => <div key={i} className="h-7 rounded skeleton" />)}</div>;
  }
  if (!d || d.total === 0) {
    return <div className="text-[11.5px] text-navy-400 py-2">No bills for this vendor in the selected period.</div>;
  }

  return (
    <div className={state.loading ? 'opacity-60 transition-opacity' : ''}>
      <div className="rounded-lg border border-navy-100 dark:border-navy-800 overflow-hidden">
        <table className="w-full text-[11.5px]">
          <thead>
            <tr className="bg-navy-50 dark:bg-navy-900 text-navy-500 text-[10px] uppercase tracking-wider">
              <th className="text-left font-semibold px-2.5 py-1.5">Date</th>
              <th className="text-left font-semibold px-2.5 py-1.5">Bill #</th>
              <th className="text-right font-semibold px-2.5 py-1.5">Amount</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((b, i) => (
              <tr key={`${b.number}-${b.date}-${i}`} className="border-t border-navy-100 dark:border-navy-800">
                <td className="px-2.5 py-1.5 tabular-nums text-navy-600 dark:text-navy-300 whitespace-nowrap">{b.date}</td>
                <td className="px-2.5 py-1.5 text-navy-800 dark:text-navy-100 min-w-0">
                  <span className="block truncate max-w-[150px]" title={b.number}>{b.number || b.type || '—'}</span>
                  {b.status && <span className="block text-[10px] text-navy-400 capitalize">{b.status}</span>}
                </td>
                <td className="px-2.5 py-1.5 text-right tabular-nums font-semibold text-navy-900 dark:text-white whitespace-nowrap">{fmtAmt(b.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-2 mt-2 text-[11px] text-navy-500">
        <span>{d.total} bill{d.total !== 1 ? 's' : ''} · {fmtAmt(d.totalAmount)}</span>
        {totalPages > 1 && (
          <div className="flex items-center gap-1.5">
            <button type="button" aria-label="Previous page" disabled={page <= 1 || state.loading}
              onClick={() => setPage((p) => p - 1)}
              className="w-6 h-6 grid place-items-center rounded-md border border-navy-200 dark:border-navy-700 disabled:opacity-40 hover:bg-navy-50 dark:hover:bg-navy-800">
              <ChevronLeft size={13} />
            </button>
            <span className="tabular-nums">Page {page} of {totalPages}</span>
            <button type="button" aria-label="Next page" disabled={page >= totalPages || state.loading}
              onClick={() => setPage((p) => p + 1)}
              className="w-6 h-6 grid place-items-center rounded-md border border-navy-200 dark:border-navy-700 disabled:opacity-40 hover:bg-navy-50 dark:hover:bg-navy-800"
              style={{ color: accent }}>
              <ChevronRight size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function TopListModal({ title, rows = [], accent = '#2563EB', kind = 'customers', from, to, onClose }) {
  // Vendors expand to their bills; only one vendor is open at a time.
  const expandable = kind === 'vendors' && !!from && !!to;
  const [openId, setOpenId] = useState(null);
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
                const rowId = r.id ?? i;
                const isOpen = expandable && openId === rowId;
                return (
                  <li key={rowId}>
                    <div
                      className={`flex items-center gap-3 ${expandable ? 'cursor-pointer rounded-lg -mx-2 px-2 py-1 hover:bg-navy-50 dark:hover:bg-navy-900' : ''}`}
                      {...(expandable ? {
                        role: 'button',
                        tabIndex: 0,
                        'aria-expanded': isOpen,
                        onClick: () => setOpenId(isOpen ? null : rowId),
                        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(isOpen ? null : rowId); } },
                      } : {})}
                    >
                      <span className="w-5 text-center text-[11px] font-bold tabular-nums text-navy-400">{i + 1}</span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] font-semibold text-navy-900 dark:text-white truncate">{r.name}</span>
                        {r.sub && <span className="block text-[11px] text-navy-500 truncate">{r.sub}</span>}
                      </span>
                      <div className="text-right shrink-0">
                        <div className="text-[13px] font-bold tabular-nums text-navy-900 dark:text-white">{fmtAmt(r.amount)}</div>
                        {/* Growth vs the previous period; "—" when it can't be measured. */}
                        <div className="text-[10.5px]">
                          {r.trend == null
                            ? <span className="text-navy-400" title="No previous-period data to compare">—</span>
                            : <GrowthBadge value={r.trend} />}
                        </div>
                      </div>
                      {expandable && (
                        <ChevronDown size={14} className={`shrink-0 text-navy-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                      )}
                    </div>
                    <div className="ml-8 mt-1.5 h-1 rounded-full bg-navy-100 dark:bg-navy-800 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: accent }} />
                    </div>
                    {isOpen && (
                      <div className="ml-8 mt-2">
                        <VendorBills vendor={r.name} from={from} to={to} accent={accent} />
                      </div>
                    )}
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
