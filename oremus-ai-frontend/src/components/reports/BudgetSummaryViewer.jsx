// Budget Summary viewer — the budget as entered on the client's platform
// (Xero Budget Manager, QuickBooks budgets, Zoho Books budgets), laid out the
// way that platform lays it out. Every column, section and label comes from the
// backend (budgetSummaryService); this page only adds the controls:
//   · date range
//   · period — one column per month / quarter / (half-year) / year
//   · budget — any budget the platform has
//   · subdivision — one QuickBooks class / location / customer of a
//     subdivided budget (shown only when the budget has them)

import { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { ArrowLeft, Star, ChevronDown } from 'lucide-react';
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
import { useReportSort } from './useReportSort.jsx';

const ACCENT = '#1A73E8';

const INTERVAL_LABELS = {
  month: 'Month',
  quarter: 'Quarter',
  half_year: 'Half-year',
  year: 'Year',
};

const DATE_PRESETS = [
  ['this-month',           'This month'],
  ['previous-month',       'Last month'],
  ['this-quarter',         'This quarter'],
  ['previous-quarter',     'Last quarter'],
  ['this-fiscal-year',     'This financial year'],
  ['previous-fiscal-year', 'Last financial year'],
  ['custom',               'Custom'],
];
const PRESET_LABELS = Object.fromEntries(DATE_PRESETS);

const fieldCls =
  'h-9 px-3 rounded-md bg-white dark:bg-navy-900 border border-navy-300 dark:border-navy-700 text-[13px] text-navy-900 dark:text-white outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20';

function fmtCell(v, sym) {
  if (v == null || Number.isNaN(v) || v === 0) return '-';
  return fmt(v, { dec: 2, sign: sym });
}

export default function BudgetSummaryViewer() {
  const dispatch = useDispatch();
  const report = useSelector(selectOpenReport);
  const data = useSelector(selectReportData);
  const status = useSelector(selectReportStatus);
  const client = useSelector(selectActiveClient);
  const filters = useSelector(selectFilters);
  const favorites = useSelector(selectFavorites);

  // null = whatever the last response used.
  const [intervalPick, setIntervalPick] = useState(null);
  const [budgetPick, setBudgetPick] = useState(null);
  const [dimensionPick, setDimensionPick] = useState(null);

  const favorited = !!favorites[report.name];
  const loading = status === 'loading';
  const sym = currencySymbol(data?.currency);

  const range = useMemo(
    () => resolvePresetRange(filters.dateRange, { from: filters.customFrom, to: filters.customTo }),
    [filters.dateRange, filters.customFrom, filters.customTo],
  );
  const fromVal = filters.customFrom || range.from_date;
  const toVal = filters.customTo || range.to_date;

  const intervals = Array.isArray(data?.intervals) && data.intervals.length ? data.intervals : ['month', 'quarter', 'year'];
  const interval = intervalPick || data?.interval || 'month';
  const budgets = Array.isArray(data?.budgets) ? data.budgets : [];
  const budgetId = budgetPick ?? data?.budgetId ?? '';
  const dimensions = Array.isArray(data?.dimensions) ? data.dimensions : [];
  const dimension = dimensionPick ?? data?.dimension ?? '';
  const budgetName = data?.budgetName || 'Budget';
  const dimensionLabel = dimensions.find((d) => d.key === dimension)?.label;

  const runReport = (over = {}) => dispatch(loadReportData({
    reportName: report.name,
    clientId: client?.id,
    provider: report.provider,
    filters: {
      from_date: fromVal,
      to_date: toVal,
      interval: over.interval || interval,
      budget_id: (over.budgetId ?? budgetId) || undefined,
      dimension: (over.dimension ?? dimension) || undefined,
    },
  }));

  const initialLoad = useRef(true);
  useEffect(() => {
    if (initialLoad.current && !data && status === 'idle') {
      runReport();
      initialLoad.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-run when the date range changes (after the first load).
  const filterMounted = useRef(false);
  useEffect(() => {
    if (!filterMounted.current) { filterMounted.current = true; return; }
    runReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.dateRange, filters.customFrom, filters.customTo]);

  const valueCols = useMemo(() => {
    const cols = (data?.columns || []).filter((c) => c.key !== 'label' && c.key !== 'total');
    return [...cols, { key: 'total', label: 'Total' }];
  }, [data?.columns]);

  const cellValue = (r, col) => {
    if (!r.cells) return undefined;
    if (col.key === 'total' && r.cells.total == null) {
      return valueCols.filter((c) => c.key !== 'total').reduce((s, c) => s + (Number(r.cells[c.key]) || 0), 0);
    }
    return r.cells[col.key];
  };

  const { rows, header } = useReportSort(data?.rows || [], {
    getValue: (r, key) => cellValue(r, valueCols.find((c) => c.key === key) || { key }),
  });

  const periodFrom = data?.meta?.from || fromVal;
  const periodTo = data?.meta?.to || toVal;

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
            meta={{ company: data?.meta?.company || client?.name, from: periodFrom, to: periodTo }}
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 items-end gap-x-4 gap-y-3">
          {/* Date range */}
          <div className="shrink-0">
            <div className="text-[11px] text-navy-500 dark:text-navy-400 mb-1">
              Date range: <span className="font-semibold text-navy-700 dark:text-navy-200">{PRESET_LABELS[filters.dateRange] || 'Custom'}</span>
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
                    {DATE_PRESETS.map(([v, l]) => (
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

          {/* Column width */}
          <div className="shrink-0">
            <div className="text-[11px] text-navy-500 dark:text-navy-400 mb-1">Period</div>
            <select
              value={interval}
              onChange={(e) => { setIntervalPick(e.target.value); runReport({ interval: e.target.value }); }}
              className={cn(fieldCls, 'w-full')}
            >
              {intervals.map((v) => (
                <option key={v} value={v}>{INTERVAL_LABELS[v] || v}</option>
              ))}
            </select>
          </div>

          {/* Budget */}
          <div className="shrink-0">
            <div className="text-[11px] text-navy-500 dark:text-navy-400 mb-1">Budget</div>
            <select
              value={budgetId}
              onChange={(e) => { setBudgetPick(e.target.value); setDimensionPick(''); runReport({ budgetId: e.target.value, dimension: '' }); }}
              disabled={!budgets.length}
              className={cn(fieldCls, 'w-full')}
            >
              {budgets.length ? budgets.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              )) : <option value="">No budgets</option>}
            </select>
          </div>

          {/* Subdivision (QuickBooks class / location / customer) */}
          {dimensions.length > 0 && (
            <div className="shrink-0">
              <div className="text-[11px] text-navy-500 dark:text-navy-400 mb-1">Subdivision</div>
              <select
                value={dimension}
                onChange={(e) => { setDimensionPick(e.target.value); runReport({ dimension: e.target.value }); }}
                className={cn(fieldCls, 'w-full')}
              >
                <option value="">All (total)</option>
                {dimensions.map((d) => (
                  <option key={d.key} value={d.key}>{d.label}</option>
                ))}
              </select>
            </div>
          )}

          <button
            type="button"
            onClick={() => runReport()}
            className="h-9 px-4 rounded-md text-white text-[13px] font-semibold shadow-soft hover:opacity-95 shrink-0 justify-self-start"
            style={{ background: ACCENT }}
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
              <div className="text-[12.5px] text-navy-500">{data?.meta?.periodText || `${periodFrom || ''} - ${periodTo || ''}`}</div>
              <div className="text-[12.5px] text-navy-500">{budgetName}{dimensionLabel ? ` · ${dimensionLabel}` : ''}</div>
              {data?.meta?.note && (
                <div className="text-[12px] text-amber-700 dark:text-amber-400 mt-1">{data.meta.note}</div>
              )}
            </div>

            {loading || !data ? (
              <ReportSkeleton />
            ) : !rows.length ? (
              <div className="py-16 text-center text-[13px] text-navy-500 dark:text-navy-400">
                {data?.message || 'No budget figures for the selected period.'}
              </div>
            ) : (
              <div className="overflow-auto scroll-thin max-h-[calc(100vh-15rem)]">
                <table className="w-full text-[12.5px] min-w-[900px]">
                  <thead>
                    <tr className="text-[11.5px] text-navy-500 dark:text-navy-400">
                      <th className="sticky top-0 z-20 bg-white dark:bg-navy-900 border-b border-navy-200 dark:border-navy-700 text-left font-semibold py-2 pr-4">{header({ key: 'label', label: 'Account' }, { isLabel: true })}</th>
                      {valueCols.map((c) => (
                        <th key={c.key} className="sticky top-0 z-20 bg-white dark:bg-navy-900 border-b border-navy-200 dark:border-navy-700 text-right font-semibold py-2 px-3 whitespace-nowrap">{header({ align: 'right', ...c })}</th>
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
                          <td className={cn('py-1 pr-4 whitespace-nowrap text-navy-700 dark:text-navy-200', emph ? 'pl-2' : 'pl-5')}>{r.label}</td>
                          {valueCols.map((c) => (
                            <td key={c.key} className="py-1 px-3 text-right tabular-nums whitespace-nowrap text-navy-800 dark:text-navy-100">
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
