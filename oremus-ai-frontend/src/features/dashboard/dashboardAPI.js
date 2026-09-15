import axiosClient from '../../services/axiosClient.js';
import { fmt } from '../../utils/fmt.js';

const PALETTE = ['#2563EB', '#06B6D4', '#8B5CF6', '#10B981', '#F59E0B', '#64748B'];

function toMonthLabel(ym) {
  return new Date(ym + '-01').toLocaleString('en', { month: 'short' });
}

export async function fetchDashboard({ clientId, from, to, basis } = {}) {
  try {
    const params = {};
    if (from)  params.from  = from;
    if (to)    params.to    = to;
    if (basis) params.basis = basis;

    const [statsRes, revRes, expRes, topCustRes, topVendRes, expBreakRes, cashRes, activityRes, profitRes, complianceRes, ratiosRes] =
      await Promise.all([
        axiosClient.get('/dashboard',                        { params }),
        axiosClient.get('/dashboard/revenue-trend',          { params }),
        axiosClient.get('/dashboard/expense-trend',          { params }),
        axiosClient.get('/dashboard/top-customers?limit=5', { params }),
        axiosClient.get('/dashboard/top-vendors?limit=5',   { params }),
        axiosClient.get('/dashboard/expense-breakdown',      { params }),
        axiosClient.get('/dashboard/cashflow-trend',         { params }),
        axiosClient.get('/dashboard/activity',               { params }),
        // EBITDA KPI tile (Dashboard requirement #31 · Add) — sourced from the
        // profitability metrics endpoint. Soft-fails so a profitability error
        // never blanks the whole dashboard.
        axiosClient.get('/metrics/profitability',            { params }).catch(() => ({ data: { data: {} } })),
        // Compliance tile — statutory payables, overdue AR/AP, filing deadlines.
        // Soft-fails so a compliance error never blanks the whole dashboard.
        axiosClient.get('/dashboard/compliance',             { params }).catch(() => ({ data: { data: [] } })),
        // Current Ratio KPI tile — the same Key Ratios engine behind the
        // Ratios page, scoped to this selected period. Soft-fails so a
        // ratios error never blanks the whole dashboard.
        axiosClient.get('/ratios',                            { params }).catch(() => ({ data: { data: {} } })),
      ]);

    const stats    = statsRes.data.data    ?? {};
    const revTrend = revRes.data.data      ?? [];
    const expTrend = expRes.data.data      ?? [];
    const topCust  = topCustRes.data.data  ?? [];
    const topVend  = topVendRes.data.data  ?? [];
    const expBreak = expBreakRes.data.data ?? [];
    const ratios   = ratiosRes.data.data   ?? {};
    const cashData = cashRes.data.data     ?? [];
    const activityData = activityRes.data.data ?? [];
    const profit   = profitRes.data.data   ?? {};
    const compliances = complianceRes.data.data ?? [];

    // ── Revenue + Expense trend ───────────────────────────────────────────────
    const trendMap = {};
    revTrend.forEach(r => {
      trendMap[r.month] = { rev: Math.round((r.revenue || 0) / 1000), exp: 0 };
    });
    expTrend.forEach(e => {
      if (trendMap[e.month]) trendMap[e.month].exp = Math.round((e.expenses || 0) / 1000);
      else trendMap[e.month] = { rev: 0, exp: Math.round((e.expenses || 0) / 1000) };
    });
    const revExp = Object.entries(trendMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ m: toMonthLabel(month), rev: v.rev, exp: v.exp, profit: v.rev - v.exp }));

    // ── Cash flow ─────────────────────────────────────────────────────────────
    const cashFlow = cashData.length > 0
      ? cashData.map(d => ({
          m:       toMonthLabel(d.month),
          inflow:  Math.round((d.inflow  || 0) / 1000),
          outflow: Math.round((d.outflow || 0) / 1000),
        }))
      : revExp.map(d => ({ m: d.m, inflow: d.rev, outflow: d.exp }));

    // ── KPI tiles (matches Dashboard 4 design) ───────────────────────────────
    const cashOnHand   = Math.round(stats.cashOnHand   || 0);
    const bankCount    = stats.bankCount                || 0;
    const monthlyBurn  = Math.round(stats.monthlyBurn  || 0);
    const runwayMonths = stats.runwayMonths             ?? null;
    const cur          = stats.currency || 'INR';

    const kpis = [
      // ── Total Revenue (Dashboard requirement #1 · Remove) — hidden ──────────
      // {
      //   id:    'rev',
      //   label: 'Total Revenue',
      //   value: Math.round(stats.totalRevenue || 0),
      //   sub:   'this period',
      //   delta: stats.revenueGrowth ?? 0,
      //   color: '#2563EB',
      //   icon:  'TrendingUp',
      // },
      {
        id:     'cash',
        label:  'Cash on Hand',
        value:  cashOnHand,
        sub:    bankCount > 0 ? `across ${bankCount} bank${bankCount !== 1 ? 's' : ''}` : 'bank balance',
        delta:  0,
        color:  '#8B5CF6',
        icon:   'Wallet',
      },
      {
        id:     'burn',
        label:  'Burn / Runway',
        // Prefer runway in months; when it can't be computed (e.g. negative
        // cash), fall back to the monthly burn rate so the card isn't blank.
        value:  runwayMonths != null
                  ? (runwayMonths >= 60 ? '60+ mo' : `${runwayMonths} mo`)
                  : (monthlyBurn > 0 ? `${fmt(monthlyBurn, { currency: cur })}/mo` : '—'),
        isText: true,
        sub:    runwayMonths != null
                  ? (monthlyBurn > 0 ? `${fmt(monthlyBurn, { currency: cur })}/mo burn` : 'runway estimate')
                  : (monthlyBurn > 0 ? (cashOnHand <= 0 ? 'cash deficit · no runway' : 'monthly burn rate') : 'no burn data'),
        delta:  -4.2,   // static until we have MoM burn tracking
        color:  '#EF4444',
        icon:   'TrendingDown',
      },
      // ── Receivables (Dashboard requirement #7 · Delete) — hidden ────────────
      // {
      //   id:    'rec',
      //   label: 'Receivables',
      //   value: Math.round(stats.outstandingReceivables || 0),
      //   sub:   `${stats.totalInvoices || 0} invoices`,
      //   delta: 0,
      //   color: '#10B981',
      //   icon:  'ReceiptText',
      // },
      // ── EBITDA (Dashboard requirement #31 · Add) ───────────────────────────
      {
        id:    'ebitda',
        label: 'EBITDA',
        value: Math.round(profit.ebitda || 0),
        sub:   profit.ebitdaMargin == null ? 'margin —' : `${profit.ebitdaMargin}% margin`,
        delta: 0,
        color: '#8B5CF6',
        icon:  'BarChart2',
      },
      // ── Current Ratio (Dashboard requirement #47 · Existing, Liquidity
      // metrics) — same Key Ratios engine as the Ratios page, scoped to the
      // selected period so it moves with the filter like every other tile.
      {
        id:     'currentRatio',
        label:  'Current Ratio',
        value:  ratios.currentRatio == null ? '—' : `${ratios.currentRatio.toFixed(2)}×`,
        isText: true,
        sub:    ratios.currentRatio == null
                  ? 'no data for this period'
                  : ratios.currentRatio >= 1.5 ? 'healthy liquidity'
                  : ratios.currentRatio >= 1   ? 'adequate liquidity'
                  : 'below 1× — watch closely',
        delta: 0,
        color: '#06B6D4',
        icon:  'Scale',
      },
    ];

    // ── Expense mix ───────────────────────────────────────────────────────────
    const totalExpAmt = expBreak.reduce((s, r) => s + parseFloat(r.totalAmount || 0), 0);
    const expenseMix = totalExpAmt > 0
      ? expBreak.slice(0, 6).map((r, i) => ({
          name:    r.account_name || 'Other',
          value:   Math.round((parseFloat(r.totalAmount) / totalExpAmt) * 100), // pct
          amount:  Math.round(parseFloat(r.totalAmount) / 1000),                // ₹k
          color:   PALETTE[i % PALETTE.length],
        }))
      : [];

    // ── Top customers ─────────────────────────────────────────────────────────
    const topCustomers = topCust.map((c, i) => ({
      id:     `tc${i}`,
      name:   c.customer_name,
      sub:    `${c.invoiceCount} invoice${c.invoiceCount !== 1 ? 's' : ''}`,
      amount: Math.round(c.totalRevenue || 0),
      trend:  0,
    }));

    // ── Top vendors ───────────────────────────────────────────────────────────
    const topVendors = topVend.map((v, i) => ({
      id:     `tv${i}`,
      name:   v.vendor_name,
      sub:    `${v.billCount} bill${v.billCount !== 1 ? 's' : ''}`,
      amount: Math.round(v.totalAmount || 0),
      trend:  0,
    }));

    return {
      revExp,
      cashFlow,
      kpis,
      expenseMix,
      topCustomers,
      topVendors,
      compliances,
      aiInsights:   [],
      activity:     activityData,
      rawStats: {
        totalRevenue:           Math.round(stats.totalRevenue           || 0),
        totalExpenses:          Math.round(stats.totalExpenses          || 0),
        totalInvoices:          stats.totalInvoices                     || 0,
        outstandingReceivables: Math.round(stats.outstandingReceivables || 0),
        totalCustomers:         stats.totalCustomers                    || 0,
        totalPayments:          Math.round(stats.totalPayments          || 0),
        currency:               stats.currency || 'INR',
      },
    };
  } catch (err) {
    // Propagate the failure so the slice hits `rejected` — the UI keeps the
    // last good data and shows an error banner. Substituting zeros here made
    // slow/failed connections render "₹0" as if it were real data.
    console.warn('Dashboard API error:', err.message);
    throw err;
  }
}
