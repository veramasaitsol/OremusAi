'use strict';

// QuickBooks Vendor Balance Detail. QuickBooks lists every A/P transaction
// dated on or before the report date at its open balance TODAY — a bill dated
// before the date but paid after it is left out, a part-paid one shows what's
// still open now — unlike its A/P Aging, which rewinds balances to the date.
jest.mock('../../config/db', () => ({ execute: jest.fn(), query: jest.fn() }));
jest.mock('../zohoChartOfAccountsService', () => ({ getBaseCurrency: jest.fn(async () => 'USD') }));

let pool;
let buildVendorBalanceDetail;
let buildApAgingSummary;

beforeEach(() => {
  jest.resetModules();
  pool = require('../../config/db');
  ({ buildVendorBalanceDetail } = require('../zohoVendorBalanceDetailService'));
  ({ buildApAgingSummary } = require('../zohoApAgingDetailService'));
});

const VENDORS = [
  { contact_name: 'Core-Mark', outstanding_payable_amount: 116.03 },
  { contact_name: 'Saleswinnr', outstanding_payable_amount: 0 },
  { contact_name: 'Oremus Corporation NA', outstanding_payable_amount: 0 },
];
const bill = (qbo_id, vendor_name, date, total, balance) => ({
  qbo_id, xero_id: null, bill_number: `B-${qbo_id}`, vendor_name, date, due_date: date,
  total, balance, currency_code: 'USD', exchange_rate: 1,
});
const BILLS = [
  bill('1257', 'Core-Mark', '2025-12-31', 9339.6, 116.03),   // part-paid on 2026-01-05
  bill('2318', 'Saleswinnr', '2025-11-30', 72898.02, 0),     // paid in full on 2026-02-02
  bill('2600', 'Core-Mark', '2026-01-10', 500, 500),         // dated after the report date
];
const LINKS = [
  { payment_id: '1402', d: '2026-01-05', payment_total: 9223.57, target_type: 'Bill', target_id: '1257', amount: 9223.57 },
  { payment_id: '2001', d: '2026-02-02', payment_total: 72898.02, target_type: 'Bill', target_id: '2318', amount: 72898.02 },
  // A payment applied to a journal entry that CREDITED A/P pays it, like a bill.
  { payment_id: '2086', d: '2025-11-27', payment_total: 200, target_type: 'JournalEntry', target_id: '1418', amount: 200 },
];
const AP_DOCS = [
  { source_type: 'Bill', source_id: '1257', reference_number: 'B-1257', transaction_details: 'Core-Mark', doc_date: '2025-12-31', net: 9339.6 },
  { source_type: 'Journal Entry', source_id: '1418', reference_number: '84', transaction_details: 'Oremus Corporation NA', doc_date: '2025-11-20', net: 200 },
  { source_type: 'Bill Payment (Check)', source_id: '2086', reference_number: '', transaction_details: 'Oremus Corporation NA', doc_date: '2025-11-27', net: -200 },
];

beforeEach(() => {
  pool.execute.mockImplementation(async (sql) => {
    if (/FROM (qbo_organizations)/.test(sql)) return [[{ x: 1 }]];
    if (/FROM xero_organizations/.test(sql)) return [[]];
    if (/FROM bills/.test(sql)) return [BILLS.map((b) => ({ ...b }))];
    if (/FROM vendors/.test(sql)) return [VENDORS];
    if (/FROM qbo_ap_links/.test(sql)) return [LINKS];
    if (/GROUP BY source_type, source_id/.test(sql)) return [AP_DOCS];
    return [[]];
  });
});

const lines = (report) => report.rows.filter((r) => r.level === 1)
  .map((r) => [r.label, r.cells.txnType, r.cells.amount, r.cells.open, r.cells.balance]);

test('lists transactions dated up to the report date at their open balance today', async () => {
  const report = await buildVendorBalanceDetail(29, { org_id: '1', to_date: '2025-12-31' });
  expect(lines(report)).toEqual([['12/31/2025', 'Bill', 9339.6, 116.03, 116.03]]);
  expect(report.rows.at(-1).cells).toEqual({ amount: 9339.6, open: 116.03, balance: 116.03 });
});

test('A/P Aging still rewinds to the report date', async () => {
  const report = await buildApAgingSummary(29, { org_id: '1', to_date: '2025-12-31', as_of_date: '2025-12-31' });
  const total = report.rows.find((r) => r.isTotal);
  // Both bills were fully open on 2025-12-31; the journal was already paid.
  expect(Object.values(total.cells).at(-1)).toBeCloseTo(9339.6 + 72898.02, 2);
  expect(report.rows.some((r) => r.label === 'Oremus Corporation NA')).toBe(false);
});

test('same-day transactions run in QuickBooks transaction order', async () => {
  BILLS.push(bill('3144', 'Core-Mark', '2025-12-31', 10, 10), bill('1300', 'Core-Mark', '2025-12-31', 20, 20));
  try {
    const report = await buildVendorBalanceDetail(29, { org_id: '1', to_date: '2025-12-31' });
    expect(lines(report).map((l) => l[3])).toEqual([116.03, 20, 10]);
    expect(lines(report).map((l) => l[4])).toEqual([116.03, 136.03, 146.03]);
  } finally {
    BILLS.splice(3);
  }
});
