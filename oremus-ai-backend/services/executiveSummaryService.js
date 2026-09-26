'use strict';

/**
 * Executive Summary report — modelled on Xero's Executive Summary.
 * ---------------------------------------------------------------------------
 * Computed entirely from the synced ledger already in our database
 * (`account_transactions` = full general ledger, `bank_transactions` = cash
 * movements, `zb_invoices` = sales) so it never spends Zoho's daily API quota.
 *
 * Lays out the same six sections Xero uses, with a current period, an equal
 * length prior (comparison) period, and a Variance column:
 *   Cash · Profitability · Balance Sheet · Sales · Performance · Position
 *
 * Returns the canonical { columns, rows, currency, meta } shape the report
 * viewer already renders. Money rows are emitted as numbers (the table formats
 * them as currency); %, day and ratio rows are emitted as pre-formatted
 * strings; empty/zero cells render as "-" exactly like Xero.
 *
 * Sign conventions (verified against the live data):
 *  - account_transactions: income = credit−debit, expense/asset = debit−credit,
 *    liability/equity = credit−debit (normal balances come out positive).
 *  - bank_transactions: debit = money IN, credit = money OUT; transfer_fund
 *    rows move cash between the org's own accounts and are excluded.
 */

const pool = require('../config/db');
// One shared base-currency resolver for every report — its own lookup here read
// only the Zoho org tables, so a QuickBooks/Xero org silently printed rupees.
const { getBaseCurrency } = require('./zohoChartOfAccountsService');

// Xero Trial-Balance true-up rows (transaction_id 'xero-recon:%') are a
// CUMULATIVE balance-sheet plug: they force each account's running balance to
// match Xero's TB as of the sync (dated the last txn date, e.g. 31-Mar), so
// they belong in AS-OF BALANCE figures (closing bank, debtors, net assets) but
// are NOT real period activity. Every PERIOD/FLOW query below therefore excludes
// them — mirroring the same guard aggregatePL uses — while asOfBalances keeps
// them. Harmless no-op for Zoho/QuickBooks (they have zero xero-recon rows).
const EXCLUDE_RECON = "AND transaction_id NOT LIKE 'xero-recon:%'";
// A control account (e.g. "TDS Control Account") is not real cash and not a real
// bank — one platform's sync mis-types it `bank`, another `other_current_asset`
// — so it's kept out of Cash Received/Spent here. (asOfBalances no longer uses
// this constant: it needs the control account IN Net Assets to tie to the
// Balance Sheet, and routes it to a `tds_control` pseudo-code so it still stays
// out of the bank total there.) Dummy / Suspense are never real balances.
const EXCLUDE_NON_BANK =
  "AND account_name NOT LIKE '%TDS Control%'"
  + " AND account_name NOT LIKE '%Dummy%'"
  + " AND account_name NOT LIKE '%Suspense%'";
// "Xero Payments Clearing" (typeCode 'bank') is an internal transit account: an
// invoice debits it, the matching /Payments credits it into the real bank, so it
// nets to zero. Its lines are plumbing, not cash movement — counting them would
// double the Cash received / spent figures. Excluded everywhere the Executive
// Summary aggregates bank/cash, mirroring the Balance Sheet which drops it too.
const EXCLUDE_CLEARING =
  "AND account_id <> 'XERO-CLEARING' AND account_name NOT LIKE '%Xero Payments Clearing%'";
// A stray adjusting JV that nets to zero — e.g. a "Reimbursement" JV cancelled
// the next day by a "Rectification entry" (Dr Employee Reimbursements / Cr Axis
// Bank 10,00,000, then the reverse) — is NOT real cash received or spent, and
// only one platform's books tends to carry it. Drop a bank/cash JOURNAL line
// (Zoho 'journal', Xero 'ManualJournal', QuickBooks 'Journal Entry') when its
// narration/ref is explicitly a "Rectification entry" / "reversal entry" /
// "correction entry", OR the narration is the bare word "Reimbursement" (real
// employee reimbursements read "Employee Reimbursements: <name>" or "Being
// <name> reimbursement …", never the bare word). Cheap (no sub-query) and
// specific — a genuine one-directional payment is never touched. asOfBalances
// does not use this.
const EXCLUDE_ADJUSTMENTS = `
  AND NOT (
    (LOWER(transaction_type) LIKE '%journal%' OR LOWER(source_type) LIKE '%journal%')
    AND (
         COALESCE(transaction_details, '') REGEXP 'rectif|reversal entry|correction entry'
      OR COALESCE(reference_number, '')    REGEXP 'rectif|reversal entry|correction entry'
      OR LOWER(TRIM(COALESCE(transaction_details, ''))) = 'reimbursement'
    )
  )`;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function resolveOrgId(userId, params) {
  if (params.org_id) return params.org_id;
  // Check all three platform token tables — Zoho, Xero, QuickBooks.
  const [[zb]] = await pool.execute(
    'SELECT org_id FROM zb_tokens WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1',
    [userId]
  );
  if (zb?.org_id) return zb.org_id;
  const [[xero]] = await pool.execute(
    'SELECT tenant_id AS org_id FROM xero_tokens WHERE user_id = ? AND tenant_id IS NOT NULL LIMIT 1',
    [userId]
  );
  if (xero?.org_id) return xero.org_id;
  const [[qbo]] = await pool.execute(
    'SELECT realm_id AS org_id FROM qbo_tokens WHERE user_id = ? AND realm_id IS NOT NULL LIMIT 1',
    [userId]
  );
  return qbo?.org_id || null;
}

function requireOrg(orgId) {
  if (!orgId) {
    const err = new Error('Provider not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
}

// Period window: default to the current Indian fiscal year (Apr–Mar) when the
// caller sends no dates, mirroring the other ledger reports.
function resolveRange(params) {
  const to = params.to_date || params.date_end || null;
  const from = params.from_date || params.date_start || null;
  if (from && to) return { from, to };
  // Default window: the fiscal year containing today, for the per-platform
  // start month (Settings → params.fy_start_month; defaults to 4 = 1 April).
  const { fyWindow, fyMonth } = require('./reportContext');
  const _fy = fyWindow(fyMonth(params.fy_start_month));
  return { from: from || _fy.from, to: to || _fy.to };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthYear(iso) {
  if (!iso) return '';
  const [y, m] = iso.split('-').map(Number);
  return `${MONTHS[(m || 1) - 1]} ${y}`;
}
// Column header for a period: the full range "MMM YYYY-MMM YYYY" (matching
// Xero's "Jul 2020-Jul 2026"), collapsing to a single "MMM YYYY" when the
// window starts and ends in the same month. The values under the column are
// the totals over the whole [from,to] window (flow rows) / the as-of balance
// at `to` (balance rows) — the range label just makes that span explicit.
function periodLabel(from, to) {
  const a = monthYear(from);
  const b = monthYear(to);
  return a === b ? b : `${a}-${b}`;
}
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000) + 1; // inclusive
}
// Equal-length window immediately before [from, to].
function priorWindow(from, to) {
  const len = daysBetween(from, to);
  const cmpTo = addDays(from, -1);
  const cmpFrom = addDays(cmpTo, -(len - 1));
  return { from: cmpFrom, to: cmpTo };
}

// ── Per-period flow + as-of metric collectors ───────────────────────────────

// Income / expense activity over a window.
async function periodPL(userId, orgId, from, to) {
  const [rows] = await pool.execute(
    `SELECT account_type_code AS code,
            SUM(COALESCE(base_debit, debit))  AS d,
            SUM(COALESCE(base_credit, credit)) AS c
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND transaction_date BETWEEN ? AND ?
        AND account_group IN ('income', 'expense')
        ${EXCLUDE_RECON}
      GROUP BY account_type_code`,
    [userId, orgId, from, to]
  );
  const byCode = {};
  for (const r of rows) byCode[r.code] = { d: num(r.d), c: num(r.c) };
  const credit = (code) => (byCode[code] ? byCode[code].c - byCode[code].d : 0);
  const debit  = (code) => (byCode[code] ? byCode[code].d - byCode[code].c : 0);

  const income = credit('income');
  const otherIncome = credit('other_income');
  const cogs = debit('cost_of_goods_sold');
  const expense = debit('expense');
  const otherExpense = debit('other_expense');
  const totalExpenses = expense + otherExpense;
  const grossProfit = income - cogs;
  const netProfit = grossProfit + otherIncome - totalExpenses;
  return { income, otherIncome, cogs, expense, otherExpense, totalExpenses, grossProfit, netProfit };
}

// Cash received / spent over a window from the GL (account_transactions).
// Cash movements = debit/credit on the cash accounts (bank + cash + the Xero
// Payments Clearing account, which carries typeCode 'bank'). A debit to a cash
// account is money in (received); a credit is money out (spent). This mirrors
// Xero's cash-basis Executive Summary and works for all three platforms since
// every provider posts into this shared ledger.
async function periodCash(userId, orgId, from, to) {
  const [[r]] = await pool.execute(
    `SELECT COALESCE(SUM(COALESCE(base_debit, debit)), 0)  AS received,
            COALESCE(SUM(COALESCE(base_credit, credit)), 0) AS spent
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND transaction_date BETWEEN ? AND ?
        AND account_type_code IN ('bank', 'cash')
        ${EXCLUDE_RECON}
        ${EXCLUDE_NON_BANK}
        ${EXCLUDE_CLEARING}
        ${EXCLUDE_ADJUSTMENTS}`,
    [userId, orgId, from, to]
  );
  const received = num(r.received);
  const spent = num(r.spent);
  return { received, spent, surplus: received - spent };
}

// Drill-down breakdown: the individual GL lines that make up each period-flow
// metric, so a user can click a value and trace exactly how it was calculated.
// One query pulls every relevant line for the window; we bucket it in JS by the
// account type + posting side that defines each metric, mirroring the exact SQL
// the metric collectors use (received = cash debits, spent = cash credits,
// income = income credits, direct costs / expenses = their debits, invoices =
// receivable debits). Each bucket is sorted largest-first and capped so the
// payload stays small; the viewer shows "largest N of M" when truncated.
function fmtDate(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return d ? String(d).slice(0, 10) : '';
}

function summariseBucket(list) {
  const sorted = list.slice().sort((a, b) => b.amount - a.amount);
  return {
    rows: sorted,
    count: sorted.length,
    total: Math.round(sorted.reduce((s, e) => s + e.amount, 0) * 100) / 100,
  };
}

// One drill-down entry. `amount` is signed so the entries SUM to the figure they
// explain (an expense credit / income debit is negative); the rest is context
// for comparing line by line against the platform (original currency + rate).
const BD_COLS = `transaction_date AS dt, reference_number AS ref, account_name AS account,
            source_type AS src, transaction_type AS ttype, transaction_details AS details,
            account_type_code AS code, currency_code AS cur, exchange_rate AS rate,
            COALESCE(base_debit, debit) AS debit, COALESCE(base_credit, credit) AS credit,
            debit AS ndebit, credit AS ncredit`;
function bdEntry(l, amount, nativeAmount) {
  return {
    date: fmtDate(l.dt),
    ref: l.ref || '',
    account: l.account || '',
    source: l.src || '',
    type: l.ttype || '',
    name: String(l.details || '').trim(),
    currency: l.cur || '',
    rate: l.rate != null ? num(l.rate) : null,
    nativeAmount: Math.round(nativeAmount * 100) / 100,
    amount: Math.round(amount * 100) / 100,
  };
}

// Each bucket holds exactly the lines its headline sums, with the SAME filters
// (cash rows mirror periodCash, P&L rows mirror periodPL) and the same sign —
// so a breakdown's total always equals the number shown on the report.
async function periodBreakdowns(userId, orgId, from, to) {
  const [cash] = await pool.execute(
    `SELECT ${BD_COLS}
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND transaction_date BETWEEN ? AND ?
        AND account_type_code IN ('bank', 'cash')
        ${EXCLUDE_RECON}
        ${EXCLUDE_NON_BANK}
        ${EXCLUDE_CLEARING}
        ${EXCLUDE_ADJUSTMENTS}`,
    [userId, orgId, from, to]
  );
  const [pl] = await pool.execute(
    `SELECT ${BD_COLS}
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND transaction_date BETWEEN ? AND ?
        AND account_group IN ('income', 'expense')
        AND account_type_code IN ('income', 'other_income', 'cost_of_goods_sold', 'expense', 'other_expense')
        ${EXCLUDE_RECON}`,
    [userId, orgId, from, to]
  );
  const buckets = { received: [], spent: [], income: [], otherIncome: [], cogs: [], totalExpenses: [] };
  for (const l of cash) {
    // Received = Σ debits and Spent = Σ credits on cash accounts, negatives included.
    if (num(l.debit) !== 0) buckets.received.push(bdEntry(l, num(l.debit), num(l.ndebit)));
    if (num(l.credit) !== 0) buckets.spent.push(bdEntry(l, num(l.credit), num(l.ncredit)));
  }
  const BUCKET_OF = {
    income: ['income', 1], other_income: ['otherIncome', 1],
    cost_of_goods_sold: ['cogs', -1], expense: ['totalExpenses', -1], other_expense: ['totalExpenses', -1],
  };
  for (const l of pl) {
    const [key, sign] = BUCKET_OF[l.code];
    // Income is credit-normal (credit − debit), costs debit-normal (debit − credit).
    const amt = sign * (num(l.credit) - num(l.debit));
    if (amt === 0) continue;
    buckets[key].push(bdEntry(l, amt, sign * (num(l.ncredit) - num(l.ndebit))));
  }
  const out = {};
  for (const k of Object.keys(buckets)) out[k] = summariseBucket(buckets[k]);
  return out;
}

// Sales activity over a window from the GL. Counts distinct sales documents
// (invoices) posted to the ledger — one source document per issued invoice —
// and their average value from the receivable/income postings. Reading the GL
// (not the capped `invoices` warehouse table) makes the count complete and
// consistent with every other figure on this report, across all platforms.
// Each platform's own label for a SALES credit note (it reduces the value
// invoiced, so it is netted off the invoiced total below).
const SALES_CREDIT_TYPES = ['ACCRECCREDIT', 'credit_note', 'CreditMemo', 'Credit Memo'];

async function periodSales(userId, orgId, from, to) {
  // An invoice raise DEBITS accounts_receivable; payments and credit notes
  // CREDIT it. Filtering debit > 0 isolates invoice-raise lines regardless of
  // the platform's source_type label (zoho 'invoice' / QB 'Invoice' / xero
  // 'ACCREC'), and COUNT(DISTINCT source_id) collapses multi-line invoices.
  const [[c]] = await pool.execute(
    `SELECT COUNT(DISTINCT source_id) AS n
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND transaction_date BETWEEN ? AND ?
        AND account_type_code = 'accounts_receivable'
        AND debit > 0
        ${EXCLUDE_RECON}`,
    [userId, orgId, from, to]
  );
  // Value invoiced = the revenue those invoices RECOGNISED, i.e. excluding sales
  // tax (a liability, not sales). Reading the income side of each invoice
  // document gets that on every platform without parsing per-line tax.
  const [[v]] = await pool.execute(
    `SELECT COALESCE(SUM(COALESCE(i.base_credit, i.credit) - COALESCE(i.base_debit, i.debit)), 0) AS t
       FROM account_transactions i
      WHERE i.user_id = ? AND i.org_id = ?
        AND i.transaction_date BETWEEN ? AND ?
        AND i.account_group = 'income'
        AND i.transaction_id NOT LIKE 'xero-recon:%'
        AND i.transaction_id IN (
              SELECT ar.transaction_id FROM account_transactions ar
               WHERE ar.user_id = i.user_id AND ar.org_id = i.org_id
                 AND ar.transaction_date BETWEEN ? AND ?
                 AND ar.account_type_code = 'accounts_receivable'
                 AND ar.debit > 0)`,
    [userId, orgId, from, to, from, to]
  );
  // Credit notes raised in the window reduce what was invoiced. Their whole
  // receivable credit is netted off (not just an income line) because a credit
  // note need not touch a revenue account at all — a tax-withholding credit note
  // debits a TDS asset — yet it still cuts the value billed to the customer.
  const [[cn]] = await pool.execute(
    `SELECT COALESCE(SUM(COALESCE(base_credit, credit) - COALESCE(base_debit, debit)), 0) AS t
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND transaction_date BETWEEN ? AND ?
        AND account_type_code = 'accounts_receivable'
        AND source_type IN (${SALES_CREDIT_TYPES.map(() => '?').join(', ')})
        ${EXCLUDE_RECON}`,
    [userId, orgId, from, to, ...SALES_CREDIT_TYPES]
  );
  const count = num(c.n);
  const total = num(v.t) - num(cn.t);

  // Drill-down: the income lines of those invoices plus the credit notes
  // (negative) — same WHERE clauses as the totals above, so they sum to the
  // average's numerator; the average is that total ÷ `count` invoices.
  const [valueLines] = await pool.execute(
    `SELECT ${BD_COLS}
       FROM account_transactions i
      WHERE i.user_id = ? AND i.org_id = ?
        AND i.transaction_date BETWEEN ? AND ?
        AND i.account_group = 'income'
        AND i.transaction_id NOT LIKE 'xero-recon:%'
        AND i.transaction_id IN (
              SELECT ar.transaction_id FROM account_transactions ar
               WHERE ar.user_id = i.user_id AND ar.org_id = i.org_id
                 AND ar.transaction_date BETWEEN ? AND ?
                 AND ar.account_type_code = 'accounts_receivable'
                 AND ar.debit > 0)`,
    [userId, orgId, from, to, from, to]
  );
  const [cnLines] = await pool.execute(
    `SELECT ${BD_COLS}
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND transaction_date BETWEEN ? AND ?
        AND account_type_code = 'accounts_receivable'
        AND source_type IN (${SALES_CREDIT_TYPES.map(() => '?').join(', ')})
        ${EXCLUDE_RECON}`,
    [userId, orgId, from, to, ...SALES_CREDIT_TYPES]
  );
  const list = [];
  for (const l of valueLines) {
    const amt = num(l.credit) - num(l.debit);
    if (amt !== 0) list.push(bdEntry(l, amt, num(l.ncredit) - num(l.ndebit)));
  }
  for (const l of cnLines) {
    const amt = -(num(l.credit) - num(l.debit));
    if (amt !== 0) list.push(bdEntry(l, amt, -(num(l.ncredit) - num(l.ndebit))));
  }
  const breakdown = { ...summariseBucket(list), divisor: count, divisorLabel: 'invoices' };
  return { count, avg: count ? total / count : 0, breakdown };
}

// Balance-sheet balances as of a date (cumulative ledger).
//
// A control account such as "TDS Control Account" IS real net worth and belongs
// in Net Assets — the Balance Sheet includes it, so this must too or the two
// reports differ by its balance. But it must NOT touch the bank total (one
// platform's sync types it 'bank', another 'other_current_asset'), so the query
// routes it to a `tds_control` pseudo-code: counted in total assets, excluded
// from Closing Bank. Dummy / Suspense / Clearing stay fully excluded — they are
// not real balances on any platform.
async function asOfBalances(userId, orgId, asOf) {
  const [rows] = await pool.execute(
    `SELECT account_group AS grp,
            CASE WHEN account_name LIKE '%TDS Control%' THEN 'tds_control'
                 ELSE account_type_code END AS code,
            SUM(COALESCE(base_debit, debit))  AS d,
            SUM(COALESCE(base_credit, credit)) AS c
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND transaction_date <= ?
        ${EXCLUDE_CLEARING}
        AND account_name NOT LIKE '%Dummy%'
        AND account_name NOT LIKE '%Suspense%'
      GROUP BY grp, code`,
    [userId, orgId, asOf]
  );
  const byCode = {};
  for (const r of rows) byCode[r.code] = { grp: r.grp, d: num(r.d), c: num(r.c) };
  const dr = (code) => (byCode[code] ? byCode[code].d - byCode[code].c : 0); // assets
  const cr = (code) => (byCode[code] ? byCode[code].c - byCode[code].d : 0); // liabilities

  const debtors = dr('accounts_receivable');
  const creditors = cr('accounts_payable');
  // Bank total stays free of control accounts so it matches across platforms.
  const closingBank = dr('bank') + dr('cash');

  const currentAssets = dr('other_current_asset') + dr('bank') + dr('cash')
    + dr('accounts_receivable') + dr('tds_control');
  const termAssets = dr('fixed_asset') + dr('other_asset');
  // Net Assets ties to the Balance Sheet's Total Equity: EVERY asset (control
  // accounts included) less every liability.
  let totalAssets = 0;
  for (const code of Object.keys(byCode)) {
    if (byCode[code].grp === 'asset') totalAssets += dr(code);
  }

  const currentLiabilities = cr('accounts_payable') + cr('other_current_liability');
  // Any liability type that is not flagged current is treated as long-term.
  let totalLiabilities = 0;
  for (const code of Object.keys(byCode)) {
    if (byCode[code].grp === 'liability') totalLiabilities += cr(code);
  }
  const termLiabilities = totalLiabilities - currentLiabilities;
  const netAssets = totalAssets - totalLiabilities;
  return {
    debtors, creditors, closingBank,
    currentAssets, termAssets, totalAssets,
    currentLiabilities, termLiabilities, totalLiabilities, netAssets,
  };
}

// Compose every metric for one period [from, to].
async function metricsFor(userId, orgId, from, to) {
  const [pl, cash, sales, bs, breakdowns] = await Promise.all([
    periodPL(userId, orgId, from, to),
    periodCash(userId, orgId, from, to),
    periodSales(userId, orgId, from, to),
    asOfBalances(userId, orgId, to),
    periodBreakdowns(userId, orgId, from, to),
  ]);
  const days = daysBetween(from, to);

  return {
    // Drill-down entries backing each period-flow metric (keyed by metric name).
    _bd: { ...breakdowns, invAvg: sales.breakdown },
    // Cash
    received: cash.received,
    spent: cash.spent,
    surplus: cash.surplus,
    closingBank: bs.closingBank,
    // Profitability
    income: pl.income,
    cogs: pl.cogs,
    grossProfit: pl.grossProfit,
    otherIncome: pl.otherIncome,
    totalExpenses: pl.totalExpenses,
    netProfit: pl.netProfit,
    // Balance Sheet
    debtors: bs.debtors,
    creditors: bs.creditors,
    netAssets: bs.netAssets,
    // Sales
    invCount: sales.count,
    invAvg: sales.avg,
    // Performance (% — null when not computable)
    grossMarginPct: pl.income ? (pl.grossProfit / pl.income) * 100 : null,
    netMarginPct:   pl.income ? (pl.netProfit / pl.income) * 100 : null,
    roiPct: bs.netAssets ? (pl.netProfit / bs.netAssets) * (365 / days) * 100 : null,
    // Position
    avgDebtorDays:   pl.income ? (bs.debtors / pl.income) * days : null,
    // Creditor days are turned over by DIRECT COSTS (cost of sales), not by every
    // expense — so an org that reports no direct costs gets a blank, exactly as
    // the platform does, instead of a figure derived from overheads.
    avgCreditorDays: pl.cogs ? (bs.creditors / pl.cogs) * days : null,
    // Cash expected in less cash owed out. The bank balance is NOT part of it —
    // it is already reported on its own line above.
    shortTermCashForecast: bs.debtors - bs.creditors,
    currentRatio: bs.currentLiabilities ? bs.currentAssets / bs.currentLiabilities : null,
    // Term (non-current) assets against term (non-current) liabilities — blank
    // when there are no long-term liabilities to cover.
    termRatio:    bs.termLiabilities ? bs.termAssets / bs.termLiabilities : null,
  };
}

// ── Cell values + units (the viewer formats by row.unit) ─────────────────────
// The Executive Summary viewer renders each value cell with fmtCell(value, unit):
// 'percent' → "x.x%", 'days'/'number' → rounded, 'ratio' → 2dp, otherwise money.
// So we emit RAW NUMBERS (or null for a blank "-") here and tag each row's unit;
// this keeps the payload identical in shape to the Xero/QuickBooks providers.
const UNIT = { currency: undefined, count: 'number', percent: 'percent', days: 'days', ratio: 'ratio' };

function cellValue(v, fmt, includeZero) {
  if (v == null) return null;
  // A zero money cell renders as "-" by default; when the caller asks to keep
  // zero balances we emit a real 0 so the row shows the formatted zero amount.
  if (fmt === 'currency') return v === 0 ? (includeZero ? 0 : null) : v;
  if (fmt === 'count')    return Math.round(v);
  return v; // percent / days / ratio: raw number, the viewer formats it
}
// Variance % — percentage change vs the prior period for money and count rows;
// %, days and ratios stay blank (Xero convention). A zero or missing prior can't
// yield a percentage change, so it renders blank ("-").
function varValue(c, m, fmt) {
  if (fmt !== 'currency' && fmt !== 'count') return null;
  if (c == null || m == null) return null;
  const cur   = fmt === 'count' ? Math.round(c) : c;
  const prior = fmt === 'count' ? Math.round(m) : m;
  if (prior === 0) return null;
  const pct = ((cur - prior) / Math.abs(prior)) * 100;
  return pct === 0 ? null : pct;
}

// Variance — the ABSOLUTE difference (current − prior) in the row's own unit,
// shown next to its percentage counterpart. Same row-type rule as the % column:
// only money and count rows vary; %, days and ratio rows stay blank.
function varAbs(c, m, fmt) {
  if (fmt !== 'currency' && fmt !== 'count') return null;
  if (c == null || m == null) return null;
  const diff = (fmt === 'count' ? Math.round(c) - Math.round(m) : c - m);
  return diff === 0 ? null : diff;
}

// ── Builder ─────────────────────────────────────────────────────────────────

// Build the list of periods to report on, newest first: the current window
// plus (compare_count − 1) equal-length windows stepping back in time. The
// "Compare with N months" control sends compare_count = N + 1; with no compare
// control we default to 2 periods (current + one prior) so the legacy
// current / prior / variance layout is preserved byte-for-byte.
function buildPeriods(params, from, to) {
  let count = 2;
  const cc = Number(params.compare_count);
  if (params.compare && Number.isFinite(cc) && cc >= 1) {
    count = Math.max(1, Math.min(13, Math.round(cc)));
  }
  const periods = [{ from, to }];
  let prev = { from, to };
  for (let i = 1; i < count; i++) {
    prev = priorWindow(prev.from, prev.to);
    periods.push(prev);
  }
  return periods;
}

async function buildExecutiveSummary(userId, params = {}) {
  const orgId = await resolveOrgId(userId, params);
  requireOrg(orgId);
  const { from, to } = resolveRange(params);
  const includeZero =
    params.include_zero === '1' || params.include_zero === 1 || params.include_zero === true;
  const basisRequested =
    String(params.accounting_basis || '').toLowerCase() === 'cash' ? 'Cash' : 'Accrual';

  const currency = await getBaseCurrency(orgId);
  const periods = buildPeriods(params, from, to);
  const periodMetrics = await Promise.all(
    periods.map((p) => metricsFor(userId, orgId, p.from, p.to))
  );
  // Xero only shows a Variance column for a single comparison (two periods);
  // with more comparison periods it lays them out side by side without variance.
  const showVariance = periods.length === 2;

  const header = (label) => ({ label, isHeader: true, level: 0 });
  // `bdKey` (optional) attaches the drill-down entries for this metric to each
  // period column (cells.c0 / c1 / …), so the viewer can open a modal listing
  // exactly which GL lines make up the number the user clicked.
  const row = (label, key, fmt, bdKey) => {
    const cells = {};
    const breakdowns = {};
    periodMetrics.forEach((m, i) => {
      cells[`c${i}`] = cellValue(m[key], fmt, includeZero);
      if (bdKey && m._bd && m._bd[bdKey] && m._bd[bdKey].count > 0) {
        breakdowns[`c${i}`] = m._bd[bdKey];
      }
    });
    if (showVariance) {
      cells.var = varAbs(periodMetrics[0][key], periodMetrics[1][key], fmt);
      cells.varPct = varValue(periodMetrics[0][key], periodMetrics[1][key], fmt);
    }
    const out = { label, level: 1, unit: UNIT[fmt], cells };
    if (Object.keys(breakdowns).length) out.breakdowns = breakdowns;
    return out;
  };

  const rows = [
    header('Cash'),
    row('Cash received',           'received',    'currency', 'received'),
    row('Cash spent',              'spent',       'currency', 'spent'),
    row('Cash surplus (deficit)',  'surplus',     'currency'),
    row('Closing bank balance',    'closingBank', 'currency'),

    header('Profitability'),
    row('Income',                  'income',        'currency', 'income'),
    row('Direct costs',            'cogs',          'currency', 'cogs'),
    row('Gross profit (loss)',     'grossProfit',   'currency'),
    row('Other income',            'otherIncome',   'currency', 'otherIncome'),
    row('Expenses',                'totalExpenses', 'currency', 'totalExpenses'),
    row('Profit (loss)',           'netProfit',     'currency'),

    header('Balance Sheet'),
    row('Debtors',                 'debtors',   'currency'),
    row('Creditors',               'creditors', 'currency'),
    // Displayed as "Net Equity" — it is Assets − Liabilities, which ties to the
    // Balance Sheet's Total Equity (the internal key stays `netAssets`).
    row('Net Equity',              'netAssets', 'currency'),

    header('Sales'),
    row('Number of invoices issued', 'invCount', 'count'),
    row('Average value of invoices', 'invAvg',   'currency', 'invAvg'),

    header('Performance'),
    row('Gross profit margin (%)',          'grossMarginPct', 'percent'),
    row('Net profit margin (%)',            'netMarginPct',   'percent'),
    row('Return on investment (p.a.) (%)',  'roiPct',         'percent'),

    header('Position'),
    row('Average debtor days',            'avgDebtorDays',         'days'),
    row('Average creditor days',          'avgCreditorDays',       'days'),
    row('Short term cash forecast',       'shortTermCashForecast', 'currency'),
    row('Current assets to liabilities',  'currentRatio',          'ratio'),
    row('Term assets to liabilities',     'termRatio',             'ratio'),
  ];

  const columns = [{ key: 'label', label: '', align: 'left' }];
  periods.forEach((p, i) => {
    columns.push({ key: `c${i}`, label: periodLabel(p.from, p.to), align: 'right' });
  });
  if (showVariance) {
    columns.push({ key: 'var', label: 'Variance', align: 'right', variance: 'abs' });
    columns.push({ key: 'varPct', label: 'Variance %', align: 'right', variance: 'pct' });
  }

  return {
    columns,
    rows,
    currency,
    meta: {
      title: 'Executive Summary',
      basis: 'Accrual',
      // Cash basis isn't derivable from the Zoho ledger (no cash-settlement
      // flag), so the figures stay accrual; we echo what was requested.
      basisRequested,
      from, to,
      periods: periods.map((p) => ({ label: periodLabel(p.from, p.to), from: p.from, to: p.to })),
      compareFrom: periods[periods.length - 1].from,
      compareTo: periods.length > 1 ? periods[1].to : null,
      source: 'ledger',
      hasBreakdown: true,
    },
  };
}

module.exports = { buildExecutiveSummary };
