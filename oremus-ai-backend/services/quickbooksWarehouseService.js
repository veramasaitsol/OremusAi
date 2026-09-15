'use strict';
// QuickBooks Online "whole data" warehouse sync.
// Fetches EVERY queryable QBO entity via the Query API and stores each record's
// full JSON (plus extracted common columns) in the generic `qbo_entities` table.
// Bronze raw page archive → qbo_wh_raw_payloads; run audit → qbo_wh_sync_runs(_items).
//
// This is ADDITIVE and parallel to the legacy quickbooksService.syncAllQBOData —
// it never touches existing tables, so dashboards/reports/UI are unaffected.

const axios = require('axios');
const pool  = require('../config/db');
const { getApiBase } = require('./quickbooksService');

const MINOR_VERSION = process.env.QBO_MINOR_VERSION || '70';
const PAGE_SIZE = 1000;

// Every QBO Query-API entity that reliably returns rows with an `Id`, without
// special query params. Ordered: name-list/master first, then transactions.
const ENTITIES = [
  // Master / name-list
  'CompanyInfo', 'Preferences', 'CompanyCurrency', 'Account', 'Item',
  'Customer', 'Vendor', 'Employee', 'Class', 'Department',
  'PaymentMethod', 'Term', 'TaxCode', 'TaxRate', 'TaxAgency', 'Budget',
  // Transactions
  'Estimate', 'Invoice', 'CreditMemo', 'SalesReceipt', 'RefundReceipt',
  'Payment', 'Bill', 'BillPayment', 'VendorCredit', 'Purchase',
  'PurchaseOrder', 'Deposit', 'Transfer', 'JournalEntry', 'TimeActivity',
  'Attachable',
];

const num = (v) => (v == null || v === '' ? null : parseFloat(v));

const toMysqlDt = (iso) => {
  if (!iso) return null;
  try { return new Date(iso).toISOString().slice(0, 19).replace('T', ' '); }
  catch { return null; }
};

// QB datetime → DATE (YYYY-MM-DD) or null
const toDate = (d) => {
  if (!d) return null;
  const s = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

// A human-friendly label for the generic row.
function pickDisplayName(entity, r) {
  return (
    r.DisplayName || r.FullyQualifiedName || r.Name || r.CompanyName ||
    r.DocNumber || r.PaymentRefNum || r.CompanyName || null
  );
}

// ── Low-level query with bronze archive ──────────────────────────────────────
async function queryPage(userId, realmId, accessToken, environment, entity, start, runId) {
  const apiBase = getApiBase(environment);
  const url = `${apiBase}/v3/company/${realmId}/query`;
  const sql = `SELECT * FROM ${entity} STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`;
  const t0 = Date.now();
  let status = null, body = null, items = [], err = null;
  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      params:  { query: sql, minorversion: MINOR_VERSION },
    });
    status = res.status;
    const qr = res.data?.QueryResponse || {};
    items = qr[entity] || [];
    body = JSON.stringify(res.data);
  } catch (e) {
    status = e.response?.status || 0;
    err = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    throw Object.assign(new Error(err), { _logged: true, items: [] });
  } finally {
    try {
      await pool.execute(
        `INSERT INTO qbo_wh_raw_payloads
           (user_id, realm_id, entity, query, response_status, response_body,
            response_size, start_position, max_results, record_count, duration_ms, sync_run_id, error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          userId, realmId, entity, sql, status, body,
          body ? body.length : null, start, PAGE_SIZE, items.length,
          Date.now() - t0, runId || null, err,
        ]
      );
    } catch { /* archive is best-effort */ }
  }
  return items;
}

// ── Upsert one record into the generic qbo_entities table ────────────────────
async function upsertRecord(conn, userId, realmId, entity, r, runId) {
  // CompanyInfo / Preferences have Id; CompanyCurrency etc. all carry Id.
  const qboId = r.Id != null ? String(r.Id) : null;
  if (!qboId) return false; // skip Id-less rows (defensive)

  await conn.execute(
    `INSERT INTO qbo_entities
       (user_id, realm_id, entity, qbo_id, sync_token, display_name, doc_number,
        txn_date, total_amt, balance, currency, active, payload,
        qbo_created_at, qbo_updated_at, sync_run_id, synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CAST(? AS JSON),?,?,?,NOW())
     ON DUPLICATE KEY UPDATE
       sync_token     = VALUES(sync_token),
       display_name   = VALUES(display_name),
       doc_number     = VALUES(doc_number),
       txn_date       = VALUES(txn_date),
       total_amt      = VALUES(total_amt),
       balance        = VALUES(balance),
       currency       = VALUES(currency),
       active         = VALUES(active),
       payload        = VALUES(payload),
       qbo_created_at = VALUES(qbo_created_at),
       qbo_updated_at = VALUES(qbo_updated_at),
       sync_run_id    = VALUES(sync_run_id),
       synced_at      = NOW()`,
    [
      userId, realmId, entity, qboId,
      r.SyncToken != null ? String(r.SyncToken) : null,
      pickDisplayName(entity, r),
      r.DocNumber || null,
      toDate(r.TxnDate),
      num(r.TotalAmt),
      num(r.Balance),
      r.CurrencyRef?.value || null,
      r.Active === false ? 0 : (r.Active === true ? 1 : null),
      JSON.stringify(r),
      toMysqlDt(r.MetaData?.CreateTime),
      toMysqlDt(r.MetaData?.LastUpdatedTime),
      runId || null,
    ]
  );
  return true;
}

// ── Sync a single entity (all pages) ─────────────────────────────────────────
async function syncEntity(userId, accessToken, realmId, environment, entity, runId) {
  let start = 1, fetched = 0, upserted = 0, failed = 0, apiCalls = 0;
  const conn = await pool.getConnection();
  try {
    while (true) {
      const items = await queryPage(userId, realmId, accessToken, environment, entity, start, runId);
      apiCalls += 1;
      fetched += items.length;
      for (const r of items) {
        try { if (await upsertRecord(conn, userId, realmId, entity, r, runId)) upserted += 1; }
        catch { failed += 1; }
      }
      if (items.length < PAGE_SIZE) break;
      start += PAGE_SIZE;
    }
  } finally {
    conn.release();
  }
  return { fetched, upserted, failed, apiCalls };
}

// ── Master orchestrator ──────────────────────────────────────────────────────
async function syncAllQBOWarehouse(userId, accessToken, realmId, environment, opts = {}) {
  const entities = Array.isArray(opts.entities) && opts.entities.length ? opts.entities : ENTITIES;

  const [runRes] = await pool.execute(
    `INSERT INTO qbo_wh_sync_runs
       (user_id, realm_id, run_type, trigger_source, triggered_by_user, started_at,
        status, entities_requested)
     VALUES (?,?,?,?,?,NOW(),'running',CAST(? AS JSON))`,
    [
      userId, realmId, opts.runType || 'full', opts.triggerSource || 'manual',
      opts.triggeredBy || null, JSON.stringify(entities),
    ]
  );
  const runId = runRes.insertId;

  let totalCalls = 0, totalUpserted = 0, totalFailed = 0;
  const completed = [];
  const errors = [];

  console.log(`[QBO Warehouse] run #${runId} start userId=${userId} realm=${realmId} entities=${entities.length}`);

  for (const entity of entities) {
    const [itemRes] = await pool.execute(
      `INSERT INTO qbo_wh_sync_run_items (sync_run_id, entity, started_at, status)
       VALUES (?,?,NOW(),'running')`,
      [runId, entity]
    );
    const itemId = itemRes.insertId;
    try {
      const r = await syncEntity(userId, accessToken, realmId, environment, entity, runId);
      totalCalls += r.apiCalls; totalUpserted += r.upserted; totalFailed += r.failed;
      completed.push(entity);
      await pool.execute(
        `UPDATE qbo_wh_sync_run_items
           SET status='completed', completed_at=NOW(), api_calls=?, records_fetched=?,
               records_upserted=?, records_failed=?
         WHERE id=?`,
        [r.apiCalls, r.fetched, r.upserted, r.failed, itemId]
      );
    } catch (e) {
      const msg = (e.message || String(e)).slice(0, 500);
      errors.push(`${entity}: ${msg}`);
      await pool.execute(
        `UPDATE qbo_wh_sync_run_items SET status='failed', completed_at=NOW(), error=? WHERE id=?`,
        [msg, itemId]
      );
      console.warn(`[QBO Warehouse] entity ${entity} failed:`, msg);
    }
  }

  await pool.execute(
    `UPDATE qbo_wh_sync_runs
       SET status=?, completed_at=NOW(), entities_completed=CAST(? AS JSON),
           api_calls_made=?, records_upserted=?, records_failed=?, error_summary=?
     WHERE id=?`,
    [
      errors.length && completed.length === 0 ? 'failed' : 'completed',
      JSON.stringify(completed), totalCalls, totalUpserted, totalFailed,
      errors.length ? errors.join(' | ').slice(0, 2000) : null, runId,
    ]
  );

  console.log(`[QBO Warehouse] run #${runId} done — upserted:${totalUpserted} failed:${totalFailed} calls:${totalCalls} entities:${completed.length}/${entities.length}`);
  return { runId, upserted: totalUpserted, failed: totalFailed, apiCalls: totalCalls, completed };
}

module.exports = {
  ENTITIES,
  syncEntity,
  syncAllQBOWarehouse,
};
