'use strict';

/**
 * report_settings — per-platform Financial Year start month.
 * ---------------------------------------------------------------------------
 * Two scopes, resolved most-specific first for a report request:
 *   1. the effective (connection-owning) user's own row for the platform
 *   2. the admin / global default row (user_id = 0) for the platform
 *   3. the built-in fallback: April (month 4)
 *
 * Nothing here calls a provider API. If the `report_settings` table has not been
 * created yet (db/report-settings.sql), reads degrade to the April fallback so
 * the app keeps working; writes throw a `NO_TABLE` error the route surfaces.
 */

const pool = require('../config/db');

const PLATFORMS = ['zoho', 'quickbooks', 'xero'];
const DEFAULTS = { fyStartMonth: 4 };

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
  if (!plat || !effUserId) return { ...DEFAULTS };

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
    fyStartMonth: normMonth(o.fy_start_month) ?? normMonth(a.fy_start_month) ?? DEFAULTS.fyStartMonth,
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
  getReportSettings,
  getFyStartMonth,
  setFyStartMonth,
  rowsForScope,
  _cacheClear: cacheClear,
};
