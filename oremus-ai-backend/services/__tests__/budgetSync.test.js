'use strict';

// Budgets from each platform's API → the one shape stored in acc_budget*.
jest.mock('../../config/db', () => ({ execute: jest.fn(), query: jest.fn(), getConnection: jest.fn() }));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));

let pool;
let axios;

beforeEach(() => {
  jest.resetModules();
  pool = require('../../config/db');
  axios = require('axios');
});
afterEach(() => jest.useRealTimers());

const mockStore = () => jest.doMock('../budgetsStore', () => ({
  persistBudgets: jest.fn(async (u, p, o, budgets, linesById) => ({
    budgets: budgets.length, lines: [...linesById.values()].reduce((s, l) => s + (l ? l.length : 0), 0),
  })),
  recordBudgetSyncError: jest.fn(),
  loadBudgetSync: jest.fn(async () => null),
}));

describe('normalizers', () => {
  const src = () => jest.requireActual('../budgetSources');

  test('Xero: monthly balances in any Xero date form; range from the amounts', () => {
    const { budgets, linesById } = src().normalizeXeroBudgets(
      [{ BudgetID: 'B1', Type: 'OVERALL', Description: 'Overall Budget', Status: 'APPROVED', Tracking: [] }],
      new Map([['B1', [
        { AccountID: 'A-SALES', AccountCode: '200', BudgetBalances: [
          { Period: '2025-04', Amount: '1000', Notes: 'launch' },
          { Period: '/Date(1748736000000+0000)/', Amount: 1050 }, // 2025-06
          { Period: '2025-07-01T00:00:00', UnitAmount: 75 },
        ] },
        { AccountCode: '400', BudgetBalances: [{ Period: '2025-04', Amount: 5 }] },
      ]]])
    );
    expect(budgets).toEqual([expect.objectContaining({
      id: 'B1', name: 'Overall Budget', type: 'OVERALL', entryPeriod: 'monthly', scope: null, startDate: '2025-04-01', endDate: '2025-07-31',
    })]);
    expect(linesById.get('B1').map((l) => [l.accountId, l.period, l.amount])).toEqual([
      ['A-SALES', '2025-04-01', 1000], ['A-SALES', '2025-06-01', 1050], ['A-SALES', '2025-07-01', 75], ['code:400', '2025-04-01', 5],
    ]);
  });

  test('QuickBooks: entry type, dates, subdivision by class / location / customer', () => {
    const { budgets, linesById } = src().normalizeQboBudgets([{
      Id: '7', Name: 'FY2025', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Quarterly',
      StartDate: '2025-01-01', EndDate: '2025-12-31', Active: true,
      BudgetDetail: [
        { BudgetDate: '2025-01-01', Amount: 1200, AccountRef: { value: '1', name: 'Sales' } },
        { BudgetDate: '2025-04-01', Amount: 1300, AccountRef: { value: '1', name: 'Sales' }, ClassRef: { value: '5', name: 'East' } },
        { BudgetDate: '2025-04-01', Amount: 90, AccountRef: { value: '2' }, DepartmentRef: { value: '3', name: 'Mumbai' } },
        { BudgetDate: '2025-04-01', Amount: 10, AccountRef: { value: '2' }, CustomerRef: { value: '58' } },
        { BudgetDate: '2025-04-01', Amount: 10 }, // no account
      ],
    }]);
    expect(budgets[0]).toEqual(expect.objectContaining({
      id: '7', type: 'ProfitAndLoss', entryPeriod: 'quarterly', startDate: '2025-01-01', endDate: '2025-12-31', status: 'ACTIVE',
    }));
    expect(linesById.get('7').map((l) => [l.accountId, l.period, l.amount, l.dimensionKey, l.dimensionLabel])).toEqual([
      ['1', '2025-01-01', 1200, '', null],
      ['1', '2025-04-01', 1300, 'class:5', 'Class: East'],
      ['2', '2025-04-01', 90, 'location:3', 'Location: Mumbai'],
      ['2', '2025-04-01', 10, 'customer:58', 'Customer: 58'],
    ]);
  });

  test('Zoho: budgets list; periods by their own date, label or position; unknown fields refused', () => {
    const { zohoBudgetList, normalizeZohoBudgetAccount } = src();
    const wrap = (detailed) => ({ code: 0, register_budget_vs_actual: {
      budget_info_list: [{ budget_id: '460000000991001', budget_name: 'FY 2026 Operating Budget' }],
      budget_vs_actuals: { generalledger_info: { generalledger_id: 'Z1' }, detailed_budget_vs_actual: detailed },
    } });
    expect(zohoBudgetList(wrap([]))).toEqual([{ id: '460000000991001', name: 'FY 2026 Operating Budget' }]);
    const opts = { accountId: 'Z1', accountName: 'Sales', from: '2025-04-01', period: 'monthly' };

    const dated = normalizeZohoBudgetAccount(wrap([
      { from_date: '2025-04-01', to_date: '2025-04-30', budget_amount: 1000, actual_amount: 900 },
      { from_date: '2025-05-01', budget_amount: '1,100.50', budget_amount_formatted: '₹1,100.50' },
    ]), opts);
    expect(dated.lines.map((l) => [l.period, l.amount])).toEqual([['2025-04-01', 1000], ['2025-05-01', 1100.5]]);

    const labelled = normalizeZohoBudgetAccount(wrap([{ period: 'Jun 2025', budget: { amount: 70 } }]), opts);
    expect(labelled.lines.map((l) => [l.period, l.amount])).toEqual([['2025-06-01', 70]]);

    const byPosition = normalizeZohoBudgetAccount(wrap([{ budget: 1 }, { budget: 2 }, { budget: 3 }]), opts);
    expect(byPosition.lines.map((l) => [l.period, l.amount])).toEqual([['2025-04-01', 1], ['2025-05-01', 2], ['2025-06-01', 3]]);

    expect(normalizeZohoBudgetAccount(wrap([]), opts)).toEqual({ lines: [], recognized: true });
    expect(normalizeZohoBudgetAccount(wrap([{ label: 'Apr 2025', planned: 5, actual: 4 }]), opts))
      .toEqual({ lines: [], recognized: false, sampleKeys: ['label', 'planned', 'actual'] });
  });
});

describe('Xero sync step', () => {
  test('reads each budget in 24-month windows and stores it under platform xero', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-17T10:00:00Z'), doNotFake: ['setTimeout'] });
    mockStore();
    pool.execute.mockImplementation(async (sql) => {
      if (/FROM xero_organizations/.test(sql)) return [[{ fiscal_year_end_month: '3' }]];
      if (/MIN\(transaction_date\)/.test(sql)) return [[{ ym: '2023-06' }]];
      return [[]];
    });
    const calls = [];
    axios.get.mockImplementation(async (url, { params } = {}) => {
      calls.push(params);
      if (url.endsWith('/Budgets')) return { data: { Budgets: [{ BudgetID: 'B1', Type: 'OVERALL', Description: 'Overall Budget' }] } };
      return { data: { Budgets: [{ BudgetID: 'B1', BudgetLines: [{ AccountID: 'A', BudgetBalances: [{ Period: params.DateFrom.slice(0, 7), Amount: 100 }] }] }] } };
    });
    expect(await require('../xeroService').syncBudgets(27, 'token', 'tenant-1')).toBe(1);
    expect(calls.filter(Boolean).map((p) => [p.DateFrom, p.DateTo])).toEqual([
      ['2023-04-01', '2025-03-31'], ['2025-04-01', '2027-03-31'], ['2027-04-01', '2029-03-31'],
    ]);
    const { persistBudgets } = require('../budgetsStore');
    const [, platform, org, budgets, linesById, window] = persistBudgets.mock.calls[0];
    expect([platform, org, budgets[0].name]).toEqual(['xero', 'tenant-1', 'Overall Budget']);
    expect(linesById.get('B1').map((l) => l.period)).toEqual(['2023-04-01', '2025-04-01', '2027-04-01']);
    expect(window).toEqual({ from: '2023-04-01', to: '2029-03-31' });
  });

  test('without accounting.budgets.read: recorded, step fails', async () => {
    mockStore();
    axios.get.mockRejectedValue(Object.assign(new Error('Request failed with status code 401'), { response: { status: 401, headers: {} } }));
    await expect(require('../xeroService').syncBudgets(27, 'token', 'tenant-1')).rejects.toThrow('401');
    const { recordBudgetSyncError, persistBudgets } = require('../budgetsStore');
    expect(recordBudgetSyncError).toHaveBeenCalledWith(27, 'xero', 'tenant-1', expect.stringMatching(/accounting\.budgets\.read/));
    expect(persistBudgets).not.toHaveBeenCalled();
    expect(jest.requireActual('../syncRunService').humanizeSyncError('xero', 'budgets', { response: { status: 401 } }))
      .toMatch(/accounting\.budgets\.read/);
  });
});

describe('QuickBooks sync step', () => {
  test('SELECT * FROM Budget, stored under platform quickbooks', async () => {
    mockStore();
    axios.get.mockResolvedValue({ data: { QueryResponse: { Budget: [{
      Id: '7', Name: 'FY2025', BudgetType: 'ProfitAndLoss', BudgetEntryType: 'Monthly', StartDate: '2025-01-01', EndDate: '2025-12-31',
      BudgetDetail: [{ BudgetDate: '2025-01-01', Amount: 500, AccountRef: { value: '1' } }],
    }] } } });
    expect(await require('../quickbooksService').syncBudgets(28, 'token', 'realm-1', 'production')).toBe(1);
    expect(axios.get.mock.calls[0][1].params.query).toBe('SELECT * FROM Budget STARTPOSITION 1 MAXRESULTS 1000');
    const { persistBudgets } = require('../budgetsStore');
    const [, platform, org, budgets, linesById] = persistBudgets.mock.calls[0];
    expect([platform, org, budgets[0].entryPeriod]).toEqual(['quickbooks', 'realm-1', 'monthly']);
    expect(linesById.get('7')).toHaveLength(1);
  });

  test('a plan without budgets (HTTP 400) is recorded as unavailable, not a failed sync', async () => {
    mockStore();
    axios.get.mockRejectedValue(Object.assign(new Error('400'), {
      response: { status: 400, data: { Fault: { Error: [{ Message: 'Feature Not Supported', Detail: 'Budgets are not available' }] } } },
    }));
    expect(await require('../quickbooksService').syncBudgets(28, 'token', 'realm-1', 'production')).toBe(0);
    expect(require('../budgetsStore').recordBudgetSyncError).toHaveBeenCalledWith(
      28, 'quickbooks', 'realm-1', expect.stringMatching(/Feature Not Supported — Budgets are not available/), 'unavailable');
  });
});

describe('Zoho sync step', () => {
  const ACCOUNTS = [
    { zoho_account_id: 'Z1', account_code: null, account_name: 'Sales' },
    { zoho_account_id: 'Z2', account_code: null, account_name: 'Salaries' },
  ];
  const zohoDb = () => {
    pool.query.mockImplementation(async (sql) => (/FROM zb_chart_of_accounts/.test(sql) ? [ACCOUNTS] : [[]]));
    pool.execute.mockImplementation(async (sql) => (/FROM zb_organizations/.test(sql) ? [[{ fiscal_year_start_month: 'april' }]] : [[]]));
  };
  const reply = (detailed, list = [{ budget_id: 'ZB1', budget_name: 'FY 2026 Budget' }]) => ({ data: {
    code: 0, register_budget_vs_actual: { budget_info_list: list, budget_vs_actuals: { detailed_budget_vs_actual: detailed } },
  } });

  test('lists budgets, then reads every profit-and-loss account of each over four financial years', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-17T10:00:00Z'), doNotFake: ['setTimeout'] });
    process.env.ZB_BUDGET_CALL_DELAY_MS = '0';
    mockStore();
    zohoDb();
    const seen = [];
    axios.get.mockImplementation(async (url, { params }) => {
      seen.push([url.replace(/^.*\/registers\//, ''), params.budget_id || null, params.from_date || null, params.to_date || null]);
      if (!params.budget_id) return reply([]);
      return reply(url.includes('/Z1/') ? [{ from_date: '2026-04-01', budget_amount: 1000 }] : [{ from_date: '2026-04-01', budget_amount: 400 }]);
    });
    const r = await require('../zohoBooksWarehouseService').syncBudgets(24, 'token', 'zorg-1', null, { triggerSource: 'manual' });
    expect(seen).toEqual([
      ['Z1/budgetvsactuals', null, null, null],
      ['Z1/budgetvsactuals', 'ZB1', '2024-04-01', '2028-03-31'],
      ['Z2/budgetvsactuals', 'ZB1', '2024-04-01', '2028-03-31'],
    ]);
    expect(r).toEqual(expect.objectContaining({ fetched: 1, inserted: 2, calls: 3 }));
    const [, platform, , budgets, linesById] = require('../budgetsStore').persistBudgets.mock.calls[0];
    expect(platform).toBe('zoho');
    expect(budgets[0]).toEqual(expect.objectContaining({ id: 'ZB1', name: 'FY 2026 Budget', startDate: '2026-04-01', endDate: '2026-04-30' }));
    expect(linesById.get('ZB1').map((l) => [l.accountId, l.amount])).toEqual([['Z1', 1000], ['Z2', 400]]);
  });

  test('the 6-hourly cron skips budgets fetched in the last day', async () => {
    jest.doMock('../budgetsStore', () => ({
      loadBudgetSync: jest.fn(async () => ({ status: 'ok', synced_at: new Date(Date.now() - 3600e3) })),
      persistBudgets: jest.fn(), recordBudgetSyncError: jest.fn(),
    }));
    zohoDb();
    const r = await require('../zohoBooksWarehouseService').syncBudgets(24, 'token', 'zorg-1', null, { triggerSource: 'cron' });
    expect(r.calls).toBe(0);
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('figures in an unknown form are reported, not stored', async () => {
    process.env.ZB_BUDGET_CALL_DELAY_MS = '0';
    mockStore();
    zohoDb();
    axios.get.mockImplementation(async (url, { params }) => (params.budget_id ? reply([{ label: 'Apr 2026', planned: 5 }]) : reply([])));
    await expect(require('../zohoBooksWarehouseService').syncBudgets(24, 'token', 'zorg-1', null, {}))
      .rejects.toThrow(/doesn't read \(period fields: label, planned\)/);
    const store = require('../budgetsStore');
    expect(store.persistBudgets).not.toHaveBeenCalled();
    expect(store.recordBudgetSyncError).toHaveBeenCalledWith(24, 'zoho', 'zorg-1', expect.stringMatching(/period fields/));
  });
});
