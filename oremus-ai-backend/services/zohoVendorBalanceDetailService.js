'use strict';

/**
 * Vendor Balance Detail — QuickBooks' "Vendor Balance Detail Report" layout.
 * ---------------------------------------------------------------------------
 * Every open bill and unapplied vendor credit grouped under its vendor:
 *
 *   Date | Transaction type | Invoice | Due date | Amount | Balance
 *
 * "Balance" is each document's own open balance (what's still owed on it — a
 * part-paid bill shows less than its Amount). The former second Balance column
 * (the vendor's running accumulation) was removed; the vendor and grand totals
 * still carry the accumulated balance, which is the same sum.
 *
 * Built from the shared `bills` warehouse plus the GL's unapplied vendor
 * credits — the same population as the A/P Aging reports, so the grand TOTAL
 * always agrees with A/P Aging Detail/Summary. Provider-agnostic: pass the
 * connection's org_id (Zoho org / QBO realm / Xero tenant).
 */

const pool = require('../config/db');
const { fetchUnallocatedVendorCredits, attachAsOfBillBalances } = require('./zohoApAgingDetailService');

async function getOrgId(userId) {
  const [[row]] = await pool.execute('SELECT org_id FROM zb_tokens WHERE user_id = ?', [userId]);
  return row?.org_id || null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

// MM/DD/YYYY (the QuickBooks report layout's date format)
function fmtDateUS(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  return `${mm}/${dd}/${dt.getFullYear()}`;
}

// Point-in-time balances: honour the report's "To" date, then an explicit
// as_of_date, then today.
function resolveAsOf(params = {}) {
  const raw = params.as_of_date || params.to_date || params.date_end || null;
  const d = raw ? new Date(raw) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

// Optional "From" — the balance itself is still computed as of a single date
// (resolveAsOf above); From only narrows WHICH bills are considered, by issue
// date, mirroring AR Aging Summary's own optional From filter. `null` (no
// filter) reproduces the exact prior behaviour.
function resolveFrom(params = {}) {
  const raw = params.from_date || params.date_start || null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Build the Vendor Balance Detail report.
 * @param {number} userId  effective user id (connection owner)
 * @param {object} params  { as_of_date | to_date (as-of), org_id }
 */
async function buildVendorBalanceDetail(userId, params = {}) {
  const orgId = params.org_id || (await getOrgId(userId));
  if (!orgId) {
    const err = new Error('Provider not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const asOf = resolveAsOf(params);
  const fromDate = resolveFrom(params);

  // Same population as the A/P Aging reports: every issued bill (not just
  // currently-outstanding ones — attachAsOfBillBalances below reconstructs
  // the as-of balance the same way AP Aging does, so the two can never
  // disagree), non-payable statuses excluded across all three providers.
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
    { key: 'label',   label: 'Date',             align: 'left'  },
    { key: 'txnType', label: 'Transaction type', align: 'left'  },
    { key: 'invoice', label: 'Invoice',          align: 'left'  },
    { key: 'dueDate', label: 'Due date',         align: 'left'  },
    { key: 'amount',  label: 'Amount',           align: 'right' },
    { key: 'balance', label: 'Balance',          align: 'right' },
  ];

  // vendor → documents
  const byVendor = new Map();
  const push = (vendorName, doc) => {
    const vendor = (vendorName || '').trim() || 'Unknown';
    if (!byVendor.has(vendor)) byVendor.set(vendor, []);
    byVendor.get(vendor).push(doc);
  };

  for (const bill of bills) {
    // Point-in-time: a bill entered after the as-of date didn't exist yet.
    if (bill.date && new Date(bill.date) > asOf) continue;
    // Optional From: exclude bills issued before the selected start date.
    if (fromDate && bill.date && new Date(bill.date) < fromDate) continue;
    // Settled on/before the as-of date (per the ledger reconstruction) — not
    // outstanding, so it doesn't belong in a historical balance snapshot.
    if (num(bill._balanceAsOf) === 0) continue;
    push(bill.vendor_name, {
      date: bill.date,
      txnType: 'Bill',
      invoice: bill.bill_number || '',
      // A bill with no due date is due on receipt — show its own date, never blank
      // out the line (that's how QuickBooks prints it).
      dueDate: fmtDateUS(bill.due_date || bill.date),
      // Amount is what the bill was raised for; Balance is what's still open, so a
      // part-paid bill shows the two differently (QuickBooks' "Open Balance").
      amount: num(bill.total),
      balance: bill._balanceAsOf,
    });
  }

  // Unapplied vendor credits reduce what's owed. A credit note has no bill number
  // and no due date, so both cells print blank.
  for (const c of await fetchUnallocatedVendorCredits(userId, orgId, asOf)) {
    push(c.vendor, {
      date: c.date,
      txnType: 'Vendor Credit',
      invoice: '',
      dueDate: '',
      amount: c.amount,
      balance: c.amount,
    });
  }

  const rows = [];
  let grandAmount = 0;
  let grandBalance = 0;

  for (const vendor of [...byVendor.keys()].sort((a, b) => a.localeCompare(b))) {
    const docs = byVendor.get(vendor).sort((a, b) => new Date(a.date) - new Date(b.date));

    rows.push({ label: vendor, isHeader: true, level: 0, cells: {} });

    let running = 0;
    let vendorAmount = 0;
    for (const d of docs) {
      running += d.balance;
      vendorAmount += d.amount;
      rows.push({
        label: fmtDateUS(d.date),
        level: 1,
        cells: {
          txnType: d.txnType,
          invoice: d.invoice,
          dueDate: d.dueDate,
          amount: round2(d.amount),
          balance: round2(d.balance),
        },
      });
    }

    rows.push({
      label: `Total for ${vendor}`,
      isSubtotal: true,
      level: 0,
      cells: { amount: round2(vendorAmount), balance: round2(running) },
    });

    grandAmount += vendorAmount;
    grandBalance += running;
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
      title: 'Vendor Balance Detail Report',
      asOf: fmtDateUS(asOf),
      from: fromDate ? fmtDateUS(fromDate) : null,
      source: 'warehouse',
    },
  };
}

module.exports = { buildVendorBalanceDetail };
