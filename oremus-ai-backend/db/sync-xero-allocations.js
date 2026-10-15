'use strict';

/**
 * Targeted Xero allocation refresh — fills xero_credit_docs / xero_allocations
 * for one user WITHOUT rebuilding the ledger (a full Xero sync does this too).
 * Read-only against Xero: GET /CreditNotes, /Overpayments, /Prepayments and
 * the over/prepayment /BankTransactions (roughly one call per 100 documents).
 *
 *   node db/sync-xero-allocations.js --user=27
 */

require('dotenv').config();
const pool = require('../config/db');
const { syncXeroAllocations } = require('../services/xeroAllocationsService');

const userArg = process.argv.find((a) => a.startsWith('--user='));
const USER_ID = userArg ? parseInt(userArg.split('=')[1], 10) : null;

(async () => {
  if (!USER_ID) throw new Error('Pass --user=<id>');
  const res = await syncXeroAllocations(USER_ID);
  console.log('Stored:', JSON.stringify(res));
  if (res.errors) {
    // Name the scope the connection is missing (read from the token's own
    // claims — no secret is printed).
    const { getValidXeroToken } = require('../services/xeroService');
    const auth = await getValidXeroToken(USER_ID);
    const claims = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString());
    const granted = new Set([].concat(claims.scope || []));
    const ok = ['accounting.payments.read', 'accounting.payments', 'accounting.transactions', 'accounting.transactions.read']
      .some((s) => granted.has(s));
    if (!ok) {
      console.log('This Xero connection was not granted accounting.payments.read (needed for /Overpayments and /Prepayments).');
      console.log('Granted:', [...granted].join(' '));
      console.log('Fix: allow that scope for the Xero app, reconnect Xero for this user, then re-run this script.');
    }
  }
  await pool.end();
})().catch(async (e) => {
  console.error(e.response?.status ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 300)}` : e);
  await pool.end().catch(() => {});
  process.exit(1);
});
