-- ─────────────────────────────────────────────────────────────────────────────
-- Oremus Accounting Engine — A4: cash-basis flag on acc_journal.
-- Idempotent: safe to re-run. ADDITIVE.
--
-- Adds is_cash_settled to acc_journal so cash-basis reports can restrict to
-- journals that represent a cash movement (accrual = all posted journals).
-- NOTE (per plan): the boolean is coarse — for true cash-basis parity we ALSO
-- pull each provider's own cash-basis totals into acc_report_snapshots and
-- reconcile against them. This flag is the GL-side approximation.
--
-- MySQL 8 has no `ADD COLUMN IF NOT EXISTS`, so we guard with information_schema
-- + a prepared statement. This relies on a SINGLE session (run via the mysql CLI),
-- NOT the pooled db/apply-sql.js runner (whose statements can land on different
-- pooled connections, losing @session vars). Apply with:
--   mysql -u root --host=127.0.0.1 --port=3306 oremus_db < db/acc-journal-cashbasis.sql
--
-- Multi-currency (base_debit/base_credit, acc_exchange_rates) is DEFERRED — not
-- added here.
-- ─────────────────────────────────────────────────────────────────────────────

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'acc_journal'
    AND COLUMN_NAME  = 'is_cash_settled'
);

SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE acc_journal ADD COLUMN is_cash_settled TINYINT(1) NOT NULL DEFAULT 0 AFTER currency',
  'SELECT 1');

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
