'use strict';

const { Router } = require('express');
const auth = require('../middleware/auth');
// listReportTypes only — the report DATA never comes from Zoho's report API.
// Every report is served from our own synced database (see LEDGER_BUILDERS +
// the invoice/warehouse builders below). Zoho is used solely for data sync and
// OAuth, per product requirement — so the report endpoints make ZERO Zoho calls.
const { listReportTypes } = require('../services/zohoBooksReportsService');
const { buildArAgingDetail } = require('../services/zohoArAgingDetailService');
const { buildSalesByCustomer, buildSalesByCustomerDetail, buildSalesByProductSummary, buildArAgingSummary } = require('../services/salesArFromInvoicesService');
const { buildProfitAndLoss, buildCashFlow, buildExpenseDetails } = require('../services/zohoLedgerReportsService');
const { buildExecutiveSummary } = require('../services/executiveSummaryService');
const { buildBudgetSummary } = require('../services/budgetSummaryService');
const { buildBudgetVariance } = require('../services/budgetVarianceService');
const { buildCashSummary } = require('../services/cashSummaryService');
const { buildCashFlowStatement } = require('../services/cashFlowStatementService');
const { buildSalesByProductDetail } = require('../services/zohoSalesByProductDetailService');
const { buildInventoryItemSummary } = require('../services/zohoInventoryItemSummaryService');
const { buildApAgingDetail, buildApAgingSummary } = require('../services/zohoApAgingDetailService');
const { buildVendorBalanceDetail } = require('../services/zohoVendorBalanceDetailService');
const { buildVendorBalanceSummary } = require('../services/zohoVendorBalanceSummaryService');
const { buildExpensesByVendorSummary } = require('../services/zohoExpensesByVendorSummaryService');
const { buildSupplierInvoiceSummary } = require('../services/zohoSupplierInvoiceSummaryService');
const { buildVendorContactList } = require('../services/zohoVendorContactListService');
const { buildChartOfAccounts } = require('../services/zohoChartOfAccountsService');
const { buildTransactionDetailByAccount } = require('../services/zohoTransactionDetailByAccountService');
const { buildTransactionListByVendor } = require('../services/zohoTransactionListByVendorService');
const { buildTaxLiability } = require('../services/zohoTaxLiabilityService');
const { buildRecurringInvoices } = require('../services/zohoRecurringInvoicesService');
const { buildPurchasesByItem } = require('../services/zohoPurchasesByItemService');
const { buildTdsSummary } = require('../services/zohoTdsSummaryService');
const { buildGstReturnsWorkbook } = require('../services/zohoGstReturnsWorkbookService');
const { buildRecurringBills } = require('../services/zohoRecurringBillsService');
const { buildForexGainsLosses, buildRealisedForex } = require('../services/zohoForexService');
const { buildBankReconciliation } = require('../services/zohoBankReconciliationService');
const { buildBalanceSheet, buildTrialBalance, buildGeneralLedger } = require('../services/zohoGlReportsService');
const { buildCreditNoteDetails } = require('../services/zohoCreditNoteDetailsService');
const { getEffectiveZohoUserId } = require('../services/zohoService');
const { getReportSettings } = require('../services/reportSettingsService');
const pool = require('../config/db');

// Resolve the connection's Zoho org_id (the shared invoice-derived builders
// require an explicit org_id rather than falling back internally).
async function resolveZohoOrgId(userId) {
  const [[row]] = await pool.execute('SELECT org_id FROM zb_tokens WHERE user_id = ?', [userId]);
  return row?.org_id || null;
}

// Connected company name for the report header — looked up from whichever
// provider owns this org_id. Best-effort; null on any miss. Lets the viewer
// print the company the data actually came from instead of a stale client name
// after an org switch or admin view-as-client.
async function orgDisplayName(userId, orgId) {
  if (!orgId) return null;
  const probes = [
    ['SELECT org_name AS n FROM zb_oauth_organizations WHERE user_id = ? AND org_id = ? LIMIT 1', [userId, String(orgId)]],
    ['SELECT company_name AS n FROM qbo_organizations WHERE user_id = ? AND realm_id = ? LIMIT 1', [userId, String(orgId)]],
    ['SELECT name AS n FROM xero_organizations WHERE user_id = ? AND tenant_id = ? LIMIT 1', [userId, String(orgId)]],
  ];
  for (const [sql, args] of probes) {
    try {
      const [[row]] = await pool.execute(sql, args);
      if (row?.n) return row.n;
    } catch { /* table absent on this deployment — try the next provider */ }
  }
  return null;
}

// Stamp result.meta.company (best-effort, never throws).
async function stampCompany(result, userId, orgId) {
  try {
    if (!result || typeof result !== 'object') return result;
    const company = await orgDisplayName(userId, orgId);
    if (company) result.meta = { ...(result.meta || {}), company: result.meta?.company || company };
  } catch { /* header is cosmetic — never fail the report over it */ }
  return result;
}

// Reports computed locally from the synced ledger (account_transactions /
// bank_transactions) instead of Zoho's report API — avoids the per-org daily
// API quota while returning the same { columns, rows, currency, meta } shape.
const LEDGER_BUILDERS = {
  profitandloss:    buildProfitAndLoss,
  cashflow:         buildCashFlowStatement,
  expensedetails:   buildExpenseDetails,
  executivesummary: buildExecutiveSummary,
  budgetsummary:    buildBudgetSummary,
  budgetvariance:   buildBudgetVariance,
  cashsummary:      buildCashSummary,
  cashflowstatement: buildCashFlowStatement,
  salesbyproductdetail: buildSalesByProductDetail,
  inventoryitemsummary: buildInventoryItemSummary,
  apagingdetail:    buildApAgingDetail,
  apagingsummary:   buildApAgingSummary,
  vendorbalancedetail: buildVendorBalanceDetail,
  vendorbalancesummary: buildVendorBalanceSummary,
  expensesbyvendorsummary: buildExpensesByVendorSummary,
  supplierinvoicesummary: buildSupplierInvoiceSummary,
  vendorcontactlist: buildVendorContactList,
  chartofaccounts: buildChartOfAccounts,
  transactiondetailbyaccount: buildTransactionDetailByAccount,
  transactionlistbyvendor: buildTransactionListByVendor,
  taxliability: buildTaxLiability,
  recurringinvoices: buildRecurringInvoices,
  recurringinvoicedetails: buildRecurringInvoices,
  purchasesbyitem: buildPurchasesByItem,
  tdssummary: buildTdsSummary,
  gstreturnsworkbook: buildGstReturnsWorkbook,
  recurringbills: buildRecurringBills,
  foreigncurrencygainsandlosses: buildForexGainsLosses,
  // Catalog liveType is `realizedgainorloss` (matches the Reports catalog card);
  // the old `realisedfxgainorloss` key never matched a request → fell through to
  // the live Zoho API → UNKNOWN_REPORT_TYPE → mock fallback.
  realizedgainorloss: buildRealisedForex,
  bankreconciliation: buildBankReconciliation,
  // GL-derived reports + Credit Notes, served from local tables (account_transactions /
  // zb_credit_notes) with a transparent live fallback when the org has no local data.
  balancesheet:     buildBalanceSheet,
  trialbalance:     buildTrialBalance,
  generalledger:    buildGeneralLedger,
  creditnotedetails: buildCreditNoteDetails,
};

// Honest empty report — returned when an org has no synced data for a report (or
// the report has no local builder yet). We NEVER fall back to the Zoho report
// API, so a missing-data report shows the viewer's "no data" state instead of a
// Zoho rate-limit / re-auth error. Sync the org's data to populate it.
function emptyReport(type, params) {
  return {
    columns: [],
    rows: [],
    currency: 'INR',
    empty: true,
    emptyReason: 'no_data',
    meta: {
      title: type,
      source: 'ledger',
      from: params.from_date || params.date_start || null,
      to: params.to_date || params.date_end || null,
    },
  };
}

const router = Router();
router.use(auth);
router.use(require('../middleware/adminClientView')); // honor admin view-as-client (X-Client-Id)

// GET /api/zb-reports/types
router.get('/types', (req, res) => {
  res.json({ types: listReportTypes() });
});

// GET /api/zb-reports/:type?from_date=&to_date=&refresh=
// Allow-list of forwarded query params (Zoho ignores unknown keys but we sanitize anyway)
const ALLOWED_PARAMS = new Set([
  'from_date', 'to_date', 'date_start', 'date_end', 'as_of_date',
  'accounting_basis', 'basis', 'entity',
  'account_id', 'customer_id', 'vendor_id',
  'show_zero_balance', 'show_breakup', 'include_zero',
  'tax_id', 'cash_basis',
  'group_by', 'sort_column', 'sort_order',
  'aging_by', 'interval', 'interval_type', 'interval_range', 'number_of_columns',
  'currency_id',
  'filter_by', 'usestate',
  'show_rows', 'compare_with', 'cash_based', 'is_hierarchy_report',
  'compare', 'compare_count', 'oldest_first',
  'periods', 'future_periods',
  'period', // Budget Summary: 'yearly' or 'monthly'
  'bs_from', // Balance Sheet: optional From date → Current-Year-Earnings split point
]);

router.get('/:type', async (req, res) => {
  try {
    const { type } = req.params;

    const params = {};
    Object.keys(req.query || {}).forEach((k) => {
      if (k === 'refresh') return;
      if (ALLOWED_PARAMS.has(k)) params[k] = req.query[k];
    });

    // Clients with integration_type='zoho' inherit the admin's Zoho connection
    // (single company-wide connection) — resolve the effective Zoho user so the
    // report fetches the admin's org/token instead of 400-ing (which made the
    // frontend fall back to mock data).
    // Admin view-as-client fallback: if the client has no Zoho connection,
    // try the admin's userId (they may own the company-wide Zoho connection).
    let effectiveUid = await getEffectiveZohoUserId(req.user.id);
    if (!effectiveUid || effectiveUid === req.user.id) {
      const [[tok]] = await pool.execute(
        'SELECT 1 FROM zb_tokens WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1',
        [effectiveUid]
      );
      if (!tok && req.adminUserId) {
        const adminUid = await getEffectiveZohoUserId(req.adminUserId);
        const [[adminTok]] = await pool.execute(
          'SELECT 1 FROM zb_tokens WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1',
          [adminUid]
        );
        if (adminTok) effectiveUid = adminUid;
      }
    }

    // Per-platform Financial Year start month (Settings → client override →
    // admin default → April). Keyed by req.user.id, which adminClientView has
    // already swapped to the client when an admin is viewing as one.
    try {
      params.fy_start_month = (await getReportSettings(req.user.id, 'zoho')).fyStartMonth;
    } catch { /* report_settings not present yet — builders default to April */ }

    // AR Aging Details is built from the synced warehouse (Zoho v3 India has no
    // working aging-details endpoint). Honour the X-Org-Id org switcher.
    if (type === 'aragingdetail') {
      if (req.orgId) params.org_id = req.orgId;
      const result = await buildArAgingDetail(effectiveUid, params);
      await stampCompany(result, effectiveUid, params.org_id);
      return res.json(result);
    }

    // Sales by Customer + AR Aging Summary are built from the shared `invoices`
    // warehouse (provider-agnostic — same builder serves QB + Xero), so they
    // need the org_id resolved (X-Org-Id switcher, else the connection's org).
    if (type === 'salesbycustomer' || type === 'salesbycustomerdetail'
        || type === 'salesbyproductsummary' || type === 'aragingsummary') {
      params.org_id = req.orgId || (await resolveZohoOrgId(effectiveUid));
      const builder = type === 'salesbycustomer' ? buildSalesByCustomer
        : type === 'salesbycustomerdetail' ? buildSalesByCustomerDetail
        : type === 'salesbyproductsummary' ? buildSalesByProductSummary
        : buildArAgingSummary;
      const result = await builder(effectiveUid, params);
      await stampCompany(result, effectiveUid, params.org_id);
      return res.json(result);
    }

    // P&L / Cash Flow / Expenses / BS / TB / GL / Credit Notes + every other
    // report below are computed entirely from our own synced database — including
    // the report-viewer's "Display columns by" (interval) and "Compare to"
    // (previous period / year) controls, which the local builders handle
    // natively. We NEVER call the Zoho report API here (it's used only for data
    // sync + OAuth). If a builder returns { _noLocalData: true } the org simply
    // has no synced data for this report → return an honest empty report so the
    // viewer shows its "no data" state (no Zoho rate-limit / re-auth errors).
    if (LEDGER_BUILDERS[type]) {
      if (req.orgId) params.org_id = req.orgId;
      // For recurring invoices, use the ACTUAL user's ID (not effectiveUid)
      // because the recurring invoice data is synced under the user's own ID.
      // Also resolve org_id from the table itself if not set — this handles
      // the admin-without-X-Client-Id case where effectiveUid has no tokens.
      if (type === 'recurringinvoices' || type === 'recurringinvoicedetails') {
        effectiveUid = req.user.id;
        if (!params.org_id) {
          const [[riRow]] = await pool.execute(
            'SELECT org_id FROM zb_recurring_invoices WHERE user_id = ? AND is_deleted = 0 LIMIT 1',
            [effectiveUid]
          );
          if (riRow?.org_id) params.org_id = riRow.org_id;
        }
      }
      // Detect the actual platform from the ACTUAL logged-in user's tokens
      // (req.user.id), not effectiveUid which may have fallen back to admin's
      // Zoho connection. This lets TDS, GST, Tax Liability reports work for
      // Xero and QuickBooks clients.
      if (!params.platform) {
        const [[xRow]] = await pool.execute(
          'SELECT tenant_id FROM xero_tokens WHERE user_id = ? LIMIT 1',
          [req.user.id]
        );
        const [[qRow]] = await pool.execute(
          'SELECT realm_id FROM qbo_tokens WHERE user_id = ? LIMIT 1',
          [req.user.id]
        );
        const [[zRow]] = await pool.execute(
          'SELECT org_id FROM zb_tokens WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1',
          [req.user.id]
        );
        if (xRow) { params.platform = 'xero'; if (!params.org_id) params.org_id = xRow.tenant_id; effectiveUid = req.user.id; }
        else if (qRow) { params.platform = 'quickbooks'; if (!params.org_id) params.org_id = qRow.realm_id; effectiveUid = req.user.id; }
        else { params.platform = 'zoho'; }
      }
      try {
        const result = await LEDGER_BUILDERS[type](effectiveUid, params);
        if (result && !result._noLocalData) {
          await stampCompany(result, effectiveUid, params.org_id);
          return res.json(result);
        }
      } catch (buildErr) {
        // If the builder fails because the org is missing (NOT_CONNECTED),
        // return an honest empty report instead of a 400/500 error.
        // This happens when admin switches to a non-Zoho client.
        if (buildErr.code === 'NOT_CONNECTED') {
          console.warn('[zb-reports]', type, 'not available for user', effectiveUid, '-', buildErr.message);
          return res.json(emptyReport(type, params));
        }
        throw buildErr;
      }
      return res.json(emptyReport(type, params));
    }

    // Report types without a local builder yet (e.g. purchaseorderdetails —
    // no warehouse table exists). Still no Zoho call: return an empty report;
    // sync that data to a local table to enable them.
    return res.json(emptyReport(type, params));
  } catch (e) {
    if (e.code === 'UNKNOWN_REPORT_TYPE') {
      return res.status(404).json({ error: e.message, code: e.code });
    }
    if (e.code === 'NOT_CONNECTED') {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    if (e.code === 'REAUTH_REQUIRED') {
      return res.status(401).json({ error: e.message, code: e.code, provider: e.provider });
    }
    if (e.code === 'ZOHO_ERROR') {
      return res.status(e.status || 502).json({ error: e.message, code: e.code });
    }
    console.error('[zb-reports] error:', e.message);
    return res.status(500).json({ error: 'Server error', detail: e.message });
  }
});

module.exports = router;
