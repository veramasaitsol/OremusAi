-- ─────────────────────────────────────────────────────────────────────────────
-- Oremus Analytics Data Warehouse (Phase 5) — star-schema Fact + Dimension tables.
--
-- ADDITIVE & PROVIDER-AGNOSTIC. Never touches existing tables. Every fact/dim row
-- is scoped by (user_id, provider, connection_ref) so the SAME warehouse serves
-- Zoho today and QuickBooks / Xero later (Phase 10). The ETL (analyticsWarehouseService)
-- populates these from the provider raw warehouse (zb_* for Zoho).
--
-- Idempotent: safe to re-run. All tables prefixed dim_* / fact_*.
-- ─────────────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════════════
--  DIMENSIONS
-- ════════════════════════════════════════════════════════════════════════════

-- DimDate — global (not per-user). Indian fiscal year (Apr–Mar).
CREATE TABLE IF NOT EXISTS dim_date (
  date_key        INT          NOT NULL PRIMARY KEY,   -- YYYYMMDD
  full_date       DATE         NOT NULL,
  day             TINYINT      NOT NULL,
  month           TINYINT      NOT NULL,
  month_name      VARCHAR(12)  NOT NULL,
  quarter         TINYINT      NOT NULL,
  year            SMALLINT     NOT NULL,
  fiscal_year     SMALLINT     NOT NULL,                -- FY start year (Apr Y .. Mar Y+1)
  fiscal_quarter  TINYINT      NOT NULL,
  day_of_week     TINYINT      NOT NULL,                -- 1=Mon .. 7=Sun
  day_name        VARCHAR(12)  NOT NULL,
  is_weekend      TINYINT(1)   NOT NULL DEFAULT 0,
  UNIQUE KEY uq_dim_date_full (full_date),
  INDEX idx_dim_date_year (year, month),
  INDEX idx_dim_date_fy (fiscal_year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_customer (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  source_id       VARCHAR(96)  NOT NULL,
  name            VARCHAR(512) NULL,
  email           VARCHAR(255) NULL,
  phone           VARCHAR(64)  NULL,
  status          VARCHAR(32)  NULL,
  currency_code   VARCHAR(8)   NULL,
  updated_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dim_customer (provider, connection_ref, source_id),
  INDEX idx_dim_customer_user (user_id, provider, connection_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_vendor (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  source_id       VARCHAR(96)  NOT NULL,
  name            VARCHAR(512) NULL,
  email           VARCHAR(255) NULL,
  phone           VARCHAR(64)  NULL,
  status          VARCHAR(32)  NULL,
  currency_code   VARCHAR(8)   NULL,
  updated_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dim_vendor (provider, connection_ref, source_id),
  INDEX idx_dim_vendor_user (user_id, provider, connection_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_account (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  source_id       VARCHAR(96)  NOT NULL,
  name            VARCHAR(512) NULL,
  account_type    VARCHAR(64)  NULL,
  classification  VARCHAR(32)  NULL,   -- Asset|Liability|Equity|Revenue|Expense
  parent_id       VARCHAR(96)  NULL,
  updated_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dim_account (provider, connection_ref, source_id),
  INDEX idx_dim_account_user (user_id, provider, connection_ref),
  INDEX idx_dim_account_class (classification)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_item (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  source_id       VARCHAR(96)  NOT NULL,
  name            VARCHAR(512) NULL,
  sku             VARCHAR(128) NULL,
  item_type       VARCHAR(64)  NULL,
  rate            DECIMAL(20,2) NULL,
  updated_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dim_item (provider, connection_ref, source_id),
  INDEX idx_dim_item_user (user_id, provider, connection_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dim_project (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  source_id       VARCHAR(96)  NOT NULL,
  name            VARCHAR(512) NULL,
  status          VARCHAR(32)  NULL,
  customer_id     VARCHAR(96)  NULL,
  updated_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dim_project (provider, connection_ref, source_id),
  INDEX idx_dim_project_user (user_id, provider, connection_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ════════════════════════════════════════════════════════════════════════════
--  FACTS  (rebuilt per connection by the ETL; keyed for fast slice/dice)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS fact_revenue (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  date_key        INT          NULL,
  txn_date        DATE         NULL,
  doc_type        VARCHAR(32)  NOT NULL,   -- invoice | credit_note
  doc_id          VARCHAR(96)  NOT NULL,
  doc_number      VARCHAR(128) NULL,
  customer_source_id VARCHAR(96) NULL,
  customer_name   VARCHAR(512) NULL,
  status          VARCHAR(32)  NULL,
  sub_total       DECIMAL(20,2) DEFAULT 0,
  tax_total       DECIMAL(20,2) DEFAULT 0,
  total           DECIMAL(20,2) DEFAULT 0,
  balance         DECIMAL(20,2) DEFAULT 0,
  currency_code   VARCHAR(8)   NULL,
  UNIQUE KEY uq_fact_revenue (provider, connection_ref, doc_type, doc_id),
  INDEX idx_fact_rev_scope (user_id, provider, connection_ref, txn_date),
  INDEX idx_fact_rev_date (date_key),
  INDEX idx_fact_rev_cust (customer_source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fact_expense (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  date_key        INT          NULL,
  txn_date        DATE         NULL,
  doc_type        VARCHAR(32)  NOT NULL,   -- bill | expense
  doc_id          VARCHAR(96)  NOT NULL,
  doc_number      VARCHAR(128) NULL,
  vendor_source_id VARCHAR(96) NULL,
  vendor_name     VARCHAR(512) NULL,
  category        VARCHAR(255) NULL,
  account_source_id VARCHAR(96) NULL,
  status          VARCHAR(32)  NULL,
  sub_total       DECIMAL(20,2) DEFAULT 0,
  tax_total       DECIMAL(20,2) DEFAULT 0,
  total           DECIMAL(20,2) DEFAULT 0,
  balance         DECIMAL(20,2) DEFAULT 0,
  currency_code   VARCHAR(8)   NULL,
  UNIQUE KEY uq_fact_expense (provider, connection_ref, doc_type, doc_id),
  INDEX idx_fact_exp_scope (user_id, provider, connection_ref, txn_date),
  INDEX idx_fact_exp_date (date_key),
  INDEX idx_fact_exp_vendor (vendor_source_id),
  INDEX idx_fact_exp_cat (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fact_cashflow (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  date_key        INT          NULL,
  txn_date        DATE         NULL,
  source_id       VARCHAR(96)  NOT NULL,
  account_source_id VARCHAR(96) NULL,
  account_name    VARCHAR(255) NULL,
  txn_type        VARCHAR(64)  NULL,
  direction       VARCHAR(8)   NOT NULL,   -- inflow | outflow
  amount          DECIMAL(20,2) DEFAULT 0,
  currency_code   VARCHAR(8)   NULL,
  UNIQUE KEY uq_fact_cashflow (provider, connection_ref, source_id),
  INDEX idx_fact_cf_scope (user_id, provider, connection_ref, txn_date),
  INDEX idx_fact_cf_date (date_key),
  INDEX idx_fact_cf_dir (direction)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fact_receivable (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  date_key        INT          NULL,
  txn_date        DATE         NULL,
  due_date        DATE         NULL,
  doc_id          VARCHAR(96)  NOT NULL,
  doc_number      VARCHAR(128) NULL,
  customer_source_id VARCHAR(96) NULL,
  customer_name   VARCHAR(512) NULL,
  status          VARCHAR(32)  NULL,
  total           DECIMAL(20,2) DEFAULT 0,
  balance         DECIMAL(20,2) DEFAULT 0,
  days_overdue    INT          DEFAULT 0,
  aging_bucket    VARCHAR(16)  NULL,       -- current | 1-30 | 31-60 | 61-90 | 90+
  currency_code   VARCHAR(8)   NULL,
  UNIQUE KEY uq_fact_receivable (provider, connection_ref, doc_id),
  INDEX idx_fact_ar_scope (user_id, provider, connection_ref),
  INDEX idx_fact_ar_bucket (aging_bucket),
  INDEX idx_fact_ar_cust (customer_source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fact_payable (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  date_key        INT          NULL,
  txn_date        DATE         NULL,
  due_date        DATE         NULL,
  doc_id          VARCHAR(96)  NOT NULL,
  doc_number      VARCHAR(128) NULL,
  vendor_source_id VARCHAR(96) NULL,
  vendor_name     VARCHAR(512) NULL,
  status          VARCHAR(32)  NULL,
  total           DECIMAL(20,2) DEFAULT 0,
  balance         DECIMAL(20,2) DEFAULT 0,
  days_overdue    INT          DEFAULT 0,
  aging_bucket    VARCHAR(16)  NULL,
  currency_code   VARCHAR(8)   NULL,
  UNIQUE KEY uq_fact_payable (provider, connection_ref, doc_id),
  INDEX idx_fact_ap_scope (user_id, provider, connection_ref),
  INDEX idx_fact_ap_bucket (aging_bucket),
  INDEX idx_fact_ap_vendor (vendor_source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fact_tax (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  date_key        INT          NULL,
  txn_date        DATE         NULL,
  doc_type        VARCHAR(32)  NOT NULL,   -- invoice | bill
  doc_id          VARCHAR(96)  NOT NULL,
  direction       VARCHAR(8)   NOT NULL,   -- output (collected) | input (paid)
  taxable_amount  DECIMAL(20,2) DEFAULT 0,
  tax_amount      DECIMAL(20,2) DEFAULT 0,
  currency_code   VARCHAR(8)   NULL,
  UNIQUE KEY uq_fact_tax (provider, connection_ref, doc_type, doc_id),
  INDEX idx_fact_tax_scope (user_id, provider, connection_ref, txn_date),
  INDEX idx_fact_tax_dir (direction)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ETL run tracking
CREATE TABLE IF NOT EXISTS analytics_etl_runs (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT          NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  connection_ref  VARCHAR(64)  NOT NULL,
  started_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  completed_at    TIMESTAMP    NULL,
  status          VARCHAR(16)  DEFAULT 'running',  -- running|succeeded|failed
  rows_written    INT          DEFAULT 0,
  detail          JSON         NULL,
  INDEX idx_etl_scope (user_id, provider, connection_ref),
  INDEX idx_etl_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
