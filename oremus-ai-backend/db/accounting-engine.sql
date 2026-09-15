-- ─────────────────────────────────────────────────────────────────────────────
-- Oremus Accounting Engine — provider-agnostic common accounting data layer.
-- Idempotent: safe to re-run. Creates 6 tables prefixed acc_*.
--
-- This is ADDITIVE. It NEVER touches existing tables (qbo_*, zb_*, zoho_*, xero_*,
-- customers, invoices, …). It is a unified double-entry General Ledger + report
-- cache + audit layer that sits ABOVE each provider's raw warehouse, fed by the
-- provider adapters (QuickBooksProvider, ZohoBooksProvider, …).
--
-- Design notes:
--  • provider          : 'quickbooks' | 'zoho' | 'xero'
--  • connection_ref    : QBO realm_id / Zoho org_id / Xero tenant_id (multi-org isolation)
--  • account_ref       : the provider's account id (QBO Account.Id / Zoho account_id)
--  • source_type/ref   : the originating document (Invoice, Bill, Payment, JournalEntry …)
--  • Running balances are computed at QUERY time from acc_journal_lines (no stored cache),
--    so the ledger is always internally consistent with the posted lines.
-- ─────────────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════════════
--  CONNECTIONS — one row per connected company (realm / org / tenant)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS acc_connections (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  company_name    VARCHAR(255) NULL,
  currency        VARCHAR(10)  NULL,
  environment     VARCHAR(20)  NULL,
  fiscal_year_start_month TINYINT NULL,
  is_active       TINYINT(1)   DEFAULT 1,
  created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_acc_conn (user_id, provider, connection_ref),
  INDEX idx_acc_conn_user (user_id),
  INDEX idx_acc_conn_provider (provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ════════════════════════════════════════════════════════════════════════════
--  JOURNAL — one row per posted source transaction
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS acc_journal (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  source_type     VARCHAR(48)  NOT NULL,    -- Invoice | Bill | Payment | BillPayment | JournalEntry | Deposit | …
  source_ref      VARCHAR(96)  NOT NULL,    -- the provider transaction id
  txn_date        DATE         NULL,
  doc_number      VARCHAR(128) NULL,
  entity_name     VARCHAR(512) NULL,        -- customer / vendor / payee
  memo            VARCHAR(1024) NULL,
  total_amt       DECIMAL(20,2) NULL,
  currency        VARCHAR(10)  NULL,
  posted_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_acc_journal (provider, connection_ref, source_type, source_ref),
  INDEX idx_acc_journal_user (user_id),
  INDEX idx_acc_journal_conn (connection_ref),
  INDEX idx_acc_journal_date (txn_date),
  INDEX idx_acc_journal_type (source_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ════════════════════════════════════════════════════════════════════════════
--  JOURNAL LINES — the double-entry ledger (debit / credit per account)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS acc_journal_lines (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  journal_id      BIGINT       NOT NULL,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  line_no         INT          NOT NULL DEFAULT 0,
  account_ref     VARCHAR(64)  NULL,
  account_name    VARCHAR(512) NULL,
  txn_date        DATE         NULL,
  debit           DECIMAL(20,2) NOT NULL DEFAULT 0,
  credit          DECIMAL(20,2) NOT NULL DEFAULT 0,
  entity_name     VARCHAR(512) NULL,
  memo            VARCHAR(1024) NULL,
  klass           VARCHAR(255) NULL,        -- QBO Class
  department      VARCHAR(255) NULL,        -- QBO Department / Location
  UNIQUE KEY uq_acc_line (journal_id, line_no),
  INDEX idx_acc_line_journal (journal_id),
  INDEX idx_acc_line_account (provider, connection_ref, account_ref),
  INDEX idx_acc_line_conn_date (connection_ref, txn_date),
  CONSTRAINT fk_acc_line_journal FOREIGN KEY (journal_id)
    REFERENCES acc_journal(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ════════════════════════════════════════════════════════════════════════════
--  REPORT CACHE — provider-agnostic (mirrors zb_report_cache)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS acc_report_cache (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  report_type     VARCHAR(64)  NOT NULL,
  params_hash     CHAR(40)     NOT NULL,
  params_json     JSON         NULL,
  status_code     INT          NULL,
  body            LONGTEXT     NULL,
  transformed     LONGTEXT     NULL,
  fetched_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  expires_at      DATETIME     NULL,
  UNIQUE KEY uq_acc_cache (user_id, provider, connection_ref, report_type, params_hash),
  INDEX idx_acc_cache_lookup (provider, connection_ref, report_type),
  INDEX idx_acc_cache_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ════════════════════════════════════════════════════════════════════════════
--  AUDIT LOG — unified accounting events
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS acc_audit_log (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NULL,
  provider        VARCHAR(20)  NULL,
  connection_ref  VARCHAR(64)  NULL,
  event           VARCHAR(48)  NOT NULL,    -- sync_started | sync_completed | sync_failed |
                                            -- ledger_ingested | entity_updated | manual_sync | report_fetched
  source_type     VARCHAR(48)  NULL,
  source_ref      VARCHAR(96)  NULL,
  detail          JSON         NULL,
  created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_acc_audit_user (user_id),
  INDEX idx_acc_audit_event (event),
  INDEX idx_acc_audit_created (created_at),
  INDEX idx_acc_audit_conn (provider, connection_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
