'use strict';

// A/R Aging for Xero as of a past date. Xero writes no zb_customer_payments /
// zb_credit_notes, so the invoice balances are rewound from the posting-engine
// ledger (by InvoiceID) plus Xero's dated allocations — never from the sync
// engine's synthetic revaluation / rounding / true-up lines.
jest.mock('../../config/db', () => ({ execute: jest.fn(), query: jest.fn() }));
jest.mock('../zohoChartOfAccountsService', () => ({ getBaseCurrency: jest.fn(async () => 'INR') }));

const ORG = 'tenant-1';
let pool;
let sar;
let ard;
let ledgerSql;

beforeEach(() => {
  jest.resetModules();
  pool = require('../../config/db');
  sar = require('../salesArFromInvoicesService');
  ard = require('../zohoArAgingDetailService');
});

// ledger(cutoffDay) → { [InvoiceID]: { asOf, today } } — the per-invoice A/R
// aggregate the SQL computes for that as-of date.
function mockDb({ invoices = [], ledger = () => ({}), creditDocs = [], allocations = [], synced = [] }) {
  ledgerSql = [];
  pool.execute.mockImplementation(async (sql, params = []) => {
    if (/FROM account_transactions/.test(sql)) ledgerSql.push(sql);
    if (/FROM xero_allocation_sync/.test(sql)) return [synced.map((doc_type) => ({ doc_type }))];
    if (/FROM xero_credit_docs/.test(sql)) return [creditDocs];
    if (/FROM xero_allocations/.test(sql)) return [allocations];
    if (/FROM invoices/.test(sql)) return [invoices.map((i) => ({ ...i }))];
    if (/xero_organizations/.test(sql)) return [[{ x: 1 }]];
    if (/GROUP BY source_id/.test(sql)) {
      const day = String(params[0]).slice(0, 10);
      return [Object.entries(ledger(day)).map(([source_id, v]) => ({ source_id, balance_as_of: v.asOf, balance_today: v.today }))];
    }
    return [[]];
  });
}

const invoice = (over) => ({
  xero_id: 'inv-1', invoice_number: 'INV-1', customer_name: 'Acme', status: 'paid',
  date: '2026-03-01', due_date: '2026-03-15', total: 1000, balance: 0,
  currency_code: 'INR', exchange_rate: 1, ...over,
});
const total = (rep) => { const t = rep.rows.find((r) => r.isTotal); return t.cells.total ?? t.cells.balance; };
const summaryOn = async (d) => total(await sar.buildArAgingSummary(1, { org_id: ORG, to_date: d }));

test('an invoice paid after the as-of date is still owed on it', async () => {
  // Paid 2026-04-10: open on 31 Mar, settled by 30 Apr.
  mockDb({
    invoices: [invoice()],
    ledger: (day) => ({ 'inv-1': { asOf: day < '2026-04-10' ? 1000 : 0, today: 0 } }),
  });
  expect(await summaryOn('2026-03-31')).toBe(1000);
  expect(await summaryOn('2026-04-30')).toBe(0);

  const detail = await ard.buildArAgingDetail(1, { org_id: ORG, to_date: '2026-03-31' });
  const row = detail.rows.find((r) => r.level === 1);
  expect(row.cells).toEqual(expect.objectContaining({ invoice: 'INV-1', balance: 1000 }));
});

test('a TDS credit note allocated after the as-of date is rewound by its allocation date', async () => {
  // 620,900 invoice: customer pays 90% on 20 Jun and a 10% TDS credit note is
  // allocated on 30 Jun. The ledger alone leaves 62,090 open for ever.
  mockDb({
    invoices: [invoice({ xero_id: 'inv-tds', invoice_number: 'CPL940', date: '2023-05-05', due_date: '2023-05-20', total: 620900 })],
    ledger: (day) => ({ 'inv-tds': { asOf: day < '2023-06-20' ? 620900 : 62090, today: 62090 } }),
    synced: ['CREDITNOTE'],
    creditDocs: [{ doc_type: 'CREDITNOTE', doc_id: 'cn-1', xero_type: 'ACCRECCREDIT', side: 'ar', doc_number: 'CN-9',
      contact_name: 'Acme', date: '2023-06-30', status: 'PAID', total: 62090, remaining_credit: 0 }],
    allocations: [{ doc_type: 'CREDITNOTE', doc_id: 'cn-1', kind: 'ALLOCATION', invoice_id: 'inv-tds', date: '2023-06-30', amount: 62090 }],
  });
  expect(await summaryOn('2023-06-15')).toBe(620900);
  expect(await summaryOn('2023-06-25')).toBe(62090);
  expect(await summaryOn('2023-07-01')).toBe(0);
});

test('an invoice whose ledger does not reconcile with Xero keeps its live balance', async () => {
  // Settled by a credit we can't date (allocations not synced) — no guessing.
  mockDb({ invoices: [invoice()], ledger: () => ({ 'inv-1': { asOf: 1000, today: 100 } }) });
  expect(await summaryOn('2026-03-31')).toBe(0);
});

test('every ledger read excludes the sync engine\'s synthetic revaluation / rounding / true-up lines', async () => {
  mockDb({
    invoices: [invoice()],
    ledger: (day) => ({ 'inv-1': { asOf: day < '2026-04-10' ? 1000 : 0, today: 0 } }),
  });
  await sar.buildArAgingSummary(1, { org_id: ORG, to_date: '2026-03-31' });
  await ard.buildArAgingDetail(1, { org_id: ORG, to_date: '2026-03-31' });
  expect(ledgerSql.length).toBeGreaterThan(0);
  for (const sql of ledgerSql) {
    const genuineOnly = sql.includes("transaction_id LIKE 'xero:%'");
    const syntheticExcluded = ['xero-recon:%', 'xero-fxu:%', 'xero-rnd:%'].every((p) => sql.includes(`NOT LIKE '${p}'`));
    expect(genuineOnly || syntheticExcluded).toBe(true);
  }
});

test('an unallocated Xero credit note is a negative line on the as-of date', async () => {
  mockDb({
    synced: ['CREDITNOTE', 'OVERPAYMENT'],
    creditDocs: [{ doc_type: 'CREDITNOTE', doc_id: 'cn-2', xero_type: 'ACCRECCREDIT', side: 'ar', doc_number: 'CN-10',
      contact_name: 'Acme', date: '2026-02-01', status: 'AUTHORISED', total: 300, remaining_credit: 300,
      currency_code: 'INR', currency_rate: 1 }],
  });
  expect(await summaryOn('2026-01-31')).toBe(0);
  expect(await summaryOn('2026-03-31')).toBe(-300);
  const detail = await ard.buildArAgingDetail(1, { org_id: ORG, to_date: '2026-03-31' });
  expect(detail.rows.find((r) => r.level === 1).cells).toEqual(expect.objectContaining({ customer: 'Acme', balance: -300 }));
});
