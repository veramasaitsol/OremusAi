/**
 * Key Ratios Summary — the same 18 ratios as the Ratios (Benchmark) page,
 * compared across the last N fiscal years side by side (FY24 | FY25 | FY26 …),
 * mirroring the reference "Key Ratios Summary" layout. Backed by
 * GET /api/ratios/fy-summary, which reuses the exact same Key Ratios engine
 * as the single-period Ratios page — a ratio can never disagree between the
 * two views.
 */
import { useEffect, useState, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import DashboardTabs from '../components/common/DashboardTabs.jsx';
import axiosClient from '../services/axiosClient.js';
import { fmtMoneyCompact } from '../utils/fmt.js';
import { cn } from '../utils/classNames.js';
import { toast } from '../utils/toastStore.js';

const fmtPctOrNA  = (v) => (v == null ? 'N/A' : `${v.toFixed(1)}%`);
const fmtRatioOrNA = (v) => (v == null ? 'N/A' : v.toFixed(2));
const fmtTimesOrNA = (v) => (v == null ? 'N/A' : `${v.toFixed(2)}×`);
const fmtDaysOrNA  = (v) => (v == null ? 'N/A' : `${v.toFixed(1)}d`);
const fmtMoneyOrNA = (currency) => (v) => (v == null ? 'N/A' : fmtMoneyCompact(v, currency));

// One row per ratio: { key, label, formula, fmt }. `fmt` is bound to currency
// per-render since Working Capital needs it. Grouped in the same order/
// sections as the reference "Key Ratios Summary" tab.
function buildRowGroups(currency) {
  const money = fmtMoneyOrNA(currency);
  return [
    {
      title: 'Profitability',
      rows: [
        { key: 'grossProfitMargin',      label: 'Gross Profit Margin',                     fmt: fmtPctOrNA },
        { key: 'operatingMargin',        label: 'Operating Margin',                         fmt: fmtPctOrNA },
        { key: 'netProfitMargin',        label: 'Net Profit Margin',                        fmt: fmtPctOrNA },
        { key: 'returnOnEquity',         label: 'Return on Equity — Closing Equity Basis',  fmt: fmtPctOrNA },
        { key: 'returnOnEquityAverage',  label: 'Return on Equity — Average Equity Basis',  fmt: fmtPctOrNA },
        { key: 'returnOnInvestment',     label: 'Return on Investment (ROI)',               fmt: fmtPctOrNA },
      ],
    },
    {
      title: 'Liquidity',
      rows: [
        { key: 'currentRatio',   label: 'Current Ratio',    fmt: fmtRatioOrNA },
        { key: 'cashFlowRatio',  label: 'Cash Flow Ratio',  fmt: fmtRatioOrNA },
        { key: 'workingCapital', label: 'Working Capital',  fmt: money },
        { key: 'quickRatio',     label: 'Quick Ratio',      fmt: fmtRatioOrNA },
      ],
    },
    {
      title: 'Efficiency & Turnover',
      rows: [
        { key: 'assetTurnover',             label: 'Asset Turnover Ratio',              fmt: fmtTimesOrNA },
        { key: 'receivablesTurnover',       label: 'Receivables Turnover',              fmt: fmtTimesOrNA },
        { key: 'avgDebtorDays',             label: 'Average Debtor Days (AR Days)',     fmt: fmtDaysOrNA },
        { key: 'avgPayableDays',            label: 'Average Payable Days (AP Days)',    fmt: fmtDaysOrNA },
        { key: 'inventoryTurnover',         label: 'Inventory Turnover',                fmt: fmtTimesOrNA },
        { key: 'daysInventoryOutstanding',  label: 'Days Inventory Outstanding (DIO)',  fmt: fmtDaysOrNA },
      ],
    },
    {
      title: 'Leverage & Solvency',
      rows: [
        { key: 'debtToEquity',         label: 'Debt / Equity Ratio',                fmt: fmtRatioOrNA },
        { key: 'equityMultiplier',     label: 'Equity Multiplier',                  fmt: fmtTimesOrNA },
        { key: 'financialLeverage',    label: 'Financial Leverage Ratio',           fmt: fmtTimesOrNA },
        { key: 'debtServiceCoverage',  label: 'Debt Service Coverage Ratio (DSCR)', fmt: fmtTimesOrNA },
      ],
    },
  ];
}

export default function KeyRatiosSummary() {
  const [years, setYears]     = useState([]);   // [{ label, from, to, ratios }]
  const [provider, setProvider] = useState(null);
  const [currency, setCurrency] = useState('INR');
  const [count, setCount]     = useState(3);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const load = useCallback(async (n) => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await axiosClient.get('/ratios/fy-summary', { params: { count: n } });
      setYears(data.years || []);
      setProvider(data.provider || null);
      setCurrency(data.currency || 'INR');
    } catch {
      setError('Could not load the fiscal-year comparison.');
      toast.error('Could not load the fiscal-year comparison.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(count); }, [load, count]);

  const groups = buildRowGroups(currency);

  return (
    <div className="px-4 lg:px-6 py-5">
      <DashboardTabs />

      <div className="flex flex-col gap-1 mb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-navy-900 dark:text-white">Key Ratios Summary</h1>
          <p className="text-[13px] text-navy-500 dark:text-navy-400">
            The same 18 ratios as the Benchmark Dashboard, compared across fiscal years
            {provider ? ` · ${provider === 'quickbooks' ? 'QuickBooks' : provider === 'xero' ? 'Xero' : 'Zoho Books'}` : ''}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="text-[13px] rounded-lg border border-navy-200 dark:border-navy-700 bg-white dark:bg-navy-900 px-2.5 py-1.5"
          >
            <option value={2}>Last 2 fiscal years</option>
            <option value={3}>Last 3 fiscal years</option>
            <option value={5}>Last 5 fiscal years</option>
          </select>
          <button
            onClick={() => load(count)}
            disabled={loading}
            className="flex items-center gap-1.5 text-[13px] rounded-lg border border-navy-200 dark:border-navy-700 px-2.5 py-1.5 hover:bg-navy-50 dark:hover:bg-navy-800"
          >
            <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 text-[13px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-navy-100 dark:border-navy-800 overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr className="bg-navy-50 dark:bg-navy-900/60">
              <th className="text-left px-4 py-2.5 font-semibold text-navy-700 dark:text-navy-200 sticky left-0 bg-navy-50 dark:bg-navy-900/60">
                Ratio
              </th>
              {years.map((y) => (
                <th key={y.label} className="text-right px-4 py-2.5 font-semibold text-navy-700 dark:text-navy-200 whitespace-nowrap">
                  {y.label}
                  <div className="text-[10.5px] font-normal text-navy-400">{y.from} – {y.to}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <RowGroup key={g.title} group={g} years={years} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RowGroup({ group, years }) {
  return (
    <>
      <tr>
        <td
          colSpan={years.length + 1}
          className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider text-navy-500 dark:text-navy-400 bg-navy-50/60 dark:bg-navy-900/40"
        >
          {group.title}
        </td>
      </tr>
      {group.rows.map((row) => (
        <tr key={row.key} className="border-t border-navy-50 dark:border-navy-800/60">
          <td className="px-4 py-1.5 text-navy-700 dark:text-navy-300 sticky left-0 bg-white dark:bg-navy-950">
            {row.label}
          </td>
          {years.map((y) => (
            <td key={y.label} className="px-4 py-1.5 text-right tabular-nums text-navy-800 dark:text-navy-100">
              {row.fmt(y.ratios ? y.ratios[row.key] : null)}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
