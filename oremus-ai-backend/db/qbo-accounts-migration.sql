-- ─────────────────────────────────────────────────────────────────────────────
-- qbo_accounts — Chart of Accounts synced from QuickBooks Online
-- Mirrors the QBO Account entity (developer.intuit.com → Account API)
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS qbo_accounts (
  id                                  INT AUTO_INCREMENT PRIMARY KEY,
  user_id                             INT          NOT NULL,
  realm_id                            VARCHAR(64)  NOT NULL,
  qbo_id                              VARCHAR(64)  NOT NULL,
  name                                VARCHAR(255) NULL,
  fully_qualified_name                VARCHAR(255) NULL,
  account_type                        VARCHAR(64)  NULL,
  account_sub_type                    VARCHAR(64)  NULL,
  classification                      VARCHAR(32)  NULL,   -- Asset / Liability / Equity / Revenue / Expense
  account_number                      VARCHAR(64)  NULL,
  description                         TEXT         NULL,
  current_balance                     DECIMAL(18,2) DEFAULT 0,
  current_balance_with_sub_accounts   DECIMAL(18,2) DEFAULT 0,
  currency                            VARCHAR(10)  NULL,
  parent_qbo_id                       VARCHAR(64)  NULL,
  is_sub_account                      TINYINT(1)   DEFAULT 0,
  active                              TINYINT(1)   DEFAULT 1,
  qbo_created_at                      DATETIME     NULL,
  qbo_updated_at                      DATETIME     NULL,
  synced_at                           TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_qbo_account (user_id, qbo_id),
  INDEX idx_realm_id (realm_id),
  INDEX idx_account_type (account_type),
  INDEX idx_classification (classification),
  INDEX idx_parent_qbo_id (parent_qbo_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
