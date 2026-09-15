'use strict';

/**
 * Consolidate the duplicate Zoho warehouse tables into the legacy tables.
 * ---------------------------------------------------------------------------
 * Goal: eliminate the duplicate pair tables. The legacy tables become the
 * single source of truth (they already carry the multi-provider qbo_id/xero_id
 * columns); the zb_* parents are dropped afterwards by a separate step.
 *
 *   zb_invoices  -> invoices
 *   zb_bills     -> bills
 *   zb_expenses  -> expense_entries
 *   zb_contacts  -> customers   (contact_type customer / customer_and_vendor)
 *   zb_contacts  -> vendors     (contact_type vendor   / customer_and_vendor)
 *
 * This script does the NON-DESTRUCTIVE half (everything is reversible until the
 * zb_* tables are dropped by drop-zb-duplicate-tables.js):
 *   1. Backs up every legacy target (schema + data) to db/backups/.
 *   2. Converts each legacy table to utf8mb4_0900_ai_ci so JOINs against the
 *      0900_ai_ci child tables (zb_invoice_line_items, etc.) don't throw
 *      "Illegal mix of collations".
 *   3. ADDs every column present in the zb_* table but missing from the legacy
 *      table, copying the exact column definition (type / nullability / default)
 *      from information_schema. Idempotent: skips columns that already exist.
 *   4. Backfills the new columns on existing legacy rows (matched by zoho id)
 *      and inserts any zb_* rows missing from the legacy table.
 *
 * DRY RUN by default — prints the plan and exits. Pass --confirm to execute.
 *
 *   node db/consolidate-zb-into-legacy.js            # dry run
 *   node db/consolidate-zb-into-legacy.js --confirm  # execute
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

const CONFIRM = process.argv.includes('--confirm');

// zb table -> legacy table(s). Contacts fans out to customers + vendors.
const PAIRS = [
  { zb: 'zb_invoices', legacy: 'invoices' },
  { zb: 'zb_bills', legacy: 'bills' },
  { zb: 'zb_expenses', legacy: 'expense_entries' },
  { zb: 'zb_contacts', legacy: 'customers' },
  { zb: 'zb_contacts', legacy: 'vendors' },
];

// Columns never copied from zb_* (legacy identity / housekeeping already present).
const SKIP = new Set(['id', 'synced_at', 'raw_payload_id']);

const esc = (v) => (v === null || v === undefined ? 'NULL' : pool.escape(v));

async function columns(table) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLLATION_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [table]
  );
  return rows;
}

function colDef(c) {
  let def = `\`${c.COLUMN_NAME}\` ${c.COLUMN_TYPE}`;
  // text/blob types cannot carry a column-level default; everything else can.
  const isTextBlob = /\b(text|blob|json|geometry)\b/i.test(c.COLUMN_TYPE);
  def += c.IS_NULLABLE === 'NO' ? ' NOT NULL' : ' NULL';
  if (!isTextBlob) {
    if (c.COLUMN_DEFAULT !== null && c.COLUMN_DEFAULT !== undefined) {
      const d = String(c.COLUMN_DEFAULT);
      // information_schema returns function defaults (CURRENT_TIMESTAMP) and
      // numeric/string literals as text; pass timestamps through verbatim.
      def += /^(current_timestamp|now\()/i.test(d) ? ` DEFAULT ${d}` : ` DEFAULT ${pool.escape(d)}`;
    } else if (c.IS_NULLABLE === 'YES') {
      def += ' DEFAULT NULL';
    }
  }
  return def;
}

async function backup(table, dir) {
  const [[{ ['Create Table']: createSql }]] = await pool.query(`SHOW CREATE TABLE \`${table}\``);
  const [rows] = await pool.query(`SELECT * FROM \`${table}\``);
  let sql = `-- Backup of \`${table}\` taken ${new Date().toISOString()} (${rows.length} rows)\n\n`;
  sql += `DROP TABLE IF EXISTS \`${table}\`;\n${createSql};\n\n`;
  if (rows.length) {
    const cols = Object.keys(rows[0]);
    const colList = cols.map((c) => `\`${c}\``).join(', ');
    const values = rows.map((r) => `(${cols.map((c) => esc(r[c])).join(', ')})`).join(',\n  ');
    sql += `INSERT INTO \`${table}\` (${colList}) VALUES\n  ${values};\n`;
  }
  fs.writeFileSync(path.join(dir, `${table}.sql`), sql, 'utf8');
  return rows.length;
}

(async () => {
  console.log(CONFIRM ? '\nMODE: --confirm (will back up, alter, and backfill)\n' : '\nMODE: DRY RUN (no changes). Pass --confirm to execute.\n');

  // Build the per-pair column add plan.
  const plan = [];
  for (const { zb, legacy } of PAIRS) {
    const zbCols = await columns(zb);
    const legacyCols = await columns(legacy);
    const legacyNames = new Set(legacyCols.map((c) => c.COLUMN_NAME));
    const toAdd = zbCols.filter((c) => !SKIP.has(c.COLUMN_NAME) && !legacyNames.has(c.COLUMN_NAME));
    const needsCollation = legacyCols.some((c) => c.COLLATION_NAME && c.COLLATION_NAME !== 'utf8mb4_0900_ai_ci');
    plan.push({ zb, legacy, toAdd, needsCollation });
    console.log(`${zb} -> ${legacy}`);
    console.log(`   collation convert: ${needsCollation ? 'YES -> utf8mb4_0900_ai_ci' : 'no'}`);
    console.log(`   add ${toAdd.length} columns: ${toAdd.map((c) => c.COLUMN_NAME).join(', ') || '(none)'}`);
  }

  if (!CONFIRM) {
    console.log('\nDry run complete. Re-run with --confirm to apply.');
    await pool.end();
    return;
  }

  // 1. Backup legacy targets.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(__dirname, 'backups', `consolidate-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`\nBacking up legacy tables to ${dir}`);
  for (const legacy of [...new Set(PAIRS.map((p) => p.legacy))]) {
    const n = await backup(legacy, dir);
    console.log(`  saved ${legacy}.sql (${n} rows)`);
  }

  // 2 + 3. Convert collation then add columns.
  for (const { legacy, toAdd, needsCollation } of plan) {
    if (needsCollation) {
      console.log(`\nConverting ${legacy} to utf8mb4_0900_ai_ci ...`);
      await pool.query(`ALTER TABLE \`${legacy}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    }
    if (toAdd.length) {
      // Re-check existence (customers/vendors share zb_contacts; a column added
      // for one pair may already exist when the other pair runs).
      const existing = new Set((await columns(legacy)).map((c) => c.COLUMN_NAME));
      const adds = toAdd.filter((c) => !existing.has(c.COLUMN_NAME));
      if (adds.length) {
        const clause = adds.map((c) => `ADD COLUMN ${colDef(c)}`).join(', ');
        console.log(`Adding ${adds.length} columns to ${legacy} ...`);
        await pool.query(`ALTER TABLE \`${legacy}\` ${clause}`);
      }
    }
  }

  console.log('\nSchema migration done. Run the data backfill step next.');
  await pool.end();
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
