-- Bill line items — mirrors zb_invoice_line_items, for the purchase side.
-- Populated from the Zoho /bills/{bill_id} DETAIL call (the /bills LIST payload
-- carries no line_items / tax breakdown). Unblocks "Purchases by Item" and the
-- purchase-tax (input GST / ITC) side of the GST + Tax Liability reports.
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS `zb_bill_line_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `org_id` varchar(100) NOT NULL,
  `zoho_line_item_id` varchar(100) NOT NULL,
  `zoho_bill_id` varchar(100) NOT NULL,
  `line_position` int DEFAULT '0',
  `zoho_item_id` varchar(100) DEFAULT NULL,
  `item_name` varchar(255) DEFAULT NULL,
  `description` text,
  `unit` varchar(50) DEFAULT NULL,
  `hsn_or_sac` varchar(50) DEFAULT NULL,
  `account_id` varchar(100) DEFAULT NULL,
  `account_name` varchar(255) DEFAULT NULL,
  `quantity` decimal(18,4) DEFAULT '0.0000',
  `rate` decimal(18,4) DEFAULT '0.0000',
  `discount` decimal(18,4) DEFAULT '0.0000',
  `discount_amount` decimal(18,4) DEFAULT '0.0000',
  `item_total` decimal(18,4) DEFAULT '0.0000',
  `item_total_inclusive_of_tax` decimal(18,4) DEFAULT '0.0000',
  `tax_id` varchar(100) DEFAULT NULL,
  `tax_name` varchar(255) DEFAULT NULL,
  `tax_type` varchar(64) DEFAULT NULL,
  `tax_percentage` decimal(7,4) DEFAULT NULL,
  `tax_amount` decimal(18,4) DEFAULT '0.0000',
  `custom_fields_json` json DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_zbbli` (`user_id`,`org_id`,`zoho_line_item_id`),
  KEY `idx_zbbli_bill` (`zoho_bill_id`),
  KEY `idx_zbbli_item` (`zoho_item_id`),
  CONSTRAINT `zb_bill_line_items_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
