'use strict';

/**
 * QuickBooks Online Reports service
 * ---------------------------------------------------------------
 * Pulls QBO's /v3/company/{realm}/reports/* endpoints (the SAME reports the
 * QuickBooks UI renders — so figures match QB exactly), caches the response in
 * acc_report_cache (TTL 15 min by default), and transforms QBO's nested
 * { Header, Columns, Rows } payload into the uniform { columns, rows, currency }
 * shape the frontend ReportTable already consumes.
 *
 * Row shape (matches ReportTable.jsx + zohoBooksReportsService output):
 *   columns: [{ key, label, align }]
 *   rows:    [{ label, level, isHeader?, isSubtotal?, isTotal?, cells:{key:val},
 *               accountRef?, drill?:[{ name, ref, date, amount, sourceType, sourceRef }] }]
 *
 * Unknown / unsupported report types throw UNKNOWN_REPORT_TYPE so the route
 * returns 404 and the frontend falls back to its existing mock generator.
 */

const crypto = require('crypto');
const axios  = require('axios');
const pool   = require('../config/db');
const { getValidQBOToken, getEffectiveQBUserId, getApiBase } = require('./quickbooksService');

const MINOR_VERSION  = process.env.QBO_MINOR_VERSION || '70';
const DEFAULT_TTL_MS = 15 * 60 * 1000;

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

// ─── report registry: our canonical type → QBO ReportName + transform ───────
// `type` values match the frontend liveType strings.
const REPORT_DEFS = {
  profitandloss:             { qbo: 'ProfitAndLoss',             transform: transformGeneric,        requiresDates: true  },
  balancesheet:              { qbo: 'BalanceSheet',              transform: transformGeneric,        requiresDates: true  },
  cashflow:                  { qbo: 'CashFlow',                  transform: transformGeneric,        requiresDates: true  },
  trialbalance:              { qbo: 'TrialBalance',              transform: transformTrialBalance,   requiresDates: true  },
  generalledger:             { qbo: 'GeneralLedger',             transform: transformGeneralLedger,  requiresDates: true  },
  aragingsummary:            { qbo: 'AgedReceivables',           transform: transformGeneric,        requiresDates: false },
  aragingdetail:             { qbo: 'AgedReceivableDetail',      transform: transformGeneric,        requiresDates: false },
  apagingsummary:            { qbo: 'AgedPayables',              transform: transformGeneric,        requiresDates: false },
  apagingdetail:             { qbo: 'AgedPayableDetail',         transform: transformGeneric,        requiresDates: false },
  customerbalance:           { qbo: 'CustomerBalance',           transform: transformGeneric,        requiresDates: false },
  vendorbalance:             { qbo: 'VendorBalance',             transform: transformGeneric,        requiresDates: false },
  inventoryvaluationsummary: { qbo: 'InventoryValuationSummary', transform: transformGeneric,        requiresDates: false },
};

function listReportTypes() { return Object.keys(REPORT_DEFS); }
function isKnownType(type) { return Object.prototype.hasOwnProperty.call(REPORT_DEFS, type); }

// ─── QBO param mapping ──────────────────────────────────────────────────────
function buildQboParams(type, def, params) {
  const out = { minorversion: MINOR_VERSION };
  const from = params.from_date || params.from || null;
  const to   = params.to_date   || params.to   || null;
  if (def.requiresDates || from || to) {
    if (from) out.start_date = from;
    if (to)   out.end_date   = to;
  }
  // Aging / balance reports anchor on a single date.
  if (!def.requiresDates && to) out.report_date = to;

  const basis = (params.accounting_basis || params.basis || '').toLowerCase();
  if (basis === 'cash')    out.accounting_method = 'Cash';
  if (basis === 'accrual') out.accounting_method = 'Accrual';

  // Monthly column breakdown (used by the Budget Summary builder).
  if (params.summarize_column_by) out.summarize_column_by = params.summarize_column_by;

  // "Display columns by" (interval) → QBO's summarize_column_by. QBO natively
  // returns one value column per sub-period, which the generic transformer
  // already renders as multiple columns.
  if (!out.summarize_column_by && params.interval) {
    const COLUMN_BY = {
      months: 'Month', quarters: 'Quarter', years: 'Year',
      days: 'Days', weeks: 'Week',
      customers: 'Customers', vendors: 'Vendors', employees: 'Employees',
      products: 'ProductsAndServices',
    };
    if (COLUMN_BY[params.interval]) out.summarize_column_by = COLUMN_BY[params.interval];
  }

  return out;
}

// ─── QBO report column → our columns ────────────────────────────────────────
function buildColumns(qboColumns) {
  const cols = Array.isArray(qboColumns?.Column) ? qboColumns.Column : [];
  if (!cols.length) {
    return [{ key: 'label', label: '', align: 'left' }, { key: 'c0', label: 'Total', align: 'right' }];
  }
  return cols.map((c, i) => {
    if (i === 0) return { key: 'label', label: c.ColTitle || '', align: 'left' };
    return { key: `c${i}`, label: c.ColTitle || '', align: 'right' };
  });
}

// Pull the entity-id (account / txn) out of a QBO ColData cell.
function colId(cell) {
  return cell && cell.id != null && cell.id !== '' ? String(cell.id) : null;
}

// ─── GENERIC transformer (P&L, Balance Sheet, Cash Flow, Aging, balances) ───
function transformGeneric(body) {
  const columns = buildColumns(body?.Columns);
  const valueKeys = columns.slice(1).map((c) => c.key);
  const rows = [];

  function cellsFromColData(colData) {
    const cells = {};
    valueKeys.forEach((k, idx) => {
      const cell = colData[idx + 1];
      cells[k] = cell ? num(cell.value) : null;
    });
    return cells;
  }

  function walk(rowList, level) {
    if (!Array.isArray(rowList)) return;
    rowList.forEach((row) => {
      const type = row.type;
      const isSection = type === 'Section' || row.Rows || row.Header || row.Summary;
      if (isSection) {
        const headerCd = row.Header?.ColData || [];
        const headerLabel = headerCd[0]?.value || '';
        const hasSummary = Array.isArray(row.Summary?.ColData) && row.Summary.ColData.length;
        // QBO wraps profit lines (GrossProfit, NetOperatingIncome, …) in a
        // group node whose Header has no label — the Summary carries the real
        // label + total. Only emit a header row when it has its own label
        // (skip the empty camelCase group node; its Summary renders below).
        const headerCells = cellsFromColData(headerCd);
        const headerHasAmt = valueKeys.some((k) => headerCells[k] != null && headerCells[k] !== 0);
        const label = headerLabel || (hasSummary ? '' : row.group || '');
        if (label) {
          rows.push({
            label, level, isHeader: true,
            cells: headerHasAmt ? headerCells : {},
            accountRef: colId(headerCd[0]),
          });
        }
        walk(row.Rows?.Row, level + 1);
        // Summary → subtotal (or grand total at top level)
        const sumCd = row.Summary?.ColData;
        if (Array.isArray(sumCd) && sumCd.length) {
          const slabel = sumCd[0]?.value || (label ? `Total ${label}` : 'Total');
          const isTop = level === 0;
          const isNet = /\b(net (income|profit|loss)|net cash)\b/i.test(slabel);
          rows.push({
            label: slabel, level,
            isTotal: isTop && isNet,
            isSubtotal: !(isTop && isNet),
            cells: cellsFromColData(sumCd),
          });
        }
      } else {
        // Data row (leaf)
        const cd = row.ColData || [];
        rows.push({
          label: cd[0]?.value || '',
          level,
          cells: cellsFromColData(cd),
          accountRef: colId(cd[0]),
        });
      }
    });
  }

  walk(body?.Rows?.Row, 0);
  return { columns, rows, currency: body?.Header?.Currency || 'USD' };
}

// ─── TRIAL BALANCE (Account | Debit | Credit) ───────────────────────────────
function transformTrialBalance(body) {
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
      if (row.Rows || row.Header || row.Summary) {
        const hcd = row.Header?.ColData || [];
        if (hcd[0]?.value) rows.push({ label: hcd[0].value, level, isHeader: true, cells: {} });
        walk(row.Rows?.Row, level + 1);
        const scd = row.Summary?.ColData;
        if (Array.isArray(scd) && scd.length) {
          rows.push({
            label: scd[0]?.value || 'Total', level, isSubtotal: true,
            cells: { debit: num(scd[1]?.value), credit: num(scd[2]?.value) },
          });
        }
      } else {
        const cd = row.ColData || [];
        const d = num(cd[1]?.value), c = num(cd[2]?.value);
        totDebit += d || 0; totCredit += c || 0;
        rows.push({
          label: cd[0]?.value || '', level,
          cells: { debit: d, credit: c },
          accountRef: colId(cd[0]),
        });
      }
    });
  }
  walk(body?.Rows?.Row, 0);
  rows.push({
    label: 'TOTAL', level: 0, isTotal: true,
    cells: { debit: Math.round(totDebit * 100) / 100, credit: Math.round(totCredit * 100) / 100 },
  });
  return { columns, rows, currency: body?.Header?.Currency || 'USD', _totals: { debit: totDebit, credit: totCredit } };
}

// ─── GENERAL LEDGER (grouped by account; per-txn detail rows) ───────────────
// QBO GeneralLedger columns vary; the stable identifier is each column's
// MetaData ColKey (ColType is just the generic data type — Date/String/Money).
function transformGeneralLedger(body) {
  const qcols = Array.isArray(body?.Columns?.Column) ? body.Columns.Column : [];
  const idxByKey = {};
  qcols.forEach((c, i) => {
    const key = (c.MetaData || []).find((m) => m.Name === 'ColKey')?.Value;
    if (key && idxByKey[key] == null) idxByKey[key] = i;
  });

  const columns = [
    { key: 'label',   label: 'Date',        align: 'left'  },
    { key: 'type',    label: 'Transaction', align: 'left'  },
    { key: 'docnum',  label: 'Num',         align: 'left'  },
    { key: 'name',    label: 'Name',        align: 'left'  },
    { key: 'memo',    label: 'Memo',        align: 'left'  },
    { key: 'account', label: 'Account',     align: 'left'  },
    { key: 'debit',   label: 'Debit',       align: 'right' },
    { key: 'credit',  label: 'Credit',      align: 'right' },
    { key: 'balance', label: 'Balance',     align: 'right' },
  ];
  const rows = [];

  // Locate the relevant column indices by ColKey (fall back to positional).
  const iDate    = idxByKey.tx_date   ?? 0;
  const iType    = idxByKey.txn_type  ?? 1;
  const iDoc     = idxByKey.doc_num   ?? 2;
  const iName    = idxByKey.name      ?? 3;
  const iMemo    = idxByKey.memo      ?? idxByKey.memo_desc ?? 4;
  // Some GL variants expose explicit debit/credit columns; the common one gives
  // a single signed "Amount" (subt_nat_amount) instead → split by sign below.
  const iDebit   = idxByKey.debt_amt  ?? idxByKey.debit     ?? null;
  const iCredit  = idxByKey.credit_amt?? idxByKey.credit    ?? null;
  const iBalance = idxByKey.rbal_nat_amount ?? idxByKey.rbal_nat_home_amount ?? idxByKey.balance ?? null;
  const iAmount  = idxByKey.subt_nat_amount ?? idxByKey.subt_nat_home_amount ?? idxByKey.nat_home_amount ?? idxByKey.amount ?? null;

  function walk(rowList, level, accCtx) {
    if (!Array.isArray(rowList)) return;
    rowList.forEach((row) => {
      if (row.Rows || row.Header || row.Summary) {
        const hcd = row.Header?.ColData || [];
        const accName = hcd[0]?.value || '';
        const accRef  = colId(hcd[0]) || accCtx.ref;
        const ctx = accName ? { ref: accRef, name: accName } : accCtx;
        if (accName) rows.push({ label: accName, level, isHeader: true, cells: {}, accountRef: accRef });
        walk(row.Rows?.Row, level + 1, ctx);
        const scd = row.Summary?.ColData;
        if (Array.isArray(scd) && scd.length) {
          rows.push({ label: scd[0]?.value || `Total ${accName}`, level, isSubtotal: true,
            cells: { balance: num(scd[iBalance != null ? iBalance : scd.length - 1]?.value) } });
        }
      } else {
        const cd = row.ColData || [];
        const get = (i) => (i != null && cd[i] ? cd[i].value : '');
        // Prefer explicit debit/credit columns; else the signed natural Amount.
        let debit = iDebit != null ? num(get(iDebit)) : null;
        let credit = iCredit != null ? num(get(iCredit)) : null;
        const amount = iAmount != null ? num(get(iAmount)) : null;
        const txnCell = cd[iType];
        rows.push({
          label: get(iDate), level,
          cells: {
            type:    get(iType),
            docnum:  get(iDoc),
            name:    get(iName),
            memo:    get(iMemo),
            account: accCtx.name || '',
            amount,            // signed, account-natural (positive = normal-side increase)
            debit, credit,     // populated by applyGlNormalSides() using classification
            balance: iBalance != null ? num(get(iBalance)) : null,
          },
          accountRef:  accCtx.ref || null,
          accountName: accCtx.name || null,
          sourceType:  get(iType) || null,
          sourceRef:   colId(txnCell),
        });
      }
    });
  }
  walk(body?.Rows?.Row, 0, { ref: null, name: null });
  return { columns, rows, currency: body?.Header?.Currency || 'USD', _glNatural: true };
}

// Convert each GL row's signed, account-natural `amount` into universal
// debit/credit using the account's normal balance side. classMap maps
// accountRef → 'debit' | 'credit' (the account's normal side). Accounts whose
// side is unknown default to 'debit'. Idempotent; only fills when amount is set.
function applyGlNormalSides(transformed, classMap) {
  if (!transformed || !Array.isArray(transformed.rows)) return transformed;
  for (const r of transformed.rows) {
    if (r.isHeader || r.isSubtotal || r.isTotal) continue;
    const amt = r.cells?.amount;
    // Skip rows that already arrived with explicit debit/credit and no signed amount.
    if (amt == null) continue;
    const side = classMap[r.accountRef] || 'debit';
    if (side === 'credit') {
      r.cells.debit  = amt < 0 ? -amt : 0;
      r.cells.credit = amt >= 0 ? amt : 0;
    } else {
      r.cells.debit  = amt >= 0 ? amt : 0;
      r.cells.credit = amt < 0 ? -amt : 0;
    }
  }
  return transformed;
}

// classification → normal balance side
function normalSideForClassification(classification) {
  return /^(Liability|Equity|Revenue|Income)$/i.test(String(classification || '')) ? 'credit' : 'debit';
}

// ─── cache ──────────────────────────────────────────────────────────────────
// The cache (acc_report_cache) is a pure optimization. If the table is absent
// the report must still render straight from the QBO API, so a read failure is
// swallowed and treated as a miss rather than failing the whole request.
async function readCache(userId, connRef, reportType, paramsHash) {
  try {
    const [rows] = await pool.execute(
      `SELECT transformed, body, expires_at FROM acc_report_cache
        WHERE user_id = ? AND provider = 'quickbooks' AND connection_ref = ?
          AND report_type = ? AND params_hash = ? LIMIT 1`,
      [userId, connRef, reportType, paramsHash]
    );
    return rows[0] || null;
  } catch (e) {
    console.warn('[qbo-reports] cache read skipped:', e.message);
    return null;
  }
}
async function writeCache(userId, connRef, reportType, paramsHash, paramsJson, statusCode, body, transformed, ttlMs) {
  const expiresAt = new Date(Date.now() + ttlMs);
  await pool.execute(
    `INSERT INTO acc_report_cache
       (user_id, provider, connection_ref, report_type, params_hash, params_json, status_code, body, transformed, fetched_at, expires_at)
     VALUES (?, 'quickbooks', ?, ?, ?, CAST(? AS JSON), ?, ?, ?, CURRENT_TIMESTAMP, ?)
     ON DUPLICATE KEY UPDATE
       params_json = VALUES(params_json), status_code = VALUES(status_code),
       body = VALUES(body), transformed = VALUES(transformed),
       fetched_at = CURRENT_TIMESTAMP, expires_at = VALUES(expires_at)`,
    [userId, connRef, reportType, paramsHash, JSON.stringify(paramsJson || {}),
     statusCode, body == null ? null : JSON.stringify(body),
     transformed == null ? null : JSON.stringify(transformed), expiresAt]
  );
}

// ─── raw QBO report fetch (also used by the ledger ingestor) ────────────────
async function fetchRawQboReport(realmId, accessToken, environment, qboReportName, qboParams) {
  const url = `${getApiBase(environment)}/v3/company/${realmId}/reports/${qboReportName}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    params:  qboParams,
  });
  return res.data;
}

// ─── main entry: fetch + cache + transform ──────────────────────────────────
async function fetchReport(userId, type, params = {}, { refresh = false, ttlMs = DEFAULT_TTL_MS } = {}) {
  // QBO exposes no budget through its API, so there is nothing to print; the
  // shared builder says so honestly rather than passing actuals off as a budget.
  // Budget Variance IS derived from QBO's P&L (actuals against an absent
  // budget, which is what QBO itself shows). Lazy require avoids a load-time
  // circular dependency.
  if (type === 'budgetsummary') {
    const { buildBudgetSummary } = require('./budgetSummaryService');
    return buildBudgetSummary(userId, params);
  }
  if (type === 'budgetvariance') {
    const { buildQuickbooksBudgetVariance } = require('./quickbooksBudgetVarianceService');
    return buildQuickbooksBudgetVariance(userId, params);
  }

  // Sales/AR + Purchases/AP reports are built from the shared `invoices` /
  // `bills` / `expense_entries` warehouses (the same provider-agnostic builders
  // Zoho + Xero use) so all three providers render an IDENTICAL structure. QBO
  // documents are mirrored there by syncInvoices/syncBills keyed on the realm_id,
  // so passing the realm as org_id makes these work with only the data differing
  // per provider. This overrides QBO's native AgedReceivables/AgedPayables
  // (REPORT_DEFS) so the layout matches Zoho + Xero.
  if (['salesbycustomer', 'aragingsummary', 'aragingdetail',
       'apagingsummary', 'apagingdetail', 'vendorbalancedetail',
       'supplierinvoicesummary', 'expensesbyvendorsummary', 'vendorcontactlist',
       'transactiondetailbyaccount', 'transactionlistbyvendor',
       'taxliability', 'tdssummary', 'gstreturnsworkbook',
       'foreigncurrencygainsandlosses', 'realizedgainorloss',
       'inventoryitemsummary'].includes(type)) {
    const effId = await getEffectiveQBUserId(userId);
    const [[row]] = await pool.execute('SELECT realm_id FROM qbo_tokens WHERE user_id = ?', [effId]);
    const orgId = row?.realm_id;
    if (!orgId) {
      return { columns: [{ key: 'label', label: '', align: 'left' }], rows: [], currency: 'USD',
        empty: true, unavailable: true, emptyReason: 'unavailable' };
    }
    // No platform filter — user_id + org_id (realm_id) already scope the data,
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
    // return a graceful empty layout for QuickBooks — honest, not an error.
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

  // ── DB-only financial statements ──────────────────────────────────────────
  // Profit & Loss / Balance Sheet / Trial Balance / General Ledger / Cash Flow /
  // Bank Summary / Executive Summary are built from our synced QuickBooks ledger
  // (account_transactions / bank_transactions, org_id = realm_id) via the
  // provider-agnostic Zoho builders — NEVER a live QuickBooks Reports API call.
  // Any other report type has no DB source and returns a graceful empty state.
  const effId = await getEffectiveQBUserId(userId);
  const [[tokRow]] = await pool.execute('SELECT realm_id FROM qbo_tokens WHERE user_id = ?', [effId]);
  const orgId = tokRow?.realm_id;
  const emptyOut = { columns: [{ key: 'label', label: '', align: 'left' }], rows: [],
    currency: 'USD', empty: true, unavailable: true, emptyReason: 'unavailable' };
  if (!orgId) return emptyOut;
  const opts = { ...params, org_id: orgId, platform: 'quickbooks' };

  switch (type) {
    case 'profitandloss':    return require('./zohoLedgerReportsService').buildProfitAndLoss(effId, opts);
    case 'cashflow':         return require('./zohoLedgerReportsService').buildCashFlow(effId, opts);
    case 'balancesheet':     return require('./zohoGlReportsService').buildBalanceSheet(effId, opts);
    case 'trialbalance':     return require('./zohoGlReportsService').buildTrialBalance(effId, opts);
    case 'generalledger':    return require('./zohoGlReportsService').buildGeneralLedger(effId, opts);
    case 'banksummary':      return require('./bankSummaryService').buildBankSummary(effId, opts);
    case 'executivesummary': return require('./executiveSummaryService').buildExecutiveSummary(effId, opts);
    default:                 return emptyOut;
  }
}

module.exports = {
  REPORT_DEFS,
  listReportTypes,
  isKnownType,
  fetchReport,
  fetchRawQboReport,
  buildQboParams,
  transformGeneralLedger,
  transformTrialBalance,
  transformGeneric,
  applyGlNormalSides,
  normalSideForClassification,
};
