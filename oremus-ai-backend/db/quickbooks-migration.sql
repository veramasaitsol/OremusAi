-- ─────────────────────────────────────────────────────────────────────────────
-- QuickBooks Online integration migration
-- Idempotent: run multiple times safely.
-- Adds qbo_tokens, qbo_organizations and qbo_id columns on data tables so
-- QBO-synced rows coexist with Zoho-synced rows.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS qbo_tokens (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL UNIQUE,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    BIGINT,
  realm_id      VARCHAR(64),
  environment   VARCHAR(20) DEFAULT 'sandbox',
  connected_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS qbo_organizations (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  user_id           INT NOT NULL,
  realm_id          VARCHAR(64) NOT NULL,
  company_name      VARCHAR(255),
  legal_name        VARCHAR(255),
  country           VARCHAR(10),
  currency          VARCHAR(10),
  fiscal_year_start VARCHAR(20),
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_user_realm (user_id, realm_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Add qbo_id columns to existing data tables (one column per table).
-- Wrapped in a stored procedure so re-runs don't error on "Duplicate column".
DROP PROCEDURE IF EXISTS add_qbo_column;
DELIMITER $$
CREATE PROCEDURE add_qbo_column(IN tbl VARCHAR(64))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = tbl
       AND COLUMN_NAME  = 'qbo_id'
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN qbo_id VARCHAR(64) NULL, ADD INDEX idx_qbo_id (qbo_id)');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

CALL add_qbo_column('customers');
CALL add_qbo_column('vendors');
CALL add_qbo_column('invoices');
CALL add_qbo_column('bills');
CALL add_qbo_column('expense_entries');
CALL add_qbo_column('daybook_transactions');
CALL add_qbo_column('account_transactions');
CALL add_qbo_column('bank_transactions');

DROP PROCEDURE IF EXISTS add_qbo_column;
