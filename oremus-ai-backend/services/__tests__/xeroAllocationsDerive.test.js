'use strict';

// Overpayments / prepayments rebuilt from the documents they were applied to,
// for Xero connections that can't read /Overpayments or /Prepayments.
jest.mock('../../config/db', () => ({ execute: jest.fn(), query: jest.fn() }));

const { deriveCreditDocs } = require('../xeroAllocationsService');

const bt = (over) => ({
  BankTransactionID: 'bt-1', OverpaymentID: 'op-1', Type: 'SPEND-OVERPAYMENT', Status: 'AUTHORISED',
  Contact: { Name: 'MC Medcrave' }, DateString: '2024-10-08T00:00:00', Total: 555518, ...over,
});
const bill = (over) => ({
  InvoiceID: 'inv-86', InvoiceNumber: 'Invoice No : 086', Type: 'ACCPAY', Status: 'PAID',
  Contact: { Name: 'MC Medcrave' }, DateString: '2024-10-03T00:00:00', Overpayments: [], ...over,
});

test('an allocation is dated the later of the overpayment and the bill', () => {
  const [op] = deriveCreditDocs('OVERPAYMENT', {
    bankTransactions: [bt()],
    invoices: [
      // Overpayment newer than the bill → allocated on the overpayment date.
      bill({ Overpayments: [{ OverpaymentID: 'op-1', AppliedAmount: 500000, DateString: '2024-10-08T00:00:00' }] }),
      // Bill newer than the overpayment → allocated on the bill date.
      bill({ InvoiceID: 'inv-87', DateString: '2024-11-05T00:00:00',
        Overpayments: [{ OverpaymentID: 'op-1', AppliedAmount: 55518, DateString: '2024-10-08T00:00:00' }] }),
    ],
  });
  expect(op.Allocations.map((a) => [a.Invoice.InvoiceID, a.DateString, a.Amount]))
    .toEqual([['inv-86', '2024-10-08', 500000], ['inv-87', '2024-11-05', 55518]]);
  expect(op.RemainingCredit).toBe(0);
  expect(op.Status).toBe('PAID');
});

test('an overpayment never applied keeps its whole amount as remaining credit', () => {
  const [op] = deriveCreditDocs('OVERPAYMENT', {
    bankTransactions: [bt({ Contact: { Name: 'Care health insurance limited' }, Total: 1997000, DateString: '2026-06-05' })],
    invoices: [],
  });
  expect(op).toEqual(expect.objectContaining({ Type: 'SPEND-OVERPAYMENT', RemainingCredit: 1997000, Status: 'AUTHORISED' }));
});

test('ledger refunds go to the contact\'s overpayment they fit, never one dated after the refund', () => {
  const docs = deriveCreditDocs('OVERPAYMENT', {
    bankTransactions: [
      bt({ OverpaymentID: 'op-a', Contact: { Name: 'Salary' }, DateString: '2022-06-01', Total: 100000 }),
      bt({ OverpaymentID: 'op-b', Contact: { Name: 'Salary' }, DateString: '2022-06-20', Total: 50000 }),
      bt({ OverpaymentID: 'op-c', Contact: { Name: 'Salary' }, DateString: '2022-08-01', Total: 46988 }),
    ],
    invoices: [bill({ Contact: { Name: 'Salary' }, DateString: '2022-06-25',
      Overpayments: [{ OverpaymentID: 'op-a', AppliedAmount: 53012, DateString: '2022-06-01' }] })],
    ledgerRefunds: [{ id: 'pay-1', contact: 'salary', date: '2022-06-30', amount: 46988 }],
  });
  const byId = Object.fromEntries(docs.map((d) => [d.OverpaymentID, d]));
  // op-a has exactly 46,988 left → the refund is that; op-c (dated later) is untouched.
  expect(byId['op-a'].RemainingCredit).toBe(0);
  expect(byId['op-b'].RemainingCredit).toBe(50000);
  expect(byId['op-c'].RemainingCredit).toBe(46988);
});

test('a deleted bank transaction is not an overpayment', () => {
  expect(deriveCreditDocs('OVERPAYMENT', { bankTransactions: [bt({ Status: 'DELETED' })], invoices: [] })).toEqual([]);
});
