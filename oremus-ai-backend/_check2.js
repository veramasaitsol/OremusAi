'use strict';
const pool = require('./config/db');
(async () => {
  const uid = 23;
  const orgId = 'ce2803aa-f67b-4f8f-9e1f-fc07c9644750';
  const asOf = '2026-03-31';

  // Replicate aggregateBS exactly (platform='xero', excludes xero-recon)
  const [accts] = await pool.execute(
    `SELECT account_id,
            MAX(account_name) AS account_name,
            account_group, account_type_code,
            SUM(debit)  AS d,
            SUM(credit) AS c
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND platform = 'xero'
        AND transaction_date <= ?
        AND source_type != 'xero-recon'
      GROUP BY account_id, account_group, account_type_code`,
    [uid, orgId, asOf]
  );
  console.log('=== Our BS (excludes xero-recon) — GST accounts ===');
  for (const a of accts) {
    if (/igst|cgst|sgst|gst/i.test(a.account_name || '')) {
      const bal = a.account_group === 'asset' ? (Number(a.d) - Number(a.c)) : (Number(a.c) - Number(a.d));
      console.log(' ', a.account_name, '| group:', a.account_group, '| bal:', bal.toFixed(2));
    }
  }

  // Same but INCLUDING recon
  const [accts2] = await pool.execute(
    `SELECT account_id,
            MAX(account_name) AS account_name,
            account_group, account_type_code,
            SUM(debit)  AS d,
            SUM(credit) AS c
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND platform = 'xero'
        AND transaction_date <= ?
      GROUP BY account_id, account_group, account_type_code`,
    [uid, orgId, asOf]
  );
  console.log('\n=== Our BS (INCLUDES recon) — GST accounts ===');
  for (const a of accts2) {
    if (/igst|cgst|sgst|gst/i.test(a.account_name || '')) {
      const bal = a.account_group === 'asset' ? (Number(a.d) - Number(a.c)) : (Number(a.c) - Number(a.d));
      console.log(' ', a.account_name, '| group:', a.account_group, '| bal:', bal.toFixed(2));
    }
  }
  console.log('\nXero export: Input CGST 46702.63 | Input IGST 3425.35 | Input SGST 44049.63 | Output CGST 192548.79 | Output IGST 225781.93 | Output SGST 192548.79 | GST Payable -0.58');

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
