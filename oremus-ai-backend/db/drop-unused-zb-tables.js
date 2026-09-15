'use strict';

/**
 * Drop the synced-but-unused Zoho warehouse tables.
 * ---------------------------------------------------------------------------
 * These 5 tables are populated by the sync engine yet READ BY NOTHING in the
 * app (no report, dashboard, metric, or accounting path queries them — only the
 * /sync/zb/counts overview touches a couple of them):
 *
 *   zb_tax_authorities   — read by nothing
 *   zb_tax_exemptions    — read by nothing
 *   zb_tax_rates         — only the /counts overview
 *   zb_currencies        — only the /counts overview
 *   zb_recurring_invoices— only /counts; the "Recurring Invoices" report fetches
 *                          live from Zoho, not this table
 *
 * SAFETY
 * ------
 *  - DRY RUN by default: prints what it WOULD do and exits. Pass --confirm to act.
 *  - Backs up every target table (schema + data) to a timestamped .sql file in
 *    db/backups/ BEFORE dropping. DROP TABLE is auto-commit DDL in MySQL and
 *    cannot be rolled back, so the backup is your only undo.
 *  - Only drops tables in the hard-coded allow-list below. Never wildcards.
 *
 * IMPORTANT — sync coupling: the sync engine still writes to these tables. After
 * dropping, remove the matching modules from MODULE_ORDER / MODULE_FUNCTIONS in
 * services/zohoBooksWarehouseService.js (currencies, tax_authorities,
 * tax_exemptions, taxes, recurring_invoices) or the next sync run will error
 * trying to INSERT into a missing table. This script prints a reminder.
 *
 * Run (dry run):   node db/drop-unused-zb-tables.js
 * Run (for real):  node db/drop-unused-zb-tables.js --confirm
 */

const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

const TABLES = [
  'zb_tax_authorities',
  'zb_tax_exemptions',
  'zb_tax_rates',
  'zb_currencies',
  'zb_recurring_invoices',
];

// Sync modules that feed the tables above — disable these in
// services/zohoBooksWarehouseService.js after dropping.
const COUPLED_SYNC_MODULES = [
  'tax_authorities', 'tax_exemptions', 'taxes', 'currencies', 'recurring_invoices',
];

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

  // Report current state.
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
    console.log('After dropping, disable these sync modules in zohoBooksWarehouseService.js:');
    console.log('  ', COUPLED_SYNC_MODULES.join(', '));
    await pool.end();
    return;
  }

  // Back up everything first.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(__dirname, 'backups', `unused-zb-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`\nBacking up to ${dir}`);
  for (const t of present) {
    const { file, rows } = await backupTable(t, dir);
    console.log(`  saved  ${path.basename(file)} (${rows} rows)`);
  }

  // Drop (FK checks off in case of stray references; these tables have none).
  console.log('\nDropping…');
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of present) {
    await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    console.log(`  dropped ${t}`);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');

  console.log('\nDone. REMINDER — disable these sync modules in');
  console.log('services/zohoBooksWarehouseService.js (MODULE_ORDER + MODULE_FUNCTIONS):');
  console.log('  ', COUPLED_SYNC_MODULES.join(', '));
  console.log('Otherwise the next sync will fail inserting into the dropped tables.');
  console.log(`To restore: node db/apply-sql.js ${path.relative(process.cwd(), dir)}/<table>.sql`);

  await pool.end();
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
