'use strict';

/**
 * Cash Summary report — modelled on Xero's Cash Summary.
 * ---------------------------------------------------------------------------
 * A cash-basis report: actual money received vs paid over the period, plus the
 * opening and closing cash position. Built ENTIRELY from the shared GL
 * (`account_transactions`) so it works identically for Zoho / QuickBooks /
 * Xero and never spends a provider's API quota.
 *
 * How each figure is derived (cash-basis, every rupee traceable) — see the
 * `breakdown` array attached to each value row for the exact contributing
 * transactions:
 *
 *   A "cash movement" is any GL line posted to a cash account
 *   (account_type_code IN ('bank','cash') — for Xero this also covers the
 *   synthetic "Xero Payments Clearing" account, which is typed 'bank').
 *     • A DEBIT to a cash account is money IN  (received).
 *     • A CREDIT to a cash account is money OUT (spent).
 *
 *   Each cash movement is attributed to the P&L / settled account on the OTHER
 *   side of its source document (linked by source_id):
 *     • Money IN  → the income account(s) of the invoice being paid, split by
 *       each income line's share. (Verified: 100% of receipts map to income.)
 *     • Money OUT → the expense account(s) of the bill being paid; when the
 *       payment settles a payable/provision directly (e.g. Salaries Payable),
 *       it is attributed to that settled account. (100% of spend is allocated.)
 *
 * Layout (matches Xero):
 *   Income              (cash received, by account) → Total Income
 *   Less Expenses       (cash paid, by account)     → Total Expenses
 *   Surplus (Deficit)   (= Income − Expenses)
 *   Net Cash Movement   (= Surplus)
 *   Summary
 *     Opening Balance   (cumulative cash before the period)
 *     Cash Balance      (= Opening Balance + Net Cash Movement)
 *
 * "Compare with: Average" gives three columns:
 *   <period> | Average (YTD) | Variance   (avg = period/months, var = period−avg)
 */

const pool = require('../config/db');

// Xero Trial-Balance true-up rows ('xero-recon:%') are a cumulative
// balance-sheet plug, not real cash activity. They must be excluded from the
// PERIOD movement (else a giant fake receipt appears as "Unallocated" income),
// but kept in the opening/closing BALANCE so the Cash Balance still ties to
// Xero. No-op for Zoho/QuickBooks (they have zero such rows).
const EXCLUDE_RECON = "AND transaction_id NOT LIKE 'xero-recon:%'";
// "Xero Payments Clearing" (typed 'bank') is an internal transit account — an
// invoice debits it, the matching /Payments credits it into the real bank, so it
// nets to zero. Counting its lines would double every settled receipt/payment
// and leave un-attributable movements, so it's excluded from every cash query.
const EXCLUDE_CLEARING =
  "AND account_id <> 'XERO-CLEARING' AND account_name NOT LIKE '%Xero Payments Clearing%'";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Scope a report to a specific platform when the caller passes one (QB/Xero
// providers do). Absent → org_id scoping alone (identical to the old behavior).
function resolvePlatform(params) {
  return params.platform ? String(params.platform).toLowerCase() : null;
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

function monthSpan(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  return Math.max(1, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + 1);
}

function labelFor(from, to) {
  const s = new Date(from);
  const e = new Date(to);
  if (monthSpan(from, to) === 1) return `${MON[s.getMonth()]} ${s.getFullYear()}`;
  if (s.getFullYear() === e.getFullYear()) return `${MON[s.getMonth()]}-${MON[e.getMonth()]} ${s.getFullYear()}`;
  return `${MON[s.getMonth()]} ${s.getFullYear()}-${MON[e.getMonth()]} ${e.getFullYear()}`;
}

function buildBreakdownGroups(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const label = entry.source || 'Unspecified cash account';
    let group = groups.get(label);
    if (!group) {
      group = { label, amount: 0, transactions: [] };
      groups.set(label, group);
    }
    group.amount += num(entry.amount);
    group.transactions.push(entry);
  }
  return [...groups.values()]
    .map((g) => {
      const transactions = [...g.transactions]
        .sort((a, b) => num(b.amount) - num(a.amount))
        .map((t) => ({ ...t, amount: round2(t.amount) }));
      return {
        label: g.label,
        amount: round2(g.amount),
        transactions,
        transactionCount: g.transactions.length,
        transactionTruncated: false,
      };
    })
    .sort((a, b) => b.amount - a.amount);
}

async function buildCashSummary(userId, params = {}) {
  const orgId = await resolveOrgId(userId, params);
  requireOrg(orgId);
  const platform = resolvePlatform(params);
  const { from, to } = resolveRange(params);
  const months = monthSpan(from, to);

  const platClause = platform ? ' AND platform = ?' : '';
  const scope = platform ? [userId, orgId, platform] : [userId, orgId];

  // 1) Every cash movement in the period (a GL line on a bank/cash account).
  const [cashLines] = await pool.execute(
    `SELECT transaction_id, source_id, transaction_date AS dt,
            reference_number AS ref, account_name AS cash_account,
            COALESCE(base_debit, debit) AS debit, COALESCE(base_credit, credit) AS credit
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?${platClause}
        AND transaction_date BETWEEN ? AND ?
        AND account_type_code IN ('bank', 'cash')
        ${EXCLUDE_RECON}
        ${EXCLUDE_CLEARING}`,
    [...scope, from, to]
  );

  // 2) The non-cash lines of the source documents those movements belong to,
  //    so each movement can be attributed to its income / expense account.
  const sourceIds = [...new Set(cashLines.map((c) => c.source_id).filter((s) => s != null))];
  const counterpartsBySource = {};
  if (sourceIds.length) {
    const [cp] = await pool.query(
      `SELECT source_id, account_name, account_group,
              COALESCE(base_debit, debit) AS debit, COALESCE(base_credit, credit) AS credit
         FROM account_transactions
        WHERE user_id = ? AND org_id = ?${platClause}
          AND account_type_code NOT IN ('bank', 'cash')
          AND source_id IN (?)`,
      platform ? [userId, orgId, platform, sourceIds] : [userId, orgId, sourceIds]
    );
    for (const r of cp) (counterpartsBySource[r.source_id] ||= []).push(r);
  }

  const isIncome = (g) => /income/.test(g || '');
  const isExpense = (g) => /expense/.test(g || '');

  // Accumulators keyed by account name; each holds the running total and the
  // list of contributing cash movements (the drill-down "breakdown").
  const income = new Map();
  const expenses = new Map();
  const add = (bucket, name, amount, contrib) => {
    let e = bucket.get(name);
    if (!e) { e = { label: name, amount: 0, breakdown: [] }; bucket.set(name, e); }
    e.amount += amount;
    e.breakdown.push(contrib);
  };

  for (const c of cashLines) {
    const lines = counterpartsBySource[c.source_id] || [];
    const inflow = num(c.debit);
    const outflow = num(c.credit);
    const date = c.dt instanceof Date ? c.dt.toISOString().slice(0, 10) : String(c.dt).slice(0, 10);

    if (inflow > 0) {
      // Prefer the invoice's income lines; else fall back to any credit-side
      // counterpart (e.g. capital introduced). Split the receipt by share.
      let targets = lines.filter((l) => isIncome(l.account_group) && num(l.credit) > 0);
      if (!targets.length) targets = lines.filter((l) => num(l.credit) > 0);
      distribute(income, targets, 'credit', inflow, c, date);
    }
    if (outflow > 0) {
      // Prefer the bill's expense lines; else fall back to the settled account
      // (payable/provision). Split the payment by share.
      let targets = lines.filter((l) => isExpense(l.account_group) && num(l.debit) > 0);
      if (!targets.length) targets = lines.filter((l) => num(l.debit) > 0);
      distribute(expenses, targets, 'debit', outflow, c, date);
    }
  }

  function distribute(bucket, targets, sideKey, cashAmount, c, date) {
    const base = targets.reduce((s, t) => s + num(t[sideKey]), 0);
    if (base <= 0 || !targets.length) {
      add(bucket, 'Unallocated', cashAmount, { date, ref: c.ref || null, source: c.cash_account || null, amount: cashAmount });
      return;
    }
    for (const t of targets) {
      const share = num(t[sideKey]) / base;
      const amt = cashAmount * share;
      if (amt === 0) continue;
      add(bucket, t.account_name || 'Unnamed account', amt, {
        date, ref: c.ref || null, source: c.cash_account || null, amount: amt,
      });
    }
  }

  // Sort each section by size, round, and trim the breakdown to the top N.
  const finalize = (bucket) =>
    [...bucket.values()]
      .map((e) => {
        e.amount = round2(e.amount);
        e.breakdown.sort((a, b) => b.amount - a.amount);
        const count = e.breakdown.length;
        e.breakdownGroups = buildBreakdownGroups(e.breakdown);
        e.breakdown = e.breakdown.map((b) => ({ ...b, amount: round2(b.amount) }));
        e.breakdownCount = count;
        e.breakdownTruncated = false;
        return e;
      })
      .filter((e) => e.amount !== 0)
      .sort((a, b) => b.amount - a.amount);

  const incomeRows = finalize(income);
  const expenseRows = finalize(expenses);
  const totalIncome = round2(incomeRows.reduce((s, r) => s + r.amount, 0));
  const totalExpenses = round2(expenseRows.reduce((s, r) => s + r.amount, 0));
  const surplus = round2(totalIncome - totalExpenses);
  const netMovement = surplus;

  // Opening cash = cumulative net of cash-account movements before the period.
  // (Balance figure → recon plugs stay in, so it ties to Xero.)
  const [[openRow]] = await pool.execute(
    `SELECT SUM(COALESCE(base_debit, debit)) - SUM(COALESCE(base_credit, credit)) AS net
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?${platClause}
        AND transaction_date < ?
        AND account_type_code IN ('bank', 'cash')
        ${EXCLUDE_CLEARING}`,
    [...scope, from]
  );
  const opening = round2(num(openRow?.net));
  // Recon plugs dated inside the window are excluded from netMovement above (so
  // they don't distort the income/expense categories), but the Cash Balance is
  // a BALANCE and must still tie to Xero — add their net cash effect back here.
  const [[reconRow]] = await pool.execute(
    `SELECT SUM(COALESCE(base_debit, debit)) - SUM(COALESCE(base_credit, credit)) AS net
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?${platClause}
        AND transaction_date BETWEEN ? AND ?
        AND account_type_code IN ('bank', 'cash')
        AND transaction_id LIKE 'xero-recon:%'
        ${EXCLUDE_CLEARING}`,
    [...scope, from, to]
  );
  const reconInWindow = round2(num(reconRow?.net));
  const closing = round2(opening + netMovement + reconInWindow);

  // Each value row: the period figure, its monthly average, and the variance.
  const cells = (v) => {
    const avg = v / months;
    const variance = v - avg;
    return {
      cur: v !== 0 ? v : null,
      avg: avg !== 0 ? avg : null,
      var: variance !== 0 ? variance : null,
    };
  };

  const rows = [];

  rows.push({ label: 'Income', isHeader: true, level: 0 });
  for (const r of incomeRows) {
    rows.push({
      label: r.label,
      level: 1,
      cells: cells(r.amount),
      breakdown: r.breakdown,
      breakdownGroups: r.breakdownGroups,
      breakdownCount: r.breakdownCount,
      breakdownTruncated: r.breakdownTruncated,
    });
  }
  rows.push({ label: 'Total Income', isSubtotal: true, level: 0, cells: cells(totalIncome) });

  rows.push({ label: 'Less Expenses', isHeader: true, level: 0 });
  for (const r of expenseRows) {
    rows.push({
      label: r.label,
      level: 1,
      cells: cells(r.amount),
      breakdown: r.breakdown,
      breakdownGroups: r.breakdownGroups,
      breakdownCount: r.breakdownCount,
      breakdownTruncated: r.breakdownTruncated,
    });
  }
  rows.push({ label: 'Total Expenses', isSubtotal: true, level: 0, cells: cells(totalExpenses) });

  rows.push({ label: 'Surplus (Deficit)', isSubtotal: true, level: 0, cells: cells(surplus) });
  rows.push({ label: 'Net Cash Movement', isSubtotal: true, level: 0, cells: cells(netMovement) });

  rows.push({ label: 'Summary', isHeader: true, level: 0 });
  rows.push({ label: 'Opening Balance', isSubtotal: true, level: 1, cells: cells(opening) });
  rows.push({ label: 'Cash Balance', isTotal: true, level: 1, cells: cells(closing) });

  const rangeLabel = labelFor(from, to);
  return {
    columns: [
      { key: 'label', label: '',              align: 'left'  },
      { key: 'cur',   label: rangeLabel,      align: 'right' },
      { key: 'avg',   label: 'Average (YTD)', align: 'right' },
      { key: 'var',   label: 'Variance',      align: 'right' },
    ],
    rows,
    currency: 'INR',
    meta: { title: 'Cash Summary', basis: 'Cash', from, to, source: 'ledger', hasBreakdown: true },
  };
}

function round2(v) {
  return Math.round((num(v) + Number.EPSILON) * 100) / 100;
}

module.exports = { buildCashSummary };
