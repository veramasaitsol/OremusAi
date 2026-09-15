'use strict';

const { Router } = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const adminClientView = require('../middleware/adminClientView');
const { getEffectiveZohoUserId } = require('../services/zohoService');
// Trial Balance for balance enrichment is computed from our local ledger
// (account_transactions), NOT the Zoho report API — Zoho is used only for data
// sync + OAuth, so this page makes no Zoho report calls.
const { buildTrialBalance } = require('../services/zohoGlReportsService');

const router = Router();
router.use(auth);
// Admin "view as client": swap req.user.id to the selected client on a valid
// X-Client-Id so these read-only account endpoints return the client's data.
// No-op for non-admins / no header. Only GET reads live in this router.
router.use(adminClientView);

// Map Zoho's account_type → classification used by the Accounts UI (matches QB/Xero shape).
function classify(accountType) {
  const t = String(accountType || '').toLowerCase();
  if (['bank', 'cash', 'accounts_receivable', 'other_current_asset', 'fixed_asset',
       'other_asset', 'stock', 'payment_clearing_account', 'input_tax',
       'inventory_asset', 'intangible_asset', 'non_current_asset',
       'deferred_tax_assets'].includes(t)) return 'Asset';
  if (['accounts_payable', 'credit_card', 'other_current_liability',
       'other_liability', 'long_term_liability', 'overseas_tax_payable',
       'output_tax', 'non_current_liability', 'deferred_tax_liabilities',
       'employer_liabilities', 'employee_reimbursements'].includes(t)) return 'Liability';
  if (['equity', 'owner_drawings', 'retained_earnings'].includes(t)) return 'Equity';
  if (['income', 'other_income'].includes(t)) return 'Revenue';
  if (['expense', 'cost_of_goods_sold', 'other_expense',
       'depreciation_and_amortisation'].includes(t)) return 'Expense';
  return 'Uncategorized';
}

// GET /api/zoho/accounts?type=&classification=&active=&search=
router.get('/accounts', async (req, res) => {
  try {
    const effectiveUid = await getEffectiveZohoUserId(req.user.id);

    const where  = ['user_id = ?'];
    const params = [effectiveUid];

    if (req.query.type) {
      where.push('account_type = ?');
      params.push(req.query.type);
    }
    if (req.query.active != null && req.query.active !== '') {
      where.push('is_active = ?');
      params.push(req.query.active === '1' || req.query.active === 'true' ? 1 : 0);
    }
    if (req.query.search) {
      where.push('(account_name LIKE ? OR account_code LIKE ?)');
      params.push(`%${req.query.search}%`, `%${req.query.search}%`);
    }

    const [rows] = await pool.execute(
      `SELECT id, org_id, zoho_account_id, account_code, account_name,
              account_type, account_type_formatted, account_subtype,
              parent_account_id, description,
              currency_id, currency_code,
              is_active, is_system_account, is_default_account,
              current_balance, current_balance_formatted,
              has_transactions, documents_count,
              zoho_created_time, zoho_last_modified_time, synced_at
         FROM zb_chart_of_accounts
        WHERE ${where.join(' AND ')}
        ORDER BY FIELD(account_type, 'bank', 'cash', 'accounts_receivable', 'other_current_asset',
                       'fixed_asset', 'other_asset', 'accounts_payable', 'credit_card',
                       'other_current_liability', 'long_term_liability', 'equity',
                       'income', 'other_income', 'cost_of_goods_sold', 'expense', 'other_expense'),
                 account_code, account_name`,
      params
    );

    // Enrich balances using the locally-computed Trial Balance (the CoA list
    // doesn't carry current_balance). Built from our ledger — no Zoho API call.
    // Falls back to 0 balances if the org has no local ledger yet.
    const balanceByName = {};
    let baseCurrency = null;
    try {
      const tb = await buildTrialBalance(effectiveUid, { platform: 'zoho', ...(req.orgId ? { org_id: req.orgId } : {}) });
      baseCurrency = tb.currency || null;
      (tb.rows || []).forEach((row) => {
        if (!row || row.isHeader || row.isTotal) return;
        const name = String(row.cells?.account || '').trim();
        if (!name) return;
        // The trial balance's closing balance is already the signed, debit-
        // positive net the accounts list displays.
        balanceByName[name.toLowerCase()] = Number(row.cells?.closing || 0);
      });
    } catch (_) {
      // Trial balance unavailable — proceed with zero balances.
    }

    // Normalise into the shape the existing Accounts.jsx UI expects (mirroring QB/Xero).
    const normalised = rows.map((r) => {
      const dbBalance = Number(r.current_balance || 0);
      const tbBalance = balanceByName[(r.account_name || '').toLowerCase()];
      const displayBalance = dbBalance !== 0 ? dbBalance : (tbBalance != null ? tbBalance : 0);
      return {
        ...r,
        qbo_id: r.zoho_account_id,
        name: r.account_name,
        fully_qualified_name: r.account_name,
        classification: classify(r.account_type),
        account_sub_type: r.account_subtype,
        account_number: r.account_code,
        currency: r.currency_code || baseCurrency,
        parent_qbo_id: r.parent_account_id,
        is_sub_account: r.parent_account_id ? 1 : 0,
        active: r.is_active ? 1 : 0,
        current_balance: displayBalance,
        current_balance_with_sub_accounts: displayBalance,
      };
    });

    // Apply classification filter (in JS since it's a derived column)
    const filtered = req.query.classification
      ? normalised.filter((a) => a.classification === req.query.classification)
      : normalised;

    // Build groupings + totals
    const byClassification = {};
    const totals = { Asset: 0, Liability: 0, Equity: 0, Revenue: 0, Expense: 0, Uncategorized: 0 };
    filtered.forEach((a) => {
      const k = a.classification || 'Uncategorized';
      if (!byClassification[k]) byClassification[k] = [];
      byClassification[k].push(a);
      if (a.active && !a.is_sub_account) {
        totals[k] = (totals[k] || 0) + Number(a.current_balance || 0);
      }
    });

    return res.json({
      data: filtered,
      total: filtered.length,
      byClassification,
      totals,
      source: 'zoho',
    });
  } catch (err) {
    console.error('Zoho accounts list error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/zoho/accounts/summary
router.get('/accounts/summary', async (req, res) => {
  try {
    const effectiveUid = await getEffectiveZohoUserId(req.user.id);
    const [rows] = await pool.execute(
      `SELECT account_type, is_active, current_balance, parent_account_id
         FROM zb_chart_of_accounts
        WHERE user_id = ?`,
      [effectiveUid]
    );
    const counts = { total: rows.length, active: 0, withTransactions: 0 };
    const byClassification = {};
    rows.forEach((r) => {
      if (r.is_active) counts.active += 1;
      const c = classify(r.account_type);
      if (!byClassification[c]) byClassification[c] = { count: 0, balance: 0 };
      byClassification[c].count += 1;
      if (r.is_active && !r.parent_account_id) byClassification[c].balance += Number(r.current_balance || 0);
    });
    return res.json({ counts, byClassification, source: 'zoho' });
  } catch (err) {
    console.error('Zoho accounts summary error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
