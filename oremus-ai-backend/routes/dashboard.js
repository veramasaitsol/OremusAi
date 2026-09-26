'use strict';
const { Router } = require('express');
const pool       = require('../config/db');
const auth       = require('../middleware/auth');
const { getEffectiveQBUserId } = require('../services/quickbooksService');
const { getEffectiveXeroUserId } = require('../services/xeroService');
const { getEffectiveZohoUserId } = require('../services/zohoService');
const { getProvider } = require('../services/accounting');
const { derivePL, providerBalanceSheetTotals } = require('../services/metricsService');
const { computePLFigures, aggregatePL } = require('../services/zohoLedgerReportsService');
const { computeKeyRatios } = require('../services/keyRatiosService');
const { buildArAgingSummary } = require('../services/salesArFromInvoicesService');
const { buildApAgingSummary } = require('../services/zohoApAgingDetailService');
const cache = require('../utils/cache');
const adminClientView = require('../middleware/adminClientView');

const router = Router();
router.use(auth);
// Admin "view as client": when an admin sends X-Client-Id, all dashboard
// endpoints resolve that client's data (no-op for non-admins).
router.use(adminClientView);

// ── Date range helper ──────────────────────────────────────────────────────────
function getDateRange(query) {
  const to   = query.to || new Date().toISOString().slice(0, 10);
  const from = query.from || (() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  })();
  return { from, to };
}

// ── Monthly zero-fill helpers ─────────────────────────────────────────────────
// Trend SQL uses GROUP BY month, so months with no rows are dropped. These
// helpers build the complete list of month buckets a chart should show and
// merge query rows onto it, filling gaps with zeros — so a "Last 12 Months"
// chart always renders 12 buckets and a period chart spans the whole period.
function shortMonth(ym) {
  return new Date(`${ym}-01T00:00:00`).toLocaleString('en', { month: 'short' });
}
// All 'YYYY-MM' keys from the `from` month to the `to` month inclusive.
function monthKeysBetween(from, to) {
  const keys = [];
  const start = new Date(`${String(from).slice(0, 7)}-01T00:00:00`);
  const end   = new Date(`${String(to).slice(0, 7)}-01T00:00:00`);
  if (isNaN(start) || isNaN(end) || start > end) return keys;
  const d = new Date(start);
  while (d <= end && keys.length < 600) {
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() + 1);
  }
  return keys;
}
// Trailing 12 'YYYY-MM' keys ending in the current month (matches the
// DATE_SUB(CURDATE(), INTERVAL 12 MONTH) window the kpi trends query).
function last12MonthKeys() {
  const keys = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 11; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    keys.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}
// Merge `rows` (each with a 'YYYY-MM' key under `ymField`) onto `keys`, in
// chronological order. `makeEntry(ym, row|null)` returns the output object.
// When the source has no rows at all we return [] so existing empty-state and
// fallback paths are preserved — we only fill GAPS in a series that has data.
function zeroFillMonths(rows, keys, ymField, makeEntry) {
  if (!rows || rows.length === 0) return [];
  const byYm = new Map();
  for (const r of rows) byYm.set(r[ymField], r);
  return keys.map((ym) => makeEntry(ym, byYm.get(ym) || null));
}

// ── Accounting basis helper ──────────────────────────────────────────────────
// Resolve cash vs accrual from the request. Defaults to 'accrual' (Zoho/QB
// default), so omitting the param keeps the existing behavior byte-for-byte.
function getBasis(query) {
  const v = String(query.basis || query.accounting_basis || '').toLowerCase();
  return v === 'cash' ? 'cash' : 'accrual';
}
// Provider report params for a basis. Zoho Books honors `cash_based`; the QB
// reports service maps `accounting_basis` → accounting_method. For accrual we
// send nothing so the (already-verified) accrual numbers are unchanged.
function basisReportParams(basis) {
  return basis === 'cash' ? { accounting_basis: 'cash', cash_based: true } : {};
}

// ── Safe query helper — returns [] / 0 instead of throwing ────────────────────
async function safeQuery(sql, params) {
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (_) {
    return [];
  }
}
async function safeCount(sql, params) {
  try {
    const [[row]] = await pool.execute(sql, params);
    return parseInt(Object.values(row)[0] || 0);
  } catch (_) {
    return 0;
  }
}

// ── Check which synced tables have data for this user ─────────────────────────
async function dataAvailability(uid, reqOrgId = null, adminUserId = null) {
  // Exclude QB "AccountBalance" snapshot rows: those carry a classification but
  // are chart-of-accounts balances, NOT a Zoho-style transaction ledger. Counting
  // them would flip QB users onto the account_transactions flow branches and
  // starve their working invoice/expense proxies. COALESCE keeps Zoho rows (any
  // transaction_type, incl. NULL) counted, so Zoho detection is unchanged.
  const acct = await safeCount(
    `SELECT COUNT(*) AS c FROM account_transactions
      WHERE user_id = ? AND account_group IS NOT NULL
        AND COALESCE(transaction_type,'') <> 'AccountBalance'`, [uid]
  );
  const bank = await safeCount(
    'SELECT COUNT(*) AS c FROM bank_transactions WHERE user_id = ?', [uid]
  );
  // Zoho-only invoices: rows synced from Zoho do NOT have qbo_id or xero_id.
  const zohoInv = await safeCount(
    'SELECT COUNT(*) AS c FROM invoices WHERE user_id = ? AND qbo_id IS NULL AND xero_id IS NULL', [uid]
  );

  // QB detection — resolve effective user id (clients with integration_type
  // 'quickbooks' inherit the admin's QB connection).
  let qboUid = uid, qboAcc = 0, qboInv = 0;
  try {
    qboUid = await getEffectiveQBUserId(uid);
    qboAcc = await safeCount('SELECT COUNT(*) AS c FROM qbo_accounts WHERE user_id = ?', [qboUid]);
    qboInv = await safeCount('SELECT COUNT(*) AS c FROM invoices     WHERE user_id = ? AND qbo_id IS NOT NULL', [qboUid]);
  } catch (_) { /* fall back silently */ }
  // Fallback: if effective user has no QB data, check the admin's user ID.
  // This handles the case where the admin synced data under their own ID
  // but the client has their own qbo_tokens row (from OAuth connect flow).
  if (adminUserId && qboAcc === 0 && qboInv === 0 && qboUid !== adminUserId) {
    try {
      const altAcc = await safeCount('SELECT COUNT(*) AS c FROM qbo_accounts WHERE user_id = ?', [adminUserId]);
      const altInv = await safeCount('SELECT COUNT(*) AS c FROM invoices     WHERE user_id = ? AND qbo_id IS NOT NULL', [adminUserId]);
      if (altAcc > 0 || altInv > 0) { qboUid = adminUserId; qboAcc = altAcc; qboInv = altInv; }
    } catch (_) { /* ignore */ }
  }

  // Xero detection — same pattern as QB
  let xeroUid = uid, xeroAcc = 0, xeroInv = 0;
  try {
    xeroUid = await getEffectiveXeroUserId(uid);
    xeroAcc = await safeCount('SELECT COUNT(*) AS c FROM xero_accounts WHERE user_id = ?', [xeroUid]);
    xeroInv = await safeCount('SELECT COUNT(*) AS c FROM invoices      WHERE user_id = ? AND xero_id IS NOT NULL', [xeroUid]);
  } catch (_) { /* fall back silently */ }
  // Fallback: if effective user has no Xero data, check the admin's user ID.
  if (adminUserId && xeroAcc === 0 && xeroInv === 0 && xeroUid !== adminUserId) {
    try {
      const altAcc = await safeCount('SELECT COUNT(*) AS c FROM xero_accounts WHERE user_id = ?', [adminUserId]);
      const altInv = await safeCount('SELECT COUNT(*) AS c FROM invoices      WHERE user_id = ? AND xero_id IS NOT NULL', [adminUserId]);
      if (altAcc > 0 || altInv > 0) { xeroUid = adminUserId; xeroAcc = altAcc; xeroInv = altInv; }
    } catch (_) { /* ignore */ }
  }

  // Zoho-live detection — user (or their admin) has a valid Zoho org connection.
  // When true, dashboard KPIs come from the cached Zoho reports so they match
  // the Reports page byte-for-byte.
  let hasZohoLive = false, zohoOrgId = null, zohoUid = uid;
  try {
    // Always resolve the effective Zoho user so warehouse queries (zb_invoices,
    // zb_bills, etc.) use the correct user_id regardless of whether X-Org-Id
    // was provided.  Clients whose integration_type='zoho' inherit the admin's
    // token/warehouse via this call.
    zohoUid = await getEffectiveZohoUserId(uid);
  } catch (_) { /* keep zohoUid = uid */ }

  if (reqOrgId) {
    // X-Org-Id header (validated by orgScope middleware) selects the active org.
    hasZohoLive = true; zohoOrgId = reqOrgId;
  } else {
    try {
      const [[tok]] = await pool.execute(
        'SELECT org_id FROM zb_tokens WHERE user_id = ? AND org_id IS NOT NULL',
        [zohoUid]
      );
      if (tok?.org_id) { hasZohoLive = true; zohoOrgId = tok.org_id; }
    } catch (_) { /* ignore */ }
  }

  return {
    hasAcctTxn:  acct    > 0,
    hasBankTxn:  bank    > 0,
    hasInvoices: zohoInv > 0,                       // Zoho-only invoices
    hasQbo:      qboAcc  > 0 || qboInv  > 0,        // QB data available
    hasXero:     xeroAcc > 0 || xeroInv > 0,        // Xero data available
    hasZohoLive,
    zohoOrgId,
    zohoUid,   // effective user_id that owns the Zoho token + warehouse data
    qboUid,
    xeroUid,
  };
}

// Resolve the effective (userId, orgId, platform) for whichever provider is
// actually connected — needed by any endpoint that calls the provider-agnostic
// report engines (aggregateBS/aggregatePL, AR/AP Aging Summary), which require
// a REAL org_id (Zoho org / QBO realm / Xero tenant), unlike the optional
// X-Org-Id SQL filter (`req.orgId`) some queries in this file use as-is.
// Returns { effUid: null, orgId: null, platform: null } when nothing is
// connected — callers must handle that rather than assume a value.
async function resolveEffectiveOrgContext(av, uid, req) {
  const { hasZohoLive, zohoOrgId, zohoUid, hasAcctTxn, hasQbo, qboUid, hasXero, xeroUid } = av;
  if (hasZohoLive) return { effUid: zohoUid, orgId: req.orgId || zohoOrgId, platform: 'zoho' };
  if (hasAcctTxn) {
    let orgId = req.orgId || null;
    if (!orgId) {
      const [[t]] = await pool.execute(
        'SELECT org_id FROM account_transactions WHERE user_id=? AND org_id IS NOT NULL LIMIT 1', [uid]
      ).catch(() => [[]]);
      orgId = t?.org_id || null;
    }
    return { effUid: uid, orgId, platform: null };
  }
  if (hasQbo) {
    const [[t]] = await pool.execute(
      'SELECT realm_id FROM qbo_tokens WHERE user_id=? AND realm_id IS NOT NULL LIMIT 1', [qboUid]
    ).catch(() => [[]]);
    return { effUid: qboUid, orgId: t?.realm_id || null, platform: 'quickbooks' };
  }
  if (hasXero) {
    const [[t]] = await pool.execute(
      'SELECT tenant_id FROM xero_tokens WHERE user_id=? AND tenant_id IS NOT NULL LIMIT 1', [xeroUid]
    ).catch(() => [[]]);
    return { effUid: xeroUid, orgId: t?.tenant_id || null, platform: 'xero' };
  }
  return { effUid: null, orgId: null, platform: null };
}

// ── Cash on Hand — single source of truth ────────────────────────────────────
// The dashboard summary card (GET /dashboard), the detail panel (GET /kpi/cash)
// and the burn/runway tile (GET /kpi/burn) all derive cash from THIS one
// function, so the headline total, the bank count and the per-account breakdown
// can never disagree. Per provider it reads the authoritative SYNCED balance
// (no live API call): Zoho → the synced bank ledger (bank_transactions,
// or, when available, the posted GL's debit−credit bank/cash balances so it
// matches the Balance Sheet exactly, falling back to the warehouse bank-account table;
// QuickBooks / Xero → the synced Bank-type accounts in the chart of accounts.
// Values are NOT floored at zero — a genuinely negative cash position shows as
// negative on every surface instead of a misleading ₹0 on the card while the
// detail panel shows the real negative figure.
// `asOf` (optional 'YYYY-MM-DD') scopes the balance to that date instead of the
// live total — the same "as of" pattern used by Balance Sheet / Aging reports —
// so the dashboard's selected period actually moves the figure. Only the
// dated-ledger paths (account_transactions / bank_transactions) can honour it;
// the QuickBooks/Xero chart-of-accounts snapshot fallback (branches 4-5 below)
// has no transaction-level history to replay, so it stays "current balance"
// regardless of `asOf` — a genuine data-sync limitation, not a bug.
// Returns { accounts: [{ id, name, balance }], bankCount, total }.
async function resolveCashOnHand(av, uid, activeOrgId, asOf) {
  const orgF = activeOrgId ? ' AND org_id = ?' : '';
  const orgP = activeOrgId ? [activeOrgId] : [];
  const zbUid = av.zohoUid || uid;
  const asOfF = asOf ? ' AND transaction_date <= ?' : '';
  const asOfP = asOf ? [asOf] : [];

  const pack = (accounts) => ({
    accounts,
    bankCount: accounts.length,
    total: accounts.reduce((s, a) => s + a.balance, 0),
  });

  // Prefer the posted ledger when it exists so dashboard cash matches the
  // Balance Sheet's bank/cash lines exactly. Skip QB's AccountBalance snapshot
  // rows because summing multiple snapshots would overstate cash.
  const fromAccountLedger = async (userId) => {
    const rows = await safeQuery(
      `SELECT account_id AS id,
              MAX(account_name) AS name,
              SUM(COALESCE(base_debit, debit) - COALESCE(base_credit, credit)) AS net
         FROM account_transactions
        WHERE user_id=?${activeOrgId ? ' AND org_id = ?' : ''}
          AND LOWER(COALESCE(account_type_code, '')) IN ('bank', 'cash')
          AND COALESCE(transaction_type, '') <> 'AccountBalance'${asOfF}
        GROUP BY account_id
       HAVING ROUND(COALESCE(SUM(COALESCE(base_debit, debit) - COALESCE(base_credit, credit)), 0), 2) <> 0
       ORDER BY name ASC`,
      [userId, ...orgP, ...asOfP]
    );
    return rows.map((r) => ({
      id: String(r.id),
      name: r.name || 'Bank Account',
      balance: Math.round(parseFloat(r.net || 0)),
    }));
  };

  // Per-account net from the synced bank ledger. Zoho/Xero bank feeds store
  // debit = money IN and credit = money OUT, so a positive balance is debit − credit.
  const fromBankLedger = async (userId) => {
    const rows = await safeQuery(
      `SELECT bt.account_id AS id,
              SUM(CASE WHEN bt.debit_or_credit='debit' THEN bt.amount ELSE -bt.amount END) AS net,
              (SELECT account_name FROM account_transactions
                WHERE user_id=?${orgF} AND account_id=bt.account_id LIMIT 1) AS name
         FROM bank_transactions bt
        WHERE bt.user_id=?${activeOrgId ? ' AND bt.org_id = ?' : ''}${asOf ? ' AND bt.transaction_date <= ?' : ''}
        GROUP BY bt.account_id
       HAVING net <> 0`,
      [userId, ...orgP, userId, ...orgP, ...asOfP]
    );
    // Resolve missing names: when account_id is NULL (common for Xero),
    // look up the bank name from xero_accounts or qbo_accounts.
    // mysql2 returns SQL NULL as JS null — must compare via String(),
    // otherwise this filter never matches and names stay generic.
    const needName = rows.filter((r) => !r.name && String(r.id) === 'null');
    if (needName.length > 0) {
      // Try Xero bank accounts first
      const xeroBanks = await safeQuery(
        'SELECT xero_id AS id, name FROM xero_accounts WHERE user_id=? AND type="BANK" AND status="ACTIVE"',
        [userId]
      );
      // Try QBO bank accounts
      const qboBanks = await safeQuery(
        'SELECT qbo_id AS id, name FROM qbo_accounts WHERE user_id=? AND account_type="Bank" AND active=1',
        [userId]
      );
      const bankMap = new Map();
      for (const b of [...xeroBanks, ...qboBanks]) bankMap.set(String(b.id), b.name);
      // Also build a list of bank names for the null-id case
      const bankNames = [...xeroBanks, ...qboBanks].map((b) => b.name).filter(Boolean);
      for (const r of needName) {
        if (bankMap.has(r.id)) {
          r.name = bankMap.get(r.id);
        } else if (bankNames.length === 1) {
          // Only one bank account — use its name
          r.name = bankNames[0];
        } else if (bankNames.length > 1) {
          // Multiple banks with no account_id — use 'Bank Account N'
          r.name = 'Bank Account';
        } else {
          r.name = 'Bank Account';
        }
      }
    }
    return rows.map((r) => ({
      id:      String(r.id) === 'null' ? 'bank' : String(r.id),
      name:    r.name || 'Bank Account',
      balance: Math.round(parseFloat(r.net || 0)),
    }));
  };

  // 1. Zoho — synced bank ledger; fall back to the warehouse bank-account table.
  if (av.hasZohoLive) {
    const ledgerAccounts = await fromAccountLedger(zbUid);
    if (ledgerAccounts.length > 0) return pack(ledgerAccounts);
    const bankRows = await safeCount(
      `SELECT COUNT(*) AS c FROM bank_transactions WHERE user_id=?${orgF}`, [zbUid, ...orgP]
    );
    if (bankRows > 0) return pack(await fromBankLedger(zbUid));
    const rows = await safeQuery(
      `SELECT zoho_account_id AS id, account_name AS name, account_balance AS bal
         FROM zb_bank_accounts WHERE user_id=?${orgF}`, [zbUid, ...orgP]
    );
    return pack(rows
      .map((r) => ({ id: String(r.id), name: r.name || String(r.id), balance: Math.round(parseFloat(r.bal || 0)) }))
      .filter((a) => a.balance !== 0));
  }

  // 2. Generic posted ledger (legacy/local orgs without a live Zoho token).
  if (av.hasAcctTxn) {
    const ledgerAccounts = await fromAccountLedger(uid);
    if (ledgerAccounts.length > 0) return pack(ledgerAccounts);
  }

  // 3. Legacy bank ledger (no Zoho token, but bank rows exist).
  if (av.hasBankTxn) return pack(await fromBankLedger(uid));

  // 4. QuickBooks — Bank balances from the synced chart of accounts. Reduced-
  //    schema deployments store the COA as AccountBalance snapshot rows in
  //    account_transactions; full-schema deployments have the qbo_accounts table.
  if (av.hasQbo) {
    let rows = await safeQuery(
      `SELECT account_id AS id, account_name AS name, balance AS bal
         FROM account_transactions
        WHERE user_id=? AND transaction_type='AccountBalance'
          AND account_type_code IN ('bank','cash')`,
      [av.qboUid]
    );
    if (rows.length === 0) {
      rows = await safeQuery(
        `SELECT qbo_id AS id, name, current_balance_with_sub_accounts AS bal
           FROM qbo_accounts
          WHERE user_id=? AND account_type='Bank' AND active=1 AND is_sub_account=0`,
        [av.qboUid]
      );
    }
    return pack(rows.map((r) => ({ id: String(r.id), name: r.name || String(r.id), balance: Math.round(parseFloat(r.bal || 0)) })));
  }

  // 5. Xero — BANK accounts from the synced chart of accounts.
  if (av.hasXero) {
    const rows = await safeQuery(
      `SELECT xero_id AS id, name, balance AS bal
         FROM xero_accounts
        WHERE user_id=? AND type='BANK' AND status='ACTIVE'`,
      [av.xeroUid]
    );
    return pack(rows.map((r) => ({ id: String(r.id), name: r.name || String(r.id), balance: Math.round(parseFloat(r.bal || 0)) })));
  }

  return { accounts: [], bankCount: 0, total: 0 };
}

// Sum numeric leaf rows of a transformed report whose label matches any of the
// given regexes (or returns the row's amount if `level === topLevel`).
function sumReportRows(rows, predicate) {
  let s = 0;
  (rows || []).forEach((r) => {
    if (predicate(r)) s += Number(r.cells?.amount || r.cells?.balance || 0);
  });
  return s;
}

// Read the (single) numeric amount cell from a transformed report row. QBO
// reports key the value column 'c0' (single period); fall back to amount/balance
// or the last numeric cell so we work regardless of transformer style.
function rowAmount(r) {
  const c = r.cells || {};
  if (c.c0 != null) return Number(c.c0) || 0;
  if (c.amount != null) return Number(c.amount) || 0;
  if (c.balance != null) return Number(c.balance) || 0;
  const vals = Object.values(c).filter((v) => typeof v === 'number');
  return vals.length ? Number(vals[vals.length - 1]) || 0 : 0;
}

// Sum revenue + expenses from a transformed QuickBooks Profit & Loss report so
// the dashboard KPIs match QuickBooks' own P&L exactly (Total Income vs the
// sparse invoices/expense_entries sums). Expenses include COGS + Operating +
// Other Expenses so (revenue - expenses) equals QBO Net Income.
function sumQboPL(rows) {
  let revenue = 0, expenses = 0;
  (rows || []).forEach((r) => {
    if ((r.level || 0) !== 0 || !r.isSubtotal) return;
    const label = String(r.label || '').trim().toLowerCase();
    const amt = rowAmount(r);
    if (label === 'total income' || label === 'total other income') revenue += amt;
    else if (label === 'total cost of goods sold'
          || label === 'total expenses'
          || label === 'total other expenses') expenses += amt;
  });
  return { revenue, expenses };
}

// Revenue / expenses / net profit / interest for QuickBooks — built from our OWN
// synced general ledger (account_transactions, scoped by org_id = QBO realm_id)
// via the provider-agnostic Zoho P&L builder. NO live QBO /Reports call. Mirrors
// xeroProfitAndLoss's recombination + 15-min in-process cache. Scoped to the SAME
// from/to the caller passes — whatever period the dashboard's date picker
// (Month/Quarter/Year/custom) has selected.
async function qboProfitAndLoss(qboUid, from, to, basis) {
  return cache.wrap(`dash:qbopl:${qboUid}:${from}:${to}:${basis || 'accrual'}`, 15 * 60 * 1000, async () => {
    const [[tok]] = await pool.execute(
      'SELECT realm_id FROM qbo_tokens WHERE user_id=? LIMIT 1', [qboUid]);
    const ledgerReports = require('../services/zohoLedgerReportsService');
    const rep = await ledgerReports.buildProfitAndLoss(qboUid,
      { from_date: from, to_date: to, org_id: tok?.realm_id, accounting_basis: basis });
    const pl = derivePL(rep.rows, 'quickbooks');
    const revenue  = (Number(pl.revenue) || 0) + (Number(pl.otherIncome) || 0);
    const expenses = (Number(pl.cogs) || 0) + (Number(pl.opex) || 0) + (Number(pl.otherExpense) || 0);
    // revenue − expenses == QB Net Income by construction.
    return { ...pl, revenue, expenses, netProfit: Number(pl.netProfit) || 0, currency: rep.currency || 'USD' };
  });
}

// Revenue / expenses / net profit / interest for Xero — built from our OWN
// synced general ledger (account_transactions, scoped by org_id = Xero
// tenant_id) via the provider-agnostic Zoho P&L builder. NO live Xero /Reports
// call. Mirrors qboProfitAndLoss's recombination + 15-min in-process cache.
async function xeroProfitAndLoss(xeroUid, from, to, basis) {
  return cache.wrap(`dash:xeropl:${xeroUid}:${from}:${to}:${basis || 'accrual'}`, 15 * 60 * 1000, async () => {
    const [[tok]] = await pool.execute(
      'SELECT tenant_id FROM xero_tokens WHERE user_id=? LIMIT 1', [xeroUid]);
    const ledgerReports = require('../services/zohoLedgerReportsService');
    const rep = await ledgerReports.buildProfitAndLoss(xeroUid,
      { from_date: from, to_date: to, org_id: tok?.tenant_id, accounting_basis: basis });
    const pl = derivePL(rep.rows, 'xero');
    const revenue  = (Number(pl.revenue) || 0) + (Number(pl.otherIncome) || 0);
    const expenses = (Number(pl.cogs) || 0) + (Number(pl.opex) || 0) + (Number(pl.otherExpense) || 0);
    // revenue − expenses == Xero Net Profit by construction.
    return { ...pl, revenue, expenses, netProfit: Number(pl.netProfit) || 0, currency: rep.currency || 'INR' };
  });
}

// ── GET /api/dashboard ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const uid = req.user.id;
    const { from, to } = getDateRange(req.query);
    const basis = getBasis(req.query);
    const av = await dataAvailability(uid, req.orgId, req.adminUserId || null);
    const { hasAcctTxn, hasBankTxn, hasInvoices, hasQbo, qboUid, hasXero, xeroUid, hasZohoLive, zohoOrgId, zohoUid } = av;
    // For org-scoped queries, prefer the resolved zohoOrgId (from token) when
    // req.orgId is null — this lets admin users see the client's warehouse data.
    const activeOrgId = req.orgId || zohoOrgId || null;
    const orgF = activeOrgId ? ' AND org_id = ?' : '';
    const orgP = activeOrgId ? [activeOrgId] : [];
    // Effective user_id for warehouse (zb_*) queries — may differ from uid when
    // an admin views a client's Zoho data.
    const zbUid = zohoUid || uid;

    let totalRevenue = 0, totalExpenses = 0, totalPayments = 0;
    let totalInvoices = 0, totalCustomers = 0, outstandingReceivables = 0;
    // Display currency for the whole dashboard. Defaults to INR (Zoho/legacy
    // Indian data); overridden per branch so QB/Xero render their own currency.
    let currency = 'INR';

    // ── Zoho branch (highest priority) ──────────────────────────────────────
    // Computed from the local ledger/warehouse tables (account_transactions,
    // invoices, bank_transactions) → matches the Reports page WITHOUT spending
    // Zoho's per-org daily API quota or depending on a live OAuth token.
    let zohoLocalOk = false;
    if (hasZohoLive) {
      try {
        const [[zo]] = await pool.execute(
          `SELECT currency FROM zb_oauth_organizations WHERE user_id = ? AND currency IS NOT NULL LIMIT 1`,
          [uid]
        );
        if (zo?.currency) currency = zo.currency;
      } catch (_) { /* keep default INR */ }
      var opexForBurn = 0
      try {
        // Revenue / Expenses from the local general ledger (account_transactions).
        // Use the CANONICAL P&L calculation (computePLFigures) so dashboard KPIs
        // match the P&L Report byte-for-byte. This function calculates:
        //   income  → net = credit − debit (revenue is credit-normal)
        //   expense → net = debit − credit (expenses are debit-normal)
        // The old approach summed only gross credits/debits which overstated
        // revenue/expenses when accounts had opposite-side postings (refunds, etc).
        const plFigures = await computePLFigures(zbUid, activeOrgId, null, from, to);
        const revenue = plFigures.revenue + plFigures.otherIncome;
        const expenses = plFigures.cogs + plFigures.opex + plFigures.otherExpense;
        // No ledger activity for this org/period → fall back to the warehouse
        // tables (invoices/bills) below so the dashboard still shows real data.
        if (revenue === 0 && expenses === 0) {
          throw new Error('No local ledger activity — falling back to warehouse');
        }
        opexForBurn = plFigures.opex
        totalRevenue  = revenue;
        totalExpenses = expenses;

        // Outstanding receivables + invoice count + customers from the synced
        // invoices (point-in-time: every unpaid invoice, NOT period sales) — the
        // same concept Zoho's AR aging summary reported, served from our DB.
        const [[arRow]] = await pool.execute(
          `SELECT COALESCE(SUM(balance),0) AS bal,
                  COUNT(*) AS cnt,
                  COUNT(DISTINCT customer_name) AS cust
           FROM invoices
           WHERE user_id = ? AND (is_deleted=0 OR is_deleted IS NULL)
             AND balance > 0${orgF}`,
          [zbUid, ...orgP]
        );
        outstandingReceivables = parseFloat(arRow?.bal || 0);
        totalInvoices = parseInt(arRow?.cnt || 0);
        totalCustomers = parseInt(arRow?.cust || 0);

        zohoLocalOk = true;
      } catch (e) {
        // No local ledger → fall back to the warehouse branches below.
        console.warn('[dashboard] local ledger compute failed, falling back:', e.message);
        zohoLocalOk = false;
      }
    }

    if (zohoLocalOk) {
      // skip the if/else cascade below
    } else if (hasZohoLive) {
      // Zoho live fetch failed (quota / network) — fall back to the warehouse
      // tables (zb_invoices, zb_bills) which are always available offline.
      try {
        const zbOrgF = activeOrgId ? ' AND org_id = ?' : '';
        const zbOrgP = activeOrgId ? [activeOrgId] : [];
        const [[revRow]] = await pool.execute(
          `SELECT COALESCE(SUM(total),0) AS rev, COUNT(*) AS cnt,
                  COALESCE(SUM(balance),0) AS balance
           FROM invoices
           WHERE user_id = ? AND (is_deleted=0 OR is_deleted IS NULL)
             AND date BETWEEN ? AND ?${zbOrgF}`,
          [zbUid, from, to, ...zbOrgP]
        );
        totalRevenue  = parseFloat(revRow.rev  || 0);
        totalInvoices = parseInt(revRow.cnt    || 0);
        outstandingReceivables = parseFloat(revRow.balance || 0);

        const [[expRow]] = await pool.execute(
          `SELECT COALESCE(SUM(total),0) AS exp FROM bills
           WHERE user_id = ? AND (is_deleted=0 OR is_deleted IS NULL)
             AND date BETWEEN ? AND ?${zbOrgF}`,
          [zbUid, from, to, ...zbOrgP]
        );
        totalExpenses = parseFloat(expRow.exp || 0);

        // Distinct customer count from invoices in period
        const [[custRow]] = await pool.execute(
          `SELECT COUNT(DISTINCT customer_name) AS c FROM invoices
           WHERE user_id = ? AND (is_deleted=0 OR is_deleted IS NULL)
             AND date BETWEEN ? AND ?${zbOrgF}`,
          [zbUid, from, to, ...zbOrgP]
        );
        totalCustomers = parseInt(custRow.c || 0);
      } catch (zbErr) {
        console.warn('[dashboard] warehouse fallback failed:', zbErr.message);
      }
    } else if (hasAcctTxn) {
      // Revenue / Expenses from the posted ledger — use the CANONICAL P&L
      // calculation (computePLFigures) so dashboard KPIs match the P&L Report.
      // Old approach summed only gross credits/debits; this uses net (credit−debit
      // for income, debit−credit for expense) matching the accounting standard.
      try {
        const acctOrgId = activeOrgId || null;
        const plFigures = await computePLFigures(uid, acctOrgId, null, from, to);
        totalRevenue = plFigures.revenue + plFigures.otherIncome;
        totalExpenses = plFigures.cogs + plFigures.opex + plFigures.otherExpense;
      } catch (_) {
        // Fallback: if computePLFigures fails (no org_id), use legacy gross sums
        const [revRow] = await safeQuery(
          `SELECT COALESCE(SUM(COALESCE(base_credit, credit)), 0) AS v FROM account_transactions
           WHERE user_id = ? AND account_group = 'income'
             AND (account_type_code IS NULL OR account_type_code <> 'other_income')
             AND COALESCE(base_credit, credit) > 0
             AND transaction_date BETWEEN ? AND ?${orgF}`, [uid, from, to, ...orgP]
        );
        totalRevenue = parseFloat(revRow?.v || 0);
        const [expRow] = await safeQuery(
          `SELECT COALESCE(SUM(COALESCE(base_debit, debit)), 0) AS v FROM account_transactions
           WHERE user_id = ? AND account_group = 'expense' AND COALESCE(base_debit, debit) > 0
             AND transaction_date BETWEEN ? AND ?${orgF}`, [uid, from, to, ...orgP]
        );
        totalExpenses = parseFloat(expRow?.v || 0);
      }

      const [cntRow] = await safeQuery(
        `SELECT COUNT(DISTINCT transaction_id) AS v FROM account_transactions
         WHERE user_id = ? AND transaction_type = 'invoice'
           AND transaction_date BETWEEN ? AND ?${orgF}`, [uid, from, to, ...orgP]
      );
      totalInvoices = parseInt(cntRow?.v || 0);

    } else if (hasInvoices) {
      const rows = await safeQuery(
        `SELECT COALESCE(SUM(total),0) AS rev, COUNT(*) AS cnt
         FROM invoices WHERE user_id = ? AND qbo_id IS NULL AND xero_id IS NULL AND date BETWEEN ? AND ?${orgF}`, [uid, from, to, ...orgP]
      );
      totalRevenue  = parseFloat(rows[0]?.rev || 0);
      totalInvoices = parseInt(rows[0]?.cnt || 0);

      const eRows = await safeQuery(
        `SELECT COALESCE(SUM(amount),0) AS v FROM expense_entries
         WHERE user_id = ? AND qbo_id IS NULL AND xero_id IS NULL AND expense_date BETWEEN ? AND ?${orgF}`, [uid, from, to, ...orgP]
      );
      totalExpenses = parseFloat(eRows[0]?.v || 0);
    } else if (hasQbo) {
      // QB revenue / expenses come from QuickBooks' OWN ProfitAndLoss report so
      // the KPIs tie out to QuickBooks EXACTLY (the synced invoices/bills tables
      // only capture a subset of transactions). The invoice COUNT still comes
      // from the synced table. If the live report is unavailable (token/network),
      // fall back to the synced-document sums so the dashboard never goes blank.
      currency = 'USD';
      try {
        const [[o]] = await pool.execute(
          `SELECT currency FROM qbo_organizations
            WHERE user_id = ? AND currency REGEXP '^[A-Z]{3}$' LIMIT 1`,
          [qboUid]
        );
        if (o?.currency) currency = o.currency;
      } catch (_) { /* keep default USD */ }

      let plOk = false;
      try {
        const pl = await qboProfitAndLoss(qboUid, from, to, basis);
        totalRevenue  = pl.revenue;
        totalExpenses = pl.expenses;
        if (pl.currency) currency = pl.currency;
        plOk = true;
      } catch (err) {
        console.warn('[dashboard] QB P&L fetch failed, falling back to synced docs:', err.message);
      }

      const [r] = await safeQuery(
        `SELECT COALESCE(SUM(total),0) AS rev, COUNT(*) AS cnt
         FROM invoices WHERE user_id = ? AND qbo_id IS NOT NULL AND date BETWEEN ? AND ?`,
        [qboUid, from, to]
      );
      totalInvoices = parseInt(r?.cnt || 0);

      if (!plOk) {
        totalRevenue = parseFloat(r?.rev || 0);
        const [eb] = await safeQuery(
          `SELECT COALESCE(SUM(total),0) AS v FROM bills
           WHERE user_id = ? AND qbo_id IS NOT NULL AND date BETWEEN ? AND ?`,
          [qboUid, from, to]
        );
        const [e] = await safeQuery(
          `SELECT COALESCE(SUM(amount),0) AS v FROM expense_entries
           WHERE user_id = ? AND qbo_id IS NOT NULL AND expense_date BETWEEN ? AND ?`,
          [qboUid, from, to]
        );
        totalExpenses = parseFloat(eb?.v || 0) + parseFloat(e?.v || 0);
      }
    } else if (hasXero) {
      // Xero-synced data — built from the same GL the P&L Report uses,
      // NOT from the invoices/bills tables (which miss journal adjustments).
      try {
        const pl = await xeroProfitAndLoss(xeroUid, from, to, basis);
        totalRevenue  = pl.revenue;
        totalExpenses = pl.expenses;
        if (pl.currency) currency = pl.currency;
      } catch (err) {
        console.warn('[dashboard] Xero P&L from GL failed, falling back to docs:', err.message);
        // Fallback: document-level sums (partial — misses journals)
        try {
          const [r] = await safeQuery(
            `SELECT COALESCE(SUM(total),0) AS rev, COUNT(*) AS cnt
             FROM invoices WHERE user_id = ? AND xero_id IS NOT NULL AND date BETWEEN ? AND ?`,
            [xeroUid, from, to]
          );
          totalRevenue  = parseFloat(r?.rev || 0);
          totalInvoices = parseInt(r?.cnt || 0);
          const [eb] = await safeQuery(
            `SELECT COALESCE(SUM(total),0) AS v FROM bills
             WHERE user_id = ? AND xero_id IS NOT NULL AND date BETWEEN ? AND ?`,
            [xeroUid, from, to]
          );
          const [e] = await safeQuery(
            `SELECT COALESCE(SUM(amount),0) AS v FROM expense_entries
             WHERE user_id = ? AND xero_id IS NOT NULL AND expense_date BETWEEN ? AND ?`,
            [xeroUid, from, to]
          );
          totalExpenses = parseFloat(eb?.v || 0) + parseFloat(e?.v || 0);
        } catch (_) { /* best effort */ }
      }
      // Invoice count (still from synced table — the GL doesn't have this)
      try {
        const [r] = await safeQuery(
          `SELECT COUNT(*) AS cnt FROM invoices
           WHERE user_id = ? AND xero_id IS NOT NULL AND date BETWEEN ? AND ?`,
          [xeroUid, from, to]
        );
        totalInvoices = parseInt(r?.cnt || 0);
      } catch (_) { /* best effort */ }
    }

    if (!zohoLocalOk && hasBankTxn) {
      const rows = await safeQuery(
        `SELECT COALESCE(SUM(amount), 0) AS pay,
                COUNT(DISTINCT NULLIF(customer_id,'')) AS cust
         FROM bank_transactions
         WHERE user_id = ? AND debit_or_credit = 'debit'
           AND transaction_date BETWEEN ? AND ?${orgF}`, [uid, from, to, ...orgP]
      );
      totalPayments  = parseFloat(rows[0]?.pay || 0);
      totalCustomers = parseInt(rows[0]?.cust || 0);
    } else if (!zohoLocalOk && hasInvoices) {
      const rows = await safeQuery(
        `SELECT COALESCE(SUM(total - balance),0) AS pay,
                COUNT(DISTINCT customer_name) AS cust
         FROM invoices WHERE user_id = ? AND qbo_id IS NULL AND xero_id IS NULL AND date BETWEEN ? AND ?${orgF}`, [uid, from, to, ...orgP]
      );
      totalPayments  = parseFloat(rows[0]?.pay || 0);
      totalCustomers = parseInt(rows[0]?.cust || 0);
    } else if (hasQbo) {
      const rows = await safeQuery(
        `SELECT COALESCE(SUM(total - balance),0) AS pay,
                COUNT(DISTINCT customer_name) AS cust
         FROM invoices
         WHERE user_id = ? AND qbo_id IS NOT NULL AND date BETWEEN ? AND ?`,
        [qboUid, from, to]
      );
      totalPayments  = parseFloat(rows[0]?.pay || 0);
      const cFromInv  = parseInt(rows[0]?.cust || 0);
      const [c] = await safeQuery(
        `SELECT COUNT(*) AS v FROM customers WHERE user_id = ? AND qbo_id IS NOT NULL`,
        [qboUid]
      );
      totalCustomers = Math.max(parseInt(c?.v || 0), cFromInv);
    } else if (hasXero) {
      const rows = await safeQuery(
        `SELECT COALESCE(SUM(total - balance),0) AS pay,
                COUNT(DISTINCT customer_name) AS cust
         FROM invoices
         WHERE user_id = ? AND xero_id IS NOT NULL AND date BETWEEN ? AND ?`,
        [xeroUid, from, to]
      );
      totalPayments  = parseFloat(rows[0]?.pay || 0);
      const cFromInv  = parseInt(rows[0]?.cust || 0);
      const [c] = await safeQuery(
        `SELECT COUNT(*) AS v FROM customers WHERE user_id = ? AND xero_id IS NOT NULL`,
        [xeroUid]
      );
      totalCustomers = Math.max(parseInt(c?.v || 0), cFromInv);
    }

    if (!zohoLocalOk && hasInvoices) {
      const rows = await safeQuery(
        `SELECT COALESCE(SUM(balance),0) AS v FROM invoices
         WHERE user_id = ? AND qbo_id IS NULL AND xero_id IS NULL AND balance > 0${orgF}`, [uid, ...orgP]
      );
      outstandingReceivables = parseFloat(rows[0]?.v || 0);
    } else if (!zohoLocalOk && hasQbo) {
      // Prefer the QB Chart of Accounts A/R balance (point-in-time, authoritative)
      const [ar] = await safeQuery(
        `SELECT COALESCE(SUM(current_balance_with_sub_accounts),0) AS v
         FROM qbo_accounts
         WHERE user_id = ? AND account_type = 'Accounts Receivable' AND active = 1`,
        [qboUid]
      );
      outstandingReceivables = parseFloat(ar?.v || 0);
      // Fallback to invoice-balance sum if there's no A/R account row
      if (!outstandingReceivables) {
        const [r] = await safeQuery(
          `SELECT COALESCE(SUM(balance),0) AS v FROM invoices
           WHERE user_id = ? AND qbo_id IS NOT NULL AND balance > 0`,
          [qboUid]
        );
        outstandingReceivables = parseFloat(r?.v || 0);
      }
    } else if (hasXero) {
      // Xero: sum balances of accounts with type='RECEIVABLE' or class='ASSET' + name like A/R
      const [ar] = await safeQuery(
        `SELECT COALESCE(SUM(balance),0) AS v FROM xero_accounts
         WHERE user_id = ? AND status = 'ACTIVE'
           AND (type IN ('CURRENT','RECEIVABLE') AND name LIKE '%Receivable%')`,
        [xeroUid]
      );
      outstandingReceivables = parseFloat(ar?.v || 0);
      if (!outstandingReceivables) {
        const [r] = await safeQuery(
          `SELECT COALESCE(SUM(balance),0) AS v FROM invoices
           WHERE user_id = ? AND xero_id IS NOT NULL AND balance > 0`,
          [xeroUid]
        );
        outstandingReceivables = parseFloat(r?.v || 0);
      }
    }

    // ── Cash on Hand — shared single source of truth (resolveCashOnHand). The
    // detail panel (GET /kpi/cash) and the burn tile (GET /kpi/burn) derive cash
    // from the SAME function, so the summary card total, the bank count and the
    // per-account breakdown always agree. Not floored: a genuinely negative
    // position shows as negative on both the card and the detail panel.
    // Scoped "as of" the selected period's end date (capped at today, since we
    // can't know a future balance) so the card actually moves with the filter —
    // same as-of pattern as the Balance Sheet / Aging reports.
    const todayStr = new Date().toISOString().slice(0, 10);
    const asOfDate = to && to < todayStr ? to : todayStr;
    const cash = await resolveCashOnHand(av, uid, activeOrgId, asOfDate);
    const cashOnHand = cash.total;
    const bankCount  = cash.bankCount;

    // ── Burn rate: average monthly expenses over the SELECTED period (same
    // totalExpenses already resolved per-provider above, and the same period-
    // average approach GET /kpi/burn uses), so the tile moves with the filter
    // instead of always showing a trailing-N-months-from-today figure.
    const monthCount = Math.max(1, monthKeysBetween(from, to).length);
    const monthlyBurn = opexForBurn / monthCount 
    let runwayMonths = null;
    if (monthlyBurn > 0 && cashOnHand > 0) {
      const raw = cashOnHand / monthlyBurn;
      // Cap at 60 months — anything beyond 5 years isn't actionable
      runwayMonths = parseFloat(Math.min(raw, 60).toFixed(1));
    }

    return res.json({
      data: {
        totalRevenue, totalExpenses, totalPayments,
        totalInvoices, totalCustomers, outstandingReceivables,
        cashOnHand, bankCount, monthlyBurn, runwayMonths,
        currency,
        periodFrom: from, periodTo: to,
      },
    });
  } catch (err) {
    console.error('Dashboard stats error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/dashboard/revenue-trend ─────────────────────────────────────────
router.get('/revenue-trend', async (req, res) => {
  try {
    const uid = req.user.id;
    const { from, to } = getDateRange(req.query);
    const { hasAcctTxn, hasInvoices, hasQbo, qboUid, hasXero, xeroUid, hasZohoLive, zohoOrgId, zohoUid } = await dataAvailability(uid, req.orgId, req.adminUserId || null);
    const activeOrgId = req.orgId || zohoOrgId || null;
    const orgF = activeOrgId ? ' AND org_id = ?' : '';
    const orgP = activeOrgId ? [activeOrgId] : [];
    const zbUid = zohoUid || uid;

    let rows = [];
    // Zoho-live: revenue trend from zb_invoices (accrual basis — same source
    // as the main /api/dashboard totalRevenue so the trend chart matches the KPI).
    if (hasZohoLive) {
      rows = await safeQuery(
        `SELECT DATE_FORMAT(date,'%Y-%m') AS month, COALESCE(SUM(total),0) AS revenue
         FROM invoices
         WHERE user_id = ? AND (is_deleted=0 OR is_deleted IS NULL)
           AND date BETWEEN ? AND ?${orgF}
         GROUP BY month ORDER BY month ASC`, [zbUid, from, to, ...orgP]
      );
    }
    if (rows.length === 0 && hasAcctTxn) {
      // Use NET income (credit − debit) to match the P&L Report's calculation.
      // Old approach summed only gross credits which overstated revenue.
      rows = await safeQuery(
        `SELECT DATE_FORMAT(transaction_date,'%Y-%m') AS month,
                COALESCE(SUM(CASE WHEN account_type_code = 'other_income' THEN 0
                    ELSE COALESCE(base_credit, credit) - COALESCE(base_debit, debit) END), 0) AS revenue
         FROM account_transactions
         WHERE user_id = ? AND account_group = 'income'
           AND transaction_date BETWEEN ? AND ?${orgF}
         GROUP BY month ORDER BY month ASC`, [uid, from, to, ...orgP]
      );
    }
    if (rows.length === 0 && hasInvoices) {
      rows = await safeQuery(
        `SELECT DATE_FORMAT(date,'%Y-%m') AS month, COALESCE(SUM(total),0) AS revenue
         FROM invoices WHERE user_id = ? AND qbo_id IS NULL AND xero_id IS NULL AND date BETWEEN ? AND ?${orgF}
         GROUP BY month ORDER BY month ASC`, [uid, from, to, ...orgP]
      );
    }
    if (rows.length === 0 && hasQbo) {
      rows = await safeQuery(
        `SELECT DATE_FORMAT(date,'%Y-%m') AS month, COALESCE(SUM(total),0) AS revenue
         FROM invoices WHERE user_id = ? AND qbo_id IS NOT NULL AND date BETWEEN ? AND ?
         GROUP BY month ORDER BY month ASC`, [qboUid, from, to]
      );
    }
    if (rows.length === 0 && hasXero) {
      rows = await safeQuery(
        `SELECT DATE_FORMAT(date,'%Y-%m') AS month, COALESCE(SUM(total),0) AS revenue
         FROM invoices WHERE user_id = ? AND xero_id IS NOT NULL AND date BETWEEN ? AND ?
         GROUP BY month ORDER BY month ASC`, [xeroUid, from, to]
      );
    }
    const filled = zeroFillMonths(rows, monthKeysBetween(from, to), 'month', (ym, r) => ({
      month:   ym,
      revenue: Math.round(parseFloat(r?.revenue || 0)),
    }));
    return res.json({ data: filled });
  } catch (err) {
    console.error('Revenue trend error:', err.message);
    return res.json({ data: [] });
  }
});

// ── GET /api/dashboard/expense-trend ─────────────────────────────────────────
router.get('/expense-trend', async (req, res) => {
  try {
    const uid = req.user.id;
    const { from, to } = getDateRange(req.query);
    const { hasAcctTxn, hasQbo, qboUid, hasXero, xeroUid, hasZohoLive, zohoOrgId, zohoUid } = await dataAvailability(uid, req.orgId, req.adminUserId || null);
    const activeOrgId = req.orgId || zohoOrgId || null;
    const orgF = activeOrgId ? ' AND org_id = ?' : '';
    const orgP = activeOrgId ? [activeOrgId] : [];
    const zbUid = zohoUid || uid;

    let rows = [];
    // Zoho-live: expense trend from zb_bills (accrual basis — same source as the
    // main /api/dashboard totalExpenses so the trend chart matches the KPI).
    if (hasZohoLive) {
      rows = await safeQuery(
        `SELECT DATE_FORMAT(date,'%Y-%m') AS month, COALESCE(SUM(total),0) AS expenses
         FROM bills
         WHERE user_id = ? AND (is_deleted=0 OR is_deleted IS NULL)
           AND date BETWEEN ? AND ?${orgF}
         GROUP BY month ORDER BY month ASC`, [zbUid, from, to, ...orgP]
      );
    }
    if (rows.length === 0 && hasAcctTxn) {
      // Use NET expense (debit − credit) to match the P&L Report's calculation.
      // Old approach summed only gross debits which overstated expenses.
      rows = await safeQuery(
        `SELECT DATE_FORMAT(transaction_date,'%Y-%m') AS month,
                COALESCE(SUM(COALESCE(base_debit, debit) - COALESCE(base_credit, credit)), 0) AS expenses
         FROM account_transactions
         WHERE user_id = ? AND account_group = 'expense'
           AND transaction_date BETWEEN ? AND ?${orgF}
         GROUP BY month ORDER BY month ASC`, [uid, from, to, ...orgP]
      );
    }
    if (rows.length === 0 && hasQbo) {
      rows = await safeQuery(
        `SELECT DATE_FORMAT(expense_date,'%Y-%m') AS month, COALESCE(SUM(amount),0) AS expenses
         FROM expense_entries WHERE user_id = ? AND qbo_id IS NOT NULL AND expense_date BETWEEN ? AND ?
         GROUP BY month ORDER BY month ASC`, [qboUid, from, to]
      );
    }
    if (rows.length === 0 && hasXero) {
      rows = await safeQuery(
        `SELECT DATE_FORMAT(expense_date,'%Y-%m') AS month, COALESCE(SUM(amount),0) AS expenses
         FROM expense_entries WHERE user_id = ? AND xero_id IS NOT NULL AND expense_date BETWEEN ? AND ?
         GROUP BY month ORDER BY month ASC`, [xeroUid, from, to]
      );
    }
    if (rows.length === 0 && !hasZohoLive && !hasAcctTxn && !hasQbo && !hasXero) {
      rows = await safeQuery(
        `SELECT DATE_FORMAT(expense_date,'%Y-%m') AS month, COALESCE(SUM(amount),0) AS expenses
         FROM expense_entries WHERE user_id = ? AND qbo_id IS NULL AND xero_id IS NULL AND expense_date BETWEEN ? AND ?${orgF}
         GROUP BY month ORDER BY month ASC`, [uid, from, to, ...orgP]
      );
    }
    const filled = zeroFillMonths(rows, monthKeysBetween(from, to), 'month', (ym, r) => ({
      month:    ym,
      expenses: Math.round(parseFloat(r?.expenses || 0)),
    }));
    return res.json({ data: filled });
  } catch (err) {
    console.error('Expense trend error:', err.message);
    return res.json({ data: [] });
  }
});

// ── GET /api/dashboard/cashflow-trend ────────────────────────────────────────
router.get('/cashflow-trend', async (req, res) => {
  try {
    const uid = req.user.id;
    const { from, to } = getDateRange(req.query);
    const { hasBankTxn, hasAcctTxn, hasQbo, qboUid, hasXero, xeroUid, hasZohoLive } = await dataAvailability(uid, req.orgId, req.adminUserId || null);
    const orgF = req.orgId ? ' AND org_id = ?' : '';
    const orgP = req.orgId ? [req.orgId] : [];

    let rows = [];
    // Zoho-live: cash movement from the synced `bank_transactions`.
    // Zoho bank convention (verified against data): customer_payment = debit (money in),
    // vendor_payment/expense = credit (money out). So debit = inflow, credit = outflow.
    if (hasZohoLive) {
      rows = await safeQuery(
        `SELECT DATE_FORMAT(transaction_date,'%Y-%m') AS month,
                COALESCE(SUM(CASE WHEN debit_or_credit = 'debit'  THEN amount ELSE 0 END), 0) AS inflow,
                COALESCE(SUM(CASE WHEN debit_or_credit = 'credit' THEN amount ELSE 0 END), 0) AS outflow
         FROM bank_transactions
         WHERE user_id = ? AND transaction_date BETWEEN ? AND ?${orgF}
         GROUP BY month ORDER BY month ASC`, [uid, from, to, ...orgP]
      );
    }
    if (rows.length === 0 && hasBankTxn) {
      rows = await safeQuery(
        `SELECT DATE_FORMAT(transaction_date,'%Y-%m') AS month,
                COALESCE(SUM(CASE WHEN debit_or_credit = 'debit'  THEN amount ELSE 0 END), 0) AS inflow,
                COALESCE(SUM(CASE WHEN debit_or_credit = 'credit' THEN amount ELSE 0 END), 0) AS outflow
         FROM bank_transactions
         WHERE user_id = ? AND transaction_date BETWEEN ? AND ?${orgF}
         GROUP BY month ORDER BY month ASC`, [uid, from, to, ...orgP]
      );
    }
    if (rows.length === 0 && hasAcctTxn) {
      rows = await safeQuery(
        `SELECT DATE_FORMAT(transaction_date,'%Y-%m') AS month,
                COALESCE(SUM(CASE WHEN account_group = 'income'  AND COALESCE(base_credit, credit) > 0 THEN COALESCE(base_credit, credit) ELSE 0 END), 0) AS inflow,
                COALESCE(SUM(CASE WHEN account_group = 'expense' AND COALESCE(base_debit, debit) > 0 THEN COALESCE(base_debit, debit)  ELSE 0 END), 0) AS outflow
         FROM account_transactions
         WHERE user_id = ? AND transaction_date BETWEEN ? AND ?${orgF}
         GROUP BY month ORDER BY month ASC`, [uid, from, to, ...orgP]
      );
    }
    if (rows.length === 0 && hasQbo) {
      // QB: inflow = invoices paid amount (total - balance), outflow = expense_entries amount
      const inRows = await safeQuery(
        `SELECT DATE_FORMAT(date,'%Y-%m') AS month, COALESCE(SUM(total-balance),0) AS inflow
         FROM invoices WHERE user_id = ? AND qbo_id IS NOT NULL AND date BETWEEN ? AND ?
         GROUP BY month ORDER BY month ASC`, [qboUid, from, to]
      );
      const outRows = await safeQuery(
        `SELECT DATE_FORMAT(expense_date,'%Y-%m') AS month, COALESCE(SUM(amount),0) AS outflow
         FROM expense_entries WHERE user_id = ? AND qbo_id IS NOT NULL AND expense_date BETWEEN ? AND ?
         GROUP BY month ORDER BY month ASC`, [qboUid, from, to]
      );
      const map = {};
      for (const r of inRows)  map[r.month] = { month: r.month, inflow: parseFloat(r.inflow), outflow: 0 };
      for (const r of outRows) {
        if (map[r.month]) map[r.month].outflow = parseFloat(r.outflow);
        else map[r.month] = { month: r.month, inflow: 0, outflow: parseFloat(r.outflow) };
      }
      rows = Object.values(map).sort((a, b) => a.month.localeCompare(b.month));
    }
    if (rows.length === 0 && hasXero) {
      const inRows = await safeQuery(
        `SELECT DATE_FORMAT(date,'%Y-%m') AS month, COALESCE(SUM(total-balance),0) AS inflow
         FROM invoices WHERE user_id = ? AND xero_id IS NOT NULL AND date BETWEEN ? AND ?
         GROUP BY month ORDER BY month ASC`, [xeroUid, from, to]
      );
      const outRows = await safeQuery(
        `SELECT DATE_FORMAT(expense_date,'%Y-%m') AS month, COALESCE(SUM(amount),0) AS outflow
         FROM expense_entries WHERE user_id = ? AND xero_id IS NOT NULL AND expense_date BETWEEN ? AND ?
         GROUP BY month ORDER BY month ASC`, [xeroUid, from, to]
      );
      const map = {};
      for (const r of inRows)  map[r.month] = { month: r.month, inflow: parseFloat(r.inflow), outflow: 0 };
      for (const r of outRows) {
        if (map[r.month]) map[r.month].outflow = parseFloat(r.outflow);
        else map[r.month] = { month: r.month, inflow: 0, outflow: parseFloat(r.outflow) };
      }
      rows = Object.values(map).sort((a, b) => a.month.localeCompare(b.month));
    }
    if (rows.length === 0 && !hasZohoLive && !hasBankTxn && !hasAcctTxn && !hasQbo && !hasXero) {
      const inRows  = await safeQuery(
        `SELECT DATE_FORMAT(date,'%Y-%m') AS month, COALESCE(SUM(total-balance),0) AS inflow
         FROM invoices WHERE user_id = ? AND qbo_id IS NULL AND xero_id IS NULL AND date BETWEEN ? AND ?${orgF}
         GROUP BY month ORDER BY month ASC`, [uid, from, to, ...orgP]
      );
      const outRows = await safeQuery(
        `SELECT DATE_FORMAT(expense_date,'%Y-%m') AS month, COALESCE(SUM(amount),0) AS outflow
         FROM expense_entries WHERE user_id = ? AND qbo_id IS NULL AND xero_id IS NULL AND expense_date BETWEEN ? AND ?${orgF}
         GROUP BY month ORDER BY month ASC`, [uid, from, to, ...orgP]
      );
      const map = {};
      for (const r of inRows)  map[r.month] = { month: r.month, inflow: parseFloat(r.inflow), outflow: 0 };
      for (const r of outRows) {
        if (map[r.month]) map[r.month].outflow = parseFloat(r.outflow);
        else map[r.month] = { month: r.month, inflow: 0, outflow: parseFloat(r.outflow) };
      }
      rows = Object.values(map).sort((a, b) => a.month.localeCompare(b.month));
    }
    const filled = zeroFillMonths(rows, monthKeysBetween(from, to), 'month', (ym, r) => ({
      month:   ym,
      inflow:  Math.round(parseFloat(r?.inflow || 0)),
      outflow: Math.round(parseFloat(r?.outflow || 0)),
    }));
    return res.json({ data: filled });
  } catch (err) {
    console.error('Cashflow trend error:', err.message);
    return res.json({ data: [] });
  }
});

// ── GET /api/dashboard/top-customers ─────────────────────────────────────────
router.get('/top-customers', async (req, res) => {
  try {
    const uid = req.user.id;
    const { from, to } = getDateRange(req.query);
    const limit = Math.min(parseInt(req.query.limit || '10'), 50);
    const { hasAcctTxn, hasInvoices, hasQbo, qboUid, hasXero, xeroUid, hasZohoLive } = await dataAvailability(uid, req.orgId, req.adminUserId || null);
    const orgF = req.orgId ? ' AND org_id = ?' : '';
    const orgP = req.orgId ? [req.orgId] : [];

    let rows = [];
    // Zoho-live: pull from the synced warehouse `zb_invoices` so the full Zoho
    // sales history surfaces (not just the few rows in the legacy `invoices`
    // table). This is what makes Top Customers populate with the same names the
    // Reports page shows.
    if (hasZohoLive) {
      rows = await safeQuery(
        `SELECT customer_name,
                COUNT(*) AS invoiceCount,
                COALESCE(SUM(total), 0) AS totalRevenue
         FROM invoices
         WHERE user_id = ? AND customer_name IS NOT NULL AND customer_name <> ''
           AND date BETWEEN ? AND ?${orgF}
         GROUP BY customer_name
         ORDER BY totalRevenue DESC LIMIT ${limit}`, [uid, from, to, ...orgP]
      );
    }
    if (rows.length === 0 && hasAcctTxn) {
      rows = await safeQuery(
        `SELECT COALESCE(NULLIF(transaction_details,''), 'Unknown') AS customer_name,
                COUNT(DISTINCT transaction_id) AS invoiceCount,
                COALESCE(SUM(COALESCE(base_credit, credit)), 0) AS totalRevenue
         FROM account_transactions
         WHERE user_id = ? AND account_group = 'income'
           AND (account_type_code IS NULL OR account_type_code <> 'other_income')
           AND COALESCE(base_credit, credit) > 0
           AND transaction_date BETWEEN ? AND ?${orgF}
         GROUP BY customer_name
         ORDER BY totalRevenue DESC LIMIT ${limit}`, [uid, from, to, ...orgP]
      );
    }
    if (rows.length === 0 && hasInvoices) {
      rows = await safeQuery(
        `SELECT customer_name, COUNT(*) AS invoiceCount, COALESCE(SUM(total),0) AS totalRevenue
         FROM invoices WHERE user_id = ? AND qbo_id IS NULL AND xero_id IS NULL AND date BETWEEN ? AND ?${orgF}
         GROUP BY customer_name ORDER BY totalRevenue DESC LIMIT ${limit}`, [uid, from, to, ...orgP]
      );
    }
    if (rows.length === 0 && hasQbo) {
      rows = await safeQuery(
        `SELECT customer_name, COUNT(*) AS invoiceCount, COALESCE(SUM(total),0) AS totalRevenue
         FROM invoices WHERE user_id = ? AND qbo_id IS NOT NULL AND date BETWEEN ? AND ?
         GROUP BY customer_name ORDER BY totalRevenue DESC LIMIT ${limit}`, [qboUid, from, to]
      );
    }
    if (rows.length === 0 && hasXero) {
      rows = await safeQuery(
        `SELECT customer_name, COUNT(*) AS invoiceCount, COALESCE(SUM(total),0) AS totalRevenue
         FROM invoices WHERE user_id = ? AND xero_id IS NOT NULL AND date BETWEEN ? AND ?
         GROUP BY customer_name ORDER BY totalRevenue DESC LIMIT ${limit}`, [xeroUid, from, to]
      );
    }
    return res.json({ data: rows });
  } catch (err) {
    console.error('Top customers error:', err.message);
    return res.json({ data: [] });
  }
});

// ── GET /api/dashboard/top-vendors ───────────────────────────────────────────
router.get('/top-vendors', async (req, res) => {
  try {
    const uid = req.user.id;
    const { from, to } = getDateRange(req.query);
    const limit = Math.min(parseInt(req.query.limit || '10'), 50);
    const { hasAcctTxn, hasQbo, qboUid, hasXero, xeroUid, hasZohoLive } = await dataAvailability(uid, req.orgId, req.adminUserId || null);
    const orgF = req.orgId ? ' AND org_id = ?' : '';
    const orgP = req.orgId ? [req.orgId] : [];

    let rows = [];
    // Zoho-live: use the warehouse `zb_bills` so the full bill history shows up.
    if (hasZohoLive) {
      rows = await safeQuery(
        `SELECT vendor_name,
                COUNT(*) AS billCount,
                COALESCE(SUM(total), 0) AS totalAmount
         FROM bills
         WHERE user_id = ? AND vendor_name IS NOT NULL AND vendor_name <> ''
           AND date BETWEEN ? AND ?${orgF}
         GROUP BY vendor_name
         ORDER BY totalAmount DESC LIMIT ${limit}`, [uid, from, to, ...orgP]
      );
    }
    if (rows.length === 0 && hasAcctTxn) {
      rows = await safeQuery(
        `SELECT COALESCE(NULLIF(transaction_details,''), 'Unknown') AS vendor_name,
                COUNT(DISTINCT transaction_id) AS billCount,
                COALESCE(SUM(COALESCE(base_debit, debit)), 0) AS totalAmount
         FROM account_transactions
         WHERE user_id = ? AND account_group = 'expense' AND COALESCE(base_debit, debit) > 0
           AND transaction_date BETWEEN ? AND ?${orgF}
         GROUP BY vendor_name
         ORDER BY totalAmount DESC LIMIT ${limit}`, [uid, from, to, ...orgP]
      );
    }
    if (rows.length === 0 && hasQbo) {
      rows = await safeQuery(
        `SELECT COALESCE(NULLIF(vendor_name,''), 'Unknown') AS vendor_name,
                COUNT(*) AS billCount, COALESCE(SUM(amount),0) AS totalAmount
         FROM expense_entries
         WHERE user_id = ? AND qbo_id IS NOT NULL AND expense_date BETWEEN ? AND ?
         GROUP BY vendor_name ORDER BY totalAmount DESC LIMIT ${limit}`, [qboUid, from, to]
      );
    }
    if (rows.length === 0 && hasXero) {
      rows = await safeQuery(
        `SELECT COALESCE(NULLIF(vendor_name,''), 'Unknown') AS vendor_name,
                COUNT(*) AS billCount, COALESCE(SUM(amount),0) AS totalAmount
         FROM expense_entries
         WHERE user_id = ? AND xero_id IS NOT NULL AND expense_date BETWEEN ? AND ?
         GROUP BY vendor_name ORDER BY totalAmount DESC LIMIT ${limit}`, [xeroUid, from, to]
      );
    }
    if (rows.length === 0) {
      rows = await safeQuery(
        `SELECT vendor_name, COUNT(*) AS billCount, COALESCE(SUM(total),0) AS totalAmount
         FROM bills WHERE user_id = ? AND qbo_id IS NULL AND xero_id IS NULL AND date BETWEEN ? AND ?${orgF}
         GROUP BY vendor_name ORDER BY totalAmount DESC LIMIT ${limit}`, [uid, from, to, ...orgP]
      );
    }
    return res.json({ data: rows });
  } catch (err) {
    console.error('Top vendors error:', err.message);
    return res.json({ data: [] });
  }
});

// ── GET /api/dashboard/expense-breakdown ─────────────────────────────────────
router.get('/expense-breakdown', async (req, res) => {
  try {
    const uid = req.user.id;
    const { from, to } = getDateRange(req.query);
    const av = await dataAvailability(uid, req.orgId, req.adminUserId || null);
    const { hasZohoLive, zohoOrgId, zohoUid, hasAcctTxn, hasQbo, qboUid, hasXero, xeroUid } = av;

    // Same provider priority the rest of this file already uses
    // (Zoho-live > generic posted ledger > QuickBooks > Xero) to pick the
    // (effective user, org) pair, then source the category breakdown from
    // the P&L engine's own account buckets (aggregatePL — the exact same
    // classification computePLFigures/the P&L Report use), so categories are
    // real GL account names, not a bank-transaction offset label (which is
    // frequently blank and used to fall through to "Other").
    let effUid = null, orgId = null;
    if (hasZohoLive) { effUid = zohoUid; orgId = req.orgId || zohoOrgId; }
    else if (hasAcctTxn) {
      effUid = uid; orgId = req.orgId || null;
      if (!orgId) {
        const [[t]] = await pool.execute(
          'SELECT org_id FROM account_transactions WHERE user_id=? AND org_id IS NOT NULL LIMIT 1', [uid]
        ).catch(() => [[]]);
        orgId = t?.org_id || null;
      }
    } else if (hasQbo) {
      effUid = qboUid;
      const [[t]] = await pool.execute(
        'SELECT realm_id FROM qbo_tokens WHERE user_id=? AND realm_id IS NOT NULL LIMIT 1', [qboUid]
      ).catch(() => [[]]);
      orgId = t?.realm_id || null;
    } else if (hasXero) {
      effUid = xeroUid;
      const [[t]] = await pool.execute(
        'SELECT tenant_id FROM xero_tokens WHERE user_id=? AND tenant_id IS NOT NULL LIMIT 1', [xeroUid]
      ).catch(() => [[]]);
      orgId = t?.tenant_id || null;
    }

    let rows = [];
    if (effUid && orgId) {
      const buckets = await aggregatePL(effUid, orgId, null, from, to);
      const catMap = new Map();
      for (const key of ['operating_expense', 'other_expense']) {
        const b = buckets[key];
        if (!b) continue;
        for (const { accountName, net } of b.accounts.values()) {
          catMap.set(accountName, (catMap.get(accountName) || 0) + net);
        }
      }
      let cats = [...catMap.entries()]
        .map(([account_name, totalAmount]) => ({ account_name, totalAmount: Math.round(totalAmount) }))
        .filter((r) => r.totalAmount !== 0)
        .sort((a, b) => b.totalAmount - a.totalAmount);
      if (cats.length > 6) {
        const otherSum = cats.slice(6).reduce((s, r) => s + r.totalAmount, 0);
        cats = otherSum !== 0 ? [...cats.slice(0, 6), { account_name: 'Other', totalAmount: otherSum }] : cats.slice(0, 6);
      }
      rows = cats;
    }
    return res.json({ data: rows });
  } catch (err) {
    console.error('Expense breakdown error:', err.message);
    return res.json({ data: [] });
  }
});

// ── GET /api/dashboard/activity ──────────────────────────────────────────────
router.get('/activity', async (req, res) => {
  try {
    const uid = req.user.id;
    const { hasAcctTxn, hasInvoices, hasBankTxn, hasQbo, qboUid, hasXero, xeroUid, hasZohoLive } = await dataAvailability(uid, req.orgId, req.adminUserId || null);

    // Cascade — Zoho-live (warehouse) → Zoho legacy → QB → Xero
    const useZb   = hasZohoLive;
    const useQbo  = !useZb && !(hasAcctTxn || hasInvoices || hasBankTxn) && hasQbo;
    const useXero = !useZb && !(hasAcctTxn || hasInvoices || hasBankTxn) && !hasQbo && hasXero;
    const scopeUid = useQbo ? qboUid : useXero ? xeroUid : uid;
    // Org scope applies only to the Zoho path (req.orgId is null for QB/Xero users).
    const zohoOrg = (useQbo || useXero) ? null : req.orgId;
    const orgF = zohoOrg ? ' AND org_id = ?' : '';
    const orgP = zohoOrg ? [zohoOrg] : [];
    const invFilter = useQbo
      ? 'AND qbo_id IS NOT NULL'
      : useXero
        ? 'AND xero_id IS NOT NULL'
        : 'AND qbo_id IS NULL AND xero_id IS NULL';

    // Recent invoices (scoped) — Zoho-live pulls from the synced warehouse.
    const invItems = useZb
      ? await safeQuery(
          `SELECT invoice_number, customer_name, total, date
           FROM invoices WHERE user_id = ?${orgF}
           ORDER BY date DESC, id DESC LIMIT 5`,
          [uid, ...orgP]
        )
      : await safeQuery(
          `SELECT invoice_number, customer_name, total, date
           FROM invoices WHERE user_id = ? ${invFilter}${orgF}
           ORDER BY date DESC, id DESC LIMIT 5`,
          [scopeUid, ...orgP]
        );

    // Recent bank transactions (Zoho only — QB/Xero have no bank_transactions sync)
    const bankItems = useZb
      ? await safeQuery(
          `SELECT transaction_type_formatted, payee, amount, debit_or_credit, transaction_date
           FROM bank_transactions WHERE user_id = ?${orgF}
           ORDER BY transaction_date DESC, id DESC LIMIT 5`,
          [uid, ...orgP]
        )
      : (useQbo || useXero) ? [] : await safeQuery(
          `SELECT transaction_type_formatted, payee, amount, debit_or_credit, transaction_date
           FROM bank_transactions WHERE user_id = ?${orgF}
           ORDER BY transaction_date DESC, id DESC LIMIT 5`,
          [uid, ...orgP]
        );

    // For QB/Xero users, surface recent expense entries instead
    const expFilter = useQbo ? 'qbo_id IS NOT NULL' : useXero ? 'xero_id IS NOT NULL' : null;
    const expItems = expFilter ? await safeQuery(
      `SELECT vendor_name, amount, expense_date AS dt, account_name
       FROM expense_entries
       WHERE user_id = ? AND ${expFilter}
       ORDER BY expense_date DESC, id DESC LIMIT 5`,
      [scopeUid]
    ) : [];

    const now = Date.now();
    function relTime(dateStr) {
      if (!dateStr) return '?';
      const diff = Math.floor((now - new Date(dateStr)) / 1000);
      if (diff < 3600)    return `${Math.floor(diff / 60)}m`;
      if (diff < 86400)   return `${Math.floor(diff / 3600)}h`;
      if (diff < 2592000) return `${Math.floor(diff / 86400)}d`;
      return `${Math.floor(diff / 2592000)}mo`;
    }

    const all = [];

    invItems.forEach(inv => {
      all.push({
        t:      relTime(inv.date),
        rawDate: inv.date,
        icon:   'FileText',
        tone:   'blue',
        who:    'System',
        what:   'created invoice',
        target: `${inv.invoice_number || 'INV'} · ${inv.customer_name || ''}`,
      });
    });

    bankItems.forEach(txn => {
      const isIn = txn.debit_or_credit === 'debit';
      all.push({
        t:      relTime(txn.transaction_date),
        rawDate: txn.transaction_date,
        icon:   isIn ? 'ArrowDownLeft' : 'ArrowUpRight',
        tone:   isIn ? 'green' : 'amber',
        who:    'System',
        what:   isIn ? 'received payment' : 'made payment',
        target: `${txn.payee || txn.transaction_type_formatted || 'Transaction'} · ₹${Math.round(txn.amount || 0).toLocaleString('en-IN')}`,
      });
    });

    expItems.forEach(exp => {
      all.push({
        t:      relTime(exp.dt),
        rawDate: exp.dt,
        icon:   'ArrowUpRight',
        tone:   'amber',
        who:    'System',
        what:   'recorded expense',
        target: `${exp.vendor_name || exp.account_name || 'Expense'} · ₹${Math.round(exp.amount || 0).toLocaleString('en-IN')}`,
      });
    });

    all.sort((a, b) => new Date(b.rawDate) - new Date(a.rawDate));
    const data = all.slice(0, 6).map(({ rawDate, ...rest }) => rest);

    return res.json({ data });
  } catch (err) {
    console.error('Activity error:', err.message);
    return res.json({ data: [] });
  }
});

// ── GET /api/dashboard/profitability ─────────────────────────────────────────
router.get('/profitability', async (req, res) => {
  try {
    const uid = req.user.id;
    const { from, to } = getDateRange(req.query);
    const { hasAcctTxn, hasQbo, qboUid, hasXero, xeroUid, hasZohoLive, zohoOrgId, zohoUid } = await dataAvailability(uid, req.orgId, req.adminUserId || null);

    const basis   = getBasis(req.query);
    const useZb   = hasZohoLive;
    const useQbo  = !useZb && !hasAcctTxn && hasQbo;
    const useXero = !useZb && !hasAcctTxn && !hasQbo && hasXero;
    const scope   = useQbo ? qboUid : useXero ? xeroUid : uid;
    // Org scope applies only to the Zoho path (req.orgId is null for QB/Xero users).
    const activeOrgId = req.orgId || zohoOrgId || null;
    const zohoOrg = (useQbo || useXero) ? null : activeOrgId;
    const orgF = zohoOrg ? ' AND org_id = ?' : '';
    const orgP = zohoOrg ? [zohoOrg] : [];
    const zbUid = zohoUid || uid;

    let revenue = 0, expenses = 0;
    if (useZb) {
      // Revenue/expenses from the local general ledger (account_transactions) —
      // the same accrual P&L the GET /dashboard card uses, served from our DB so
      // there's no Zoho API call and no live-token dependency. revenue − expenses
      // === Net Profit/Loss, matching the Reports page.
      const [revRow] = await safeQuery(
        `SELECT COALESCE(SUM(COALESCE(base_credit, credit)),0) AS v FROM account_transactions
         WHERE user_id=? AND account_group='income' AND COALESCE(base_credit, credit) > 0
           AND transaction_date BETWEEN ? AND ?${orgF}`, [zbUid, from, to, ...orgP]
      );
      const [expRow] = await safeQuery(
        `SELECT COALESCE(SUM(COALESCE(base_debit, debit)),0) AS v FROM account_transactions
         WHERE user_id=? AND account_group='expense' AND COALESCE(base_debit, debit) > 0
           AND transaction_date BETWEEN ? AND ?${orgF}`, [zbUid, from, to, ...orgP]
      );
      revenue  = Math.round(parseFloat(revRow?.v || 0));
      expenses = Math.round(parseFloat(expRow?.v || 0));
    } else if (useQbo) {
      // Revenue/expenses from QuickBooks' own P&L → tie out to QB exactly.
      // revenue − expenses === QB Net Income. Fall back to synced docs on failure.
      let plOk = false;
      try {
        const pl = await qboProfitAndLoss(qboUid, from, to, basis);
        revenue  = Math.round(pl.revenue);
        expenses = Math.round(pl.expenses);
        plOk = true;
      } catch (err) {
        console.warn('[profitability] QB P&L fetch failed, falling back to synced docs:', err.message);
      }
      if (!plOk) {
        const [r1] = await safeQuery(
          `SELECT COALESCE(SUM(total),0) AS v FROM invoices
           WHERE user_id=? AND qbo_id IS NOT NULL AND date BETWEEN ? AND ?`, [scope, from, to]);
        const [r2] = await safeQuery(
          `SELECT COALESCE(SUM(amount),0) AS v FROM expense_entries
           WHERE user_id=? AND qbo_id IS NOT NULL AND expense_date BETWEEN ? AND ?`, [scope, from, to]);
        revenue  = Math.round(parseFloat(r1?.v || 0));
        expenses = Math.round(parseFloat(r2?.v || 0));
      }
    } else if (useXero) {
      const [r1] = await safeQuery(
        `SELECT COALESCE(SUM(total),0) AS v FROM invoices
         WHERE user_id=? AND xero_id IS NOT NULL AND date BETWEEN ? AND ?`,
        [scope, from, to]
      );
      const [r2] = await safeQuery(
        `SELECT COALESCE(SUM(amount),0) AS v FROM expense_entries
         WHERE user_id=? AND xero_id IS NOT NULL AND expense_date BETWEEN ? AND ?`,
        [scope, from, to]
      );
      revenue  = Math.round(parseFloat(r1?.v || 0));
      expenses = Math.round(parseFloat(r2?.v || 0));
    } else {
      const [revRow] = await safeQuery(
        `SELECT COALESCE(SUM(COALESCE(base_credit, credit)),0) AS v FROM account_transactions
         WHERE user_id=? AND account_group='income' AND COALESCE(base_credit, credit) > 0
           AND transaction_date BETWEEN ? AND ?${orgF}`, [uid, from, to, ...orgP]
      );
      revenue  = Math.round(parseFloat(revRow?.v || 0));
    }

    // Total Expenses = Operating Expense + Non-Operating Expense (excludes
    // COGS, per spec — moot today since every current client has COGS=0, a
    // services business) — sourced from the P&L engine's own canonical
    // buckets (computePLFigures, the same one the P&L Report / Ratios engine
    // use), not the branch-specific queries above, so this figure can't drift
    // from what the P&L Report shows. Falls back to whatever `expenses` the
    // branch above already computed if the org can't be resolved (e.g. a
    // brand-new connection with no account_transactions yet).
    try {
      let plEffUid = null, plOrgId = null;
      if (useZb) { plEffUid = zbUid; plOrgId = zohoOrg; }
      else if (useQbo) {
        plEffUid = qboUid;
        const [[t]] = await pool.execute('SELECT realm_id FROM qbo_tokens WHERE user_id=? AND realm_id IS NOT NULL LIMIT 1', [qboUid]).catch(() => [[]]);
        plOrgId = t?.realm_id || null;
      } else if (useXero) {
        plEffUid = xeroUid;
        const [[t]] = await pool.execute('SELECT tenant_id FROM xero_tokens WHERE user_id=? AND tenant_id IS NOT NULL LIMIT 1', [xeroUid]).catch(() => [[]]);
        plOrgId = t?.tenant_id || null;
      } else {
        plEffUid = uid;
        plOrgId = activeOrgId || (await pool.execute('SELECT org_id FROM account_transactions WHERE user_id=? AND org_id IS NOT NULL LIMIT 1', [uid]).catch(() => [[{}]]))[0]?.[0]?.org_id || null;
      }
      if (plEffUid && plOrgId) {
        const pl = await computePLFigures(plEffUid, plOrgId, null, from, to);
        expenses = Math.round(pl.opex + pl.otherExpense);
      }
    } catch (_) { /* keep the branch-computed `expenses` above */ }

    const netProfit   = revenue - expenses;
    const expenseRatio = revenue > 0 ? parseFloat(((expenses / revenue) * 100).toFixed(1)) : 0;
    const netMargin    = revenue > 0 ? parseFloat(((netProfit / revenue) * 100).toFixed(1)) : 0;

    // Trend spans the SELECTED period (from → to), so every chart lines up with
    // the chosen window (e.g. a financial year shows Apr → Mar) instead of a
    // rolling last-12-months window anchored to today.
    const trendRows = useZb
      ? await safeQuery(
          `SELECT ym,
                  COALESCE(SUM(rev),0) AS rev, COALESCE(SUM(exp),0) AS exp
           FROM (
             SELECT DATE_FORMAT(date,'%Y-%m') AS ym, total AS rev, 0 AS exp
               FROM invoices
              WHERE user_id=? AND (is_deleted=0 OR is_deleted IS NULL)${orgF}
                AND date BETWEEN ? AND ?
             UNION ALL
             SELECT DATE_FORMAT(date,'%Y-%m') AS ym, 0 AS rev, total AS exp
               FROM bills
              WHERE user_id=? AND (is_deleted=0 OR is_deleted IS NULL)${orgF}
                AND date BETWEEN ? AND ?
           ) u
           GROUP BY ym ORDER BY ym ASC`, [zbUid, ...orgP, from, to, zbUid, ...orgP, from, to]
        )
      : (useQbo || useXero)
      ? await safeQuery(
          `SELECT DATE_FORMAT(d,'%Y-%m') AS ym,
                  COALESCE(SUM(rev),0) AS rev, COALESCE(SUM(exp),0) AS exp
           FROM (
             SELECT date AS d, total AS rev, 0 AS exp FROM invoices
              WHERE user_id=? AND ${useQbo ? 'qbo_id IS NOT NULL' : 'xero_id IS NOT NULL'}
                AND date BETWEEN ? AND ?
             UNION ALL
             SELECT expense_date AS d, 0 AS rev, amount AS exp FROM expense_entries
              WHERE user_id=? AND ${useQbo ? 'qbo_id IS NOT NULL' : 'xero_id IS NOT NULL'}
                AND expense_date BETWEEN ? AND ?
           ) u
           GROUP BY ym ORDER BY ym ASC`, [scope, from, to, scope, from, to]
        )
      : await safeQuery(
          `SELECT DATE_FORMAT(transaction_date,'%Y-%m') AS ym,
                  COALESCE(SUM(CASE WHEN account_group='income'  AND COALESCE(base_credit, credit) > 0 THEN COALESCE(base_credit, credit) ELSE 0 END),0) AS rev,
                  COALESCE(SUM(CASE WHEN account_group='expense' AND COALESCE(base_debit, debit) > 0  THEN COALESCE(base_debit, debit)  ELSE 0 END),0) AS exp
           FROM account_transactions
           WHERE user_id=? AND transaction_date BETWEEN ? AND ?${orgF}
           GROUP BY ym ORDER BY ym ASC`, [uid, from, to, ...orgP]
        );

    const trend = zeroFillMonths(trendRows, monthKeysBetween(from, to), 'ym', (ym, r) => {
      const rev = Math.round(parseFloat(r?.rev || 0));
      const exp = Math.round(parseFloat(r?.exp || 0));
      return { month: shortMonth(ym), revenue: rev, expenses: exp, netProfit: rev - exp };
    });

    return res.json({ data: { revenue, expenses, netProfit, expenseRatio, netMargin, trend } });
  } catch (err) {
    console.error('Profitability error:', err.message);
    return res.json({ data: { revenue: 0, expenses: 0, netProfit: 0, expenseRatio: 0, netMargin: 0, trend: [] } });
  }
});

// ── GET /api/dashboard/liquidity ──────────────────────────────────────────────
router.get('/liquidity', async (req, res) => {
  try {
    const uid = req.user.id;
    const { from, to } = getDateRange(req.query);

    // Current Assets / Current Liabilities / Cash / AR / AP / Total Assets /
    // Total Equity all come from the Balance Sheet's own point-in-time engine
    // (keyRatiosService.computeKeyRatios → aggregateBS) — the SAME one behind
    // the Balance Sheet report, the Ratios page, and the Cash Flow Metrics
    // section — instead of a separate "latest balance per account" query that
    // always read as-of TODAY regardless of the selected period, blanket-
    // abs()'d every balance (masking a genuinely negative position), and
    // counted only Accounts Payable as "Current Liabilities" (missing Other
    // Current Liabilities and credit cards entirely).
    const av = await dataAvailability(uid, req.orgId, req.adminUserId || null);
    const { effUid, orgId, platform } = await resolveEffectiveOrgContext(av, uid, req);

    if (!effUid || !orgId) {
      return res.json({ data: { currentAssets: 0, currentLiabilities: 0, cash: 0, receivables: 0, payables: 0, workingCapital: 0, currentRatio: 0, quickRatio: 0, totalAssets: 0, totalLiabilities: 0, equity: 0, debtEquity: null, interestExpense: 0, interestCoverage: null } });
    }

    const { ratios, raw } = await computeKeyRatios(effUid, orgId, platform, from, to, 4);

    // Interest coverage = EBIT / Interest Expense, EBIT = Net Profit + Income
    // Tax + Interest Expense — the same formula used throughout this app's
    // Ratio Workings (adding tax and interest back to net profit).
    const ebit = raw.netProfit + raw.incomeTax + raw.interestExpense;
    const interestCoverage = raw.interestExpense > 0 ? parseFloat((ebit / raw.interestExpense).toFixed(2)) : null;

    return res.json({
      data: {
        currentAssets:      Math.round(raw.currentAssets),
        currentLiabilities: Math.round(raw.currentLiabilities),
        cash:               Math.round(raw.bankBalance),
        receivables:        Math.round(raw.accountsReceivable),
        payables:           Math.round(raw.accountsPayable),
        workingCapital:     ratios.workingCapital != null ? Math.round(ratios.workingCapital) : null,
        currentRatio:       ratios.currentRatio,
        quickRatio:         ratios.quickRatio,
        totalAssets:        Math.round(raw.totalAssets),
        totalLiabilities:   Math.round(raw.totalLiabilities),
        equity:             Math.round(raw.totalEquity),
        debtEquity:         ratios.debtToEquity,
        interestExpense:    Math.round(raw.interestExpense),
        interestCoverage,
      },
    });
  } catch (err) {
    console.error('Liquidity error:', err.message);
    return res.json({ data: { currentAssets: 0, currentLiabilities: 0, cash: 0, receivables: 0, payables: 0, workingCapital: 0, currentRatio: 0, quickRatio: 0, totalAssets: 0, totalLiabilities: 0, equity: 0, debtEquity: null, interestExpense: 0, interestCoverage: null } });
  }
});

// ── GET /api/dashboard/efficiency ────────────────────────────────────────────
router.get('/efficiency', async (req, res) => {
  try {
    const uid = req.user.id;
    const { from, to } = getDateRange(req.query);
    const orgF = req.orgId ? ' AND org_id = ?' : '';
    const orgP = req.orgId ? [req.orgId] : [];

    // AR/AP (invoices/bills) belong to the connection admin for company-owned
    // QuickBooks/Xero clients — scope those queries by the effective user_id.
    const av = await dataAvailability(uid, req.orgId, req.adminUserId || null);
    const { hasZohoLive, zohoUid, hasQbo, qboUid, hasXero, xeroUid } = av;
    const invUid = hasZohoLive ? (zohoUid || uid) : hasQbo ? qboUid : hasXero ? xeroUid : uid;
    const { orgId: agingOrgId } = await resolveEffectiveOrgContext(av, uid, req);

    const periodDays = Math.max(1, (new Date(to) - new Date(from)) / 86400000);

    const [revRow]  = await safeQuery(
      `SELECT COALESCE(SUM(COALESCE(base_credit, credit)),0) AS v FROM account_transactions
       WHERE user_id=? AND account_group='income' AND COALESCE(base_credit, credit) > 0
         AND transaction_date BETWEEN ? AND ?${orgF}`, [uid, from, to, ...orgP]
    );
    const [expRow]  = await safeQuery(
      `SELECT COALESCE(SUM(COALESCE(base_debit, debit)),0) AS v FROM account_transactions
       WHERE user_id=? AND account_group='expense' AND COALESCE(base_debit, debit) > 0
         AND transaction_date BETWEEN ? AND ?${orgF}`, [uid, from, to, ...orgP]
    );
    const [arRow]   = await safeQuery(`SELECT COALESCE(SUM(balance),0) AS v FROM invoices WHERE user_id=? AND balance>0${orgF}`, [invUid, ...orgP]);
    const [apRow]   = await safeQuery(`SELECT COALESCE(SUM(balance),0) AS v FROM bills    WHERE user_id=? AND balance>0${orgF}`, [invUid, ...orgP]);

    const latestRows = await safeQuery(
      `SELECT at1.account_group, at1.balance
       FROM account_transactions at1
       INNER JOIN (
         SELECT account_id, MAX(id) AS max_id
         FROM account_transactions WHERE user_id=?${orgF} GROUP BY account_id
       ) latest ON at1.account_id=latest.account_id AND at1.id=latest.max_id
       WHERE at1.user_id=? AND at1.account_group='asset'${req.orgId ? ' AND at1.org_id = ?' : ''}`, [uid, ...orgP, uid, ...orgP]
    );

    const receivables  = parseFloat(arRow?.v  || 0);
    const payables     = parseFloat(apRow?.v  || 0);
    let totalAssets  = latestRows.reduce((s, r) => s + Math.abs(parseFloat(r.balance || 0)), 0);

    let revenue  = parseFloat(revRow?.v  || 0);
    let expenses = parseFloat(expRow?.v  || 0);

    // For AR/AP days use all-time data scaled to annual to avoid absurd values on short periods
    const [allTimeRev] = await safeQuery(
      `SELECT COALESCE(SUM(COALESCE(base_credit, credit)),0) AS v,
              DATEDIFF(MAX(transaction_date), MIN(transaction_date))+1 AS span_days
       FROM account_transactions
       WHERE user_id=? AND account_group='income' AND COALESCE(base_credit, credit) > 0${orgF}`, [uid, ...orgP]
    );
    const [allTimeExp] = await safeQuery(
      `SELECT COALESCE(SUM(COALESCE(base_debit, debit)),0) AS v,
              DATEDIFF(MAX(transaction_date), MIN(transaction_date))+1 AS span_days
       FROM account_transactions
       WHERE user_id=? AND account_group='expense' AND COALESCE(base_debit, debit) > 0${orgF}`, [uid, ...orgP]
    );
    const allRevSpan = Math.max(1, parseFloat(allTimeRev?.span_days || 365));
    const allExpSpan = Math.max(1, parseFloat(allTimeExp?.span_days || 365));
    let annualRev  = (parseFloat(allTimeRev?.v || 0) / allRevSpan) * 365;
    let annualExp  = (parseFloat(allTimeExp?.v || 0) / allExpSpan) * 365;

    // ── Liabilities → equity (for ROE / Debt-driven ratios) ───────────────────
    // Equity = total assets − total liabilities (latest per-account balances),
    // since shareholders' equity is not stored as a discrete field.
    const liabRows = await safeQuery(
      `SELECT at1.balance
       FROM account_transactions at1
       INNER JOIN (
         SELECT account_id, MAX(id) AS max_id
         FROM account_transactions WHERE user_id=?${orgF} GROUP BY account_id
       ) latest ON at1.account_id=latest.account_id AND at1.id=latest.max_id
       WHERE at1.user_id=? AND at1.account_group='liability'${req.orgId ? ' AND at1.org_id = ?' : ''}`,
      [uid, ...orgP, uid, ...orgP]
    );
    let totalLiabilities = liabRows.reduce((s, r) => s + Math.abs(parseFloat(r.balance || 0)), 0);

    // QuickBooks/Xero write no dated general ledger here, so everything above
    // (totalAssets, totalLiabilities, revenue, expenses, annualRev/Exp) reads
    // as 0 for them — ROE, Cost to Income, Asset Turnover, AR/AP Days would
    // silently show null/0. Override with each provider's OWN live Balance
    // Sheet (totals) + P&L (revenue/expenses) report for the same period, so
    // these ratios tie out to the provider exactly instead of reading empty.
    if (hasQbo || hasXero) {
      const effUid = hasQbo ? qboUid : xeroUid;
      const bs = await providerBalanceSheetTotals(
        { provider: hasQbo ? 'quickbooks' : 'xero', conn: { effectiveUserId: effUid } }, to
      );
      if (bs) { totalAssets = bs.totalAssets; totalLiabilities = bs.totalLiabilities; }
      try {
        const pl = hasQbo
          ? await qboProfitAndLoss(effUid, from, to, 'accrual')
          : await xeroProfitAndLoss(effUid, from, to, 'accrual');
        revenue  = pl.revenue;
        expenses = pl.expenses;
        annualRev = (revenue  / periodDays) * 365;
        annualExp = (expenses / periodDays) * 365;
      } catch (err) {
        console.warn('[efficiency] provider P&L fetch failed:', err.message);
      }
    }

    // Standard formula: (balance / annual_total) * 365
    const arDays        = annualRev > 0 ? Math.round((receivables / annualRev) * 365) : 0;
    const apDays        = annualExp > 0 ? Math.round((payables    / annualExp) * 365) : 0;
    const assetTurnover = totalAssets > 0 && annualRev > 0
      ? parseFloat((annualRev / totalAssets).toFixed(2)) : 0;

    const equity           = totalAssets - totalLiabilities;
    const annualNetProfit  = annualRev - annualExp;
    const roe = equity > 0 ? parseFloat(((annualNetProfit / equity) * 100).toFixed(1)) : null;

    // ── Cost to Income ratio (period) ─────────────────────────────────────────
    const costToIncome = revenue > 0 ? parseFloat(((expenses / revenue) * 100).toFixed(1)) : null;

    // ── AR / AP ageing buckets ────────────────────────────────────────────────
    // Reuses the SAME point-in-time engine as the "AR Aging Summary" / "AP
    // Aging Summary" reports (salesArFromInvoicesService / zohoApAgingDetailService)
    // instead of a separate query that always bucketed by CURDATE() regardless
    // of the selected period — so moving the Dashboard's date picker never
    // actually moved these buckets, and invoices.balance/bills.balance is
    // today's LIVE balance, which can't reconstruct what was genuinely
    // outstanding on a past date. buildArAgingSummary rewinds post-as-of-date
    // payments (attachAsOfBalances) so a since-settled invoice still shows
    // correctly for a historical "to" date; the two report builders share the
    // exact same 9-bucket scale (AGING_BUCKETS), collapsed here into this
    // panel's 5 coarser buckets from the already-computed TOTAL row, so the
    // Dashboard can never disagree with the Reports-catalog aging reports for
    // the same as-of date.
    const collapseAging = (reportResult) => {
      const c = (reportResult.rows || []).find(r => r.isTotal)?.cells || {};
      const n = (v) => Number(v) || 0;
      return [
        { bucket: 'not_due', amount: Math.round(n(c.notdue)) },
        { bucket: '0_30',    amount: Math.round(n(c.d1_30)) },
        { bucket: '31_60',   amount: Math.round(n(c.d31_60)) },
        { bucket: '61_90',   amount: Math.round(n(c.d61_90)) },
        { bucket: 'over_90', amount: Math.round(n(c.d91_180) + n(c.d180_1y) + n(c.y1_2) + n(c.y2_3) + n(c.y_above)) },
      ];
    };
    let arAging = [], apAging = [];
    if (agingOrgId) {
      try {
        const [arReport, apReport] = await Promise.all([
          buildArAgingSummary(invUid, { org_id: agingOrgId, to_date: to }),
          buildApAgingSummary(invUid, { org_id: agingOrgId, to_date: to }),
        ]);
        arAging = collapseAging(arReport);
        apAging = collapseAging(apReport);
      } catch (err) {
        console.warn('[efficiency] AR/AP aging fetch failed:', err.message);
      }
    }

    // ── AR vs AP days · monthly trend (cohort by issue month) ─────────────────
    // No payment timestamp is stored, so settlement is proxied: settled docs
    // (balance<=0) at their due_date, outstanding docs at today. Amount-weighted
    // by document total → "days from issue to paid/today" per cohort month.
    const cohortDaysQuery = (table) => safeQuery(
      `SELECT DATE_FORMAT(date,'%Y-%m') AS ym,
              SUM(total * DATEDIFF(
                CASE WHEN balance<=0 THEN COALESCE(due_date,CURDATE()) ELSE CURDATE() END, date)) AS weighted,
              COALESCE(SUM(total),0) AS tot
       FROM ${table}
       WHERE user_id=? AND date IS NOT NULL
         AND date BETWEEN ? AND ?${orgF}
       GROUP BY ym`, [invUid, from, to, ...orgP]
    );
    const daysMap = (rows) => Object.fromEntries(rows.map(r => {
      const tot = parseFloat(r.tot || 0);
      const d   = tot > 0 ? Math.max(0, Math.min(365, Math.round(parseFloat(r.weighted || 0) / tot))) : 0;
      return [r.ym, d];
    }));
    const arDaysMap = daysMap(await cohortDaysQuery('invoices'));
    const apDaysMap = daysMap(await cohortDaysQuery('bills'));
    // Span the selected period (from → to) so the trend lines up with every chart.
    const trend = monthKeysBetween(from, to).map(ym => ({
      month:  shortMonth(ym),
      arDays: arDaysMap[ym] || 0,
      apDays: apDaysMap[ym] || 0,
    }));

    // ── Cash Conversion Cycle = DSO + DIO − DPO ───────────────────────────────
    // DIO = 0 (no inventory data); CCC collapses to DSO − DPO.
    const inventoryDays = 0;
    const ccc = arDays + inventoryDays - apDays;

    return res.json({
      data: {
        arDays, apDays, assetTurnover,
        receivables: Math.round(receivables),
        payables:    Math.round(payables),
        revenue:     Math.round(revenue),
        expenses:    Math.round(expenses),
        totalAssets: Math.round(totalAssets),
        totalLiabilities: Math.round(totalLiabilities),
        equity:      Math.round(equity),
        roe,
        costToIncome,
        arAging, apAging,
        trend,
        inventoryDays, ccc,
      },
    });
  } catch (err) {
    console.error('Efficiency error:', err.message);
    return res.json({ data: { arDays: 0, apDays: 0, assetTurnover: 0, receivables: 0, payables: 0, revenue: 0, expenses: 0, totalAssets: 0, totalLiabilities: 0, equity: 0, roe: null, costToIncome: null, arAging: [], apAging: [], trend: [], inventoryDays: 0, ccc: 0 } });
  }
});

// ── GET /api/dashboard/kpi/revenue ───────────────────────────────────────────
router.get('/kpi/revenue', async (req, res) => {
  try {
    const uid = req.user.id;
    const { from, to } = getDateRange(req.query);
    const basis = getBasis(req.query);
    const { hasZohoLive, zohoOrgId, zohoUid: _zohoUid, hasQbo, qboUid } = await dataAvailability(uid, req.orgId, req.adminUserId || null);
    const zbUid      = _zohoUid || uid;
    const activeOrgId = req.orgId || zohoOrgId || null;
    const orgF = activeOrgId ? ' AND org_id = ?' : '';
    const orgP = activeOrgId ? [activeOrgId] : [];

    const periodMs  = new Date(to) - new Date(from);
    const priorTo   = new Date(from); priorTo.setDate(priorTo.getDate() - 1);
    const priorFrom = new Date(priorTo - periodMs);
    const priorToStr   = priorTo.toISOString().slice(0, 10);
    const priorFromStr = priorFrom.toISOString().slice(0, 10);

    let current = 0, prior = 0, trend = [], topCustomers = [];

    if (hasZohoLive) {
      // ── Zoho path: use warehouse zb_invoices ──────────────────────────────
      const [curRow] = await safeQuery(
        `SELECT COALESCE(SUM(total),0) AS v FROM invoices
         WHERE user_id=? AND (is_deleted=0 OR is_deleted IS NULL)
           AND date BETWEEN ? AND ?${orgF}`, [zbUid, from, to, ...orgP]
      );
      const [priRow] = await safeQuery(
        `SELECT COALESCE(SUM(total),0) AS v FROM invoices
         WHERE user_id=? AND (is_deleted=0 OR is_deleted IS NULL)
           AND date BETWEEN ? AND ?${orgF}`, [zbUid, priorFromStr, priorToStr, ...orgP]
      );
      current = Math.round(parseFloat(curRow?.v || 0));
      prior   = Math.round(parseFloat(priRow?.v || 0));

      const trendRows = await safeQuery(
        `SELECT DATE_FORMAT(date,'%Y-%m') AS ym, COALESCE(SUM(total),0) AS revenue
         FROM invoices
         WHERE user_id=? AND (is_deleted=0 OR is_deleted IS NULL)
           AND date BETWEEN ? AND ?${orgF}
         GROUP BY ym ORDER BY ym ASC`, [zbUid, from, to, ...orgP]
      );
      trend = zeroFillMonths(trendRows, monthKeysBetween(from, to), 'ym', (ym, r) => ({
        month:   shortMonth(ym),
        revenue: Math.round(parseFloat(r?.revenue || 0)),
      }));

      const custRows = await safeQuery(
        `SELECT customer_name AS name, COALESCE(SUM(total),0) AS amount, COUNT(*) AS count
         FROM invoices
         WHERE user_id=? AND (is_deleted=0 OR is_deleted IS NULL)
           AND date BETWEEN ? AND ?${orgF}
         GROUP BY customer_name ORDER BY amount DESC LIMIT 5`, [zbUid, from, to, ...orgP]
      );
      topCustomers = custRows.map(r => ({ name: r.name, amount: Math.round(parseFloat(r.amount)), count: parseInt(r.count) }));
    } else if (hasQbo) {
      // ── QuickBooks path ───────────────────────────────────────────────────
      // Headline current/prior revenue from QuickBooks' own P&L (Total Income),
      // so the KPI ties out to QuickBooks exactly. Trend + top customers come
      // from the synced invoices (scoped to the effective QB user). If the live
      // report is unavailable, current/prior fall back to invoice sums.
      let plOk = false;
      try {
        const [pc, pp] = await Promise.all([
          qboProfitAndLoss(qboUid, from, to, basis),
          qboProfitAndLoss(qboUid, priorFromStr, priorToStr, basis),
        ]);
        current = Math.round(pc.revenue);
        prior   = Math.round(pp.revenue);
        plOk = true;
      } catch (err) {
        console.warn('[kpi/revenue] QB P&L fetch failed, falling back to synced docs:', err.message);
      }
      if (!plOk) {
        const [curRow] = await safeQuery(
          `SELECT COALESCE(SUM(total),0) AS v FROM invoices
           WHERE user_id=? AND qbo_id IS NOT NULL AND date BETWEEN ? AND ?`, [qboUid, from, to]);
        const [priRow] = await safeQuery(
          `SELECT COALESCE(SUM(total),0) AS v FROM invoices
           WHERE user_id=? AND qbo_id IS NOT NULL AND date BETWEEN ? AND ?`, [qboUid, priorFromStr, priorToStr]);
        current = Math.round(parseFloat(curRow?.v || 0));
        prior   = Math.round(parseFloat(priRow?.v || 0));
      }

      const trendRows = await safeQuery(
        `SELECT DATE_FORMAT(date,'%Y-%m') AS ym, COALESCE(SUM(total),0) AS revenue
         FROM invoices WHERE user_id=? AND qbo_id IS NOT NULL AND date BETWEEN ? AND ?
         GROUP BY ym ORDER BY ym ASC`, [qboUid, from, to]);
      trend = zeroFillMonths(trendRows, monthKeysBetween(from, to), 'ym', (ym, r) => ({
        month:   shortMonth(ym),
        revenue: Math.round(parseFloat(r?.revenue || 0)),
      }));

      const custRows = await safeQuery(
        `SELECT customer_name AS name, COALESCE(SUM(total),0) AS amount, COUNT(*) AS count
         FROM invoices WHERE user_id=? AND qbo_id IS NOT NULL AND date BETWEEN ? AND ?
         GROUP BY customer_name ORDER BY amount DESC LIMIT 5`, [qboUid, from, to]);
      topCustomers = custRows.map(r => ({ name: r.name, amount: Math.round(parseFloat(r.amount)), count: parseInt(r.count) }));
    } else {
      // ── Non-Zoho path: use account_transactions ───────────────────────────
      const trendRows = await safeQuery(
        `SELECT DATE_FORMAT(transaction_date,'%Y-%m') AS ym, COALESCE(SUM(COALESCE(base_credit, credit)),0) AS revenue
         FROM account_transactions
         WHERE user_id=? AND account_group='income' AND COALESCE(base_credit, credit) > 0
           AND transaction_date BETWEEN ? AND ?${orgF}
         GROUP BY ym ORDER BY ym ASC`, [uid, from, to, ...orgP]
      );
      trend = zeroFillMonths(trendRows, monthKeysBetween(from, to), 'ym', (ym, r) => ({
        month:   shortMonth(ym),
        revenue: Math.round(parseFloat(r?.revenue || 0)),
      }));

      const topCustRows = await safeQuery(
        `SELECT customer_name AS name, COALESCE(SUM(total),0) AS amount, COUNT(*) AS count
         FROM invoices WHERE user_id=? AND date BETWEEN ? AND ?${orgF}
         GROUP BY customer_name ORDER BY amount DESC LIMIT 5`, [uid, from, to, ...orgP]
      );
      topCustomers = topCustRows.map(r => ({ name: r.name, amount: Math.round(parseFloat(r.amount)), count: parseInt(r.count) }));

      const [curRow] = await safeQuery(
        `SELECT COALESCE(SUM(COALESCE(base_credit, credit)),0) AS v FROM account_transactions
         WHERE user_id=? AND account_group='income' AND COALESCE(base_credit, credit) > 0
           AND transaction_date BETWEEN ? AND ?${orgF}`, [uid, from, to, ...orgP]
      );
      const [priRow] = await safeQuery(
        `SELECT COALESCE(SUM(COALESCE(base_credit, credit)),0) AS v FROM account_transactions
         WHERE user_id=? AND account_group='income' AND COALESCE(base_credit, credit) > 0
           AND transaction_date BETWEEN ? AND ?${orgF}`, [uid, priorFromStr, priorToStr, ...orgP]
      );
      current = Math.round(parseFloat(curRow?.v || 0));
      prior   = Math.round(parseFloat(priRow?.v || 0));
    }

    const growth = prior > 0 ? parseFloat(((current - prior) / prior).toFixed(4)) : null;
    return res.json({ data: { trend, topCustomers, current, prior, growth } });
  } catch (err) {
    console.error('KPI revenue error:', err.message);
    return res.json({ data: { trend: [], topCustomers: [], current: 0, prior: 0, growth: null } });
  }
});

// ── GET /api/dashboard/kpi/cash ───────────────────────────────────────────────
router.get('/kpi/cash', async (req, res) => {
  try {
    const uid = req.user.id;
    const { from, to } = getDateRange(req.query);
    const basis = getBasis(req.query);
    const av = await dataAvailability(uid, req.orgId, req.adminUserId || null);
    const { zohoOrgId, zohoUid: _zohoUid, hasQbo, qboUid } = av;
    const zbUid = _zohoUid || uid;
    const activeOrgId = req.orgId || zohoOrgId || null;
    const orgF = activeOrgId ? ' AND org_id = ?' : '';
    const orgP = activeOrgId ? [activeOrgId] : [];

    // Per-account Cash + Bank balances from the shared single source of truth
    // (resolveCashOnHand), the SAME function GET /dashboard uses for the summary
    // card — so the card total and this detail panel always agree, for every
    // provider. No Zoho API call, no live-token dependency. Scoped "as of" the
    // selected period's end date (capped at today) — same as GET /dashboard.
    const todayStr = new Date().toISOString().slice(0, 10);
    const asOfDate = to && to < todayStr ? to : todayStr;
    const cash = await resolveCashOnHand(av, uid, activeOrgId, asOfDate);
    const accounts = cash.accounts;
    const total = cash.total;

    let trendRows, openingBalance;
    if (hasQbo) {
      // QB has no synced bank ledger — approximate monthly cash movement from
      // invoice collections (money in = total − balance) and expense_entries
      // (money out), the same proxy /cashflow-trend uses. The running cash
      // position is anchored so the period ends at the current total cash.
      const inRows = await safeQuery(
        `SELECT DATE_FORMAT(date,'%Y-%m') AS ym, COALESCE(SUM(total-balance),0) AS inflow
         FROM invoices WHERE user_id=? AND qbo_id IS NOT NULL AND date BETWEEN ? AND ?
         GROUP BY ym`, [qboUid, from, to]
      );
      const outRows = await safeQuery(
        `SELECT DATE_FORMAT(expense_date,'%Y-%m') AS ym, COALESCE(SUM(amount),0) AS outflow
         FROM expense_entries WHERE user_id=? AND qbo_id IS NOT NULL AND expense_date BETWEEN ? AND ?
         GROUP BY ym`, [qboUid, from, to]
      );
      const mp = {};
      for (const r of inRows)  mp[r.ym] = { ym: r.ym, inflow: parseFloat(r.inflow) || 0, outflow: 0 };
      for (const r of outRows) { (mp[r.ym] ||= { ym: r.ym, inflow: 0, outflow: 0 }).outflow = parseFloat(r.outflow) || 0; }
      trendRows = Object.values(mp)
        .map((d) => ({ ym: d.ym, inflow: d.inflow, outflow: d.outflow, netbal: d.inflow - d.outflow }))
        .sort((a, b) => a.ym.localeCompare(b.ym));
      const totalNet = trendRows.reduce((s, d) => s + d.netbal, 0);
      openingBalance = Math.round(total - totalNet); // so the running line ends at current cash
    } else {
      // Cash-flow trend from the synced bank ledger: debit = inflow, credit = outflow.
      // `netbal` is in the account-balance convention (debit − credit, matching
      // `total`/`accounts`) so the cash-position line reconstructs the month-end
      // balance regardless of which period is selected.
      trendRows = await safeQuery(
        `SELECT DATE_FORMAT(transaction_date,'%Y-%m') AS ym,
                COALESCE(SUM(CASE WHEN debit_or_credit='debit'  THEN amount ELSE 0 END),0) AS inflow,
                COALESCE(SUM(CASE WHEN debit_or_credit='credit' THEN amount ELSE 0 END),0) AS outflow,
                COALESCE(SUM(CASE WHEN debit_or_credit='debit' THEN amount ELSE -amount END),0) AS netbal
         FROM bank_transactions
         WHERE user_id=? AND transaction_date BETWEEN ? AND ?${orgF}
         GROUP BY ym ORDER BY ym ASC`, [zbUid, from, to, ...orgP]
      );
      // Opening cash balance immediately before the period (debit − credit).
      const [openRow] = await safeQuery(
        `SELECT COALESCE(SUM(CASE WHEN debit_or_credit='debit' THEN amount ELSE -amount END),0) AS net
         FROM bank_transactions
         WHERE user_id=? AND transaction_date < ?${orgF}`, [zbUid, from, ...orgP]
      );
      openingBalance = Math.round(parseFloat(openRow?.net || 0));
    }

    const trend = zeroFillMonths(trendRows, monthKeysBetween(from, to), 'ym', (ym, r) => ({
      month:   shortMonth(ym),
      inflow:  Math.round(parseFloat(r?.inflow || 0)),
      outflow: Math.round(parseFloat(r?.outflow || 0)),
      netbal:  Math.round(parseFloat(r?.netbal || 0)),
    }));

    return res.json({ data: { accounts, trend, total, openingBalance } });
  } catch (err) {
    console.error('KPI cash error:', err.message);
    return res.json({ data: { accounts: [], trend: [], total: 0, openingBalance: 0 } });
  }
});

// ── GET /api/dashboard/kpi/burn ───────────────────────────────────────────────
router.get('/kpi/burn', async (req, res) => {
  try {
    const uid = req.user.id;
    const { from, to } = getDateRange(req.query);
    const av = await dataAvailability(uid, req.orgId, req.adminUserId || null);
    const { hasZohoLive, zohoOrgId, zohoUid: _zohoUid } = av;
    const zbUid = _zohoUid || uid;
    const activeOrgId = req.orgId || zohoOrgId || null;
    const orgF = activeOrgId ? ' AND org_id = ?' : '';
    const orgP = activeOrgId ? [activeOrgId] : [];

    // Cash on hand from the shared single source of truth so the runway here
    // matches the Cash on Hand card and detail panel exactly. Scoped "as of"
    // the selected period's end date (capped at today) — same as GET /dashboard.
    const todayStr = new Date().toISOString().slice(0, 10);
    const asOfDate = to && to < todayStr ? to : todayStr;
    const cashOnHand = (await resolveCashOnHand(av, uid, activeOrgId, asOfDate)).total;

    let trendRows = [], topCatRows = [];

    if (hasZohoLive) {
      // Use zb_bills for expense trend and top categories
      trendRows = await safeQuery(
        `SELECT DATE_FORMAT(date,'%Y-%m') AS ym,
                COALESCE(SUM(total),0) AS expenses
         FROM bills
         WHERE user_id=? AND (is_deleted=0 OR is_deleted IS NULL)
           AND date BETWEEN ? AND ?${orgF}
         GROUP BY ym ORDER BY ym ASC`, [zbUid, from, to, ...orgP]
      );
      topCatRows = await safeQuery(
        `SELECT COALESCE(account_name,'Other') AS name,
                COALESCE(SUM(debit_or_credit_effect),'0') AS amount
         FROM zb_chart_of_accounts
         WHERE user_id=?${orgF} AND account_type_formatted IN ('Expense','Other Expense','Cost of Goods Sold')
         ORDER BY CAST(amount AS DECIMAL) DESC LIMIT 6`, [zbUid, ...orgP]
      );
      // If chart of accounts didn't work, group bills by vendor
      if (!topCatRows.length) {
        topCatRows = await safeQuery(
          `SELECT COALESCE(vendor_name,'Other') AS name, SUM(total) AS amount
           FROM bills WHERE user_id=? AND (is_deleted=0 OR is_deleted IS NULL)${orgF}
           GROUP BY vendor_name ORDER BY amount DESC LIMIT 6`, [zbUid, ...orgP]
        );
      }
    } else if (av.hasQbo) {
      // QB has no synced GL flows — use expense_entries (same source as the main
      // dashboard burn), scoped to the effective QB user.
      trendRows = await safeQuery(
        `SELECT DATE_FORMAT(expense_date,'%Y-%m') AS ym, COALESCE(SUM(amount),0) AS expenses
         FROM expense_entries
         WHERE user_id=? AND qbo_id IS NOT NULL AND expense_date BETWEEN ? AND ?
         GROUP BY ym ORDER BY ym ASC`, [av.qboUid, from, to]
      );
      topCatRows = await safeQuery(
        `SELECT COALESCE(NULLIF(account_name,''), NULLIF(vendor_name,''), 'Other') AS name,
                COALESCE(SUM(amount),0) AS amount
         FROM expense_entries
         WHERE user_id=? AND qbo_id IS NOT NULL AND expense_date BETWEEN ? AND ?
         GROUP BY name ORDER BY amount DESC LIMIT 6`, [av.qboUid, from, to]
      );
    } else {
      trendRows = await safeQuery(
        `SELECT DATE_FORMAT(transaction_date,'%Y-%m') AS ym,
                COALESCE(SUM(COALESCE(base_debit, debit)),0) AS expenses
         FROM account_transactions
         WHERE user_id=? AND account_group='expense' AND COALESCE(base_debit, debit) > 0
           AND transaction_date BETWEEN ? AND ?${orgF}
         GROUP BY ym ORDER BY ym ASC`, [uid, from, to, ...orgP]
      );
      topCatRows = await safeQuery(
        `SELECT COALESCE(account_name,'Other') AS name,
                COALESCE(SUM(COALESCE(base_debit, debit)),0) AS amount
         FROM account_transactions
         WHERE user_id=? AND account_group='expense' AND COALESCE(base_debit, debit) > 0${orgF}
         GROUP BY account_name ORDER BY amount DESC LIMIT 6`, [uid, ...orgP]
      );
    }

    const trend = zeroFillMonths(trendRows, monthKeysBetween(from, to), 'ym', (ym, r) => ({
      month:    shortMonth(ym),
      expenses: Math.round(parseFloat(r?.expenses || 0)),
    }));

    // Average over the number of months in the selected period (zero-burn months
    // included), so runway = cash ÷ avg burn stays consistent with the window.
    const monthCount = Math.max(1, monthKeysBetween(from, to).length);
    const avgMonthlyBurn = trendRows.length
      ? trendRows.reduce((s, r) => s + parseFloat(r.expenses), 0) / monthCount
      : 0;

    const runwayMonths = avgMonthlyBurn > 0 && cashOnHand > 0
      ? parseFloat(Math.min(60, cashOnHand / avgMonthlyBurn).toFixed(1))
      : null;

    return res.json({
      data: {
        trend,
        topCategories: topCatRows.map(r => ({ name: r.name, amount: Math.round(parseFloat(r.amount)) })),
        avgMonthlyBurn: Math.round(avgMonthlyBurn),
        cashOnHand:     Math.round(cashOnHand),
        runwayMonths,
      },
    });
  } catch (err) {
    console.error('KPI burn error:', err.message);
    return res.json({ data: { trend: [], topCategories: [], avgMonthlyBurn: 0, cashOnHand: 0, runwayMonths: null } });
  }
});

// ── GET /api/dashboard/kpi/receivables ───────────────────────────────────────
router.get('/kpi/receivables', async (req, res) => {
  try {
    const uid = req.user.id;
    const { hasZohoLive, zohoOrgId, zohoUid: _zohoUid, hasQbo, qboUid, hasXero, xeroUid } = await dataAvailability(uid, req.orgId, req.adminUserId || null);
    const zbUid = _zohoUid || uid;
    const activeOrgId = req.orgId || zohoOrgId || null;
    const orgF = activeOrgId ? ' AND org_id = ?' : '';
    const orgP = activeOrgId ? [activeOrgId] : [];

    // Invoices live under the connection OWNER's user_id. For company-owned
    // QuickBooks/Xero clients that is the admin (qboUid/xeroUid), NOT req.user.id
    // — otherwise the client sees an empty AR panel while the main dashboard
    // (which already scopes by qboUid) shows data.
    const invTable = 'invoices';
    const invUid   = hasZohoLive ? zbUid : hasQbo ? qboUid : hasXero ? xeroUid : uid;

    const agingRows = await safeQuery(
      `SELECT
         CASE
           WHEN due_date IS NULL OR due_date >= CURDATE() THEN 'not_due'
           WHEN DATEDIFF(CURDATE(),due_date) <= 30        THEN '0_30'
           WHEN DATEDIFF(CURDATE(),due_date) <= 60        THEN '31_60'
           WHEN DATEDIFF(CURDATE(),due_date) <= 90        THEN '61_90'
           ELSE 'over_90'
         END AS bucket,
         COUNT(*)                   AS count,
         COALESCE(SUM(balance),0)   AS amount
       FROM ${invTable}
       WHERE user_id=? AND balance>0${orgF}
       GROUP BY bucket`, [invUid, ...orgP]
    );

    const aging = agingRows.map(r => ({
      bucket: r.bucket,
      count:  parseInt(r.count),
      amount: Math.round(parseFloat(r.amount)),
    }));

    const overdueRows = await safeQuery(
      `SELECT customer_name AS name,
              COALESCE(SUM(balance),0)         AS amount,
              COUNT(*)                          AS invoices,
              MAX(DATEDIFF(CURDATE(),due_date)) AS daysOverdue
       FROM ${invTable}
       WHERE user_id=? AND balance>0 AND due_date < CURDATE()${orgF}
       GROUP BY customer_name
       ORDER BY amount DESC LIMIT 5`, [invUid, ...orgP]
    );

    const overdueCustomers = overdueRows.map(r => ({
      name:        r.name,
      amount:      Math.round(parseFloat(r.amount)),
      invoices:    parseInt(r.invoices),
      daysOverdue: parseInt(r.daysOverdue || 0),
    }));

    const total = aging.reduce((s, r) => s + r.amount, 0);

    return res.json({ data: { aging, overdueCustomers, total } });
  } catch (err) {
    console.error('KPI receivables error:', err.message);
    return res.json({ data: { aging: [], overdueCustomers: [], total: 0 } });
  }
});

// ── GET /api/dashboard/compliance ────────────────────────────────────────────
// LOCAL compliance items (no live API):
//   1. Statutory payables — latest GL balance of GST/TDS/PF/ESI/etc. accounts
//   2. Overdue AR / AP — invoices & bills past due_date with balance > 0
//   3. Filing deadlines — upcoming India GST (GSTR-1/3B) + TDS quarterly returns
//      (only when statutory accounts exist, i.e. an India-registered org).
function fmtAmt(n) { try { return Math.round(n).toLocaleString('en-IN'); } catch { return String(Math.round(n)); } }

function filingDeadlines() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out = [];
  const nextByDom = (dom) => {
    let d = new Date(today.getFullYear(), today.getMonth(), dom);
    if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, dom);
    return d;
  };
  const push = (title, d) => {
    const days = Math.ceil((d - today) / 86400000);
    if (days < 0 || days > 60) return;
    const tone = days <= 7 ? 'red' : days <= 21 ? 'amber' : 'green';
    out.push({ id: `file-${title.replace(/\s+/g, '-')}`, type: 'filing', title,
      due: `Due ${d.toISOString().slice(0, 10)} · ${days}d`, tone, icon: 'CalendarClock' });
  };
  push('GSTR-1 return', nextByDom(11));
  push('GSTR-3B return', nextByDom(20));
  // TDS quarterly return due dates (India): 31 Jul, 31 Oct, 31 Jan, 31 May
  const tdsDates = [[6, 31], [9, 31], [0, 31], [4, 31]].map(([mo, dy]) => {
    let yr = today.getFullYear();
    let d = new Date(yr, mo, dy);
    if (d < today) d = new Date(yr + 1, mo, dy);
    return d;
  }).sort((a, b) => a - b);
  push('TDS quarterly return', tdsDates[0]);
  return out;
}

router.get('/compliance', async (req, res) => {
  try {
    const uid = req.user.id;
    const orgF = req.orgId ? ' AND org_id = ?' : '';
    const orgP = req.orgId ? [req.orgId] : [];
    const items = [];

    // Overdue invoices/bills are owned by the connection admin for company-owned
    // QuickBooks/Xero clients — scope AR/AP by the effective user_id.
    const { hasZohoLive, zohoUid, hasQbo, qboUid, hasXero, xeroUid } = await dataAvailability(uid, req.orgId, req.adminUserId || null);
    const invUid = hasZohoLive ? (zohoUid || uid) : hasQbo ? qboUid : hasXero ? xeroUid : uid;

    // 1. Statutory payables from the GL (latest balance per liability account).
    const statRows = await safeQuery(
      `SELECT at1.account_name AS name, at1.balance AS bal
         FROM account_transactions at1
         INNER JOIN (SELECT account_id, MAX(id) AS mid FROM account_transactions
                      WHERE user_id=?${orgF} GROUP BY account_id) l
           ON at1.account_id=l.account_id AND at1.id=l.mid
        WHERE at1.user_id=?${req.orgId ? ' AND at1.org_id=?' : ''} AND at1.account_group='liability'
          AND LOWER(at1.account_name) REGEXP 'gst|cgst|sgst|igst|tds|tcs|epf|esi|professional tax|pf payable'`,
      [uid, ...orgP, uid, ...orgP]
    );
    for (const r of statRows) {
      const amt = Math.abs(parseFloat(r.bal || 0));
      if (amt <= 0) continue;
      items.push({ id: `stat-${r.name}`, type: 'statutory', title: r.name, amount: Math.round(amt),
        due: `Payable · ${fmtAmt(amt)}`, tone: 'amber', icon: 'Landmark' });
    }

    // 2. Overdue receivables / payables.
    const [ar] = await safeQuery(
      `SELECT COUNT(*) n, COALESCE(SUM(balance),0) amt FROM invoices
        WHERE user_id=?${orgF} AND balance>0 AND due_date < CURDATE()`, [invUid, ...orgP]);
    if (ar && ar.n > 0) items.push({ id: 'ar-overdue', type: 'receivable',
      title: `${ar.n} overdue invoice${ar.n > 1 ? 's' : ''}`, amount: Math.round(ar.amt),
      due: `Receivable · ${fmtAmt(ar.amt)}`, tone: 'red', icon: 'AlertTriangle' });
    const [ap] = await safeQuery(
      `SELECT COUNT(*) n, COALESCE(SUM(balance),0) amt FROM bills
        WHERE user_id=?${orgF} AND balance>0 AND due_date < CURDATE()`, [invUid, ...orgP]);
    if (ap && ap.n > 0) items.push({ id: 'ap-overdue', type: 'payable',
      title: `${ap.n} overdue bill${ap.n > 1 ? 's' : ''}`, amount: Math.round(ap.amt),
      due: `Payable · ${fmtAmt(ap.amt)}`, tone: 'red', icon: 'AlertTriangle' });

    // 3. Filing deadlines — only for India-registered orgs (have statutory accts).
    if (statRows.length > 0) for (const f of filingDeadlines()) items.push(f);

    // Amber/red first, then by amount desc.
    const rank = { red: 0, amber: 1, green: 2 };
    items.sort((a, b) => (rank[a.tone] - rank[b.tone]) || ((b.amount || 0) - (a.amount || 0)));
    return res.json({ data: items });
  } catch (err) {
    console.error('compliance error:', err.message);
    return res.json({ data: [] });
  }
});

module.exports = router;
