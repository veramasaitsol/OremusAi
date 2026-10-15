'use strict';

/**
 * Xero credit documents and their dated allocations / refunds.
 * ---------------------------------------------------------------------------
 * A bill or invoice in Xero is settled three ways: a cash Payment (already in
 * the ledger, dated, keyed to the bill), or an ALLOCATION of a credit note,
 * overpayment or prepayment. Xero's GL has no line for an allocation — it only
 * moves the open amount between two documents of the same contact — so the
 * posting-engine ledger can say a bill was settled but not WHEN. Without that
 * date a historical A/P (or A/R) aging can't tell whether the bill was still
 * open on the as-of date.
 *
 * Xero does return it: every CreditNote, Overpayment and Prepayment carries
 *   Allocations[] { AllocationID, Invoice{InvoiceID}, Amount, Date }
 *     (Date = "the date the allocation is applied")
 *   Payments[]    { PaymentID, Amount, Date, Status }   (cash refunds)
 *   RemainingCredit                                       (open today)
 * — all inside the scope the connection already has (accounting.transactions /
 * accounting.transactions.read). Those are stored here:
 *
 *   xero_credit_docs   one row per credit note / overpayment / prepayment
 *   xero_allocations   one row per allocation (kind ALLOCATION) or cash
 *                      refund (kind REFUND), in the document's own currency
 *
 * Written by the ledger rebuild (from lists it already fetches, plus
 * /Overpayments) and by syncXeroAllocations() for a targeted refresh.
 */

const pool = require('../config/db');

const DOC_TYPES = {
  CREDITNOTE:  { idKey: 'CreditNoteID',  numberKey: 'CreditNoteNumber' },
  OVERPAYMENT: { idKey: 'OverpaymentID', numberKey: null },
  PREPAYMENT:  { idKey: 'PrepaymentID',  numberKey: null },
};

// Payables-side Xero types; everything else (ACCRECCREDIT, RECEIVE-*) is AR.
const AP_TYPES = new Set(['ACCPAYCREDIT', 'SPEND-OVERPAYMENT', 'SPEND-PREPAYMENT']);

// Same "actually hits the books" statuses the posting engine uses.
const LIVE_STATUSES = new Set(['AUTHORISED', 'PAID']);

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const str = (v, max = 255) => (v == null || v === '' ? null : String(v).slice(0, max));

let tablesReady = false;
async function ensureXeroAllocationTables() {
  if (tablesReady) return;
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS xero_credit_docs (
       id               INT AUTO_INCREMENT PRIMARY KEY,
       user_id          INT           NOT NULL,
       org_id           VARCHAR(64)   NOT NULL,
       doc_type         VARCHAR(16)   NOT NULL,
       doc_id           VARCHAR(64)   NOT NULL,
       xero_type        VARCHAR(32)   NULL,
       side             CHAR(2)       NOT NULL,
       doc_number       VARCHAR(255)  NULL,
       reference        VARCHAR(255)  NULL,
       contact_id       VARCHAR(64)   NULL,
       contact_name     VARCHAR(255)  NULL,
       date             DATE          NULL,
       status           VARCHAR(20)   NULL,
       total            DECIMAL(18,2) NOT NULL DEFAULT 0,
       remaining_credit DECIMAL(18,2) NOT NULL DEFAULT 0,
       currency_code    VARCHAR(3)    NULL,
       currency_rate    DECIMAL(18,8) NULL,
       ledger_source_id VARCHAR(64)   NULL,
       synced_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
       UNIQUE KEY uq_doc (user_id, org_id, doc_type, doc_id),
       KEY idx_org_side (org_id, side)
     ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS xero_allocations (
       id             INT AUTO_INCREMENT PRIMARY KEY,
       user_id        INT           NOT NULL,
       org_id         VARCHAR(64)   NOT NULL,
       doc_type       VARCHAR(16)   NOT NULL,
       doc_id         VARCHAR(64)   NOT NULL,
       kind           VARCHAR(12)   NOT NULL,
       line_key       VARCHAR(100)  NOT NULL,
       invoice_id     VARCHAR(64)   NULL,
       invoice_number VARCHAR(255)  NULL,
       date           DATE          NULL,
       amount         DECIMAL(18,2) NOT NULL DEFAULT 0,
       synced_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
       UNIQUE KEY uq_line (user_id, org_id, doc_type, doc_id, kind, line_key),
       KEY idx_invoice (org_id, invoice_id),
       KEY idx_doc (org_id, doc_type, doc_id)
     ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  // Which document types have been fetched for an org — an org with no
  // overpayments has no rows, which must not read as "never synced".
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS xero_allocation_sync (
       user_id   INT         NOT NULL,
       org_id    VARCHAR(64) NOT NULL,
       doc_type  VARCHAR(16) NOT NULL,
       synced_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (user_id, org_id, doc_type)
     ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  // 'api' = read from Xero's own /Overpayments|/Prepayments|/CreditNotes;
  // 'derived' = rebuilt from the documents they were applied to (see
  // deriveCreditDocs) because the connection can't read those endpoints.
  const [cols] = await pool.execute(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'xero_allocation_sync'`
  );
  if (!cols.some((c) => c.name === 'source')) {
    await pool.execute("ALTER TABLE xero_allocation_sync ADD COLUMN source VARCHAR(10) NOT NULL DEFAULT 'api'")
      .catch((e) => { if (e.code !== 'ER_DUP_FIELDNAME') throw e; });
  }
  tablesReady = true;
}

// Rows for one document list. `ledgerIds` maps OverpaymentID / PrepaymentID →
// the BankTransactionID the posting engine used as the ledger source_id.
function rowsFor(docType, docs, userId, orgId, ledgerIds) {
  const { toDate } = require('./xeroPostingEngine'); // lazy: posting engine requires this module
  const { idKey, numberKey } = DOC_TYPES[docType];
  const docRows = [];
  const allocRows = [];
  for (const d of docs) {
    const docId = d[idKey];
    if (!docId) continue;
    const xeroType = String(d.Type || '').toUpperCase();
    docRows.push([
      userId, String(orgId), docType, String(docId), str(xeroType, 32),
      AP_TYPES.has(xeroType) ? 'ap' : 'ar',
      str(numberKey ? d[numberKey] : null), str(d.Reference),
      str(d.Contact?.ContactID, 64), str(d.Contact?.Name),
      toDate(d.DateString || d.Date), str(d.Status, 20),
      num(d.Total), num(d.RemainingCredit),
      str(d.CurrencyCode, 3), d.CurrencyRate != null ? num(d.CurrencyRate) : null,
      docType === 'CREDITNOTE' ? String(docId) : (ledgerIds.get(String(docId)) || null),
    ]);
    (d.Allocations || []).forEach((a, i) => {
      if (a.IsDeleted) return; // a removed allocation no longer settles anything
      allocRows.push([
        userId, String(orgId), docType, String(docId), 'ALLOCATION',
        String(a.AllocationID || `i${i}`),
        str(a.Invoice?.InvoiceID, 64), str(a.Invoice?.InvoiceNumber),
        toDate(a.DateString || a.Date), num(a.Amount),
      ]);
    });
    (d.Payments || []).forEach((p, i) => {
      if (String(p.Status || 'AUTHORISED').toUpperCase() === 'DELETED') return;
      allocRows.push([
        userId, String(orgId), docType, String(docId), 'REFUND',
        String(p.PaymentID || `p${i}`), null, str(p.Reference),
        toDate(p.DateString || p.Date), num(p.Amount),
      ]);
    });
  }
  return { docRows, allocRows };
}

const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const nameKey = (v) => String(v || '').trim().toLowerCase();

/**
 * Overpayments / prepayments rebuilt WITHOUT /Overpayments or /Prepayments —
 * both need the accounting.payments(.read) scope, which a granular-scope Xero
 * connection may not have. Everything else is readable with the scopes it
 * does have, so each document is reassembled in the shape Xero returns it:
 *
 *   header       the SPEND-/RECEIVE-OVERPAYMENT (or -PREPAYMENT) bank
 *                transaction that created it (OverpaymentID / PrepaymentID,
 *                Contact, Date, Total, currency) — /BankTransactions
 *   allocations  every invoice / bill lists the overpayments and prepayments
 *                applied to it, with AppliedAmount — /Invoices. The list has
 *                no allocation date, so it's taken as the LATER of the two
 *                documents' dates: that's the date Xero applies an allocation
 *                on — verified against every allocation Xero returned with a
 *                real date (39 of 39 credit-note allocations for one org).
 *   refunds      cash refunds, from /Payments when readable (exact, by
 *                OverpaymentID); otherwise from the ledger's refund lines,
 *                matched to the contact's overpayment they fit.
 *   RemainingCredit = Total − allocations − refunds.
 *
 * @param {'OVERPAYMENT'|'PREPAYMENT'} docType
 * @param {object} src { invoices, bankTransactions, payments, ledgerRefunds }
 */
function deriveCreditDocs(docType, { invoices, bankTransactions, payments, ledgerRefunds }) {
  const { toDate } = require('./xeroPostingEngine'); // lazy: posting engine requires this module
  const idKey = DOC_TYPES[docType].idKey;
  const kind = docType === 'OVERPAYMENT' ? 'OVERPAYMENT' : 'PREPAYMENT';
  const listKey = docType === 'OVERPAYMENT' ? 'Overpayments' : 'Prepayments';
  const docs = new Map();

  for (const bt of bankTransactions || []) {
    const id = bt[idKey];
    if (!id || !String(bt.Type || '').toUpperCase().endsWith(kind)) continue;
    if (String(bt.Status || '').toUpperCase() === 'DELETED') continue; // removed in Xero
    docs.set(String(id), {
      [idKey]: id, Type: String(bt.Type).toUpperCase(), Contact: bt.Contact,
      DateString: toDate(bt.DateString || bt.Date), Total: num(bt.Total), Reference: bt.Reference,
      CurrencyCode: bt.CurrencyCode, CurrencyRate: bt.CurrencyRate, Allocations: [], Payments: [],
    });
  }

  for (const inv of invoices || []) {
    if (!['AUTHORISED', 'PAID'].includes(String(inv.Status || '').toUpperCase())) continue;
    const invDate = toDate(inv.DateString || inv.Date);
    const isBill = String(inv.Type || '').toUpperCase() === 'ACCPAY';
    (inv[listKey] || []).forEach((o, i) => {
      const id = o[idKey];
      if (!id || !num(o.AppliedAmount)) return;
      const docDate = toDate(o.DateString || o.Date);
      if (!docs.has(String(id))) {
        // Applied but its bank transaction wasn't in the list — header from
        // the embedded copy (same contact as the document it settled).
        docs.set(String(id), {
          [idKey]: id, Type: `${isBill ? 'SPEND' : 'RECEIVE'}-${kind}`, Contact: inv.Contact,
          DateString: docDate, Total: num(o.Total), CurrencyCode: inv.CurrencyCode,
          CurrencyRate: o.CurrencyRate, Allocations: [], Payments: [],
        });
      }
      docs.get(String(id)).Allocations.push({
        AllocationID: `inv:${inv.InvoiceID}${i ? `:${i}` : ''}`,
        Invoice: { InvoiceID: inv.InvoiceID, InvoiceNumber: inv.InvoiceNumber },
        Amount: num(o.AppliedAmount),
        DateString: docDate && invDate ? (docDate > invDate ? docDate : invDate) : (docDate || invDate),
      });
    });
  }

  const used = (d) => [...d.Allocations, ...d.Payments].reduce((s, x) => s + num(x.Amount), 0);
  if (Array.isArray(payments)) {
    // Exact: each refund names the overpayment / prepayment it paid out.
    for (const p of payments) {
      const id = p[kind === 'OVERPAYMENT' ? 'Overpayment' : 'Prepayment']?.[idKey];
      if (!id || !docs.has(String(id)) || String(p.Status || '').toUpperCase() === 'DELETED') continue;
      docs.get(String(id)).Payments.push({ PaymentID: p.PaymentID, Amount: num(p.Amount), DateString: toDate(p.DateString || p.Date) });
    }
  } else if (kind === 'OVERPAYMENT') {
    // Ledger refund lines carry the contact, date and amount but not which
    // overpayment — give each to that contact's overpayment(s) dated on or
    // before it with credit left: an exact fit first, then newest first.
    for (const r of ledgerRefunds || []) {
      const mine = [...docs.values()]
        .filter((d) => nameKey(d.Contact?.Name) === nameKey(r.contact) && d.DateString && d.DateString <= r.date)
        .sort((a, b) => b.DateString.localeCompare(a.DateString));
      const room = (d) => round2(d.Total - used(d));
      let left = round2(r.amount);
      const exact = mine.find((d) => Math.abs(room(d) - left) < 0.01);
      for (const d of exact ? [exact] : mine) {
        if (left <= 0.005) break;
        const take = round2(Math.min(left, room(d)));
        if (take <= 0.005) continue;
        d.Payments.push({ PaymentID: `${r.id}${d.Payments.length ? `:${d.Payments.length}` : ''}`, Amount: take, DateString: r.date });
        left = round2(left - take);
      }
    }
  }

  for (const d of docs.values()) {
    d.RemainingCredit = Math.max(0, round2(d.Total - used(d)));
    d.Status = d.RemainingCredit > 0.005 ? 'AUTHORISED' : 'PAID';
  }
  return [...docs.values()];
}

// Overpayment refunds as the ledger holds them (posted from /Payments on an
// earlier run that could read it): AP refunds credit A/P, AR refunds debit A/R.
async function loadLedgerRefunds(userId, orgId) {
  const [rows] = await pool.execute(
    `SELECT source_id AS id, transaction_details AS contact,
            DATE_FORMAT(MIN(transaction_date), '%Y-%m-%d') AS date,
            SUM(CASE WHEN account_type_code = 'accounts_payable' THEN credit - debit ELSE debit - credit END) AS amount
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND transaction_id LIKE 'xero:%'
        AND source_type IN ('APOVERPAYMENTPAYMENT', 'AROVERPAYMENTPAYMENT')
        AND account_type_code IN ('accounts_payable', 'accounts_receivable')
      GROUP BY source_id, transaction_details`,
    [userId, String(orgId)]
  ).catch(() => [[]]);
  return rows.filter((r) => num(r.amount) > 0.005).map((r) => ({ ...r, amount: num(r.amount) }));
}

/**
 * Replace the stored credit docs + allocations for every document type whose
 * list was fetched. A list left null (fetch failed / not requested) keeps what
 * is already stored, so a rate-limited sync never wipes good data.
 * Overpayments / prepayments whose own endpoint couldn't be read are derived
 * from `invoices` + `bankTransactions` (+ `payments` when readable) instead —
 * see deriveCreditDocs.
 * @param {object} lists { creditNotes, overpayments, prepayments, bankTransactions, invoices, payments }
 */
async function persistXeroAllocations(userId, orgId, lists) {
  await ensureXeroAllocationTables();
  const source = { CREDITNOTE: 'api', OVERPAYMENT: 'api', PREPAYMENT: 'api' };
  const canDerive = Array.isArray(lists.invoices) && Array.isArray(lists.bankTransactions);
  const derived = {};
  for (const [docType, key] of [['OVERPAYMENT', 'overpayments'], ['PREPAYMENT', 'prepayments']]) {
    if (Array.isArray(lists[key]) || !canDerive) continue;
    const ledgerRefunds = docType === 'OVERPAYMENT' && !Array.isArray(lists.payments)
      ? await loadLedgerRefunds(userId, orgId) : null;
    derived[docType] = deriveCreditDocs(docType, { ...lists, ledgerRefunds });
    source[docType] = 'derived';
  }
  const ledgerIds = new Map();
  for (const bt of lists.bankTransactions || []) {
    for (const k of ['OverpaymentID', 'PrepaymentID']) {
      if (bt[k] && bt.BankTransactionID) ledgerIds.set(String(bt[k]), String(bt.BankTransactionID));
    }
  }
  const byType = {
    CREDITNOTE: lists.creditNotes,
    OVERPAYMENT: lists.overpayments || derived.OVERPAYMENT,
    PREPAYMENT: lists.prepayments || derived.PREPAYMENT,
  };
  const stats = {};
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [docType, docs] of Object.entries(byType)) {
      if (!Array.isArray(docs)) continue;
      const { docRows, allocRows } = rowsFor(docType, docs, userId, orgId, ledgerIds);
      await conn.execute('DELETE FROM xero_allocations WHERE user_id = ? AND org_id = ? AND doc_type = ?', [userId, String(orgId), docType]);
      await conn.execute('DELETE FROM xero_credit_docs WHERE user_id = ? AND org_id = ? AND doc_type = ?', [userId, String(orgId), docType]);
      for (let i = 0; i < docRows.length; i += 500) {
        await conn.query(
          `INSERT INTO xero_credit_docs
             (user_id, org_id, doc_type, doc_id, xero_type, side, doc_number, reference,
              contact_id, contact_name, date, status, total, remaining_credit,
              currency_code, currency_rate, ledger_source_id)
           VALUES ?`, [docRows.slice(i, i + 500)]);
      }
      for (let i = 0; i < allocRows.length; i += 500) {
        await conn.query(
          `INSERT INTO xero_allocations
             (user_id, org_id, doc_type, doc_id, kind, line_key, invoice_id, invoice_number, date, amount)
           VALUES ?`, [allocRows.slice(i, i + 500)]);
      }
      await conn.execute(
        `INSERT INTO xero_allocation_sync (user_id, org_id, doc_type, source) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE synced_at = CURRENT_TIMESTAMP, source = VALUES(source)`,
        [userId, String(orgId), docType, source[docType]]
      );
      stats[docType] = { docs: docRows.length, lines: allocRows.length, source: source[docType] };
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return stats;
}

/**
 * Targeted refresh — fetches only what the allocation tables need (credit
 * notes, overpayments, prepayments, and the over/prepayment bank transactions
 * for their ledger link) without rebuilding the ledger. Read-only against Xero.
 */
async function syncXeroAllocations(userId) {
  const { fetchAllPages } = require('./xeroPostingEngine');
  const { getValidXeroToken } = require('./xeroService');
  const auth = await getValidXeroToken(userId);
  if (!auth) throw new Error('Xero not connected for this user');
  // Each list on its own: /Overpayments and /Prepayments need the
  // accounting.payments(.read) scope, which a granular-scope connection may
  // not have been granted — a 401 there must not stop credit notes storing.
  const errors = {};
  const get = async (resource, extraParams) => {
    try {
      return await fetchAllPages(auth, resource, resource, { extraParams });
    } catch (e) {
      errors[resource] = e.response?.status ? `HTTP ${e.response.status}` : e.message;
      return null;
    }
  };
  const creditNotes = await get('CreditNotes');
  const overpayments = await get('Overpayments');
  const prepayments = await get('Prepayments');
  const bankTransactions = await get('BankTransactions', {
    where: 'Type=="SPEND-OVERPAYMENT" OR Type=="RECEIVE-OVERPAYMENT" OR Type=="SPEND-PREPAYMENT" OR Type=="RECEIVE-PREPAYMENT"',
  });
  // Only needed to derive overpayment / prepayment allocations when their own
  // endpoints can't be read (each invoice lists what was applied to it).
  const invoices = overpayments && prepayments ? null : await get('Invoices');
  const stats = await persistXeroAllocations(userId, auth.tenantId,
    { creditNotes, overpayments, prepayments, bankTransactions, invoices });
  return { orgId: auth.tenantId, ...stats, ...(Object.keys(errors).length ? { errors } : {}) };
}

/**
 * What the A/P (or A/R) reports need for one org, or null when nothing is
 * stored yet (table missing or never synced) so callers keep their
 * ledger-only behaviour.
 *   allocByInvoice:  InvoiceID → [{ date, amount, docType, docNumber }]
 *   credits:         live credit notes / overpayments on `side`, each with
 *                    its allocations + refunds, for an as-of open amount.
 *   creditsComplete: both credit notes and overpayments have been synced, so
 *                    `credits` is the full list of open A/P credits.
 */
async function loadXeroAllocations(userId, orgId, side = 'ap') {
  let docs;
  let lines;
  let synced;
  try {
    [synced] = await pool.execute(
      'SELECT doc_type FROM xero_allocation_sync WHERE user_id = ? AND org_id = ?',
      [userId, String(orgId)]
    );
    if (!synced.length) return null;
    [docs] = await pool.execute(
      `SELECT doc_type, doc_id, xero_type, side, doc_number, reference, contact_name,
              DATE_FORMAT(date, '%Y-%m-%d') AS date, status, total, remaining_credit,
              currency_code, currency_rate
         FROM xero_credit_docs WHERE user_id = ? AND org_id = ?`,
      [userId, String(orgId)]
    );
    [lines] = await pool.execute(
      `SELECT doc_type, doc_id, kind, invoice_id, DATE_FORMAT(date, '%Y-%m-%d') AS date, amount
         FROM xero_allocations WHERE user_id = ? AND org_id = ?`,
      [userId, String(orgId)]
    );
  } catch (_) {
    return null; // tables not created yet
  }

  const docKey = (t, id) => `${t}␟${id}`;
  const live = new Map();
  for (const d of docs) {
    if (!LIVE_STATUSES.has(String(d.status || '').toUpperCase())) continue;
    live.set(docKey(d.doc_type, d.doc_id), { ...d, total: num(d.total), remaining: num(d.remaining_credit), allocations: [], refunds: [] });
  }
  const allocByInvoice = new Map();
  for (const l of lines) {
    const doc = live.get(docKey(l.doc_type, l.doc_id));
    if (!doc) continue;
    const entry = { date: l.date, amount: num(l.amount) };
    if (l.kind === 'REFUND') { doc.refunds.push(entry); continue; }
    doc.allocations.push(entry);
    if (doc.side !== side || !l.invoice_id) continue;
    if (!allocByInvoice.has(l.invoice_id)) allocByInvoice.set(l.invoice_id, []);
    allocByInvoice.get(l.invoice_id).push({ ...entry, docType: l.doc_type, docNumber: doc.doc_number || doc.reference || null });
  }
  // Prepayments only reach A/P when allocated (the ledger posts them to their
  // own line account), so only credit notes and overpayments are open A/P items.
  const credits = [...live.values()].filter((d) => d.side === side && d.doc_type !== 'PREPAYMENT');
  // The open-credit list is only complete once BOTH A/P credit kinds are in —
  // otherwise callers keep inferring credits from the ledger.
  const syncedTypes = new Set(synced.map((r) => r.doc_type));
  const creditsComplete = syncedTypes.has('CREDITNOTE') && syncedTypes.has('OVERPAYMENT');
  return { allocByInvoice, credits, creditsComplete, syncedTypes };
}

// Open amount of a credit doc on `day` (YYYY-MM-DD): its total less what was
// allocated or refunded on or before then. 0 for a doc that didn't exist yet.
function creditOpenOn(doc, day) {
  if (!doc.date || doc.date > day) return 0;
  const used = [...doc.allocations, ...doc.refunds]
    .filter((x) => x.date && x.date <= day)
    .reduce((s, x) => s + x.amount, 0);
  return Math.round((doc.total - used) * 100) / 100;
}

module.exports = {
  ensureXeroAllocationTables,
  deriveCreditDocs,
  persistXeroAllocations,
  syncXeroAllocations,
  loadXeroAllocations,
  creditOpenOn,
};
