-- ─────────────────────────────────────────────────────────────────────────────
-- QuickBooks Online Warehouse migration.
-- Idempotent: safe to re-run. Creates 4 tables prefixed qbo_wh_* / qbo_entities.
-- Existing tables (qbo_tokens, qbo_organizations, qbo_accounts, customers, …) are
-- NEVER touched. This is a parallel, additive "whole data" store mirroring the
-- Zoho zb_* warehouse pattern but using a generic JSON-per-record design so that
-- ALL QBO Query-API entities are captured without per-entity schema modelling.
-- ─────────────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════════════
--  BRONZE — raw API page archive (replay / audit)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS qbo_wh_raw_payloads (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  realm_id        VARCHAR(64)  NULL,
  entity          VARCHAR(64)  NOT NULL,
  query           TEXT         NULL,
  response_status INT          NULL,
  response_body   LONGTEXT     NULL,
  response_size   INT          NULL,
  start_position  INT          NULL,
  max_results     INT          NULL,
  record_count    INT          NULL,
  fetched_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  duration_ms     INT          NULL,
  sync_run_id     BIGINT       NULL,
  error           TEXT         NULL,
  INDEX idx_qwh_raw_entity  (entity),
  INDEX idx_qwh_raw_user    (user_id, realm_id),
  INDEX idx_qwh_raw_run     (sync_run_id),
  INDEX idx_qwh_raw_fetched (fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ════════════════════════════════════════════════════════════════════════════
--  AUDIT — sync run log
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS qbo_wh_sync_runs (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id           INT          NOT NULL,
  realm_id          VARCHAR(64)  NULL,
  run_type          VARCHAR(50)  NOT NULL,
  trigger_source    VARCHAR(50)  NULL,
  triggered_by_user INT          NULL,
  started_at        DATETIME     NOT NULL,
  completed_at      DATETIME     NULL,
  status            VARCHAR(20)  DEFAULT 'running',
  entities_requested JSON        NULL,
  entities_completed JSON        NULL,
  api_calls_made    INT          DEFAULT 0,
  records_upserted  INT          DEFAULT 0,
  records_failed    INT          DEFAULT 0,
  error_summary     TEXT         NULL,
  INDEX idx_qwh_run_user   (user_id, realm_id),
  INDEX idx_qwh_run_status (status),
  INDEX idx_qwh_run_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS qbo_wh_sync_run_items (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  sync_run_id      BIGINT       NOT NULL,
  entity           VARCHAR(64)  NOT NULL,
  started_at       DATETIME     NULL,
  completed_at     DATETIME     NULL,
  status           VARCHAR(20)  NULL,
  api_calls        INT          DEFAULT 0,
  records_fetched  INT          DEFAULT 0,
  records_upserted INT          DEFAULT 0,
  records_failed   INT          DEFAULT 0,
  error            TEXT         NULL,
  INDEX idx_qwh_item_run    (sync_run_id),
  INDEX idx_qwh_item_entity (entity),
  FOREIGN KEY (sync_run_id) REFERENCES qbo_wh_sync_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ════════════════════════════════════════════════════════════════════════════
--  SILVER — generic per-record store (full JSON + extracted common columns)
--  One row per (user_id, realm_id, entity, qbo_id). Captures every QBO entity.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS qbo_entities (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  realm_id        VARCHAR(64)  NOT NULL,
  entity          VARCHAR(64)  NOT NULL,
  qbo_id          VARCHAR(64)  NOT NULL,
  sync_token      VARCHAR(32)  NULL,
  display_name    VARCHAR(512) NULL,
  doc_number      VARCHAR(128) NULL,
  txn_date        DATE         NULL,
  total_amt       DECIMAL(20,2) NULL,
  balance         DECIMAL(20,2) NULL,
  currency        VARCHAR(10)  NULL,
  active          TINYINT      NULL,
  payload         JSON         NOT NULL,
  qbo_created_at  DATETIME     NULL,
  qbo_updated_at  DATETIME     NULL,
  sync_run_id     BIGINT       NULL,
  synced_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_qbo_entity (user_id, realm_id, entity, qbo_id),
  INDEX idx_qbo_ent_entity  (entity),
  INDEX idx_qbo_ent_user    (user_id, realm_id),
  INDEX idx_qbo_ent_txndate (txn_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
