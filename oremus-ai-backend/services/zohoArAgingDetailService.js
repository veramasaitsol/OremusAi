'use strict';

/**
 * AR Aging Details (by Invoice Due Date)
 * -------------------------------------------------------------
 * Zoho Books' v3 India region does not expose a working
 * /reports/aragingdetails endpoint, so this report is built from
 * the synced `zb_invoices` warehouse instead. It mirrors Zoho's
 * "AR Aging Details By Invoice Due Date" layout: open invoices
 * grouped into 4x15-day aging buckets with a per-bucket subtotal
 * header and a grand total, in the same { columns, rows, currency }
 * shape the frontend report viewer expects.
 */

const pool = require('../config/db');
const { attachAsOfBalances } = require('./salesArFromInvoicesService');
const { getBaseCurrency } = require('./zohoChartOfAccountsService');

async function getOrgId(userId) {
  const [[row]] = await pool.execute(
    'SELECT org_id FROM zb_tokens WHERE user_id = ?',
    [userId]
  );
  return row?.org_id || null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// MM/DD/YYYY (the A/R Aging Detail layout's date format)
function fmtDate(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

function round2(n) {
  return Math.round((num(n) + Number.EPSILON) * 100) / 100;
}

// As-of date for point-in-time aging: honour the report's "To" date (end of the
// selected period) like Zoho's "As of" field, falling back to an explicit
// as_of_date, then today. The "From" date is irrelevant to a point-in-time aging.
function resolveAsOf(params = {}) {
  const raw = params.as_of_date || params.to_date || params.date_end || null;
  const d = raw ? new Date(raw) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

// Whole-day difference (asOf - dueDate); positive = overdue.
function daysBetween(asOf, due) {
  const MS = 24 * 60 * 60 * 1000;
  const a = Date.UTC(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
  const b = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  return Math.floor((a - b) / MS);
}

// Aging groups, oldest first — the A/R Aging Detail layout. Ranges are
// non-overlapping so every open document lands in exactly one group and the
// group subtotals always foot to the grand total. Empty groups are omitted.
const BUCKETS = [
  { id: 'b91',     label: '91 or more days past due', test: (age) => age >= 91 },
  { id: 'b6190',   label: '61 - 90 days past due',    test: (age) => age >= 61 && age <= 90 },
  { id: 'b3160',   label: '31 - 60 days past due',    test: (age) => age >= 31 && age <= 60 },
  { id: 'b130',    label: '1 - 30 days past due',     test: (age) => age >= 1 && age <= 30 },
  { id: 'current', label: 'CURRENT',                  test: (age) => age <= 0 },
];

function bucketFor(age) {
  return BUCKETS.find((b) => b.test(age)) || BUCKETS[BUCKETS.length - 1];
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Reconstructs each invoice's outstanding balance AS OF a historical date —
// rewinding both cash payments AND credit notes applied after that date.
// Shared with AR Aging Summary (salesArFromInvoicesService.js) so the two
// reports can never independently drift apart on the same calculation; see
// that file for the full explanation.
// Sets `_balanceAsOf` on every invoice row.

/**
 * Build the AR Aging Details report.
 * @param {number} userId  effective Zoho user id (connection owner)
 * @param {object} params  { to_date (as-of), org_id (optional) }
 */
async function buildArAgingDetail(userId, params = {}) {
  const orgId = params.org_id || (await getOrgId(userId));
  if (!orgId) {
    const err = new Error('Zoho not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  // AR aging is point-in-time "as of" a date — the selected "To" date (defaults
  // to today, like Zoho's AR aging).
  const asOf = resolveAsOf(params);
  const asOfDisplay = fmtDate(asOf);

  // Open invoices only (outstanding balance), scoped to the org. Match Zoho's
  // AR aging: count actual receivables only — exclude draft / approved (not yet
  // issued to the customer) and void invoices.
  // Pull every issued invoice (NOT just currently-open ones): an invoice with a
  // zero balance today may have been open on the as-of date. attachAsOfBalances
  // rewinds post-as-of payments to recover the historical balance.
  const [invoices] = await pool.execute(
    `SELECT invoice_number, customer_name, status, date, due_date,
            total, balance, currency_code, exchange_rate
       FROM invoices
      WHERE user_id = ? AND org_id = ?
        AND LOWER(COALESCE(status, '')) NOT IN
            ('draft', 'approved', 'submitted', 'void', 'voided', 'deleted')
      ORDER BY due_date ASC, date ASC`,
    [userId, orgId]
  );

  await attachAsOfBalances(invoices, userId, orgId, asOf);
  // total/_balanceAsOf are still native to each invoice's own currency at this
  // point — attachAsOfBalances' payment/credit-note rewinding runs entirely in
  // that native currency. Convert to the org's base currency only now, so both
  // the displayed row and every bucket subtotal/grand total below agree.
  for (const inv of invoices) {
    const rate = num(inv.exchange_rate) || 1;
    inv.total = round2(inv.total * rate);
    inv._balanceAsOf = round2(inv._balanceAsOf * rate);
  }

  // Always the org's base/reporting currency, never a per-invoice code — every
  // amount here is already converted to it, so a multi-currency org's totals
  // still foot correctly.
  const currency = await getBaseCurrency(orgId);

  // Standalone unapplied / overpayment customer-Payment credits still reduce a
  // customer's true outstanding receivable. QuickBooks' own Aged Receivable
  // Detail lists each as a separate negative row (Transaction type "Payment",
  // no invoice #), aged by the payment's own date — omitting them understates
  // the customer's balance by exactly the unapplied amount. Modelled as
  // invoice-shaped rows (negative total/balance, flagged `_isPayment`) so they
  // flow through the same bucketing/subtotal/render logic below unchanged.
  // ⚠️ Zoho's OWN Aging Detail does NOT surface these as separate rows (proven:
  // a genuine Zoho payment can carry a real nonzero unused_amount, e.g. ₹0.40 —
  // confirmed via its raw API payload — yet Zoho's own report omits it and the
  // grand total ties without it). This behaviour is QuickBooks/Xero-specific, so
  // only synthetic (non-Zoho) payment rows qualify: real Zoho payment ids are
  // bare numeric strings, while ours are prefixed `qbo:`/`xero:` (contain ':').
  const [creditPayments] = await pool.execute(
    `SELECT customer_name, date, amount, unused_amount, exchange_rate
       FROM zb_customer_payments
      WHERE user_id = ? AND org_id = ? AND date <= ? AND unused_amount <> 0
        AND zoho_payment_id LIKE '%:%'`,
    [userId, orgId, ymd(asOf)]
  );
  for (const p of creditPayments) {
    // The payment's own rate — it isn't necessarily tied to any one invoice.
    const rate = num(p.exchange_rate) || 1;
    invoices.push({
      invoice_number: '',
      customer_name: p.customer_name,
      date: p.date,
      due_date: p.date,
      total: round2(-num(p.amount) * rate),
      _balanceAsOf: round2(-num(p.unused_amount) * rate),
      _isPayment: true,
    });
  }

  const columns = [
    { key: 'date',     label: 'Date',             align: 'left'  },
    { key: 'txnType',  label: 'Transaction type', align: 'left'  },
    { key: 'invoice',  label: 'Invoice',          align: 'left'  },
    { key: 'customer', label: 'Customer Name',    align: 'left'  },
    { key: 'dueDate',  label: 'Due date',         align: 'left'  },
    { key: 'amount',   label: 'Amount',           align: 'right' },
    { key: 'balance',  label: 'Balance',          align: 'right' },
  ];

  // Aging basis: due date (QuickBooks / Xero default, and Zoho's "Aging By:
  // Invoice Due Date") unless the caller asks to age from the invoice date.
  const ageFromInvoiceDate = String(params.aging_by || '').toLowerCase() === 'invoice_date';

  // Group invoices into aging buckets.
  const grouped = new Map(BUCKETS.map((b) => [b.id, []]));
  for (const inv of invoices) {
    // Point-in-time: skip invoices issued after the as-of date (didn't exist
    // yet) and any already settled on/before it (no outstanding balance then).
    if (inv.date && new Date(inv.date) > asOf) continue;
    // Unapplied-payment credit rows carry a NEGATIVE balance by design — only
    // invoices are dropped once fully settled.
    if (!inv._isPayment && inv._balanceAsOf <= 0) continue;
    // An invoice with no due date is due on issue (how all three providers
    // treat it) — never drop it, or its balance vanishes from the total.
    const basis = ageFromInvoiceDate ? (inv.date || inv.due_date)
                                     : (inv.due_date || inv.date);
    if (!basis) continue;
    const age = daysBetween(asOf, new Date(basis));
    const b = bucketFor(age);
    grouped.get(b.id).push({ inv, age });
  }

  const rows = [];
  let grandAmount = 0;
  let grandBalance = 0;

  for (const bucket of BUCKETS) {
    const items = grouped.get(bucket.id);
    if (!items.length) continue;   // empty groups are omitted

    const bucketAmount = items.reduce((s, x) => s + num(x.inv.total), 0);
    const bucketBalance = items.reduce((s, x) => s + x.inv._balanceAsOf, 0);
    grandAmount += bucketAmount;
    grandBalance += bucketBalance;

    rows.push({ label: bucket.label, isHeader: true, level: 0, cells: {} });

    for (const { inv } of items) {
      rows.push({
        label: fmtDate(inv.date),
        level: 1,
        cells: {
          txnType:  inv._isPayment ? 'Payment' : 'Invoice',
          invoice:  inv.invoice_number || '',
          customer: inv.customer_name || '',
          dueDate:  fmtDate(inv.due_date || inv.date),
          amount:   round2(inv.total),
          balance:  round2(inv._balanceAsOf),
        },
      });
    }

    rows.push({
      label: `Total for ${bucket.label}`,
      isSubtotal: true,
      level: 0,
      cells: { amount: round2(bucketAmount), balance: round2(bucketBalance) },
    });
  }

  rows.push({
    label: 'TOTAL',
    isTotal: true,
    level: 0,
    cells: { amount: round2(grandAmount), balance: round2(grandBalance) },
  });

  return {
    columns,
    rows,
    currency,
    meta: {
      title: 'A/R Aging Detail Report',
      asOf: asOfDisplay,
      agingBy: ageFromInvoiceDate ? 'Invoice Date' : 'Invoice Due Date',
    },
  };
}

module.exports = { buildArAgingDetail };
