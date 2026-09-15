// Xero-style viewer for the Executive Summary report ONLY. Every other report
// uses the common QBO-style QBReportViewer; ReportViewerModal routes the open
// "Executive Summary" report here so its filter bar + report sheet mirror Xero's
// Executive Summary (Date range / Compare with / Filter / More / Update, and a
// sectioned table with This-month / Last-month / Variance columns).

import { useEffect, useMemo, useState, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  ArrowLeft, Star, X, ChevronDown,
  ArrowUp, ArrowDown, Filter as FilterIcon, MoreVertical, Search,
} from 'lucide-react';
import Popover from '../ui/Popover.jsx';
import ExportMenu from './ExportMenu.jsx';
import ReportSkeleton from './ReportSkeleton.jsx';
import {
  selectOpenReport, selectReportData, selectReportStatus,
  selectFilters, selectCompare, selectFavorites,
  closeReport, setFilter, setCompare, toggleFavorite, loadReportData,
} from '../../features/reports/reportsSlice.js';
import { selectActiveClient } from '../../features/clients/clientsSlice.js';
import { resolvePresetRange } from '../../features/reports/data/dateRanges.js';
import { fmt, currencySymbol } from '../../utils/fmt.js';
import { cn } from '../../utils/classNames.js';
import DrillDownModal from './DrillDownModal.jsx';

const XERO_BLUE = '#1A73E8';

// Xero "Date range" presets — keys MUST resolve in resolvePresetRange.
const XERO_PERIODS = [
  ['this-month',            'This month'],
  ['this-quarter',          'This quarter'],
  ['this-fiscal-year',      'This financial year'],
  ['previous-month',        'Last month'],
  ['previous-quarter',      'Last quarter'],
  ['previous-fiscal-year',  'Last financial year'],
  ['this-month-to-date',    'Month to date'],
  ['this-quarter-to-date',  'Quarter to date'],
  ['this-year-to-date',     'Year to date'],
  ['custom',                'Custom date range'],
];
const PERIOD_LABELS = Object.fromEntries(XERO_PERIODS);

const fieldCls =
  'h-9 px-3 rounded-md bg-white dark:bg-navy-900 border border-navy-300 dark:border-navy-700 text-[13px] text-navy-900 dark:text-white outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20';

// Format a value for its unit (currency uses parentheses for negatives, Xero-style).
function fmtCell(v, unit, sym, decimals = true) {
  if (v == null || Number.isNaN(v)) return '–';
  if (unit === 'percent') return `${v.toFixed(1)}%`;
  if (unit === 'days')    return String(Math.round(v));
  if (unit === 'number')  return Math.round(v).toLocaleString('en-US');
  if (unit === 'ratio')   return v.toFixed(2);
  const s = fmt(Math.abs(v), { dec: decimals ? 2 : 0, sign: sym });
  return v < 0 ? `(${s})` : s;
}

// The Variance % column is a percentage change vs the prior period (backend
// emits the raw percent), so it always renders as "x.x%" with an up/down arrow
// and green/red coloring regardless of the row's unit.
function VarCell({ v }) {
  if (v == null || Number.isNaN(v) || v === 0) return <span className="text-navy-400">–</span>;
  const up = v > 0;
  return (
    <span className={cn('inline-flex items-center justify-end gap-1', up ? 'text-emerald-600' : 'text-rose-600')}>
      {up ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
      {`${Math.abs(v).toFixed(1)}%`}
    </span>
  );
}

// The Variance column is the ABSOLUTE difference (current − prior) in the row's
// own unit, colored by direction to match the % column beside it. Negatives keep
// Xero's parentheses style via fmtCell.
function VarAmountCell({ v, unit, sym, decimals }) {
  if (v == null || Number.isNaN(v) || v === 0) return <span className="text-navy-400">–</span>;
  const up = v > 0;
  return (
    <span className={cn('tabular-nums', up ? 'text-emerald-600' : 'text-rose-600')}>
      {fmtCell(v, unit, sym, decimals)}
    </span>
  );
}

export default function ExecutiveSummaryViewer() {
  const dispatch = useDispatch();
  const report = useSelector(selectOpenReport);
  const data = useSelector(selectReportData);
  const status = useSelector(selectReportStatus);
  const client = useSelector(selectActiveClient);
  const filters = useSelector(selectFilters);
  const compare = useSelector(selectCompare);
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
  const endedText = endDate.toLocaleString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
  const startDate = fromVal ? new Date(fromVal) : null;
  const monthSpan = startDate
    ? (endDate.getFullYear() - startDate.getFullYear()) * 12 + (endDate.getMonth() - startDate.getMonth()) + 1
    : 1;
  const periodSubtitle = monthSpan > 1
    ? `For the ${monthSpan} months ended ${endedText}`
    : `For the month ended ${endedText}`;

  // Xero "Compare with": None, N months (1–4 or custom), and a Previous
  // Month/Quarter/Year basis. count = N+1 periods (1 = None); baseOn 'year'
  // steps by year, otherwise by the selected period length.
  const compareN = (compare.count || 1) > 1 ? compare.count - 1 : 0; // 0 = None
  const [prevType, setPrevType] = useState(compare.baseOn === 'year' ? 'year' : 'month');
  const [compareOpen, setCompareOpen] = useState(false);
  const [customN, setCustomN] = useState('');
  const applyCompare = (n, pType = prevType) => {
    setPrevType(pType);
    if (!n || n <= 0) { dispatch(setCompare({ with: 'none', count: 1 })); return; }
    dispatch(setCompare({ with: 'previous-period', baseOn: pType === 'year' ? 'year' : 'period', count: n + 1 }));
  };
  const compareLabel = compareN <= 0
    ? 'None'
    : `Compare with ${compareN} ${prevType}${compareN > 1 ? 's' : ''}`;

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
  }, [filters.dateRange, filters.customFrom, filters.customTo, filters.basis, filters.includeZero, compare.count, compare.baseOn]);

  const rows = data?.rows || [];
  // Render whatever value columns the backend returned (current period plus any
  // comparison periods, and a Variance column when there's a single comparison).
  const valueCols = (data?.columns || []).filter((c) => c.key !== 'label');

  // ── View controls (Xero-style) ─────────────────────────────────────────────
  const [compact, setCompact]     = useState(true);   // "Compact view" (footer toggle)
  const [decimals, setDecimals]   = useState(true);   // "More → Decimals"
  const [moreOpen, setMoreOpen]   = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterSearch, setFilterSearch] = useState('');
  const [hidden, setHidden]       = useState(() => new Set()); // hidden row labels
  const [drill, setDrill]         = useState(null); // { title, rows, count, truncated }
  const rowPad = compact ? 'py-1' : 'py-2';

  const openDrill = (r, colKey, colLabel) => {
    const b = r.breakdowns?.[colKey];
    if (!b) return;
    setDrill({
      title: r.label,
      subtitle: colLabel,
      rows: b.rows || [],
      count: b.count || 0,
      truncated: !!b.truncated,
    });
  };

  // Catalog of indicators grouped by their section header, derived from the data
  // so the Filter picker always mirrors exactly what the report can show.
  const groups = useMemo(() => {
    const g = [];
    let cur = null;
    for (const r of rows) {
      if (r.isHeader) { cur = { section: r.label, items: [] }; g.push(cur); }
      else if (cur) cur.items.push(r.label);
    }
    return g;
  }, [rows]);

  // Rows actually rendered: drop hidden indicators, and any section left empty.
  const visibleRows = useMemo(() => {
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.isHeader) {
        // keep the header only if at least one following row (until next header) is visible
        let hasChild = false;
        for (let j = i + 1; j < rows.length && !rows[j].isHeader; j++) {
          if (!hidden.has(rows[j].label)) { hasChild = true; break; }
        }
        if (hasChild) out.push(r);
      } else if (!hidden.has(r.label)) {
        out.push(r);
      }
    }
    return out;
  }, [rows, hidden]);

  const toggleHidden = (label) => setHidden((prev) => {
    const next = new Set(prev);
    if (next.has(label)) next.delete(label); else next.add(label);
    return next;
  });

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
            <Popover
              align="start"
              width={240}
              open={compareOpen}
              onOpenChange={setCompareOpen}
              trigger={(
                <button type="button" className={cn(fieldCls, 'w-full inline-flex items-center justify-between gap-2')}>
                  <span className="truncate">{compareLabel}</span>
                  <ChevronDown size={15} className="text-navy-400 shrink-0" />
                </button>
              )}
            >
              {({ close }) => (
                <div className="flex flex-col">
                  <div className="px-2.5 pt-1 pb-1 text-[10px] uppercase tracking-wider text-navy-400 font-semibold">Compare with</div>
                  {[['None', 0], ['1 month', 1], ['2 months', 2], ['3 months', 3], ['4 months', 4]].map(([label, n]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => { applyCompare(n); close(); }}
                      className={cn(
                        'text-left px-2.5 py-1.5 rounded-md text-[13px] hover:bg-navy-50 dark:hover:bg-navy-800',
                        compareN === n ? 'font-semibold text-sky-700 dark:text-sky-300' : 'text-navy-700 dark:text-navy-200',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                  <div className="px-2.5 py-1.5 flex items-center gap-2">
                    <input
                      type="number" min="1" max="12" placeholder="Enter a different number"
                      value={customN}
                      onChange={(e) => setCustomN(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && customN) { applyCompare(Number(customN)); close(); } }}
                      className={cn(fieldCls, 'w-full text-[12px]')}
                    />
                  </div>
                  <div className="mt-1 border-t border-navy-100 dark:border-navy-800 px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-wider text-navy-400 font-semibold">Previous</div>
                  {['month', 'quarter', 'year'].map((t) => (
                    <label key={t} className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] capitalize hover:bg-navy-50 dark:hover:bg-navy-800 cursor-pointer">
                      <input
                        type="radio" name="prevType" checked={prevType === t}
                        onChange={() => applyCompare(compareN || 1, t)}
                        className="accent-sky-600"
                      />
                      {t}
                    </label>
                  ))}
                </div>
              )}
            </Popover>
          </div>

          <div className="shrink-0">
            <div className="text-[11px] text-navy-500 dark:text-navy-400 mb-1">&nbsp;</div>
            <label className="inline-flex items-center gap-2 h-9 text-[12.5px] text-navy-700 dark:text-navy-200 cursor-pointer">
              <input type="checkbox" checked={!!filters.includeZero} onChange={(e) => dispatch(setFilter({ includeZero: e.target.checked }))} className="accent-sky-600" />
              Show rows with zero balances
            </label>
          </div>


          {/* Filter (show/hide indicators) */}
          <div className="shrink-0">
            <div className="text-[11px] text-navy-500 dark:text-navy-400 mb-1">&nbsp;</div>
            <button
              type="button"
              onClick={() => setFilterOpen(true)}
              className={cn(fieldCls, 'inline-flex items-center gap-2 font-semibold')}
            >
              <FilterIcon size={14} className="text-sky-600" /> Filter
              {hidden.size > 0 && (
                <span className="ml-0.5 text-[11px] px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700">{hidden.size}</span>
              )}
            </button>
          </div>

          {/* More (Decimals / Compact) */}
          <div className="shrink-0">
            <div className="text-[11px] text-navy-500 dark:text-navy-400 mb-1">&nbsp;</div>
            <Popover
              align="end"
              width={200}
              open={moreOpen}
              onOpenChange={setMoreOpen}
              trigger={(
                <button type="button" className={cn(fieldCls, 'inline-flex items-center gap-1.5')}>
                  <MoreVertical size={14} /> More
                </button>
              )}
            >
              {() => (
                <div className="flex flex-col gap-0.5">
                  <div className="px-2.5 pt-1 pb-1.5 text-[10px] uppercase tracking-wider text-navy-400 font-semibold">Show</div>
                  <label className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] hover:bg-navy-50 dark:hover:bg-navy-800 cursor-pointer">
                    <input type="checkbox" checked={decimals} onChange={(e) => setDecimals(e.target.checked)} className="accent-sky-600" />
                    Decimals
                  </label>
                  <label className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] hover:bg-navy-50 dark:hover:bg-navy-800 cursor-pointer">
                    <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} className="accent-sky-600" />
                    Compact view
                  </label>
                </div>
              )}
            </Popover>
          </div>

          <div className="shrink-0">
            <div className="text-[11px] text-navy-500 dark:text-navy-400 mb-1">&nbsp;</div>
            <button
              type="button"
              onClick={runReport}
              className="h-9 px-4 rounded-md text-white text-[13px] font-semibold shadow-soft hover:opacity-95"
              style={{ background: XERO_BLUE }}
            >
              Update
            </button>
          </div>
        </div>
      </div>

      {/* Filter modal — show/hide indicators, grouped like Xero */}
      {filterOpen && (
        <>
          <div className="fixed inset-0 bg-navy-950/40 z-[60]" onClick={() => setFilterOpen(false)} />
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[70] w-[440px] max-w-[calc(100vw-2rem)] max-h-[80vh] flex flex-col bg-white dark:bg-navy-900 rounded-xl shadow-2xl border border-navy-200 dark:border-navy-800">
            <div className="flex items-center justify-between px-4 py-3 border-b border-navy-100 dark:border-navy-800">
              <span className="text-[15px] font-bold text-navy-900 dark:text-white">Filter</span>
              <button onClick={() => setFilterOpen(false)} className="h-7 w-7 grid place-items-center rounded-md text-navy-400 hover:bg-navy-100 dark:hover:bg-navy-800"><X size={15} /></button>
            </div>
            <div className="px-4 py-3">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-navy-400" />
                <input
                  value={filterSearch}
                  onChange={(e) => setFilterSearch(e.target.value)}
                  placeholder="Search filters"
                  className={cn(fieldCls, 'w-full pl-8')}
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto scroll-thin px-4 pb-2">
              {groups.map((grp) => {
                const items = grp.items.filter((l) => l.toLowerCase().includes(filterSearch.toLowerCase()));
                if (items.length === 0) return null;
                return (
                  <div key={grp.section} className="mb-3">
                    <div className="text-[11px] text-navy-500 font-semibold mb-1">{grp.section}</div>
                    {items.map((label) => (
                      <label key={label} className="flex items-center gap-2.5 py-1.5 text-[13px] text-navy-800 dark:text-navy-100 cursor-pointer">
                        <input type="checkbox" checked={!hidden.has(label)} onChange={() => toggleHidden(label)} className="accent-sky-600" />
                        {label}
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-navy-100 dark:border-navy-800">
              <button onClick={() => setHidden(new Set())} className="text-[13px] font-semibold text-sky-700 hover:underline mr-auto">Select all</button>
              <button onClick={() => setFilterOpen(false)} className="h-9 px-4 rounded-md border border-navy-300 dark:border-navy-700 text-[13px] font-semibold text-navy-700 dark:text-navy-200">Cancel</button>
              <button onClick={() => setFilterOpen(false)} className="h-9 px-4 rounded-md text-white text-[13px] font-semibold" style={{ background: XERO_BLUE }}>Apply</button>
            </div>
          </div>
        </>
      )}

      {/* Report sheet */}
      <div className="flex-1 min-h-0 overflow-y-auto scroll-thin bg-navy-50/40 dark:bg-navy-950">
        <div className="p-4 sm:p-6 lg:p-8">
          <div className="max-w-[1100px] mx-auto bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-800 rounded-lg shadow-card px-5 sm:px-10 py-8">
            <div className="mb-6">
              <div className="text-[22px] font-bold text-navy-900 dark:text-white leading-tight">{report.name}</div>
              <div className="text-[13px] text-navy-700 dark:text-navy-200 mt-1">{data?.meta?.company || client?.name || 'Oremus'}</div>
              <div className="text-[12.5px] text-navy-500">{periodSubtitle}</div>
            </div>

            {loading || !data ? (
              <ReportSkeleton />
            ) : (
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-[12px] text-navy-500 dark:text-navy-400 [&>th]:sticky [&>th]:top-0 [&>th]:z-20 [&>th]:bg-white dark:[&>th]:bg-navy-900 [&>th]:border-b [&>th]:border-navy-200 dark:[&>th]:border-navy-700">
                    <th className="text-left font-semibold py-2" />
                    {valueCols.map((c) => (
                      <th key={c.key} className="text-right font-semibold py-2 px-3 w-[150px]">{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r, i) => {
                    if (r.isHeader) {
                      return (
                        <tr key={i}>
                          <td colSpan={valueCols.length + 1} className="pt-5 pb-1 text-[14px] font-bold text-navy-900 dark:text-white">{r.label}</td>
                        </tr>
                      );
                    }
                    const emph = r.isSubtotal;
                    return (
                      <tr key={i} className={cn('border-b border-navy-100 dark:border-navy-800', emph && 'font-semibold')}>
                        <td className={cn(rowPad, 'pr-4 text-navy-700 dark:text-navy-200', emph ? 'pl-3' : 'pl-5')}>{r.label}</td>
                        {valueCols.map((c) => {
                          const val = r.cells?.[c.key];
                          const canDrill = !c.variance && r.breakdowns?.[c.key];
                          return (
                            <td key={c.key} className={cn(rowPad, 'px-3 text-right tabular-nums text-navy-800 dark:text-navy-100')}>
                              {c.variance === 'pct' ? (
                                <VarCell v={val} />
                              ) : c.variance === 'abs' ? (
                                <VarAmountCell v={val} unit={r.unit} sym={sym} decimals={decimals} />
                              ) : canDrill ? (
                                <button
                                  type="button"
                                  onClick={() => openDrill(r, c.key, c.label)}
                                  className="text-sky-700 dark:text-sky-300 hover:underline cursor-pointer"
                                  title="Show the entries behind this amount"
                                >
                                  {fmtCell(val, r.unit, sym, decimals)}
                                </button>
                              ) : (
                                fmtCell(val, r.unit, sym, decimals)
                              )}
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

      {/* Drill-down modal — paginated GL entries behind a clicked amount */}
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
