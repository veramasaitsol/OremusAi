'use strict';

/**
 * QuickBooks A/R: unapplied credits per customer, for the AR Aging reports.
 *
 * QuickBooks' A/R Aging lists, per customer, every open invoice PLUS every
 * credit against A/R not yet applied to an invoice — Credit Memos, Journal
 * Entries crediting A/R (write-offs, intermediary bank charges, …), Deposits
 * posted to A/R and unused Payments — as negative lines. Its customer totals
 * are the customer balances QuickBooks syncs into
 * customers.outstanding_receivable_amount (in the customer's own currency).
 *
 * The synced GL has no invoice↔credit linkage, so the unapplied amount is
 * recovered per customer:
 *     customer balance − open invoice balances + unused payments  (native)
 * converted to the home currency at the customer's invoice rate, then
 * attributed to that customer's own credit documents — a document of exactly
 * that amount first, then the newest ones — and, for a journal line that names
 * no customer, one of exactly the right amount. Only QuickBooks orgs use this.
 */

const pool = require('../config/db');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

// "Boston Scientific:BS International S.A." (QuickBooks full name) and
// "BS International S.A." (display name) are the same customer.
const nameKey = (s) => {
  const t = String(s || '').trim().toLowerCase();
  const i = t.lastIndexOf(':');
  return i >= 0 ? t.slice(i + 1).trim() : t;
};

const ymd = (d) => {
  if (!d) return '';
  if (d instanceof Date) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return String(d).slice(0, 10);
};

async function isQuickBooksOrg(orgId) {
  const [[r]] = await pool.execute('SELECT 1 AS x FROM qbo_organizations WHERE realm_id = ? LIMIT 1', [String(orgId)])
    .catch(() => [[null]]);
  return !!r;
}

/**
 * Unapplied A/R credits open on `asOf`, as
 * [{ customer, date, amount (<0), total, type, docNumber, ref }] in the home
 * currency. [] for non-QuickBooks orgs.
 */
async function qboUnappliedArCredits(userId, orgId, asOf) {
  if (!(await isQuickBooksOrg(orgId))) return [];
  const asOfDay = ymd(asOf);

  const [customers] = await pool.execute(
    `SELECT contact_name, company_name, outstanding_receivable_amount
       FROM customers WHERE user_id = ? AND org_id = ?`,
    [userId, orgId]
  );
  const balance = new Map();
  const display = new Map();
  for (const c of customers) {
    const k = nameKey(c.contact_name || c.company_name);
    if (!k) continue;
    balance.set(k, (balance.get(k) || 0) + num(c.outstanding_receivable_amount));
    display.set(k, String(c.contact_name || c.company_name).trim());
  }
  if (!balance.size) return [];

  // Open invoices (native) and each customer's currency rate to the home currency.
  const [invoices] = await pool.execute(
    `SELECT customer_name, balance, currency_code, exchange_rate, date
       FROM invoices
      WHERE user_id = ? AND org_id = ?
        AND LOWER(COALESCE(status, '')) NOT IN ('draft', 'approved', 'submitted', 'void', 'voided', 'deleted')
      ORDER BY date`,
    [userId, orgId]
  );
  const [[org]] = await pool.execute('SELECT currency FROM qbo_organizations WHERE realm_id = ? LIMIT 1', [String(orgId)]);
  const home = org?.currency || null;
  const openNative = new Map();
  const rate = new Map();
  for (const inv of invoices) {
    const k = nameKey(inv.customer_name);
    openNative.set(k, (openNative.get(k) || 0) + num(inv.balance));
    const foreign = inv.currency_code && home && inv.currency_code !== home && num(inv.exchange_rate) > 0;
    rate.set(k, foreign ? num(inv.exchange_rate) : 1); // latest invoice wins
    if (!display.has(k)) display.set(k, String(inv.customer_name).trim());
    else display.set(k, String(inv.customer_name).trim()); // group with the invoices
  }

  // Unused payments are already listed by the reports as "Unapplied Credit".
  const [pays] = await pool.execute(
    `SELECT customer_name, unused_amount FROM zb_customer_payments
      WHERE user_id = ? AND org_id = ? AND unused_amount <> 0 AND zoho_payment_id LIKE '%:%'`,
    [userId, orgId]
  );
  const unused = new Map();
  for (const p of pays) unused.set(nameKey(p.customer_name), (unused.get(nameKey(p.customer_name)) || 0) + num(p.unused_amount));

  // Credit documents against A/R, all dates (home-currency ledger amounts).
  const [docs] = await pool.execute(
    `SELECT source_type, source_id, reference_number, transaction_details,
            DATE_FORMAT(MIN(transaction_date), '%Y-%m-%d') AS d,
            SUM(COALESCE(base_credit, credit)) - SUM(COALESCE(base_debit, debit)) AS net
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND account_type_code = 'accounts_receivable'
        AND source_type IN ('Credit Memo', 'Journal Entry', 'Deposit', 'Refund Receipt')
      GROUP BY source_type, source_id, reference_number, transaction_details`,
    [userId, orgId]
  );
  const creditDocs = [];
  for (const d of docs) {
    const amt = round2(d.net);
    if (amt <= 0.005) continue;
    const k = nameKey(d.transaction_details);
    creditDocs.push({
      type: d.source_type, ref: String(d.reference_number || '').trim(), date: d.d,
      amount: amt, left: amt, customer: balance.has(k) ? k : null, linked: false,
    });
  }

  // QuickBooks applies a credit (journal entry / credit memo) to invoices with
  // a zero-amount Payment whose `invoice_numbers` lists the invoices AND the
  // credit's own number. That ties an unnamed journal to its customer, and
  // replaying cash payments and these applications in date order gives each
  // linked credit's exact open amount on any date.
  const [payments] = await pool.execute(
    `SELECT customer_name, DATE_FORMAT(date, '%Y-%m-%d') AS d, amount, unused_amount, invoice_numbers
       FROM zb_customer_payments
      WHERE user_id = ? AND org_id = ? AND COALESCE(is_deleted, 0) = 0 AND COALESCE(invoice_numbers, '') <> ''`,
    [userId, orgId]
  );
  const [invRows] = await pool.execute(
    `SELECT invoice_number, customer_name, DATE_FORMAT(date, '%Y-%m-%d') AS d, total
       FROM invoices
      WHERE user_id = ? AND org_id = ?
        AND LOWER(COALESCE(status, '')) NOT IN ('draft', 'approved', 'submitted', 'void', 'voided', 'deleted')`,
    [userId, orgId]
  );
  const invByNum = new Map(invRows.map((r) => [String(r.invoice_number).trim(), r]));
  const tokens = (p) => String(p.invoice_numbers).split(',').map((t) => t.trim()).filter(Boolean);
  const events = [];
  for (const p of payments) {
    const k = nameKey(p.customer_name);
    const invs = tokens(p).filter((t) => invByNum.has(t));
    const credits = [];
    // Home-currency customers only: a foreign customer's journal is booked in
    // the home currency at its own rate, which the synced ledger doesn't keep,
    // so replaying it in the invoice currency would leave FX crumbs.
    for (const t of (rate.get(k) || 1) === 1 ? tokens(p) : []) {
      if (invByNum.has(t)) continue;
      const doc = creditDocs.find((c) => c.ref === t && (c.customer === k || c.customer == null));
      if (!doc) continue;
      doc.customer = k;
      doc.linked = true;
      credits.push(doc);
    }
    events.push({ date: p.d, customer: k, invs, credits, cash: num(p.amount) > 0 ? num(p.amount) - num(p.unused_amount) : 0 });
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || (b.cash > 0) - (a.cash > 0));

  // Open amount (home currency) of every linked credit on `day`.
  const linkedOpen = (day) => {
    const invOpen = new Map();
    for (const r of invRows) if (r.d <= day) invOpen.set(String(r.invoice_number).trim(), num(r.total));
    const credOpen = new Map();
    for (const c of creditDocs) if (c.linked && c.date <= day) credOpen.set(c, c.amount / (rate.get(c.customer) || 1));
    for (const e of events) {
      if (e.date > day) break;
      if (e.cash > 0) {
        let left = e.cash;
        for (const n of e.invs) {
          const t = Math.min(invOpen.get(n) || 0, left);
          invOpen.set(n, (invOpen.get(n) || 0) - t);
          left -= t;
        }
        continue;
      }
      const creds = e.credits.filter((c) => (credOpen.get(c) || 0) > 0.005);
      for (const n of e.invs) {
        let need = invOpen.get(n) || 0;
        for (const c of creds) {
          if (need <= 0.005) break;
          const t = Math.min(credOpen.get(c), need);
          credOpen.set(c, credOpen.get(c) - t);
          need -= t;
        }
        invOpen.set(n, need);
      }
    }
    const out = new Map();
    for (const [c, v] of credOpen) out.set(c, round2(v * (rate.get(c.customer) || 1)));
    return out;
  };

  // What's unapplied today per customer, less what the linked credits explain;
  // the rest is attributed to the customer's unlinked credits below.
  const openToday = linkedOpen('9999-12-31');
  const explained = new Map();
  for (const [c, v] of openToday) explained.set(c.customer, (explained.get(c.customer) || 0) + v);
  const gap = new Map();
  for (const [k, bal] of balance) {
    const g = round2((bal - (openNative.get(k) || 0) + (unused.get(k) || 0)) * (rate.get(k) || 1) + (explained.get(k) || 0));
    if (g < -0.005) gap.set(k, g);
  }

  const own = new Map();
  const unnamed = [];
  for (const doc of creditDocs) {
    if (doc.linked || doc.date > asOfDay) continue;
    if (doc.customer) {
      if (!own.has(doc.customer)) own.set(doc.customer, []);
      own.get(doc.customer).push(doc);
    } else {
      unnamed.push(doc);
    }
  }

  const items = [];
  const take = (k, doc, amount) => {
    doc.left = round2(doc.left - amount);
    gap.set(k, round2(gap.get(k) + amount));
    items.push({
      customer: display.get(k),
      date: doc.date,
      amount: -round2(amount),
      total: -doc.amount,
      type: doc.type,
      docNumber: doc.ref,
      ref: [doc.type, doc.ref].filter(Boolean).join(' '),
    });
  };
  // Linked credits: their exact open amount on the as-of date.
  for (const [c, v] of linkedOpen(asOfDay)) {
    if (v <= 0.005 || !display.has(c.customer)) continue;
    items.push({
      customer: display.get(c.customer), date: c.date, amount: -v, total: -c.amount,
      type: c.type, docNumber: c.ref, ref: [c.type, c.ref].filter(Boolean).join(' '),
    });
  }

  const needing = () => [...gap].filter(([, g]) => g < -0.005).sort((a, b) => a[1] - b[1]);
  const newestFirst = (a, b) => b.date.localeCompare(a.date);

  // 1. A single document of exactly the unapplied amount.
  for (const [k] of needing()) {
    const need = -gap.get(k);
    const exact = (own.get(k) || []).filter((d) => Math.abs(d.left - need) < 0.005).sort(newestFirst)[0]
      || unnamed.find((d) => d.left === d.amount && Math.abs(d.amount - need) < 0.005);
    if (exact) take(k, exact, need);
  }
  // 2. The customer's own credit documents, newest first.
  for (const [k] of needing()) {
    for (const doc of (own.get(k) || []).sort(newestFirst)) {
      const need = -gap.get(k);
      if (need <= 0.005) break;
      if (doc.left > 0.005) take(k, doc, Math.min(doc.left, need));
    }
  }
  // 3. What no document explains stays on the customer, so its total matches —
  // only for an as-of date at or after the latest A/R activity (the customer
  // balances are current figures; an earlier date can't be told apart).
  const [[last]] = await pool.execute(
    `SELECT DATE_FORMAT(MAX(transaction_date), '%Y-%m-%d') AS d FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND account_type_code = 'accounts_receivable'`,
    [userId, orgId]
  );
  if (last?.d && asOfDay < last.d) return items;
  for (const [k, g] of gap) {
    if (g < -0.005) {
      items.push({ customer: display.get(k), date: asOfDay, amount: round2(g), total: round2(g), type: 'Unapplied balance', docNumber: '', ref: 'Unapplied balance' });
    }
  }
  return items;
}

module.exports = { qboUnappliedArCredits };
