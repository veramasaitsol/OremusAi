'use strict';

/**
 * report_settings — per-platform Financial Year start month.
 * ---------------------------------------------------------------------------
 * The ONE place the Financial Year is decided, for the Dashboard and every
 * report. Resolved most-specific first:
 *   1. users.fy_start_month of the client               (client override;
 *      NULL = inherit — a client has one platform, so one column)
 *   2. report_settings row (user_id = 0, platform)      (admin platform FY)
 *   3. the platform's system default: QuickBooks / Xero → January (Jan–Dec),
 *      Zoho → April (Apr–Mar)
 *
 * Only the start MONTH is stored. It moves reporting-period boundaries
 * (fiscal-year presets, the Retained / Current-Year Earnings split, YTD
 * comparisons) and never touches transaction dates or data.
 *
 * Nothing here calls a provider API. The schema is ensured on first use (same
 * as db/fy-settings.sql): the report_settings table, the users.fy_start_month
 * column, and a one-time move of old per-client report_settings rows into
 * that column. If that fails, reads fall back to the system default.
 */

const pool = require('../config/db');

const PLATFORMS = ['zoho', 'quickbooks', 'xero'];
// System default FY start month per platform.
const PLATFORM_DEFAULT_FY = { zoho: 4, quickbooks: 1, xero: 1 };
const FALLBACK_FY = 4;
const DEFAULTS = { fyStartMonth: FALLBACK_FY, byPlatform: PLATFORM_DEFAULT_FY };

/** System default FY start month for a platform (1..12). */
function defaultFyStartMonth(platform) {
  return PLATFORM_DEFAULT_FY[String(platform || '').toLowerCase()] || FALLBACK_FY;
}

// Ensure the schema the first time it's needed (idempotent, never fatal).
let schemaReady = null;
async function migrate() {
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS report_settings (
       id             INT AUTO_INCREMENT PRIMARY KEY,
       user_id        INT          NOT NULL,
       platform       VARCHAR(12)  NOT NULL,
       fy_start_month TINYINT      NULL,
       updated_by     INT          NULL,
       created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
       updated_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       UNIQUE KEY uq_scope_platform (user_id, platform)
     )`
  );
  const [[col]] = await pool.execute(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'fy_start_month'`
  );
  if (!Number(col.n)) {
    await pool.execute('ALTER TABLE users ADD COLUMN fy_start_month TINYINT NULL DEFAULT NULL');
  }
  // Old per-client overrides (report_settings.user_id > 0) → users column.
  await pool.execute(
    `UPDATE users u JOIN report_settings r ON r.user_id = u.id
        SET u.fy_start_month = r.fy_start_month
      WHERE r.user_id > 0 AND r.fy_start_month BETWEEN 1 AND 12 AND u.fy_start_month IS NULL`
  );
  await pool.execute('DELETE FROM report_settings WHERE user_id > 0');
}
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = migrate().catch((err) => { schemaReady = null; console.warn('[fy settings] schema check failed:', err.message); });
  }
  return schemaReady;
}

// ── tiny in-process TTL cache ────────────────────────────────────────────────
const TTL_MS = 60 * 1000;
const cache = new Map(); // key -> { value, exp }
function cacheGet(key) {
  const e = cache.get(key);
  if (e && e.exp > Date.now()) return e.value;
  cache.delete(key);
  return undefined;
}
function cacheSet(key, value) {
  cache.set(key, { value, exp: Date.now() + TTL_MS });
}
function cacheClear() {
  cache.clear();
}

function normPlatform(p) {
  const s = String(p || '').toLowerCase();
  return PLATFORMS.includes(s) ? s : null;
}
function normMonth(m) {
  const n = Number(m);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}
function isNoTable(err) {
  return err && (err.code === 'ER_NO_SUCH_TABLE' || /report_settings.*doesn.?t exist/i.test(err.message || ''));
}

/** All rows for a scope, keyed by platform. `{}` if the table is absent. */
async function rowsForScope(scopeUserId) {
  await ensureSchema();
  if (Number(scopeUserId) !== 0) {
    // A client's override is its single users.fy_start_month, for any platform.
    try {
      const [[u]] = await pool.execute('SELECT fy_start_month FROM users WHERE id = ?', [scopeUserId]);
      const out = {};
      if (u) for (const p of PLATFORMS) out[p] = { platform: p, fy_start_month: u.fy_start_month };
      return out;
    } catch (err) {
      return {};
    }
  }
  try {
    const [rows] = await pool.execute(
      'SELECT platform, fy_start_month FROM report_settings WHERE user_id = ?',
      [scopeUserId]
    );
    const out = {};
    for (const r of rows) out[r.platform] = r;
    return out;
  } catch (err) {
    if (isNoTable(err)) return {}; // table not created yet — behave as before
    throw err;
  }
}

/**
 * Effective settings for a report request.
 * @param {number} effUserId  connection-owning user id (route already resolved)
 * @param {string} platform   'zoho' | 'quickbooks' | 'xero' (or null)
 * @returns {Promise<{ fyStartMonth: number }>}
 */
async function getReportSettings(effUserId, platform) {
  const plat = normPlatform(platform);
  if (!plat || !effUserId) return { fyStartMonth: defaultFyStartMonth(plat) };

  const key = `s:${effUserId}:${plat}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const [own, admin] = await Promise.all([
    rowsForScope(effUserId),
    rowsForScope(0),
  ]);
  const o = own[plat] || {};
  const a = admin[plat] || {};

  const value = {
    fyStartMonth: normMonth(o.fy_start_month) ?? normMonth(a.fy_start_month) ?? defaultFyStartMonth(plat),
    // Where it came from, so the UI can say "inherited from …".
    source: normMonth(o.fy_start_month) != null ? 'client'
      : normMonth(a.fy_start_month) != null ? 'admin' : 'system',
  };
  cacheSet(key, value);
  return value;
}

/** Convenience: just the fiscal-year start month (1..12). */
async function getFyStartMonth(effUserId, platform) {
  return (await getReportSettings(effUserId, platform)).fyStartMonth;
}

/**
 * Upsert one (scope, platform) row's `fy_start_month`.
 * @param {number} scopeUserId  0 for the admin/global default, else a user id
 * @param {number|null} fyStartMonth  1..12, or null to clear (→ inherit)
 */
async function setFyStartMonth(scopeUserId, platform, fyStartMonth, actorId = null) {
  const plat = normPlatform(platform);
  if (!plat) { const e = new Error('platform must be zoho | quickbooks | xero'); e.code = 'BAD_PLATFORM'; throw e; }

  let month = null;
  if (fyStartMonth != null) {
    month = normMonth(fyStartMonth);
    if (month == null) { const e = new Error('fyStartMonth must be 1..12'); e.code = 'BAD_MONTH'; throw e; }
  }

  await ensureSchema();
  if (Number(scopeUserId) !== 0) {
    await pool.execute('UPDATE users SET fy_start_month = ? WHERE id = ?', [month, scopeUserId]);
    cacheClear();
    return;
  }
  try {
    await pool.execute(
      `INSERT INTO report_settings (user_id, platform, fy_start_month, updated_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE fy_start_month = VALUES(fy_start_month), updated_by = VALUES(updated_by)`,
      [scopeUserId, plat, month, actorId]
    );
  } catch (err) {
    if (isNoTable(err)) {
      const e = new Error('report_settings table is missing — run db/report-settings.sql on the database');
      e.code = 'NO_TABLE';
      throw e;
    }
    throw err;
  }
  cacheClear();
}

module.exports = {
  PLATFORMS,
  DEFAULTS,
  PLATFORM_DEFAULT_FY,
  defaultFyStartMonth,
  getReportSettings,
  getFyStartMonth,
  setFyStartMonth,
  rowsForScope,
  _cacheClear: cacheClear,
};
