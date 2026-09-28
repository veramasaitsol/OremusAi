'use strict';

/**
 * Unified, provider-agnostic accounting engine API.  Mounted at /api/accounting.
 * Auto-detects the requester's provider (Zoho / QuickBooks / Xero) and returns
 * the uniform { columns, rows, currency } report shape the frontend already
 * renders. Multi-org aware via the X-Org-Id header (req.orgId from orgScope).
 *
 * Routes:
 *   GET  /types                          — known report types for the active provider
 *   GET  /provider                       — the resolved active connection
 *   GET  /accounts                       — unified Chart of Accounts (grouped + totals)
 *   GET  /ledger?account_ref=&from=&to=  — one account's GL with running balance
 *   GET  /source/:sourceType/:sourceRef  — full source document (drill-down leaf)
 *   GET  /audit                          — recent acc_audit_log events
 *   POST /ingest                         — (re)ingest the GL into acc_journal(_lines)
 *   GET  /:type                          — a normalized financial report
 */

const { Router } = require('express');
const pool = require('../config/db');
const auth = require('../middleware/auth');
const { resolveProvider } = require('../services/accounting');
const qboReports = require('../services/quickbooksReportsService');
const { ingestLedger } = require('../services/accountingLedgerService');
const { getReportSettings } = require('../services/reportSettingsService');

const router = Router();
router.use(auth);
router.use(require('../middleware/adminClientView')); // honor admin view-as-client (X-Client-Id)

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Build provider-neutral report params from the query string. Anything the
// viewers can send must survive to the builder — a dropped param is a filter
// that silently does nothing. Mirrors routes/zbReports.js ALLOWED_PARAMS.
const ACCOUNTING_PASSTHROUGH = [
  'as_of_date', 'date_start', 'date_end',
  'account_id', 'customer_id', 'vendor_id', 'entity',
  'group_by', 'sort_column', 'sort_order',
  'tax_id', 'cash_basis', 'show_zero_balance', 'show_breakup',
  'interval_type', 'number_of_columns', 'compare_with',
  'currency_id', 'filter_by',
  'bs_from', // Balance Sheet: optional From date → Current-Year-Earnings split point
];
function buildParams(q) {
  const p = {};
  if (q.from || q.from_date) p.from_date = q.from || q.from_date;
  if (q.to   || q.to_date)   p.to_date   = q.to   || q.to_date;
  if (q.basis || q.accounting_basis) p.accounting_basis = q.basis || q.accounting_basis;
  if (q.interval)      p.interval      = q.interval;
  if (q.compare)       p.compare       = q.compare;
  if (q.compare_count) p.compare_count = q.compare_count;
  if (q.oldest_first)  p.oldest_first  = q.oldest_first;
  if (q.aging_by)      p.aging_by      = q.aging_by; // AR/AP aging basis (due vs invoice date)
  // Budget Summary: 'yearly' | 'monthly'
  if (q.period)        p.period        = q.period;
  // "Show rows with zero balances" toggles (Executive Summary / Trial Balance)
  if (q.include_zero)  p.include_zero  = q.include_zero;
  for (const k of ACCOUNTING_PASSTHROUGH) {
    if (q[k] !== undefined && q[k] !== '') p[k] = q[k];
  }
  return p;
}

// Resolve the active connection or send a clean 400 (frontend falls back to mock).
async function requireConn(req, res) {
  const resolved = await resolveProvider(req.user.id, req.orgId || null, req.adminUserId || null);
  if (!resolved) {
    res.status(400).json({ error: 'No accounting connection', code: 'NOT_CONNECTED' });
    return null;
  }
  return resolved;
}

// ── GET /api/accounting/types ────────────────────────────────────────────────
router.get('/types', async (req, res) => {
  const resolved = await requireConn(req, res);
  if (!resolved) return;
  // QBO has a concrete type registry; others advertise their own.
  const types = resolved.provider === 'quickbooks' ? qboReports.listReportTypes() : null;
  return res.json({ provider: resolved.provider, types });
});

// ── GET /api/accounting/provider ─────────────────────────────────────────────
router.get('/provider', async (req, res) => {
  const resolved = await requireConn(req, res);
  if (!resolved) return;
  const { provider, conn } = resolved;
  return res.json({
    provider,
    connectionRef: conn.connectionRef,
    companyName:   conn.companyName,
    currency:      conn.currency,
    environment:   conn.environment,
  });
});

// ── GET /api/accounting/accounts ─────────────────────────────────────────────
router.get('/accounts', async (req, res) => {
  const resolved = await requireConn(req, res);
  if (!resolved) return;
  try {
    const out = await resolved.adapter.listAccounts(resolved.conn);
    return res.json({ provider: resolved.provider, currency: resolved.conn.currency, ...out });
  } catch (e) {
    console.error('[accounting/accounts]', e.message);
    return res.status(502).json({ error: 'Failed to load accounts', code: e.code || 'ERROR' });
  }
});

// ── GET /api/accounting/ledger ───────────────────────────────────────────────
// One account's General Ledger from the posted double-entry lines, with a
// running balance computed at query time. This is the Report→Account drill.
router.get('/ledger', async (req, res) => {
  const resolved = await requireConn(req, res);
  if (!resolved) return;
  const { conn } = resolved;
  const accountRef = req.query.account_ref;
  if (!accountRef) return res.status(400).json({ error: 'account_ref is required' });

  // Zoho, Xero AND QuickBooks post their GL to `account_transactions` (the
  // unified acc_journal(_lines) tables aren't populated for any of them —
  // Xero's GL is synthesized into account_transactions scoped by
  // org_id = tenant_id, QuickBooks by org_id = realm_id via syncGeneralLedger).
  // Read directly from there scoped by user + org + account so the
  // Report→Account drill works off our DB (no live provider call).
  if (conn.provider === 'zoho' || conn.provider === 'xero' || conn.provider === 'quickbooks') {
    // ── DB-ONLY. Everything below reads our own synced `account_transactions`
    // (the general ledger all three platforms post into) plus local silver
    // tables (`invoices` / `bills` / `expense_entries` / `bank_transactions`)
    // for document numbers and names. It NEVER calls Zoho / Xero / QuickBooks'
    // own report or ledger APIs. Each lookup is isolated so one failing query
    // degrades gracefully instead of turning the whole drill into a 500.
    const uid   = conn.effectiveUserId;
    const org   = conn.connectionRef;
    const acct  = String(accountRef);
    const from  = req.query.from ? String(req.query.from).slice(0, 10) : null;
    const to    = req.query.to   ? String(req.query.to).slice(0, 10)   : null;
    // transaction_date is DATETIME — widen the upper bound to end-of-day so a
    // posting stamped with a time on the last day isn't dropped.
    const toEnd = to ? `${to} 23:59:59` : null;
    const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
    // resolveProvider checks Zoho first when an org is selected and can hand back
    // provider 'zoho' for a Xero tenant, so decide from the org itself.
    let isXeroLedger = conn.provider === 'xero';
    if (!isXeroLedger) {
      try {
        const [[xo]] = await pool.execute('SELECT 1 AS x FROM xero_organizations WHERE tenant_id = ? LIMIT 1', [org]);
        isXeroLedger = !!xo;
      } catch (_) { /* table absent on this deployment — not a Xero ledger */ }
    }

    const SRC_TYPE = {
      invoice: 'Invoice', bill: 'Bill', expense: 'Expense', journal: 'Journal',
      customer_payment: 'CustomerPayment', vendor_payment: 'VendorPayment',
    };
    const XERO_TYPE_LABEL = {
      ACCREC: 'Invoice', ACCPAY: 'Bill', ACCPAYCREDIT: 'Bill Credit',
      ACCRECCREDIT: 'Credit Note', BankSPEND: 'Expense', BankRECEIVE: 'Deposit',
      'BankSPEND-OVERPAYMENT': 'Expense', ManualJournal: 'Manual Journal',
      'xero-fx-unrealised': 'Unrealised FX Revaluation',
      ACCRECPAYMENT: 'Receivable Payment', ACCPAYPAYMENT: 'Payable Payment',
      'BankSPEND-PREPAYMENT': 'Prepayment', 'BankRECEIVE-PREPAYMENT': 'Prepayment',
      'BankRECEIVE-OVERPAYMENT': 'Overpayment',
    };

    // Run a read that is allowed to fail softly (a missing optional column on an
    // older deployment, an empty IN list, …) — returns [] instead of throwing.
    const softRows = async (sql, params, useQuery = false) => {
      try {
        const [r] = useQuery ? await pool.query(sql, params) : await pool.execute(sql, params);
        return Array.isArray(r) ? r : [];
      } catch (e) {
        console.warn('[accounting/ledger] soft query failed:', e.code || e.message);
        return [];
      }
    };

    // 1. Account classification (best-effort): normal side + name.
    let accountGroup = '';
    let accountName = '';
    const clsRows = await softRows(
      `SELECT account_group, account_name
         FROM account_transactions
        WHERE user_id = ? AND org_id = ? AND account_id = ? AND account_group IS NOT NULL
        LIMIT 1`,
      [uid, org, acct]
    );
    if (clsRows[0]) {
      accountGroup = String(clsRows[0].account_group || '').toLowerCase();
      accountName  = clsRows[0].account_name || '';
    }
    const isPlAccount  = accountGroup === 'income' || accountGroup === 'expense';
    const creditNormal = accountGroup === 'equity' || accountGroup === 'liability';
    const sign = creditNormal ? -1 : 1;
    // P&L drills exclude the Xero trial-balance true-up plug so they tie to the
    // P&L; balance-sheet drills keep it so they tie to the (cumulative) BS.
    const reconExcl = isPlAccount ? " AND transaction_id NOT LIKE 'xero-recon:%'" : '';

    // 2. Opening ("Beginning Balance"): net of every line strictly BEFORE `from`
    //    (recon plugs always included for a BS account), in the BS sign.
    let opening = 0;
    if (from && validDate(from)) {
      const d = new Date(from);
      const fyStart = Number.isNaN(d.getTime())
        ? null
        : `${d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1}-04-01`;
      // A Xero P&L account opens at its year-to-date movement (0 at FY start), as
      // in Xero's Account Transactions and our own General Ledger — never all
      // prior years plus the Trial-Balance true-up plugs, which made every Xero
      // P&L drill open at minus its period total and close at zero.
      const xeroPl = isXeroLedger && isPlAccount && fyStart;
      const obRows = await softRows(
        xeroPl
          ? `SELECT COALESCE(SUM(COALESCE(base_debit, debit)) - SUM(COALESCE(base_credit, credit)), 0) AS opening
               FROM account_transactions
              WHERE user_id = ? AND org_id = ? AND account_id = ?
                AND transaction_date >= ? AND transaction_date < ?
                AND transaction_id NOT LIKE 'xero-recon:%'`
          : `SELECT COALESCE(SUM(COALESCE(base_debit, debit)) - SUM(COALESCE(base_credit, credit)), 0) AS opening
               FROM account_transactions
              WHERE user_id = ? AND org_id = ? AND account_id = ?
                AND (transaction_date < ?${reconExcl}
                     OR transaction_id LIKE 'xero-recon:%')`,
        xeroPl ? [uid, org, acct, fyStart, from] : [uid, org, acct, from]
      );
      opening = round2(Number(obRows[0]?.opening || 0) * sign);

      // Retained Earnings carries pre-FY accumulated P&L on the Balance Sheet —
      // fold it into the opening so the drill reconciles to that line.
      if (creditNormal && /retained\s+earnings/i.test(accountName)) {
        if (fyStart) {
          const pi = await softRows(
            `SELECT COALESCE(SUM(COALESCE(base_credit, credit) - COALESCE(base_debit, debit)), 0) AS v FROM account_transactions
              WHERE user_id = ? AND org_id = ? AND account_group = 'income' AND transaction_date < ?`,
            [uid, org, fyStart]
          );
          const pe = await softRows(
            `SELECT COALESCE(SUM(COALESCE(base_debit, debit) - COALESCE(base_credit, credit)), 0) AS v FROM account_transactions
              WHERE user_id = ? AND org_id = ? AND account_group = 'expense' AND transaction_date < ?`,
            [uid, org, fyStart]
          );
          opening = round2(opening + Number(pi[0]?.v || 0) - Number(pe[0]?.v || 0));
        }
      }
    }

    // 3. The period's posting lines. This is the one query whose failure the
    //    caller must see — surface the real SQL error instead of "Server error".
    const where = ['user_id = ?', 'org_id = ?', 'account_id = ?'];
    const params = [uid, org, acct];
    if (from && validDate(from))  { where.push('transaction_date >= ?'); params.push(from); }
    if (toEnd && validDate(to))   { where.push('transaction_date <= ?'); params.push(toEnd); }
    if (isPlAccount) where.push("transaction_id NOT LIKE 'xero-recon:%'");

    let zrows;
    try {
      [zrows] = await pool.execute(
        `SELECT transaction_date, transaction_type, transaction_id, transaction_number,
                reference_number, account_name, transaction_details,
                COALESCE(base_debit, debit) AS debit, COALESCE(base_credit, credit) AS credit,
                debit AS native_debit, credit AS native_credit, currency_code, exchange_rate,
                source_id, source_type
           FROM account_transactions
          WHERE ${where.join(' AND ')}
          ORDER BY transaction_date ASC, id ASC`,
        params
      );
    } catch (e) {
      console.error('[accounting/ledger] main query failed:', e.code, e.sqlMessage || e.message);
      return res.status(500).json({ error: `Ledger query failed: ${e.code || e.message}`, code: e.code || 'LEDGER_QUERY_FAILED' });
    }

    // 4. Xero: resolve each line's document number/name from the local silver
    //    tables (keyed by the raw Xero UUID in source_id). pool.query — not
    //    execute — because `IN (?)` array expansion needs the text protocol.
    const docMeta = new Map();
    if (isXeroLedger && zrows.length) {
      const uuids = [...new Set(
        zrows.map((r) => String(r.source_id || '')).filter((v) => /^[0-9a-f-]{36}$/i.test(v))
      )];
      if (uuids.length) {
        const probes = [
          'SELECT xero_id, invoice_number AS num, customer_name AS name FROM invoices WHERE user_id = ? AND xero_id IN (?)',
          'SELECT xero_id, bill_number AS num, vendor_name AS name FROM bills WHERE user_id = ? AND xero_id IN (?)',
          'SELECT xero_id, reference_number AS num, vendor_name AS name FROM expense_entries WHERE user_id = ? AND xero_id IN (?)',
          'SELECT xero_id, reference_number AS num, payee AS name FROM bank_transactions WHERE user_id = ? AND xero_id IN (?)',
        ];
        const found = new Set();
        for (const sql of probes) {
          const remaining = uuids.filter((u) => !found.has(u));
          if (!remaining.length) break;
          for (let i = 0; i < remaining.length; i += 200) {
            // eslint-disable-next-line no-await-in-loop
            const rs = await softRows(sql, [uid, remaining.slice(i, i + 200)], true);
            for (const dr of rs) {
              if (dr.xero_id && (dr.num || dr.name)) {
                docMeta.set(String(dr.xero_id), { num: dr.num || '', name: dr.name || '' });
                found.add(String(dr.xero_id));
              }
            }
          }
        }
      }
    }

    // 5. Running balance in the Balance Sheet's sign convention.
    let zbal = opening;
    const ledger = zrows.map((r) => {
      const debit = round2(r.debit);
      const credit = round2(r.credit);
      zbal = round2(zbal + (creditNormal ? credit - debit : debit - credit));
      const rawType = r.transaction_type || r.source_type || '';
      const doc = isXeroLedger ? (docMeta.get(String(r.source_id || '')) || null) : null;
      const memoText = String(r.transaction_details || '').trim();
      let docNumber = r.transaction_number || r.reference_number || '';
      if (isXeroLedger) {
        // Invoice/bill lines resolve their number from the silver table (doc.num).
        // Anything not found there (payments, credit notes, and bills missing from
        // the bills table) falls back to the ledger's own reference_number — the
        // document number / Reference Xero shows. A manual journal's
        // reference_number holds its narration, so it keeps no Num (as in Xero).
        docNumber = doc?.num || (rawType === 'ManualJournal' ? '' : (r.reference_number || ''));
      } else if (/^\d+$/.test(String(docNumber)) && memoText.startsWith(docNumber)) {
        docNumber = '';
      }
      const typeLabel = isXeroLedger
        ? (XERO_TYPE_LABEL[rawType] || rawType)
        : (SRC_TYPE[rawType] || rawType);
      return {
        date: r.transaction_date,
        sourceType: typeLabel,
        sourceRef: r.transaction_id,
        docNumber,
        name: isXeroLedger ? (doc?.name || memoText || '') : r.transaction_details,
        memo: r.transaction_details,
        account: r.account_name,
        debit, credit, balance: zbal,
        // Original-currency detail (for exports / reconciliation); debit/credit
        // above stay the base-currency figures the balance is built from.
        currencyCode: r.currency_code || null,
        exchangeRate: r.exchange_rate != null ? Number(r.exchange_rate) : null,
        nativeDebit: round2(r.native_debit),
        nativeCredit: round2(r.native_credit),
      };
    });

    const totals = {
      debit:  round2(ledger.reduce((s, r) => s + r.debit, 0)),
      credit: round2(ledger.reduce((s, r) => s + r.credit, 0)),
      balance: zbal,
    };
    // Beginning Balance row — only for a period-scoped drill (opening → moves →
    // closing, like QuickBooks).
    if (from && validDate(from)) {
      ledger.unshift({
        date: null, sourceType: 'Beginning Balance', sourceRef: null,
        docNumber: '', name: '', memo: '', account: '',
        debit: 0, credit: 0, balance: opening, isOpening: true,
      });
    }
    return res.json({
      provider: conn.provider,
      accountRef: acct,
      currency: conn.currency,
      opening: (from && validDate(from)) ? opening : undefined,
      ledger,
      totals,
    });
  }

  const where = ['l.provider = ?', 'l.connection_ref = ?', 'l.user_id = ?', 'l.account_ref = ?'];
  const params = [conn.provider, conn.connectionRef, conn.effectiveUserId, String(accountRef)];
  if (req.query.from) { where.push('l.txn_date >= ?'); params.push(req.query.from); }
  if (req.query.to)   { where.push('l.txn_date <= ?'); params.push(req.query.to); }

  try {
    const [rows] = await pool.execute(
      `SELECT l.txn_date, l.debit, l.credit, l.account_name, l.entity_name, l.memo,
              j.source_type, j.source_ref, j.doc_number
         FROM acc_journal_lines l
         JOIN acc_journal j ON j.id = l.journal_id
        WHERE ${where.join(' AND ')}
        ORDER BY l.txn_date ASC, l.journal_id ASC, l.line_no ASC`,
      params
    );

    let balance = 0;
    const ledger = rows.map((r) => {
      const debit = round2(r.debit), credit = round2(r.credit);
      balance = round2(balance + debit - credit);
      return {
        date: r.txn_date, sourceType: r.source_type, sourceRef: r.source_ref,
        docNumber: r.doc_number, name: r.entity_name, memo: r.memo,
        account: r.account_name, debit, credit, balance,
      };
    });
    const totals = {
      debit:  round2(ledger.reduce((s, r) => s + r.debit, 0)),
      credit: round2(ledger.reduce((s, r) => s + r.credit, 0)),
      balance,
    };
    return res.json({ provider: conn.provider, accountRef: String(accountRef), currency: conn.currency, ledger, totals });
  } catch (e) {
    console.error('[accounting/ledger]', e.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/accounting/source/:sourceType/:sourceRef ────────────────────────
router.get('/source/:sourceType/:sourceRef', async (req, res) => {
  const resolved = await requireConn(req, res);
  if (!resolved) return;
  try {
    const doc = await resolved.adapter.getSourceDocument(
      resolved.conn, req.params.sourceType, req.params.sourceRef
    );
    if (!doc) return res.status(404).json({ error: 'Source document not found' });
    return res.json(doc);
  } catch (e) {
    console.error('[accounting/source]', e.message);
    return res.status(502).json({ error: 'Failed to load source document' });
  }
});

// ── GET /api/accounting/audit ────────────────────────────────────────────────
router.get('/audit', async (req, res) => {
  const resolved = await requireConn(req, res);
  if (!resolved) return;
  const { conn } = resolved;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  try {
    const [rows] = await pool.execute(
      `SELECT id, event, source_type, source_ref, detail, created_at
         FROM acc_audit_log
        WHERE user_id = ? AND provider = ? AND connection_ref = ?
        ORDER BY id DESC LIMIT ${limit}`,
      [conn.effectiveUserId, conn.provider, conn.connectionRef]
    );
    return res.json({ provider: conn.provider, events: rows });
  } catch (e) {
    console.error('[accounting/audit]', e.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/accounting/ingest ──────────────────────────────────────────────
// (Re)build the double-entry ledger for [from,to]. Runs in the background.
router.post('/ingest', async (req, res) => {
  const resolved = await requireConn(req, res);
  if (!resolved) return;
  const from = req.body?.from || req.query.from || null;
  const to   = req.body?.to   || req.query.to   || null;
  ingestLedger(resolved.adapter, resolved.conn, { from, to })
    .catch((e) => console.error('[accounting/ingest] async error:', e.message));
  return res.json({ message: 'Ledger ingestion started', provider: resolved.provider });
});

// ── GET /api/accounting/:type ────────────────────────────────────────────────
// Catch-all report route — MUST stay last so it doesn't shadow the static ones.
router.get('/:type', async (req, res) => {
  const resolved = await requireConn(req, res);
  if (!resolved) return;
  try {
    const params = buildParams(req.query);
    // Per-platform Financial Year start month (Settings → client override →
    // admin default → April). req.user.id is the client here (adminClientView
    // swaps it when an admin views as one).
    try {
      params.fy_start_month = (await getReportSettings(req.user.id, resolved.provider)).fyStartMonth;
    } catch { /* report_settings not present yet — builders default to April */ }
    const data = await resolved.adapter.fetchReport(
      resolved.conn, req.params.type, params,
      { refresh: req.query.refresh === '1' || req.query.refresh === 'true' }
    );
    // Stamp the report with the company the data actually came from, so the
    // viewer header always matches the resolved connection (not a stale client
    // name after an org switch or admin view-as-client).
    const company = resolved.conn.companyName || null;
    data.meta = { ...(data.meta || {}), company: data.meta?.company || company };
    return res.json({
      provider: resolved.provider,
      type: req.params.type,
      company,
      connectionRef: resolved.conn.connectionRef,
      ...data,
    });
  } catch (e) {
    if (e.code === 'UNKNOWN_REPORT_TYPE') return res.status(404).json({ error: e.message, code: e.code });
    if (e.code === 'NOT_CONNECTED')       return res.status(400).json({ error: e.message, code: e.code });
    if (e.code === 'NOT_IMPLEMENTED')     return res.status(501).json({ error: e.message, code: e.code });
    console.error('[accounting/report]', req.params.type, e.message);
    return res.status(e.status || 502).json({ error: e.message, code: e.code || 'ERROR' });
  }
});

module.exports = router;
