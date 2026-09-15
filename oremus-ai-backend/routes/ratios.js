'use strict';
const { Router } = require('express');
const pool       = require('../config/db');
const auth       = require('../middleware/auth');
const { getEffectiveQBUserId }   = require('../services/quickbooksService');
const { getEffectiveXeroUserId } = require('../services/xeroService');
const { getEffectiveZohoUserId } = require('../services/zohoService');
const { computeKeyRatios }       = require('../services/keyRatiosService');
const { getFyStartMonth }        = require('../services/reportSettingsService');
const { fyWindowsBack }          = require('../services/reportContext');

const router = Router();
router.use(auth);
router.use(require('../middleware/adminClientView')); // honor admin view-as-client (X-Client-Id)

function getDateRange(query) {
  const to   = query.to || new Date().toISOString().slice(0, 10);
  const from = query.from || (() => {
    const d = new Date(to);
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })();
  return { from, to };
}

// ── Platform detection ──────────────────────────────────────────────────────
// Identical across all three platforms: whichever provider the viewed client
// is actually connected to decides which ledger scope (org_id) the ratios are
// computed against — nothing here is specific to one platform's data shape.
async function detectPlatform(uid, reqOrgId) {
  let zohoUid = uid;
  try { zohoUid = await getEffectiveZohoUserId(uid); } catch (_) { zohoUid = uid; }
  let hasZoho = false, zohoOrgId = null;
  try {
    if (reqOrgId) {
      hasZoho = true; zohoOrgId = reqOrgId;
    } else {
      const [[tok]] = await pool.execute(
        'SELECT org_id FROM zb_tokens WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1',
        [zohoUid]
      );
      if (tok?.org_id) { hasZoho = true; zohoOrgId = tok.org_id; }
    }
  } catch (_) { /* no zoho */ }

  let qboUid = uid;
  try { qboUid = await getEffectiveQBUserId(uid); } catch (_) { qboUid = uid; }
  let hasQbo = false;
  try {
    const [[tok]] = await pool.execute('SELECT 1 FROM qbo_tokens WHERE user_id = ? LIMIT 1', [qboUid]);
    if (tok) hasQbo = true;
  } catch (_) { /* no qbo */ }

  let xeroUid = uid;
  try { xeroUid = await getEffectiveXeroUserId(uid); } catch (_) { xeroUid = uid; }
  let hasXero = false;
  try {
    const [[tok]] = await pool.execute('SELECT 1 FROM xero_tokens WHERE user_id = ? LIMIT 1', [xeroUid]);
    if (tok) hasXero = true;
  } catch (_) { /* no xero */ }

  let platform = 'zoho';
  if (hasQbo && !hasZoho) platform = 'quickbooks';
  else if (hasXero && !hasZoho && !hasQbo) platform = 'xero';

  return { platform, zohoUid, zohoOrgId, qboUid, xeroUid, hasZoho, hasQbo, hasXero };
}

// ── Resolve org_id for the canonical P&L/BS engines ─────────────────────────
//   Zoho   → zb_tokens.org_id (from the connected org)
//   Xero   → account_transactions.org_id (= tenant_id)
//   QBO    → qbo_tokens.realm_id
async function resolveOrgId(uid, platform, zohoOrgId) {
  if (zohoOrgId) return zohoOrgId;
  try {
    if (platform === 'xero') {
      const [[r]] = await pool.execute(
        'SELECT org_id FROM account_transactions WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1',
        [uid]
      );
      return r?.org_id || null;
    }
    if (platform === 'quickbooks') {
      const [[r]] = await pool.execute(
        'SELECT realm_id FROM qbo_tokens WHERE user_id = ? AND realm_id IS NOT NULL LIMIT 1',
        [uid]
      );
      return r?.realm_id || null;
    }
  } catch (_) { /* fall through */ }
  return null;
}

// ── Display currency — best-effort, per platform, never blocks the ratios ──
async function resolveCurrency(platform, effUid, orgId) {
  try {
    if (platform === 'zoho') {
      const [[o]] = await pool.execute(
        'SELECT currency FROM zb_oauth_organizations WHERE user_id = ? AND currency IS NOT NULL LIMIT 1',
        [effUid]
      );
      if (o?.currency) return o.currency;
    } else if (platform === 'quickbooks') {
      const [[o]] = await pool.execute(
        `SELECT currency FROM qbo_organizations WHERE user_id = ? AND currency REGEXP '^[A-Z]{3}$' LIMIT 1`,
        [effUid]
      );
      if (o?.currency) return o.currency;
    } else if (platform === 'xero') {
      const [[o]] = await pool.execute(
        'SELECT currency FROM xero_organizations WHERE user_id = ? AND tenant_id = ? LIMIT 1',
        [effUid, orgId]
      );
      if (o?.currency) return o.currency;
      const [[a]] = await pool.execute(
        'SELECT currency_code FROM xero_accounts WHERE user_id = ? AND tenant_id = ? AND currency_code IS NOT NULL LIMIT 1',
        [effUid, orgId]
      );
      if (a?.currency_code) return a.currency_code;
    }
  } catch (_) { /* fall through to default */ }
  return 'INR';
}

// Resolve the platform + effective user/org context shared by both routes.
async function resolveContext(req) {
  const uid = req.user.id;
  const reqOrgId = req.orgId || null;
  const plat = await detectPlatform(uid, reqOrgId);
  const { platform, zohoUid, zohoOrgId, qboUid, xeroUid } = plat;
  const effUid = platform === 'quickbooks' ? qboUid
               : platform === 'xero'       ? xeroUid
               : zohoUid || uid;
  const orgId = await resolveOrgId(effUid, platform, zohoOrgId);
  const fyStartMonth = await getFyStartMonth(uid, platform).catch(() => 4);
  return { uid, platform, effUid, orgId, fyStartMonth };
}

// ── GET / — ratios for one selected period (the existing Ratios page) ──────
router.get('/', async (req, res) => {
  try {
    const { from, to } = getDateRange(req.query);
    const { platform, effUid, orgId, fyStartMonth } = await resolveContext(req);
    const currency = await resolveCurrency(platform, effUid, orgId);

    const { ratios, raw } = await computeKeyRatios(effUid, orgId, platform, from, to, fyStartMonth);

    return res.json({
      data: { ...ratios, raw },
      provider: platform,
      currency,
    });
  } catch (err) {
    console.error('Ratios error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /fy-summary — the same ratios across the last N fiscal years ───────
router.get('/fy-summary', async (req, res) => {
  try {
    const count = Math.min(6, Math.max(1, parseInt(req.query.count, 10) || 3));
    const { platform, effUid, orgId, fyStartMonth } = await resolveContext(req);
    const currency = await resolveCurrency(platform, effUid, orgId);

    const windows = fyWindowsBack(fyStartMonth, count);
    const years = await Promise.all(windows.map(async ({ from, to, label }) => {
      const { ratios, raw } = await computeKeyRatios(effUid, orgId, platform, from, to, fyStartMonth);
      return { label, from, to, ratios, raw };
    }));

    return res.json({ provider: platform, currency, fyStartMonth, years });
  } catch (err) {
    console.error('Ratios fy-summary error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
