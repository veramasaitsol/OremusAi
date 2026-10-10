'use strict';

// Transaction List by Vendor. QuickBooks lists every transaction that names a
// vendor, once, on the account the transaction books to (bills on A/P, payments
// and deposits on the bank), with journal entries carrying no amount. Zoho and
// Xero keep following Accounts Payable.
jest.mock('../../config/db', () => ({ execute: jest.fn(), query: jest.fn() }));
jest.mock('../zohoChartOfAccountsService', () => ({ getBaseCurrency: jest.fn(async () => 'USD') }));

let pool;
let buildTransactionListByVendor;

beforeEach(() => {
  jest.resetModules();
  pool = require('../../config/db');
  ({ buildTransactionListByVendor } = require('../zohoTransactionListByVendorService'));
});

const ACCOUNTS = [
  { qbo_id: '7', name: 'Accounts Payable', fully_qualified_name: 'Accounts Payable', account_number: '2001' },
  { qbo_id: '151', name: 'Payroll 4295', fully_qualified_name: 'Payroll 4295', account_number: '1004' },
  { qbo_id: '152', name: 'Operating 8245', fully_qualified_name: 'Operating 8245', account_number: '1005' },
  { qbo_id: '60', name: 'Inside Purchases', fully_qualified_name: 'Inside Purchases', account_number: null },
  { qbo_id: '61', name: 'Repairs', fully_qualified_name: 'Expenses:Repairs', account_number: null },
  { qbo_id: '70', name: 'Clipper Receivable', fully_qualified_name: 'Clipper Receivable', account_number: null },
  { qbo_id: '80', name: 'WM Payable', fully_qualified_name: 'WM Payable', account_number: null },
  { qbo_id: '168', name: 'Accounts Payable - INR', fully_qualified_name: 'Accounts Payable - INR', account_number: null },
  { qbo_id: '166', name: 'Exchange Gain or Loss', fully_qualified_name: 'Exchange Gain or Loss', account_number: null,
    account_sub_type: 'ExchangeGainOrLoss' },
  { qbo_id: '163', name: 'Mercury Credit card', fully_qualified_name: 'Mercury Credit card', account_number: null },
];
const AP = ['7', 'Accounts Payable', 'accounts_payable'];
const AP_INR = ['168', 'Accounts Payable - INR', 'accounts_payable'];
const FX = ['166', 'Exchange Gain or Loss', 'other_expense'];
const CARD = ['163', 'Mercury Credit card', 'other_current_liability'];
const BANK = ['152', 'Operating 8245', 'bank'];
const BANK2 = ['151', 'Payroll 4295', 'bank'];
const PURCHASES = ['60', 'Inside Purchases', 'cost_of_goods_sold'];
const REPAIRS = ['61', 'Repairs', 'expense'];
const RECEIVABLE = ['70', 'Clipper Receivable', 'other_current_asset'];

let lineNo = 0;
function line(id, type, [account_id, account_name, account_type_code], { dr = 0, cr = 0, name = null, ref = null, date = '2026-03-02', memo } = {}) {
  return {
    source_id: id, source_type: type, transaction_type: type, transaction_date: date,
    account_id, account_name, account_type_code, debit: dr, credit: cr,
    transaction_details: name, reference_number: ref, line_number: lineNo++,
    ...(memo !== undefined ? { memo } : {}),
  };
}

// A synced QuickBooks bill payment: one qbo_ap_links row per document it settled.
function payment(id, { total, vendor, date = '2026-03-02', num = null, payType = 'Check', memo = null, targets = [] }) {
  return (targets.length ? targets : ['']).map((target_id) => ({
    payment_id: id, payment_date: date, payment_total: total, vendor_name: vendor,
    doc_number: num, pay_type: payType, memo, target_id,
  }));
}

function mockDb({ lines = [], vendors = [], bills = [], purchases = [], vendorDocs = [], payments = [], memoColumn = true } = {}) {
  pool.execute.mockImplementation(async (sql) => {
    if (/information_schema\.COLUMNS/.test(sql)) return [[{ n: memoColumn ? 1 : 0 }]];
    if (/FROM account_transactions/.test(sql)) return [lines];
    if (/track_1099 = 1/.test(sql)) return [[]];
    if (/UNION ALL/.test(sql)) return [vendorDocs];
    if (/FROM vendors/.test(sql)) return [vendors.map((contact_name) => ({ contact_name }))];
    if (/FROM qbo_accounts/.test(sql)) return [ACCOUNTS];
    if (/FROM bills/.test(sql)) return [bills];
    if (/FROM expense_entries/.test(sql)) return [purchases];
    if (/FROM qbo_ap_links/.test(sql)) return [payments.flat()];
    throw new Error(`unexpected SQL: ${sql}`);
  });
  pool.query.mockImplementation(async (sql, [, , ids]) => {
    if (/account_type_code = 'accounts_payable' AND source_id IN/.test(sql)) {
      return [lines.filter((l) => l.account_type_code === 'accounts_payable' && ids.includes(l.source_id))
        .map(({ source_id, account_id, account_name }) => ({ source_id, account_id, account_name }))];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

async function run(db, params = {}) {
  mockDb(db);
  const res = await buildTransactionListByVendor(34, {
    org_id: 'REALM-1', platform: 'quickbooks', from_date: '2026-01-01', to_date: '2026-12-31', ...params,
  });
  const rows = [];
  const totals = {};
  let vendor = null;
  for (const r of res.rows) {
    if (r.isHeader) vendor = r.label;
    else if (r.isSubtotal) totals[r.label.replace(/^Total for /, '')] = r.cells.amount;
    else if (r.isTotal) totals.TOTAL = r.cells.amount;
    else rows.push({ vendor, date: r.label, ...r.cells });
  }
  return { rows, totals };
}

const ledgerSql = () => pool.execute.mock.calls.map(([sql]) => sql).find((sql) => /FROM account_transactions/.test(sql));

describe('buildTransactionListByVendor — QuickBooks', () => {
  test('a bill and its payment: the bill on A/P (+), the payment on the bank (−)', async () => {
    const { rows, totals } = await run({
      vendors: ['Ajax'],
      lines: [
        line('600', 'Bill', AP, { cr: 733.81, name: 'Ajax', ref: '77587' }),
        line('600', 'Bill', PURCHASES, { dr: 733.81, name: 'Ajax', ref: '77587' }),
        line('601', 'Bill Payment (Check)', AP, { dr: 733.81, name: 'Ajax' }),
        line('601', 'Bill Payment (Check)', BANK, { cr: 733.81, name: 'Ajax' }),
      ],
      bills: [{ qbo_id: '600', vendor_name: 'Ajax', bill_number: '0077587' }],
    });
    expect(rows).toEqual([
      expect.objectContaining({ vendor: 'Ajax', date: '03/02/2026', type: 'Bill', num: '0077587',
        account: '2001 Accounts Payable', split: 'Inside Purchases', amount: 733.81, track: 'No', posting: 'Yes' }),
      expect.objectContaining({ vendor: 'Ajax', type: 'Bill Payment (Check)', num: '',
        account: '1005 Operating 8245', split: 'Accounts Payable', amount: -733.81 }),
    ]);
    expect(totals).toEqual({ Ajax: 0, TOTAL: 0 });
  });

  test("lists a vendor's deposits and checks too, not only what touched A/P", async () => {
    const { rows, totals } = await run({
      vendors: ['Clipper', 'precision power washing'],
      lines: [
        line('137', 'Deposit', BANK, { dr: 46300.58, name: 'Clipper' }),
        line('137', 'Deposit', RECEIVABLE, { cr: 46300.58, name: 'Clipper' }),
        line('157', 'Check', BANK, { cr: 300, name: 'precision power washing', ref: '157' }),
        line('157', 'Check', REPAIRS, { dr: 300, name: 'precision power washing', ref: '157' }),
      ],
    });
    expect(rows).toEqual([
      expect.objectContaining({ vendor: 'Clipper', type: 'Deposit', account: '1005 Operating 8245',
        split: 'Clipper Receivable', amount: 46300.58 }),
      expect.objectContaining({ vendor: 'precision power washing', type: 'Check', num: '157',
        account: '1005 Operating 8245', split: 'Repairs', amount: -300 }),
    ]);
    expect(totals.TOTAL).toBe(46000.58);
  });

  test('an expense paid against A/P is listed once, on the bank it was paid from', async () => {
    const { rows } = await run({
      vendors: ['Circle K'],
      lines: [
        line('700', 'Expense', BANK, { cr: 20529.62, name: 'Circle K' }),
        line('700', 'Expense', AP, { dr: 20529.62, name: 'Circle K' }),
      ],
    });
    expect(rows).toEqual([
      expect.objectContaining({ vendor: 'Circle K', type: 'Expense', account: '1005 Operating 8245',
        split: 'Accounts Payable', amount: -20529.62 }),
    ]);
  });

  test('a deposit between two banks books to the account deposited to', async () => {
    const { rows } = await run({
      vendors: ['Clipper'],
      lines: [
        line('890', 'Deposit', BANK2, { dr: 2000, name: 'Clipper' }),
        line('890', 'Deposit', BANK, { cr: 2000, name: 'Clipper' }),
      ],
    });
    expect(rows).toEqual([
      expect.objectContaining({ account: '1004 Payroll 4295', split: 'Operating 8245', amount: 2000 }),
    ]);
  });

  test('customers and employees are not vendors; names match exactly', async () => {
    const { rows, totals } = await run({
      vendors: ['Cintas'],
      lines: [
        line('800', 'Expense', BANK, { cr: 50, name: 'MS Lottery Corp' }),
        line('800', 'Expense', REPAIRS, { dr: 50, name: 'MS Lottery Corp' }),
        line('801', 'Journal Entry', REPAIRS, { dr: 10, name: 'cintas', ref: '337' }),
        line('801', 'Journal Entry', BANK, { cr: 10, ref: '337' }),
      ],
    });
    expect(rows).toEqual([]);
    expect(totals).toEqual({ TOTAL: 0 });
  });

  test('a bill booked to another Accounts Payable account is still on A/P', async () => {
    const { rows } = await run({
      vendors: ['Waste Management'],
      lines: [
        line('950', 'Bill', ['80', 'WM Payable', 'accounts_payable'], { cr: 120, name: 'Waste Management' }),
        line('950', 'Bill', REPAIRS, { dr: 120, name: 'Waste Management' }),
      ],
    });
    expect(rows).toEqual([
      expect.objectContaining({ vendor: 'Waste Management', account: 'WM Payable', split: 'Repairs', amount: 120 }),
    ]);
  });

  test('a vendor missing from the vendor list: its bills and credits are still listed', async () => {
    const vendor = 'Old Supplier (deleted)';
    const { rows } = await run({
      vendors: [],
      lines: [
        line('960', 'Bill', AP, { cr: 80, name: vendor, memo: '' }),
        line('960', 'Bill', REPAIRS, { dr: 80, name: vendor, memo: '' }),
        line('961', 'Vendor Credit', AP, { dr: 30, name: vendor, memo: '' }),
        line('961', 'Vendor Credit', REPAIRS, { cr: 30, name: vendor, memo: '' }),
        line('962', 'Check', BANK, { cr: 5, name: vendor, memo: '' }),
        line('962', 'Check', REPAIRS, { dr: 5, name: vendor, memo: '' }),
      ],
    });
    expect(rows.map((r) => [r.vendor, r.type, r.amount])).toEqual([
      [vendor, 'Bill', 80],
      [vendor, 'Vendor Credit', -30],
    ]);
  });

  test("a ledger synced before memos were kept apart: the document's own payee decides", async () => {
    const { rows } = await run({
      vendors: ['Acme', 'HABEGGER'],
      lines: [
        // These lines hold the memo where the name belongs.
        line('970', 'Bill', AP, { cr: 64, name: 'Invoice 123' }),
        line('970', 'Bill', REPAIRS, { dr: 64, name: 'Invoice 123' }),
        line('4564', 'Expense', BANK, { cr: 72.85, name: 'HABEGGER IND INDIANAPOLI IN DEBIT CARD P' }),
        line('4564', 'Expense', REPAIRS, { dr: 72.85, name: 'HABEGGER IND INDIANAPOLI IN DEBIT CARD P' }),
        line('4565', 'Expense', BANK, { cr: 9, name: 'Abigail Warner' }),
        line('4565', 'Expense', REPAIRS, { dr: 9, name: 'Abigail Warner' }),
      ],
      bills: [{ qbo_id: '970', vendor_name: 'Acme', bill_number: 'A-1' }],
      purchases: [
        { qbo_id: '4564', vendor_name: 'HABEGGER', description: 'HABEGGER IND INDIANAPOLI IN DEBIT CARD P' },
        { qbo_id: '4565', vendor_name: 'Abigail Warner', description: 'refund' }, // a customer
      ],
    });
    expect(rows.map((r) => [r.vendor, r.type, r.num, r.memo, r.amount])).toEqual([
      ['Acme', 'Bill', 'A-1', '', 64],
      ['HABEGGER', 'Expense', '', 'HABEGGER IND INDIANAPOLI IN DEBIT CARD P', -72.85],
    ]);
  });

  test('journal entries: under the vendor on a debit line, with no account, split or amount', async () => {
    const vendor = 'MS Lottery Corp Vendor';
    const { rows, totals } = await run({
      vendors: [vendor, 'Circle K'],
      lines: [
        line('1166', 'Journal Entry', RECEIVABLE, { dr: 185, name: vendor, ref: '230', memo: 'Comm on lottery sales' }),
        line('1166', 'Journal Entry', REPAIRS, { cr: 185, name: vendor, ref: '230', memo: 'Commission' }),
        // The vendor only on a credit line: QuickBooks leaves it out.
        line('4009', 'Journal Entry', AP, { cr: 141.6, name: 'Circle K', ref: '1203', memo: '' }),
        line('4009', 'Journal Entry', PURCHASES, { dr: 141.6, name: '2483990', ref: '1203', memo: '2483990' }),
        line('691', 'Deposit', BANK, { dr: 778.32, name: vendor, memo: '' }),
        line('691', 'Deposit', RECEIVABLE, { cr: 778.32, name: vendor, memo: '' }),
      ],
    });
    expect(rows).toEqual([
      expect.objectContaining({ vendor, type: 'Deposit', amount: 778.32 }),
      expect.objectContaining({ vendor, type: 'Journal Entry', num: '230', memo: 'Comm on lottery sales',
        account: '', split: '', amount: null }),
    ]);
    expect(totals).toEqual({ [vendor]: 778.32, TOTAL: 778.32 });
  });

  test("memos: the ledger's own memo, else (before it was synced) the purchase's", async () => {
    const { rows } = await run({
      vendors: ['Ajax', 'ADT Security'],
      lines: [
        line('600', 'Bill', AP, { cr: 10, name: 'Ajax', memo: '2312164' }),
        line('600', 'Bill', PURCHASES, { dr: 10, name: 'Ajax', memo: 'line description' }),
        line('710', 'Expense', BANK, { cr: 52.31, name: 'ADT Security', memo: null }),
        line('710', 'Expense', REPAIRS, { dr: 52.31, name: 'ADT Security', memo: null }),
        line('711', 'Expense', BANK, { cr: 5, name: 'ADT Security', memo: '' }),
        line('711', 'Expense', REPAIRS, { dr: 5, name: 'ADT Security', memo: 'line description' }),
      ],
      purchases: [
        { qbo_id: '710', vendor_name: 'ADT Security', description: 'ACH DEBIT ADT SECURITY' },
        { qbo_id: '711', vendor_name: 'ADT Security', description: 'line description' },
      ],
    });
    expect(rows.map((r) => [r.vendor, r.memo])).toEqual([
      ['ADT Security', 'ACH DEBIT ADT SECURITY'],
      ['ADT Security', ''],
      ['Ajax', '2312164'],
    ]);
  });

  test('reads no memo column a deployment does not have yet', async () => {
    await run({ memoColumn: false, vendors: ['Ajax'], lines: [] });
    expect(ledgerSql()).not.toMatch(/\bmemo\b/);
  });

  test("orders a vendor's same-day transactions as QuickBooks entered them", async () => {
    const date = '2026-04-23';
    const { rows } = await run({
      vendors: ['AT&T'],
      lines: [
        line('2477', 'Bill', AP, { cr: 220.08, name: 'AT&T', ref: '2359102', date }),
        line('2477', 'Bill', REPAIRS, { dr: 220.08, name: 'AT&T', ref: '2359102', date }),
        line('2283', 'Expense', BANK, { cr: 220.01, name: 'AT&T', date }),
        line('2283', 'Expense', AP, { dr: 220.01, name: 'AT&T', date }),
        line('2290', 'Bill', AP, { cr: 1, name: 'AT&T', ref: '2359103', date }),
        line('2290', 'Bill', REPAIRS, { dr: 1, name: 'AT&T', ref: '2359103', date }),
      ],
    });
    expect(rows.map((r) => [r.type, r.num])).toEqual([['Expense', ''], ['Bill', '2359103'], ['Bill', '2359102']]);
  });

  test('a purchase with no vendor payee is not listed, even when its memo reads like one', async () => {
    const { rows, totals } = await run({
      vendors: ['Uber'],
      lines: [
        // Synced before memos were kept apart: both lines hold the memo "Uber".
        line('761', 'Expense', BANK, { cr: 8.67, name: 'Uber' }),
        line('761', 'Expense', REPAIRS, { dr: 8.67, name: 'Uber' }),
        line('762', 'Expense', BANK, { cr: 11.96, name: 'Uber' }),
        line('762', 'Expense', REPAIRS, { dr: 11.96, name: 'Uber' }),
      ],
      purchases: [
        { qbo_id: '761', vendor_name: 'Uber', description: 'Uber' },
        { qbo_id: '762', vendor_name: null, description: 'Uber' },
      ],
    });
    expect(rows.map((r) => [r.vendor, r.amount])).toEqual([['Uber', -8.67]]);
    expect(totals).toEqual({ Uber: -8.67, TOTAL: -8.67 });
  });

  test('a bill payment that only applied a credit is listed at $0, with no account and A/P as the split', async () => {
    const date = '2025-04-12';
    const { rows, totals } = await run({
      vendors: ['Airbnb'],
      lines: [
        line('1539', 'Bill', AP, { cr: 7525.92, name: 'Airbnb', ref: 'RCFRSZAF82', date, memo: '' }),
        line('1539', 'Bill', REPAIRS, { dr: 7525.92, name: 'Airbnb', ref: 'RCFRSZAF82', date, memo: '' }),
        line('1571', 'Journal Entry', AP, { dr: 7525.92, name: 'Airbnb', ref: '286', date, memo: '' }),
        line('1571', 'Journal Entry', CARD, { cr: 7525.92, ref: '286', date, memo: '' }),
      ],
      // QuickBooks' $0 payment that set the journal's credit against the bill.
      payments: [payment('1600', { total: 0, vendor: 'Airbnb', date, num: '1', targets: ['1539', '1571'] })],
    }, { from_date: '2025-01-01', to_date: '2025-12-31' });
    expect(rows.map((r) => [r.type, r.num, r.account, r.split, r.amount])).toEqual([
      ['Bill', 'RCFRSZAF82', '2001 Accounts Payable', 'Repairs', 7525.92],
      ['Journal Entry', '286', '', '', null],
      ['Bill Payment (Check)', '1', '', 'Accounts Payable', 0],
    ]);
    expect(totals).toEqual({ Airbnb: 7525.92, TOTAL: 7525.92 });
  });

  test("a foreign vendor's bill payment reads its own total; the exchange gain is not a split", async () => {
    const date = '2025-08-22';
    const { rows } = await run({
      vendors: ['Bitla & Co.,'],
      lines: [
        // Paid INR 40,000 from a USD bank: the ledger only holds USD.
        line('1984', 'Bill Payment (Check)', BANK, { cr: 457.53, name: 'Bitla & Co.,', date, memo: '' }),
        line('1984', 'Bill Payment (Check)', AP_INR, { dr: 465.84, name: 'Bitla & Co.,', date, memo: '' }),
        line('1984', 'Bill Payment (Check)', FX, { cr: 8.31, name: 'Bitla & Co.,', date, memo: '' }),
      ],
      payments: [payment('1984', { total: 40000, vendor: 'Bitla & Co.,', date, targets: ['1780'] })],
    }, { from_date: '2025-01-01', to_date: '2025-12-31' });
    expect(rows).toEqual([
      expect.objectContaining({ type: 'Bill Payment (Check)', account: '1005 Operating 8245',
        split: 'Accounts Payable - INR', amount: -40000 }),
    ]);
  });

  test('a bill payment synced with its record takes its payee and number from it', async () => {
    const { rows } = await run({
      vendors: ['Ajax'],
      lines: [
        line('601', 'Bill Payment (Credit Card)', AP, { dr: 50, name: 'Ajax', ref: '77', memo: '' }),
        line('601', 'Bill Payment (Credit Card)', ['164', 'Amex', 'credit_card'], { cr: 50, name: 'Ajax', ref: '77', memo: '' }),
      ],
      payments: [payment('601', { total: 50, vendor: 'Ajax', num: '0077', payType: 'CreditCard', targets: ['600'] })],
    });
    expect(rows.map((r) => [r.vendor, r.type, r.num, r.account, r.split, r.amount])).toEqual([
      ['Ajax', 'Bill Payment (Credit Card)', '0077', 'Amex', 'Accounts Payable', -50],
    ]);
  });

  test('a bill with several lines on one account has no single split account', async () => {
    const { rows } = await run({
      vendors: ['Vouch'],
      lines: [
        line('1503', 'Bill', REPAIRS, { dr: 85.6, name: 'Vouch' }),
        line('1503', 'Bill', REPAIRS, { dr: 1064.82, name: 'Vouch' }),
        line('1503', 'Bill', AP, { cr: 1150.42, name: 'Vouch' }),
      ],
    });
    expect(rows.map((r) => [r.account, r.split, r.amount])).toEqual([['2001 Accounts Payable', '', 1150.42]]);
  });
});

describe('buildTransactionListByVendor — Zoho keeps following Accounts Payable', () => {
  test('bills and what cleared them are listed on A/P; direct expenses are not', async () => {
    const { rows, totals } = await run({
      lines: [
        line('zb-1', 'bill', ['z-ap', 'Accounts Payable', 'accounts_payable'], { cr: 100, name: 'Acme' }),
        line('zb-1', 'bill', ['z-ex', 'Office Supplies', 'expense'], { dr: 100, name: 'Acme' }),
        line('zb-2', 'expense', ['z-bank', 'Petty Cash', 'bank'], { cr: 40, name: 'Acme' }),
        line('zb-2', 'expense', ['z-ex', 'Office Supplies', 'expense'], { dr: 40, name: 'Acme' }),
      ],
      vendorDocs: [{ pid: 'zb-1', vendor_name: 'Acme', date: '2026-03-02', num: 'B-1', memo: '' }],
    }, { platform: 'zoho', org_id: 'ZOHO-ORG' });
    expect(rows).toEqual([
      expect.objectContaining({ vendor: 'Acme', type: 'Bill', num: 'B-1', account: 'Accounts Payable',
        split: 'Office Supplies', amount: 100 }),
    ]);
    expect(totals).toEqual({ Acme: 100, TOTAL: 100 });
    expect(ledgerSql()).not.toMatch(/\bmemo\b/);
    expect(pool.execute.mock.calls.some(([sql]) => /qbo_accounts/.test(sql))).toBe(false);
  });
});
