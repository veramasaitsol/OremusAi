'use strict';
// Zoho Books Warehouse API endpoints.
// All endpoints require Bearer JWT.

const { Router } = require('express');
const pool       = require('../config/db');
const auth       = require('../middleware/auth');
const { getValidToken, getEffectiveZohoUserId } = require('../services/zohoService');
const {
  syncAllZohoBooksWarehouse,
  syncSingleModule,
  syncAllOrgsForUser,
  MODULE_ORDER,
} = require('../services/zohoBooksWarehouseService');

const router = Router();
router.use(auth);

// Helper — resolve valid access token + org_id for the user.
// getValidToken THROWS when the stored refresh token can no longer be
// exchanged (a revoked grant, or one issued by a different OAuth app). Left
// unhandled that rejection escapes the route and the caller gets no response
// at all, so it is turned into a 401 telling the user to reconnect.
async function getZohoContext(userId) {
  let accessToken;
  try {
    accessToken = await getValidToken(userId);
  } catch (e) {
    if (e.code === 'REAUTH_REQUIRED') {
      return { error: e.message, code: e.code, status: 401 };
    }
    throw e;
  }
  if (!accessToken) return { error: 'Zoho not connected' };
  const [rows] = await pool.execute('SELECT org_id FROM zb_tokens WHERE user_id = ?', [userId]);
  if (!rows[0]?.org_id) return { error: 'Zoho org_id missing' };
  return { accessToken, orgId: rows[0].org_id };
}

// ── POST /api/sync/zb/all ─────────────────────────────────────────────────────
// Triggers a warehouse sync for EVERY organization on the connection (a Zoho
// account can expose several orgs). Runs in the background; returns immediately.
// Clients inheriting the admin's Zoho connection sync the admin's orgs.
router.post('/all', async (req, res) => {
  const effectiveUserId = await getEffectiveZohoUserId(req.user.id);
  const ctx = await getZohoContext(effectiveUserId);
  if (ctx.error) return res.status(ctx.status || 400).json({ error: ctx.error, code: ctx.code });

  const isFull = !!req.body?.full;
  syncAllOrgsForUser(effectiveUserId, {
    runType: isFull ? 'full' : 'incremental',
    triggerSource: 'manual',
    full: isFull,
  }).catch((e) => console.error('[ZB Warehouse] async error:', e.message));

  return res.json({ message: 'Warehouse sync started in background (all organizations)' });
});

// ── POST /api/sync/zb/:module ─────────────────────────────────────────────────
router.post('/:module', async (req, res) => {
  const { module } = req.params;
  if (!MODULE_ORDER.includes(module)) {
    return res.status(400).json({ error: `Unknown module: ${module}`, valid: MODULE_ORDER });
  }
  const ctx = await getZohoContext(req.user.id);
  if (ctx.error) return res.status(ctx.status || 400).json({ error: ctx.error, code: ctx.code });

  syncSingleModule(req.user.id, ctx.accessToken, ctx.orgId, module)
    .catch((e) => console.error(`[ZB Warehouse] ${module} error:`, e.message));

  return res.json({ message: `${module} sync started in background` });
});

// ── GET /api/sync/zb/status ───────────────────────────────────────────────────
// ?run_id=N → details for one run
// (omitted) → last 10 runs for this user
router.get('/status', async (req, res) => {
  try {
    const { run_id } = req.query;
    if (run_id) {
      const [[run]] = await pool.execute(
        `SELECT * FROM zb_sync_runs WHERE id = ? AND user_id = ?`,
        [run_id, req.user.id]
      );
      if (!run) return res.status(404).json({ error: 'Run not found' });
      const [items] = await pool.execute(
        `SELECT id, module, status, api_calls, records_fetched, records_inserted,
                records_updated, records_failed, started_at, completed_at, error
         FROM zb_sync_run_items WHERE sync_run_id = ? ORDER BY id ASC`,
        [run_id]
      );
      return res.json({ run, items });
    }
    const [rows] = await pool.execute(
      `SELECT id, run_type, status, trigger_source, started_at, completed_at,
              api_calls_made, records_inserted, records_updated, records_failed, error_summary
       FROM zb_sync_runs WHERE user_id = ? ORDER BY id DESC LIMIT 10`,
      [req.user.id]
    );
    return res.json({ runs: rows });
  } catch (e) {
    console.error('[ZB status] error:', e.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/sync/zb/watermarks ───────────────────────────────────────────────
router.get('/watermarks', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT module, last_modified_after, last_synced_at, records_total
       FROM zb_sync_watermarks WHERE user_id = ?
       ORDER BY module ASC`,
      [req.user.id]
    );
    return res.json({ watermarks: rows });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/sync/zb/watermarks ───────────────────────────────────────────
// Clears sync watermarks so the next run does a full re-fetch.
router.delete('/watermarks', async (req, res) => {
  try {
    await pool.execute('DELETE FROM zb_sync_watermarks WHERE user_id = ?', [req.user.id]);
    return res.json({ message: 'Watermarks cleared' });
  } catch (e) {
    console.error('[ZB watermarks] delete error:', e.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/sync/zb/health ───────────────────────────────────────────────────
// Returns Zoho connection state + API quota availability.
router.get('/health', async (req, res) => {
  try {
    const { getValidToken } = require('../services/zohoService');
    const accessToken = await getValidToken(req.user.id).catch(() => null);
    if (!accessToken) {
      return res.json({ connected: false, quotaAvailable: true });
    }
    const [orgRows] = await pool.execute(
      'SELECT org_id FROM zb_tokens WHERE user_id = ? AND org_id IS NOT NULL LIMIT 1',
      [req.user.id]
    );
    const orgId = orgRows[0]?.org_id;
    if (!orgId) return res.json({ connected: true, quotaAvailable: true });

    // Lightweight API test — fetch org list (1 API call)
    const axios = require('axios');
    try {
      const r = await axios.get('https://www.zohoapis.in/books/v3/organizations', {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        timeout: 8000,
      });
      const code = r.data?.code;
      if (code === 45) {
        return res.json({
          connected: true,
          quotaAvailable: false,
          quotaMessage: r.data?.message ?? 'Daily API limit reached. Data will refresh tomorrow.',
        });
      }
      const invoiceCount = await pool.execute(
        'SELECT COUNT(*) AS c FROM invoices WHERE user_id = ?', [req.user.id]
      ).then(([[row]]) => parseInt(row?.c || 0)).catch(() => 0);
      return res.json({ connected: true, quotaAvailable: true, invoiceCount });
    } catch (apiErr) {
      // Network error or auth error — treat as connected but quota unknown
      return res.json({ connected: true, quotaAvailable: true });
    }
  } catch (e) {
    console.error('[ZB health] error:', e.message);
    return res.json({ connected: false, quotaAvailable: true });
  }
});

// ── GET /api/sync/zb/counts ───────────────────────────────────────────────────
// Quick "how much data is in the warehouse" overview for the current user.
router.get('/counts', async (req, res) => {
  try {
    const tables = [
      'zb_organizations','zb_currencies','zb_chart_of_accounts','zb_tax_rates',
      'zb_items','customers','vendors','zb_contact_persons','zb_contact_addresses',
      'zb_projects','zb_tasks','zb_time_entries',
      'zb_estimates','zb_sales_orders','zb_purchase_orders',
      'invoices','zb_invoice_line_items','zb_recurring_invoices',
      'bills','zb_bill_line_items','zb_recurring_bills',
      'zb_customer_payments','zb_customer_payment_invoices',
      'zb_vendor_payments','zb_vendor_payment_bills',
      'zb_credit_notes','zb_credit_note_invoices',
      'zb_vendor_credits',
      'expense_entries','zb_expense_line_items','zb_recurring_expenses',
      'zb_journals','zb_journal_line_items',
      'zb_bank_accounts',
      'zb_raw_payloads','zb_sync_runs',
    ];
    const out = {};
    for (const t of tables) {
      try {
        const [[r]] = await pool.execute(`SELECT COUNT(*) AS c FROM ${t} WHERE user_id = ?`, [req.user.id]);
        out[t] = parseInt(r?.c || 0);
      } catch { out[t] = null; }
    }
    return res.json({ counts: out });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
