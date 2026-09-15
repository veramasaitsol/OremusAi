'use strict';

/**
 * Drop the 4 DUPLICATE Zoho warehouse tables now consolidated into the legacy
 * tables.
 * ---------------------------------------------------------------------------
 * These tables held the same data as their legacy counterparts (the rich
 * warehouse sync was repointed to write the legacy tables, and all reads were
 * repointed off the zb_* tables):
 *
 *   zb_invoices  -> invoices
 *   zb_bills     -> bills
 *   zb_expenses  -> expense_entries
 *   zb_contacts  -> customers + vendors
 *
 * The legacy tables were first given the missing columns + matching collation
 * (db/consolidate-zb-into-legacy.js) and backfilled (db/backfill-zb-into-legacy.js).
 * No live code path queries these 4 tables anymore (verified via grep — only
 * comments + migration scripts reference the names).
 *
 * NOTE: the child line-item / payment tables (zb_invoice_line_items,
 * zb_bill_line_items, zb_customer_payments, zb_vendor_payments,
 * zb_vendor_credits, zb_credit_notes, zb_journals, …) are NOT dropped — reports
 * still JOIN them on zoho_*_id, which exists in the legacy tables too.
 *
 * SAFETY
 * ------
 *  - DRY RUN by default: prints what it WOULD do and exits. Pass --confirm to act.
 *  - Backs up every target table (schema + data) to a timestamped .sql file in
 *    db/backups/ BEFORE dropping. DROP TABLE is auto-commit DDL in MySQL and
 *    cannot be rolled back, so the backup is your only undo.
 *  - Only drops tables in the hard-coded allow-list below. Never wildcards.
 *
 * Run (dry run):   node db/drop-duplicate-zb-tables.js
 * Run (for real):  node db/drop-duplicate-zb-tables.js --confirm
 */

const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

const TABLES = ['zb_invoices', 'zb_bills', 'zb_expenses', 'zb_contacts'];

const CONFIRM = process.argv.includes('--confirm');
const esc = (v) => (v === null || v === undefined ? 'NULL' : pool.escape(v));

async function tableExists(name) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [name]
  );
  return row.c > 0;
}

async function backupTable(name, dir) {
  const [[{ ['Create Table']: createSql }]] = await pool.query(`SHOW CREATE TABLE \`${name}\``);
  const [rows] = await pool.query(`SELECT * FROM \`${name}\``);

  let sql = `-- Backup of \`${name}\` taken ${new Date().toISOString()}\n`;
  sql += `-- Rows: ${rows.length}\n\n`;
  sql += `DROP TABLE IF EXISTS \`${name}\`;\n${createSql};\n\n`;
  if (rows.length) {
    const cols = Object.keys(rows[0]);
    const colList = cols.map((c) => `\`${c}\``).join(', ');
    const values = rows
      .map((r) => `(${cols.map((c) => esc(r[c])).join(', ')})`)
      .join(',\n  ');
    sql += `INSERT INTO \`${name}\` (${colList}) VALUES\n  ${values};\n`;
  }
  const file = path.join(dir, `${name}.sql`);
  fs.writeFileSync(file, sql, 'utf8');
  return { file, rows: rows.length };
}

(async () => {
  console.log(`\nTarget tables (${TABLES.length}):`, TABLES.join(', '));
  console.log(CONFIRM ? '\nMODE: --confirm (will back up then DROP)\n' : '\nMODE: DRY RUN (no changes). Pass --confirm to execute.\n');

  const present = [];
  for (const t of TABLES) {
    if (!(await tableExists(t))) {
      console.log(`  skip   ${t} — does not exist`);
      continue;
    }
    const [[{ c }]] = await pool.query(`SELECT COUNT(*) AS c FROM \`${t}\``);
    console.log(`  found  ${t} — ${c} rows`);
    present.push(t);
  }

  if (!present.length) {
    console.log('\nNothing to do.');
    await pool.end();
    return;
  }

  if (!CONFIRM) {
    console.log('\nDry run complete. Re-run with --confirm to back up and drop the above tables.');
    await pool.end();
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(__dirname, 'backups', `duplicate-zb-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`\nBacking up to ${dir}`);
  for (const t of present) {
    const { file, rows } = await backupTable(t, dir);
    console.log(`  saved  ${path.basename(file)} (${rows} rows)`);
  }

  console.log('\nDropping…');
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of present) {
    await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    console.log(`  dropped ${t}`);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');

  console.log(`\nDone. To restore: node db/apply-sql.js ${path.relative(process.cwd(), dir)}/<table>.sql`);
  await pool.end();
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
