'use strict';

// Vendor Balance Detail for Xero: QuickBooks' layout (Amount · Open balance ·
// running Balance) with open balances rewound to the report date — the same
// figures as Xero's Aged Payables.
jest.mock('../../config/db', () => ({ execute: jest.fn(), query: jest.fn() }));
jest.mock('../zohoChartOfAccountsService', () => ({ getBaseCurrency: jest.fn(async () => 'INR') }));

let pool;
let build;

beforeEach(() => {
  jest.resetModules();
  pool = require('../../config/db');
  ({ buildVendorBalanceDetail: build } = require('../zohoVendorBalanceDetailService'));
});

const bill = (o) => ({
  qbo_id: null, vendor_name: 'MC Medcrave', due_date: null, currency_code: 'INR', exchange_rate: 1, ...o,
});

// ledger(day) → { [InvoiceID]: { asOf, today } }; postings for the drill-down.
function mockDb({ bills = [], ledger = () => ({}), postings = [], creditDocs = [], allocations = [] }) {
  pool.execute.mockImplementation(async (sql, params = []) => {
    if (/FROM qbo_organizations/.test(sql)) return [[]];
    if (/xero_organizations/.test(sql)) return [[{ x: 1 }]];
    if (/FROM xero_allocation_sync/.test(sql)) return [[{ doc_type: 'CREDITNOTE' }, { doc_type: 'OVERPAYMENT' }]];
    if (/FROM xero_credit_docs/.test(sql)) return [creditDocs];
    if (/FROM xero_allocations/.test(sql)) return [allocations];
    if (/FROM bills/.test(sql)) return [bills.map((b) => ({ ...b }))];
    if (/GROUP BY source_id/.test(sql)) {
      const day = String(params[0]).slice(0, 10);
      return [Object.entries(ledger(day)).map(([source_id, v]) => ({ source_id, balance_as_of: v.asOf, balance_today: v.today }))];
    }
    if (/ORDER BY transaction_date/.test(sql)) return [postings];
    return [[]];
  });
}

const detail = (r) => r.rows.filter((x) => x.level === 1).map((x) => [x.label, x.cells.txnType, x.cells.invoice, x.cells.amount, x.cells.open, x.cells.balance]);

test('QuickBooks layout; a bill paid after the date is open on it; an overpayment shows full and open amounts', async () => {
  mockDb({
    bills: [
      bill({ xero_id: 'b1', bill_number: '086', date: '2024-10-03', due_date: '2024-11-02', total: 569283.38, balance: 0 }),
      bill({ xero_id: 'b2', bill_number: '087', date: '2025-03-10', total: 1000, balance: 0 }),
    ],
    // 086: 555,518 overpayment allocated 2024-10-08 (below), the rest paid in 2026.
    // 087: paid 2025-04-01, after the report date.
    ledger: (day) => ({
      b1: { asOf: 569283.38, today: 555518 },
      b2: { asOf: day < '2025-04-01' ? 1000 : 0, today: 0 },
    }),
    creditDocs: [{ doc_type: 'OVERPAYMENT', doc_id: 'op-1', side: 'ap', status: 'PAID', total: 555518,
      contact_name: 'MC Medcrave', date: '2024-10-08', currency_code: 'INR', currency_rate: 1 },
    { doc_type: 'OVERPAYMENT', doc_id: 'op-2', side: 'ap', status: 'AUTHORISED', total: 22301,
      contact_name: 'HDFC Credit Card -6592', date: '2024-02-01', currency_code: 'INR', currency_rate: 1 }],
    allocations: [
      { doc_type: 'OVERPAYMENT', doc_id: 'op-1', kind: 'ALLOCATION', invoice_id: 'b1', date: '2024-10-08', amount: 555518 },
      { doc_type: 'OVERPAYMENT', doc_id: 'op-2', kind: 'ALLOCATION', invoice_id: 'bX', date: '2024-06-01', amount: 6710 },
    ],
  });
  const r = await build(1, { org_id: 'tenant-1', to_date: '2025-03-15' });
  expect(r.columns.map((c) => c.label)).toEqual(['Date', 'Transaction type', 'Num', 'Due date', 'Amount', 'Open balance', 'Balance']);
  expect(detail(r)).toEqual([
    ['02/01/2024', 'Overpayment', '', -22301, -15591, -15591],
    ['10/03/2024', 'Bill', '086', 569283.38, 13765.38, 13765.38],
    ['03/10/2025', 'Bill', '087', 1000, 1000, 14765.38],
  ]);
  expect(r.rows.find((x) => x.isTotal).cells.open).toBe(-825.62); // -15,591 + 13,765.38 + 1,000
});

test('a bill paid before it was issued is listed as that payment, on the payment date', async () => {
  mockDb({
    bills: [bill({ xero_id: 'food', bill_number: 'Food Expenses', vendor_name: 'HDFC Credit Card -6592',
      date: '2025-03-31', due_date: '2025-04-30', total: 19761.06, balance: 0 })],
    ledger: (day) => ({ food: { asOf: day < '2025-03-31' ? -19761.06 : 0, today: 0 } }),
    postings: [{ source_id: 'food', transaction_date: '2025-02-25', transaction_type: 'ACCPAY', debit: 19761.06, credit: 0 }],
  });
  const r = await build(1, { org_id: 'tenant-1', to_date: '2025-03-15' });
  expect(detail(r)).toEqual([['02/25/2025', 'Bill Payment', 'Food Expenses', -19761.06, -19761.06, -19761.06]]);
});
