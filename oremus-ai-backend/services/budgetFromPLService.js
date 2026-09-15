'use strict';

/**
 * Provider-agnostic Budget Variance builder.
 * ---------------------------------------------------------------------------
 * No provider exposes a dedicated Budget report in its JSON API, so Budget
 * Variance shows actuals — derived from the provider's Profit & Loss — against
 * an absent budget, which is precisely what these reports show for a company
 * with no budget loaded. Provide a provider-specific P&L fetcher and these
 * helpers emit the canonical payload the report viewers already render.
 *
 * Cell-key contract (BudgetVarianceViewer reads these EXACT keys, ignoring
 * `columns`): cells.cur / curBudget / ytd / ytdBudget.
 */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Default to the current Indian fiscal year (Apr–Mar) when no dates are sent,
// mirroring the rest of the report builders.
function resolveRange(params = {}) {
  const from = params.from_date || params.from || params.date_start || null;
  const to = params.to_date || params.to || params.date_end || null;
  if (from && to) return { from, to };
  // Default window: the fiscal year containing today, for the per-platform
  // start month (Settings → params.fy_start_month; defaults to 4 = 1 April).
  const { fyWindow, fyMonth } = require('./reportContext');
  const _fy = fyWindow(fyMonth(params.fy_start_month));
  return { from: from || _fy.from, to: to || _fy.to };
}

// Start of the Indian fiscal year (1 April) containing the given date.
function fyStartOf(dateStr) {
  const d = new Date(dateStr);
  const y = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-04-01`;
}

function monthSpan(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  return Math.max(1, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + 1);
}

// Human label for a window: single month → "Jun 2026", else "Apr-Jun 2026"
// (or spanning years → "Oct 2025-Mar 2026").
function labelFor(from, to) {
  const s = new Date(from);
  const e = new Date(to);
  if (monthSpan(from, to) === 1) return `${MON[s.getMonth()]} ${s.getFullYear()}`;
  if (s.getFullYear() === e.getFullYear()) return `${MON[s.getMonth()]}-${MON[e.getMonth()]} ${s.getFullYear()}`;
  return `${MON[s.getMonth()]} ${s.getFullYear()}-${MON[e.getMonth()]} ${e.getFullYear()}`;
}

// Map a P&L section header to one of our three trading buckets.
function sectionFromHeader(label) {
  const s = String(label || '').toLowerCase();
  if (s.includes('cost of sales') || s.includes('cost of goods')) return 'cos';
  if (s.includes('expense')) return 'expense';
  if (s.includes('income') || s.includes('revenue') || s.includes('turnover') || s.includes('sales')) return 'income';
  return null;
}

// Walk a P&L payload, calling cb(section, leafRow) for each ACCOUNT LEAF row.
// Section headers switch the active bucket; the provider's own totals/subtotals
// and computed profit lines (level 0) are skipped — we recompute those.
function eachLeaf(pl, cb) {
  let section = null;
  for (const row of pl.rows || []) {
    if (row.isHeader) {
      const s = sectionFromHeader(row.label);
      if (s) section = s;
      continue;
    }
    if (row.isTotal || row.isSubtotal) continue;
    if (!section || (row.level || 0) < 1) continue;
    cb(section, row);
  }
}

// ── Budget Variance ───────────────────────────────────────────────────────

// Sum a single-period P&L's account leaves into name → { name, section, value }.
// Reads the LAST value column (the period/total column) to avoid double-counting
// when a provider appends a Total column.
function leafNets(pl) {
  const valueKeys = (pl.columns || []).filter((c) => c.key !== 'label').map((c) => c.key);
  const valueKey = valueKeys[valueKeys.length - 1];
  const map = new Map();
  eachLeaf(pl, (section, row) => {
    const v = num(row.cells?.[valueKey]);
    if (v === 0) return;
    const prev = map.get(row.label);
    if (prev) prev.value += v;
    else map.set(row.label, { name: row.label, section, value: v });
  });
  return map;
}

// Build a Budget Variance from a selected-period P&L and a year-to-date P&L.
// With no budget store, budgets are 0 (render "-"), so Variance equals Actual
// and Variance% is "-" — exactly what these reports show with no budget loaded.
function budgetVarianceFromPL(periodPL, ytdPL, { from, to, ytdFrom }) {
  const periodMap = leafNets(periodPL);
  const ytdMap = leafNets(ytdPL);
  const ids = new Set([...periodMap.keys(), ...ytdMap.keys()]);
  const accounts = [];
  for (const id of ids) {
    const meta = ytdMap.get(id) || periodMap.get(id);
    accounts.push({
      name: meta.name,
      section: meta.section,
      cur: periodMap.get(id)?.value || 0,
      ytd: ytdMap.get(id)?.value || 0,
    });
  }

  const budgetFor = () => 0;
  const pct = (actual, budget) => (!budget ? '-' : `${(((actual - budget) / Math.abs(budget)) * 100).toFixed(1)}%`);
  const cells = (cur, ytd) => {
    const cb = budgetFor();
    const yb = budgetFor();
    const cVar = cur - cb;
    const yVar = ytd - yb;
    return {
      cur: cur !== 0 ? cur : '-',
      curBudget: cb !== 0 ? cb : '-',
      curVar: cVar !== 0 ? cVar : '-',
      curVarPct: pct(cur, cb),
      ytd: ytd !== 0 ? ytd : '-',
      ytdBudget: yb !== 0 ? yb : '-',
      ytdVar: yVar !== 0 ? yVar : '-',
      ytdVarPct: pct(ytd, yb),
    };
  };

  const sectionTotal = (section) => {
    let cur = 0;
    let ytd = 0;
    for (const a of accounts) {
      if (a.section !== section) continue;
      cur += a.cur;
      ytd += a.ytd;
    }
    return { cur, ytd };
  };

  const rows = [];
  const pushSection = (section, headerLabel, totalLabel) => {
    const leaves = accounts.filter((a) => a.section === section);
    if (leaves.length === 0) return { cur: 0, ytd: 0 };
    leaves.sort((a, b) => a.name.localeCompare(b.name));
    rows.push({ label: headerLabel, isHeader: true, level: 0 });
    for (const a of leaves) rows.push({ label: a.name, level: 1, cells: cells(a.cur, a.ytd) });
    const tot = sectionTotal(section);
    rows.push({ label: totalLabel, isSubtotal: true, level: 0, cells: cells(tot.cur, tot.ytd) });
    return tot;
  };

  const income = pushSection('income', 'Trading Income', 'Total Trading Income');
  const cos = pushSection('cos', 'Cost of Sales', 'Total Cost of Sales');
  const gross = { cur: income.cur - cos.cur, ytd: income.ytd - cos.ytd };
  rows.push({ label: 'Gross Profit', isSubtotal: true, level: 0, cells: cells(gross.cur, gross.ytd) });
  const expense = pushSection('expense', 'Operating Expenses', 'Total Operating Expenses');
  const net = { cur: gross.cur - expense.cur, ytd: gross.ytd - expense.ytd };
  rows.push({ label: 'Net Profit', isTotal: true, level: 0, cells: cells(net.cur, net.ytd) });

  const periodLabel = labelFor(from, to);
  const ytdLabel = labelFor(ytdFrom, to);
  const columns = [
    { key: 'label', label: '', align: 'left' },
    { key: 'cur', label: periodLabel, align: 'right' },
    { key: 'curBudget', label: `${periodLabel} Overall Budget`, align: 'right' },
    { key: 'curVar', label: 'Variance', align: 'right' },
    { key: 'curVarPct', label: 'Variance %', align: 'right' },
    { key: 'ytd', label: ytdLabel, align: 'right' },
    { key: 'ytdBudget', label: `${ytdLabel} Overall Budget`, align: 'right' },
    { key: 'ytdVar', label: 'Variance', align: 'right' },
    { key: 'ytdVarPct', label: 'Variance %', align: 'right' },
  ];

  return {
    columns,
    rows,
    currency: periodPL.currency || ytdPL.currency || 'USD',
    budgetName: 'Overall Budget',
    meta: { title: 'Budget Variance', basis: 'Accrual', from, to, ytdFrom, source: 'pnl' },
  };
}

module.exports = {
  resolveRange,
  fyStartOf,
  budgetVarianceFromPL,
};
