'use strict';
const pool = require('../config/db');

// Admin "view as client" — lets an admin inspect a single client's data through
// the normal data endpoints. When the authenticated user is an admin AND sends
// an `X-Client-Id` header pointing to a valid client account, this swaps
// `req.user.id` to that client so every downstream query (which keys on
// req.user.id) returns the client's data instead of the admin's.
//
// Security: a no-op for non-admins, so clients can NEVER impersonate anyone.
// The target id is validated to be a real `client` user before the swap.
//
// `req.orgId` is cleared so the dashboard re-resolves the client's own Zoho org
// from the client's token (instead of the admin's active org from orgScope).
//
// Must be mounted AFTER the `auth` middleware (req.user must already be set).
module.exports = async function adminClientView(req, _res, next) {
  try {
    if (req.user?.role !== 'admin') return next();

    const raw = req.headers['x-client-id'];
    if (!raw) return next();

    const clientId = parseInt(raw, 10);
    if (!Number.isInteger(clientId) || clientId <= 0) return next();
    if (clientId === req.user.id) return next();

    const [rows] = await pool.execute(
      `SELECT id FROM users WHERE id = ? AND role = 'client' LIMIT 1`,
      [clientId]
    );
    if (rows.length) {
      req.adminUserId = req.user.id;   // preserve admin's original user ID for fallback
      req.viewAsClientId = clientId;
      req.user = { ...req.user, id: clientId };
      req.orgId = null;   // re-resolve the client's own org downstream
    }
  } catch (_) {
    /* on any error, fall back to the admin's own data (no swap) */
  }
  return next();
};
