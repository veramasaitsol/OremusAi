'use strict';
const pool = require('./config/db');
(async () => {
  const uid = 23;
  const orgId = 'ce2803aa-f67b-4f8f-9e1f-fc07c9644750';
  const fyStart = '2025-04-01';

  // Key accounts: GL all-time / prior / FY nets + plug, vs Xero export values
  const [rows] = await pool.execute(
    `SELECT account_id, MAX(account_name) AS name, account_group,
            SUM(CASE WHEN transaction_id LIKE 'xero-recon:%' THEN debit ELSE 0 END) AS plug_d,
            SUM(CASE WHEN transaction_id LIKE 'xero-recon:%' THEN credit ELSE 0 END) AS plug_c,
            SUM(CASE WHEN transaction_id NOT LIKE 'xero-recon:%' THEN debit ELSE 0 END) AS gl_d,
            SUM(CASE WHEN transaction_id NOT LIKE 'xero-recon:%' THEN credit ELSE 0 END) AS gl_c,
            SUM(CASE WHEN transaction_id NOT LIKE 'xero-recon:%' AND transaction_date < ? THEN debit ELSE 0 END) AS gl_prior_d,
            SUM(CASE WHEN transaction_id NOT LIKE 'xero-recon:%' AND transaction_date < ? THEN credit ELSE 0 END) AS gl_prior_c
       FROM account_transactions
      WHERE user_id = ? AND org_id = ?
      GROUP BY account_id, account_group
      HAVING MAX(account_name) REGEXP 'Accounts Receivable|Output IGST|Input IGST|Axis Bank|HDFC|Audit Fee|Salaries & Wages|Retained Earnings'
      ORDER BY name`,
    [fyStart, fyStart, uid, orgId]
  );
  console.log('account | grp | GL_all(Dr-Cr) | GL_prior | plug(Dr-Cr) | GL+plug');
  for (const r of rows) {
    const glAll = Number(r.gl_d) - Number(r.gl_c);
    const glPrior = Number(r.gl_prior_d) - Number(r.gl_prior_c);
    const plug = Number(r.plug_d) - Number(r.plug_c);
    console.log(`${r.name} | ${r.account_group} | ${glAll.toFixed(2)} | ${glPrior.toFixed(2)} | ${plug.toFixed(2)} | ${(glAll + plug).toFixed(2)}`);
  }
  console.log('\nXero export: AR=9488599.35 OutputIGST=225781.93 InputIGST=3425.35 Axis=2065729.84 HDFC=47216127.81');

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
