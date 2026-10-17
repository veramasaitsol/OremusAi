'use strict';

/**
 * Budgets from every accounting platform — one set of tables.
 * ---------------------------------------------------------------------------
 * None of the three platforms keeps budgets in its ledger; each serves them
 * from its own API (see budgetSources.js for how each is read). Whatever the
 * source, a budget is stored the same way, keyed by platform + org:
 *
 *   acc_budgets        one row per budget: name, type, entry period (monthly /
 *                      quarterly / half_yearly / yearly), its date range and
 *                      what it is scoped to (a Xero tracking option, a Zoho
 *                      reporting tag)
 *   acc_budget_lines   one row per budget × account × subdivision × period:
 *                      the amount as entered on the platform (income and
 *                      expenses positive); `period` is the first day of the
 *                      period. `dimension_key` is '' for a plain budget, else
 *                      the QuickBooks class / location / customer it belongs to.
 *   acc_budget_sync    when an org's budgets were last fetched and whether the
 *                      platform let us (an org with no budgets must not read
 *                      as "never synced")
 *
 * Written by each platform's sync step; read by the Budget Summary
 * (budgetSummaryService). No other report reads these tables.
 */

const pool = require('../config/db');

const PLATFORMS = new Set(['xero', 'quickbooks', 'zoho']);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const str = (v, max = 255) => (v == null || v === '' ? null : String(v).slice(0, max));

let tablesReady = false;
async function ensureBudgetTables() {
  if (tablesReady) return;
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS acc_budgets (
       user_id      INT          NOT NULL,
       platform     VARCHAR(16)  NOT NULL,
       org_id       VARCHAR(64)  NOT NULL,
       budget_id    VARCHAR(64)  NOT NULL,
       name         VARCHAR(255) NULL,
       budget_type  VARCHAR(32)  NULL,
       entry_period VARCHAR(16)  NULL,
       start_date   DATE         NULL,
       end_date     DATE         NULL,
       status       VARCHAR(20)  NULL,
       scope_json   TEXT         NULL,
       source_updated_at DATETIME NULL,
       synced_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (user_id, platform, org_id, budget_id)
     ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS acc_budget_lines (
       user_id         INT           NOT NULL,
       platform        VARCHAR(16)   NOT NULL,
       org_id          VARCHAR(64)   NOT NULL,
       budget_id       VARCHAR(64)   NOT NULL,
       account_id      VARCHAR(64)   NOT NULL,
       account_code    VARCHAR(50)   NULL,
       account_name    VARCHAR(255)  NULL,
       dimension_key   VARCHAR(100)  NOT NULL DEFAULT '',
       dimension_label VARCHAR(255)  NULL,
       period          DATE          NOT NULL,
       amount          DECIMAL(18,2) NOT NULL DEFAULT 0,
       notes           VARCHAR(255)  NULL,
       PRIMARY KEY (user_id, platform, org_id, budget_id, account_id, dimension_key, period),
       KEY idx_budget_period (platform, org_id, budget_id, period)
     ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS acc_budget_sync (
       user_id     INT          NOT NULL,
       platform    VARCHAR(16)  NOT NULL,
       org_id      VARCHAR(64)  NOT NULL,
       status      VARCHAR(12)  NOT NULL DEFAULT 'ok',
       error       VARCHAR(500) NULL,
       budgets     INT          NOT NULL DEFAULT 0,
       line_count  INT          NOT NULL DEFAULT 0,
       window_from DATE         NULL,
       window_to   DATE         NULL,
       synced_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (user_id, platform, org_id)
     ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  tablesReady = true;
}

function checkPlatform(platform) {
  if (!PLATFORMS.has(platform)) throw new Error(`Unknown budget platform: ${platform}`);
}

/**
 * Replace an org's stored budgets with what was just fetched.
 * @param {object[]} budgets  normalized budgets { id, name, type, entryPeriod,
 *        startDate, endDate, status, scope, updatedAt } — every budget the
 *        platform has now (others stored for the org are removed)
 * @param {Map<string, object[]|null>} linesById  budget id → normalized lines
 *        { accountId, accountCode, accountName, dimensionKey, dimensionLabel,
 *        period, amount, notes }, or null when that budget's lines couldn't be
 *        fetched (its stored lines are then kept as they were)
 * @param {{ from?: string, to?: string }} window  the range that was requested
 */
async function persistBudgets(userId, platform, orgId, budgets, linesById, window = {}) {
  checkPlatform(platform);
  await ensureBudgetTables();
  const org = String(orgId);
  const key = [userId, platform, org];
  const conn = await pool.getConnection();
  let lineCount = 0;
  try {
    await conn.beginTransaction();
    const ids = budgets.map((b) => String(b.id)).filter(Boolean);
    if (ids.length) {
      await conn.query('DELETE FROM acc_budget_lines WHERE user_id = ? AND platform = ? AND org_id = ? AND budget_id NOT IN (?)', [...key, ids]);
      await conn.query('DELETE FROM acc_budgets WHERE user_id = ? AND platform = ? AND org_id = ? AND budget_id NOT IN (?)', [...key, ids]);
    } else {
      await conn.execute('DELETE FROM acc_budget_lines WHERE user_id = ? AND platform = ? AND org_id = ?', key);
      await conn.execute('DELETE FROM acc_budgets WHERE user_id = ? AND platform = ? AND org_id = ?', key);
    }
    for (const b of budgets) {
      const id = String(b.id || '');
      if (!id) continue;
      await conn.execute(
        `INSERT INTO acc_budgets
           (user_id, platform, org_id, budget_id, name, budget_type, entry_period, start_date, end_date, status, scope_json, source_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), budget_type = VALUES(budget_type), entry_period = VALUES(entry_period),
           start_date = VALUES(start_date), end_date = VALUES(end_date), status = VALUES(status),
           scope_json = VALUES(scope_json), source_updated_at = VALUES(source_updated_at), synced_at = CURRENT_TIMESTAMP`,
        [...key, id, str(b.name), str(b.type, 32), str(b.entryPeriod, 16), b.startDate || null, b.endDate || null,
          str(b.status, 20), b.scope ? JSON.stringify(b.scope) : null, b.updatedAt || null]
      );
      const lines = linesById.get(id);
      if (!Array.isArray(lines)) continue; // fetch failed — keep what's stored
      const rows = lineRows(userId, platform, org, id, lines);
      await conn.execute('DELETE FROM acc_budget_lines WHERE user_id = ? AND platform = ? AND org_id = ? AND budget_id = ?', [...key, id]);
      for (let i = 0; i < rows.length; i += 500) {
        await conn.query(
          `INSERT INTO acc_budget_lines
             (user_id, platform, org_id, budget_id, account_id, account_code, account_name,
              dimension_key, dimension_label, period, amount, notes)
           VALUES ?`, [rows.slice(i, i + 500)]);
      }
      lineCount += rows.length;
    }
    await conn.execute(
      `INSERT INTO acc_budget_sync (user_id, platform, org_id, status, error, budgets, line_count, window_from, window_to)
       VALUES (?, ?, ?, 'ok', NULL, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = 'ok', error = NULL, budgets = VALUES(budgets), line_count = VALUES(line_count),
         window_from = VALUES(window_from), window_to = VALUES(window_to), synced_at = CURRENT_TIMESTAMP`,
      [...key, ids.length, lineCount, window.from || null, window.to || null]
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return { budgets: budgets.length, lines: lineCount };
}

// Insert rows for one budget; one row per account × subdivision × period (the
// last value wins), zero amounts left out.
function lineRows(userId, platform, org, budgetId, lines) {
  const byKey = new Map();
  for (const l of lines) {
    if (!l.accountId || !l.period) continue;
    const amount = Math.round(num(l.amount) * 100) / 100;
    if (!amount) continue;
    const dim = l.dimensionKey || '';
    byKey.set(`${l.accountId}|${dim}|${l.period}`, [
      userId, platform, org, budgetId, String(l.accountId).slice(0, 64), str(l.accountCode, 50), str(l.accountName),
      dim.slice(0, 100), str(l.dimensionLabel), l.period, amount, str(l.notes),
    ]);
  }
  return [...byKey.values()];
}

/**
 * Remember why the platform's budgets couldn't be read (stored budgets are
 * kept). status 'error' = refused / failed; 'unavailable' = the platform or its
 * plan has no budgets feature for this org.
 */
async function recordBudgetSyncError(userId, platform, orgId, message, status = 'error') {
  checkPlatform(platform);
  try {
    await ensureBudgetTables();
    await pool.execute(
      `INSERT INTO acc_budget_sync (user_id, platform, org_id, status, error) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), error = VALUES(error), synced_at = CURRENT_TIMESTAMP`,
      [userId, platform, String(orgId), status, str(message, 500)]
    );
  } catch (e) {
    console.warn(`[Budgets] could not record ${platform} sync error:`, e.message);
  }
}

/** Sync state for an org, or null when its budgets were never fetched. */
async function loadBudgetSync(userId, platform, orgId) {
  try {
    const [[row]] = await pool.execute(
      `SELECT status, error, budgets, line_count, synced_at
         FROM acc_budget_sync WHERE user_id = ? AND platform = ? AND org_id = ?`,
      [userId, platform, String(orgId)]
    );
    return row || null;
  } catch (_) {
    return null; // tables not created yet
  }
}

/** The org's budgets: Xero's Overall Budget first, then by start date / name. */
async function listBudgets(userId, platform, orgId) {
  try {
    const [rows] = await pool.execute(
      `SELECT budget_id, name, budget_type, entry_period, status, scope_json,
              DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date
         FROM acc_budgets WHERE user_id = ? AND platform = ? AND org_id = ?
        ORDER BY budget_type = 'OVERALL' DESC, start_date DESC, name`,
      [userId, platform, String(orgId)]
    );
    return rows.map((r) => ({
      id: r.budget_id,
      name: r.name || 'Budget',
      type: r.budget_type,
      entryPeriod: r.entry_period,
      status: r.status,
      startDate: r.start_date,
      endDate: r.end_date,
      scope: r.scope_json ? JSON.parse(r.scope_json) : null,
    }));
  } catch (_) {
    return [];
  }
}

/** Amounts of one budget between two months (YYYY-MM-01, inclusive). */
async function loadBudgetLines(userId, platform, orgId, budgetId, fromMonth, toMonth) {
  const [rows] = await pool.execute(
    `SELECT account_id, account_code, account_name, dimension_key, dimension_label,
            DATE_FORMAT(period, '%Y-%m-01') AS period, amount
       FROM acc_budget_lines
      WHERE user_id = ? AND platform = ? AND org_id = ? AND budget_id = ? AND period BETWEEN ? AND ?`,
    [userId, platform, String(orgId), String(budgetId), fromMonth, toMonth]
  );
  return rows.map((r) => ({ ...r, amount: num(r.amount) }));
}

module.exports = {
  ensureBudgetTables,
  persistBudgets,
  recordBudgetSyncError,
  loadBudgetSync,
  listBudgets,
  loadBudgetLines,
  lineRows,
};
