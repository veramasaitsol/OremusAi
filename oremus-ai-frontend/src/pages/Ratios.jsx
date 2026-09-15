/**
 * Ratios — Financial benchmark dashboard.
 * Matches the reference layout: 2-column grid of semicircle gauges.
 * Each gauge shows the ratio value, a health-colour fill, benchmark ticks,
 * the formula, and interpretation bullets.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useSelector } from 'react-redux';
import { RefreshCw, Info } from 'lucide-react';
import GaugeChart from '../components/ratios/GaugeChart.jsx';
import PeriodFilter from '../components/common/PeriodFilter.jsx';
import DashboardTabs from '../components/common/DashboardTabs.jsx';
import axiosClient from '../services/axiosClient.js';
import { cn } from '../utils/classNames.js';
import { fmtDateRange, fmtMoneyCompact } from '../utils/fmt.js';
import { toast } from '../utils/toastStore.js';
import {
  selectPeriodLabel,
  selectDateRange,
  selectPeriod,
  selectCustomRange,
} from '../features/filters/filtersSlice.js';

// ── Colour helpers ────────────────────────────────────────────────────────────
const GREEN = '#10B981';
const AMBER = '#F59E0B';
const RED   = '#EF4444';
const GRAY  = '#94A3B8';

function colorHigher(good, warn) {
  return (v) => {
    if (v == null || !isFinite(v)) return GRAY;
    if (v >= good) return GREEN;
    if (v >= warn) return AMBER;
    return RED;
  };
}
function colorLower(good, warn) {
  return (v) => {
    if (v == null || !isFinite(v)) return GRAY;
    if (v <= good) return GREEN;
    if (v <= warn) return AMBER;
    return RED;
  };
}
function colorAboveZero(v) {
  if (v == null || !isFinite(v)) return GRAY;
  return v >= 0 ? GREEN : RED;
}

// ── Formatters ────────────────────────────────────────────────────────────────
const pct  = (v) => (v == null ? 'N/A' : `${v.toFixed(1)}%`);
const pctA = (v) => `${v}%`;
const ratio= (v) => (v == null ? 'N/A' : v.toFixed(1));
const times= (v) => (v == null ? 'N/A' : `${v.toFixed(2)}×`);
const timesA= (v) => `${v}×`;
const days = (v) => (v == null ? 'N/A' : `${v.toFixed(1)}d`);
const daysA= (v) => `${v}`;

// Human platform name for the header/footer labels. The ratios are computed
// from the VIEWED CLIENT's own synced data (Zoho / QuickBooks / Xero), so the
// page must never hardcode one platform.
const PROVIDER_LABEL = {
  zoho: 'Zoho Books',
  quickbooks: 'QuickBooks',
  xero: 'Xero',
};
const providerLabel = (p) => PROVIDER_LABEL[p] || 'your accounting';

// ── Ratio config factory ──────────────────────────────────────────────────────
// Each entry drives one GaugeChart card. `currency` (the viewed client's own)
// is threaded into the working-capital money formatter.
function buildConfigs(data, currency = 'INR') {
  if (!data) return [];
  // Currency-aware compact money (respects the VIEWED CLIENT's currency).
  const wc   = (v) => (v == null ? 'N/A' : fmtMoneyCompact(v, currency));
  const wcA  = (v) => fmtMoneyCompact(v, currency);

  // Dynamically compute working capital gauge range based on actual value
  const wcVal = data.workingCapital;
  const wcMax = wcVal != null ? Math.max(Math.abs(wcVal) * 1.5, 1_000_000) : 5_000_000;
  const wcMin = -wcMax;

  return [
    // ── Profitability Ratios ────────────────────────────────────────────────
    {
      key: 'grossProfitMargin',
      category: 'Profitability Ratios',
      label: 'Gross profit margin',
      value: data.grossProfitMargin,
      min: -100, max: 100,
      benchmarks: [{ value: 20, label: '20%' }, { value: 50, label: '50%' }],
      color: colorHigher(50, 20)(data.grossProfitMargin),
      fmt: pct, fmtAxis: pctA,
      formula: 'Gross Profit / Revenue × 100',
      note: '* From your synced P&L — matches the dashboard Gross Margin',
      interpretations: [
        '> 50%: hugely profitable business',
        '< 20%: hard to become profitable',
        'Possible issue in the business model',
      ],
    },
    {
      key: 'netProfitMargin',
      category: 'Profitability Ratios',
      label: 'Net profit margin',
      value: data.netProfitMargin,
      min: -100, max: 100,
      benchmarks: [{ value: 3, label: '3%' }, { value: 10, label: '10%' }],
      color: colorHigher(10, 3)(data.netProfitMargin),
      fmt: pct, fmtAxis: pctA,
      formula: 'Net Profit / Revenue × 100',
      interpretations: [
        '< 3%: not efficient',
        '> 10%: very efficient',
        'Possible issue in cost structure',
      ],
    },
    {
      key: 'operatingMargin',
      category: 'Profitability Ratios',
      label: 'Operating margin',
      value: data.operatingMargin,
      min: -100, max: 100,
      benchmarks: [{ value: 5, label: '5%' }, { value: 10, label: '10%' }],
      color: colorHigher(10, 5)(data.operatingMargin),
      fmt: pct, fmtAxis: pctA,
      formula: 'EBIT / Revenue × 100',
      note: '* From your synced P&L — matches the dashboard Operating Margin',
      interpretations: [
        '< 5%: not efficient at operating business',
        '> 10%: very efficient at operating business',
        'Possible issue in COGS (Cost of Goods Sold)',
      ],
    },
    {
      key: 'returnOnEquity',
      category: 'Profitability Ratios',
      label: 'Return on Equity (ROE)',
      value: data.returnOnEquity,
      min: -50, max: 50,
      benchmarks: [{ value: 8, label: '8%' }, { value: 15, label: '15%' }],
      color: data.returnOnEquity != null ? colorHigher(15, 8)(data.returnOnEquity) : GRAY,
      fmt: pct, fmtAxis: pctA,
      formula: "Net Profit / Shareholders' Equity × 100",
      note: '* Equity derived as Assets − Liabilities from the ledger',
      interpretations: [
        '> 15%: strong returns to shareholders',
        '< 8%: returns may lag cost of capital',
        'Possible issue in profitability or capital structure',
      ],
    },
    {
      key: 'returnOnEquityAverage',
      category: 'Profitability Ratios',
      label: 'Return on Equity (avg. equity basis)',
      value: data.returnOnEquityAverage,
      min: -50, max: 50,
      benchmarks: [{ value: 8, label: '8%' }, { value: 15, label: '15%' }],
      color: data.returnOnEquityAverage != null ? colorHigher(15, 8)(data.returnOnEquityAverage) : GRAY,
      fmt: pct, fmtAxis: pctA,
      formula: "Net Profit / Average Shareholders' Equity × 100",
      note: '* Needs opening + closing equity — N/A for a brand-new period with no prior data',
      interpretations: [
        '> 15%: strong returns to shareholders',
        '< 8%: returns may lag cost of capital',
        'Smooths out swings from a single point-in-time equity balance',
      ],
    },
    {
      key: 'returnOnInvestment',
      category: 'Profitability Ratios',
      label: 'Return on Investment (ROI)',
      value: data.returnOnInvestment,
      min: 0, max: 100,
      benchmarks: [{ value: 10, label: '10%' }, { value: 20, label: '20%' }],
      color: data.returnOnInvestment != null ? colorHigher(20, 10)(data.returnOnInvestment) : GRAY,
      fmt: pct, fmtAxis: pctA,
      formula: 'Net Gain / Cost of Investment × 100',
      note: '* Requires investment cost data — not tracked in synced data',
      interpretations: [
        '> 20%: highly effective investments',
        '< 10%: investments underperforming',
        'Compare against alternative uses of capital',
      ],
    },

    // ── Liquidity Ratios ────────────────────────────────────────────────────
    {
      key: 'currentRatio',
      category: 'Liquidity Ratios',
      label: 'Current ratio',
      value: data.currentRatio,
      min: 0, max: 10,
      benchmarks: [{ value: 1, label: '1' }, { value: 1.5, label: '1.5' }],
      color: colorHigher(1.5, 1)(data.currentRatio),
      fmt: ratio, fmtAxis: ratio,
      formula: 'Current Assets / Current Liabilities',
      note: '* GL-based current assets / liabilities — matches the dashboard',
      interpretations: [
        '> 1.5: strong financial performance',
        '< 1: weak financial performance',
        'Possible issue with asset distribution and cash availability',
      ],
    },
    {
      key: 'cashFlowRatio',
      category: 'Liquidity Ratios',
      label: 'Cash flow ratio',
      value: data.cashFlowRatio,
      min: -2, max: 12,
      benchmarks: [{ value: 0.8, label: '0.8' }, { value: 1, label: '1' }],
      color: colorHigher(1, 0.8)(data.cashFlowRatio),
      fmt: ratio, fmtAxis: ratio,
      formula: 'Operating Cash Flow / Current Liabilities',
      interpretations: [
        '> 1: income all covered by cash flow',
        '< 0.8: income may not cover obligations',
        'Indicates number of times cash covers liabilities',
      ],
    },
    {
      key: 'workingCapital',
      category: 'Liquidity Ratios',
      label: 'Working capital',
      value: data.workingCapital,
      min: wcMin, max: wcMax,
      benchmarks: [{ value: 0, label: '0' }],
      color: colorAboveZero(data.workingCapital),
      fmt: wc, fmtAxis: wcA,
      formula: '(Current Assets − Current Liabilities) / Total Assets',
      note: '* GL-based current assets minus payables — matches the dashboard',
      interpretations: [
        '> 0: company can meet financial obligations at any time',
        '< 0: company might not be able to meet obligations',
        'Possible issues in cash availability at short term',
      ],
    },
    {
      key: 'quickRatio',
      category: 'Liquidity Ratios',
      label: 'Quick ratio',
      value: data.quickRatio,
      min: 0, max: 5,
      benchmarks: [{ value: 0.7, label: '0.7' }, { value: 1, label: '1' }],
      color: colorHigher(1, 0.7)(data.quickRatio),
      fmt: ratio, fmtAxis: ratio,
      formula: '(Current Assets − Inventory) / Current Liabilities',
      note: '* GL-based (cash + receivables) / current liabilities — matches the dashboard',
      interpretations: [
        '> 1: company is sufficiently liquid',
        '< 0.7: company may face liquidity issues',
        'Possible issue in short-term obligation coverage',
      ],
    },

    // ── Efficiency Ratios ───────────────────────────────────────────────────
    {
      key: 'assetTurnover',
      category: 'Efficiency Ratios',
      label: 'Asset Turnover Ratio',
      value: data.assetTurnover,
      min: 0, max: 3,
      benchmarks: [{ value: 0.5, label: '0.5×' }, { value: 1, label: '1×' }],
      color: data.assetTurnover != null ? colorHigher(1, 0.5)(data.assetTurnover) : GRAY,
      fmt: times, fmtAxis: timesA,
      formula: 'Revenue / Average Total Assets',
      note: '* Average of opening and closing total assets for the period',
      interpretations: [
        '> 1×: assets used efficiently to generate sales',
        '< 0.5×: assets underutilised',
        'Compare within the same industry',
      ],
    },
    {
      key: 'receivablesTurnover',
      category: 'Efficiency Ratios',
      label: 'Receivables Turnover',
      value: data.receivablesTurnover,
      min: 0, max: 20,
      benchmarks: [{ value: 4, label: '4×' }, { value: 8, label: '8×' }],
      color: data.receivablesTurnover != null ? colorHigher(8, 4)(data.receivablesTurnover) : GRAY,
      fmt: times, fmtAxis: timesA,
      formula: 'Revenue / Average AR',
      note: '* Average of opening and closing accounts receivable for the period',
      interpretations: [
        '> 8×: collections are quick and efficient',
        '< 4×: collections may be slow',
        'Possible issue in credit / collection policy',
      ],
    },
    {
      key: 'avgDebtorDays',
      category: 'Efficiency Ratios',
      label: 'Average Debtor Days (AR Days)',
      value: data.avgDebtorDays,
      min: 0, max: 120,
      benchmarks: [{ value: 30, label: '30' }, { value: 60, label: '60' }],
      color: data.avgDebtorDays != null ? colorLower(30, 60)(data.avgDebtorDays) : GRAY,
      fmt: days, fmtAxis: daysA,
      formula: '365 / Receivables Turnover',
      note: '* Same Receivables Turnover figure as the gauge above',
      interpretations: [
        '< 30: customers pay quickly',
        '> 60: collections cycle is slow',
        'Compare against your invoice payment terms',
      ],
    },
    {
      key: 'avgPayableDays',
      category: 'Efficiency Ratios',
      label: 'Average Payable Days (AP Days)',
      value: data.avgPayableDays,
      min: 0, max: 120,
      benchmarks: [{ value: 30, label: '30' }, { value: 60, label: '60' }],
      color: GRAY,
      fmt: days, fmtAxis: daysA,
      formula: '(Average AP / Total Operating Expenses) × 365',
      note: '* Average of opening and closing accounts payable for the period',
      interpretations: [
        'Higher: taking longer to pay vendors (more working-capital headroom)',
        'Lower: paying vendors quickly',
        'Compare against your vendors’ payment terms',
      ],
    },
    {
      key: 'inventoryTurnover',
      category: 'Efficiency Ratios',
      label: 'Inventory Turnover',
      value: data.inventoryTurnover,
      min: 0, max: 20,
      benchmarks: [{ value: 4, label: '4×' }, { value: 8, label: '8×' }],
      color: data.inventoryTurnover != null ? colorHigher(8, 4)(data.inventoryTurnover) : GRAY,
      fmt: times, fmtAxis: timesA,
      formula: 'COGS / Average Inventory',
      note: '* Requires inventory data — not tracked in synced data',
      interpretations: [
        '> 8×: inventory sells through quickly',
        '< 4×: possible overstocking or slow sales',
        'Highly sector-dependent',
      ],
    },
    {
      key: 'daysInventoryOutstanding',
      category: 'Efficiency Ratios',
      label: 'Days Inventory Outstanding (DIO)',
      value: data.daysInventoryOutstanding,
      min: 0, max: 180,
      benchmarks: [{ value: 30, label: '30' }, { value: 60, label: '60' }],
      color: data.daysInventoryOutstanding != null ? colorLower(30, 60)(data.daysInventoryOutstanding) : GRAY,
      fmt: days, fmtAxis: daysA,
      formula: '(Inventory / COGS) × 365',
      note: '* Requires inventory data — not tracked in synced data',
      interpretations: [
        '< 30: inventory converts to sales quickly',
        '> 60: capital tied up in inventory',
        'Compare against industry norms',
      ],
    },

    // ── Leverage & Solvency Ratios ──────────────────────────────────────────
    {
      key: 'debtToEquity',
      category: 'Leverage & Solvency Ratios',
      label: 'Debt-to-equity',
      value: data.debtToEquity,
      min: 0, max: 10,
      benchmarks: [{ value: 2.5, label: '2.5' }, { value: 5, label: '5' }],
      color: data.debtToEquity != null ? colorLower(2.5, 5)(data.debtToEquity) : GRAY,
      fmt: ratio, fmtAxis: ratio,
      formula: 'Total Liabilities / Equity',
      note: '* Equity derived as Assets − Liabilities from the ledger',
      interpretations: [
        '< 2.5: mature and stable company',
        '> 5: company may be overleveraged',
        'Possible issue in debt management',
      ],
    },
    {
      key: 'debtServiceCoverage',
      category: 'Leverage & Solvency Ratios',
      label: 'Debt Service Coverage Ratio (DSCR)',
      value: data.debtServiceCoverage,
      min: 0, max: 3,
      benchmarks: [{ value: 1, label: '1' }, { value: 1.25, label: '1.25' }],
      color: data.debtServiceCoverage != null ? colorHigher(1.25, 1)(data.debtServiceCoverage) : GRAY,
      fmt: times, fmtAxis: timesA,
      formula: 'Net Operating Income / Total Debt Service',
      note: '* Requires loan repayment schedule — not tracked in synced data',
      interpretations: [
        '> 1.25: comfortably covers debt obligations',
        '< 1: operating income cannot cover debt service',
        'Closely watched by lenders',
      ],
    },
    {
      key: 'equityMultiplier',
      category: 'Leverage & Solvency Ratios',
      label: 'Equity Multiplier',
      value: data.equityMultiplier,
      min: 0, max: 6,
      benchmarks: [{ value: 2, label: '2×' }, { value: 3, label: '3×' }],
      color: data.equityMultiplier != null ? colorLower(2, 3)(data.equityMultiplier) : GRAY,
      fmt: times, fmtAxis: timesA,
      formula: "Total Assets / Shareholders' Equity",
      note: '* Equity derived as Assets − Liabilities from the ledger',
      interpretations: [
        '< 2×: conservatively financed',
        '> 3×: heavily reliant on debt financing',
        'Higher multiplier amplifies both gains and losses',
      ],
    },
    {
      key: 'financialLeverage',
      category: 'Leverage & Solvency Ratios',
      label: 'Financial Leverage Ratio',
      value: data.financialLeverage,
      min: 0, max: 6,
      benchmarks: [{ value: 2, label: '2×' }, { value: 3, label: '3×' }],
      color: data.financialLeverage != null ? colorLower(2, 3)(data.financialLeverage) : GRAY,
      fmt: times, fmtAxis: timesA,
      formula: 'Average Total Assets / Average Equity',
      note: '* Average of opening and closing balances for the period',
      interpretations: [
        '< 2×: low reliance on borrowed funds',
        '> 3×: high financial risk from leverage',
        'Read alongside interest coverage',
      ],
    },
  ];
}

// Render order for the grouped sections.
const CATEGORY_ORDER = [
  'Profitability Ratios',
  'Liquidity Ratios',
  'Efficiency Ratios',
  'Leverage & Solvency Ratios',
];

// In-page section tabs — id matches the category, label is the short pill text.
const CATEGORY_TABS = [
  { id: 'Profitability Ratios',        label: 'Profitability' },
  { id: 'Liquidity Ratios',            label: 'Liquidity' },
  { id: 'Efficiency Ratios',           label: 'Efficiency' },
  { id: 'Leverage & Solvency Ratios',  label: 'Leverage & Solvency' },
];

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Ratios() {
  const periodLabel = useSelector(selectPeriodLabel);
  const dateRange   = useSelector(selectDateRange);
  const period      = useSelector(selectPeriod);
  const customRange = useSelector(selectCustomRange);

  const [ratios,  setRatios]  = useState(null);
  const [provider, setProvider] = useState(null);   // viewed client's platform (zoho|quickbooks|xero)
  const [currency, setCurrency] = useState('INR');  // viewed client's currency (for money formatting)
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [activeCat, setActiveCat] = useState(CATEGORY_TABS[0].id);

  const sectionRefs = useRef({});
  const scrollToCat = (cat) => {
    setActiveCat(cat);
    const el = sectionRefs.current[cat];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await axiosClient.get('/ratios', {
        params: { from: dateRange.from, to: dateRange.to },
      });
      setRatios(data.data);
      setProvider(data.provider || null);
      setCurrency(data.currency || 'INR');
    } catch {
      // Never surface the raw backend error string (e.g. "Server error") in the
      // UI. Show a friendly inline message and a toast instead.
      setError("We couldn't load your financial ratios right now. Please try again.");
      toast.error("Couldn't load financial ratios. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [dateRange.from, dateRange.to]);

  useEffect(() => { load(); }, [period, customRange.from, customRange.to]);  // eslint-disable-line

  const configs = buildConfigs(ratios, currency);

  return (
    <div className="p-6 lg:p-7 max-w-[1400px] mx-auto">
      {/* Tab bar — shared with Overview */}
      <DashboardTabs />

      {/* ── Header ── */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10.5px] font-bold tracking-[0.2em] uppercase text-navy-500">
              Financial Ratios
            </span>
            <span className="text-navy-300">·</span>
            <span className="text-[10.5px] text-navy-500">{periodLabel}</span>
            {fmtDateRange(dateRange.from, dateRange.to) && (
              <>
                <span className="text-navy-300">·</span>
                <span className="text-[10.5px] text-navy-500 tabular-nums">{fmtDateRange(dateRange.from, dateRange.to)}</span>
              </>
            )}
          </div>
          <h1 className="text-[26px] font-bold tracking-tight text-navy-900 dark:text-white">
            Benchmark Dashboard
          </h1>
          <p className="text-[12px] text-navy-500 mt-0.5">
            Key financial ratios computed from your synced {providerLabel(provider)} data
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PeriodFilter />
          <button
            onClick={load}
            disabled={loading}
            className="h-9 px-3.5 rounded-lg border border-navy-200 dark:border-navy-700 bg-white dark:bg-navy-800 text-navy-700 dark:text-navy-300 text-[12px] font-medium flex items-center gap-1.5 hover:bg-navy-50 dark:hover:bg-navy-700 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── Legend ── */}
      <div className="flex items-center gap-4 mb-5 text-[11px] text-navy-500 dark:text-navy-400">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm" style={{ background: GREEN }} />
          <span>Healthy</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm" style={{ background: AMBER }} />
          <span>Needs attention</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm" style={{ background: RED }} />
          <span>Critical</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm" style={{ background: GRAY }} />
          <span>No data</span>
        </div>
      </div>

      {/* ── Category section tabs ── */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1 mb-5 scrollbar-none">
        {CATEGORY_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => scrollToCat(t.id)}
            className={cn(
              'h-9 px-4 rounded-xl text-[12.5px] font-semibold whitespace-nowrap transition flex-shrink-0',
              activeCat === t.id
                ? 'bg-brand-500 text-white shadow-soft'
                : 'text-navy-500 hover:text-navy-800 dark:hover:text-white hover:bg-navy-100 dark:hover:bg-navy-800'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Error state ── */}
      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400 text-[12px]">
          {error}
        </div>
      )}

      {/* ── Skeleton / Grid ── */}
      {loading && !ratios ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <div
              key={i}
              className="h-44 rounded-2xl bg-navy-100 dark:bg-navy-800 animate-pulse"
            />
          ))}
        </div>
      ) : (
        <div className="space-y-7">
          {CATEGORY_ORDER.map((category) => {
            const group = configs.filter((c) => c.category === category);
            if (group.length === 0) return null;
            return (
              <section key={category} ref={(el) => (sectionRefs.current[category] = el)} className="scroll-mt-4">
                <div className="flex items-center gap-3 mb-3">
                  <h2 className="text-[12px] font-bold uppercase tracking-[0.14em] text-navy-500 dark:text-navy-400 whitespace-nowrap">
                    {category}
                  </h2>
                  <div className="flex-1 h-px bg-navy-100 dark:bg-navy-800" />
                </div>
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  {group.map((cfg) => (
                    <div key={cfg.key} className="relative">
                      <GaugeChart
                        value={cfg.value}
                        min={cfg.min}
                        max={cfg.max}
                        benchmarks={cfg.benchmarks}
                        color={cfg.color}
                        fmt={cfg.fmt}
                        fmtAxis={cfg.fmtAxis}
                        label={cfg.label}
                        formula={cfg.formula}
                        interpretations={cfg.interpretations}
                      />
                      {/* Approximation notice */}
                      {cfg.note && (
                        <div className="mt-1 flex items-start gap-1 px-1">
                          <Info size={10} className="text-navy-400 shrink-0 mt-0.5" />
                          <span className="text-[10px] text-navy-400 dark:text-navy-500 leading-snug">
                            {cfg.note}
                          </span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* ── Footer ── */}
      <div className="mt-8 text-center text-[11px] text-navy-400">
        Benchmark Dashboard · {periodLabel} · Data from {providerLabel(provider)} sync
      </div>
    </div>
  );
}
