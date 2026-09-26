'use strict';
const { Router } = require('express');
const pool       = require('../config/db');
const auth       = require('../middleware/auth');

const router = Router();
router.use(auth);

async function safeQuery(sql, params) {
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (_) {
    return [];
  }
}

// ── GET /api/search?q=xxx ─────────────────────────────────────────────────────
// Searches across invoices, bank_transactions, account_transactions, bills.
// Returns up to 5 results per category, max 20 total.
router.get('/', async (req, res) => {
  try {
    const uid = req.user.id;
    const q   = (req.query.q || '').trim();

    if (!q || q.length < 2) {
      return res.json({ data: [] });
    }

    const like = `%${q}%`;
    const orgF = req.orgId ? ' AND org_id = ?' : '';
    const orgP = req.orgId ? [req.orgId] : [];

    const [invoices, transactions, accounts, bills] = await Promise.all([
      // Invoices → customer name or invoice number
      safeQuery(
        `SELECT 'invoice' AS type,
                invoice_number AS ref,
                customer_name  AS title,
                total          AS amount,
                date           AS date,
                status
         FROM invoices
         WHERE user_id = ?
           AND (customer_name LIKE ? OR invoice_number LIKE ?)${orgF}
         ORDER BY date DESC LIMIT 5`,
        [uid, like, like, ...orgP]
      ),

      // Bank transactions → payee or type
      safeQuery(
        `SELECT 'transaction' AS type,
                transaction_type_formatted AS ref,
                payee          AS title,
                amount,
                transaction_date AS date,
                debit_or_credit AS status
         FROM bank_transactions
         WHERE user_id = ?
           AND (payee LIKE ? OR transaction_type_formatted LIKE ?)${orgF}
         ORDER BY transaction_date DESC LIMIT 5`,
        [uid, like, like, ...orgP]
      ),

      // Account transactions → account name or details
      safeQuery(
        `SELECT 'account' AS type,
                transaction_number AS ref,
                COALESCE(NULLIF(transaction_details,''), account_name) AS title,
                COALESCE(COALESCE(base_credit, credit), COALESCE(base_debit, debit), 0) AS amount,
                transaction_date AS date,
                account_group AS status
         FROM account_transactions
         WHERE user_id = ?
           AND (account_name LIKE ? OR transaction_details LIKE ? OR transaction_number LIKE ?)${orgF}
         ORDER BY transaction_date DESC LIMIT 5`,
        [uid, like, like, like, ...orgP]
      ),

      // Bills → vendor name or bill number
      safeQuery(
        `SELECT 'bill' AS type,
                bill_number AS ref,
                vendor_name AS title,
                total       AS amount,
                date,
                status
         FROM bills
         WHERE user_id = ?
           AND (vendor_name LIKE ? OR bill_number LIKE ?)${orgF}
         ORDER BY date DESC LIMIT 5`,
        [uid, like, like, ...orgP]
      ),
    ]);

    // Merge, label and return max 20
    const results = [
      ...invoices.map(r    => ({ ...r, category: 'Invoice' })),
      ...transactions.map(r => ({ ...r, category: 'Transaction' })),
      ...accounts.map(r    => ({ ...r, category: 'Account' })),
      ...bills.map(r       => ({ ...r, category: 'Bill' })),
    ]
      .slice(0, 20)
      .map(r => ({
        type:     r.type,
        category: r.category,
        ref:      r.ref   || '',
        title:    r.title || 'Unknown',
        amount:   parseFloat(r.amount || 0),
        date:     r.date  || null,
        status:   r.status || '',
      }));

    return res.json({ data: results });
  } catch (err) {
    console.error('Search error:', err.message);
    return res.json({ data: [] });
  }
});

module.exports = router;
