'use strict';

// Cached check for whether a base table exists in the current database.
// Lets provider syncs degrade gracefully on deployments that intentionally
// keep a reduced schema (e.g. no qbo_accounts / acc_* tables — the ledger data
// lives in the shared account_transactions table instead). Result is cached
// per table name; a process restart re-checks (cheap, runs once per table).
const pool = require('../config/db');

const _cache = new Map();

async function tableExists(name) {
  if (_cache.has(name)) return _cache.get(name);
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS c FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`,
    [name]
  );
  const exists = row.c > 0;
  _cache.set(name, exists);
  return exists;
}

module.exports = { tableExists };
