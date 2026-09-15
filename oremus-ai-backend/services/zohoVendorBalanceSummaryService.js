'use strict';

/**
 * Vendor Balance Summary — Zoho Books' "Vendor Balance Summary" layout.
 * ---------------------------------------------------------------------------
 *   Vendor Name | Billed Amount | Amount Paid | Closing Balance
 *
 * Unlike Vendor Balance Detail (a single as-of-date snapshot of open
 * documents), this is a date-RANGE report: Billed/Paid are the period's
 * activity, Closing Balance is each vendor's outstanding position as of the
 * period's end. Built entirely from the synced database — the Accounts
 * Payable control account (account_transactions) for Billed/Paid, and the
 * same bill-level as-of reconstruction Vendor Balance Detail / AP Aging use
 * for Closing Balance, so all three reports can never disagree for the same
 * as-of date. Provider-agnostic: pass the connection's org_id (Zoho org /
 * QBO realm / Xero tenant).
 *
 * Known, disclosed gap: a vendor advance/retainer not posted through a bill
 * (found empirically — one real vendor's live Zoho export showed a closing
 * balance with no corresponding bill or payment anywhere in our synced AP
 * ledger) won't be reflected here. Billed/Paid/Closing all foot correctly
 * for every vendor whose activity is bill-and-payment based, which is the
 * overwhelming majority; a vendor with an untracked advance will show
 * Closing Balance 0 here while the provider's own report may show a
 * nonzero figure for that one vendor.
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

// Default window: the fiscal year containing today, for the per-platform
// start month — same pattern as the other range reports (zohoForexService.js).
function resolveRange(params) {
  const from = params.from_date || params.from || null;
  const to = params.to_date || params.to || null;
  if (from && to) return { from, to };
  const { fyWindow, fyMonth } = require('./reportContext');
  const _fy = fyWindow(fyMonth(params.fy_start_month));
  return { from: from || _fy.from, to: to || _fy.to };
}

/**
 * Build the Vendor Balance Summary report.
 * @param {number} userId  effective user id (connection owner)
 * @param {object} params  { from_date, to_date, org_id }
 */
async function buildVendorBalanceSummary(userId, params = {}) {
  const orgId = params.org_id || (await getOrgId(userId));
  if (!orgId) {
    const err = new Error('Provider not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const { from, to } = resolveRange(params);
  const toDate = new Date(to);

  // Billed / Paid: the period's own activity, straight off the AP control
  // account. Billed = every credit (bills raised); Paid = every debit
  // (payments AND vendor credits applied — both clear what's owed, and
  // Zoho's own layout has no separate credits column).
  const [activity] = await pool.execute(
    `SELECT transaction_details AS vendor,
            SUM(CASE WHEN credit > 0 THEN credit ELSE 0 END) AS billed,
            SUM(CASE WHEN debit > 0 THEN debit ELSE 0 END) AS paid
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND account_type_code = 'accounts_payable'
        AND transaction_date BETWEEN ? AND ?
        AND transaction_id NOT LIKE 'xero-recon:%'
      GROUP BY vendor`,
    [userId, orgId, from, to]
  );

  // Closing Balance: each vendor's outstanding position as of the period's
  // end — same bill-level reconstruction as Vendor Balance Detail / AP
  // Aging, summed per vendor instead of listed per document.
  const [bills] = await pool.execute(
    `SELECT bill_number, vendor_name, date, total, balance, currency_code
       FROM bills
      WHERE user_id = ? AND org_id = ?
        AND LOWER(COALESCE(status, '')) NOT IN ('draft', 'submitted', 'void', 'voided', 'deleted')`,
    [userId, orgId]
  );
  await attachAsOfBillBalances(bills, userId, orgId, toDate);

  const currency = bills.find((r) => r.currency_code)?.currency_code || 'INR';

  const byVendor = new Map();
  const get = (name) => {
    const vendor = (name || '').trim() || 'Unknown';
    if (!byVendor.has(vendor)) byVendor.set(vendor, { billed: 0, paid: 0, closing: 0 });
    return byVendor.get(vendor);
  };

  for (const r of activity) {
    const v = get(r.vendor);
    v.billed += num(r.billed);
    v.paid += num(r.paid);
  }
  for (const bill of bills) {
    if (bill.date && new Date(bill.date) > toDate) continue; // didn't exist yet
    get(bill.vendor_name).closing += num(bill._balanceAsOf);
  }
  // Unapplied vendor credits reduce the closing balance, exactly as they do
  // in AP Aging / Vendor Balance Detail.
  for (const c of await fetchUnallocatedVendorCredits(userId, orgId, toDate)) {
    get(c.vendor).closing += num(c.amount);
  }

  const columns = [
    { key: 'vendor', label: 'Vendor Name',     align: 'left'  },
    { key: 'billed', label: 'Billed Amount',   align: 'right' },
    { key: 'paid',   label: 'Amount Paid',     align: 'right' },
    { key: 'closing', label: 'Closing Balance', align: 'right' },
  ];

  const rows = [];
  let grandBilled = 0, grandPaid = 0, grandClosing = 0;
  for (const vendor of [...byVendor.keys()].sort((a, b) => a.localeCompare(b))) {
    const v = byVendor.get(vendor);
    // Skip a vendor with zero activity in the period AND nothing outstanding
    // at the period end — nothing to show, same convention as Zoho's own
    // report, which still lists every vendor even at ₹0.00 (kept here too).
    rows.push({
      label: vendor,
      level: 1,
      cells: {
        billed: round2(v.billed),
        paid: round2(v.paid),
        closing: round2(v.closing),
      },
    });
    grandBilled += v.billed;
    grandPaid += v.paid;
    grandClosing += v.closing;
  }

  rows.push({
    label: 'TOTAL',
    isTotal: true,
    level: 0,
    cells: {
      billed: round2(grandBilled),
      paid: round2(grandPaid),
      closing: round2(grandClosing),
    },
  });

  return {
    columns,
    rows,
    currency,
    meta: {
      title: 'Vendor Balance Summary Report',
      from, to,
      source: 'warehouse',
    },
  };
}

module.exports = { buildVendorBalanceSummary };
