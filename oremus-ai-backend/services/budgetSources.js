'use strict';

/**
 * How each platform's API describes a budget, turned into the one shape
 * budgetsStore keeps. Pure functions — the platform sync steps fetch, these
 * normalize:
 *
 *   budget { id, name, type, entryPeriod, startDate, endDate, status, scope, updatedAt }
 *   line   { accountId, accountCode, accountName, dimensionKey, dimensionLabel,
 *            period (YYYY-MM-01), amount, notes }
 *
 * Xero        GET /Budgets, GET /Budgets/{id}?DateFrom&DateTo — monthly
 *             BudgetBalances per account; a tracking budget is its own budget.
 * QuickBooks  SELECT * FROM Budget — BudgetDetail[] { BudgetDate, Amount,
 *             AccountRef, ClassRef | DepartmentRef | CustomerRef } in the
 *             budget's entry period (Monthly / Quarterly / Yearly); a
 *             subdivided budget has one detail per class / location / customer.
 * Zoho Books  no budgets endpoint; GET /registers/{account_id}/budgetvsactuals
 *             lists the org's budgets (budget_info_list) and, with budget_id,
 *             returns that account's figures per period
 *             (detailed_budget_vs_actual). Zoho doesn't document the fields of
 *             a period entry, so they are recognised by name and a response
 *             that doesn't match is reported instead of being guessed at.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const isNumeric = (v) => (typeof v === 'number' && Number.isFinite(v))
  || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/,/g, ''))));
const pad = (n) => String(n).padStart(2, '0');

/** Any date form a platform sends → first day of its month (YYYY-MM-01), or null. */
function toMonth(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const ms = s.match(/^\/Date\((-?\d+)/);
  if (ms) {
    const d = new Date(Number(ms[1]));
    return Number.isNaN(d.getTime()) ? null : `${d.toISOString().slice(0, 7)}-01`;
  }
  const ym = s.match(/^(\d{4})-(\d{2})/);
  if (ym) return `${ym[1]}-${ym[2]}-01`;
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); // dd/mm/yyyy (Zoho India)
  if (dmy) return `${dmy[3]}-${pad(dmy[2])}-01`;
  const named = s.match(/^([A-Za-z]{3,9})[\s,-]+(?:\d{1,2}[\s,]+)?(\d{4})/); // "Apr 2025", "April-2025"
  if (named) {
    const m = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase());
    if (m >= 0) return `${named[2]}-${pad(m + 1)}-01`;
  }
  return null;
}

const lastDayOf = (month) => {
  const [y, m] = month.split('-').map(Number);
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
};

// Xero "/Date(1573755038314+0000)/" or ISO → DATETIME string, else null.
function toDateTime(v) {
  if (!v) return null;
  const s = String(v);
  const ms = s.match(/^\/Date\((-?\d+)/);
  const d = ms ? new Date(Number(ms[1])) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
}

// A budget with no dates of its own spans the months it has amounts for.
function withRange(budget, lines) {
  if (budget.startDate && budget.endDate) return budget;
  const months = (lines || []).map((l) => l.period).filter(Boolean).sort();
  if (!months.length) return budget;
  return { ...budget, startDate: budget.startDate || months[0], endDate: budget.endDate || lastDayOf(months[months.length - 1]) };
}

// ── Xero ─────────────────────────────────────────────────────────────────────
/**
 * @param {object[]} list  GET /Budgets → Budgets[]
 * @param {Map<string, object[]|null>} detailLines  BudgetID → BudgetLines merged
 *        across the date windows fetched, or null when they couldn't be fetched
 */
function normalizeXeroBudgets(list, detailLines) {
  const budgets = [];
  const linesById = new Map();
  for (const b of list || []) {
    const id = String(b.BudgetID || '');
    if (!id) continue;
    const raw = detailLines.get(id);
    let lines = null;
    if (Array.isArray(raw)) {
      lines = [];
      for (const line of raw) {
        const accountId = line.AccountID || (line.AccountCode ? `code:${line.AccountCode}` : null);
        if (!accountId) continue;
        for (const bal of line.BudgetBalances || []) {
          // Amount is the budgeted figure; UnitAmount only a fallback.
          const amount = bal.Amount != null && bal.Amount !== '' ? num(bal.Amount) : num(bal.UnitAmount);
          lines.push({ accountId, accountCode: line.AccountCode || null, period: toMonth(bal.Period), amount, notes: bal.Notes || null });
        }
      }
    }
    budgets.push(withRange({
      id,
      name: b.Description || (b.Type === 'OVERALL' ? 'Overall Budget' : 'Budget'),
      type: b.Type || null,
      entryPeriod: 'monthly',
      status: b.Status || null,
      scope: Array.isArray(b.Tracking) && b.Tracking.length ? b.Tracking : null,
      updatedAt: toDateTime(b.UpdatedDateUTC),
    }, lines));
    linesById.set(id, lines);
  }
  return { budgets, linesById };
}

// ── QuickBooks ───────────────────────────────────────────────────────────────
const QBO_ENTRY = { monthly: 'monthly', quarterly: 'quarterly', yearly: 'yearly', annually: 'yearly' };
const QBO_DIMENSIONS = [['ClassRef', 'class', 'Class'], ['DepartmentRef', 'location', 'Location'], ['CustomerRef', 'customer', 'Customer']];

/** @param {object[]} list  SELECT * FROM Budget → Budget[] */
function normalizeQboBudgets(list) {
  const budgets = [];
  const linesById = new Map();
  for (const b of list || []) {
    const id = String(b.Id || '');
    if (!id) continue;
    const lines = [];
    for (const d of b.BudgetDetail || []) {
      const account = d.AccountRef;
      if (!account?.value) continue;
      const dims = QBO_DIMENSIONS.filter(([k]) => d[k]?.value);
      lines.push({
        accountId: String(account.value),
        accountName: account.name || null,
        dimensionKey: dims.map(([k, key]) => `${key}:${d[k].value}`).join('|'),
        dimensionLabel: dims.map(([k, , label]) => `${label}: ${d[k].name || d[k].value}`).join(', ') || null,
        period: toMonth(d.BudgetDate),
        amount: num(d.Amount),
      });
    }
    budgets.push(withRange({
      id,
      name: b.Name || 'Budget',
      type: b.BudgetType || null,
      entryPeriod: QBO_ENTRY[String(b.BudgetEntryType || '').toLowerCase()] || 'monthly',
      startDate: b.StartDate ? String(b.StartDate).slice(0, 10) : null,
      endDate: b.EndDate ? String(b.EndDate).slice(0, 10) : null,
      status: b.Active === false ? 'INACTIVE' : 'ACTIVE',
      updatedAt: toDateTime(b.MetaData?.LastUpdatedTime),
    }, lines));
    linesById.set(id, lines);
  }
  return { budgets, linesById };
}

// ── Zoho Books ───────────────────────────────────────────────────────────────
const ZOHO_BUDGET_KEYS = ['budget_amount', 'budgeted_amount', 'budget', 'budget_value', 'budgetamount'];
const ZOHO_DATE_KEYS = ['from_date', 'start_date', 'period_start_date', 'begin_date', 'date'];
const ZOHO_LABEL_KEYS = ['period', 'period_name', 'label', 'month', 'name', 'date_range'];
const ZOHO_PERIOD_MONTHS = { monthly: 1, quarterly: 3, 'half-yearly': 6, yearly: 12 };

/** The org's budgets from any budgetvsactuals response. */
function zohoBudgetList(response) {
  const list = response?.register_budget_vs_actual?.budget_info_list || [];
  return list
    .filter((b) => b && b.budget_id)
    .map((b) => ({ id: String(b.budget_id), name: b.budget_name || 'Budget' }));
}

function zohoBudgetValue(item) {
  const pick = (v) => {
    if (isNumeric(v)) return Number(String(v).replace(/,/g, ''));
    if (v && typeof v === 'object') {
      for (const k of ['amount', 'value', 'total']) if (isNumeric(v[k])) return Number(String(v[k]).replace(/,/g, ''));
    }
    return null;
  };
  for (const k of ZOHO_BUDGET_KEYS) {
    const v = pick(item[k]);
    if (v != null) return v;
  }
  for (const [k, raw] of Object.entries(item)) {
    if (!/^budget/i.test(k) || /(_id|_name|formatted|percent|percentage|info)$/i.test(k)) continue;
    const v = pick(raw);
    if (v != null) return v;
  }
  return null;
}

function zohoItemMonth(item) {
  for (const k of ZOHO_DATE_KEYS) { const m = toMonth(item[k]); if (m) return m; }
  for (const k of ZOHO_LABEL_KEYS) { const m = toMonth(item[k]); if (m) return m; }
  return null;
}

/**
 * One account's budget amounts from GET /registers/{id}/budgetvsactuals with a
 * budget_id. Period entries are matched to months by their own date / label,
 * else by position from the requested `from` month in `period` steps.
 * @returns {{ lines: object[], recognized: boolean, sampleKeys?: string[] }}
 */
function normalizeZohoBudgetAccount(response, { accountId, accountCode = null, accountName = null, from, period = 'monthly' }) {
  const items = response?.register_budget_vs_actual?.budget_vs_actuals?.detailed_budget_vs_actual || [];
  const list = Array.isArray(items) ? items.filter((x) => x && typeof x === 'object') : [];
  if (!list.length) return { lines: [], recognized: true };
  if (zohoBudgetValue(list[0]) == null) return { lines: [], recognized: false, sampleKeys: Object.keys(list[0]) };

  const step = ZOHO_PERIOD_MONTHS[period] || 1;
  const start = toMonth(from);
  const lines = [];
  list.forEach((item, i) => {
    let month = zohoItemMonth(item);
    if (!month && start) {
      const [y, m] = start.split('-').map(Number);
      const idx = y * 12 + (m - 1) + i * step;
      month = `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}-01`;
    }
    const amount = zohoBudgetValue(item);
    if (!month || amount == null) return;
    lines.push({ accountId: String(accountId), accountCode, accountName, period: month, amount });
  });
  return { lines, recognized: true };
}

module.exports = {
  toMonth,
  withRange,
  normalizeXeroBudgets,
  normalizeQboBudgets,
  zohoBudgetList,
  normalizeZohoBudgetAccount,
};
