# Report Filter Conformance Matrix

Which filters each report honours, verified by reading the builder + route + viewer
(2026-09-08). All reports are served from our synced DB — a filter "working" means
the local query / builder actually narrows to it.

Legend: ✅ applied · ⏳ as-of only (point-in-time report) · — n/a for this report ·
⚠️ not wired

## How filters flow

| Layer | Where | Notes |
|---|---|---|
| Frontend | `src/features/reports/reportsSlice.js` `resolveFilters` → `reportsAPI.js` `buildParams` | emits `from_date`, `to_date`, `accounting_basis`, `interval`, `compare`, `compare_count`, `oldest_first`, `period`, `include_zero` |
| Route (Zoho) | `routes/zbReports.js` `ALLOWED_PARAMS` | broad whitelist; injects `org_id = req.orgId`, detects `platform` |
| Route (QB/Xero) | `routes/accounting.js` `buildParams` | now also passes `as_of_date`, `account_id`, `customer_id`, `vendor_id`, `entity`, `group_by`, `tax_id`, … (previously dropped) |
| Builder | one `resolveRange()` / `resolveAsOf()` per service | canonical impl now in `services/reportContext.js`; existing copies are equivalent for the both-dates-present path |
| Viewer | `QBReportViewer.jsx` `dateRangeText`, `ZohoDetailReportViewer.jsx` `rangeText`, `BudgetSummaryViewer.jsx` header | shows the resolved window, preferring `data.meta.from/to` |

## Financials

| Report | Builder | Date range | As-of | Basis | Interval | Compare |
|---|---|---|---|---|---|---|
| Profit & Loss | `zohoLedgerReportsService.buildProfitAndLoss` | ✅ | — | ✅ meta | ✅ | ✅ |
| Balance Sheet | `zohoGlReportsService.buildBalanceSheet` | ✅ (drill scope) | ✅ | accrual only (meta) | ✅ | ✅ |
| Trial Balance | `zohoGlReportsService.buildTrialBalance` | ✅ (YTD from) | ✅ | accrual only | — | — |
| General Ledger | `zohoGlReportsService.buildGeneralLedger` | ✅ | ✅ opening | — | — | — |
| Cash Flow | `zohoLedgerReportsService.buildCashFlow` | ✅ | — | — | ✅ | ✅ |
| Statement of Cash Flows | `cashFlowStatementService` → `buildCashFlow` | ✅ | — | — | ✅ | ✅ |
| Cash Summary | `cashSummaryService.buildCashSummary` | ✅ | — | — | — | — |
| Executive Summary | `executiveSummaryService.buildExecutiveSummary` | ✅ | ✅ | — | — | — |
| Budget Summary | `budgetSummaryService.buildBudgetSummary` → `buildTrialBalance` | ✅ | ✅ | accrual only | single column | — |
| Budget Variance | `budgetVarianceService.buildBudgetVariance` | ✅ (period + YTD) | — | — | — | — |

## Sales / AR

| Report | Builder | Date range | As-of | Other |
|---|---|---|---|---|
| Sales by Customer / Detail / Product Summary | `salesArFromInvoicesService` | ✅ | ⏳ | — |
| Sales by Product/Service Detail | `zohoSalesByProductDetailService` | ✅ | — | — |
| Credit Notes | `zohoCreditNoteDetailsService` | ✅ | — | — |
| Recurring Invoices | `zohoRecurringInvoicesService` | — (master list) | — | `status` |
| AR Aging Summary | `salesArFromInvoicesService.buildArAgingSummary` | — | ⏳ | `aging_by` ✅ |
| AR Aging Detail | `zohoArAgingDetailService` | — | ⏳ | `aging_by` ✅ |

## AP / Purchases

| Report | Builder | Date range | As-of | Other |
|---|---|---|---|---|
| AP Aging Summary / Detail | `zohoApAgingDetailService` | — | ⏳ | `aging_by` ✅ |
| Vendor Balance Detail | `zohoVendorBalanceDetailService` | — | ⏳ | — |
| Supplier Invoice Summary | `zohoSupplierInvoiceSummaryService` | ✅ | — | — |
| Purchases by Item | `zohoPurchasesByItemService` | ✅ | — | — |
| Expenses by Vendor Summary | `zohoExpensesByVendorSummaryService` | ✅ | — | — |
| Vendor Contact List | `zohoVendorContactListService` | — (master list) | — | — |

## Inventory / Tax / Banking / Ledger / Currency

| Report | Builder | Date range | As-of | Other |
|---|---|---|---|---|
| Inventory Item Summary | `zohoInventoryItemSummaryService` | ✅ (opening from pre-period) | — | — |
| GST Returns Workbook | `zohoGstReturnsWorkbookService` | ✅ | — | — |
| TDS Summary | `zohoTdsSummaryService` | ✅ | — | — |
| Tax Liability | `zohoTaxLiabilityService` | ✅ | — | `tax_id` |
| Bank Reconciliation | `zohoBankReconciliationService` | ✅ | — | — |
| Transaction Detail by Account | `zohoTransactionDetailByAccountService` | ✅ | — | `account_id` |
| Transaction List by Vendor | `zohoTransactionListByVendorService` | ✅ | — | `vendor_id` |
| Chart of Accounts | `zohoChartOfAccountsService` | — | ⏳ balances | — |
| Foreign Currency Gains / Losses · Realized Gain or Loss | `zohoForexService` | ✅ | ⏳ | — |
| Bank Summary | `bankSummaryService` | ✅ | — | — |

## Status

- **Date range / as-of** work on every report that should have them (audited by
  reading each builder's SQL). No ⚠️ found on the core filters.
- **Fixed this pass:** `routes/accounting.js buildParams` was dropping
  `as_of_date` / `account_id` / `customer_id` / `vendor_id` / `entity` /
  `group_by` / `tax_id` for QuickBooks & Xero — those report-specific filters
  now reach the builder.
- **Follow-up (low risk, deferred):** collapse the ~8 per-service `resolveRange`
  copies onto `services/reportContext.js` so `from`/`to` short aliases and
  one-sided ranges work everywhere identically.
