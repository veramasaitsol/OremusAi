'use strict';

/**
 * Data backfill step for the zb_* -> legacy consolidation.
 * Run AFTER db/consolidate-zb-into-legacy.js --confirm (which adds the columns).
 *
 * For each pair it:
 *   - UPDATEs every legacy row that matches a zb_* row (by user_id + zoho id),
 *     copying every column the two tables share (so the freshly-added columns
 *     get the warehouse values; pre-existing shared columns are refreshed
 *     identically — verified zero diffs).
 *   - INSERTs any zb_* row missing from the legacy table.
 *
 * Contacts: the legacy customers AND vendors tables each already mirror the full
 * zb_contacts set (reports filter on contact_type), so both are backfilled from
 * zb_contacts in full.
 *
 * Identity / provider columns are never copied: id, qbo_id, xero_id, synced_at.
 *
 *   node db/backfill-zb-into-legacy.js            # dry run (row counts only)
 *   node db/backfill-zb-into-legacy.js --confirm  # execute
 */

require('dotenv').config();
const pool = require('../config/db');

const CONFIRM = process.argv.includes('--confirm');

// Legacy shared tables use the generic `zoho_id` column (shared across all
// platforms); the zb_* silver tables keep their entity-specific id column.
const PAIRS = [
  { zb: 'zb_invoices', legacy: 'invoices', zbZid: 'zoho_invoice_id', legacyZid: 'zoho_id' },
  { zb: 'zb_bills', legacy: 'bills', zbZid: 'zoho_bill_id', legacyZid: 'zoho_id' },
  { zb: 'zb_expenses', legacy: 'expense_entries', zbZid: 'zoho_expense_id', legacyZid: 'zoho_id' },
  { zb: 'zb_contacts', legacy: 'customers', zbZid: 'zoho_contact_id', legacyZid: 'zoho_id' },
  { zb: 'zb_contacts', legacy: 'vendors', zbZid: 'zoho_contact_id', legacyZid: 'zoho_id' },
];

const NEVER_COPY = new Set(['id', 'qbo_id', 'xero_id', 'synced_at']);

async function colNames(table) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [table]
  );
  return rows.map((r) => r.COLUMN_NAME);
}

(async () => {
  console.log(CONFIRM ? '\nMODE: --confirm (will backfill)\n' : '\nMODE: DRY RUN\n');

  for (const { zb, legacy, zbZid, legacyZid } of PAIRS) {
    const zbCols = new Set(await colNames(zb));
    const legacyCols = await colNames(legacy);
    // Columns to copy = present in BOTH, minus identity/provider columns. The
    // join-key id columns differ by name (legacyZid vs zbZid) so they are not
    // in this intersection and are handled explicitly on INSERT below.
    const shared = legacyCols.filter((c) => zbCols.has(c) && !NEVER_COPY.has(c));
    // For UPDATE, exclude the join key (no point re-setting it).
    const setCols = shared.filter((c) => c !== 'user_id');

    const [[{ m }]] = await pool.query(
      `SELECT COUNT(*) AS m FROM \`${legacy}\` l JOIN \`${zb}\` z
         ON l.user_id = z.user_id AND l.\`${legacyZid}\` = z.\`${zbZid}\``
    );
    const [[{ mi }]] = await pool.query(
      `SELECT COUNT(*) AS mi FROM \`${zb}\` z
        WHERE NOT EXISTS (SELECT 1 FROM \`${legacy}\` l
          WHERE l.user_id = z.user_id AND l.\`${legacyZid}\` = z.\`${zbZid}\`)`
    );
    console.log(`${zb} -> ${legacy}: update ${m} rows (${setCols.length} cols), insert ${mi} missing rows`);

    if (!CONFIRM) continue;

    if (setCols.length && m) {
      const setClause = setCols.map((c) => `l.\`${c}\` = z.\`${c}\``).join(', ');
      const [r] = await pool.query(
        `UPDATE \`${legacy}\` l JOIN \`${zb}\` z
            ON l.user_id = z.user_id AND l.\`${legacyZid}\` = z.\`${zbZid}\`
          SET ${setClause}`
      );
      console.log(`   updated ${r.affectedRows} rows`);
    }
    if (mi) {
      // Map the zb id column into the legacy zoho_id column, then the shared cols.
      const colList = [legacyZid, ...shared].map((c) => `\`${c}\``).join(', ');
      const selList = [`z.\`${zbZid}\``, ...shared.map((c) => `z.\`${c}\``)].join(', ');
      const [r] = await pool.query(
        `INSERT INTO \`${legacy}\` (${colList})
         SELECT ${selList} FROM \`${zb}\` z
          WHERE NOT EXISTS (SELECT 1 FROM \`${legacy}\` l
            WHERE l.user_id = z.user_id AND l.\`${legacyZid}\` = z.\`${zbZid}\`)`
      );
      console.log(`   inserted ${r.affectedRows} rows`);
    }
  }

  console.log('\nBackfill complete.');
  await pool.end();
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
