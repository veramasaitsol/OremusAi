-- ─────────────────────────────────────────────────────────────────────────────
-- Oremus Accounting Engine — A2: unified documents (acc_documents + lines).
-- Idempotent: safe to re-run. ADDITIVE.
--
-- DRILL-DOWN ONLY. These tables are NEVER summed to build a report — that is the
-- whole point of the GL-as-source-of-truth design (the recent invoice
-- sub_total/tax_total=0 bug was a direct symptom of summing documents). Reports
-- come from acc_journal_lines; these rows exist purely so a user can click a
-- report figure → see the originating invoice/bill/payment and its line items.
--
-- One acc_documents row per source document; links 1:1 to the acc_journal row
-- it posted (via provider + connection_ref + source_type + source_ref, the same
-- natural key acc_journal uses).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS acc_documents (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  doc_type        VARCHAR(48)  NOT NULL,    -- Invoice | Bill | Payment | CreditNote | Expense | JournalEntry | …
  doc_ref         VARCHAR(96)  NOT NULL,    -- provider document id
  doc_number      VARCHAR(128) NULL,
  doc_date        DATE         NULL,
  due_date        DATE         NULL,
  status          VARCHAR(48)  NULL,
  contact_ref     VARCHAR(64)  NULL,        -- customer / vendor provider id
  contact_name    VARCHAR(512) NULL,
  sub_total       DECIMAL(20,2) NULL,
  tax_total       DECIMAL(20,2) NULL,
  discount        DECIMAL(20,2) NULL,
  total           DECIMAL(20,2) NULL,
  balance         DECIMAL(20,2) NULL,
  currency        VARCHAR(10)  NULL,
  memo            VARCHAR(1024) NULL,
  raw_payload     JSON         NULL,
  created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_acc_document (provider, connection_ref, doc_type, doc_ref),
  INDEX idx_acc_doc_user (user_id),
  INDEX idx_acc_doc_conn (provider, connection_ref),
  INDEX idx_acc_doc_date (doc_date),
  INDEX idx_acc_doc_type (doc_type),
  INDEX idx_acc_doc_contact (contact_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS acc_document_lines (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  document_id     BIGINT       NOT NULL,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  line_no         INT          NOT NULL DEFAULT 0,
  account_ref     VARCHAR(64)  NULL,        -- the income/expense/COGS account this line hits
  account_name    VARCHAR(512) NULL,
  item_name       VARCHAR(512) NULL,
  description     VARCHAR(1024) NULL,
  quantity        DECIMAL(20,4) NULL,
  rate            DECIMAL(20,4) NULL,
  amount          DECIMAL(20,2) NULL,
  tax_amount      DECIMAL(20,2) NULL,
  tax_name        VARCHAR(128) NULL,
  raw_payload     JSON         NULL,
  UNIQUE KEY uq_acc_doc_line (document_id, line_no),
  INDEX idx_acc_docline_doc (document_id),
  INDEX idx_acc_docline_account (provider, connection_ref, account_ref),
  CONSTRAINT fk_acc_docline_doc FOREIGN KEY (document_id)
    REFERENCES acc_documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
