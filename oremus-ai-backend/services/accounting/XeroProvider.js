'use strict';

/**
 * XeroProvider — accounting adapter for Xero.
 * ---------------------------------------------------------------------------
 * Reports are built ENTIRELY from our own synced database (account_transactions,
 * scoped by org_id = tenant_id) — never from Xero's live /Reports API. Accounts
 * come from the synced xero_accounts table. Honours the company-owned connection
 * model (clients inherit the admin's tenant) via getEffectiveXeroUserId.
 *
 * A report with no DB builder — or a tenant with no synced ledger — returns an
 * honest empty report (viewer shows its "no data" state).
 */

const AccountingProvider = require('./AccountingProvider');
const pool = require('../../config/db');
const { getEffectiveXeroUserId } = require('../xeroService');
const ledgerReports = require('../zohoLedgerReportsService');
const { buildCashFlowStatement } = require('../cashFlowStatementService');
const { buildSalesByCustomer, buildSalesByCustomerDetail, buildSalesByProductSummary, buildArAgingSummary } = require('../salesArFromInvoicesService');
const { buildSalesByProductDetail } = require('../zohoSalesByProductDetailService');
const { buildArAgingDetail } = require('../zohoArAgingDetailService');
const { buildRecurringInvoices } = require('../zohoRecurringInvoicesService');
const { buildCreditNoteDetails } = require('../zohoCreditNoteDetailsService');
const { buildApAgingSummary, buildApAgingDetail } = require('../zohoApAgingDetailService');
const { buildVendorBalanceDetail } = require('../zohoVendorBalanceDetailService');
const { buildVendorBalanceSummary } = require('../zohoVendorBalanceSummaryService');
const { buildSupplierInvoiceSummary } = require('../zohoSupplierInvoiceSummaryService');
const { buildVendorContactList } = require('../zohoVendorContactListService');
const { buildExpensesByVendorSummary } = require('../zohoExpensesByVendorSummaryService');
const { buildTdsSummary } = require('../zohoTdsSummaryService');
const { buildTaxLiability } = require('../zohoTaxLiabilityService');
const { buildGstReturnsWorkbook } = require('../zohoGstReturnsWorkbookService');
const { buildTransactionListByVendor } = require('../zohoTransactionListByVendorService');
const { buildTransactionDetailByAccount } = require('../zohoTransactionDetailByAccountService');
const { buildBankReconciliation } = require('../zohoBankReconciliationService');
const { buildPurchasesByItem } = require('../zohoPurchasesByItemService');
const { buildInventoryItemSummary } = require('../zohoInventoryItemSummaryService');
const { buildRealisedForex, buildForexGainsLosses } = require('../zohoForexService');
const { buildChartOfAccounts } = require('../zohoChartOfAccountsService');
const glReports = require('../zohoGlReportsService');
const execSummary = require('../executiveSummaryService');
const bankSummary = require('../bankSummaryService');
const cashSummary = require('../cashSummaryService');
const budgetVariance = require('../budgetVarianceService');
const budgetSummary = require('../budgetSummaryService');

// Reports we build from our OWN synced Xero general ledger (account_transactions,
// scoped by org_id = Xero tenant_id) instead of calling Xero's /Reports API — per
// the DB-backed reporting mandate. The Zoho ledger builders are fully provider-
// agnostic: they read account_transactions by (user_id, org_id) and honour
// params.org_id first, so passing the Xero tenant_id as org_id runs them off the
// Xero ledger. General Ledger has no Xero /Reports equivalent, so this is the only
// way Xero can serve a GL at all.
const XERO_DB_BUILDERS = {
  profitandloss:     (uid, p) => ledgerReports.buildProfitAndLoss(uid, p),
  cashflow:          (uid, p) => buildCashFlowStatement(uid, p),
  cashflowstatement: (uid, p) => buildCashFlowStatement(uid, p),
  salesbycustomer:       (uid, p) => buildSalesByCustomer(uid, p),
  salesbycustomerdetail: (uid, p) => buildSalesByCustomerDetail(uid, p),
  salesbyproductsummary: (uid, p) => buildSalesByProductSummary(uid, p),
  salesbyproductdetail:  (uid, p) => buildSalesByProductDetail(uid, p),
  // AR/AP aging come from the shared `invoices` / `bills` warehouses (Xero docs
  // are mirrored there keyed on the tenant_id), not the GL.
  aragingsummary:   (uid, p) => buildArAgingSummary(uid, p),
  aragingdetail:    (uid, p) => buildArAgingDetail(uid, p),
  apagingsummary:   (uid, p) => buildApAgingSummary(uid, p),
  apagingdetail:    (uid, p) => buildApAgingDetail(uid, p),
  vendorbalancedetail: (uid, p) => buildVendorBalanceDetail(uid, p),
  vendorbalancesummary: (uid, p) => buildVendorBalanceSummary(uid, p),
  supplierinvoicesummary: (uid, p) => buildSupplierInvoiceSummary(uid, p),
  vendorcontactlist: (uid, p) => buildVendorContactList(uid, p),
  expensesbyvendorsummary: (uid, p) => buildExpensesByVendorSummary(uid, p),
  transactionlistbyvendor: (uid, p) => buildTransactionListByVendor(uid, p),
  transactiondetailbyaccount: (uid, p) => buildTransactionDetailByAccount(uid, p),
  bankreconciliation: (uid, p) => buildBankReconciliation(uid, p),
  purchasesbyitem:  (uid, p) => buildPurchasesByItem(uid, p),
  inventoryitemsummary: (uid, p) => buildInventoryItemSummary(uid, p),
  realizedgainorloss: (uid, p) => buildRealisedForex(uid, p),
  foreigncurrencygainsandlosses: (uid, p) => buildForexGainsLosses(uid, p),
  chartofaccounts:  (uid, p) => buildChartOfAccounts(uid, p),
  balancesheet:     (uid, p) => glReports.buildBalanceSheet(uid, p),
  trialbalance:     (uid, p) => glReports.buildTrialBalance(uid, p),
  generalledger:    (uid, p) => glReports.buildGeneralLedger(uid, p),
  banksummary:      (uid, p) => bankSummary.buildBankSummary(uid, p),
  executivesummary: (uid, p) => execSummary.buildExecutiveSummary(uid, p),
  cashsummary:      (uid, p) => cashSummary.buildCashSummary(uid, p),
  budgetvariance:   (uid, p) => budgetVariance.buildBudgetVariance(uid, p),
  budgetsummary:    (uid, p) => budgetSummary.buildBudgetSummary(uid, p),
  tdssummary:       (uid, p) => buildTdsSummary(uid, p),
  recurringinvoices: (uid, p) => buildRecurringInvoices(uid, p),
  // The Reports catalog card "Recurring Invoices" sends liveType
  // `recurringinvoicedetails` (mirrors routes/zbReports.js). Alias it to the same
  // builder so Xero doesn't fall through to the bare columns:[] empty.
  recurringinvoicedetails: (uid, p) => buildRecurringInvoices(uid, p),
  // Credit Notes reads the synced `zb_credit_notes` silver table (shared across
  // all 3 platforms), not the GL — so it renders its format + "No data
  // available" even when the tenant has no credit notes synced yet.
  creditnotedetails: (uid, p) => buildCreditNoteDetails(uid, p),
  taxliability:     (uid, p) => buildTaxLiability(uid, p),
  // GSTR-3B Summary workbook — reconstructed from the shared ledger
  // (Output/Input CGST/SGST/IGST rows in account_transactions). buildGstReturnsWorkbook
  // branches to its ledger path when params.platform is 'xero'.
  gstreturnsworkbook: (uid, p) => buildGstReturnsWorkbook(uid, p),
};

// Builders that read their own synced silver tables (zb_recurring_invoices, …)
// and do NOT need a synced general ledger. They run even when the tenant has no
// account_transactions rows, so their own report-shaped "no data" payload (full
// column skeleton + emptyText) reaches the viewer instead of the bare
// columns:[] empty that renders as "no transactions during the date range".
const LEDGER_OPTIONAL_BUILDERS = new Set([
  'recurringinvoices',
  'recurringinvoicedetails',
  'creditnotedetails',
  // Always render the GSTR-3B section skeleton (numbered 3.1 / 3.1.1 / 3.2 / 4 / 5)
  // even for a tenant with no synced ledger — the builder fills zeros itself.
  'gstreturnsworkbook',
]);

// Honest empty report — returned when a report has no DB builder or the tenant
// has no synced ledger. We NEVER fall back to Xero's live /Reports API.
function emptyReport(conn) {
  return {
    columns: [],
    rows: [],
    currency: (conn && conn.currency) || 'USD',
    empty: true,
    emptyReason: 'no_data',
    meta: { source: 'xero-ledger' },
  };
}

// Xero account `class` → universal classification label.
const CLASS_LABEL = {
  ASSET:     'Asset',
  LIABILITY: 'Liability',
  EQUITY:    'Equity',
  REVENUE:   'Revenue',
  EXPENSE:   'Expense',
};

class XeroProvider extends AccountingProvider {
  get key() { return 'xero'; }

  async resolveConnection(userId, reqOrgId = null) {
    const effectiveUserId = await getEffectiveXeroUserId(userId);

    // An explicit org (X-Org-Id switcher) wins when it's one this user actually
    // connected — otherwise fall through to the active tenant.
    let tenantId = null;
    if (reqOrgId) {
      try {
        const [[owned]] = await pool.execute(
          'SELECT tenant_id FROM xero_organizations WHERE user_id = ? AND tenant_id = ? LIMIT 1',
          [effectiveUserId, String(reqOrgId)]
        );
        if (owned) tenantId = owned.tenant_id;
      } catch (_) { /* xero_organizations optional */ }
    }

    // DB-ONLY. The tenant_id lives in xero_tokens and persists after the access
    // token expires. Report data comes entirely from our synced tables, so we
    // never refresh the OAuth token here — this path makes NO call to Xero.
    if (!tenantId) {
      try {
        const [[tok]] = await pool.execute(
          'SELECT tenant_id FROM xero_tokens WHERE user_id = ? AND tenant_id IS NOT NULL LIMIT 1',
          [effectiveUserId]
        );
        tenantId = tok?.tenant_id || null;
      } catch (_) { /* no tokens — fall through to synced data tables */ }
    }

    // DB-only fallback: even without any xero_tokens row, we can resolve the
    // tenant from the synced data tables.  This lets reports work purely from
    // the database — no re-authorization needed after initial sync.
    if (!tenantId) {
      try {
        const [[row]] = await pool.execute(
          'SELECT tenant_id FROM xero_accounts WHERE user_id = ? AND tenant_id IS NOT NULL LIMIT 1',
          [effectiveUserId]
        );
        tenantId = row?.tenant_id || null;
      } catch (_) { /* table may not exist */ }
    }
    if (!tenantId) {
      try {
        const [[row]] = await pool.execute(
          "SELECT org_id AS tenant_id FROM account_transactions WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1",
          [effectiveUserId]
        );
        tenantId = row?.tenant_id || null;
      } catch (_) { /* table may not exist */ }
    }

    if (!tenantId) return null;

    let currency = 'USD', companyName = null;
    try {
      const [[org]] = await pool.execute(
        `SELECT name, currency FROM xero_organizations
          WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
        [effectiveUserId, tenantId]
      );
      if (org?.currency) currency = org.currency;
      if (org?.name) companyName = org.name;
    } catch (_) { /* optional */ }
    if (currency === 'USD') {
      try {
        const [[acc]] = await pool.execute(
          `SELECT currency_code FROM xero_accounts
            WHERE user_id = ? AND tenant_id = ? AND currency_code IS NOT NULL LIMIT 1`,
          [effectiveUserId, tenantId]
        );
        if (acc?.currency_code) currency = acc.currency_code;
      } catch (_) { /* default */ }
    }

    return {
      provider:      'xero',
      connectionRef: tenantId,
      userId,
      effectiveUserId,
      currency,
      environment:   null,
      companyName,
    };
  }

  async listAccounts(conn) {
    const [rows] = await pool.execute(
      `SELECT xero_id AS account_ref, code, name, type AS account_type,
              class AS classification, currency_code, balance, status
         FROM xero_accounts
        WHERE user_id = ? AND tenant_id = ?
        ORDER BY FIELD(class,'ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE'),
                 code IS NULL, code, name`,
      [conn.effectiveUserId, conn.connectionRef]
    );

    const accounts = rows.map((r) => ({
      accountRef:     String(r.account_ref),
      code:           r.code || null,
      name:           r.name,
      fullyQualifiedName: r.name,
      accountType:    r.account_type,
      classification: CLASS_LABEL[r.classification] || r.classification || 'Uncategorized',
      currency:       r.currency_code || conn.currency,
      currentBalance: Number(r.balance || 0),
      balanceWithSub: Number(r.balance || 0),
      active:         String(r.status || '').toUpperCase() === 'ACTIVE',
    }));

    const groups = {};
    const totals = {};
    for (const a of accounts) {
      (groups[a.classification] ||= []).push(a);
    }
    for (const [k, list] of Object.entries(groups)) {
      totals[k] = list
        .filter((a) => a.active)
        .reduce((s, a) => s + a.currentBalance, 0);
    }
    return { accounts, groups, totals };
  }

  async fetchReport(conn, type, params = {}, opts = {}) {
    // DB-ONLY: scope the shared ledger builder to this Xero tenant and run it off
    // our synced GL. We NEVER call Xero's live /Reports API for report generation.
    // A report with no local builder — or a tenant with no synced ledger —
    // returns an honest empty report so the viewer shows its "no data" state.
    const builder = XERO_DB_BUILDERS[type];
    const ledgerOptional = LEDGER_OPTIONAL_BUILDERS.has(type);
    if (builder && (ledgerOptional || await this._hasLedger(conn))) {
      // platform='xero' scopes every ledger query to this tenant's rows (all
      // Xero rows are stamped 'xero' by the posting engine since the stamping
      // fix). user_id + org_id (tenant_id) also uniquely scope to this tenant.
      const scoped = { ...params, org_id: conn.connectionRef, platform: 'xero' };
      const report = await builder(conn.effectiveUserId, scoped);
      if (report && !report._noLocalData) {
        report.currency = conn.currency || report.currency;
        report.meta = { ...(report.meta || {}), source: 'xero-ledger' };
        return report;
      }
    }
    return emptyReport(conn);
  }

  async fetchGeneralLedger(conn, params = {}) {
    if (await this._hasLedger(conn)) {
      const scoped = { ...params, org_id: conn.connectionRef, platform: 'xero' };
      const report = await glReports.buildGeneralLedger(conn.effectiveUserId, scoped);
      if (report && !report._noLocalData) {
        report.currency = conn.currency || report.currency;
        report.meta = { ...(report.meta || {}), source: 'xero-ledger' };
        return report;
      }
    }
    const e = new Error('Xero has no General Ledger report');
    e.code = 'NOT_IMPLEMENTED';
    throw e;
  }

  // True when we have a synced Xero general ledger for this tenant in
  // account_transactions (org_id = tenant_id), i.e. DB-backed reports are usable.
  async _hasLedger(conn) {
    try {
      const [[row]] = await pool.execute(
        `SELECT 1 AS ok FROM account_transactions
          WHERE user_id = ? AND org_id = ? LIMIT 1`,
        [conn.effectiveUserId, conn.connectionRef]
      );
      return !!row;
    } catch (_) { return false; }
  }

  async getSourceDocument(conn, sourceType, sourceRef) {
    if (!sourceRef) return null;
    const ref = String(sourceRef);
    // Probe the synced silver tables by their xero_id (raw Xero UUID).
    const probes = [
      ['invoices',         'invoice'],
      ['bills',            'bill'],
      ['expense_entries',  'expense'],
      ['bank_transactions', 'bank'],
      ['daybook_transactions', 'journal'],
      ['customers',        'customer'],
      ['vendors',          'vendor'],
    ];
    for (const [table, kind] of probes) {
      try {
        const [[row]] = await pool.execute(
          `SELECT * FROM \`${table}\` WHERE user_id = ? AND xero_id = ? LIMIT 1`,
          [conn.effectiveUserId, ref]
        );
        if (row) {
          return {
            provider:   'xero',
            sourceType,
            entity:     kind,
            sourceRef:  ref,
            payload:    row,
          };
        }
      } catch (_) { /* table may lack xero_id — skip */ }
    }
    return null;
  }
}

module.exports = XeroProvider;
