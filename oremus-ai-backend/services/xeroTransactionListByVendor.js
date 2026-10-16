'use strict';

/**
 * Transaction List by Vendor for Xero — Xero has no such report, so it is
 * built the way QuickBooks builds its own (see zohoTransactionListByVendorService):
 * every transaction that names a vendor, once, on the account the transaction
 * itself books to:
 *
 *   Bill / supplier credit note   on Accounts Payable; amount = what it did to
 *                                 A/P (bills +, credit notes −)
 *   Bill payment, spend money,    on the bank / card account paid from or into;
 *   refunds, receive money        amount = that account's movement (out −, in +)
 *
 * "Item split account" is the account of the one other line, blank when there
 * are several. Realised exchange gains and losses are not lines (Xero, like
 * QuickBooks, posts them itself). The vendor is the contact Xero stamps on the
 * document (see xeroVendorName — the same rule Expenses by Vendor uses).
 *
 * Xero-specific plumbing in the posting-engine ledger, kept out:
 *   - "Xero Payments Clearing": a bill moves each settlement off A/P into it and
 *     the matching payment moves it on to the real bank. Those settlement lines
 *     ride on the bill's own document but are the payment, which is listed as
 *     the payment (on its bank, split Accounts Payable — what it paid).
 *   - Prepayment allocations move money that already left as the prepayment;
 *     Xero shows no transaction for an allocation, so neither does this.
 *   - Manual journals carry no contact in Xero, so they never name a vendor;
 *     customer documents and the sync engine's synthetic lines aren't a vendor's.
 */

const pool = require('../config/db');
const { xeroVendorName, contactRoles } = require('./xeroExpensesByVendor');

// Booked on Accounts Payable, signed by what they do to it.
const PAYABLE_DOCS = { ACCPAY: 'Bill', ACCPAYCREDIT: 'Vendor Credit' };
// Booked on the bank / card account; `in` = money comes in (a debit to it).
const MONEY_DOCS = {
  ACCPAYPAYMENT:          { label: 'Bill Payment',              in: false },
  'BankSPEND':            { label: 'Spend Money',               in: false },
  'BankSPEND-OVERPAYMENT': { label: 'Spend Money (Overpayment)', in: false },
  'BankSPEND-PREPAYMENT': { label: 'Spend Money (Prepayment)',  in: false },
  'BankRECEIVE':          { label: 'Receive Money',             in: true },
  APCREDITPAYMENT:        { label: 'Credit Note Refund',        in: true },
  APOVERPAYMENTPAYMENT:   { label: 'Overpayment Refund',        in: true },
  APPREPAYMENTPAYMENT:    { label: 'Prepayment Refund',         in: true },
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (n) => Math.round(num(n) * 100) / 100;
const isClearing = (l) => l.account_id === 'XERO-CLEARING' || /xero payments clearing/i.test(l.account_name || '');
// A realised exchange difference is posted in base currency only.
const isFx = (l) => num(l.ndebit) === 0 && num(l.ncredit) === 0;
const isPayable = (l) => l.account_type_code === 'accounts_payable';

async function accountNames(userId, orgId) {
  const [rows] = await pool.execute(
    'SELECT xero_id, code, name FROM xero_accounts WHERE user_id = ? AND tenant_id = ?',
    [userId, String(orgId)]
  ).catch(() => [[]]);
  const byId = new Map();
  for (const r of rows) {
    const name = String(r.name || '').trim();
    const code = String(r.code || '').trim();
    byId.set(String(r.xero_id), { full: code ? `${code} ${name}` : name, name });
  }
  return byId;
}

// The line a document books its own amount on, among `lines`.
function headerLine(lines, moneyIn) {
  const size = (l) => Math.abs(num(l.debit) - num(l.credit));
  const ownSide = moneyIn ? (l) => num(l.debit) > 0 : (l) => num(l.credit) > 0;
  const tests = [
    (l) => l.account_type_code === 'bank' && ownSide(l),
    (l) => !isPayable(l) && ownSide(l),
    () => true,
  ];
  for (const t of tests) {
    const hit = lines.filter(t);
    if (hit.length) return hit.reduce((a, b) => (size(b) > size(a) ? b : a));
  }
  return null;
}

/**
 * Entries for the report: [{ vendor, date, type, num, memo, account, split, amount }],
 * amounts in base currency.
 */
async function xeroTransactionEntries(userId, orgId, from, to) {
  const [roles, accounts, [lines]] = await Promise.all([
    contactRoles(userId, orgId),
    accountNames(userId, orgId),
    pool.execute(
      `SELECT source_id, source_type, transaction_date, account_id, account_name, account_type_code,
              COALESCE(base_debit, debit) AS debit, COALESCE(base_credit, credit) AS credit,
              debit AS ndebit, credit AS ncredit, transaction_details, reference_number
         FROM account_transactions
        WHERE user_id = ? AND org_id = ? AND transaction_id LIKE 'xero:%'
          AND transaction_date BETWEEN ? AND ?
          AND (source_type IN (${Object.keys({ ...PAYABLE_DOCS, ...MONEY_DOCS }).map(() => '?').join(', ')}))
        ORDER BY transaction_date, source_id, line_number`,
      [userId, String(orgId), from, to, ...Object.keys({ ...PAYABLE_DOCS, ...MONEY_DOCS })]
    ),
  ]);

  const docs = new Map();
  for (const l of lines) {
    const k = `${l.source_type}|${l.source_id}`;
    if (!docs.has(k)) docs.set(k, { type: l.source_type, id: String(l.source_id), lines: [] });
    docs.get(k).lines.push(l);
  }

  const label = (l) => accounts.get(String(l.account_id)) || { full: l.account_name || '', name: l.account_name || '' };
  // What a bill payment / overpayment cleared: the org's A/P account.
  const apLine = lines.find(isPayable);
  const apName = apLine ? label(apLine).name : 'Accounts Payable';

  const entries = [];
  let settlementsWithoutPayments = 0;
  for (const d of docs.values()) {
    let header;
    let others;
    let amount;
    let type;

    if (PAYABLE_DOCS[d.type]) {
      type = PAYABLE_DOCS[d.type];
      const isBill = d.type === 'ACCPAY';
      // A bill's own lines — not the settlement pair (A/P debit + clearing
      // credit) the posting engine dates on each payment.
      const own = d.lines.filter((l) => !isClearing(l) && !(isBill && isPayable(l) && num(l.debit) > 0));
      if (isBill && d.lines.some((l) => isClearing(l))) settlementsWithoutPayments += 1;
      const ap = own.filter(isPayable);
      if (!ap.length) continue; // only its settlement fell in the period — that's the payment's entry
      header = ap.reduce((a, b) => (Math.abs(num(b.credit) - num(b.debit)) > Math.abs(num(a.credit) - num(a.debit)) ? b : a));
      others = own.filter((l) => !isPayable(l) && !isFx(l));
      amount = ap.reduce((s, l) => s + num(l.credit) - num(l.debit), 0);
    } else {
      const m = MONEY_DOCS[d.type];
      type = m.label;
      const own = d.lines.filter((l) => !isClearing(l) && !isFx(l));
      header = headerLine(own, m.in);
      if (!header) continue;
      others = own.filter((l) => l !== header);
      amount = num(header.debit) - num(header.credit);
    }

    const vendor = xeroVendorName(header.transaction_details, d.type, roles);
    if (!vendor) continue;
    // A bill payment's other side is the clearing account the bill moved its
    // settlement into — i.e. what it paid off: Accounts Payable.
    const split = d.type === 'ACCPAYPAYMENT'
      ? apName
      : (others.length === 1 ? label(others[0]).name : '');
    entries.push({
      vendor,
      date: String(header.transaction_date).slice(0, 10),
      type,
      num: String(header.reference_number || '').trim(),
      memo: '',
      account: label(header).full,
      split,
      amount: r2(amount) || 0,
    });
  }

  // Bills were settled in the period but no payment document came through —
  // Xero's /Payments needs the accounting.payments.read scope.
  const paymentsListed = entries.some((e) => e.type === 'Bill Payment');
  const note = settlementsWithoutPayments && !paymentsListed
    ? 'Bill payments are missing: this Xero connection cannot read payments (accounting.payments.read). Grant it, reconnect Xero and sync.'
    : undefined;
  return { entries, note };
}

module.exports = { xeroTransactionEntries };
