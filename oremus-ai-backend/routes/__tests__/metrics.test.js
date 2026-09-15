'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────
// Auth middleware → inject a fake user.
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = { id: 1 }; next(); });
// db pool → control warehouse breakdown rows.
jest.mock('../../config/db', () => ({ execute: jest.fn().mockResolvedValue([[]]) }));
// Provider resolver → fake adapter with per-org P&L fixtures.
jest.mock('../../services/accounting', () => ({ resolveProvider: jest.fn() }));
// Cache → bypass so each request runs the loader (no cross-test bleed).
jest.mock('../../utils/cache', () => ({ get: () => undefined, set: (_k, v) => v, wrap: (_k, _ttl, loader) => loader() }));

const express = require('supertest');
const http = require('express');
const { resolveProvider } = require('../../services/accounting');
const pool = require('../../config/db');
const metricsRouter = require('../metrics');

// Two Zoho orgs with different figures so X-Org-Id selection is observable.
const ORG_PL = {
  '60036297771': [
    { label: 'Total Income', isSubtotal: true, level: 0, cells: { amount: 1000 } },
    { label: 'Total Cost of Goods Sold', isSubtotal: true, level: 0, cells: { amount: 400 } },
    { label: 'Gross Profit', isSubtotal: true, level: 0, cells: { amount: 600 } },
    { label: 'Net Profit/Loss', isTotal: true, level: 0, cells: { amount: 350 } },
  ],
  '60072747871': [
    { label: 'Total Income', isSubtotal: true, level: 0, cells: { amount: 9000 } },
    { label: 'Total Cost of Goods Sold', isSubtotal: true, level: 0, cells: { amount: 3000 } },
    { label: 'Gross Profit', isSubtotal: true, level: 0, cells: { amount: 6000 } },
    { label: 'Net Profit/Loss', isTotal: true, level: 0, cells: { amount: 4000 } },
  ],
};

const fetchReportSpy = jest.fn();

function fakeCtx(orgId) {
  return {
    provider: 'zoho',
    conn: { provider: 'zoho', connectionRef: orgId, userId: 1, effectiveUserId: 1, currency: 'INR' },
    adapter: {
      fetchReport: (conn, type, params, opts) => {
        fetchReportSpy(conn.connectionRef, type, params);
        if (type === 'cashflow') return Promise.resolve({ rows: [], currency: 'INR' });
        return Promise.resolve({ rows: ORG_PL[conn.connectionRef] || [], currency: 'INR' });
      },
    },
  };
}

// Build a minimal app: simulate orgScope (X-Org-Id → req.orgId) then mount router.
function buildApp() {
  const app = http();
  app.use((req, _res, next) => { req.orgId = req.headers['x-org-id'] || null; next(); });
  app.use('/api/metrics', metricsRouter);
  return app;
}

beforeEach(() => {
  fetchReportSpy.mockClear();
  pool.execute.mockResolvedValue([[]]);
  resolveProvider.mockImplementation((_uid, orgId) => Promise.resolve(fakeCtx(orgId || '60036297771')));
});

describe('GET /api/metrics/profitability multi-org', () => {
  test('org A figures', async () => {
    const res = await express(buildApp())
      .get('/api/metrics/profitability?from=2025-04-01&to=2026-03-31')
      .set('X-Org-Id', '60036297771');
    expect(res.status).toBe(200);
    expect(res.body.data.revenue).toBe(1000);
    expect(res.body.data.grossProfit).toBe(600);
    expect(res.body.data.grossMargin).toBe(60);
    expect(res.body.data._meta.orgId).toBe('60036297771');
    expect(res.body.data._meta.provider).toBe('zoho');
  });

  test('switching X-Org-Id changes results', async () => {
    const res = await express(buildApp())
      .get('/api/metrics/profitability?from=2025-04-01&to=2026-03-31')
      .set('X-Org-Id', '60072747871');
    expect(res.body.data.revenue).toBe(9000);
    expect(res.body.data.netProfit).toBe(4000);
    expect(res.body.data._meta.orgId).toBe('60072747871');
  });
});

describe('param pass-through', () => {
  test('customer_id + currency_id reach fetchReport', async () => {
    await express(buildApp())
      .get('/api/metrics/revenue?from=2025-04-01&to=2026-03-31&customer_id=C9&currency_id=INR')
      .set('X-Org-Id', '60036297771');
    const [, , params] = fetchReportSpy.mock.calls[0];
    expect(params.customer_id).toBe('C9');
    expect(params.currency_id).toBe('INR');
  });

  test('basis=cash sets cash_based param + meta', async () => {
    const res = await express(buildApp())
      .get('/api/metrics/profitability?from=2025-04-01&to=2026-03-31&basis=cash')
      .set('X-Org-Id', '60072747871');
    const [, , params] = fetchReportSpy.mock.calls[0];
    expect(params.cash_based).toBe(true);
    expect(res.body.data._meta.basis).toBe('cash');
  });
});

describe('cashflow fallback', () => {
  test('no cashflow report → warehouse source + warning', async () => {
    pool.execute.mockResolvedValue([[{ dc: 'debit', total: 500 }, { dc: 'credit', total: 200 }]]);
    const res = await express(buildApp())
      .get('/api/metrics/cashflow?from=2025-04-01&to=2026-03-31')
      .set('X-Org-Id', '60036297771');
    expect(res.body.data._meta.source).toBe('warehouse');
    expect(res.body.data._meta.warnings.length).toBeGreaterThan(0);
    expect(res.body.data.inflow).toBe(500);
    expect(res.body.data.outflow).toBe(200);
    expect(res.body.data.operatingCashFlow).toBeNull();
  });
});

describe('no connection', () => {
  test('soft 200 with null data + provider null', async () => {
    resolveProvider.mockResolvedValueOnce(null);
    const res = await express(buildApp())
      .get('/api/metrics/revenue?from=2025-04-01&to=2026-03-31');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect(res.body._meta.provider).toBeNull();
  });
});
