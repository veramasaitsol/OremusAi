import { useState } from 'react';
import { X, Layers, Download } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { fmt } from '../../utils/fmt.js';
import { exportRowsCSV } from '../../utils/exportReport.js';
import { cn } from '../../utils/classNames.js';

// Generic "how was this amount calculated" popup — the modal counterpart of
// the inline breakdown/drill panels elsewhere in ReportTable.jsx, used where
// a click target (an AR/AP Aging Summary cell, an Aging Detail row's Balance)
// benefits from its own focused view instead of pushing the table around.
// `entries` is the same {name, ref, date, type, txnAmount, amount} shape the
// inline panels already use — nothing new for the backend to produce.
const PAGE_SIZE = 15;

function formatCell(value, decimals, currency, locale) {
  if (value == null || value === '') return '';
  if (typeof value !== 'number') return value;
  return fmt(value, { dec: decimals, sign: '', currency, locale });
}

export default function BreakdownModal({
  open, onClose, title, subtitle, entries = [], currency = 'USD', decimals = 2, numLocale,
}) {
  const [page, setPage] = useState(0);

  const hasType = entries.some((e) => e.type != null);
  const hasTxnAmount = entries.some((e) => e.txnAmount != null);
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const pg = Math.min(page, totalPages - 1);
  const start = pg * PAGE_SIZE;
  const slice = entries.slice(start, start + PAGE_SIZE);

  const handleClose = () => { setPage(0); onClose?.(); };

  return (
    <Modal open={open} onClose={handleClose} size="md">
      <header className="flex items-center justify-between px-5 py-4 border-b border-navy-200 dark:border-navy-800">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/10 shrink-0">
            <Layers size={18} />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-navy-900 dark:text-navy-50 truncate">{title || 'Breakdown'}</h3>
            {subtitle && <p className="text-[11px] text-navy-400 truncate">{subtitle}</p>}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => exportRowsCSV(
              [
                'Counterparty', hasType ? 'Type' : 'Ref', 'Date',
                ...(hasTxnAmount ? ['Transaction Amount'] : []), 'Amount',
              ],
              entries.map((e) => [
                e.name || '', hasType ? (e.type || '') : (e.ref || ''), e.date || '',
                ...(hasTxnAmount ? [e.txnAmount ?? ''] : []), e.amount ?? '',
              ]),
              title || 'Breakdown',
            )}
            className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-navy-600 dark:text-navy-300 hover:text-brand-600"
          >
            <Download size={13} /> Export
          </button>
          <button type="button" onClick={handleClose} className="text-navy-400 hover:text-navy-700 dark:hover:text-navy-200" aria-label="Close">
            <X size={18} />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto scroll-thin">
        {entries.length === 0 ? (
          <div className="py-10 text-center text-sm text-navy-500">No contributing entries.</div>
        ) : (
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b-2 border-navy-200 dark:border-navy-700">
                <th className="sticky top-0 z-10 bg-white dark:bg-navy-950 px-4 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-navy-500 dark:text-navy-300">Counterparty</th>
                <th className="sticky top-0 z-10 bg-white dark:bg-navy-950 px-4 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-navy-500 dark:text-navy-300">{hasType ? 'Type' : 'Ref'}</th>
                <th className="sticky top-0 z-10 bg-white dark:bg-navy-950 px-4 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-navy-500 dark:text-navy-300">Date</th>
                {hasTxnAmount && (
                  <th className="sticky top-0 z-10 bg-white dark:bg-navy-950 px-4 py-2 text-right text-[10.5px] font-semibold uppercase tracking-wider text-navy-500 dark:text-navy-300">Txn Amount</th>
                )}
                <th className="sticky top-0 z-10 bg-white dark:bg-navy-950 px-4 py-2 text-right text-[10.5px] font-semibold uppercase tracking-wider text-navy-500 dark:text-navy-300">Amount</th>
              </tr>
            </thead>
            <tbody>
              {slice.map((e, i) => (
                <tr key={i} className="border-t border-navy-100 dark:border-navy-800">
                  <td className="px-4 py-2 text-navy-700 dark:text-navy-200">{e.name || '–'}</td>
                  <td className="px-4 py-2 font-mono text-navy-500">{hasType ? (e.type || '–') : (e.ref || '–')}</td>
                  <td className="px-4 py-2 text-navy-500">{e.date || '–'}</td>
                  {hasTxnAmount && (
                    <td className="px-4 py-2 text-right tabular-nums text-navy-600 dark:text-navy-300">{formatCell(e.txnAmount, decimals, currency, numLocale)}</td>
                  )}
                  <td className="px-4 py-2 text-right tabular-nums font-medium text-navy-800 dark:text-navy-100">{formatCell(e.amount, decimals, currency, numLocale)}</td>
                </tr>
              ))}
            </tbody>
            {entries.length > 1 && (
              <tfoot>
                <tr className="bg-navy-50 dark:bg-navy-900/60 font-semibold border-t-2 border-navy-200 dark:border-navy-700">
                  <td className="px-4 py-2" colSpan={hasTxnAmount ? 3 : 2}>Total ({entries.length})</td>
                  {hasTxnAmount && <td className="px-4 py-2" />}
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatCell(entries.reduce((s, e) => s + (Number(e.amount) || 0), 0), decimals, currency, numLocale)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>

      {totalPages > 1 && (
        <div className="px-4 py-2.5 border-t border-navy-100 dark:border-navy-800 flex items-center justify-between gap-2 bg-navy-50/60 dark:bg-navy-900/60">
          <span className="text-[11.5px] text-navy-500 dark:text-navy-400">
            Showing {start + 1}–{Math.min(start + PAGE_SIZE, entries.length)} of {entries.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pg === 0}
              onClick={() => setPage(pg - 1)}
              className={cn(
                'h-7 px-2.5 rounded-md border border-navy-200 dark:border-navy-700 text-[11.5px] font-semibold text-navy-600 dark:text-navy-300',
                'hover:bg-white dark:hover:bg-navy-800 disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              ← Prev
            </button>
            <span className="text-[11.5px] text-navy-500 dark:text-navy-400 tabular-nums">Page {pg + 1} of {totalPages}</span>
            <button
              type="button"
              disabled={pg >= totalPages - 1}
              onClick={() => setPage(pg + 1)}
              className={cn(
                'h-7 px-2.5 rounded-md border border-navy-200 dark:border-navy-700 text-[11.5px] font-semibold text-navy-600 dark:text-navy-300',
                'hover:bg-white dark:hover:bg-navy-800 disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
