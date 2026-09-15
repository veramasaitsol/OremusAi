'use strict';

/**
 * Shared report context — the ONE place date ranges, as-of dates, accounting
 * basis, interval / compare columns, the active org and the platform are
 * resolved from a report request's query params.
 * -------------------------------------------------------------------------
 * Historically each of the ~34 report builders re-implemented its own
 * `resolveRange` / `from_date` parsing, so the same filter behaved differently
 * per report. Builders should call `resolveReportContext()` (or the individual
 * helpers) instead, so every report filters the local ledger the same way.
 *
 * Nothing here calls a provider API — it only reads our own tables to resolve
 * which org a request is scoped to. Pure functions take their inputs as args so
 * they stay unit-testable without a database.
 */

const defaultPool = require('../config/db');

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

function isValidDay(s) {
  return typeof s === 'string' && ISO_DAY.test(s) && !Number.isNaN(Date.parse(s.slice(0, 10)));
}
function day(s) {
  return String(s).slice(0, 10);
}

// Fiscal-year start month (1..12). Defaults to 4 (Indian FY, 1 April) so every
// existing caller behaves exactly as before; the Settings feature threads a
// per-platform month in via `params.fy_start_month`.
function fyMonth(m) {
  const n = Number(m);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 4;
}

// Start of the fiscal year that contains `date` (Date | ISO), for the given
// start month — e.g. month 4 on 2026-02-10 → "2025-04-01"; month 1 → "2026-01-01".
function fiscalYearStart(date = new Date(), fyStartMonth = 4) {
  const d = date instanceof Date ? date : new Date(date);
  const m = fyMonth(fyStartMonth);
  const y = (d.getMonth() + 1) >= m ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String(m).padStart(2, '0')}-01`;
}
// End of that fiscal year (day before the start month, one year on). Month 1
// (calendar-year FY) ends 31 Dec of the same year.
function fiscalYearEnd(date = new Date(), fyStartMonth = 4) {
  const m = fyMonth(fyStartMonth);
  const startY = Number(fiscalYearStart(date, m).slice(0, 4));
  if (m === 1) return `${startY}-12-31`;
  const endMonth = m - 1;            // 1..11
  const endY = startY + 1;
  const lastDay = new Date(endY, endMonth, 0).getDate(); // last day of month `endMonth`
  return `${endY}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}
// { from, to } for the fiscal year containing `anchor`.
function fyWindow(fyStartMonth = 4, anchor = new Date()) {
  return { from: fiscalYearStart(anchor, fyStartMonth), to: fiscalYearEnd(anchor, fyStartMonth) };
}

// The last `count` fiscal years (containing `anchor`, then going back),
// oldest first — e.g. count=3, fyStartMonth=4, anchor in FY26 →
// [{FY24}, {FY25}, {FY26}]. Label uses the FY's ending year (the convention
// every platform and the existing report labels already use), so it moves
// correctly with whatever start month the client/admin has configured —
// nothing here assumes April.
function fyWindowsBack(fyStartMonth = 4, count = 3, anchor = new Date()) {
  const n = Math.max(1, parseInt(count, 10) || 1);
  const windows = [];
  for (let i = n - 1; i >= 0; i--) {
    const shifted = new Date(anchor);
    shifted.setFullYear(shifted.getFullYear() - i);
    const { from, to } = fyWindow(fyStartMonth, shifted);
    windows.push({ from, to, label: `FY${to.slice(2, 4)}` });
  }
  return windows;
}

/**
 * Period window for range reports (P&L, GL, Cash Flow, …).
 * Accepts from_date/from/date_start and to_date/to/date_end. When neither bound
 * is given, defaults to the current fiscal year (start month from
 * `params.fy_start_month`, else April). A one-sided range keeps the given bound
 * and fills the other from the same fiscal year.
 */
function resolveRange(params = {}) {
  let from = params.from_date || params.from || params.date_start || null;
  let to   = params.to_date   || params.to   || params.date_end   || null;
  if (from && !isValidDay(from)) from = null;
  if (to && !isValidDay(to)) to = null;
  if (from && to) return { from: day(from), to: day(to) };
  const anchor = from || to || new Date();
  const fyM = fyMonth(params.fy_start_month);
  return {
    from: from ? day(from) : fiscalYearStart(anchor, fyM),
    to:   to   ? day(to)   : fiscalYearEnd(anchor, fyM),
  };
}

/**
 * As-of date for cumulative reports (Balance Sheet, Trial Balance, aging).
 * Explicit as_of_date wins, else the period's To bound, else today.
 */
function resolveAsOf(params = {}) {
  const cand = params.as_of_date || params.to_date || params.to || params.date_end;
  return isValidDay(cand) ? day(cand) : new Date().toISOString().slice(0, 10);
}

/** Accounting basis: 'cash' | 'accrual' (default accrual). */
function resolveBasis(params = {}) {
  const raw = String(
    params.accounting_basis || params.basis || params.cash_basis || params.cash_based || ''
  ).toLowerCase();
  if (raw === 'cash' || raw === '1' || raw === 'true') return 'cash';
  return 'accrual';
}

/** "Display columns by" interval: 'none' | 'month' | 'quarter' | 'year'. */
function resolveInterval(params = {}) {
  const raw = String(params.interval || params.interval_type || 'none').toLowerCase();
  if (['month', 'monthly', 'months'].includes(raw)) return 'month';
  if (['quarter', 'quarterly', 'quarters'].includes(raw)) return 'quarter';
  if (['year', 'yearly', 'years', 'fy'].includes(raw)) return 'year';
  return 'none';
}

/** Budget Summary column mode: 'yearly' | 'monthly'. */
function resolvePeriod(params = {}) {
  return String(params.period || 'yearly').toLowerCase() === 'monthly' ? 'monthly' : 'yearly';
}

/**
 * "Compare with" config → { mode: 'period'|'year'|null, count, oldestFirst }.
 * `compare` = 'period' | 'year'; `compare_count` = number of extra columns.
 */
function resolveCompare(params = {}) {
  const modeRaw = String(params.compare || params.compare_with || '').toLowerCase();
  let mode = null;
  if (['period', 'previous_period', 'prev', 'previousperiod'].includes(modeRaw)) mode = 'period';
  else if (['year', 'previous_year', 'previousyear', 'fy'].includes(modeRaw)) mode = 'year';
  const count = Math.max(0, parseInt(params.compare_count, 10) || 0);
  if (!mode || count < 1) return { mode: null, count: 0, oldestFirst: false };
  const oldestFirst = params.oldest_first === '1' || params.oldest_first === 'true' || params.oldest_first === true;
  return { mode, count, oldestFirst };
}

/** Lowercase provider tag matching account_transactions.platform, or null. */
function resolvePlatform(params = {}) {
  const p = params.platform ? String(params.platform).toLowerCase() : null;
  return ['zoho', 'quickbooks', 'xero'].includes(p) ? p : null;
}

/**
 * Active org for the request. An explicit params.org_id (from the X-Org-Id
 * switcher, injected by the route) wins. Otherwise fall back to the active
 * connection pointer for whichever provider the user has:
 *   Zoho → zb_tokens.org_id
 *   QuickBooks → the qbo_tokens row flagged is_active (or the only row)
 *   Xero → xero_tokens.active_tenant_id (or tenant_id)
 * Order mirrors the dashboard's provider precedence.
 */
async function resolveOrgId(userId, params = {}, pool = defaultPool) {
  if (params.org_id) return String(params.org_id);
  if (!userId) return null;

  const [[zb]] = await pool.execute(
    'SELECT org_id FROM zb_tokens WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1',
    [userId]
  );
  if (zb?.org_id) return String(zb.org_id);

  // qbo_tokens may be single-row (legacy) or multi-row keyed (user_id, realm_id)
  // with an is_active flag once the multi-org migration has run — COALESCE keeps
  // this correct on both shapes.
  try {
    const [[qt]] = await pool.execute(
      `SELECT realm_id FROM qbo_tokens
        WHERE user_id = ? AND realm_id IS NOT NULL
        ORDER BY COALESCE(is_active, 1) DESC, updated_at DESC
        LIMIT 1`,
      [userId]
    );
    if (qt?.realm_id) return String(qt.realm_id);
  } catch (_) {
    const [[qt]] = await pool.execute(
      'SELECT realm_id FROM qbo_tokens WHERE user_id = ? AND realm_id IS NOT NULL LIMIT 1',
      [userId]
    );
    if (qt?.realm_id) return String(qt.realm_id);
  }

  // Xero: one grant covers every tenant; the active tenant is xero_tokens.tenant_id.
  const [[xt]] = await pool.execute(
    'SELECT tenant_id FROM xero_tokens WHERE user_id = ? AND tenant_id IS NOT NULL LIMIT 1',
    [userId]
  );
  if (xt?.tenant_id) return String(xt.tenant_id);
  return null;
}

/**
 * One call that resolves everything a report builder needs from its params.
 * `userId` is the effective (connection-owning) user id the route already
 * resolved. Returns plain data; the caller runs the report query.
 */
async function resolveReportContext(userId, params = {}, pool = defaultPool) {
  const orgId = await resolveOrgId(userId, params, pool);
  return {
    effectiveUserId: userId,
    orgId,
    platform: resolvePlatform(params),
    fyStartMonth: fyMonth(params.fy_start_month),
    range: resolveRange(params),
    asOf: resolveAsOf(params),
    basis: resolveBasis(params),
    interval: resolveInterval(params),
    compare: resolveCompare(params),
    period: resolvePeriod(params),
  };
}

module.exports = {
  fyMonth,
  fiscalYearStart,
  fiscalYearEnd,
  fyWindow,
  fyWindowsBack,
  resolveRange,
  resolveAsOf,
  resolveBasis,
  resolveInterval,
  resolvePeriod,
  resolveCompare,
  resolvePlatform,
  resolveOrgId,
  resolveReportContext,
};
