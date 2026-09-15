'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// /api/webhooks — inbound provider webhook intake (Phase 3 webhook sync).
//
// PUBLIC (no JWT — the provider calls it). Authenticity is checked with a shared
// secret (ZOHO_WEBHOOK_SECRET) passed as ?token= or X-Webhook-Token. Every event
// is logged verbatim to zb_webhook_logs, then a targeted incremental sync for the
// affected module is queued (deduped) so the warehouse converges quickly without
// waiting for the 15-min cron.
// ─────────────────────────────────────────────────────────────────────────────

const { Router } = require('express');
const pool = require('../config/db');
const jobQueue = require('../utils/jobQueue');
const { getValidToken } = require('../services/zohoService');
const { syncSingleModule } = require('../services/zohoBooksWarehouseService');

const router = Router();

// Zoho resource keyword → warehouse module
const RESOURCE_MODULE = {
  invoice: 'invoices', contact: 'contacts', bill: 'bills', item: 'items',
  customerpayment: 'customer_payments', vendorpayment: 'vendor_payments',
  creditnote: 'credit_notes', vendorcredit: 'vendor_credits', expense: 'expenses',
  estimate: 'estimates', salesorder: 'sales_orders', purchaseorder: 'purchase_orders',
  banktransaction: 'bank_transactions', journal: 'journals',
};

function detectModule(eventType, body) {
  const hay = `${eventType || ''} ${Object.keys(body || {}).join(' ')}`.toLowerCase();
  for (const key of Object.keys(RESOURCE_MODULE)) {
    if (hay.includes(key)) return RESOURCE_MODULE[key];
  }
  return null;
}

async function logActivity(userId, orgId, action, summary, detail) {
  try {
    await pool.execute(
      `INSERT INTO zb_activity_logs (user_id, provider, org_id, actor, action, summary, detail)
       VALUES (?, 'zoho', ?, 'webhook', ?, ?, ?)`,
      [userId ?? null, orgId ?? null, action, summary ?? null, detail ? JSON.stringify(detail) : null]
    );
  } catch (e) { console.warn('[webhook activity]', e.message); }
}

// ── POST /api/webhooks/zoho ───────────────────────────────────────────────────
router.post('/zoho', async (req, res) => {
  const body = req.body || {};
  const eventType = body.event_type || body.eventType || req.headers['x-zoho-event'] || null;
  const orgId = String(body.organization_id || body.organisation_id || req.query.org_id || '') || null;

  // signature / shared-secret check
  const secret = process.env.ZOHO_WEBHOOK_SECRET;
  const provided = req.query.token || req.headers['x-webhook-token'];
  const signatureOk = secret ? provided === secret : true;

  // resolve user from org
  let userId = null;
  if (orgId) {
    try {
      const [[row]] = await pool.execute(
        'SELECT user_id FROM zb_oauth_organizations WHERE org_id = ? LIMIT 1', [orgId]
      );
      userId = row?.user_id ?? null;
    } catch { /* ignore */ }
  }

  const module = detectModule(eventType, body);
  let logId = null;
  try {
    const [r] = await pool.execute(
      `INSERT INTO zb_webhook_logs
         (provider, user_id, org_id, event_type, module, resource_id, headers_json, payload_json, signature_ok, status)
       VALUES ('zoho', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, orgId, eventType, module,
       String(body.resource_id || body.id || '') || null,
       JSON.stringify({ 'x-zoho-event': req.headers['x-zoho-event'] || null }),
       JSON.stringify(body).slice(0, 4_000_000),
       signatureOk ? 1 : 0,
       signatureOk ? 'received' : 'ignored']
    );
    logId = r.insertId;
  } catch (e) {
    console.error('[webhook log]', e.message);
  }

  // Always 200 quickly so the provider doesn't retry-storm; process async.
  res.status(200).json({ received: true });

  if (!signatureOk) { console.warn('[webhook] bad secret — ignored'); return; }
  if (!userId || !module) {
    await markProcessed(logId, 'ignored', !userId ? 'no user for org' : 'no module mapped');
    return;
  }

  // queue a targeted incremental resync (deduped per user/org/module)
  const key = `wh-sync:${userId}:${orgId}:${module}`;
  jobQueue.enqueue(key, async () => {
    const accessToken = await getValidToken(userId);
    if (!accessToken) throw new Error('no valid Zoho token');
    return syncSingleModule(userId, accessToken, orgId, module);
  })
    .then(async () => {
      await markProcessed(logId, 'processed', null);
      await logActivity(userId, orgId, 'webhook.processed', `${eventType} → resynced ${module}`, { module });
    })
    .catch(async (e) => {
      await markProcessed(logId, 'failed', e.message);
      console.error('[webhook sync]', e.message);
    });
});

async function markProcessed(logId, status, error) {
  if (!logId) return;
  try {
    await pool.execute(
      `UPDATE zb_webhook_logs SET status=?, error=?, processed_at=NOW() WHERE id=?`,
      [status, error ? String(error).slice(0, 1000) : null, logId]
    );
  } catch { /* ignore */ }
}

module.exports = router;
