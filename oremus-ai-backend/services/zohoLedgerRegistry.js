'use strict';

/**
 * zohoLedgerRegistry — single lookup for Zoho reports served from the SYNCED
 * database (never the live Zoho API).
 * ---------------------------------------------------------------------------
 * Product rule: the website only ever shows synced data. Zoho's API is used
 * solely for OAuth and data sync; every report/metric a page renders must be
 * computed from our own tables. routes/zbReports.js already follows this rule
 * with its own builder map; this registry extends the same rule to the
 * provider-adapter consumers (/api/metrics, /api/accounting, /api/reports).
 *
 * Differences from the routes/zbReports.js map:
 *  - `cashflow` maps to the activity-structured Cash Flow STATEMENT builder
 *    (Operating/Investing/Financing sections) because adapter consumers —
 *    metricsService.deriveCashFlow in particular — parse activity labels,
 *    mirroring Zoho's live /reports/cashflow shape. The zb-reports viewer
 *    keeps its inflow/outflow-by-type builder unchanged.
 *
 * Types with no local builder return an honest empty report (no Zoho call,
 * no error) — sync the underlying data to enable them.
 */

const pool = require('../config/db');
const { buildProfitAndLoss, buildCashFlow, buildExpenseDetails } = require('./zohoLedgerReportsService');
const { buildCashFlowStatement } = require('./cashFlowStatementService');
const { buildExecutiveSummary } = require('./executiveSummaryService');
const { buildBudgetSummary } = require('./budgetSummaryService');
const { buildBudgetVariance } = require('./budgetVarianceService');
const { buildCashSummary } = require('./cashSummaryService');
const { buildSalesByProductDetail } = require('./zohoSalesByProductDetailService');
const { buildInventoryItemSummary } = require('./zohoInventoryItemSummaryService');
const { buildApAgingDetail, buildApAgingSummary } = require('./zohoApAgingDetailService');
const { buildArAgingDetail } = require('./zohoArAgingDetailService');
const { buildSalesByCustomer, buildSalesByCustomerDetail, buildSalesByProductSummary, buildArAgingSummary } = require('./salesArFromInvoicesService');
const { buildVendorBalanceDetail } = require('./zohoVendorBalanceDetailService');
const { buildVendorBalanceSummary } = require('./zohoVendorBalanceSummaryService');
const { buildExpensesByVendorSummary } = require('./zohoExpensesByVendorSummaryService');
const { buildSupplierInvoiceSummary } = require('./zohoSupplierInvoiceSummaryService');
const { buildVendorContactList } = require('./zohoVendorContactListService');
const { buildChartOfAccounts } = require('./zohoChartOfAccountsService');
const { buildTransactionDetailByAccount } = require('./zohoTransactionDetailByAccountService');
const { buildTransactionListByVendor } = require('./zohoTransactionListByVendorService');
const { buildTaxLiability } = require('./zohoTaxLiabilityService');
const { buildPurchasesByItem } = require('./zohoPurchasesByItemService');
const { buildTdsSummary } = require('./zohoTdsSummaryService');
const { buildGstReturnsWorkbook } = require('./zohoGstReturnsWorkbookService');
const { buildRecurringBills } = require('./zohoRecurringBillsService');
const { buildRecurringInvoices } = require('./zohoRecurringInvoicesService');
const { buildForexGainsLosses, buildRealisedForex } = require('./zohoForexService');
const { buildBankReconciliation } = require('./zohoBankReconciliationService');
const { buildBalanceSheet, buildTrialBalance, buildGeneralLedger } = require('./zohoGlReportsService');
const { buildCreditNoteDetails } = require('./zohoCreditNoteDetailsService');

const LEDGER_BUILDERS = {
  profitandloss:     buildProfitAndLoss,
  // Activity-structured statement (see header). `bankcashflow` preserves access
  // to the inflow/outflow-by-type view if an adapter consumer ever needs it.
  cashflow:          buildCashFlowStatement,
  cashflowstatement: buildCashFlowStatement,
  bankcashflow:      buildCashFlow,
  expensedetails:    buildExpenseDetails,
  executivesummary:  buildExecutiveSummary,
  budgetsummary:     buildBudgetSummary,
  budgetvariance:    buildBudgetVariance,
  cashsummary:       buildCashSummary,
  salesbyproductdetail: buildSalesByProductDetail,
  inventoryitemsummary: buildInventoryItemSummary,
  inventorysummary:  buildInventoryItemSummary,
  salesbycustomer:   buildSalesByCustomer,
  salesbycustomerdetail: buildSalesByCustomerDetail,
  salesbyproductsummary: buildSalesByProductSummary,
  aragingsummary:    buildArAgingSummary,
  aragingdetail:     buildArAgingDetail,
  apagingdetail:     buildApAgingDetail,
  apagingsummary:    buildApAgingSummary,
  vendorbalancedetail: buildVendorBalanceDetail,
  vendorbalancesummary: buildVendorBalanceSummary,
  expensesbyvendorsummary: buildExpensesByVendorSummary,
  supplierinvoicesummary: buildSupplierInvoiceSummary,
  vendorcontactlist: buildVendorContactList,
  chartofaccounts:   buildChartOfAccounts,
  transactiondetailbyaccount: buildTransactionDetailByAccount,
  transactionlistbyvendor: buildTransactionListByVendor,
  taxliability:      buildTaxLiability,
  purchasesbyitem:   buildPurchasesByItem,
  tdssummary:        buildTdsSummary,
  gstreturnsworkbook: buildGstReturnsWorkbook,
  recurringbills:    buildRecurringBills,
  recurringinvoices: buildRecurringInvoices,
  foreigncurrencygainsandlosses: buildForexGainsLosses,
  realizedgainorloss: buildRealisedForex,
  bankreconciliation: buildBankReconciliation,
  balancesheet:      buildBalanceSheet,
  trialbalance:      buildTrialBalance,
  generalledger:     buildGeneralLedger,
  creditnotedetails: buildCreditNoteDetails,
};

// Honest empty report — same shape routes/zbReports.js returns when an org has
// no synced data for a report (or the type has no local builder yet).
function emptyReport(type, params = {}) {
  return {
    columns: [],
    rows: [],
    currency: 'INR',
    empty: true,
    emptyReason: 'no_data',
    meta: {
      title: type,
      source: 'ledger',
      from: params.from_date || params.date_start || params.from || null,
      to: params.to_date || params.date_end || params.to || null,
    },
  };
}

async function resolveOrgIdFromTokens(userId) {
  try {
    const [[row]] = await pool.execute(
      'SELECT org_id FROM zb_tokens WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1',
      [userId]
    );
    return row?.org_id || null;
  } catch (_) {
    return null;
  }
}

/**
 * Fetch a Zoho report from the synced database. `userId` must be the EFFECTIVE
 * Zoho user (clients inherit the admin's connection — resolve with
 * getEffectiveZohoUserId before calling). Never calls the Zoho API.
 */
async function fetchLedgerReport(userId, type, params = {}) {
  const builder = LEDGER_BUILDERS[type];
  if (!builder) return emptyReport(type, params);
  const p = { ...params, platform: 'zoho' };
  if (!p.org_id) p.org_id = await resolveOrgIdFromTokens(userId);
  const result = await builder(userId, p);
  if (result && !result._noLocalData) return result;
  return emptyReport(type, p);
}

module.exports = { LEDGER_BUILDERS, emptyReport, fetchLedgerReport };
