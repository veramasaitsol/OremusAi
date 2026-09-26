'use strict';

/**
 * Transaction List by Vendor
 * ---------------------------------------------------------------------------
 * Everything a vendor owed and was paid, grouped under that vendor, in the
 * layout the platforms export:
 *
 *   Date | Track 1099 | Transaction type | Num | Posting (Y/N)
 *        | Memo | Account full name | Item split account | Amount
 *
 * The report follows Accounts Payable: every bill a vendor raised and every
 * payment or credit that cleared it, which is why "Account full name" reads
 * Accounts Payable throughout. "Item split account" is the other side of the
 * entry, left blank when the transaction splits across several accounts.
 * Amount is what the transaction did to Accounts Payable, so bills read
 * positive and the payments and credits that clear them read negative — a
 * vendor's total is therefore what is still outstanding from the period, and
 * the report's total is exactly the period's movement on Accounts Payable.
 *
 * Built entirely from `account_transactions` — the balanced double-entry ledger
 * all three platforms sync into — so the same code serves Zoho, QuickBooks and
 * Xero. Vendor names, document numbers and memos come from the vendor document
 * tables (bills, expenses, and Zoho's vendor payments and credits) where those
 * exist; QuickBooks' bill payments and Xero's vendor credits have no document
 * table of their own, so their vendor is read off the ledger posting itself.
 */

const pool = require('../config/db');
const { getBaseCurrency } = require('./zohoChartOfAccountsService');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (n) => Math.round(num(n) * 100) / 100;

async function resolveOrgId(userId, params) {
  if (params.org_id) return params.org_id;
  const [[row]] = await pool.execute('SELECT org_id FROM zb_tokens WHERE user_id = ?', [userId]);
  return row?.org_id || null;
}

function resolvePlatform(params) {
  return params.platform ? String(params.platform).toLowerCase() : null;
}

// Report window; defaults to the current Indian fiscal year, as the other
// transaction-level reports do.
function resolveRange(params) {
  const from = params.from_date || params.date_start || params.from || null;
  const to = params.to_date || params.date_end || params.to || null;
  if (from && to) return { from: String(from).slice(0, 10), to: String(to).slice(0, 10) };
  // Default window: the fiscal year containing today, for the per-platform
  // start month (Settings → params.fy_start_month; defaults to 4 = 1 April).
  const { fyWindow, fyMonth } = require('./reportContext');
  const _fy = fyWindow(fyMonth(params.fy_start_month));
  return { from: from || _fy.from, to: to || _fy.to };
}

// MM/DD/YYYY — the date format all three platforms print on this report.
function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return y && m && day ? `${m}/${day}/${y}` : String(d).slice(0, 10);
}

// Accounts Payable is where every credit purchase and the entries that clear
// it land, whatever each platform calls the rest of its chart.
const isPayable = (name) => String(name || '').trim().toLowerCase().startsWith('accounts payable');

// Each platform's own name for the kind of transaction. QuickBooks already
// records readable names ("Bill Payment (Check)"), so unknown values pass
// through untouched rather than being guessed at.
const TXN_TYPES = {
  bill: 'Bill',
  vendor_payment: 'Bill Payment',
  vendor_credit: 'Vendor Credit',
  expense: 'Expense',
  accpay: 'Bill',
  accpaycredit: 'Vendor Credit',
  bankspend: 'Spend Money',
  'bankspend-overpayment': 'Spend Money (Overpayment)',
  'bankspend-prepayment': 'Spend Money (Prepayment)',
  manualjournal: 'Manual Journal',
};
function txnTypeLabel(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (TXN_TYPES[key]) return TXN_TYPES[key];
  if (!key) return 'Transaction';
  // Snake-cased platform codes read as words; anything already readable stays.
  return key.includes('_')
    ? key.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : String(raw).trim();
}

/**
 * Vendor, document number and memo for every vendor document in the window,
 * keyed on the id the ledger stores in `source_id`. Zoho's vendor payment and
 * credit tables are only populated by the Zoho sync; the other platforms'
 * equivalents are recognised from the ledger instead.
 */
async function vendorDocuments(userId, orgId, from, to) {
  const scope = 'user_id = ? AND org_id = ? AND COALESCE(is_deleted, 0) = 0 AND date BETWEEN ? AND ?';
  const args = [];
  const push = () => args.push(userId, orgId, from, to);

  let sql =
    `SELECT COALESCE(qbo_id, xero_id, zoho_id) AS pid, vendor_name, date,
            bill_number AS num, notes AS memo
       FROM bills WHERE ${scope} AND COALESCE(vendor_name,'') <> ''`;
  push();
  sql +=
    ` UNION ALL
      SELECT COALESCE(qbo_id, xero_id, zoho_id) AS pid, vendor_name, date,
             reference_number AS num, description AS memo
        FROM expense_entries WHERE ${scope} AND COALESCE(vendor_name,'') <> ''`;
  push();
  sql +=
    ` UNION ALL
      SELECT zoho_vendor_payment_id AS pid, vendor_name, date,
             payment_number AS num, description AS memo
        FROM zb_vendor_payments WHERE ${scope} AND COALESCE(vendor_name,'') <> ''`;
  push();
  sql +=
    ` UNION ALL
      SELECT zoho_vendor_credit_id AS pid, vendor_name, date,
             vendor_credit_number AS num, notes AS memo
        FROM zb_vendor_credits WHERE ${scope} AND COALESCE(vendor_name,'') <> ''`;
  push();

  const [rows] = await pool.execute(sql, args);
  const byId = new Map();
  for (const r of rows) {
    const pid = String(r.pid || '').trim();
    if (!pid) continue;
    byId.set(pid.toLowerCase(), {
      vendor: String(r.vendor_name).trim(),
      date: r.date,
      num: String(r.num || '').trim(),
      memo: String(r.memo || '').trim(),
    });
  }
  return byId;
}

// The vendors QuickBooks flags "Track payments for 1099". Zoho and Xero have no
// such flag (they store NULL), so every vendor there reads "No".
async function trackedContractors(userId, orgId) {
  const [rows] = await pool.execute(
    `SELECT contact_name
       FROM vendors
      WHERE user_id = ? AND org_id = ? AND COALESCE(is_deleted, 0) = 0
        AND track_1099 = 1 AND COALESCE(contact_name, '') <> ''`,
    [userId, orgId]
  );
  return new Set(rows.map((r) => String(r.contact_name).trim().toLowerCase()));
}

async function buildTransactionListByVendor(userId, params = {}) {
  const orgId = await resolveOrgId(userId, params);
  if (!orgId) {
    const err = new Error('Not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const platform = resolvePlatform(params);
  const { from, to } = resolveRange(params);

  const platClause = platform ? ' AND platform = ?' : '';
  const scope = platform ? [userId, orgId, platform] : [userId, orgId];
  const [lines] = await pool.execute(
    `SELECT source_id, source_type, transaction_type, transaction_date,
            account_name, COALESCE(base_debit, debit) AS debit, COALESCE(base_credit, credit) AS credit,
            transaction_details, reference_number
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?${platClause}
        AND transaction_date BETWEEN ? AND ?
        AND COALESCE(source_id, '') <> ''
      ORDER BY transaction_date, source_id, line_number`,
    [...scope, from, to]
  );

  const docs = await vendorDocuments(userId, orgId, from, to);
  const currency = await getBaseCurrency(orgId);
  const tracked1099 = await trackedContractors(userId, orgId);

  // Fold the ledger's posting lines back into the documents they came from.
  const byDoc = new Map();
  for (const l of lines) {
    const key = String(l.source_id).trim().toLowerCase();
    let d = byDoc.get(key);
    if (!d) {
      d = {
        date: l.transaction_date,
        type: l.transaction_type || l.source_type,
        ref: String(l.reference_number || '').trim(),
        details: String(l.transaction_details || '').trim(),
        payable: 0,
        payableAccount: '',
        splits: new Set(),
      };
      byDoc.set(key, d);
    }
    const name = String(l.account_name || '').trim();
    if (isPayable(name)) {
      d.payableAccount = name;
      d.payable += num(l.credit) - num(l.debit);
    } else {
      d.splits.add(name);
    }
    if (!d.ref) d.ref = String(l.reference_number || '').trim();
  }

  const entries = [];
  for (const [key, d] of byDoc) {
    // Only what passed through Accounts Payable is a vendor's transaction.
    if (!d.payableAccount) continue;
    const doc = docs.get(key);
    const vendor = doc?.vendor || d.details;
    if (!vendor) continue;

    const splits = [...d.splits].filter(Boolean);
    entries.push({
      vendor,
      date: doc?.date || d.date,
      type: txnTypeLabel(d.type),
      num: doc?.num || d.ref || '',
      // Zoho and Xero record the vendor's name against every posting line, so
      // that is a name, not a memo; QuickBooks records the real memo there.
      memo: doc?.memo || (d.details && d.details !== vendor ? d.details : ''),
      account: d.payableAccount,
      split: splits.length === 1 ? splits[0] : '',
      amount: r2(d.payable),
    });
  }

  entries.sort(
    (a, b) =>
      a.vendor.localeCompare(b.vendor, undefined, { sensitivity: 'base' }) ||
      String(a.date).localeCompare(String(b.date)) ||
      a.type.localeCompare(b.type) ||
      a.num.localeCompare(b.num)
  );

  const columns = [
    { key: 'label',   label: 'Date',               align: 'left'  },
    { key: 'track',   label: 'Track 1099',         align: 'left'  },
    { key: 'type',    label: 'Transaction type',   align: 'left'  },
    { key: 'num',     label: 'Num',                align: 'left'  },
    { key: 'posting', label: 'Posting (Y/N)',      align: 'left'  },
    { key: 'memo',    label: 'Memo',               align: 'left'  },
    { key: 'account', label: 'Account full name',  align: 'left'  },
    { key: 'split',   label: 'Item split account', align: 'left'  },
    { key: 'amount',  label: 'Amount',             align: 'right' },
  ];

  const rows = [];
  let vendor = null;
  let subtotal = 0;
  let total = 0;

  const closeVendor = () => {
    if (vendor === null) return;
    rows.push({
      label: `Total for ${vendor}`,
      isSubtotal: true,
      level: 0,
      cells: { amount: r2(subtotal) },
    });
  };

  for (const e of entries) {
    if (e.vendor !== vendor) {
      closeVendor();
      vendor = e.vendor;
      subtotal = 0;
      rows.push({ label: vendor, isHeader: true, level: 0, cells: {} });
    }
    rows.push({
      label: fmtDate(e.date),
      level: 1,
      cells: {
        track: tracked1099.has(e.vendor.trim().toLowerCase()) ? 'Yes' : 'No',
        type: e.type,
        num: e.num,
        posting: 'Yes',
        memo: e.memo,
        account: e.account,
        split: e.split,
        amount: e.amount,
      },
    });
    subtotal += e.amount;
    total += e.amount;
  }
  closeVendor();

  rows.push({ label: 'TOTAL', isTotal: true, level: 0, cells: { amount: r2(total) } });

  return {
    columns,
    rows,
    currency,
    meta: { title: 'Transaction List by Vendor', from, to, basis: 'Accrual', source: 'ledger' },
  };
}

module.exports = { buildTransactionListByVendor };
