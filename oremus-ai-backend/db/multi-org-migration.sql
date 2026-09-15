-- ─────────────────────────────────────────────────────────────────────────────
-- Multi-organization support for QuickBooks + hardened ledger keys.
-- Written against the live schema in oremusdb (verified 2026-09-08).
--
-- REVIEW BEFORE RUNNING. Not applied automatically.
--   phpMyAdmin: select `oremusdb`, open the SQL tab, paste, Go.
--   CLI       : mysql -u <user> -p oremusdb < db/multi-org-migration.sql
--
-- No stored procedures (a stale mysql.proc can't block it). Safe to re-run.
--
-- The new unique keys only ADD `org_id` to the existing ones, so no current row
-- can violate them — this cannot fail on existing data. Each key swap that
-- backs a `user_id` foreign key is done as ONE `ALTER TABLE` statement so the
-- FK is never left without a supporting index (avoids MariaDB error 1553).
--
-- Current state this migrates FROM:
--   qbo_tokens           : PRIMARY KEY(id), UNIQUE KEY `user_id`(user_id),
--                          FK qbo_tokens_ibfk_1 (user_id)
--   account_transactions : UNIQUE KEY uq_acct_txn(user_id,transaction_id,
--                          transaction_number,account_id), FK ..._ibfk_1(user_id)
--   bank_transactions    : UNIQUE KEY uq_bank_txn(user_id,transaction_id),
--                          FK ..._ibfk_1(user_id)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. qbo_tokens: one row per (user, realm) + an active flag ────────────────
-- `idx_qbo_tok_user` is added FIRST so the FK still has a user_id index when the
-- old `user_id` unique is dropped.
ALTER TABLE `qbo_tokens`
  ADD COLUMN IF NOT EXISTS `is_active` TINYINT(1) NOT NULL DEFAULT 1 AFTER `environment`;

ALTER TABLE `qbo_tokens`
  ADD INDEX IF NOT EXISTS `idx_qbo_tok_user` (`user_id`);

ALTER TABLE `qbo_tokens`
  ADD UNIQUE INDEX IF NOT EXISTS `uq_qbo_tok` (`user_id`, `realm_id`);

ALTER TABLE `qbo_tokens`
  DROP INDEX IF EXISTS `user_id`;

-- ── 2. account_transactions: scope the unique key by org_id (single ALTER) ───
ALTER TABLE `account_transactions`
  DROP INDEX IF EXISTS `uq_acct_txn`,
  ADD UNIQUE INDEX `uq_acct_txn`
    (`user_id`, `org_id`, `transaction_id`, `transaction_number`, `account_id`);

-- ── 3. bank_transactions: scope the unique key by org_id (single ALTER) ──────
ALTER TABLE `bank_transactions`
  DROP INDEX IF EXISTS `uq_bank_txn`,
  ADD UNIQUE INDEX `uq_bank_txn` (`user_id`, `org_id`, `transaction_id`);

-- ── Rollback (manual) ──────────────────────────────────────────────────────
-- Only safe while every user still has <= 1 QuickBooks company.
--   ALTER TABLE `qbo_tokens` ADD UNIQUE INDEX `user_id` (`user_id`);
--   ALTER TABLE `qbo_tokens` DROP INDEX `uq_qbo_tok`, DROP INDEX `idx_qbo_tok_user`, DROP COLUMN `is_active`;
--   ALTER TABLE `account_transactions` DROP INDEX `uq_acct_txn`,
--     ADD UNIQUE INDEX `uq_acct_txn` (`user_id`,`transaction_id`,`transaction_number`,`account_id`);
--   ALTER TABLE `bank_transactions` DROP INDEX `uq_bank_txn`,
--     ADD UNIQUE INDEX `uq_bank_txn` (`user_id`,`transaction_id`);
