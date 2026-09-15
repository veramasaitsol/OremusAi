'use strict';
const { Router } = require('express');
const pool       = require('../config/db');
const auth       = require('../middleware/auth');

const router = Router();
router.use(auth);
router.use(require('../middleware/adminClientView')); // honor admin view-as-client (X-Client-Id)

// GET /api/customers?page=1&limit=50&search=
router.get('/', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(200, parseInt(req.query.limit || '50'));
    const offset = (page - 1) * limit;
    const search = `%${req.query.search || ''}%`;
    const orgF = req.orgId ? ' AND org_id = ?' : '';
    const orgP = req.orgId ? [req.orgId] : [];

    const [rows] = await pool.execute(
      `SELECT id, zoho_id, contact_name, company_name, email, phone,
              outstanding_receivable_amount, status, synced_at
       FROM customers
       WHERE user_id = ? AND (contact_name LIKE ? OR company_name LIKE ? OR email LIKE ?)${orgF}
       ORDER BY outstanding_receivable_amount DESC LIMIT ${limit} OFFSET ${offset}`,
      [req.user.id, search, search, search, ...orgP]
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM customers
       WHERE user_id = ? AND (contact_name LIKE ? OR company_name LIKE ? OR email LIKE ?)${orgF}`,
      [req.user.id, search, search, search, ...orgP]
    );

    return res.json({ data: rows, total, page, limit });
  } catch (err) {
    console.error('Customers list error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
