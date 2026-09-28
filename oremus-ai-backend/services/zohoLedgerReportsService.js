'use strict';

/**
 * Ledger-derived financial reports (Profit & Loss, Cash Flow, Expenses)
 * -------------------------------------------------------------------------
 * These reports are computed directly from the synced Zoho data already in
 * our database — `account_transactions` (a full general ledger: every posting
 * classified by account_group / account_type_code with debit & credit) and
 * `bank_transactions` (cash movements) — instead of calling Zoho's report API.
 *
 * This keeps reports working without spending Zoho's 1,000-calls/day-per-org
 * quota. Each builder returns the same { columns, rows, currency, meta } shape
 * the frontend report viewer (ReportTable) already renders, so no UI changes
 * are needed.
 *
 * Sign conventions (verified against the live data):
 *  - account_transactions: income accounts carry revenue as credit−debit;
 *    expense accounts carry cost as debit−credit.
 *  - bank_transactions: debit_or_credit = 'debit' is money IN (inflow),
 *    'credit' is money OUT (outflow). transfer_fund rows move cash between the
 *    org's own accounts and are excluded from cash-flow totals.
 */

const pool = require('../config/db');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function r2(v) {
  return Math.round((num(v) + Number.EPSILON) * 100) / 100;
}

// Resolve the org to report on: an explicit org (from the X-Org-Id switcher)
// wins, otherwise fall back to whichever platform the user is connected to.
// Checks Zoho (zb_tokens.org_id), Xero (xero_tokens.tenant_id),
// QuickBooks (qbo_tokens.realm_id) in order.
async function resolveOrgId(userId, params) {
  if (params.org_id) return params.org_id;
  // Zoho
  const [[zb]] = await pool.execute(
    'SELECT org_id FROM zb_tokens WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1',
    [userId]
  );
  if (zb?.org_id) return zb.org_id;
  // Xero — tenant_id serves as the org identifier
  const [[xt]] = await pool.execute(
    'SELECT tenant_id AS org_id FROM xero_tokens WHERE user_id = ? AND tenant_id IS NOT NULL LIMIT 1',
    [userId]
  );
  if (xt?.org_id) return xt.org_id;
  // QuickBooks — realm_id serves as the org identifier
  const [[qt]] = await pool.execute(
    'SELECT realm_id AS org_id FROM qbo_tokens WHERE user_id = ? AND realm_id IS NOT NULL LIMIT 1',
    [userId]
  );
  return qt?.org_id || null;
}

function requireOrg(orgId) {
  if (!orgId) {
    const err = new Error('Zoho not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
}

// The platform this report is scoped to ('zoho' | 'quickbooks' | 'xero'),
// matching the static lowercase `platform` column on account_transactions.
// When a caller passes it, every ledger query additionally filters by platform
// (belt-and-suspenders alongside org_id). When absent, org_id scoping alone
// applies — identical to the previous behavior, so no existing flow breaks.
function resolvePlatform(params) {
  return params.platform ? String(params.platform).toLowerCase() : null;
}

// Period window: default to the current Indian fiscal year (Apr–Mar) when the
// caller sends no dates, mirroring how Zoho scopes a P&L with no filter.
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

const TWO_COLS = [
  { key: 'label',  label: 'Account', align: 'left'  },
  { key: 'amount', label: 'Total',   align: 'right' },
];

// P&L sections, keyed by the Zoho account_type_code, with the column key/title
// used to bucket and label each line. Hoisted to module scope so the period
// aggregator + the row assembler share one definition.
const PL_SECTIONS = {
  income:             { key: 'operating_income',  title: 'Operating Income',      sign: 'credit' },
  cost_of_goods_sold: { key: 'cogs',              title: 'Cost of Goods Sold',    sign: 'debit'  },
  expense:            { key: 'operating_expense', title: 'Operating Expense',     sign: 'debit'  },
  other_income:       { key: 'other_income',      title: 'Non Operating Income',  sign: 'credit' },
  other_expense:      { key: 'other_expense',     title: 'Non Operating Expense', sign: 'debit'  },
};

const PL_SECTION_TITLE = {
  operating_income:  'Operating Income',
  cogs:              'Cost of Goods Sold',
  operating_expense: 'Operating Expense',
  other_income:      'Non Operating Income',
  other_expense:     'Non Operating Expense',
};

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function lastDayOfMonth(y, m) {
  return new Date(y, m, 0).getDate(); // m is 1-based: day 0 of next month = last day of m
}
function parseYmd(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return { y, m, d };
}

// "Display columns by" — split [from,to] into one sub-period per month / quarter
// / year. Each returned column carries its own from/to plus a compact label.
function splitByInterval(from, to, interval) {
  const a = parseYmd(from);
  const b = parseYmd(to);
  const cols = [];
  if (interval === 'months') {
    let y = a.y; let m = a.m;
    while (y < b.y || (y === b.y && m <= b.m)) {
      const first = y === a.y && m === a.m;
      const last = y === b.y && m === b.m;
      cols.push({
        label: `${MONTH_ABBR[m - 1]} ${y}`,
        from: first ? from : fmtDate(y, m, 1),
        to: last ? to : fmtDate(y, m, lastDayOfMonth(y, m)),
      });
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
  } else if (interval === 'quarters') {
    let y = a.y; let q = Math.floor((a.m - 1) / 3); // 0-based quarter
    while (y < b.y || (y === b.y && q * 3 + 1 <= b.m)) {
      const sm = q * 3 + 1;   // quarter start month (1-based)
      const em = sm + 2;      // quarter end month
      const first = y === a.y && q === Math.floor((a.m - 1) / 3);
      const last = y === b.y && em >= b.m;
      cols.push({
        label: `Q${q + 1} ${y}`,
        from: first ? from : fmtDate(y, sm, 1),
        to: last ? to : fmtDate(y, em, lastDayOfMonth(y, em)),
      });
      q += 1; if (q > 3) { q = 0; y += 1; }
    }
  } else if (interval === 'days') {
    let cur = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T00:00:00`);
    while (cur <= end) {
      const y = cur.getFullYear(); const m = cur.getMonth() + 1; const d = cur.getDate();
      const ds = fmtDate(y, m, d);
      cols.push({ label: `${MONTH_ABBR[m - 1]} ${d}, ${y}`, from: ds, to: ds });
      cur.setDate(cur.getDate() + 1);
    }
  } else if (interval === 'weeks') {
    let cur = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T00:00:00`);
    while (cur <= end) {
      const we = new Date(cur); we.setDate(we.getDate() + 6);
      const realEnd = we > end ? end : we;
      const f = fmtDate(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
      const t = fmtDate(realEnd.getFullYear(), realEnd.getMonth() + 1, realEnd.getDate());
      cols.push({
        label: `${MONTH_ABBR[cur.getMonth()]} ${cur.getDate()} - ${MONTH_ABBR[realEnd.getMonth()]} ${realEnd.getDate()}, ${realEnd.getFullYear()}`,
        from: f, to: t,
      });
      cur.setDate(cur.getDate() + 7);
    }
  } else { // years
    let y = a.y;
    while (y <= b.y) {
      cols.push({
        label: `${y}`,
        from: y === a.y ? from : fmtDate(y, 1, 1),
        to: y === b.y ? to : fmtDate(y, 12, 31),
      });
      y += 1;
    }
  }
  return cols;
}

// Same window shifted back `years` whole years (for "Compare to → Previous year").
function shiftYearRange(from, to, years) {
  const a = parseYmd(from); const b = parseYmd(to);
  const clamp = (y, m, d) => Math.min(d, lastDayOfMonth(y, m));
  return {
    from: fmtDate(a.y - years, a.m, clamp(a.y - years, a.m, a.d)),
    to: fmtDate(b.y - years, b.m, clamp(b.y - years, b.m, b.d)),
  };
}

// The window of the same length ending `n` periods before [from,to] (for
// "Compare to → Previous period"). n=1 is the period immediately before.
function prevPeriodRange(from, to, n) {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  const lenDays = Math.round((b - a) / 86400000) + 1;
  const newTo = new Date(a);
  newTo.setDate(newTo.getDate() - 1 - lenDays * (n - 1));
  const newFrom = new Date(newTo);
  newFrom.setDate(newFrom.getDate() - (lenDays - 1));
  const out = (d) => fmtDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return { from: out(newFrom), to: out(newTo) };
}

// Spelled-out range label for a comparison column header, e.g.
// "Apr 2025 - Mar 2026".
function rangeLabel(from, to) {
  const a = parseYmd(from); const b = parseYmd(to);
  return `${MONTH_ABBR[a.m - 1]} ${a.y} - ${MONTH_ABBR[b.m - 1]} ${b.y}`;
}

// Resolve the list of report columns (one period each). Compare mode wins over
// interval; otherwise interval months/quarters/years splits the range; the
// default is a single "Total" column (preserving the original output).
function buildPeriods(from, to, params) {
  const interval = params.interval;
  const compare = params.compare; // 'period' | 'year'
  const count = Math.max(1, parseInt(params.compare_count, 10) || 1);
  const oldestFirst = String(params.oldest_first) === '1' || params.oldest_first === true;

  if ((compare === 'period' || compare === 'year') && count > 1) {
    const cols = [{ label: rangeLabel(from, to), from, to }];
    for (let i = 1; i < count; i += 1) {
      const r = compare === 'year' ? shiftYearRange(from, to, i) : prevPeriodRange(from, to, i);
      cols.push({ label: rangeLabel(r.from, r.to), from: r.from, to: r.to });
    }
    return oldestFirst ? cols.reverse() : cols;
  }

  if (['months', 'quarters', 'years', 'days', 'weeks'].includes(interval)) {
    return splitByInterval(from, to, interval);
  }

  return [{ label: 'Total', from, to }];
}

// Aggregate one period's income/expense ledger into P&L section buckets:
// { [sectionKey]: { title, accounts: Map(id -> { accountName, accountRef, net }), total } }.
// Exclude the Xero Trial-Balance true-up ('xero-recon:%') rows: those are a
// CUMULATIVE balance-sheet plug (they roll prior-year P&L into retained earnings
// so the Balance Sheet reconciles), not real in-period activity. Left in, a plug
// dated inside the P&L window distorts period revenue/expense. Real postings alone
// match the provider's P&L exactly. No-op for Zoho/QB (they have no recon rows).
async function aggregatePL(userId, orgId, platform, from, to, currencyCode = null) {
  const platClause = platform ? ' AND platform = ?' : '';
  // Optional per-transaction currency filter (multi-currency orgs only — a
  // no-op for every single-currency org). Purely additive: every existing
  // caller passes nothing, so behavior is unchanged for them.
  const currClause = currencyCode ? ' AND currency_code = ?' : '';
  const args = platform ? [userId, orgId, platform, from, to] : [userId, orgId, from, to];
  if (currencyCode) args.push(currencyCode);
  const [accts] = await pool.execute(
    `SELECT account_id, account_name, account_group, account_type_code,
            SUM(COALESCE(base_debit, debit))  AS d,
            SUM(COALESCE(base_credit, credit)) AS c
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?${platClause}
        AND transaction_date BETWEEN ? AND ?
        AND account_group IN ('income', 'expense')
        AND transaction_id NOT LIKE 'xero-recon:%'${currClause}
      GROUP BY account_id, account_name, account_group, account_type_code
      ORDER BY account_name ASC`,
    args
  );
  const buckets = {};
  for (const a of accts) {
    const sec = PL_SECTIONS[a.account_type_code]
      || (a.account_group === 'income' ? PL_SECTIONS.income : PL_SECTIONS.expense);
    const net = sec.sign === 'credit' ? num(a.c) - num(a.d) : num(a.d) - num(a.c);
    if (net === 0) continue;
    const b = (buckets[sec.key] ||= { title: sec.title, accounts: new Map(), total: 0 });
    b.accounts.set(String(a.account_id), { accountName: a.account_name, accountRef: a.account_id, net });
    b.total += net;
  }
  return buckets;
}

// ── Profit & Loss ───────────────────────────────────────────────────────────
// Built from the income / expense ledger postings in the period. Lays out the
// same sections Zoho's P&L uses: Operating Income, Cost of Goods Sold, Gross
// Profit, Operating Expense, Operating Profit, then non-operating income /
// expense, ending in Net Profit / Loss.
//
// Supports the report-viewer controls:
//  - Display columns by (interval months/quarters/years) → one amount column
//    per sub-period.
//  - Compare to (previous period / previous year, N periods) → one amount
//    column per compared period.
// With neither, the output is a single "Total" column — byte-identical to the
// original report so existing behavior and drill-downs are unchanged.
//
// NOTE: the ledger (account_transactions) records accrual postings and carries
// no cash-settlement flag, so a true cash-basis P&L can't be derived here — the
// requested accounting_basis is echoed in meta but the figures stay accrual.
// This one builder serves all three platforms (Zoho / QuickBooks / Xero); the
// QB & Xero providers call it scoped by org_id = realm_id / tenant_id, so P&L is
// DB-only for every platform — no provider report API is ever called.
async function buildProfitAndLoss(userId, params = {}) {
  const orgId = await resolveOrgId(userId, params);
  requireOrg(orgId);
  const platform = resolvePlatform(params);
  const { from, to } = resolveRange(params);

  const periods = buildPeriods(from, to, params);
  const currencyCode = params.currency_code ? String(params.currency_code).toUpperCase() : null;
  const perPeriod = await Promise.all(periods.map((p) => aggregatePL(userId, orgId, platform, p.from, p.to, currencyCode)));
  const multi = periods.length > 1;
  const colKey = (i) => (multi ? `c${i}` : 'amount');
  const cellsFrom = (fn) => {
    const cells = {};
    periods.forEach((_, i) => { cells[colKey(i)] = fn(i); });
    return cells;
  };

  const columns = multi
    ? [{ key: 'label', label: 'Account', align: 'left' },
       ...periods.map((p, i) => ({ key: colKey(i), label: p.label, align: 'right' }))]
    : TWO_COLS;

  const rows = [];

  // Emit a section: the union of accounts seen across every period (first-seen
  // order), each with a cell per period column, then the per-period subtotal.
  // Returns the array of per-period section totals for the derived-row math.
  const pushSection = (key) => {
    const order = [];
    const seen = new Set();
    const nameById = {};
    const refById = {};
    for (const bk of perPeriod) {
      const b = bk[key];
      if (!b) continue;
      for (const [id, info] of b.accounts) {
        if (!seen.has(id)) {
          seen.add(id); order.push(id);
          nameById[id] = info.accountName; refById[id] = info.accountRef;
        }
      }
    }
    const totals = periods.map((_, i) => num(perPeriod[i][key]?.total));
    if (order.length === 0) return totals; // no header when the section is empty everywhere
    const title = PL_SECTION_TITLE[key];
    rows.push({ label: title, isHeader: true, level: 0 });
    for (const id of order) {
      rows.push({
        label: nameById[id],
        level: 1,
        accountRef: refById[id],
        accountName: nameById[id],
        cells: cellsFrom((i) => num(perPeriod[i][key]?.accounts.get(id)?.net)),
      });
    }
    rows.push({ label: `Total for ${title}`, isSubtotal: true, level: 0, cells: cellsFrom((i) => totals[i]) });
    return totals;
  };

  const operatingIncome = pushSection('operating_income');
  const cogs = pushSection('cogs');
  const grossProfit = periods.map((_, i) => operatingIncome[i] - cogs[i]);
  rows.push({ label: 'Gross Profit', isSubtotal: true, level: 0, cells: cellsFrom((i) => grossProfit[i]) });

  const operatingExpense = pushSection('operating_expense');
  const operatingProfit = periods.map((_, i) => grossProfit[i] - operatingExpense[i]);
  rows.push({ label: 'Operating Profit', isSubtotal: true, level: 0, cells: cellsFrom((i) => operatingProfit[i]) });

  const otherIncome = pushSection('other_income');
  const otherExpense = pushSection('other_expense');
  const netProfit = periods.map((_, i) => operatingProfit[i] + otherIncome[i] - otherExpense[i]);

  // Single-period keeps the signed Net Profit / Net Loss label; multi-column
  // can't pick one label across columns, so it stays "Net Profit / Loss".
  const netLabel = multi ? 'Net Profit / Loss' : (netProfit[0] >= 0 ? 'Net Profit' : 'Net Loss');
  rows.push({ label: netLabel, isTotal: true, level: 0, cells: cellsFrom((i) => netProfit[i]) });

  const basisCash = params.accounting_basis === 'cash' || params.basis === 'cash' || params.cash_based === 'true' || params.cash_basis === 'true';
  return {
    columns,
    rows,
    currency: 'INR',
    meta: {
      title: 'Profit and Loss',
      basis: 'Accrual',
      basisRequested: basisCash ? 'Cash' : 'Accrual',
      from,
      to,
      source: 'ledger',
      periods: periods.map((p) => ({ label: p.label, from: p.from, to: p.to })),
    },
  };
}

// ── Cash Flow Statement (Statement of Cash Flows) ────────────────────────────
// Built ENTIRELY from account_transactions (the general ledger) for ALL three
// platforms (Zoho / QuickBooks / Xero). Never calls a provider report API.
//
// Method: INDIRECT, laid out exactly like QuickBooks' Statement of Cash Flows.
// Start from Net Income, then list one adjustment line per non-cash balance-
// sheet account (the period change in its balance), grouped into Operating /
// Investing / Financing, and reconcile to the actual cash movement.
//
// The math ties out by the double-entry identity. Over any window,
//   Σ_all(credit − debit) = 0.
// Split the ledger into cash accounts, P&L accounts, and other balance-sheet
// accounts:
//   Σ_cash(credit − debit) + Σ_pl(credit − debit) + Σ_bs(credit − debit) = 0
//   −ΔCash + NetIncome + Σ(adjustments) = 0
//   ΔCash = NetIncome + Σ(adjustments)
// where ΔCash = Σ_cash(debit − credit) is the real cash movement, Net Income =
// Σ_pl(credit − debit) (income posts credit, expense posts debit), and each
// non-cash balance-sheet account's adjustment = Σ(credit − debit) over the
// window. That single sign rule captures both conventions automatically: an
// asset increase (net debit) yields a negative adjustment (a use of cash) and a
// liability/equity increase (net credit) a positive one (a source of cash). So
// ending cash = beginning cash + net change ALWAYS reconciles exactly.
//
// Supports the viewer controls: "Display columns by" (interval) and "Compare to"
// (previous period / year) each produce one amount column per period.

// Section titles + per-section subtotal labels, mirroring QuickBooks.
const CF_INDIRECT_SECTIONS = {
  operating: { title: 'OPERATING ACTIVITIES', netLabel: 'Net cash provided by operating activities' },
  investing: { title: 'INVESTING ACTIVITIES', netLabel: 'Net cash provided by investing activities' },
  financing: { title: 'FINANCING ACTIVITIES', netLabel: 'Net cash provided by financing activities' },
};

const CF_ADJ_HEADER = 'Adjustments to reconcile Net Income to Net Cash provided by operations:';
const CF_ADJ_TOTAL  = 'Total Adjustments to reconcile Net Income to Net Cash provided by operations';

// Which cash-flow section a non-cash balance-sheet account belongs to, from its
// account_group + account_type_code.
//   Investing — non-current / fixed assets and investments.
//   Financing — owners' equity and long-term borrowings.
//   Operating — working capital (receivables, payables, prepaid, taxes, etc.).
function classifyBsSection(group, typeCode) {
  const g = String(group || '').toLowerCase();
  const tc = String(typeCode || '').toLowerCase();
  if (/fixed_asset|other_asset|intangible|investment|non_current_asset/.test(tc)) return 'investing';
  if (g === 'equity' || /long_term_liability|non_current_liability|loan|borrowing/.test(tc)) return 'financing';
  return 'operating';
}

// One window's indirect cash flow. Returns
//   { netIncome,
//     accounts: Map(account_id -> { name, ref, section, adj }),   // adj = Σ(credit−debit)
//     sectionNet: {operating,investing,financing},                // Σ adjustments per section
//     net }                                                       // = netIncome + Σ all adjustments = ΔCash
//
// Net Income is derived from computePLFigures so it ties exactly to the P&L.
// xero-recon:% true-up entries are excluded from both NI and BS adjustments
// so the cash flow statement reconciles with the P&L and Balance Sheet.
async function aggregateIndirectCashFlow(userId, orgId, platform, from, to) {
  // Do NOT pass platform — old synced rows have platform=NULL and org_id alone
  // already scopes to the correct tenant.
  const args = [userId, orgId, from, to];

  // Net Income via computePLFigures — same source of truth as the P&L Report.
  const pl = await computePLFigures(userId, orgId, null, from, to);
  const netIncome = r2(pl.netProfit);

  // Period change in every non-cash balance-sheet account = its adjustment.
  // Exclude xero-recon:% true-up entries (same as P&L) so cash flow ties out.
  const [rows] = await pool.execute(
    `SELECT account_id, account_name, account_group AS g, account_type_code AS tc,
            SUM(COALESCE(base_credit, credit) - COALESCE(base_debit, debit)) AS adj
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND transaction_date BETWEEN ? AND ?
        AND account_group IN ('asset', 'liability', 'equity')
        AND (account_type_code IS NULL OR account_type_code NOT IN ('bank', 'cash'))
        AND transaction_id NOT LIKE 'xero-recon:%'
      GROUP BY account_id, account_name, account_group, account_type_code
      HAVING SUM(COALESCE(base_debit, debit)) + SUM(COALESCE(base_credit, credit)) <> 0
      ORDER BY account_name ASC`,
    args
  );

  const accounts = new Map();
  const sectionNet = { operating: 0, investing: 0, financing: 0 };
  for (const r of rows) {
    const section = classifyBsSection(r.g, r.tc);
    const adj = r2(num(r.adj));
    accounts.set(String(r.account_id), { name: r.account_name, ref: r.account_id, section, adj });
    sectionNet[section] = r2(sectionNet[section] + adj);
  }
  const net = r2(netIncome + sectionNet.operating + sectionNet.investing + sectionNet.financing);
  return { netIncome, accounts, sectionNet, net };
}

// Cumulative bank/cash balance strictly before `from` = opening cash for the
// period. Σ(debit − credit) over all prior postings to bank/cash accounts.
// No platform filter — rows may have platform=NULL.
async function openingCash(userId, orgId, platform, from) {
  const [[row]] = await pool.execute(
    `SELECT SUM(COALESCE(base_debit, debit) - COALESCE(base_credit, credit)) AS bal
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND account_type_code IN ('bank', 'cash')
        AND transaction_date < ?`,
    [userId, orgId, from]
  );
  return r2(num(row?.bal));
}

async function buildCashFlow(userId, params = {}) {
  const orgId = await resolveOrgId(userId, params);
  requireOrg(orgId);
  const platform = resolvePlatform(params);
  const { from, to } = resolveRange(params);

  const periods = buildPeriods(from, to, params);
  const perPeriod = await Promise.all(
    periods.map((p) => aggregateIndirectCashFlow(userId, orgId, platform, p.from, p.to))
  );
  const beginning = await Promise.all(
    periods.map((p) => openingCash(userId, orgId, platform, p.from))
  );

  const multi = periods.length > 1;
  const colKey = (i) => (multi ? `c${i}` : 'amount');
  const cellsFrom = (fn) => {
    const cells = {};
    periods.forEach((_, i) => { cells[colKey(i)] = fn(i); });
    return cells;
  };

  const columns = multi
    ? [{ key: 'label', label: 'Account', align: 'left' },
       ...periods.map((p, i) => ({ key: colKey(i), label: p.label, align: 'right' }))]
    : TWO_COLS;

  // Union of the accounts in one section across every period column, ordered
  // alphabetically by name (matching QuickBooks). Each carries its per-column
  // adjustment cell.
  const sectionAccounts = (section) => {
    const byId = new Map();
    for (const pp of perPeriod) {
      for (const [id, info] of pp.accounts) {
        if (info.section !== section) continue;
        if (!byId.has(id)) byId.set(id, { name: info.name, ref: info.ref });
      }
    }
    return [...byId.entries()]
      .map(([id, v]) => ({ id, name: v.name, ref: v.ref }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  };
  const adjCell = (id) => (i) => num(perPeriod[i].accounts.get(id)?.adj);

  const rows = [];

  // ── OPERATING ACTIVITIES ──────────────────────────────────────────────────
  rows.push({ label: CF_INDIRECT_SECTIONS.operating.title, isHeader: true, level: 0 });
  rows.push({
    label: 'Net Income',
    level: 1,
    cells: cellsFrom((i) => perPeriod[i].netIncome),
  });
  const opAccts = sectionAccounts('operating');
  if (opAccts.length) {
    rows.push({ label: CF_ADJ_HEADER, isHeader: true, level: 1 });
    for (const a of opAccts) {
      rows.push({ label: a.name, level: 2, accountRef: a.ref, accountName: a.name, cells: cellsFrom(adjCell(a.id)) });
    }
    rows.push({
      label: CF_ADJ_TOTAL,
      isSubtotal: true,
      level: 1,
      cells: cellsFrom((i) => num(perPeriod[i].sectionNet.operating)),
    });
  }
  rows.push({
    label: CF_INDIRECT_SECTIONS.operating.netLabel,
    isSubtotal: true,
    level: 0,
    cells: cellsFrom((i) => r2(perPeriod[i].netIncome + perPeriod[i].sectionNet.operating)),
  });

  // ── INVESTING / FINANCING ACTIVITIES ─────────────────────────────────────
  for (const section of ['investing', 'financing']) {
    const accts = sectionAccounts(section);
    if (!accts.length) continue; // QuickBooks omits a section with no activity
    rows.push({ label: CF_INDIRECT_SECTIONS[section].title, isHeader: true, level: 0 });
    for (const a of accts) {
      rows.push({ label: a.name, level: 1, accountRef: a.ref, accountName: a.name, cells: cellsFrom(adjCell(a.id)) });
    }
    rows.push({
      label: CF_INDIRECT_SECTIONS[section].netLabel,
      isSubtotal: true,
      level: 0,
      cells: cellsFrom((i) => num(perPeriod[i].sectionNet[section])),
    });
  }

  // ── Reconciliation ────────────────────────────────────────────────────────
  const netMovement = periods.map((_, i) => num(perPeriod[i].net));
  rows.push({
    label: 'NET CASH INCREASE FOR PERIOD',
    isTotal: true,
    level: 0,
    cells: cellsFrom((i) => netMovement[i]),
  });
  rows.push({
    label: 'Cash at beginning of period',
    isSubtotal: true,
    level: 0,
    cells: cellsFrom((i) => beginning[i]),
  });
  rows.push({
    label: 'CASH AT END OF PERIOD',
    isTotal: true,
    level: 0,
    cells: cellsFrom((i) => r2(beginning[i] + netMovement[i])),
  });

  return {
    columns,
    rows,
    currency: 'INR',
    meta: {
      title: 'Statement of Cash Flows',
      method: 'indirect',
      from,
      to,
      source: 'ledger',
      periods: periods.map((p) => ({ label: p.label, from: p.from, to: p.to })),
    },
  };
}

// ── Expenses by Category ────────────────────────────────────────────────────
// Expense ledger accounts (operating + non-operating) for the period, each as a
// line with its net cost, sorted largest first, with a grand total.
async function buildExpenseDetails(userId, params = {}) {
  const orgId = await resolveOrgId(userId, params);
  requireOrg(orgId);
  const platform = resolvePlatform(params);
  const { from, to } = resolveRange(params);

  const platClause = platform ? ' AND platform = ?' : '';
  const args = platform ? [userId, orgId, platform, from, to] : [userId, orgId, from, to];
  const [accts] = await pool.execute(
    `SELECT account_id, account_name,
            SUM(COALESCE(base_debit, debit)) - SUM(COALESCE(base_credit, credit)) AS net
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?${platClause}
        AND transaction_date BETWEEN ? AND ?
        AND account_group = 'expense'
      GROUP BY account_id, account_name
      HAVING net <> 0
      ORDER BY net DESC`,
    args
  );

  const rows = [];
  let total = 0;
  for (const a of accts) {
    const net = num(a.net);
    rows.push({
      label: a.account_name,
      level: 1,
      accountRef: a.account_id,
      accountName: a.account_name,
      cells: { amount: net },
    });
    total += net;
  }
  rows.push({ label: 'Total Expenses', isTotal: true, level: 0, cells: { amount: total } });

  return {
    columns: [
      { key: 'label',  label: 'Expense Account', align: 'left'  },
      { key: 'amount', label: 'Amount',          align: 'right' },
    ],
    rows,
    currency: 'INR',
    meta: { title: 'Expenses by Category', from, to, source: 'ledger' },
  };
}

/**
 * computePLFigures(userId, orgId, platform, from, to) → flat P&L numbers.
 *
 * THE canonical P&L calculation for the entire application.  Dashboard and
 * Ratios MUST call this (or use the same query logic) so their KPIs match the
 * P&L Report byte-for-byte.
 *
 * Internally delegates to `aggregatePL()` (the P&L Report's own bucketing
 * engine) and flattens the result into the plain object that consumers expect.
 *
 * Sign convention (matching the P&L Report):
 *   income accounts  → net = credit − debit  (revenue is credit-normal)
 *   expense accounts → net = debit  − credit (expenses are debit-normal)
 *
 * Returns:
 *   { revenue, otherIncome, cogs, grossProfit, opex, operatingProfit,
 *     otherExpense, operatingNet, netProfit }
 *
 * All values are positive when favourable (revenue positive, expenses positive
 * cost). Net Profit = operatingNet + otherIncome − otherExpense.
 */
async function computePLFigures(userId, orgId, platform, from, to) {
  // Do NOT pass the platform filter.  Old synced rows have platform=NULL and
  // org_id alone already scopes to the correct tenant.  Passing platform would
  // miss the bulk of ledger data (e.g. 6,489 of 6,561 Xero rows are NULL).
  const buckets = await aggregatePL(userId, orgId, null, from, to);

  const revenue          = num(buckets.operating_income?.total) || 0;
  const otherIncome      = num(buckets.other_income?.total)     || 0;
  const cogs             = num(buckets.cogs?.total)             || 0;
  const opex             = num(buckets.operating_expense?.total) || 0;
  const otherExpense     = num(buckets.other_expense?.total)    || 0;
  const grossProfit      = revenue - cogs;
  const operatingProfit  = grossProfit - opex;   // EBIT
  const operatingNet     = operatingProfit;       // alias for dashboard
  const netProfit        = operatingProfit + otherIncome - otherExpense;

  return {
    revenue,
    otherIncome,
    cogs,
    grossProfit,
    opex,
    operatingProfit,
    otherExpense,
    operatingNet,
    netProfit,
  };
}

/**
 * computeCashFlowFigures(userId, orgId, platform, from, to) → flat cash-flow
 * numbers.  Uses the same engine as the Cash Flow Statement report so the
 * Ratios endpoint ties out exactly.
 *
 * Returns:
 *   { netIncome, operatingCashFlow, investingCashFlow, financingCashFlow,
 *     netCashChange, openingCash, closingCash }
 */
async function computeCashFlowFigures(userId, orgId, platform, from, to) {
  const cf = await aggregateIndirectCashFlow(userId, orgId, platform, from, to);
  const open = await openingCash(userId, orgId, platform, from);
  return {
    netIncome:         cf.netIncome,
    operatingCashFlow: r2(cf.netIncome + cf.sectionNet.operating),
    investingCashFlow: r2(cf.sectionNet.investing),
    financingCashFlow: r2(cf.sectionNet.financing),
    netCashChange:     cf.net,
    openingCash:       open,
    closingCash:       r2(open + cf.net),
  };
}

// ── Interest / Tax / Depreciation — isolated line items ─────────────────────
// Not part of computePLFigures's canonical bucket totals (opex/otherExpense
// are single numbers there), but needed for EBITDA, Interest Coverage, and
// the leverage ratios. Sourced from the SAME aggregatePL buckets (so figures
// never drift from the P&L Report), classified by name using the identical
// regexes metricsService.js already applies to report ROWS — kept in sync
// here rather than re-derived, so both call sites agree on what counts.
// Matches only where the account normally lives on every platform's P&L:
// Depreciation in Operating Expense, Interest/Tax in Non-Operating Expense —
// this avoids e.g. "Professional Tax" (a routine opex line) being picked up
// as Income Tax.
const RE_DEPRECIATION = /deprecia|amorti/i;
const RE_INTEREST     = /interest/i;
const RE_TAX          = /(^|\b)(income )?tax/i;

function sumMatchingAccounts(bucket, re) {
  if (!bucket) return 0;
  let total = 0;
  for (const { accountName, net } of bucket.accounts.values()) {
    if (re.test(accountName || '')) total += net;
  }
  return total;
}

/**
 * extractPLLineItems(userId, orgId, from, to) → { depreciation, interestExpense, incomeTax }
 * Provider-agnostic (same aggregatePL engine as computePLFigures — org_id
 * alone scopes the platform, no per-provider branching).
 */
async function extractPLLineItems(userId, orgId, from, to) {
  const buckets = await aggregatePL(userId, orgId, null, from, to);
  return {
    depreciation:    num(sumMatchingAccounts(buckets.operating_expense, RE_DEPRECIATION)) || 0,
    interestExpense: num(sumMatchingAccounts(buckets.other_expense, RE_INTEREST)) || 0,
    incomeTax:       num(sumMatchingAccounts(buckets.other_expense, RE_TAX)) || 0,
  };
}

module.exports = { buildProfitAndLoss, buildCashFlow, buildExpenseDetails, buildPeriods, computePLFigures, computeCashFlowFigures, extractPLLineItems, aggregatePL };
