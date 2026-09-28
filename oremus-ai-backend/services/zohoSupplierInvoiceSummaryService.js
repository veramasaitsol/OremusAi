'use strict';

/**
 * Supplier Invoice Summary — Xero's "Payable Invoice Summary" layout.
 * ---------------------------------------------------------------------------
 * One row per supplier bill AND supplier credit note in the period, oldest
 * first, with a grand Total footer:
 *
 *   Invoice Date | Vendor Name | Reference | Due Date | Payable | Balance
 *
 * PROVIDER-AGNOSTIC: reads the shared `account_transactions` ledger (ACCPAY /
 * ACCPAYCREDIT entries) for bill amounts and vendor names, LEFT JOINing the
 * `bills` warehouse for the due date (which is not stored in the GL).  This
 * makes the report work for Zoho, QuickBooks, and Xero without platform-
 * specific code — only the data differs.  When `bills` is empty (a connection
 * that hasn't synced its bill metadata yet) the report still renders with the
 * due-date column blank rather than showing "no data".
 *
 * Credit notes come from ACCPAYCREDIT entries in the GL (already handled by
 * `fetchPayableCreditNotes`).  Their unapplied balance is derived per vendor
 * from the Accounts Payable ledger balance, same as before.
 */

const pool = require('../config/db');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Resolve org_id from any platform's token table.
async function resolveOrgId(userId, paramsOrgId) {
  if (paramsOrgId) return paramsOrgId;
  const [[zoho]] = await pool.execute(
    'SELECT org_id FROM zb_tokens WHERE user_id = ? LIMIT 1', [userId]
  );
  if (zoho?.org_id) return zoho.org_id;
  const [[xero]] = await pool.execute(
    'SELECT tenant_id AS org_id FROM xero_tokens WHERE user_id = ? LIMIT 1', [userId]
  );
  if (xero?.org_id) return xero.org_id;
  const [[qbo]] = await pool.execute(
    'SELECT realm_id AS org_id FROM qbo_tokens WHERE user_id = ? LIMIT 1', [userId]
  );
  return qbo?.org_id || null;
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ymd(d) {
  if (!d) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const dt = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function fmtDate(d) {
  const iso = ymd(d);
  if (!iso) return '';
  const [y, m, dd] = iso.split('-');
  return `${dd} ${MONTHS[Number(m) - 1]} ${y}`;
}

/**
 * Supplier credit notes raised in the period, from the GL's
 * Accounts Payable control lines (ACCPAYCREDIT).
 */
async function fetchPayableCreditNotes(userId, orgId, from, to) {
  const [lines] = await pool.execute(
    `SELECT transaction_details AS vendor, source_id, source_type,
            MIN(transaction_date) AS doc_date,
            MAX(reference_number) AS reference,
            SUM(COALESCE(base_credit, credit)) - SUM(COALESCE(base_debit, debit)) AS net
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND account_type_code = 'accounts_payable'
        AND transaction_date <= ?
        AND transaction_id NOT LIKE 'xero-recon:%'
      GROUP BY vendor, source_id, source_type`,
    [userId, orgId, `${to} 23:59:59`]
  );

  const byVendor = new Map();
  for (const ln of lines) {
    const vendor = (ln.vendor || '').trim();
    if (!vendor) continue;
    if (!byVendor.has(vendor)) byVendor.set(vendor, { net: 0, credits: [] });
    const v = byVendor.get(vendor);
    v.net += num(ln.net);
    if (/CREDIT/i.test(ln.source_type || '') && num(ln.net) < 0) {
      v.credits.push({
        vendor,
        date: ln.doc_date,
        reference: ln.reference || '',
        gross: round2(num(ln.net)),
        balance: 0,
      });
    }
  }

  const out = [];
  for (const v of byVendor.values()) {
    if (!v.credits.length) continue;
    v.credits.sort((a, b) => new Date(b.date) - new Date(a.date));
    let unapplied = round2(-v.net);
    for (const c of v.credits) {
      if (unapplied > 0.005) {
        const take = Math.min(unapplied, -c.gross);
        c.balance = -round2(take);
        unapplied = round2(unapplied - take);
      }
      const d = ymd(c.date);
      if (d >= from && d <= to) out.push(c);
    }
  }
  return out;
}

/**
 * As-of-date outstanding balance per supplier bill, rebuilt from the shared
 * Accounts Payable ledger.
 *
 * The `bills` warehouse only stores each bill's LIVE balance — 0 once the bill
 * is finally settled — so a bill paid AFTER the report's `to` date wrongly
 * showed as fully paid. Every platform's own Payable Invoice Summary reports the
 * balance the document carried ON the report end date.
 *
 * Method — a standard AP sub-ledger reconstruction, per vendor, using only
 * postings dated on/before `to`:
 *   1. Each bill starts at its own net: its credit (raised) minus any debits
 *      posted to the SAME ledger transaction (Xero keeps a bill's payments on
 *      the bill's own transaction id; QuickBooks / Zoho post them separately so
 *      the bill stays at gross here and step 3 handles it).
 *   2. Credit notes are applied to the vendor's bills — first to a bill sharing
 *      the credit note's reference, then to a bill whose remaining balance
 *      exactly equals the credit, then oldest bill first.
 *   3. The vendor's true balance as of `to` is Σ credits − Σ debits over every
 *      AP line. Any excess of the bills' running total over that (unlinked
 *      payments) is trimmed oldest bill first (FIFO — oldest debts clear first).
 * Returns a Map keyed by `<vendor lower>|ref:<reference lower>` and
 * `<vendor lower>|txn:<transaction_id>` → balance (≥ 0).
 */
async function apBalancesAsOf(userId, orgId, to) {
  const [rows] = await pool.execute(
    `SELECT transaction_details AS vendor,
            transaction_id AS txn,
            MIN(transaction_date) AS first_date,
            MAX(NULLIF(reference_number, '')) AS ref,
            MAX(CASE WHEN source_type LIKE '%CREDIT%' OR transaction_type LIKE '%Credit%'
                     THEN 1 ELSE 0 END) AS is_credit,
            ROUND(SUM(COALESCE(base_credit, credit)), 2) AS cr,
            ROUND(SUM(COALESCE(base_debit, debit)), 2) AS dr
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND account_type_code = 'accounts_payable'
        AND transaction_date <= ?
        AND transaction_id NOT LIKE 'xero-recon:%'
      GROUP BY vendor, txn`,
    [userId, orgId, `${to} 23:59:59`]
  );

  const perVendor = new Map();
  for (const r of rows) {
    const v = (r.vendor || '').trim();
    if (!v) continue;
    if (!perVendor.has(v)) perVendor.set(v, { bills: [], credits: [], owed: 0 });
    const pv = perVendor.get(v);
    pv.owed = round2(pv.owed + num(r.cr) - num(r.dr));
    const ref = (r.ref || '').trim().toLowerCase();
    if (r.is_credit && num(r.dr) > 0.005) {
      pv.credits.push({ ref, amt: round2(num(r.dr)), date: ymd(r.first_date) });
    } else if (num(r.cr) > 0) {
      pv.bills.push({
        txn: r.txn,
        ref,
        date: ymd(r.first_date),
        gross: round2(num(r.cr)),
        bal: Math.max(0, round2(num(r.cr) - num(r.dr))),
      });
    }
  }

  const balByKey = new Map();
  for (const [v, pv] of perVendor) {
    const byDateAsc = (a, b) => String(a.date).localeCompare(String(b.date));
    pv.bills.sort(byDateAsc);
    pv.credits.sort(byDateAsc);
    const reduce = (bill, amt) => {
      const t = round2(Math.min(bill.bal, amt));
      bill.bal = round2(bill.bal - t);
      return t;
    };

    // 2) apply credit notes
    for (const c of pv.credits) {
      let left = c.amt;
      if (left > 0.005 && c.ref) {
        for (const b of pv.bills) {
          if (b.ref === c.ref && b.bal > 0.005) left = round2(left - reduce(b, left));
          if (left <= 0.005) break;
        }
      }
      if (left > 0.005) {
        const exact = pv.bills.find((b) => b.bal > 0.005 && Math.abs(b.bal - left) < 0.02);
        if (exact) left = round2(left - reduce(exact, left));
      }
      for (const b of pv.bills) {
        if (left <= 0.005) break;
        if (b.bal > 0.005) left = round2(left - reduce(b, left));
      }
    }

    // 3) trim any excess over the vendor's true as-of balance (unlinked payments)
    let excess = round2(pv.bills.reduce((s, b) => s + b.bal, 0) - Math.max(0, pv.owed));
    for (const b of pv.bills) {
      if (excess <= 0.005) break;
      const t = round2(Math.min(b.bal, excess));
      b.bal = round2(b.bal - t);
      excess = round2(excess - t);
    }

    const vl = v.toLowerCase();
    for (const b of pv.bills) {
      balByKey.set(`${vl}|txn:${b.txn}`, b.bal);
      if (b.ref) balByKey.set(`${vl}|ref:${b.ref}`, b.bal);
    }
  }
  return balByKey;
}

async function buildSupplierInvoiceSummary(userId, params = {}) {
  const orgId = await resolveOrgId(userId, params.org_id);
  if (!orgId) {
    const err = new Error('Provider not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const { from, to } = resolveRange(params);

  // ── Primary source: the shared `bills` warehouse ──
  // Zoho, QuickBooks and Xero sync ALL populate this table (keyed by org_id),
  // so one query serves every platform and carries the invoice total, the
  // outstanding balance and the due date directly. The previous version read
  // `account_transactions` filtered by `source_type IN ('ACCPAY')` — a
  // Xero-only tag — so Zoho and QuickBooks returned nothing.
  const [billRows] = await pool.execute(
    `SELECT bill_number, reference_number, vendor_name, date, due_date,
            total, balance, currency_code
       FROM bills
      WHERE user_id = ? AND org_id = ? AND COALESCE(is_deleted, 0) = 0
        AND date BETWEEN ? AND ?
      ORDER BY date ASC, vendor_name ASC`,
    [userId, orgId, from, to]
  );

  let bills = billRows.map((b) => ({
    bill_number: b.bill_number || b.reference_number || '',
    vendor_name: b.vendor_name,
    date: b.date,
    total: num(b.total),
    due_date: b.due_date || null,
    balance: b.balance != null ? num(b.balance) : null,
    currency_code: b.currency_code,
  }));

  // ── Fallback: the org has no synced bill metadata — reconstruct from the
  // Accounts Payable ledger. Matches every platform's tagging (Xero 'ACCPAY',
  // Zoho/QuickBooks 'Bill', …) instead of Xero-only, keyed off the AP account.
  if (bills.length === 0) {
    const [txnBills] = await pool.execute(
      `SELECT COALESCE(NULLIF(at.reference_number, ''), CONCAT('src:', at.source_id)) AS bill_number,
              at.transaction_details AS vendor_name,
              MIN(at.transaction_date) AS date,
              ROUND(SUM(CASE WHEN at.credit > 0 THEN COALESCE(at.base_credit, at.credit) ELSE 0 END), 2) AS total,
              COALESCE(at.base_currency_code, at.currency_code) AS currency_code
         FROM account_transactions at
        WHERE at.user_id = ? AND org_id = ?
          AND at.account_type_code = 'accounts_payable'
          AND at.transaction_date BETWEEN ? AND ?
          AND at.transaction_id NOT LIKE 'xero-recon:%'
          AND ( UPPER(COALESCE(at.source_type, '')) IN ('ACCPAY', 'BILL', 'BILLPAYABLE', 'VENDORBILL', 'SUPPLIERBILL')
                OR at.transaction_type IN ('Bill', 'Vendor Bill', 'Supplier Bill') )
          AND at.credit > 0
        GROUP BY bill_number, at.transaction_details, at.currency_code, at.base_currency_code
        ORDER BY date ASC, vendor_name ASC`,
      [userId, orgId, from, to]
    );
    bills = txnBills.map((t) => ({
      bill_number: t.bill_number,
      vendor_name: t.vendor_name,
      date: t.date,
      total: num(t.total),
      due_date: null,
      balance: null,
      currency_code: t.currency_code,
    }));
  }

  const currency = bills.find((b) => b.currency_code)?.currency_code || 'INR';

  const columns = [
    { key: 'label',       label: 'Invoice Date', align: 'left'  },
    { key: 'vendor',      label: 'Vendor Name',  align: 'left'  },
    { key: 'reference',   label: 'Reference',    align: 'left'  },
    { key: 'dueDate',     label: 'Due Date',     align: 'left'  },
    { key: 'payable',     label: 'Payable',      align: 'right' },
    { key: 'balance',     label: 'Balance',      align: 'right' },
  ];

  // As-of-`to` balance per bill from the AP ledger — the `bills` warehouse only
  // keeps the LIVE balance, which is wrong for a bill settled after `to`.
  const asOfBal = await apBalancesAsOf(userId, orgId, to);

  const docs = bills.map((b) => {
    const payable = num(b.total);
    const vl = String(b.vendor_name || '').toLowerCase();
    const ref = String(b.bill_number || '').trim().toLowerCase();
    // Prefer the reconstructed as-of balance; fall back to the warehouse's live
    // balance only when the bill can't be matched in the ledger.
    let balance;
    if (ref && asOfBal.has(`${vl}|ref:${ref}`)) balance = asOfBal.get(`${vl}|ref:${ref}`);
    else if (b.balance != null) balance = round2(b.balance);
    else balance = null;
    return {
      date: b.date,
      vendor: b.vendor_name || '(No supplier)',
      source: 'Payable Invoice',
      reference: b.bill_number || '',
      dueDate: fmtDate(b.due_date),
      payable,
      balance,
    };
  });

  // Add credit notes from GL
  for (const c of await fetchPayableCreditNotes(userId, orgId, from, to)) {
    docs.push({
      date: c.date,
      vendor: c.vendor,
      source: 'Payable Credit Note',
      reference: c.reference,
      dueDate: '',
      payable: c.gross,
      balance: c.balance,
    });
  }

  const sourceRank = (d) => (d.source === 'Payable Invoice' ? 0 : 1);
  docs.sort((a, b) => ymd(a.date).localeCompare(ymd(b.date))
                   || sourceRank(a) - sourceRank(b)
                   || String(a.vendor).localeCompare(String(b.vendor)));

  const rows = [];
  const grand = { payable: 0, balance: 0 };

  for (const d of docs) {
    rows.push({
      label: fmtDate(d.date),
      level: 0,
      cells: {
        vendor: d.vendor,
        reference: d.reference,
        dueDate: d.dueDate,
        payable: round2(d.payable),
        balance: d.balance != null ? round2(d.balance) : '',
      },
    });

    grand.payable += d.payable;
    if (d.balance != null) grand.balance += d.balance;
  }

  rows.push({
    label: 'Total',
    isTotal: true,
    level: 0,
    cells: {
      payable: round2(grand.payable),
      balance: round2(grand.balance),
    },
  });

  return {
    columns,
    rows,
    currency,
    meta: { title: 'Payable Invoice Summary', from, to, source: 'ledger' },
  };
}

module.exports = { buildSupplierInvoiceSummary };
