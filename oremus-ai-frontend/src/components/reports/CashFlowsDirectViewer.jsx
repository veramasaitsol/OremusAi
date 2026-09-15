// Xero-style viewer for the "Statement of Cash Flows - Direct" report ONLY.
// Every other report uses the common QBO-style QBReportViewer; ReportViewerModal
// routes this report here so its filter bar + report sheet mirror Xero's
// Statement of Cash Flows (Date range / Compare with / More / Update, and a
// single period column with Net Cash Flows + Cash and Cash Equivalents).

import { useEffect, useMemo, useRef } from 'react';
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

// Xero "Date range" presets — keys MUST resolve in resolvePresetRange.
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

// Format a value for currency (parentheses for negatives, Xero-style).
function fmtCell(v, sym) {
  if (v == null || Number.isNaN(v)) return '–';
  const s = fmt(Math.abs(v), { dec: 2, sign: sym });
  return v < 0 ? `(${s})` : s;
}

export default function CashFlowsDirectViewer() {
  const dispatch = useDispatch();
  const report = useSelector(selectOpenReport);
  const data = useSelector(selectReportData);
  const status = useSelector(selectReportStatus);
  const client = useSelector(selectActiveClient);
  const filters = useSelector(selectFilters);
  const favorites = useSelector(selectFavorites);


  const favorited = !!favorites[report.name];
  const loading = status === 'loading';
  const sym = currencySymbol(data?.currency);

  const range = useMemo(
    () => resolvePresetRange(filters.dateRange, { from: filters.customFrom, to: filters.customTo }),
    [filters.dateRange, filters.customFrom, filters.customTo],
  );
  const fromVal = filters.customFrom || range.from_date;
  const toVal = filters.customTo || range.to_date;
  const endDate = toVal ? new Date(toVal) : new Date();
  const curLabel = endDate.toLocaleString('en-US', { month: 'short', year: 'numeric' });
  const endedText = endDate.toLocaleString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });

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

  const rows = data?.rows || [];
  const rowPad = 'py-1.5';

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
            meta={{ company: client?.name, from: fromVal, to: toVal }}
            trigger={(
              <button type="button" className="h-8 px-2.5 rounded-md border border-navy-200 dark:border-navy-700 text-navy-700 dark:text-navy-200 hover:bg-navy-50 dark:hover:bg-navy-800 inline-flex items-center gap-1 text-[12.5px] font-semibold">
                Export <ChevronDown size={13} />
              </button>
            )}
          />
          <button
            type="button"
            onClick={() => dispatch(closeReport())}
            aria-label="Close"
            className="h-8 w-8 grid place-items-center rounded-md border border-navy-200 dark:border-navy-700 text-navy-500 hover:bg-navy-50 dark:hover:bg-navy-800"
          >
            <X size={15} />
          </button>
        </div>
      </header>

      {/* Xero-style filter bar */}
      <div className="border-b border-navy-200 dark:border-navy-800 bg-white dark:bg-navy-950 px-4 sm:px-6 py-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 items-end gap-x-4 gap-y-3">
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
                        onClick={() => { dispatch(setFilter({ dateRange: v })); close(); }}
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

          <div className="shrink-0">
            <div className="text-[11px] text-navy-500 dark:text-navy-400 mb-1">Compare with</div>
            <select disabled value="none" className={cn(fieldCls, 'w-[160px] text-navy-500')}>
              <option value="none">None</option>
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
          <div className="max-w-[1100px] mx-auto bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-800 rounded-lg shadow-card px-5 sm:px-10 py-8">
            <div className="mb-6">
              <div className="text-[22px] font-bold text-navy-900 dark:text-white leading-tight">{report.name}</div>
              <div className="text-[13px] text-navy-700 dark:text-navy-200 mt-1">{data?.meta?.company || client?.name || 'Oremus'}</div>
              <div className="text-[12.5px] text-navy-500">For the month ended {endedText}</div>
            </div>

            {loading || !data ? (
              <ReportSkeleton />
            ) : (
              <table className="w-full text-[13px]">
                <thead>
                  {/* Band — Description | Amount header */}
                  <tr className="text-[12px] font-semibold text-navy-600 dark:text-navy-300 [&>th]:sticky [&>th]:top-0 [&>th]:z-20 [&>th]:bg-white dark:[&>th]:bg-navy-900">
                    <th className="text-left py-2 px-3">Description</th>
                    <th className="text-right py-2 px-3 w-[160px]">Amount</th>
                  </tr>
                  <tr className="text-[12px] text-navy-500 dark:text-navy-400 [&>th]:sticky [&>th]:top-[34px] [&>th]:z-20 [&>th]:bg-white dark:[&>th]:bg-navy-900 [&>th]:border-b [&>th]:border-navy-200 dark:[&>th]:border-navy-700">
                    <th className="text-left font-semibold py-1.5" />
                    <th className="text-right font-semibold py-1.5 pl-3">{curLabel}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    if (r.isHeader) {
                      return (
                        <tr key={i}>
                          <td colSpan={2} className="pt-4 pb-1 pl-3 text-[14px] font-bold text-navy-900 dark:text-white">{r.label}</td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={i} className="border-b border-navy-100 dark:border-navy-800 font-semibold">
                        <td className={cn(rowPad, 'pr-4 pl-3 text-navy-800 dark:text-navy-100')}>{r.label}</td>
                        <td className={cn(rowPad, 'pl-3 text-right tabular-nums text-navy-800 dark:text-navy-100')}>{fmtCell(r.cells.cur, sym)}</td>
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
