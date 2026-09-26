'use strict';

/**
 * metricsService — derives expanded Revenue / Profitability / Cash Flow metrics
 * from each provider's OWN financial reports (P&L, Balance Sheet, Cash Flow) via
 * the provider-agnostic adapter layer, so the figures tie out EXACTLY to Zoho
 * Books / Xero / QuickBooks. Breakdowns (revenue-by-product, recurring split)
 * come from the synced Zoho warehouse tables; QB/Xero return empty arrays.
 *
 * Pure derivation functions (rowAmount, derivePL, deriveEbitda, margins,
 * priorPeriod, growth, deriveCashFlow) are unit-testable with no DB/HTTP.
 * The orchestrators (getRevenue/Profitability/Cashflow Metrics) resolve a LOCAL
 * context (resolveLocalCtx) and derive figures from the synced tables via
 * localPL() / bankFlows() — NO live provider report fetch.
 */

const pool = require('../config/db');

// ── Schema-drift resolver for the Zoho token/org tables ───────────────────────
// Older DBs store the Zoho connection in `zoho_tokens` / `zoho_organizations`;
// newer (warehouse) DBs renamed these to `zb_tokens` / `zb_oauth_organizations`.
// Detect which pair actually exists (cached) so the metrics resolve a connection
// on either schema WITHOUT creating any new tables.
let _zohoConnTablesCache = null;
async function zohoConnTables() {
  if (_zohoConnTablesCache) return _zohoConnTablesCache;
  const [rows] = await pool.query(
    `SELECT table_name AS t FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name IN ('zb_tokens','zoho_tokens','zb_oauth_organizations','zoho_organizations')`
  );
  const have = new Set(rows.map((r) => r.t || r.TABLE_NAME || r.table_name));
  _zohoConnTablesCache = {
    tokens: have.has('zb_tokens') ? 'zb_tokens' : (have.has('zoho_tokens') ? 'zoho_tokens' : null),
    orgs:   have.has('zb_oauth_organizations') ? 'zb_oauth_organizations'
          : (have.has('zoho_organizations') ? 'zoho_organizations' : null),
  };
  return _zohoConnTablesCache;
}

// ── Report row value reader (mirror routes/dashboard.js rowAmount) ────────────
// Zoho keys the value cell `amount`, QB `c0`, Xero `c1`. Fall back to the last
// numeric cell so we work regardless of transformer style.
function rowAmount(row) {
  const c = (row && row.cells) || {};
  if (c.c0 != null) return Number(c.c0) || 0;
  if (c.amount != null) return Number(c.amount) || 0;
  if (c.balance != null) return Number(c.balance) || 0;
  const vals = Object.values(c).filter((v) => typeof v === 'number');
  return vals.length ? Number(vals[vals.length - 1]) || 0 : 0;
}

// ── P&L label matching ────────────────────────────────────────────────────────
const RE_TOTAL_INCOME = /^(total\s+)?(operating\s+income|income|revenue|sales)$/;
const RE_OTHER_INCOME = /^(total\s+)?(other income|non[\s-]?operating income)$/;
const RE_COGS         = /^(total\s+)?(cost of goods sold|cogs|cost of sales)$/;
const RE_GROSS_PROFIT = /^gross profit$/;
const RE_OPEX         = /^(total\s+)?(operating expense[s]?|expense[s]?)$/;
const RE_OTHER_EXP    = /^(total\s+)?(other expense[s]?|non[\s-]?operating expense[s]?)$/;
const RE_OPERATING    = /^(operating profit|net operating income)$/;
const RE_NET_PROFIT   = /^(net profit|net loss|net income|net profit\/loss)$/;
const RE_DEPRECIATION = /deprecia|amorti/;
const RE_INTEREST     = /interest/;
const RE_TAX          = /(^|\b)(income )?tax/;
const RE_CAPEX        = /(capital expenditure|purchase of (fixed|property|plant|equipment)|fixed asset)/;

const norm = (s) => String(s || '').trim().toLowerCase();
const isSummaryRow = (r) => !!(r && (r.isSubtotal || r.isTotal));

// Pick the FIRST summary row (isSubtotal/isTotal) whose normalized label matches.
function pickSummary(rows, re) {
  for (const r of rows || []) {
    if (isSummaryRow(r) && re.test(norm(r.label))) return rowAmount(r);
  }
  return null;
}

// Pick the FIRST row (regardless of isSubtotal/isTotal) whose normalized label
// matches — Xero's P&L emits its final "Net Profit" line as a plain level-0
// row with neither flag set (unlike QB's "Net Income", which IS isTotal), so
// pickSummary alone misses it. Used as a second-tier fallback before resorting
// to the additive formula.
function pickAnyRow(rows, re) {
  for (const r of rows || []) {
    if (re.test(norm(r.label))) return rowAmount(r);
  }
  return null;
}

// Sum LEAF rows (not headers/subtotals/totals) whose label matches a regex.
function sumLeafByLabel(rows, re) {
  let s = 0;
  for (const r of rows || []) {
    if (r.isHeader || r.isSubtotal || r.isTotal) continue;
    if (re.test(norm(r.label))) s += rowAmount(r);
  }
  return s;
}

// Sum a Zoho-style section: the `Total for {section}` subtotal if present, else
// the section header amount. Used as a revenue/expense fallback.
function sumZohoSection(rows, names) {
  let s = 0;
  for (const r of rows || []) {
    const label = norm(r.label);
    const amt = rowAmount(r);
    if (!amt) continue;
    if (names.some((n) => label === norm(n) || label === `total for ${norm(n)}`)) s += amt;
  }
  return s;
}

/**
 * derivePL(rows, provider) → normalized P&L figures.
 * Prefers the report's own emitted summary rows (Gross/Operating/Net), falling
 * back to section summation so a single robust path covers Zoho/QB/Xero.
 */
function derivePL(rows, provider) {
  rows = rows || [];

  // Revenue: prefer a Total Income summary row; else sum Zoho income sections.
  let revenue = pickSummary(rows, RE_TOTAL_INCOME);
  if (revenue == null) revenue = sumZohoSection(rows, ['Operating Income', 'Income', 'Revenue']);
  revenue = Number(revenue) || 0;

  let otherIncome = pickSummary(rows, RE_OTHER_INCOME);
  if (otherIncome == null) otherIncome = sumZohoSection(rows, ['Non Operating Income', 'Other Income']);
  otherIncome = Number(otherIncome) || 0;

  let cogs = pickSummary(rows, RE_COGS);
  if (cogs == null) cogs = sumZohoSection(rows, ['Cost of Goods Sold']);
  cogs = Number(cogs) || 0;

  let opex = pickSummary(rows, RE_OPEX);
  if (opex == null) opex = sumZohoSection(rows, ['Operating Expense', 'Expense']);
  opex = Number(opex) || 0;

  let otherExpense = pickSummary(rows, RE_OTHER_EXP);
  if (otherExpense == null) otherExpense = sumZohoSection(rows, ['Non Operating Expense', 'Other Expense']);
  otherExpense = Number(otherExpense) || 0;

  // Gross / Operating / Net — prefer emitted summary rows.
  let grossProfit = pickSummary(rows, RE_GROSS_PROFIT);
  if (grossProfit == null) grossProfit = revenue - cogs;

  let operatingProfit = pickSummary(rows, RE_OPERATING);
  if (operatingProfit == null) operatingProfit = grossProfit - opex;

  // Depreciation / interest / tax — leaf rows (subsets of opex; not re-added).
  const depreciation = sumLeafByLabel(rows, RE_DEPRECIATION);
  const interest     = sumLeafByLabel(rows, RE_INTEREST);
  const tax          = sumLeafByLabel(rows, RE_TAX);

  let netProfit = pickSummary(rows, RE_NET_PROFIT);
  if (netProfit == null) netProfit = pickAnyRow(rows, RE_NET_PROFIT);
  if (netProfit == null) netProfit = operatingProfit + otherIncome - otherExpense - interest - tax;

  return {
    provider: provider || null,
    revenue,
    otherIncome,
    cogs,
    grossProfit: Number(grossProfit) || 0,
    opex,
    operatingProfit: Number(operatingProfit) || 0,
    otherExpense,
    interest,
    tax,
    depreciation,
    netProfit: Number(netProfit) || 0,
  };
}

// EBITDA = operating profit + D&A. When D&A is absent (0), EBITDA collapses to
// operating profit and we flag the fallback so callers can warn.
function deriveEbitda(pl) {
  const da = Number(pl.depreciation) || 0;
  const ebitda = (Number(pl.operatingProfit) || 0) + da;
  const m = margins(pl);
  return {
    ebitda,
    ebitdaMargin: pl.revenue > 0 ? round2((ebitda / pl.revenue) * 100) : null,
    daSource: da !== 0 ? 'reported' : 'fallback',
  };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Margins as value/revenue*100. Null when revenue <= 0 (margin undefined).
function margins(pl) {
  const rev = Number(pl.revenue) || 0;
  if (rev <= 0) return { grossMargin: null, operatingMargin: null, netMargin: null };
  return {
    grossMargin:     round2((pl.grossProfit / rev) * 100),
    operatingMargin: round2((pl.operatingProfit / rev) * 100),
    netMargin:       round2((pl.netProfit / rev) * 100),
  };
}

// Prior period of equal length immediately before {from,to}.
function priorPeriod({ from, to }) {
  const f = new Date(from + 'T00:00:00Z');
  const t = new Date(to + 'T00:00:00Z');
  const lenDays = Math.round((t - f) / 86400000) + 1; // inclusive
  const priorTo = new Date(f.getTime() - 86400000);
  const priorFrom = new Date(priorTo.getTime() - (lenDays - 1) * 86400000);
  const ymd = (d) => d.toISOString().slice(0, 10);
  return { from: ymd(priorFrom), to: ymd(priorTo) };
}

// Growth %. Null when prior is 0/null. Uses |prior| so a swing from a negative
// prior reads as a sensible signed percent.
function growth(current, prior) {
  const cur = Number(current) || 0;
  if (prior == null || Number(prior) === 0) {
    return { current: cur, prior: prior == null ? null : Number(prior), growthPct: null };
  }
  const p = Number(prior);
  return { current: cur, prior: p, growthPct: round2(((cur - p) / Math.abs(p)) * 100) };
}

// ── Cash Flow derivation (Zoho/QB cashflow report) ────────────────────────────
const RE_CF_OPERATING = /operating activit/i;
const RE_CF_INVESTING = /investing activit/i;
const RE_CF_FINANCING = /financing activit/i;
// Must NOT match activity rows like "Net Cash Provided by Operating Activities";
// only the final net-movement line ("Net Change in Cash", "Net cash increase…").
const RE_CF_NET       = /net (change|increase|decrease)[\s\w]*cash|net cash (increase|decrease|change)/i;

function pickCashflowSection(rows, re) {
  // Prefer a summary row (subtotal/total) for the activity; else any matching row.
  let summary = null, any = null;
  for (const r of rows || []) {
    if (re.test(norm(r.label)) || re.test(String(r.label || ''))) {
      if (isSummaryRow(r)) { summary = rowAmount(r); break; }
      if (any == null) any = rowAmount(r);
    }
  }
  return summary != null ? summary : any;
}

function deriveCashFlow(rows, provider) {
  rows = rows || [];
  const operating = pickCashflowSection(rows, RE_CF_OPERATING);
  const investing = pickCashflowSection(rows, RE_CF_INVESTING);
  const financing = pickCashflowSection(rows, RE_CF_FINANCING);
  let netChange = pickCashflowSection(rows, RE_CF_NET);
  if (netChange == null) {
    netChange = (Number(operating) || 0) + (Number(investing) || 0) + (Number(financing) || 0);
  }
  // CapEx — leaf rows under investing that look like asset purchases (positive magnitude).
  const capex = Math.abs(sumLeafByLabel(rows, RE_CAPEX));
  return {
    provider: provider || null,
    operating: operating == null ? null : Number(operating),
    investing: investing == null ? null : Number(investing),
    financing: financing == null ? null : Number(financing),
    netChange: Number(netChange) || 0,
    capex,
  };
}

// ── Warehouse breakdown queries (Zoho only; safe-empty otherwise) ─────────────
async function safeRows(sql, params) {
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (_) {
    return [];
  }
}

// Bank inflow/outflow/net from bank_transactions. Zoho convention:
// debit = money IN, credit = money OUT. Exclude inter-account moves.
async function bankFlows(effUserId, orgId, from, to) {
  const rows = await safeRows(
    `SELECT debit_or_credit AS dc, SUM(amount) AS total
       FROM bank_transactions
      WHERE user_id = ? AND org_id = ?
        AND transaction_date >= ? AND transaction_date <= ?
        AND transaction_type NOT IN ('transfer_fund','journal')
      GROUP BY debit_or_credit`,
    [effUserId, orgId, from, to]
  );
  let inflow = 0, outflow = 0;
  for (const r of rows) {
    if (r.dc === 'debit') inflow += Number(r.total) || 0;
    else if (r.dc === 'credit') outflow += Number(r.total) || 0;
  }
  return { inflow, outflow, net: inflow - outflow };
}

// Revenue grouped by product/service from invoice line items. Top-N + "Other".
async function revenueByProduct(effUserId, orgId, from, to, customerId, topN = 10) {
  const params = [effUserId, orgId, from, to];
  let custClause = '';
  if (customerId) { custClause = ' AND i.zoho_customer_id = ?'; params.push(String(customerId)); }
  const rows = await safeRows(
    `SELECT li.zoho_item_id AS itemId,
            COALESCE(NULLIF(li.item_name,''), NULLIF(li.name,''), 'Unnamed') AS name,
            SUM(li.item_total) AS amount
       FROM zb_invoice_line_items li
       JOIN invoices i
         ON i.user_id = li.user_id AND i.org_id = li.org_id
        AND i.zoho_id = li.zoho_invoice_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND i.date >= ? AND i.date <= ?
        AND i.status NOT IN ('void','draft')${custClause}
      GROUP BY li.zoho_item_id, name
      ORDER BY amount DESC`,
    params
  );
  const mapped = rows.map((r) => ({ itemId: r.itemId != null ? String(r.itemId) : null, name: r.name, amount: Number(r.amount) || 0 }));
  if (mapped.length <= topN) return mapped;
  const top = mapped.slice(0, topN);
  const other = mapped.slice(topN).reduce((s, r) => s + r.amount, 0);
  if (other) top.push({ itemId: null, name: 'Other', amount: round2(other) });
  return top;
}

// Recurring vs one-time split from invoices (recurring_invoice_id present).
async function recurringSplit(effUserId, orgId, from, to, customerId) {
  const params = [effUserId, orgId, from, to];
  let custClause = '';
  if (customerId) { custClause = ' AND zoho_customer_id = ?'; params.push(String(customerId)); }
  const [row] = await safeRows(
    `SELECT
        SUM(CASE WHEN recurring_invoice_id IS NOT NULL AND recurring_invoice_id <> '' THEN total ELSE 0 END) AS recurring,
        SUM(CASE WHEN recurring_invoice_id IS NULL OR recurring_invoice_id = '' THEN total ELSE 0 END) AS oneTime
       FROM invoices
      WHERE user_id = ? AND org_id = ?
        AND date >= ? AND date <= ?
        AND status NOT IN ('void','draft')${custClause}`,
    params
  );
  const recurring = Number(row && row.recurring) || 0;
  const oneTime = Number(row && row.oneTime) || 0;
  const total = recurring + oneTime;
  return { recurring, oneTime, total, recurringPct: total > 0 ? round2((recurring / total) * 100) : null };
}

// Revenue grouped by place of supply (geography) from invoices. Top-N + "Other".
async function revenueByGeography(effUserId, orgId, from, to, customerId, topN = 8) {
  const params = [effUserId, orgId, from, to];
  let custClause = '';
  if (customerId) { custClause = ' AND zoho_customer_id = ?'; params.push(String(customerId)); }
  const rows = await safeRows(
    `SELECT COALESCE(NULLIF(place_of_supply,''),'Unknown') AS name,
            SUM(total) AS amount
       FROM invoices
      WHERE user_id = ? AND org_id = ?
        AND date >= ? AND date <= ?
        AND status NOT IN ('void','draft')${custClause}
      GROUP BY name
      ORDER BY amount DESC`,
    params
  );
  const mapped = rows.map((r) => ({ name: r.name, amount: Number(r.amount) || 0 }));
  if (mapped.length <= topN) return mapped;
  const top = mapped.slice(0, topN);
  const other = mapped.slice(topN).reduce((s, r) => s + r.amount, 0);
  if (other) top.push({ name: 'Other', amount: round2(other) });
  return top;
}

// Distinct customers who invoiced in [from, to]. Identifies a customer by
// zoho_customer_id, falling back to customer_name when the synced invoices
// carry no contact id (some orgs — and every QuickBooks row — sync names only).
async function activeCustomerIds(effUserId, orgId, from, to) {
  const rows = await safeRows(
    `SELECT DISTINCT COALESCE(NULLIF(zoho_customer_id,''), NULLIF(customer_name,'')) AS id
       FROM invoices
      WHERE user_id = ? AND org_id = ?
        AND date >= ? AND date <= ?
        AND status NOT IN ('void','draft')
        AND COALESCE(NULLIF(zoho_customer_id,''), NULLIF(customer_name,'')) IS NOT NULL`,
    [effUserId, orgId, from, to]
  );
  return new Set(rows.map((r) => String(r.id)));
}

// Logo churn from two already-resolved customer-id sets.
function churnFromSets(priorSet, currSet) {
  let churned = 0;
  for (const id of priorSet) if (!currSet.has(id)) churned++;
  const priorCount = priorSet.size;
  return {
    priorCount,
    activeCount: currSet.size,
    churned,
    retained: priorCount - churned,
    churnRate: priorCount > 0 ? round2((churned / priorCount) * 100) : null,
  };
}

// Logo churn: distinct customers who invoiced in the prior comparable period but
// not in the current period, as a % of prior-period active customers.
async function customerChurn(effUserId, orgId, from, to) {
  const pp = priorPeriod({ from, to });
  const priorSet = await activeCustomerIds(effUserId, orgId, pp.from, pp.to);
  const currSet  = await activeCustomerIds(effUserId, orgId, from, to);
  return churnFromSets(priorSet, currSet);
}

// ── Orchestrators ─────────────────────────────────────────────────────────────
// ctx = { provider, adapter, conn } from resolveProvider.
// params = report params already built by the route (from/to + basis + customer/currency).

function baseMeta(ctx, params, source) {
  return {
    provider: ctx.provider,
    basis: params.cash_based ? 'cash' : 'accrual',
    orgId: ctx.conn.connectionRef,
    currency: ctx.conn.currency,
    source,
    from: params.from,
    to: params.to,
    warnings: [],
  };
}

// ── LOCAL P&L derivation (NO live provider API) ───────────────────────────────
// Sources P&L figures from the SYNCED local tables so the metrics tabs need no
// live report fetch. Zoho: account_transactions general ledger. Xero/QBO:
// invoices (revenue) + bills + expense_entries (expenses). Returns the same
// shape as derivePL().
async function sumOne(sql, params) {
  const rows = await safeRows(sql, params);
  return Number(rows[0] && rows[0].v) || 0;
}

async function localPL(provider, effUserId, connRef, from, to) {
  if (provider === 'zoho') {
    // Use the CANONICAL P&L calculation (computePLFigures) so metrics match the
    // P&L Report byte-for-byte. This function calculates:
    //   income  → net = credit − debit (revenue is credit-normal)
    //   expense → net = debit − credit (expenses are debit-normal)
    // The old approach summed only gross credits/debits which overstated
    // revenue/expenses when accounts had opposite-side postings (refunds, etc).
    try {
      const { computePLFigures, extractPLLineItems } = require('./zohoLedgerReportsService');
      // Depreciation/Interest/Tax are leaf-account line items, not part of
      // computePLFigures's bucket totals — extractPLLineItems reads them from
      // the SAME aggregatePL buckets (never drifts from the P&L Report), and
      // is what feeds EBITDA (Operating Profit + Depreciation) below via
      // getProfitabilityMetrics. Previously hardcoded to 0 here, which made
      // EBITDA silently collapse to Operating Profit for every Zoho client.
      const [figures, pli] = await Promise.all([
        computePLFigures(effUserId, connRef, null, from, to),
        extractPLLineItems(effUserId, connRef, from, to),
      ]);
      return {
        provider,
        revenue: figures.revenue,
        otherIncome: figures.otherIncome,
        cogs: figures.cogs,
        grossProfit: figures.grossProfit,
        opex: figures.opex,
        operatingProfit: figures.operatingProfit,
        otherExpense: figures.otherExpense,
        interest: pli.interestExpense,
        tax: pli.incomeTax,
        depreciation: pli.depreciation,
        netProfit: figures.netProfit,
      };
    } catch (_) {
      // Fallback: if computePLFigures fails (e.g. no org_id), use legacy gross sums
      const base = [effUserId, connRef, from, to];
      const rev = await sumOne(
        `SELECT COALESCE(SUM(COALESCE(base_credit, credit)),0) v FROM account_transactions
          WHERE user_id=? AND org_id=? AND account_group='income' AND COALESCE(base_credit, credit) > 0
            AND (account_type_code IS NULL OR account_type_code <> 'other_income')
            AND transaction_date BETWEEN ? AND ?`, base);
      const otherIncome = await sumOne(
        `SELECT COALESCE(SUM(COALESCE(base_credit, credit)),0) v FROM account_transactions
          WHERE user_id=? AND org_id=? AND account_group='income' AND COALESCE(base_credit, credit) > 0
            AND account_type_code = 'other_income'
            AND transaction_date BETWEEN ? AND ?`, base);
      const exp = await sumOne(
        `SELECT COALESCE(SUM(COALESCE(base_debit, debit)),0) v FROM account_transactions
          WHERE user_id=? AND org_id=? AND account_group='expense' AND COALESCE(base_debit, debit) > 0
            AND transaction_date BETWEEN ? AND ?`, base);
      const expLike = `SELECT COALESCE(SUM(COALESCE(base_debit, debit)),0) v FROM account_transactions
          WHERE user_id=? AND org_id=? AND account_group='expense' AND COALESCE(base_debit, debit) > 0
            AND transaction_date BETWEEN ? AND ? AND LOWER(account_name) REGEXP ?`;
      const cogs         = await sumOne(expLike, [...base, 'cost of goods|cogs|cost of sales']);
      const depreciation = await sumOne(expLike, [...base, 'deprecia|amorti']);
      const interest     = await sumOne(expLike, [...base, 'interest']);
      const tax          = await sumOne(expLike, [...base, 'income tax']);
      const opex = exp - cogs - interest - tax;
      const grossProfit = rev - cogs;
      const operatingProfit = grossProfit - opex;
      return { provider, revenue: rev, otherIncome, cogs, grossProfit, opex,
               operatingProfit, otherExpense: 0, interest, tax, depreciation, netProfit: rev + otherIncome - exp };
    }
  }
  // xero / quickbooks — synced invoices + bills + expense_entries
  const idcol = provider === 'xero' ? 'xero_id' : 'qbo_id';
  const rev  = await sumOne(`SELECT COALESCE(SUM(total),0) v FROM invoices WHERE user_id=? AND ${idcol} IS NOT NULL AND date BETWEEN ? AND ?`, [effUserId, from, to]);
  const bill = await sumOne(`SELECT COALESCE(SUM(total),0) v FROM bills WHERE user_id=? AND ${idcol} IS NOT NULL AND date BETWEEN ? AND ?`, [effUserId, from, to]);
  const eent = await sumOne(`SELECT COALESCE(SUM(amount),0) v FROM expense_entries WHERE user_id=? AND ${idcol} IS NOT NULL AND expense_date BETWEEN ? AND ?`, [effUserId, from, to]);
  const exp = bill + eent;
  return { provider, revenue: rev, otherIncome: 0, cogs: 0, grossProfit: rev, opex: exp,
           operatingProfit: rev - exp, otherExpense: 0, interest: 0, tax: 0, depreciation: 0, netProfit: rev - exp };
}

// P&L figures for the revenue / profitability metrics. QuickBooks uses its OWN
// ProfitAndLoss report (via quickbooksReportsService + derivePL) so the metrics
// tie out to QuickBooks EXACTLY — matching the dashboard cards — scoped to the
// SAME from/to the caller (dashboard date picker) requested, exactly like Zoho/
// Xero. Falls back to localPL if the QB report is unavailable, so the metrics
// never break. Returns the same shape as localPL/derivePL.
async function providerPL(ctx, from, to, params = {}) {
  console.log(`providerPL(${ctx.provider}, ${from} → ${to})`);
  const { provider, conn } = ctx;
  if (provider === 'quickbooks' || provider === 'xero') {
    // QuickBooks AND Xero P&L come from our OWN synced general ledger
    // (account_transactions, scoped by org_id = realm_id / tenant_id) via the
    // provider-agnostic Zoho builder — NO live provider /Reports call. derivePL
    // parses the Zoho section labels the builder emits.
    try {
      const ledgerReports = require('./zohoLedgerReportsService');
      const rep = await ledgerReports.buildProfitAndLoss(conn.effectiveUserId,
        { from_date: from, to_date: to, org_id: conn.connectionRef, platform: provider,
          accounting_basis: params.accounting_basis });
      if (rep && !rep._noLocalData) {
        const derived = derivePL(rep.rows, provider);
        // If the GL builder returned all zeros (e.g. Xero with no account_transactions
        // data under this org_id), fall through to localPL which queries invoices/bills.
        if (derived.revenue > 0 || derived.cogs > 0 || derived.opex > 0) return derived;
      }
    } catch (_) { /* fall back to the local derivation below */ }
  }
  return localPL(provider, conn.effectiveUserId, conn.connectionRef, from, to);
}

// Balance Sheet totals (Total Assets / Total Liabilities / Equity) as of a
// point in time, from each provider's OWN Balance Sheet report. Zoho already
// gets this from the local GL (account_transactions latest-balance-per-account
// — see dashboard.js's /liquidity, /efficiency). QuickBooks and Xero write no
// such ledger in this deployment, so leverage/equity ratios (Debt/Equity, ROE,
// Interest Coverage's EBIT, Equity Multiplier) would otherwise always be null.
// Trusts the report's own "Total Assets"/"Total Liabilities"/"Total Equity"
// summary rows (ties out exactly to what the provider itself shows) instead of
// re-deriving by walking/classifying every leaf account. Returns null if the
// provider isn't quickbooks/xero, or the fetch fails.
// QB report emits "Total Assets"; the DB GL builder (Zoho/Xero) emits
// "Total for Assets" — accept both.
const RE_TOTAL_ASSETS = /^total (for )?assets$/;
const RE_TOTAL_LIAB   = /^total (for )?liabilities$/;
const RE_TOTAL_EQUITY = /^total (for )?equity$/;
async function providerBalanceSheetTotals(ctx, to) {
  const { provider, conn } = ctx;
  if (provider !== 'quickbooks' && provider !== 'xero') return null;
  try {
    // QuickBooks AND Xero balance sheet come from our OWN synced general ledger
    // (scoped by org_id = realm_id / tenant_id) via the provider-agnostic Zoho GL
    // builder — NO live provider /Reports call.
    const rep = await require('./zohoGlReportsService').buildBalanceSheet(
      conn.effectiveUserId, { to_date: to, from_date: to, org_id: conn.connectionRef, platform: provider });
    if (!rep || rep._noLocalData) return null;
    const pick = (re) => {
      for (const r of rep.rows || []) {
        if ((r.isSubtotal || r.isTotal) && re.test(norm(r.label))) return Number(rowAmount(r)) || 0;
      }
      return null;
    };
    const totalAssets = pick(RE_TOTAL_ASSETS);
    const totalLiabilities = pick(RE_TOTAL_LIAB);
    if (totalAssets == null && totalLiabilities == null) return null;
    let equity = pick(RE_TOTAL_EQUITY);
    if (equity == null) equity = (totalAssets || 0) - (totalLiabilities || 0);
    return { totalAssets: totalAssets || 0, totalLiabilities: totalLiabilities || 0, equity, provider };
  } catch (_) {
    return null;
  }
}

// ── LOCAL cash-flow derivation (indirect method; NO live provider API) ────────
// Zoho: derived from the synced `account_transactions` general ledger. OCF via
// the indirect method — Net Income + non-cash add-backs (depreciation) + changes
// in working capital — and CapEx from gross fixed-asset purchases (excluding the
// "Accumulated Depreciation" contra-asset accounts). Verified against the live
// data: OCF − CapEx ties out to the bank ledger's net cash movement.
//
// Sign conventions (double-entry): an ASSET increase is a net debit and USES
// cash (−); a LIABILITY increase is a net credit and FREES cash (+).
//
// Zoho and Xero both have a synced general ledger (account_transactions), so the
// indirect method works for both. QuickBooks has no local GL here (its P&L comes
// from invoices/bills tables), so there are no OCF/CapEx figures to derive →
// null, and the caller keeps the existing bank inflow/outflow fallback.
async function localCashFlow(provider, effUserId, connRef, from, to) {
  // Zoho, Xero AND QuickBooks all have a synced general ledger in
  // account_transactions (scoped by org_id), so the indirect method works for
  // all three.
  if (provider !== 'zoho' && provider !== 'xero' && provider !== 'quickbooks') return null;
  const base = [effUserId, connRef, from, to];

  // Net income = income (credit − debit) − expense (debit − credit). Xero's
  // true-up plugs are excluded, as in every other P&L figure: they force each
  // account's CUMULATIVE balance to Xero's trial balance and are all dated the
  // last ledger day, so inside a period they load prior years onto it.
  const income = await sumOne(
    `SELECT COALESCE(SUM(COALESCE(base_credit, credit)) - SUM(COALESCE(base_debit, debit)),0) v FROM account_transactions
      WHERE user_id=? AND org_id=? AND account_group='income'
        AND transaction_id NOT LIKE 'xero-recon:%'
        AND transaction_date BETWEEN ? AND ?`, base);
  const expense = await sumOne(
    `SELECT COALESCE(SUM(COALESCE(base_debit, debit)) - SUM(COALESCE(base_credit, credit)),0) v FROM account_transactions
      WHERE user_id=? AND org_id=? AND account_group='expense'
        AND transaction_id NOT LIKE 'xero-recon:%'
        AND transaction_date BETWEEN ? AND ?`, base);
  const netIncome = income - expense;

  // Non-cash add-back: depreciation / amortization (a subset of expense).
  const depreciation = await sumOne(
    `SELECT COALESCE(SUM(COALESCE(base_debit, debit)) - SUM(COALESCE(base_credit, credit)),0) v FROM account_transactions
      WHERE user_id=? AND org_id=? AND account_group='expense'
        AND LOWER(account_name) REGEXP 'deprecia|amorti'
        AND transaction_id NOT LIKE 'xero-recon:%'
        AND transaction_date BETWEEN ? AND ?`, base);

  // Working-capital movement over the period. Asset increase uses cash (−);
  // liability increase frees cash (+).
  const assetChange = await sumOne(
    `SELECT COALESCE(SUM(COALESCE(base_debit, debit)) - SUM(COALESCE(base_credit, credit)),0) v FROM account_transactions
      WHERE user_id=? AND org_id=?
        AND account_type_code IN ('accounts_receivable','other_current_asset','other_asset')
        AND transaction_date BETWEEN ? AND ?`, base);
  const liabChange = await sumOne(
    `SELECT COALESCE(SUM(COALESCE(base_credit, credit)) - SUM(COALESCE(base_debit, debit)),0) v FROM account_transactions
      WHERE user_id=? AND org_id=?
        AND account_type_code IN ('accounts_payable','other_current_liability')
        AND transaction_date BETWEEN ? AND ?`, base);

  const operating = netIncome + depreciation - assetChange + liabChange;

  // CapEx = gross fixed-asset purchases (net debit), EXCLUDING the accumulated-
  // depreciation contra-asset accounts. Clamp at 0 so a period of net disposals
  // doesn't invert Free Cash Flow.
  const capexRaw = await sumOne(
    `SELECT COALESCE(SUM(COALESCE(base_debit, debit)) - SUM(COALESCE(base_credit, credit)),0) v FROM account_transactions
      WHERE user_id=? AND org_id=? AND account_type_code='fixed_asset'
        AND LOWER(account_name) NOT REGEXP 'accumulated deprecia'
        AND transaction_date BETWEEN ? AND ?`, base);
  const capex = Math.max(0, capexRaw);

  return {
    provider,
    operating: round2(operating),
    investing: round2(-capex), // only CapEx is identifiable from the GL
    financing: null,           // no reliable financing flag in the ledger
    capex: round2(capex),
  };
}

// Resolve provider + connection from LOCAL token/org tables only — no token
// refresh, no live API. Mirrors the dashboard's detection order (Zoho→QBO→Xero).
async function resolveLocalCtx(userId) {
  const { getEffectiveZohoUserId } = require('./zohoService');
  const { getEffectiveQBUserId } = require('./quickbooksService');
  const { getEffectiveXeroUserId } = require('./xeroService');
  try {
    const { tokens, orgs } = await zohoConnTables();
    if (tokens) {
      // getEffectiveZohoUserId maps a client user → the admin that owns the
      // tokens (new schema). If it throws (e.g. it queries zb_tokens on an older
      // DB), fall back to the raw userId — every connected user has its own row.
      let uid = userId;
      try { uid = await getEffectiveZohoUserId(userId); } catch (_) { uid = userId; }
      let [t] = await pool.execute(`SELECT org_id FROM \`${tokens}\` WHERE user_id=? AND org_id IS NOT NULL LIMIT 1`, [uid]);
      if ((!t[0] || !t[0].org_id) && uid !== userId) {
        [t] = await pool.execute(`SELECT org_id FROM \`${tokens}\` WHERE user_id=? AND org_id IS NOT NULL LIMIT 1`, [userId]);
        if (t[0] && t[0].org_id) uid = userId;
      }
      if (t[0] && t[0].org_id) {
        let currency = 'INR';
        if (orgs) {
          const [o] = await pool.execute(`SELECT currency FROM \`${orgs}\` WHERE user_id=? AND org_id=? LIMIT 1`, [uid, t[0].org_id]);
          if (o[0] && o[0].currency) currency = o[0].currency;
        }
        return { provider: 'zoho', conn: { effectiveUserId: uid, connectionRef: t[0].org_id, currency } };
      }
    }
  } catch (_) { /* try next */ }
  try {
    const uid = await getEffectiveQBUserId(userId);
    const [t] = await pool.execute('SELECT realm_id FROM qbo_tokens WHERE user_id=? LIMIT 1', [uid]);
    if (t[0] && t[0].realm_id) {
      let currency = 'USD';
      const [o] = await pool.execute("SELECT currency FROM qbo_organizations WHERE user_id=? AND currency REGEXP '^[A-Z]{3}$' LIMIT 1", [uid]);
      if (o[0] && o[0].currency) currency = o[0].currency;
      return { provider: 'quickbooks', conn: { effectiveUserId: uid, connectionRef: t[0].realm_id, currency } };
    }
  } catch (_) { /* try next */ }
  try {
    const uid = await getEffectiveXeroUserId(userId);
    const [t] = await pool.execute('SELECT tenant_id FROM xero_tokens WHERE user_id=? LIMIT 1', [uid]);
    if (t[0] && t[0].tenant_id) {
      let currency = 'USD';
      const [o] = await pool.execute('SELECT currency FROM xero_organizations WHERE user_id=? AND tenant_id=? LIMIT 1', [uid, t[0].tenant_id]);
      if (o[0] && o[0].currency) currency = o[0].currency;
      return { provider: 'xero', conn: { effectiveUserId: uid, connectionRef: t[0].tenant_id, currency } };
    }
  } catch (_) { /* none */ }
  return null;
}

async function getRevenueMetrics(ctx, params, opts = {}) {
  const { conn, provider } = ctx;
  const meta = baseMeta(ctx, params, 'local');

  const pl = await providerPL(ctx, params.from, params.to, params);

  // Prior-period revenue for growth (same window length, shifted back) —
  // same selected period for every provider, including QuickBooks.
  let priorRevenue = null;
  try {
    const pp = priorPeriod({ from: params.from, to: params.to });
    priorRevenue = (await providerPL(ctx, pp.from, pp.to, params)).revenue;
  } catch (_) { /* growth stays null */ }

  // Breakdowns. Logo churn works off the shared `invoices` table (customer_name
  // + org_id), which Zoho, QuickBooks AND Xero all populate, so it's computed
  // for all three. Product/Geography/Recurring need data neither QuickBooks nor
  // Xero sync (line items, place-of-supply, recurring-invoice linkage), so
  // those stay Zoho-only, with an honest reason recorded for the other two.
  let byProduct = [], byGeography = [];
  let recurring = { recurring: 0, oneTime: 0, total: 0, recurringPct: null };
  const churn = await customerChurn(conn.effectiveUserId, conn.connectionRef, params.from, params.to);
  if (provider === 'zoho') {
    byProduct   = await revenueByProduct(conn.effectiveUserId, conn.connectionRef, params.from, params.to, params.customer_id);
    byGeography = await revenueByGeography(conn.effectiveUserId, conn.connectionRef, params.from, params.to, params.customer_id);
    recurring   = await recurringSplit(conn.effectiveUserId, conn.connectionRef, params.from, params.to, params.customer_id);
  } else if (provider === 'quickbooks' || provider === 'xero') {
    const label = provider === 'quickbooks' ? 'QuickBooks' : 'Xero';
    // Recurring vs one-time: neither provider's synced invoices carry a
    // recurring-invoice linkage (Zoho-only field) — every invoice reads as
    // one-time. Still reports the real revenue total for the period (not
    // zero); it's the recurring/one-time SPLIT that's unknown, not the
    // revenue itself.
    recurring = await recurringSplit(conn.effectiveUserId, conn.connectionRef, params.from, params.to, null);
    meta.warnings.push(`${label} does not sync recurring-invoice linkage; the recurring split reflects 0 invoices flagged recurring, not a confirmed 0% recurring-revenue business.`);
    // recurring.total is summed from synced INVOICE records only, unlike the
    // headline `revenue` above (which now comes from ${label}'s own P&L report
    // and can include income never invoiced through this sync — journals,
    // other income, etc.) — the two totals are expected to differ.
    if (recurring.total !== pl.revenue) {
      meta.warnings.push(`The recurring split total (from synced invoices) may differ from the headline revenue above (from ${label}'s own P&L report) — they are sourced differently.`);
    }

    // Revenue by Product/Service and by Geography need data this deployment
    // doesn't sync for this provider (no line-item warehouse; no place-of-
    // supply field on the invoice) — reported empty with an explicit reason
    // instead of a silently-empty array that reads as "no product/geography
    // sales".
    meta.warnings.push(`Revenue by Product/Service is not available for ${label} (no synced line-item data).`);
    meta.warnings.push(`Revenue by Geography is not available for ${label} (invoices carry no place-of-supply/region field).`);
  }

  return {
    revenue: pl.revenue,
    otherIncome: pl.otherIncome,
    growth: growth(pl.revenue, priorRevenue),
    byProduct,
    byGeography,
    recurring,
    churn,
    currency: conn.currency,
    _meta: meta,
  };
}

async function getProfitabilityMetrics(ctx, params, opts = {}) {
  const { conn, provider } = ctx;
  const meta = baseMeta(ctx, params, 'local');

  const pl = await providerPL(ctx, params.from, params.to, params);
  const m = margins(pl);
  const eb = deriveEbitda(pl);
  if (eb.daSource === 'fallback') meta.warnings.push('Depreciation/amortization not found in local ledger; EBITDA equals operating profit.');

  return {
    revenue: pl.revenue,
    cogs: pl.cogs,
    grossProfit: pl.grossProfit,
    grossMargin: m.grossMargin,
    opex: pl.opex,
    operatingProfit: pl.operatingProfit,
    operatingMargin: m.operatingMargin,
    otherIncome: pl.otherIncome,
    interest: pl.interest,
    tax: pl.tax,
    depreciation: pl.depreciation,
    ebitda: eb.ebitda,
    ebitdaMargin: eb.ebitdaMargin,
    netProfit: pl.netProfit,
    netMargin: m.netMargin,
    currency: conn.currency,
    _meta: meta,
  };
}

// Gross cash inflow/outflow proxy for QuickBooks, scoped to the SAME selected
// period as everything else. QB has no synced bank ledger, and its own
// CashFlow report uses the INDIRECT method — Net Income plus balance-sheet-
// change adjustments (e.g. "Accounts Payable: +1,602.67" means AP grew, freeing
// cash; it is NOT a customer payment). Summing those adjustment rows would
// mislabel indirect-method noise as real cash movements, so instead this reuses
// the same direct-method proxy already used elsewhere on the dashboard for QB:
// inflow = customer payments collected (invoices total − balance) in the
// period, outflow = expense_entries paid in the period.
async function qboInvoiceExpenseFlows(effUserId, from, to) {
  const inflow  = await sumOne(
    `SELECT COALESCE(SUM(total - balance),0) v FROM invoices
      WHERE user_id=? AND qbo_id IS NOT NULL AND date BETWEEN ? AND ?`, [effUserId, from, to]);
  const outflow = await sumOne(
    `SELECT COALESCE(SUM(amount),0) v FROM expense_entries
      WHERE user_id=? AND qbo_id IS NOT NULL AND expense_date BETWEEN ? AND ?`, [effUserId, from, to]);
  return { inflow, outflow, net: inflow - outflow };
}

async function getCashflowMetrics(ctx, params, opts = {}) {
  // Lazy require — keyRatiosService.js itself requires this file (for
  // margins/deriveEbitda), so a top-level require here would be a circular
  // import resolved before this file finishes exporting, leaving
  // computeCashFlowMetrics undefined. Requiring inside the function (same
  // pattern already used in resolveLocalCtx above) defers it until after
  // both modules have fully loaded.
  const { computeCashFlowMetrics } = require('./keyRatiosService');
  const { conn, provider } = ctx;
  const meta = baseMeta(ctx, params, 'local');

  // inflow/outflow: Zoho/Xero from the synced bank ledger; QuickBooks from the
  // invoice/expense proxy (see qboInvoiceExpenseFlows) since it has neither a
  // bank ledger nor a direct-method report to derive gross cash movement from.
  const flows = provider === 'quickbooks'
    ? await qboInvoiceExpenseFlows(conn.effectiveUserId, params.from, params.to)
    : await bankFlows(conn.effectiveUserId, conn.connectionRef, params.from, params.to);

  // Operating CF / CapEx / Free CF / Net Change: the SAME simplified indirect
  // method the Ratios page's Cash Flow Ratio uses
  // (keyRatiosService.deriveCashFlowMetrics — Net Profit + Depreciation −
  // Change in Working Capital; CapEx = movement in Gross Fixed Assets; Net
  // Change = Cash & Bank this period-end minus at the period's start,
  // computed directly rather than derived) — so this card and the Ratios
  // page can never show two different numbers for the same period. This is
  // NOT the full Cash Flow Statement report, which keeps its own granular,
  // per-account reconstruction (zohoLedgerReportsService.aggregateIndirectCashFlow) —
  // deliberately coarser, matching the reference ratio methodology's own
  // "indirect estimate" framing.
  let cf = null;
  try {
    cf = await computeCashFlowMetrics(conn.effectiveUserId, conn.connectionRef, provider, params.from, params.to);
  } catch (_) { cf = null; }

  const inflow = flows.inflow, outflow = flows.outflow;

  if (!cf || !cf.hasOpeningPeriodData) {
    // No prior-period balance to diff against (brand-new client) → bank
    // inflow/outflow only, same fallback shape as before.
    meta.source = 'local';
    meta.warnings.push(cf
      ? 'No prior-period balance to compare against yet; showing bank inflow/outflow only.'
      : `Cash flow figures unavailable for ${provider}; showing bank inflow/outflow only.`);
    return {
      operatingCashFlow: null,
      investingCashFlow: null,
      financingCashFlow: null,
      netChange: flows.net,
      capex: null,
      freeCashFlow: null,
      inflow,
      outflow,
      net: flows.net,
      currency: conn.currency,
      _meta: meta,
    };
  }

  return {
    operatingCashFlow: cf.operatingCashFlow,
    investingCashFlow: null,
    financingCashFlow: null,
    netChange: cf.netChange,
    capex: cf.capex,
    freeCashFlow: cf.freeCashFlow,
    inflow,
    outflow,
    net: cf.netChange,
    currency: conn.currency,
    _meta: meta,
  };
}

module.exports = {
  resolveLocalCtx,
  localPL,
  rowAmount,
  derivePL,
  providerBalanceSheetTotals,
  deriveEbitda,
  margins,
  priorPeriod,
  growth,
  deriveCashFlow,
  localCashFlow,
  bankFlows,
  revenueByProduct,
  revenueByGeography,
  customerChurn,
  recurringSplit,
  getRevenueMetrics,
  getProfitabilityMetrics,
  getCashflowMetrics,
};
