import { useState, useEffect, useCallback } from 'react';
import { useSelector } from 'react-redux';
import {
  Search, RefreshCw, ChevronLeft, ChevronRight,
  ArrowUpRight, ArrowDownLeft, BookOpen, Download,
  ChevronsLeft, ChevronsRight,
} from 'lucide-react';
import axiosClient from '../services/axiosClient.js';
import { fmt, currencySymbol, getActiveCurrency } from '../utils/fmt.js';
import { selectDateRange, selectPeriod, selectCustomRange } from '../features/filters/filtersSlice.js';
import PeriodFilter from '../components/common/PeriodFilter.jsx';
import Badge from '../components/ui/Badge.jsx';

const PAGE_SIZES = [50, 100, 200];

const TYPE_LABELS = {
  Invoice:            { tone: 'blue',   label: 'Invoice' },
  'Customer Payment': { tone: 'green',  label: 'Payment In' },
  Bill:               { tone: 'amber',  label: 'Bill' },
  'Vendor Payment':   { tone: 'red',    label: 'Payment Out' },
  Expense:            { tone: 'amber',  label: 'Expense' },
  'Journal Entry':    { tone: 'navy',   label: 'Journal' },
  'Credit Note':      { tone: 'purple', label: 'Credit Note' },
  'Debit Note':       { tone: 'purple', label: 'Debit Note' },
};

function typeMeta(type) {
  return TYPE_LABELS[type] || { tone: 'navy', label: type || '—' };
}

function fmtAmt(n) {
  if (!n || n === '0.00' || parseFloat(n) === 0) return '—';
  return fmt(parseFloat(n), { dec: 2 });
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtTotal(n) {
  return fmt(parseFloat(n) || 0);
}

// Returns array of page numbers + '...' sentinels
function pageWindow(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = [];
  const left  = Math.max(2, current - 2);
  const right = Math.min(total - 1, current + 2);
  pages.push(1);
  if (left > 2) pages.push('...');
  for (let p = left; p <= right; p++) pages.push(p);
  if (right < total - 1) pages.push('...');
  pages.push(total);
  return pages;
}

// ── Invoice row (fallback when daybook is empty) ──────────────────────────────
function InvoiceRow({ row, idx }) {
  const isPaid = row.status === 'paid';
  return (
    <tr className="border-b border-navy-100 dark:border-navy-800 hover:bg-navy-50/50 dark:hover:bg-navy-800/40 transition-colors">
      <td className="py-3 pl-4 pr-2 text-[11px] text-navy-400 tabular-nums">{idx}</td>
      <td className="py-3 px-3 text-[12px] text-navy-600 dark:text-navy-400 tabular-nums whitespace-nowrap">
        {fmtDate(row.date)}
      </td>
      <td className="py-3 px-3"><Badge tone="blue">Invoice</Badge></td>
      <td className="py-3 px-3 text-[12.5px] font-mono text-navy-700 dark:text-navy-300">{row.invoice_number || '—'}</td>
      <td className="py-3 px-3 text-[12.5px] text-navy-800 dark:text-navy-200 max-w-[200px] truncate">{row.customer_name || '—'}</td>
      <td className="py-3 px-3 text-[11.5px] text-navy-500">Accounts Receivable</td>
      <td className="py-3 px-3 text-right">
        <span className="text-[12.5px] font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{fmtAmt(row.total)}</span>
      </td>
      <td className="py-3 px-3 text-right">
        <span className="text-[12.5px] font-semibold tabular-nums text-red-500">{fmtAmt(row.balance)}</span>
      </td>
      <td className="py-3 pr-4 pl-3">
        <span className={`inline-flex items-center gap-1 text-[10.5px] font-semibold px-2 py-0.5 rounded-full ${
          isPaid
            ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
            : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
        }`}>
          {isPaid ? '✓ Paid' : row.status}
        </span>
      </td>
    </tr>
  );
}

// ── DayBook row ───────────────────────────────────────────────────────────────
function DaybookRow({ row, idx }) {
  const meta     = typeMeta(row.transaction_type);
  const isCredit = parseFloat(row.credit) > 0;
  return (
    <tr className="border-b border-navy-100 dark:border-navy-800 hover:bg-navy-50/50 dark:hover:bg-navy-800/40 transition-colors">
      <td className="py-3 pl-4 pr-2 text-[11px] text-navy-400 tabular-nums">{idx}</td>
      <td className="py-3 px-3 text-[12px] text-navy-600 dark:text-navy-400 tabular-nums whitespace-nowrap">
        {fmtDate(row.transaction_date)}
      </td>
      <td className="py-3 px-3"><Badge tone={meta.tone}>{meta.label}</Badge></td>
      <td className="py-3 px-3 text-[12.5px] font-mono text-navy-700 dark:text-navy-300">{row.reference_number || '—'}</td>
      <td className="py-3 px-3 text-[12.5px] text-navy-800 dark:text-navy-200 max-w-[200px] truncate">
        {row.entity_name || row.description || '—'}
      </td>
      <td className="py-3 px-3 text-[11.5px] text-navy-500 max-w-[160px] truncate">{row.account_name || '—'}</td>
      <td className="py-3 px-3 text-right">
        {parseFloat(row.credit) > 0 ? (
          <span className="inline-flex items-center gap-1 text-[12.5px] font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
            <ArrowDownLeft size={11} />{fmtAmt(row.credit)}
          </span>
        ) : '—'}
      </td>
      <td className="py-3 px-3 text-right">
        {parseFloat(row.debit) > 0 ? (
          <span className="inline-flex items-center gap-1 text-[12.5px] font-semibold tabular-nums text-red-500">
            <ArrowUpRight size={11} />{fmtAmt(row.debit)}
          </span>
        ) : '—'}
      </td>
      <td className="py-3 pr-4 pl-3">
        <span className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full ${
          isCredit
            ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700'
            : 'bg-red-100 dark:bg-red-900/30 text-red-600'
        }`}>
          {isCredit ? 'Credit' : 'Debit'}
        </span>
      </td>
    </tr>
  );
}

// ── Pagination bar ────────────────────────────────────────────────────────────
function Pagination({ page, totalPages, pageSize, total, onPage, onPageSize }) {
  const [jumpVal, setJumpVal] = useState('');
  const pages = pageWindow(page, totalPages);
  const from  = (page - 1) * pageSize + 1;
  const to    = Math.min(page * pageSize, total);

  function handleJump(e) {
    if (e.key === 'Enter') {
      const n = parseInt(jumpVal);
      if (n >= 1 && n <= totalPages) { onPage(n); setJumpVal(''); }
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-navy-100 dark:border-navy-800">
      {/* Left: row count + per-page */}
      <div className="flex items-center gap-3 text-[12px] text-navy-500">
        <span>{from.toLocaleString('en-IN')}–{to.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')}</span>
        <span className="text-navy-300">|</span>
        <span>Rows</span>
        <select
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
          className="h-7 px-2 rounded-md border border-navy-200 dark:border-navy-700 bg-white dark:bg-navy-900 text-[12px] text-navy-700 dark:text-navy-300 focus:outline-none"
        >
          {PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Centre: page buttons */}
      <div className="flex items-center gap-1">
        {/* First */}
        <button
          onClick={() => onPage(1)} disabled={page === 1}
          title="First page"
          className="h-7 w-7 rounded-lg flex items-center justify-center border border-navy-200 dark:border-navy-700 text-navy-500 hover:bg-navy-50 dark:hover:bg-navy-800 disabled:opacity-30 transition"
        >
          <ChevronsLeft size={13} />
        </button>
        {/* Prev */}
        <button
          onClick={() => onPage(page - 1)} disabled={page === 1}
          title="Previous page"
          className="h-7 w-7 rounded-lg flex items-center justify-center border border-navy-200 dark:border-navy-700 text-navy-500 hover:bg-navy-50 dark:hover:bg-navy-800 disabled:opacity-30 transition"
        >
          <ChevronLeft size={13} />
        </button>

        {pages.map((p, i) =>
          p === '...' ? (
            <span key={`ellipsis-${i}`} className="h-7 w-7 flex items-center justify-center text-[12px] text-navy-400">…</span>
          ) : (
            <button
              key={p}
              onClick={() => onPage(p)}
              className={`h-7 min-w-[28px] px-1.5 rounded-lg text-[12px] font-medium transition ${
                p === page
                  ? 'bg-brand-500 text-white shadow-sm'
                  : 'border border-navy-200 dark:border-navy-700 text-navy-600 dark:text-navy-300 hover:bg-navy-50 dark:hover:bg-navy-800'
              }`}
            >
              {p}
            </button>
          )
        )}

        {/* Next */}
        <button
          onClick={() => onPage(page + 1)} disabled={page === totalPages}
          title="Next page"
          className="h-7 w-7 rounded-lg flex items-center justify-center border border-navy-200 dark:border-navy-700 text-navy-500 hover:bg-navy-50 dark:hover:bg-navy-800 disabled:opacity-30 transition"
        >
          <ChevronRight size={13} />
        </button>
        {/* Last */}
        <button
          onClick={() => onPage(totalPages)} disabled={page === totalPages}
          title="Last page"
          className="h-7 w-7 rounded-lg flex items-center justify-center border border-navy-200 dark:border-navy-700 text-navy-500 hover:bg-navy-50 dark:hover:bg-navy-800 disabled:opacity-30 transition"
        >
          <ChevronsRight size={13} />
        </button>
      </div>

      {/* Right: jump to page */}
      {totalPages > 10 && (
        <div className="flex items-center gap-2 text-[12px] text-navy-500">
          <span>Go to</span>
          <input
            type="number"
            min={1}
            max={totalPages}
            value={jumpVal}
            onChange={(e) => setJumpVal(e.target.value)}
            onKeyDown={handleJump}
            placeholder={String(page)}
            className="h-7 w-16 px-2 rounded-md border border-navy-200 dark:border-navy-700 bg-white dark:bg-navy-900 text-[12px] text-navy-700 dark:text-navy-300 text-center focus:outline-none focus:border-brand-400"
          />
          <span className="text-navy-400">of {totalPages}</span>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Transactions() {
  const dateRange   = useSelector(selectDateRange);
  const period      = useSelector(selectPeriod);
  const customRange = useSelector(selectCustomRange);

  const [search,       setSearch]       = useState('');
  const [typeFilter,   setTypeFilter]   = useState('');
  const [page,         setPage]         = useState(1);
  const [pageSize,     setPageSize]     = useState(50);
  const [rows,         setRows]         = useState([]);
  const [total,        setTotal]        = useState(0);
  const [periodCredit, setPeriodCredit] = useState(0);
  const [periodDebit,  setPeriodDebit]  = useState(0);
  const [loading,      setLoading]      = useState(false);
  const [mode,         setMode]         = useState('invoices');
  const [syncing,      setSyncing]      = useState(false);
  const [exporting,    setExporting]    = useState(false);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const dbRes = await axiosClient.get('/transactions', {
        params: { page, limit: pageSize, search, type: typeFilter || undefined,
                  from: dateRange.from, to: dateRange.to },
      });
      if (dbRes.data.total > 0) {
        setMode('daybook');
        setRows(dbRes.data.data);
        setTotal(dbRes.data.total);
        setPeriodCredit(parseFloat(dbRes.data.periodCredit) || 0);
        setPeriodDebit(parseFloat(dbRes.data.periodDebit)   || 0);
      } else {
        setMode('invoices');
        const invRes = await axiosClient.get('/transactions/invoices', {
          params: { page, limit: pageSize, from: dateRange.from, to: dateRange.to },
        });
        const invRows = invRes.data.data ?? [];
        setRows(invRows);
        setTotal(invRes.data.total ?? 0);
        const sumCredit = invRows.reduce((s, r) => s + parseFloat(r.total   || 0), 0);
        const sumDebit  = invRows.reduce((s, r) => s + parseFloat(r.balance || 0), 0);
        setPeriodCredit(sumCredit);
        setPeriodDebit(sumDebit);
      }
    } catch {
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, search, typeFilter, dateRange.from, dateRange.to]);

  // Reset to page 1 when filters change (but not page/pageSize)
  useEffect(() => {
    setPage(1);
  }, [period, customRange.from, customRange.to, search, typeFilter, pageSize]);

  useEffect(() => { load(); }, [load]);

  async function handleSync() {
    setSyncing(true);
    try { await axiosClient.post('/sync/daybook'); } catch {}
    setTimeout(() => { setSyncing(false); load(); }, 3000);
  }

  // Export the FULL period (not just the current page) to an .xlsx workbook,
  // currency-aware, matching whichever view is active (Day Book / Invoices).
  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    try {
      const XLSX = await import('xlsx');
      const sym = currencySymbol(getActiveCurrency());
      const stamp = `${dateRange.from} to ${dateRange.to}`;
      let header, body, sheet, file, cols;

      if (mode === 'daybook') {
        const res = await axiosClient.get('/transactions', {
          params: { page: 1, limit: 100000, search, type: typeFilter || undefined, from: dateRange.from, to: dateRange.to },
        });
        const all = res.data?.data ?? [];
        header = ['Date', 'Reference', 'Entity / Description', 'Account', `Credit (${sym})`, `Debit (${sym})`, 'Status'];
        body = all.map((r) => [
          r.date || '',
          r.reference_number || '',
          r.entity_name || r.description || '',
          r.account_name || '',
          parseFloat(r.credit) || 0,
          parseFloat(r.debit) || 0,
          r.status || '',
        ]);
        const totCredit = all.reduce((s, r) => s + (parseFloat(r.credit) || 0), 0);
        const totDebit  = all.reduce((s, r) => s + (parseFloat(r.debit)  || 0), 0);
        body.push(['', '', '', 'Total', totCredit, totDebit, '']);
        cols = [{ wch: 12 }, { wch: 16 }, { wch: 34 }, { wch: 26 }, { wch: 16 }, { wch: 16 }, { wch: 12 }];
        sheet = 'Day Book';
        file = `Day Book ${stamp}.xlsx`;
      } else {
        const res = await axiosClient.get('/transactions/invoices', {
          params: { page: 1, limit: 100000, from: dateRange.from, to: dateRange.to },
        });
        const all = res.data?.data ?? [];
        header = ['Date', 'Customer', `Total (${sym})`, `Balance (${sym})`, 'Status'];
        body = all.map((r) => [r.date || '', r.customer_name || '', parseFloat(r.total) || 0, parseFloat(r.balance) || 0, r.status || '']);
        cols = [{ wch: 12 }, { wch: 30 }, { wch: 16 }, { wch: 16 }, { wch: 12 }];
        sheet = 'Invoices';
        file = `Invoices ${stamp}.xlsx`;
      }

      const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
      ws['!cols'] = cols;
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, sheet);
      XLSX.writeFile(wb, file);
    } catch {
      /* export failed — leave UI unchanged */
    } finally {
      setExporting(false);
    }
  }

  const net = periodCredit - periodDebit;

  return (
    <div className="p-6 lg:p-7 max-w-[1600px] mx-auto">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <BookOpen size={14} className="text-navy-400" />
            <span className="text-[10.5px] font-bold tracking-[0.18em] uppercase text-navy-500">
              {mode === 'daybook' ? 'Day Book · Zoho Synced' : 'Invoices · Zoho Synced'}
            </span>
          </div>
          <h1 className="text-[24px] font-bold text-navy-900 dark:text-white">Transactions</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <PeriodFilter />
          <button
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-navy-200 dark:border-navy-700 bg-white dark:bg-navy-900 text-navy-600 dark:text-navy-300 text-[12px] font-medium hover:bg-navy-50 dark:hover:bg-navy-800 transition disabled:opacity-50"
          >
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
          <button
            onClick={handleExport}
            disabled={exporting || loading || rows.length === 0}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-navy-200 dark:border-navy-700 bg-white dark:bg-navy-900 text-navy-600 dark:text-navy-300 text-[12px] font-medium hover:bg-navy-50 dark:hover:bg-navy-800 transition disabled:opacity-50"
          >
            <Download size={13} /> {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>

      {/* ── Summary chips (period totals, not page totals) ── */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="flex items-center gap-2 bg-white dark:bg-navy-900 rounded-xl border border-navy-200 dark:border-navy-800 px-4 py-2.5">
          <ArrowDownLeft size={14} className="text-emerald-500 shrink-0" />
          <div>
            <div className="text-[10px] uppercase tracking-wider text-navy-500 font-semibold">
              {mode === 'daybook' ? 'Total Inflow' : 'Total Invoiced'}
            </div>
            <div className="text-[15px] font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
              {fmtTotal(periodCredit)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 bg-white dark:bg-navy-900 rounded-xl border border-navy-200 dark:border-navy-800 px-4 py-2.5">
          <ArrowUpRight size={14} className="text-red-500 shrink-0" />
          <div>
            <div className="text-[10px] uppercase tracking-wider text-navy-500 font-semibold">
              {mode === 'daybook' ? 'Total Outflow' : 'Outstanding'}
            </div>
            <div className="text-[15px] font-bold text-red-500 tabular-nums">
              {fmtTotal(periodDebit)}
            </div>
          </div>
        </div>
        {mode === 'daybook' && (
          <div className="flex items-center gap-2 bg-white dark:bg-navy-900 rounded-xl border border-navy-200 dark:border-navy-800 px-4 py-2.5">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-navy-500 font-semibold">Net</div>
              <div className={`text-[15px] font-bold tabular-nums ${net >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
                {fmtTotal(Math.abs(net))}
                <span className="text-[11px] ml-1">{net >= 0 ? 'surplus' : 'deficit'}</span>
              </div>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 bg-white dark:bg-navy-900 rounded-xl border border-navy-200 dark:border-navy-800 px-4 py-2.5">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-navy-500 font-semibold">Entries</div>
            <div className="text-[15px] font-bold text-navy-900 dark:text-white tabular-nums">
              {total.toLocaleString('en-IN')}
            </div>
          </div>
        </div>
      </div>

      {/* ── Filters row ── */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[220px] max-w-[380px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-navy-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search reference, description, entity…"
            className="w-full h-9 pl-8 pr-3 rounded-lg bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-700 text-[12.5px] text-navy-800 dark:text-navy-200 placeholder:text-navy-400 focus:outline-none focus:border-brand-400 transition"
          />
        </div>

        {mode === 'daybook' && (
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="h-9 px-3 rounded-lg bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-700 text-[12.5px] text-navy-700 dark:text-navy-300 focus:outline-none focus:border-brand-400 transition"
          >
            <option value="">All types</option>
            <option value="Invoice">Invoice</option>
            <option value="Customer Payment">Customer Payment</option>
            <option value="Bill">Bill</option>
            <option value="Vendor Payment">Vendor Payment</option>
            <option value="Expense">Expense</option>
            <option value="Journal Entry">Journal Entry</option>
          </select>
        )}

        <span className="h-9 inline-flex items-center px-3 rounded-lg bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-700 text-[11.5px] font-medium text-navy-500 tabular-nums ml-auto whitespace-nowrap">
          {fmtDate(dateRange.from)} – {fmtDate(dateRange.to)}
        </span>
      </div>

      {/* ── Table ── */}
      <div className="bg-white dark:bg-navy-900 rounded-2xl border border-navy-200 dark:border-navy-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead>
              <tr className="border-b border-navy-100 dark:border-navy-800 bg-navy-50/70 dark:bg-navy-800/50">
                <th className="py-2.5 pl-4 pr-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-navy-500 w-10">#</th>
                <th className="py-2.5 px-3 text-left text-[10.5px] font-bold uppercase tracking-wider text-navy-500 w-28">Date</th>
                <th className="py-2.5 px-3 text-left text-[10.5px] font-bold uppercase tracking-wider text-navy-500 w-32">Type</th>
                <th className="py-2.5 px-3 text-left text-[10.5px] font-bold uppercase tracking-wider text-navy-500 w-32">Reference</th>
                <th className="py-2.5 px-3 text-left text-[10.5px] font-bold uppercase tracking-wider text-navy-500">Entity / Description</th>
                <th className="py-2.5 px-3 text-left text-[10.5px] font-bold uppercase tracking-wider text-navy-500 w-40">Account</th>
                <th className="py-2.5 px-3 text-right text-[10.5px] font-bold uppercase tracking-wider text-navy-500 w-32">
                  {mode === 'daybook' ? `Credit (${currencySymbol(getActiveCurrency())})` : `Amount (${currencySymbol(getActiveCurrency())})`}
                </th>
                <th className="py-2.5 px-3 text-right text-[10.5px] font-bold uppercase tracking-wider text-navy-500 w-32">
                  {mode === 'daybook' ? `Debit (${currencySymbol(getActiveCurrency())})` : `Balance (${currencySymbol(getActiveCurrency())})`}
                </th>
                <th className="py-2.5 pr-4 pl-3 text-left text-[10.5px] font-bold uppercase tracking-wider text-navy-500 w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(Math.min(pageSize, 10))].map((_, i) => (
                  <tr key={i} className="border-b border-navy-100 dark:border-navy-800 animate-pulse">
                    {[...Array(9)].map((_, j) => (
                      <td key={j} className="py-3 px-3">
                        <div className="h-3 rounded bg-navy-100 dark:bg-navy-800" style={{ width: `${40 + (j * 13) % 50}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-16 text-center">
                    <BookOpen size={32} className="mx-auto text-navy-300 mb-3" />
                    <p className="text-[13px] font-medium text-navy-500">No transactions for this period</p>
                    <p className="text-[11.5px] text-navy-400 mt-1">
                      Try a wider date range or click Sync to fetch from Zoho Books
                    </p>
                  </td>
                </tr>
              ) : mode === 'daybook' ? (
                rows.map((row, i) => (
                  <DaybookRow key={row.id} row={row} idx={(page - 1) * pageSize + i + 1} />
                ))
              ) : (
                rows.map((row, i) => (
                  <InvoiceRow key={row.id} row={row} idx={(page - 1) * pageSize + i + 1} />
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > 0 && (
          <Pagination
            page={page}
            totalPages={totalPages}
            pageSize={pageSize}
            total={total}
            onPage={(p) => setPage(p)}
            onPageSize={(s) => { setPageSize(s); setPage(1); }}
          />
        )}
      </div>
    </div>
  );
}
