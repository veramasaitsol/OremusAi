'use strict';
const pool = require('./config/db');
(async () => {
  const uid = 23;
  const orgId = 'ce2803aa-f67b-4f8f-9e1f-fc07c9644750';

  // 1. Output IGST rows: platform / source_type / txn-id prefix breakdown
  const [rows] = await pool.execute(
    `SELECT platform, source_type,
            CASE WHEN transaction_id LIKE 'xero-recon:%' THEN 'recon'
                 WHEN transaction_id LIKE 'xero:%' THEN 'xero:%'
                 ELSE 'other-prefix' END AS prefix,
            COUNT(*) AS cnt, SUM(debit) AS d, SUM(credit) AS c,
            MIN(transaction_date) AS min_d, MAX(transaction_date) AS max_d,
            MAX(synced_at) AS last_sync
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND account_id = '8cc0812f-f7d4-4d84-9cde-ee20831f2874'
      GROUP BY platform, source_type, prefix
      ORDER BY cnt DESC`,
    [uid, orgId]
  );
  console.log('=== Output IGST rows by platform/source/prefix ===');
  rows.forEach(r => console.log(
    ` plat=${r.platform} src=${r.source_type} prefix=${r.prefix} cnt=${r.cnt} Dr=${r.d} Cr=${r.c} dates=${String(r.min_d).slice(0,10)}..${String(r.max_d).slice(0,10)} lastSync=${r.last_sync}`
  ));

  // 2. Sandesh account rows: same breakdown
  const [sand] = await pool.execute(
    `SELECT platform, source_type,
            CASE WHEN transaction_id LIKE 'xero-recon:%' THEN 'recon'
                 WHEN transaction_id LIKE 'xero:%' THEN 'xero:%'
                 ELSE 'other-prefix' END AS prefix,
            COUNT(*) AS cnt, SUM(debit) AS d, SUM(credit) AS c
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND account_name LIKE '%Sandesh%'
      GROUP BY platform, source_type, prefix
      ORDER BY cnt DESC`,
    [uid, orgId]
  );
  console.log('\n=== Sandesh rows by platform/source/prefix ===');
  sand.forEach(r => console.log(
    ` plat=${r.platform} src=${r.source_type} prefix=${r.prefix} cnt=${r.cnt} Dr=${r.d} Cr=${r.c}`
  ));

  // 3. Whole ledger: platform distribution
  const [plat] = await pool.execute(
    `SELECT platform, COUNT(*) AS cnt FROM account_transactions
      WHERE user_id = ? AND org_id = ? GROUP BY platform`,
    [uid, orgId]
  );
  console.log('\n=== Ledger platform distribution ===');
  plat.forEach(r => console.log(` plat=${r.platform} cnt=${r.cnt}`));

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
