import { useState } from 'react';
import { X } from 'lucide-react';
import { fmt } from '../../utils/fmt.js';
import { cn } from '../../utils/classNames.js';

const PAGE_SIZE =100;

export default function DrillDownModal({
  open, onClose,
  title, subtitle,
  rows = [],        // full array of { date, ref, account, source, amount, ... }
  count = 0,        // total count (may exceed rows.length if backend still caps)
  currency = 'USD',
  columns,          // optional override: [{ key, label, align?, className? }]
}) {
  const [page, setPage] = useState(0);

  // Reset page when modal opens with new data
  if (open && page > 0 && rows.length <= PAGE_SIZE) setPage(0);

  if (!open) return null;

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  const fmtAmount = (v) => {
    if (v == null) return '';
    return fmt(Math.abs(v), { dec: 2, sign: currency });
  };

  // Default columns (Date, Reference, Account, Source, Amount)
  const cols = columns || [
    { key: 'date',    label: 'Date',      align: 'left' },
    { key: 'ref',     label: 'Reference', align: 'left' },
    { key: 'account', label: 'Account',   align: 'left' },
    { key: 'source',  label: 'Source',    align: 'left' },
    { key: 'amount',  label: 'Amount',    align: 'right' },
  ];

  const totalDisplay = count || rows.length;

  return (
    <>
      <div className="fixed inset-0 bg-navy-950/40 z-[60]" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[70] w-[720px] max-w-[calc(100vw-2rem)] max-h-[82vh] flex flex-col bg-white dark:bg-navy-900 rounded-xl shadow-2xl border border-navy-200 dark:border-navy-800">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-navy-100 dark:border-navy-800">
          <div className="min-w-0">
            <div className="text-[15px] font-bold text-navy-900 dark:text-white truncate">{title}</div>
            <div className="text-[12px] text-navy-500">
              {subtitle ? `${subtitle} · ` : ''}{totalDisplay} {totalDisplay === 1 ? 'entry' : 'entries'}
            </div>
          </div>
          <button onClick={onClose} className="h-7 w-7 grid place-items-center rounded-md text-navy-400 hover:bg-navy-100 dark:hover:bg-navy-800">
            <X size={15} />
          </button>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto scroll-thin">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-navy-50 dark:bg-navy-950">
              <tr className="text-[11px] text-navy-500 dark:text-navy-400 border-b border-navy-200 dark:border-navy-700">
                {cols.map((c) => (
                  <th
                    key={c.key}
                    className={cn(
                      'font-semibold py-2 px-4',
                      c.align === 'right' ? 'text-right' : 'text-left',
                    )}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={cols.length} className="py-8 text-center text-navy-400 text-[13px]">
                    No entries found.
                  </td>
                </tr>
              ) : (
                pageRows.map((e, i) => (
                  <tr key={start + i} className="border-b border-navy-100 dark:border-navy-800">
                    {cols.map((c) => {
                      const val = e[c.key];
                      const isAmount = c.key === 'amount';
                      return (
                        <td
                          key={c.key}
                          className={cn(
                            'py-1.5 px-4 whitespace-nowrap',
                            c.align === 'right'
                              ? 'text-right tabular-nums text-navy-800 dark:text-navy-100'
                              : 'text-navy-700 dark:text-navy-200',
                          )}
                        >
                          {isAmount ? fmtAmount(val) : (val || '–')}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer with pagination */}
        <div className="px-4 py-2.5 border-t border-navy-100 dark:border-navy-800 flex items-center justify-between gap-3">
          <span className="text-[11.5px] text-navy-500 dark:text-navy-400">
            {totalPages <= 1
              ? `${totalDisplay} ${totalDisplay === 1 ? 'entry' : 'entries'}`
              : `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${totalDisplay} entries`
            }
          </span>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={safePage === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="h-6 px-2 rounded-md border border-navy-200 dark:border-navy-700 text-[11px] font-semibold text-navy-600 dark:text-navy-300 hover:bg-white dark:hover:bg-navy-800 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ← Prev
              </button>
              <span className="text-[11px] text-navy-500 dark:text-navy-400 tabular-nums">
                Page {safePage + 1} of {totalPages}
              </span>
              <button
                type="button"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                className="h-6 px-2 rounded-md border border-navy-200 dark:border-navy-700 text-[11px] font-semibold text-navy-600 dark:text-navy-300 hover:bg-white dark:hover:bg-navy-800 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next →
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
