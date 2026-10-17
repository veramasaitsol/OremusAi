'use strict';

/**
 * Targeted budget refresh for one user — fills acc_budgets / acc_budget_lines
 * WITHOUT a full sync (a full sync does this too), then prints what was stored.
 * Read-only against the platform. Uses whichever connection the user has:
 *
 *   Xero        GET /Budgets + /Budgets/{id} (needs accounting.budgets.read)
 *   QuickBooks  SELECT * FROM Budget
 *   Zoho Books  GET /registers/{account}/budgetvsactuals — one call per
 *               profit-and-loss account per budget (Premium plan and up)
 *
 *   node db/sync-budgets.js --user=27
 */

require('dotenv').config();
const pool = require('../config/db');

const userArg = process.argv.find((a) => a.startsWith('--user='));
const USER_ID = userArg ? parseInt(userArg.split('=')[1], 10) : null;

async function hasRow(sql) {
  try { const [[r]] = await pool.execute(sql, [USER_ID]); return !!r; } catch (_) { return false; }
}

async function run(platform, fn) {
  try {
    console.log(`\n[${platform}] budgets:`, await fn());
  } catch (e) {
    const detail = e.response?.status ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 300)}` : e.message;
    console.log(`\n[${platform}] failed — ${detail}`);
  }
}

(async () => {
  if (!USER_ID) throw new Error('Pass --user=<id>');

  if (await hasRow('SELECT 1 FROM xero_tokens WHERE user_id = ? LIMIT 1')) {
    const xero = require('../services/xeroService');
    await run('xero', async () => {
      const auth = await xero.getValidXeroToken(USER_ID);
      if (!auth) throw new Error('Xero not connected');
      return xero.syncBudgets(USER_ID, auth.accessToken, auth.tenantId);
    });
  }
  if (await hasRow('SELECT 1 FROM qbo_tokens WHERE user_id = ? LIMIT 1')) {
    const qbo = require('../services/quickbooksService');
    await run('quickbooks', async () => {
      const auth = await qbo.getValidQBOToken(USER_ID);
      if (!auth) throw new Error('QuickBooks not connected');
      return qbo.syncBudgets(USER_ID, auth.accessToken, auth.realmId, auth.environment);
    });
  }
  if (await hasRow('SELECT 1 FROM zb_tokens WHERE user_id = ? LIMIT 1')) {
    const { getValidToken } = require('../services/zohoService');
    const zoho = require('../services/zohoBooksWarehouseService');
    const token = await getValidToken(USER_ID);
    const [orgs] = await pool.execute('SELECT org_id FROM zb_oauth_organizations WHERE user_id = ?', [USER_ID]);
    for (const { org_id: orgId } of orgs) {
      await run(`zoho ${orgId}`, async () => {
        if (!token) throw new Error('Zoho not connected');
        const r = await zoho.syncBudgets(USER_ID, token, orgId, null, { triggerSource: 'manual' });
        return `${r.fetched} budgets, ${r.inserted} amounts, ${r.calls} API calls`;
      });
    }
  }

  const [sync] = await pool.execute(
    'SELECT platform, org_id, status, error, budgets, line_count, synced_at FROM acc_budget_sync WHERE user_id = ?', [USER_ID]
  ).catch(() => [[]]);
  console.table(sync);
  const [budgets] = await pool.execute(
    `SELECT b.platform, b.name, b.budget_type, b.entry_period, b.status,
            DATE_FORMAT(b.start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(b.end_date, '%Y-%m-%d') AS end_date,
            COUNT(l.period) AS amounts, COUNT(DISTINCT l.account_id) AS accounts, COUNT(DISTINCT NULLIF(l.dimension_key, '')) AS subdivisions
       FROM acc_budgets b
       LEFT JOIN acc_budget_lines l
         ON l.user_id = b.user_id AND l.platform = b.platform AND l.org_id = b.org_id AND l.budget_id = b.budget_id
      WHERE b.user_id = ?
      GROUP BY b.platform, b.org_id, b.budget_id, b.name, b.budget_type, b.entry_period, b.status, b.start_date, b.end_date`,
    [USER_ID]
  ).catch(() => [[]]);
  console.table(budgets);
  await pool.end();
})().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
