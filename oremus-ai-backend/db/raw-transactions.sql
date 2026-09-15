-- ─────────────────────────────────────────────────────────────────────────────
-- Raw transaction JSON archive (Zoho + Xero)
-- Idempotent: safe to re-run.
--
-- Stores the UNMODIFIED JSON exactly as returned by the same provider APIs that
-- feed the shared `account_transactions` ledger table:
--   • Zoho  → GET /reports/accounttransaction   (Account Transactions report)
--   • Xero  → GET /ManualJournals  and  GET /Journals   (general ledger)
--
-- Grain mirrors account_transactions:
--   zoho_raw_transactions : one row per account-transaction record
--   xero_raw_transactions : one row per journal record (raw_json keeps its lines)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS zoho_raw_transactions (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id            INT           NOT NULL,
  org_id             VARCHAR(100)  NOT NULL,
  source_endpoint    VARCHAR(64)   NOT NULL DEFAULT 'reports/accounttransaction',
  transaction_id     VARCHAR(150)  NOT NULL,
  transaction_number VARCHAR(150)  NOT NULL DEFAULT '',   -- part of uq key ('' when none)
  account_id         VARCHAR(100)  NOT NULL,
  raw_json           JSON          NOT NULL,              -- verbatim Zoho record
  synced_at          TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_zoho_raw_txn (user_id, transaction_id, transaction_number, account_id),
  KEY idx_zoho_raw_user_org (user_id, org_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS xero_raw_transactions (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         INT           NOT NULL,
  tenant_id       VARCHAR(64)   NOT NULL,
  source_endpoint VARCHAR(32)   NOT NULL,                 -- 'ManualJournals' | 'Journals'
  transaction_id  VARCHAR(150)  NOT NULL,                 -- xero:<ManualJournalID> | xero:<JournalID>
  raw_json        JSON          NOT NULL,                 -- verbatim Xero journal (incl. JournalLines)
  synced_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_xero_raw_txn (user_id, source_endpoint, transaction_id),
  KEY idx_xero_raw_user_tenant (user_id, tenant_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
