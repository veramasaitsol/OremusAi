-- ─────────────────────────────────────────────────────────────────────────────
-- Oremus Accounting Engine — A3: report snapshots (acc_report_snapshots).
-- Idempotent: safe to re-run. ADDITIVE.
--
-- THE RECONCILIATION ORACLE. This is the safety net of the hybrid cutover: it
-- stores each PROVIDER'S OWN report totals (pulled from their Reports API — the
-- numbers we already match to the cent). A nightly job computes the same figure
-- from acc_journal_lines and diffs it against the snapshot. Any non-zero delta =
-- an incomplete/incorrect GL sync to investigate. We only flip a provider's
-- user-facing reports to GL-derived once this delta is ~0.
--
-- This is NOT acc_report_cache. acc_report_cache caches a transformed report BODY
-- for fast serving (TTL). acc_report_snapshots stores the authoritative per-account
-- (or per-total) NUMBER from the provider, for diffing against our GL.
--
--   report_name : 'trial_balance' | 'profit_and_loss' | 'balance_sheet' | 'cash_flow'
--   basis       : 'accrual' | 'cash'
--   period_*    : the report window
--   account_ref : provider account id, OR NULL for a report-level grand total
--   metric      : which figure ('net' | 'debit' | 'credit' | 'balance' | 'total' …)
--   provider_value : the value Zoho/QBO/Xero reported (source of truth for the diff)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS acc_report_snapshots (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  report_name     VARCHAR(48)  NOT NULL,
  basis           VARCHAR(12)  NOT NULL DEFAULT 'accrual',
  period_start    DATE         NOT NULL,
  period_end      DATE         NOT NULL,
  account_ref     VARCHAR(64)  NULL,        -- NULL = report-level grand total
  account_name    VARCHAR(512) NULL,
  metric          VARCHAR(24)  NOT NULL DEFAULT 'net',
  provider_value  DECIMAL(20,2) NOT NULL DEFAULT 0,
  currency        VARCHAR(10)  NULL,
  captured_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_acc_snapshot (provider, connection_ref, report_name, basis, period_start, period_end, account_ref, metric),
  INDEX idx_acc_snap_user (user_id),
  INDEX idx_acc_snap_lookup (provider, connection_ref, report_name, basis, period_start, period_end),
  INDEX idx_acc_snap_account (account_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-account reconciliation results (GL value vs provider_value, the delta).
-- Lets us track which accounts are reconciled (delta within tolerance) so we can
-- gate the per-provider cutover on it.
CREATE TABLE IF NOT EXISTS acc_reconciliations (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  report_name     VARCHAR(48)  NOT NULL,
  basis           VARCHAR(12)  NOT NULL DEFAULT 'accrual',
  period_start    DATE         NOT NULL,
  period_end      DATE         NOT NULL,
  account_ref     VARCHAR(64)  NULL,
  account_name    VARCHAR(512) NULL,
  metric          VARCHAR(24)  NOT NULL DEFAULT 'net',
  gl_value        DECIMAL(20,2) NOT NULL DEFAULT 0,
  provider_value  DECIMAL(20,2) NOT NULL DEFAULT 0,
  delta           DECIMAL(20,2) NOT NULL DEFAULT 0,   -- gl_value − provider_value
  within_tolerance TINYINT(1)  NOT NULL DEFAULT 0,
  reconciled_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_acc_recon (provider, connection_ref, report_name, basis, period_start, period_end, account_ref, metric),
  INDEX idx_acc_recon_user (user_id),
  INDEX idx_acc_recon_lookup (provider, connection_ref, report_name, basis, period_start, period_end),
  INDEX idx_acc_recon_delta (within_tolerance)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
