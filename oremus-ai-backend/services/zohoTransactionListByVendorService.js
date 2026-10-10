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
 * For Zoho and Xero the report follows Accounts Payable: every bill a vendor
 * raised and every payment or credit that cleared it, which is why "Account
 * full name" reads Accounts Payable throughout. "Item split account" is the
 * other side of the entry, left blank when the transaction splits across
 * several accounts. Amount is what the transaction did to Accounts Payable, so
 * bills read positive and the payments and credits that clear them read
 * negative — a vendor's total is therefore what is still outstanding from the
 * period, and the report's total is exactly the period's movement on Accounts
 * Payable. QuickBooks lists every transaction that names a vendor instead, on
 * the account the transaction books to (see the QuickBooks section below).
 *
 * Built entirely from `account_transactions` — the balanced double-entry ledger
 * all three platforms sync into — so the same code serves Zoho, QuickBooks and
 * Xero. Vendor names, document numbers and memos come from the vendor document
 * tables (bills, expenses, Zoho's vendor payments and credits, QuickBooks' bill
 * payments) where those exist; Xero's vendor credits have no document table of
 * their own, so their vendor is read off the ledger posting itself.
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

// ── QuickBooks Online ────────────────────────────────────────────────────────
// QBO's ledger is its GeneralLedger report (quickbooksService.syncGeneralLedger):
// one row per posting line, `transaction_details` holding the report's Name
// column (the line's memo when it has no name) and `memo` its Memo column.
// QuickBooks' own report lists every transaction that names a vendor, once,
// wherever it posts — not just what passed through Accounts Payable — against
// the account the transaction itself books to:
//  • Bill / Vendor Credit: its Accounts Payable account; amount = what it did
//    to A/P (bills +, credits −).
//  • Bill payments, checks, expenses, card charges and deposits: the bank or
//    card account paid from or deposited to; amount = that account's movement
//    (money out −, money in +), whatever the other side is (A/P included).
//  • Journal Entry: under the vendor named on a debit line, with account,
//    split and amount blank, as QuickBooks prints them.
//  • A bill payment is printed at its own total, in the payment's currency —
//    for a vendor billing in another currency that is not the bank line — and
//    one that only applied credits ($0, so absent from the ledger) is still
//    listed, with no account and its A/P account as the split.
// "Item split account" is the account of the one other line, blank when there
// are several (even on one account); realised exchange gains and losses, which
// QuickBooks posts itself, are not lines.
// Where QuickBooks' own record of the document is synced (bills, purchases,
// bill payments) its payee decides, and a purchase with no vendor payee is not
// listed. Otherwise the vendor is a line naming one exactly — checks, deposits
// and journals also name customers and employees, and vendors.contact_name is
// QuickBooks' DisplayName, which the ledger carries verbatim. Ledgers synced
// before memos were kept apart can hold a line's memo where its name belongs.
async function isQuickBooksOrg(orgId, platform) {
  if (platform) return platform === 'quickbooks';
  const [[r]] = await pool.execute('SELECT 1 AS x FROM qbo_organizations WHERE realm_id = ? LIMIT 1', [String(orgId)])
    .catch(() => [[null]]);
  return !!r;
}

const QBO_JOURNAL = 'journal entry';
const QBO_PAYABLE_DOCS = new Set(['bill', 'vendor credit']);
const QBO_BILL_PAYMENTS = new Set(['bill payment (check)', 'bill payment (credit card)']);
// Can only ever name a vendor.
const QBO_VENDOR_DOCS = new Set([...QBO_PAYABLE_DOCS, ...QBO_BILL_PAYMENTS]);
// Money in: booked as a debit to the bank or card account.
const QBO_MONEY_IN = new Set(['deposit', 'credit card credit']);
// QuickBooks "Purchase" transactions, which syncExpenses also stores.
const QBO_PURCHASES = new Set(['check', 'expense', 'cash expense', 'credit card expense', 'credit card credit']);
const PAYMENT_ACCOUNTS = new Set(['bank', 'credit_card']);
const isPayableLine = (l) => l.typeCode === 'accounts_payable';

// `memo` is added by the first QuickBooks ledger sync that needs it
// (quickbooksService.ensureLedgerMemoColumn). Lines synced before then have
// memo NULL, and only purchases have a memo to fall back to.
let ledgerMemo = false;
async function hasLedgerMemo() {
  if (!ledgerMemo) {
    const [[c]] = await pool.execute(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'account_transactions' AND COLUMN_NAME = 'memo'`
    ).catch(() => [[{ n: 0 }]]);
    ledgerMemo = Number(c?.n) > 0;
  }
  return ledgerMemo;
}

async function qboVendorNames(userId, orgId) {
  const [rows] = await pool.execute(
    `SELECT contact_name FROM vendors
      WHERE user_id = ? AND org_id = ? AND COALESCE(is_deleted, 0) = 0
        AND COALESCE(contact_name, '') <> ''`,
    [userId, orgId]
  );
  return new Set(rows.map((r) => String(r.contact_name).trim()));
}

// "Account full name" is the account number and fully qualified name; the split
// account is printed by its own name. An account missing from the chart keeps
// the ledger's name for both. `fx` marks the account QuickBooks posts realised
// exchange gains and losses to, which no transaction line names.
async function qboAccountNames(userId, orgId) {
  const [rows] = await pool.execute(
    `SELECT qbo_id, name, fully_qualified_name, account_number, account_sub_type
       FROM qbo_accounts WHERE user_id = ? AND realm_id = ?`,
    [userId, String(orgId)]
  ).catch(() => [[]]);
  const byId = new Map();
  for (const r of rows) {
    const name = String(r.name || '').trim();
    const full = String(r.fully_qualified_name || '').trim() || name;
    const number = String(r.account_number || '').trim();
    byId.set(String(r.qbo_id), {
      full: number ? `${number} ${full}` : full,
      name: name || full,
      fx: r.account_sub_type === 'ExchangeGainOrLoss',
    });
  }
  return byId;
}

// What the synced bills and purchases say that the ledger may not: who each is
// with, a bill's number as entered (the GeneralLedger report drops leading
// zeros, "77587" for "0077587") and a purchase's memo. Keyed `bill|id` and
// `purchase|id` on the QuickBooks id.
async function qboDocumentDetails(userId, orgId, from, to) {
  const scope = `user_id = ? AND org_id = ? AND COALESCE(is_deleted, 0) = 0 AND COALESCE(qbo_id, '') <> ''`;
  const [[bills], [purchases]] = await Promise.all([
    pool.execute(
      `SELECT qbo_id, vendor_name, bill_number FROM bills WHERE ${scope} AND date BETWEEN ? AND ?`,
      [userId, orgId, from, to]
    ),
    pool.execute(
      `SELECT qbo_id, vendor_name, description FROM expense_entries
        WHERE ${scope} AND COALESCE(expense_date, date) BETWEEN ? AND ?`,
      [userId, orgId, from, to]
    ),
  ]);
  const text = (v) => String(v || '').trim();
  const details = new Map();
  for (const b of bills) {
    details.set(`bill|${text(b.qbo_id)}`, { vendor: text(b.vendor_name), num: text(b.bill_number) });
  }
  for (const p of purchases) {
    details.set(`purchase|${text(p.qbo_id)}`, { vendor: text(p.vendor_name), memo: text(p.description) });
  }
  return details;
}

// QuickBooks' bill payments as entered (quickbooksService.syncApLinks): payee,
// number, kind, memo, total in the payment's own currency, and the documents
// each settled. Empty until a sync has given the table these columns; rows
// synced before then have no number, kind or memo.
async function qboBillPayments(orgId, from, to) {
  const [rows] = await pool.execute(
    `SELECT payment_id, payment_date, payment_total, vendor_name, doc_number, pay_type, memo, target_id
       FROM qbo_ap_links WHERE org_id = ? AND payment_date BETWEEN ? AND ?`,
    [String(orgId), from, to]
  ).catch(() => [[]]);
  const text = (v) => String(v || '').trim();
  const payments = new Map();
  for (const r of rows) {
    const id = text(r.payment_id);
    let p = payments.get(id);
    if (!p) {
      p = {
        id,
        type: r.pay_type === 'CreditCard' ? 'Bill Payment (Credit Card)' : 'Bill Payment (Check)',
        date: r.payment_date,
        total: num(r.payment_total),
        vendor: text(r.vendor_name),
        num: text(r.doc_number),
        memo: text(r.memo),
        targets: [],
      };
      payments.set(id, p);
    }
    if (text(r.target_id)) p.targets.push(text(r.target_id));
  }
  return payments;
}

// The Accounts Payable lines of the given documents, by document.
async function qboPayableLines(userId, orgId, ids) {
  if (!ids.length) return new Map();
  const [rows] = await pool.query(
    `SELECT DISTINCT source_id, account_id, account_name FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND account_type_code = 'accounts_payable' AND source_id IN (?)`,
    [userId, String(orgId), ids]
  );
  const byDoc = new Map();
  for (const r of rows) {
    const id = String(r.source_id).trim();
    if (!byDoc.has(id)) byDoc.set(id, []);
    byDoc.get(id).push({ accountId: String(r.account_id || ''), accountName: String(r.account_name || '').trim() });
  }
  return byDoc;
}

function qboDocuments(lines) {
  const docs = new Map();
  for (const l of lines) {
    const type = String(l.transaction_type || l.source_type || '').trim();
    const id = String(l.source_id).trim();
    const key = `${type}|${id}`;
    let d = docs.get(key);
    if (!d) {
      d = { id, type, date: l.transaction_date, ref: '', lines: [] };
      docs.set(key, d);
    }
    if (!d.ref) d.ref = String(l.reference_number || '').trim();
    d.lines.push({
      accountId: String(l.account_id || ''),
      accountName: String(l.account_name || '').trim(),
      typeCode: l.account_type_code || null,
      debit: num(l.debit),
      credit: num(l.credit),
      name: String(l.transaction_details || '').trim(),
      memo: l.memo == null ? null : String(l.memo).trim(),
    });
  }
  return docs;
}

// The posting line a transaction books its own amount on: A/P for bills and
// vendor credits, else the bank or card account on the transaction's own side
// (credited for money out, debited for money in), whatever else it touches.
function qboHeaderLine(doc) {
  const type = doc.type.toLowerCase();
  const size = (l) => Math.abs(l.debit - l.credit);
  const ownSide = QBO_MONEY_IN.has(type) ? (l) => l.debit > 0 : (l) => l.credit > 0;
  const isPayment = (l) => PAYMENT_ACCOUNTS.has(l.typeCode);
  const tests = [
    ...(QBO_PAYABLE_DOCS.has(type) ? [isPayableLine] : []),
    (l) => isPayment(l) && ownSide(l),
    isPayment,
    (l) => !isPayableLine(l) && ownSide(l),
    () => true,
  ];
  for (const test of tests) {
    const hit = doc.lines.filter(test);
    if (hit.length) return hit.reduce((a, b) => (size(b) > size(a) ? b : a));
  }
  return null;
}

// The document's own payee when QuickBooks' record of it is synced (a purchase
// only when that payee is a vendor); else a line naming a vendor exactly. A
// bill, credit or bill payment can only name a vendor, so its header's name
// counts as one once that line was synced with its memo apart (memo not NULL),
// which makes it a name rather than a memo.
function qboVendor(type, header, lines, own, vendors) {
  if (own) return own.vendor && (QBO_VENDOR_DOCS.has(type) || vendors.has(own.vendor)) ? own.vendor : null;
  const named = [header, ...lines].find((l) => l && vendors.has(l.name));
  if (named) return named.name;
  return QBO_VENDOR_DOCS.has(type) && header?.memo != null && header.name ? header.name : null;
}

function qboOwnRecord(type, id, { details, payments }) {
  if (type === 'bill') return details.get(`bill|${id}`);
  if (QBO_PURCHASES.has(type)) return details.get(`purchase|${id}`);
  if (QBO_BILL_PAYMENTS.has(type)) return payments.get(id);
  return null;
}

function qboEntry(doc, { vendors, accounts, details, payments }) {
  const type = doc.type.toLowerCase();
  const own = qboOwnRecord(type, doc.id, { details, payments });
  const base = {
    seq: Number.isFinite(Number(doc.id)) ? Number(doc.id) : null,
    date: String(doc.date).slice(0, 10),
    type: txnTypeLabel(doc.type),
    num: own?.num || doc.ref,
  };
  if (type === QBO_JOURNAL) {
    const line = doc.lines.find((l) => l.debit > 0 && vendors.has(l.name));
    return line ? { ...base, vendor: line.name, memo: line.memo ?? '', account: '', split: '', amount: null } : null;
  }
  const isBillPayment = QBO_BILL_PAYMENTS.has(type);
  let header = qboHeaderLine(doc);
  // A bill payment books to the bank or card account it was paid from; one
  // that only applied credits has none.
  if (isBillPayment && header && !PAYMENT_ACCOUNTS.has(header.typeCode)) header = null;
  if (!header && !isBillPayment) return null;
  const vendor = qboVendor(type, header, doc.lines, own, vendors);
  if (!vendor) return null;
  const label = (l) => accounts.get(l.accountId) || { full: l.accountName, name: l.accountName };
  const others = doc.lines.filter((l) => l.accountId !== header?.accountId && !accounts.get(l.accountId)?.fx);
  let amount = 0;
  if (isBillPayment && own) amount = -own.total;
  else if (header) amount = isPayableLine(header) ? header.credit - header.debit : header.debit - header.credit;
  return {
    ...base,
    vendor,
    memo: header?.memo ?? own?.memo ?? '',
    account: header ? label(header).full : '',
    split: others.length === 1 ? label(others[0]).name : '',
    amount: r2(amount) || 0,
  };
}

async function qboEntries(userId, orgId, from, to, lines) {
  const [vendors, accounts, details, payments] = await Promise.all([
    qboVendorNames(userId, orgId),
    qboAccountNames(userId, orgId),
    qboDocumentDetails(userId, orgId, from, to),
    qboBillPayments(orgId, from, to),
  ]);
  const docs = [...qboDocuments(lines).values()];
  // A payment that only applied credits moved no money, so the ledger has no
  // line for it; it stands on the A/P account of the documents it settled.
  const booked = new Set(docs.filter((d) => QBO_BILL_PAYMENTS.has(d.type.toLowerCase())).map((d) => d.id));
  const unbooked = [...payments.values()].filter((p) => !p.total && !booked.has(p.id));
  const payable = await qboPayableLines(userId, orgId, [...new Set(unbooked.flatMap((p) => p.targets))]);
  for (const p of unbooked) {
    const onAccount = new Map();
    for (const t of p.targets) {
      for (const a of payable.get(t) || []) {
        onAccount.set(a.accountId, { ...a, typeCode: 'accounts_payable', debit: 0, credit: 0, name: p.vendor, memo: null });
      }
    }
    docs.push({ id: p.id, type: p.type, date: p.date, ref: '', lines: [...onAccount.values()] });
  }
  const out = [];
  for (const doc of docs) {
    const e = qboEntry(doc, { vendors, accounts, details, payments });
    if (e) out.push(e);
  }
  return out;
}

// Zoho and Xero: what passed through Accounts Payable (see the header).
async function payableEntries(userId, orgId, from, to, lines) {
  const docs = await vendorDocuments(userId, orgId, from, to);

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
      if (!d.apName) d.apName = String(l.transaction_details || '').trim();
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
      // that is a name, not a memo.
      memo: doc?.memo || (d.details && d.details !== vendor ? d.details : ''),
      account: d.payableAccount,
      split: splits.length === 1 ? splits[0] : '',
      amount: r2(d.payable),
    });
  }
  return entries;
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
  const isQbo = await isQuickBooksOrg(orgId, platform);
  const withMemo = isQbo && (await hasLedgerMemo());

  const platClause = platform ? ' AND platform = ?' : '';
  const scope = platform ? [userId, orgId, platform] : [userId, orgId];
  const [lines] = await pool.execute(
    `SELECT source_id, source_type, transaction_type, transaction_date,
            account_id, account_name, account_type_code,
            COALESCE(base_debit, debit) AS debit, COALESCE(base_credit, credit) AS credit,
            transaction_details, reference_number${withMemo ? ', memo' : ''}
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?${platClause}
        AND transaction_date BETWEEN ? AND ?
        AND COALESCE(source_id, '') <> ''
      ORDER BY transaction_date, source_id, line_number`,
    [...scope, from, to]
  );

  const currency = await getBaseCurrency(orgId);
  const tracked1099 = await trackedContractors(userId, orgId);
  const entries = isQbo
    ? await qboEntries(userId, orgId, from, to, lines)
    : await payableEntries(userId, orgId, from, to, lines);

  entries.sort(
    (a, b) =>
      a.vendor.localeCompare(b.vendor, undefined, { sensitivity: 'base' }) ||
      String(a.date).localeCompare(String(b.date)) ||
      // QuickBooks lists a day's transactions in the order they were entered.
      (a.seq != null && b.seq != null ? a.seq - b.seq : 0) ||
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
    if (e.amount != null) {
      subtotal += e.amount;
      total += e.amount;
    }
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
