'use strict';
const { Router } = require('express');
const crypto     = require('crypto');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const axios      = require('axios');
const pool       = require('../config/db');
const auth       = require('../middleware/auth');
const { syncAllZohoData, getValidToken } = require('../services/zohoService');
const { syncAllZohoBooksWarehouse, syncAllOrgsForUser } = require('../services/zohoBooksWarehouseService');
const {
  QBO_AUTH_URL,
  QBO_TOKEN_URL,
  exchangeCodeForTokens: qboExchangeCode,
  refreshQBOToken: qboRefreshToken,
  revokeToken:     qboRevokeToken,
  fetchCompanyInfo: qboFetchCompanyInfo,
  getEffectiveQBUserId,
  syncAllQBOData,
} = require('../services/quickbooksService');
const { ingestForUser } = require('../services/accountingLedgerService');
const { tableExists } = require('../utils/tableExists');

// Fire-and-forget: (re)build the provider-agnostic double-entry ledger
// (acc_journal/acc_journal_lines) after an OAuth sync. Uses a wide default
// window so historical transactions are captured; failures never block OAuth.
function triggerLedgerIngest(userId, orgId = null) {
  const today = new Date();
  const to    = today.toISOString().slice(0, 10);
  const from  = `${today.getFullYear() - 2}-01-01`;
  setTimeout(() => {
    (async () => {
      // Accounting-engine tables (acc_journal/acc_connections/…) are optional.
      // On reduced-schema deployments the ledger stays in account_transactions,
      // so skip the ingest silently instead of erroring on every OAuth connect.
      if (!(await tableExists('acc_journal'))) return;
      return ingestForUser(userId, orgId, { from, to });
    })().catch((e) =>
      console.error('[acc-ledger] OAuth-triggered ingest failed:', e.message)
    );
  }, 8000); // small delay so the warehouse sync has a head start
}
const {
  XERO_AUTH_URL,
  exchangeCodeForTokens: xeroExchangeCode,
  refreshXeroToken:      xeroRefreshToken,
  revokeToken:           xeroRevokeToken,
  fetchTenants:          xeroFetchTenants,
  fetchOrganisation:     xeroFetchOrg,
  getEffectiveXeroUserId,
  getValidXeroToken,
  syncAllXeroData,
} = require('../services/xeroService');

const router = Router();

// ── Zoho org helpers ──────────────────────────────────────────────────────────
// Fetch ALL organizations available to the authorising Zoho account and upsert
// each one into zb_oauth_organizations (so the user can pick from the full list).
// Returns the raw orgs array from Zoho ([] on failure).
async function fetchAndStoreZohoOrgs(targetUserId, accessToken) {
  let orgs = [];
  try {
    const orgRes = await axios.get(`${process.env.ZOHO_API_BASE}/organizations`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    orgs = orgRes.data?.organizations ?? [];
  } catch (e) {
    console.warn('Could not fetch Zoho organisations:', e.message);
    return [];
  }
  // Persist the full set of organizations with their metadata so the user can
  // switch between them from the navbar. The relationship (user_id, org_id) is
  // upserted for every org returned by Zoho.
  for (const o of orgs) {
    if (!o?.organization_id) continue;
    await pool.execute(
      `INSERT INTO zb_oauth_organizations
         (user_id, org_id, org_name, currency, fiscal_year_start, time_zone)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         org_name          = VALUES(org_name),
         currency          = VALUES(currency),
         fiscal_year_start = VALUES(fiscal_year_start),
         time_zone         = VALUES(time_zone),
         updated_at        = NOW()`,
      [
        targetUserId,
        o.organization_id,
        o.name ?? null,
        o.currency_code ?? null,
        o.fiscal_year_start_month ?? o.fiscal_year_start ?? null,
        o.time_zone ?? null,
      ]
    );
  }
  return orgs;
}

// Fire-and-forget: sync Zoho data + warehouse for a single org.
function triggerZohoSync(userId, accessToken, orgId, { isFresh = false } = {}) {
  syncAllZohoData(userId, accessToken, orgId).catch((e) =>
    console.error('Background sync failed:', e.message)
  );
  syncAllZohoBooksWarehouse(userId, accessToken, orgId, {
    triggerSource: 'oauth',
    full: isFresh,        // fresh OAuth → priority modules only, clears watermarks
  }).catch((e) =>
    console.error('[ZB Warehouse] OAuth-triggered sync failed:', e.message)
  );
  triggerLedgerIngest(userId, orgId);
}

// Eager multi-org sync: when an account exposes several organizations we sync
// every one of them (the warehouse + legacy tables are org-scoped) so the user
// can switch instantly without waiting for data. Runs sequentially in the
// background to avoid hammering Zoho's rate limits.
function triggerZohoSyncAllOrgs(userId, accessToken, orgs, { isFresh = false } = {}) {
  (async () => {
    // Warehouse first, across ALL orgs, via the shared rate-limit-aware
    // orchestrator (stops early on Zoho's daily quota and resumes from the
    // watermark on the next cron run) so downstream ledger ingest sees fresh data.
    try {
      await syncAllOrgsForUser(userId, { triggerSource: 'oauth', full: isFresh });
    } catch (e) {
      console.error('[ZB Warehouse] OAuth multi-org sync failed:', e.message);
    }
    // Legacy shared-table sync + ledger ingest per org (non-warehouse paths).
    for (const o of orgs) {
      const orgId = o?.organization_id;
      if (!orgId) continue;
      try {
        await syncAllZohoData(userId, accessToken, orgId);
      } catch (e) {
        console.error(`Background sync failed (org=${orgId}):`, e.message);
      }
      triggerLedgerIngest(userId, orgId);
    }
  })();
}

// ── GET /api/auth/zoho/start ───────────────────────────────────────────────────
// Browser redirect entry point for Zoho OAuth.
// The frontend redirects here (passing the user's JWT as ?token=).
// This endpoint builds the correct auth URL using ZOHO_REDIRECT_URI from the
// SERVER environment (never the frontend build), then redirects the browser to
// Zoho's consent screen.  Works identically in dev and production.
//
// Issue #1 fix: redirect_uri is always taken from process.env — never baked
//               into the frontend bundle.
// Issue #2 fix: prompt=consent forces the Zoho consent screen even when the
//               user is already logged into Zoho in another tab.
router.get('/zoho/start', (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.redirect(
      `${process.env.FRONTEND_URL}/auth/zoho/callback?status=error&message=Missing+token`
    );
  }

  // Validate the JWT — if invalid, reject early rather than leaking to Zoho
  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.redirect(
      `${process.env.FRONTEND_URL}/auth/zoho/callback?status=error&message=Invalid+session`
    );
  }

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
    redirect_uri:  process.env.ZOHO_REDIRECT_URI,   // always from server env
    access_type:   'offline',                         // get a refresh_token
    prompt:        'consent',                         // always show consent screen
    state:         token,                             // carry JWT through OAuth
  });

  const authURL = `${process.env.ZOHO_ACCOUNTS_URL}/auth?${params.toString()}`;
  return res.redirect(authURL);
});

// ── POST /api/auth/login ───────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required' });

    const [rows] = await pool.execute(
      'SELECT * FROM users WHERE email = ?',
      [email.trim().toLowerCase()]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, client_id: user.client_id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Parse permissions JSON if stored as a string (MySQL JSON columns can return
    // either a parsed object or a raw string depending on the driver version).
    let permissions = null;
    if (user.permissions) {
      permissions = typeof user.permissions === 'string'
        ? JSON.parse(user.permissions)
        : user.permissions;
    }

    return res.json({
      token,
      id:          `u-${user.id}`,
      name:        user.name,
      email:       user.email,
      role:        user.role,
      clientId:    user.client_id,
      createdAt:   user.created_at,
      permissions, // array like ['Dashboard','Reports','AI Analytics','Profile'] or null
      integrationType: user.integration_type || 'none', // zoho | quickbooks | xero | none — scopes the Reports sidebar for clients
    });
  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/forgot-password ────────────────────────────────────────────
// Generates a single-use, time-limited reset token. Responds with a generic
// success message regardless of whether the email exists (no account
// enumeration). No mailer is configured, so in non-production the raw token +
// reset link are returned in the response so the flow can be completed; in
// production wire an email transport here and stop returning the token.
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

router.post('/forgot-password', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const generic = { message: 'If an account exists for that email, a password reset link has been sent.' };

    const [rows] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    const user = rows[0];
    if (!user) return res.json(generic);

    // One active token per user: clear any previous unused ones first.
    await pool.execute('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', [user.id]);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(rawToken);
    // Valid for 1 hour.
    await pool.execute(
      'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))',
      [user.id, tokenHash]
    );

    const base = (process.env.FRONTEND_URL || 'http://localhost:5174').replace(/\/+$/, '');
    const resetLink = `${base}/reset-password?token=${rawToken}`;

    // TODO: send `resetLink` to `email` via your email provider in production.
    const payload = { ...generic };
    if (process.env.NODE_ENV !== 'production') {
      payload.resetToken = rawToken;
      payload.resetLink = resetLink;
    }
    return res.json(payload);
  } catch (err) {
    console.error('Forgot-password error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
// Consumes a valid, unexpired, unused token and sets the new password.
router.post('/reset-password', async (req, res) => {
  try {
    const { token } = req.body || {};
    const password = req.body?.password;
    if (!token || !password)
      return res.status(400).json({ error: 'Token and new password are required' });
    if (String(password).length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const tokenHash = sha256(String(token));
    const [rows] = await pool.execute(
      'SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1',
      [tokenHash]
    );
    const reset = rows[0];
    if (!reset) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const hash = await bcrypt.hash(String(password), 10);
    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hash, reset.user_id]);
    // Burn this token and any other outstanding ones for the user.
    await pool.execute('UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [reset.user_id]);

    return res.json({ message: 'Password has been reset. You can now sign in with your new password.' });
  } catch (err) {
    console.error('Reset-password error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/zoho/exchange ──────────────────────────────────────────────
router.post('/zoho/exchange', auth, async (req, res) => {
  const { code, redirect_uri, state } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });

  // If a 'state' JWT is provided it means the admin is connecting Zoho on behalf
  // of a client. Use that JWT's user ID as the target instead of the admin's.
  let targetUserId = req.user.id;
  if (state) {
    try {
      const decoded = jwt.verify(state, process.env.JWT_SECRET);
      if (decoded?.id) targetUserId = decoded.id;
    } catch { /* invalid state JWT — fall back to authenticated user */ }
  }

  try {
    const params = new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      redirect_uri:  redirect_uri || process.env.ZOHO_REDIRECT_URI,
      code,
    });

    const tokenRes = await axios.post(
      `${process.env.ZOHO_ACCOUNTS_URL}/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    if (!access_token)
      throw new Error(tokenRes.data.error || 'No access_token from Zoho');

    const expires_at = Date.now() + (expires_in ?? 3600) * 1000;

    const orgs = await fetchAndStoreZohoOrgs(targetUserId, access_token);

    // Default active org = the first org Zoho returns (kept if one was already
    // active). The user can switch via the navbar dropdown afterwards. We store
    // ALL organizations and eagerly sync each so switching is instant.
    const organizationId = orgs[0]?.organization_id ?? process.env.ZOHO_ORG_ID ?? null;

    await pool.execute(
      `INSERT INTO zb_tokens (user_id, access_token, refresh_token, expires_at, org_id)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token  = VALUES(access_token),
         refresh_token = IF(VALUES(refresh_token) IS NULL, refresh_token, VALUES(refresh_token)),
         expires_at    = VALUES(expires_at),
         org_id        = VALUES(org_id),
         updated_at    = NOW()`,
      [targetUserId, access_token, refresh_token ?? null, expires_at, organizationId]
    );

    if (orgs.length > 0) triggerZohoSyncAllOrgs(targetUserId, access_token, orgs, { isFresh: true });
    else if (organizationId) triggerZohoSync(targetUserId, access_token, organizationId, { isFresh: true });

    return res.json({
      success: true,
      organizationId,
      organizations: orgs.map((o) => ({ org_id: o.organization_id, name: o.name, currency: o.currency_code })),
      access_token,
      expires_at,
    });
  } catch (err) {
    console.error('Zoho exchange error:', err.message);
    return res.status(500).json({ error: err.message || 'Token exchange failed' });
  }
});

// ── POST /api/auth/zoho/save ───────────────────────────────────────────────────
router.post('/zoho/save', auth, async (req, res) => {
  try {
    const { access_token, refresh_token, expires_in } = req.body;
    if (!access_token) return res.status(400).json({ error: 'access_token required' });

    const expires_at = Date.now() + (expires_in ?? 3600) * 1000;

    const orgs = await fetchAndStoreZohoOrgs(req.user.id, access_token);

    const organizationId = orgs[0]?.organization_id ?? process.env.ZOHO_ORG_ID ?? null;

    await pool.execute(
      `INSERT INTO zb_tokens (user_id, access_token, refresh_token, expires_at, org_id)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token  = VALUES(access_token),
         refresh_token = IF(VALUES(refresh_token) IS NULL, refresh_token, VALUES(refresh_token)),
         expires_at    = VALUES(expires_at),
         org_id        = VALUES(org_id),
         updated_at    = NOW()`,
      [req.user.id, access_token, refresh_token ?? null, expires_at, organizationId]
    );

    if (orgs.length > 0) triggerZohoSyncAllOrgs(req.user.id, access_token, orgs, { isFresh: true });
    else if (organizationId) triggerZohoSync(req.user.id, access_token, organizationId, { isFresh: true });

    return res.json({
      success: true,
      organizationId,
      organizations: orgs.map((o) => ({ org_id: o.organization_id, name: o.name, currency: o.currency_code })),
    });
  } catch (err) {
    console.error('Zoho save error:', err.message);
    return res.status(500).json({ error: 'Failed to save Zoho connection' });
  }
});

// ── GET /api/auth/zoho/status ──────────────────────────────────────────────────
// Clients with integration_type='zoho' inherit the admin's Zoho connection
// (same model as QB / Xero status endpoints).
router.get('/zoho/status', auth, async (req, res) => {
  try {
    const [own] = await pool.execute(
      'SELECT user_id, org_id, connected_at, expires_at FROM zb_tokens WHERE user_id = ?',
      [req.user.id]
    );
    let tok = own[0];
    let managedByAdmin = false;

    if (!tok) {
      const [u] = await pool.execute(
        'SELECT role, integration_type FROM users WHERE id = ? LIMIT 1',
        [req.user.id]
      );
      if (u[0]?.role === 'client' && u[0].integration_type === 'zoho') {
        const [admin] = await pool.execute(
          `SELECT t.user_id, t.org_id, t.connected_at, t.expires_at
             FROM users u
             JOIN zb_tokens t ON t.user_id = u.id
            WHERE u.role = 'admin'
            ORDER BY u.id ASC
            LIMIT 1`
        );
        if (admin[0]) { tok = admin[0]; managedByAdmin = true; }
      }
    }

    if (!tok) return res.json({ connected: false });

    const tokenExpired = tok.expires_at && Date.now() > Number(tok.expires_at);
    return res.json({
      connected:      !tokenExpired,
      organizationId: tok.org_id,
      connectedAt:    tok.connected_at,
      expiresAt:      tok.expires_at,
      managedByAdmin,
    });
  } catch (err) {
    console.error('Zoho status error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/zoho/disconnect ─────────────────────────────────────────────
router.post('/zoho/disconnect', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT access_token, refresh_token FROM zb_tokens WHERE user_id = ?',
      [req.user.id]
    );

    if (rows.length > 0) {
      const { access_token, refresh_token } = rows[0];
      const REVOKE_URL = `${process.env.ZOHO_ACCOUNTS_URL}/token/revoke`;
      const revokeToken = async (token) => {
        if (!token) return;
        try { await axios.post(REVOKE_URL, null, { params: { token } }); } catch {}
      };
      await Promise.all([revokeToken(access_token), revokeToken(refresh_token)]);
    }

    await pool.execute('DELETE FROM zb_tokens WHERE user_id = ?', [req.user.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Zoho disconnect error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/auth/zoho/callback — backend OAuth flow (server-side redirect) ────
router.get('/zoho/callback', async (req, res) => {
  const { code, state: stateParam, error: zohoError, error_description } = req.query;

  if (zohoError) {
    const msg = encodeURIComponent(error_description || zohoError);
    return res.redirect(`${process.env.FRONTEND_URL}/auth/zoho/callback?status=error&message=${msg}`);
  }
  if (!code) {
    return res.redirect(`${process.env.FRONTEND_URL}/auth/zoho/callback?status=error&message=No+authorization+code`);
  }

  try {
    const params = new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      redirect_uri:  process.env.ZOHO_REDIRECT_URI,
      code,
    });

    const tokenRes = await axios.post(
      `${process.env.ZOHO_ACCOUNTS_URL}/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    if (!access_token) throw new Error('No access_token in Zoho response');

    const expires_at = Date.now() + (expires_in ?? 3600) * 1000;

    let userId = null;
    if (stateParam) {
      try {
        const decoded = jwt.verify(stateParam, process.env.JWT_SECRET);
        userId = decoded.id;
      } catch {
        return res.redirect(`${process.env.FRONTEND_URL}/auth/zoho/callback?status=error&message=Invalid+state+parameter`);
      }
    }
    if (!userId) {
      return res.redirect(`${process.env.FRONTEND_URL}/auth/zoho/callback?status=error&message=Cannot+identify+user`);
    }

    const orgs = await fetchAndStoreZohoOrgs(userId, access_token);

    // Store all orgs, set the first as active, and eagerly sync every org so the
    // user can switch from the navbar dropdown without waiting.
    const organizationId = orgs[0]?.organization_id ?? process.env.ZOHO_ORG_ID ?? null;

    await pool.execute(
      `INSERT INTO zb_tokens (user_id, access_token, refresh_token, expires_at, org_id)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token  = VALUES(access_token),
         refresh_token = IF(VALUES(refresh_token) IS NULL, refresh_token, VALUES(refresh_token)),
         expires_at    = VALUES(expires_at),
         org_id        = VALUES(org_id),
         updated_at    = NOW()`,
      [userId, access_token, refresh_token ?? null, expires_at, organizationId]
    );

    if (orgs.length > 0) triggerZohoSyncAllOrgs(userId, access_token, orgs, { isFresh: true });
    else if (organizationId) triggerZohoSync(userId, access_token, organizationId, { isFresh: true });

    return res.redirect(
      `${process.env.FRONTEND_URL}/auth/zoho/callback?status=success&organizationId=${encodeURIComponent(organizationId ?? '')}`
    );
  } catch (err) {
    console.error('Zoho callback error:', err.message);
    return res.redirect(
      `${process.env.FRONTEND_URL}/auth/zoho/callback?status=error&message=${encodeURIComponent(err.message)}`
    );
  }
});

// ── POST /api/auth/zoho/refresh ────────────────────────────────────────────────
router.post('/zoho/refresh', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT refresh_token FROM zb_tokens WHERE user_id = ?',
      [req.user.id]
    );
    if (!rows[0]?.refresh_token)
      return res.status(400).json({ error: 'No refresh token stored' });

    const params = new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: rows[0].refresh_token,
    });

    const tokenRes = await axios.post(
      `${process.env.ZOHO_ACCOUNTS_URL}/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, expires_in } = tokenRes.data;
    if (!access_token) throw new Error('Refresh failed');

    const expires_at = Date.now() + (expires_in ?? 3600) * 1000;
    await pool.execute(
      'UPDATE zb_tokens SET access_token = ?, expires_at = ?, updated_at = NOW() WHERE user_id = ?',
      [access_token, expires_at, req.user.id]
    );

    return res.json({ access_token, expires_at });
  } catch (err) {
    console.error('Token refresh error:', err.message);
    return res.status(500).json({ error: 'Token refresh failed' });
  }
});

// ── GET /api/auth/zoho/organizations ──────────────────────────────────────────
// Lists the organizations available for the user to choose from (populated during
// OAuth). Supports admin-for-client via optional ?state= JWT, same as /exchange.
router.get('/zoho/organizations', auth, async (req, res) => {
  let targetUserId = req.user.id;
  const { state } = req.query;
  if (state) {
    try {
      const decoded = jwt.verify(state, process.env.JWT_SECRET);
      if (decoded?.id) targetUserId = decoded.id;
    } catch { /* invalid state JWT — fall back to authenticated user */ }
  }
  try {
    const [rows] = await pool.execute(
      `SELECT org_id, org_name, currency, time_zone, fiscal_year_start
         FROM zb_oauth_organizations
        WHERE user_id = ?
        ORDER BY org_name ASC`,
      [targetUserId]
    );
    // Normalize to a consistent shape that all clients (web + mobile) can rely on:
    // both organization_id and org_id are included so either field name works.
    const organizations = rows.map(o => ({
      organization_id: String(o.org_id),
      org_id:          String(o.org_id),
      name:            o.org_name ?? '',
      org_name:        o.org_name ?? '',
      currency_code:   o.currency ?? null,
      currency:        o.currency ?? null,
      time_zone:       o.time_zone ?? null,
      fiscal_year_start: o.fiscal_year_start ?? null,
    }));
    return res.json({ organizations });
  } catch (err) {
    console.error('Zoho organizations list error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/zoho/select-org ────────────────────────────────────────────
// Switches the active organization for the user. All orgs are kept and were
// eagerly synced at connect-time, so this only updates which org is "active".
// A best-effort incremental sync is kicked off so the chosen org is fresh.
router.post('/zoho/select-org', auth, async (req, res) => {
  // Accept orgId (preferred) or organization_id (fallback) so all clients work
  const orgId = req.body.orgId || req.body.organization_id || req.body.org_id;
  const { state } = req.body;
  if (!orgId) return res.status(400).json({ error: 'orgId is required' });

  let targetUserId = req.user.id;
  if (state) {
    try {
      const decoded = jwt.verify(state, process.env.JWT_SECRET);
      if (decoded?.id) targetUserId = decoded.id;
    } catch { /* invalid state JWT — fall back to authenticated user */ }
  }

  try {
    // Validate the org belongs to this user's available organizations.
    const [[org]] = await pool.execute(
      'SELECT org_id FROM zb_oauth_organizations WHERE user_id = ? AND org_id = ? LIMIT 1',
      [targetUserId, orgId]
    );
    if (!org) return res.status(400).json({ error: 'Organization not available for this account' });

    const [[tok]] = await pool.execute(
      'SELECT org_id FROM zb_tokens WHERE user_id = ? LIMIT 1',
      [targetUserId]
    );
    if (!tok) return res.status(400).json({ error: 'No Zoho token on file — reconnect required' });

    await pool.execute(
      'UPDATE zb_tokens SET org_id = ?, updated_at = NOW() WHERE user_id = ?',
      [orgId, targetUserId]
    );

    // Refresh the chosen org in the background (idempotent upserts; no deletes).
    const accessToken = await getValidToken(targetUserId);
    if (accessToken) triggerZohoSync(targetUserId, accessToken, orgId);

    return res.json({ success: true, organizationId: orgId });
  } catch (err) {
    console.error('Zoho select-org error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ╔════════════════════════════════════════════════════════════════════════════╗
// ║                       QUICKBOOKS ONLINE OAUTH ROUTES                       ║
// ╚════════════════════════════════════════════════════════════════════════════╝

// Helper: build the Intuit OAuth consent URL.
function buildQBOAuthURL(stateJwt) {
  const params = new URLSearchParams({
    client_id:     process.env.QBO_CLIENT_ID || '',
    response_type: 'code',
    scope:         process.env.QBO_SCOPES || 'com.intuit.quickbooks.accounting',
    redirect_uri:  process.env.QBO_REDIRECT_URI,
    state:         stateJwt,
  });
  return `${QBO_AUTH_URL}?${params.toString()}`;
}

// Each QuickBooks company is its own OAuth grant / qbo_tokens row (since
// db/multi-org-migration.sql). After connecting one, mark it the active company
// and clear the flag on the user's other realms. Guarded so it's a no-op on a
// deployment where the is_active column doesn't exist yet.
async function markQBORealmActive(userId, realmId) {
  try {
    await pool.execute(
      'UPDATE qbo_tokens SET is_active = IF(realm_id = ?, 1, 0), updated_at = NOW() WHERE user_id = ?',
      [String(realmId), userId]
    );
  } catch (_) { /* pre-migration schema — single realm, nothing to flip */ }
}

// ── GET /api/auth/quickbooks/start ────────────────────────────────────────────
// Browser redirect entry point for QBO OAuth. Frontend passes user JWT as ?token=.
router.get('/quickbooks/start', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.redirect(
      `${process.env.FRONTEND_URL}/auth/quickbooks/callback?status=error&message=Missing+token`
    );
  }
  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.redirect(
      `${process.env.FRONTEND_URL}/auth/quickbooks/callback?status=error&message=Invalid+session`
    );
  }
  if (!process.env.QBO_CLIENT_ID) {
    return res.redirect(
      `${process.env.FRONTEND_URL}/auth/quickbooks/callback?status=error&message=` +
      encodeURIComponent('QuickBooks not configured on the server (QBO_CLIENT_ID missing).')
    );
  }
  return res.redirect(buildQBOAuthURL(token));
});

// ── GET /api/auth/quickbooks/callback ─────────────────────────────────────────
// Intuit redirects here with ?code=&state=&realmId=  (or ?error=)
router.get('/quickbooks/callback', async (req, res) => {
  const { code, state: stateParam, realmId, error: qboError, error_description } = req.query;

  if (qboError) {
    const msg = encodeURIComponent(error_description || qboError);
    return res.redirect(`${process.env.FRONTEND_URL}/auth/quickbooks/callback?status=error&message=${msg}`);
  }
  if (!code || !realmId) {
    return res.redirect(
      `${process.env.FRONTEND_URL}/auth/quickbooks/callback?status=error&message=Missing+code+or+realmId`
    );
  }

  // Identify the user from the OAuth 'state' JWT (set in /quickbooks/start).
  let userId = null;
  if (stateParam) {
    try {
      const decoded = jwt.verify(stateParam, process.env.JWT_SECRET);
      userId = decoded.id;
    } catch {
      return res.redirect(
        `${process.env.FRONTEND_URL}/auth/quickbooks/callback?status=error&message=Invalid+state+parameter`
      );
    }
  }
  if (!userId) {
    return res.redirect(
      `${process.env.FRONTEND_URL}/auth/quickbooks/callback?status=error&message=Cannot+identify+user`
    );
  }

  try {
    const tokenData = await qboExchangeCode(code, process.env.QBO_REDIRECT_URI);
    const { access_token, refresh_token, expires_in } = tokenData;
    if (!access_token) throw new Error('No access_token from Intuit');

    const expires_at  = Date.now() + (expires_in ?? 3600) * 1000;
    const environment = process.env.QBO_ENV || 'sandbox';

    await pool.execute(
      `INSERT INTO qbo_tokens (user_id, access_token, refresh_token, expires_at, realm_id, environment)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token  = VALUES(access_token),
         refresh_token = IF(VALUES(refresh_token) IS NULL, refresh_token, VALUES(refresh_token)),
         expires_at    = VALUES(expires_at),
         realm_id      = VALUES(realm_id),
         environment   = VALUES(environment),
         updated_at    = NOW()`,
      [userId, access_token, refresh_token ?? null, expires_at, String(realmId), environment]
    );
    await markQBORealmActive(userId, realmId);

    // Fetch company info (best-effort) and store
    const info = await qboFetchCompanyInfo(access_token, realmId, environment);
    await pool.execute(
      `INSERT INTO qbo_organizations
         (user_id, realm_id, company_name, legal_name, country, currency, fiscal_year_start)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         company_name      = VALUES(company_name),
         legal_name        = VALUES(legal_name),
         country           = VALUES(country),
         currency          = VALUES(currency),
         fiscal_year_start = VALUES(fiscal_year_start),
         updated_at        = NOW()`,
      [
        userId, String(realmId),
        info.companyName || null, info.legalName || null,
        info.country     || null, info.currency  || null,
        info.fiscalYearStart || null,
      ]
    );

    // Kick off background sync (non-blocking)
    syncAllQBOData(userId, access_token, String(realmId), environment).catch((e) =>
      console.error('[QBO Background sync] failed:', e.message)
    );
    triggerLedgerIngest(userId);

    return res.redirect(
      `${process.env.FRONTEND_URL}/auth/quickbooks/callback?status=success&realmId=${encodeURIComponent(realmId)}`
    );
  } catch (err) {
    console.error('QBO callback error:', err.response?.data || err.message);
    const msg = encodeURIComponent(err.response?.data?.error_description || err.message);
    return res.redirect(`${process.env.FRONTEND_URL}/auth/quickbooks/callback?status=error&message=${msg}`);
  }
});

// ── POST /api/auth/quickbooks/exchange ────────────────────────────────────────
// Alternative: frontend posts {code, realmId, state?} after browser callback.
router.post('/quickbooks/exchange', auth, async (req, res) => {
  const { code, realmId, state, redirect_uri } = req.body;
  if (!code || !realmId) return res.status(400).json({ error: 'code and realmId required' });

  let targetUserId = req.user.id;
  if (state) {
    try {
      const decoded = jwt.verify(state, process.env.JWT_SECRET);
      if (decoded?.id) targetUserId = decoded.id;
    } catch { /* fall back to authed user */ }
  }

  try {
    const tokenData = await qboExchangeCode(code, redirect_uri || process.env.QBO_REDIRECT_URI);
    const { access_token, refresh_token, expires_in } = tokenData;
    if (!access_token) throw new Error('No access_token from Intuit');

    const expires_at  = Date.now() + (expires_in ?? 3600) * 1000;
    const environment = process.env.QBO_ENV || 'sandbox';

    await pool.execute(
      `INSERT INTO qbo_tokens (user_id, access_token, refresh_token, expires_at, realm_id, environment)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token  = VALUES(access_token),
         refresh_token = IF(VALUES(refresh_token) IS NULL, refresh_token, VALUES(refresh_token)),
         expires_at    = VALUES(expires_at),
         realm_id      = VALUES(realm_id),
         environment   = VALUES(environment),
         updated_at    = NOW()`,
      [targetUserId, access_token, refresh_token ?? null, expires_at, String(realmId), environment]
    );
    await markQBORealmActive(targetUserId, realmId);

    const info = await qboFetchCompanyInfo(access_token, realmId, environment);
    await pool.execute(
      `INSERT INTO qbo_organizations
         (user_id, realm_id, company_name, legal_name, country, currency, fiscal_year_start)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         company_name      = VALUES(company_name),
         legal_name        = VALUES(legal_name),
         country           = VALUES(country),
         currency          = VALUES(currency),
         fiscal_year_start = VALUES(fiscal_year_start),
         updated_at        = NOW()`,
      [
        targetUserId, String(realmId),
        info.companyName || null, info.legalName || null,
        info.country     || null, info.currency  || null,
        info.fiscalYearStart || null,
      ]
    );

    syncAllQBOData(targetUserId, access_token, String(realmId), environment).catch((e) =>
      console.error('[QBO Background sync] failed:', e.message)
    );
    triggerLedgerIngest(targetUserId);

    return res.json({ success: true, realmId: String(realmId), environment, expires_at });
  } catch (err) {
    console.error('QBO exchange error:', err.response?.data || err.message);
    return res.status(500).json({
      error: err.response?.data?.error_description || err.message || 'QBO token exchange failed',
    });
  }
});

// ── POST /api/auth/quickbooks/save ────────────────────────────────────────────
// Parity with /zoho/save — caller already has access_token + refresh_token + realmId.
router.post('/quickbooks/save', auth, async (req, res) => {
  try {
    const { access_token, refresh_token, expires_in, realm_id } = req.body;
    if (!access_token || !realm_id)
      return res.status(400).json({ error: 'access_token and realm_id required' });

    const expires_at  = Date.now() + (expires_in ?? 3600) * 1000;
    const environment = process.env.QBO_ENV || 'sandbox';

    await pool.execute(
      `INSERT INTO qbo_tokens (user_id, access_token, refresh_token, expires_at, realm_id, environment)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token  = VALUES(access_token),
         refresh_token = IF(VALUES(refresh_token) IS NULL, refresh_token, VALUES(refresh_token)),
         expires_at    = VALUES(expires_at),
         realm_id      = VALUES(realm_id),
         environment   = VALUES(environment),
         updated_at    = NOW()`,
      [req.user.id, access_token, refresh_token ?? null, expires_at, String(realm_id), environment]
    );
    await markQBORealmActive(req.user.id, realm_id);

    syncAllQBOData(req.user.id, access_token, String(realm_id), environment).catch((e) =>
      console.error('[QBO Background sync] failed:', e.message)
    );
    triggerLedgerIngest(req.user.id);

    return res.json({ success: true, realmId: String(realm_id), environment });
  } catch (err) {
    console.error('QBO save error:', err.message);
    return res.status(500).json({ error: 'Failed to save QuickBooks connection' });
  }
});

// ── GET /api/auth/quickbooks/status ───────────────────────────────────────────
// If the access token has expired but we still hold a valid refresh token,
// silently refresh it. Intuit refresh tokens last ~100 days, so users stay
// "connected" across days without re-running the OAuth dance.
router.get('/quickbooks/status', auth, async (req, res) => {
  try {
    // Clients with integration_type='quickbooks' inherit the admin's connection.
    const effectiveUserId = await getEffectiveQBUserId(req.user.id);

    const [rows] = await pool.execute(
      `SELECT user_id, realm_id, environment, connected_at, expires_at, refresh_token
       FROM qbo_tokens WHERE user_id = ?`,
      [effectiveUserId]
    );
    if (rows.length === 0) return res.json({ connected: false });

    const tok          = rows[0];
    const tokenExpired = tok.expires_at && Date.now() > Number(tok.expires_at);

    // Auto-refresh if access token lapsed but we have a refresh token.
    let effectiveExpiresAt = tok.expires_at;
    let stillConnected     = !tokenExpired;
    if (tokenExpired && tok.refresh_token) {
      try {
        // Refresh the token that actually owns the row (admin's row when client is inheriting).
        const fresh = await qboRefreshToken(tok.user_id, tok.refresh_token);
        effectiveExpiresAt = fresh.expires_at;
        stillConnected     = true;
      } catch (e) {
        console.warn('[QBO status] silent refresh failed:', e.response?.data || e.message);
        stillConnected = false;
      }
    }

    return res.json({
      connected:    stillConnected,
      realmId:      tok.realm_id,
      environment:  tok.environment,
      connectedAt:  tok.connected_at,
      expiresAt:    effectiveExpiresAt,
      // Lets the frontend distinguish "this is my own connection" vs "inherited from admin".
      managedByAdmin: tok.user_id !== req.user.id,
    });
  } catch (err) {
    console.error('QBO status error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/quickbooks/disconnect ──────────────────────────────────────
router.post('/quickbooks/disconnect', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT access_token, refresh_token FROM qbo_tokens WHERE user_id = ?',
      [req.user.id]
    );
    if (rows.length > 0) {
      const { access_token, refresh_token } = rows[0];
      await Promise.all([qboRevokeToken(access_token), qboRevokeToken(refresh_token)]);
    }
    await pool.execute('DELETE FROM qbo_tokens WHERE user_id = ?', [req.user.id]);
    await pool.execute('DELETE FROM qbo_organizations WHERE user_id = ?', [req.user.id])
      .catch(() => {});
    return res.json({ success: true });
  } catch (err) {
    console.error('QBO disconnect error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/auth/quickbooks/organizations ──────────────────────────────────
// Lists every QuickBooks company connected for this account. Until
// db/multi-org-migration.sql runs, qbo_tokens holds one row per user so this
// returns a single company — but the contract already matches /zoho/organizations
// so the frontend switcher needs no special-casing later.
router.get('/quickbooks/organizations', auth, async (req, res) => {
  let targetUserId = await getEffectiveQBUserId(req.user.id);
  const { state } = req.query;
  if (state) {
    try {
      const decoded = jwt.verify(state, process.env.JWT_SECRET);
      if (decoded?.id) targetUserId = await getEffectiveQBUserId(decoded.id);
    } catch { /* fall back */ }
  }
  try {
    let activeRealm = null;
    try {
      const [[row]] = await pool.execute(
        `SELECT realm_id FROM qbo_tokens WHERE user_id = ?
          ORDER BY COALESCE(is_active, 1) DESC, updated_at DESC LIMIT 1`,
        [targetUserId]
      );
      activeRealm = row?.realm_id || null;
    } catch (_) {
      const [[row]] = await pool.execute(
        'SELECT realm_id FROM qbo_tokens WHERE user_id = ? LIMIT 1', [targetUserId]
      );
      activeRealm = row?.realm_id || null;
    }
    const [rows] = await pool.execute(
      `SELECT realm_id, company_name, currency, country
         FROM qbo_organizations WHERE user_id = ? ORDER BY company_name ASC`,
      [targetUserId]
    );
    const organizations = rows.map((o) => ({
      organization_id: String(o.realm_id),
      org_id:          String(o.realm_id),
      realm_id:        String(o.realm_id),
      name:            o.company_name ?? '',
      org_name:        o.company_name ?? '',
      currency_code:   o.currency ?? null,
      currency:        o.currency ?? null,
      country:         o.country ?? null,
    }));
    return res.json({ organizations, activeOrgId: activeRealm ? String(activeRealm) : null });
  } catch (err) {
    console.error('QBO organizations list error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/quickbooks/select-org ────────────────────────────────────
// Flips the active QuickBooks company. Each realm has its own token pair, so
// this only moves the is_active flag (no-op before the multi-org migration,
// which is when a user can have more than one realm).
router.post('/quickbooks/select-org', auth, async (req, res) => {
  const realmId = req.body.orgId || req.body.realm_id || req.body.organization_id;
  const { state } = req.body;
  if (!realmId) return res.status(400).json({ error: 'orgId is required' });

  let targetUserId = await getEffectiveQBUserId(req.user.id);
  if (state) {
    try {
      const decoded = jwt.verify(state, process.env.JWT_SECRET);
      if (decoded?.id) targetUserId = await getEffectiveQBUserId(decoded.id);
    } catch { /* fall back */ }
  }

  try {
    const [[owned]] = await pool.execute(
      'SELECT realm_id FROM qbo_organizations WHERE user_id = ? AND realm_id = ? LIMIT 1',
      [targetUserId, String(realmId)]
    );
    if (!owned) return res.status(400).json({ error: 'Company not available for this account' });

    try {
      await pool.execute(
        'UPDATE qbo_tokens SET is_active = IF(realm_id = ?, 1, 0), updated_at = NOW() WHERE user_id = ?',
        [String(realmId), targetUserId]
      );
    } catch (_) {
      // Pre-migration: no is_active column and only one realm — nothing to flip.
    }
    return res.json({ success: true, realmId: String(realmId) });
  } catch (err) {
    console.error('QBO select-org error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ╔════════════════════════════════════════════════════════════════════════════╗
// ║                              XERO OAUTH ROUTES                             ║
// ╚════════════════════════════════════════════════════════════════════════════╝

function buildXeroAuthURL(stateJwt) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.XERO_CLIENT_ID || '',
    redirect_uri:  process.env.XERO_REDIRECT_URI,
    scope:         process.env.XERO_SCOPES || 'openid profile email accounting.transactions accounting.contacts accounting.settings accounting.reports.read offline_access',
    state:         stateJwt,
  });
  return `${XERO_AUTH_URL}?${params.toString()}`;
}

// One Xero OAuth grant covers every tenant the user authorised. Fetch the full
// list and upsert each ORGANISATION tenant into xero_organizations (the
// canonical "orgs list", mirrors fetchAndStoreZohoOrgs). Best-effort per-tenant
// metadata. Returns the ORGANISATION tenants ([] on failure).
async function fetchAndStoreXeroTenants(targetUserId, accessToken) {
  let tenants = [];
  try {
    tenants = (await xeroFetchTenants(accessToken)) || [];
  } catch (e) {
    console.warn('Could not fetch Xero connections:', e.message);
    return [];
  }
  const orgs = tenants.filter((t) => (t.tenantType || 'ORGANISATION') === 'ORGANISATION');
  for (const t of orgs) {
    if (!t?.tenantId) continue;
    let org = null;
    try { org = await xeroFetchOrg(accessToken, t.tenantId); } catch { /* best-effort */ }
    await pool.execute(
      `INSERT INTO xero_organizations
         (user_id, tenant_id, name, legal_name, short_code, country, currency,
          fiscal_year_end_month, organisation_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name                  = VALUES(name),
         legal_name            = VALUES(legal_name),
         short_code            = VALUES(short_code),
         country               = VALUES(country),
         currency              = VALUES(currency),
         fiscal_year_end_month = VALUES(fiscal_year_end_month),
         organisation_type     = VALUES(organisation_type),
         updated_at            = NOW()`,
      [
        targetUserId, t.tenantId,
        org?.Name || t.tenantName || null,
        org?.LegalName || null, org?.ShortCode || null,
        org?.CountryCode || null, org?.BaseCurrency || null,
        String(org?.FinancialYearEndMonth || ''),
        org?.OrganisationType || null,
      ]
    );
  }
  return orgs;
}

// Fire-and-forget: sync every connected Xero tenant sequentially (rate-limit
// friendly) after an OAuth connect.
function triggerXeroSyncAllTenants(userId, accessToken, orgs) {
  (async () => {
    for (const t of orgs) {
      if (!t?.tenantId) continue;
      try {
        await syncAllXeroData(userId, accessToken, t.tenantId);
      } catch (e) {
        console.error(`[Xero Background sync] failed (tenant=${t.tenantId}):`, e.message);
      }
    }
  })();
}

// ── GET /api/auth/xero/start ──────────────────────────────────────────────────
router.get('/xero/start', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.redirect(`${process.env.FRONTEND_URL}/auth/xero/callback?status=error&message=Missing+token`);
  }
  try {
    jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.redirect(`${process.env.FRONTEND_URL}/auth/xero/callback?status=error&message=Invalid+session`);
  }
  if (!process.env.XERO_CLIENT_ID) {
    return res.redirect(
      `${process.env.FRONTEND_URL}/auth/xero/callback?status=error&message=` +
      encodeURIComponent('Xero not configured on the server (XERO_CLIENT_ID missing).')
    );
  }
  return res.redirect(buildXeroAuthURL(token));
});

// ── GET /api/auth/xero/callback ───────────────────────────────────────────────
router.get('/xero/callback', async (req, res) => {
  const { code, state: stateParam, error: xeroError, error_description } = req.query;

  if (xeroError) {
    const msg = encodeURIComponent(error_description || xeroError);
    return res.redirect(`${process.env.FRONTEND_URL}/auth/xero/callback?status=error&message=${msg}`);
  }
  if (!code) {
    return res.redirect(`${process.env.FRONTEND_URL}/auth/xero/callback?status=error&message=Missing+code`);
  }

  let userId = null;
  if (stateParam) {
    try {
      const decoded = jwt.verify(stateParam, process.env.JWT_SECRET);
      userId = decoded.id;
    } catch {
      return res.redirect(`${process.env.FRONTEND_URL}/auth/xero/callback?status=error&message=Invalid+state+parameter`);
    }
  }
  if (!userId) {
    return res.redirect(`${process.env.FRONTEND_URL}/auth/xero/callback?status=error&message=Cannot+identify+user`);
  }

  try {
    const tokenData = await xeroExchangeCode(code, process.env.XERO_REDIRECT_URI);
    const { access_token, refresh_token, expires_in } = tokenData;
    if (!access_token) throw new Error('No access_token from Xero');

    const expires_at = Date.now() + (expires_in ?? 1800) * 1000;

    // Store EVERY tenant this grant authorised; keep the current active tenant
    // if it's still in the list, else default to the first.
    const orgs = await fetchAndStoreXeroTenants(userId, access_token);
    if (orgs.length === 0) throw new Error('No Xero tenant available for this user');

    const [[existing]] = await pool.execute(
      'SELECT tenant_id FROM xero_tokens WHERE user_id = ? LIMIT 1', [userId]
    );
    const keep = existing?.tenant_id && orgs.some((o) => o.tenantId === existing.tenant_id)
      ? existing.tenant_id : null;
    const active = orgs.find((o) => o.tenantId === keep) || orgs[0];
    const tenantId   = active.tenantId;
    const tenantName = active.tenantName || null;

    await pool.execute(
      `INSERT INTO xero_tokens (user_id, access_token, refresh_token, expires_at, tenant_id, tenant_name)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token  = VALUES(access_token),
         refresh_token = IF(VALUES(refresh_token) IS NULL, refresh_token, VALUES(refresh_token)),
         expires_at    = VALUES(expires_at),
         tenant_id     = VALUES(tenant_id),
         tenant_name   = VALUES(tenant_name),
         updated_at    = NOW()`,
      [userId, access_token, refresh_token ?? null, expires_at, tenantId, tenantName]
    );

    triggerXeroSyncAllTenants(userId, access_token, orgs);

    return res.redirect(
      `${process.env.FRONTEND_URL}/auth/xero/callback?status=success&tenantId=${encodeURIComponent(tenantId)}`
    );
  } catch (err) {
    console.error('Xero callback error:', err.response?.data || err.message);
    const msg = encodeURIComponent(err.response?.data?.error_description || err.message);
    return res.redirect(`${process.env.FRONTEND_URL}/auth/xero/callback?status=error&message=${msg}`);
  }
});

// ── POST /api/auth/xero/exchange ──────────────────────────────────────────────
router.post('/xero/exchange', auth, async (req, res) => {
  const { code, state, redirect_uri } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });

  let targetUserId = req.user.id;
  if (state) {
    try {
      const decoded = jwt.verify(state, process.env.JWT_SECRET);
      if (decoded?.id) targetUserId = decoded.id;
    } catch { /* fall through */ }
  }

  try {
    const tokenData = await xeroExchangeCode(code, redirect_uri || process.env.XERO_REDIRECT_URI);
    const { access_token, refresh_token, expires_in } = tokenData;
    if (!access_token) throw new Error('No access_token from Xero');
    const expires_at = Date.now() + (expires_in ?? 1800) * 1000;

    const orgs = await fetchAndStoreXeroTenants(targetUserId, access_token);
    if (orgs.length === 0) throw new Error('No Xero tenant available');

    const [[existing]] = await pool.execute(
      'SELECT tenant_id FROM xero_tokens WHERE user_id = ? LIMIT 1', [targetUserId]
    );
    const active = orgs.find((o) => o.tenantId === existing?.tenant_id) || orgs[0];

    await pool.execute(
      `INSERT INTO xero_tokens (user_id, access_token, refresh_token, expires_at, tenant_id, tenant_name)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token  = VALUES(access_token),
         refresh_token = IF(VALUES(refresh_token) IS NULL, refresh_token, VALUES(refresh_token)),
         expires_at    = VALUES(expires_at),
         tenant_id     = VALUES(tenant_id),
         tenant_name   = VALUES(tenant_name),
         updated_at    = NOW()`,
      [targetUserId, access_token, refresh_token ?? null, expires_at, active.tenantId, active.tenantName || null]
    );

    triggerXeroSyncAllTenants(targetUserId, access_token, orgs);

    return res.json({
      success: true,
      tenantId: active.tenantId,
      tenantName: active.tenantName,
      organizations: orgs.map((o) => ({ tenant_id: o.tenantId, name: o.tenantName })),
      expires_at,
    });
  } catch (err) {
    console.error('Xero exchange error:', err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data?.error_description || err.message });
  }
});

// ── POST /api/auth/xero/save ──────────────────────────────────────────────────
router.post('/xero/save', auth, async (req, res) => {
  try {
    const { access_token, refresh_token, expires_in, tenant_id, tenant_name } = req.body;
    if (!access_token || !tenant_id)
      return res.status(400).json({ error: 'access_token and tenant_id required' });

    const expires_at = Date.now() + (expires_in ?? 1800) * 1000;
    await pool.execute(
      `INSERT INTO xero_tokens (user_id, access_token, refresh_token, expires_at, tenant_id, tenant_name)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token  = VALUES(access_token),
         refresh_token = IF(VALUES(refresh_token) IS NULL, refresh_token, VALUES(refresh_token)),
         expires_at    = VALUES(expires_at),
         tenant_id     = VALUES(tenant_id),
         tenant_name   = VALUES(tenant_name),
         updated_at    = NOW()`,
      [req.user.id, access_token, refresh_token ?? null, expires_at, tenant_id, tenant_name ?? null]
    );

    syncAllXeroData(req.user.id, access_token, tenant_id).catch((e) =>
      console.error('[Xero Background sync] failed:', e.message)
    );

    return res.json({ success: true, tenantId: tenant_id });
  } catch (err) {
    console.error('Xero save error:', err.message);
    return res.status(500).json({ error: 'Failed to save Xero connection' });
  }
});

// ── GET /api/auth/xero/status ─────────────────────────────────────────────────
// Auto-refreshes expired access tokens via refresh_token (60-day window).
// Clients with integration_type='xero' inherit admin's connection via
// getEffectiveXeroUserId, returning managedByAdmin:true for context.
router.get('/xero/status', auth, async (req, res) => {
  try {
    const effectiveUserId = await getEffectiveXeroUserId(req.user.id);

    const [rows] = await pool.execute(
      `SELECT user_id, tenant_id, tenant_name, connected_at, expires_at, refresh_token
       FROM xero_tokens WHERE user_id = ?`,
      [effectiveUserId]
    );
    if (rows.length === 0) return res.json({ connected: false });

    const tok          = rows[0];
    const tokenExpired = tok.expires_at && Date.now() > Number(tok.expires_at);

    let effectiveExpiresAt = tok.expires_at;
    let stillConnected     = !tokenExpired;
    if (tokenExpired && tok.refresh_token) {
      try {
        const fresh = await xeroRefreshToken(tok.user_id, tok.refresh_token);
        effectiveExpiresAt = fresh.expires_at;
        stillConnected     = true;
      } catch (e) {
        console.warn('[Xero status] silent refresh failed:', e.response?.data || e.message);
        stillConnected = false;
      }
    }

    return res.json({
      connected:      stillConnected,
      tenantId:       tok.tenant_id,
      tenantName:     tok.tenant_name,
      connectedAt:    tok.connected_at,
      expiresAt:      effectiveExpiresAt,
      managedByAdmin: tok.user_id !== req.user.id,
    });
  } catch (err) {
    console.error('Xero status error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/auth/xero/organizations ─────────────────────────────────────────
// Lists every Xero tenant available to the connected account (populated at
// connect-time). Mirrors /zoho/organizations. Honours admin-for-client via
// optional ?state= JWT.
router.get('/xero/organizations', auth, async (req, res) => {
  let targetUserId = await getEffectiveXeroUserId(req.user.id);
  const { state } = req.query;
  if (state) {
    try {
      const decoded = jwt.verify(state, process.env.JWT_SECRET);
      if (decoded?.id) targetUserId = await getEffectiveXeroUserId(decoded.id);
    } catch { /* fall back */ }
  }
  try {
    const [[activeRow]] = await pool.execute(
      'SELECT tenant_id FROM xero_tokens WHERE user_id = ? LIMIT 1', [targetUserId]
    );
    const [rows] = await pool.execute(
      `SELECT tenant_id, name, currency, country, short_code
         FROM xero_organizations WHERE user_id = ? ORDER BY name ASC`,
      [targetUserId]
    );
    const organizations = rows.map((o) => ({
      organization_id: String(o.tenant_id),
      org_id:          String(o.tenant_id),
      tenant_id:       String(o.tenant_id),
      name:            o.name ?? '',
      org_name:        o.name ?? '',
      currency_code:   o.currency ?? null,
      currency:        o.currency ?? null,
      country:         o.country ?? null,
    }));
    return res.json({ organizations, activeOrgId: activeRow?.tenant_id ? String(activeRow.tenant_id) : null });
  } catch (err) {
    console.error('Xero organizations list error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/xero/select-org ──────────────────────────────────────────
// Switches the active Xero tenant. All tenants share one token, so this only
// moves the xero_tokens.tenant_id pointer and kicks a best-effort sync.
router.post('/xero/select-org', auth, async (req, res) => {
  const tenantId = req.body.orgId || req.body.tenant_id || req.body.organization_id;
  const { state } = req.body;
  if (!tenantId) return res.status(400).json({ error: 'orgId is required' });

  let targetUserId = await getEffectiveXeroUserId(req.user.id);
  if (state) {
    try {
      const decoded = jwt.verify(state, process.env.JWT_SECRET);
      if (decoded?.id) targetUserId = await getEffectiveXeroUserId(decoded.id);
    } catch { /* fall back */ }
  }

  try {
    const [[owned]] = await pool.execute(
      'SELECT tenant_id, name FROM xero_organizations WHERE user_id = ? AND tenant_id = ? LIMIT 1',
      [targetUserId, String(tenantId)]
    );
    if (!owned) return res.status(400).json({ error: 'Organization not available for this account' });

    const [upd] = await pool.execute(
      'UPDATE xero_tokens SET tenant_id = ?, tenant_name = ?, updated_at = NOW() WHERE user_id = ?',
      [String(tenantId), owned.name || null, targetUserId]
    );
    if (!upd.affectedRows) return res.status(400).json({ error: 'No Xero token on file — reconnect required' });

    // Refresh the chosen tenant in the background (idempotent upserts).
    try {
      const tok = await getValidXeroToken(targetUserId, String(tenantId));
      if (tok?.accessToken) {
        syncAllXeroData(targetUserId, tok.accessToken, String(tenantId)).catch((e) =>
          console.error('[Xero select-org] background sync failed:', e.message)
        );
      }
    } catch (e) { console.warn('[Xero select-org] token unavailable for sync:', e.message); }

    return res.json({ success: true, tenantId: String(tenantId) });
  } catch (err) {
    console.error('Xero select-org error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/xero/disconnect ────────────────────────────────────────────
router.post('/xero/disconnect', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT refresh_token FROM xero_tokens WHERE user_id = ?',
      [req.user.id]
    );
    if (rows.length > 0) {
      await xeroRevokeToken(rows[0].refresh_token);
    }
    await pool.execute('DELETE FROM xero_tokens WHERE user_id = ?', [req.user.id]);
    await pool.execute('DELETE FROM xero_organizations WHERE user_id = ?', [req.user.id])
      .catch(() => {});
    return res.json({ success: true });
  } catch (err) {
    console.error('Xero disconnect error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/xero/refresh ───────────────────────────────────────────────
router.post('/xero/refresh', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT refresh_token FROM xero_tokens WHERE user_id = ?',
      [req.user.id]
    );
    if (!rows[0]?.refresh_token) return res.status(400).json({ error: 'No Xero refresh token stored' });
    const { access_token, expires_at } = await xeroRefreshToken(req.user.id, rows[0].refresh_token);
    return res.json({ access_token, expires_at });
  } catch (err) {
    console.error('Xero refresh error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Xero token refresh failed' });
  }
});

// ── POST /api/auth/quickbooks/refresh ─────────────────────────────────────────
router.post('/quickbooks/refresh', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT refresh_token FROM qbo_tokens WHERE user_id = ?',
      [req.user.id]
    );
    if (!rows[0]?.refresh_token)
      return res.status(400).json({ error: 'No QBO refresh token stored' });

    const { access_token, expires_at } = await qboRefreshToken(req.user.id, rows[0].refresh_token);
    return res.json({ access_token, expires_at });
  } catch (err) {
    console.error('QBO refresh error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'QBO token refresh failed' });
  }
});

module.exports = router;
