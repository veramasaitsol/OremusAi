-- QuickBooks ledger contacts + Cash-basis ledger.
--
-- Applied automatically by services/quickbooksService.js
-- (ensureLedgerContactColumns / ensureCashLedgerTable) on the next QuickBooks
-- sync; kept here for reference and for manual setup
-- (node db/apply-sql.js db/qbo-ledger-contacts.sql).
--
-- Why: QuickBooks' vendor reports (Expenses by Vendor Summary, …) count a
-- ledger line under a vendor only when the line's Name IS a Vendor — a payee
-- that is a Customer or Employee, or no payee at all, lands in "Not
-- Specified". account_transactions.transaction_details holds the Name, or the
-- memo when there is none, so it can't tell those apart: a payee-less expense
-- whose memo reads "Uber" looked like vendor Uber, and a Purchase paid to the
-- *customer* "Mercury Bank" looked like a vendor.
--
-- contact_id   = QuickBooks id of the line's customer / vendor / employee
--                (journal & deposit lines: the line's own Entity; other
--                documents: their payee / customer).
-- contact_type = 'Vendor' | 'Customer' | 'Employee' (NULL = unknown/none).
-- NULL contact_type on every line of a company = synced before these columns.

ALTER TABLE account_transactions ADD COLUMN contact_id   VARCHAR(64)  NULL;
ALTER TABLE account_transactions ADD COLUMN contact_type VARCHAR(16)  NULL;
ALTER TABLE account_transactions ADD COLUMN contact_name VARCHAR(255) NULL;

-- QuickBooks' own Cash-basis GeneralLedger (accounting_method=Cash), one row
-- per posting line, replaced per company on every sync. Cash-basis reports read
-- it rather than re-deriving cash timing: QuickBooks moves each bill's expense
-- lines to the dates the bill was paid, pro rata.
CREATE TABLE IF NOT EXISTS qbo_cash_ledger (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  user_id           INT           NOT NULL,
  org_id            VARCHAR(64)   NOT NULL,              -- QBO realm_id
  account_id        VARCHAR(64)   NOT NULL,
  account_name      VARCHAR(255)  NULL,
  account_group     VARCHAR(32)   NULL,                  -- asset | liability | equity | income | expense
  account_type_code VARCHAR(64)   NULL,
  account_sub_type  VARCHAR(64)   NULL,                  -- QBO AccountSubType (UnappliedCashBillPaymentExpense, …)
  transaction_date  DATE          NOT NULL,
  transaction_type  VARCHAR(64)   NULL,                  -- GL "Transaction Type" (Bill, Expense, Journal Entry, …)
  source_id         VARCHAR(64)   NULL,                  -- the document's QBO id
  reference_number  VARCHAR(255)  NULL,                  -- the document's number
  name              VARCHAR(255)  NULL,                  -- GL Name column
  memo              TEXT          NULL,
  debit             DECIMAL(18,2) NOT NULL DEFAULT 0,
  credit            DECIMAL(18,2) NOT NULL DEFAULT 0,
  currency_code     VARCHAR(8)    NULL,
  contact_id        VARCHAR(64)   NULL,
  contact_type      VARCHAR(16)   NULL,
  contact_name      VARCHAR(255)  NULL,
  synced_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_org_date (org_id, transaction_date),
  KEY idx_org_group (org_id, account_group),
  KEY idx_user_org (user_id, org_id)
);
