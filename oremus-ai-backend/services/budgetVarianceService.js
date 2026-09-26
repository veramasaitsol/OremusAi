'use strict';

/**
 * Budget Variance report — modelled on Xero's Budget Variance.
 * ---------------------------------------------------------------------------
 * Xero's Budget Variance compares actuals against budget for the selected
 * period AND for the year-to-date, each as four columns:
 *
 *   <Period>  |  <Period> Overall Budget  |  Variance  |  Variance %
 *   <YTD>     |  <YTD> Overall Budget     |  Variance  |  Variance %
 *
 * laid out in the trading structure:
 *
 *   Trading Income     → Total Trading Income
 *   Cost of Sales      → Total Cost of Sales
 *   Gross Profit       (= Income − Cost of Sales)
 *   Operating Expenses → Total Operating Expenses
 *   Net Profit         (= Gross Profit − Operating Expenses)
 *
 * Variance  = Actual − Budget.
 * Variance% = Variance ÷ |Budget| × 100 (shown only when a budget exists).
 *
 * We have no separate budget store, so — exactly like the other ledger-derived
 * reports — actuals are computed from the synced general ledger
 * (`account_transactions`) and the budget columns are empty ("-"), which makes
 * Variance equal the actual and Variance% "-" (precisely what Xero shows for a
 * company with no budget loaded). When a budget source is added later, only
 * `budgetFor()` needs to return real figures.
 *
 * Year-to-date follows the org's financial year (Indian Apr–Mar), consistent
 * with every other ledger report here.
 *
 * Sign conventions (verified against the live data):
 *  - income accounts carry revenue as credit−debit;
 *  - cost-of-sales / expense accounts carry cost as debit−credit.
 *
 * Xero's true-up plugs (`transaction_id` `xero-recon:%`) are excluded, exactly as
 * the Profit and Loss excludes them. Those lines force each account's CUMULATIVE
 * balance to Xero's trial balance and are all dated the last ledger day, so left
 * in a period report they dump every prior year onto that period's accounts —
 * they turned this report's revenue into a large negative figure.
 */

const pool = require('../config/db');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function resolveOrgId(userId, params) {
  if (params.org_id) return params.org_id;
  const [[row]] = await pool.execute(
    'SELECT org_id FROM zb_tokens WHERE user_id = ?',
    [userId]
  );
  return row?.org_id || null;
}

function requireOrg(orgId) {
  if (!orgId) {
    const err = new Error('Zoho not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
}

// Selected period: default to the current Indian fiscal year when no dates are
// sent, mirroring the other ledger reports.
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

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Start of the fiscal year containing the given date, for the configured
// per-platform start month (Settings → params.fy_start_month; default 4 = April).
const { fiscalYearStart, fyMonth } = require('./reportContext');
function fyStartOf(dateStr, fyStartMonth = 4) {
  return fiscalYearStart(dateStr, fyMonth(fyStartMonth));
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

function classify(group, typeCode) {
  if (typeCode === 'cost_of_goods_sold') return { section: 'cos', sign: 'debit' };
  if (group === 'income') return { section: 'income', sign: 'credit' };
  if (group === 'expense') return { section: 'expense', sign: 'debit' };
  return null;
}

// Net per income/expense account over a window, signed positive for a normal
// balance. Accounts whose net is zero are dropped.
async function netsByAccount(userId, orgId, from, to) {
  const [accts] = await pool.execute(
    `SELECT account_id, account_name, account_group, account_type_code,
            SUM(COALESCE(base_debit, debit))  AS d,
            SUM(COALESCE(base_credit, credit)) AS c
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND transaction_date BETWEEN ? AND ?
        AND account_group IN ('income', 'expense')
        AND transaction_id NOT LIKE 'xero-recon:%'
      GROUP BY account_id, account_name, account_group, account_type_code`,
    [userId, orgId, from, to]
  );
  const map = new Map();
  for (const a of accts) {
    const cls = classify(a.account_group, a.account_type_code);
    if (!cls) continue;
    const net = cls.sign === 'credit' ? num(a.c) - num(a.d) : num(a.d) - num(a.c);
    if (net === 0) continue;
    map.set(a.account_id, { name: a.account_name, section: cls.section, net });
  }
  return map;
}

// Drill-down: the individual GL lines behind each account's actual, so a user
// can click a value and trace exactly how it was calculated (same feature added
// to the Executive Summary + Cash Summary). One query pulls every income/expense
// line over the widest window we report on, then each line is bucketed to the
// selected-period column ('cur') and/or the year-to-date column ('ytd') by date,
// per account. Amounts are the line's signed contribution to the account's net
// (income = credit−debit, cost/expense = debit−credit), so the entries sum to
// the value shown. Each bucket is sorted largest-first and capped.
function fmtDate(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return d ? String(d).slice(0, 10) : '';
}

function summariseBucket(list) {
  const sorted = list.slice().sort((a, b) => b.amount - a.amount);
  return {
    rows: sorted,
    count: sorted.length,
  };
}

// Map account_id → { cur: {rows,count,truncated}, ytd: {…} } of contributing lines.
async function breakdownLines(userId, orgId, from, to, ytdFrom) {
  const wideFrom = from < ytdFrom ? from : ytdFrom;
  const [lines] = await pool.execute(
    `SELECT account_id, account_group, account_type_code,
            transaction_date AS dt, reference_number AS ref, account_name AS account,
            source_type AS src, COALESCE(base_debit, debit) AS debit, COALESCE(base_credit, credit) AS credit
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
        AND transaction_date BETWEEN ? AND ?
        AND account_group IN ('income', 'expense')
        AND transaction_id NOT LIKE 'xero-recon:%'`,
    [userId, orgId, wideFrom, to]
  );
  const map = new Map();
  for (const l of lines) {
    const cls = classify(l.account_group, l.account_type_code);
    if (!cls) continue;
    const amt = cls.sign === 'credit' ? num(l.credit) - num(l.debit) : num(l.debit) - num(l.credit);
    if (amt === 0) continue;
    const dt = fmtDate(l.dt);
    const entry = { date: dt, ref: l.ref || '', account: l.account || '', source: l.src || '', amount: amt };
    if (!map.has(l.account_id)) map.set(l.account_id, { cur: [], ytd: [] });
    const b = map.get(l.account_id);
    if (dt >= from && dt <= to) b.cur.push(entry);
    if (dt >= ytdFrom && dt <= to) b.ytd.push(entry);
  }
  const out = new Map();
  for (const [id, b] of map) out.set(id, { cur: summariseBucket(b.cur), ytd: summariseBucket(b.ytd) });
  return out;
}

// Budget for an account/window. No budget store yet → 0 (renders as "-").
function budgetFor() {
  return 0;
}

// Variance % = (actual − budget) / |budget| × 100; "-" when there's no budget.
function pct(actual, budget) {
  if (!budget) return '-';
  return `${(((actual - budget) / Math.abs(budget)) * 100).toFixed(1)}%`;
}

async function buildBudgetVariance(userId, params = {}) {
  const orgId = await resolveOrgId(userId, params);
  requireOrg(orgId);

  const { from, to } = resolveRange(params);
  const ytdFrom = fyStartOf(to, params.fy_start_month);

  const periodMap = await netsByAccount(userId, orgId, from, to);
  const ytdMap = await netsByAccount(userId, orgId, ytdFrom, to);
  const bdMap = await breakdownLines(userId, orgId, from, to, ytdFrom);

  // Union of accounts seen in either window.
  const ids = new Set([...periodMap.keys(), ...ytdMap.keys()]);
  const accounts = [];
  for (const id of ids) {
    const meta = ytdMap.get(id) || periodMap.get(id);
    accounts.push({
      id,
      name: meta.name,
      section: meta.section,
      cur: periodMap.get(id)?.net || 0,
      ytd: ytdMap.get(id)?.net || 0,
    });
  }

  // Eight value columns: actual / budget / variance / variance% for the period,
  // then the same four for the year-to-date.
  const cells = (cur, ytd) => {
    const cb = budgetFor();
    const yb = budgetFor();
    const cVar = cur - cb;
    const yVar = ytd - yb;
    return {
      cur:        cur !== 0 ? cur : '-',
      curBudget:  cb !== 0 ? cb : '-',
      curVar:     cVar !== 0 ? cVar : '-',
      curVarPct:  pct(cur, cb),
      ytd:        ytd !== 0 ? ytd : '-',
      ytdBudget:  yb !== 0 ? yb : '-',
      ytdVar:     yVar !== 0 ? yVar : '-',
      ytdVarPct:  pct(ytd, yb),
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
    for (const a of leaves) {
      const leaf = { label: a.name, level: 1, cells: cells(a.cur, a.ytd) };
      const bd = bdMap.get(a.id);
      if (bd) {
        const b = {};
        if (bd.cur.count > 0) b.cur = bd.cur;
        if (bd.ytd.count > 0) b.ytd = bd.ytd;
        if (Object.keys(b).length) leaf.breakdowns = b;
      }
      rows.push(leaf);
    }
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
  // Column order mirrors Xero's Budget Variance export: Budget | Actuals |
  // Variance | Variance % for the selected period, then the same four for the
  // year-to-date. (Budget BEFORE Actuals — matches the Xero sheet layout.)
  const columns = [
    { key: 'label',     label: '',                        align: 'left'  },
    { key: 'curBudget', label: `Budget (${periodLabel})`,  align: 'right' },
    { key: 'cur',       label: `Actuals (${periodLabel})`, align: 'right' },
    { key: 'curVar',    label: 'Variance',                 align: 'right' },
    { key: 'curVarPct', label: 'Variance %',               align: 'right' },
    { key: 'ytdBudget', label: `Budget (${ytdLabel})`,     align: 'right' },
    { key: 'ytd',       label: `Actuals (${ytdLabel})`,    align: 'right' },
    { key: 'ytdVar',    label: 'Variance',                 align: 'right' },
    { key: 'ytdVarPct', label: 'Variance %',               align: 'right' },
  ];

  return {
    columns,
    rows,
    currency: 'INR',
    budgetName: 'Overall Budget',
    meta: {
      title: 'Budget Variance',
      basis: 'Accrual',
      from,
      to,
      ytdFrom,
      source: 'ledger',
      hasBreakdown: true,
    },
  };
}

module.exports = { buildBudgetVariance };
