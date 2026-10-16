'use strict';

/**
 * Expenses by Vendor Summary for Xero — Xero has no such report, so it is
 * built the way QuickBooks builds its own (see zohoExpensesByVendorSummaryService):
 * every expense-account line (expenses, direct costs, other expenses) in the
 * period, grouped by the line's Name, where only a supplier gets its own row and
 * everything else is "Not Specified".
 *
 * Who a line belongs to. Xero stamps the document's Contact on every line the
 * posting engine writes (transaction_details), so no document lookup is needed:
 *   - purchase documents — bills, supplier credit notes, spend money, supplier
 *     payments/refunds, prepayment allocations — count under their contact,
 *     unless that contact is only a customer (QuickBooks: a purchase paid to a
 *     customer isn't a vendor's);
 *   - receive money (a refund booked to an expense account) counts under its
 *     contact only when the contact is a supplier;
 *   - manual journals carry no contact in Xero, and the sync engine's own
 *     revaluation / rounding lines belong to nobody → "Not Specified";
 *   - expense-account lines on CUSTOMER documents (e.g. realised FX on a
 *     customer payment) are receivables activity and left out, as QuickBooks does.
 *
 * Accrual basis: lines dated in the period.
 *
 * Cash basis (Xero's cash rules): an expense counts when it's paid —
 *   - spend / receive money, prepayments, payment FX and manual journals on
 *     their own date (they are cash movements already);
 *   - a bill's expense lines pro rata to each settlement dated in the period:
 *     cash payments (in the ledger, on the payment date) and overpayment /
 *     credit-note allocations (xero_allocations, on the allocation date). A
 *     prepayment's lines already counted when it was paid, so neither its
 *     allocation to a bill nor the allocation entry counts again;
 *   - a supplier credit note's lines (negative) pro rata to each allocation or
 *     cash refund dated in the period.
 *   Unrealised-FX revaluations and rounding plugs are accrual adjustments and
 *   don't appear on a cash basis.
 */

const pool = require('../config/db');
const { loadXeroAllocations } = require('./xeroAllocationsService');

const NOT_SPECIFIED = 'Not Specified';

const PURCHASE_DOCS = new Set([
  'ACCPAY', 'ACCPAYCREDIT', 'ACCPAYPAYMENT', 'APCREDITPAYMENT', 'APOVERPAYMENTPAYMENT',
  'APPREPAYMENTPAYMENT', 'BankSPEND', 'BankSPEND-OVERPAYMENT', 'BankSPEND-PREPAYMENT', 'PrepaymentAllocation',
]);
const CUSTOMER_DOCS = new Set([
  'ACCREC', 'ACCRECCREDIT', 'ACCRECPAYMENT', 'ARCREDITPAYMENT', 'AROVERPAYMENTPAYMENT',
  'ARPREPAYMENTPAYMENT', 'BankRECEIVE-OVERPAYMENT', 'BankRECEIVE-PREPAYMENT',
]);
// Lines that are cash movements in themselves (cash basis takes them as dated).
const CASH_DOCS = new Set([
  'BankSPEND', 'BankRECEIVE', 'BankSPEND-PREPAYMENT', 'BankSPEND-OVERPAYMENT',
  'ACCPAYPAYMENT', 'APCREDITPAYMENT', 'APOVERPAYMENTPAYMENT', 'APPREPAYMENTPAYMENT', 'ManualJournal',
]);

const SETTLEMENT_LABEL = { PAYMENT: 'Bill payment', OVERPAYMENT: 'Overpayment allocated', CREDITNOTE: 'Credit note allocated' };

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : (d ? String(d).slice(0, 10) : null));
const key = (s) => String(s || '').trim().toLowerCase();
const isSynthetic = (l) => !String(l.txn_id || '').startsWith('xero:');

const LINE_COLS = `source_id, source_type AS stype, transaction_id AS txn_id,
       COALESCE(base_debit, debit) AS debit, COALESCE(base_credit, credit) AS credit,
       transaction_date AS dt, reference_number AS ref, account_name AS account,
       transaction_details AS details, COALESCE(transaction_type, source_type) AS ttype`;

async function contactRoles(userId, orgId) {
  const vendors = new Map();
  const customers = new Set();
  const [vs] = await pool.execute(
    'SELECT contact_name, company_name FROM vendors WHERE user_id = ? AND org_id = ?', [userId, orgId]);
  for (const v of vs) {
    const display = String(v.contact_name || v.company_name || '').trim();
    for (const n of [v.contact_name, v.company_name]) if (key(n) && display) vendors.set(key(n), display);
  }
  const [cs] = await pool.execute(
    'SELECT contact_name, company_name FROM customers WHERE user_id = ? AND org_id = ?', [userId, orgId]
  ).catch(() => [[]]);
  for (const c of cs) for (const n of [c.contact_name, c.company_name]) if (key(n)) customers.add(key(n));
  return { vendors, customers };
}

function vendorOf(line, roles) {
  if (line.stype === 'ManualJournal' || isSynthetic(line)) return NOT_SPECIFIED;
  const name = String(line.details || '').trim();
  if (!name) return NOT_SPECIFIED;
  if (roles.vendors.has(key(name))) return roles.vendors.get(key(name));
  if (PURCHASE_DOCS.has(line.stype) && !roles.customers.has(key(name))) return name;
  return NOT_SPECIFIED;
}

function entryOf(line, vendor, amount, extra = {}) {
  return {
    vendor,
    amount,
    entry: {
      name: String(line.details || '').trim() || vendor,
      account: line.account || '',
      ref: line.ref || '',
      date: ymd(line.dt),
      type: line.ttype || line.stype || '',
      ...extra,
    },
  };
}

// Expense lines (debit-normal: debit − credit) in the period, customer docs dropped.
async function expenseLines(userId, orgId, from, to) {
  const [lines] = await pool.execute(
    `SELECT ${LINE_COLS}
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND account_group = 'expense'
        AND transaction_date BETWEEN ? AND ?
        AND transaction_id NOT LIKE 'xero-recon:%'`,
    [userId, orgId, from, to]
  );
  return lines.filter((l) => !CUSTOMER_DOCS.has(l.stype));
}

// Every expense line of the given documents, whatever their date.
async function docExpenseLines(userId, orgId, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 1000) {
    const [lines] = await pool.query(
      `SELECT ${LINE_COLS}
         FROM account_transactions
        WHERE user_id = ? AND org_id = ? AND account_group = 'expense'
          AND transaction_id LIKE 'xero:%' AND source_id IN (?)`,
      [userId, orgId, ids.slice(i, i + 1000)]
    );
    for (const l of lines) {
      const id = String(l.source_id);
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(l);
    }
  }
  return out;
}

// Spread a document's expense lines over one settlement: `share` of the doc's
// own total, on the settlement's date. One entry per expense line.
function spread(lines, share, sign, roles, settlement) {
  return lines.map((l) => {
    const amt = Math.round(sign * (num(l.debit) - num(l.credit)) * share * 100) / 100;
    return entryOf(l, vendorOf(l, roles), amt, {
      date: settlement.date,
      type: settlement.type,
      ref: settlement.ref || l.ref || '',
    });
  });
}

async function cashEntries(userId, orgId, from, to, roles) {
  const out = [];

  // 1. Cash movements booked straight to an expense account.
  for (const l of await expenseLines(userId, orgId, from, to)) {
    if (!CASH_DOCS.has(l.stype) || isSynthetic(l)) continue;
    out.push(entryOf(l, vendorOf(l, roles), num(l.debit) - num(l.credit)));
  }

  // 2. Bills, pro rata to each cash payment in the period (the A/P debit lines
  //    the posting engine dates on the payment) …
  const settlements = new Map(); // bill id → [{ date, amount, type, ref }]
  const add = (id, s) => { if (!settlements.has(id)) settlements.set(id, []); settlements.get(id).push(s); };
  const [pays] = await pool.execute(
    `SELECT source_id, transaction_date AS dt, debit, reference_number AS ref
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND account_type_code = 'accounts_payable'
        AND transaction_id LIKE 'xero:%' AND source_type = 'ACCPAY' AND debit > 0
        AND transaction_date BETWEEN ? AND ?`,
    [userId, orgId, from, to]
  );
  for (const p of pays) add(String(p.source_id), { date: ymd(p.dt), amount: num(p.debit), type: SETTLEMENT_LABEL.PAYMENT, ref: p.ref });

  //    … and each overpayment / credit-note allocation dated in the period
  //    (a prepayment's own lines already counted when it was paid).
  const alloc = await loadXeroAllocations(userId, orgId, 'ap');
  if (alloc) {
    for (const [billId, list] of alloc.allocByInvoice) {
      for (const a of list) {
        if (a.docType === 'PREPAYMENT' || !a.date || a.date < from || a.date > to) continue;
        add(String(billId), { date: a.date, amount: a.amount, type: SETTLEMENT_LABEL[a.docType], ref: a.docNumber });
      }
    }
  }

  // 3. Supplier credit notes, pro rata to each allocation / cash refund in the period.
  const creditEvents = new Map(); // credit note id → { total, events }
  for (const d of alloc?.credits || []) {
    if (d.doc_type !== 'CREDITNOTE') continue;
    const events = [
      ...d.allocations.map((a) => ({ ...a, type: 'Credit note allocated' })),
      ...d.refunds.map((r) => ({ ...r, type: 'Credit note refunded' })),
    ].filter((e) => e.date && e.date >= from && e.date <= to);
    if (events.length) creditEvents.set(String(d.doc_id), { total: num(d.total), ref: d.doc_number, events });
  }

  const billIds = [...settlements.keys()];
  const [billRows] = billIds.length
    ? await pool.query('SELECT xero_id, total FROM bills WHERE user_id = ? AND org_id = ? AND xero_id IN (?)', [userId, orgId, billIds])
    : [[]];
  const billTotal = new Map(billRows.map((b) => [String(b.xero_id), num(b.total)]));
  const lines = await docExpenseLines(userId, orgId, [...billIds, ...creditEvents.keys()]);

  for (const [id, list] of settlements) {
    const total = billTotal.get(id);
    const docLines = lines.get(id) || [];
    if (!total || !docLines.length) continue;
    for (const s of list) out.push(...spread(docLines, s.amount / total, 1, roles, s));
  }
  for (const [id, cn] of creditEvents) {
    const docLines = lines.get(id) || [];
    if (!cn.total || !docLines.length) continue;
    // Credit-note lines credit the expense account, so (debit − credit) is already negative.
    for (const e of cn.events) out.push(...spread(docLines, e.amount / cn.total, 1, roles, { ...e, ref: cn.ref }));
  }
  return { entries: out, allocationsSynced: !!alloc };
}

/**
 * Entries for the Expenses by Vendor Summary: [{ vendor, amount, entry }],
 * amounts in base currency, expense-positive.
 */
async function xeroExpenseEntries(userId, orgId, from, to, { cash = false } = {}) {
  const roles = await contactRoles(userId, orgId);
  if (cash) return cashEntries(userId, orgId, from, to, roles);
  const entries = (await expenseLines(userId, orgId, from, to))
    .map((l) => entryOf(l, vendorOf(l, roles), num(l.debit) - num(l.credit)));
  return { entries, allocationsSynced: true };
}

module.exports = { xeroExpenseEntries, NOT_SPECIFIED };
