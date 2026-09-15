'use strict';

/**
 * QuickBooksProvider — accounting adapter for QuickBooks Online.
 * ---------------------------------------------------------------------------
 * Reports are built ENTIRELY from our own synced database (account_transactions,
 * scoped by org_id = realm_id) — never from QBO's live Reports API. Accounts come
 * from the synced qbo_accounts table; source documents from the qbo_entities
 * warehouse payloads. Honours the company-owned connection model (clients inherit
 * the admin's realm) via getEffectiveQBUserId.
 */

const AccountingProvider = require('./AccountingProvider');
const pool = require('../../config/db');
const { getEffectiveQBUserId } = require('../quickbooksService');
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
const ledgerReports = require('../zohoLedgerReportsService');
const { buildCashFlowStatement } = require('../cashFlowStatementService');
const glReports = require('../zohoGlReportsService');
const execSummary = require('../executiveSummaryService');
const bankSummary = require('../bankSummaryService');
const cashSummary = require('../cashSummaryService');
const budgetVariance = require('../budgetVarianceService');
const budgetSummary = require('../budgetSummaryService');

// Reports we build from our OWN synced QuickBooks general ledger
// (account_transactions, scoped by org_id = QBO realm_id) instead of calling
// QBO's Reports API — per the DB-backed reporting mandate. The Zoho ledger
// builders are provider-agnostic: they read account_transactions by
// (user_id, org_id) and honour params.org_id first, so passing the QBO realm_id
// as org_id runs them off the QuickBooks ledger (populated by
// quickbooksService.syncGeneralLedger).
const QBO_DB_BUILDERS = {
  profitandloss:     (uid, p) => ledgerReports.buildProfitAndLoss(uid, p),
  cashflow:          (uid, p) => buildCashFlowStatement(uid, p),
  cashflowstatement: (uid, p) => buildCashFlowStatement(uid, p),
  salesbycustomer:       (uid, p) => buildSalesByCustomer(uid, p),
  salesbycustomerdetail: (uid, p) => buildSalesByCustomerDetail(uid, p),
  salesbyproductsummary: (uid, p) => buildSalesByProductSummary(uid, p),
  salesbyproductdetail:  (uid, p) => buildSalesByProductDetail(uid, p),
  // AR/AP aging come from the shared `invoices` / `bills` warehouses (QBO docs
  // are mirrored there keyed on the realm_id), not the GL.
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
  // builder so QuickBooks doesn't fall through to the bare columns:[] empty.
  recurringinvoicedetails: (uid, p) => buildRecurringInvoices(uid, p),
  // Credit Notes reads the synced `zb_credit_notes` silver table (shared across
  // all 3 platforms), not the GL — so it renders its format + "No data
  // available" even when the realm has no credit notes synced yet.
  creditnotedetails: (uid, p) => buildCreditNoteDetails(uid, p),
  taxliability:     (uid, p) => buildTaxLiability(uid, p),
  // GSTR-3B Summary workbook — reconstructed from the shared ledger
  // (Output/Input CGST/SGST/IGST rows in account_transactions). buildGstReturnsWorkbook
  // branches to its ledger path when params.platform is 'quickbooks'.
  gstreturnsworkbook: (uid, p) => buildGstReturnsWorkbook(uid, p),
};

// Builders that read their own synced silver tables (zb_recurring_invoices, …)
// and do NOT need a synced general ledger. They run even when the realm has no
// account_transactions rows, so their own report-shaped "no data" payload (full
// column skeleton + emptyText) reaches the viewer instead of the bare
// columns:[] empty that renders as "no transactions during the date range".
const LEDGER_OPTIONAL_BUILDERS = new Set([
  'recurringinvoices',
  'recurringinvoicedetails',
  'creditnotedetails',
  // Always render the GSTR-3B section skeleton (numbered 3.1 / 3.1.1 / 3.2 / 4 / 5)
  // even for a realm with no synced ledger — the builder fills zeros itself.
  'gstreturnsworkbook',
]);

// Honest empty report — returned when a report has no DB builder or the realm
// has no synced ledger. We NEVER fall back to QBO's live Reports API.
function emptyReport(conn) {
  return {
    columns: [],
    rows: [],
    currency: (conn && conn.currency) || 'USD',
    empty: true,
    emptyReason: 'no_data',
    meta: { source: 'qbo-ledger' },
  };
}

// QBO General-Ledger "Transaction Type" labels → qbo_entities.entity names.
// Used to resolve a drill-down leaf to its stored source-document payload.
const TXN_TYPE_TO_ENTITY = {
  'Invoice': 'Invoice',
  'Payment': 'Payment',
  'Sales Receipt': 'SalesReceipt',
  'Credit Memo': 'CreditMemo',
  'Refund': 'RefundReceipt',
  'Refund Receipt': 'RefundReceipt',
  'Estimate': 'Estimate',
  'Bill': 'Bill',
  'Bill Payment': 'BillPayment',
  'Bill Payment (Check)': 'BillPayment',
  'Bill Payment (Credit Card)': 'BillPayment',
  'Vendor Credit': 'VendorCredit',
  'Check': 'Purchase',
  'Expense': 'Purchase',
  'Cash Expense': 'Purchase',
  'Credit Card Expense': 'Purchase',
  'Credit Card Credit': 'Purchase',
  'Purchase Order': 'PurchaseOrder',
  'Deposit': 'Deposit',
  'Transfer': 'Transfer',
  'Journal Entry': 'JournalEntry',
  'Journal': 'JournalEntry',
  'Time Activity': 'TimeActivity',
};

class QuickBooksProvider extends AccountingProvider {
  get key() { return 'quickbooks'; }

  async resolveConnection(userId, reqOrgId = null) {
    const effectiveUserId = await getEffectiveQBUserId(userId);

    // An explicit realm (X-Org-Id switcher) wins when the user actually
    // connected it. Only meaningful once qbo_tokens allows multiple rows per
    // user (see db/multi-org-migration.sql); harmless before then.
    let pinnedRealm = null;
    if (reqOrgId) {
      try {
        const [[owned]] = await pool.execute(
          'SELECT realm_id FROM qbo_organizations WHERE user_id = ? AND realm_id = ? LIMIT 1',
          [effectiveUserId, String(reqOrgId)]
        );
        if (owned) pinnedRealm = owned.realm_id;
      } catch (_) { /* qbo_organizations optional */ }
    }

    // DB-ONLY. The realm_id (and environment) live in qbo_tokens and persist
    // after the access token expires. Report data comes entirely from our synced
    // tables, so we never refresh the OAuth token here — this path makes NO call
    // to QuickBooks.
    let realmId = pinnedRealm || null;
    let environment = null;
    if (!realmId) {
      try {
        const [[row]] = await pool.execute(
          'SELECT realm_id, environment FROM qbo_tokens WHERE user_id = ? AND realm_id IS NOT NULL LIMIT 1',
          [effectiveUserId]
        );
        realmId = row?.realm_id || null;
        environment = row?.environment || null;
      } catch (_) { /* no tokens — fall through to synced data tables */ }
    }
    if (!realmId) {
      try {
        const [[row]] = await pool.execute(
          'SELECT realm_id FROM qbo_accounts WHERE user_id = ? AND realm_id IS NOT NULL LIMIT 1',
          [effectiveUserId]
        );
        realmId = row?.realm_id || null;
      } catch (_) { /* table may not exist */ }
    }
    if (!realmId) {
      try {
        const [[row]] = await pool.execute(
          'SELECT realm_id FROM qbo_organizations WHERE user_id = ? AND realm_id IS NOT NULL LIMIT 1',
          [effectiveUserId]
        );
        realmId = row?.realm_id || null;
      } catch (_) { /* table may not exist */ }
    }
    if (!realmId) return null;

    let currency = 'USD', companyName = null;
    // The realm's home currency (QBO Preferences.CurrencyPrefs.HomeCurrency, stored
    // at connect time) is authoritative — reports must read in the same currency
    // QuickBooks itself reports in. qbo_accounts is only a fallback, and is absent
    // on reduced-schema deployments.
    try {
      const [[org]] = await pool.execute(
        `SELECT company_name, currency FROM qbo_organizations
          WHERE user_id = ? AND realm_id = ? LIMIT 1`,
        [effectiveUserId, realmId]
      );
      if (org?.company_name) companyName = org.company_name;
      if (/^[A-Z]{3}$/.test(org?.currency || '')) currency = org.currency;
    } catch (_) { /* optional */ }
    if (currency === 'USD') {
      try {
        const [[row]] = await pool.execute(
          `SELECT currency FROM qbo_accounts
            WHERE user_id = ? AND realm_id = ? AND currency IS NOT NULL LIMIT 1`,
          [effectiveUserId, realmId]
        );
        if (/^[A-Z]{3}$/.test(row?.currency || '')) currency = row.currency;
      } catch (_) { /* default */ }
    }

    return {
      provider:        'quickbooks',
      connectionRef:   realmId,
      userId,
      effectiveUserId,
      currency,
      environment,
      companyName,
    };
  }

  async listAccounts(conn) {
    const [rows] = await pool.execute(
      `SELECT qbo_id AS account_ref, account_number AS code, name,
              fully_qualified_name, account_type, account_sub_type, classification,
              parent_qbo_id AS parent_ref, currency, current_balance,
              current_balance_with_sub_accounts, is_sub_account, active
         FROM qbo_accounts
        WHERE user_id = ? AND realm_id = ?
        ORDER BY FIELD(classification,'Asset','Liability','Equity','Revenue','Expense'),
                 account_number IS NULL, account_number, name`,
      [conn.effectiveUserId, conn.connectionRef]
    );

    const accounts = rows.map((r) => ({
      accountRef:    String(r.account_ref),
      code:          r.code || null,
      name:          r.name,
      fullyQualifiedName: r.fully_qualified_name || r.name,
      accountType:   r.account_type,
      accountSubType: r.account_sub_type,
      classification: r.classification || 'Uncategorized',
      parentRef:     r.parent_ref != null ? String(r.parent_ref) : null,
      currency:      r.currency || conn.currency,
      currentBalance: Number(r.current_balance || 0),
      balanceWithSub: Number(r.current_balance_with_sub_accounts || 0),
      isSubAccount:  !!r.is_sub_account,
      active:        !!r.active,
    }));

    const groups = {};
    const totals = {};
    for (const a of accounts) {
      (groups[a.classification] ||= []).push(a);
    }
    for (const [k, list] of Object.entries(groups)) {
      totals[k] = list
        .filter((a) => a.active && !a.isSubAccount)
        .reduce((s, a) => s + a.balanceWithSub, 0);
    }
    return { accounts, groups, totals };
  }

  async fetchReport(conn, type, params = {}, opts = {}) {
    // DB-ONLY: serve the report from our synced QuickBooks general ledger
    // (account_transactions, org_id = realm_id). We NEVER call QBO's live Reports
    // API for report generation. A report with no local builder — or a realm with
    // no synced ledger — returns an honest empty report so the viewer shows its
    // "no data" state (sync the realm's data to populate it).
    const builder = QBO_DB_BUILDERS[type];
    const ledgerOptional = LEDGER_OPTIONAL_BUILDERS.has(type);
    if (builder && (ledgerOptional || await this._hasLedger(conn))) {
      const scoped = { ...params, org_id: conn.connectionRef, platform: 'quickbooks' };
      const report = await builder(conn.effectiveUserId, scoped);
      if (report && !report._noLocalData) {
        report.currency = conn.currency || report.currency;
        report.meta = { ...(report.meta || {}), source: 'qbo-ledger' };
        return report;
      }
    }
    return emptyReport(conn);
  }

  async fetchGeneralLedger(conn, params = {}) {
    return this.fetchReport(conn, 'generalledger', params, params.opts || {});
  }

  // True when we have a synced QuickBooks general ledger for this realm in
  // account_transactions (org_id = realm_id), i.e. DB-backed reports are usable.
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
    const entity = TXN_TYPE_TO_ENTITY[sourceType] || sourceType;
    const candidates = [entity];
    if (entity !== sourceType) candidates.push(sourceType); // try raw label too

    for (const ent of candidates) {
      const [[row]] = await pool.execute(
        `SELECT entity, qbo_id, display_name, doc_number, txn_date, total_amt,
                balance, currency, payload, qbo_created_at, qbo_updated_at
           FROM qbo_entities
          WHERE user_id = ? AND realm_id = ? AND entity = ? AND qbo_id = ? LIMIT 1`,
        [conn.effectiveUserId, conn.connectionRef, ent, String(sourceRef)]
      );
      if (row) {
        let payload = row.payload;
        if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) {} }
        return {
          provider:    'quickbooks',
          sourceType:  sourceType,
          entity:      row.entity,
          sourceRef:   String(row.qbo_id),
          displayName: row.display_name,
          docNumber:   row.doc_number,
          txnDate:     row.txn_date,
          totalAmt:    row.total_amt != null ? Number(row.total_amt) : null,
          balance:     row.balance != null ? Number(row.balance) : null,
          currency:    row.currency || conn.currency,
          createdAt:   row.qbo_created_at,
          updatedAt:   row.qbo_updated_at,
          payload,
        };
      }
    }
    return null;
  }
}

module.exports = QuickBooksProvider;
