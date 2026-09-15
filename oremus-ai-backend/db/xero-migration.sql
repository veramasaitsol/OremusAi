-- ─────────────────────────────────────────────────────────────────────────────
-- Xero integration migration
-- Idempotent: safe to re-run.
-- Adds xero_tokens, xero_organizations, xero_accounts, and xero_id columns
-- on shared data tables so Xero-synced rows coexist with Zoho/QB rows.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS xero_tokens (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL UNIQUE,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    BIGINT,
  tenant_id     VARCHAR(64),
  tenant_name   VARCHAR(255),
  connected_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS xero_organizations (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  user_id               INT NOT NULL,
  tenant_id             VARCHAR(64) NOT NULL,
  name                  VARCHAR(255),
  legal_name            VARCHAR(255),
  short_code            VARCHAR(64),
  country               VARCHAR(10),
  currency              VARCHAR(10),
  fiscal_year_end_month VARCHAR(20),
  organisation_type     VARCHAR(64),
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_user_tenant (user_id, tenant_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS xero_accounts (
  id                          INT AUTO_INCREMENT PRIMARY KEY,
  user_id                     INT NOT NULL,
  tenant_id                   VARCHAR(64) NOT NULL,
  xero_id                     VARCHAR(64) NOT NULL,
  code                        VARCHAR(64) NULL,
  name                        VARCHAR(255) NULL,
  type                        VARCHAR(64) NULL,
  tax_type                    VARCHAR(64) NULL,
  class                       VARCHAR(32) NULL,
  description                 TEXT NULL,
  enable_payments_to_account  TINYINT(1) DEFAULT 0,
  show_in_expense_claims      TINYINT(1) DEFAULT 0,
  status                      VARCHAR(20) NULL,
  bank_account_number         VARCHAR(64) NULL,
  bank_account_type           VARCHAR(64) NULL,
  currency_code               VARCHAR(10) NULL,
  reporting_code              VARCHAR(64) NULL,
  reporting_code_name         VARCHAR(255) NULL,
  has_attachments             TINYINT(1) DEFAULT 0,
  balance                     DECIMAL(18,2) DEFAULT 0,
  updated_date_utc            DATETIME NULL,
  synced_at                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_xero_account (user_id, xero_id),
  INDEX idx_tenant_id (tenant_id),
  INDEX idx_type (type),
  INDEX idx_class (class),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP PROCEDURE IF EXISTS add_xero_column;
DELIMITER $$
CREATE PROCEDURE add_xero_column(IN tbl VARCHAR(64))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = tbl
       AND COLUMN_NAME  = 'xero_id'
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN xero_id VARCHAR(64) NULL, ADD INDEX idx_xero_id (xero_id)');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

CALL add_xero_column('customers');
CALL add_xero_column('vendors');
CALL add_xero_column('invoices');
CALL add_xero_column('bills');
CALL add_xero_column('expense_entries');
CALL add_xero_column('daybook_transactions');
CALL add_xero_column('account_transactions');
CALL add_xero_column('bank_transactions');

DROP PROCEDURE IF EXISTS add_xero_column;
