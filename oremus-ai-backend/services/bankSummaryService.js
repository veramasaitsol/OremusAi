'use strict';

/**
 * Bank Summary — built from OUR general ledger (account_transactions), NOT a
 * live provider Reports API. Provider-agnostic: reads the balanced double-entry
 * ledger scoped by (user_id, org_id) — passing a Xero tenant_id as org_id runs
 * it off the Xero ledger exactly like the Zoho builders.
 *
 * For every cash/bank account it computes, over the requested window:
 *   Opening Balance = Σ(debit − credit) for postings BEFORE the from date
 *   Cash Received   = Σ(debit)  within the window
 *   Cash Spent      = Σ(credit) within the window
 *   Closing Balance = Opening + Received − Spent
 *
 * Returns the { columns, rows, currency } shape the report viewer renders, plus
 * the { _noLocalData: true } sentinel when the org has no cash accounts synced,
 * so the caller can fall back to a live report with no empty screen.
 */

const pool = require('../config/db');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function r2(n) {
  return Math.round(num(n) * 100) / 100;
}

// Explicit org (switcher) wins, else the connection's primary Zoho org.
async function resolveOrgId(userId, params) {
  if (params.org_id) return params.org_id;
  const [[row]] = await pool.execute(
    'SELECT org_id FROM zb_tokens WHERE user_id = ?',
    [userId]
  );
  return row?.org_id || null;
}

// Reporting window (default: current Indian fiscal year).
function resolveRange(params) {
  const to = params.to_date || params.date_end || null;
  const from = params.from_date || params.date_start || null;
  if (from && to) return { from, to };
  // Default window: the fiscal year containing today, for the per-platform
  // start month (Settings → params.fy_start_month; defaults to 4 = 1 April).
  const { fyWindow, fyMonth } = require('./reportContext');
  const _fy = fyWindow(fyMonth(params.fy_start_month));
  return { from: from || _fy.from, to: to || _fy.to };
}

const NO_LOCAL = { _noLocalData: true };

// Cash accounts in the ledger: account_type_code bank/cash (normalized to the
// shared Zoho vocabulary at promotion time).
const CASH_TYPES = ['bank', 'cash'];

async function buildBankSummary(userId, params = {}) {
  const orgId = await resolveOrgId(userId, params);
  if (!orgId) return NO_LOCAL;

  const { from, to } = resolveRange(params);
  const placeholders = CASH_TYPES.map(() => '?').join(',');

  // One pass per account: opening (before `from`) + in-window received/spent.
  // Received/Spent exclude Xero Trial-Balance true-up rows ('xero-recon:%')
  // because those are a cumulative balance-sheet plug, not real cash movement
  // (else a bank shows a giant fake receipt). Their net is captured separately
  // (recon_net) and added back into the Closing balance so it still ties to
  // Xero. Opening keeps them (it's a balance). No-op for Zoho/QuickBooks.
  const [rows] = await pool.execute(
    `SELECT account_id,
            MAX(account_name) AS account_name,
            SUM(CASE WHEN transaction_date <  ? THEN COALESCE(base_debit, debit) - COALESCE(base_credit, credit) ELSE 0 END) AS opening,
            SUM(CASE WHEN transaction_date >= ? AND transaction_date <= ? AND transaction_id NOT LIKE 'xero-recon:%' THEN COALESCE(base_debit, debit)  ELSE 0 END) AS received,
            SUM(CASE WHEN transaction_date >= ? AND transaction_date <= ? AND transaction_id NOT LIKE 'xero-recon:%' THEN COALESCE(base_credit, credit) ELSE 0 END) AS spent,
            SUM(CASE WHEN transaction_date >= ? AND transaction_date <= ? AND transaction_id LIKE 'xero-recon:%' THEN COALESCE(base_debit, debit) - COALESCE(base_credit, credit) ELSE 0 END) AS recon_net
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND LOWER(account_type_code) IN (${placeholders})
        AND account_id <> 'XERO-CLEARING'
        AND account_name NOT LIKE '%Xero Payments Clearing%'
      GROUP BY account_id
      ORDER BY account_name`,
    [from, from, to, from, to, from, to, userId, orgId, ...CASH_TYPES]
  );

  if (!rows.length) return NO_LOCAL;

  const columns = [
    { key: 'label',   label: 'Bank Account',    align: 'left'  },
    { key: 'opening', label: 'Opening Balance', align: 'right' },
    { key: 'received', label: 'Cash Received',  align: 'right' },
    { key: 'spent',   label: 'Cash Spent',      align: 'right' },
    { key: 'closing', label: 'Closing Balance', align: 'right' },
  ];

  const totals = { opening: 0, received: 0, spent: 0, closing: 0 };
  const dataRows = rows.map((r) => {
    const opening = r2(r.opening);
    const received = r2(r.received);
    const spent = r2(r.spent);
    // recon_net (Xero true-up) is excluded from received/spent but belongs in
    // the closing balance so it still ties to Xero.
    const closing = r2(opening + received - spent + r2(r.recon_net));
    totals.opening += opening;
    totals.received += received;
    totals.spent += spent;
    totals.closing += closing;
    return {
      label: r.account_name || 'Unnamed Account',
      opening,
      received,
      spent,
      closing,
    };
  });

  dataRows.push({
    label: 'Total',
    opening: r2(totals.opening),
    received: r2(totals.received),
    spent: r2(totals.spent),
    closing: r2(totals.closing),
    isSubtotal: true,
  });

  return {
    columns,
    rows: dataRows,
    currency: 'INR',
    meta: { source: 'ledger', from, to },
  };
}

module.exports = { buildBankSummary };
