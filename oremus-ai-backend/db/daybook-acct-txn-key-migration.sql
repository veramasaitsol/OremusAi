-- Day Book imbalance fix — widen account_transactions unique key.
--
-- BUG: uq_acct_txn (user_id, transaction_id, account_id) is too coarse. A single
-- Zoho transaction_id can span multiple sub-vouchers (e.g. a customer payment +
-- the invoice it settles, or a vendor payment + its bill) that BOTH post to the
-- same account (Accounts Receivable / Accounts Payable). Those two lines collide
-- on (user_id, transaction_id, account_id), so syncAccountTransactions'
-- ON DUPLICATE KEY UPDATE silently overwrites one with the other. The dropped
-- line is the payment's AR-credit / AP-debit, leaving the Day Book unbalanced
-- (sum of debits != sum of credits) by exactly the bank amount of each payment.
--
-- FIX: add transaction_number to the unique key so each voucher's line is kept
-- distinct. transaction_number becomes NOT NULL DEFAULT '' so MySQL dedup stays
-- idempotent (NULLs are treated as distinct in unique keys, which would break it).
--
-- NOTE: this only stops FUTURE syncs from dropping lines. The lines already lost
-- during prior syncs were never persisted and can only be recovered by re-running
-- syncAccountTransactions for the affected org(s) AFTER applying this migration.
--
-- RUN ONCE: node db/apply-sql.js db/daybook-acct-txn-key-migration.sql

-- 1. Backfill existing NULL numbers to '' so they match future '' inserts.
UPDATE account_transactions SET transaction_number = '' WHERE transaction_number IS NULL;

-- 2. Enforce the non-null invariant the unique key relies on.
ALTER TABLE account_transactions MODIFY transaction_number VARCHAR(150) NOT NULL DEFAULT '';

-- 3. Swap the unique key (single atomic ALTER keeps the user_id FK index covered).
ALTER TABLE account_transactions DROP INDEX uq_acct_txn, ADD UNIQUE KEY uq_acct_txn (user_id, transaction_id, transaction_number, account_id);
