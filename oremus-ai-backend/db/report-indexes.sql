-- ─────────────────────────────────────────────────────────────────────────────
-- Performance indexes for the report + dashboard queries at 200+ clients.
--
-- REVIEW BEFORE RUNNING. Not applied automatically.
--   CLI  : mysql -u <user> -p <db> < db/report-indexes.sql
--   cPanel/phpMyAdmin: select the DB, open the Import tab, choose this file.
--
-- MariaDB 10.0.2+ / MySQL 8.0 native `IF NOT EXISTS` — no stored procedures,
-- so a stale mysql.proc system table cannot block it. Safe to re-run.
--
-- Why these: every report builder filters account_transactions / bank_transactions
-- by (org_id) and a transaction_date range, often also by platform. Existing
-- keys are (user_id)/(user_id,org_id) shaped, so date-range scans read the
-- whole org.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE account_transactions ADD INDEX IF NOT EXISTS idx_at_org_date       (org_id, transaction_date);
ALTER TABLE account_transactions ADD INDEX IF NOT EXISTS idx_at_user_org_plat  (user_id, org_id, platform);
ALTER TABLE account_transactions ADD INDEX IF NOT EXISTS idx_at_org_group_date (org_id, account_group, transaction_date);
ALTER TABLE bank_transactions    ADD INDEX IF NOT EXISTS idx_bt_org_date       (org_id, transaction_date);

-- ── Rollback (manual) ──────────────────────────────────────────────────────
--   ALTER TABLE account_transactions
--     DROP INDEX idx_at_org_date, DROP INDEX idx_at_user_org_plat, DROP INDEX idx_at_org_group_date;
--   ALTER TABLE bank_transactions DROP INDEX idx_bt_org_date;
