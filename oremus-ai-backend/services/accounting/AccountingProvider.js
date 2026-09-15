'use strict';

/**
 * AccountingProvider — base contract for every accounting integration.
 * ---------------------------------------------------------------------------
 * The accounting engine is provider-agnostic: routes/services talk only to this
 * interface, and each concrete adapter (QuickBooksProvider, ZohoBooksProvider,
 * XeroProvider, …) maps it onto its own backend. Adding a future provider
 * (FreshBooks, Tally, Sage, NetSuite, …) means implementing this class — no
 * changes to the routes, ledger ingestor, or frontend.
 *
 * A "connection" (conn) is the resolved, per-company context:
 *   {
 *     provider:          'quickbooks' | 'zoho' | 'xero',
 *     connectionRef:     QBO realm_id / Zoho org_id / Xero tenant_id,
 *     userId:            the ORIGINAL requesting user id,
 *     effectiveUserId:   the user id that actually owns the tokens/data
 *                        (clients inherit their admin's connection),
 *     currency:          reporting currency (e.g. 'USD', 'INR'),
 *     environment:       provider env hint ('sandbox' | 'production' | null),
 *     companyName:       display name when known,
 *   }
 *
 * All report output MUST be the uniform normalized shape consumed by the
 * frontend ReportTable:
 *   { columns: [{ key, label, align }],
 *     rows:    [{ label, level, isHeader?, isSubtotal?, isTotal?,
 *                 cells:{key:val}, accountRef?,
 *                 drill?:[{ name, ref, date, amount, sourceType, sourceRef }] }],
 *     currency }
 */
class AccountingProvider {
  /** @returns {string} canonical provider key, e.g. 'quickbooks'. */
  get key() {
    throw new Error('NOT_IMPLEMENTED: key');
  }

  /**
   * Resolve the active company connection for a user.
   * @param {number} userId           requesting user id
   * @param {string|null} reqOrgId    active org from the X-Org-Id header (multi-org)
   * @returns {Promise<object|null>}  a conn object, or null when not connected
   */
  // eslint-disable-next-line no-unused-vars
  async resolveConnection(userId, reqOrgId = null) {
    throw new Error('NOT_IMPLEMENTED: resolveConnection');
  }

  /**
   * Unified Chart of Accounts for the connection.
   * @returns {Promise<{accounts: Array, groups: object, totals: object}>}
   */
  // eslint-disable-next-line no-unused-vars
  async listAccounts(conn) {
    throw new Error('NOT_IMPLEMENTED: listAccounts');
  }

  /**
   * Fetch a financial report in normalized shape.
   * @param {object} conn
   * @param {string} type   canonical report type (profitandloss, balancesheet, …)
   * @param {object} params { from_date, to_date, accounting_basis, compare, … }
   * @param {object} opts   { refresh, ttlMs }
   * @returns {Promise<{columns, rows, currency}>}
   */
  // eslint-disable-next-line no-unused-vars
  async fetchReport(conn, type, params = {}, opts = {}) {
    throw new Error('NOT_IMPLEMENTED: fetchReport');
  }

  /**
   * Pull the provider's General Ledger for [from,to] as normalized rows so the
   * ledger ingestor can persist double-entry lines into acc_journal(_lines).
   * @returns {Promise<{columns, rows, currency}>}
   */
  // eslint-disable-next-line no-unused-vars
  async fetchGeneralLedger(conn, params = {}) {
    throw new Error('NOT_IMPLEMENTED: fetchGeneralLedger');
  }

  /**
   * Full source document for a drill-down leaf (Invoice, Bill, Payment, …).
   * @returns {Promise<object|null>} the raw document JSON (or null if absent)
   */
  // eslint-disable-next-line no-unused-vars
  async getSourceDocument(conn, sourceType, sourceRef) {
    throw new Error('NOT_IMPLEMENTED: getSourceDocument');
  }
}

module.exports = AccountingProvider;
