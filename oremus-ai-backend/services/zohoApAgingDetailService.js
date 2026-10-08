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
    `SELECT qbo_id, bill_number, vendor_name, date, due_date,
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
      txnType: c.type || 'Vendor Credit',
      invoice: c.docNumber || '',
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
  // QuickBooks keeps unapplied payments, direct expenses, credits and journals
  // against A/P as open negative items — handled by the vendor reconciliation.
  if (await isQuickBooksOrg(orgId)) return (await qboVendorReconciliation(userId, orgId, asOf)).items;

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
    `SELECT qbo_id, bill_number, vendor_name, date, due_date, total, balance, currency_code
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
    add(c.vendor, c.date, c.amount, c.ref || 'Vendor Credit');
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
    rows.push({ label: vendor, level: 1, cells: { vendor, ...cells }, cellDrill });
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
  await attachLedgerBillBalances(bills, userId, orgId, asOf);
  if (!(await isQuickBooksOrg(orgId))) return;

  // QuickBooks: a bill paid AFTER the as-of date still owed that amount on the
  // date (see qboVendorReconciliation) — add it back so the bill ages correctly.
  const { billExtra, billBalance } = await qboVendorReconciliation(userId, orgId, asOf);
  if (billBalance) {
    // Exact: each bill's open amount on the as-of date from QuickBooks' own
    // payment applications.
    for (const bill of bills) {
      const bal = bill.qbo_id != null ? billBalance.get(String(bill.qbo_id)) : undefined;
      if (bal === undefined) continue;
      bill._balanceAsOf = bal;
      bill._breakdown = [{ name: bill.vendor_name || null, ref: bill.bill_number || null, date: null,
        type: 'Bill total less payments applied on or before the as-of date', amount: bal }];
    }
    return;
  }
  // Each amount is used up as it's applied — capped at what the bill can
  // still owe, any remainder going to the next bill with the same key — so
  // two bills sharing number/date/total (duplicates exist in real books)
  // can never both receive it.
  const left = new Map(billExtra);
  for (const bill of bills) {
    const key = qboBillKey(bill);
    const room = round2(num(bill.total) - num(bill._balanceAsOf));
    const extra = round2(Math.min(left.get(key) || 0, Math.max(0, room)));
    if (extra <= 0.005) continue;
    left.set(key, round2(left.get(key) - extra));
    bill._balanceAsOf = round2(num(bill._balanceAsOf) + extra);
    bill._breakdown = [
      ...(bill._breakdown || []),
      { name: bill.vendor_name || null, ref: bill.bill_number || null, date: null, type: 'Paid after as-of date', amount: extra },
    ];
  }
}

async function attachLedgerBillBalances(bills, userId, orgId, asOf) {
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

// ── QuickBooks vendor reconciliation ─────────────────────────────────────────
// QuickBooks' A/P Aging lists, per vendor, every open bill PLUS every document
// that debited A/P without being applied to a bill: direct Expenses posted to
// A/P, Vendor Credits, Journal Entries and unapplied Bill Payments — shown as
// negative lines. Its vendor totals are the vendor balances AS OF the report
// date, which are exactly the vendor's A/P ledger lines dated on or before it
// (so the report always foots to the GL A/P balance on that date). The synced
// GL carries no bill↔payment linkage, so the negative lines are recovered per
// vendor as (vendor balance − open bill balances) and attributed to that
// vendor's own A/P documents. A/P lines with no vendor are listed as they are,
// never borrowed by another vendor. Only QuickBooks orgs take this path.

const qboOrgCache = new Map();
async function isQuickBooksOrg(orgId) {
  const key = String(orgId || '');
  if (!qboOrgCache.has(key)) {
    const [[r]] = await pool.execute('SELECT 1 AS x FROM qbo_organizations WHERE realm_id = ? LIMIT 1', [key])
      .catch(() => [[null]]);
    qboOrgCache.set(key, !!r);
  }
  return qboOrgCache.get(key);
}

const qboBillKey = (b) =>
  `${String(b.bill_number || '').trim()}␟${b.date ? fmtDate(new Date(b.date)) : ''}␟${round2(b.total)}`;

const nameKey = (s) => String(s || '').trim().toLowerCase();
const UNASSIGNED_VENDOR = 'Unassigned (no vendor)';

// The summary, detail and vendor-balance reports all call into this for the
// same as-of date within one request — compute once.
const qboReconCache = new Map();
function qboVendorReconciliation(userId, orgId, asOf) {
  const cutoff = `${asOf.getFullYear()}-${String(asOf.getMonth() + 1).padStart(2, '0')}-${String(asOf.getDate()).padStart(2, '0')} 23:59:59`;
  const key = `${userId}|${orgId}|${cutoff}`;
  const hit = qboReconCache.get(key);
  if (hit && Date.now() - hit.at < 15000) return hit.promise;
  const promise = computeQboVendorReconciliation(userId, orgId, asOf, cutoff);
  qboReconCache.set(key, { at: Date.now(), promise });
  promise.catch(() => qboReconCache.delete(key));
  return promise;
}

// GL source type → the QuickBooks entity a Bill Payment links it by.
const QBO_LINK_TYPE = {
  'Bill': 'Bill',
  'Vendor Credit': 'VendorCredit',
  'Journal Entry': 'JournalEntry',
  'Deposit': 'Deposit',
  'Check': 'Purchase',
  'Expense': 'Purchase',
  'Credit Card Credit': 'Purchase',
};

// Exact open items from QuickBooks' own applications (qbo_ap_links, synced
// from BillPayment.Line[].LinkedTxn). Every A/P document is open by its
// amount less what was applied to it on or before the as-of date — the same
// rule QuickBooks' A/P Aging uses — so no vendor, bucket or amount is inferred.
// Returns null when the company has no synced links (older sync), so the
// caller falls back to the ledger reconciliation below.
async function computeQboExactOpenItems(userId, orgId, asOf, asOfEnd, ctx) {
  let links;
  try {
    [links] = await pool.execute(
      `SELECT payment_id, DATE_FORMAT(payment_date, '%Y-%m-%d') AS d, payment_total, target_type, target_id, amount
         FROM qbo_ap_links WHERE org_id = ?`,
      [orgId]
    );
  } catch (_) { return null; } // table not created yet
  if (!links.length) return null;

  const { canonOf, displayName, bills, billVendorByQboId, expenseVendorByQboId } = ctx;
  const day = fmtDate(asOfEnd).split('/').reverse().join('-'); // YYYY-MM-DD
  const applied = new Map();     // `${type}:${id}` → amount applied on/before the as-of date
  const paymentNet = new Map();  // payment id → { total, applied (bills − credits) }
  for (const l of links) {
    if (!l.d || l.d > day) continue;
    const isBill = l.target_type === 'Bill';
    if (l.target_type !== 'None') {
      const k = `${l.target_type}:${l.target_id}`;
      applied.set(k, (applied.get(k) || 0) + num(l.amount));
    }
    const p = paymentNet.get(l.payment_id) || { total: num(l.payment_total), applied: 0 };
    p.applied += l.target_type === 'None' ? 0 : (isBill ? num(l.amount) : -num(l.amount));
    paymentNet.set(l.payment_id, p);
  }

  // Bills: open = total − payments applied on/before the as-of date.
  const billBalance = new Map();
  for (const b of bills) {
    if (!b.qbo_id) continue;
    billBalance.set(String(b.qbo_id), round2(num(b.total) - (applied.get(`Bill:${b.qbo_id}`) || 0)));
  }

  const [docs] = await pool.execute(
    `SELECT source_type, source_id, reference_number, transaction_details,
            MIN(transaction_date) AS doc_date, SUM(credit) - SUM(debit) AS net
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND account_type_code = 'accounts_payable'
        AND transaction_date IS NOT NULL AND transaction_date <= ?
      GROUP BY source_type, source_id, reference_number, transaction_details`,
    [userId, orgId, `${day} 23:59:59`]
  );
  const items = [];
  for (const d of docs) {
    const type = String(d.source_type || '');
    if (type === 'Bill') continue; // aged from the bills themselves
    const sid = String(d.source_id || '');
    const net = num(d.net);
    let open;
    if (/^Bill Payment/i.test(type)) {
      // Unapplied part of the payment (a debit to A/P, so negative).
      const p = paymentNet.get(sid);
      open = p ? -round2(p.total - p.applied) : net;
    } else {
      const linkType = QBO_LINK_TYPE[type];
      const used = linkType ? (applied.get(`${linkType}:${sid}`) || 0) : 0;
      open = net - Math.sign(net) * Math.min(Math.abs(net), used);
    }
    open = round2(open);
    if (Math.abs(open) <= 0.005) continue;
    const name = (type === 'Expense' && expenseVendorByQboId.get(sid)) || d.transaction_details;
    const canon = canonOf.get(nameKey(name));
    const ref = String(d.reference_number || '').trim();
    items.push({
      vendor: canon ? displayName.get(canon) : UNASSIGNED_VENDOR,
      date: d.doc_date, amount: open, total: round2(net), type, docNumber: ref,
      ref: [type, ref, canon ? null : String(d.transaction_details || '').trim()].filter(Boolean).join(' · '),
      key: `${type}|${sid}|${String(d.transaction_details || '').trim()}`,
      canon: canon || null,
    });
  }
  return { billExtra: new Map(), billBalance, items, exact: true };
}

async function computeQboVendorReconciliation(userId, orgId, asOf, cutoff) {
  const asOfEnd = new Date(cutoff.replace(' ', 'T'));

  // Vendors: every name a vendor goes by → one canonical key, plus its balance.
  const [vendorRows] = await pool.execute(
    `SELECT contact_name, company_name, full_name, outstanding_payable_amount
       FROM vendors WHERE user_id = ? AND org_id = ?`,
    [userId, orgId]
  );
  const canonOf = new Map();
  const balanceToday = new Map();
  const displayName = new Map();
  for (const v of vendorRows) {
    const canon = nameKey(v.contact_name || v.company_name || v.full_name);
    if (!canon) continue;
    for (const n of [v.contact_name, v.company_name, v.full_name]) {
      if (nameKey(n) && !canonOf.has(nameKey(n))) canonOf.set(nameKey(n), canon);
    }
    balanceToday.set(canon, (balanceToday.get(canon) || 0) + num(v.outstanding_payable_amount));
    if (!displayName.has(canon)) displayName.set(canon, String(v.contact_name || v.company_name || v.full_name).trim());
  }
  if (!balanceToday.size) return { billExtra: new Map(), items: [] };

  // Bills as the ledger reconstructs them (the same population the reports use).
  const [bills] = await pool.execute(
    `SELECT bill_number, vendor_name, date, due_date, total, balance, qbo_id
       FROM bills
      WHERE user_id = ? AND org_id = ?
        AND LOWER(COALESCE(status, '')) NOT IN ('draft', 'submitted', 'void', 'voided', 'deleted')`,
    [userId, orgId]
  );
  await attachLedgerBillBalances(bills, userId, orgId, asOf);
  const billVendorByQboId = new Map();
  for (const b of bills) {
    if (b.qbo_id) billVendorByQboId.set(String(b.qbo_id), b.vendor_name);
    const canon = canonOf.get(nameKey(b.vendor_name));
    if (canon) displayName.set(canon, String(b.vendor_name).trim()); // group with the bills
  }
  const [expenses] = await pool.execute(
    `SELECT qbo_id, vendor_name FROM expense_entries
      WHERE user_id = ? AND org_id = ? AND qbo_id IS NOT NULL AND COALESCE(vendor_name, '') <> ''`,
    [userId, orgId]
  );
  const expenseVendorByQboId = new Map(expenses.map((e) => [String(e.qbo_id), e.vendor_name]));

  // QuickBooks' own applications, when synced, give every open item exactly.
  const exact = await computeQboExactOpenItems(userId, orgId, asOf, asOfEnd,
    { canonOf, displayName, bills, billVendorByQboId, expenseVendorByQboId });
  if (exact) return exact;

  // A/P documents. The GL's Name column is the vendor for bill payments,
  // credits and (as synced) journal lines; bills and expenses resolve through
  // their own documents.
  const [docs] = await pool.execute(
    `SELECT source_type, source_id, reference_number, transaction_details,
            MIN(transaction_date) AS doc_date, SUM(credit) - SUM(debit) AS net
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND account_type_code = 'accounts_payable'
        AND transaction_date IS NOT NULL
      GROUP BY source_type, source_id, reference_number, transaction_details`,
    [userId, orgId]
  );
  const balanceAsOf = new Map(); // canon → A/P ledger balance on the as-of date
  const vendorDocs = new Map(); // canon → negative docs on/before the as-of date
  const unattributed = [];
  for (const d of docs) {
    const type = String(d.source_type || '');
    const sid = String(d.source_id || '');
    const name = (type === 'Bill' && billVendorByQboId.get(sid))
      || (type === 'Expense' && expenseVendorByQboId.get(sid))
      || d.transaction_details;
    const net = num(d.net);
    // The vendor is the line's own name (bills/expenses through their
    // documents). The QuickBooks sync stores a journal line's real entity, so
    // nothing is guessed from memos or amounts.
    const canon = canonOf.get(nameKey(name));
    const onOrBefore = new Date(d.doc_date) <= asOfEnd;
    if (!onOrBefore) continue; // after the as-of date: not part of it at all
    if (canon) balanceAsOf.set(canon, (balanceAsOf.get(canon) || 0) + net);
    if (type === 'Bill') continue; // bills are aged from the bills themselves
    if (!canon) {
      // No vendor on this A/P line — keep it (either sign) under its own name.
      if (Math.abs(net) > 0.005) unattributed.push({ type, date: d.doc_date, amount: round2(net), ref: String(d.reference_number || '').trim(), name: String(d.transaction_details || '').trim() });
      continue;
    }
    if (net >= -0.005) continue;
    const doc = {
      type, date: d.doc_date, amount: round2(-net), left: round2(-net),
      ref: String(d.reference_number || '').trim(),
      key: `${type}|${sid}|${String(d.transaction_details || '').trim()}`,
    };
    {
      if (!vendorDocs.has(canon)) vendorDocs.set(canon, []);
      vendorDocs.get(canon).push(doc);
    }
  }

  // Per vendor: balance on the as-of date vs the bills open on it.
  const openBills = new Map();
  for (const b of bills) {
    if (b.date && new Date(b.date) > asOf) continue;
    const canon = canonOf.get(nameKey(b.vendor_name));
    if (!canon) continue;
    if (!openBills.has(canon)) openBills.set(canon, []);
    openBills.get(canon).push(b);
  }
  const gap = new Map();
  for (const canon of new Set([...balanceAsOf.keys(), ...openBills.keys()])) {
    const balAsOf = balanceAsOf.get(canon) || 0;
    const billed = (openBills.get(canon) || []).reduce((s, b) => s + num(b._balanceAsOf), 0);
    const g = round2(balAsOf - billed);
    if (Math.abs(g) > 0.005) gap.set(canon, g);
  }

  const items = [];
  const takeFrom = (canon, doc, amount) => {
    doc.left = round2(doc.left - amount);
    gap.set(canon, round2((gap.get(canon) || 0) + amount));
    items.push({
      vendor: displayName.get(canon),
      date: doc.date,
      amount: -round2(amount),
      total: -round2(doc.amount), // the document's full amount (amount = its open part)
      type: doc.type,
      docNumber: doc.ref,
      ref: [doc.type, doc.ref].filter(Boolean).join(' '),
      key: doc.key,
      canon,
    });
  };

  // A credit still unapplied TODAY was unapplied on every earlier date after it
  // was issued (applications don't reverse). So for a past as-of date, every
  // document open today and dated on or before it is listed at its open amount
  // today first — the same documents QuickBooks shows — and only what's left
  // is explained by bills paid, or credits applied, after the as-of date.
  if (asOf.getFullYear() < 9999) {
    const today = await qboVendorReconciliation(userId, orgId, new Date(9999, 11, 31));
    const byKey = new Map();
    for (const list of vendorDocs.values()) for (const d of list) byKey.set(d.key, d);
    for (const it of today.items) {
      const doc = it.key && byKey.get(it.key);
      if (!doc || !it.canon) continue; // dated after the as-of date
      takeFrom(it.canon, doc, Math.min(doc.left, -it.amount));
    }
  }

  // Owed more than the open bills → bills paid after the as-of date. Restore
  // them newest-first (payments settle the oldest bills first).
  const billExtra = new Map();
  for (const [canon, g] of gap) {
    if (g <= 0) continue;
    let need = g;
    const list = (openBills.get(canon) || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    for (const b of list) {
      if (need <= 0.005) break;
      const room = round2(num(b.total) - num(b._balanceAsOf));
      if (room <= 0.005) continue;
      const take = round2(Math.min(room, need));
      billExtra.set(qboBillKey(b), round2((billExtra.get(qboBillKey(b)) || 0) + take));
      need = round2(need - take);
    }
    gap.set(canon, need);
  }

  // Owed less than the open bills → unapplied debits. Take the vendor's own
  // expenses / credits / journals first, then a journal or credit with no
  // vendor name that matches the amount, then its bill payments.
  const newestFirst = (a, b) => new Date(b.date) - new Date(a.date);
  const needing = () => [...gap].filter(([, g]) => g < -0.005).sort((a, b) => a[1] - b[1]);

  // A single document of exactly the unapplied amount is that document — take
  // it whole before splitting anything (vendor's own documents first, then one
  // with no vendor name), so an unrelated larger journal is never sliced up.
  for (const [canon] of needing()) {
    const need = -gap.get(canon);
    const exact = (vendorDocs.get(canon) || []).filter((d) => Math.abs(d.left - need) < 0.005).sort(newestFirst)[0];
    if (exact) takeFrom(canon, exact, need);
  }

  for (const [canon] of needing()) {
    for (const doc of (vendorDocs.get(canon) || []).filter((d) => !/payment/i.test(d.type)).sort(newestFirst)) {
      const need = -gap.get(canon);
      if (need <= 0.005) break;
      takeFrom(canon, doc, Math.min(doc.left, need));
    }
  }
  for (const [canon] of needing()) {
    for (const doc of (vendorDocs.get(canon) || []).filter((d) => /payment/i.test(d.type)).sort(newestFirst)) {
      const need = -gap.get(canon);
      if (need <= 0.005) break;
      if (doc.left > 0.005) takeFrom(canon, doc, Math.min(doc.left, need));
    }
  }

  // Whatever no document explains still belongs on the vendor, or its total
  // stops matching QuickBooks.
  for (const [canon, g] of gap) {
    if (Math.abs(g) <= 0.005) continue;
    items.push({ vendor: displayName.get(canon), date: asOf, amount: round2(g), type: 'Unapplied balance', ref: 'Unapplied balance' });
  }
  // A/P lines with no vendor (journal lines synced without their entity) are
  // kept so the total still ties to the ledger A/P, but under ONE row rather
  // than one row per memo; each still ages by its own date and shows in the
  // drill-down with its memo.
  for (const d of unattributed) {
    items.push({
      vendor: UNASSIGNED_VENDOR, date: d.date, amount: d.amount, total: d.amount,
      type: d.type, docNumber: d.ref,
      ref: [d.type, d.ref, d.name].filter(Boolean).join(' · '),
    });
  }
  return { billExtra, items };
}

// fetchUnallocatedVendorCredits and attachAsOfBillBalances are shared with the
// Vendor Balance Detail report so it shows the identical bill population and
// as-of reconstruction, and can never independently drift from AP Aging.
module.exports = { buildApAgingDetail, buildApAgingSummary, fetchUnallocatedVendorCredits, attachAsOfBillBalances };
