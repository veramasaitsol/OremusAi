// Xero-style viewer for the Cash Summary report ONLY. Every other report uses
// the common QBO-style QBReportViewer; ReportViewerModal routes the open
// "Cash Summary" report here so its filter bar + report sheet mirror Xero's
// Cash Summary (Date range / Compare with / More / Update, a "View cash graphs"
// link, and a Period / Average (YTD) / Variance table of bold cash lines).

import { Fragment, useEffect, useMemo, useState, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  ArrowLeft, Star, X, ChevronDown, ChevronRight,
  LineChart, ArrowUp, ArrowDown,
} from 'lucide-react';
import Popover from '../ui/Popover.jsx';
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

// Breakdown drill-down pagination — an expanded row shows this many
// contributing transactions at a time and pages through the rest (the backend
// sends the full list, largest first).
const BREAKDOWN_PAGE_SIZE = 10;

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

// Xero "Compare with" options for Cash Summary.
const COMPARE_OPTIONS = [
  ['average', 'Average'],
  ['none',    'None'],
];

const fieldCls =
  'h-9 px-3 rounded-md bg-white dark:bg-navy-900 border border-navy-300 dark:border-navy-700 text-[13px] text-navy-900 dark:text-white outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20';

// Format a value for currency (parentheses for negatives, Xero-style).
function fmtCell(v, sym) {
  if (v == null || Number.isNaN(v)) return '–';
  const s = fmt(Math.abs(v), { dec: 2, sign: sym });
  return v < 0 ? `(${s})` : s;
}

function VarCell({ v, sym }) {
  if (v == null || Number.isNaN(v) || v === 0) return <span className="text-navy-400">–</span>;
  const up = v > 0;
  return (
    <span className={cn('inline-flex items-center justify-end gap-1', up ? 'text-emerald-600' : 'text-rose-600')}>
      {up ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
      {fmtCell(Math.abs(v), sym)}
    </span>
  );
}

function groupedBreakdown(row) {
  if (Array.isArray(row?.breakdownGroups) && row.breakdownGroups.length) return row.breakdownGroups;
  const flat = Array.isArray(row?.breakdown) ? row.breakdown : [];
  const groups = new Map();
  flat.forEach((entry) => {
    const label = entry.source || 'Unspecified cash account';
    const current = groups.get(label) || { label, amount: 0, transactions: [] };
    current.amount += Number(entry.amount) || 0;
    current.transactions.push(entry);
    groups.set(label, current);
  });
  return [...groups.values()]
    .map((group) => ({
      ...group,
      transactions: [...group.transactions].sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)),
      transactionCount: group.transactions.length,
      transactionTruncated: false,
    }))
    .sort((a, b) => b.amount - a.amount);
}

export default function CashSummaryViewer() {
  const dispatch = useDispatch();
  const report = useSelector(selectOpenReport);
  const data = useSelector(selectReportData);
  const status = useSelector(selectReportStatus);
  const client = useSelector(selectActiveClient);
  const filters = useSelector(selectFilters);
  const favorites = useSelector(selectFavorites);

  const [compareWith, setCompareWith] = useState('average');
  const [expanded, setExpanded] = useState({});
  const [expandedGroups, setExpandedGroups] = useState({});
  // Current page (0-based) of each expanded breakdown, keyed by row index.
  const [bdPage, setBdPage] = useState({});
  const toggleRow = (i) => {
    setExpanded((e) => ({ ...e, [i]: !e[i] }));
    // Re-opening a breakdown always lands on its first page.
    setBdPage((p) => ({ ...p, [i]: 0 }));
  };
  const toggleGroup = (key) => {
    setExpandedGroups((g) => ({ ...g, [key]: !g[key] }));
    setBdPage((p) => ({ ...p, [key]: 0 }));
  };

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

  const showCompare = compareWith !== 'none';
  const colCount = showCompare ? 4 : 2;

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

  // Fresh report data → collapse everything and restart each breakdown's pages.
  useEffect(() => {
    setExpanded({});
    setExpandedGroups({});
    setBdPage({});
  }, [data]);

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
            <select
              value={compareWith}
              onChange={(e) => setCompareWith(e.target.value)}
              className={cn(fieldCls, 'w-full')}
            >
              {COMPARE_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
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
          <div className="max-w-[1100px] mx-auto bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-800 rounded-lg shadow-card px-5 sm:px-10 py-8">
            <div className="flex items-start justify-between gap-4 mb-6">
              <div>
                <div className="text-[22px] font-bold text-navy-900 dark:text-white leading-tight">{report.name}</div>
                <div className="text-[13px] text-navy-700 dark:text-navy-200 mt-1">{data?.meta?.company || client?.name || 'Oremus'}</div>
                <div className="text-[12.5px] text-navy-500">For the month ended {endedText}</div>
              </div>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-sky-700 dark:text-sky-300 hover:underline shrink-0"
              >
                <LineChart size={14} /> View cash graphs
              </button>
            </div>

            {loading || !data ? (
              <ReportSkeleton />
            ) : (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-[12px] text-navy-500 dark:text-navy-400 [&>th]:sticky [&>th]:top-0 [&>th]:z-20 [&>th]:bg-white dark:[&>th]:bg-navy-900 [&>th]:border-b [&>th]:border-navy-200 dark:[&>th]:border-navy-700">
                    <th className="text-left font-semibold py-2" />
                    <th className="text-right font-semibold py-2 px-3 w-[160px]">{curLabel}</th>
                    {showCompare && <th className="text-right font-semibold py-2 px-3 w-[150px]">Average (YTD)</th>}
                    {showCompare && <th className="text-right font-semibold py-2 pl-3 w-[130px]">Variance</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    if (r.isHeader) {
                      return (
                        <tr key={i}>
                          <td colSpan={colCount} className="pt-5 pb-1 text-[14px] font-bold text-navy-900 dark:text-white">{r.label}</td>
                        </tr>
                      );
                    }
                    // A value row with a `breakdown` can be expanded to reveal
                    // the cash-account totals behind its amount, and each cash
                    // account then drills further into its own transactions.
                    const groups = groupedBreakdown(r);
                    const bd = groups.length ? groups : null;
                    const isOpen = !!expanded[i];
                    return (
                      <Fragment key={i}>
                        <tr
                          className={cn(
                            'border-b border-navy-100 dark:border-navy-800 font-semibold',
                            bd && bd.length && 'cursor-pointer hover:bg-sky-50/60 dark:hover:bg-navy-800/60',
                          )}
                          onClick={bd && bd.length ? () => toggleRow(i) : undefined}
                        >
                          <td className={cn(rowPad, 'pr-4 pl-3 text-navy-800 dark:text-navy-100')}>
                            <span className="inline-flex items-center gap-1.5">
                              {bd && bd.length ? (
                                <ChevronRight size={13} className={cn('text-navy-400 transition-transform', isOpen && 'rotate-90')} />
                              ) : (
                                <span className="inline-block w-[13px]" />
                              )}
                              {r.label}
                              {bd && bd.length ? (
                                <span className="text-[11px] font-normal text-navy-400">
                                  ({r.breakdownCount ?? bd.length})
                                </span>
                              ) : null}
                            </span>
                          </td>
                          <td className={cn(rowPad, 'px-3 text-right tabular-nums text-navy-800 dark:text-navy-100')}>{fmtCell(r.cells.cur, sym)}</td>
                          {showCompare && <td className={cn(rowPad, 'px-3 text-right tabular-nums text-navy-700 dark:text-navy-200')}>{fmtCell(r.cells.avg, sym)}</td>}
                          {showCompare && <td className={cn(rowPad, 'pl-3 text-right tabular-nums')}><VarCell v={r.cells.var} sym={sym} /></td>}
                        </tr>
                        {bd && isOpen && (
                          <tr className="bg-navy-50/50 dark:bg-navy-950/50">
                            <td colSpan={colCount} className="px-3 pb-3 pt-1">
                              <div className="rounded-md border border-navy-200 dark:border-navy-700 overflow-hidden">
                                <table className="w-full text-[12px]">
                                  <thead>
                                    <tr className="text-navy-500 dark:text-navy-400 bg-navy-100/50 dark:bg-navy-800/50">
                                      <th className="text-left font-semibold py-1.5 px-3">Cash account</th>
                                      <th className="text-right font-semibold py-1.5 px-3">Transactions</th>
                                      <th className="text-right font-semibold py-1.5 px-3">Amount</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {bd.map((group, j) => {
                                      const groupKey = `${i}:${group.label}`;
                                      const isGroupOpen = !!expandedGroups[groupKey];
                                      const txns = Array.isArray(group.transactions) ? group.transactions : [];
                                      const totalTxns = group.transactionCount ?? txns.length;
                                      const shownTxns = txns.length;
                                      const groupPages = Math.max(1, Math.ceil(shownTxns / BREAKDOWN_PAGE_SIZE));
                                      const groupIdx = Math.min(bdPage[groupKey] || 0, groupPages - 1);
                                      const groupStart = groupIdx * BREAKDOWN_PAGE_SIZE;
                                      const groupRows = txns.slice(groupStart, groupStart + BREAKDOWN_PAGE_SIZE);
                                      return (
                                        <Fragment key={groupKey}>
                                          <tr
                                            className="border-t border-navy-100 dark:border-navy-800 cursor-pointer hover:bg-navy-100/40 dark:hover:bg-navy-800/30"
                                            onClick={() => toggleGroup(groupKey)}
                                          >
                                            <td className="py-1.5 px-3 text-navy-800 dark:text-navy-100">
                                              <span className="inline-flex items-center gap-1.5 font-semibold">
                                                <ChevronRight size={13} className={cn('text-navy-400 transition-transform', isGroupOpen && 'rotate-90')} />
                                                {group.label}
                                              </span>
                                            </td>
                                            <td className="py-1.5 px-3 text-right tabular-nums text-navy-600 dark:text-navy-300">
                                              {totalTxns}
                                            </td>
                                            <td className="py-1.5 px-3 text-right tabular-nums font-semibold text-navy-800 dark:text-navy-100">
                                              {fmtCell(group.amount, sym)}
                                            </td>
                                          </tr>
                                          {isGroupOpen && (
                                            <tr className="bg-white/70 dark:bg-navy-900/40">
                                              <td colSpan={3} className="p-0">
                                                <table className="w-full text-[12px]">
                                                  <thead>
                                                    <tr className="border-t border-navy-100 dark:border-navy-800 text-navy-500 dark:text-navy-400 bg-white/70 dark:bg-navy-900/50">
                                                      <th className="text-left font-semibold py-1.5 pl-9 pr-3">Date</th>
                                                      <th className="text-left font-semibold py-1.5 px-3">Reference</th>
                                                      <th className="text-right font-semibold py-1.5 px-3">Amount</th>
                                                    </tr>
                                                  </thead>
                                                  <tbody>
                                                    {groupRows.map((txn, txnIdx) => (
                                                      <tr key={`${groupKey}:${txnIdx}`} className="border-t border-navy-100 dark:border-navy-800">
                                                        <td className="py-1.5 pl-9 pr-3 text-navy-700 dark:text-navy-200 tabular-nums">{txn.date || '–'}</td>
                                                        <td className="py-1.5 px-3 text-navy-700 dark:text-navy-200">{txn.ref || '–'}</td>
                                                        <td className="py-1.5 px-3 text-right tabular-nums text-navy-800 dark:text-navy-100">{fmtCell(txn.amount, sym)}</td>
                                                      </tr>
                                                    ))}
                                                  </tbody>
                                                </table>
                                                {(shownTxns > BREAKDOWN_PAGE_SIZE || group.transactionTruncated) && (
                                                  <div className="px-3 py-1.5 border-t border-navy-100 dark:border-navy-800 flex flex-wrap items-center justify-between gap-2 bg-navy-50/60 dark:bg-navy-900/60">
                                                    <span className="text-[11px] text-navy-500 dark:text-navy-400">
                                                      {group.transactionTruncated
                                                        ? `Showing ${groupStart + 1}–${Math.min(groupStart + BREAKDOWN_PAGE_SIZE, shownTxns)} of ${shownTxns} displayed transactions (${totalTxns} total)`
                                                        : `Showing ${groupStart + 1}–${Math.min(groupStart + BREAKDOWN_PAGE_SIZE, totalTxns)} of ${totalTxns} transactions`}
                                                    </span>
                                                    {shownTxns > BREAKDOWN_PAGE_SIZE && (
                                                      <div className="flex items-center gap-2">
                                                        <button
                                                          type="button"
                                                          disabled={groupIdx === 0}
                                                          onClick={() => setBdPage((p) => ({ ...p, [groupKey]: groupIdx - 1 }))}
                                                          className="h-6 px-2 rounded-md border border-navy-200 dark:border-navy-700 text-[11px] font-semibold text-navy-600 dark:text-navy-300 hover:bg-white dark:hover:bg-navy-800 disabled:opacity-40 disabled:cursor-not-allowed"
                                                        >
                                                          ← Prev
                                                        </button>
                                                        <span className="text-[11px] text-navy-500 dark:text-navy-400 tabular-nums">Page {groupIdx + 1} of {groupPages}</span>
                                                        <button
                                                          type="button"
                                                          disabled={groupIdx >= groupPages - 1}
                                                          onClick={() => setBdPage((p) => ({ ...p, [groupKey]: groupIdx + 1 }))}
                                                          className="h-6 px-2 rounded-md border border-navy-200 dark:border-navy-700 text-[11px] font-semibold text-navy-600 dark:text-navy-300 hover:bg-white dark:hover:bg-navy-800 disabled:opacity-40 disabled:cursor-not-allowed"
                                                        >
                                                          Next →
                                                        </button>
                                                      </div>
                                                    )}
                                                  </div>
                                                )}
                                              </td>
                                            </tr>
                                          )}
                                        </Fragment>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
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
