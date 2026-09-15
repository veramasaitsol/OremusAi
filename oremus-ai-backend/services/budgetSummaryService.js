'use strict';

/**
 * Budget Summary report — provider-agnostic.
 * ---------------------------------------------------------------------------
 * Mirrors the Trial Balance exactly: the account set and every figure come
 * straight from `zohoGlReportsService.buildTrialBalance`, so Budget Summary,
 * Trial Balance, Balance Sheet and Profit & Loss all reconcile for the same
 * filters. No separate budget store exists, so the single value column is the
 * actual (a "budget = actual" layout).
 *
 * Layout: Profit & Loss sections first (Trading Income, Cost of Sales,
 * Operating Expenses, Other Income, Non Operating Expense) with Gross Profit
 * and Net Profit computed lines, then the Balance Sheet sections (Assets,
 * Liabilities, Equity). P&L rows carry the period's net movement with their
 * natural sign (income positive, expense positive); Balance Sheet rows carry
 * the Trial Balance's debit-positive cumulative balance as of the period end.
 *
 * One value column ("p0") for the selected range plus a Total column that
 * equals it — the report shows exactly what a Trial Balance for that date
 * range shows. `period: 'yearly'` is kept in the payload because
 * BudgetSummaryViewer reads it.
 */

const { buildTrialBalance } = require('./zohoGlReportsService');
const { resolveRange } = require('./reportContext');

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function r2(n) {
  return Math.round(num(n) * 100) / 100;
}

// A clean Indian fiscal year (1 Apr → 31 Mar) → "Apr 2025-Mar 2026", otherwise
// a plain "1 Apr 2025 - 30 Jun 2025" window label.
function rangeLabel(from, to) {
  const s = new Date(from);
  const e = new Date(to);
  const cleanFY = s.getMonth() === 3 && s.getDate() === 1
    && e.getMonth() === 2 && e.getDate() === 31
    && e.getFullYear() === s.getFullYear() + 1;
  if (cleanFY) return `Apr ${s.getFullYear()}-Mar ${e.getFullYear()}`;
  const d = (x) => `${x.getDate()} ${MON[x.getMonth()]} ${x.getFullYear()}`;
  return `${d(s)} - ${d(e)}`;
}

// Section bucket for a Trial Balance account. Uses the raw classification codes
// the P&L / Balance Sheet builders key on (typeCode / groupRaw), falling back
// to the coarse `group` and the human `type` label.
function classify(acct) {
  const g = String(acct.groupRaw || acct.group || '').toLowerCase();
  const tc = String(acct.typeCode || '').toLowerCase();
  const t = String(acct.type || '').toLowerCase();

  if (tc === 'cost_of_goods_sold' || tc === 'cogs' || t.includes('cost of goods') || t.includes('cost of sales')) return 'cogs';
  if (g === 'other_income' || tc === 'other_income' || t.includes('other income')) return 'other_income';
  if (g === 'other_expense' || tc === 'other_expense' || t.includes('other expense') || t.includes('non operating')) return 'other_expense';
  if (g === 'income' || tc === 'income' || tc === 'revenue' || t.includes('income') || t.includes('revenue') || t.includes('sales') || t.includes('turnover')) return 'operating_income';
  if (g === 'expense' || t.includes('expense')) return 'operating_expense';
  if (g === 'asset') return 'asset';
  if (g === 'liability') return 'liability';
  if (g === 'equity') return 'equity';
  return null;
}

const INCOME_SECTIONS = new Set(['operating_income', 'other_income']);

// Value shown for one account. Trial Balance `closing` is debit-positive.
// Present income as positive revenue (flip the credit sign) so P&L subtotals
// match the Profit & Loss report; leave everything else debit-positive so
// Balance Sheet / Trial Balance rows tie out.
function actualValue(section, acct) {
  return INCOME_SECTIONS.has(section) ? r2(-num(acct.closing)) : r2(num(acct.closing));
}

const SECTION_LABELS = {
  operating_income:  'Trading Income',
  cogs:              'Cost of Sales',
  operating_expense: 'Operating Expenses',
  other_income:      'Other Income',
  other_expense:     'Non Operating Expense',
  asset:             'Assets',
  liability:         'Liabilities',
  equity:            'Equity',
};
const PL_ORDER = ['operating_income', 'cogs', 'operating_expense', 'other_income', 'other_expense'];
const BS_ORDER = ['asset', 'liability', 'equity'];

function emptyPayload(from, to, extra = {}) {
  return {
    columns: [{ key: 'label', label: '', align: 'left' }],
    rows: [],
    empty: true,
    period: 'yearly',
    meta: { title: 'Budget Summary - Overall Budget', from, to, source: 'trial-balance' },
    ...extra,
  };
}

async function buildBudgetSummary(userId, params = {}) {
  const { from, to } = resolveRange(params);

  // Single source of truth: the Trial Balance for this exact window.
  const tb = await buildTrialBalance(userId, {
    ...params,
    from_date: from,
    to_date: to,
    as_of_date: to,
  });

  if (!tb || tb._noLocalData) {
    return emptyPayload(from, to, {
      unavailable: true,
      emptyReason: 'unavailable',
      message: 'No accounting connection found. Connect Zoho, QuickBooks or Xero first.',
    });
  }
  const tbAccounts = Array.isArray(tb.accounts) ? tb.accounts : [];
  if (tbAccounts.length === 0) {
    return emptyPayload(from, to, {
      emptyReason: 'empty',
      message: 'No ledger activity for the selected period.',
    });
  }

  // Bucket accounts into sections.
  const bySection = new Map(); // section -> [{ name, value }]
  for (const a of tbAccounts) {
    const section = classify(a);
    if (!section) continue;
    const value = actualValue(section, a);
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push({ name: a.name || '(Unnamed)', value });
  }

  const COL = 'p0';
  const rows = [];

  const sectionSubtotal = (section) =>
    (bySection.get(section) || []).reduce((s, r) => s + r.value, 0);

  const pushSection = (section) => {
    const list = bySection.get(section);
    if (!list || list.length === 0) return 0;
    list.sort((x, y) => x.name.localeCompare(y.name));
    rows.push({ label: SECTION_LABELS[section], isHeader: true, level: 0 });
    for (const item of list) {
      rows.push({ label: item.name, level: 1, cells: { [COL]: r2(item.value), total: r2(item.value) } });
    }
    const sub = r2(sectionSubtotal(section));
    rows.push({
      label: `Total ${SECTION_LABELS[section]}`,
      isSubtotal: true, level: 0,
      cells: { [COL]: sub, total: sub },
    });
    rows.push({ label: '', level: 0 });
    return sub;
  };

  // ── Profit & Loss block ──
  const income = pushSection('operating_income');
  const cogs = pushSection('cogs');
  const gross = r2(income - cogs);
  if (bySection.has('operating_income') || bySection.has('cogs')) {
    rows.push({ label: 'Gross Profit', isSubtotal: true, level: 0, cells: { [COL]: gross, total: gross } });
    rows.push({ label: '', level: 0 });
  }
  const opex = pushSection('operating_expense');
  const otherInc = pushSection('other_income');
  const otherExp = pushSection('other_expense');
  const net = r2(gross - opex + otherInc - otherExp);
  const hasPL = PL_ORDER.some((s) => bySection.has(s));
  if (hasPL) {
    rows.push({ label: 'Net Profit', isTotal: true, level: 0, cells: { [COL]: net, total: net } });
    rows.push({ label: '', level: 0 });
  }

  // ── Balance Sheet block ──
  for (const section of BS_ORDER) pushSection(section);

  const label = rangeLabel(from, to);
  const columns = [
    { key: 'label', label: '', align: 'left' },
    { key: COL, label, align: 'right' },
    { key: 'total', label: 'Total', align: 'right' },
  ];

  return {
    columns,
    rows,
    currency: tb.currency || 'INR',
    budgetName: 'Overall Budget',
    period: 'yearly',
    meta: {
      title: 'Budget Summary - Overall Budget',
      basis: 'Accrual',
      from,
      to,
      source: 'trial-balance',
      reconcilesWith: ['trialbalance', 'balancesheet', 'profitandloss'],
      totalAccounts: tbAccounts.length,
    },
  };
}

module.exports = { buildBudgetSummary };
