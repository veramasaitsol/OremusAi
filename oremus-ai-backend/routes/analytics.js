'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// /api/analytics — fast read API over the star-schema warehouse (Phase 5 + 8).
//
// All reads hit the pre-aggregated fact_*/dim_* tables (not raw zb_*), cached
// in-process for a few seconds (Phase 9). POST /rebuild runs the ETL through the
// sequential job queue. Provider-agnostic: scoped by (user_id, provider,
// connection_ref); Zoho org_id is today's connection_ref.
// ─────────────────────────────────────────────────────────────────────────────

const { Router } = require('express');
const pool  = require('../config/db');
const auth  = require('../middleware/auth');
const cache = require('../utils/cache');
const jobQueue = require('../utils/jobQueue');
const { runEtl } = require('../services/analyticsWarehouseService');

const router = Router();
router.use(auth);
router.use(require('../middleware/adminClientView')); // honor admin view-as-client (X-Client-Id)

const PROVIDER = 'zoho';
const TTL = 15000; // 15s

// resolve connection + guard. req.orgId is set by global orgScope middleware.
function ctx(req, res) {
  const userId = req.user.id;
  const conn = req.orgId;
  if (!conn) { res.status(400).json({ error: 'No active connection (Zoho org) for analytics' }); return null; }
  return { userId, conn };
}

// build [from,to] WHERE fragment on a date column
function dateRange(req) {
  const { from, to } = req.query;
  const clauses = [];
  const params = [];
  if (from) { clauses.push('txn_date >= ?'); params.push(from); }
  if (to)   { clauses.push('txn_date <= ?'); params.push(to); }
  return { sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params, key: `${from || '*'}_${to || '*'}` };
}

async function one(sql, params) {
  const [[row]] = await pool.execute(sql, params);
  return row || {};
}

// ── POST /api/analytics/rebuild ───────────────────────────────────────────────
router.post('/rebuild', async (req, res) => {
  const c = ctx(req, res); if (!c) return;
  const key = `etl:${c.userId}:${PROVIDER}:${c.conn}`;
  jobQueue.enqueue(key, () => runEtl(c.userId, { provider: PROVIDER, connectionRef: c.conn }))
    .then(() => cache.invalidate(`an:${c.userId}:${c.conn}`))
    .catch((e) => console.error('[analytics ETL]', e.message));
  return res.json({ message: 'Analytics rebuild queued', queueSize: jobQueue.size() });
});

// ── GET /api/analytics/etl-status ─────────────────────────────────────────────
router.get('/etl-status', async (req, res) => {
  const c = ctx(req, res); if (!c) return;
  const [rows] = await pool.execute(
    `SELECT id, started_at, completed_at, status, rows_written, detail
       FROM analytics_etl_runs
      WHERE user_id=? AND provider=? AND connection_ref=?
      ORDER BY id DESC LIMIT 10`,
    [c.userId, PROVIDER, c.conn]
  );
  return res.json({ runs: rows });
});

// ── GET /api/analytics/overview ───────────────────────────────────────────────
router.get('/overview', async (req, res) => {
  const c = ctx(req, res); if (!c) return;
  const dr = dateRange(req);
  const cacheKey = `an:${c.userId}:${c.conn}:overview:${dr.key}`;
  try {
    const data = await cache.wrap(cacheKey, TTL, async () => {
      const scope = [c.userId, PROVIDER, c.conn];
      const base = `WHERE user_id=? AND provider=? AND connection_ref=?`;

      const rev = await one(`SELECT COALESCE(SUM(total),0) v, COALESCE(SUM(tax_total),0) t FROM fact_revenue ${base}${dr.sql}`, [...scope, ...dr.params]);
      const exp = await one(`SELECT COALESCE(SUM(total),0) v, COALESCE(SUM(tax_total),0) t FROM fact_expense ${base}${dr.sql}`, [...scope, ...dr.params]);
      const cf  = await one(
        `SELECT COALESCE(SUM(CASE WHEN direction='inflow' THEN amount END),0) inflow,
                COALESCE(SUM(CASE WHEN direction='outflow' THEN amount END),0) outflow
           FROM fact_cashflow ${base}${dr.sql}`, [...scope, ...dr.params]);
      const ar  = await one(`SELECT COALESCE(SUM(balance),0) v FROM fact_receivable ${base}`, scope);
      const ap  = await one(`SELECT COALESCE(SUM(balance),0) v FROM fact_payable ${base}`, scope);

      const revenue = Number(rev.v), expense = Number(exp.v);
      const inflow = Number(cf.inflow), outflow = Number(cf.outflow);
      return {
        totalRevenue: revenue,
        totalExpenses: expense,
        grossProfit: revenue,                 // before COGS split — net of returns
        netProfit: revenue - expense,
        accountsReceivable: Number(ar.v),
        accountsPayable: Number(ap.v),
        workingCapital: Number(ar.v) - Number(ap.v),
        cashInflow: inflow,
        cashOutflow: outflow,
        operatingCashFlow: inflow - outflow,
        taxCollected: Number(rev.t),
        taxPaid: Number(exp.t),
        netTax: Number(rev.t) - Number(exp.t),
      };
    });
    return res.json({ data });
  } catch (e) {
    console.error('[analytics overview]', e.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// shared monthly-trend helper
async function monthlyTrend({ userId, conn }, table, valueExpr, dr) {
  return pool.execute(
    `SELECT DATE_FORMAT(txn_date,'%Y-%m') ym,
            DATE_FORMAT(txn_date,'%b %Y') label,
            ${valueExpr} value
       FROM ${table}
      WHERE user_id=? AND provider=? AND connection_ref=? AND txn_date IS NOT NULL${dr.sql}
      GROUP BY ym, label
      ORDER BY ym ASC`,
    [userId, PROVIDER, conn, ...dr.params]
  ).then(([rows]) => rows.map(r => ({ ...r, value: Number(r.value) })));
}

// ── GET /api/analytics/revenue ────────────────────────────────────────────────
router.get('/revenue', async (req, res) => {
  const c = ctx(req, res); if (!c) return;
  const dr = dateRange(req);
  try {
    const data = await cache.wrap(`an:${c.userId}:${c.conn}:revenue:${dr.key}`, TTL,
      () => monthlyTrend(c, 'fact_revenue', 'COALESCE(SUM(total),0)', dr));
    return res.json({ trend: data });
  } catch (e) { console.error('[analytics revenue]', e.message); return res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/analytics/expense ────────────────────────────────────────────────
router.get('/expense', async (req, res) => {
  const c = ctx(req, res); if (!c) return;
  const dr = dateRange(req);
  try {
    const data = await cache.wrap(`an:${c.userId}:${c.conn}:expense:${dr.key}`, TTL,
      () => monthlyTrend(c, 'fact_expense', 'COALESCE(SUM(total),0)', dr));
    return res.json({ trend: data });
  } catch (e) { console.error('[analytics expense]', e.message); return res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/analytics/cashflow ───────────────────────────────────────────────
router.get('/cashflow', async (req, res) => {
  const c = ctx(req, res); if (!c) return;
  const dr = dateRange(req);
  try {
    const data = await cache.wrap(`an:${c.userId}:${c.conn}:cashflow:${dr.key}`, TTL, async () => {
      const [rows] = await pool.execute(
        `SELECT DATE_FORMAT(txn_date,'%Y-%m') ym, DATE_FORMAT(txn_date,'%b %Y') label,
                COALESCE(SUM(CASE WHEN direction='inflow' THEN amount END),0) inflow,
                COALESCE(SUM(CASE WHEN direction='outflow' THEN amount END),0) outflow
           FROM fact_cashflow
          WHERE user_id=? AND provider=? AND connection_ref=? AND txn_date IS NOT NULL${dr.sql}
          GROUP BY ym, label ORDER BY ym ASC`,
        [c.userId, PROVIDER, c.conn, ...dr.params]
      );
      return rows.map(r => ({ ym: r.ym, label: r.label, inflow: Number(r.inflow), outflow: Number(r.outflow), net: Number(r.inflow) - Number(r.outflow) }));
    });
    return res.json({ trend: data });
  } catch (e) { console.error('[analytics cashflow]', e.message); return res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/analytics/top-customers ──────────────────────────────────────────
router.get('/top-customers', async (req, res) => {
  const c = ctx(req, res); if (!c) return;
  const dr = dateRange(req);
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  try {
    const data = await cache.wrap(`an:${c.userId}:${c.conn}:topcust:${dr.key}:${limit}`, TTL, async () => {
      const [rows] = await pool.execute(
        `SELECT customer_source_id id, COALESCE(customer_name,'—') name, COALESCE(SUM(total),0) amount
           FROM fact_revenue
          WHERE user_id=? AND provider=? AND connection_ref=? AND doc_type='invoice'${dr.sql}
          GROUP BY customer_source_id, name
          ORDER BY amount DESC LIMIT ${limit}`,
        [c.userId, PROVIDER, c.conn, ...dr.params]
      );
      return rows.map(r => ({ ...r, amount: Number(r.amount) }));
    });
    return res.json({ items: data });
  } catch (e) { console.error('[analytics top-customers]', e.message); return res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/analytics/top-vendors ────────────────────────────────────────────
router.get('/top-vendors', async (req, res) => {
  const c = ctx(req, res); if (!c) return;
  const dr = dateRange(req);
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  try {
    const data = await cache.wrap(`an:${c.userId}:${c.conn}:topvend:${dr.key}:${limit}`, TTL, async () => {
      const [rows] = await pool.execute(
        `SELECT vendor_source_id id, COALESCE(vendor_name,'—') name, COALESCE(SUM(total),0) amount
           FROM fact_expense
          WHERE user_id=? AND provider=? AND connection_ref=?${dr.sql}
          GROUP BY vendor_source_id, name
          ORDER BY amount DESC LIMIT ${limit}`,
        [c.userId, PROVIDER, c.conn, ...dr.params]
      );
      return rows.map(r => ({ ...r, amount: Number(r.amount) }));
    });
    return res.json({ items: data });
  } catch (e) { console.error('[analytics top-vendors]', e.message); return res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/analytics/expense-by-category ────────────────────────────────────
router.get('/expense-by-category', async (req, res) => {
  const c = ctx(req, res); if (!c) return;
  const dr = dateRange(req);
  try {
    const data = await cache.wrap(`an:${c.userId}:${c.conn}:expcat:${dr.key}`, TTL, async () => {
      const [rows] = await pool.execute(
        `SELECT COALESCE(NULLIF(category,''),'Uncategorised') name, COALESCE(SUM(total),0) amount
           FROM fact_expense
          WHERE user_id=? AND provider=? AND connection_ref=?${dr.sql}
          GROUP BY name ORDER BY amount DESC`,
        [c.userId, PROVIDER, c.conn, ...dr.params]
      );
      return rows.map(r => ({ ...r, amount: Number(r.amount) }));
    });
    return res.json({ items: data });
  } catch (e) { console.error('[analytics expense-by-category]', e.message); return res.status(500).json({ error: 'Server error' }); }
});

// ── aging (shared) ────────────────────────────────────────────────────────────
async function aging({ userId, conn }, table) {
  const [rows] = await pool.execute(
    `SELECT aging_bucket bucket, COUNT(*) cnt, COALESCE(SUM(balance),0) amount
       FROM ${table}
      WHERE user_id=? AND provider=? AND connection_ref=?
      GROUP BY aging_bucket`,
    [userId, PROVIDER, conn]
  );
  const order = ['current', '1-30', '31-60', '61-90', '90+'];
  const map = Object.fromEntries(rows.map(r => [r.bucket, { bucket: r.bucket, count: Number(r.cnt), amount: Number(r.amount) }]));
  const buckets = order.map(b => map[b] || { bucket: b, count: 0, amount: 0 });
  const total = buckets.reduce((s, b) => s + b.amount, 0);
  return { buckets, total };
}

// ── GET /api/analytics/ar-aging ───────────────────────────────────────────────
router.get('/ar-aging', async (req, res) => {
  const c = ctx(req, res); if (!c) return;
  try {
    const data = await cache.wrap(`an:${c.userId}:${c.conn}:araging`, TTL, () => aging(c, 'fact_receivable'));
    return res.json(data);
  } catch (e) { console.error('[analytics ar-aging]', e.message); return res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/analytics/ap-aging ───────────────────────────────────────────────
router.get('/ap-aging', async (req, res) => {
  const c = ctx(req, res); if (!c) return;
  try {
    const data = await cache.wrap(`an:${c.userId}:${c.conn}:apaging`, TTL, () => aging(c, 'fact_payable'));
    return res.json(data);
  } catch (e) { console.error('[analytics ap-aging]', e.message); return res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/analytics/tax-summary ────────────────────────────────────────────
router.get('/tax-summary', async (req, res) => {
  const c = ctx(req, res); if (!c) return;
  const dr = dateRange(req);
  try {
    const data = await cache.wrap(`an:${c.userId}:${c.conn}:tax:${dr.key}`, TTL, async () => {
      const row = await one(
        `SELECT COALESCE(SUM(CASE WHEN direction='output' THEN tax_amount END),0) output_tax,
                COALESCE(SUM(CASE WHEN direction='input'  THEN tax_amount END),0) input_tax,
                COALESCE(SUM(CASE WHEN direction='output' THEN taxable_amount END),0) output_taxable,
                COALESCE(SUM(CASE WHEN direction='input'  THEN taxable_amount END),0) input_taxable
           FROM fact_tax
          WHERE user_id=? AND provider=? AND connection_ref=?${dr.sql}`,
        [c.userId, PROVIDER, c.conn, ...dr.params]
      );
      const outTax = Number(row.output_tax), inTax = Number(row.input_tax);
      return { outputTax: outTax, inputTax: inTax, netTaxLiability: outTax - inTax,
               outputTaxable: Number(row.output_taxable), inputTaxable: Number(row.input_taxable) };
    });
    return res.json({ data });
  } catch (e) { console.error('[analytics tax-summary]', e.message); return res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
