-- Xero credit documents + their dated allocations / refunds.
--
-- Created automatically by services/xeroAllocationsService.js
-- (ensureXeroAllocationTables) on the first Xero sync; kept here for reference
-- and for manual setup (node db/apply-sql.js db/xero-allocations.sql).
--
-- Why: Xero's GL has no line for allocating a credit note / overpayment /
-- prepayment to a bill or invoice, so the posting-engine ledger can't date
-- those settlements and historical A/P aging can't tell whether such a bill
-- was still open. Xero returns the date on each Allocation
-- (GET /CreditNotes, /Overpayments, /Prepayments — scope accounting.transactions
-- or accounting.transactions.read).
--
-- Amounts are in the document's own currency (Xero only allocates between
-- documents of the same currency). currency_rate is Xero's CurrencyRate
-- (foreign units per 1 base unit).

CREATE TABLE IF NOT EXISTS xero_credit_docs (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  user_id          INT           NOT NULL,
  org_id           VARCHAR(64)   NOT NULL,              -- Xero tenant_id
  doc_type         VARCHAR(16)   NOT NULL,              -- CREDITNOTE | OVERPAYMENT | PREPAYMENT
  doc_id           VARCHAR(64)   NOT NULL,              -- CreditNoteID / OverpaymentID / PrepaymentID
  xero_type        VARCHAR(32)   NULL,                  -- ACCPAYCREDIT, SPEND-OVERPAYMENT, …
  side             CHAR(2)       NOT NULL,              -- ap | ar
  doc_number       VARCHAR(255)  NULL,
  reference        VARCHAR(255)  NULL,
  contact_id       VARCHAR(64)   NULL,
  contact_name     VARCHAR(255)  NULL,
  date             DATE          NULL,
  status           VARCHAR(20)   NULL,                  -- AUTHORISED | PAID | VOIDED | …
  total            DECIMAL(18,2) NOT NULL DEFAULT 0,
  remaining_credit DECIMAL(18,2) NOT NULL DEFAULT 0,    -- open today, per Xero
  currency_code    VARCHAR(3)    NULL,
  currency_rate    DECIMAL(18,8) NULL,
  ledger_source_id VARCHAR(64)   NULL,                  -- account_transactions.source_id of the doc
  synced_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_doc (user_id, org_id, doc_type, doc_id),
  KEY idx_org_side (org_id, side)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS xero_allocations (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  user_id        INT           NOT NULL,
  org_id         VARCHAR(64)   NOT NULL,
  doc_type       VARCHAR(16)   NOT NULL,
  doc_id         VARCHAR(64)   NOT NULL,
  kind           VARCHAR(12)   NOT NULL,                -- ALLOCATION | REFUND
  line_key       VARCHAR(100)  NOT NULL,                -- AllocationID / PaymentID
  invoice_id     VARCHAR(64)   NULL,                    -- bills.xero_id / invoices.xero_id (ALLOCATION)
  invoice_number VARCHAR(255)  NULL,
  date           DATE          NULL,                    -- date the allocation / refund applied
  amount         DECIMAL(18,2) NOT NULL DEFAULT 0,
  synced_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_line (user_id, org_id, doc_type, doc_id, kind, line_key),
  KEY idx_invoice (org_id, invoice_id),
  KEY idx_doc (org_id, doc_type, doc_id)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which document types have been fetched per org (an org with no overpayments
-- has no rows in the tables above, which must not read as "never synced").
CREATE TABLE IF NOT EXISTS xero_allocation_sync (
  user_id   INT         NOT NULL,
  org_id    VARCHAR(64) NOT NULL,
  doc_type  VARCHAR(16) NOT NULL,                      -- CREDITNOTE | OVERPAYMENT | PREPAYMENT
  synced_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, org_id, doc_type)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
