-- Financial Year settings. Also applied automatically on first use by
-- services/reportSettingsService.js (ensureSchema). Safe to re-run except the
-- ALTER, which MySQL rejects if the column already exists — skip it then.
--   users.fy_start_month       client override (1..12), NULL = inherit
--   report_settings (user_id 0) admin default per platform
-- Resolution: client → admin platform → system default (QBO/Xero Jan, Zoho Apr).
CREATE TABLE IF NOT EXISTS report_settings (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  user_id        INT          NOT NULL,
  platform       VARCHAR(12)  NOT NULL,
  fy_start_month TINYINT      NULL,
  updated_by     INT          NULL,
  created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_scope_platform (user_id, platform)
);
ALTER TABLE users ADD COLUMN fy_start_month TINYINT NULL DEFAULT NULL;
UPDATE users u JOIN report_settings r ON r.user_id = u.id
   SET u.fy_start_month = r.fy_start_month
 WHERE r.user_id > 0 AND r.fy_start_month BETWEEN 1 AND 12 AND u.fy_start_month IS NULL;
DELETE FROM report_settings WHERE user_id > 0;
