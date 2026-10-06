-- Store converted (base-currency) amounts at full precision. Xero lines are
-- converted at the document/payment rate; rounding each line to 2 dp lost up
-- to half a paisa/cent per line, which added up across the ledger. Reports
-- round once, on the totals they print. Widening never loses existing data.
-- (xeroPostingEngine.ensureBasePrecision applies the same change on sync.)
ALTER TABLE account_transactions
  MODIFY base_debit  DECIMAL(20,6) NULL,
  MODIFY base_credit DECIMAL(20,6) NULL;
