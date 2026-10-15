'use strict';

/**
 * One-off backfill: currency_code / currency_symbol / exchange_rate on Xero
 * bills synced before syncBills stored them.
 *
 * syncBills used to write only number/vendor/dates/total/balance/status, so a
 * foreign-currency bill (e.g. an AED supplier invoice in an INR org) carried
 * currency_code NULL and read as base currency in A/P Aging and Foreign
 * Currency Gains and Losses. The values already exist locally: the posting
 * engine stamps every line of the bill's own ACCPAY document in
 * account_transactions with the bill's CurrencyCode and CurrencyRate (the
 * rate Xero reported for the document), keyed by source_id = bills.xero_id.
 * So this needs NO Xero API call. The next Xero sync writes the same fields
 * straight from the API.
 *
 * Only fills rows where currency_code IS NULL. Rows that already have a
 * currency are never touched, and nothing is deleted.
 *
 *   node db/backfill-xero-bill-currency.js                # dry run (counts only)
 *   node db/backfill-xero-bill-currency.js --confirm      # execute
 *   node db/backfill-xero-bill-currency.js --user=27      # limit to one user
 */

require('dotenv').config();
const pool = require('../config/db');
const { currencySymbol } = require('../utils/currencySymbols');

const CONFIRM = process.argv.includes('--confirm');
const userArg = process.argv.find((a) => a.startsWith('--user='));
const USER_ID = userArg ? parseInt(userArg.split('=')[1], 10) : null;

(async () => {
  // One currency and one rate per bill document: a bill whose lines disagree
  // is left alone rather than guessed.
  const [rows] = await pool.query(
    `SELECT b.id, b.user_id, b.bill_number, d.code, d.rate
       FROM bills b
       JOIN (SELECT user_id, org_id, source_id,
                    MAX(currency_code) AS code, MAX(exchange_rate) AS rate
               FROM account_transactions
              WHERE platform = 'xero' AND source_type = 'ACCPAY'
                AND currency_code IS NOT NULL AND exchange_rate > 0
              GROUP BY user_id, org_id, source_id
             HAVING COUNT(DISTINCT currency_code) = 1
                AND COUNT(DISTINCT exchange_rate) = 1) d
         ON d.user_id = b.user_id
        AND d.org_id = b.org_id COLLATE utf8mb4_unicode_ci
        AND d.source_id = b.xero_id COLLATE utf8mb4_unicode_ci
      WHERE b.xero_id IS NOT NULL AND b.currency_code IS NULL
        ${USER_ID ? 'AND b.user_id = ?' : ''}`,
    USER_ID ? [USER_ID] : []
  );

  const byCode = {};
  for (const r of rows) byCode[r.code] = (byCode[r.code] || 0) + 1;
  console.log(`Xero bills with NULL currency that the ledger can fill: ${rows.length}`, byCode);

  if (!CONFIRM) {
    console.log('Dry run — re-run with --confirm to write.');
    await pool.end();
    return;
  }

  let updated = 0;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const [res] = await pool.execute(
      `UPDATE bills SET currency_code = ?, currency_symbol = ?, exchange_rate = ?
        WHERE id = ? AND currency_code IS NULL`,
      [r.code, currencySymbol(r.code), r.rate, r.id]
    );
    updated += res.affectedRows;
  }
  console.log(`Updated ${updated} bills.`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
