# Xero — every API + table we use (sync in, reports out)

Source of truth: `services/xeroService.js` (sync), `routes/auth.js` (connect),
`services/xeroReportsService.js` + `routes/accounting.js` (reports). Base URL for
the Accounting API: `https://api.xero.com/api.xro/2.0`. Verified 2026-07-23.

===============================================================================
## PART 1 — SYNC: APIs that pull data FROM Xero INTO our tables
===============================================================================

### 1a. Connect-time (one-time, when a user links Xero) — routes/auth.js
| Xero API | Purpose | Table written |
|---|---|---|
| `POST identity.xero.com/connect/token` | OAuth — exchange code / refresh token | `xero_tokens` (access, refresh, expires, tenant_id) |
| `GET /connections` | which tenant(s) the user authorized | (drives tenant_id) |
| `GET /Organisation` | org name + base currency | `xero_organizations` |

### 1b. Data sync (POST /api/sync/xero/all → syncAllXeroData) — services/xeroService.js
| # | Sync function | Xero API | Filter/params | Table written |
|---|---|---|---|---|
| 1 | syncAccounts | `GET /Accounts` | — | `xero_accounts` |
| 2 | fetchAndStoreBalances | `GET /Reports/TrialBalance` | — | updates `xero_accounts.balance` |
| 3 | syncCustomers | `GET /Contacts` | `where=IsCustomer==true` | `customers` |
| 4 | syncVendors | `GET /Contacts` | `where=IsSupplier==true` | `vendors` |
| 5 | syncInvoices | `GET /Invoices` | `Statuses=AUTHORISED,PAID` + `Type=="ACCREC"` | `invoices` |
| 6 | syncBills | `GET /Invoices` | `Statuses=AUTHORISED,PAID` + `Type=="ACCPAY"` | `bills` |
| 7 | syncExpenses | `GET /BankTransactions` | `where=Type=="SPEND"` | `expense_entries` |
| 8 | syncBankTransactions | `GET /BankTransactions` | — | `bank_transactions` |
| 9 | syncManualJournals | `GET /ManualJournals` | — | `account_transactions` (GL) + `xero_raw_transactions` |
| 10 | syncJournals (full GL) | `GET /Journals` | `offset` (paginated) | `account_transactions` (GL) + `xero_raw_transactions` |

**Distinct Xero endpoints used for sync = 8:**
`/Organisation`, `/Accounts`, `/Reports/TrialBalance`, `/Contacts`, `/Invoices`,
`/BankTransactions`, `/ManualJournals`, `/Journals`
(`/Contacts`, `/Invoices`, `/BankTransactions` are each called twice with different filters).

> Note on GL: full ledger comes from `/Journals` and needs the
> `accounting.journals.read` scope. Without it, only `/ManualJournals` syncs
> (a small subset) — this is why Xero's `account_transactions` count can be far
> lower than Zoho's until you reconnect with that scope.

===============================================================================
## PART 2 — REPORTS: APIs + tables used to CREATE reports in our platform
===============================================================================
Route: `GET /api/accounting/:type` → XeroProvider.fetchReport → xeroReportsService.

### 2a. Fetched LIVE from Xero's own Reports API (match Xero UI exactly — NO ledger table)
| Report | Xero API | Tables touched (auth/currency/cache only) |
|---|---|---|
| Profit & Loss | `GET /Reports/ProfitAndLoss` | `xero_tokens`, `xero_organizations`, `acc_report_cache` |
| Balance Sheet | `GET /Reports/BalanceSheet` | same |
| Trial Balance | `GET /Reports/TrialBalance` | same |
| Bank Summary | `GET /Reports/BankSummary` | same |
| Executive Summary | `GET /Reports/ExecutiveSummary` | same |
| Chart of Accounts | `GET /Accounts` | `xero_tokens`, `xero_organizations`, `acc_report_cache` |

### 2b. DERIVED from Xero's Reports API (extra call, no single Xero report exists)
| Report | Xero API called | Built by |
|---|---|---|
| Budget Summary | *none* — Xero exposes no budget, so it reports `unavailable` | budgetSummaryService |
| Budget Variance | `GET /Reports/ProfitAndLoss` (period + YTD) | xeroBudgetVarianceService |
| Cash Flow (indirect) | `GET /Reports/ProfitAndLoss` + `GET /Reports/BalanceSheet` (open/close) | xeroCashFlowService |

### 2c. Built from OUR SYNCED tables (NO live Xero call at report time)
| Report(s) | Tables used |
|---|---|
| Cash Summary, Statement of Cash Flows (direct) | `bank_transactions` (+ `xero_tokens` for tenant) |
| Sales by Customer, AR Aging (summary/detail) | `invoices` |
| AP Aging (summary/detail), Supplier Invoice Summary | `bills` |
| Purchases by Vendor, Expenses by Vendor Summary | `bills`, `expense_entries` |
| Vendor Contact List | `vendors` |
| Transaction Detail by Account, Transaction List by Vendor | `account_transactions` / `bills` |
| Tax Liability, TDS Summary, GST Returns Workbook | `invoices`, `bills` |
| General Ledger (if exposed) | `account_transactions` |

===============================================================================
## SUMMARY (the counts you asked for)
===============================================================================
- **APIs to SYNC Xero → our platform:** **8 distinct endpoints** (10 calls counting
  the 3 that run twice with different filters), listed in Part 1b, plus 3 connect-time
  APIs (OAuth token, /connections, /Organisation).
- **APIs to CREATE reports:** **5 live Xero report endpoints** (`/Reports/ProfitAndLoss`,
  `/Reports/BalanceSheet`, `/Reports/TrialBalance`, `/Reports/BankSummary`,
  `/Reports/ExecutiveSummary`) + **1 list endpoint** (`/Accounts` for Chart of Accounts).
  The derived reports (Budget×2, Cash Flow) reuse `/Reports/ProfitAndLoss` (+ BalanceSheet).
  Everything else is served from our synced tables with NO extra Xero call.
- **Tables Xero data lives in:** `xero_tokens`, `xero_organizations`, `xero_accounts`,
  `customers`, `vendors`, `invoices`, `bills`, `expense_entries`, `bank_transactions`,
  `account_transactions`, `xero_raw_transactions`, and the report cache `acc_report_cache`.
