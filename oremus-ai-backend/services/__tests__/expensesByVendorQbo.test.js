'use strict';

// QuickBooks Expenses by Vendor Summary. QuickBooks groups the report by each
// expense line's Name and only a Vendor gets its own row; everything else is
// "Not Specified". The ledger stores that Name's kind (contact_type) so the
// report can tell a vendor from a customer, an employee or a bare memo.
jest.mock('../../config/db', () => ({ execute: jest.fn(), query: jest.fn() }));
jest.mock('../zohoChartOfAccountsService', () => ({ getBaseCurrency: jest.fn(async () => 'USD') }));

let pool;
let buildExpensesByVendorSummary;

beforeEach(() => {
  jest.resetModules();
  pool = require('../../config/db');
  ({ buildExpensesByVendorSummary } = require('../zohoExpensesByVendorSummaryService'));
});

const line = (o) => ({
  source_id: '1', debit: 0, credit: 0, dt: '2026-03-01', ref: null, account: 'Office',
  ttype: o.stype, details: '', sub_type: null, grp: 'expense', ...o,
});

// Route the builder's queries: QuickBooks company, contacts known, ledger lines.
function mockLedger({ accrual = [], cash = [], contactsKnown = true } = {}) {
  pool.execute.mockImplementation(async (sql) => {
    if (/FROM qbo_organizations/.test(sql)) return [[{ x: 1 }]];
    if (/contact_type IS NOT NULL LIMIT 1/.test(sql)) return [[contactsKnown ? { x: 1 } : undefined]];
    if (/FROM qbo_cash_ledger/.test(sql)) return [cash];
    if (/FROM account_transactions/.test(sql)) return [accrual];
    return [[]];
  });
}

const totals = (report) => Object.fromEntries(report.rows.map((r) => [r.label, r.cells.amount]));

describe('QuickBooks Expenses by Vendor Summary', () => {
  test('a line counts under its Name only when that Name is a Vendor', async () => {
    mockLedger({
      accrual: [
        line({ stype: 'Bill', debit: 100, contact_type: 'Vendor', contact_name: 'Waste Management' }),
        // A journal line that itself names a vendor stays with that vendor.
        line({ stype: 'Journal Entry', debit: 311.56, contact_type: 'Vendor', contact_name: 'Waste Management' }),
        // A payee-less expense whose memo reads like a vendor is unattributed.
        line({ stype: 'Expense', debit: 49.39, contact_type: null, contact_name: null, details: 'Uber' }),
        // A purchase paid to a customer isn't a vendor's.
        line({ stype: 'Expense', debit: 100, contact_type: 'Customer', contact_name: 'Mercury Bank' }),
        // Deposit lines spell the kind 'VENDOR'.
        line({ stype: 'Deposit', credit: 0.15, contact_type: 'VENDOR', contact_name: 'Waste Management' }),
      ],
    });
    const t = totals(await buildExpensesByVendorSummary(29, { org_id: '1', from_date: '2026-01-01', to_date: '2026-12-31' }));
    expect(t).toEqual({ 'Not Specified': 149.39, 'Waste Management': 411.41, TOTAL: 560.8 });
  });

  test("customer documents are left out; purchases on income accounts count", async () => {
    mockLedger({
      accrual: [
        line({ stype: 'Payment', debit: 12.5, contact_type: 'Customer', contact_name: 'Sixt' }),
        line({ stype: 'Invoice', credit: 3, contact_type: 'Customer', contact_name: 'Sixt' }),
        line({ stype: 'Expense', grp: 'income', debit: 532.33, contact_type: 'Vendor', contact_name: 'BDT Beverage' }),
        line({ stype: 'Vendor Credit', grp: 'income', credit: 22.95, contact_type: 'Vendor', contact_name: 'DKH Dis' }),
        // Other income-account activity (sales deposits, journals) is not spend.
        line({ stype: 'Deposit', grp: 'income', credit: 5000, contact_type: null, contact_name: null }),
        line({ stype: 'Journal Entry', grp: 'income', credit: 900, contact_type: null, contact_name: null }),
      ],
    });
    const t = totals(await buildExpensesByVendorSummary(29, { org_id: '1', from_date: '2026-01-01', to_date: '2026-12-31' }));
    expect(t).toEqual({ 'BDT Beverage': 532.33, 'DKH Dis': -22.95, TOTAL: 509.38 });
  });

  test('cash basis reads the cash ledger and skips unapplied vendor prepayments', async () => {
    mockLedger({
      accrual: [line({ stype: 'Bill', debit: 999, contact_type: 'Vendor', contact_name: 'Wrong basis' })],
      cash: [
        // Paid before the bill existed: parked on the system account…
        line({ stype: 'Bill Payment (Check)', debit: 91863.06, sub_type: 'UnappliedCashBillPaymentExpense',
          contact_type: 'Vendor', contact_name: 'Saleswinnr' }),
        // …then the bill reverses it there and books the real expense.
        line({ stype: 'Bill', credit: 91863.06, sub_type: 'UnappliedCashBillPaymentExpense',
          contact_type: 'Vendor', contact_name: 'Saleswinnr' }),
        line({ stype: 'Bill', debit: 91863.06, contact_type: 'Vendor', contact_name: 'Saleswinnr' }),
        // A real FX difference on a bill payment still counts.
        line({ stype: 'Bill Payment (Check)', credit: 8.31, contact_type: 'Vendor', contact_name: 'Bitla & Co.,' }),
      ],
    });
    const report = await buildExpensesByVendorSummary(29, {
      org_id: '1', from_date: '2026-01-01', to_date: '2026-12-31', accounting_basis: 'Cash',
    });
    expect(totals(report)).toEqual({ 'Bitla & Co.,': -8.31, Saleswinnr: 0, TOTAL: -8.31 });
    expect(report.meta.source).toBe('ledger');
  });

  test('a company synced before ledger contacts keeps the old attribution', async () => {
    mockLedger({ contactsKnown: false });
    pool.query.mockResolvedValue([[]]);
    // Fallback path: ledger lines + document lookups, journals unattributed.
    pool.execute.mockImplementation(async (sql) => {
      if (/FROM qbo_organizations/.test(sql)) return [[{ x: 1 }]];
      if (/contact_type IS NOT NULL LIMIT 1/.test(sql)) return [[undefined]];
      if (/FROM bills/.test(sql)) return [[{ pid: '540', vendor_name: 'Waste Management' }]];
      if (/FROM vendors/.test(sql)) return [[]];
      if (/FROM account_transactions/.test(sql)) {
        return [[
          { source_id: '540', debit: 820.6, credit: 0, stype: 'Bill', ttype: 'Bill', details: 'Waste Management' },
          { source_id: '1042', debit: 311.56, credit: 0, stype: 'Journal Entry', ttype: 'Journal Entry', details: 'Waste Management' },
        ]];
      }
      return [[]];
    });
    const t = totals(await buildExpensesByVendorSummary(29, { org_id: '1', from_date: '2025-01-01', to_date: '2025-12-31' }));
    expect(t).toEqual({ 'Not Specified': 311.56, 'Waste Management': 820.6, TOTAL: 1132.16 });
  });
});

describe('QuickBooks ledger contacts (sync)', () => {
  let qs;
  beforeEach(() => { qs = require('../quickbooksService'); });

  test('documents carry their payee and its kind', () => {
    expect(qs.docEntity('Bill', { VendorRef: { value: '87', name: 'Uber' } }))
      .toEqual({ id: '87', type: 'Vendor', name: 'Uber' });
    expect(qs.docEntity('Purchase', { EntityRef: { value: '103', name: 'Mercury Bank', type: 'Customer' } }))
      .toEqual({ id: '103', type: 'Customer', name: 'Mercury Bank' });
    expect(qs.docEntity('Purchase', {})).toBeNull();
    expect(qs.docEntity('Transfer', { VendorRef: { value: '1' } })).toBeNull();
  });

  test("deposit lines take their own entity, with one spelling of its kind", () => {
    const out = new Map();
    qs.collectLineEntities('Deposit', [{
      Id: '226',
      Line: [{ DetailType: 'DepositLineDetail', Amount: 0.1,
        DepositLineDetail: { AccountRef: { value: '60' }, Entity: { value: '9', name: 'QuickBooks Payments', type: 'VENDOR' } } }],
    }], out);
    expect(qs.lineEntityFor(out, 'Deposit:226', '60', 0, 0.1))
      .toMatchObject({ id: '9', type: 'Vendor', name: 'QuickBooks Payments' });
  });

  test('a journal reversing an unapplied vendor prepayment belongs to the paying vendor', () => {
    const ctx = {
      lineEntities: new Map(),
      docEntities: new Map(),
      nameTypes: new Map(),
      paidBy: new Map([['JournalEntry:1418', { id: '12', type: 'Vendor', name: 'Oremus Corporation NA' }]]),
      unappliedAccounts: new Set(['151']),
    };
    const row = { sourceRef: '1418', cells: {} };
    expect(qs.ledgerContactFor(row, 'JournalEntry', '151', 0, 200, ctx))
      .toEqual({ id: '12', type: 'Vendor', name: 'Oremus Corporation NA' });
    // On any other account the journal line stays unnamed.
    expect(qs.ledgerContactFor(row, 'JournalEntry', '60', 200, 0, ctx)).toBeNull();
  });
});
