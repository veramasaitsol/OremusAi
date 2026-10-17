'use strict';

// Budget Summary: budgets of all three platforms from the shared acc_budget*
// tables, laid out in each platform's own sections.
jest.mock('../../config/db', () => ({ execute: jest.fn(), query: jest.fn(), getConnection: jest.fn() }));

let pool;

beforeEach(() => {
  jest.resetModules();
  pool = require('../../config/db');
});

const ORGS = {
  'tenant-1': { table: 'xero_organizations', row: { user_id: 27, name: 'Applaud India', currency: 'INR', fy: '3' } },
  'realm-1': { table: 'qbo_organizations', row: { user_id: 28, name: '1210 N Germantown LLC', currency: 'USD', fy: 'January' } },
  'zorg-1': { table: 'zb_organizations', row: { user_id: 24, name: 'Zoho Ltd', currency: 'INR', fy: 'april' } },
};
const ACCOUNTS = {
  xero_accounts: [
    { id: 'X-SALES', code: '200', name: 'Sales', type: 'REVENUE', cls: 'REVENUE' },
    { id: 'X-COS', code: '310', name: 'Cost of Goods Sold', type: 'DIRECTCOSTS', cls: 'EXPENSE' },
    { id: 'X-INT', code: '270', name: 'Interest Income', type: 'OTHERINCOME', cls: 'REVENUE' },
    { id: 'X-RENT', code: '469', name: 'Rent', type: 'OVERHEADS', cls: 'EXPENSE' },
    { id: 'X-ADV', code: '400', name: 'advertising', type: 'EXPENSE', cls: 'EXPENSE' },
    { id: 'X-BANK', code: '090', name: 'Business Bank', type: 'BANK', cls: 'ASSET' },
  ],
  qbo_accounts: [
    { id: '1', code: null, name: 'Rental Income', type: 'Income', cls: 'Revenue' },
    { id: '2', code: null, name: 'Repairs', type: 'Expense', cls: 'Expense' },
    { id: '3', code: null, name: 'Interest Earned', type: 'Other Income', cls: 'Revenue' },
    { id: '4', code: null, name: 'Penalties', type: 'Other Expense', cls: 'Expense' },
    { id: '5', code: null, name: 'Supplies', type: 'Cost of Goods Sold', cls: 'Expense' },
  ],
  zb_chart_of_accounts: [
    { id: 'Z1', code: null, name: 'Sales', type: 'income', cls: null },
    { id: 'Z2', code: null, name: 'Salaries', type: 'expense', cls: null },
    { id: 'Z3', code: null, name: 'Bank Fees', type: 'other_expense', cls: null },
  ],
};
const line = (platform, budget_id, account_id, period, amount, dim = '', label = null) =>
  ({ platform, budget_id, account_id, account_code: null, account_name: null, dimension_key: dim, dimension_label: label, period, amount });

function mockDb({ sync = { status: 'ok', synced_at: '2026-10-17 10:00:00' }, budgets = {}, lines = [] } = {}) {
  pool.execute.mockImplementation(async (sql, args = []) => {
    for (const [orgId, o] of Object.entries(ORGS)) {
      if (sql.includes(`FROM ${o.table}`)) return [args[0] === orgId ? [o.row] : []];
    }
    if (/FROM zb_oauth_organizations/.test(sql)) return [[]];
    if (/FROM acc_budget_sync/.test(sql)) return [sync ? [sync] : []];
    if (/FROM acc_budgets/.test(sql)) return [budgets[args[1]] || []];
    if (/FROM acc_budget_lines/.test(sql)) {
      const [, platform, , budgetId, from, to] = args;
      return [lines.filter((l) => l.platform === platform && l.budget_id === budgetId && l.period >= from && l.period <= to)];
    }
    for (const t of Object.keys(ACCOUNTS)) if (sql.includes(`FROM ${t}`)) return [ACCOUNTS[t]];
    return [[]];
  });
}

const build = (params) => require('../budgetSummaryService').buildBudgetSummary(1, params);
const byLabel = (r) => Object.fromEntries(r.rows.filter((x) => x.label).map((x) => [x.label, x]));
const labels = (r) => r.rows.filter((x) => x.label).map((x) => x.label);

describe('Xero — Budget Summary layout', () => {
  const budgets = {
    xero: [
      { budget_id: 'B-OVERALL', name: 'Overall Budget', budget_type: 'OVERALL', entry_period: 'monthly' },
      { budget_id: 'B-NORTH', name: 'North Region', budget_type: 'TRACKING', entry_period: 'monthly' },
    ],
  };
  const lines = [
    line('xero', 'B-OVERALL', 'X-SALES', '2025-04-01', 1000), line('xero', 'B-OVERALL', 'X-SALES', '2025-05-01', 1100),
    line('xero', 'B-OVERALL', 'X-SALES', '2026-03-01', 1200),
    line('xero', 'B-OVERALL', 'X-COS', '2025-04-01', 400), line('xero', 'B-OVERALL', 'X-COS', '2025-05-01', 440),
    line('xero', 'B-OVERALL', 'X-INT', '2025-04-01', 10),
    line('xero', 'B-OVERALL', 'X-RENT', '2025-04-01', 300), line('xero', 'B-OVERALL', 'X-RENT', '2025-05-01', 300),
    line('xero', 'B-OVERALL', 'X-ADV', '2025-07-01', 50),
    line('xero', 'B-OVERALL', 'X-BANK', '2025-04-01', 999), // balance sheet: left out
    line('xero', 'B-OVERALL', 'X-SALES', '2026-04-01', 9999), // next year: outside the range
    line('xero', 'B-NORTH', 'X-SALES', '2025-04-01', 250),
  ];
  const params = { org_id: 'tenant-1', from_date: '2025-04-01', to_date: '2026-03-31' };

  test('monthly columns + Total, Xero sections, totals, title text', async () => {
    mockDb({ budgets, lines });
    const r = await build(params);
    expect(r.columns.map((c) => c.label)).toEqual([
      'Account', 'Apr 2025', 'May 2025', 'Jun 2025', 'Jul 2025', 'Aug 2025', 'Sep 2025',
      'Oct 2025', 'Nov 2025', 'Dec 2025', 'Jan 2026', 'Feb 2026', 'Mar 2026', 'Total',
    ]);
    expect(labels(r)).toEqual([
      'Trading Income', 'Sales', 'Total Trading Income',
      'Cost of Sales', 'Cost of Goods Sold', 'Total Cost of Sales',
      'Gross Profit',
      'Other Income', 'Interest Income', 'Total Other Income',
      'Operating Expenses', 'advertising', 'Rent', 'Total Operating Expenses',
      'Net Profit',
    ]);
    const R = byLabel(r);
    expect(R.Sales.cells).toEqual(expect.objectContaining({ p0: 1000, p1: 1100, p11: 1200, total: 3300 }));
    expect(R['Gross Profit'].cells).toEqual(expect.objectContaining({ p0: 600, p1: 660, total: 2460 }));
    expect(R['Net Profit'].cells).toEqual(expect.objectContaining({ p0: 310, total: 1820 }));
    expect(R['Net Profit'].isTotal).toBe(true);
    expect(r).toEqual(expect.objectContaining({ currency: 'INR', budgetName: 'Overall Budget', period: 'budget', intervals: ['month', 'quarter', 'year'] }));
    expect(r.budgets.map((b) => b.name)).toEqual(['Overall Budget', 'North Region']);
    expect(r.meta).toEqual(expect.objectContaining({ platform: 'xero', company: 'Applaud India', periodText: 'For the 12 months ending 31 March 2026', skippedLines: 1 }));
  });

  test('quarters / years counted from the first month and headed by their last month', async () => {
    mockDb({ budgets, lines });
    const q = await build({ ...params, interval: 'quarter' });
    expect(q.columns.map((c) => c.label)).toEqual(['Account', 'Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Total']);
    expect(byLabel(q).Sales.cells).toEqual({ p0: 2100, p1: 0, p2: 0, p3: 1200, total: 3300 });
    const y = await build({ ...params, interval: 'year', to_date: '2027-03-31' });
    expect(y.columns.map((c) => c.label)).toEqual(['Account', 'Mar 2026', 'Mar 2027', 'Total']);
    expect(byLabel(y).Sales.cells).toEqual({ p0: 3300, p1: 9999, total: 13299 });
  });

  test('budget_id picks a tracking budget', async () => {
    mockDb({ budgets, lines });
    const r = await build({ ...params, budget_id: 'B-NORTH' });
    expect(r.budgetName).toBe('North Region');
    expect(byLabel(r)['Net Profit'].cells.total).toBe(250);
  });
});

describe('QuickBooks — Budget Overview layout', () => {
  const budgets = {
    quickbooks: [
      { budget_id: '7', name: 'FY2025 by Class', budget_type: 'ProfitAndLoss', entry_period: 'monthly' },
      { budget_id: '8', name: 'FY2025 Quarterly', budget_type: 'ProfitAndLoss', entry_period: 'quarterly' },
      { budget_id: '9', name: 'Balance budget', budget_type: 'BalanceSheet', entry_period: 'monthly' },
    ],
  };
  const lines = [
    line('quickbooks', '7', '1', '2025-01-01', 5000, 'class:1', 'Class: East'),
    line('quickbooks', '7', '1', '2025-01-01', 3000, 'class:2', 'Class: West'),
    line('quickbooks', '7', '1', '2025-02-01', 5000, 'class:1', 'Class: East'),
    line('quickbooks', '7', '5', '2025-01-01', 1000, 'class:1', 'Class: East'),
    line('quickbooks', '7', '2', '2025-01-01', 2000, 'class:2', 'Class: West'),
    line('quickbooks', '7', '3', '2025-01-01', 100, 'class:1', 'Class: East'),
    line('quickbooks', '7', '4', '2025-01-01', 40, 'class:1', 'Class: East'),
    line('quickbooks', '8', '1', '2025-01-01', 12000),
    line('quickbooks', '8', '1', '2025-04-01', 15000),
  ];
  const params = { org_id: 'realm-1', from_date: '2025-01-01', to_date: '2025-12-31' };

  test('QuickBooks sections incl. Net Operating / Net Other Income; subdivisions add up', async () => {
    mockDb({ budgets, lines });
    const r = await build(params);
    expect(labels(r)).toEqual([
      'Income', 'Rental Income', 'Total Income',
      'Cost of Goods Sold', 'Supplies', 'Total Cost of Goods Sold',
      'Gross Profit',
      'Expenses', 'Repairs', 'Total Expenses',
      'Net Operating Income',
      'Other Income', 'Interest Earned', 'Total Other Income',
      'Other Expenses', 'Penalties', 'Total Other Expenses',
      'Net Other Income',
      'Net Income',
    ]);
    const R = byLabel(r);
    expect(R['Rental Income'].cells).toEqual(expect.objectContaining({ p0: 8000, p1: 5000, total: 13000 }));
    expect(R['Net Operating Income'].cells.total).toBe(10000); // 13000 − 1000 − 2000
    expect(R['Net Other Income'].cells.total).toBe(60);
    expect(R['Net Income'].cells.total).toBe(10060);
    expect(r.meta.periodText).toBe('January - December 2025');
    expect(r.currency).toBe('USD');
    // Balance-sheet budgets aren't offered.
    expect(r.budgets.map((b) => b.id)).toEqual(['7', '8']);
    expect(r.dimensions).toEqual([{ key: 'class:1', label: 'Class: East' }, { key: 'class:2', label: 'Class: West' }]);
  });

  test('dimension shows one class only', async () => {
    mockDb({ budgets, lines });
    const r = await build({ ...params, dimension: 'class:2' });
    expect(r.dimension).toBe('class:2');
    expect(byLabel(r)['Rental Income'].cells.total).toBe(3000);
    expect(byLabel(r)['Net Income'].cells.total).toBe(1000);
    expect(labels(r)).not.toContain('Net Other Income'); // no other income / expense in this class
  });

  test('a quarterly budget is shown by quarter, with QuickBooks range headings', async () => {
    mockDb({ budgets, lines });
    const r = await build({ ...params, budget_id: '8', interval: 'month' });
    expect(r.interval).toBe('quarter');
    expect(r.columns.map((c) => c.label)).toEqual(['Account', 'Jan - Mar 2025', 'Apr - Jun 2025', 'Jul - Sep 2025', 'Oct - Dec 2025', 'Total']);
    expect(byLabel(r)['Rental Income'].cells).toEqual({ p0: 12000, p1: 15000, p2: 0, p3: 0, total: 27000 });
    expect(r.meta.note).toBe('This budget is set per quarter, so it is shown by quarter rather than by month.');
  });
});

describe('Zoho Books — budget Profit and Loss layout', () => {
  test('Zoho sections, half-year columns, Zoho date heading', async () => {
    mockDb({
      budgets: { zoho: [{ budget_id: 'ZB1', name: 'FY 2026 Operating Budget', entry_period: 'monthly' }] },
      lines: [
        line('zoho', 'ZB1', 'Z1', '2025-04-01', 50000), line('zoho', 'ZB1', 'Z1', '2025-10-01', 60000),
        line('zoho', 'ZB1', 'Z2', '2025-04-01', 20000), line('zoho', 'ZB1', 'Z3', '2025-04-01', 500),
      ],
    });
    const r = await build({ org_id: 'zorg-1', from_date: '2025-04-01', to_date: '2026-03-31', interval: 'half_year' });
    expect(r.columns.map((c) => c.label)).toEqual(['Account', 'Apr - Sep 2025', 'Oct 2025 - Mar 2026', 'Total']);
    expect(labels(r)).toEqual([
      'Operating Income', 'Sales', 'Total for Operating Income',
      'Gross Profit',
      'Operating Expense', 'Salaries', 'Total for Operating Expense',
      'Operating Profit',
      'Non Operating Expense', 'Bank Fees', 'Total for Non Operating Expense',
      'Net Profit/Loss',
    ]);
    expect(byLabel(r)['Net Profit/Loss'].cells).toEqual({ p0: 29500, p1: 60000, total: 89500 });
    expect(r.meta.periodText).toBe('From 01/04/2025 To 31/03/2026');
    expect(r.intervals).toContain('half_year');
  });
});

describe('empty states', () => {
  const xero = { org_id: 'tenant-1', from_date: '2025-04-01', to_date: '2026-03-31' };
  test('never synced / refused / unavailable plan / no budgets / nothing in range', async () => {
    mockDb({ sync: null });
    expect(await build(xero)).toEqual(expect.objectContaining({ empty: true, emptyReason: 'not_synced' }));

    mockDb({ sync: { status: 'error', error: 'Xero denied access to budgets — the connection is missing the accounting.budgets.read permission.' } });
    const denied = await build(xero);
    expect(denied.emptyReason).toBe('no_access');
    expect(denied.message).toMatch(/accounting\.budgets\.read permission\. Grant it, reconnect Xero/);

    mockDb({ sync: { status: 'unavailable', error: 'QuickBooks did not return budgets for this company (HTTP 400: ...).' } });
    const plan = await build({ org_id: 'realm-1' });
    expect(plan.message).toMatch(/QuickBooks Online Plus or Advanced/);

    mockDb();
    expect((await build({ org_id: 'zorg-1' })).message).toMatch(/Premium plan/);

    mockDb({ budgets: { xero: [{ budget_id: 'B1', name: 'Overall Budget', budget_type: 'OVERALL' }] } });
    const none = await build({ ...xero, from_date: '2030-04-01', to_date: '2031-03-31' });
    expect(none).toEqual(expect.objectContaining({ empty: true, emptyReason: 'no_amounts', budgetName: 'Overall Budget' }));
  });

  test('an org that belongs to no platform is unavailable', async () => {
    mockDb();
    expect(await build({ org_id: 'nobody' })).toEqual(expect.objectContaining({ unavailable: true, emptyReason: 'unavailable' }));
  });
});

describe('budgetsStore.lineRows', () => {
  test('one row per account × subdivision × period, last value wins, zeros left out', () => {
    const { lineRows } = jest.requireActual('../budgetsStore');
    const rows = lineRows(27, 'quickbooks', 'realm-1', 'B1', [
      { accountId: '1', period: '2025-01-01', amount: 10, dimensionKey: 'class:1', dimensionLabel: 'Class: East' },
      { accountId: '1', period: '2025-01-01', amount: 12, dimensionKey: 'class:1', dimensionLabel: 'Class: East' },
      { accountId: '1', period: '2025-01-01', amount: 5, dimensionKey: 'class:2' },
      { accountId: '1', period: '2025-02-01', amount: 0 },
      { accountId: '2', period: '2025-02-01', amount: 7.456 },
    ]);
    expect(rows).toEqual([
      [27, 'quickbooks', 'realm-1', 'B1', '1', null, null, 'class:1', 'Class: East', '2025-01-01', 12, null],
      [27, 'quickbooks', 'realm-1', 'B1', '1', null, null, 'class:2', null, '2025-01-01', 5, null],
      [27, 'quickbooks', 'realm-1', 'B1', '2', null, null, '', null, '2025-02-01', 7.46, null],
    ]);
  });
});
