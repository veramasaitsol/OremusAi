-- ============================================================================
-- clean-keep-users.sql
-- Empties ALL application data EXCEPT the `users` table.
-- TRUNCATE resets auto-increment counters; FK checks are disabled so tables
-- that are referenced by foreign keys can be truncated in any order.
--
-- WARNING: This permanently deletes data in 88 tables. It does NOT touch `users`.
-- Run only against the database you intend to wipe. Take a backup first:
--   mysqldump -u <user> -p <db> > backup_before_clean.sql
-- ============================================================================

SET FOREIGN_KEY_CHECKS = 0;

TRUNCATE TABLE acc_accounts;
TRUNCATE TABLE acc_audit_log;
TRUNCATE TABLE acc_connections;
TRUNCATE TABLE acc_document_lines;
TRUNCATE TABLE acc_documents;
TRUNCATE TABLE acc_journal;
TRUNCATE TABLE acc_journal_lines;
TRUNCATE TABLE acc_reconciliations;
TRUNCATE TABLE acc_report_cache;
TRUNCATE TABLE acc_report_snapshots;
TRUNCATE TABLE account_transactions;
TRUNCATE TABLE analytics_etl_runs;
TRUNCATE TABLE bank_transactions;
TRUNCATE TABLE bills;
TRUNCATE TABLE customers;
TRUNCATE TABLE daybook_transactions;
TRUNCATE TABLE dim_account;
TRUNCATE TABLE dim_customer;
TRUNCATE TABLE dim_date;
TRUNCATE TABLE dim_item;
TRUNCATE TABLE dim_project;
TRUNCATE TABLE dim_vendor;
TRUNCATE TABLE expense_entries;
TRUNCATE TABLE fact_cashflow;
TRUNCATE TABLE fact_expense;
TRUNCATE TABLE fact_payable;
TRUNCATE TABLE fact_receivable;
TRUNCATE TABLE fact_revenue;
TRUNCATE TABLE fact_tax;
TRUNCATE TABLE invoices;
TRUNCATE TABLE password_resets;
TRUNCATE TABLE qbo_accounts;
TRUNCATE TABLE qbo_entities;
TRUNCATE TABLE qbo_organizations;
TRUNCATE TABLE qbo_tokens;
TRUNCATE TABLE qbo_wh_raw_payloads;
TRUNCATE TABLE qbo_wh_sync_run_items;
TRUNCATE TABLE qbo_wh_sync_runs;
TRUNCATE TABLE vendors;
TRUNCATE TABLE xero_accounts;
TRUNCATE TABLE xero_organizations;
TRUNCATE TABLE xero_tokens;
TRUNCATE TABLE zb_activity_logs;
TRUNCATE TABLE zb_bank_accounts;
TRUNCATE TABLE zb_bill_line_items;
TRUNCATE TABLE zb_chart_of_accounts;
TRUNCATE TABLE zb_contact_addresses;
TRUNCATE TABLE zb_contact_persons;
TRUNCATE TABLE zb_credit_note_invoices;
TRUNCATE TABLE zb_credit_notes;
TRUNCATE TABLE zb_currencies;
TRUNCATE TABLE zb_customer_payment_invoices;
TRUNCATE TABLE zb_customer_payments;
TRUNCATE TABLE zb_estimates;
TRUNCATE TABLE zb_expense_line_items;
TRUNCATE TABLE zb_invoice_line_items;
TRUNCATE TABLE zb_items;
TRUNCATE TABLE zb_journal_line_items;
TRUNCATE TABLE zb_journals;
TRUNCATE TABLE zb_organizations;
TRUNCATE TABLE zb_projects;
TRUNCATE TABLE zb_purchase_orders;
TRUNCATE TABLE zb_raw_payloads;
TRUNCATE TABLE zb_recurring_bills;
TRUNCATE TABLE zb_recurring_expenses;
TRUNCATE TABLE zb_recurring_invoices;
TRUNCATE TABLE zb_report_cache;
TRUNCATE TABLE zb_sales_orders;
TRUNCATE TABLE zb_sync_run_items;
TRUNCATE TABLE zb_sync_runs;
TRUNCATE TABLE zb_sync_watermarks;
TRUNCATE TABLE zb_tasks;
TRUNCATE TABLE zb_tax_authorities;
TRUNCATE TABLE zb_tax_exemptions;
TRUNCATE TABLE zb_tax_group_taxes;
TRUNCATE TABLE zb_tax_rates;
TRUNCATE TABLE zb_time_entries;
TRUNCATE TABLE zb_vendor_credits;
TRUNCATE TABLE zb_vendor_payment_bills;
TRUNCATE TABLE zb_vendor_payments;
TRUNCATE TABLE zb_webhook_logs;
TRUNCATE TABLE zb_oauth_organizations;
TRUNCATE TABLE zb_tokens;

SET FOREIGN_KEY_CHECKS = 1;
