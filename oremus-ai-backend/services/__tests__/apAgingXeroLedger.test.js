'use strict';

// A/P Aging for Xero, rebuilt from the posting-engine ledger. Xero's A/P lines
// carry the bill's InvoiceID as source_id (transaction_number is just the line
// index), Xero overpayments sit on A/P until allocated, and Xero's CurrencyRate
// runs foreign-per-base — each of which the shared builder has to honour.
jest.mock('../../config/db', () => ({ execute: jest.fn(), query: jest.fn() }));
jest.mock('../zohoChartOfAccountsService', () => ({ getBaseCurrency: jest.fn(async () => 'INR') }));

const ORG = 'tenant-1';
let pool;
let ap;

beforeEach(() => {
  jest.resetModules();
  pool = require('../../config/db');
  ap = require('../zohoApAgingDetailService');
});

// bills: rows of the bills table. bySource: source_id → { asOf, today } (the
// ledger aggregate the SQL computes). numberRows: what the legacy
// transaction_number␟vendor aggregate returns. vendorLines: the per-vendor A/P
// lines fetchUnallocatedVendorCredits reads.
// syncedTypes: which Xero credit document types xero_allocation_sync records
// (defaults to all three once any credit docs/allocations are given).
function mockDb({ bills = [], bySource = {}, numberRows = [], postings = [], vendorLines = [], creditDocs = [], allocations = [], syncedTypes }) {
  const synced = syncedTypes || (creditDocs.length || allocations.length ? ['CREDITNOTE', 'OVERPAYMENT', 'PREPAYMENT'] : []);
  pool.execute.mockImplementation(async (sql) => {
    if (/FROM xero_allocation_sync/.test(sql)) return [synced.map((doc_type) => ({ doc_type }))];
    if (/FROM xero_credit_docs/.test(sql)) return [creditDocs];
    if (/FROM xero_allocations/.test(sql)) return [allocations];
    if (/FROM bills/.test(sql)) return [bills.map((b) => ({ ...b }))];
    if (/qbo_organizations/.test(sql)) return [[]];
    if (/xero_organizations/.test(sql)) return [[{ x: 1 }]];
    if (/GROUP BY transaction_number, transaction_details/.test(sql)) return [numberRows];
    if (/GROUP BY source_id\s*$/.test(sql)) {
      return [Object.entries(bySource).map(([source_id, v]) => ({ source_id, balance_as_of: v.asOf, balance_today: v.today }))];
    }
    if (/GROUP BY vendor, source_id, source_type/.test(sql)) return [vendorLines];
    if (/ORDER BY transaction_date/.test(sql)) return [postings];
    return [[]];
  });
}

const bill = (over) => ({
  qbo_id: null, xero_id: 'inv-1', bill_number: '102', vendor_name: 'MC Medcrave',
  date: '2026-01-02', due_date: '2026-01-02', total: 592048, balance: 0,
  currency_code: 'INR', exchange_rate: 1, ...over,
});
const total = (rep, key = 'total') => rep.rows.find((r) => r.isTotal).cells[key];

test('a Xero bill paid after the as-of date is still owed on it (keyed by source_id, not line index)', async () => {
  mockDb({
    bills: [bill()],
    // Line-index transaction_numbers ('5', '6') can never match bill number '102'.
    numberRows: [
      { transaction_number: '5', transaction_details: 'MC Medcrave', balance_as_of: 592048, balance_today: 592048 },
      { transaction_number: '6', transaction_details: 'MC Medcrave', balance_as_of: 0, balance_today: -592048 },
    ],
    bySource: { 'inv-1': { asOf: 592048, today: 0 } },
    postings: [{ source_id: 'inv-1', transaction_date: '2026-01-02', transaction_type: 'ACCPAY', credit: 592048, debit: 0, reference_number: '102' }],
  });

  const summary = await ap.buildApAgingSummary(1, { org_id: ORG, to_date: '2026-01-05' });
  expect(total(summary)).toBe(592048);

  const detail = await ap.buildApAgingDetail(1, { org_id: ORG, to_date: '2026-01-05' });
  const row = detail.rows.find((r) => r.cells?.invoice === '102');
  expect(row.cells.balance).toBe(592048);
  expect(row.cellDrill.balance).toEqual([
    expect.objectContaining({ date: '2026-01-02', type: 'ACCPAY', amount: 592048 }),
  ]);
});

test('a bill whose ledger does not reconcile with Xero keeps its live balance', async () => {
  // Settled by an overpayment allocation the ledger can't date: today's ledger
  // (592048) disagrees with Xero's AmountDue (0) → untrusted, unchanged.
  mockDb({ bills: [bill()], bySource: { 'inv-1': { asOf: 592048, today: 592048 } } });
  const summary = await ap.buildApAgingSummary(1, { org_id: ORG, to_date: '2026-01-05' });
  expect(total(summary)).toBe(0);
});

test('a sub-rupee ledger residual never leaves a paid Xero bill open today', async () => {
  mockDb({ bills: [bill()], bySource: { 'inv-1': { asOf: 0.48, today: 0.48 } } });
  const summary = await ap.buildApAgingSummary(1, { org_id: ORG, to_date: '2026-10-15' });
  expect(total(summary)).toBe(0);
});

test('an unallocated Xero overpayment reduces the vendor like a credit note does', async () => {
  mockDb({
    vendorLines: [
      { vendor: 'Care health', source_id: 'op-1', source_type: 'BankSPEND-OVERPAYMENT', doc_date: '2026-06-05', net: -1947000 },
      { vendor: 'Care health', source_id: 'op-2', source_type: 'BankSPEND-OVERPAYMENT', doc_date: '2026-06-05', net: -50000 },
    ],
  });
  const summary = await ap.buildApAgingSummary(1, { org_id: ORG, to_date: '2026-10-15' });
  expect(total(summary)).toBe(-1997000);

  const detail = await ap.buildApAgingDetail(1, { org_id: ORG, to_date: '2026-10-15' });
  const types = detail.rows.filter((r) => r.level === 1).map((r) => r.cells.txnType);
  expect(types).toEqual(['Overpayment', 'Overpayment']);
});

test('a foreign-currency Xero bill is aged in base currency at its own rate', async () => {
  // Xero CurrencyRate 0.010956 = GBP per 1 INR → divide.
  mockDb({
    bills: [bill({ xero_id: 'inv-gbp', bill_number: '1275', vendor_name: 'Applaud UK', date: '2018-03-31',
      due_date: '2018-03-31', total: 91931.19, balance: 0, currency_code: 'GBP', exchange_rate: 0.010956 })],
    bySource: { 'inv-gbp': { asOf: 91931.19, today: 0 } },
  });
  const summary = await ap.buildApAgingSummary(1, { org_id: ORG, to_date: '2018-12-31' });
  expect(total(summary)).toBeCloseTo(91931.19 / 0.010956, 0);
});

// Xero's own dated allocations (xero_credit_docs / xero_allocations).
const OVERPAYMENT = {
  doc_type: 'OVERPAYMENT', doc_id: 'op-1', xero_type: 'SPEND-OVERPAYMENT', side: 'ap',
  doc_number: null, reference: 'Advance', contact_name: 'Salary', date: '2022-06-08',
  status: 'PAID', total: 40000, remaining_credit: 0, currency_code: 'INR', currency_rate: 1,
};

test('a bill settled by an overpayment allocation is open until the allocation date', async () => {
  // The ledger only has the bill's own A/P credit (no allocation line), so
  // without the allocation the bill never reconciled and read 0 on every date.
  const salaryBill = bill({ xero_id: 'inv-sal', bill_number: 'JUN-22', vendor_name: 'Salary',
    date: '2022-05-31', due_date: '2022-05-31', total: 40000, balance: 0 });
  const allocations = [{ doc_type: 'OVERPAYMENT', doc_id: 'op-1', kind: 'ALLOCATION', invoice_id: 'inv-sal', date: '2022-06-10', amount: 40000 }];
  const setup = { bills: [salaryBill], bySource: { 'inv-sal': { asOf: 40000, today: 40000 } }, creditDocs: [OVERPAYMENT], allocations };

  mockDb(setup);
  // Before the overpayment existed: the bill is fully owed.
  expect(total(await ap.buildApAgingSummary(1, { org_id: ORG, to_date: '2022-06-01' }))).toBe(40000);
  // Overpayment made, not yet allocated: bill owed, overpayment held as credit.
  expect(total(await ap.buildApAgingSummary(1, { org_id: ORG, to_date: '2022-06-09' }))).toBe(0);
  const detail = await ap.buildApAgingDetail(1, { org_id: ORG, to_date: '2022-06-09' });
  expect(detail.rows.filter((r) => r.level === 1).map((r) => [r.cells.txnType, r.cells.balance]))
    .toEqual([['Bill', 40000], ['Overpayment', -40000]]);
  // After the allocation: nothing open.
  const after = await ap.buildApAgingDetail(1, { org_id: ORG, to_date: '2022-06-30' });
  expect(after.rows.filter((r) => r.level === 1)).toEqual([]);
});

test('a partly allocated or refunded credit is listed at its open amount on the date', async () => {
  mockDb({
    creditDocs: [{ ...OVERPAYMENT, doc_type: 'CREDITNOTE', doc_id: 'cn-1', doc_number: 'CN-7', xero_type: 'ACCPAYCREDIT',
      contact_name: 'Printo', date: '2023-01-31', total: 1000, status: 'AUTHORISED', remaining_credit: 300 }],
    allocations: [
      { doc_type: 'CREDITNOTE', doc_id: 'cn-1', kind: 'ALLOCATION', invoice_id: 'inv-x', date: '2023-02-15', amount: 500 },
      { doc_type: 'CREDITNOTE', doc_id: 'cn-1', kind: 'REFUND', invoice_id: null, date: '2023-03-10', amount: 200 },
    ],
  });
  const at = async (d) => total(await ap.buildApAgingSummary(1, { org_id: ORG, to_date: d }));
  expect(await at('2023-01-30')).toBe(0);
  expect(await at('2023-02-01')).toBe(-1000);
  expect(await at('2023-02-20')).toBe(-500);
  expect(await at('2023-03-31')).toBe(-300);
  const detail = await ap.buildApAgingDetail(1, { org_id: ORG, to_date: '2023-03-31' });
  expect(detail.rows.find((r) => r.level === 1).cells).toEqual(expect.objectContaining({ txnType: 'Vendor Credit', invoice: 'CN-7', balance: -300 }));
});

test('voided credit documents are ignored', async () => {
  mockDb({ creditDocs: [{ ...OVERPAYMENT, status: 'VOIDED', remaining_credit: 40000 }] });
  expect(total(await ap.buildApAgingSummary(1, { org_id: ORG, to_date: '2022-06-09' }))).toBe(0);
});

test('until overpayments are synced, open credits still come from the ledger', async () => {
  // Credit notes synced (no open ones), overpayments not yet (scope missing):
  // the Care health overpayment must still be listed from the ledger.
  mockDb({
    syncedTypes: ['CREDITNOTE'],
    vendorLines: [{ vendor: 'Care health', source_id: 'op-1', source_type: 'BankSPEND-OVERPAYMENT', doc_date: '2026-06-05', net: -1997000 }],
  });
  const credits = await ap.fetchUnallocatedVendorCredits(1, ORG, new Date('2026-10-15'));
  expect(credits).toEqual([expect.objectContaining({ vendor: 'Care health', amount: -1997000, type: 'Overpayment' })]);
});

test('a bill paid before it was issued shows as a credit between the two dates', async () => {
  // "Food Expenses" bill dated 31 Mar, paid 25 Feb: on 15 Mar Xero lists the
  // payment as a -19,761.06 credit; before 25 Feb and after 31 Mar nothing.
  const food = bill({ xero_id: 'inv-food', bill_number: 'Food Expenses', vendor_name: 'HDFC Credit Card -6592',
    date: '2025-03-31', due_date: '2025-03-31', total: 19761.06, balance: 0 });
  mockDb({
    bills: [food],
    bySource: { 'inv-food': { asOf: -19761.06, today: 0 } },
  });
  expect(total(await ap.buildApAgingSummary(1, { org_id: ORG, to_date: '2025-03-15' }))).toBe(-19761.06);

  // A bill dated later whose balance only fell back to Xero's live figure says
  // nothing about the past — never pulled into an earlier date.
  mockDb({ bills: [{ ...food, balance: 500 }], bySource: { 'inv-food': { asOf: -19761.06, today: 0 } } });
  expect(total(await ap.buildApAgingSummary(1, { org_id: ORG, to_date: '2025-03-15' }))).toBe(0);
});
