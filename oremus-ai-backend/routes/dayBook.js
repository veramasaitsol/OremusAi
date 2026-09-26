'use strict';

// Day Book — a chronological list of journal entries with their full
// double-entry account lines (account, debit, credit), mirroring how Zoho
// Books presents its Day Book report. Read-only.
//
// Source of truth = `account_transactions` — the synced GL postings, shared by
// all three platforms (Zoho / QuickBooks / Xero). Each posting row carries a
// `transaction_id` plus a `transaction_number` (the voucher no.). A single
// transaction_id can span several sub-vouchers (e.g. a customer payment #437
// plus the invoice applications CPL1183 / CPL1193 it settles), so we group by
// (transaction_id, transaction_number) — each pair is one self-balancing
// voucher (sum of debits == sum of credits), matching Zoho's Day Book exactly.
// Grouping by transaction_id alone merged those sub-vouchers into one unbalanced
// block. We deliberately do NOT use zb_journals/zb_journal_line_items: Zoho's
// /journals LIST endpoint omits line items + totals, so that table is empty.
const { Router } = require('express');
const pool       = require('../config/db');
const auth       = require('../middleware/auth');
const { resolveLocalCtx } = require('../services/metricsService');
const { getOrgCurrency }  = require('../services/zohoBooksReportsService');

const router = Router();
router.use(auth);
router.use(require('../middleware/adminClientView')); // honor admin view-as-client (X-Client-Id)

// Which platform is connected + the right effective user id + that org's
// currency — reusing resolveLocalCtx (the same Zoho→QuickBooks→Xero detection
// /api/metrics already relies on) instead of a Zoho-only resolver, so Day Book
// works for whichever platform a client actually has connected. No new table
// or column: currency comes from the org record each platform already syncs
// (zb_oauth_organizations / qbo_organizations / xero_organizations).
async function resolveDayBookContext(req) {
  let ctx = await resolveLocalCtx(req.user.id);
  if (!ctx && req.adminUserId) ctx = await resolveLocalCtx(req.adminUserId);
  if (!ctx) return null;

  const { provider, conn } = ctx;
  // An explicit X-Org-Id (multiple connections on the same platform) wins over
  // resolveLocalCtx's own pick; otherwise use whatever it auto-detected.
  const orgId = req.orgId || conn.connectionRef;
  let currency = conn.currency;
  if (req.orgId && req.orgId !== conn.connectionRef) {
    currency = (await lookupCurrencyForOrg(provider, conn.effectiveUserId, req.orgId)) || currency;
  }
  return { provider, effectiveUid: conn.effectiveUserId, orgId, currency };
}

async function lookupCurrencyForOrg(provider, userId, orgId) {
  try {
    if (provider === 'zoho') return await getOrgCurrency(userId, orgId);
    if (provider === 'quickbooks') {
      const [[row]] = await pool.execute(
        'SELECT currency FROM qbo_organizations WHERE user_id = ? AND realm_id = ? LIMIT 1',
        [userId, orgId]
      );
      return row?.currency || null;
    }
    if (provider === 'xero') {
      const [[row]] = await pool.execute(
        'SELECT currency FROM xero_organizations WHERE user_id = ? AND tenant_id = ? LIMIT 1',
        [userId, orgId]
      );
      return row?.currency || null;
    }
  } catch (_) { /* fall through to the caller's default */ }
  return null;
}

// GET /api/daybook?page&limit&search&type&from&to
// Paginates by TRANSACTION (entry), then attaches each entry's posting lines.
const EMPTY_RESPONSE = (page, limit) => ({
  data: [], total: 0, page, limit, periodDebit: 0, periodCredit: 0, types: [],
  currency: null, platform: null,
});

router.get('/', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));

    const dbCtx = await resolveDayBookContext(req);
    if (!dbCtx) return res.json(EMPTY_RESPONSE(page, limit));
    const { provider, effectiveUid, orgId, currency } = dbCtx;

    const offset = (page - 1) * limit;
    const from   = req.query.from || null;
    const to     = req.query.to   || null;
    const type   = (req.query.type || '').trim();
    const rawSearch = (req.query.search || '').trim();

    // ── Shared WHERE clause ────────────────────────────────────────────────────
    // org_id alone scopes to the right tenant regardless of platform — the
    // `platform` column on account_transactions is inconsistently populated
    // across historical syncs (many real rows carry it NULL), so filtering by
    // it would silently drop genuine data. Same reasoning already applied to
    // the P&L/Balance Sheet builders elsewhere in this codebase.
    let where    = 'at.user_id = ?';
    const params = [effectiveUid];

    if (orgId)  { where += ' AND at.org_id = ?';            params.push(orgId); }
    if (from)      { where += ' AND at.transaction_date >= ?'; params.push(from); }
    if (to)        { where += ' AND at.transaction_date <= ?'; params.push(to); }
    if (type)      { where += ' AND at.transaction_type = ?'; params.push(type); }

    if (rawSearch) {
      const like = `%${rawSearch}%`;
      where +=
        ` AND ( at.account_name LIKE ? OR at.transaction_details LIKE ?
                OR at.transaction_number LIKE ? OR at.reference_number LIKE ? )`;
      params.push(like, like, like, like);
    }

    // ── Period summary: distinct entries + total debit/credit ─────────────────
    // An entry = one voucher = (transaction_id, transaction_number). A single
    // Zoho transaction_id can hold several sub-vouchers (e.g. a customer payment
    // #437 plus the invoice applications CPL1183 / CPL1193 it settles); each is a
    // self-balancing voucher and must be counted/grouped separately to match Zoho.
    const [[summary]] = await pool.execute(
      `SELECT COUNT(DISTINCT at.transaction_id, at.transaction_number) AS total,
              COALESCE(SUM(COALESCE(at.base_debit, at.debit)),  0)        AS periodDebit,
              COALESCE(SUM(COALESCE(at.base_credit, at.credit)), 0)        AS periodCredit
         FROM account_transactions at
        WHERE ${where}`,
      params
    );

    // ── Distinct transaction types (for the filter dropdown) ──────────────────
    const [typeRows] = await pool.execute(
      `SELECT DISTINCT at.transaction_type AS t
         FROM account_transactions at
        WHERE at.user_id = ?
              ${orgId ? 'AND at.org_id = ?' : ''}
              AND at.transaction_type IS NOT NULL AND at.transaction_type <> ''
        ORDER BY t ASC`,
      orgId ? [effectiveUid, orgId] : [effectiveUid]
    );

    // ── One page of voucher keys, newest first ────────────────────────────────
    // Key = (transaction_id, transaction_number) so each Zoho sub-voucher is its
    // own balanced entry instead of being merged with siblings that share a id.
    const [groups] = await pool.execute(
      `SELECT at.transaction_id, at.transaction_number,
              MIN(at.transaction_date) AS entry_date
         FROM account_transactions at
        WHERE ${where}
        GROUP BY at.transaction_id, at.transaction_number
        ORDER BY entry_date DESC, at.transaction_id DESC, at.transaction_number DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    // ── Fetch every posting line for this page's vouchers ─────────────────────
    const keyOf = (id, num) => `${id}|${num ?? ''}`;
    let entries = [];
    if (groups.length) {
      // Row-value IN on the composite (transaction_id, transaction_number) key.
      const pairPlaceholders = groups.map(() => '(?,?)').join(',');
      const lineParams       = [effectiveUid];
      for (const g of groups) lineParams.push(g.transaction_id, g.transaction_number);

      const [rows] = await pool.query(
        `SELECT at.transaction_id, at.transaction_date, at.account_name,
                at.account_group, at.account_type_code, at.transaction_details,
                at.transaction_type, at.transaction_number, at.reference_number,
                COALESCE(at.base_debit, at.debit) AS debit, COALESCE(at.base_credit, at.credit) AS credit,
                COALESCE(at.base_currency_code, at.currency_code) AS currency_code
           FROM account_transactions at
          WHERE at.user_id = ?
            AND (at.transaction_id, at.transaction_number) IN (${pairPlaceholders})
          ORDER BY at.id ASC`,
        lineParams
      );

      // Group rows into entries keyed by (transaction_id, transaction_number).
      const byVoucher = new Map();
      for (const r of rows) {
        const key = keyOf(r.transaction_id, r.transaction_number);
        let e = byVoucher.get(key);
        if (!e) {
          e = {
            transactionId: r.transaction_id,
            date:          r.transaction_date,
            type:          r.transaction_type,
            number:        r.transaction_number,
            reference:     r.reference_number,
            totalDebit:    0,
            totalCredit:   0,
            // The transaction's own currency (not the org's base currency) —
            // every line of one voucher comes from the same source document,
            // so the first line that has one applies to the whole entry; only
            // falls back to the period-level org currency (below) when the
            // sync genuinely couldn't resolve one for this specific document.
            currency:      null,
            lines:         [],
          };
          byVoucher.set(key, e);
        }
        const debit  = Number(r.debit)  || 0;
        const credit = Number(r.credit) || 0;
        e.totalDebit  += debit;
        e.totalCredit += credit;
        if (!e.currency && r.currency_code) e.currency = r.currency_code;
        e.lines.push({
          account:     r.account_name,
          accountType: r.account_group || r.account_type_code,
          description: r.transaction_details,
          debit,
          credit,
          currency:    r.currency_code || null,
        });
      }

      // Re-order entries to match the paginated `groups` order (date DESC).
      const dateByKey = new Map(
        groups.map((g) => [keyOf(g.transaction_id, g.transaction_number), g.entry_date])
      );
      entries = groups
        .map((g) => byVoucher.get(keyOf(g.transaction_id, g.transaction_number)))
        .filter(Boolean)
        .map((e) => ({
          ...e,
          date:     dateByKey.get(keyOf(e.transactionId, e.number)) || e.date,
          currency: e.currency || currency,
        }));
    }

    return res.json({
      data:         entries,
      total:        summary.total,
      page,
      limit,
      periodDebit:  summary.periodDebit,
      periodCredit: summary.periodCredit,
      types:        typeRows.map((r) => r.t),
      currency,
      platform,
    });
  } catch (err) {
    console.error('Day Book list error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
