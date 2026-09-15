'use strict';
const { Router } = require('express');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const axios      = require('axios');
const pool       = require('../config/db');
const auth       = require('../middleware/auth');
const { QBO_AUTH_URL, revokeToken: qboRevokeToken } = require('../services/quickbooksService');
const { XERO_AUTH_URL, revokeToken: xeroRevokeToken } = require('../services/xeroService');

const router = Router();
router.use(auth);

// ── Admin-only guard ──────────────────────────────────────────────────────────
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}
router.use(adminOnly);

const DEFAULT_PERMISSIONS = ['Dashboard', 'Profile'];

function parsePerms(raw) {
  if (!raw) return DEFAULT_PERMISSIONS;
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return DEFAULT_PERMISSIONS; }
}

// Some deployments only have the zb_tokens table (qbo_/xero_tokens were never
// created). JOINing a non-existent table throws ER_NO_SUCH_TABLE, so probe once
// (cached) and only join the provider token tables that actually exist.
let _tokenTableCache = null;
async function existingTokenTables() {
  if (_tokenTableCache) return _tokenTableCache;
  const out = { zoho: false, qbo: false, xero: false };
  const [rows] = await pool.execute(
    `SELECT table_name AS t FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name IN ('zb_tokens','qbo_tokens','xero_tokens')`
  );
  for (const r of rows) {
    const t = r.t || r.table_name || r.TABLE_NAME;
    if (t === 'zb_tokens') out.zoho = true;
    if (t === 'qbo_tokens')  out.qbo = true;
    if (t === 'xero_tokens') out.xero = true;
  }
  _tokenTableCache = out;
  return out;
}

// ── GET /api/clients ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const search = `%${req.query.search || ''}%`;
    const tokens = await existingTokenTables();

    const cols = [
      `u.id, u.name, u.email`,
      `COALESCE(u.mobile, '')               AS mobile`,
      `COALESCE(u.company, '')              AS company`,
      `u.client_id`,
      `COALESCE(u.integration_type, 'none') AS integration_type`,
      `u.permissions`,
      `COALESCE(u.status, 'Active')         AS status`,
      `u.created_at`,
    ];
    const joins = [];

    if (tokens.zoho) {
      cols.push(
        // Connected = a token row with a durable refresh_token exists (disconnect
        // deletes the row). NOT keyed on the short-lived access-token expiry, which
        // lapses ~hourly and is silently refreshed on the next API call.
        `CASE WHEN zt.refresh_token IS NOT NULL THEN 1 ELSE 0 END AS zoho_connected`,
        `zt.org_id       AS zoho_org_id`,
        `zt.connected_at AS zoho_connected_at`,
      );
      joins.push(`LEFT JOIN zb_tokens zt ON zt.user_id = u.id`);
    } else {
      cols.push(`0 AS zoho_connected`, `NULL AS zoho_org_id`, `NULL AS zoho_connected_at`);
    }

    if (tokens.qbo) {
      cols.push(
        `CASE WHEN qt.refresh_token IS NOT NULL THEN 1 ELSE 0 END AS qbo_connected`,
        `qt.realm_id     AS qbo_realm_id`,
        `qt.environment  AS qbo_environment`,
        `qt.connected_at AS qbo_connected_at`,
      );
      joins.push(`LEFT JOIN qbo_tokens qt ON qt.user_id = u.id`);
    } else {
      cols.push(`0 AS qbo_connected`, `NULL AS qbo_realm_id`, `NULL AS qbo_environment`, `NULL AS qbo_connected_at`);
    }

    if (tokens.xero) {
      cols.push(
        `CASE WHEN xt.refresh_token IS NOT NULL THEN 1 ELSE 0 END AS xero_connected`,
        `xt.tenant_id    AS xero_tenant_id`,
        `xt.tenant_name  AS xero_tenant_name`,
        `xt.connected_at AS xero_connected_at`,
      );
      joins.push(`LEFT JOIN xero_tokens xt ON xt.user_id = u.id`);
    } else {
      cols.push(`0 AS xero_connected`, `NULL AS xero_tenant_id`, `NULL AS xero_tenant_name`, `NULL AS xero_connected_at`);
    }

    const [rows] = await pool.execute(
      `SELECT ${cols.join(',\n         ')}
       FROM users u
       ${joins.join('\n       ')}
       WHERE u.role = 'client'
         AND (u.name LIKE ? OR u.email LIKE ? OR COALESCE(u.company,'') LIKE ?)
       ORDER BY u.created_at DESC`,
      [search, search, search]
    );

    const data = rows.map((r) => ({
      ...r,
      permissions:    parsePerms(r.permissions),
      zoho_connected: r.zoho_connected === 1,
      qbo_connected:  r.qbo_connected === 1,
      xero_connected: r.xero_connected === 1,
    }));

    return res.json({ data, total: data.length });
  } catch (err) {
    console.error('GET /api/clients:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/clients ─────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, email, mobile, company, password, status, integration_type, permissions } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ error: 'name, email and password are required' });
    if (password.length < 4)
      return res.status(400).json({ error: 'Password must be at least 4 characters' });

    const hash     = await bcrypt.hash(password, 10);
    const clientId = `c-${Date.now()}`;
    const perms    = permissions ?? DEFAULT_PERMISSIONS;

    const [result] = await pool.execute(
      `INSERT INTO users
         (name, email, password, role, client_id, mobile, company, integration_type, permissions, status)
       VALUES (?, ?, ?, 'client', ?, ?, ?, ?, ?, ?)`,
      [
        name.trim(),
        email.trim().toLowerCase(),
        hash,
        clientId,
        mobile  || null,
        company || null,
        integration_type || 'none',
        JSON.stringify(perms),
        status  || 'Active',
      ]
    );

    const [rows] = await pool.execute(
      `SELECT id, name, email, mobile, company, client_id,
              integration_type, permissions, status, created_at
       FROM users WHERE id = ?`,
      [result.insertId]
    );

    return res.status(201).json({
      ...rows[0],
      permissions:    parsePerms(rows[0].permissions),
      zoho_connected: false,
      qbo_connected:  false,
      xero_connected: false,
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ error: 'A user with this email already exists' });
    console.error('POST /api/clients:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── PUT /api/clients/:id ──────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { name, email, mobile, company, status, integration_type, permissions, password } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name and email required' });

    // Password is optional on update — only changed when a non-empty value is sent.
    const changePassword = typeof password === 'string' && password.length > 0;
    if (changePassword && password.length < 4)
      return res.status(400).json({ error: 'Password must be at least 4 characters' });

    const fields = [
      'name = ?', 'email = ?', 'mobile = ?', 'company = ?',
      'status = ?', 'integration_type = ?', 'permissions = ?',
    ];
    const params = [
      name.trim(),
      email.trim().toLowerCase(),
      mobile  || null,
      company || null,
      status  || 'Active',
      integration_type || 'none',
      JSON.stringify(permissions ?? []),
    ];

    if (changePassword) {
      fields.push('password = ?');
      params.push(await bcrypt.hash(password, 10));
    }

    params.push(req.params.id);

    const [result] = await pool.execute(
      `UPDATE users SET ${fields.join(', ')} WHERE id = ? AND role = 'client'`,
      params
    );

    if (result.affectedRows === 0)
      return res.status(404).json({ error: 'Client not found' });

    return res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ error: 'Email already in use' });
    console.error('PUT /api/clients:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/clients/:id ───────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const [result] = await pool.execute(
      `DELETE FROM users WHERE id = ? AND role = 'client'`,
      [req.params.id]
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ error: 'Client not found' });
    return res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/clients:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/clients/:id/connect-zoho ───────────────────────────────────────
// Admin initiates Zoho OAuth on behalf of a client.
// Returns the Zoho OAuth consent URL directly — no BACKEND_URL redirect hop.
// The client JWT is embedded in the OAuth 'state' param so the callback can
// attribute the tokens to the correct client user, not the admin.
router.post('/:id/connect-zoho', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, email, role, client_id FROM users WHERE id = ? AND role = 'client'`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });

    // Short-lived JWT for the CLIENT — becomes the OAuth 'state' parameter.
    const clientToken = jwt.sign(
      { id: rows[0].id, email: rows[0].email, role: rows[0].role, client_id: rows[0].client_id },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Build the Zoho OAuth consent URL directly using server env vars.
    // This avoids the BACKEND_URL redirect that fails in production because
    // BACKEND_URL=localhost:5001 is unreachable from the user's browser.
    const scopes = [
      'ZohoBooks.fullaccess.all',
      'ZohoBooks.settings.READ',
      'ZohoBooks.contacts.READ',
      'ZohoBooks.invoices.READ',
      'ZohoBooks.expenses.READ',
      'ZohoBooks.reports.READ',
    ].join(',');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     process.env.ZOHO_CLIENT_ID,
      scope:         scopes,
      redirect_uri:  process.env.ZOHO_REDIRECT_URI,  // always from server env
      access_type:   'offline',
      prompt:        'consent',
      state:         clientToken,                     // client JWT travels through OAuth
    });

    const url = `${process.env.ZOHO_ACCOUNTS_URL}/auth?${params.toString()}`;

    return res.json({ url, clientToken });
  } catch (err) {
    console.error('connect-zoho:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/clients/:id/disconnect-zoho ────────────────────────────────────
router.post('/:id/disconnect-zoho', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT access_token, refresh_token FROM zb_tokens WHERE user_id = ?`,
      [req.params.id]
    );

    if (rows.length > 0) {
      const REVOKE_URL = `${process.env.ZOHO_ACCOUNTS_URL}/token/revoke`;
      const revoke = async (token) => {
        if (!token) return;
        try { await axios.post(REVOKE_URL, null, { params: { token } }); } catch {}
      };
      await Promise.all([revoke(rows[0].access_token), revoke(rows[0].refresh_token)]);
    }

    await pool.execute(`DELETE FROM zb_tokens WHERE user_id = ?`, [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('disconnect-zoho:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/clients/:id/connect-quickbooks ─────────────────────────────────
// Admin initiates QBO OAuth on behalf of a client.
router.post('/:id/connect-quickbooks', async (req, res) => {
  try {
    if (!process.env.QBO_CLIENT_ID) {
      return res.status(503).json({ error: 'QuickBooks not configured on the server' });
    }
    const [rows] = await pool.execute(
      `SELECT id, email, role, client_id FROM users WHERE id = ? AND role = 'client'`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });

    const clientToken = jwt.sign(
      { id: rows[0].id, email: rows[0].email, role: rows[0].role, client_id: rows[0].client_id },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    const params = new URLSearchParams({
      client_id:     process.env.QBO_CLIENT_ID,
      response_type: 'code',
      scope:         process.env.QBO_SCOPES || 'com.intuit.quickbooks.accounting',
      redirect_uri:  process.env.QBO_REDIRECT_URI,
      state:         clientToken,
    });

    const url = `${QBO_AUTH_URL}?${params.toString()}`;
    return res.json({ url, clientToken });
  } catch (err) {
    console.error('connect-quickbooks:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/clients/:id/connect-xero ────────────────────────────────────────
router.post('/:id/connect-xero', async (req, res) => {
  try {
    if (!process.env.XERO_CLIENT_ID) {
      return res.status(503).json({ error: 'Xero not configured on the server' });
    }
    const [rows] = await pool.execute(
      `SELECT id, email, role, client_id FROM users WHERE id = ? AND role = 'client'`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });

    const clientToken = jwt.sign(
      { id: rows[0].id, email: rows[0].email, role: rows[0].role, client_id: rows[0].client_id },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     process.env.XERO_CLIENT_ID,
      redirect_uri:  process.env.XERO_REDIRECT_URI,
      scope:         process.env.XERO_SCOPES || 'openid profile email accounting.transactions accounting.contacts accounting.settings accounting.reports.read offline_access',
      state:         clientToken,
    });

    const url = `${XERO_AUTH_URL}?${params.toString()}`;
    return res.json({ url, clientToken });
  } catch (err) {
    console.error('connect-xero:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/clients/:id/disconnect-xero ─────────────────────────────────────
router.post('/:id/disconnect-xero', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT refresh_token FROM xero_tokens WHERE user_id = ?`,
      [req.params.id]
    );
    if (rows.length > 0) {
      await xeroRevokeToken(rows[0].refresh_token);
    }
    await pool.execute(`DELETE FROM xero_tokens WHERE user_id = ?`, [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('disconnect-xero:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/clients/:id/disconnect-quickbooks ──────────────────────────────
router.post('/:id/disconnect-quickbooks', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT access_token, refresh_token FROM qbo_tokens WHERE user_id = ?`,
      [req.params.id]
    );
    if (rows.length > 0) {
      await Promise.all([
        qboRevokeToken(rows[0].access_token),
        qboRevokeToken(rows[0].refresh_token),
      ]);
    }
    await pool.execute(`DELETE FROM qbo_tokens WHERE user_id = ?`, [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('disconnect-quickbooks:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
