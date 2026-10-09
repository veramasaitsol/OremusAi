'use strict';

/**
 * Key Ratios engine — the 18 financial ratios (margins, liquidity, leverage,
 * returns, turnover), computed the same way for every platform (Zoho /
 * QuickBooks / Xero) from ONLY the already-synced local ledger. Nothing here
 * calls a provider API and nothing is hardcoded to one client's chart of
 * accounts — every figure is derived from account_type_code classifications
 * that already work identically across all three platforms, so a ratio comes
 * back N/A only when the underlying data genuinely doesn't exist (no debt, no
 * inventory, no prior-period balance), never because of an assumption baked
 * in for one company.
 *
 * Every building block is reused from the report engines that already back
 * the P&L / Balance Sheet reports, so ratios can never drift from what those
 * reports show:
 *   - P&L totals        → zohoLedgerReportsService.computePLFigures
 *   - Interest/Tax/Depr → zohoLedgerReportsService.extractPLLineItems
 *   - Balance Sheet      → zohoGlReportsService.aggregateBS (point-in-time,
 *                          same engine behind the Balance Sheet report)
 * Cash flow (Operating CF / CapEx / Free CF) is this file's own simplified
 * indirect method (deriveCashFlowMetrics, below) — deliberately NOT
 * zohoLedgerReportsService.aggregateIndirectCashFlow, which is the full,
 * granular per-account reconstruction the actual Cash Flow Statement report
 * needs. This module and the Dashboard's Cash Flow Metrics card
 * (services/metricsService.js) both call deriveCashFlowMetrics, so they can
 * never disagree with each other — they were previously two separate,
 * independently-drifting implementations.
 */

const {
  computePLFigures, extractPLLineItems,
  aggregateIndirectCashFlow, sumNegativeInvestingOutflows,
} = require('./zohoLedgerReportsService');
const { aggregateBS } = require('./zohoGlReportsService');
const { margins, deriveEbitda } = require('./metricsService');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// A ratio's denominator: null when it's zero/missing, so callers can tell
// "N/A — no data" apart from a genuine 0.
function safe(numerator, denominator) {
  if (denominator === null || denominator === undefined || denominator === 0) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

// Percent-scaled ratio (margins, ROE, ROI) — null propagates through instead
// of producing 0%.
function pct(numerator, denominator) {
  const r = safe(numerator, denominator);
  return r === null ? null : r * 100;
}

function dayBefore(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Accounts that represent real borrowings (loans, debentures, lease/OD
// facilities) rather than routine provisions or accruals — matched by name
// since account_type_code alone doesn't distinguish "Provision for Gratuity"
// (long_term_liability, not debt) from an actual term loan (also
// long_term_liability on every platform). credit_card-typed accounts are
// always counted as debt. No platform/company is special-cased — a client
// with zero matching accounts correctly gets Total Debt = 0, same as one
// with an actual loan gets it picked up automatically.
const RE_DEBT_ACCOUNT = /\b(loan|borrowing|debenture|overdraft|lease liabilit|notes? payable|term loan|line of credit|od account)\b/i;

// Accumulated depreciation shares the SAME account_type_code ('fixed_asset')
// as the cost accounts it offsets on every platform — there's no separate
// type code for it — so Gross Fixed Assets (cost, before depreciation) is
// only recoverable by name. Same pattern already used for CapEx elsewhere
// in this codebase (metricsService.js's capex query).
const RE_ACCUM_DEPRECIATION = /accumulated\s*deprecia/i;

// Collapse an aggregateBS() snapshot { assets, liabilities, equity } (each a
// Map of accountId -> {amount, typeCode, name}) into the scalar totals every
// ratio needs. `currentAssets` / `currentLiabilities` use the EXACT SAME
// account_type_code sets as the Balance Sheet Report's own "Current Assets" /
// "Current Liabilities" sections (BS_SUBGROUPS in zohoGlReportsService.js),
// so these figures — and the Liquidity Metrics card that displays them
// directly — tie out to that report instead of drifting from it:
//   currentAssets      = bank + cash + accounts_receivable + other_current_asset
//                         (Bank nests under Current Assets on the report)
//   currentLiabilities = accounts_payable + other_current_liability (NOT
//                         credit_card — the Report buckets that separately;
//                         it still counts toward `debt` below, just not here)
// ABS() is applied only to Total Assets / Total Current Assets / Total
// Current Liabilities when they serve as a ratio's "positive base" — the same
// convention the reference ratio methodology documents (needed because a bank
// account holding an overdraft posts as a negative balance INSIDE Assets on
// every platform's export, not as a Liability) — and never to a figure meant
// to show its true sign as a result (Working Capital, Total Debt, Total
// Equity).
function bsTotals(bs) {
  let bank = 0, ar = 0, otherCurrentAsset = 0, totalAssets = 0, grossFixedAssets = 0;
  for (const { amount, typeCode, name } of bs.assets.values()) {
    totalAssets += amount;
    const tc = (typeCode || '').toLowerCase();
    if (tc === 'bank' || tc === 'cash') bank += amount;
    else if (tc === 'accounts_receivable') ar += amount;
    else if (tc === 'other_current_asset') otherCurrentAsset += amount;
    else if (tc === 'fixed_asset' && !RE_ACCUM_DEPRECIATION.test(name || '')) grossFixedAssets += amount;
  }
  let ap = 0, otherCurrentLiability = 0, totalLiabilities = 0, debt = 0;
  for (const { amount, typeCode, name } of bs.liabilities.values()) {
    totalLiabilities += amount;
    const tc = (typeCode || '').toLowerCase();
    if (tc === 'accounts_payable') ap += amount;
    else if (tc === 'other_current_liability') otherCurrentLiability += amount;
    if (tc === 'credit_card' || RE_DEBT_ACCOUNT.test(name || '')) debt += amount;
  }
  // aggregateBS's equity Map holds only PRIOR-year accumulated earnings
  // (Retained Earnings) — the current period's P&L is returned separately as
  // `netIncome` ("Current Year Earnings", the same line buildBalanceSheet
  // renders explicitly in the Equity section). Total Equity must include
  // both, or the balance sheet fails to balance (Assets = Liabilities +
  // Equity) by exactly the period's net profit — caught by a 64-scenario x
  // 3-client double-entry regression check before this shipped.
  let totalEquity = num(bs.netIncome);
  for (const { amount } of bs.equity.values()) totalEquity += amount;

  const currentAssets = bank + ar + otherCurrentAsset;
  const currentLiabilities = ap + otherCurrentLiability;
  const hasData = bs.assets.size > 0 || bs.liabilities.size > 0 || bs.equity.size > 0;

  return {
    hasData,
    bank, ar, currentAssets, totalAssets, grossFixedAssets,
    ap, currentLiabilities, totalLiabilities, debt,
    totalEquity,
  };
}

const avg = (a, b) => (a + b) / 2;

/**
 * The reference ratio methodology's simplified indirect-method cash flow —
 * deliberately coarser than a full Statement of Cash Flows (which wants
 * line-item detail: ΔAR, ΔAP, ΔInventory each their own row — that's what
 * zohoLedgerReportsService.aggregateIndirectCashFlow / buildCashFlow are for,
 * and this does NOT replace them). This is the "metrics/ratios" version:
 *   operatingCashFlow = Net Profit + Depreciation − Change in Working Capital
 *   Working Capital   = Current Assets − Current Liabilities
 *                       (same Current Assets as the Balance Sheet Report,
 *                       including Bank & Cash)
 *   changeInWorkingCapital = WC(as of `to`) − WC(as of day before `from`)
 *   Depreciation      = Depreciation + Amortization from the P&L
 *   grossFixedAssets  = |Σ negative Investing Activities lines| from the
 *     Cash Flow Statement (same engine as the report)
 *   capex             = same figure
 *   freeCashFlow      = operatingCashFlow − grossFixedAssets
 *   netChange = Cash & Bank this period-end minus at the period's start —
 *     computed directly, NOT derived from operatingCashFlow/FCF, so it
 *     stays a plain, independently-measured fact.
 * `investingOutflows` is the precomputed GFA from the CF report (null when
 * unavailable). `null` for every field when there's no prior-period snapshot
 * to diff against (a brand-new client) — never a fabricated 0.
 */
function deriveCashFlowMetrics(pl, pli, close, open, hasOpening, investingOutflows) {
  if (!hasOpening) {
    return {
      operatingCashFlow: null, changeInWorkingCapital: null,
      capex: null, freeCashFlow: null, netChange: null, grossFixedAssets: null,
    };
  }
  // WC matches Liquidity / Balance Sheet: Current Assets (incl. Bank) − CL.
  const wcClose = close.currentAssets - close.currentLiabilities;
  const wcOpen = open.currentAssets - open.currentLiabilities;
  const changeInWorkingCapital = r2(wcClose - wcOpen);
  const operatingCashFlow = r2(pl.netProfit + pli.depreciation - changeInWorkingCapital);
  // GFA = abs(sum of negative Investing Activities lines on the CF Statement).
  const grossFixedAssets = investingOutflows == null ? null : r2(investingOutflows);
  const capex = grossFixedAssets;
  const freeCashFlow = grossFixedAssets == null
    ? null
    : r2(operatingCashFlow - grossFixedAssets);
  const netChange = r2(close.bank - open.bank);
  return { operatingCashFlow, changeInWorkingCapital, capex, freeCashFlow, netChange, grossFixedAssets };
}
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/**
 * computeCashFlowMetrics(userId, orgId, platform, from, to, fyStartMonth)
 * Standalone entry point for callers that don't already have `pl`/`close`/
 * `open` on hand (the Dashboard's Cash Flow Metrics card). computeKeyRatios
 * below reuses the pure `deriveCashFlowMetrics` directly against data it has
 * already fetched, rather than calling this and re-querying — same formula,
 * zero duplicate DB round-trips.
 */
async function computeCashFlowMetrics(userId, orgId, platform, from, to, fyStartMonth = 4) {
  const asOfOpen = dayBefore(from);
  const [pl, pli, bsCloseRaw, bsOpenRaw, cfStmt] = await Promise.all([
    computePLFigures(userId, orgId, null, from, to),
    extractPLLineItems(userId, orgId, from, to),
    aggregateBS(userId, orgId, null, to, null, fyStartMonth),
    aggregateBS(userId, orgId, null, asOfOpen, null, fyStartMonth),
    // Same Investing Activities lines the Cash Flow Statement report shows.
    aggregateIndirectCashFlow(userId, orgId, null, from, to),
  ]);
  const close = bsTotals(bsCloseRaw);
  const open = bsTotals(bsOpenRaw);
  const hasOpening = open.hasData;
  const investingOutflows = sumNegativeInvestingOutflows(cfStmt.accounts);
  const cf = deriveCashFlowMetrics(pl, pli, close, open, hasOpening, investingOutflows);
  return {
    ...cf,
    netProfit: pl.netProfit,
    depreciation: pli.depreciation,
    currentAssets: close.currentAssets,
    currentLiabilities: close.currentLiabilities,
    grossFixedAssets: cf.grossFixedAssets != null ? cf.grossFixedAssets : close.grossFixedAssets,
    cash: close.bank,
    hasOpeningPeriodData: hasOpening,
    from, to, asOfOpen, asOfClose: to, platform, fyStartMonth,
  };
}

/**
 * computeKeyRatios(userId, orgId, platform, from, to, fyStartMonth)
 * Returns { ratios, raw }. `ratios` values are `null` when genuinely N/A
 * (no data for that figure), never a fabricated 0. Percent-style ratios
 * (margins, ROE, ROI, Cash Flow Ratio) are scaled ×100; multiples (Current
 * Ratio, Equity Multiplier, turnover ratios, …) are plain numbers; day-count
 * ratios (AR/AP Days) are days.
 */
async function computeKeyRatios(userId, orgId, platform, from, to, fyStartMonth = 4) {
  const asOfClose = to;
  const asOfOpen = dayBefore(from);

  const [pl, pli, bsCloseRaw, bsOpenRaw, cfStmt] = await Promise.all([
    computePLFigures(userId, orgId, null, from, to),
    extractPLLineItems(userId, orgId, from, to),
    aggregateBS(userId, orgId, null, asOfClose, null, fyStartMonth),
    aggregateBS(userId, orgId, null, asOfOpen, null, fyStartMonth),
    // Same Investing Activities lines the Cash Flow Statement report shows.
    aggregateIndirectCashFlow(userId, orgId, null, from, to),
  ]);

  const close = bsTotals(bsCloseRaw);
  const open = bsTotals(bsOpenRaw);
  const hasOpening = open.hasData;
  // Same Operating Cash Flow formula the Dashboard's Cash Flow Metrics card
  // uses (deriveCashFlowMetrics, above) — computed here from data already
  // fetched, not by calling computeCashFlowMetrics again, so Ratios and the
  // Dashboard can never disagree without an extra DB round-trip.
  // GFA = |Σ negative Investing Activities| from the Cash Flow Statement.
  const investingOutflows = sumNegativeInvestingOutflows(cfStmt.accounts);
  const cf = deriveCashFlowMetrics(pl, pli, close, open, hasOpening, investingOutflows);

  const plFull = { ...pl, depreciation: pli.depreciation };
  const m = margins(pl); // { grossMargin, operatingMargin, netMargin } — %, revenue-based, null if revenue<=0
  const ebitda = deriveEbitda(plFull); // { ebitda, ebitdaMargin }

  const totalAssetsCloseAbs = Math.abs(close.totalAssets);
  const totalAssetsOpenAbs = Math.abs(open.totalAssets);
  // close.currentAssets matches the Balance Sheet Report's "Current Assets"
  // section (includes Bank & Cash — see bsTotals / BS_SUBGROUPS).
  const currentAssetsCloseAbs = Math.abs(close.currentAssets);
  const currentLiabilitiesCloseAbs = Math.abs(close.currentLiabilities);

  const avgTotalAssetsAbs = hasOpening ? avg(totalAssetsOpenAbs, totalAssetsCloseAbs) : null;
  const avgEquity = hasOpening ? avg(open.totalEquity, close.totalEquity) : null;
  const avgAR = hasOpening ? avg(open.ar, close.ar) : null;

  const receivablesTurnover = safe(pl.revenue, avgAR);
  const assetTurnover = safe(pl.revenue, avgTotalAssetsAbs);
  const financialLeverage = hasOpening ? safe(avgTotalAssetsAbs, avgEquity) : null;

  // Inventory: no inventory account type exists in the synced GL for any
  // platform today (services businesses have none; product businesses would
  // need an 'inventory'-classified asset, which nothing currently syncs) —
  // genuinely N/A rather than a guess, for every client, not just this one.
  const inventoryTurnover = null;
  const daysInventoryOutstanding = null;

  // DSCR needs a principal-repayment schedule, which no local table carries
  // for any platform. When there's no debt at all it's cleanly N/A ("no debt
  // to service"); when a client DOES carry debt, it stays null (data not
  // available) rather than silently assuming a repayment amount.
  const dscr = null;

  // AR / AP Days — same formulas as the Dashboard Efficiency card:
  //   AR Days = (Closing AR ÷ Revenue) × periodDays
  //   AP Days = (Closing AP ÷ (Operating + Non-Operating Expense)) × periodDays
  // Closing AR/AP from the Balance Sheet as of `to`; Revenue / Expenses from
  // the P&L for [from, to]. periodDays is inclusive (full FY ≈ 365).
  const periodDays = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
  const closingAR = Math.abs(close.ar);
  const closingAP = Math.abs(close.ap);
  const apExpenseBase = num(pl.opex) + num(pl.otherExpense);
  const avgDebtorDays = pl.revenue > 0
    ? Math.round((closingAR / pl.revenue) * periodDays)
    : null;
  const avgPayableDays = apExpenseBase > 0
    ? Math.round((closingAP / apExpenseBase) * periodDays)
    : null;

  const ratios = {
    grossProfitMargin: m.grossMargin,
    operatingMargin:   m.operatingMargin,
    netProfitMargin:   m.netMargin,

    currentRatio:   safe(currentAssetsCloseAbs, currentLiabilitiesCloseAbs),
    quickRatio:     safe(close.bank + close.ar, currentLiabilitiesCloseAbs),
    workingCapital: close.hasData ? (close.currentAssets - close.currentLiabilities) : null,
    // Cash Flow Ratio = Operating Cash Flow ÷ Current Liabilities, as a %
    // (same scaling as ROE / margins). E.g. OCF 32,064 / CL 1,183,867 ≈ 2.71%.
    cashFlowRatio:  cf.operatingCashFlow != null
      ? pct(cf.operatingCashFlow, currentLiabilitiesCloseAbs)
      : null,

    // `returnOnEquity` = closing-equity basis, kept under its original name
    // (the existing Ratios page gauge reads this key); `returnOnEquityAverage`
    // is the additional average-equity-basis figure from the reference ratio
    // methodology (needs opening+closing equity, so null for a brand-new
    // client with no prior-period data).
    returnOnEquity:        pct(pl.netProfit, close.totalEquity),
    returnOnEquityAverage: hasOpening ? pct(pl.netProfit, avgEquity) : null,
    returnOnInvestment:    pct(pl.netProfit, totalAssetsCloseAbs),

    assetTurnover,
    receivablesTurnover,
    inventoryTurnover,
    daysInventoryOutstanding,
    avgDebtorDays,
    avgPayableDays,

    debtToEquity:      close.hasData ? safe(close.debt, close.totalEquity) : null,
    debtServiceCoverage: dscr,
    equityMultiplier:  safe(totalAssetsCloseAbs, close.totalEquity),
    financialLeverage,
  };

  return {
    ratios,
    raw: {
      revenue: pl.revenue, otherIncome: pl.otherIncome, cogs: pl.cogs, opex: pl.opex,
      otherExpense: pl.otherExpense,
      grossProfit: pl.grossProfit, operatingProfit: pl.operatingProfit, netProfit: pl.netProfit,
      depreciation: pli.depreciation, interestExpense: pli.interestExpense, incomeTax: pli.incomeTax,
      ebitda: ebitda.ebitda, ebitdaMargin: ebitda.ebitdaMargin,
      operatingCashFlow: cf.operatingCashFlow, changeInWorkingCapital: cf.changeInWorkingCapital,
      grossFixedAssets: cf.grossFixedAssets,
      capex: cf.capex, freeCashFlow: cf.freeCashFlow, netChange: cf.netChange,
      totalAssets: close.totalAssets, currentAssets: close.currentAssets,
      totalLiabilities: close.totalLiabilities, currentLiabilities: close.currentLiabilities,
      totalEquity: close.totalEquity, totalDebt: close.debt,
      accountsReceivable: close.ar, accountsPayable: close.ap, bankBalance: close.bank,
      // Balances the day before `from` (null without an opening snapshot) — for
      // average-balance ratios such as standard AR Days.
      openingAccountsReceivable: hasOpening ? open.ar : null,
      openingAccountsPayable: hasOpening ? open.ap : null,
      hasOpeningPeriodData: hasOpening,
      from, to, asOfOpen, asOfClose, platform, fyStartMonth,
    },
  };
}

module.exports = { computeKeyRatios, computeCashFlowMetrics };
