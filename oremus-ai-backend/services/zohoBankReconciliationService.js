'use strict';

/**
 * Bank Reconciliation
 * ---------------------------------------------------------------------------
 * The classic bank reconciliation statement, in the shape Zoho Books and Xero
 * print it: for each bank account, start from the bank statement balance, add
 * the entries the books have made but the statement has not shown yet, take
 * away the statement lines the books have not recorded, and arrive at the book
 * balance.
 *
 *   Balance as per Bank Statement as of <date>
 *   Add: Book Entries Not on the Statement        (Xero's un-presented items)
 *   Less: Statement Lines Not in the Books        (Xero's un-reconciled lines)
 *   Balance as per Books as of <date>
 *
 * Each reconciling figure is then itemised underneath, the way Xero lists its
 * un-presented cheques and un-reconciled statement lines, so every number can
 * be traced to the transactions behind it.
 *
 * The statement side is `bank_transactions` (the synced bank feed) and the book
 * side is `account_transactions` (the general ledger), which all three
 * platforms populate, so one builder serves Zoho, QuickBooks and Xero. An
 * entry counts as reconciled when the feed line and the ledger posting carry
 * the same transaction id on the same bank account.
 *
 * Balances are as at the To date rather than for the window: a reconciliation
 * is a statement of position, so every posting up to that date counts.
 */

const pool = require('../config/db');
const { getBaseCurrency } = require('./zohoChartOfAccountsService');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (n) => Math.round(num(n) * 100) / 100;

// Bank names differ in punctuation between a platform's feed and its ledger
// ("HDFC Bank - 502..." vs "HDFC Bank 502..."), so names are compared on their
// letters and digits alone.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function resolveOrgId(userId, params) {
  if (params.org_id) return params.org_id;
  const [[row]] = await pool.execute('SELECT org_id FROM zb_tokens WHERE user_id = ?', [userId]);
  return row?.org_id || null;
}

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

// MM/DD/YYYY, the date format these reports print.
function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return y && m && day ? `${m}/${day}/${y}` : String(d).slice(0, 10);
}

// Each platform's own vocabulary → the label it prints.
const TYPE_LABEL = {
  invoice: 'Invoice', bill: 'Bill', expense: 'Expense', journal: 'Journal Entry',
  customer_payment: 'Payment', vendor_payment: 'Bill Payment',
  credit_note: 'Credit Note', vendor_credit: 'Vendor Credit',
  transfer_fund: 'Transfer', card_payment: 'Card Payment',
  ACCREC: 'Invoice', ACCPAY: 'Bill',
  ACCRECCREDIT: 'Credit Note', ACCPAYCREDIT: 'Vendor Credit',
  BankSPEND: 'Spend Money', BankRECEIVE: 'Receive Money',
  'BankSPEND-OVERPAYMENT': 'Spend Money', 'BankRECEIVE-OVERPAYMENT': 'Receive Money',
  'BankSPEND-PREPAYMENT': 'Spend Money', 'BankRECEIVE-PREPAYMENT': 'Receive Money',
  ManualJournal: 'Journal Entry',
};

function typeLabel(raw) {
  if (!raw) return '';
  if (TYPE_LABEL[raw]) return TYPE_LABEL[raw];
  if (!String(raw).includes('_')) return String(raw);
  return String(raw).split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// The document reference the platform prints. Zoho keeps it in
// transaction_number, QuickBooks numbers the document in reference_number, and
// a "reference" that merely repeats the narration is a description, not a
// reference.
function docRef(row) {
  const plat = String(row.platform || '').toLowerCase();
  const ref = (row.reference_number || '').trim();
  const seq = (row.transaction_number || '').trim();
  const candidate = plat === 'zoho'
    ? (seq && seq !== '0' ? seq : ref)
    : (ref || (seq !== '0' ? seq : ''));
  const desc = (row.transaction_details || '').trim();
  if (!candidate || candidate.length > 40) return '';
  return desc.startsWith(candidate) ? '' : candidate;
}

/**
 * Contact name per source document. The ledger records which document a
 * posting came from but not who it was with, so the name is read back off the
 * synced documents, matched on whichever platform id the ledger row carries.
 */
async function nameMap(userId, orgId) {
  const map = new Map();
  const add = (rows) => {
    for (const r of rows) {
      if (!r.n) continue;
      for (const id of [r.a, r.b, r.c]) if (id) map.set(String(id).toLowerCase(), r.n);
    }
  };
  const q = async (sql) => {
    try {
      const [rows] = await pool.execute(sql, [userId, orgId]);
      return rows;
    } catch { return []; }
  };
  add(await q(`SELECT zoho_id AS a, qbo_id AS b, xero_id AS c, customer_name AS n
                 FROM invoices WHERE user_id = ? AND org_id = ?`));
  add(await q(`SELECT zoho_id AS a, qbo_id AS b, xero_id AS c, vendor_name AS n
                 FROM bills WHERE user_id = ? AND org_id = ?`));
  add(await q(`SELECT zoho_id AS a, qbo_id AS b, xero_id AS c, vendor_name AS n
                 FROM expense_entries WHERE user_id = ? AND org_id = ?`));
  add(await q(`SELECT zoho_payment_id AS a, NULL AS b, NULL AS c, customer_name AS n
                 FROM zb_customer_payments WHERE user_id = ? AND org_id = ?`));
  add(await q(`SELECT zoho_vendor_payment_id AS a, NULL AS b, NULL AS c, vendor_name AS n
                 FROM zb_vendor_payments WHERE user_id = ? AND org_id = ?`));
  return map;
}

async function buildBankReconciliation(userId, params = {}) {
  const orgId = await resolveOrgId(userId, params);
  if (!orgId) {
    const err = new Error('Not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const platform = params.platform ? String(params.platform).toLowerCase() : null;
  const { from, to } = resolveRange(params);

  const platClause = platform ? ' AND platform = ?' : '';
  const bookArgs = platform ? [userId, orgId, platform, to] : [userId, orgId, to];

  // Book side: every general-ledger posting on a bank or cash account up to the
  // as-of date.
  const [book] = await pool.execute(
    `SELECT id, platform, account_id, account_name, transaction_id, transaction_date,
            transaction_type, source_type, source_id, transaction_number,
            reference_number, transaction_details,
            COALESCE(base_debit, debit) AS debit, COALESCE(base_credit, credit) AS credit
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?${platClause}
        AND LOWER(account_type_code) IN ('bank', 'cash')
        AND transaction_date <= ?
      ORDER BY account_name, transaction_date, id`,
    bookArgs
  );

  // Statement side: the synced bank feed. Deleted feed lines are not part of
  // the statement. Not every platform syncs a feed, in which case the statement
  // side is simply empty and the whole book balance stands unreconciled.
  const [feed] = await pool.execute(
    `SELECT id, account_id, account_name, transaction_id, transaction_date,
            transaction_type, reference_number, payee, description,
            amount, debit_or_credit
       FROM bank_transactions
      WHERE user_id = ? AND transaction_date <= ?
        AND (status IS NULL OR UPPER(status) <> 'DELETED')
      ORDER BY account_name, transaction_date, id`,
    [userId, to]
  );

  const names = await nameMap(userId, orgId);
  const currency = await getBaseCurrency(orgId);

  // One section per bank account, keyed on the ledger's account id.
  const accounts = new Map();
  for (const b of book) {
    const key = String(b.account_id);
    if (!accounts.has(key)) {
      accounts.set(key, { name: b.account_name || '(Unnamed Account)', book: [], feed: [] });
    }
    accounts.get(key).book.push(b);
  }

  // Attach each feed line to its ledger account: by account id where the feed
  // records one (Zoho), otherwise by account name (Xero's feed carries only a
  // name). A feed line for an account that has no ledger postings still has to
  // be reconciled, so it opens a section of its own.
  const byId = new Map();
  const byName = new Map();
  for (const [key, acc] of accounts) {
    byId.set(key, acc);
    byName.set(norm(acc.name), acc);
  }
  for (const f of feed) {
    let acc = (f.account_id && byId.get(String(f.account_id))) || byName.get(norm(f.account_name));
    if (!acc) {
      acc = { name: f.account_name || '(Unnamed Account)', book: [], feed: [] };
      accounts.set(`feed:${norm(f.account_name)}`, acc);
      byName.set(norm(f.account_name), acc);
    }
    acc.feed.push(f);
  }

  const columns = [
    { key: 'label',  label: 'Bank Reconciliation', align: 'left'  },
    { key: 'type',   label: 'Transaction type',    align: 'left'  },
    { key: 'ref',    label: 'Reference',           align: 'left'  },
    { key: 'name',   label: 'To / From',           align: 'left'  },
    { key: 'amount', label: 'Amount',              align: 'right' },
  ];

  // A bank account is an asset, so a debit is money in and a credit is money
  // out. The feed states the same thing with debit_or_credit.
  const bookAmount = (b) => r2(num(b.debit) - num(b.credit));
  const feedAmount = (f) =>
    r2((String(f.debit_or_credit).toLowerCase() === 'credit' ? -1 : 1) * num(f.amount));

  const rows = [];
  const totals = { statement: 0, unpresented: 0, unreconciled: 0, bookBal: 0 };
  let feedSeen = false;

  const sections = [...accounts.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));

  for (const acc of sections) {
    if (acc.feed.length) feedSeen = true;

    // Reconciled means the same transaction appears on both sides of this
    // account. Amounts are summed per transaction because one transaction can
    // touch the same bank account on more than one line.
    const bookByTxn = new Map();
    for (const b of acc.book) {
      const t = b.transaction_id;
      bookByTxn.set(t, r2((bookByTxn.get(t) || 0) + bookAmount(b)));
    }
    const feedByTxn = new Map();
    for (const f of acc.feed) {
      const t = f.transaction_id;
      feedByTxn.set(t, r2((feedByTxn.get(t) || 0) + feedAmount(f)));
    }

    const statement = acc.feed.reduce((s, f) => r2(s + feedAmount(f)), 0);
    const bookBal = acc.book.reduce((s, b) => r2(s + bookAmount(b)), 0);

    const unpresentedRows = acc.book.filter((b) => !feedByTxn.has(b.transaction_id));
    const unreconciledRows = acc.feed.filter((f) => !bookByTxn.has(f.transaction_id));

    let unpresented = 0;
    for (const [t, v] of bookByTxn) if (!feedByTxn.has(t)) unpresented = r2(unpresented + v);
    let unreconciled = 0;
    for (const [t, v] of feedByTxn) if (!bookByTxn.has(t)) unreconciled = r2(unreconciled + v);

    // What is left once the matched transactions are compared: a transaction
    // present on both sides for a different amount. Zero on healthy data, and
    // shown only when it is not, so a mismatch is visible instead of silently
    // breaking the reconciliation.
    let mismatch = 0;
    for (const [t, v] of bookByTxn) {
      if (feedByTxn.has(t)) mismatch = r2(mismatch + r2(v - feedByTxn.get(t)));
    }

    // The four statement lines are pinned with `alwaysShow` so the reconciliation
    // always reads as a complete sum — a zero reconciling item is a meaningful
    // result here, not an empty row to drop.
    rows.push({ label: acc.name, isHeader: true, level: 0, cells: {} });
    rows.push({ label: `Balance as per Bank Statement as of ${fmtDate(to)}`, level: 1, alwaysShow: true, cells: { amount: statement } });
    rows.push({ label: 'Add: Book Entries Not on the Statement', level: 1, alwaysShow: true, cells: { amount: unpresented } });
    rows.push({ label: 'Less: Statement Lines Not in the Books', level: 1, alwaysShow: true, cells: { amount: unreconciled } });
    if (mismatch !== 0) {
      rows.push({ label: 'Add: Differences on Reconciled Transactions', level: 1, alwaysShow: true, cells: { amount: mismatch } });
    }
    rows.push({
      label: `Balance as per Books as of ${fmtDate(to)}`,
      isSubtotal: true,
      level: 1,
      cells: { amount: bookBal },
    });

    // The reconciling figures, itemised.
    if (unpresentedRows.length) {
      rows.push({ label: 'Book Entries Not on the Statement', isHeader: true, level: 1, cells: {} });
      for (const b of unpresentedRows) {
        rows.push({
          label: fmtDate(b.transaction_date),
          level: 2,
          cells: {
            type: typeLabel(b.transaction_type || b.source_type),
            ref: docRef(b),
            name: names.get(String(b.source_id || '').toLowerCase())
              || (b.transaction_details || '').replace(/\s*\n\s*/g, ' ').trim(),
            amount: bookAmount(b),
          },
        });
      }
      rows.push({
        label: 'Total Book Entries Not on the Statement',
        isSubtotal: true,
        level: 1,
        cells: { amount: unpresented },
      });
    }

    if (unreconciledRows.length) {
      rows.push({ label: 'Statement Lines Not in the Books', isHeader: true, level: 1, cells: {} });
      for (const f of unreconciledRows) {
        rows.push({
          label: fmtDate(f.transaction_date),
          level: 2,
          cells: {
            type: typeLabel(f.transaction_type),
            ref: (f.reference_number || '').trim(),
            name: f.payee || (f.description || '').replace(/\s*\n\s*/g, ' ').trim(),
            amount: feedAmount(f),
          },
        });
      }
      rows.push({
        label: 'Total Statement Lines Not in the Books',
        isSubtotal: true,
        level: 1,
        cells: { amount: unreconciled },
      });
    }

    totals.statement = r2(totals.statement + statement);
    totals.unpresented = r2(totals.unpresented + unpresented);
    totals.unreconciled = r2(totals.unreconciled + unreconciled);
    totals.bookBal = r2(totals.bookBal + bookBal);
  }

  if (sections.length) {
    rows.push({
      label: `TOTAL BALANCE AS PER BOOKS AS OF ${fmtDate(to)}`,
      isTotal: true,
      level: 0,
      cells: { amount: r2(totals.bookBal) },
    });
  }

  return {
    columns,
    rows,
    currency,
    meta: {
      title: 'Bank Reconciliation',
      from,
      to,
      basis: 'Accrual',
      source: 'ledger',
      note: feedSeen
        ? undefined
        : 'No bank feed is synced for this connection, so there is no statement to compare against — every book entry is listed as unreconciled.',
    },
  };
}

module.exports = { buildBankReconciliation };
