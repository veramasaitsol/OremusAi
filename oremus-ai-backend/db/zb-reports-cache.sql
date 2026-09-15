-- =============================================================================
-- Zoho Books Reports Cache
-- One table that stores every Zoho /reports/* JSON response (raw + transformed)
-- with TTL so the Reports page + Dashboard match Zoho exactly with minimal
-- API hits.
-- =============================================================================

CREATE TABLE IF NOT EXISTS zb_report_cache (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  org_id          VARCHAR(100) NOT NULL,
  report_type     VARCHAR(64)  NOT NULL,
  params_hash     CHAR(40)     NOT NULL,
  params_json     JSON         NULL,
  zoho_endpoint   VARCHAR(255) NULL,
  status_code     INT          NULL,
  body            LONGTEXT     NULL,
  transformed     LONGTEXT     NULL,
  fetched_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  expires_at      DATETIME     NULL,
  UNIQUE KEY uq_zbrc (user_id, org_id, report_type, params_hash),
  INDEX idx_zbrc_user (user_id, org_id),
  INDEX idx_zbrc_exp  (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
