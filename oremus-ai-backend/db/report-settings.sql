-- ─────────────────────────────────────────────────────────────────────────────
-- report_settings — per-platform Financial Year start month.
--
-- REVIEW BEFORE RUNNING. Not applied automatically.
--   CLI  : mysql -u <user> -p <db> < db/report-settings.sql
--   cPanel/phpMyAdmin: select the DB, open the Import tab, choose this file.
--
-- One row per (scope, platform):
--   user_id = 0            → the admin / global default for that platform
--                            (there is no users.id 0, so it never collides).
--   user_id = <client id>  → that client's own override for their platform.
--
-- Resolution for a report request by effective user U on platform P:
--   1. row (U, P)                → client override
--   2. else row (0, P)          → admin default
--   3. else fallback in code    → fy_start_month = 4 (April)
--
-- Safe to re-run (CREATE TABLE IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS report_settings (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  user_id        INT          NOT NULL,             -- 0 = admin/global default
  platform       VARCHAR(12)  NOT NULL,             -- 'zoho' | 'quickbooks' | 'xero'
  fy_start_month TINYINT      NULL,                 -- 1..12; NULL = inherit
  updated_by     INT          NULL,
  created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_scope_platform (user_id, platform)
);
