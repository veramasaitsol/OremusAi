// Xero-style viewer for the Budget Variance report ONLY. ReportViewerModal routes
// the open "Budget Variance" report here so its filter bar + report sheet mirror
// Xero's Budget Variance (Date range / Budget / Currency / More / Update, and a
// table with Budget / Actuals / Variance / Variance % columns — Budget FIRST,
// under a green band — for both the selected period and the year-to-date window).
// Every other report keeps the common QBReportViewer.

import { useEffect, useMemo, useState, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  ArrowLeft, Star, X, ChevronDown,
  ArrowUp, ArrowDown,
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
import DrillDownModal from './DrillDownModal.jsx';

const XERO_BLUE = '#1A73E8';

const BUDGETS = ['Overall Budget'];
const CURRENCIES = [
  ['INR', 'Indian Rupee'],
  ['USD', 'US Dollar'],
  ['EUR', 'Euro'],
  ['GBP', 'British Pound'],
  ['AUD', 'Australian Dollar'],
];

// Date-range presets — keys MUST resolve in resolvePresetRange.
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

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Which value columns carry a drill-down: the two ACTUAL columns map to the
// backend breakdown buckets (selected-period 'cur', year-to-date 'ytd').
const BD_KEY = { actM: 'cur', actY: 'ytd' };

// Money: 2dp, parentheses for negatives, '-' for zero/empty (Xero-style).
function fmtMoney(v, sym) {
  if (v == null || Number.isNaN(v) || v === 0) return '-';
  const s = fmt(Math.abs(v), { dec: 2, sign: sym });
  return v < 0 ? `(${s})` : s;
}

function VarCell({ v, sym }) {
  if (v == null || Number.isNaN(v) || v === 0) return <span className="text-navy-400">–</span>;
  const up = v > 0;
  return (
    <span className={cn('inline-flex items-center justify-end gap-1', up ? 'text-emerald-600' : 'text-rose-600')}>
      {fmtMoney(Math.abs(v), sym)}
      {up ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
    </span>
  );
}

function PctCell({ v }) {
  if (v == null || Number.isNaN(v) || v === 0) return <span className="text-navy-400">–</span>;
  const up = v > 0;
  return <span className={cn(up ? 'text-emerald-600' : 'text-rose-600')}>{`${v > 0 ? '' : '-'}${Math.abs(v).toFixed(2)}%`}</span>;
}

export default function BudgetVarianceViewer() {
  const dispatch = useDispatch();
  const report = useSelector(selectOpenReport);
  const data = useSelector(selectReportData);
  const status = useSelector(selectReportStatus);
  const client = useSelector(selectActiveClient);
  const filters = useSelector(selectFilters);
  const favorites = useSelector(selectFavorites);

  const [budget, setBudget] = useState('Overall Budget');
  const [currency, setCurrency] = useState('INR');
  const [drill, setDrill] = useState(null); // { title, subtitle, rows, count, truncated }

  const openDrill = (r, bdKey, colLabel) => {
    const b = r.breakdowns?.[bdKey];
    if (!b) return;
    setDrill({
      title: r.label,
      subtitle: colLabel,
      rows: b.rows || [],
      count: b.count || 0,
      truncated: !!b.truncated,
    });
  };

  const favorited = !!favorites[report.name];
  const loading = status === 'loading';
  const sym = currencySymbol(currency);

  const range = useMemo(
    () => resolvePresetRange(filters.dateRange, { from: filters.customFrom, to: filters.customTo }),
    [filters.dateRange, filters.customFrom, filters.customTo],
  );
  const fromVal = filters.customFrom || range.from_date;
  const toVal = filters.customTo || range.to_date;
  const budgetName = data?.budgetName || budget;

  const end = toVal ? new Date(toVal) : new Date(2026, 5, 30);
  const endM = Number.isNaN(end.getTime()) ? 5 : end.getMonth();
  const endY = Number.isNaN(end.getTime()) ? 2026 : end.getFullYear();
  const monthLabel = `${MONTH_ABBR[endM]} ${endY}`;
  const ytdLabel = endM === 0 ? `${MONTH_ABBR[0]} ${endY}` : `${MONTH_ABBR[0]}-${MONTH_ABBR[endM]} ${endY}`;
  const endedText = new Date(endY, endM + 1, 0).toLocaleString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });

  // Column groups: a period quartet + a YTD quartet, each Budget / Actuals /
  // Variance / Variance % — Budget first, matching Xero's export layout. The
  // green band row above the header labels the Budget/Actuals pairs.
  const valueCols = [
    { key: 'budM',  label: monthLabel, type: 'money' },
    { key: 'actM',  label: monthLabel, type: 'money' },
    { key: 'varM',  label: 'Variance',    type: 'var' },
    { key: 'varpM', label: 'Variance %',  type: 'pct' },
    { key: 'budY',  label: ytdLabel, type: 'money' },
    { key: 'actY',  label: ytdLabel, type: 'money' },
    { key: 'varY',  label: 'Variance',    type: 'var' },
    { key: 'varpY', label: 'Variance %',  type: 'pct' },
  ];

  // Derive variance + variance% from the row's base figures so the table stays
  // consistent regardless of the date range selected. Supports BOTH cell shapes:
  // the mock generator's (actM/budM/actY/budY) and the live backend's
  // (cur/curBudget/ytd/ytdBudget — where empty values arrive as the string '-').
  const toNum = (v) => (typeof v === 'number' ? v : v == null || v === '-' ? null : Number(v));
  const derive = (cells) => {
    if (!cells) return {};
    const actM = toNum(cells.actM ?? cells.cur);
    const budM = toNum(cells.budM ?? cells.curBudget);
    const actY = toNum(cells.actY ?? cells.ytd);
    const budY = toNum(cells.budY ?? cells.ytdBudget);
    const varM = (actM || 0) - (budM || 0);
    const varY = (actY || 0) - (budY || 0);
    return {
      actM, budM, varM,
      varpM: budM ? (varM / budM) * 100 : null,
      actY, budY, varY,
      varpY: budY ? (varY / budY) * 100 : null,
    };
  };

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
  const rowPad = 'py-1';

  const renderCell = (val, type) => {
    if (type === 'var') return <VarCell v={val} sym={sym} />;
    if (type === 'pct') return <PctCell v={val} />;
    return fmtMoney(val, sym);
  };

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
        </div>
      </header>

      {/* Xero-style filter bar */}
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

          {/* Budget */}
          <div className="shrink-0">
            <div className="text-[11px] text-navy-500 dark:text-navy-400 mb-1">Budget</div>
            <select value={budget} onChange={(e) => setBudget(e.target.value)} className={cn(fieldCls, 'w-full')}>
              {BUDGETS.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>

          {/* Currency */}
          <div className="shrink-0">
            <div className="text-[11px] text-navy-500 dark:text-navy-400 mb-1">Currency</div>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} className={cn(fieldCls, 'w-full')}>
              {CURRENCIES.map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
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
          <div className="max-w-[1600px] mx-auto bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-800 rounded-lg shadow-card px-5 sm:px-8 py-8">
            <div className="mb-6">
              <div className="text-[20px] font-bold text-navy-900 dark:text-white leading-tight">{report.name}</div>
              <div className="text-[13px] text-navy-700 dark:text-navy-200 mt-1">{data?.meta?.company || client?.name || 'Oremus'}</div>
              <div className="text-[12.5px] text-navy-500">For the month ended {endedText}</div>
            </div>

            {loading || !data ? (
              <ReportSkeleton />
            ) : (
              <div className="overflow-auto scroll-thin max-h-[calc(100vh-15rem)]">
                <table className="w-full text-[12.5px] min-w-[1200px]">
                  <thead>
                    {/* Band row — labels the Budget/Actuals pairs */}
                    <tr className="text-[11.5px] font-semibold text-navy-600 dark:text-navy-300">
                      <th className="sticky top-0 z-20 bg-white dark:bg-navy-900 py-1 pr-4" />
                      <th className="sticky top-0 z-20 bg-white dark:bg-navy-900 py-1 px-3 text-center">Budget</th>
                      <th className="sticky top-0 z-20 bg-white dark:bg-navy-900 py-1 px-3 text-center">Actuals</th>
                      <th colSpan={2} className="sticky top-0 z-20 bg-white dark:bg-navy-900" />
                      <th className="sticky top-0 z-20 bg-white dark:bg-navy-900 py-1 px-3 text-center border-l border-navy-200 dark:border-navy-700">Budget</th>
                      <th className="sticky top-0 z-20 bg-white dark:bg-navy-900 py-1 px-3 text-center">Actuals</th>
                      <th colSpan={2} className="sticky top-0 z-20 bg-white dark:bg-navy-900" />
                    </tr>
                    <tr className="text-[11.5px] text-navy-500 dark:text-navy-400">
                      <th className="sticky top-[26px] z-20 bg-white dark:bg-navy-900 border-b border-navy-200 dark:border-navy-700 text-left font-semibold py-2 pr-4" />
                      {valueCols.map((c, idx) => (
                        <th
                          key={c.key}
                          className={cn(
                            'sticky top-[26px] z-20 bg-white dark:bg-navy-900 border-b border-navy-200 dark:border-navy-700 text-right font-semibold py-2 px-3 whitespace-nowrap',
                            idx === 4 && 'border-l border-navy-200 dark:border-navy-700',
                          )}
                        >
                          {c.label}
                        </th>
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
                      const d = derive(r.cells);
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
                          {valueCols.map((c, idx) => {
                            const bdKey = BD_KEY[c.key];
                            const canDrill = bdKey && r.breakdowns?.[bdKey] && d[c.key] != null;
                            return (
                              <td
                                key={c.key}
                                className={cn(
                                  rowPad, 'px-3 text-right tabular-nums whitespace-nowrap text-navy-800 dark:text-navy-100',
                                  idx === 4 && 'border-l border-navy-100 dark:border-navy-800',
                                )}
                              >
                                {canDrill ? (
                                  <button
                                    type="button"
                                    onClick={() => openDrill(r, bdKey, c.label)}
                                    className="text-sky-700 dark:text-sky-300 hover:underline cursor-pointer"
                                    title="Show the entries behind this amount"
                                  >
                                    {renderCell(d[c.key], c.type)}
                                  </button>
                                ) : (
                                  renderCell(d[c.key], c.type)
                                )}
                              </td>
                            );
                          })}
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

      {/* Drill-down modal — paginated GL entries behind a clicked actual amount */}
      <DrillDownModal
        open={!!drill}
        onClose={() => setDrill(null)}
        title={drill?.title || ''}
        subtitle={drill?.subtitle}
        rows={drill?.rows || []}
        count={drill?.count || 0}
        currency={sym}
      />
    </>
  );
}
