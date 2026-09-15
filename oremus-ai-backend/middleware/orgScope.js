'use strict';
const jwt  = require('jsonwebtoken');
const pool = require('../config/db');

// Resolves the active organization for the request and exposes it as
// `req.orgId`. Provider-agnostic: an org id here is a Zoho org_id, a QuickBooks
// realm_id or a Xero tenant_id. Never blocks the request — on any problem it
// leaves req.orgId null, which means "no org filtering" (preserves
// single-connection behaviour).
//
// Resolution order:
//   1. X-Org-Id header — validated against every org this user connected across
//      all three providers.
//   2. Fallback to the persisted active connection pointer:
//        Zoho → zb_tokens.org_id
//        QuickBooks → the qbo_tokens row flagged is_active (or the only row)
//        Xero → xero_tokens.tenant_id
//
// Read routes append `AND org_id = ?` only when req.orgId is set, so a user with
// a single connection and no header is unaffected.
module.exports = async function orgScope(req, _res, next) {
  req.orgId = null;
  try {
    let userId = req.user?.id;
    if (!userId) {
      const header = req.headers.authorization;
      if (header && header.startsWith('Bearer ')) {
        try {
          const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
          userId = payload?.id;
        } catch { /* invalid token — handled by the route's auth middleware */ }
      }
    }
    if (!userId) return next();

    const headerOrg = req.headers['x-org-id'];
    if (headerOrg) {
      const id = String(headerOrg);
      // Validate against whichever provider's org list contains it. Each query
      // is guarded so a reduced-schema deployment (missing a table) still works.
      const checks = [
        ['SELECT org_id AS v FROM zb_oauth_organizations WHERE user_id = ? AND org_id = ? LIMIT 1', [userId, id]],
        ['SELECT realm_id AS v FROM qbo_organizations WHERE user_id = ? AND realm_id = ? LIMIT 1', [userId, id]],
        ['SELECT tenant_id AS v FROM xero_organizations WHERE user_id = ? AND tenant_id = ? LIMIT 1', [userId, id]],
      ];
      for (const [sql, args] of checks) {
        try {
          const [[row]] = await pool.execute(sql, args);
          if (row?.v) { req.orgId = String(row.v); return next(); }
        } catch { /* table absent on this deployment — try the next provider */ }
      }
      // Header given but not recognised — ignore it and fall through to the
      // active pointer rather than scoping to an org the user doesn't own.
    }

    // Active connection pointer, provider precedence Zoho → QuickBooks → Xero.
    const [[zb]] = await pool.execute(
      'SELECT org_id FROM zb_tokens WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1',
      [userId]
    );
    if (zb?.org_id) { req.orgId = String(zb.org_id); return next(); }

    try {
      const [[qb]] = await pool.execute(
        `SELECT realm_id FROM qbo_tokens WHERE user_id = ? AND realm_id IS NOT NULL
          ORDER BY COALESCE(is_active, 1) DESC, updated_at DESC LIMIT 1`,
        [userId]
      );
      if (qb?.realm_id) { req.orgId = String(qb.realm_id); return next(); }
    } catch {
      const [[qb]] = await pool.execute(
        'SELECT realm_id FROM qbo_tokens WHERE user_id = ? AND realm_id IS NOT NULL LIMIT 1',
        [userId]
      );
      if (qb?.realm_id) { req.orgId = String(qb.realm_id); return next(); }
    }

    const [[xt]] = await pool.execute(
      'SELECT tenant_id FROM xero_tokens WHERE user_id = ? AND tenant_id IS NOT NULL LIMIT 1',
      [userId]
    );
    if (xt?.tenant_id) req.orgId = String(xt.tenant_id);
  } catch { /* never block the request on org resolution */ }
  return next();
};
