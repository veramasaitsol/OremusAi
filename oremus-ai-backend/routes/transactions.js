'use strict';
const { Router } = require('express');
const pool       = require('../config/db');
const auth       = require('../middleware/auth');
const adminClientView = require('../middleware/adminClientView');

const router = Router();
router.use(auth);
// Lets an admin "view as client": when a valid X-Client-Id is sent, req.user.id
// is swapped to that client so these read endpoints return the client's data
// (same mechanism the dashboard uses). No-op for non-admins / no header.
router.use(adminClientView);

// GET /api/transactions?page&limit&search&type&from&to
router.get('/', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(200, parseInt(req.query.limit || '50'));
    const offset = (page - 1) * limit;
    const search = `%${req.query.search || ''}%`;
    const type   = req.query.type || null;
    const from   = req.query.from || null;
    const to     = req.query.to   || null;

    let where  = 'user_id = ? AND (description LIKE ? OR reference_number LIKE ? OR account_name LIKE ?)';
    const params = [req.user.id, search, search, search];

    if (type) { where += ' AND transaction_type = ?'; params.push(type); }
    if (from) { where += ' AND transaction_date >= ?'; params.push(from); }
    if (to)   { where += ' AND transaction_date <= ?'; params.push(to); }
    if (req.orgId) { where += ' AND org_id = ?'; params.push(req.orgId); }

    const [rows] = await pool.execute(
      `SELECT id, transaction_id, transaction_date, transaction_type,
              reference_number, description, debit, credit, account_name, entity_name, synced_at
       FROM daybook_transactions WHERE ${where}
       ORDER BY transaction_date DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM daybook_transactions WHERE ${where}`, params
    );

    const [[{ periodCredit, periodDebit }]] = await pool.execute(
      `SELECT COALESCE(SUM(credit),0) AS periodCredit, COALESCE(SUM(debit),0) AS periodDebit
       FROM daybook_transactions WHERE ${where}`, params
    );

    return res.json({ data: rows, total, page, limit, periodCredit, periodDebit });
  } catch (err) {
    // Some deployments never created the daybook_transactions table — degrade to
    // an empty (but valid) payload instead of 500-ing the Transactions page.
    if (err.code === 'ER_NO_SUCH_TABLE') {
      const page  = Math.max(1, parseInt(req.query.page  || '1'));
      const limit = Math.min(200, parseInt(req.query.limit || '50'));
      return res.json({ data: [], total: 0, page, limit, periodCredit: 0, periodDebit: 0 });
    }
    console.error('Transactions list error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/transactions/invoices
router.get('/invoices', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(200, parseInt(req.query.limit || '50'));
    const offset = (page - 1) * limit;
    const status = req.query.status || null;
    const from   = req.query.from   || null;
    const to     = req.query.to     || null;

    let where = 'user_id = ?';
    const params = [req.user.id];
    if (status) { where += ' AND status = ?'; params.push(status); }
    if (from)   { where += ' AND date >= ?';  params.push(from); }
    if (to)     { where += ' AND date <= ?';  params.push(to); }
    if (req.orgId) { where += ' AND org_id = ?'; params.push(req.orgId); }

    const [rows] = await pool.execute(
      `SELECT id, zoho_id, invoice_number, customer_name,
              date, due_date, total, balance, status, synced_at
       FROM invoices WHERE ${where} ORDER BY date DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM invoices WHERE ${where}`, params
    );
    return res.json({ data: rows, total, page, limit });
  } catch (err) {
    console.error('Invoices list error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/transactions/bills
router.get('/bills', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(200, parseInt(req.query.limit || '50'));
    const offset = (page - 1) * limit;
    const status = req.query.status || null;

    let where = 'user_id = ?';
    const params = [req.user.id];
    if (status) { where += ' AND status = ?'; params.push(status); }
    if (req.orgId) { where += ' AND org_id = ?'; params.push(req.orgId); }

    const [rows] = await pool.execute(
      `SELECT id, zoho_id, bill_number, vendor_name,
              date, due_date, total, balance, status, synced_at
       FROM bills WHERE ${where} ORDER BY date DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM bills WHERE ${where}`, params
    );
    return res.json({ data: rows, total, page, limit });
  } catch (err) {
    console.error('Bills list error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/transactions/expenses
router.get('/expenses', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(200, parseInt(req.query.limit || '50'));
    const offset = (page - 1) * limit;
    const orgF = req.orgId ? ' AND org_id = ?' : '';
    const orgP = req.orgId ? [req.orgId] : [];

    const [rows] = await pool.execute(
      `SELECT id, zoho_id, account_name, expense_date,
              amount, vendor_name, description, status, synced_at
       FROM expense_entries WHERE user_id = ?${orgF}
       ORDER BY expense_date DESC LIMIT ${limit} OFFSET ${offset}`,
      [req.user.id, ...orgP]
    );
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM expense_entries WHERE user_id = ?${orgF}`, [req.user.id, ...orgP]
    );
    return res.json({ data: rows, total, page, limit });
  } catch (err) {
    console.error('Expenses list error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/transactions/bank-transactions
// Query params: page, limit, search, type, account, status, from, to
router.get('/bank-transactions', async (req, res) => {
  try {
    const page    = Math.max(1, parseInt(req.query.page    || '1'));
    const limit   = Math.min(500, parseInt(req.query.limit || '100'));
    const offset  = (page - 1) * limit;
    const search  = `%${req.query.search || ''}%`;
    const type    = req.query.type    || null;
    const account = req.query.account || null;
    const status  = req.query.status  || null;
    const from    = req.query.from    || null;
    const to      = req.query.to      || null;

    let where    = 'user_id = ? AND (payee LIKE ? OR description LIKE ? OR reference_number LIKE ? OR account_name LIKE ?)';
    const params = [req.user.id, search, search, search, search];

    if (type)    { where += ' AND transaction_type = ?';     params.push(type);           }
    if (account) { where += ' AND account_name LIKE ?';      params.push(`%${account}%`); }
    if (status)  { where += ' AND status = ?';               params.push(status);         }
    if (from)    { where += ' AND transaction_date >= ?';    params.push(from);           }
    if (to)      { where += ' AND transaction_date <= ?';    params.push(to);             }
    if (req.orgId) { where += ' AND org_id = ?';             params.push(req.orgId);      }

    const [rows] = await pool.execute(
      `SELECT id, transaction_id, transaction_date, amount,
              transaction_type, transaction_type_formatted, status, source,
              account_id, account_name, account_type,
              payee, description, currency_code,
              debit_or_credit, offset_account_name,
              reference_number, reconcile_status,
              running_balance, synced_at
       FROM bank_transactions
       WHERE ${where}
       ORDER BY transaction_date DESC, id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM bank_transactions WHERE ${where}`, params
    );

    const [[{ totalAmount }]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS totalAmount FROM bank_transactions WHERE ${where}`, params
    );

    // Distinct transaction types for filter dropdown
    const [types] = await pool.execute(
      `SELECT DISTINCT transaction_type, transaction_type_formatted
       FROM bank_transactions
       WHERE user_id = ? AND transaction_type IS NOT NULL${req.orgId ? ' AND org_id = ?' : ''}
       ORDER BY transaction_type`,
      req.orgId ? [req.user.id, req.orgId] : [req.user.id]
    );

    return res.json({
      data: rows,
      total,
      page,
      limit,
      totalAmount,
      types: types.map((r) => ({ value: r.transaction_type, label: r.transaction_type_formatted })),
    });
  } catch (err) {
    console.error('Bank transactions list error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/transactions/account-transactions
// Query params: page, limit, search, type, from, to, account
router.get('/account-transactions', async (req, res) => {
  try {
    const page    = Math.max(1, parseInt(req.query.page    || '1'));
    const limit   = Math.min(500, parseInt(req.query.limit || '100'));
    const offset  = (page - 1) * limit;
    const search  = `%${req.query.search  || ''}%`;
    const type    = req.query.type    || null;
    const account = req.query.account || null;
    const from    = req.query.from    || null;
    const to      = req.query.to      || null;

    let where    = 'user_id = ? AND (account_name LIKE ? OR transaction_details LIKE ? OR transaction_number LIKE ? OR reference_number LIKE ?)';
    const params = [req.user.id, search, search, search, search];

    if (type)    { where += ' AND transaction_type = ?';               params.push(type);    }
    if (account) { where += ' AND account_name LIKE ?';                params.push(`%${account}%`); }
    if (from)    { where += ' AND transaction_date >= ?';              params.push(from);    }
    if (to)      { where += ' AND transaction_date <= ?';              params.push(to);      }
    if (req.orgId) { where += ' AND org_id = ?';                       params.push(req.orgId); }

    const [rows] = await pool.execute(
      `SELECT id, transaction_id, account_id, transaction_date, account_name,
              transaction_details, transaction_type, transaction_number,
              reference_number, COALESCE(base_debit, debit) AS debit, COALESCE(base_credit, credit) AS credit,
              balance, balance_type, synced_at
       FROM account_transactions
       WHERE ${where}
       ORDER BY transaction_date DESC, id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM account_transactions WHERE ${where}`, params
    );

    const [[{ totalDebit, totalCredit }]] = await pool.execute(
      `SELECT COALESCE(SUM(COALESCE(base_debit, debit)),0) AS totalDebit, COALESCE(SUM(COALESCE(base_credit, credit)),0) AS totalCredit
       FROM account_transactions WHERE ${where}`,
      params
    );

    // Distinct transaction types for filter dropdown
    const [types] = await pool.execute(
      `SELECT DISTINCT transaction_type FROM account_transactions
       WHERE user_id = ? AND transaction_type IS NOT NULL${req.orgId ? ' AND org_id = ?' : ''}
       ORDER BY transaction_type`,
      req.orgId ? [req.user.id, req.orgId] : [req.user.id]
    );

    return res.json({
      data: rows,
      total,
      page,
      limit,
      totalDebit,
      totalCredit,
      types: types.map((r) => r.transaction_type),
    });
  } catch (err) {
    console.error('Account transactions list error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
