'use strict';

// Expenses by Vendor Summary for Xero, built with QuickBooks' rules: each
// expense line under its contact when that contact is a supplier (Xero stamps
// the document's contact on every line), else "Not Specified"; cash basis
// counts a bill as it's paid or settled by an allocation.
jest.mock('../../config/db', () => ({ execute: jest.fn(), query: jest.fn() }));
jest.mock('../zohoChartOfAccountsService', () => ({ getBaseCurrency: jest.fn(async () => 'INR') }));

let pool;
let build;

beforeEach(() => {
  jest.resetModules();
  pool = require('../../config/db');
  ({ buildExpensesByVendorSummary: build } = require('../zohoExpensesByVendorSummaryService'));
});

const ORG = 'tenant-1';
const line = (o) => ({
  source_id: 'doc', txn_id: `xero:${o.source_id || 'doc'}`, debit: 0, credit: 0, dt: '2025-06-10',
  ref: null, account: 'Office expenses', details: '', ttype: o.stype, ...o,
});

function mockDb({ lines = [], docLines = [], pays = [], bills = [], vendors = [], customers = [],
  synced = [], creditDocs = [], allocations = [] } = {}) {
  const handler = async (sql) => {
    if (/FROM qbo_organizations/.test(sql)) return [[]];
    if (/FROM xero_organizations/.test(sql)) return [[{ x: 1 }]];
    if (/FROM vendors/.test(sql)) return [vendors.map((n) => ({ contact_name: n }))];
    if (/FROM customers/.test(sql)) return [customers.map((n) => ({ contact_name: n }))];
    if (/FROM xero_allocation_sync/.test(sql)) return [synced.map((doc_type) => ({ doc_type }))];
    if (/FROM xero_credit_docs/.test(sql)) return [creditDocs];
    if (/FROM xero_allocations/.test(sql)) return [allocations];
    if (/FROM bills/.test(sql)) return [bills];
    if (/account_type_code = 'accounts_payable'/.test(sql)) return [pays];
    if (/source_id IN \(\?\)/.test(sql)) return [docLines];
    if (/account_group = 'expense'/.test(sql)) return [lines];
    return [[]];
  };
  pool.execute.mockImplementation(handler);
  pool.query.mockImplementation(handler);
}

const totals = (r) => Object.fromEntries(r.rows.map((x) => [x.label, x.cells.amount]));

test('accrual: each expense line under its supplier, the rest Not Specified, customer-side FX left out', async () => {
  mockDb({
    vendors: ['MC Medcrave', 'HDFC Life Insurance'],
    customers: ['Applaud UK'],
    lines: [
      line({ stype: 'ACCPAY', details: 'MC Medcrave', debit: 548192.37 }),
      // A supplier credit note reduces that supplier's spend.
      line({ stype: 'ACCPAYCREDIT', details: 'HDFC Life Insurance', credit: 520.97 }),
      // Spend money to a payee Xero hasn't flagged as a supplier is still theirs …
      line({ stype: 'BankSPEND', details: 'Swiggy', debit: 1200 }),
      // … unless the payee is a customer.
      line({ stype: 'BankSPEND', details: 'Applaud UK', debit: 300 }),
      // A tax refund received into an expense account: not a supplier's.
      line({ stype: 'BankRECEIVE', details: 'CBDT Tax', credit: 340675 }),
      // Manual journals carry no contact; synthetic revaluations belong to nobody.
      line({ stype: 'ManualJournal', details: 'Salary accrual', debit: 1000 }),
      line({ stype: 'xero-fx-unrealised', txn_id: 'xero-fxu:2025-06', details: 'Unrealised currency gains/losses', credit: 50 }),
      // Realised FX on a customer payment is receivables activity.
      line({ stype: 'ACCRECPAYMENT', details: 'Applaud UK', debit: 999 }),
    ],
  });
  const r = await build(1, { org_id: ORG, from_date: '2025-04-01', to_date: '2026-03-31' });
  expect(totals(r)).toEqual({
    'HDFC Life Insurance': -520.97,
    'MC Medcrave': 548192.37,
    'Not Specified': 300 + 1000 - 340675 - 50, // customer-paid spend, journal, tax refund, revaluation
    Swiggy: 1200,
    TOTAL: 209446.4, // everything above except the customer-payment FX
  });
  expect(r.meta.basis).toBe('Accrual');
});

test('cash: a bill counts pro rata as it is paid or settled by an overpayment — never by a prepayment', async () => {
  // ₹1,000 bill: ₹900 expense + ₹100 tax (tax isn't an expense line).
  const billLine = line({ source_id: 'bill-1', stype: 'ACCPAY', details: 'MC Medcrave', debit: 900, dt: '2025-03-20' });
  mockDb({
    vendors: ['MC Medcrave'],
    bills: [{ xero_id: 'bill-1', total: 1000 }],
    docLines: [billLine],
    pays: [{ source_id: 'bill-1', dt: '2025-05-02', debit: 400, ref: 'Invoice 86' }],
    synced: ['CREDITNOTE', 'OVERPAYMENT', 'PREPAYMENT'],
    creditDocs: [
      { doc_type: 'OVERPAYMENT', doc_id: 'op-1', side: 'ap', status: 'PAID', total: 500, contact_name: 'MC Medcrave', date: '2025-04-08' },
      { doc_type: 'PREPAYMENT', doc_id: 'pp-1', side: 'ap', status: 'PAID', total: 100, contact_name: 'MC Medcrave', date: '2025-03-01' },
    ],
    allocations: [
      { doc_type: 'OVERPAYMENT', doc_id: 'op-1', kind: 'ALLOCATION', invoice_id: 'bill-1', date: '2025-06-01', amount: 500 },
      { doc_type: 'PREPAYMENT', doc_id: 'pp-1', kind: 'ALLOCATION', invoice_id: 'bill-1', date: '2025-06-01', amount: 100 },
    ],
    lines: [
      line({ stype: 'BankSPEND', details: 'Swiggy', debit: 250 }),
      // The bill itself (dated before the year) isn't a cash event …
      billLine,
      // … nor is a revaluation.
      line({ stype: 'xero-fx-unrealised', txn_id: 'xero-fxu:2025-06', credit: 50 }),
    ],
  });
  const r = await build(1, { org_id: ORG, from_date: '2025-04-01', to_date: '2026-03-31', accounting_basis: 'cash' });
  // 900 × 400/1000 paid + 900 × 500/1000 by overpayment; the prepayment share
  // counted when the prepayment itself was spent.
  expect(totals(r)).toEqual({ 'MC Medcrave': 360 + 450, Swiggy: 250, TOTAL: 1060 });
  expect(r.meta.basis).toBe('Cash');
  const drill = r.rows.find((x) => x.label === 'MC Medcrave').cellDrill.amount;
  expect(drill.map((d) => [d.date, d.type, d.amount])).toEqual([
    ['2025-05-02', 'Bill payment', 360],
    ['2025-06-01', 'Overpayment allocated', 450],
  ]);
});

test('cash: a supplier credit note counts as it is allocated or refunded', async () => {
  const cnLine = line({ source_id: 'cn-1', stype: 'ACCPAYCREDIT', details: 'HDFC Life Insurance', credit: 1000, dt: '2025-01-15' });
  mockDb({
    vendors: ['HDFC Life Insurance'],
    docLines: [cnLine],
    synced: ['CREDITNOTE', 'OVERPAYMENT'],
    creditDocs: [{ doc_type: 'CREDITNOTE', doc_id: 'cn-1', doc_number: 'CN-7', side: 'ap', status: 'PAID', total: 1000,
      contact_name: 'HDFC Life Insurance', date: '2025-01-15' }],
    allocations: [
      { doc_type: 'CREDITNOTE', doc_id: 'cn-1', kind: 'ALLOCATION', invoice_id: 'bill-9', date: '2025-01-20', amount: 400 }, // before the period
      { doc_type: 'CREDITNOTE', doc_id: 'cn-1', kind: 'REFUND', invoice_id: null, date: '2025-07-01', amount: 600 },
    ],
  });
  const r = await build(1, { org_id: ORG, from_date: '2025-04-01', to_date: '2026-03-31', accounting_basis: 'cash' });
  expect(totals(r)).toEqual({ 'HDFC Life Insurance': -600, TOTAL: -600 });
});

test('cash: says so when allocations haven\'t been synced yet', async () => {
  mockDb({ lines: [line({ stype: 'BankSPEND', details: 'Swiggy', debit: 10 })] });
  const r = await build(1, { org_id: ORG, from_date: '2025-04-01', to_date: '2026-03-31', accounting_basis: 'cash' });
  expect(r.meta.note).toMatch(/allocations are synced/);
});
