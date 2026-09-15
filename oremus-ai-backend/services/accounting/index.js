'use strict';

/**
 * Accounting provider resolver.
 * ---------------------------------------------------------------------------
 * resolveProvider(userId, reqOrgId, fallbackUserId) inspects the user's connected
 * integrations (in the same precedence the dashboard uses: Zoho-live → QuickBooks
 * → Xero) and returns the first adapter that can resolve an active connection:
 *
 *   { provider, adapter, conn }
 *
 * When the primary userId has no connection, tries fallbackUserId (typically the
 * admin's ID when viewing as client via X-Client-Id header). This ensures admin
 * client-switching works even when the client relies on the admin's connection.
 *
 * Returns null when neither userId has a live accounting connection, so callers
 * can fall back (e.g. the frontend mock generator) with zero regression.
 *
 * Multi-org: the X-Org-Id header (resolved into req.orgId by orgScope) is passed
 * through as reqOrgId so the engine scopes to the active company.
 */

const QuickBooksProvider = require('./QuickBooksProvider');
const ZohoBooksProvider  = require('./ZohoBooksProvider');
const XeroProvider       = require('./XeroProvider');

const PROVIDERS = {
  quickbooks: new QuickBooksProvider(),
  zoho:       new ZohoBooksProvider(),
  xero:       new XeroProvider(),
};

// Detection precedence. Zoho is checked first only when an org is explicitly
// active (reqOrgId) OR the user has a Zoho token, matching dashboard behaviour.
const ORDER = ['zoho', 'quickbooks', 'xero'];

function getProvider(key) {
  return PROVIDERS[key] || null;
}

/**
 * Try to resolve a provider for a single userId.
 * Returns { provider, adapter, conn } or null.
 */
async function _tryResolve(userId, reqOrgId) {
  const order = reqOrgId ? ['zoho', 'quickbooks', 'xero'] : ORDER;
  for (const key of order) {
    const adapter = PROVIDERS[key];
    try {
      const conn = await adapter.resolveConnection(userId, reqOrgId);
      if (conn) return { provider: key, adapter, conn };
    } catch (_) { /* try next provider */ }
  }
  return null;
}

async function resolveProvider(userId, reqOrgId = null, fallbackUserId = null) {
  // When an org is explicitly selected, prefer Zoho (orgs are a Zoho concept).
  const result = await _tryResolve(userId, reqOrgId);
  if (result) return result;

  // Admin view-as-client fallback: the client may rely on the admin's connection
  // (e.g. client has integration_type='zoho' but no zb_tokens — the admin owns
  // the connection). Try the admin's userId before giving up.
  if (fallbackUserId && fallbackUserId !== userId) {
    const fbResult = await _tryResolve(fallbackUserId, reqOrgId);
    if (fbResult) return fbResult;
  }

  return null;
}

module.exports = { resolveProvider, getProvider, PROVIDERS };
