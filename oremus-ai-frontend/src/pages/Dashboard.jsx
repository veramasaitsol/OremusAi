import { useEffect, useState, useRef, Suspense } from 'react';
import lazyWithRetry from '../utils/lazyWithRetry.js';
import { useDispatch, useSelector } from 'react-redux';
import {
  Calendar, ChevronDown, Check, TrendingUp, Sparkles, Loader2, AlertTriangle, RefreshCw,
} from 'lucide-react';
import axiosClient from '../services/axiosClient.js';
import Badge from '../components/ui/Badge.jsx';
import DashboardTabs from '../components/common/DashboardTabs.jsx';
import GlobalSearch from '../components/common/GlobalSearch.jsx';
import HeroChartTile from '../components/dashboard/HeroChartTile.jsx';
import KpiTile from '../components/dashboard/KpiTile.jsx';
import KpiDetailModal from '../components/dashboard/KpiDetailModal.jsx';
import CashFlowTile from '../components/dashboard/CashFlowTile.jsx';
import ExpenseMixTile from '../components/dashboard/ExpenseMixTile.jsx';
import ExpenseMixModal from '../components/dashboard/ExpenseMixModal.jsx';
import TopListTile from '../components/dashboard/TopListTile.jsx';
import TopListModal from '../components/dashboard/TopListModal.jsx';
import ComplianceTile from '../components/dashboard/ComplianceTile.jsx';
import AiInsightsTile from '../components/dashboard/AiInsightsTile.jsx';
import AskOremusModal from '../components/dashboard/AskOremusModal.jsx';
import ActivityTile from '../components/dashboard/ActivityTile.jsx';
import ActivityLogModal from '../components/dashboard/ActivityLogModal.jsx';
import QuickStatTile from '../components/dashboard/QuickStatTile.jsx';
import PeriodPill from '../components/dashboard/PeriodPill.jsx';
import DashboardSkeleton from '../components/dashboard/DashboardSkeleton.jsx';
import DashboardExportMenu from '../components/dashboard/DashboardExportMenu.jsx';
import { SectionSkeleton } from '../components/metrics/MetricSection.jsx';

// Heavy recharts-backed metric sections — code-split + lazy-loaded below the
// fold so the initial dashboard paint stays light (shimmer fallback while they
// stream in).
const RevenueMetrics = lazyWithRetry(() => import('../components/metrics/RevenueMetrics.jsx'));
const ProfitabilityMetrics = lazyWithRetry(() => import('../components/metrics/ProfitabilityMetrics.jsx'));
const CashFlowMetrics = lazyWithRetry(() => import('../components/metrics/CashFlowMetrics.jsx'));
const ExpenseMetrics = lazyWithRetry(() => import('../components/metrics/ExpenseMetrics.jsx'));
const LiquidityMetrics = lazyWithRetry(() => import('../components/metrics/LiquidityMetrics.jsx'));
const EfficiencyMetrics = lazyWithRetry(() => import('../components/metrics/EfficiencyMetrics.jsx'));
import { loadDashboard } from '../features/dashboard/dashboardSlice.js';
import { selectActiveClient } from '../features/clients/clientsSlice.js';
import { selectUser } from '../features/auth/authSlice.js';
import {
  PERIODS,
  selectPeriodLabel, selectDraftPeriodLabel, selectDateRange, selectFiltersDirty,
  selectPeriod, selectCustomRange, selectDraftPeriod, selectDraftCustomRange,
  selectBasis, selectCustomer, selectCurrency,
  setPeriod, setCustomRange, applyFilters, setCustomer,
} from '../features/filters/filtersSlice.js';
import { selectZohoConnected } from '../features/zoho/zohoSlice.js';
import { selectOrgSelectedId, selectActiveOrg } from '../features/orgs/orgsSlice.js';
import { getViewAsClientId } from '../features/viewAs/viewAsSlice.js';
import { setActiveCurrency } from '../features/ui/uiSlice.js';
import { cn } from '../utils/classNames.js';
import { fmt, fmtDateRange } from '../utils/fmt.js';

// ── Custom range picker ───────────────────────────────────────────────────────
function CustomRangePicker({ onClose }) {
  const dispatch = useDispatch();
  const customRange = useSelector(selectDraftCustomRange);
  const [pending, setPending] = useState(customRange);
  return (
    <div className="p-3 border-t border-navy-100 dark:border-navy-800">
      <div className="text-[10.5px] uppercase tracking-wider text-navy-500 font-semibold mb-2">Custom range</div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <label className="block">
          <span className="block text-[10.5px] font-semibold text-navy-500 mb-1">From</span>
          <input type="date" value={pending.from || ''} onChange={e => setPending(p => ({ ...p, from: e.target.value }))}
            className="w-full h-8 px-2 rounded-lg bg-navy-50 dark:bg-navy-800 border border-transparent focus:border-brand-400 text-[12px] outline-none text-navy-900 dark:text-white" />
        </label>
        <label className="block">
          <span className="block text-[10.5px] font-semibold text-navy-500 mb-1">To</span>
          <input type="date" value={pending.to || ''} onChange={e => setPending(p => ({ ...p, to: e.target.value }))}
            className="w-full h-8 px-2 rounded-lg bg-navy-50 dark:bg-navy-800 border border-transparent focus:border-brand-400 text-[12px] outline-none text-navy-900 dark:text-white" />
        </label>
      </div>
      <button
        onClick={() => { if (pending.from && pending.to) { dispatch(setCustomRange(pending)); dispatch(applyFilters()); onClose(); } }}
        disabled={!pending.from || !pending.to}
        className="w-full h-8 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-[12px] font-semibold transition"
      >Apply</button>
    </div>
  );
}

// ── Period selector ───────────────────────────────────────────────────────────
function PeriodSelector() {
  const dispatch = useDispatch();
  // The control reflects the DRAFT (pending) selection; the fetch only happens
  // when the user commits via applyFilters() (the "Apply" button / range Apply).
  const period = useSelector(selectDraftPeriod);
  const label = useSelector(selectDraftPeriodLabel);
  const dirty = useSelector(selectFiltersDirty);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const QUICK = [
    { id: 'this_month', label: 'Month' },
    { id: 'this_quarter', label: 'Qtr' },
    { id: 'this_year', label: 'Year' },
  ];
  const isQuick = QUICK.map(p => p.id).includes(period);

  const apply = () => { dispatch(applyFilters()); setOpen(false); };

  return (
    <div ref={ref} className="relative flex items-center gap-2">
      {/* Quick pills */}
      <div className="flex items-center h-9 bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-700 rounded-xl overflow-hidden shadow-soft">
        <div className="flex items-center px-1 gap-0.5">
          {QUICK.map(p => (
            <PeriodPill key={p.id} active={period === p.id}
              onClick={() => dispatch(setPeriod(p.id))}>
              {p.label}
            </PeriodPill>
          ))}
          {!isQuick && (
            <PeriodPill active onClick={() => setOpen(o => !o)}>
              {label} <ChevronDown size={10} className="inline ml-0.5" />
            </PeriodPill>
          )}
        </div>
        <div className="w-px h-5 bg-navy-200 dark:bg-navy-700" />
        <button
          onClick={() => setOpen(o => !o)}
          className="h-9 px-2.5 text-navy-500 hover:text-navy-800 dark:hover:text-white hover:bg-navy-50 dark:hover:bg-navy-800 transition flex items-center gap-1.5 text-[12px] font-medium"
          title="More period options"
        >
          <Calendar size={13} />
          <span className="hidden sm:inline">More</span>
          <ChevronDown size={10} className={cn('transition-transform', open && 'rotate-180')} />
        </button>
      </div>

      {/* Apply — commit the pending period. Shown only when there's a change. */}
      {dirty && (
        <button
          onClick={apply}
          className="h-9 px-3 rounded-xl bg-brand-500 hover:bg-brand-600 text-white text-[12px] font-semibold shadow-soft transition whitespace-nowrap"
        >
          Apply
        </button>
      )}

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[220px] z-50 bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-700 rounded-xl shadow-lift overflow-hidden animate-fadein">
          <div className="px-3 py-2 border-b border-navy-100 dark:border-navy-800 text-[10.5px] uppercase tracking-wider text-navy-500 font-semibold">Period</div>
          <ul className="py-1">
            {PERIODS.map(p => {
              const active = period === p.id;
              return (
                <li key={p.id}>
                  <button
                    onClick={() => dispatch(setPeriod(p.id))}
                    className={cn('w-full flex items-center justify-between px-3 py-2 text-[12.5px] text-left transition',
                      active
                        ? 'bg-brand-50/60 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300 font-semibold'
                        : 'text-navy-700 dark:text-navy-200 hover:bg-navy-50 dark:hover:bg-navy-800')}
                  >
                    {p.label}
                    {active && <Check size={12} />}
                  </button>
                </li>
              );
            })}
          </ul>
          {period === 'custom'
            ? <CustomRangePicker onClose={() => setOpen(false)} />
            : (
              <div className="border-t border-navy-100 dark:border-navy-800 p-2.5">
                <button
                  onClick={apply}
                  className="w-full h-8 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-[12px] font-semibold transition"
                >
                  Apply filter
                </button>
              </div>
            )}
        </div>
      )}
    </div>
  );
}

// ── Customer filter (scopes the /metrics/* sections to one customer) ──────────
function CustomerFilter() {
  const dispatch = useDispatch();
  const customer = useSelector(selectCustomer);
  const [list, setList] = useState([]);

  useEffect(() => {
    axiosClient.get('/customers', { params: { limit: 200 } })
      .then(r => setList(r.data?.data || []))
      .catch(() => setList([]));
  }, []);

  if (list.length === 0) return null; // no customer list → hide control

  return (
    <select
      value={customer}
      onChange={(e) => dispatch(setCustomer(e.target.value))}
      aria-label="Customer"
      className="h-9 px-3 text-[12px] font-semibold bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-700 rounded-xl shadow-soft text-navy-700 dark:text-navy-200 max-w-[180px] truncate"
    >
      <option value="">All customers</option>
      {list.map((c) => (
        <option key={c.zoho_id || c.id} value={c.zoho_id || ''}>
          {c.company_name || c.contact_name || 'Unnamed'}
        </option>
      ))}
    </select>
  );
}

// ── fmt helper ────────────────────────────────────────────────────────────────
function fmtAmt(v) {
  if (v == null) return '--';
  return fmt(v);
}

// ── Section tab bar ───────────────────────────────────────────────────────────
const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'revenue', label: 'Revenue' },
  { id: 'profitability', label: 'Profit' },
  { id: 'cashflow', label: 'Cash Flow' },
  { id: 'expenses', label: 'Expenses' },
  { id: 'liquidity', label: 'Liquidity' },
  { id: 'efficiency', label: 'Efficiency' },
];

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const dispatch = useDispatch();
  const client = useSelector(selectActiveClient);
  const user = useSelector(selectUser);
  const dash = useSelector((s) => s.dashboard);
  const periodLabel = useSelector(selectPeriodLabel);
  const zohoConnected = useSelector(selectZohoConnected);
  const dateRange = useSelector(selectDateRange);
  const period = useSelector(selectPeriod);
  const selectedOrgId = useSelector(selectOrgSelectedId);
  const activeOrg = useSelector(selectActiveOrg);
  const customRange = useSelector(selectCustomRange);
  const basis = useSelector(selectBasis);
  const customer = useSelector(selectCustomer);
  const currency = useSelector(selectCurrency);

  const [activeSection, setActiveSection] = useState('overview');
  const [kpiModal, setKpiModal] = useState(null); // kpi id or null
  const [expenseModal, setExpenseModal] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [topModal, setTopModal] = useState(null); // 'customers' | 'vendors' | null
  const [logOpen, setLogOpen] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);

  const sectionRefs = useRef({});

  // On boot several async slices resolve in quick succession (auth, orgs,
  // active client), re-running this effect with parameters that produce the
  // exact same request (scoping comes from headers read out of localStorage).
  // Skip dispatches whose effective request signature matches the previous one
  // — the duplicate refetch wasted a full 9-call round and re-rendered charts
  // mid-animation on every reload.
  const lastLoadKey = useRef(null);
  useEffect(() => {
    const key = [
      dateRange.from, dateRange.to, basis,
      getViewAsClientId() || '', selectedOrgId || '',
    ].join('|');
    if (lastLoadKey.current === key) return;
    lastLoadKey.current = key;
    dispatch(loadDashboard({ clientId: client?.id, from: dateRange.from, to: dateRange.to, basis }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, client?.id, period, customRange.from, customRange.to, selectedOrgId, basis]);

  // Manual retry after a failed load (bypasses the dedupe guard above).
  const retryLoad = () => {
    dispatch(loadDashboard({ clientId: client?.id, from: dateRange.from, to: dateRange.to, basis }));
  };

  // Keep the store's active currency in sync with the loaded company data (the
  // client / org may differ from what DashboardLayout resolved at mount).
  useEffect(() => {
    const c = dash.rawStats?.currency;
    if (c) dispatch(setActiveCurrency(c));
  }, [dash.rawStats?.currency, dispatch]);

  // Show when the connected accounting data was last synced (sync itself now
  // lives in Settings). Refetched whenever the active client changes.
  useEffect(() => {
    let cancelled = false;
    axiosClient.get('/sync/last')
      .then((r) => { if (!cancelled) setLastSyncedAt(r.data?.lastSyncedAt || null); })
      .catch(() => { if (!cancelled) setLastSyncedAt(null); });
    return () => { cancelled = true; };
  }, [client?.id]);

  const lastSyncedLabel = lastSyncedAt
    ? new Date(lastSyncedAt).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
    : null;

  // Scroll to section when tab clicked
  const scrollTo = (id) => {
    setActiveSection(id);
    if (id === 'overview') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const el = sectionRefs.current[id];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const rs = dash.rawStats || {};
  const netProfit = (rs.totalRevenue || 0) - (rs.totalExpenses || 0);
  // First-ever load (no data yet) → show shimmer skeleton instead of empty tiles.
  const initialLoading = dash.status === 'loading' && (!dash.kpis || dash.kpis.length === 0);
  // Refetch with existing data (filter change / reload) → dim + "Updating…" so
  // stale numbers aren't mistaken for the new period's data.
  const refreshing = dash.status === 'loading' && !initialLoading;
  const rangeLabel = fmtDateRange(dateRange.from, dateRange.to);
  const firstName = (user?.name || 'there').split(' ')[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="p-4 lg:p-6 max-w-[1600px] mx-auto">
      <DashboardTabs />

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="text-[10.5px] font-bold tracking-[0.2em] uppercase text-navy-400">Workspace</span>
            <span className="text-navy-300">·</span>
            <span className="text-[10.5px] text-navy-400">{periodLabel}</span>
            {rangeLabel && (
              <>
                <span className="text-navy-300">·</span>
                <span className="text-[10.5px] text-navy-400 tabular-nums">{rangeLabel}</span>
              </>
            )}
            <Badge tone="green" dot>Live</Badge>
          </div>
          <h1 className="text-[26px] font-bold tracking-tight text-navy-900 dark:text-white">
            {greeting}, {firstName}
          </h1>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {lastSyncedLabel && (
            <span className="text-[11.5px] text-navy-400 dark:text-navy-500 whitespace-nowrap">
              Last synced: <span className="font-medium text-navy-600 dark:text-navy-300">{lastSyncedLabel}</span>
            </span>
          )}
          <PeriodSelector />
          <DashboardExportMenu
            dash={dash}
            reportName={`Dashboard ${periodLabel}`}
            meta={{ company: activeOrg?.org_name || 'Oremus', from: dateRange.from, to: dateRange.to, currency: rs.currency }}
            disabled={initialLoading}
          />
        </div>
      </div>

      {/* ── Search + Ask Oremus AI (left)  ·  Section nav tabs (right) ───────── */}
      {/* Stacks vertically below lg; side-by-side on large screens. Sticky right
          below the top Navbar (h-14) so search + the section tabs (which drive
          scrollTo) stay reachable while scrolling the bento grid below — an
          opaque, full-bleed background (negative margin cancels the page's own
          padding) keeps content from showing through while it's pinned. */}
      <div className="sticky top-14 z-20 -mx-4 lg:-mx-6 px-4 lg:px-6 py-3 mb-5 flex flex-col gap-3 lg:flex-row lg:items-center bg-navy-50/95 dark:bg-navy-950/95 backdrop-blur-md border-b border-navy-200/70 dark:border-navy-800/70">
        {/* Left: Search + Ask Oremus AI */}
        <div className="flex items-center gap-2 w-full min-w-0 lg:flex-1">
          <GlobalSearch className="flex-1 max-w-[420px] min-w-0" />
          <button
            type="button"
            onClick={() => setAskOpen(true)}
            className="h-9 pl-2.5 pr-3.5 rounded-xl text-white font-semibold text-[12.5px] flex items-center gap-2 shadow-soft hover:shadow-lift bg-gradient-to-r from-brand-500 to-cyan-500 hover:from-brand-600 hover:to-cyan-600 transition-all whitespace-nowrap shrink-0"
          >
            <span className="w-5 h-5 rounded-md bg-white/20 grid place-items-center shrink-0">
              <Sparkles size={11} />
            </span>
            <span className="hidden sm:inline">Ask Oremus AI</span>
          </button>
        </div>

        {/* Right: Section tabs (full-width scroll on mobile, pushed right on lg) */}
        <div className="flex items-center gap-1 overflow-x-auto pb-0.5 scrollbar-none w-full lg:w-auto lg:shrink-0">
          {SECTIONS.map(s => (
            <button
              key={s.id}
              onClick={() => scrollTo(s.id)}
              className={cn(
                'h-8 px-3 rounded-lg text-[12px] font-semibold whitespace-nowrap transition flex-shrink-0',
                activeSection === s.id
                  ? 'bg-brand-500 text-white shadow-soft'
                  : 'text-navy-500 hover:text-navy-800 dark:hover:text-white hover:bg-navy-100 dark:hover:bg-navy-800'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Load-failure banner (slow / dropped connection) ─────────────────── */}
      {dash.status === 'failed' && (
        <div className="mb-4 flex flex-wrap items-center gap-3 px-4 py-3 rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 text-[12.5px] text-rose-700 dark:text-rose-300">
          <AlertTriangle size={15} className="shrink-0" />
          <span className="flex-1 min-w-[200px]">
            Couldn&apos;t load dashboard data
            {dash.kpis && dash.kpis.length > 0 ? ' — showing the last loaded numbers' : ''}.
            This usually means a slow or interrupted connection.
          </span>
          <button
            onClick={retryLoad}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-[12px] font-semibold transition"
          >
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}

      {/* ── Overview bento grid ──────────────────────────────────────────────── */}
      {initialLoading ? <DashboardSkeleton /> : (
        <div className="relative">
          {refreshing && (
            <div className="absolute inset-0 z-20 flex items-start justify-center pt-10 pointer-events-none">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/95 dark:bg-navy-900/95 border border-navy-200 dark:border-navy-700 shadow-lift text-[12px] font-semibold text-navy-600 dark:text-navy-300">
                <Loader2 size={13} className="animate-spin" /> Updating…
              </div>
            </div>
          )}
          <div className={cn('grid grid-cols-12 gap-3 mb-5 transition-opacity duration-200', refreshing && 'opacity-40 pointer-events-none')}>
          {/* Hero chart — 7 cols × 2 rows */}
          <div className="col-span-12 xl:col-span-7 xl:row-span-2">
            <HeroChartTile data={dash.revExp} lastYearProfit={dash.lastYearProfit} />
          </div>

          {/* KPI tiles — 5 cols, 2×2 (fills the hero height, no extra space) */}
          <div className="col-span-12 xl:col-span-5 xl:row-span-2 grid grid-cols-2 grid-rows-2 gap-3 auto-rows-fr">
            {dash.kpis.map((k) => (
              <KpiTile key={k.id} kpi={k} onClick={() => setKpiModal(k.id)} />
            ))}
          </div>

          {/* Row · Cash flow + Expense mix (wider donut + legend) */}
          <div className="col-span-12 md:col-span-5 xl:col-span-4">
            <CashFlowTile data={dash.cashFlow} />
          </div>
          <div className="col-span-12 md:col-span-7 xl:col-span-8">
            <ExpenseMixTile data={dash.expenseMix} onDetails={() => setExpenseModal(true)} />
          </div>

          {/* Row · Top customers + Top vendors + Compliance (equal height) */}
          <div className="col-span-12 md:col-span-6 xl:col-span-4">
            <TopListTile
              title={zohoConnected ? 'Top customers · Zoho' : 'Top customers'}
              rows={dash.topCustomers} accent="#2563EB"
              loading={dash.status === 'loading'}
              onViewAll={() => setTopModal('customers')}
            />
          </div>
          <div className="col-span-12 md:col-span-6 xl:col-span-4">
            <TopListTile
              title={zohoConnected ? 'Top vendors · Zoho' : 'Top vendors'}
              rows={dash.topVendors} accent="#F59E0B"
              loading={dash.status === 'loading'}
              onViewAll={() => setTopModal('vendors')}
            />
          </div>
          <div className="col-span-12 md:col-span-6 xl:col-span-4">
            <ComplianceTile items={dash.compliances} />
          </div>

          {/* Row · Recent activity + Oremus AI insights */}
          {/* <div className="col-span-12 xl:col-span-8">
            <ActivityTile items={dash.activity} onViewLog={() => setLogOpen(true)} />
          </div>
          <div className="col-span-12 xl:col-span-4">
            <AiInsightsTile items={dash.aiInsights} onAsk={() => setAskOpen(true)} />
          </div> */}

          {/* Quick stats row */}
          {/* <div className="col-span-12 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <QuickStatTile label="Invoices"
              value={rs.totalInvoices || (dash.status === 'loading' ? '…' : '0')}
              sub={rs.outstandingReceivables ? `${fmtAmt(rs.outstandingReceivables)} outstanding` : 'no outstanding'}
              accent="#06B6D4" icon="ReceiptText" />
            <QuickStatTile label="Customers"
              value={rs.totalCustomers || (dash.status === 'loading' ? '…' : '0')}
              sub="this period" accent="#10B981" icon="Users" />
            <QuickStatTile label="Payments In"
              value={rs.totalPayments ? fmtAmt(rs.totalPayments) : (dash.status === 'loading' ? '…' : fmtAmt(0))}
              sub="received this period" accent="#F59E0B" icon="Wallet" />
            <QuickStatTile label="Total Expenses"
              value={rs.totalExpenses != null ? fmtAmt(rs.totalExpenses) : (dash.status === 'loading' ? '…' : fmtAmt(0))}
              sub="this period" accent="#EF4444" icon="TrendingDown" />
            <QuickStatTile label="Net Profit"
              value={rs.totalRevenue != null ? fmtAmt(netProfit) : (dash.status === 'loading' ? '…' : fmtAmt(0))}
              sub="revenue − expenses"
              accent={netProfit >= 0 ? '#8B5CF6' : '#EF4444'}
              icon={netProfit >= 0 ? 'TrendingUp' : 'TrendingDown'} />
          </div> */}
          </div>
        </div>
      )}

      {/* ── Section divider ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 mb-5">
        <div className="flex items-center gap-2 text-[11px] font-bold text-navy-400 uppercase tracking-widest">
          <TrendingUp size={12} />
          Financial Metrics
        </div>
        <div className="flex-1 h-px bg-navy-100 dark:bg-navy-800" />
        <CustomerFilter />
      </div>

      {/* ── Metrics sections (lazy-loaded · shimmer fallback) ─────────────────── */}
      <div className="space-y-5">
        <div ref={el => sectionRefs.current['revenue'] = el} className="scroll-mt-4">
          <Suspense fallback={<SectionSkeleton />}>
            <RevenueMetrics from={dateRange.from} to={dateRange.to} customer={customer} currency={currency} />
          </Suspense>
        </div>

        <div ref={el => sectionRefs.current['profitability'] = el} className="scroll-mt-4">
          <Suspense fallback={<SectionSkeleton />}>
            <ProfitabilityMetrics from={dateRange.from} to={dateRange.to} basis={basis} customer={customer} currency={currency} />
          </Suspense>
        </div>

        <div ref={el => sectionRefs.current['cashflow'] = el} className="scroll-mt-4">
          <Suspense fallback={<SectionSkeleton />}>
            <CashFlowMetrics from={dateRange.from} to={dateRange.to} basis={basis} customer={customer} currency={currency} />
          </Suspense>
        </div>

        <div ref={el => sectionRefs.current['expenses'] = el} className="scroll-mt-4">
          <Suspense fallback={<SectionSkeleton />}>
            <ExpenseMetrics from={dateRange.from} to={dateRange.to} />
          </Suspense>
        </div>

        <div ref={el => sectionRefs.current['liquidity'] = el} className="scroll-mt-4">
          <Suspense fallback={<SectionSkeleton />}>
            <LiquidityMetrics from={dateRange.from} to={dateRange.to} />
          </Suspense>
        </div>

        <div ref={el => sectionRefs.current['efficiency'] = el} className="scroll-mt-4">
          <Suspense fallback={<SectionSkeleton />}>
            <EfficiencyMetrics from={dateRange.from} to={dateRange.to} />
          </Suspense>
        </div>
      </div>

      <div className="mt-6 text-center text-[11px] text-navy-300">
        Oremus AI · {periodLabel}
      </div>

      {/* ── KPI Detail Modal ─────────────────────────────────────────────────── */}
      {kpiModal && (
        <KpiDetailModal
          kpiId={kpiModal}
          from={dateRange.from}
          to={dateRange.to}
          onClose={() => setKpiModal(null)}
        />
      )}

      {/* ── Expense Mix Modal ────────────────────────────────────────────────── */}
      {expenseModal && (
        <ExpenseMixModal data={dash.expenseMix} onClose={() => setExpenseModal(false)} />
      )}

      {/* ── Ask Oremus AI Modal ──────────────────────────────────────────────── */}
      {askOpen && (
        <AskOremusModal insights={dash.aiInsights} onClose={() => setAskOpen(false)} />
      )}

      {/* ── Top list Modal ───────────────────────────────────────────────────── */}
      {topModal && (
        <TopListModal
          title={topModal === 'vendors' ? 'Top vendors' : 'Top customers'}
          rows={topModal === 'vendors' ? dash.topVendors : dash.topCustomers}
          accent={topModal === 'vendors' ? '#F59E0B' : '#2563EB'}
          kind={topModal}
          onClose={() => setTopModal(null)}
        />
      )}

      {/* ── Activity Log Modal ───────────────────────────────────────────────── */}
      {logOpen && (
        <ActivityLogModal items={dash.activity} onClose={() => setLogOpen(false)} />
      )}
    </div>
  );
}
