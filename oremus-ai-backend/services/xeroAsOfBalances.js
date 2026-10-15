'use strict';

/**
 * Point-in-time balances for Xero invoices (A/R) and bills (A/P).
 * ---------------------------------------------------------------------------
 * The aging reports turn today's live balance into the balance AS OF a past
 * date by rewinding every settlement made after it. For Zoho that rewind reads
 * zb_customer_payments / zb_credit_notes — tables Xero never writes, so for a
 * Xero org nothing was rewound and every invoice/bill settled since the as-of
 * date dropped off a historical aging as if it had been paid back then.
 *
 * Xero's settlements are found in two places instead:
 *   1. Cash payments — the posting-engine ledger (account_transactions). Each
 *      document's control-account lines carry the document's own InvoiceID as
 *      source_id: the invoice/bill line itself, plus one line per payment
 *      dated on the payment's own date. (transaction_number is only the line
 *      index there, so it can't be used to match documents.)
 *   2. Credit note / overpayment / prepayment allocations — Xero's GL has no
 *      line for these, so they come from xero_allocations, each with the date
 *      Xero applied it (see xeroAllocationsService).
 *
 * Only genuine document postings are read (transaction_id 'xero:<id>'). The
 * sync engine's synthetic lines — 'xero-recon:' trial-balance true-ups,
 * 'xero-fxu:' unrealised FX revaluations, 'xero-rnd:' rounding — sit on the
 * same AR/AP control accounts with labels like "Unrealised currency
 * gains/losses (Xero revaluation)", and must never be read as a customer,
 * vendor or settlement.
 *
 * Every figure is reconciled before it's used: the ledger's balance TODAY,
 * less all allocations, must match Xero's own AmountDue (`balance`) within
 * half a unit. A document that doesn't reconcile keeps its live balance —
 * never a fabricated one. A trusted document's as-of balance is anchored on
 * that AmountDue, rewinding only what moved after the as-of date:
 *   balanceAsOf = balance + (ledger asOf − ledger today) + allocations after asOf
 */

const pool = require('../config/db');
const { loadXeroAllocations, creditOpenOn } = require('./xeroAllocationsService');
const { invoiceFxContext, rateToBase } = require('./invoiceFx');

// Genuine Xero document postings only — excludes every synthetic prefix the
// sync engine writes (xero-recon:, xero-fxu:, xero-rnd:, and any added later).
const GENUINE_XERO_LINES_SQL = "transaction_id LIKE 'xero:%'";

// For queries that also serve Zoho / QuickBooks rows (whose transaction_ids
// look nothing like 'xero:'), drop just the Xero sync engine's synthetic lines:
// trial-balance true-ups, unrealised-FX revaluations and rounding plugs. None
// is a document, customer or vendor.
const NOT_SYNTHETIC_XERO_SQL =
  "transaction_id NOT LIKE 'xero-recon:%' AND transaction_id NOT LIKE 'xero-fxu:%' AND transaction_id NOT LIKE 'xero-rnd:%'";

const SIDES = {
  ar: { control: 'accounts_receivable', sign: 1,  numberKey: 'invoice_number', nameKey: 'customer_name' },
  ap: { control: 'accounts_payable',    sign: -1, numberKey: 'bill_number',    nameKey: 'vendor_name' },
};

const ALLOC_LABEL = { CREDITNOTE: 'Credit note', OVERPAYMENT: 'Overpayment', PREPAYMENT: 'Prepayment' };

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

function endOfDay(asOf) {
  const d = asOf instanceof Date ? asOf : new Date(asOf);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 23:59:59`;
}

/**
 * Sets `_balanceAsOf` and `_breakdown` on every document it can reconstruct.
 * Documents it can't (no xero_id, no ledger lines, or not reconciling with
 * Xero) are left exactly as the caller initialised them.
 * @param {object[]} docs  invoice or bill rows with xero_id, total, balance
 * @param {'ar'|'ap'} side
 * @returns {Promise<Set<object>>} the documents that were reconstructed
 */
async function attachXeroAsOfBalances(docs, userId, orgId, asOf, side) {
  const cfg = SIDES[side];
  const done = new Set();
  const byId = new Map(docs.filter((d) => d.xero_id).map((d) => [String(d.xero_id), d]));
  if (!byId.size) return done;

  const cutoff = endOfDay(asOf);
  const day = cutoff.slice(0, 10);
  // AR balances are debit-normal, AP credit-normal.
  const net = cfg.sign > 0 ? 'debit - credit' : 'credit - debit';

  const [agg] = await pool.execute(
    `SELECT source_id,
            SUM(CASE WHEN transaction_date <= ? THEN ${net} ELSE 0 END) AS balance_as_of,
            SUM(${net}) AS balance_today
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND account_type_code = ?
        AND ${GENUINE_XERO_LINES_SQL}
      GROUP BY source_id`,
    [cutoff, userId, orgId, cfg.control]
  );
  const ledgerById = new Map();
  for (const r of agg) {
    if (byId.has(String(r.source_id))) {
      ledgerById.set(String(r.source_id), { asOf: num(r.balance_as_of), today: num(r.balance_today) });
    }
  }

  // Individual postings, only to show HOW each as-of figure was reached in the
  // aging detail's click-through breakdown.
  const [postings] = await pool.execute(
    `SELECT source_id, transaction_date, transaction_type, source_type, reference_number, debit, credit
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND account_type_code = ?
        AND ${GENUINE_XERO_LINES_SQL}
        AND transaction_date <= ?
      ORDER BY transaction_date`,
    [userId, orgId, cfg.control, cutoff]
  );
  const postingsById = new Map();
  for (const p of postings) {
    const id = String(p.source_id);
    if (!byId.has(id)) continue;
    if (!postingsById.has(id)) postingsById.set(id, []);
    postingsById.get(id).push(p);
  }

  const alloc = await loadXeroAllocations(userId, orgId, side);

  for (const [id, doc] of byId) {
    let ledger = ledgerById.get(id);
    if (!ledger) continue; // nothing traced to this document — keep its live balance
    const allocs = alloc?.allocByInvoice.get(id) || [];
    if (allocs.length) {
      const all = allocs.reduce((s, a) => s + a.amount, 0);
      const upToDay = allocs.filter((a) => a.date && a.date <= day).reduce((s, a) => s + a.amount, 0);
      ledger = { asOf: ledger.asOf - upToDay, today: ledger.today - all };
    }
    // Doesn't reconcile with Xero's AmountDue (a settlement we can't date) —
    // untrusted, keep the live balance rather than guess.
    if (Math.abs(ledger.today - num(doc.balance)) > 0.5) continue;

    doc._balanceAsOf = round2(num(doc.balance) + ledger.asOf - ledger.today);
    const name = doc[cfg.nameKey] || null;
    const number = doc[cfg.numberKey] || null;
    doc._breakdown = (postingsById.get(id) || []).map((p) => ({
      name,
      ref: p.reference_number || number,
      date: p.transaction_date ? String(p.transaction_date).slice(0, 10) : null,
      type: p.transaction_type || p.source_type || 'GL Posting',
      amount: round2(cfg.sign * (num(p.debit) - num(p.credit))),
    }));
    for (const a of allocs) {
      if (!a.date || a.date > day) continue;
      doc._breakdown.push({
        name, ref: a.docNumber || number, date: a.date,
        type: `${ALLOC_LABEL[a.docType] || 'Credit'} allocated`, amount: -round2(a.amount),
      });
    }
    doc._breakdown.sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')));
    doc._ledgerAsOf = true;
    done.add(doc);
  }
  return done;
}

/**
 * Was this invoice/bill part of the books on the as-of date? Normally only if
 * issued on or before it. But Xero lets a payment pre-date its document (a
 * bill dated 31 Mar paid on 25 Feb — 355 such bills in one org), and between
 * the two dates that payment sits on A/R or A/P as a credit, which Xero's aged
 * reports list. So a later-dated document counts too when its ledger-rebuilt
 * as-of balance is a credit. Only for balances rebuilt from the ledger — a
 * live-balance fallback says nothing about a past date.
 */
function existedOn(doc, asOf) {
  if (!doc.date || new Date(doc.date) <= asOf) return true;
  return paidBeforeIssue(doc, asOf);
}

// Issued after the as-of date but already (partly) paid by then.
function paidBeforeIssue(doc, asOf) {
  return !!doc._ledgerAsOf && !!doc.date && new Date(doc.date) > asOf && num(doc._balanceAsOf) < -0.005;
}

const CREDIT_LABEL = {
  ap: { CREDITNOTE: 'Vendor Credit', OVERPAYMENT: 'Overpayment' },
  ar: { CREDITNOTE: 'Credit Note', OVERPAYMENT: 'Overpayment' },
};

/**
 * Xero credit notes / overpayments still unallocated on the as-of date —
 * Xero's aged reports list each as a negative line under its contact. The
 * open amount is the document's total less every allocation and cash refund
 * dated on or before the as-of date, converted to base at its own rate.
 * Returns null until both credit notes and overpayments have been synced for
 * the org (an incomplete list would understate credits), so callers can keep
 * whatever they did before.
 * @returns {Promise<null|Array<{customer, date, amount, total, type, docNumber, ref}>>}
 *          `customer` is the contact name (customer or vendor); amounts are
 *          negative, in base currency.
 */
async function xeroOpenCredits(userId, orgId, asOf, side) {
  const alloc = await loadXeroAllocations(userId, orgId, side);
  if (!alloc?.creditsComplete) return null;
  const day = endOfDay(asOf).slice(0, 10);
  const fx = await invoiceFxContext(orgId);
  const out = [];
  for (const d of alloc.credits) {
    const open = creditOpenOn(d, day);
    if (open <= 0.005) continue;
    const rate = rateToBase(d.currency_code, d.currency_rate, fx);
    const type = CREDIT_LABEL[side][d.doc_type] || 'Credit';
    const docNumber = d.doc_number || d.reference || '';
    out.push({
      customer: (d.contact_name || '').trim() || 'Unknown',
      date: d.date,
      amount: -round2(open * rate),
      total: -round2(d.total * rate),
      type,
      docNumber,
      ref: [type, docNumber].filter(Boolean).join(' '),
    });
  }
  return out;
}

module.exports = {
  attachXeroAsOfBalances, xeroOpenCredits, existedOn, paidBeforeIssue,
  GENUINE_XERO_LINES_SQL, NOT_SYNTHETIC_XERO_SQL,
};
