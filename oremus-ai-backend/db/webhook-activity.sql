-- ─────────────────────────────────────────────────────────────────────────────
-- Webhook + Activity audit collections (Phase 2 audit + Phase 3 webhook sync).
-- ADDITIVE. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- Raw inbound webhook events (kept verbatim for audit + replay).
CREATE TABLE IF NOT EXISTS zb_webhook_logs (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  provider        VARCHAR(20)  NOT NULL DEFAULT 'zoho',
  user_id         INT          NULL,            -- resolved from org_id (nullable until matched)
  org_id          VARCHAR(100) NULL,
  event_type      VARCHAR(96)  NULL,            -- e.g. invoice.created, contact.updated
  module          VARCHAR(48)  NULL,            -- mapped warehouse module to resync
  resource_id     VARCHAR(96)  NULL,
  headers_json    JSON         NULL,
  payload_json    LONGTEXT     NULL,
  signature_ok    TINYINT(1)   DEFAULT 0,
  status          VARCHAR(16)  DEFAULT 'received', -- received | processed | ignored | failed
  error           VARCHAR(1024) NULL,
  received_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  processed_at    TIMESTAMP    NULL,
  INDEX idx_wh_user (user_id),
  INDEX idx_wh_org (org_id),
  INDEX idx_wh_event (event_type),
  INDEX idx_wh_received (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Normalised activity feed (system + provider events), powers audit reports.
CREATE TABLE IF NOT EXISTS zb_activity_logs (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NULL,
  provider        VARCHAR(20)  NULL,
  org_id          VARCHAR(100) NULL,
  actor           VARCHAR(255) NULL,            -- user/email/system
  action          VARCHAR(96)  NOT NULL,        -- sync.completed | webhook.received | etl.run | report.fetched
  entity_type     VARCHAR(48)  NULL,
  entity_id       VARCHAR(96)  NULL,
  summary         VARCHAR(1024) NULL,
  detail          JSON         NULL,
  created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_act_user (user_id),
  INDEX idx_act_action (action),
  INDEX idx_act_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
