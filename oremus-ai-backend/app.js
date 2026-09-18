'use strict';
const path = require('path');
// Single environment file for every server (dev / testing / production). The same
// `.env` is deployed everywhere, so there is no environment-specific branching.
require('dotenv').config({
  path: path.resolve(__dirname, '.env'),
});
const express = require('express');
const cors    = require('cors');

const aiQueryRoutes = require('./routes/aiQuery')
const aiFeedbackRoutes = require('./routes/aiFeedback')
const authRoutes         = require('./routes/auth');
const dashboardRoutes    = require('./routes/dashboard');
const metricsRoutes      = require('./routes/metrics');
const ratiosRoutes       = require('./routes/ratios');
const customersRoutes    = require('./routes/customers');
const vendorsRoutes      = require('./routes/vendors');
const transactionsRoutes = require('./routes/transactions');
const dayBookRoutes      = require('./routes/dayBook');
const syncRoutes         = require('./routes/sync');
const clientsRoutes      = require('./routes/clients');
const searchRoutes       = require('./routes/search');
const quickbooksRoutes   = require('./routes/quickbooks');
const xeroReadRoutes     = require('./routes/xero');
const zbWarehouseRoutes  = require('./routes/zbWarehouse');
const qbWarehouseRoutes  = require('./routes/qbWarehouse');
const zbReportsRoutes    = require('./routes/zbReports');
const zohoReadRoutes     = require('./routes/zoho');
const accountingRoutes   = require('./routes/accounting');
const analyticsRoutes    = require('./routes/analytics');
const reportsRoutes      = require('./routes/reports');
const reportExportRoutes = require('./routes/reportExport');
const settingsRoutes     = require('./routes/settings');
const webhooksRoutes     = require('./routes/webhooks');
const notificationsRoutes = require('./routes/notifications');
const pool               = require('./config/db');

const app  = express();
const PORT = process.env.PORT || 5001;

// ── CORS ───────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5180',    // main frontend (dev, launch.json)
  'http://localhost:5181',    // standalone Day Book app (dev)
  'http://localhost:5182',    // oremus-web (dev, launch.json)
  'http://localhost:5183',    // oremus-next (dev, launch.json)
  'http://10.10.9.23:5173',   // local network dev
  'http://10.10.9.216:5173',  // local network dev (Zoho Console homepage URL)
  'https://oremuscorp.ai',                  // production frontend
  'https://www.oremuscorp.ai',
  'https://api.oremuscorp.ai',              // production backend (self)
  'https://oremusai.vensframe.com',
  'https://api.oremusai.vensframe.com',
  'https://daybook.vensframe.com',          // standalone Day Book app (prod)
  'https://www.daybook.vensframe.com',
  'https://oremusai.veramasa.com',
  'https://oremusui.vensframe.com',
  'http://122.175.56.137:8000/api/v1/query',
  'http://122.175.56.137:8000',
  'https://122.175.56.137:8000/api/v1/query',
  'https://122.175.56.137:8000',

  ...(process.env.DAYBOOK_URL ? [process.env.DAYBOOK_URL] : []),
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
];

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    console.warn(`CORS blocked: '${origin}'`);
    cb(null, false);
  },
  credentials:    true,
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Org-Id', 'X-Client-Id'],
};

app.options('*', cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Resolve the active Zoho organization (req.orgId) for every request. Never
// blocks — leaves req.orgId null when there's no org to scope by.
const orgScope = require('./middleware/orgScope');
app.use(orgScope);

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/api/auth',         authRoutes);
// Alias: some Zoho Console registrations omit the /api prefix (e.g. /auth/zoho/callback).
// Mounting at /auth as well ensures the callback works regardless.
app.use('/auth',             authRoutes);
app.use('/api/dashboard',    dashboardRoutes);
app.use('/api/metrics',      metricsRoutes);
app.use('/api/ratios',       ratiosRoutes);
app.use('/api/customers',    customersRoutes);
app.use('/api/vendors',      vendorsRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/daybook',      dayBookRoutes);
app.use('/api/sync',         syncRoutes);
app.use('/api/clients',      clientsRoutes);
app.use('/api/search',       searchRoutes);
app.use('/api/quickbooks',   quickbooksRoutes);
app.use('/api/xero',         xeroReadRoutes);
app.use('/api/sync/zb',      zbWarehouseRoutes);
app.use('/api/sync/qbo-wh',  qbWarehouseRoutes);
app.use('/api/zb-reports',   zbReportsRoutes);
app.use('/api/zoho',         zohoReadRoutes);
app.use('/api/accounting',   accountingRoutes);
app.use('/api/analytics',    analyticsRoutes);
app.use('/api/reports',      reportsRoutes);
app.use('/api/report-export', reportExportRoutes);
app.use('/api/settings',     settingsRoutes);
app.use('/api/notifications', notificationsRoutes);
// PUBLIC (no JWT — providers post here; authenticity via shared secret).
app.use('/api/webhooks',     webhooksRoutes);
app.use('/api/v1', aiQueryRoutes);
app.use('/api/v1', aiFeedbackRoutes);
// ── Health check ───────────────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  try {
    await pool.execute('SELECT 1');
    return res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch {
    return res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

// ── 404 ────────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Global error handler ───────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Crash guards (keeps cPanel process alive on unexpected throws) ─────────────
process.on('uncaughtException',  (err) => console.error('UncaughtException:', err.message));
process.on('unhandledRejection', (err) => console.error('UnhandledRejection:', err));

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Oremus backend running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
});

// ── DISABLED DURING DEVELOPMENT (2026-06-16) ───────────────────────────────────
// The ZB warehouse incremental cron + nightly full-validation cron are commented
// out because, while still developing, they were exhausting Zoho's 1000-calls/day
// per-org quota (each pass probes ~24 modules across every connected org). Re-enable
// both blocks once development is complete and a sane sync cadence is finalised.
// Until then, syncing is manual only (the /api/sync routes still work).
/*
// ── ZB warehouse cron (incremental sync every 15 min) ──────────────────────────
// Disable with ZB_WAREHOUSE_CRON=false. Skips users with no valid Zoho token.
if (process.env.ZB_WAREHOUSE_CRON !== 'false') {
  const { syncAllOrgsForUser } = require('./services/zohoBooksWarehouseService');
  const { runEtl } = require('./services/analyticsWarehouseService');
  // Default 6h: each incremental run probes ~24 modules (≥1 API call each), so a
  // tighter interval blows past Zoho's 1000-calls/day-per-org quota (15 min × 24
  // modules ≈ 2300/day → guaranteed daily rate-limit). 6h ≈ 96 calls/day/org,
  // leaving headroom for dashboard reports + manual syncs. Override with the env.
  const ZB_INTERVAL_MS = parseInt(process.env.ZB_WAREHOUSE_INTERVAL_MS || (6 * 60 * 60 * 1000));
  setInterval(async () => {
    try {
      // One pass per distinct connected user; the orchestrator syncs EVERY org
      // on the connection (multi-org accounts) and stops early on rate limits.
      const [users] = await pool.execute(
        `SELECT DISTINCT o.user_id
           FROM zb_oauth_organizations o
           JOIN zb_tokens t ON t.user_id = o.user_id`
      );
      for (const u of users) {
        try {
          const result = await syncAllOrgsForUser(u.user_id, {
            runType: 'incremental', triggerSource: 'cron',
          });
          // Refresh the analytics star-schema per synced org.
          for (const c of result.completed || []) {
            try {
              await runEtl(u.user_id, { provider: 'zoho', connectionRef: c.orgId });
            } catch (e) { console.error(`[Analytics ETL user=${u.user_id} org=${c.orgId}]`, e.message); }
          }
        } catch (e) { console.error(`[ZB cron user=${u.user_id}]`, e.message); }
      }
    } catch (e) { console.error('[ZB cron] outer error:', e.message); }
  }, ZB_INTERVAL_MS);
  console.log(`[ZB Warehouse] cron enabled — every ${Math.round(ZB_INTERVAL_MS/60000)} min`);
}

// ── Nightly full validation (deep resync + analytics rebuild) ──────────────────
// A full (non-incremental) sync once a day reconciles anything the incremental
// watermark path may have missed (deletes, back-dated edits). Disable with
// ZB_NIGHTLY_CRON=false. Runs when local time crosses the configured hour.
if (process.env.ZB_NIGHTLY_CRON !== 'false') {
  const { syncAllOrgsForUser } = require('./services/zohoBooksWarehouseService');
  const { runEtl } = require('./services/analyticsWarehouseService');
  const NIGHTLY_HOUR = parseInt(process.env.ZB_NIGHTLY_HOUR || '3', 10); // local hour 0-23
  let lastNightlyRunDay = null;
  setInterval(async () => {
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    if (now.getHours() !== NIGHTLY_HOUR || lastNightlyRunDay === dayKey) return;
    lastNightlyRunDay = dayKey;
    try {
      const [users] = await pool.execute(
        `SELECT DISTINCT o.user_id
           FROM zb_oauth_organizations o
           JOIN zb_tokens t ON t.user_id = o.user_id`
      );
      for (const u of users) {
        try {
          const result = await syncAllOrgsForUser(u.user_id, {
            runType: 'full', triggerSource: 'nightly',
          });
          for (const c of result.completed || []) {
            try {
              await runEtl(u.user_id, { provider: 'zoho', connectionRef: c.orgId });
            } catch (e) { console.error(`[Analytics ETL user=${u.user_id} org=${c.orgId}]`, e.message); }
          }
        } catch (e) { console.error(`[ZB nightly user=${u.user_id}]`, e.message); }
      }
    } catch (e) { console.error('[ZB nightly] outer error:', e.message); }
  }, 5 * 60 * 1000); // check every 5 min
  console.log(`[ZB Warehouse] nightly full-validation enabled — at ${NIGHTLY_HOUR}:00 local`);
}
*/

module.exports = app;