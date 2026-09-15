'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// /api/reports — provider-agnostic reporting facade (Phase 7 + 8 + 10).
//
// Exposes clean, stable, provider-neutral report slugs (profit-loss,
// balance-sheet, ar-aging, …) and dispatches to whichever provider engine backs
// the current user (Zoho today, QuickBooks where connected). Consumers never need
// to know the provider or its native report-type spelling. New providers slot in
// by adding a column to CANON — the facade contract stays fixed (Phase 10).
// ─────────────────────────────────────────────────────────────────────────────

const { Router } = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
// All reports are served from the synced database only (product rule: the
// website never calls a provider's report API at request time — providers are
// sync + OAuth only). Zoho runs off the ledger registry; QuickBooks runs off the
// DB-only accounting adapter (QuickBooksProvider).
const { fetchLedgerReport } = require('../services/zohoLedgerRegistry');
const { getEffectiveZohoUserId } = require('../services/zohoService');
const { resolveProvider: resolveAccountingConn } = require('../services/accounting');
const { getReportSettings } = require('../services/reportSettingsService');
const { resolveOrgId } = require('../services/reportContext');

const zohoLedgerEngine = {
  async fetchReport(userId, type, params = {}) {
    const effectiveUid = await getEffectiveZohoUserId(userId).catch(() => userId);
    return fetchLedgerReport(effectiveUid, type, params);
  },
};

// QuickBooks reports come from the DB-only provider adapter (account_transactions,
// scoped by realm_id) — never QBO's live Reports API.
const qboLedgerEngine = {
  async fetchReport(userId, type, params = {}) {
    const resolved = await resolveAccountingConn(userId, null);
    if (!resolved) { const e = new Error('No accounting connection'); e.code = 'NOT_CONNECTED'; throw e; }
    return resolved.adapter.fetchReport(resolved.conn, type, params);
  },
};

const router = Router();
router.use(auth);
router.use(require('../middleware/adminClientView')); // honor admin view-as-client (X-Client-Id)

// canonical slug → each provider's internal report type (null = not available)
const CANON = {
  'profit-loss':        { zoho: 'profitandloss',          quickbooks: 'profitandloss', xero: 'profitandloss' },
  'balance-sheet':      { zoho: 'balancesheet',           quickbooks: 'balancesheet', xero: 'balancesheet' },
  'cash-flow':          { zoho: 'cashflow',               quickbooks: 'cashflow', xero: 'cashflow' },
  'movement-of-equity': { zoho: 'movementofequity',       quickbooks: null },
  'trial-balance':      { zoho: 'trialbalance',           quickbooks: 'trialbalance', xero: 'trialbalance' },
  'general-ledger':     { zoho: 'generalledger',          quickbooks: 'generalledger', xero: 'generalledger' },
  'sales-by-customer':  { zoho: 'salesbycustomer',        quickbooks: null },
  'sales-by-item':      { zoho: 'salesbyitem',            quickbooks: null },
  'invoice-details':    { zoho: 'invoicedetails',         quickbooks: null },
  'customer-balance':   { zoho: 'customerbalancesummary', quickbooks: 'customerbalance' },
  'ar-aging':           { zoho: 'aragingsummary',         quickbooks: 'aragingsummary' },
  'ar-aging-detail':    { zoho: null,                     quickbooks: 'aragingdetail' },
  'vendor-balance':     { zoho: 'vendorbalancesummary',   quickbooks: 'vendorbalance' },
  'ap-aging':           { zoho: 'apagingsummary',         quickbooks: 'apagingsummary' },
  'ap-aging-detail':    { zoho: null,                     quickbooks: 'apagingdetail' },
  'bill-details':       { zoho: 'billdetails',            quickbooks: null },
  'tax-summary':        { zoho: 'taxsummary',             quickbooks: null },
  'inventory-summary':  { zoho: 'inventorysummary',       quickbooks: 'inventoryvaluationsummary' },
};

// Xero engine: uses the same DB-backed XeroProvider adapter as /accounting.
const xeroLedgerEngine = {
  async fetchReport(userId, type, params = {}, opts = {}) {
    const resolved = await resolveAccountingConn(userId, null, opts.adminUserId || null);
    if (!resolved || resolved.provider !== 'xero') {
      const e = new Error('No Xero connection'); e.code = 'NOT_CONNECTED'; throw e;
    }
    return resolved.adapter.fetchReport(resolved.conn, type, params, opts);
  },
};

const ENGINES = { zoho: zohoLedgerEngine, quickbooks: qboLedgerEngine, xero: xeroLedgerEngine };

async function resolveProvider(userId, fallbackUserId) {
  // Helper: detect provider for a given user ID
  const detect = async (uid) => {
    try {
      const [[u]] = await pool.execute('SELECT integration_type FROM users WHERE id = ?', [uid]);
      const t = (u?.integration_type || '').toLowerCase();
      if (t === 'quickbooks' || t === 'xero' || t === 'zoho') return t;
    } catch { /* fall through */ }
    const [[z]] = await pool.execute('SELECT 1 FROM zb_tokens WHERE user_id = ? LIMIT 1', [uid]);
    if (z) return 'zoho';
    const [[q]] = await pool.execute('SELECT 1 FROM qbo_tokens WHERE user_id = ? LIMIT 1', [uid]);
    if (q) return 'quickbooks';
    return null;
  };
  let p = await detect(userId);
  if (!p && fallbackUserId) p = await detect(fallbackUserId);
  return p || 'zoho';
}

// ── GET /api/reports ──────────────────────────────────────────────────────────
// Lists the canonical reports available for the current user's provider.
router.get('/', async (req, res) => {
  try {
    const provider = await resolveProvider(req.user.id, req.adminUserId || null);
    const available = Object.entries(CANON)
      .filter(([, m]) => m[provider])
      .map(([slug, m]) => ({ slug, provider, providerType: m[provider] }));
    return res.json({ provider, reports: available });
  } catch (e) {
    console.error('[reports list]', e.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/reports/meta/currencies ────────────────────────────────────────
// Distinct transaction currencies actually present in the active org's
// synced ledger, for the report viewer's currency filter dropdown. A
// single-currency org (the common case) gets back just its one currency —
// the dropdown then has nothing meaningful to filter, by design. A nested
// path (not "/:slug") so it can never collide with the canonical-report
// route below regardless of definition order.
router.get('/meta/currencies', async (req, res) => {
  try {
    const orgId = await resolveOrgId(req.user.id, { org_id: req.orgId });
    if (!orgId) return res.json({ currencies: [] });
    const [rows] = await pool.execute(
      `SELECT DISTINCT currency_code FROM account_transactions
        WHERE org_id = ? AND currency_code IS NOT NULL AND currency_code <> ''
        ORDER BY currency_code ASC`,
      [orgId]
    );
    return res.json({ currencies: rows.map((r) => r.currency_code) });
  } catch (e) {
    console.error('[reports currencies]', e.message);
    return res.json({ currencies: [] });
  }
});

// ── GET /api/reports/:slug ──────────────────────────────────────────────────
// Query: from, to, refresh, + any provider passthrough params.
router.get('/:slug', async (req, res) => {
  const { slug } = req.params;
  const map = CANON[slug];
  if (!map) {
    return res.status(404).json({ error: `Unknown report '${slug}'`, available: Object.keys(CANON) });
  }
  try {
    const provider = await resolveProvider(req.user.id, req.adminUserId || null);
    const engine = ENGINES[provider];
    const type = map[provider];
    if (!engine || !type) {
      return res.status(501).json({ error: `Report '${slug}' not available for provider '${provider}'` });
    }

    const { from, to, refresh, ...rest } = req.query;
    const params = { ...rest };
    if (from) params.from_date = from;
    if (to)   params.to_date = to;

    // Per-platform Financial Year start month (Settings → client override →
    // admin default → April).
    try {
      params.fy_start_month = (await getReportSettings(req.user.id, provider)).fyStartMonth;
    } catch { /* report_settings not present yet — builders default to April */ }

    const result = await engine.fetchReport(req.user.id, type, params, { refresh: refresh === 'true', adminUserId: req.adminUserId || null });
    return res.json({ slug, provider, providerType: type, ...result });
  } catch (e) {
    if (e.code === 'NOT_CONNECTED') return res.status(400).json({ error: e.message });
    if (e.code === 'UNKNOWN_REPORT_TYPE') return res.status(404).json({ error: e.message });
    console.error(`[reports ${slug}]`, e.message);
    return res.status(500).json({ error: 'Failed to fetch report' });
  }
});

module.exports = router;
