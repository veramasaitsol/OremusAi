'use strict';
// Read-only API endpoints for Xero-synced data stored in our DB.
// Bearer JWT required.

const { Router } = require('express');
const pool       = require('../config/db');
const auth       = require('../middleware/auth');
const adminClientView = require('../middleware/adminClientView');
const { getEffectiveXeroUserId } = require('../services/xeroService');

const router = Router();
router.use(auth);
// Admin "view as client": swap req.user.id to the selected client on a valid
// X-Client-Id so these read-only account endpoints return the client's data.
// No-op for non-admins / no header. Only GET reads live in this router.
router.use(adminClientView);

// ── GET /api/xero/accounts ───────────────────────────────────────────────────
// Returns the synced Xero Chart of Accounts for the effective user
// (clients with integration_type='xero' inherit admin's view).
// Optional query params:
//   ?type=BANK           filter by Xero Account.Type
//   ?class=ASSET         filter by Xero Account.Class
//   ?status=ACTIVE|ARCHIVED
//   ?search=foo          partial match against name / code
router.get('/accounts', async (req, res) => {
  try {
    const { type, class: cls, status, search } = req.query;
    const effectiveUserId = await getEffectiveXeroUserId(req.user.id);

    const where  = ['user_id = ?'];
    const params = [effectiveUserId];

    if (type)   { where.push('type = ?');   params.push(type); }
    if (cls)    { where.push('class = ?');  params.push(cls); }
    if (status) { where.push('status = ?'); params.push(status); }
    if (search) {
      where.push('(name LIKE ? OR code LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s);
    }

    const sql = `
      SELECT id, tenant_id, xero_id, code, name, type, tax_type, class, description,
             enable_payments_to_account, show_in_expense_claims, status,
             bank_account_number, bank_account_type, currency_code,
             reporting_code, reporting_code_name, has_attachments, balance,
             updated_date_utc, synced_at
      FROM xero_accounts
      WHERE ${where.join(' AND ')}
      ORDER BY
        FIELD(class,'ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE'),
        code IS NULL, code, name
    `;

    const [rows] = await pool.execute(sql, params);

    // Group by class for easy frontend rendering.
    const byClassification = rows.reduce((acc, r) => {
      // Normalise Xero CAPS to title case for parity with the QB accounts endpoint
      const raw = r.class || 'Uncategorized';
      const k = raw === 'Uncategorized'
        ? 'Uncategorized'
        : raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
      (acc[k] ||= []).push({ ...r, classification: k });
      return acc;
    }, {});

    const totals = {};
    for (const [k, list] of Object.entries(byClassification)) {
      totals[k] = list
        .filter((r) => r.status === 'ACTIVE')
        .reduce((s, r) => s + Number(r.balance || 0), 0);
    }

    // Frontend (Accounts page) expects fields named like the QB endpoint
    // (current_balance, current_balance_with_sub_accounts, classification,
    // is_sub_account, active). Map Xero rows to that shape for compatibility.
    const normalised = rows.map((r) => ({
      ...r,
      qbo_id: r.xero_id,             // alias so the QB table key works
      classification: r.class
        ? r.class.charAt(0).toUpperCase() + r.class.slice(1).toLowerCase()
        : 'Uncategorized',
      account_type: r.type || null,
      account_sub_type: r.tax_type || null,
      account_number: r.code || null,
      current_balance: r.balance || 0,
      current_balance_with_sub_accounts: r.balance || 0,
      currency: r.currency_code || null,
      parent_qbo_id: null,
      is_sub_account: 0,
      active: r.status === 'ACTIVE' ? 1 : 0,
    }));

    return res.json({
      data: normalised,
      total: rows.length,
      byClassification,
      totals,
      source: 'xero',
    });
  } catch (err) {
    // Some deployments never created the xero_accounts table — degrade to an
    // empty (but valid) payload instead of 500-ing the Accounts page.
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ data: [], total: 0, byClassification: {}, totals: {}, source: 'xero' });
    }
    console.error('GET /api/xero/accounts:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/xero/accounts/summary ───────────────────────────────────────────
router.get('/accounts/summary', async (req, res) => {
  try {
    const effectiveUserId = await getEffectiveXeroUserId(req.user.id);

    const [[counts]] = await pool.execute(
      `SELECT
         COUNT(*)                        AS total,
         SUM(status = 'ACTIVE')          AS active_count,
         0                               AS sub_account_count,
         MAX(synced_at)                  AS last_synced_at
       FROM xero_accounts WHERE user_id = ?`,
      [effectiveUserId]
    );

    const [byClass] = await pool.execute(
      `SELECT class AS classification,
              COUNT(*)                       AS count,
              SUM(balance)                   AS total_balance
         FROM xero_accounts
        WHERE user_id = ? AND status = 'ACTIVE'
        GROUP BY class`,
      [effectiveUserId]
    );

    return res.json({
      counts: counts || {},
      byClassification: byClass,
      source: 'xero',
    });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ counts: {}, byClassification: [], source: 'xero' });
    }
    console.error('GET /api/xero/accounts/summary:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
