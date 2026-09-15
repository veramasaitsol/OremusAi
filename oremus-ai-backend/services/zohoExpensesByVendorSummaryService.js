'use strict';

/**
 * Expenses by Vendor Summary — modelled on QuickBooks' "Expenses by Vendor
 * Summary" (system report token VEND_EXP).
 * ---------------------------------------------------------------------------
 * One row per vendor with a single Total column (the money spent with that
 * vendor in the period), listed alphabetically, with a grand TOTAL footer:
 *
 *   Vendor Name | Total
 *
 * Accounting basis (QB's Cash/Accrual toggle, forwarded as accounting_basis):
 *   - Accrual (default) = expense RECOGNITION, read straight off the shared
 *                         ledger (`account_transactions`, account_group =
 *                         'expense') so it ties to the platform's own P&L
 *                         expense total exactly — not just the subset of
 *                         expense activity that has a bills/expenses document
 *                         row (QuickBooks in particular posts a lot of its
 *                         expense-account activity via plain Journal Entries
 *                         with no vendor document at all). Each ledger line is
 *                         attributed to a vendor via the bill/expense/vendor-
 *                         credit document it came from; anything the ledger
 *                         can't tie to a vendor document (mainly manual
 *                         journals) is grouped under "Not Specified", QB's own
 *                         label for unattributed activity.
 *   - Cash              = money PAID → zb_vendor_payments (bill payments) +
 *                         zb_expenses (direct spend).
 *
 * Data note: warehouse bills don't sync sub_total/tax_total (Zoho's bill LIST
 * omits them; only the DETAIL call carries them), so a bill's pre-tax amount
 * falls back to its total when sub_total is 0 — the expense portion ties out
 * exactly, the bill tax split is approximate until bill details are backfilled.
 */

const pool = require('../config/db');
const { getBaseCurrency } = require('./zohoChartOfAccountsService');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function getOrgId(userId) {
  const [[row]] = await pool.execute(
    'SELECT org_id FROM zb_tokens WHERE user_id = ?',
    [userId]
  );
  return row?.org_id || null;
}

// Vendor for every bill / expense / vendor-credit document in the window,
// keyed on the id the ledger stores in `source_id` — the same lookup pattern
// used by Transaction List by Vendor, so any platform's own document number
// resolves regardless of which one raised the ledger line.
async function vendorByDocId(userId, orgId, from, to) {
  const scope = 'user_id = ? AND org_id = ? AND COALESCE(is_deleted, 0) = 0 AND date BETWEEN ? AND ?';
  const args = [];
  const push = () => args.push(userId, orgId, from, to);

  let sql =
    `SELECT COALESCE(qbo_id, xero_id, zoho_id) AS pid, vendor_name
       FROM bills WHERE ${scope} AND COALESCE(vendor_name,'') <> ''`;
  push();
  sql +=
    ` UNION ALL
      SELECT COALESCE(qbo_id, xero_id, zoho_id) AS pid, vendor_name
        FROM expense_entries WHERE ${scope} AND COALESCE(vendor_name,'') <> ''`;
  push();
  sql +=
    ` UNION ALL
      SELECT zoho_vendor_credit_id AS pid, vendor_name
        FROM zb_vendor_credits WHERE ${scope} AND COALESCE(vendor_name,'') <> ''`;
  push();

  const [rows] = await pool.execute(sql, args);
  const byId = new Map();
  for (const r of rows) {
    const pid = String(r.pid || '').trim().toLowerCase();
    if (!pid) continue;
    byId.set(pid, String(r.vendor_name).trim());
  }
  return byId;
}

function resolveRange(params) {
  const from = params.from_date || params.from || null;
  const to = params.to_date || params.to || null;
  if (from && to) return { from, to };
  // Default window: the fiscal year containing today, for the per-platform
  // start month (Settings → params.fy_start_month; defaults to 4 = 1 April).
  const { fyWindow, fyMonth } = require('./reportContext');
  const _fy = fyWindow(fyMonth(params.fy_start_month));
  return { from: from || _fy.from, to: to || _fy.to };
}

// Sum a per-vendor amount from one source table into the running map.
async function accumulate(map, sql, args, sign) {
  const [rows] = await pool.execute(sql, args);
  for (const r of rows) {
    if (!r.vendor || String(r.vendor).trim() === '') continue;
    const key = String(r.vendor);
    map.set(key, round2((map.get(key) || 0) + sign * num(r.amt)));
  }
}

/**
 * Build the Expenses by Vendor Summary report.
 * @param {number} userId  effective Zoho user id (connection owner)
 * @param {object} params  { from_date, to_date, accounting_basis, org_id }
 */
async function buildExpensesByVendorSummary(userId, params = {}) {
  const orgId = params.org_id || (await getOrgId(userId));
  if (!orgId) {
    const err = new Error('Zoho not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const { from, to } = resolveRange(params);
  const base = [userId, orgId, from, to];
  const isCash = String(params.accounting_basis || params.basis || '').toLowerCase() === 'cash';
  const currency = await getBaseCurrency(orgId);

  const map = new Map();

  if (isCash) {
    // Cash basis = money paid out.
    await accumulate(map,
      `SELECT vendor_name AS vendor, SUM(amount) AS amt
         FROM zb_vendor_payments
        WHERE user_id = ? AND org_id = ? AND COALESCE(is_deleted, 0) = 0
          AND date BETWEEN ? AND ?
        GROUP BY vendor_name`, base, 1);
    await accumulate(map,
      `SELECT vendor_name AS vendor, SUM(total_without_tax) AS amt
         FROM expense_entries
        WHERE user_id = ? AND org_id = ? AND COALESCE(is_deleted, 0) = 0
          AND date BETWEEN ? AND ?
        GROUP BY vendor_name`, base, 1);
  } else {
    // Accrual basis = the ledger's own expense-account activity, so the total
    // ties to the platform's P&L expense total (not just the subset that has
    // a bills/expenses document row). transaction_date drives the window, not
    // the document's own `date` column, matching how the ledger recognises it.
    const [lines] = await pool.execute(
      `SELECT source_id, debit, credit
         FROM account_transactions
        WHERE user_id = ? AND org_id = ? AND account_group = 'expense'
          AND transaction_date BETWEEN ? AND ?
          AND transaction_id NOT LIKE 'xero-recon:%'`,
      base
    );
    const docs = await vendorByDocId(userId, orgId, from, to);
    for (const l of lines) {
      const key = String(l.source_id || '').trim().toLowerCase();
      const vendor = docs.get(key) || 'Not Specified';
      const amt = num(l.debit) - num(l.credit); // expense accounts run debit-normal
      map.set(vendor, round2((map.get(vendor) || 0) + amt));
    }
  }

  const vendors = [...map.entries()]
    .map(([name, amount]) => ({ name, amount: round2(amount) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const columns = [
    { key: 'label',  label: 'Vendor Name', align: 'left'  },
    { key: 'amount', label: 'Total',       align: 'right' },
  ];

  const rows = [];
  let grand = 0;
  for (const v of vendors) {
    rows.push({ label: v.name, level: 0, cells: { amount: v.amount } });
    grand += v.amount;
  }
  rows.push({ label: 'TOTAL', isTotal: true, level: 0, cells: { amount: round2(grand) } });

  return {
    columns,
    rows,
    currency,
    meta: {
      title: 'Expenses by Vendor Summary',
      from,
      to,
      basis: isCash ? 'Cash' : 'Accrual',
      source: isCash ? 'warehouse' : 'ledger',
    },
  };
}

module.exports = { buildExpensesByVendorSummary };
