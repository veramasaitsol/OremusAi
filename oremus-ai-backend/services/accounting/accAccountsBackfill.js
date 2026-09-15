'use strict';

/**
 * accAccountsBackfill — populate the unified Chart of Accounts (acc_accounts)
 * from each provider's COA table. Phase B of the GL warehouse migration.
 *
 * v1 = ZOHO ONLY (back-fills from zb_chart_of_accounts). QBO/Xero ride the same
 * table later. Idempotent UPSERT keyed on (connection_ref, account_ref) — safe to
 * re-run after every COA sync.
 *
 * This is ADDITIVE: it reads provider tables + acc_connections and writes only
 * acc_accounts. Nothing else is touched.
 */

const pool = require('../../config/db');
const { classifyZohoType } = require('./ZohoBooksProvider');

// Unified classification (Asset/Liability/Equity/Revenue/Expense/Uncategorized)
// → acc_accounts.account_type ENUM (asset|liability|equity|income|expense|NULL).
function toAccountTypeEnum(classification) {
  switch (classification) {
    case 'Asset':     return 'asset';
    case 'Liability': return 'liability';
    case 'Equity':    return 'equity';
    case 'Revenue':   return 'income';
    case 'Expense':   return 'expense';
    default:          return null; // Uncategorized → leave NULL
  }
}

// Derive the correctness flags from the Zoho raw account_type + name.
function zohoFlags(rawType, name) {
  const t = String(rawType || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  return {
    is_bank: /(^|_)(bank|cash)$/.test(t) || t === 'bank' || t === 'cash' ? 1 : 0,
    is_ar:   t === 'accounts_receivable' ? 1 : 0,
    is_ap:   t === 'accounts_payable' ? 1 : 0,
    is_retained_earnings: t === 'equity' && /retained earnings/.test(n) ? 1 : 0,
  };
}

const UPSERT_SQL = `
  INSERT INTO acc_accounts
    (user_id, provider, connection_ref, account_ref, code, name,
     account_type, account_subtype, is_bank, is_ar, is_ap, is_retained_earnings,
     parent_ref, currency, is_active, raw_payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    user_id = VALUES(user_id), code = VALUES(code), name = VALUES(name),
    account_type = VALUES(account_type), account_subtype = VALUES(account_subtype),
    is_bank = VALUES(is_bank), is_ar = VALUES(is_ar), is_ap = VALUES(is_ap),
    is_retained_earnings = VALUES(is_retained_earnings),
    parent_ref = VALUES(parent_ref), currency = VALUES(currency),
    is_active = VALUES(is_active), raw_payload = VALUES(raw_payload),
    updated_at = NOW()
`;

/**
 * Back-fill acc_accounts for ONE Zoho connection (user_id + org_id).
 * Reads zb_chart_of_accounts; tries the connection user first, falling back to
 * any user that has COA rows for that org (multi-tenant inheritance).
 */
async function backfillZohoConnection(userId, orgId) {
  // zb_chart_of_accounts.currency_code is typically NULL, so resolve the org's
  // base currency once and use it as the fallback (the org is the source of truth).
  let orgCurrency = null;
  try {
    const [[org]] = await pool.execute(
      'SELECT currency_code FROM zb_organizations WHERE org_id = ? AND currency_code IS NOT NULL LIMIT 1',
      [String(orgId)]
    );
    orgCurrency = org?.currency_code || null;
  } catch (_) { /* leave null */ }

  // Prefer the connection user's COA; fall back to whoever has rows for the org.
  let [rows] = await pool.execute(
    `SELECT zoho_account_id, account_code, account_name, account_type,
            account_subtype, parent_account_id, currency_code, current_balance, is_active
       FROM zb_chart_of_accounts
      WHERE user_id = ? AND org_id = ? AND is_deleted = 0`,
    [userId, orgId]
  );
  if (rows.length === 0) {
    [rows] = await pool.execute(
      `SELECT zoho_account_id, account_code, account_name, account_type,
              account_subtype, parent_account_id, currency_code, current_balance, is_active
         FROM zb_chart_of_accounts
        WHERE org_id = ? AND is_deleted = 0`,
      [orgId]
    );
  }

  let upserted = 0;
  for (const r of rows) {
    if (r.zoho_account_id == null) continue;
    const classification = classifyZohoType(r.account_type);
    const accountType = toAccountTypeEnum(classification);
    const flags = zohoFlags(r.account_type, r.account_name);
    await pool.execute(UPSERT_SQL, [
      userId,
      'zoho',
      String(orgId),
      String(r.zoho_account_id),
      r.account_code || null,
      r.account_name || null,
      accountType,
      r.account_subtype || r.account_type || null,
      flags.is_bank, flags.is_ar, flags.is_ap, flags.is_retained_earnings,
      r.parent_account_id != null ? String(r.parent_account_id) : null,
      r.currency_code || orgCurrency,
      r.is_active ? 1 : 0,
      JSON.stringify(r),
    ]);
    upserted += 1;
  }
  return { userId, orgId: String(orgId), fetched: rows.length, upserted };
}

/**
 * Back-fill acc_accounts for ALL registered Zoho connections (acc_connections).
 * Pass {userId, orgId} to scope to a single connection.
 */
async function backfillZohoAccounts({ userId = null, orgId = null } = {}) {
  let conns;
  if (userId && orgId) {
    conns = [{ user_id: userId, connection_ref: String(orgId) }];
  } else {
    const [rows] = await pool.execute(
      `SELECT user_id, connection_ref FROM acc_connections
        WHERE provider = 'zoho' AND is_active = 1`
    );
    conns = rows;
  }
  const results = [];
  for (const c of conns) {
    results.push(await backfillZohoConnection(c.user_id, c.connection_ref));
  }
  return results;
}

module.exports = { backfillZohoAccounts, backfillZohoConnection, toAccountTypeEnum, zohoFlags };
