'use strict';

/**
 * /api/settings — per-platform report settings (Financial Year start month).
 *
 *   GET  /report   → the FY start month that applies to the caller, plus (for an
 *                    admin) the editable per-platform defaults.
 *   PUT  /report   → save it.  body { scope: 'admin' | 'own', platform, fyStartMonth }
 *                      scope 'admin' — admin only; the workspace default every
 *                                      client of that platform inherits.
 *                      scope 'own'   — the caller's override for their own
 *                                      connection (null fyStartMonth = inherit).
 *
 * Resolution when a report runs: client's own row → admin default row → April.
 */

const { Router } = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const {
  PLATFORMS, DEFAULTS,
  getReportSettings, setFyStartMonth, rowsForScope,
} = require('../services/reportSettingsService');

const router = Router();
router.use(auth);

// Which platform(s) the user has connected, in the app's provider precedence.
async function connectedPlatforms(userId) {
  const out = [];
  const probes = [
    ['zoho', 'SELECT 1 FROM zb_tokens WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1'],
    ['quickbooks', 'SELECT 1 FROM qbo_tokens WHERE user_id = ? AND realm_id IS NOT NULL LIMIT 1'],
    ['xero', 'SELECT 1 FROM xero_tokens WHERE user_id = ? AND tenant_id IS NOT NULL LIMIT 1'],
  ];
  for (const [name, sql] of probes) {
    try { const [[r]] = await pool.execute(sql, [userId]); if (r) out.push(name); }
    catch { /* table absent on this deployment */ }
  }
  return out;
}

router.get('/report', async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const mine = await connectedPlatforms(req.user.id);

    const body = {
      defaults: DEFAULTS,
      canEditAdmin: isAdmin,
      canEditOwn: mine.length > 0,
      myPlatforms: mine,
    };

    // Effective (resolved) FY month per platform for the caller.
    const effective = {};
    for (const p of PLATFORMS) effective[p] = await getReportSettings(req.user.id, p);
    body.effective = effective;

    if (isAdmin) {
      const adminRows = await rowsForScope(0);
      body.admin = {};
      for (const p of PLATFORMS) {
        const r = adminRows[p] || {};
        body.admin[p] = { fyStartMonth: r.fy_start_month != null ? Number(r.fy_start_month) : null };
      }
    } else {
      const ownRows = await rowsForScope(req.user.id);
      body.own = {};
      for (const p of mine) {
        const r = ownRows[p] || {};
        body.own[p] = { fyStartMonth: r.fy_start_month != null ? Number(r.fy_start_month) : null };
      }
    }

    return res.json(body);
  } catch (e) {
    console.error('[settings/report GET]', e.message);
    return res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.put('/report', async (req, res) => {
  try {
    const { scope, platform } = req.body || {};
    if (!PLATFORMS.includes(String(platform))) {
      return res.status(400).json({ error: 'platform must be zoho | quickbooks | xero' });
    }
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'fyStartMonth')) {
      return res.status(400).json({ error: 'fyStartMonth is required (1..12, or null to inherit)' });
    }
    const fyStartMonth = req.body.fyStartMonth;

    let scopeUserId;
    if (scope === 'admin') {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
      scopeUserId = 0;
    } else if (scope === 'own') {
      const mine = await connectedPlatforms(req.user.id);
      if (!mine.includes(String(platform))) {
        return res.status(403).json({ error: `You have no ${platform} connection` });
      }
      scopeUserId = req.user.id;
    } else {
      return res.status(400).json({ error: "scope must be 'admin' or 'own'" });
    }

    await setFyStartMonth(scopeUserId, platform, fyStartMonth, req.user.id);
    const effective = await getReportSettings(req.user.id, platform);
    return res.json({ ok: true, platform, scope, effective });
  } catch (e) {
    if (e.code === 'NO_TABLE') return res.status(503).json({ error: e.message });
    if (['BAD_PLATFORM', 'BAD_MONTH'].includes(e.code)) return res.status(400).json({ error: e.message });
    console.error('[settings/report PUT]', e.message);
    return res.status(500).json({ error: 'Failed to save settings' });
  }
});

module.exports = router;
