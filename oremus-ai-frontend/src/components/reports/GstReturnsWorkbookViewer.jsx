// Zoho-Books-native viewer for the "GST Returns Workbook" (GSTR-3B Summary).
// Unlike the single-table ZohoDetailReportViewer, this report is a multi-section
// workbook: each numbered section (3.1, 3.1.1, 3.2, 4, 5 …) is its own table
// with a tinted numbered header row. It reuses the Zoho chrome (breadcrumb
// module header, "Filters :" bar, Table/Chart sub-bar) and renders the
// generator's `data.sections` array.

import { useEffect, useMemo, useState, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  ArrowLeft, X, ChevronDown, Plus, RefreshCw,
  SlidersHorizontal, CalendarClock, Table2, BarChart3,
} from 'lucide-react';
import Popover from '../ui/Popover.jsx';
import ExportMenu from './ExportMenu.jsx';
import ReportSkeleton from './ReportSkeleton.jsx';
import {
  selectOpenReport, selectReportData, selectReportStatus,
  selectFilters,
  closeReport, setFilter, loadReportData,
} from '../../features/reports/reportsSlice.js';
import { selectActiveClient } from '../../features/clients/clientsSlice.js';
import { resolvePresetRange } from '../../features/reports/data/dateRanges.js';
import { fmt } from '../../utils/fmt.js';
import { cn } from '../../utils/classNames.js';

const ZOHO_BLUE = '#2563eb';

const ZOHO_PERIODS = [
  ['this-month',           'This Month'],
  ['previous-month',       'Previous Month'],
  ['this-quarter',         'This Quarter'],
  ['previous-quarter',     'Previous Quarter'],
  ['this-fiscal-year',     'This Year'],
  ['previous-fiscal-year', 'Previous Year'],
  ['custom',               'Custom'],
];
const PERIOD_LABELS = Object.fromEntries(ZOHO_PERIODS);

const fieldCls =
  'h-9 px-3 rounded-md bg-white dark:bg-navy-900 border border-navy-300 dark:border-navy-700 text-[13px] text-navy-900 dark:text-white outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20';

function dmy(s) {
  if (!s) return '';
  const [y, m, d] = String(s).split('-');
  if (!y || !m || !d) return s;
  return `${d}/${m}/${y}`;
}

// Header-tint classes for numbered "1 2 3 …" column rows.
const TINTS = {
  blue: 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300',
  orange: 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300',
};

export default function GstReturnsWorkbookViewer() {
  const dispatch = useDispatch();
  const report = useSelector(selectOpenReport);
  const data = useSelector(selectReportData);
  const status = useSelector(selectReportStatus);
  const client = useSelector(selectActiveClient);
  const filters = useSelector(selectFilters);

  const loading = status === 'loading';
  const sections = data?.sections || [];
  const currency = data?.currency || 'INR';

  const [view, setView] = useState('table');

  const range = useMemo(
    () => resolvePresetRange(filters.dateRange, { from: filters.customFrom, to: filters.customTo }),
    [filters.dateRange, filters.customFrom, filters.customTo],
  );
  const fromVal = filters.customFrom || range.from_date;
  const toVal = filters.customTo || range.to_date;

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

  const title = data?.title || report.name;
  const rangeText = `From ${dmy(fromVal)} To ${dmy(toVal)}`;

  return (
    <>
      {/* Top header */}
      <header className="border-b border-navy-200 dark:border-navy-800 bg-white dark:bg-navy-950 px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => dispatch(closeReport())}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-sky-700 dark:text-sky-300 hover:underline shrink-0"
            aria-label="Back to all reports"
          >
            <ArrowLeft size={14} />
            Back to all reports
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[13.5px] text-navy-900 dark:text-white truncate">
              <span className="font-bold">{title}</span>
              <span className="text-navy-300">•</span>
              <span className="text-navy-500 dark:text-navy-400">{rangeText}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <ExportMenu
            meta={{ company: client?.name, from: fromVal, to: toVal }}
            trigger={(
              <button type="button" className="h-8 px-2.5 rounded-md border border-navy-200 dark:border-navy-700 text-navy-700 dark:text-navy-200 hover:bg-navy-50 dark:hover:bg-navy-800 inline-flex items-center gap-1 text-[12.5px] font-semibold">
                Export <ChevronDown size={13} />
              </button>
            )}
          />
        
        </div>
      </header>

      {/* Zoho "Filters :" bar */}
      <div className="border-b border-navy-200 dark:border-navy-800 bg-white dark:bg-navy-950 px-4 sm:px-6 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <span className="text-[12.5px] font-semibold text-navy-500 dark:text-navy-400">Filters :</span>
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] text-navy-600 dark:text-navy-300">Date Range :</span>
            <Popover
              align="start"
              width={200}
              trigger={(
                <button type="button" className="h-9 px-3 rounded-md border border-navy-300 dark:border-navy-700 text-navy-700 dark:text-navy-200 hover:bg-navy-50 dark:hover:bg-navy-800 inline-flex items-center gap-2 text-[13px] font-semibold">
                  {PERIOD_LABELS[filters.dateRange] || 'Custom'} <ChevronDown size={15} />
                </button>
              )}
            >
              {({ close }) => (
                <div className="flex flex-col">
                  {ZOHO_PERIODS.map(([v, l]) => (
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
            {filters.dateRange === 'custom' && (
              <>
                <input type="date" value={fromVal || ''} onChange={(e) => dispatch(setFilter({ customFrom: e.target.value, dateRange: 'custom' }))} className={fieldCls} />
                <input type="date" value={toVal || ''} onChange={(e) => dispatch(setFilter({ customTo: e.target.value, dateRange: 'custom' }))} className={fieldCls} />
              </>
            )}
          </div>

          <button type="button" className="h-9 px-3 rounded-md border border-navy-300 dark:border-navy-700 text-navy-700 dark:text-navy-200 hover:bg-navy-50 dark:hover:bg-navy-800 inline-flex items-center gap-1.5 text-[12.5px] font-semibold">
            <Plus size={15} /> More Filters
          </button>

          <div className="grow" />

          <button
            type="button"
            onClick={runReport}
            className="h-9 px-4 rounded-md text-white text-[13px] font-semibold shadow-soft hover:opacity-95 shrink-0"
            style={{ background: ZOHO_BLUE }}
          >
            Run Report
          </button>
        </div>
      </div>

      {/* Sub-bar */}
      <div className="border-b border-navy-200 dark:border-navy-800 bg-navy-50/60 dark:bg-navy-900/60 px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md border border-navy-300 dark:border-navy-700 overflow-hidden">
          <button
            type="button"
            onClick={() => setView('table')}
            className={cn('h-8 px-3 inline-flex items-center gap-1.5 text-[12.5px] font-semibold', view === 'table' ? 'bg-sky-600 text-white' : 'text-navy-600 dark:text-navy-300 hover:bg-navy-50 dark:hover:bg-navy-800')}
          >
            <Table2 size={14} /> Table View
          </button>
          <button
            type="button"
            onClick={() => setView('chart')}
            className={cn('h-8 px-3 inline-flex items-center gap-1.5 text-[12.5px] font-semibold border-l border-navy-300 dark:border-navy-700', view === 'chart' ? 'bg-sky-600 text-white' : 'text-navy-600 dark:text-navy-300 hover:bg-navy-50 dark:hover:bg-navy-800')}
          >
            <BarChart3 size={14} /> Chart View
          </button>
        </div>
      </div>

      {/* Report sheet */}
      <div className="flex-1 min-h-0 overflow-y-auto scroll-thin bg-navy-50/40 dark:bg-navy-950">
        <div className="p-4 sm:p-6 lg:p-8">
          <div className="max-w-[1100px] mx-auto bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-800 rounded-lg shadow-card px-5 sm:px-10 py-8">
            <div className="text-center mb-6">
              <div className="text-[18px] font-bold text-navy-900 dark:text-white leading-tight">{data?.meta?.company || client?.name || 'Oremus'}</div>
              <div className="text-[15px] font-semibold text-navy-800 dark:text-navy-100 mt-0.5">{title}</div>
              <div className="text-[12.5px] text-navy-500 mt-0.5">{rangeText}</div>
            </div>

            {data?.meta?.note ? (
              <div className="mb-6 rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-900/20 px-4 py-2.5 text-[12px] leading-snug text-amber-800 dark:text-amber-200">
                {data.meta.note}
              </div>
            ) : null}

            {loading || !data ? (
              <ReportSkeleton />
            ) : (
              <div className="space-y-8">
                {sections.map((s, si) => (
                  <Section key={si} section={s} currency={currency} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function Section({ section, currency }) {
  const { no, title, columns, rows, tint = 'blue' } = section;
  const tintCls = TINTS[tint] || TINTS.blue;
  const ncols = columns.length;

  return (
    <div>
      <div className="text-[13.5px] font-bold text-navy-900 dark:text-white mb-2">
        {no} {title}
      </div>
      <table className="w-full text-[13px] border border-navy-200 dark:border-navy-700">
        <thead>
          {/* Column labels */}
          <tr className="text-[11.5px] uppercase tracking-wide text-navy-500 dark:text-navy-400 [&>th]:sticky [&>th]:top-0 [&>th]:z-20 [&>th]:bg-white dark:[&>th]:bg-navy-900 [&>th]:border-b [&>th]:border-navy-200 dark:[&>th]:border-navy-700">
            {columns.map((c, ci) => (
              <th key={ci} className={cn('font-semibold py-2 px-3 align-bottom', ci === 0 ? 'text-left' : 'text-right')}>{c}</th>
            ))}
          </tr>
          {/* Numbered "1 2 3 …" tinted row */}
          <tr className={cn('text-[11.5px] font-semibold', tintCls)}>
            {columns.map((c, ci) => (
              <td key={ci} className={cn('py-1 px-3 border-b border-navy-200 dark:border-navy-700', ci === 0 ? 'text-left' : 'text-right')}>{ci + 1}</td>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => {
            if (r.subhead) {
              return (
                <tr key={ri} className="border-b border-navy-100 dark:border-navy-800 bg-navy-50/50 dark:bg-navy-800/40">
                  <td colSpan={ncols} className="py-2 px-3 text-left font-semibold text-navy-800 dark:text-navy-100">{r.subhead}</td>
                </tr>
              );
            }
            if (r.fullNote) {
              return (
                <tr key={ri} className="border-b border-navy-100 dark:border-navy-800">
                  <td colSpan={ncols} className="py-3 px-3 text-center text-navy-500 dark:text-navy-400 italic">{r.fullNote}</td>
                </tr>
              );
            }
            if (r.spanNote) {
              return (
                <tr key={ri} className="border-b border-navy-100 dark:border-navy-800">
                  <td className="py-2 px-3 text-left text-navy-800 dark:text-navy-100">{r.label}</td>
                  <td colSpan={ncols - 1} className="py-2 px-3 text-center text-navy-500 dark:text-navy-400">{r.spanNote}</td>
                </tr>
              );
            }
            return (
              <tr key={ri} className={cn('border-b border-navy-100 dark:border-navy-800', r.bold && 'font-bold')}>
                {r.cells.map((val, ci) => (
                  <td
                    key={ci}
                    className={cn(
                      'py-2 px-3',
                      ci === 0 ? 'text-left' : 'text-right tabular-nums',
                      r.bold ? 'text-navy-900 dark:text-white' : 'text-navy-800 dark:text-navy-100',
                    )}
                  >
                    {ci === 0 ? val : formatCell(val, currency)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Numbers render as currency (₹0.00); strings (plain "0", blanks) render as-is.
function formatCell(val, currency) {
  if (val == null || val === '') return '';
  if (typeof val === 'number') return fmt(val, { dec: 2, currency });
  return val;
}
