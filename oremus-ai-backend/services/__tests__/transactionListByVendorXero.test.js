'use strict';

// Transaction List by Vendor for Xero, laid out the QuickBooks way: every
// transaction naming a vendor, once, on the account it books to — bills and
// credit notes on Accounts Payable, payments and spend/receive money on the
// bank — with the posting engine's clearing and settlement plumbing kept out.
jest.mock('../../config/db', () => ({ execute: jest.fn(), query: jest.fn() }));
jest.mock('../zohoChartOfAccountsService', () => ({ getBaseCurrency: jest.fn(async () => 'INR') }));

let pool;
let build;

beforeEach(() => {
  jest.resetModules();
  pool = require('../../config/db');
  ({ buildTransactionListByVendor: build } = require('../zohoTransactionListByVendorService'));
});

const ACCOUNTS = [
  { xero_id: 'ap', code: '800', name: 'Accounts Payable' },
  { xero_id: 'hdfc', code: '10025', name: 'HDFC Account' },
  { xero_id: 'rent', code: '469', name: 'Rent' },
  { xero_id: 'gst', code: '820', name: 'Input CGST 9%' },
  { xero_id: 'it', code: '463', name: 'IT Software and Consumables' },
  { xero_id: 'office', code: '453', name: 'Office expenses' },
  { xero_id: 'fx', code: '499', name: 'Realised Currency Gains' },
];
const ACCT = {
  ap: ['ap', 'Accounts Payable', 'accounts_payable'],
  bank: ['hdfc', 'HDFC Account', 'bank'],
  clearing: ['XERO-CLEARING', 'Xero Payments Clearing', 'bank'],
  rent: ['rent', 'Rent', 'expense'],
  gst: ['gst', 'Input CGST 9%', 'other_current_asset'],
  it: ['it', 'IT Software and Consumables', 'expense'],
  office: ['office', 'Office expenses', 'expense'],
  fx: ['fx', 'Realised Currency Gains', 'expense'],
};
// One posting line; `fxOnly` = a base-currency-only realised FX line.
function line(source_type, source_id, [account_id, account_name, account_type_code], { dr = 0, cr = 0, who, ref = null, date = '2026-09-02', fxOnly = false }) {
  return {
    source_id, source_type, transaction_date: date, account_id, account_name, account_type_code,
    debit: dr, credit: cr, ndebit: fxOnly ? 0 : dr, ncredit: fxOnly ? 0 : cr,
    transaction_details: who, reference_number: ref,
  };
}

function mockDb({ lines = [], vendors = [], customers = [] }) {
  const handler = async (sql) => {
    if (/track_1099 = 1/.test(sql)) return [[]];
    if (/FROM vendors/.test(sql)) return [vendors.map((contact_name) => ({ contact_name }))];
    if (/FROM customers/.test(sql)) return [customers.map((contact_name) => ({ contact_name }))];
    if (/FROM xero_accounts/.test(sql)) return [ACCOUNTS];
    if (/FROM account_transactions/.test(sql)) return [lines];
    return [[]];
  };
  pool.execute.mockImplementation(handler);
  pool.query.mockImplementation(handler);
}

const run = (over = {}) => build(1, { org_id: 'tenant-1', platform: 'xero', from_date: '2026-09-01', to_date: '2026-09-30', ...over });
const detail = (r) => r.rows.filter((x) => x.level === 1).map((x) => ({ date: x.label, ...x.cells }));

test('a bill on Accounts Payable (+) and its payment on the bank (−) — the settlement plumbing is not a transaction', async () => {
  const who = 'MC Medcrave';
  mockDb({
    vendors: [who],
    lines: [
      line('ACCPAY', 'bill-110', ACCT.rent, { dr: 180000, who, ref: '110' }),
      line('ACCPAY', 'bill-110', ACCT.gst, { dr: 17349, who, ref: '110' }),
      line('ACCPAY', 'bill-110', ACCT.ap, { cr: 197349, who, ref: '110' }),
      // The posting engine's settlement pair on the bill, dated the payment.
      line('ACCPAY', 'bill-110', ACCT.ap, { dr: 197349, who, ref: '110', date: '2026-09-07' }),
      line('ACCPAY', 'bill-110', ACCT.clearing, { cr: 197349, who, ref: '110', date: '2026-09-07' }),
      // The payment itself: clearing → bank, with a realised FX difference.
      line('ACCPAYPAYMENT', 'pay-1', ACCT.clearing, { dr: 197349, who, ref: '110', date: '2026-09-07' }),
      line('ACCPAYPAYMENT', 'pay-1', ACCT.bank, { cr: 197349.03, who, ref: '110', date: '2026-09-07' }),
      line('ACCPAYPAYMENT', 'pay-1', ACCT.fx, { dr: 0.03, who, ref: '110', date: '2026-09-07', fxOnly: true }),
    ],
  });
  const r = await run();
  expect(detail(r)).toEqual([
    expect.objectContaining({ date: '09/02/2026', type: 'Bill', num: '110', account: '800 Accounts Payable', split: '', amount: 197349 }),
    expect.objectContaining({ date: '09/07/2026', type: 'Bill Payment', num: '110', account: '10025 HDFC Account', split: 'Accounts Payable', amount: -197349.03 }),
  ]);
  expect(r.rows.find((x) => x.isTotal).cells.amount).toBe(-0.03);
});

test('a bill from before the period paid within it lists only the payment', async () => {
  const who = 'MC Medcrave';
  mockDb({
    vendors: [who],
    lines: [
      line('ACCPAY', 'bill-old', ACCT.ap, { dr: 500, who, date: '2026-09-05' }),
      line('ACCPAY', 'bill-old', ACCT.clearing, { cr: 500, who, date: '2026-09-05' }),
      line('ACCPAYPAYMENT', 'pay-2', ACCT.clearing, { dr: 500, who, date: '2026-09-05' }),
      line('ACCPAYPAYMENT', 'pay-2', ACCT.bank, { cr: 500, who, date: '2026-09-05' }),
    ],
  });
  expect(detail(await run()).map((d) => [d.type, d.amount])).toEqual([['Bill Payment', -500]]);
});

test('spend and receive money on the bank; a single other line is the split', async () => {
  mockDb({
    vendors: ['HDFC Life Insurance'],
    customers: ['Applaud UK'],
    lines: [
      line('BankSPEND', 's1', ACCT.it, { dr: 4015.47, who: 'Amazon' }),
      line('BankSPEND', 's1', ACCT.bank, { cr: 4015.47, who: 'Amazon' }),
      // Two expense lines: no single split.
      line('BankSPEND', 's2', ACCT.it, { dr: 100, who: 'Amazon', date: '2026-09-03' }),
      line('BankSPEND', 's2', ACCT.office, { dr: 50, who: 'Amazon', date: '2026-09-03' }),
      line('BankSPEND', 's2', ACCT.bank, { cr: 150, who: 'Amazon', date: '2026-09-03' }),
      // Paid to a customer — not a vendor's.
      line('BankSPEND', 's3', ACCT.office, { dr: 300, who: 'Applaud UK' }),
      line('BankSPEND', 's3', ACCT.bank, { cr: 300, who: 'Applaud UK' }),
      // A refund from a supplier is listed; a tax refund isn't a vendor's.
      line('BankRECEIVE', 'r1', ACCT.bank, { dr: 520.97, who: 'HDFC Life Insurance' }),
      line('BankRECEIVE', 'r1', ACCT.office, { cr: 520.97, who: 'HDFC Life Insurance' }),
      line('BankRECEIVE', 'r2', ACCT.bank, { dr: 340675, who: 'CBDT Tax' }),
      line('BankRECEIVE', 'r2', ACCT.office, { cr: 340675, who: 'CBDT Tax' }),
    ],
  });
  expect(detail(await run()).map((d) => [d.type, d.account, d.split, d.amount])).toEqual([
    ['Spend Money', '10025 HDFC Account', 'IT Software and Consumables', -4015.47],
    ['Spend Money', '10025 HDFC Account', '', -150],
    ['Receive Money', '10025 HDFC Account', 'Office expenses', 520.97],
  ]);
});

test('a supplier credit note on Accounts Payable (−), its cash refund on the bank (+)', async () => {
  const who = 'HDFC Life Insurance';
  mockDb({
    vendors: [who],
    lines: [
      line('ACCPAYCREDIT', 'cn-1', ACCT.office, { cr: 1000, who, ref: 'CN-7' }),
      line('ACCPAYCREDIT', 'cn-1', ACCT.ap, { dr: 1000, who, ref: 'CN-7' }),
      line('APCREDITPAYMENT', 'refund-1', ACCT.bank, { dr: 600, who, date: '2026-09-20' }),
      line('APCREDITPAYMENT', 'refund-1', ACCT.ap, { cr: 600, who, date: '2026-09-20' }),
    ],
  });
  expect(detail(await run()).map((d) => [d.type, d.num, d.account, d.split, d.amount])).toEqual([
    ['Vendor Credit', 'CN-7', '800 Accounts Payable', 'Office expenses', -1000],
    ['Credit Note Refund', '', '10025 HDFC Account', 'Accounts Payable', 600],
  ]);
});

test('says so when bills were paid but the connection could not read payments', async () => {
  const who = 'MC Medcrave';
  mockDb({
    vendors: [who],
    lines: [
      line('ACCPAY', 'bill-old', ACCT.ap, { dr: 500, who }),
      line('ACCPAY', 'bill-old', ACCT.clearing, { cr: 500, who }),
    ],
  });
  expect((await run()).meta.note).toMatch(/accounting\.payments\.read/);
});
