-- QuickBooks ledger memos. syncGeneralLedger stores the GeneralLedger report's
-- Name column in transaction_details (its memo only when a line has no name),
-- so every vendor transaction lost its memo, which the Transaction List by
-- Vendor prints. '' = no memo; NULL = a line synced before this column.
-- (quickbooksService.ensureLedgerMemoColumn applies the same change on sync.)
ALTER TABLE account_transactions ADD COLUMN memo TEXT NULL;
