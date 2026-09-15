-- Notifications (one row per user notification). Idempotent.
-- Apply: node db/apply-sql.js db/notifications-migration.sql
-- Generated notifications (overdue invoices, bills due, welcome) carry a
-- dedupe_key so re-running the generator never creates duplicates. Ad-hoc
-- notifications leave dedupe_key NULL (MySQL treats NULLs as distinct in a
-- UNIQUE index, so they always insert).
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGINT       AUTO_INCREMENT PRIMARY KEY,
  user_id     INT          NOT NULL,
  type        VARCHAR(40)  NOT NULL DEFAULT 'info',   -- info|success|warning|error|finance|sync|system
  title       VARCHAR(255) NOT NULL,
  body        TEXT         NULL,
  link        VARCHAR(255) NULL,
  dedupe_key  VARCHAR(191) NULL,
  meta        JSON         NULL,
  read_at     DATETIME     NULL,
  created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notif_user   (user_id, created_at),
  INDEX idx_notif_unread (user_id, read_at),
  UNIQUE KEY uq_notif_dedupe (user_id, dedupe_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
