'use strict';

// Mock the db pool so requiring reportContext never loads config/db.js (dotenv,
// mysql2). The pure helpers take an injected pool; only resolveOrgId touches it.
jest.mock('../../config/db', () => ({ execute: jest.fn() }));

const {
  fiscalYearStart, fiscalYearEnd,
  resolveRange, resolveAsOf, resolveBasis, resolveInterval,
  resolvePeriod, resolveCompare, resolvePlatform, resolveOrgId,
  resolveReportContext,
} = require('../reportContext');

describe('reportContext — date helpers', () => {
  test('fiscalYearStart / End use the Indian FY (Apr–Mar)', () => {
    expect(fiscalYearStart('2025-06-15')).toBe('2025-04-01');
    expect(fiscalYearEnd('2025-06-15')).toBe('2026-03-31');
    // January falls in the PREVIOUS fiscal year
    expect(fiscalYearStart('2026-01-10')).toBe('2025-04-01');
    expect(fiscalYearEnd('2026-01-10')).toBe('2026-03-31');
  });

  test('resolveRange: both bounds pass through (trimmed to day)', () => {
    expect(resolveRange({ from_date: '2025-04-01', to_date: '2025-06-30' }))
      .toEqual({ from: '2025-04-01', to: '2025-06-30' });
    expect(resolveRange({ from: '2025-04-01T00:00:00Z', to: '2025-06-30T23:59:59Z' }))
      .toEqual({ from: '2025-04-01', to: '2025-06-30' });
  });

  test('resolveRange: no bounds → current fiscal year', () => {
    const r = resolveRange({});
    expect(r.from).toMatch(/^\d{4}-04-01$/);
    expect(r.to).toMatch(/^\d{4}-03-31$/);
    expect(Number(r.to.slice(0, 4)) - Number(r.from.slice(0, 4))).toBe(1);
  });

  test('resolveRange: one-sided range fills the other bound from the same FY', () => {
    expect(resolveRange({ from_date: '2025-05-01' }))
      .toEqual({ from: '2025-05-01', to: '2026-03-31' });
    expect(resolveRange({ to_date: '2025-05-01' }))
      .toEqual({ from: '2025-04-01', to: '2025-05-01' });
  });

  test('resolveRange: garbage dates are ignored', () => {
    const r = resolveRange({ from_date: 'not-a-date', to_date: '' });
    expect(r.from).toMatch(/^\d{4}-04-01$/);
  });

  test('resolveAsOf: as_of_date wins, else to bound, else today', () => {
    expect(resolveAsOf({ as_of_date: '2025-12-31', to_date: '2025-06-30' })).toBe('2025-12-31');
    expect(resolveAsOf({ to_date: '2025-06-30' })).toBe('2025-06-30');
    expect(resolveAsOf({})).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe('reportContext — filter helpers', () => {
  test('resolveBasis', () => {
    expect(resolveBasis({ basis: 'cash' })).toBe('cash');
    expect(resolveBasis({ accounting_basis: 'CASH' })).toBe('cash');
    expect(resolveBasis({ cash_basis: '1' })).toBe('cash');
    expect(resolveBasis({ basis: 'accrual' })).toBe('accrual');
    expect(resolveBasis({})).toBe('accrual');
  });

  test('resolveInterval normalises synonyms', () => {
    expect(resolveInterval({ interval: 'monthly' })).toBe('month');
    expect(resolveInterval({ interval: 'Quarters' })).toBe('quarter');
    expect(resolveInterval({ interval_type: 'year' })).toBe('year');
    expect(resolveInterval({})).toBe('none');
  });

  test('resolvePeriod', () => {
    expect(resolvePeriod({ period: 'monthly' })).toBe('monthly');
    expect(resolvePeriod({ period: 'YEARLY' })).toBe('yearly');
    expect(resolvePeriod({})).toBe('yearly');
  });

  test('resolveCompare', () => {
    expect(resolveCompare({ compare: 'year', compare_count: '2' }))
      .toEqual({ mode: 'year', count: 2, oldestFirst: false });
    expect(resolveCompare({ compare: 'period', compare_count: 3, oldest_first: '1' }))
      .toEqual({ mode: 'period', count: 3, oldestFirst: true });
    expect(resolveCompare({ compare: 'year' })).toEqual({ mode: null, count: 0, oldestFirst: false });
    expect(resolveCompare({})).toEqual({ mode: null, count: 0, oldestFirst: false });
  });

  test('resolvePlatform only accepts the three known tags', () => {
    expect(resolvePlatform({ platform: 'XERO' })).toBe('xero');
    expect(resolvePlatform({ platform: 'sap' })).toBeNull();
    expect(resolvePlatform({})).toBeNull();
  });
});

describe('reportContext — org resolution', () => {
  const mkPool = (handlers) => ({
    execute: jest.fn(async (sql) => {
      for (const [re, rows] of handlers) if (re.test(sql)) return [rows];
      return [[]];
    }),
  });

  test('explicit params.org_id always wins, no DB hit', async () => {
    const pool = mkPool([]);
    expect(await resolveOrgId(1, { org_id: 'ORG-9' }, pool)).toBe('ORG-9');
    expect(pool.execute).not.toHaveBeenCalled();
  });

  test('falls back to the Zoho active org', async () => {
    const pool = mkPool([[/FROM zb_tokens/, [{ org_id: 'ZO-1' }]]]);
    expect(await resolveOrgId(1, {}, pool)).toBe('ZO-1');
  });

  test('falls back to the active QBO realm (is_active ordering)', async () => {
    const pool = mkPool([
      [/FROM zb_tokens/, []],
      [/FROM qbo_tokens/, [{ realm_id: 'RE-2' }]],
    ]);
    expect(await resolveOrgId(1, {}, pool)).toBe('RE-2');
  });

  test('falls back to the active Xero tenant', async () => {
    const pool = mkPool([
      [/FROM zb_tokens/, []],
      [/FROM qbo_tokens/, []],
      [/FROM xero_tokens/, [{ tenant_id: 'TEN-3' }]],
    ]);
    expect(await resolveOrgId(1, {}, pool)).toBe('TEN-3');
  });

  test('resolveReportContext bundles everything', async () => {
    const pool = mkPool([[/FROM zb_tokens/, [{ org_id: 'ZO-1' }]]]);
    const ctx = await resolveReportContext(7, {
      from_date: '2025-04-01', to_date: '2025-06-30',
      basis: 'cash', interval: 'month', platform: 'zoho',
    }, pool);
    expect(ctx).toMatchObject({
      effectiveUserId: 7,
      orgId: 'ZO-1',
      platform: 'zoho',
      range: { from: '2025-04-01', to: '2025-06-30' },
      basis: 'cash',
      interval: 'month',
      period: 'yearly',
    });
  });
});
