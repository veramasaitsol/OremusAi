# Reports → Database Tables Map (Zoho · QuickBooks · Xero)

How each of the **32 catalog reports** is built from **our own `oremusdb` tables**.
No report calls a provider's live Report API for its data — the provider APIs are
used only for OAuth + data sync. Every figure is computed from synced tables.

- **Zoho** routes: `GET /api/zb-reports/:type` → builder services (see `routes/zbReports.js`).
- **QuickBooks / Xero** routes: `GET /api/accounting/:type` → `QuickBooksProvider` /
  `XeroProvider`, which reuse the **same provider-agnostic builder services** as Zoho,
  scoped by `org_id = realm_id` (QB) or `org_id = tenant_id` (Xero).

---

## 1. All report-data tables (19)

### Core ledger (double-entry) — 2
| Table | What it holds |
|---|---|
| `account_transactions` | The general ledger: every balanced debit/credit posting (`user_id`, `org_id`, `debit`, `credit`, `account_id`, `date`). Carries `qbo_id` / `xero_id` so all 3 providers share it. |
| `bank_transactions` | Bank/cash movements (money in / money out) used for all cash-basis reports. |

### Shared document warehouses (provider-agnostic, carry `qbo_id`/`xero_id`) — 4
| Table | What it holds |
|---|---|
| `invoices` | Sales invoice headers (total, balance, tax_total, customer, dates). |
| `bills` | Purchase/vendor bill headers. |
| `expense_entries` | Direct expenses / spend (cash purchases). |
| `vendors` | Vendor master (contact list). |

### Zoho silver/warehouse tables (`zb_*`, populated by Zoho sync only) — 10
| Table | What it holds |
|---|---|
| `zb_invoice_line_items` | Invoice line detail (product/service, qty, rate, tax per line). |
| `zb_bill_line_items` | Bill line detail (incl. per-line TDS). |
| `zb_customer_payments` | Customer receipts (for AR rewind + FX). |
| `zb_vendor_payments` | Vendor payments (for AP, 1099, FX). |
| `zb_vendor_credits` | Vendor credit notes. |
| `zb_credit_notes` | Customer credit notes. |
| `zb_chart_of_accounts` | Zoho account master. |
| `zb_bank_accounts` | Bank account master (statement balances). |
| `zb_items` | Item/inventory master. |
| `zb_recurring_bills` | Recurring bill schedules. |

### Provider chart-of-accounts / source docs — 3
| Table | What it holds |
|---|---|
| `qbo_entities` | QuickBooks source-document payloads (used for QB Sales-by-Product Detail). |
| `qbo_accounts` | QuickBooks account master (classification / normal-side for GL). |
| `xero_accounts` | Xero account master (classification / balances). |

> Support tables (not report *data*, only org/currency/cache lookups):
> `zb_tokens`, `zb_organizations`, `zb_oauth_organizations`, `qbo_tokens`,
> `qbo_organizations`, `xero_tokens`, `xero_organizations`, `acc_report_cache`.

---

## 2. The 32 reports → builder → tables

Legend: **AT** = `account_transactions`, **BT** = `bank_transactions`.

### Financials (7)
| # | Report (`liveType`) | Builder service | Tables |
|---|---|---|---|
| 1 | Profit & Loss `profitandloss` | `zohoLedgerReportsService.buildProfitAndLoss` | **AT** |
| 2 | Executive Summary `executivesummary` | `executiveSummaryService.buildExecutiveSummary` | **AT**, **BT**. Every row is proven equal to Xero's own Executive Summary. Definitions that matter: `Average value of invoices` = revenue recognised by invoice documents (so tax-exclusive) **less sales credit notes raised in the window**, ÷ invoices issued; `Average creditor days` turns over **Direct costs only** (blank when the org reports none); `Term assets to liabilities` = term assets ÷ **non-current** liabilities (blank when there are none); `Short term cash forecast` = **Debtors − Creditors** (the bank balance is already its own row). Currency from the shared `getBaseCurrency(orgId)` |
| 3 | Budget Summary `budgetsummary` | `budgetSummaryService.buildBudgetSummary` | *none* — no budget exists anywhere (no provider exposes one, we store none), so it returns `empty/unavailable` on all 3 providers instead of printing actuals under a "Budget" heading |
| 4 | Budget Variance `budgetvariance` | `budgetVarianceService.buildBudgetVariance` | **AT** (excludes `transaction_id LIKE 'xero-recon:%'` — those plugs carry cumulative prior-year balances, see §4) |
| 5 | Balance Sheet `balancesheet` | `zohoGlReportsService.buildBalanceSheet` | **AT**. Point-in-time: the **To** date is the as-of that drives every figure; **From** only scopes the account-drill's opening row. "Display columns by" / "Compare to" emit one column per period END date (cumulative as of each). The ledger holds accrual postings with no cash-settlement flag, so a cash-basis sheet cannot be derived — `meta.basis: 'Accrual'` + `meta.basisRequested` report that honestly (same contract as the P&L) and the viewer labels the header from `meta.basis` |
| 6 | Cash Flow `cashflow` | `zohoLedgerReportsService.buildCashFlow` | **BT** |
| 7 | Statement of Cash Flows `cashflowstatement` | `cashFlowStatementService.buildCashFlowStatement` | **BT** |

### Sales (4)
| # | Report | Builder | Tables |
|---|---|---|---|
| 8 | Sales by Customer `salesbycustomer` | `salesArFromInvoicesService.buildSalesByCustomer` | `invoices` |
| 9 | Sales by Product/Service Detail `salesbyproductdetail` | `zohoSalesByProductDetailService.buildSalesByProductDetail` (one provider-agnostic builder) | `zb_invoice_line_items` JOIN `invoices` (scoped by `org_id` = Zoho org / QB realm / Xero tenant). An invoice with NO synced lines is SKIPPED — never emitted as a whole-invoice "Uncategorized" group; a line with no item groups under "Not Specified". No lines at all → honest `unavailable` |
| 10 | Credit Note Details `creditnotedetails` | `zohoCreditNoteDetailsService.buildCreditNoteDetails` | `zb_credit_notes` |
| 11 | Recurring Invoice Details `recurringinvoicedetails` | *(no builder — returns empty; no synced source table)* | — |

### Accounts Receivable / Payable (4)
| # | Report | Builder | Tables |
|---|---|---|---|
| 12 | AR Aging Summary `aragingsummary` | `salesArFromInvoicesService.buildArAgingSummary` | `invoices`, `zb_customer_payments` |
| 13 | AR Aging Detail `aragingdetail` | `zohoArAgingDetailService.buildArAgingDetail` | `invoices`, `zb_customer_payments` |
| 14 | AP Aging Summary `apagingsummary` | `zohoApAgingDetailService.buildApAgingSummary` | `bills` |
| 15 | AP Aging Detail `apagingdetail` | `zohoApAgingDetailService.buildApAgingDetail` | `bills` |

### Purchases (5)
| # | Report | Builder | Tables |
|---|---|---|---|
| 16 | Supplier Invoice Summary `supplierinvoicesummary` | `zohoSupplierInvoiceSummaryService` | `bills` |
| 17 | Vendor Balance Detail `vendorbalancedetail` | `zohoVendorBalanceDetailService` | `bills`, `account_transactions` (unapplied vendor credits) |
| 18 | Purchases by Item `purchasesbyitem` | `zohoPurchasesByItemService` | `zb_bill_line_items` + `bills` |
| 19 | Expenses by Vendor Summary `expensesbyvendorsummary` | `zohoExpensesByVendorSummaryService` | `zb_vendor_payments`, `expense_entries`, `bills`, `zb_vendor_credits` |
| 20 | Vendor Contact List (all 3 providers) `vendorcontactlist` | `zohoVendorContactListService` | `vendors` — the whole contact card each platform holds for a supplier: display name, company, phone, email, person name, billing address, account number, tax id and the QuickBooks 1099 flag. A master list, so no date filter and no other table |

### Inventory (1)
| # | Report | Builder | Tables |
|---|---|---|---|
| 21 | Inventory Item Summary `inventoryitemsummary` | `zohoInventoryItemSummaryService` | `zb_items` (the item master — whether the platform tracks the item's stock, its code and its opening stock), unioned with every item actually traded: `zb_invoice_line_items` + `invoices` for the quantity and value sold, `zb_bill_line_items` + `bills` for the quantity bought (lines dated before the period open the balance), plus `zb_organizations`·`xero_organizations`·`qbo_organizations` for the base currency |

### Tax (3)
| # | Report | Builder | Tables |
|---|---|---|---|
| 22 | GST Returns Workbook `gstreturnsworkbook` | `zohoGstReturnsWorkbookService` | `zb_invoice_line_items` + `invoices`, less `zb_credit_note_line_items` + `zb_credit_notes`, and `zb_bill_line_items` + `bills`, plus `zb_raw_payloads` (`/bills/{id}`, for place of supply and reverse charge) and `zb_organizations` |
| 23 | TDS Summary `tdssummary` | `zohoTdsSummaryService` | `zb_bill_line_items` + `bills`, plus `zb_raw_payloads` (`/bills/{id}`, for the section code) and `zb_organizations` |
| 24 | Tax Liability `taxliability` | `zohoTaxLiabilityService` | `zb_invoice_line_items` + `invoices`, less `zb_credit_note_line_items` + `zb_credit_notes`, plus `zb_raw_payloads` (`/settings/taxes`, for each tax's status), `zb_organizations` |

### Banking (1)
| # | Report | Builder | Tables |
|---|---|---|---|
| 25 | Bank Reconciliation `bankreconciliation` | `zohoBankReconciliationService` | **BT** (the synced bank feed = the statement side) and **AT** (every bank/cash posting = the book side), reconciled on the transaction id they share; plus `invoices` / `bills` / `expense_entries` / `zb_customer_payments` / `zb_vendor_payments` for the To/From column |

### Ledger (5)
| # | Report | Builder | Tables |
|---|---|---|---|
| 26 | Transaction Detail by Account `transactiondetailbyaccount` | `zohoTransactionDetailByAccountService` | **AT** (every posting line, its account, the other side of the entry for Split, and the period running balance), plus `invoices` / `bills` / `expense_entries` / `zb_customer_payments` / `zb_vendor_payments` for the Name column |
| 27 | Transaction List by Vendor `transactionlistbyvendor` | `zohoTransactionListByVendorService` | **AT** (every posting on Accounts Payable — the transaction, its split account and its amount), plus `bills` / `expense_entries` / `zb_vendor_payments` / `zb_vendor_credits` for the vendor name, document number and memo |
| 28 | Trial Balance `trialbalance` | `zohoGlReportsService.buildTrialBalance` | **AT** (opening balance, year-to-date movement and closing balance per account), plus `zb_chart_of_accounts` (Zoho) / `xero_accounts` (Xero) for the account code and type — QuickBooks syncs no chart, so its type comes from **AT** and the code column is dropped |
| 29 | General Ledger `generalledger` | `zohoGlReportsService.buildGeneralLedger` | **AT** (every posting line + the pre-period opening balance), plus `invoices` / `bills` / `expense_entries` / `zb_customer_payments` / `zb_vendor_payments` for the Name column |
| 30 | Chart of Accounts `chartofaccounts` | All 3: `zohoChartOfAccountsService` | Account master `zb_chart_of_accounts` (Zoho) / `xero_accounts` (Xero) / **AT** itself (QB syncs no master), unioned with every account posted to; balances always recomputed from **AT** as at the To date |

### Currency (2)
| # | Report | Builder | Tables |
|---|---|---|---|
| 31 | Foreign Currency Gains/Losses `foreigncurrencygainsandlosses` | `zohoForexService.buildForexGainsLosses` | `invoices`, `bills`, **AT** (bank balances + unapplied vendor credits), `zb_customer_payments`, `zb_vendor_payments` |
| 32 | Realized Gain or Loss `realizedgainorloss` | `zohoForexService.buildRealisedForex` | `zb_customer_payments`, `zb_vendor_payments`, `invoices`, `bills` |

---

## 3. Per-platform applicability

The builders are **shared** across all three providers. The difference is which
source tables a given platform's sync actually **populates**.

| Report group | Zoho | QuickBooks | Xero |
|---|---|---|---|
| P&L, Balance Sheet, Trial Balance, General Ledger, Exec Summary | ✅ from **AT** | ✅ from **AT** (`org_id = realm_id`, `meta.source: qbo-ledger`) | ✅ from **AT** (`org_id = tenant_id`) |
| Bank Summary / Cash Flow / Cash Summary / Cash Flow Statement | ✅ from **BT** | ✅ from **BT** | ✅ from **BT** |
| Sales by Customer, AR/AP Aging, Purchases by Vendor, Supplier Invoice, Expenses by Vendor, Vendor Contact List, Txn by Account, Budget Summary/Variance | ✅ | ✅ (shared `invoices`/`bills`/`expense_entries`/`vendors`/**AT**) | ✅ (same shared tables) |
| Sales by Product Detail | ✅ `zb_invoice_line_items` | ✅ `zb_invoice_line_items` | ⚠️ `unavailable` — Xero syncs no invoice lines |
| Chart of Accounts | ✅ `zb_chart_of_accounts` + **AT** balances | ✅ **AT** only (no account master synced) | ✅ `xero_accounts` + **AT** balances |
| Reports that need **Zoho-only** tables: Credit Note Details (`zb_credit_notes`), Purchases by Item / TDS (`zb_bill_line_items`), Inventory (`zb_items`), Recurring Bills (`zb_recurring_bills`), FX (`zb_*_payments`), AR-rewind (`zb_customer_payments`), GST/Tax line detail (`zb_invoice_line_items`) | ✅ | ⚠️ graceful **empty** (those `zb_*` tables aren't populated by QB sync) | ⚠️ graceful **empty** |
| Recurring Invoice Details | ⚠️ empty (no builder / no source table) | ⚠️ empty | ⚠️ empty |

✅ = built from DB · ⚠️ = returns an honest "no data / not available" state (never a live API call, never mock data).

---

## 4. Summary counts
- **32** catalog reports, all served from `oremusdb` (zero live Report-API calls).
- **19** report-data tables total; the 2 ledger tables (`account_transactions`,
  `bank_transactions`) power the financial core for **all three** providers.
- QuickBooks & Xero fully cover the ledger + shared-document reports; the
  line-item / payment / item / credit-note reports depend on `zb_*` tables that
  only the Zoho sync populates, so they show an empty state for QB/Xero until an
  equivalent sync writes those tables.

### The `xero-recon:%` rule — MANDATORY for every period P&L figure
`xeroPostingEngine.trueUpFromTrialBalance` posts one plug line per account keyed
`transaction_id = 'xero-recon:<accountId>'` (plus `xero-recon:__residual__`), ALL
dated the last ledger day. They force each account's **cumulative** balance to
Xero's trial balance. Left inside a **period** income/expense query they dump every
prior year onto that period — e.g. Budget Variance reported Revenue from Operations
- Domestic as **−29,178,929.31** instead of **+40,648,348.43** because one plug of
−69,827,277.74 sat in the window.

So any query that sums `account_group IN ('income','expense')` over a date range
MUST add `AND transaction_id NOT LIKE 'xero-recon:%'`. Applied in:
`zohoLedgerReportsService.aggregatePL`, `budgetVarianceService`
(`netsByAccount` + `breakdownLines`, which powers the click-through drill),
`metricsService.localCashFlow`, and the `routes/accounting.js` account drill.
Balance-sheet queries must KEEP the plugs — that is what they are for.
