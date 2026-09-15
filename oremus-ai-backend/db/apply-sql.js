'use strict';
// Generic idempotent SQL migration runner. The shared mysql2 pool has NO
// multipleStatements, so we strip `--` comment lines, split on `;`, and run
// each statement sequentially. Usage: node db/apply-sql.js <file.sql>
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

async function main() {
  const rel = process.argv[2];
  if (!rel) {
    console.error('Usage: node db/apply-sql.js <path-to-sql>');
    process.exit(1);
  }
  const file = path.isAbsolute(rel) ? rel : path.join(__dirname, '..', rel);
  const raw = fs.readFileSync(file, 'utf8');

  const cleaned = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  const statements = cleaned
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`Applying ${statements.length} statements from ${path.basename(file)}…`);
  let ok = 0;
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
      ok++;
    } catch (err) {
      console.error('\nFAILED statement:\n', stmt.slice(0, 200));
      console.error('ERROR:', err.message);
      throw err;
    }
  }
  console.log(`Done. ${ok}/${statements.length} statements executed.`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
