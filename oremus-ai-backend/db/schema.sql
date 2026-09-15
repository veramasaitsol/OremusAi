-- Oremus DB Schema
-- Local:  mysql -u root -p oremus_db < db/schema.sql
-- cPanel: mysql -u cpuser_dbuser -p cpuser_oremus_db < db/schema.sql
-- NOTE: Do NOT add USE <dbname> here — cPanel requires you select the DB
--       before importing, and the DB name has a cPanel username prefix.

-- ── Users ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  name             VARCHAR(255) NOT NULL,
  email            VARCHAR(255) NOT NULL UNIQUE,
  password         VARCHAR(255) NOT NULL,
  role             ENUM('admin','client') NOT NULL DEFAULT 'client',
  client_id        VARCHAR(100) NULL,
  mobile           VARCHAR(20)  NULL,
  company          VARCHAR(255) NULL,
  integration_type VARCHAR(20)  NOT NULL DEFAULT 'none',
  permissions      JSON         NULL,
  status           VARCHAR(20)  NOT NULL DEFAULT 'Active',
  created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ── Zoho OAuth tokens (one row per user) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS zb_tokens (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT          NOT NULL UNIQUE,
  access_token  TEXT         NOT NULL,
  refresh_token TEXT         NULL,
  expires_at    BIGINT       NULL,
  org_id        VARCHAR(100) NULL,
  connected_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Zoho Organization info ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zb_oauth_organizations (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  user_id             INT          NOT NULL,
  org_id              VARCHAR(100) NOT NULL,
  org_name            VARCHAR(255) NULL,
  currency            VARCHAR(10)  NULL,
  fiscal_year_start   VARCHAR(20)  NULL,
  time_zone           VARCHAR(100) NULL,
  created_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_org (user_id, org_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Customers (synced from Zoho Books contacts, type=customer) ────────────────
CREATE TABLE IF NOT EXISTS customers (
  id                              INT AUTO_INCREMENT PRIMARY KEY,
  user_id                         INT           NOT NULL,
  org_id                          VARCHAR(100)  NOT NULL,
  zoho_id                 VARCHAR(100)  NOT NULL,
  contact_name                    VARCHAR(255)  NULL,
  company_name                    VARCHAR(255)  NULL,
  email                           VARCHAR(255)  NULL,
  phone                           VARCHAR(50)   NULL,
  outstanding_receivable_amount   DECIMAL(15,2) DEFAULT 0,
  status                          VARCHAR(50)   DEFAULT 'active',
  synced_at                       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_customer (user_id, zoho_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Vendors (synced from Zoho Books contacts, type=vendor) ────────────────────
CREATE TABLE IF NOT EXISTS vendors (
  id                            INT AUTO_INCREMENT PRIMARY KEY,
  user_id                       INT           NOT NULL,
  org_id                        VARCHAR(100)  NOT NULL,
  zoho_id               VARCHAR(100)  NOT NULL,
  contact_name                  VARCHAR(255)  NULL,
  company_name                  VARCHAR(255)  NULL,
  email                         VARCHAR(255)  NULL,
  phone                         VARCHAR(50)   NULL,
  outstanding_payable_amount    DECIMAL(15,2) DEFAULT 0,
  status                        VARCHAR(50)   DEFAULT 'active',
  synced_at                     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vendor (user_id, zoho_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Invoices (AR) ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  user_id          INT           NOT NULL,
  org_id           VARCHAR(100)  NOT NULL,
  zoho_id  VARCHAR(100)  NOT NULL,
  invoice_number   VARCHAR(100)  NULL,
  customer_name    VARCHAR(255)  NULL,
  date             DATE          NULL,
  due_date         DATE          NULL,
  total            DECIMAL(15,2) DEFAULT 0,
  balance          DECIMAL(15,2) DEFAULT 0,
  status           VARCHAR(50)   NULL,
  synced_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_invoice (user_id, zoho_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Bills (AP) ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bills (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  user_id        INT           NOT NULL,
  org_id         VARCHAR(100)  NOT NULL,
  zoho_id   VARCHAR(100)  NOT NULL,
  bill_number    VARCHAR(100)  NULL,
  vendor_name    VARCHAR(255)  NULL,
  date           DATE          NULL,
  due_date       DATE          NULL,
  total          DECIMAL(15,2) DEFAULT 0,
  balance        DECIMAL(15,2) DEFAULT 0,
  status         VARCHAR(50)   NULL,
  synced_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bill (user_id, zoho_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Day Book / Journal Transactions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daybook_transactions (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  user_id          INT           NOT NULL,
  org_id           VARCHAR(100)  NOT NULL,
  transaction_id   VARCHAR(100)  NOT NULL,
  transaction_date DATE          NULL,
  transaction_type VARCHAR(100)  NULL,
  reference_number VARCHAR(100)  NULL,
  description      TEXT          NULL,
  debit            DECIMAL(15,2) DEFAULT 0,
  credit           DECIMAL(15,2) DEFAULT 0,
  account_name     VARCHAR(255)  NULL,
  entity_name      VARCHAR(255)  NULL,
  synced_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_txn (user_id, transaction_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Expense entries ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expense_entries (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  user_id          INT           NOT NULL,
  org_id           VARCHAR(100)  NOT NULL,
  zoho_id  VARCHAR(100)  NOT NULL,
  account_name     VARCHAR(255)  NULL,
  expense_date     DATE          NULL,
  amount           DECIMAL(15,2) DEFAULT 0,
  vendor_name      VARCHAR(255)  NULL,
  description      TEXT          NULL,
  status           VARCHAR(50)   NULL,
  synced_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_expense (user_id, zoho_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Account Transactions (from Zoho Books Account Transactions report) ─────────
-- One row per account-line within a transaction.
-- The same transaction_id can appear on multiple rows (once per account touched).
-- A single transaction_id can also span multiple sub-vouchers (e.g. a customer
-- payment + the invoice it settles) that touch the SAME account, so the unique
-- key includes transaction_number to keep each voucher's line distinct —
-- otherwise two same-account lines collide and one is silently overwritten.
-- Unique key: (user_id, transaction_id, transaction_number, account_id).
CREATE TABLE IF NOT EXISTS account_transactions (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  user_id             INT           NOT NULL,
  org_id              VARCHAR(100)  NOT NULL,
  transaction_id      VARCHAR(150)  NOT NULL,   -- Zoho transaction ID
  account_id          VARCHAR(100)  NOT NULL,   -- Zoho account ID
  transaction_date    DATE          NULL,
  account_name        VARCHAR(255)  NULL,
  transaction_details TEXT          NULL,       -- vendor / description lines
  transaction_type    VARCHAR(100)  NULL,       -- Bill, Expense, Invoice, Journal…
  transaction_number  VARCHAR(150)  NOT NULL DEFAULT '', -- e.g. IND-2022-04385-SGHI-04 (part of uq key; '' when none)
  reference_number    VARCHAR(150)  NULL,
  debit               DECIMAL(15,2) DEFAULT 0,
  credit              DECIMAL(15,2) DEFAULT 0,
  balance             DECIMAL(15,2) DEFAULT 0,
  balance_type        VARCHAR(5)    NULL,       -- 'C' or 'D'
  synced_at           TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_acct_txn (user_id, transaction_id, transaction_number, account_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Bank Transactions (from Zoho Books /banktransactions) ────────────────────
CREATE TABLE IF NOT EXISTS bank_transactions (
  id                        INT AUTO_INCREMENT PRIMARY KEY,
  user_id                   INT           NOT NULL,
  org_id                    VARCHAR(100)  NOT NULL,
  transaction_id            VARCHAR(100)  NOT NULL,   -- Zoho unique ID
  transaction_date          DATE          NULL,
  amount                    DECIMAL(15,2) DEFAULT 0,
  transaction_type          VARCHAR(100)  NULL,       -- vendor_payment, deposit, …
  transaction_type_formatted VARCHAR(100) NULL,       -- "Vendor Payment", "Deposit", …
  status                    VARCHAR(50)   NULL,       -- manually_added, categorized, …
  source                    VARCHAR(50)   NULL,       -- manually_added, imported, …
  account_id                VARCHAR(100)  NULL,
  account_name              VARCHAR(255)  NULL,
  account_type              VARCHAR(50)   NULL,       -- bank, cash, credit_card, …
  customer_id               VARCHAR(100)  NULL,
  payee                     VARCHAR(255)  NULL,
  description               TEXT          NULL,
  currency_code             VARCHAR(10)   NULL,
  debit_or_credit           VARCHAR(10)   NULL,       -- 'debit' or 'credit'
  offset_account_name       VARCHAR(255)  NULL,
  reference_number          VARCHAR(150)  NULL,
  reconcile_status          VARCHAR(50)   NULL,
  imported_transaction_id   VARCHAR(100)  NULL,
  running_balance           DECIMAL(15,2) DEFAULT 0,
  synced_at                 TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bank_txn (user_id, transaction_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Seed users (password stored as plain for dev; swap for bcrypt hash in prod)
INSERT IGNORE INTO users (name, email, password, role, client_id) VALUES
  ('Admin User',        'admin@oremus.com',           '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhy2', 'admin',  NULL),
  ('Maya Chen',         'maya@oremus.com',             '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhy2', 'admin',  NULL),
  ('Acme Logistics',    'finance@acmelogistics.in',    '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhy2', 'client', 'c-acme'),
  ('Northbeam Studios', 'ops@northbeam.studio',        '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhy2', 'client', 'c-northbeam');
-- Note: above hash = bcrypt('admin123') rounds=10.
-- Run db/seed.js to insert with correct per-user passwords.

-- ── Upgrade existing databases (safe to re-run — ADD COLUMN IF NOT EXISTS) ────
ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile           VARCHAR(20)  NULL           AFTER client_id;
ALTER TABLE users ADD COLUMN IF NOT EXISTS company          VARCHAR(255) NULL           AFTER mobile;
ALTER TABLE users ADD COLUMN IF NOT EXISTS integration_type VARCHAR(20)  DEFAULT 'none' AFTER company;
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions      JSON         NULL           AFTER integration_type;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status           VARCHAR(20)  DEFAULT 'Active' AFTER permissions;

-- ── Create account_transactions table if upgrading an existing database ────────
CREATE TABLE IF NOT EXISTS account_transactions (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  user_id             INT           NOT NULL,
  org_id              VARCHAR(100)  NOT NULL,
  transaction_id      VARCHAR(150)  NOT NULL,
  account_id          VARCHAR(100)  NOT NULL,
  transaction_date    DATE          NULL,
  account_name        VARCHAR(255)  NULL,
  transaction_details TEXT          NULL,
  transaction_type    VARCHAR(100)  NULL,
  transaction_number  VARCHAR(150)  NOT NULL DEFAULT '',
  reference_number    VARCHAR(150)  NULL,
  debit               DECIMAL(15,2) DEFAULT 0,
  credit              DECIMAL(15,2) DEFAULT 0,
  balance             DECIMAL(15,2) DEFAULT 0,
  balance_type        VARCHAR(5)    NULL,
  synced_at           TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_acct_txn (user_id, transaction_id, transaction_number, account_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Create bank_transactions table if upgrading an existing database ──────────
CREATE TABLE IF NOT EXISTS bank_transactions (
  id                         INT AUTO_INCREMENT PRIMARY KEY,
  user_id                    INT           NOT NULL,
  org_id                     VARCHAR(100)  NOT NULL,
  transaction_id             VARCHAR(100)  NOT NULL,
  transaction_date           DATE          NULL,
  amount                     DECIMAL(15,2) DEFAULT 0,
  transaction_type           VARCHAR(100)  NULL,
  transaction_type_formatted VARCHAR(100)  NULL,
  status                     VARCHAR(50)   NULL,
  source                     VARCHAR(50)   NULL,
  account_id                 VARCHAR(100)  NULL,
  account_name               VARCHAR(255)  NULL,
  account_type               VARCHAR(50)   NULL,
  customer_id                VARCHAR(100)  NULL,
  payee                      VARCHAR(255)  NULL,
  description                TEXT          NULL,
  currency_code              VARCHAR(10)   NULL,
  debit_or_credit            VARCHAR(10)   NULL,
  offset_account_name        VARCHAR(255)  NULL,
  reference_number           VARCHAR(150)  NULL,
  reconcile_status           VARCHAR(50)   NULL,
  imported_transaction_id    VARCHAR(100)  NULL,
  running_balance            DECIMAL(15,2) DEFAULT 0,
  synced_at                  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bank_txn (user_id, transaction_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── Add account_group / account_type_code to account_transactions if missing ──
ALTER TABLE account_transactions ADD COLUMN IF NOT EXISTS account_group     VARCHAR(50)  NULL AFTER account_name;
ALTER TABLE account_transactions ADD COLUMN IF NOT EXISTS account_type_code VARCHAR(100) NULL AFTER account_group;

-- ═══════════════════════════════════════════════════════════════════════════════
-- QuickBooks Online integration (parallel to Zoho)
-- For idempotent migration on existing DBs, see db/quickbooks-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS qbo_tokens (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL UNIQUE,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    BIGINT,
  realm_id      VARCHAR(64),
  environment   VARCHAR(20) DEFAULT 'sandbox',
  connected_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS qbo_organizations (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  user_id           INT NOT NULL,
  realm_id          VARCHAR(64) NOT NULL,
  company_name      VARCHAR(255),
  legal_name        VARCHAR(255),
  country           VARCHAR(10),
  currency          VARCHAR(10),
  fiscal_year_start VARCHAR(20),
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_user_realm (user_id, realm_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- qbo_id columns on data tables (allow QBO rows to coexist with Zoho rows).
ALTER TABLE customers            ADD COLUMN IF NOT EXISTS qbo_id VARCHAR(64) NULL, ADD INDEX IF NOT EXISTS idx_qbo_id (qbo_id);
ALTER TABLE vendors              ADD COLUMN IF NOT EXISTS qbo_id VARCHAR(64) NULL, ADD INDEX IF NOT EXISTS idx_qbo_id (qbo_id);
ALTER TABLE invoices             ADD COLUMN IF NOT EXISTS qbo_id VARCHAR(64) NULL, ADD INDEX IF NOT EXISTS idx_qbo_id (qbo_id);
ALTER TABLE bills                ADD COLUMN IF NOT EXISTS qbo_id VARCHAR(64) NULL, ADD INDEX IF NOT EXISTS idx_qbo_id (qbo_id);
ALTER TABLE expense_entries      ADD COLUMN IF NOT EXISTS qbo_id VARCHAR(64) NULL, ADD INDEX IF NOT EXISTS idx_qbo_id (qbo_id);
ALTER TABLE daybook_transactions ADD COLUMN IF NOT EXISTS qbo_id VARCHAR(64) NULL, ADD INDEX IF NOT EXISTS idx_qbo_id (qbo_id);
ALTER TABLE account_transactions ADD COLUMN IF NOT EXISTS qbo_id VARCHAR(64) NULL, ADD INDEX IF NOT EXISTS idx_qbo_id (qbo_id);
ALTER TABLE bank_transactions    ADD COLUMN IF NOT EXISTS qbo_id VARCHAR(64) NULL, ADD INDEX IF NOT EXISTS idx_qbo_id (qbo_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Xero integration (parallel to Zoho + QuickBooks)
-- For idempotent migration on existing DBs, see db/xero-migration.sql
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS xero_tokens (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL UNIQUE,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    BIGINT,
  tenant_id     VARCHAR(64),
  tenant_name   VARCHAR(255),
  connected_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS xero_organizations (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  user_id               INT NOT NULL,
  tenant_id             VARCHAR(64) NOT NULL,
  name                  VARCHAR(255),
  legal_name            VARCHAR(255),
  short_code            VARCHAR(64),
  country               VARCHAR(10),
  currency              VARCHAR(10),
  fiscal_year_end_month VARCHAR(20),
  organisation_type     VARCHAR(64),
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_user_tenant (user_id, tenant_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS xero_accounts (
  id                          INT AUTO_INCREMENT PRIMARY KEY,
  user_id                     INT NOT NULL,
  tenant_id                   VARCHAR(64) NOT NULL,
  xero_id                     VARCHAR(64) NOT NULL,
  code                        VARCHAR(64) NULL,
  name                        VARCHAR(255) NULL,
  type                        VARCHAR(64) NULL,
  tax_type                    VARCHAR(64) NULL,
  class                       VARCHAR(32) NULL,
  description                 TEXT NULL,
  enable_payments_to_account  TINYINT(1) DEFAULT 0,
  show_in_expense_claims      TINYINT(1) DEFAULT 0,
  status                      VARCHAR(20) NULL,
  bank_account_number         VARCHAR(64) NULL,
  bank_account_type           VARCHAR(64) NULL,
  currency_code               VARCHAR(10) NULL,
  reporting_code              VARCHAR(64) NULL,
  reporting_code_name         VARCHAR(255) NULL,
  has_attachments             TINYINT(1) DEFAULT 0,
  balance                     DECIMAL(18,2) DEFAULT 0,
  updated_date_utc            DATETIME NULL,
  synced_at                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_xero_account (user_id, xero_id),
  INDEX idx_tenant_id (tenant_id),
  INDEX idx_type (type),
  INDEX idx_class (class),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

ALTER TABLE customers            ADD COLUMN IF NOT EXISTS xero_id VARCHAR(64) NULL, ADD INDEX IF NOT EXISTS idx_xero_id (xero_id);
ALTER TABLE vendors              ADD COLUMN IF NOT EXISTS xero_id VARCHAR(64) NULL, ADD INDEX IF NOT EXISTS idx_xero_id (xero_id);
ALTER TABLE invoices             ADD COLUMN IF NOT EXISTS xero_id VARCHAR(64) NULL, ADD INDEX IF NOT EXISTS idx_xero_id (xero_id);
ALTER TABLE bills                ADD COLUMN IF NOT EXISTS xero_id VARCHAR(64) NULL, ADD INDEX IF NOT EXISTS idx_xero_id (xero_id);
ALTER TABLE expense_entries      ADD COLUMN IF NOT EXISTS xero_id VARCHAR(64) NULL, ADD INDEX IF NOT EXISTS idx_xero_id (xero_id);
ALTER TABLE daybook_transactions ADD COLUMN IF NOT EXISTS xero_id VARCHAR(64) NULL, ADD INDEX IF NOT EXISTS idx_xero_id (xero_id);
ALTER TABLE account_transactions ADD COLUMN IF NOT EXISTS xero_id VARCHAR(64) NULL, ADD INDEX IF NOT EXISTS idx_xero_id (xero_id);
ALTER TABLE bank_transactions    ADD COLUMN IF NOT EXISTS xero_id VARCHAR(64) NULL, ADD INDEX IF NOT EXISTS idx_xero_id (xero_id);

-- ── QuickBooks Chart of Accounts ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qbo_accounts (
  id                                  INT AUTO_INCREMENT PRIMARY KEY,
  user_id                             INT          NOT NULL,
  realm_id                            VARCHAR(64)  NOT NULL,
  qbo_id                              VARCHAR(64)  NOT NULL,
  name                                VARCHAR(255) NULL,
  fully_qualified_name                VARCHAR(255) NULL,
  account_type                        VARCHAR(64)  NULL,
  account_sub_type                    VARCHAR(64)  NULL,
  classification                      VARCHAR(32)  NULL,
  account_number                      VARCHAR(64)  NULL,
  description                         TEXT         NULL,
  current_balance                     DECIMAL(18,2) DEFAULT 0,
  current_balance_with_sub_accounts   DECIMAL(18,2) DEFAULT 0,
  currency                            VARCHAR(10)  NULL,
  parent_qbo_id                       VARCHAR(64)  NULL,
  is_sub_account                      TINYINT(1)   DEFAULT 0,
  active                              TINYINT(1)   DEFAULT 1,
  qbo_created_at                      DATETIME     NULL,
  qbo_updated_at                      DATETIME     NULL,
  synced_at                           TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_qbo_account (user_id, qbo_id),
  INDEX idx_realm_id (realm_id),
  INDEX idx_account_type (account_type),
  INDEX idx_classification (classification),
  INDEX idx_parent_qbo_id (parent_qbo_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Zoho Books Warehouse (Phases 0-5) — see db/zb-warehouse.sql for idempotent migration
-- For fresh installs we include the warehouse DDL by reference; apply zb-warehouse.sql after schema.sql
-- ═══════════════════════════════════════════════════════════════════════════════
-- (Run: mysql -u root oremus_db < db/zb-warehouse.sql)

-- ═══════════════════════════════════════════════════════════════════════════════
-- Zoho Books Reports cache (Phase 6) — apply db/zb-reports-cache.sql after schema.sql
-- ═══════════════════════════════════════════════════════════════════════════════
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
