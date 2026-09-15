'use strict';

/**
 * Accounting Ledger ingestion.
 * ---------------------------------------------------------------------------
 * Pulls a provider's General Ledger (via its adapter) and persists it into the
 * provider-agnostic double-entry store:
 *
 *   acc_journal        — one row per source transaction (Invoice, Bill, …)
 *   acc_journal_lines  — the debit/credit lines per account (the GL itself)
 *
 * The provider GL report is grouped BY ACCOUNT (each account section lists the
 * transactions touching it). A single transaction therefore appears under
 * multiple account sections — e.g. an Invoice shows as a debit under Accounts
 * Receivable AND a credit under an Income account. We regroup those rows by
 * (source_type, source_ref) to reconstruct the full balanced journal entry.
 *
 * Idempotent: re-running upserts the journal and rewrites its lines. Validates
 * Σdebits == Σcredits per connection and records the result in acc_audit_log.
 */

const pool = require('../config/db');
const { resolveProvider, getProvider } = require('./accounting');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ─── audit ──────────────────────────────────────────────────────────────────
async function audit(conn, event, detail = null, source = {}) {
  try {
    await pool.execute(
      `INSERT INTO acc_audit_log
         (user_id, provider, connection_ref, event, source_type, source_ref, detail)
       VALUES (?,?,?,?,?,?, CAST(? AS JSON))`,
      [
        conn.effectiveUserId, conn.provider, conn.connectionRef, event,
        source.sourceType || null, source.sourceRef || null,
        detail == null ? null : JSON.stringify(detail),
      ]
    );
  } catch (e) { console.warn('[acc-ledger] audit write failed:', e.message); }
}

// ─── ensure the connection row exists (multi-org isolation) ──────────────────
async function ensureConnection(conn) {
  try {
    await pool.execute(
      `INSERT INTO acc_connections
         (user_id, provider, connection_ref, company_name, currency, environment)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         company_name = COALESCE(VALUES(company_name), company_name),
         currency     = COALESCE(VALUES(currency), currency),
         environment  = COALESCE(VALUES(environment), environment),
         is_active    = 1`,
      [conn.effectiveUserId, conn.provider, conn.connectionRef,
       conn.companyName || null, conn.currency || null, conn.environment || null]
    );
  } catch (e) { console.warn('[acc-ledger] ensureConnection failed:', e.message); }
}

// ─── regroup normalized GL rows into balanced journals ───────────────────────
// Returns Map<"sourceType|sourceRef", { header, lines:[] }>.
function buildJournals(gl) {
  const journals = new Map();
  let currentAccRef = null, currentAccName = null;

  for (const row of gl.rows || []) {
    if (row.isHeader) {
      currentAccRef  = row.accountRef || null;
      currentAccName = row.label || null;
      continue;
    }
    if (row.isSubtotal || row.isTotal) continue;

    const sourceRef  = row.sourceRef || null;
    const sourceType = row.sourceType || null;
    if (!sourceRef || !sourceType) continue; // skip rows we can't trace

    const debit  = round2(row.cells?.debit);
    const credit = round2(row.cells?.credit);
    if (debit === 0 && credit === 0) continue;

    const key = `${sourceType}|${sourceRef}`;
    let j = journals.get(key);
    if (!j) {
      j = {
        header: {
          sourceType, sourceRef,
          txnDate:   row.label || null,           // GL "Date" column
          docNumber: row.cells?.docnum || null,
          entity:    row.cells?.name || null,
          memo:      row.cells?.memo || null,
        },
        lines: [],
      };
      journals.set(key, j);
    }
    j.lines.push({
      accountRef:  currentAccRef,
      accountName: currentAccName,
      txnDate:     row.label || null,
      debit, credit,
      entity:      row.cells?.name || null,
      memo:        row.cells?.memo || null,
    });
  }
  return journals;
}

// ─── persist one journal + its lines (idempotent) ───────────────────────────
async function persistJournal(dbConn, conn, j) {
  const totalDebit  = j.lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = j.lines.reduce((s, l) => s + l.credit, 0);
  const totalAmt    = round2(Math.max(totalDebit, totalCredit));

  const [res] = await dbConn.execute(
    `INSERT INTO acc_journal
       (user_id, provider, connection_ref, source_type, source_ref, txn_date,
        doc_number, entity_name, memo, total_amt, currency)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       id = LAST_INSERT_ID(id),
       txn_date    = VALUES(txn_date),
       doc_number  = VALUES(doc_number),
       entity_name = VALUES(entity_name),
       memo        = VALUES(memo),
       total_amt   = VALUES(total_amt),
       currency    = VALUES(currency)`,
    [
      conn.effectiveUserId, conn.provider, conn.connectionRef,
      j.header.sourceType, j.header.sourceRef, j.header.txnDate || null,
      j.header.docNumber || null, j.header.entity || null, j.header.memo || null,
      totalAmt, conn.currency || null,
    ]
  );
  const journalId = res.insertId;

  // Rewrite lines (handles edits / re-sync cleanly).
  await dbConn.execute('DELETE FROM acc_journal_lines WHERE journal_id = ?', [journalId]);

  let lineNo = 0;
  for (const l of j.lines) {
    await dbConn.execute(
      `INSERT INTO acc_journal_lines
         (journal_id, user_id, provider, connection_ref, line_no, account_ref,
          account_name, txn_date, debit, credit, entity_name, memo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        journalId, conn.effectiveUserId, conn.provider, conn.connectionRef, lineNo++,
        l.accountRef || null, l.accountName || null, l.txnDate || null,
        l.debit, l.credit, l.entity || null, l.memo || null,
      ]
    );
  }
  return { journalId, totalDebit, totalCredit, lineCount: j.lines.length };
}

// ─── main: ingest the GL for a connection over [from,to] ─────────────────────
async function ingestLedger(adapter, conn, { from, to } = {}) {
  await ensureConnection(conn);
  await audit(conn, 'sync_started', { kind: 'ledger', from, to });

  let gl;
  try {
    gl = await adapter.fetchGeneralLedger(conn, { from_date: from, to_date: to });
  } catch (e) {
    await audit(conn, 'sync_failed', { kind: 'ledger', error: e.message });
    throw e;
  }

  const journals = buildJournals(gl);
  let journalsWritten = 0, linesWritten = 0, sumDebit = 0, sumCredit = 0;

  const dbConn = await pool.getConnection();
  try {
    for (const j of journals.values()) {
      const r = await persistJournal(dbConn, conn, j);
      journalsWritten += 1;
      linesWritten    += r.lineCount;
      sumDebit  += r.totalDebit;
      sumCredit += r.totalCredit;
    }
  } finally {
    dbConn.release();
  }

  const balanced = round2(sumDebit) === round2(sumCredit);
  const summary = {
    kind: 'ledger', from, to, journals: journalsWritten, lines: linesWritten,
    sumDebit: round2(sumDebit), sumCredit: round2(sumCredit), balanced,
  };
  if (!balanced) {
    console.warn(`[acc-ledger] IMBALANCE ${conn.provider}/${conn.connectionRef}: Dr ${summary.sumDebit} != Cr ${summary.sumCredit}`);
  }
  await audit(conn, 'sync_completed', summary);
  console.log(`[acc-ledger] ${conn.provider}/${conn.connectionRef} ingested ${journalsWritten} journals / ${linesWritten} lines (balanced=${balanced})`);
  return summary;
}

// ─── convenience: resolve provider for a user then ingest ────────────────────
async function ingestForUser(userId, reqOrgId = null, range = {}) {
  const resolved = await resolveProvider(userId, reqOrgId);
  if (!resolved) return { skipped: true, reason: 'no_connection' };
  return ingestLedger(resolved.adapter, resolved.conn, range);
}

module.exports = { ingestLedger, ingestForUser, buildJournals, getProvider };
