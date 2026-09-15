'use strict';
const path = require('path');
// Single environment file for every server — same `.env` as app.js, resolved by
// absolute path so it loads regardless of the process working directory.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT || '3306'),
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASSWORD || '',
  database:           process.env.DB_NAME     || 'oremus_db',
  waitForConnections: true,
  // Default 10; raise via DB_POOL_SIZE for many concurrent clients. cPanel
  // shared MySQL caps total connections per account, so keep this comfortably
  // under that limit.
  connectionLimit:    parseInt(process.env.DB_POOL_SIZE || '10', 10),
  queueLimit:         0,
  dateStrings:        true,
  connectTimeout:     30000,
  // cPanel shared hosting: disable SSL if not configured
  ssl:                process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// ── Relax ONLY_FULL_GROUP_BY for this app's connections ──────────────────────
// Many reporting queries GROUP BY a subset of selected columns (valid on the
// deployment MySQL, which runs without ONLY_FULL_GROUP_BY). Some local/strict
// MySQL installs enable it by default, which makes those queries throw and the
// services swallow the error → empty panels (e.g. revenue-by-product). Drop just
// that mode per-connection so behaviour matches production, without touching the
// server global (other databases on the same server are unaffected).
pool.on('connection', (conn) => {
  conn.query("SET SESSION sql_mode = REPLACE(@@SESSION.sql_mode, 'ONLY_FULL_GROUP_BY', '')");
});

// ── Slow-query logging (ENHANCEMENTS Task C) ─────────────────────────────────
// Non-invasive: wrap pool.query / pool.execute to time each call and warn when
// it exceeds the threshold. Behaviour is otherwise identical — the original
// result is returned and rejections propagate untouched. Disable with
// DB_SLOW_QUERY_MS=0. Note: this covers the common pool.query path; queries run
// on a checked-out connection (pool.getConnection()) are not wrapped.
const SLOW_QUERY_MS = parseInt(process.env.DB_SLOW_QUERY_MS || '200', 10);

if (SLOW_QUERY_MS > 0) {
  for (const method of ['query', 'execute']) {
    const original = pool[method].bind(pool);
    pool[method] = async (...args) => {
      const started = process.hrtime.bigint();
      try {
        return await original(...args);
      } finally {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        if (ms >= SLOW_QUERY_MS) {
          const arg0 = args[0];
          const sql = typeof arg0 === 'string' ? arg0 : (arg0 && arg0.sql) || '';
          const oneLine = String(sql).replace(/\s+/g, ' ').trim().slice(0, 200);
          console.warn(`[slow-query] ${ms.toFixed(0)}ms  ${oneLine}`);
        }
      }
    };
  }
}

module.exports = pool;
