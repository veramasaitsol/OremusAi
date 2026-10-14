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

-- ── New table indexes ──────────────────────────────────────────────────────
ALTER TABLE zb_invoice_line_items ADD INDEX IF NOT EXISTS idx_zili_invoice  (`zoho_invoice_id`);
ALTER TABLE zb_invoice_line_items ADD INDEX IF NOT EXISTS idx_zili_item       (`zoho_item_id`);
ALTER TABLE zb_vendor_payments ADD INDEX IF NOT EXISTS idx_zvp_org           (`org_id`);
ALTER TABLE zb_vendor_payments ADD INDEX IF NOT EXISTS idx_zvp_contact         (`contact_name`);
ALTER TABLE zb_vendor_credits  ADD INDEX IF NOT EXISTS idx_vc_org              (`org_id`);
ALTER TABLE zb_vendor_credits  ADD INDEX IF NOT EXISTS idx_vc_contact            (`contact_name`);
ALTER TABLE zb_customer_payments ADD INDEX IF NOT EXISTS idx_cp_org               (`org_id`);
ALTER TABLE zb_customer_payments ADD INDEX IF NOT EXISTS idx_cp_contact              (`contact_name`);
-- ── Rollback (manual) ──────────────────────────────────────────────────────
--   ALTER TABLE account_transactions
--     DROP INDEX idx_at_org_date, DROP INDEX idx_at_user_org_plat, DROP INDEX idx_at_org_group_date;
--   ALTER TABLE bank_transactions DROP INDEX idx_bt_org_date;
--   ALTER TABLE zb_invoice_line_items DROP INDEX idx_zili_invoice, DROP INDEX idx_zili_item;
--   ALTER TABLE zb_vendor_payments DROP INDEX idx_zvp_org, DROP INDEX idx_zvp_contact;
--   ALTER TABLE zb_vendor_credits  DROP INDEX idx_vc_org, DROP INDEX idx_vc_contact;
--   ALTER TABLE zb_customer_payments DROP INDEX idx_cp_org, DROP INDEX idx_cp_contact;
