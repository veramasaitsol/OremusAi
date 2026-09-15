// Budget Summary viewer — supports fiscal-year columns (yearly) and
// calendar-month columns (monthly). Reads the `period` field from the
// backend response to decide which mode to use.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  ArrowLeft, Star, X, ChevronDown,
} from 'lucide-react';
import Popover from '../ui/Popover.jsx';
import ExportMenu from './ExportMenu.jsx';
import ReportSkeleton from './ReportSkeleton.jsx';
import {
  selectOpenReport, selectReportData, selectReportStatus,
  selectFilters, selectFavorites,
  closeReport, setFilter, toggleFavorite, loadReportData,
} from '../../features/reports/reportsSlice.js';
import { selectActiveClient } from '../../features/clients/clientsSlice.js';
import { resolvePresetRange } from '../../features/reports/data/dateRanges.js';
import { fmt, currencySymbol } from '../../utils/fmt.js';
import { cn } from '../../utils/classNames.js';

const XERO_BLUE = '#1A73E8';

// Period extension — yearly mode (fiscal year columns)
// Negative values = previous years, positive = future years
const FUTURE_PERIODS_YEARLY = [
  ['-5', 'Previous 5 years'],
  ['-3', 'Previous 3 years'],
  ['-2', 'Previous 2 years'],
  ['-1', 'Previous 1 year'],
  ['0',  'No extra periods'],
  ['1',  'Next 1 year'],
  ['2',  'Next 2 years'],
  ['3',  'Next 3 years'],
  ['5',  'Next 5 years'],
];
// Future periods — monthly mode
const FUTURE_PERIODS_MONTHLY = [
  ['0',  'No future periods'],
  ['2',  'Next 2 periods'],
  ['5',  'Next 5 periods'],
  ['11', 'Next 11 periods'],
  ['23', 'Next 23 periods'],
];

const BUDGETS = ['Overall Budget'];

const XERO_PERIODS = [
  ['this-month',           'This month'],
  ['previous-month',       'Last month'],
  ['this-quarter',         'This quarter'],
  ['previous-quarter',     'Last quarter'],
  ['this-fiscal-year',     'This financial year'],
  ['previous-fiscal-year', 'Last financial year'],
  ['custom',               'Custom'],
];
const PERIOD_LABELS = Object.fromEntries(XERO_PERIODS);

const fieldCls =
  'h-9 px-3 rounded-md bg-white dark:bg-navy-900 border border-navy-300 dark:border-navy-700 text-[13px] text-navy-900 dark:text-white outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20';

const prettyDate = (s) => {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
};

function fmtCell(v, sym) {
  if (v == null || Number.isNaN(v) || v === 0) return '-';
  const s = fmt(Math.abs(v), { dec: 0, sign: sym });
  return v < 0 ? `(${s})` : s;
}

export default function BudgetSummaryViewer() {
  const dispatch = useDispatch();
  const report = useSelector(selectOpenReport);
  const data = useSelector(selectReportData);
  const status = useSelector(selectReportStatus);
  const client = useSelector(selectActiveClient);
  const filters = useSelector(selectFilters);
  const favorites = useSelector(selectFavorites);

  const [future, setFuture] = useState('0');
  const [budget, setBudget] = useState('Overall Budget');

  const favorited = !!favorites[report.name];
  const loading = status === 'loading';
  const sym = currencySymbol(data?.currency);

  const range = useMemo(
    () => resolvePresetRange(filters.dateRange, { from: filters.customFrom, to: filters.customTo }),
    [filters.dateRange, filters.customFrom, filters.customTo],
  );
  const fromVal = filters.customFrom || range.from_date;
  const toVal = filters.customTo || range.to_date;
  const budgetName = data?.budgetName || budget;

  // Detect period mode from backend response
  const isYearly = data?.period === 'yearly';
  const FUTURE_PERIODS = isYearly ? FUTURE_PERIODS_YEARLY : FUTURE_PERIODS_MONTHLY;

  // Extend the date range based on the `future` dropdown:
  //  • Positive value → extend to_date forward (Next X years)
  //  • Negative value → extend from_date backward (Previous X years)
  const { extendedFromDate, extendedToDate } = useMemo(() => {
    const n = Number(future || 0);
    if (n === 0 || isYearly === false) return { extendedFromDate: fromVal, extendedToDate: toVal };

    const fmt = (d) => {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    };

    if (n > 0 && toVal) {
      // Future: extend to_date forward
      const d = new Date(toVal);
      if (!Number.isNaN(d.getTime())) {
        d.setFullYear(d.getFullYear() + n);
        return { extendedFromDate: fromVal, extendedToDate: fmt(d) };
      }
    }
    if (n < 0 && fromVal) {
      // Previous: extend from_date backward
      const d = new Date(fromVal);
      if (!Number.isNaN(d.getTime())) {
        d.setFullYear(d.getFullYear() + n); // n is negative
        return { extendedFromDate: fmt(d), extendedToDate: toVal };
      }
    }
    return { extendedFromDate: fromVal, extendedToDate: toVal };
  }, [fromVal, toVal, future, isYearly]);

  const runReport = () => dispatch(loadReportData({
    reportName: report.name,
    clientId: client?.id,
    provider: report.provider,
    filters: { period: 'yearly', from_date: extendedFromDate, to_date: extendedToDate },
  }));

  const initialLoad = useRef(true);
  useEffect(() => {
    if (initialLoad.current && !data && status === 'idle') {
      runReport();
      initialLoad.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-run when future period count changes and data is already loaded
  const prevFuture = useRef(future);
  useEffect(() => {
    if (prevFuture.current !== future && data) {
      prevFuture.current = future;
      runReport();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [future]);

  // Auto re-run when the date range changes (after the initial mount load) so
  // the date pickers / presets actually refresh the report.
  const filterMounted = useRef(false);
  useEffect(() => {
    if (!filterMounted.current) { filterMounted.current = true; return; }
    runReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.dateRange, filters.customFrom, filters.customTo]);

  // ── Build value columns ──
  const valueCols = useMemo(() => {
    if (!data?.columns) return [{ key: 'total', label: 'Total' }];

    // Backend already returns the correct number of columns based on the
    // extended to_date. Just read all period columns + Total.
    if (isYearly && data.period === 'yearly') {
      const periodCols = data.columns.filter(c => c.key !== 'label' && c.key !== 'total');
      return [...periodCols, { key: 'total', label: 'Total' }];
    }

    // Monthly fallback
    const periodCount = Math.min(24, Math.max(1, 1 + Number(future || 0)));
    const startDate = fromVal ? new Date(fromVal) : new Date(2026, 0, 1);
    const startMonth = Number.isNaN(startDate.getTime()) ? 0 : startDate.getMonth();
    const startYear = Number.isNaN(startDate.getTime()) ? 2026 : startDate.getFullYear();
    const monthCols = Array.from({ length: periodCount }, (_, i) => {
      const d = new Date(startYear, startMonth + i, 1);
      const label = d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
      return { key: `m${i + 1}`, label, srcKey: `m${i + 1}` };
    });
    return [...monthCols, { key: 'total', label: 'Total' }];
  }, [data?.columns, data?.period, future, fromVal, isYearly]);

  // Show the EXTENDED period in the header so the user sees the full range.
  const periodDisplay = useMemo(() => ({
    from: extendedFromDate || fromVal,
    to: extendedToDate || toVal,
  }), [extendedFromDate, extendedToDate, fromVal, toVal]);

  const cellValue = (r, col) => {
    if (!r.cells) return undefined;
    if (col.key === 'total') {
      return valueCols
        .filter(c => c.key !== 'total')
        .reduce((acc, c) => acc + (r.cells[c.key] || r.cells[c.srcKey] || 0), 0);
    }
    return r.cells[col.key] ?? r.cells[col.srcKey];
  };

  const rows = data?.rows || [];
  const rowPad = 'py-1';

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
        <div className="flex items-center gap-2 shrink-0">
          <ExportMenu
            meta={{ company: client?.name, from: periodDisplay.from, to: periodDisplay.to }}
            trigger={(
              <button type="button" className="h-8 px-2.5 rounded-md border border-navy-200 dark:border-navy-700 text-navy-700 dark:text-navy-200 hover:bg-navy-50 dark:hover:bg-navy-800 inline-flex items-center gap-1 text-[12.5px] font-semibold">
                Export <ChevronDown size={13} />
              </button>
            )}
          />
        </div>
      </header>

      {/* Filter bar */}
      <div className="border-b border-navy-200 dark:border-navy-800 bg-white dark:bg-navy-950 px-4 sm:px-6 py-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 items-end gap-x-4 gap-y-3">
          {/* Date range */}
          <div className="shrink-0">
            <div className="text-[11px] text-navy-500 dark:text-navy-400 mb-1">
              Date range: <span className="font-semibold text-navy-700 dark:text-navy-200">{PERIOD_LABELS[filters.dateRange] || 'Custom'}</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={fromVal || ''}
                onChange={(e) => dispatch(setFilter({ customFrom: e.target.value, dateRange: 'custom' }))}
                className={fieldCls}
              />
              <input
                type="date"
                value={toVal || ''}
                onChange={(e) => dispatch(setFilter({ customTo: e.target.value, dateRange: 'custom' }))}
                className={fieldCls}
              />
              <Popover
                align="start"
                width={220}
                trigger={(
                  <button type="button" className="h-9 w-9 grid place-items-center rounded-md border border-navy-300 dark:border-navy-700 text-navy-600 hover:bg-navy-50 dark:hover:bg-navy-800" aria-label="Date range presets">
                    <ChevronDown size={16} />
                  </button>
                )}
              >
                {({ close }) => (
                  <div className="flex flex-col">
                    {XERO_PERIODS.map(([v, l]) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => { dispatch(setFilter(v === 'custom' ? { dateRange: v } : { dateRange: v, customFrom: '', customTo: '' })); close(); }}
                        className={cn(
                          'text-left px-3 py-1.5 rounded-md text-[13px] hover:bg-navy-50 dark:hover:bg-navy-800',
                          filters.dateRange === v ? 'font-semibold text-sky-700 dark:text-sky-300' : 'text-navy-700 dark:text-navy-200',
                        )}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                )}
              </Popover>
            </div>
          </div>

          {/* Future periods to show */}
          <div className="shrink-0">
            <div className="text-[11px] text-navy-500 dark:text-navy-400 mb-1">Future periods to show</div>
            <select value={future} onChange={(e) => setFuture(e.target.value)} className={cn(fieldCls, 'w-full')}>
              {FUTURE_PERIODS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>

          {/* Budget */}
          <div className="shrink-0">
            <div className="text-[11px] text-navy-500 dark:text-navy-400 mb-1">Budget</div>
            <select value={budget} onChange={(e) => setBudget(e.target.value)} className={cn(fieldCls, 'w-full')}>
              {BUDGETS.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={runReport}
            className="h-9 px-4 rounded-md text-white text-[13px] font-semibold shadow-soft hover:opacity-95 shrink-0 justify-self-start"
            style={{ background: XERO_BLUE }}
          >
            Update
          </button>
        </div>
      </div>

      {/* Report sheet */}
      <div className="flex-1 min-h-0 overflow-y-auto scroll-thin bg-navy-50/40 dark:bg-navy-950">
        <div className="p-4 sm:p-6 lg:p-8">
          <div className="max-w-[1500px] mx-auto bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-800 rounded-lg shadow-card px-5 sm:px-8 py-8">
            <div className="mb-6">
              <div className="text-[20px] font-bold text-navy-900 dark:text-white leading-tight">{report.name} - {budgetName}</div>
              <div className="text-[13px] text-navy-700 dark:text-navy-200 mt-1">{data?.meta?.company || client?.name || 'Oremus'}</div>
              <div className="text-[12.5px] text-navy-500">For the period {prettyDate(periodDisplay.from)} to {prettyDate(periodDisplay.to)}</div>
              <div className="text-[12.5px] text-navy-500">{budgetName}</div>
            </div>

            {loading || !data ? (
              <ReportSkeleton />
            ) : (
              <div className="overflow-auto scroll-thin max-h-[calc(100vh-15rem)]">
                <table className="w-full text-[12.5px] min-w-[1100px]">
                  <thead>
                    <tr className="text-[11.5px] text-navy-500 dark:text-navy-400">
                      <th className="sticky top-0 z-20 bg-white dark:bg-navy-900 border-b border-navy-200 dark:border-navy-700 text-left font-semibold py-2 pr-4" />
                      {valueCols.map((c) => (
                        <th key={c.key} className="sticky top-0 z-20 bg-white dark:bg-navy-900 border-b border-navy-200 dark:border-navy-700 text-right font-semibold py-2 px-3 whitespace-nowrap">{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      if (r.level === 0 && !r.isSubtotal && !r.isTotal) {
                        return (
                          <tr key={i}>
                            <td colSpan={valueCols.length + 1} className="pt-4 pb-1 text-[13.5px] font-bold text-navy-900 dark:text-white">{r.label}</td>
                          </tr>
                        );
                      }
                      const emph = r.isSubtotal || r.isTotal;
                      return (
                        <tr
                          key={i}
                          className={cn(
                            'border-b border-navy-100 dark:border-navy-800',
                            r.isTotal && 'border-t-2 border-navy-300 dark:border-navy-600 font-bold',
                            r.isSubtotal && 'font-semibold',
                          )}
                        >
                          <td className={cn(rowPad, 'pr-4 text-navy-700 dark:text-navy-200', emph ? 'pl-2' : 'pl-5')}>{r.label}</td>
                          {valueCols.map((c) => (
                            <td key={c.key} className={cn(rowPad, 'px-3 text-right tabular-nums whitespace-nowrap text-navy-800 dark:text-navy-100')}>
                              {fmtCell(cellValue(r, c), sym)}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

    </>
  );
}
