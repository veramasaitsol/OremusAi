'use strict';

/**
 * Chart of Accounts — every ledger account, grouped and with its balance.
 * ---------------------------------------------------------------------------
 *   Account Name | Code | Type | Balance
 *
 * Accounts are grouped under their top-level classification (Assets,
 * Liabilities, Equity, Income, Expenses), sorted by name within the section,
 * with a per-section subtotal and a grand total.
 *
 * PROVIDER-AGNOSTIC. The account master comes from whichever chart the
 * connected platform syncs — Zoho `zb_chart_of_accounts`, Xero `xero_accounts`,
 * QuickBooks `qbo_accounts` — falling back to the accounts that appear in the
 * shared ledger. The balance is
 * always recomputed from the shared `account_transactions` ledger as at the To
 * date, signed by the account's normal side, because the master tables carry a
 * balance only at sync time (and several platforms leave it at zero).
 */

const pool = require('../config/db');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

async function getOrgId(userId) {
  const [[row]] = await pool.execute('SELECT org_id FROM zb_tokens WHERE user_id = ?', [userId]);
  return row?.org_id || null;
}

// The org's base (reporting) currency. `orgId` is the Zoho org id, the Xero
// tenant id or the QuickBooks realm id depending on the connection, so each
// provider's organisation table is consulted in turn.
async function getBaseCurrency(orgId) {
  const lookups = [
    ['SELECT currency_code AS c FROM zb_organizations WHERE org_id = ? LIMIT 1', orgId],
    ['SELECT currency AS c FROM xero_organizations WHERE tenant_id = ? LIMIT 1', orgId],
    ['SELECT currency AS c FROM qbo_organizations WHERE realm_id = ? LIMIT 1', orgId],
  ];
  for (const [sql, arg] of lookups) {
    try {
      const [[row]] = await pool.execute(sql, [arg]);
      if (/^[A-Z]{3}$/.test(row?.c || '')) return row.c;
    } catch { /* table absent on this deployment — try the next provider */ }
  }
  return 'INR';
}

const SECTIONS = [
  { key: 'asset',     label: 'Assets'      },
  { key: 'liability', label: 'Liabilities' },
  { key: 'equity',    label: 'Equity'      },
  { key: 'income',    label: 'Income'      },
  { key: 'expense',   label: 'Expenses'    },
];

// Assets and expenses are debit-normal, everything else credit-normal, so a
// healthy balance reads positive in every section — the convention every
// platform's chart of accounts uses.
const DEBIT_NORMAL = new Set(['asset', 'expense']);

// Zoho account_type → classification.
const ZOHO_GROUP = {
  bank: 'asset', cash: 'asset', accounts_receivable: 'asset', fixed_asset: 'asset',
  other_asset: 'asset', other_current_asset: 'asset', stock: 'asset', inventory: 'asset',
  accounts_payable: 'liability', long_term_liability: 'liability',
  other_current_liability: 'liability', other_liability: 'liability', credit_card: 'liability',
  equity: 'equity',
  income: 'income', other_income: 'income',
  expense: 'expense', cost_of_goods_sold: 'expense', other_expense: 'expense',
};

// Xero class → classification.
const XERO_GROUP = {
  ASSET: 'asset', LIABILITY: 'liability', EQUITY: 'equity',
  REVENUE: 'income', EXPENSE: 'expense',
};

// QuickBooks classification → universal group.
const QBO_GROUP = {
  Asset: 'asset', Liability: 'liability', Equity: 'equity',
  Revenue: 'income', Expense: 'expense',
};

// QuickBooks account_type → human-readable label.
const QBO_TYPE_LABEL = {
  Bank: 'Bank', AccountsReceivable: 'Accounts Receivable',
  OtherCurrentAsset: 'Other Current Asset', FixedAsset: 'Fixed Asset',
  OtherAsset: 'Other Asset', AccountsPayable: 'Accounts Payable',
  CreditCard: 'Credit Card', OtherCurrentLiability: 'Other Current Liability',
  LongTermLiability: 'Long Term Liability', OtherLiability: 'Other Liability',
  Equity: 'Equity', Income: 'Income', OtherIncome: 'Other Income',
  Expense: 'Expense', CostOfGoodsSold: 'Cost of Goods Sold',
  OtherExpense: 'Other Expense',
};

// Humanise an enum-style type (other_current_asset → "Other Current Asset",
// CURRLIAB → "Currliab" is unhelpful, so Xero types get their own labels).
function prettyEnum(raw) {
  if (!raw) return '';
  return String(raw)
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

const XERO_TYPE_LABEL = {
  BANK: 'Bank', CURRENT: 'Current Asset', FIXED: 'Fixed Asset',
  INVENTORY: 'Inventory', NONCURRENT: 'Non-current Asset', PREPAYMENT: 'Prepayment',
  CURRLIAB: 'Current Liability', TERMLIAB: 'Non-current Liability',
  LIABILITY: 'Liability', PAYGLIABILITY: 'Current Liability',
  SUPERANNUATIONLIABILITY: 'Current Liability', WAGESPAYABLELIABILITY: 'Current Liability',
  EQUITY: 'Equity',
  REVENUE: 'Revenue', SALES: 'Revenue', OTHERINCOME: 'Other Income',
  EXPENSE: 'Expense', DIRECTCOSTS: 'Direct Costs', OVERHEADS: 'Overhead',
  DEPRECIATN: 'Depreciation', SUPERANNUATIONEXPENSE: 'Expense', WAGESEXPENSE: 'Expense',
};

/** The Zoho account master, when this org is a Zoho connection. */
async function zohoAccounts(userId, orgId) {
  const [rows] = await pool.execute(
    `SELECT zoho_account_id AS ref, account_name AS name, account_code AS code,
            account_type AS type, account_type_formatted AS type_label
       FROM zb_chart_of_accounts
      WHERE user_id = ? AND org_id = ? AND COALESCE(is_deleted, 0) = 0`,
    [userId, orgId]
  ).catch(() => [[]]);
  return rows.map((r) => ({
    ref: r.ref,
    name: r.name,
    code: r.code || '',
    type: r.type_label || prettyEnum(r.type),
    group: ZOHO_GROUP[r.type] || 'asset',
  }));
}

/** The Xero account master, when this org is a Xero tenant. */
async function xeroAccounts(userId, orgId) {
  const [rows] = await pool.execute(
    `SELECT xero_id AS ref, name, code, type, class
       FROM xero_accounts
      WHERE user_id = ? AND tenant_id = ?`,
    [userId, orgId]
  ).catch(() => [[]]);
  return rows.map((r) => ({
    ref: r.ref,
    name: r.name,
    code: r.code || '',
    type: XERO_TYPE_LABEL[r.type] || prettyEnum(r.type),
    group: XERO_GROUP[r.class] || 'asset',
  }));
}

/**
 * The accounts the shared ledger itself knows about. Used when the platform
 * syncs no account master (QuickBooks), and it is also what supplies balances
 * for every provider.
 */
async function ledgerAccounts(userId, orgId, asOf) {
  const [rows] = await pool.execute(
    `SELECT account_id AS ref,
            MAX(account_name)      AS name,
            MAX(account_group)     AS acct_group,
            MAX(account_type_code) AS type_code,
            SUM(debit) - SUM(credit) AS net
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND (transaction_date IS NULL OR transaction_date <= ?)
      GROUP BY account_id`,
    [userId, orgId, asOf]
  ).catch(() => [[]]);
  return rows.map((r) => ({
    ref: r.ref,
    name: r.name,
    code: '',
    type: prettyEnum(r.type_code),
    group: r.acct_group || 'asset',
    net: num(r.net),
  }));
}

async function buildChartOfAccounts(userId, params = {}) {
  const orgId = params.org_id || (await getOrgId(userId));
  if (!orgId) {
    const err = new Error('Provider not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const asOf = params.to_date || params.as_of_date || params.to || '9999-12-31';
  const currency = await getBaseCurrency(orgId);

  const ledger = await ledgerAccounts(userId, orgId, asOf);
  const [zoho, xero, qbo] = await Promise.all([
    zohoAccounts(userId, orgId),
    xeroAccounts(userId, orgId),
    qboAccounts(userId, orgId),
  ]);

  // Prefer the platform's own chart — it lists accounts that have never been
  // posted to, which a chart of accounts must show. Without one, the ledger is
  // the only account list we hold.
  const master = zoho.length ? zoho : xero.length ? xero : qbo.length ? qbo : ledger;

  // Anything posted to but absent from the master (a platform's own system
  // accounts, for one) still belongs on the chart, otherwise its balance would
  // vanish and the sections would stop tying to the Trial Balance.
  const key = (ref) => String(ref).toLowerCase();
  const inMaster = new Set(master.map((a) => key(a.ref)));
  const accounts = [...master, ...ledger.filter((a) => !inMaster.has(key(a.ref)))];

  // Balances are keyed on the ledger's account_id, which holds the platform's
  // own account reference for all three providers.
  const netByRef = new Map(ledger.map((a) => [key(a.ref), a.net]));
  for (const a of accounts) {
    const net = netByRef.get(key(a.ref)) || 0;
    a.balance = DEBIT_NORMAL.has(a.group) ? net : -net;
  }

  const columns = [
    { key: 'label',   label: 'Account Name', align: 'left'  },
    { key: 'code',    label: 'Code',         align: 'left'  },
    { key: 'type',    label: 'Type',         align: 'left'  },
    { key: 'balance', label: 'Balance',      align: 'right', money: true },
  ];

  const buckets = new Map(SECTIONS.map((s) => [s.key, []]));
  for (const a of accounts) (buckets.get(a.group) || buckets.get('asset')).push(a);

  const out = [];
  let count = 0;
  for (const s of SECTIONS) {
    const list = buckets.get(s.key);
    if (!list.length) continue;
    list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    out.push({ label: s.label, isHeader: true, level: 0, cells: {} });
    let sectionBalance = 0;
    for (const a of list) {
      out.push({
        label: a.name || '(Unnamed)',
        level: 1,
        cells: { code: a.code, type: a.type, balance: round2(a.balance) },
      });
      sectionBalance += a.balance;
      count += 1;
    }
    out.push({
      label: `Total for ${s.label}`,
      isSubtotal: true,
      level: 0,
      cells: { balance: round2(sectionBalance) },
    });
  }

  // No grand balance: on a balanced ledger the five sections net to zero, which
  // says nothing. A chart of accounts is asked how many accounts it holds.
  out.push({
    label: `Total (${count} accounts)`,
    isTotal: true,
    level: 0,
    cells: {},
  });

  return {
    columns,
    rows: out,
    currency,
    zoho: { module: 'Accountant', title: 'Chart of Accounts', totalCount: count },
    meta: {
      title: 'Chart of Accounts',
      source: 'warehouse',
      note: count ? undefined : 'No accounts have been synced for this organisation yet.',
    },
  };
}

/** The QuickBooks account master, when this org is a QBO company. */
async function qboAccounts(userId, orgId) {
  const [rows] = await pool.execute(
    `SELECT qbo_id AS ref, COALESCE(fully_qualified_name, name) AS name,
            account_number AS code, account_type AS type, classification
       FROM qbo_accounts
      WHERE user_id = ? AND realm_id = ? AND active = 1`,
    [userId, orgId]
  ).catch(() => [[]]);
  return rows.map((r) => ({
    ref: r.ref,
    name: r.name,
    code: r.code || '',
    type: QBO_TYPE_LABEL[r.type] || prettyEnum(r.type),
    group: QBO_GROUP[r.classification] || 'asset',
  }));
}

/**
 * The account code / type / classification the connected platform holds for
 * each account, keyed on the lowercased reference the shared ledger stores in
 * `account_id`. Falls through Zoho → Xero → QuickBooks; whichever chart has
 * data wins. QuickBooks may have no account master at all (empty map →
 * callers fall back to what the ledger itself records).
 */
async function accountMeta(userId, orgId) {
  const [zoho, xero, qbo] = await Promise.all([
    zohoAccounts(userId, orgId),
    xeroAccounts(userId, orgId),
    qboAccounts(userId, orgId),
  ]);
  const master = zoho.length ? zoho : xero.length ? xero : qbo;
  return new Map(master.map((a) => [String(a.ref).toLowerCase(), a]));
}

module.exports = { buildChartOfAccounts, accountMeta, getBaseCurrency, prettyEnum };
