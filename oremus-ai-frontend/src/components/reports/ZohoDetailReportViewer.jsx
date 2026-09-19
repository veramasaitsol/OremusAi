// Zoho-Books-native viewer for Zoho "detail" reports (Credit Note Details,
// Recurring Invoice Details, …). Every other report uses the common QBO-style
// QBReportViewer; ReportViewerModal routes these reports here so their chrome
// mirrors Zoho Books exactly — a breadcrumb module header, a "Filters :" bar
// (Date Range, optional "Report By", More Filters, Run Report), a Table/Chart
// View + Group By + Customize Report Columns sub-bar, and a centered report
// sheet that shows Zoho's "no transactions" empty state.
//
// It is config-driven by the generator's `data.zoho` block
// ({ module, title, reportBy, customizeCount }) and `data.columns`, so one
// viewer serves every Zoho detail report.

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  ArrowLeft, X, ChevronDown, Plus, RefreshCw, ChevronRight,
  SlidersHorizontal, CalendarClock, Table2, BarChart3, Download,
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
import { exportRowsCSV } from '../../utils/exportReport.js';

const ZOHO_BLUE = '#2563eb';

// Breakdown drill-down pagination — an expanded levy row shows this many
// contributing documents at a time and pages through the rest (the backend
// sends the full list, largest first).
const BREAKDOWN_PAGE_SIZE = 10;

// Zoho Books "Date Range" presets — keys MUST resolve in resolvePresetRange.
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

// Format YYYY-MM-DD → DD/MM/YYYY (Zoho Indian display) using local components.
function dmy(s) {
  if (!s) return '';
  const [y, m, d] = String(s).split('-');
  if (!y || !m || !d) return s;
  return `${d}/${m}/${y}`;
}

export default function ZohoDetailReportViewer() {
  const dispatch = useDispatch();
  const report = useSelector(selectOpenReport);
  const data = useSelector(selectReportData);
  const status = useSelector(selectReportStatus);
  const client = useSelector(selectActiveClient);
  const filters = useSelector(selectFilters);

  const loading = status === 'loading';
  const zoho = data?.zoho || {};
  const columns = data?.columns || [];
  const rows = data?.rows || [];
  const currency = data?.currency || 'USD';

  const [reportBy, setReportBy] = useState(zoho.reportBy?.value || '');
  const [view, setView] = useState('table');
  const [expanded, setExpanded] = useState({});
  // Current page (0-based) of each expanded breakdown, keyed by row index.
  const [bdPage, setBdPage] = useState({});
  const toggleRow = (i) => {
    setExpanded((e) => ({ ...e, [i]: !e[i] }));
    // Re-opening a breakdown always lands on its first page.
    setBdPage((p) => ({ ...p, [i]: 0 }));
  };

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

  // Keep local "Report By" in sync once the report config loads.
  useEffect(() => {
    if (zoho.reportBy?.value) setReportBy(zoho.reportBy.value);
  }, [zoho.reportBy?.value]);

  // Fresh report data → collapse everything and restart each breakdown's pages.
  useEffect(() => {
    setExpanded({});
    setBdPage({});
  }, [data]);

  const title = zoho.title || report.name;
  const rangeText = `From ${dmy(fromVal)} To ${dmy(toVal)}`;

  return (
    <>
      {/* Top header: breadcrumb module + title + Zoho action icons */}
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

          {/* Date Range */}
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

          {/* Optional "Report By" */}
          {zoho.reportBy && (
            <div className="flex items-center gap-2">
              <span className="text-[12.5px] text-navy-600 dark:text-navy-300">{zoho.reportBy.label || 'Report By'} :</span>
              <select value={reportBy} onChange={(e) => setReportBy(e.target.value)} className={cn(fieldCls, 'font-semibold')}>
                {zoho.reportBy.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          )}

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

      {/* Sub-bar: Table/Chart View · Group By · Customize columns */}
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
        <div className="flex items-center gap-4 text-[12.5px] text-navy-600 dark:text-navy-300">
          <span>Group By : <span className="font-semibold text-navy-800 dark:text-navy-100">{zoho.groupBy || 'None'}</span></span>
          {zoho.compareWith && (
            <span>Compare With : <span className="font-semibold text-navy-800 dark:text-navy-100">None</span></span>
          )}
          <button type="button" className="inline-flex items-center gap-1.5 font-semibold text-sky-700 dark:text-sky-300 hover:underline">
            Customize Report Columns
            <span className="inline-grid place-items-center h-5 min-w-[20px] px-1 rounded-full bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300 text-[11px]">{zoho.customizeCount ?? columns.length}</span>
          </button>
        </div>
      </div>

      {/* Report sheet */}
      <div className="flex-1 min-h-0 overflow-y-auto scroll-thin bg-navy-50/40 dark:bg-navy-950">
        <div className="p-4 sm:p-6 lg:p-8">
          <div className="max-w-[1440px] mx-auto bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-800 rounded-xl shadow-card overflow-hidden">
            <div className="text-center px-5 sm:px-10 pt-8 pb-6 border-b border-navy-100 dark:border-navy-800">
              <div className="text-[18px] font-bold text-navy-900 dark:text-white leading-tight">{data?.meta?.company || client?.name || 'Oremus'}</div>
              <div className="text-[15px] font-semibold text-navy-800 dark:text-navy-100 mt-0.5">{title}</div>
              <div className="text-[12.5px] text-navy-500 mt-0.5">{rangeText}</div>
            </div>

            {loading || !data ? (
              <div className="px-5 sm:px-10 py-8"><ReportSkeleton /></div>
            ) : (
              <div className="overflow-auto scroll-thin max-h-[calc(100vh-15rem)]">
                <table className="w-full min-w-[720px] text-[13px] border-collapse">
                  <thead>
                    <tr className="text-[11.5px] uppercase tracking-wide text-navy-500 dark:text-navy-400">
                      {columns.map((c) => (
                        <th key={c.key} className={cn('sticky top-0 z-20 bg-white dark:bg-navy-900 border-b border-navy-200 dark:border-navy-700 font-semibold py-2.5 px-4 whitespace-nowrap', c.align === 'right' ? 'text-right' : 'text-left')}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={columns.length} className="py-16 text-center text-[13px] text-navy-500 dark:text-navy-400">
                          {zoho.emptyText || 'There are no transactions during the selected date range.'}
                        </td>
                      </tr>
                    ) : (
                      rows.map((r, i) => {
                        // A value row with a `breakdown` can be expanded to reveal
                        // the exact documents that make up its tax amount (same
                        // drill-down as Cash Summary). Long lists are paginated.
                        const bd = Array.isArray(r.breakdown) && r.breakdown.length ? r.breakdown : null;
                        const isOpen = !!expanded[i];
                        const bdTotal = bd ? (r.breakdownCount ?? bd.length) : 0;
                        const bdPages = Math.max(1, Math.ceil(bdTotal / BREAKDOWN_PAGE_SIZE));
                        const bdIdx = Math.min(bdPage[i] || 0, bdPages - 1);
                        const bdStart = bdIdx * BREAKDOWN_PAGE_SIZE;
                        const bdRows = bd ? bd.slice(bdStart, bdStart + BREAKDOWN_PAGE_SIZE) : [];
                        return (
                          <Fragment key={i}>
                            <tr
                              className={cn(
                                r.isTotal
                                  ? 'border-t-2 border-navy-300 dark:border-navy-600 font-bold bg-navy-50/60 dark:bg-navy-900/40'
                                  : cn(
                                      'border-b border-navy-100 dark:border-navy-800 transition-colors hover:bg-sky-50/60 dark:hover:bg-sky-900/10',
                                      bd && 'cursor-pointer',
                                      i % 2 === 1 && 'bg-navy-50/30 dark:bg-navy-900/20',
                                    ),
                              )}
                              onClick={bd ? () => toggleRow(i) : undefined}
                            >
                              {columns.map((c) => (
                                <td
                                  key={c.key}
                                  className={cn(
                                    'py-2.5 px-4',
                                    c.align === 'right' ? 'text-right tabular-nums' : 'text-left',
                                    r.isTotal ? 'text-navy-900 dark:text-white' : 'text-navy-800 dark:text-navy-100',
                                    c.key === columns[0].key && !r.sublabel && 'whitespace-nowrap',
                                  )}
                                >
                                  {c.key === columns[0].key ? (
                                    r.sublabel ? (
                                      <div>
                                        <div className="text-sky-700 dark:text-sky-300 font-medium">{r.label}</div>
                                        <div className="text-[11.5px] text-navy-500 dark:text-navy-400 mt-0.5">{r.sublabel}</div>
                                      </div>
                                    ) : (
                                      <span className="inline-flex items-center gap-1.5">
                                        {bd ? (
                                          <ChevronRight size={13} className={cn('text-navy-400 transition-transform shrink-0', isOpen && 'rotate-90')} />
                                        ) : null}
                                        <span>{r.label}</span>
                                        {bd ? (
                                          <span className="text-[11px] font-normal text-navy-400">
                                            ({r.breakdownCount ?? bd.length})
                                          </span>
                                        ) : null}
                                      </span>
                                    )
                                  ) : formatCell(r.cells?.[c.key], c, currency)}
                                </td>
                              ))}
                            </tr>
                            {bd && isOpen && (
                              <tr className="bg-navy-50/60 dark:bg-navy-900/40">
                                <td colSpan={columns.length} className="px-4 pb-3 pt-1">
                                  <div className="rounded-md border border-navy-200 dark:border-navy-700 overflow-hidden">
                                    <div className="px-3 py-1.5 border-b border-navy-100 dark:border-navy-800 flex items-center justify-end bg-navy-100/50 dark:bg-navy-800/50">
                                      <button
                                        type="button"
                                        onClick={() => exportRowsCSV(
                                          [
                                            'Date', hasEntryOrType ? 'Entry#' : 'Reference',
                                            hasEntryOrType ? 'Transaction Type' : 'Customer / Vendor',
                                            ...(hasTxnAmount ? ['Transaction Amount'] : []), 'Tax Amount',
                                          ],
                                          bd.map((b) => [
                                            b.date || '', b.ref || '', (hasEntryOrType ? b.type : b.source) || '',
                                            ...(hasTxnAmount ? [b.txnAmount ?? ''] : []), b.amount ?? '',
                                          ]),
                                          `${r.cells?.taxName || r.label || 'Breakdown'}`,
                                        )}
                                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-navy-600 dark:text-navy-300 hover:text-brand-600"
                                      >
                                        <Download size={12} /> Export
                                      </button>
                                    </div>
                                    <table className="w-full text-[12px]">
                                      <thead>
                                        <tr className="text-navy-500 dark:text-navy-400 bg-navy-100/50 dark:bg-navy-800/50">
                                          <th className="text-left font-semibold py-1.5 px-3">Date</th>
                                          <th className="text-left font-semibold py-1.5 px-3">Reference</th>
                                          <th className="text-left font-semibold py-1.5 px-3">Customer / Vendor</th>
                                          <th className="text-right font-semibold py-1.5 px-3">Tax Amount</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {bdRows.map((b, j) => (
                                          <tr key={j} className="border-t border-navy-100 dark:border-navy-800">
                                            <td className="py-1.5 px-3 text-navy-700 dark:text-navy-200 tabular-nums">{b.date || '–'}</td>
                                            <td className="py-1.5 px-3 text-navy-700 dark:text-navy-200">{b.ref || '–'}</td>
                                            <td className="py-1.5 px-3 text-navy-600 dark:text-navy-300">{b.source || '–'}</td>
                                            <td className="py-1.5 px-3 text-right tabular-nums text-navy-800 dark:text-navy-100">{formatCell(b.amount, { money: true }, currency)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                    {bdTotal > BREAKDOWN_PAGE_SIZE && (
                                      <div className="px-3 py-1.5 border-t border-navy-100 dark:border-navy-800 flex flex-wrap items-center justify-between gap-2 bg-navy-50/60 dark:bg-navy-900/60">
                                        <span className="text-[11px] text-navy-500 dark:text-navy-400">
                                          Showing {bdStart + 1}–{Math.min(bdStart + BREAKDOWN_PAGE_SIZE, bdTotal)} of {bdTotal} documents
                                        </span>
                                        <div className="flex items-center gap-2">
                                          <button
                                            type="button"
                                            disabled={bdIdx === 0}
                                            onClick={() => setBdPage((p) => ({ ...p, [i]: bdIdx - 1 }))}
                                            className="h-6 px-2 rounded-md border border-navy-200 dark:border-navy-700 text-[11px] font-semibold text-navy-600 dark:text-navy-300 hover:bg-white dark:hover:bg-navy-800 disabled:opacity-40 disabled:cursor-not-allowed"
                                          >
                                            ← Prev
                                          </button>
                                          <span className="text-[11px] text-navy-500 dark:text-navy-400 tabular-nums">Page {bdIdx + 1} of {bdPages}</span>
                                          <button
                                            type="button"
                                            disabled={bdIdx >= bdPages - 1}
                                            onClick={() => setBdPage((p) => ({ ...p, [i]: bdIdx + 1 }))}
                                            className="h-6 px-2 rounded-md border border-navy-200 dark:border-navy-700 text-[11px] font-semibold text-navy-600 dark:text-navy-300 hover:bg-white dark:hover:bg-navy-800 disabled:opacity-40 disabled:cursor-not-allowed"
                                          >
                                            Next →
                                          </button>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {!loading && data && rows.length > 0 && zoho.totalCount != null && (
              <div className="px-5 sm:px-10 py-3.5 flex items-center justify-between border-t border-navy-200 dark:border-navy-800 text-[12.5px] text-navy-500 dark:text-navy-400 bg-navy-50/40 dark:bg-navy-900/30">
                <span>Total Count : <span className="font-semibold text-navy-800 dark:text-navy-100">{zoho.totalCount}</span></span>
                <span>1 - {zoho.totalCount}</span>
              </div>
            )}

            {!loading && data && zoho.baseCurrencyNote && (
              <div className="px-5 sm:px-10 pb-6 pt-4 flex items-center gap-1.5 text-[12px] text-navy-500 dark:text-navy-400">
                **Amount is displayed in your base currency
                <span className="inline-grid place-items-center h-4 px-1.5 rounded bg-emerald-600 text-white text-[10px] font-semibold tracking-wide">{currency}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// Render a data cell. `money` columns get the report's currency symbol + 2
// decimals; other numeric values get plain 2-decimal grouping (e.g. quantity);
// null/blank stays blank (matches Zoho's empty Average Price on the Total row).
function formatCell(val, col, currency) {
  if (val == null || val === '') return '';
  if (typeof val === 'number') {
    if (col.money) return fmt(val, { dec: 2, currency });
    return fmt(val, { dec: 2, sign: '', currency });
  }
  return val;
}
