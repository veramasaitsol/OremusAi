-- Empties all synced DATA. Keeps: users, password_resets, zoho_tokens, zoho_organizations, qbo_tokens, qbo_organizations, xero_tokens, xero_organizations
-- Uses DELETE (works with FK checks off; TRUNCATE does not on FK-referenced tables).

SET FOREIGN_KEY_CHECKS = 0;

DELETE FROM `account_transactions`;
DELETE FROM `bank_transactions`;
DELETE FROM `bills`;
DELETE FROM `customers`;
DELETE FROM `expense_entries`;
DELETE FROM `invoices`;
DELETE FROM `notifications`;
DELETE FROM `vendors`;
DELETE FROM `zb_bank_accounts`;
DELETE FROM `zb_bill_line_items`;
DELETE FROM `zb_chart_of_accounts`;
DELETE FROM `zb_credit_notes`;
DELETE FROM `zb_customer_payments`;
DELETE FROM `zb_invoice_line_items`;
DELETE FROM `zb_items`;
DELETE FROM `zb_journals`;
DELETE FROM `zb_organizations`;
DELETE FROM `zb_raw_payloads`;
DELETE FROM `zb_recurring_bills`;
DELETE FROM `zb_report_cache`;
DELETE FROM `zb_sync_run_items`;
DELETE FROM `zb_sync_runs`;
DELETE FROM `zb_sync_watermarks`;
DELETE FROM `zb_vendor_credits`;
DELETE FROM `zb_vendor_payments`;

-- reset id counters
ALTER TABLE `account_transactions` AUTO_INCREMENT = 1;
ALTER TABLE `bank_transactions` AUTO_INCREMENT = 1;
ALTER TABLE `bills` AUTO_INCREMENT = 1;
ALTER TABLE `customers` AUTO_INCREMENT = 1;
ALTER TABLE `expense_entries` AUTO_INCREMENT = 1;
ALTER TABLE `invoices` AUTO_INCREMENT = 1;
ALTER TABLE `notifications` AUTO_INCREMENT = 1;
ALTER TABLE `vendors` AUTO_INCREMENT = 1;
ALTER TABLE `zb_bank_accounts` AUTO_INCREMENT = 1;
ALTER TABLE `zb_bill_line_items` AUTO_INCREMENT = 1;
ALTER TABLE `zb_chart_of_accounts` AUTO_INCREMENT = 1;
ALTER TABLE `zb_credit_notes` AUTO_INCREMENT = 1;
ALTER TABLE `zb_customer_payments` AUTO_INCREMENT = 1;
ALTER TABLE `zb_invoice_line_items` AUTO_INCREMENT = 1;
ALTER TABLE `zb_items` AUTO_INCREMENT = 1;
ALTER TABLE `zb_journals` AUTO_INCREMENT = 1;
ALTER TABLE `zb_organizations` AUTO_INCREMENT = 1;
ALTER TABLE `zb_raw_payloads` AUTO_INCREMENT = 1;
ALTER TABLE `zb_recurring_bills` AUTO_INCREMENT = 1;
ALTER TABLE `zb_report_cache` AUTO_INCREMENT = 1;
ALTER TABLE `zb_sync_run_items` AUTO_INCREMENT = 1;
ALTER TABLE `zb_sync_runs` AUTO_INCREMENT = 1;
ALTER TABLE `zb_sync_watermarks` AUTO_INCREMENT = 1;
ALTER TABLE `zb_vendor_credits` AUTO_INCREMENT = 1;
ALTER TABLE `zb_vendor_payments` AUTO_INCREMENT = 1;

SET FOREIGN_KEY_CHECKS = 1;
