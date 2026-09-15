'use strict';

/**
 * Xero Reports service
 * ---------------------------------------------------------------
 * Pulls Xero's /Reports/* endpoints (the SAME reports the Xero UI renders — so
 * figures match Xero exactly), caches the response in acc_report_cache (TTL 15
 * min by default), and transforms Xero's nested { Reports:[{ Rows:[...] }] }
 * payload into the uniform { columns, rows, currency } shape the frontend
 * ReportTable already consumes (identical to quickbooksReportsService output).
 *
 * Row shape (matches ReportTable.jsx + zoho/qbo report services):
 *   columns: [{ key, label, align }]
 *   rows:    [{ label, level, isHeader?, isSubtotal?, isTotal?, cells:{key:val}, accountRef? }]
 *
 * Supported canonical types (Xero JSON Reports API has no CashFlow report, and
 * aging is per-contact only — those stay mock on the frontend):
 *   profitandloss, balancesheet, trialbalance, banksummary, executivesummary
 *
 * Unknown / unsupported report types throw UNKNOWN_REPORT_TYPE so the route
 * returns 404 and the frontend falls back to its existing mock generator.
 */

const crypto = require('crypto');
const axios  = require('axios');
const pool   = require('../config/db');
const { getValidXeroToken, getEffectiveXeroUserId, XERO_API_BASE } = require('./xeroService');

const DEFAULT_TTL_MS = 15 * 60 * 1000;

// `xeroHeaders` is not exported from xeroService — replicate the 3-header shape.
function xeroHeaders(accessToken, tenantId) {
  return {
    Authorization:    `Bearer ${accessToken}`,
    'Xero-tenant-id': tenantId,
    Accept:           'application/json',
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}
function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Pull the AccountID out of a Xero cell's Attributes ([{ Value, Id }]).
function cellAccountRef(cell) {
  const attr = Array.isArray(cell?.Attributes)
    ? cell.Attributes.find((a) => a.Id === 'account' || a.Id === 'accountID')
    : null;
  return attr?.Value || null;
}

// ─── report registry: our canonical type → Xero ReportName + transform ──────
// `type` values match the frontend liveType strings.
// dateMode: 'range' → fromDate/toDate; 'point' → date; 'none' → no date params.
const REPORT_DEFS = {
  profitandloss:    { xero: 'ProfitAndLoss',    transform: transformXeroReport,       dateMode: 'range' },
  balancesheet:     { xero: 'BalanceSheet',     transform: transformXeroReport,       dateMode: 'point' },
  trialbalance:     { xero: 'TrialBalance',     transform: transformXeroTrialBalance, dateMode: 'point' },
  banksummary:      { xero: 'BankSummary',      transform: transformXeroReport,       dateMode: 'range' },
  executivesummary: { xero: 'ExecutiveSummary', transform: transformXeroReport,       dateMode: 'point' },
  // Chart of Accounts is not a Xero /Reports/* report — it's the /Accounts list.
  chartofaccounts:  { endpoint: 'accounts',     transform: transformXeroAccounts,     dateMode: 'none' },
};

function listReportTypes() { return Object.keys(REPORT_DEFS); }
function isKnownType(type) { return Object.prototype.hasOwnProperty.call(REPORT_DEFS, type); }

// ─── Xero param mapping ─────────────────────────────────────────────────────
function buildXeroParams(type, def, params) {
  const out = {};
  const from = params.from_date || params.from || null;
  const to   = params.to_date   || params.to   || null;
  if (def.dateMode === 'range') {
    if (from) out.fromDate = from;
    if (to)   out.toDate   = to;
  } else if (def.dateMode === 'point') {
    if (to) out.date = to;
  }
  // Multi-period comparison columns (used by the Budget Summary, which lays a
  // P&L out across N monthly columns). Xero allows periods 1-11 + a timeframe.
  if (params.periods != null) {
    const p = parseInt(params.periods, 10);
    if (Number.isFinite(p) && p > 0) out.periods = Math.min(p, 11);
  }
  if (params.timeframe) out.timeframe = params.timeframe;
  // Cash-basis P&L (Accounting method = Cash).
  if (params.paymentsOnly) out.paymentsOnly = true;
  return out;
}

// ─── multi-window split for ranges wider than Xero's 365-day API cap ────────
// Xero's date-range reports (Profit & Loss) reject any fromDate→toDate span
// wider than 365 days (ValidationException ErrorNumber 10). The Profit & Loss
// statement is fully additive over time, so a wider range is fetched as several
// contiguous ≤365-day windows and the per-account values summed — reproducing
// exactly what Xero's own web UI shows for a multi-year period.
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function splitRange(from, to) {
  const windows = [];
  let start = new Date(from);
  const end = new Date(to);
  if (!(start <= end)) return [{ from, to }];
  while (start <= end) {
    let winEnd = new Date(start);
    winEnd.setDate(winEnd.getDate() + 364); // 365-day inclusive window (≤ Xero cap)
    if (winEnd > end) winEnd = new Date(end);
    windows.push({ from: ymd(start), to: ymd(winEnd) });
    start = new Date(winEnd);
    start.setDate(start.getDate() + 1);
  }
  return windows;
}

// Merge several single-period (uncollapsed) P&L transforms into one by summing
// matching rows. Every P&L row — leaf account, section subtotal and the Net
// Profit total — is additive across consecutive periods, so values are added
// row-for-row (aligned by level + role + label); rows present in only some
// windows are inserted in position.
function mergeAdditiveReports(parts, currency) {
  if (!parts.length) return { columns: [], rows: [], currency: currency || 'USD' };
  if (parts.length === 1) return parts[0];
  const base = parts[0];
  const valueKeys = base.columns.slice(1).map((c) => c.key);
  const roleOf = (r) => (r.isHeader ? 'H' : r.isTotal ? 'T' : r.isSubtotal ? 'S' : 'R');
  const keyOf = (r) => `${r.level}|${roleOf(r)}|${r.label}`;
  const merged = base.rows.map((r) => ({ ...r, cells: { ...(r.cells || {}) } }));

  for (let i = 1; i < parts.length; i++) {
    const rows = parts[i].rows || [];
    let ptr = 0;
    for (const src of rows) {
      const k = keyOf(src);
      let found = -1;
      for (let j = ptr; j < merged.length; j++) { if (keyOf(merged[j]) === k) { found = j; break; } }
      if (found === -1) { for (let j = 0; j < ptr; j++) { if (keyOf(merged[j]) === k) { found = j; break; } } }
      if (found >= 0) {
        const mc = merged[found].cells || (merged[found].cells = {});
        for (const vk of valueKeys) {
          const a = mc[vk], b = src.cells ? src.cells[vk] : null;
          if (a != null || b != null) mc[vk] = (a || 0) + (b || 0);
        }
        ptr = found + 1;
      } else {
        merged.splice(ptr, 0, { ...src, cells: { ...(src.cells || {}) } });
        ptr += 1;
      }
    }
  }
  return { columns: base.columns, rows: merged, currency: currency || base.currency };
}

// ─── Xero report column headers → our columns ───────────────────────────────
// The first RowType:'Header' row carries the column titles.
function buildColumns(headerRow) {
  const cells = Array.isArray(headerRow?.Cells) ? headerRow.Cells : [];
  if (!cells.length) {
    return [{ key: 'label', label: '', align: 'left' }, { key: 'c1', label: 'Total', align: 'right' }];
  }
  return cells.map((c, i) => {
    if (i === 0) return { key: 'label', label: c.Value || '', align: 'left' };
    return { key: `c${i}`, label: c.Value || '', align: 'right' };
  });
}

// QuickBooks is the reference format for Profit & Loss and Balance Sheet, and QB
// renders these as a SINGLE "Total" column. Xero instead labels the value column
// with the period end date (P&L) and adds a prior-year comparative column
// (Balance Sheet) by default. Collapse to one "Total" column so all three
// providers (Zoho/QB/Xero) render an identical single-period statement — UNLESS
// a multi-period request was made (Budget Summary passes `periods`, which needs
// every monthly column preserved).
function collapseToTotalColumn(result) {
  if (!result || !Array.isArray(result.columns) || result.columns.length < 2) return result;
  const labelCol = result.columns[0];
  const firstVal = result.columns[1];
  const keepKey = firstVal.key;
  result.columns = [labelCol, { ...firstVal, label: 'Total' }];
  result.rows = (result.rows || []).map((r) => (
    r.cells ? { ...r, cells: { [keepKey]: r.cells[keepKey] ?? null } } : r
  ));
  return result;
}

// The Executive Summary viewer is the common contract and reads each value row
// by the fixed cell keys cur / prv / var (current period, prior period,
// variance). Xero's generic transform emits c1 / c2 / c3, so remap them to the
// canonical keys (and rename the columns to match) — keeping the payload shape
// identical to the Zoho ledger-derived Executive Summary.
function remapExecutiveSummary(result) {
  if (!result || !Array.isArray(result.columns)) return result;
  const valCols = result.columns.slice(1); // drop the label column
  const TARGET = ['cur', 'prv', 'var'];
  const keyMap = {};
  valCols.forEach((c, i) => { if (TARGET[i]) keyMap[c.key] = TARGET[i]; });

  result.columns = [
    result.columns[0],
    ...valCols.slice(0, 3).map((c, i) => ({ ...c, key: TARGET[i] })),
  ];
  result.rows = (result.rows || []).map((r) => {
    if (!r.cells) return r;
    const cells = {};
    for (const [from, to] of Object.entries(keyMap)) {
      if (r.cells[from] != null) cells[to] = r.cells[from];
    }
    return { ...r, cells };
  });
  return result;
}

// ─── GENERIC transformer (P&L, Balance Sheet, Bank Summary, Exec Summary) ───
function transformXeroReport(report, currency) {
  const topRows = Array.isArray(report?.Rows) ? report.Rows : [];
  const headerRow = topRows.find((r) => r.RowType === 'Header');
  const columns = buildColumns(headerRow);
  const valueKeys = columns.slice(1).map((c) => c.key);
  const rows = [];

  function cellsFromCells(cellList) {
    const cells = {};
    valueKeys.forEach((k, idx) => {
      const cell = cellList[idx + 1];
      cells[k] = cell ? num(cell.Value) : null;
    });
    return cells;
  }

  function walk(rowList, level) {
    if (!Array.isArray(rowList)) return;
    rowList.forEach((row) => {
      const t = row.RowType;
      if (t === 'Header') return; // consumed for columns
      if (t === 'Section') {
        const label = row.Title || '';
        if (label) rows.push({ label, level, isHeader: true, cells: {} });
        walk(row.Rows, level + (label ? 1 : 0));
      } else if (t === 'SummaryRow') {
        const cells = Array.isArray(row.Cells) ? row.Cells : [];
        const slabel = cells[0]?.Value || 'Total';
        const isTop = level === 0;
        const isNet = /\b(net (profit|loss|income)|total)\b/i.test(slabel);
        rows.push({
          label: slabel, level,
          isTotal: isTop && isNet,
          isSubtotal: !(isTop && isNet),
          cells: cellsFromCells(cells),
        });
      } else {
        // RowType 'Row' (leaf)
        const cells = Array.isArray(row.Cells) ? row.Cells : [];
        rows.push({
          label: cells[0]?.Value || '',
          level,
          cells: cellsFromCells(cells),
          accountRef: cellAccountRef(cells[0]),
        });
      }
    });
  }

  walk(topRows, 0);
  return { columns, rows, currency: currency || 'USD' };
}

// ─── TRIAL BALANCE (Account | Debit | Credit) ───────────────────────────────
// Xero TB row cells = [Account, Debit, Credit, YTD Debit, YTD Credit].
function transformXeroTrialBalance(report, currency) {
  const rows = [];
  const columns = [
    { key: 'label',  label: 'Account', align: 'left'  },
    { key: 'debit',  label: 'Debit',   align: 'right' },
    { key: 'credit', label: 'Credit',  align: 'right' },
  ];
  let totDebit = 0, totCredit = 0;

  function walk(rowList, level) {
    if (!Array.isArray(rowList)) return;
    rowList.forEach((row) => {
      const t = row.RowType;
      if (t === 'Header') return;
      if (t === 'Section') {
        if (row.Title) rows.push({ label: row.Title, level, isHeader: true, cells: {} });
        walk(row.Rows, level + (row.Title ? 1 : 0));
      } else if (t === 'SummaryRow') {
        const cells = Array.isArray(row.Cells) ? row.Cells : [];
        rows.push({
          label: cells[0]?.Value || 'Total', level, isSubtotal: true,
          cells: { debit: num(cells[1]?.Value), credit: num(cells[2]?.Value) },
        });
      } else {
        const cells = Array.isArray(row.Cells) ? row.Cells : [];
        const d = num(cells[1]?.Value), c = num(cells[2]?.Value);
        totDebit += d || 0; totCredit += c || 0;
        rows.push({
          label: cells[0]?.Value || '', level,
          cells: { debit: d, credit: c },
          accountRef: cellAccountRef(cells[0]),
        });
      }
    });
  }
  walk(Array.isArray(report?.Rows) ? report.Rows : [], 0);
  rows.push({
    label: 'TOTAL', level: 0, isTotal: true,
    cells: { debit: Math.round(totDebit * 100) / 100, credit: Math.round(totCredit * 100) / 100 },
  });
  return { columns, rows, currency: currency || 'USD', _totals: { debit: totDebit, credit: totCredit } };
}

// ─── CHART OF ACCOUNTS (from /Accounts, not /Reports/*) ─────────────────────
// Xero's /Accounts endpoint returns the account list (no balances — Xero does
// not expose per-account balances here). Group leaf accounts under their Class
// so the viewer renders the familiar Asset/Liability/Equity/Revenue/Expense
// sections, matching the other report layouts.
const XERO_CLASS_LABEL = {
  ASSET: 'Assets', LIABILITY: 'Liabilities', EQUITY: 'Equity',
  REVENUE: 'Revenue', EXPENSE: 'Expenses',
};
const XERO_CLASS_ORDER = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];

function transformXeroAccounts(body, currency) {
  const accounts = Array.isArray(body?.Accounts) ? body.Accounts : [];
  const columns = [
    { key: 'label',  label: 'Account', align: 'left' },
    { key: 'code',   label: 'Code',    align: 'left' },
    { key: 'type',   label: 'Type',    align: 'left' },
    { key: 'status', label: 'Status',  align: 'left' },
  ];

  // Bucket accounts by Xero Class; keep an "Other" bucket for unclassified.
  const buckets = {};
  for (const a of accounts) {
    const cls = String(a.Class || '').toUpperCase();
    (buckets[cls] || (buckets[cls] = [])).push(a);
  }

  const rows = [];
  const orderedClasses = [
    ...XERO_CLASS_ORDER.filter((c) => buckets[c]?.length),
    ...Object.keys(buckets).filter((c) => !XERO_CLASS_ORDER.includes(c)),
  ];

  for (const cls of orderedClasses) {
    const list = buckets[cls];
    if (!list?.length) continue;
    rows.push({ label: XERO_CLASS_LABEL[cls] || cls || 'Other', level: 0, isHeader: true, cells: {} });
    list
      .sort((x, y) => String(x.Code || x.Name || '').localeCompare(String(y.Code || y.Name || '')))
      .forEach((a) => {
        // No accountRef: Xero has no General Ledger drill (NOT_IMPLEMENTED), so
        // leaving it off keeps the account name as plain text (no dead-end link).
        rows.push({
          label: a.Name || a.Code || '(unnamed)',
          level: 1,
          cells: {
            code:   a.Code || '—',
            type:   a.Type || '—',
            status: a.Status || '—',
          },
        });
      });
  }

  return { columns, rows, currency: currency || 'USD', _count: accounts.length };
}

// ─── connection currency (real tenant currency, kills the fake "USD") ───────
async function resolveCurrency(userId, tenantId) {
  try {
    const [[org]] = await pool.execute(
      `SELECT currency FROM xero_organizations WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
      [userId, tenantId]
    );
    if (org?.currency) return org.currency;
  } catch (_) { /* fall through */ }
  try {
    const [[acc]] = await pool.execute(
      `SELECT currency_code FROM xero_accounts
        WHERE user_id = ? AND tenant_id = ? AND currency_code IS NOT NULL LIMIT 1`,
      [userId, tenantId]
    );
    if (acc?.currency_code) return acc.currency_code;
  } catch (_) { /* fall through */ }
  return 'USD';
}

// ─── cache ──────────────────────────────────────────────────────────────────
async function readCache(userId, connRef, reportType, paramsHash) {
  try {
    const [rows] = await pool.execute(
      `SELECT transformed, body, expires_at FROM acc_report_cache
        WHERE user_id = ? AND provider = 'xero' AND connection_ref = ?
          AND report_type = ? AND params_hash = ? LIMIT 1`,
      [userId, connRef, reportType, paramsHash]
    );
    return rows[0] || null;
  } catch (e) {
    console.warn('[xero-reports] cache read skipped:', e.message);
    return null;
  }
}
async function writeCache(userId, connRef, reportType, paramsHash, paramsJson, statusCode, body, transformed, ttlMs) {
  const expiresAt = new Date(Date.now() + ttlMs);
  await pool.execute(
    `INSERT INTO acc_report_cache
       (user_id, provider, connection_ref, report_type, params_hash, params_json, status_code, body, transformed, fetched_at, expires_at)
     VALUES (?, 'xero', ?, ?, ?, CAST(? AS JSON), ?, ?, ?, CURRENT_TIMESTAMP, ?)
     ON DUPLICATE KEY UPDATE
       params_json = VALUES(params_json), status_code = VALUES(status_code),
       body = VALUES(body), transformed = VALUES(transformed),
       fetched_at = CURRENT_TIMESTAMP, expires_at = VALUES(expires_at)`,
    [userId, connRef, reportType, paramsHash, JSON.stringify(paramsJson || {}),
     statusCode, body == null ? null : JSON.stringify(body),
     transformed == null ? null : JSON.stringify(transformed), expiresAt]
  );
}

// ─── main entry: fetch + cache + transform ──────────────────────────────────
// Number of whole interval units (months / quarters / years) spanned by a range.
function unitsInRange(from, to, interval) {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  if (interval === 'years') return (b.getFullYear() - a.getFullYear()) + 1;
  const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + 1;
  if (interval === 'quarters') return Math.ceil(months / 3);
  return months;
}

// Pick the Xero timeframe that best fits a single date range's length.
function rangeTimeframe(from, to) {
  const days = (new Date(to) - new Date(from)) / 86400000;
  if (days > 200) return 'YEAR';
  if (days > 80) return 'QUARTER';
  return 'MONTH';
}

// Translate the report-viewer controls into Xero's native ProfitAndLoss params:
//  - Display columns by (interval)  → timeframe + periods (one column per unit).
//  - Compare to (previous year/period) → timeframe + periods comparison columns.
//  - Accounting method = Cash       → paymentsOnly=true (Xero's cash-basis P&L).
// Only applied to profitandloss; other report types are left untouched.
function applyPlControls(params) {
  if (params.periods != null) return params; // explicit periods (Budget Summary) wins
  const from = params.from_date || params.from || null;
  const to = params.to_date || params.to || null;
  let next = params;

  const TF = { months: 'MONTH', quarters: 'QUARTER', years: 'YEAR' };
  if (TF[params.interval] && from && to) {
    const periods = Math.min(Math.max(unitsInRange(from, to, params.interval) - 1, 0), 11);
    if (periods > 0) next = { ...next, timeframe: TF[params.interval], periods };
  } else if ((params.compare === 'period' || params.compare === 'year')
             && parseInt(params.compare_count, 10) > 1 && from && to) {
    const periods = Math.min(parseInt(params.compare_count, 10) - 1, 11);
    const timeframe = params.compare === 'year' ? 'YEAR' : rangeTimeframe(from, to);
    if (periods > 0) next = { ...next, timeframe, periods };
  }

  const basis = (params.accounting_basis || params.basis || '').toLowerCase();
  if (basis === 'cash') next = { ...next, paymentsOnly: true };
  return next;
}

async function fetchReport(userId, type, params = {}, { refresh = false, ttlMs = DEFAULT_TTL_MS } = {}) {
  // Xero exposes no budget through its API, so there is nothing to print; the
  // shared builder says so honestly rather than passing actuals off as a budget.
  if (type === 'budgetsummary') {
    const { buildBudgetSummary } = require('./budgetSummaryService');
    return buildBudgetSummary(userId, params);
  }

  // Budget Variance: derived from Xero's P&L (selected period + year-to-date)
  // against an absent budget, mirroring Zoho's ledger-derived Budget Variance.
  if (type === 'budgetvariance') {
    const { buildXeroBudgetVariance } = require('./xeroBudgetVarianceService');
    return buildXeroBudgetVariance(userId, params);
  }

  // Cash Flow Statement: Xero's JSON API has no Cash Flow report, so it's derived
  // (indirect method) from the period P&L plus opening/closing Balance Sheets.
  if (type === 'cashflow') {
    const { buildXeroCashFlow } = require('./xeroCashFlowService');
    return buildXeroCashFlow(userId, params);
  }

  // Cash Summary + Statement of Cash Flows - Direct: cash-basis reports built
  // from the shared `bank_transactions` ledger (the same provider-agnostic
  // builders Zoho uses). Xero bank activity is mirrored into that table by
  // syncBankTransactions, so passing the Xero tenant as org_id makes these work
  // dynamically — empty (structure only) until the org has bank transactions.
  if (type === 'cashsummary' || type === 'cashflowstatement') {
    const effId = await getEffectiveXeroUserId(userId);
    const [[row]] = await pool.execute('SELECT tenant_id FROM xero_tokens WHERE user_id = ?', [effId]);
    const orgId = row?.tenant_id;
    if (!orgId) {
      return { columns: [{ key: 'label', label: '', align: 'left' }], rows: [], currency: 'USD',
        empty: true, unavailable: true, emptyReason: 'unavailable' };
    }
    const builder = type === 'cashsummary'
      ? require('./cashSummaryService').buildCashSummary
      : require('./cashFlowStatementService').buildCashFlowStatement;
    return builder(effId, { ...params, org_id: orgId });
  }

  // Sales/AR + Purchases/AP reports are built from the shared `invoices` /
  // `bills` / `expense_entries` warehouses (the same provider-agnostic builders
  // Zoho uses). Xero documents are mirrored there by syncInvoices/syncBills
  // keyed on the tenant_id, so passing the Xero tenant as org_id makes these
  // reports work with an identical structure to the other providers.
  if (['salesbycustomer', 'aragingsummary', 'aragingdetail',
       'apagingsummary', 'apagingdetail', 'vendorbalancedetail',
       'supplierinvoicesummary', 'expensesbyvendorsummary', 'vendorcontactlist',
       'transactiondetailbyaccount', 'transactionlistbyvendor',
       'taxliability', 'tdssummary', 'gstreturnsworkbook',
       'foreigncurrencygainsandlosses', 'realizedgainorloss',
       'inventoryitemsummary'].includes(type)) {
    const effId = await getEffectiveXeroUserId(userId);
    const [[row]] = await pool.execute('SELECT tenant_id FROM xero_tokens WHERE user_id = ?', [effId]);
    const orgId = row?.tenant_id;
    if (!orgId) {
      return { columns: [{ key: 'label', label: '', align: 'left' }], rows: [], currency: 'USD',
        empty: true, unavailable: true, emptyReason: 'unavailable' };
    }
    // No platform filter — user_id + org_id already scope to this Xero tenant,
    // and legacy synced rows may have platform=NULL (filtering would drop them).
    const opts = { ...params, org_id: orgId };
    if (type === 'aragingdetail') return require('./zohoArAgingDetailService').buildArAgingDetail(effId, opts);
    if (type === 'apagingdetail') return require('./zohoApAgingDetailService').buildApAgingDetail(effId, opts);
    if (type === 'apagingsummary') return require('./zohoApAgingDetailService').buildApAgingSummary(effId, opts);
    if (type === 'vendorbalancedetail') return require('./zohoVendorBalanceDetailService').buildVendorBalanceDetail(effId, opts);
    if (type === 'supplierinvoicesummary') return require('./zohoSupplierInvoiceSummaryService').buildSupplierInvoiceSummary(effId, opts);
    if (type === 'expensesbyvendorsummary') return require('./zohoExpensesByVendorSummaryService').buildExpensesByVendorSummary(effId, opts);
    if (type === 'vendorcontactlist') return require('./zohoVendorContactListService').buildVendorContactList(effId, opts);
    if (type === 'transactiondetailbyaccount') return require('./zohoTransactionDetailByAccountService').buildTransactionDetailByAccount(effId, opts);
    if (type === 'transactionlistbyvendor') return require('./zohoTransactionListByVendorService').buildTransactionListByVendor(effId, opts);
    // P9 Tax / FX / Inventory — provider-agnostic builders over the shared
    // invoices/bills warehouse (tax_total + FX open balances). Reports sourced
    // from Zoho-only tables (TDS line items, customer/vendor payments, items)
    // return a graceful empty layout for Xero — honest, not an error.
    if (type === 'taxliability') return require('./zohoTaxLiabilityService').buildTaxLiability(effId, opts);
    if (type === 'tdssummary') return require('./zohoTdsSummaryService').buildTdsSummary(effId, opts);
    if (type === 'gstreturnsworkbook') return require('./zohoGstReturnsWorkbookService').buildGstReturnsWorkbook(effId, opts);
    if (type === 'foreigncurrencygainsandlosses') return require('./zohoForexService').buildForexGainsLosses(effId, opts);
    if (type === 'realizedgainorloss') return require('./zohoForexService').buildRealisedForex(effId, opts);
    if (type === 'inventoryitemsummary') return require('./zohoInventoryItemSummaryService').buildInventoryItemSummary(effId, opts);
    const { buildSalesByCustomer, buildArAgingSummary } = require('./salesArFromInvoicesService');
    const builder = type === 'salesbycustomer' ? buildSalesByCustomer : buildArAgingSummary;
    return builder(effId, opts);
  }

  // ── DB-only reports ─────────────────────────────────────────────────────────
  // Financial statements are built from our synced Xero general ledger
  // (account_transactions / bank_transactions, org_id = tenant_id) via the
  // provider-agnostic Zoho builders, and Chart of Accounts from the synced
  // xero_accounts table — NEVER a live Xero /Reports or /Accounts call. The Zoho
  // ledger builders honour params.org_id, so passing the Xero tenant drives them
  // off the Xero ledger. Any type without a DB source returns a graceful empty
  // state.
  const effId = await getEffectiveXeroUserId(userId);
  const [[tokRow]] = await pool.execute('SELECT tenant_id FROM xero_tokens WHERE user_id = ?', [effId]);
  const orgId = tokRow?.tenant_id;
  const emptyOut = { columns: [{ key: 'label', label: '', align: 'left' }], rows: [],
    currency: 'USD', empty: true, unavailable: true, emptyReason: 'unavailable' };
  if (!orgId) return emptyOut;
  const opts = { ...params, org_id: orgId, platform: 'xero' };

  switch (type) {
    case 'profitandloss':    return require('./zohoLedgerReportsService').buildProfitAndLoss(effId, opts);
    case 'balancesheet':     return require('./zohoGlReportsService').buildBalanceSheet(effId, opts);
    case 'trialbalance':     return require('./zohoGlReportsService').buildTrialBalance(effId, opts);
    case 'generalledger':    return require('./zohoGlReportsService').buildGeneralLedger(effId, opts);
    case 'banksummary':      return require('./bankSummaryService').buildBankSummary(effId, opts);
    case 'executivesummary': return require('./executiveSummaryService').buildExecutiveSummary(effId, opts);
    case 'chartofaccounts':  return buildChartOfAccountsFromDb(effId, orgId);
    default:                 return emptyOut;
  }
}

// Chart of Accounts served from the synced xero_accounts table (no live /Accounts
// call). Rows are reshaped into the same {Accounts:[...]} structure that
// transformXeroAccounts already expects, so grouping/columns stay identical.
async function buildChartOfAccountsFromDb(userId, tenantId) {
  const [rows] = await pool.execute(
    `SELECT code, name, type, status, \`class\`, currency_code
       FROM xero_accounts WHERE user_id = ? AND tenant_id = ?`,
    [userId, tenantId]
  );
  const currency = rows.find((r) => r.currency_code)?.currency_code || 'USD';
  const accounts = rows.map((r) => ({
    Code: r.code, Name: r.name, Type: r.type, Status: r.status, Class: r.class,
  }));
  return transformXeroAccounts({ Accounts: accounts }, currency);
}

module.exports = {
  REPORT_DEFS,
  listReportTypes,
  isKnownType,
  fetchReport,
  buildXeroParams,
  transformXeroReport,
  transformXeroTrialBalance,
  transformXeroAccounts,
};
