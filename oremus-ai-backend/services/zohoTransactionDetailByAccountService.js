'use strict';

/**
 * Transaction Detail by Account
 * ---------------------------------------------------------------------------
 * Every posting in the period listed under the account it landed on, in the
 * layout the platforms export:
 *
 *   Transaction date | Transaction type | Num | Name | Description | Split
 *                    | Amount | Balance
 *
 * Each account opens a section, its postings follow in date order with a
 * running balance that starts at zero for the period, and the section closes
 * with "Total for <account>". The report ends with a TOTAL of those section
 * totals.
 *
 * Amount is signed by the account's normal side — assets and expenses count
 * debits as positive, liabilities, equity and income count credits — so a bill
 * reads positive in both the expense section and the Accounts Payable section,
 * exactly as the platforms print it.
 *
 * Built entirely from `account_transactions`, the balanced double-entry ledger
 * all three platforms sync into, so one builder serves Zoho, QuickBooks and
 * Xero. The Name column is read back off the synced documents because the
 * ledger records which document a line came from but not who it was with.
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

// Assets and expenses grow on the debit side; everything else on the credit
// side. Signing by the account's own side is what makes a bill read positive
// under both the expense account and Accounts Payable.
const DEBIT_NORMAL = new Set(['asset', 'expense']);

// Accounts are listed in chart order, the way the platforms lay the report out.
const GROUP_ORDER = ['asset', 'liability', 'equity', 'income', 'expense'];

// Each platform's own vocabulary → the label it prints. QuickBooks already
// stores readable labels ("Bill Payment (Check)"), so those pass through.
const TYPE_LABEL = {
  invoice: 'Invoice', bill: 'Bill', expense: 'Expense', journal: 'Journal Entry',
  customer_payment: 'Payment', vendor_payment: 'Bill Payment',
  credit_note: 'Credit Note', vendor_credit: 'Vendor Credit',
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

// The document number the platform prints. Zoho keeps it in transaction_number;
// QuickBooks numbers the document in reference_number (its transaction_number
// is the line's own id) and Xero has no per-line number at all. A "number" that
// merely repeats the narration is a description, not a number.
function docNum(row) {
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
 * Contact name per source document, matched on whichever platform id the
 * ledger row carries.
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

async function buildTransactionDetailByAccount(userId, params = {}) {
  const orgId = await resolveOrgId(userId, params);
  if (!orgId) {
    const err = new Error('Not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const platform = resolvePlatform(params);
  const { from, to } = resolveRange(params);

  const platClause = platform ? ' AND platform = ?' : '';
  const args = platform ? [userId, orgId, platform, from, to] : [userId, orgId, from, to];

  const [lines] = await pool.execute(
    `SELECT id, platform, account_id, account_name, account_group,
            transaction_id, transaction_date, transaction_type, source_type,
            transaction_number, reference_number, transaction_details,
            source_id, COALESCE(base_debit, debit) AS debit, COALESCE(base_credit, credit) AS credit
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?${platClause}
        AND transaction_date BETWEEN ? AND ?
      ORDER BY account_name, transaction_date, id`,
    args
  );

  const names = await nameMap(userId, orgId);
  const currency = await getBaseCurrency(orgId);

  // Xero's Trial-Balance true-up plugs are cumulative balance-sheet corrections
  // dated at the ledger's last day. Left on a profit-and-loss account they dump
  // prior-year movement into the period, so they are excluded there exactly as
  // the Profit and Loss and General Ledger builders exclude them, and kept on
  // balance-sheet accounts where they are what makes the ledger tie.
  const isPlDistortion = (l) =>
    ['income', 'expense'].includes(l.account_group) &&
    String(l.transaction_id || '').startsWith('xero-recon:');

  // The other side of each entry, for the Split column.
  const acctsByTxn = new Map();
  for (const l of lines) {
    if (!acctsByTxn.has(l.transaction_id)) acctsByTxn.set(l.transaction_id, new Set());
    acctsByTxn.get(l.transaction_id).add(l.account_name || '');
  }
  const splitFor = (l) => {
    const others = [...(acctsByTxn.get(l.transaction_id) || [])].filter((n) => n && n !== l.account_name);
    if (others.length === 0) return '';
    return others.length === 1 ? others[0] : '-Split-';
  };

  const columns = [
    { key: 'label',   label: 'Transaction date', align: 'left'  },
    { key: 'type',    label: 'Transaction type', align: 'left'  },
    { key: 'num',     label: 'Num',              align: 'left'  },
    { key: 'name',    label: 'Name',             align: 'left'  },
    { key: 'desc',    label: 'Description',      align: 'left'  },
    { key: 'split',   label: 'Split',            align: 'left'  },
    { key: 'amount',  label: 'Amount',           align: 'right' },
    { key: 'balance', label: 'Balance',          align: 'right' },
  ];

  const byAccount = new Map();
  for (const l of lines) {
    if (isPlDistortion(l)) continue;
    const key = String(l.account_id);
    if (!byAccount.has(key)) {
      byAccount.set(key, {
        name: l.account_name || '(Unaccounted)',
        group: l.account_group || 'asset',
        lines: [],
      });
    }
    byAccount.get(key).lines.push(l);
  }
  const sections = [...byAccount.values()].sort((a, b) => {
    const ga = GROUP_ORDER.indexOf(a.group);
    const gb = GROUP_ORDER.indexOf(b.group);
    if (ga !== gb) return (ga < 0 ? 99 : ga) - (gb < 0 ? 99 : gb);
    return String(a.name).localeCompare(String(b.name));
  });

  const rows = [];
  let total = 0;

  for (const sec of sections) {
    const sign = DEBIT_NORMAL.has(sec.group) ? 1 : -1;
    rows.push({ label: sec.name, isHeader: true, level: 0, cells: {} });

    // The balance runs from zero: this report shows what the period did to the
    // account, not what the account is worth.
    let running = 0;
    for (const l of sec.lines) {
      const amount = r2(sign * (num(l.debit) - num(l.credit)));
      running = r2(running + amount);
      rows.push({
        label: fmtDate(l.transaction_date),
        level: 1,
        cells: {
          type:    typeLabel(l.transaction_type || l.source_type),
          num:     docNum(l),
          name:    names.get(String(l.source_id || '').toLowerCase()) || '',
          desc:    (l.transaction_details || '').replace(/\s*\n\s*/g, ' ').trim(),
          split:   splitFor(l),
          amount,
          balance: running,
        },
      });
    }

    rows.push({
      label: `Total for ${sec.name}`,
      isSubtotal: true,
      level: 0,
      cells: { amount: running },
    });
    total = r2(total + running);
  }

  rows.push({ label: 'TOTAL', isTotal: true, level: 0, cells: { amount: total } });

  return {
    columns,
    rows,
    currency,
    meta: { title: 'Transaction Detail by Account', from, to, basis: 'Accrual', source: 'ledger' },
  };
}

module.exports = { buildTransactionDetailByAccount };
