-- Vendor payments — synced from Xero Payments (Type=ACCPAYPAYMENT, APOVERPAYMENTPAYMENT, etc.)
-- Required by: AP Aging Summary/Detailed, Expenses by Vendor Summary,
--   Tax Liability, TDS Summary, GST Returns Workbook,
--   Forex Gains/Losses, Realised Forex.
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS `zb_vendor_payments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `org_id` varchar(100) NOT NULL,
  `zoho_id` varchar(100) NOT NULL,
  `xero_id` varchar(64) NOT NULL,
  `contact_name` varchar(255) DEFAULT NULL,
  `company_name` varchar(255) DEFAULT NULL,
  `amount` decimal(15,2) DEFAULT '0.00',
  `date` date DEFAULT NULL,
  `currency_code` varchar(10) DEFAULT NULL,
  `exchange_rate` decimal(10,6) DEFAULT '1.000000',
  `payment_type` varchar(50) DEFAULT NULL,     -- APOVERPAYMENTPAYMENT, APCREDITPAYMENT, etc.
  `apply_to_invoice_id` varchar(100) DEFAULT NULL,
  `apply_to_invoice_number` varchar(100) DEFAULT NULL,
  `status` varchar(50) DEFAULT 'AUTHORISED',
  `source_type` varchar(50) DEFAULT 'xero',
  `synced_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_zvp` (`user_id`,`xero_id`),
  KEY `idx_zvp_org` (`org_id`),
  KEY `idx_zvp_contact` (`contact_name`),
  CONSTRAINT `zb_vendor_payments_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;