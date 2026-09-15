// Xero-style viewer for the "Foreign Currency Gains and Losses" report ONLY.
// Every other report uses the common QBO-style QBReportViewer; ReportViewerModal
// routes this report here so its filter bar + report sheet mirror Xero's FX
// statement (From / To / Update, a centered title block, and a multi-column
// table grouped by Accounts Receivable / Payable with per-currency rows).

import { useEffect, useMemo, useState, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { ArrowLeft, Star, X, Printer } from 'lucide-react';
import ExportMenu from './ExportMenu.jsx';
import ReportSkeleton from './ReportSkeleton.jsx';
import {
  selectOpenReport, selectReportData, selectReportStatus,
  selectFilters, selectFavorites,
  closeReport, setFilter, toggleFavorite, loadReportData,
} from '../../features/reports/reportsSlice.js';
import { selectActiveClient } from '../../features/clients/clientsSlice.js';
import { resolvePresetRange } from '../../features/reports/data/dateRanges.js';
import { fmt } from '../../utils/fmt.js';
import { cn } from '../../utils/classNames.js';

const XERO_BLUE = '#1A73E8';

const fieldCls =
  'h-9 px-3 rounded-md bg-white dark:bg-navy-900 border border-navy-300 dark:border-navy-700 text-[13px] text-navy-900 dark:text-white outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20';

// Xero prints plain amounts and brackets a negative balance.
const num = (v) => {
  if (v == null || Number.isNaN(v)) return '';
  const text = fmt(Math.abs(v), { dec: 2 }).replace(/^[^\d-]+/, '');
  return Number(v) < 0 ? `(${text})` : text;
};
const longDate = (d) => d.toLocaleString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });

export default function ForeignCurrencyGainsViewer() {
  const dispatch = useDispatch();
  const report = useSelector(selectOpenReport);
  const data = useSelector(selectReportData);
  const status = useSelector(selectReportStatus);
  const client = useSelector(selectActiveClient);
  const filters = useSelector(selectFilters);
  const favorites = useSelector(selectFavorites);

  const favorited = !!favorites[report.name];
  const loading = status === 'loading';

  const range = useMemo(
    () => resolvePresetRange(filters.dateRange, { from: filters.customFrom, to: filters.customTo }),
    [filters.dateRange, filters.customFrom, filters.customTo],
  );
  const fromVal = filters.customFrom || range.from_date;
  const toVal = filters.customTo || range.to_date;
  const fromText = fromVal ? longDate(new Date(fromVal)) : '';
  const toText = toVal ? longDate(new Date(toVal)) : '';

  const runReport = () => dispatch(loadReportData({ reportName: report.name, clientId: client?.id, provider: report.provider }));

  useEffect(() => {
    if (!data && status === 'idle') runReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto re-run when a request-shaping filter changes (after the initial mount
  // load) so the date pickers / toggles actually refresh the report — matching
  // the QB-style viewer, which applies every control immediately.
  const filterMounted = useRef(false);
  useEffect(() => {
    if (!filterMounted.current) { filterMounted.current = true; return; }
    runReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.dateRange, filters.customFrom, filters.customTo]);

  const cols = data?.columns || [];
  const valueCols = cols.filter((c) => c.key !== 'label');
  const rows = data?.rows || [];

  return (
    <>
      {/* Top bar */}
      <header className="border-b border-navy-200 dark:border-navy-800 bg-white dark:bg-navy-950 px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => dispatch(closeReport())}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-sky-700 dark:text-sky-300 hover:underline shrink-0"
          >
            <ArrowLeft size={14} /> Reports
          </button>
          <span className="text-navy-300">/</span>
          <h2 className="flex items-center gap-2 text-[14px] font-bold text-navy-900 dark:text-white truncate">
            {report.name}
            <button
              type="button"
              onClick={() => dispatch(toggleFavorite(report.name))}
              className={cn('grid place-items-center transition', favorited ? 'text-amber-500' : 'text-navy-300 hover:text-amber-500')}
              aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
            >
              <Star size={14} fill={favorited ? 'currentColor' : 'none'} />
            </button>
          </h2>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <ExportMenu
            meta={{ company: client?.name, from: fromVal, to: toVal }}
            trigger={(
              <button
                type="button"
                className="h-8 px-2.5 rounded-md border border-navy-200 dark:border-navy-700 text-navy-700 dark:text-navy-200 hover:bg-navy-50 dark:hover:bg-navy-800 inline-flex items-center gap-1 text-[12.5px] font-semibold"
              >
                Export
              </button>
            )}
          />
        
        </div>
      </header>

      {/* From / To filter bar */}
      <div className="border-b border-navy-200 dark:border-navy-800 bg-white dark:bg-navy-950 px-4 sm:px-6 py-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 items-end gap-x-4 gap-y-3">
          <div className="shrink-0">
            <div className="text-[11px] text-navy-500 dark:text-navy-400 mb-1">From</div>
            <input
              type="date"
              value={fromVal || ''}
              onChange={(e) => dispatch(setFilter({ customFrom: e.target.value, dateRange: 'custom' }))}
              className={fieldCls}
            />
          </div>
          <div className="shrink-0">
            <div className="text-[11px] text-navy-500 dark:text-navy-400 mb-1">To</div>
            <input
              type="date"
              value={toVal || ''}
              onChange={(e) => dispatch(setFilter({ customTo: e.target.value, dateRange: 'custom' }))}
              className={fieldCls}
            />
          </div>
          <button
            type="button"
            onClick={runReport}
            className="h-9 px-4 rounded-md text-white text-[13px] font-semibold shadow-soft hover:opacity-95 shrink-0 justify-self-start"
            style={{ background: XERO_BLUE }}
          >
            Run Report
          </button>
        </div>
      </div>

      {/* Report sheet */}
      <div className="flex-1 min-h-0 overflow-y-auto scroll-thin bg-navy-50/40 dark:bg-navy-950">
        <div className="p-4 sm:p-6 lg:p-8">
          <div className="max-w-[1180px] mx-auto bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-800 rounded-lg shadow-card px-5 sm:px-10 py-8">
            <div className="text-center mb-6">
              <div className="text-[20px] font-bold text-navy-900 dark:text-white leading-tight">{report.name}</div>
              <div className="text-[13.5px] text-navy-700 dark:text-navy-200">{data?.meta?.company || client?.name || 'Oremus'}</div>
              <div className="text-[13px] text-navy-600 dark:text-navy-300">From {fromText} to {toText}</div>
            </div>

            {loading || !data ? (
              <ReportSkeleton />
            ) : (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-[12px] text-navy-500 dark:text-navy-400 [&>th]:sticky [&>th]:top-0 [&>th]:z-20 [&>th]:bg-white dark:[&>th]:bg-navy-900 [&>th]:border-b [&>th]:border-navy-200 dark:[&>th]:border-navy-700">
                    <th className="text-left font-semibold py-2" />
                    {valueCols.map((c) => (
                      <th key={c.key} className="text-right font-semibold py-2 px-3 whitespace-nowrap">{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    if (r.isHeader) {
                      return (
                        <tr key={i}>
                          <td colSpan={valueCols.length + 1} className="pt-5 pb-1 text-[13.5px] font-bold text-navy-900 dark:text-white">{r.label}</td>
                        </tr>
                      );
                    }
                    const emph = r.isSubtotal || r.isTotal;
                    return (
                      <tr
                        key={i}
                        className={cn(
                          'border-b border-navy-100 dark:border-navy-800',
                          emph ? 'font-bold text-navy-900 dark:text-white' : 'text-navy-700 dark:text-navy-200',
                          r.isTotal && 'border-t border-navy-300 dark:border-navy-600',
                        )}
                      >
                        <td className={cn('py-1.5 pr-4', emph ? 'pl-0' : 'pl-4')}>{r.label}</td>
                        {valueCols.map((c) => {
                          const v = r.cells?.[c.key];
                          if (c.key === 'balance' && v != null) {
                            return (
                              <td key={c.key} className="py-1.5 px-3 text-right tabular-nums whitespace-nowrap">
                                <span className={emph ? '' : 'text-sky-700 dark:text-sky-300'}>{num(v)}</span>
                                {r.cells?.ccy && <span className="ml-1.5 text-navy-500 dark:text-navy-400">{r.cells.ccy}</span>}
                              </td>
                            );
                          }
                          const isLink = !emph && v != null;
                          return (
                            <td key={c.key} className={cn('py-1.5 px-3 text-right tabular-nums', isLink && 'text-sky-700 dark:text-sky-300')}>
                              {v == null ? '' : num(v)}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

     
    </>
  );
}
