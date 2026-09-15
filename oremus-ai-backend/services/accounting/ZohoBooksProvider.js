'use strict';

/**
 * ZohoBooksProvider — accounting adapter for Zoho Books.
 * ---------------------------------------------------------------------------
 * Reports are computed ENTIRELY from the synced database via
 * zohoLedgerRegistry (same product rule as routes/zbReports.js): the website
 * never calls Zoho's report API at request time — Zoho is used only for OAuth
 * and data sync. Compare-with periods are handled natively by the local
 * builders, so no separate comparative path is needed.
 *
 * Accounts come from the synced zb_chart_of_accounts table; source documents
 * from the zb_* silver tables.
 */

const AccountingProvider = require('./AccountingProvider');
const pool = require('../../config/db');
const { getEffectiveZohoUserId } = require('../zohoService');
const { fetchLedgerReport } = require('../zohoLedgerRegistry');

// Zoho account_type → unified classification (Asset/Liability/Equity/Revenue/Expense).
function classifyZohoType(t) {
  const s = String(t || '').toLowerCase();
  if (/(income|revenue)/.test(s)) return 'Revenue';
  if (/(expense|cost_of_goods|cogs)/.test(s)) return 'Expense';
  if (/(payable|liabilit|credit_card)/.test(s)) return 'Liability';
  if (/equity/.test(s)) return 'Equity';
  if (/(asset|bank|cash|receivable|stock|inventory|fixed)/.test(s)) return 'Asset';
  return 'Uncategorized';
}

class ZohoBooksProvider extends AccountingProvider {
  get key() { return 'zoho'; }

  async resolveConnection(userId, reqOrgId = null) {
    let orgId = reqOrgId || null;
    if (!orgId) {
      const [[tok]] = await pool.execute(
        'SELECT org_id FROM zb_tokens WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1',
        [userId]
      );
      orgId = tok?.org_id || null;
    }
    // DB-only fallback: resolve org from synced data tables when zb_tokens
    // is missing.  Reports work purely from the database — no token needed.
    if (!orgId) {
      try {
        const [[row]] = await pool.execute(
          'SELECT org_id FROM zb_chart_of_accounts WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1',
          [userId]
        );
        orgId = row?.org_id || null;
      } catch (_) { /* table may not exist */ }
    }
    if (!orgId) {
      try {
        const [[row]] = await pool.execute(
          'SELECT org_id FROM zb_organizations WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1',
          [userId]
        );
        orgId = row?.org_id || null;
      } catch (_) { /* table may not exist */ }
    }
    if (!orgId) return null;

    const effectiveUserId = await getEffectiveZohoUserId(userId).catch(() => userId);

    let currency = 'INR', companyName = null;
    try {
      const [[org]] = await pool.execute(
        'SELECT name AS company_name, currency_code FROM zb_organizations WHERE user_id = ? AND org_id = ? LIMIT 1',
        [effectiveUserId, orgId]
      );
      if (org?.currency_code) currency = org.currency_code;
      if (org?.company_name)  companyName = org.company_name;
    } catch (_) { /* default */ }

    return {
      provider:        'zoho',
      connectionRef:   orgId,
      userId,
      effectiveUserId,
      currency,
      environment:     null,
      companyName,
    };
  }

  async listAccounts(conn) {
    const [rows] = await pool.execute(
      `SELECT zoho_account_id AS account_ref, account_code AS code, account_name AS name,
              account_type, account_subtype, parent_account_id AS parent_ref,
              currency_code, current_balance, is_active
         FROM zb_chart_of_accounts
        WHERE user_id = ? AND org_id = ? AND is_deleted = 0
        ORDER BY account_code IS NULL, account_code, account_name`,
      [conn.effectiveUserId, conn.connectionRef]
    );

    const accounts = rows.map((r) => {
      const classification = classifyZohoType(r.account_type);
      return {
        accountRef:     String(r.account_ref),
        code:           r.code || null,
        name:           r.name,
        fullyQualifiedName: r.name,
        accountType:    r.account_type,
        accountSubType: r.account_subtype,
        classification,
        parentRef:      r.parent_ref != null ? String(r.parent_ref) : null,
        currency:       r.currency_code || conn.currency,
        currentBalance: Number(r.current_balance || 0),
        balanceWithSub: Number(r.current_balance || 0),
        isSubAccount:   r.parent_ref != null,
        active:         !!r.is_active,
      };
    });

    const groups = {};
    const totals = {};
    for (const a of accounts) (groups[a.classification] ||= []).push(a);
    for (const [k, list] of Object.entries(groups)) {
      totals[k] = list
        .filter((a) => a.active && !a.isSubAccount)
        .reduce((s, a) => s + a.balanceWithSub, 0);
    }
    return { accounts, groups, totals };
  }

  async fetchReport(conn, type, params = {}) {
    // Synced-data only: effective user (clients inherit the admin's
    // connection) + the resolved org, computed by the local ledger builders.
    return fetchLedgerReport(conn.effectiveUserId, type, {
      ...params,
      org_id: params.org_id || conn.connectionRef,
    });
  }

  async fetchGeneralLedger(conn, params = {}) {
    return fetchLedgerReport(conn.effectiveUserId, 'generalledger', {
      ...params,
      org_id: params.org_id || conn.connectionRef,
    });
  }

  async getSourceDocument(conn, sourceType, sourceRef) {
    if (!sourceRef) return null;
    // Map common source types to their zb_* silver table + id column.
    const TABLE_MAP = {
      Invoice:         { table: 'invoices',             id: 'zoho_id' },
      Bill:            { table: 'bills',                id: 'zoho_id' },
      CustomerPayment: { table: 'zb_customer_payments', id: 'zoho_payment_id' },
      VendorPayment:   { table: 'zb_vendor_payments',   id: 'zoho_payment_id' },
      CreditNote:      { table: 'zb_credit_notes',      id: 'zoho_creditnote_id' },
      VendorCredit:    { table: 'zb_vendor_credits',    id: 'zoho_vendor_credit_id' },
      Journal:         { table: 'zb_journals',          id: 'zoho_journal_id' },
      JournalEntry:    { table: 'zb_journals',          id: 'zoho_journal_id' },
      Expense:         { table: 'expense_entries',      id: 'zoho_id' },
      BankTransaction: { table: 'bank_transactions',    id: 'transaction_id' },
    };
    const m = TABLE_MAP[sourceType];
    if (!m) return null;
    try {
      const [[row]] = await pool.execute(
        `SELECT * FROM ${m.table} WHERE user_id = ? AND org_id = ? AND ${m.id} = ? LIMIT 1`,
        [conn.effectiveUserId, conn.connectionRef, String(sourceRef)]
      );
      if (!row) return null;
      return { provider: 'zoho', sourceType, sourceRef: String(sourceRef), payload: row };
    } catch (_) {
      return null;
    }
  }
}

module.exports = ZohoBooksProvider;
module.exports.classifyZohoType = classifyZohoType;
