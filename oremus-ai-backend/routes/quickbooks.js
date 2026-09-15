'use strict';
// Read-only API endpoints for QuickBooks-synced data stored in our DB.
// All endpoints require Bearer JWT auth (middleware/auth).

const { Router } = require('express');
const pool       = require('../config/db');
const auth       = require('../middleware/auth');
const adminClientView = require('../middleware/adminClientView');
const cache      = require('../utils/cache');
const { getEffectiveQBUserId } = require('../services/quickbooksService');

const router = Router();
router.use(auth);
// Admin "view as client": swap req.user.id to the selected client on a valid
// X-Client-Id so these read-only account endpoints return the client's data.
// No-op for non-admins / no header. Only GET reads live in this router.
router.use(adminClientView);

// Chart of Accounts changes only on a (manual) QB sync, so a short TTL gives a
// large read-amplification win with negligible staleness. ENHANCEMENTS Task E.
const ACCOUNTS_TTL_MS = 60000;

// ── GET /api/quickbooks/accounts ─────────────────────────────────────────────
// Returns the synced QuickBooks Chart of Accounts for the current user.
// Optional query params:
//   ?type=Bank         filter by account_type
//   ?classification=Asset
//   ?active=1|0
//   ?search=foo        partial match against name / fully_qualified_name / account_number
router.get('/accounts', async (req, res) => {
  try {
    const { type, classification, active, search } = req.query;

    // Clients with integration_type='quickbooks' inherit the admin's QB view.
    const effectiveUserId = await getEffectiveQBUserId(req.user.id);

    const where  = ['user_id = ?'];
    const params = [effectiveUserId];

    if (type) {
      where.push('account_type = ?');
      params.push(type);
    }
    if (classification) {
      where.push('classification = ?');
      params.push(classification);
    }
    if (active === '0' || active === '1') {
      where.push('active = ?');
      params.push(parseInt(active));
    }
    if (search) {
      where.push('(name LIKE ? OR fully_qualified_name LIKE ? OR account_number LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    const cacheKey = `qbo-accounts:${effectiveUserId}:${JSON.stringify({ type, classification, active, search })}`;
    const payload = await cache.wrap(cacheKey, ACCOUNTS_TTL_MS, async () => {
      const sql = `
        SELECT id, realm_id, qbo_id, name, fully_qualified_name,
               account_type, account_sub_type, classification, account_number,
               description, current_balance, current_balance_with_sub_accounts,
               currency, parent_qbo_id, is_sub_account, active,
               qbo_created_at, qbo_updated_at, synced_at
        FROM qbo_accounts
        WHERE ${where.join(' AND ')}
        ORDER BY
          FIELD(classification,'Asset','Liability','Equity','Revenue','Expense'),
          account_number IS NULL, account_number,
          name
      `;

      const [rows] = await pool.execute(sql, params);

      // Group by classification for easy frontend rendering, but also return flat list.
      const byClassification = rows.reduce((acc, r) => {
        const k = r.classification || 'Uncategorized';
        (acc[k] ||= []).push(r);
        return acc;
      }, {});

      // Aggregate totals per classification (using current_balance — accounts only,
      // not double-counting sub-accounts).
      const totals = {};
      for (const [k, list] of Object.entries(byClassification)) {
        totals[k] = list
          .filter((r) => r.active && !r.is_sub_account)
          .reduce((s, r) => s + Number(r.current_balance_with_sub_accounts || 0), 0);
      }

      return { data: rows, total: rows.length, byClassification, totals };
    });

    return res.json(payload);
  } catch (err) {
    // Some deployments never created the qbo_accounts table — degrade to an
    // empty (but valid) payload instead of 500-ing the Accounts page.
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ data: [], total: 0, byClassification: {}, totals: {} });
    }
    console.error('GET /api/quickbooks/accounts:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/quickbooks/accounts/summary ─────────────────────────────────────
// Lightweight summary tile data: counts + classification totals.
router.get('/accounts/summary', async (req, res) => {
  try {
    const effectiveUserId = await getEffectiveQBUserId(req.user.id);

    const payload = await cache.wrap(`qbo-accounts-summary:${effectiveUserId}`, ACCOUNTS_TTL_MS, async () => {
      const [[counts]] = await pool.execute(
        `SELECT
           COUNT(*)                                                         AS total,
           SUM(active = 1)                                                  AS active_count,
           SUM(is_sub_account = 1)                                          AS sub_account_count,
           MAX(synced_at)                                                   AS last_synced_at
         FROM qbo_accounts WHERE user_id = ?`,
        [effectiveUserId]
      );

      const [byClass] = await pool.execute(
        `SELECT classification,
                COUNT(*)                                       AS count,
                SUM(current_balance_with_sub_accounts)         AS total_balance
           FROM qbo_accounts
          WHERE user_id = ? AND active = 1 AND is_sub_account = 0
          GROUP BY classification`,
        [effectiveUserId]
      );

      return { counts: counts || {}, byClassification: byClass };
    });

    return res.json(payload);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ counts: {}, byClassification: [] });
    }
    console.error('GET /api/quickbooks/accounts/summary:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
