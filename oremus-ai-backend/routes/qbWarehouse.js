'use strict';
// QuickBooks Online Warehouse API endpoints. All require Bearer JWT.

const { Router } = require('express');
const pool       = require('../config/db');
const auth       = require('../middleware/auth');
const { getValidQBOToken, getEffectiveQBUserId } = require('../services/quickbooksService');
const { syncAllQBOWarehouse, syncEntity, ENTITIES } = require('../services/quickbooksWarehouseService');

const router = Router();
router.use(auth);

// Resolve a valid QBO access token + realm for the requester (handles the
// company-owned connection model where clients inherit the admin's connection).
async function getQBContext(userId) {
  const effectiveId = await getEffectiveQBUserId(userId);
  const tok = await getValidQBOToken(effectiveId);
  if (!tok) return { error: 'QuickBooks not connected' };
  return { ...tok, effectiveId };
}

// ── POST /api/sync/qbo-wh/all ─────────────────────────────────────────────────
router.post('/all', async (req, res) => {
  const ctx = await getQBContext(req.user.id);
  if (ctx.error) return res.status(400).json({ error: ctx.error });

  // One click = full fetch into qbo_entities (then accounting ledger ingest runs).
  syncAllQBOWarehouse(ctx.effectiveId, ctx.accessToken, ctx.realmId, ctx.environment, {
    runType: 'full',
    triggerSource: 'manual',
    triggeredBy: req.user.id,
  })
    .catch((e) => console.error('[QBO Warehouse] async error:', e.message));

  return res.json({ message: 'QuickBooks warehouse sync started in background' });
});

// ── POST /api/sync/qbo-wh/entity/:entity ──────────────────────────────────────
router.post('/entity/:entity', async (req, res) => {
  const { entity } = req.params;
  if (!ENTITIES.includes(entity)) {
    return res.status(400).json({ error: `Unknown entity: ${entity}`, valid: ENTITIES });
  }
  const ctx = await getQBContext(req.user.id);
  if (ctx.error) return res.status(400).json({ error: ctx.error });

  syncEntity(ctx.effectiveId, ctx.accessToken, ctx.realmId, ctx.environment, entity, null)
    .catch((e) => console.error(`[QBO Warehouse] ${entity} error:`, e.message));

  return res.json({ message: `${entity} sync started in background` });
});

// ── GET /api/sync/qbo-wh/status ───────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const effectiveId = await getEffectiveQBUserId(req.user.id);
    const { run_id } = req.query;
    if (run_id) {
      const [[run]] = await pool.execute(
        `SELECT * FROM qbo_wh_sync_runs WHERE id = ? AND user_id = ?`,
        [run_id, effectiveId]
      );
      if (!run) return res.status(404).json({ error: 'Run not found' });
      const [items] = await pool.execute(
        `SELECT id, entity, status, api_calls, records_fetched, records_upserted,
                records_failed, started_at, completed_at, error
         FROM qbo_wh_sync_run_items WHERE sync_run_id = ? ORDER BY id ASC`,
        [run_id]
      );
      return res.json({ run, items });
    }
    const [rows] = await pool.execute(
      `SELECT id, run_type, status, trigger_source, started_at, completed_at,
              api_calls_made, records_upserted, records_failed, error_summary
       FROM qbo_wh_sync_runs WHERE user_id = ? ORDER BY id DESC LIMIT 10`,
      [effectiveId]
    );
    return res.json({ runs: rows });
  } catch (e) {
    console.error('[QBO WH status] error:', e.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/sync/qbo-wh/counts ───────────────────────────────────────────────
// Per-entity record counts in the warehouse for the current (effective) user.
router.get('/counts', async (req, res) => {
  try {
    const effectiveId = await getEffectiveQBUserId(req.user.id);
    const [rows] = await pool.execute(
      `SELECT entity, COUNT(*) AS c, MAX(synced_at) AS last_synced
       FROM qbo_entities WHERE user_id = ? GROUP BY entity ORDER BY entity ASC`,
      [effectiveId]
    );
    const counts = {};
    let total = 0;
    for (const r of rows) { counts[r.entity] = { count: Number(r.c), last_synced: r.last_synced }; total += Number(r.c); }
    return res.json({ total, counts });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
