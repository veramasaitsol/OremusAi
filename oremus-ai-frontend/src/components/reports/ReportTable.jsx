import { Fragment, useState } from 'react';
import { useSelector } from 'react-redux';
import { ChevronRight, ChevronDown, ChevronsUpDown, Download } from 'lucide-react';
import { fmt, currencySymbol } from '../../utils/fmt.js';
import { selectFilters } from '../../features/reports/reportsSlice.js';
import { resolvePresetRange } from '../../features/reports/data/dateRanges.js';
import { cn } from '../../utils/classNames.js';
import AccountLedgerModal from './AccountLedgerModal.jsx';
import SourceDocumentModal from './SourceDocumentModal.jsx';
import { exportRowsCSV } from '../../utils/exportReport.js';

// `numberFormat` maps the "Number format" filter (indian/international) to
// the locale `fmt` should group digits with, overriding the currency default
// so the control is a real toggle rather than a decorative no-op.
function localeFor(numberFormat) {
  if (numberFormat === 'indian') return 'en-IN';
  if (numberFormat === 'international') return 'en-US';
  return undefined;
}

// Small "Export" affordance shown in a drill-down/breakdown panel's header —
// exports just that panel's rows (not the whole report) to CSV.
function ExportBtn({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-[11px] font-semibold text-navy-600 dark:text-navy-300 hover:text-brand-600"
    >
      <Download size={12} /> Export
    </button>
  );
}

function formatCell(value, decimals, currency, locale, parens = false) {
  if (value == null) return '';
  if (typeof value !== 'number') return value;
  return fmt(value, { dec: decimals, sign: '', currency, locale, parens }).replace(/^/, '');
}

// One side (Income or Expense) of a horizontal / T-format P&L. Renders the
// section headers, leaf accounts (indented) and "Total for X" subtotals exactly
// like Zoho, with a bold grand Total footer that balances against the other side.
function HorizontalSide({ side, decimals, currency, includeZero, locale, parens = false }) {
  const all = Array.isArray(side?.rows) ? side.rows : [];
  // Match Zoho: hide zero-balance leaf accounts (keep headers & subtotals).
  const rows = includeZero
    ? all
    : all.filter((r) => r.isHeader || r.isSubtotal || !(r.cells?.amount == null || r.cells?.amount === 0));
  return (
    <div className="flex flex-col">
      <div className="px-4 py-2.5 text-[15px] italic font-semibold text-navy-800 dark:text-navy-100 border-b-2 border-navy-200 dark:border-navy-700">
        {side?.title}
      </div>
      <table className="w-full border-collapse text-[12.5px]">
        <tbody>
          {rows.map((r, i) => {
            const isHeader   = r.isHeader === true;
            const isSubtotal = r.isSubtotal;
            const indentPx   = Math.min((r.level || 0), 5) * 16;
            const v = r.cells?.amount;
            return (
              <tr
                key={i}
                className={cn(
                  isHeader   && 'font-bold text-navy-800 dark:text-navy-100',
                  isSubtotal && 'bg-navy-50 dark:bg-navy-900/60 font-semibold',
                  !isHeader && !isSubtotal && 'text-navy-700 dark:text-navy-300',
                )}
              >
                <td className="px-4 py-1.5" style={{ paddingLeft: 16 + indentPx }}>
                  {!isHeader && !isSubtotal ? <span className="mr-1.5 text-navy-400">•</span> : null}
                  {r.label}
                </td>
                <td className="px-4 py-1.5 text-right tabular-nums">
                  {v == null || v === '' ? '' : formatCell(v, decimals, currency, locale, parens)}
                </td>
              </tr>
            );
          })}
          <tr className="border-t-2 border-navy-200 dark:border-navy-700 font-bold text-navy-900 dark:text-navy-50">
            <td className="px-4 py-2.5 text-right">Total</td>
            <td className="px-4 py-2.5 text-right tabular-nums">
              {side?.total == null ? '' : formatCell(side.total, decimals, currency, locale, parens)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const DRILL_PAGE_SIZE = 25;

export default function ReportTable({ data, variant = 'standard', asOf = false }) {
  const filters = useSelector(selectFilters);
  const [expanded, setExpanded] = useState({});
  const [collapsedSec, setCollapsedSec] = useState({});  // QB section collapse
  const [ledger, setLedger] = useState(null);  // { accountRef, accountName }
  const [source, setSource] = useState(null);  // { sourceType, sourceRef }
  const [drillPage, setDrillPage] = useState({});  // pagination for inline drill-down
  // Per-CELL drill-down (AR/AP Aging Summary's customer/vendor × bucket matrix —
  // the click target is one cell, not the whole row) — keyed by `${rowIdx}:${colKey}`
  // so several cells, in the same or different rows, can be open at once.
  const [expandedCell, setExpandedCell] = useState({});
  const [cellPage, setCellPage] = useState({});
  const CELL_DRILL_PAGE_SIZE = 10;
  const toggleCell = (key) => {
    setExpandedCell((m) => ({ ...m, [key]: !m[key] }));
    setCellPage((p) => ({ ...p, [key]: 0 }));
  };

  // Resolve the report's active date range so the account ledger drill scopes
  // to the same period the report was run for.
  const range = resolvePresetRange(filters.dateRange, { from: filters.customFrom, to: filters.customTo });

  // As-of reports (Balance Sheet, Aging) are cumulative to a single as-of date,
  // so their account drill scopes to the period ending on that date and shows a
  // "Beginning Balance" opening row (posted net before the period start) + the
  // period's transactions — the running balance reconciles to the as-of value,
  // exactly like QuickBooks. The as-of date is the To/customTo date. The period
  // start is the user's From (customFrom) when set; otherwise it defaults to the
  // year-to-date of the as-of date (Jan 1 → as-of), which captures the current
  // year's movements against the carried-forward opening. An as-of range with no
  // From also arrives inverted (from = today) — the customFrom fallback fixes it.
  const periodMode = asOf || (range.from_date > range.to_date);
  const asOfDate = periodMode ? (filters.customTo || range.to_date) : range.to_date;
  const drillFrom = periodMode
    ? (filters.customFrom || `${String(asOfDate).slice(0, 4)}-01-01`)
    : range.from_date;
  const drillTo = asOfDate;

  // Horizontal / T-format P&L (Expense column | Income column) — matches Zoho's
  // "Horizontal Profit and Loss". Falls through to the standard table otherwise.
  const numLocale = localeFor(filters.numberFormat);

  // Balance Sheet prints negatives accounting-style — `(1,234.00)`, no minus.
  const parensNeg = /^balance sheet/i.test(String(data?.meta?.title || ''));

  if (data.layout === 'horizontal' && data.horizontal) {
    const currency = data.currency || 'USD';
    const decimals = filters.decimals != null ? filters.decimals : 2;
    return (
      <div className="overflow-x-auto scroll-thin">
        <div className="grid grid-cols-1 md:grid-cols-2 border border-navy-200 dark:border-navy-700 rounded-lg overflow-hidden">
          <div className="md:border-r border-navy-200 dark:border-navy-700">
            <HorizontalSide side={data.horizontal.expense} decimals={decimals} currency={currency} includeZero={filters.includeZero} locale={numLocale} parens={parensNeg} />
          </div>
          <div className="border-t md:border-t-0 border-navy-200 dark:border-navy-700">
            <HorizontalSide side={data.horizontal.income} decimals={decimals} currency={currency} includeZero={filters.includeZero} locale={numLocale} parens={parensNeg} />
          </div>
        </div>
      </div>
    );
  }

  const cols = data.columns.filter((c) => !filters.hiddenColumns[c.key]);
  const currency = data.currency || 'USD';
  // INR + most accounting reports use 2 decimals like Zoho; allow filter override.
  const decimals = filters.decimals != null ? filters.decimals : 2;

  // Match Zoho's default: hide account rows whose every amount is zero/blank.
  // Section headers, subtotals and totals are always kept (Zoho shows e.g.
  // "Cost of Goods Sold" + "Total for Cost of Goods Sold 0.00" even when empty).
  const valueKeys = cols.filter((c) => c.key !== 'label').map((c) => c.key);
  // `alwaysShow` keeps a row a report needs whatever its value: the lines of a
  // bank reconciliation read as a running sum, so dropping one for being zero
  // would leave the remaining lines looking like they don't add up.
  const isZeroLeaf = (r) => {
    if (r.isHeader || r.isSubtotal || r.isTotal || r.drill || r.breakdown || r.alwaysShow) return false;
    return valueKeys.length > 0 && valueKeys.every((k) => {
      const v = r.cells?.[k];
      return v == null || v === '' || (typeof v === 'number' && v === 0);
    });
  };
  const rows = filters.includeZero ? data.rows : data.rows.filter((r) => !isZeroLeaf(r));

  // Wide reports (e.g. AR/AP Aging with nine bucket columns) size the table to
  // its content and scroll sideways instead of being squeezed into the panel —
  // otherwise the amount columns starve the label column and long customer names
  // stack up six lines tall. The label column keeps a floor and a ceiling so the
  // names wrap to a line or two without pushing the amounts off-screen.
  const isWide = cols.length > 6;
  const qbPadX  = isWide ? 'px-2.5' : 'px-3';    // QB-style branch
  const stdPadX = isWide ? 'px-2.5' : 'px-3.5';  // standard branch
  const labelWidth = isWide ? 'min-w-[190px] max-w-[280px]' : '';
  // Beyond the label column, other free-text columns (Description/Memo/Split)
  // are otherwise unbounded — a single long note blows the whole table out to
  // several times the panel width (measured 3245px vs a 1134px container),
  // which is what makes the horizontal scrollbar feel excessively long. Cap +
  // wrap them too instead of forcing one unbroken line.
  const textColWidth = isWide ? 'max-w-[240px] break-words' : '';

  const toggleRow = (idx) => {
    setExpanded((m) => ({ ...m, [idx]: !m[idx] }));
    setDrillPage((p) => ({ ...p, [idx]: 0 }));
  };

  // Drill-down modals are shared by every render branch below.
  const drillModals = (
    <>
      <AccountLedgerModal
        open={!!ledger}
        onClose={() => setLedger(null)}
        accountRef={ledger?.accountRef}
        accountName={ledger?.accountName}
        currency={currency}
        from={drillFrom}
        to={drillTo}
        asOf={periodMode}
      />
      <SourceDocumentModal
        open={!!source}
        onClose={() => setSource(null)}
        sourceType={source?.sourceType}
        sourceRef={source?.sourceRef}
        currency={currency}
      />
    </>
  );

  // One cell's drill-down — the invoices/bills/credits that sum into a single
  // (customer, bucket) or (vendor, bucket) amount, e.g. AR/AP Aging Summary.
  // Same Counterparty/Ref/Date/Amount shape as the row-level `r.drill` above,
  // so it reads consistently, just scoped to one cell instead of the whole row.
  const renderCellDrill = (entries, cellKey, colSpan, exportName) => {
    const totalPages = Math.max(1, Math.ceil(entries.length / CELL_DRILL_PAGE_SIZE));
    const pg = Math.min(cellPage[cellKey] || 0, totalPages - 1);
    const start = pg * CELL_DRILL_PAGE_SIZE;
    const slice = entries.slice(start, start + CELL_DRILL_PAGE_SIZE);
    return (
      <tr key={`cell-${cellKey}`}>
        <td colSpan={colSpan} className="px-3 pb-3 pt-1">
          <div className="ml-6 mt-1 mb-2 rounded-lg border border-navy-100 dark:border-navy-800 bg-navy-50/40 dark:bg-navy-900/40">
            <div className="px-3 py-1.5 border-b border-navy-100 dark:border-navy-800 flex items-center justify-end">
              <ExportBtn onClick={() => exportRowsCSV(
                ['Counterparty', 'Ref', 'Date', 'Amount'],
                entries.map((d) => [d.name || '', d.ref || '', d.date || '', d.amount ?? '']),
                exportName || 'Breakdown',
              )} />
            </div>
            <table className="w-full text-[11.5px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-navy-400">
                  <th className="text-left px-3 py-1.5">Counterparty</th>
                  <th className="text-left px-3 py-1.5">Ref</th>
                  <th className="text-left px-3 py-1.5">Date</th>
                  <th className="text-right px-3 py-1.5">Amount</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((d, di) => (
                  <tr key={di} className="border-t border-navy-100 dark:border-navy-800">
                    <td className="px-3 py-1.5 text-navy-700 dark:text-navy-200">{d.name}</td>
                    <td className="px-3 py-1.5 font-mono text-navy-500">{d.ref}</td>
                    <td className="px-3 py-1.5 text-navy-500">{d.date}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-navy-700 dark:text-navy-200">
                      {formatCell(d.amount, decimals, currency, numLocale, parensNeg)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {entries.length > CELL_DRILL_PAGE_SIZE && (
              <div className="px-3 py-1.5 border-t border-navy-100 dark:border-navy-800 flex flex-wrap items-center justify-between gap-2 bg-navy-50/60 dark:bg-navy-900/60">
                <span className="text-[11px] text-navy-500 dark:text-navy-400">
                  Showing {start + 1}–{Math.min(start + CELL_DRILL_PAGE_SIZE, entries.length)} of {entries.length} entries
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={pg === 0}
                    onClick={() => setCellPage((p) => ({ ...p, [cellKey]: pg - 1 }))}
                    className="h-6 px-2 rounded-md border border-navy-200 dark:border-navy-700 text-[11px] font-semibold text-navy-600 dark:text-navy-300 hover:bg-white dark:hover:bg-navy-800 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    ← Prev
                  </button>
                  <span className="text-[11px] text-navy-500 dark:text-navy-400 tabular-nums">Page {pg + 1} of {totalPages}</span>
                  <button
                    type="button"
                    disabled={pg >= totalPages - 1}
                    onClick={() => setCellPage((p) => ({ ...p, [cellKey]: pg + 1 }))}
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
    );
  };

  // ── QuickBooks Online–style sheet ────────────────────────────────────────
  // Clean white sheet, section headers with a collapse chevron, leaf amounts
  // plain and subtotal/total amounts prefixed with the currency symbol — the
  // visual language of QBO's report builder. Only used when the QB viewer asks
  // for it (variant="quickbooks"); Zoho/Xero keep the standard layout.
  if (variant === 'quickbooks') {
    const sym = currencySymbol(currency);
    const toggleSec = (idx) => setCollapsedSec((m) => ({ ...m, [idx]: !m[idx] }));

    // Hide the descendant rows of a collapsed section header. A header at
    // level L hides every following row with level > L until a row at level ≤ L
    // (so its sibling "Total for …" line, which shares the header's level, stays
    // visible — matching QBO).
    let hideAbove = null;
    const visible = [];
    rows.forEach((r, i) => {
      const lvl = r.level || 0;
      if (hideAbove != null) {
        if (lvl > hideAbove) return;
        hideAbove = null;
      }
      visible.push({ r, i });
      if (r.isHeader && collapsedSec[i]) hideAbove = lvl;
    });

    // Subtotal/total rows prefix the currency symbol, but only on money columns —
    // a column that opts out with `money: false` (quantities, percentages) must
    // never be printed as an amount.
    const qbAmount = (v, emphasize) => {
      if (v == null || v === '') return '';
      if (typeof v !== 'number') return v;
      const opts = { dec: decimals, sign: emphasize ? sym : '', locale: numLocale, parens: parensNeg };
      return fmt(v, opts);
    };

    return (
      <div className="overflow-auto scroll-thin max-h-[calc(100vh-15rem)]">
        <table className={cn('w-full border-collapse text-[13px] text-navy-800 dark:text-navy-100', isWide && 'min-w-max')}>
          <thead>
            <tr>
              {cols.map((c, ci) => (
                <th
                  key={c.key}
                  className={cn(
                    'sticky top-0 z-20 bg-white dark:bg-navy-900 border-b border-navy-300 dark:border-navy-600',
                    'py-2 font-semibold text-[12px] text-navy-500 dark:text-navy-400',
                    qbPadX,
                    c.align === 'right' ? 'text-right whitespace-nowrap' : 'text-left',
                    ci === 0 ? labelWidth : (c.align !== 'right' && textColWidth),
                  )}
                >
                  {c.align === 'right' ? (
                    <span className="inline-flex items-center gap-1 justify-end">
                      {c.label}
                      <ChevronsUpDown size={12} className="text-navy-300 dark:text-navy-500" />
                    </span>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map(({ r, i }) => {
              const isHeader   = r.isHeader === true;
              const isSubtotal = r.isSubtotal;
              const isTotal    = r.isTotal;
              const lvl        = r.level || 0;
              const indentPx   = Math.min(lvl, 6) * 18;
              // `breakdown` is a composition list (Balance Sheet sub-totals,
              // synthetic earnings lines): expandable like a transaction drill.
              const hasBreakdown = Array.isArray(r.breakdown) && r.breakdown.length > 0;
              const isDrillable = !!r.drill || hasBreakdown;
              const isExpanded  = expanded[i];
              const collapsed   = collapsedSec[i];
              const emphasize   = isSubtotal || isTotal;       // $-prefix amounts
              const majorLine   = isTotal || (isSubtotal && lvl === 0);

              const rowCls = cn(
                'transition',
                isHeader && 'bg-navy-50 dark:bg-navy-900/50',
                isTotal && 'bg-navy-100/70 dark:bg-navy-800/60 font-bold border-y-2 border-navy-300 dark:border-navy-600',
                isSubtotal && 'font-semibold border-t border-navy-200 dark:border-navy-700',
                majorLine && !isTotal && 'bg-navy-50/70 dark:bg-navy-900/40',
                !isHeader && !isSubtotal && !isTotal && 'hover:bg-navy-50/60 dark:hover:bg-navy-900/40',
              );

              return (
                <Fragment key={i}>
                  <tr className={rowCls}>
                    {cols.map((c, ci) => {
                      const isLabel = ci === 0;
                      const v = isLabel ? r.label : (r.cells?.[c.key] ?? '');
                      const isAccountClickable = isLabel && !!r.accountRef && !isHeader && !isTotal;
                      // AR/AP Aging Summary etc: this ONE cell (not the row) has
                      // its own contributing invoices/bills — click the amount
                      // itself to drill in, the same way QuickBooks' own Summary
                      // report does.
                      const cellEntries = !isLabel ? r.cellDrill?.[c.key] : null;
                      const cellKey = `${i}:${c.key}`;
                      const cellIsOpen = !!expandedCell[cellKey];
                      return (
                        <td
                          key={c.key}
                          className={cn(
                            'py-[7px]',
                            qbPadX,
                            c.align === 'right' ? 'text-right tabular-nums whitespace-nowrap' : 'text-left',
                            isLabel ? labelWidth : (c.align !== 'right' && textColWidth),
                          )}
                          style={isLabel ? { paddingLeft: 12 + indentPx } : undefined}
                        >
                          {isLabel && isHeader && (
                            <button
                              type="button"
                              onClick={() => toggleSec(i)}
                              className="inline-flex items-center mr-1.5 align-middle text-navy-500 hover:text-navy-800 dark:hover:text-white"
                              aria-label={collapsed ? 'Expand section' : 'Collapse section'}
                            >
                              {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                            </button>
                          )}
                          {isLabel && isDrillable && !isHeader && (
                            <button
                              type="button"
                              onClick={() => toggleRow(i)}
                              className="inline-flex items-center mr-1 align-middle text-navy-400 hover:text-brand-600"
                              aria-label={isExpanded ? 'Collapse' : 'Expand'}
                            >
                              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            </button>
                          )}
                          {isAccountClickable ? (
                            <button
                              type="button"
                              onClick={() => setLedger({ accountRef: String(r.accountRef), accountName: r.accountName || r.label })}
                              className="text-left text-brand-600 hover:underline"
                            >
                              {v}
                            </button>
                          ) : isLabel ? (
                            v
                          ) : cellEntries?.length ? (
                            <button
                              type="button"
                              onClick={() => toggleCell(cellKey)}
                              className={cn(
                                'text-brand-600 hover:underline tabular-nums',
                                cellIsOpen && 'underline',
                              )}
                              aria-label={cellIsOpen ? 'Collapse' : 'Expand'}
                            >
                              {qbAmount(v, emphasize && c.money !== false)}
                            </button>
                          ) : (
                            qbAmount(v, emphasize && c.money !== false)
                          )}
                        </td>
                      );
                    })}
                  </tr>
                  {cols.map((c, ci) => {
                    if (ci === 0) return null;
                    const cellKey = `${i}:${c.key}`;
                    const entries = r.cellDrill?.[c.key];
                    if (!entries?.length || !expandedCell[cellKey]) return null;
                    return renderCellDrill(entries, cellKey, cols.length, `${r.label} - ${c.label}`);
                  })}
                  {hasBreakdown && !r.drill && isExpanded && (
                    <tr>
                      <td colSpan={cols.length} className="px-3 pb-3 pt-1">
                        <div className="ml-6 mt-1 mb-2 rounded-lg border border-navy-100 dark:border-navy-800 bg-navy-50/40 dark:bg-navy-900/40">
                          <div className="px-3 py-1.5 border-b border-navy-100 dark:border-navy-800 flex items-center justify-end">
                            <ExportBtn onClick={() => exportRowsCSV(
                              ['Component', 'Amount'],
                              r.breakdown.map((b) => [b.label || '', b.amount ?? '']),
                              r.label || 'Breakdown',
                            )} />
                          </div>
                          <table className="w-full text-[11.5px]">
                            <thead>
                              <tr className="text-[10px] uppercase tracking-wider text-navy-400">
                                <th className="text-left px-3 py-1.5">Component</th>
                                <th className="text-right px-3 py-1.5">Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.breakdown.map((b, bi) => {
                                const clickable = !!b.accountRef;
                                return (
                                  <tr
                                    key={bi}
                                    className={cn(
                                      'border-t border-navy-100 dark:border-navy-800',
                                      clickable && 'cursor-pointer hover:bg-navy-100/60 dark:hover:bg-navy-800/40',
                                    )}
                                    onClick={clickable ? () => setLedger({ accountRef: String(b.accountRef), accountName: b.label }) : undefined}
                                  >
                                    <td className={cn('px-3 py-1.5', clickable ? 'text-brand-600' : 'text-navy-700 dark:text-navy-200')}>{b.label}</td>
                                    <td className="px-3 py-1.5 text-right tabular-nums text-navy-700 dark:text-navy-200">
                                      {formatCell(b.amount, decimals, currency, numLocale, parensNeg)}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                  {r.drill && isExpanded && (() => {
                    const allDrill = r.drill || [];
                    const drillTotalPages = Math.max(1, Math.ceil(allDrill.length / DRILL_PAGE_SIZE));
                    const drillPg = Math.min(drillPage[i] || 0, drillTotalPages - 1);
                    const drillStart = drillPg * DRILL_PAGE_SIZE;
                    const drillSlice = allDrill.slice(drillStart, drillStart + DRILL_PAGE_SIZE);
                    return (
                    <tr>
                      <td colSpan={cols.length} className="px-3 pb-3 pt-1">
                        <div className="ml-6 mt-1 mb-2 rounded-lg border border-navy-100 dark:border-navy-800 bg-navy-50/40 dark:bg-navy-900/40">
                          <div className="px-3 py-1.5 border-b border-navy-100 dark:border-navy-800 flex items-center justify-end">
                            <ExportBtn onClick={() => exportRowsCSV(
                              ['Counterparty', 'Ref', 'Date', 'Amount'],
                              allDrill.map((d) => [d.name || '', d.ref || '', d.date || '', d.amount ?? '']),
                              r.label || 'Drilldown',
                            )} />
                          </div>
                          <table className="w-full text-[11.5px]">
                            <thead>
                              <tr className="text-[10px] uppercase tracking-wider text-navy-400">
                                <th className="text-left px-3 py-1.5">Counterparty</th>
                                <th className="text-left px-3 py-1.5">Ref</th>
                                <th className="text-left px-3 py-1.5">Date</th>
                                <th className="text-right px-3 py-1.5">Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {drillSlice.map((d, di) => {
                                const drillToSource = !!(d.sourceType && d.sourceRef);
                                return (
                                  <tr
                                    key={di}
                                    className={cn(
                                      'border-t border-navy-100 dark:border-navy-800',
                                      drillToSource && 'cursor-pointer hover:bg-navy-100/60 dark:hover:bg-navy-800/40',
                                    )}
                                    onClick={drillToSource ? () => setSource({ sourceType: d.sourceType, sourceRef: d.sourceRef }) : undefined}
                                  >
                                    <td className={cn('px-3 py-1.5', drillToSource ? 'text-brand-600' : 'text-navy-700 dark:text-navy-200')}>{d.name}</td>
                                    <td className="px-3 py-1.5 font-mono text-navy-500">{d.ref}</td>
                                    <td className="px-3 py-1.5 text-navy-500">{d.date}</td>
                                    <td className="px-3 py-1.5 text-right tabular-nums text-navy-700 dark:text-navy-200">
                                      {formatCell(d.amount, decimals, currency, numLocale, parensNeg)}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          {allDrill.length > DRILL_PAGE_SIZE && (
                            <div className="px-3 py-1.5 border-t border-navy-100 dark:border-navy-800 flex items-center justify-between gap-2 bg-navy-50/60 dark:bg-navy-900/60">
                              <span className="text-[11px] text-navy-500 dark:text-navy-400">
                                Showing {drillStart + 1}–{Math.min(drillStart + DRILL_PAGE_SIZE, allDrill.length)} of {allDrill.length} entries
                              </span>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  disabled={drillPg === 0}
                                  onClick={() => setDrillPage((p) => ({ ...p, [i]: drillPg - 1 }))}
                                  className="h-6 px-2 rounded-md border border-navy-200 dark:border-navy-700 text-[11px] font-semibold text-navy-600 dark:text-navy-300 hover:bg-white dark:hover:bg-navy-800 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  ← Prev
                                </button>
                                <span className="text-[11px] text-navy-500 dark:text-navy-400 tabular-nums">Page {drillPg + 1} of {drillTotalPages}</span>
                                <button
                                  type="button"
                                  disabled={drillPg >= drillTotalPages - 1}
                                  onClick={() => setDrillPage((p) => ({ ...p, [i]: drillPg + 1 }))}
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
                    );
                  })()}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {drillModals}
      </div>
    );
  }

  return (
    <div className="overflow-auto scroll-thin max-h-[calc(100vh-15rem)]">
      <table className={cn('w-full border-collapse text-[12.5px]', isWide && 'min-w-max')}>
        <thead>
          <tr>
            {cols.map((c, ci) => (
              <th
                key={c.key}
                className={cn(
                  'sticky top-0 z-20 bg-white dark:bg-navy-900 py-2.5 font-semibold text-navy-500 dark:text-navy-400 uppercase tracking-[0.12em] text-[10.5px] border-b border-navy-200 dark:border-navy-700',
                  stdPadX,
                  c.align === 'right' ? 'text-right whitespace-nowrap' : 'text-left',
                  ci === 0 ? labelWidth : (c.align !== 'right' && textColWidth),
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            // Backend now emits explicit isHeader for section titles.
            // Fall back to legacy "level === 0" behaviour for older reports.
            const isHeader   = r.isHeader === true || (r.isHeader == null && r.level === 0 && !r.isSubtotal && !r.isTotal);
            const isSubtotal = r.isSubtotal;
            const isTotal    = r.isTotal;
            const hasBreakdown = Array.isArray(r.breakdown) && r.breakdown.length > 0;
            const isDrillable = !!r.drill || hasBreakdown;
            const isExpanded = expanded[i];
            const indentPx = Math.min((r.level || 0), 5) * 16;

            const rowCls = cn(
              'transition',
              isHeader   && 'bg-navy-50/50 dark:bg-navy-900/40 border-t border-navy-100 dark:border-navy-800',
              isSubtotal && 'bg-navy-50 dark:bg-navy-900/60 font-semibold',
              isTotal    && 'bg-brand-50/60 dark:bg-brand-500/10 font-bold border-t-2 border-brand-300 dark:border-brand-500/40',
              !isHeader && !isSubtotal && !isTotal && 'hover:bg-navy-50/50 dark:hover:bg-navy-900/40',
            );

            return (
              <Fragment key={i}>
                <tr className={rowCls}>
                  {cols.map((c, ci) => {
                    const isLabel = ci === 0;
                    const v = isLabel ? r.label : (r.cells?.[c.key] ?? '');
                    // The account label drills to its General Ledger when the
                    // backend tagged the row with an accountRef (Report→Account).
                    const isAccountClickable = isLabel && !!r.accountRef && !isHeader && !isTotal;
                    return (
                      <td
                        key={c.key}
                        className={cn(
                          'py-2.5',
                          stdPadX,
                          c.align === 'right' ? 'text-right tabular-nums whitespace-nowrap' : 'text-left',
                          isLabel ? labelWidth : (c.align !== 'right' && textColWidth),
                          isHeader   && 'font-bold text-navy-800 dark:text-navy-100',
                          !isHeader && !isSubtotal && !isTotal && 'text-navy-700 dark:text-navy-300',
                        )}
                        style={isLabel ? { paddingLeft: 12 + indentPx } : undefined}
                      >
                        {isLabel && isDrillable && (
                          <button
                            type="button"
                            onClick={() => toggleRow(i)}
                            className="inline-flex items-center mr-1 text-navy-400 hover:text-brand-600 align-middle"
                            aria-label={isExpanded ? 'Collapse' : 'Expand'}
                          >
                            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          </button>
                        )}
                        {isAccountClickable ? (
                          <button
                            type="button"
                            onClick={() => setLedger({ accountRef: String(r.accountRef), accountName: r.accountName || r.label })}
                            className="text-left text-brand-600 hover:underline"
                          >
                            {v}
                          </button>
                        ) : (
                          v == null || v === '' ? '' : (typeof v === 'number' ? formatCell(v, decimals, currency, numLocale, parensNeg) : v)
                        )}
                      </td>
                    );
                  })}
                </tr>
                {hasBreakdown && !r.drill && isExpanded && (
                  <tr>
                    <td colSpan={cols.length} className="px-3 pb-3 pt-1">
                      <div className="ml-6 mt-1 mb-2 rounded-lg border border-navy-100 dark:border-navy-800 bg-navy-50/40 dark:bg-navy-900/40">
                        <div className="px-3 py-1.5 border-b border-navy-100 dark:border-navy-800 flex items-center justify-end">
                          <ExportBtn onClick={() => exportRowsCSV(
                            ['Component', 'Amount'],
                            r.breakdown.map((b) => [b.label || '', b.amount ?? '']),
                            r.label || 'Breakdown',
                          )} />
                        </div>
                        <table className="w-full text-[11.5px]">
                          <thead>
                            <tr className="text-[10px] uppercase tracking-wider text-navy-400">
                              <th className="text-left px-3 py-1.5">Component</th>
                              <th className="text-right px-3 py-1.5">Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.breakdown.map((b, bi) => {
                              const clickable = !!b.accountRef;
                              return (
                                <tr
                                  key={bi}
                                  className={cn(
                                    'border-t border-navy-100 dark:border-navy-800',
                                    clickable && 'cursor-pointer hover:bg-navy-100/60 dark:hover:bg-navy-800/40',
                                  )}
                                  onClick={clickable ? () => setLedger({ accountRef: String(b.accountRef), accountName: b.label }) : undefined}
                                >
                                  <td className={cn('px-3 py-1.5', clickable ? 'text-brand-600' : 'text-navy-700 dark:text-navy-200')}>{b.label}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums text-navy-700 dark:text-navy-200">
                                    {formatCell(b.amount, decimals, currency, numLocale, parensNeg)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
                {r.drill && isExpanded && (
                  <tr>
                    <td colSpan={cols.length} className="px-3 pb-3 pt-1">
                      <div className="ml-6 mt-1 mb-2 rounded-lg border border-navy-100 dark:border-navy-800 bg-navy-50/40 dark:bg-navy-900/40">
                        <div className="px-3 py-1.5 border-b border-navy-100 dark:border-navy-800 flex items-center justify-end">
                          <ExportBtn onClick={() => exportRowsCSV(
                            ['Counterparty', 'Ref', 'Date', 'Amount'],
                            r.drill.map((d) => [d.name || '', d.ref || '', d.date || '', d.amount ?? '']),
                            r.label || 'Drilldown',
                          )} />
                        </div>
                        <table className="w-full text-[11.5px]">
                          <thead>
                            <tr className="text-[10px] uppercase tracking-wider text-navy-400">
                              <th className="text-left px-3 py-1.5">Counterparty</th>
                              <th className="text-left px-3 py-1.5">Ref</th>
                              <th className="text-left px-3 py-1.5">Date</th>
                              <th className="text-right px-3 py-1.5">Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.drill.map((d, di) => {
                              const drillToSource = !!(d.sourceType && d.sourceRef);
                              return (
                                <tr
                                  key={di}
                                  className={cn(
                                    'border-t border-navy-100 dark:border-navy-800',
                                    drillToSource && 'cursor-pointer hover:bg-navy-100/60 dark:hover:bg-navy-800/40',
                                  )}
                                  onClick={drillToSource ? () => setSource({ sourceType: d.sourceType, sourceRef: d.sourceRef }) : undefined}
                                >
                                  <td className={cn('px-3 py-1.5', drillToSource ? 'text-brand-600' : 'text-navy-700 dark:text-navy-200')}>{d.name}</td>
                                  <td className="px-3 py-1.5 font-mono text-navy-500">{d.ref}</td>
                                  <td className="px-3 py-1.5 text-navy-500">{d.date}</td>
                                  <td className="px-3 py-1.5 text-right tabular-nums text-navy-700 dark:text-navy-200">
                                    {formatCell(d.amount, decimals, currency, numLocale, parensNeg)}
                                  </td>
                                </tr>
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
      {drillModals}
    </div>
  );
}
