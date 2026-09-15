'use strict';
const pool = require('./config/db');
(async () => {
  const uid = 23;
  const orgId = 'ce2803aa-f67b-4f8f-9e1f-fc07c9644750';

  // 1. Check recon entries after full re-sync
  const [recon] = await pool.execute(
    `SELECT account_name, SUM(debit) AS d, SUM(credit) AS c
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND transaction_id LIKE 'xero-recon:%'
      GROUP BY account_name HAVING SUM(debit) - SUM(credit) != 0
      ORDER BY account_name LIMIT 10`,
    [uid, orgId]
  );
  console.log('=== Recon entries (non-zero) after re-sync ===');
  recon.forEach(r => console.log(' ', r.account_name, '| Dr:', r.d, '| Cr:', r.c));

  // 2. Output IGST combined balance (GL + recon)
  const [igst] = await pool.execute(
    `SELECT account_name,
            SUM(CASE WHEN transaction_id LIKE 'xero-recon:%' THEN 0 ELSE debit END) AS gl_d,
            SUM(CASE WHEN transaction_id LIKE 'xero-recon:%' THEN 0 ELSE credit END) AS gl_c,
            SUM(debit) AS all_d, SUM(credit) AS all_c
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND account_name LIKE '%Output IGST%'
      GROUP BY account_name`,
    [uid, orgId]
  );
  console.log('\n=== Output IGST after re-sync ===');
  igst.forEach(r => {
    console.log(' ', r.account_name);
    console.log('    GL only (Cr-Dr):', (Number(r.gl_c) - Number(r.gl_d)).toFixed(2));
    console.log('    GL+recon (Cr-Dr):', (Number(r.all_c) - Number(r.all_d)).toFixed(2));
  });
  console.log('    Xero expects: 225,781.93');

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
