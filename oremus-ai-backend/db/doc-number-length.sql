-- Document numbers longer than 100 chars exist in real data (a Xero supplier
-- reference listing several invoice numbers reached 111 chars), and one such
-- row aborted the whole bills sync ("Data too long for column 'bill_number'").
-- Widen to 255, keeping each column's collation/nullability. Widening never
-- loses data. (xeroService.ensureDocNumberLength applies the same on sync.)
ALTER TABLE bills    MODIFY bill_number    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL;
ALTER TABLE invoices MODIFY invoice_number VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL;
