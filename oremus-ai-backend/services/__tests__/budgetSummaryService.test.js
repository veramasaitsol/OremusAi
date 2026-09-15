'use strict';

// Budget Summary is a pure reshape of buildTrialBalance's `accounts` array, so
// mock that and assert the sections/totals reconcile.
jest.mock('../../config/db', () => ({ execute: jest.fn(), query: jest.fn() }));
jest.mock('../zohoGlReportsService', () => ({ buildTrialBalance: jest.fn() }));

const { buildTrialBalance } = require('../zohoGlReportsService');
const { buildBudgetSummary } = require('../budgetSummaryService');

// Trial Balance `closing` is debit-positive: income reads negative, expense and
// balance-sheet accounts read positive.
const TB_ACCOUNTS = [
  { ref: 'a1', name: 'Product Sales',   groupRaw: 'income',    typeCode: 'income',              closing: -1000, isPL: true },
  { ref: 'a2', name: 'Interest Income', groupRaw: 'other_income', typeCode: 'other_income',     closing: -50,   isPL: true },
  { ref: 'a3', name: 'Materials',       groupRaw: 'expense',   typeCode: 'cost_of_goods_sold',  closing: 400,   isPL: true },
  { ref: 'a4', name: 'Salaries',        groupRaw: 'expense',   typeCode: 'expense',             closing: 200,   isPL: true },
  { ref: 'a5', name: 'Bank Charges',    groupRaw: 'other_expense', typeCode: 'other_expense',   closing: 30,    isPL: true },
  { ref: 'a6', name: 'Cash',            groupRaw: 'asset',     typeCode: 'bank',                closing: 5000,  isPL: false },
  { ref: 'a7', name: 'Accounts Payable', groupRaw: 'liability', typeCode: 'accounts_payable',  closing: -1200, isPL: false },
  { ref: 'a8', name: 'Share Capital',   groupRaw: 'equity',    typeCode: 'equity',             closing: -3000, isPL: false },
];

function rowsByLabel(res) {
  const m = {};
  for (const r of res.rows) if (r.label) m[r.label] = r;
  return m;
}
const cell = (r) => (r && r.cells ? r.cells.p0 : undefined);

describe('buildBudgetSummary — mirrors Trial Balance', () => {
  beforeEach(() => {
    buildTrialBalance.mockResolvedValue({ currency: 'INR', accounts: TB_ACCOUNTS });
  });

  test('passes the resolved window to buildTrialBalance', async () => {
    await buildBudgetSummary(1, { from_date: '2025-04-01', to_date: '2025-06-30', org_id: 'O1', platform: 'zoho' });
    expect(buildTrialBalance).toHaveBeenCalledWith(1, expect.objectContaining({
      from_date: '2025-04-01', to_date: '2025-06-30', as_of_date: '2025-06-30',
      org_id: 'O1', platform: 'zoho',
    }));
  });

  test('P&L subtotals + Net Profit reconcile with the ledger figures', async () => {
    const res = await buildBudgetSummary(1, { from_date: '2025-04-01', to_date: '2026-03-31' });
    const R = rowsByLabel(res);

    expect(cell(R['Total Trading Income'])).toBe(1000);      // -(-1000)
    expect(cell(R['Total Cost of Sales'])).toBe(400);
    expect(cell(R['Gross Profit'])).toBe(600);               // 1000 - 400
    expect(cell(R['Total Operating Expenses'])).toBe(200);
    expect(cell(R['Total Other Income'])).toBe(50);          // -(-50)
    expect(cell(R['Total Non Operating Expense'])).toBe(30);
    expect(cell(R['Net Profit'])).toBe(420);                 // 600 - 200 + 50 - 30
  });

  test('Balance Sheet sections carry the Trial Balance debit-positive balance', async () => {
    const res = await buildBudgetSummary(1, {});
    const R = rowsByLabel(res);
    expect(cell(R['Total Assets'])).toBe(5000);
    expect(cell(R['Total Liabilities'])).toBe(-1200);
    expect(cell(R['Total Equity'])).toBe(-3000);
    expect(cell(R['Cash'])).toBe(5000);
  });

  test('Total column equals the single period column on every row', async () => {
    const res = await buildBudgetSummary(1, {});
    for (const r of res.rows) {
      if (r.cells) expect(r.cells.total).toBe(r.cells.p0);
    }
  });

  test('column label is the fiscal-year when the range is a clean FY', async () => {
    const res = await buildBudgetSummary(1, { from_date: '2025-04-01', to_date: '2026-03-31' });
    const valueCol = res.columns.find((c) => c.key === 'p0');
    expect(valueCol.label).toBe('Apr 2025-Mar 2026');
  });

  test('no ledger → unavailable payload (not a crash)', async () => {
    buildTrialBalance.mockResolvedValue({ _noLocalData: true });
    const res = await buildBudgetSummary(1, {});
    expect(res).toMatchObject({ empty: true, unavailable: true });
    expect(res.rows).toEqual([]);
  });

  test('connected but empty ledger → empty payload', async () => {
    buildTrialBalance.mockResolvedValue({ currency: 'INR', accounts: [] });
    const res = await buildBudgetSummary(1, {});
    expect(res).toMatchObject({ empty: true, emptyReason: 'empty' });
  });
});
