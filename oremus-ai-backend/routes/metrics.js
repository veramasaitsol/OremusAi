'use strict';

/**
 * /api/metrics — expanded Revenue / Profitability / Cash Flow metrics.
 * Figures are derived from the active provider's OWN reports (P&L / Balance
 * Sheet / Cash Flow) so they tie out exactly to Zoho / Xero / QuickBooks.
 * Multi-org: req.orgId (X-Org-Id via app-level orgScope) selects the company.
 */

const { Router } = require('express');
const crypto = require('crypto');
const auth = require('../middleware/auth');
const adminClientView = require('../middleware/adminClientView');
const { resolveProvider } = require('../services/accounting');
const cache = require('../utils/cache');
const metrics = require('../services/metricsService');

const router = Router();
router.use(auth);
// Admin "view as client" — honor X-Client-Id so metrics resolve the selected
// client's connection (same as the dashboard). Must run after auth.
router.use(adminClientView);

const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// Default range: trailing 30 days (matches dashboard default).
function getRange(query) {
  const to = query.to || new Date().toISOString().slice(0, 10);
  const from = query.from || (() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  })();
  return { from, to };
}

function getBasis(query) {
  const v = String(query.basis || query.accounting_basis || '').toLowerCase();
  return v === 'cash' ? 'cash' : 'accrual';
}
function basisReportParams(basis) {
  return basis === 'cash' ? { accounting_basis: 'cash', cash_based: true } : {};
}

// Build the report params shared by every endpoint. Both `from/to` (what the
// metrics service reads) and `from_date/to_date` (what Zoho/QB report APIs
// expect) are provided; customer_id/currency_id pass through to the provider.
function buildParams(req) {
  const { from, to } = getRange(req.query);
  const basis = getBasis(req.query);
  const params = {
    from, to,
    from_date: from, to_date: to,
    ...basisReportParams(basis),
  };
  if (req.query.customer_id) params.customer_id = String(req.query.customer_id);
  if (req.query.currency_id) params.currency_id = String(req.query.currency_id);
  return params;
}

function hashParams(params) {
  return crypto.createHash('sha1').update(JSON.stringify(params)).digest('hex').slice(0, 12);
}

// Soft response when the user has no live accounting connection — the frontend
// mock path takes over. 200 (not 4xx) keeps the dashboard from erroring.
function noConnection(ep, params) {
  const meta = {
    provider: null,
    basis: params.cash_based ? 'cash' : 'accrual',
    orgId: null,
    currency: null,
    source: 'none',
    from: params.from,
    to: params.to,
    warnings: ['No connected accounting provider.'],
  };
  return { data: null, _meta: meta };
}

function makeHandler(ep, fn) {
  return async (req, res) => {
    try {
      const params = buildParams(req);
      // LOCAL context only — provider/currency/org resolved from synced tables,
      // no live token refresh or report fetch (metrics compute from local data).
      let ctx = await metrics.resolveLocalCtx(req.user.id);
      // Fallback: if admin is viewing a client but resolveLocalCtx found nothing,
      // try the admin's own user ID (data may be synced under the admin).
      if (!ctx && req.adminUserId) {
        ctx = await metrics.resolveLocalCtx(req.adminUserId);
      }
      if (!ctx) return res.json(noConnection(ep, params));

      const key = `metrics:${ctx.provider}:${ctx.conn.connectionRef}:${ep}:${hashParams(params)}`;
      const cached = cache.get(key) !== undefined;
      const data = await cache.wrap(key, CACHE_TTL, () => fn(ctx, params, {}));
      if (data && data._meta) data._meta.cache = cached;
      return res.json({ data });
    } catch (err) {
      return res.status(500).json({ error: 'metrics_failed', message: err.message });
    }
  };
}

router.get('/revenue',       makeHandler('revenue',       metrics.getRevenueMetrics));
router.get('/profitability', makeHandler('profitability', metrics.getProfitabilityMetrics));
router.get('/cashflow',      makeHandler('cashflow',      metrics.getCashflowMetrics));

module.exports = router;
