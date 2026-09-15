# Which DB tables feed each Report and each Dashboard section

Source of truth: `routes/dashboard.js`, `routes/zbReports.js` (+ the Zoho `services/*Service.js` builders),
and `routes/accounting.js` (QuickBooks + Xero via provider services). Verified 2026-07-22.

> Note on providers:
> - **Zoho** reports are built **from our own synced DB tables** (listed below).
> - **QuickBooks / Xero** financial reports (P&L, Balance Sheet, Cash Flow, Trial Balance, GL, Executive/Bank Summary)
>   come **directly from the provider's own Reports API**, NOT from our DB — so they have *no* DB table.
>   Only a few QB/Xero reports are derived from our shared tables (noted with ⚙️).

---

## PART A — DASHBOARD (routes/dashboard.js)

| Dashboard section / endpoint | Tables used |
|---|---|
| **Connection/setup flags** (`GET /dashboard` bootstrap) | `account_transactions`, `bank_transactions`, `invoices`, `qbo_accounts`, `xero_accounts`, `zb_tokens` |
| **Cash on Hand / Bank balances** (shared cash source) | `bank_transactions`, `account_transactions`, `zb_bank_accounts`, `qbo_accounts`, `xero_accounts` |
| **KPI: Revenue / Expenses / Net Profit** | Zoho → `account_transactions`, `invoices`, `bills`, `expense_entries`, `zb_oauth_organizations` · QB/Xero → `invoices`, `bills`, `expense_entries` (+ live P&L API), `qbo_organizations`, `xero_organizations`/`xero_tokens` |
| **KPI: Accounts Receivable (A/R)** | `invoices` |
| **KPI: Accounts Payable (A/P)** | `bills` |
| **KPI: Customers count** | `invoices`, `customers` |
| **KPI: Burn / Runway** | `bank_transactions`, `account_transactions`, `expense_entries` |
| **Revenue trend chart** | `invoices`, `account_transactions`, `expense_entries` |
| **Expense trend chart** | `bills`, `account_transactions`, `expense_entries` |
| **Cash movement / cash-flow trend chart** | `bank_transactions`, `account_transactions`, `invoices`, `expense_entries` |
| **Revenue by month / by source** | `invoices`, `account_transactions` |
| **Expense / spend by category** | `bills`, `account_transactions`, `expense_entries`, `bank_transactions` |
| **Recent invoices / recent transactions** | `invoices`, `bank_transactions`, `expense_entries` |
| **Financial health / ratios tile** | `account_transactions`, `invoices`, `bills`, `bank_transactions` |
| **AR/AP snapshot + statutory payables** | `account_transactions`, `invoices`, `bills` |
| **Cash summary / runway tile** | `bills`, `zb_chart_of_accounts`, `expense_entries`, `account_transactions` |
| **Revenue headline (current vs prior)** | `invoices`, `account_transactions` |

**Dashboard core tables (most used):** `account_transactions`, `invoices`, `bills`, `expense_entries`, `bank_transactions`, `customers`, plus provider COA `qbo_accounts` / `xero_accounts` / `zb_chart_of_accounts`.

---

## PART B — REPORTS

### B1. Zoho reports (built from our synced DB tables)

| Report | Builder service | Tables used |
|---|---|---|
| Profit & Loss | zohoLedgerReportsService | `account_transactions` |
| Cash Flow | zohoLedgerReportsService | `bank_transactions`, `account_transactions` |
| Expense Details | zohoLedgerReportsService | `account_transactions` |
| Balance Sheet | zohoGlReportsService | `account_transactions` — cumulative as of the **To** date (From only scopes the account drill); "Display columns by" / "Compare to" give one column per period END date. Accrual only (the ledger has no cash-settlement flag): `meta.basis: 'Accrual'` + `meta.basisRequested` |
| Trial Balance (all 3 providers) | zohoGlReportsService | `account_transactions` (opening balance, year-to-date debit/credit movement, closing balance), plus `zb_chart_of_accounts` (Zoho) / `xero_accounts` (Xero) for the account code and type, and `zb_organizations`·`xero_organizations`·`qbo_organizations` for the base currency |
| General Ledger (all 3 providers) | zohoGlReportsService | `account_transactions` (every posting line + opening balance), plus `invoices`, `bills`, `expense_entries`, `zb_customer_payments`, `zb_vendor_payments` for the Name column |
| Executive Summary (all 3 providers) | executiveSummaryService | `account_transactions` (cash, P&L, balances, invoice count/value), `bank_transactions`; base currency via the shared `getBaseCurrency(orgId)`. Sales credit notes (`ACCRECCREDIT` / `credit_note` / `CreditMemo`) are netted off the value invoiced, so a tax-withholding credit note that never touches a revenue account still reduces it. Every row ties to Xero's own Executive Summary |
| Budget Summary | budgetSummaryService | *no table* — there is no budget anywhere (no provider API exposes one and we store none), so the report returns an honest `empty/unavailable` on all 3 providers rather than presenting `account_transactions` actuals as a budget |
| Budget Variance | budgetVarianceService | `account_transactions` — income/expense movement in the window, EXCLUDING `transaction_id LIKE 'xero-recon:%'` (the Xero trial-balance plugs hold cumulative prior-year balances and are all dated the last ledger day, so inside a period they flip revenue negative). The same exclusion applies to the click-through drill lines. Budget columns are blank because no budget is stored anywhere |
| Cash Summary | cashSummaryService | `bank_transactions` |
| Cash Flow Statement | cashFlowStatementService | `bank_transactions` |
| Bank Reconciliation (all 3 providers) | zohoBankReconciliationService | `bank_transactions` (the synced bank feed — the statement side) and `account_transactions` (every bank/cash posting — the book side), matched on the transaction id both sides share, plus `invoices`·`bills`·`expense_entries`·`zb_customer_payments`·`zb_vendor_payments` for the To/From column and `zb_organizations`·`xero_organizations`·`qbo_organizations` for the base currency |
| Sales by Customer | salesArFromInvoicesService | `invoices`, `zb_customer_payments` |
| AR Aging Summary | salesArFromInvoicesService | `invoices`, `zb_customer_payments` |
| AR Aging Detail | zohoArAgingDetailService | `invoices`, `zb_customer_payments` |
| Sales by Product/Service Detail (all 3 providers) | zohoSalesByProductDetailService | `zb_invoice_line_items` JOIN `invoices` — grouped by the product/service actually recorded on the invoice line. An invoice with no synced lines is skipped rather than invented as an "Uncategorized" product, and a connection with no invoice lines at all (Xero) returns an honest `unavailable` report explaining why |
| Inventory Item Summary (all 3 providers) | zohoInventoryItemSummaryService | `zb_items` (the item master — whether the platform tracks the item's stock, its code and its opening stock), unioned with every item actually traded: `zb_invoice_line_items`·`invoices` for the quantity and value sold and `zb_bill_line_items`·`bills` for the quantity bought (lines dated before the period open the balance), plus `zb_organizations`·`xero_organizations`·`qbo_organizations` for the base currency |
| AP Aging Summary | zohoApAgingDetailService | `bills` |
| AP Aging Detail | zohoApAgingDetailService | `bills` |
| Vendor Balance Detail | zohoVendorBalanceDetailService | `bills`, `account_transactions` (unapplied vendor credits) |
| Purchases by Item | zohoPurchasesByItemService | `zb_bill_line_items`, `bills` |
| Expenses by Vendor Summary | zohoExpensesByVendorSummaryService | `zb_vendor_payments`, `expense_entries`, `bills`, `zb_vendor_credits` |
| Supplier Invoice Summary | zohoSupplierInvoiceSummaryService | `bills` |
| Vendor Contact List (all 3 providers) | zohoVendorContactListService | `vendors` (contact card per supplier — name, company, phone, email, full name, `billing_address`, `account_number`, `gst_no`, `track_1099`; no date filter, it is a master list) |
| Transaction Detail by Account (all 3 providers) | zohoTransactionDetailByAccountService | `account_transactions` (every posting line, its account, the other side of the entry for Split, and the period running balance), plus `invoices`·`bills`·`expense_entries`·`zb_customer_payments`·`zb_vendor_payments` for the Name column, and `zb_organizations`·`xero_organizations`·`qbo_organizations` for the base currency |
| Transaction List by Vendor (all 3 providers) | zohoTransactionListByVendorService | `account_transactions` (every posting on Accounts Payable — the transaction, its split account and its amount), plus `bills`·`expense_entries`·`zb_vendor_payments`·`zb_vendor_credits` for the vendor name, document number and memo, and `zb_organizations`·`xero_organizations`·`qbo_organizations` for the base currency |
| Chart of Accounts (all 3 providers) | zohoChartOfAccountsService | `zb_chart_of_accounts` (Zoho) / `xero_accounts` (Xero) / none (QB), plus `account_transactions` for every balance and `zb_organizations`·`xero_organizations`·`qbo_organizations` for the base currency |
| Credit Note Details | zohoCreditNoteDetailsService | `zb_credit_notes` |
| Recurring Bills | zohoRecurringBillsService | `zb_recurring_bills` |
| Tax Liability (Zoho's Tax Summary) | zohoTaxLiabilityService | `zb_invoice_line_items` (the taxable amount and the tax charged on each line) joined to `invoices` (to date-filter and exclude drafts, voids and deletions), less `zb_credit_note_line_items` joined to `zb_credit_notes` (a credit note is a negative sale and nets off the same rate's row), plus `zb_raw_payloads` (the `/settings/taxes` response, for each tax's live status) and `zb_organizations` for the base currency |
| TDS Summary | zohoTdsSummaryService | `zb_bill_line_items` (the tax deducted at source on each bill line and the amount it was deducted from — the bill header's TDS columns are not populated by the sync) joined to `bills` (to date-filter and exclude deletions), plus `zb_raw_payloads` (the `/bills/{id}` responses, the only place Zoho's section code such as 194J survives) and `zb_organizations` for the base currency |
| GST Returns Workbook | zohoGstReturnsWorkbookService | `zb_invoice_line_items` (the taxable amount and rate on each sold line) joined to `invoices` (to date-filter and exclude drafts, voids and deletions), less `zb_credit_note_line_items` joined to `zb_credit_notes` (a credit note is a negative supply), and `zb_bill_line_items` joined to `bills` for the input-credit and exempt-inward sides, plus `zb_raw_payloads` (the `/bills/{id}` responses, the only place the source and destination of supply and the reverse-charge flag survive) and `zb_organizations` for the base currency |
| Forex Gains/Losses & Realised Forex | zohoForexService | `zb_customer_payments`, `zb_vendor_payments`, `invoices`, `bills`, `account_transactions` (bank balances), `zb_organizations` |

### B2. QuickBooks reports (routes/accounting.js → QuickBooksProvider)

| Report | Source |
|---|---|
| P&L, Balance Sheet, Cash Flow, Trial Balance, General Ledger, Sales-by-Product, Executive/Bank Summary, Aging (default) | **QBO Reports API — no DB table** (optional cache: `acc_report_cache`) |
| ⚙️ Chart of Accounts | `account_transactions` (QB syncs no account master — `qbo_accounts` does not exist) |
| ⚙️ GL normal-side | `qbo_accounts` (absent → defaults to debit side) |
| ⚙️ Sales by Product/Customer Detail, AR/AP built locally | `qbo_entities`, shared `invoices` / `bills` |

### B3. Xero reports (routes/accounting.js → XeroProvider)

| Report | Source |
|---|---|
| P&L, Balance Sheet, Trial Balance, Bank Summary, Executive Summary | **Xero Reports API — no DB table** (optional cache: `acc_report_cache`) |
| ⚙️ Budget Summary / Budget Variance / Cash Flow (derived) | Xero P&L API + shared `bank_transactions` |
| ⚙️ Chart of Accounts / currency | `xero_accounts` (names/codes/types) + `account_transactions` (balances), `xero_organizations` |
| ⚙️ Sales/AR + Purchases/AP built locally | shared `invoices` / `bills` |

---

## Quick answer — the tables that matter most

- **Reports (Zoho):** `account_transactions` (all P&L/BS/TB/GL/budget), `invoices`, `bills`, `expense_entries`,
  `bank_transactions`, plus line-item/payment tables `zb_invoice_line_items`, `zb_bill_line_items`,
  `zb_customer_payments`, `zb_vendor_payments`, `zb_vendor_credits`, `zb_credit_notes`, `zb_recurring_bills`,
  `zb_items`, `zb_chart_of_accounts`, `zb_bank_accounts`, `vendors`.
- **Reports (QuickBooks/Xero):** mostly **provider API (no table)**; local pieces use `qbo_accounts`/`xero_accounts`,
  `qbo_entities`, and shared `invoices`/`bills`/`bank_transactions`.
- **Dashboard (all providers):** `account_transactions`, `invoices`, `bills`, `expense_entries`,
  `bank_transactions`, `customers`, and COA tables `qbo_accounts`/`xero_accounts`/`zb_chart_of_accounts`.
