'use strict';

/**
 * A/P Aging Detail + A/P Aging Summary
 * -------------------------------------------------------------
 * The payables counterpart of the A/R aging reports, built from the shared
 * `bills` warehouse (plus the GL for unapplied vendor credits) instead of a
 * provider report API — so the identical layout and numbers come out for Zoho,
 * QuickBooks and Xero. The detail report lists every open bill / vendor credit
 * grouped into past-due bands with a per-band subtotal and a grand total, in
 * the { columns, rows, currency } shape the report viewer expects.
 */

const pool = require('../config/db');
// The A/P Aging Summary ages into the same nine buckets as the A/R Aging
// Summary — one shared definition keeps the two reports column-identical.
const { AGING_BUCKETS, agingBucketFor } = require('./salesArFromInvoicesService');

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

const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

// DD/MM/YYYY (matches Zoho's India locale display)
function fmtDate(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// MM/DD/YYYY (the A/P Aging Detail layout's date format)
function fmtDateUS(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  return `${mm}/${dd}/${dt.getFullYear()}`;
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

// Past-due bands, oldest first — the A/P Aging Detail layout (the mirror of the
// A/R Aging Detail's groups). Ranges are non-overlapping so every document lands
// in exactly one band and the band subtotals always foot to the grand total.
// Empty bands are omitted.
const DETAIL_BUCKETS = [
  { id: 'b91',     label: '91 or more days past due', test: (age) => age >= 91 },
  { id: 'b6190',   label: '61 - 90 days past due',    test: (age) => age >= 61 && age <= 90 },
  { id: 'b3160',   label: '31 - 60 days past due',    test: (age) => age >= 31 && age <= 60 },
  { id: 'b130',    label: '1 - 30 days past due',     test: (age) => age >= 1 && age <= 30 },
  { id: 'current', label: 'CURRENT',                  test: (age) => age <= 0 },
];

function detailBucketFor(age) {
  return DETAIL_BUCKETS.find((b) => b.test(age)) || DETAIL_BUCKETS[DETAIL_BUCKETS.length - 1];
}

/**
 * Build the A/P Aging Detail report — every open bill and unapplied vendor
 * credit as of a date, grouped into past-due bands. Provider-agnostic: pass the
 * connection's org_id (Zoho org / QBO realm / Xero tenant).
 * @param {number} userId  effective user id (connection owner)
 * @param {object} params  { as_of_date | to_date (as-of), aging_by, org_id }
 */
async function buildApAgingDetail(userId, params = {}) {
  const orgId = params.org_id || (await getOrgId(userId));
  if (!orgId) {
    const err = new Error('Provider not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  // AP aging is point-in-time "as of" a date — the selected "To" date (defaults
  // to today, like every provider's AP aging).
  const asOf = resolveAsOf(params);

  // Age by due date (the default for Xero's Aged Payables and QuickBooks' A/P
  // Aging Detail); `aging_by=bill_date` switches to the bill date like Zoho's
  // "Aging By: Bill Date". Only the band distribution changes — the totals are
  // identical either way, and match the A/P Aging Summary.
  const agingByBillDate =
    ['billdate', 'bill', 'transactiondate', 'invoicedate']
      .includes(String(params.aging_by || params.aging_by_date || '').toLowerCase().replace(/[\s_-]/g, ''));

  // Same population as the A/P Aging Summary so the two reports always foot to
  // the same total: every issued bill (not just currently-outstanding ones —
  // attachAsOfBillBalances below reconstructs the as-of balance), non-payable
  // statuses excluded across all three providers (Zoho draft/void, Xero
  // DRAFT/SUBMITTED/VOIDED/DELETED).
  const [bills] = await pool.execute(
    `SELECT bill_number, vendor_name, date, due_date,
            total, balance, currency_code
       FROM bills
      WHERE user_id = ? AND org_id = ?
        AND LOWER(COALESCE(status, '')) NOT IN ('draft', 'submitted', 'void', 'voided', 'deleted')`,
    [userId, orgId]
  );

  await attachAsOfBillBalances(bills, userId, orgId, asOf);

  const currency = bills.find((r) => r.currency_code)?.currency_code || 'INR';

  const columns = [
    { key: 'date',    label: 'Date',             align: 'left'  },
    { key: 'txnType', label: 'Transaction type', align: 'left'  },
    { key: 'invoice', label: 'Invoice',          align: 'left'  },
    { key: 'vendor',  label: 'Vendor name',      align: 'left'  },
    { key: 'dueDate', label: 'Due date',         align: 'left'  },
    { key: 'pastDue', label: 'Past due',         align: 'right' },
    { key: 'amount',  label: 'Amount',           align: 'right' },
    { key: 'balance', label: 'Balance',          align: 'right' },
  ];

  // Collect the documents, each bucketed by its own age.
  const grouped = new Map(DETAIL_BUCKETS.map((b) => [b.id, []]));
  const place = (doc, agingDate) => {
    const age = daysBetween(asOf, new Date(agingDate));
    grouped.get(detailBucketFor(age).id).push({ ...doc, age });
  };

  for (const bill of bills) {
    // Point-in-time: a bill entered after the as-of date didn't exist yet.
    if (bill.date && new Date(bill.date) > asOf) continue;
    // Settled on/before the as-of date (per the ledger reconstruction) — not
    // outstanding, so it doesn't belong in a historical aging snapshot.
    if (num(bill._balanceAsOf) === 0) continue;
    // A bill with no due date is due on receipt (how all three providers treat
    // it) — never drop it, or its balance vanishes from the total.
    const basis = agingByBillDate ? (bill.date || bill.due_date)
                                  : (bill.due_date || bill.date);
    if (!basis) continue;
    place({
      date: bill.date,
      txnType: 'Bill',
      invoice: bill.bill_number || '',
      vendor: bill.vendor_name || '',
      dueDate: fmtDateUS(bill.due_date || bill.date),
      amount: num(bill.total),
      balance: bill._balanceAsOf,
      breakdown: bill._breakdown,
    }, basis);
  }

  // Unapplied vendor credits reduce what's owed, exactly as they do on the
  // platform's own report. A credit note has no due date, so it shows blank Due
  // date / Past due and ages by its own document date.
  for (const c of await fetchUnallocatedVendorCredits(userId, orgId, asOf)) {
    place({
      date: c.date,
      txnType: 'Vendor Credit',
      invoice: '',
      vendor: c.vendor,
      dueDate: '',
      noAge: true,
      amount: c.amount,
      balance: c.amount,
    }, c.date);
  }

  const rows = [];
  let grandAmount = 0;
  let grandBalance = 0;

  for (const bucket of DETAIL_BUCKETS) {
    const items = grouped.get(bucket.id);
    if (!items.length) continue;   // empty bands are omitted
    items.sort((a, b) => new Date(a.date) - new Date(b.date));

    const bucketAmount = items.reduce((s, x) => s + x.amount, 0);
    const bucketBalance = items.reduce((s, x) => s + x.balance, 0);
    grandAmount += bucketAmount;
    grandBalance += bucketBalance;

    rows.push({ label: bucket.label, isHeader: true, level: 0, cells: {} });

    for (const d of items) {
      // The Balance column is a reconstructed, as-of-date figure — clicking it
      // opens the same breakdown modal AP Aging Summary's cells use, showing
      // the GL postings (payments, vendor credits, adjustments) it's built from.
      const cellDrill = d.breakdown?.length ? { balance: d.breakdown } : undefined;
      rows.push({
        label: fmtDateUS(d.date),
        level: 1,
        cells: {
          txnType: d.txnType,
          invoice: d.invoice,
          vendor: d.vendor,
          dueDate: d.dueDate,
          // A day count, not money — send it as text so the viewer prints "100"
          // instead of running it through the currency formatter ("100.00").
          pastDue: (d.noAge || d.age <= 0) ? '' : String(d.age),
          amount: round2(d.amount),
          balance: round2(d.balance),
        },
        cellDrill,
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
      title: 'A/P Aging Detail Report',
      asOf: fmtDateUS(asOf),
      agingBy: agingByBillDate ? 'Bill Date' : 'Bill Due Date',
    },
  };
}

/**
 * Vendor credit notes that are still UNALLOCATED as of a date, as
 * [{ vendor, date, amount (negative) }].
 *
 * The providers show a vendor's credit balance in their aged-payables report
 * only for the part that isn't already applied to a bill (an applied credit has
 * already reduced that bill's balance, so counting it again would double it).
 * The `bills` warehouse stores balances but not credit notes, so the leftover is
 * derived from the GL's Accounts Payable control lines: a vendor whose A/P
 * ledger balance is NEGATIVE owes nothing and is holding exactly that much
 * unapplied credit. It is then spread over that vendor's credit notes
 * newest-first (providers apply the oldest credits first) so each leftover slice
 * ages by its own document date.
 *
 * Returns [] for connections with no synced GL credit notes (Zoho/QuickBooks
 * today) — their bill balances already reconcile with the platform.
 */
async function fetchUnallocatedVendorCredits(userId, orgId, asOf) {
  // End-of-day literal built from the same calendar date daysBetween() ages by,
  // so the cut-off can't slip a day through a timezone conversion.
  const cutoff = `${asOf.getFullYear()}-${String(asOf.getMonth() + 1).padStart(2, '0')}-${String(asOf.getDate()).padStart(2, '0')} 23:59:59`;
  const [lines] = await pool.execute(
    `SELECT transaction_details AS vendor, source_id, source_type,
            MIN(transaction_date) AS doc_date,
            SUM(credit) - SUM(debit) AS net
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND account_type_code = 'accounts_payable'
        AND transaction_date <= ?
        AND transaction_id NOT LIKE 'xero-recon:%'
      GROUP BY vendor, source_id, source_type`,
    [userId, orgId, cutoff]
  );
  if (!lines.length) return [];

  // vendor → { net, credits: [{ date, amount }] }
  const byVendor = new Map();
  for (const ln of lines) {
    const vendor = (ln.vendor || '').trim();
    if (!vendor) continue;
    if (!byVendor.has(vendor)) byVendor.set(vendor, { net: 0, credits: [] });
    const v = byVendor.get(vendor);
    v.net += num(ln.net);
    // Credit notes debit A/P (net < 0); payments do too, so key on the type.
    if (/CREDIT/i.test(ln.source_type || '') && num(ln.net) < 0) {
      v.credits.push({ date: ln.doc_date, amount: -num(ln.net) });
    }
  }

  const out = [];
  for (const [vendor, v] of byVendor) {
    let remaining = round2(-v.net); // negative ledger balance = unapplied credit
    if (remaining <= 0.005 || !v.credits.length) continue;
    v.credits.sort((a, b) => new Date(b.date) - new Date(a.date));
    for (const c of v.credits) {
      if (remaining <= 0.005) break;
      const take = Math.min(remaining, c.amount);
      out.push({ vendor, date: c.date, amount: -round2(take) });
      remaining = round2(remaining - take);
    }
  }
  return out;
}

/**
 * Build the A/P Aging Summary report — the payables mirror of the A/R Aging
 * Summary. Outstanding bills as of a date, grouped by vendor into the nine
 * shared aging buckets plus a Total column. Provider-agnostic: pass the
 * connection's org_id (Zoho org / QBO realm / Xero tenant) and it works from
 * the shared `bills` warehouse with an identical structure for every provider.
 * @param {number} userId  effective user id (connection owner)
 * @param {object} params  { as_of_date | to_date (as-of), aging_by, org_id }
 */
async function buildApAgingSummary(userId, params = {}) {
  const orgId = params.org_id || (await getOrgId(userId));
  if (!orgId) {
    const err = new Error('Provider not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  // Point-in-time as-of date — the selected "To" date (defaults to today).
  const asOf = resolveAsOf(params);

  // Age by due date (what Xero's Aged Payables and QuickBooks' A/P Aging
  // Summary do by default); `aging_by=bill_date` switches to the bill date like
  // Zoho's "Aging By: Bill Date" option. Only the bucket distribution changes —
  // the vendor totals and the grand total are identical either way.
  const agingByBillDate =
    ['billdate', 'bill', 'transactiondate', 'invoicedate']
      .includes(String(params.aging_by || params.aging_by_date || '').toLowerCase().replace(/[\s_-]/g, ''));

  // Every issued bill (NOT just currently-outstanding ones — a bill that's
  // since been fully paid may still have owed a balance on the as-of date;
  // attachAsOfBillBalances below reconstructs what it actually was). Statuses
  // excluded are the non-payable ones across all three: Zoho draft/void,
  // Xero DRAFT/SUBMITTED/VOIDED/DELETED.
  const [bills] = await pool.execute(
    `SELECT bill_number, vendor_name, date, due_date, total, balance, currency_code
       FROM bills
      WHERE user_id = ? AND org_id = ?
        AND LOWER(COALESCE(status, '')) NOT IN ('draft', 'submitted', 'void', 'voided', 'deleted')`,
    [userId, orgId]
  );

  await attachAsOfBillBalances(bills, userId, orgId, asOf);

  const currency = bills.find((r) => r.currency_code)?.currency_code || 'INR';

  const columns = [
    { key: 'vendor', label: 'Vendor Name', align: 'left' },
    ...AGING_BUCKETS.map((b) => ({ key: b.id, label: b.label, align: 'right' })),
    { key: 'total', label: 'Total', align: 'right' },
  ];

  // vendor → { bucketId: amount }
  const byVendor = new Map();
  // vendor → { bucketId: [ {name, ref, date, amount}, … ] } — the exact bills/
  // credits behind each cell, for the click-to-drill-down below (mirrors
  // QuickBooks' own "click a Summary cell → see its Detail rows").
  const byVendorDrill = new Map();
  const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [b.id, 0]));
  let grandTotal = 0;

  const add = (vendorName, agingDate, amount, ref) => {
    if (!agingDate || !amount) return;
    const age = daysBetween(asOf, new Date(agingDate));
    const bucket = agingBucketFor(age);
    const vendor = (vendorName || '').trim() || 'Unknown';
    if (!byVendor.has(vendor)) {
      byVendor.set(vendor, Object.fromEntries(AGING_BUCKETS.map((b) => [b.id, 0])));
    }
    byVendor.get(vendor)[bucket.id] += amount;
    totals[bucket.id] += amount;
    grandTotal += amount;
    if (!byVendorDrill.has(vendor)) {
      byVendorDrill.set(vendor, Object.fromEntries(AGING_BUCKETS.map((b) => [b.id, []])));
    }
    byVendorDrill.get(vendor)[bucket.id].push({
      name: vendor, ref: ref || '', date: fmtDate(new Date(agingDate)), amount: round2(amount),
    });
  };

  for (const bill of bills) {
    // Point-in-time: a bill entered after the as-of date didn't exist yet.
    if (bill.date && new Date(bill.date) > asOf) continue;
    // A bill with no due date is due on receipt (that's how the providers treat
    // it) — never drop it, or the grand total stops matching the platform.
    add(bill.vendor_name, agingByBillDate ? bill.date : (bill.due_date || bill.date), bill._balanceAsOf, bill.bill_number);
  }

  // Unapplied vendor credits reduce what's owed, exactly as they do on the
  // platform's own report (a credit note has no due date — it ages by its date).
  for (const c of await fetchUnallocatedVendorCredits(userId, orgId, asOf)) {
    add(c.vendor, c.date, c.amount, 'Vendor Credit');
  }

  const rows = [];
  const vendors = [...byVendor.keys()].sort((a, b) => a.localeCompare(b));
  for (const vendor of vendors) {
    const v = byVendor.get(vendor);
    const cells = {};
    const cellDrill = {};
    // Empty buckets render BLANK (not 0.00) like Xero/QuickBooks do — with nine
    // aging columns a wall of zeros hides the amounts that matter. The TOTAL row
    // below keeps real 0.00s so every column still foots.
    for (const k of AGING_BUCKETS) {
      const v2 = round2(v[k.id]);
      cells[k.id] = v2 === 0 ? '' : v2;
      const entries = byVendorDrill.get(vendor)?.[k.id];
      if (entries && entries.length) cellDrill[k.id] = entries;
    }
    cells.total = round2(AGING_BUCKETS.reduce((s, k) => s + v[k.id], 0));
    const allEntries = AGING_BUCKETS.flatMap((k) => byVendorDrill.get(vendor)?.[k.id] || []);
    if (allEntries.length) cellDrill.total = allEntries;
    rows.push({ label: vendor, level: 1, cells, cellDrill });
  }

  const totalCells = {};
  for (const k of AGING_BUCKETS) totalCells[k.id] = round2(totals[k.id]);
  totalCells.total = round2(grandTotal);
  rows.push({ label: 'TOTAL', isTotal: true, level: 0, cells: totalCells });

  return {
    columns,
    rows,
    currency,
    meta: {
      title: 'A/P Aging Summary Report',
      asOf: fmtDate(asOf),
      agingBy: agingByBillDate ? 'Bill Date' : 'Bill Due Date',
    },
  };
}

// Reconstructs each bill's outstanding balance AS OF a historical date —
// directly from the Accounts Payable control-account ledger
// (account_transactions), not from a separate vendor-payment/vendor-credit
// warehouse table (Zoho's own zb_vendor_payments/zb_vendor_credits carry no
// bill-linkage field at all, and building one would mean new sync code and
// new tables per platform). The posting engine tags most settlement rows (a
// vendor payment, a vendor credit applied to a bill) with the ORIGINATING
// BILL's own `transaction_number` rather than the payment/credit's own
// number — confirmed empirically: KRUTI COMP's bill `KC2526/1095` and its
// 2026-01-16 payment share that exact transaction_number, so summing
// credit−debit for that number up to the as-of date reproduces the bill's
// true historical balance directly (₹1,486.80 as of 1 Jan 2026, before the
// payment — byte-exact against live Zoho). Same pattern already trusted in
// this file for fetchUnallocatedVendorCredits above, just grouped
// per-document instead of per-vendor. Because account_transactions is the
// SAME unified ledger already populated identically for Zoho, QuickBooks and
// Xero, this needs no platform-specific vendor-payment/vendor-credit sync at
// all — it works for all three the moment their GL is synced.
//
// NOT every settlement is tagged this reliably — found empirically: one bill
// in real data (`KA/MAR25/0868`) has no ledger row anywhere carrying its own
// transaction_number after the bill itself, even though Zoho's own
// `bills.balance` says it's long since paid — almost certainly one leg of a
// multi-bill batch payment whose reference didn't get attributed back to
// every bill it covered. Trusting the ledger blindly there would show a
// FABRICATED outstanding balance for a bill that's genuinely settled — worse
// than the bug being fixed (that bill was invisible before, not wrong).
// So this self-validates per bill: reconstruct the ledger balance as of
// TODAY as well, and only trust the ledger's as-of-date figure for a bill
// where the two agree with Zoho's own authoritative `bills.balance` — for
// any bill where they disagree (a tracing gap), fall back to that bill's
// live balance unadjusted, exactly the pre-fix behaviour, for that bill only.
// Sets `_balanceAsOf` on every bill row.
async function attachAsOfBillBalances(bills, userId, orgId, asOf) {
  for (const bill of bills) {
    bill._balanceAsOf = num(bill.balance);
    // The AP Aging Detail "Balance" column's click-through breakdown starts
    // here — replaced below with the actual GL postings for any bill whose
    // ledger-reconstructed figure is trusted (see the self-validation below).
    bill._breakdown = [{ name: bill.vendor_name || null, ref: bill.bill_number || null, date: null, type: 'Current balance', amount: bill._balanceAsOf }];
  }

  const cutoff = `${asOf.getFullYear()}-${String(asOf.getMonth() + 1).padStart(2, '0')}-${String(asOf.getDate()).padStart(2, '0')} 23:59:59`;
  const [rows] = await pool.execute(
    `SELECT transaction_number, transaction_details,
            SUM(CASE WHEN transaction_date <= ? THEN credit ELSE 0 END)
              - SUM(CASE WHEN transaction_date <= ? THEN debit ELSE 0 END) AS balance_as_of,
            SUM(credit) - SUM(debit) AS balance_today
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND account_type_code = 'accounts_payable'
        AND transaction_id NOT LIKE 'xero-recon:%'
      GROUP BY transaction_number, transaction_details`,
    [cutoff, cutoff, userId, orgId]
  );
  const byKey = new Map();
  for (const r of rows) {
    const key = `${(r.transaction_number || '').trim()}␟${(r.transaction_details || '').trim()}`;
    byKey.set(key, { asOf: num(r.balance_as_of), today: num(r.balance_today) });
  }

  // Individual (non-aggregated) postings, only fetched to back the "how was
  // this calculated" breakdown — the trust-check above already decided which
  // bills' as-of figure is reliable using the aggregate query.
  const [postings] = await pool.execute(
    `SELECT transaction_number, transaction_details, transaction_date,
            transaction_type, source_type, reference_number, credit, debit
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND account_type_code = 'accounts_payable'
        AND transaction_id NOT LIKE 'xero-recon:%'
        AND transaction_date <= ?
      ORDER BY transaction_date`,
    [userId, orgId, cutoff]
  );
  const postingsByKey = new Map();
  for (const r of postings) {
    const key = `${(r.transaction_number || '').trim()}␟${(r.transaction_details || '').trim()}`;
    if (!postingsByKey.has(key)) postingsByKey.set(key, []);
    postingsByKey.get(key).push(r);
  }

  for (const bill of bills) {
    const key = `${(bill.bill_number || '').trim()}␟${(bill.vendor_name || '').trim()}`;
    const ledger = byKey.get(key);
    if (!ledger) continue; // no ledger postings traced to this bill at all — keep live balance
    if (Math.abs(ledger.today - num(bill.balance)) > 0.5) continue; // doesn't reconcile — untrusted for this bill, keep live balance
    bill._balanceAsOf = ledger.asOf;
    bill._breakdown = (postingsByKey.get(key) || []).map((r) => ({
      name: bill.vendor_name || null,
      ref: r.reference_number || bill.bill_number || null,
      date: r.transaction_date ? String(r.transaction_date).slice(0, 10) : null,
      type: r.transaction_type || r.source_type || 'GL Posting',
      amount: round2(num(r.credit) - num(r.debit)),
    }));
  }
}

// fetchUnallocatedVendorCredits and attachAsOfBillBalances are shared with the
// Vendor Balance Detail report so it shows the identical bill population and
// as-of reconstruction, and can never independently drift from AP Aging.
module.exports = { buildApAgingDetail, buildApAgingSummary, fetchUnallocatedVendorCredits, attachAsOfBillBalances };
