'use strict';

/**
 * Budget Summary — the budget as entered on the client's own platform, read
 * from the shared budget tables (budgetsStore, filled by each platform's sync)
 * and laid out the way that platform lays a budget out:
 *
 *   Xero        Budget Summary: Trading Income, Cost of Sales, Gross Profit,
 *               Other Income, Operating Expenses, Net Profit. A multi-month
 *               column is headed by its last month, as Xero heads it.
 *   QuickBooks  Budget Overview: Income, Cost of Goods Sold, Gross Profit,
 *               Expenses, Net Operating Income, Other Income, Other Expenses,
 *               Net Other Income, Net Income.
 *   Zoho Books  budget Profit and Loss: Operating Income, Cost of Goods Sold,
 *               Gross Profit, Operating Expense, Operating Profit, Non
 *               Operating Income / Expense, Net Profit/Loss.
 *
 * One column per period — 1, 3, 6 or 12 months counted from the first month
 * of the date range (never finer than the budget was entered in) — then a
 * Total. Only accounts with a budgeted amount in the range are listed; the
 * layout is profit and loss, so balance-sheet accounts are left out.
 * `budget_id` picks the budget (default: Xero's Overall Budget / the latest),
 * `dimension` one QuickBooks class / location / customer of a subdivided
 * budget (default: all of them added up).
 *
 * Which platform an org belongs to is read from its own organisation table,
 * because a request can reach this builder through any provider path.
 */

const pool = require('../config/db');
const { loadBudgetSync, listBudgets, loadBudgetLines } = require('./budgetsStore');

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAME = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const STEP = { month: 1, quarter: 3, half_year: 6, year: 12 };
const ENTRY_INTERVAL = { monthly: 'month', quarterly: 'quarter', half_yearly: 'half_year', 'half-yearly': 'half_year', yearly: 'year' };
const ENTRY_WORD = { monthly: 'month', quarterly: 'quarter', half_yearly: 'half-year', 'half-yearly': 'half-year', yearly: 'year' };
const INTERVAL_WORD = { month: 'month', quarter: 'quarter', half_year: 'half-year', year: 'year' };

// Section of an account, by each platform's own account types.
const XERO_SECTION = {
  REVENUE: 'income', SALES: 'income', DIRECTCOSTS: 'cogs', OTHERINCOME: 'other_income',
  EXPENSE: 'expense', OVERHEADS: 'expense', DEPRECIATN: 'expense', WAGESEXPENSE: 'expense', SUPERANNUATIONEXPENSE: 'expense',
};
const XERO_CLASS_SECTION = { REVENUE: 'income', EXPENSE: 'expense' };
const QBO_SECTION = {
  'income': 'income', 'cost of goods sold': 'cogs', 'expense': 'expense', 'other income': 'other_income', 'other expense': 'other_expense',
};
const ZOHO_SECTION = {
  income: 'income', cost_of_goods_sold: 'cogs', expense: 'expense', other_income: 'other_income', other_expense: 'other_expense',
};

// Report layout, in order: sections (their accounts + a total) and computed
// rows, which add or subtract earlier sections / computed rows.
const S = (key, title, total) => ({ key, title, total });
const C = (key, label, terms, extra = {}) => ({ key, label, terms, ...extra });
const PLATFORM = {
  xero: {
    label: 'Xero',
    intervals: ['month', 'quarter', 'year'],
    headByEnd: true,
    layout: [
      S('income', 'Trading Income', 'Total Trading Income'),
      S('cogs', 'Cost of Sales', 'Total Cost of Sales'),
      C('gross', 'Gross Profit', [[1, 'income'], [-1, 'cogs']]),
      S('other_income', 'Other Income', 'Total Other Income'),
      S('expense', 'Operating Expenses', 'Total Operating Expenses'),
      C('net', 'Net Profit', [[1, 'gross'], [1, 'other_income'], [-1, 'expense']], { isTotal: true }),
    ],
    noBudgets: 'No budgets are set up in Xero Budget Manager for this organisation.',
  },
  quickbooks: {
    label: 'QuickBooks',
    intervals: ['month', 'quarter', 'year'],
    layout: [
      S('income', 'Income', 'Total Income'),
      S('cogs', 'Cost of Goods Sold', 'Total Cost of Goods Sold'),
      C('gross', 'Gross Profit', [[1, 'income'], [-1, 'cogs']]),
      S('expense', 'Expenses', 'Total Expenses'),
      C('operating', 'Net Operating Income', [[1, 'gross'], [-1, 'expense']]),
      S('other_income', 'Other Income', 'Total Other Income'),
      S('other_expense', 'Other Expenses', 'Total Other Expenses'),
      C('other', 'Net Other Income', [[1, 'other_income'], [-1, 'other_expense']], { onlyWith: ['other_income', 'other_expense'] }),
      C('net', 'Net Income', [[1, 'operating'], [1, 'other_income'], [-1, 'other_expense']], { isTotal: true }),
    ],
    // Balance-sheet budgets have nothing to show in a profit-and-loss layout.
    keepBudget: (b) => b.type !== 'BalanceSheet',
    noBudgets: 'No profit-and-loss budgets are set up in QuickBooks for this company (budgets need QuickBooks Online Plus or Advanced).',
  },
  zoho: {
    label: 'Zoho Books',
    intervals: ['month', 'quarter', 'half_year', 'year'],
    layout: [
      S('income', 'Operating Income', 'Total for Operating Income'),
      S('cogs', 'Cost of Goods Sold', 'Total for Cost of Goods Sold'),
      C('gross', 'Gross Profit', [[1, 'income'], [-1, 'cogs']]),
      S('expense', 'Operating Expense', 'Total for Operating Expense'),
      C('operating', 'Operating Profit', [[1, 'gross'], [-1, 'expense']]),
      S('other_income', 'Non Operating Income', 'Total for Non Operating Income'),
      S('other_expense', 'Non Operating Expense', 'Total for Non Operating Expense'),
      C('net', 'Net Profit/Loss', [[1, 'operating'], [1, 'other_income'], [-1, 'other_expense']], { isTotal: true }),
    ],
    noBudgets: 'No budgets are set up in Zoho Books for this organisation (budgets need the Premium plan or higher).',
  },
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(num(n) * 100) / 100;
const monthIdx = (ymd) => { const [y, m] = String(ymd).split('-').map(Number); return y * 12 + (m - 1); };
const yearOf = (i) => Math.floor(i / 12);
const monthOf = (i) => (i % 12) + 1;
const pad = (n) => String(n).padStart(2, '0');
const firstOf = (i) => `${yearOf(i)}-${pad(monthOf(i))}-01`;
const lastDay = (i) => new Date(Date.UTC(yearOf(i), monthOf(i), 0)).getUTCDate();
const lastOf = (i) => `${yearOf(i)}-${pad(monthOf(i))}-${pad(lastDay(i))}`;

// "April" / "apr" / "4" → 4; null when unreadable.
function monthNumber(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  const n = parseInt(s, 10);
  if (String(n) === s) return n >= 1 && n <= 12 ? n : null;
  const i = MONTH_NAME.findIndex((m) => m.toLowerCase().startsWith(s.slice(0, 3)));
  return i >= 0 ? i + 1 : null;
}

/** The platform an org belongs to, with the user whose sync holds its data. */
async function resolveOrg(userId, orgId) {
  if (!orgId) return null;
  const first = async (sql) => {
    try {
      const [[row]] = await pool.execute(sql, [String(orgId), userId]);
      return row || null;
    } catch (_) {
      return null; // that platform's tables aren't on this deployment
    }
  };
  const xero = await first(`SELECT user_id, name, currency, fiscal_year_end_month AS fy
    FROM xero_organizations WHERE tenant_id = ? ORDER BY user_id = ? DESC LIMIT 1`);
  if (xero) {
    const end = monthNumber(xero.fy);
    return { platform: 'xero', userId: xero.user_id, name: xero.name, currency: xero.currency, fyStart: end ? (end % 12) + 1 : 1 };
  }
  const qbo = await first(`SELECT user_id, company_name AS name, currency, fiscal_year_start AS fy
    FROM qbo_organizations WHERE realm_id = ? ORDER BY user_id = ? DESC LIMIT 1`);
  if (qbo) return { platform: 'quickbooks', userId: qbo.user_id, name: qbo.name, currency: qbo.currency, fyStart: monthNumber(qbo.fy) || 1 };
  const zoho = await first(`SELECT user_id, name, currency_code AS currency, fiscal_year_start_month AS fy
    FROM zb_organizations WHERE org_id = ? ORDER BY user_id = ? DESC LIMIT 1`)
    || await first(`SELECT user_id, org_name AS name, currency, NULL AS fy
    FROM zb_oauth_organizations WHERE org_id = ? ORDER BY user_id = ? DESC LIMIT 1`);
  if (zoho) return { platform: 'zoho', userId: zoho.user_id, name: zoho.name, currency: zoho.currency, fyStart: monthNumber(zoho.fy) || 4 };
  return null;
}

// Every account of the org: id → { name, code, section } (section null for a
// balance-sheet account).
async function accountMeta(platform, userId, orgId) {
  const sql = {
    xero: 'SELECT xero_id AS id, code, name, type, class AS cls FROM xero_accounts WHERE user_id = ? AND tenant_id = ?',
    quickbooks: 'SELECT qbo_id AS id, account_number AS code, name, account_type AS type, classification AS cls FROM qbo_accounts WHERE user_id = ? AND realm_id = ?',
    zoho: 'SELECT zoho_account_id AS id, account_code AS code, account_name AS name, account_type AS type, NULL AS cls FROM zb_chart_of_accounts WHERE user_id = ? AND org_id = ? AND COALESCE(is_deleted, 0) = 0',
  }[platform];
  const [rows] = await pool.execute(sql, [userId, String(orgId)]).catch(() => [[]]);
  const byId = new Map();
  const byCode = new Map();
  for (const r of rows) {
    const type = String(r.type || '');
    const section = platform === 'xero'
      ? (XERO_SECTION[type.toUpperCase()] || XERO_CLASS_SECTION[String(r.cls || '').toUpperCase()] || null)
      : platform === 'quickbooks' ? (QBO_SECTION[type.toLowerCase()] || null)
        : (ZOHO_SECTION[type.toLowerCase()] || null);
    const a = { name: String(r.name || '').trim(), code: r.code || null, section };
    byId.set(String(r.id), a);
    if (r.code) byCode.set(String(r.code), a);
  }
  return { byId, byCode };
}

function resolveInterval(params, cfg, budget) {
  const raw = String(params.interval || params.interval_type || 'month').toLowerCase();
  let interval = raw.startsWith('quarter') ? 'quarter'
    : raw.startsWith('half') ? 'half_year'
      : (raw.startsWith('year') || raw === 'fy') ? 'year' : 'month';
  if (!cfg.intervals.includes(interval)) interval = 'month';
  // Never finer than the budget was entered in (a quarterly QuickBooks budget
  // has one amount per quarter).
  const floor = ENTRY_INTERVAL[String(budget?.entryPeriod || '').toLowerCase()];
  const raised = floor && STEP[floor] > STEP[interval] && cfg.intervals.includes(floor);
  return { interval: raised ? floor : interval, raisedFrom: raised ? interval : null };
}

// The date range in whole months: the request's, else this financial year.
function resolveMonths(params, fyStart) {
  const from = params.from_date || params.date_start;
  const to = params.to_date || params.date_end;
  if (from && to && monthIdx(from) <= monthIdx(to)) return { start: monthIdx(from), end: monthIdx(to) };
  const now = new Date();
  const today = now.getFullYear() * 12 + now.getMonth();
  const start = today - (((today % 12) - (fyStart - 1) + 12) % 12);
  return { start, end: start + 11 };
}

function columnLabel(s, e, headByEnd) {
  if (s === e || headByEnd) return `${MON[monthOf(e) - 1]} ${yearOf(e)}`;
  return yearOf(s) === yearOf(e)
    ? `${MON[monthOf(s) - 1]} - ${MON[monthOf(e) - 1]} ${yearOf(e)}`
    : `${MON[monthOf(s) - 1]} ${yearOf(s)} - ${MON[monthOf(e) - 1]} ${yearOf(e)}`;
}

// Column periods: `step` months each from `start`, the last cut at `end`.
function buildPeriods(start, end, interval, headByEnd = false) {
  const step = STEP[interval];
  const periods = [];
  for (let s = start; s <= end && periods.length < 120; s += step) {
    const e = Math.min(s + step - 1, end);
    periods.push({ key: `p${periods.length}`, start: s, end: e, label: columnLabel(s, e, headByEnd) });
  }
  return periods;
}

function periodText(platform, start, end) {
  const months = end - start + 1;
  if (platform === 'xero') {
    return `For the ${months === 1 ? 'month' : `${months} months`} ending ${lastDay(end)} ${MONTH_NAME[monthOf(end) - 1]} ${yearOf(end)}`;
  }
  if (platform === 'zoho') {
    return `From 01/${pad(monthOf(start))}/${yearOf(start)} To ${pad(lastDay(end))}/${pad(monthOf(end))}/${yearOf(end)}`;
  }
  return yearOf(start) === yearOf(end)
    ? `${MONTH_NAME[monthOf(start) - 1]} - ${MONTH_NAME[monthOf(end) - 1]} ${yearOf(end)}`
    : `${MONTH_NAME[monthOf(start) - 1]} ${yearOf(start)} - ${MONTH_NAME[monthOf(end) - 1]} ${yearOf(end)}`;
}

function emptyPayload(extra) {
  return {
    columns: [{ key: 'label', label: 'Account', align: 'left' }, { key: 'total', label: 'Total', align: 'right' }],
    rows: [],
    empty: true,
    ...extra,
  };
}

// Why there's no budget to show, in the platform's words.
function noBudgetMessage(cfg, sync) {
  if (!sync) {
    return { emptyReason: 'not_synced', message: `Budgets haven't been brought in from ${cfg.label} yet. Run a ${cfg.label} sync to fetch them.` };
  }
  if (sync.status === 'error') {
    const fix = /permission/i.test(sync.error || '') ? `Grant it, reconnect ${cfg.label} and sync again.` : 'Run the sync again.';
    return { emptyReason: 'no_access', message: `${sync.error || `Budgets could not be fetched from ${cfg.label}.`} ${fix}` };
  }
  if (sync.status === 'unavailable') {
    return { emptyReason: 'no_budgets', message: `${cfg.noBudgets} ${sync.error || ''}`.trim() };
  }
  return { emptyReason: 'no_budgets', message: cfg.noBudgets };
}

async function buildBudgetSummary(userId, params = {}) {
  const org = await resolveOrg(userId, params.org_id);
  if (!org) {
    return emptyPayload({
      period: 'budget', unavailable: true, emptyReason: 'unavailable',
      message: 'No accounting connection found. Connect Zoho Books, QuickBooks or Xero first.',
    });
  }
  const { platform } = org;
  const cfg = PLATFORM[platform];
  const orgId = String(params.org_id);
  const dataUser = org.userId;

  const [sync, allBudgets] = await Promise.all([
    loadBudgetSync(dataUser, platform, orgId),
    listBudgets(dataUser, platform, orgId),
  ]);
  const budgets = cfg.keepBudget ? allBudgets.filter(cfg.keepBudget) : allBudgets;
  const budget = budgets.find((b) => b.id === params.budget_id) || budgets[0] || null;

  const { start, end } = resolveMonths(params, org.fyStart);
  const { interval, raisedFrom } = resolveInterval(params, cfg, budget);
  const from = firstOf(start);
  const to = lastOf(end);
  const common = {
    period: 'budget',
    interval,
    intervals: cfg.intervals,
    budgets: budgets.map(({ id, name, type, status, entryPeriod }) => ({ id, name, type, status, entryPeriod })),
    ...(org.currency ? { currency: org.currency } : {}),
    meta: {
      title: 'Budget Summary', company: org.name, platform, from, to,
      periodText: periodText(platform, start, end), interval, source: 'budget',
      budgetSyncedAt: sync?.synced_at || null,
    },
  };

  if (!budget) return emptyPayload({ ...common, budgetName: 'Budget', ...noBudgetMessage(cfg, sync) });

  const periods = buildPeriods(start, end, interval, cfg.headByEnd);
  const [allLines, accounts] = await Promise.all([
    loadBudgetLines(dataUser, platform, orgId, budget.id, from, firstOf(end)),
    accountMeta(platform, dataUser, orgId),
  ]);

  // Subdivisions (QuickBooks class / location / customer) present in range.
  const dims = new Map();
  for (const l of allLines) if (l.dimension_key) dims.set(l.dimension_key, l.dimension_label || l.dimension_key);
  const dimension = params.dimension && dims.has(params.dimension) ? params.dimension : '';
  const lines = dimension ? allLines.filter((l) => l.dimension_key === dimension) : allLines;

  // account → { name, section, cells }
  const byAccount = new Map();
  let skipped = 0;
  for (const l of lines) {
    if (!l.amount) continue;
    const id = String(l.account_id);
    const a = accounts.byId.get(id)
      || (l.account_code ? accounts.byCode.get(String(l.account_code)) : null)
      || (id.startsWith('code:') ? accounts.byCode.get(id.slice(5)) : null);
    if (!a?.section) { skipped += 1; continue; }
    const m = monthIdx(l.period);
    const p = periods.find((x) => m >= x.start && m <= x.end);
    if (!p) continue;
    if (!byAccount.has(id)) {
      byAccount.set(id, { name: a.name || l.account_name || (a.code ? `Account ${a.code}` : 'Account'), code: a.code, section: a.section, cells: {} });
    }
    const acc = byAccount.get(id);
    acc.cells[p.key] = num(acc.cells[p.key]) + l.amount;
  }

  const keys = [...periods.map((p) => p.key), 'total'];
  const finish = (cells) => {
    const out = {};
    let total = 0;
    for (const p of periods) { out[p.key] = r2(cells[p.key]); total += num(cells[p.key]); }
    out.total = r2(total);
    return out;
  };
  const combine = (terms) => {
    const out = {};
    for (const k of keys) out[k] = r2(terms.reduce((s, [sign, cells]) => s + sign * num(cells?.[k]), 0));
    return out;
  };

  const rows = [];
  const values = {}; // section / computed key → cells
  const present = new Set([...byAccount.values()].map((a) => a.section));
  if (byAccount.size) {
    for (const item of cfg.layout) {
      if (item.terms) {
        values[item.key] = combine(item.terms.map(([sign, k]) => [sign, values[k]]));
        if (item.onlyWith && !item.onlyWith.some((k) => present.has(k))) continue;
        rows.push({ label: item.label, ...(item.isTotal ? { isTotal: true } : { isSubtotal: true }), level: 0, cells: values[item.key] });
        rows.push({ label: '', level: 0 });
        continue;
      }
      const list = [...byAccount.values()].filter((a) => a.section === item.key)
        .sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
      if (!list.length) continue;
      rows.push({ label: item.title, isHeader: true, level: 0 });
      const cellsList = list.map((a) => {
        const cells = finish(a.cells);
        rows.push({ label: a.name, level: 1, accountCode: a.code, cells });
        return cells;
      });
      values[item.key] = combine(cellsList.map((c) => [1, c]));
      rows.push({ label: item.total, isSubtotal: true, level: 0, cells: values[item.key] });
      rows.push({ label: '', level: 0 });
    }
    if (rows.length && !rows[rows.length - 1].label) rows.pop();
  }

  const entry = String(budget.entryPeriod || '').toLowerCase();
  const payload = {
    ...common,
    columns: [
      { key: 'label', label: 'Account', align: 'left' },
      ...periods.map((p) => ({ key: p.key, label: p.label, align: 'right' })),
      { key: 'total', label: 'Total', align: 'right' },
    ],
    rows,
    budgetName: budget.name,
    budgetId: budget.id,
    dimensions: [...dims].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label)),
    dimension,
    meta: {
      ...common.meta,
      budgetType: budget.type,
      entryPeriod: budget.entryPeriod,
      ...(raisedFrom ? { note: `This budget is set per ${ENTRY_WORD[entry]}, so it is shown by ${ENTRY_WORD[entry]} rather than by ${INTERVAL_WORD[raisedFrom]}.` } : {}),
      ...(skipped ? { skippedLines: skipped } : {}),
    },
  };
  if (!rows.length) {
    return { ...payload, empty: true, emptyReason: 'no_amounts', message: `${budget.name} has no budgeted amounts for this period.` };
  }
  return payload;
}

module.exports = { buildBudgetSummary, buildPeriods, resolveOrg, PLATFORM };
