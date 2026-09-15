-- ─────────────────────────────────────────────────────────────────────────────
-- DROP the dead QuickBooks normalized tables (qb_*).
-- These were populated by the removed services/quickbooksNormalizeService.js but
-- are READ BY NOTHING. The live QB stack uses qbo_entities + qbo_wh_* + qbo_accounts
-- (NOT touched here). Idempotent: DROP TABLE IF EXISTS.
--
-- CRITICAL GUARD: only `qb_*` (no `o`). NEVER touch `qbo_*` — those are in use.
-- Run: node db/apply-sql.js db/drop-qb-normalized-tables.sql
-- ─────────────────────────────────────────────────────────────────────────────

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS qb_companies;
DROP TABLE IF EXISTS qb_accounts;
DROP TABLE IF EXISTS qb_customers;
DROP TABLE IF EXISTS qb_vendors;
DROP TABLE IF EXISTS qb_employees;
DROP TABLE IF EXISTS qb_items;
DROP TABLE IF EXISTS qb_classes;
DROP TABLE IF EXISTS qb_departments;
DROP TABLE IF EXISTS qb_payment_methods;
DROP TABLE IF EXISTS qb_terms;
DROP TABLE IF EXISTS qb_tax_codes;
DROP TABLE IF EXISTS qb_tax_rates;
DROP TABLE IF EXISTS qb_invoices;
DROP TABLE IF EXISTS qb_invoice_lines;
DROP TABLE IF EXISTS qb_estimates;
DROP TABLE IF EXISTS qb_sales_receipts;
DROP TABLE IF EXISTS qb_credit_memos;
DROP TABLE IF EXISTS qb_refund_receipts;
DROP TABLE IF EXISTS qb_payments;
DROP TABLE IF EXISTS qb_bills;
DROP TABLE IF EXISTS qb_bill_lines;
DROP TABLE IF EXISTS qb_purchase_orders;
DROP TABLE IF EXISTS qb_vendor_credits;
DROP TABLE IF EXISTS qb_bill_payments;
DROP TABLE IF EXISTS qb_expenses;
DROP TABLE IF EXISTS qb_checks;
DROP TABLE IF EXISTS qb_bank_accounts;
DROP TABLE IF EXISTS qb_deposits;
DROP TABLE IF EXISTS qb_transfers;
DROP TABLE IF EXISTS qb_journal_entries;
DROP TABLE IF EXISTS qb_journal_lines;
DROP TABLE IF EXISTS qb_inventory_items;
DROP TABLE IF EXISTS qb_projects;
DROP TABLE IF EXISTS qb_time_activities;
DROP TABLE IF EXISTS qb_sync_logs;

SET FOREIGN_KEY_CHECKS = 1;
