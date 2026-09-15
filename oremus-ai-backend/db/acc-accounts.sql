-- ─────────────────────────────────────────────────────────────────────────────
-- Oremus Accounting Engine — A1: unified Chart of Accounts (acc_accounts).
-- Idempotent: safe to re-run. ADDITIVE — never touches provider tables.
--
-- This is the "dimensions / accounts" layer of the GL-as-source-of-truth design.
-- Every journal line (acc_journal_lines.account_ref) classifies through this table,
-- and every report (TB / P&L / BS) GROUPs BY these accounts. The classification
-- flags below are what make a Balance Sheet / P&L correct:
--   • account_type            : asset | liability | equity | income | expense
--   • is_bank                 : a Cash/Bank account (Cash Flow + "Cash on Hand")
--   • is_ar                   : Accounts Receivable control account
--   • is_ap                   : Accounts Payable control account
--   • is_retained_earnings    : the Retained Earnings equity account
--
-- Sign convention (matches acc_journal_lines): debit/credit stored as separate
-- non-negative amounts; net of a line = debit − credit. asset/expense are
-- debit-normal; liability/equity/income are credit-normal.
--
-- Back-filled per provider from the provider COA tables (zb_chart_of_accounts,
-- qbo_accounts, xero_accounts). raw_payload keeps the original row for re-mapping.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS acc_accounts (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id              INT          NOT NULL,
  provider             VARCHAR(20)  NOT NULL,   -- quickbooks | zoho | xero
  connection_ref       VARCHAR(64)  NOT NULL,   -- realm_id / org_id / tenant_id
  account_ref          VARCHAR(64)  NOT NULL,   -- provider account id
  code                 VARCHAR(64)  NULL,       -- account number / code
  name                 VARCHAR(512) NULL,
  account_type         ENUM('asset','liability','equity','income','expense') NULL,
  account_subtype      VARCHAR(128) NULL,       -- provider's finer type (bank, accounts_receivable, …)
  is_bank              TINYINT(1)   NOT NULL DEFAULT 0,
  is_ar                TINYINT(1)   NOT NULL DEFAULT 0,
  is_ap                TINYINT(1)   NOT NULL DEFAULT 0,
  is_retained_earnings TINYINT(1)   NOT NULL DEFAULT 0,
  parent_ref           VARCHAR(64)  NULL,       -- provider parent account id (hierarchy)
  currency             VARCHAR(10)  NULL,
  is_active            TINYINT(1)   NOT NULL DEFAULT 1,
  raw_payload          JSON         NULL,
  created_at           TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_acc_account (connection_ref, account_ref),
  INDEX idx_acc_account_user (user_id),
  INDEX idx_acc_account_conn (provider, connection_ref),
  INDEX idx_acc_account_type (account_type),
  INDEX idx_acc_account_flags (is_bank, is_ar, is_ap, is_retained_earnings)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
