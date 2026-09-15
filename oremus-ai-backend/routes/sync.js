'use strict';
const { Router } = require('express');
const axios      = require('axios');
const auth       = require('../middleware/auth');
const pool       = require('../config/db');
const { syncAllZohoData, syncAccountTransactions, syncBankTransactions, getValidToken, getEffectiveZohoUserId } = require('../services/zohoService');
const {
  syncAllQBOData,
  syncAccounts:      qboSyncAccounts,
  syncCustomers:     qboSyncCustomers,
  syncVendors:       qboSyncVendors,
  syncInvoices:      qboSyncInvoices,
  syncBills:         qboSyncBills,
  syncExpenses:      qboSyncExpenses,
  syncJournalEntries: qboSyncJournalEntries,
  getValidQBOToken,
} = require('../services/quickbooksService');
const {
  syncAllXeroData,
  syncAccounts:        xeroSyncAccounts,
  syncCustomers:       xeroSyncCustomers,
  syncVendors:         xeroSyncVendors,
  syncInvoices:        xeroSyncInvoices,
  syncBills:           xeroSyncBills,
  syncExpenses:        xeroSyncExpenses,
  syncManualJournals:  xeroSyncJournals,
  getValidXeroToken,
  XERO_API_BASE,
} = require('../services/xeroService');
const { withRetry } = require('../utils/singleFlight');

// Turn a provider throttle (HTTP 429) into a clear, actionable response instead
// of the opaque axios "Request failed with status code 429". Returns true if it
// handled the error (already sent a response).
function handleFetchError(err, res, label) {
  const status = err?.response?.status;
  if (status === 429) {
    const h = err?.response?.headers || {};
    // Zoho reports the org-wide quota via x-rate-limit-* (reset = seconds until
    // the window resets); other providers may send a plain Retry-After.
    const resetSecs = Number(h['x-rate-limit-reset']);
    const retrySecs = Number(h['retry-after']);
    const waitSecs  = Number.isFinite(resetSecs) ? resetSecs
                    : Number.isFinite(retrySecs) ? retrySecs : undefined;
    const limit     = h['x-rate-limit-limit'];
    console.warn(`[${label}] provider rate-limited (429)`
      + (limit ? `, limit=${limit}` : '')
      + (waitSecs != null ? `, resets in ${waitSecs}s` : ''));
    res.status(429).json({
      error: 'Provider API rate limit reached (HTTP 429). The accounting provider has capped the number of API calls for this organization. This is a temporary provider-side throttle, not a data problem.',
      code: 'RATE_LIMITED',
      limit: limit ? Number(limit) : undefined,
      retry_after_seconds: waitSecs,
      retry_after_human: waitSecs != null
        ? `${Math.floor(waitSecs / 3600)}h ${Math.round((waitSecs % 3600) / 60)}m`
        : undefined,
    });
    return true;
  }
  return false;
}

const router = Router();
router.use(auth);

async function getTokenAndOrg(userId) {
  const accessToken = await getValidToken(userId);
  if (!accessToken) throw new Error('Zoho not connected');
  const [rows] = await pool.execute(
    'SELECT org_id FROM zb_tokens WHERE user_id = ?', [userId]
  );
  if (!rows[0]) throw new Error('Zoho token not found');
  return { accessToken, orgId: rows[0].org_id };
}

// POST /api/sync/all
// Syncs the legacy shared tables for EVERY organization on the connection (a
// Zoho account can expose several orgs), not just the active one.
router.post('/all', async (req, res) => {
  try {
    const userId = await getEffectiveZohoUserId(req.user.id);
    const accessToken = await getValidToken(userId);
    if (!accessToken) throw new Error('Zoho not connected');
    const [orgs] = await pool.execute(
      'SELECT org_id FROM zb_oauth_organizations WHERE user_id = ? ORDER BY org_id ASC',
      [userId]
    );
    if (!orgs.length) throw new Error('No Zoho organizations found');
    (async () => {
      for (const { org_id: orgId } of orgs) {
        try {
          await syncAllZohoData(userId, accessToken, orgId);
        } catch (e) {
          console.error(`[Sync/all org=${orgId}] error:`, e.message);
        }
      }
    })();
    return res.json({ message: `Full sync started in background (${orgs.length} organization(s))` });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// GET /api/sync/last
// Returns the most recent time any of this user's accounting data was synced,
// across Zoho warehouse / QuickBooks / Xero / shared tables. Clients inherit the
// admin's connection, so the admin's id is included when resolving.
router.get('/last', async (req, res) => {
  try {
    const ids = [req.user.id];
    if (req.user.role === 'client') {
      const [admin] = await pool.execute(
        "SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1"
      );
      if (admin[0]) ids.push(admin[0].id);
    }
    const ph = ids.map(() => '?').join(',');

    // Each source is queried independently so a missing/empty table never breaks
    // the others; we keep the maximum non-null timestamp.
    const sources = [
      `SELECT MAX(last_synced_at) AS t FROM zb_sync_watermarks WHERE user_id IN (${ph})`,
      `SELECT MAX(synced_at)      AS t FROM qbo_accounts        WHERE user_id IN (${ph})`,
      `SELECT MAX(synced_at)      AS t FROM xero_accounts       WHERE user_id IN (${ph})`,
      `SELECT MAX(synced_at)      AS t FROM invoices            WHERE user_id IN (${ph})`,
      `SELECT MAX(synced_at)      AS t FROM bank_transactions   WHERE user_id IN (${ph})`,
    ];

    let last = null;
    for (const sql of sources) {
      try {
        const [rows] = await pool.execute(sql, ids);
        const t = rows[0]?.t;
        if (t && (!last || new Date(t) > new Date(last))) last = t;
      } catch { /* table may not exist for this deployment — skip */ }
    }

    return res.json({ lastSyncedAt: last });
  } catch (err) {
    console.error('GET /api/sync/last:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/sync/daybook
router.post('/daybook', async (req, res) => {
  try {
    const { accessToken, orgId } = await getTokenAndOrg(req.user.id);
    syncDayBookOnly(req.user.id, accessToken, orgId).catch((e) =>
      console.error('[Sync/daybook] error:', e.message)
    );
    return res.json({ message: 'Day book sync started in background' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// GET /api/sync/daybook/live
router.get('/daybook/live', async (req, res) => {
  try {
    const { accessToken, orgId } = await getTokenAndOrg(req.user.id);
    const page = Math.max(1, parseInt(req.query.page || '1'));

    const zohoRes = await axios.get(
      `${process.env.ZOHO_API_BASE}/reports/daybook`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        params:  { organization_id: orgId, page, usestate: true, response_option: 0 },
      }
    );
    return res.json(zohoRes.data);
  } catch (err) {
    console.error('[DayBook/live] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

async function syncDayBookOnly(userId, accessToken, orgId) {
  const url  = `${process.env.ZOHO_API_BASE}/reports/daybook`;
  const rows = [];
  let page   = 1;

  while (true) {
    const res  = await axios.get(url, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      params:  { organization_id: orgId, page, usestate: true, response_option: 0 },
    });
    const data = res.data;
    if (data.code !== 0) break;
    rows.push(...(data.daybook ?? []));
    if (!data.page_context?.has_more_page) break;
    page++;
  }

  if (rows.length === 0) return;

  const conn = await pool.getConnection();
  try {
    for (const t of rows) {
      const txnId = t.transaction_id
        || `${t.date ?? ''}-${t.transaction_type ?? ''}-${t.reference_number ?? ''}-${t.account_id ?? ''}`;
      await conn.execute(
        `INSERT INTO daybook_transactions
           (user_id, org_id, transaction_id, transaction_date, transaction_type,
            reference_number, description, debit, credit, account_name, entity_name, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           transaction_date=VALUES(transaction_date), transaction_type=VALUES(transaction_type),
           reference_number=VALUES(reference_number), description=VALUES(description),
           debit=VALUES(debit), credit=VALUES(credit),
           account_name=VALUES(account_name), entity_name=VALUES(entity_name), synced_at=NOW()`,
        [
          userId, orgId, txnId,
          t.date || null, t.transaction_type || null,
          t.reference_number || null, t.description || null,
          parseFloat(t.debit ?? 0), parseFloat(t.credit ?? 0),
          t.account_name || null, t.entity_name || null,
        ]
      );
    }
  } finally {
    conn.release();
  }
  console.log(`[DayBook/only] Synced ${rows.length} rows for orgId=${orgId}`);
}

// POST /api/sync/account-transactions
// Optional body: { from_date: 'YYYY-MM-DD', to_date: 'YYYY-MM-DD' }
// Syncs in the background; responds immediately.
router.post('/account-transactions', async (req, res) => {
  try {
    const { accessToken, orgId } = await getTokenAndOrg(req.user.id);
    const { from_date, to_date } = req.body || {};
    syncAccountTransactions(req.user.id, accessToken, orgId, from_date, to_date)
      .catch((e) => console.error('[Sync/account-transactions] error:', e.message));
    return res.json({ message: 'Account transactions sync started in background' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// POST /api/sync/bank-transactions
// Optional body: { from_date: 'YYYY-MM-DD', to_date: 'YYYY-MM-DD' }
router.post('/bank-transactions', async (req, res) => {
  try {
    const { accessToken, orgId } = await getTokenAndOrg(req.user.id);
    const { from_date, to_date } = req.body || {};
    syncBankTransactions(req.user.id, accessToken, orgId, from_date, to_date)
      .catch((e) => console.error('[Sync/bank-transactions] error:', e.message));
    return res.json({ message: 'Bank transactions sync started in background' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// GET /api/sync/bank-transactions/live
// Proxy one page directly from Zoho — no DB write
router.get('/bank-transactions/live', async (req, res) => {
  try {
    const { accessToken, orgId } = await getTokenAndOrg(req.user.id);
    const page      = Math.max(1, parseInt(req.query.page || '1'));
    const from_date = req.query.from_date || null;
    const to_date   = req.query.to_date   || null;

    const zohoRes = await axios.get(
      `${process.env.ZOHO_API_BASE}/banktransactions`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        params: {
          organization_id: orgId,
          page,
          per_page:  200,
          filter_by: 'Status.All',
          sort_column: 'date',
          sort_order:  'D',
          ...(from_date ? { date_start: from_date } : {}),
          ...(to_date   ? { date_end:   to_date   } : {}),
        },
      }
    );
    return res.json(zohoRes.data);
  } catch (err) {
    console.error('[BankTxn/live] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/sync/account-transactions/live
// Proxy-fetches one page directly from Zoho (no DB write) — useful for previewing.
router.get('/account-transactions/live', async (req, res) => {
  try {
    const { accessToken, orgId } = await getTokenAndOrg(req.user.id);
    const page      = Math.max(1, parseInt(req.query.page      || '1'));
    const from_date = req.query.from_date || null;
    const to_date   = req.query.to_date   || null;

    const zohoRes = await axios.get(
      `${process.env.ZOHO_API_BASE}/reports/accounttransaction`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        params: {
          organization_id: orgId,
          page,
          per_page: 200,
          sort_column: 'date',
          sort_order:  'A',
          ...(from_date ? { from_date } : {}),
          ...(to_date   ? { to_date }   : {}),
        },
      }
    );
    return res.json(zohoRes.data);
  } catch (err) {
    console.error('[AccountTxn/live] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ╔════════════════════════════════════════════════════════════════════════════╗
// ║   TEST / FETCH-ONLY ROUTES — return provider JSON, NEVER write to the DB    ║
// ╚════════════════════════════════════════════════════════════════════════════╝

// GET /api/sync/test/zoho
// Fetches ONE page of the same Zoho source API that feeds account_transactions
// (GET /reports/accounttransaction) and returns the raw provider JSON in the
// response body. No database write. No date filter — fetches all data.
// Optional query: page, per_page
router.get('/test/zoho', async (req, res) => {
  try {
    const { accessToken, orgId } = await getTokenAndOrg(req.user.id);
    const page     = Math.max(1, parseInt(req.query.page || '1'));
    const per_page = Math.min(200, Math.max(1, parseInt(req.query.per_page || '200')));
    // Zoho's accounttransaction report returns nothing unless a window is given,
    // so use a wide-open range to pull ALL history (no user-facing date filter).
    const today = new Date().toISOString().slice(0, 10);

    const zohoRes = await withRetry(() => axios.get(
      `${process.env.ZOHO_API_BASE}/reports/accounttransaction`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        params: {
          organization_id: orgId,
          page,
          per_page,
          from_date:   '2000-01-01',
          to_date:     today,
          sort_column: 'date',
          sort_order:  'A',
        },
      }
    ));
    return res.json({
      provider: 'zoho',
      source_endpoint: 'reports/accounttransaction',
      saved_to_db: false,
      orgId,
      page,
      data: zohoRes.data,
    });
  } catch (err) {
    if (handleFetchError(err, res, 'Test/zoho')) return;
    console.error('[Test/zoho] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/sync/test/xero
// Fetches the same Xero source API that feeds account_transactions
// (GET /ManualJournals) and returns the raw provider JSON in the response body.
// No database write.
router.get('/test/xero', async (req, res) => {
  try {
    const { accessToken, tenantId } = await getXeroAuth(req.user.id);
    const xeroRes = await withRetry(() => axios.get(`${XERO_API_BASE}/ManualJournals`, {
      headers: {
        Authorization:    `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        Accept:           'application/json',
      },
    }));
    return res.json({
      provider: 'xero',
      source_endpoint: 'ManualJournals',
      saved_to_db: false,
      tenantId,
      data: xeroRes.data,
    });
  } catch (err) {
    if (handleFetchError(err, res, 'Test/xero')) return;
    console.error('[Test/xero] error:', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/sync/test/bank/zoho
// Fetches the SAME Zoho source API that feeds the bank_transactions table
// (GET /banktransactions) and returns the raw provider JSON verbatim in the
// response body. No database write. Compare this against Zoho's official
// "List Bank Transactions" Postman request to verify the data.
// Optional query: page, per_page
router.get('/test/bank/zoho', async (req, res) => {
  try {
    const { accessToken, orgId } = await getTokenAndOrg(req.user.id);
    const page     = Math.max(1, parseInt(req.query.page || '1'));
    const per_page = Math.min(200, Math.max(1, parseInt(req.query.per_page || '200')));

    const zohoRes = await withRetry(() => axios.get(
      `${process.env.ZOHO_API_BASE}/banktransactions`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        params: {
          organization_id: orgId,
          page,
          per_page,
          sort_column: 'date',
          sort_order:  'D',
          filter_by:   'Status.All',
        },
      }
    ));
    return res.json({
      provider: 'zoho',
      source_endpoint: 'banktransactions',
      saved_to_db: false,
      orgId,
      page,
      data: zohoRes.data,
    });
  } catch (err) {
    if (handleFetchError(err, res, 'Test/bank/zoho')) return;
    console.error('[Test/bank/zoho] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/sync/test/bank/xero
// Fetches the SAME Xero source API that feeds the bank_transactions table
// (GET /BankTransactions) and returns the raw provider JSON verbatim in the
// response body. No database write. Compare this against Xero's official
// "GET BankTransactions" Postman request to verify the data.
router.get('/test/bank/xero', async (req, res) => {
  try {
    const { accessToken, tenantId } = await getXeroAuth(req.user.id);
    const xeroRes = await withRetry(() => axios.get(`${XERO_API_BASE}/BankTransactions`, {
      headers: {
        Authorization:    `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        Accept:           'application/json',
      },
    }));
    return res.json({
      provider: 'xero',
      source_endpoint: 'BankTransactions',
      saved_to_db: false,
      tenantId,
      data: xeroRes.data,
    });
  } catch (err) {
    if (handleFetchError(err, res, 'Test/bank/xero')) return;
    console.error('[Test/bank/xero] error:', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// ╔════════════════════════════════════════════════════════════════════════════╗
// ║                       QUICKBOOKS ONLINE SYNC ROUTES                        ║
// ╚════════════════════════════════════════════════════════════════════════════╝

async function getQBOAuth(userId) {
  const ctx = await getValidQBOToken(userId);
  if (!ctx) throw new Error('QuickBooks not connected');
  return ctx;
}

// POST /api/sync/qbo/all
router.post('/qbo/all', async (req, res) => {
  try {
    const { accessToken, realmId, environment } = await getQBOAuth(req.user.id);
    syncAllQBOData(req.user.id, accessToken, realmId, environment).catch((e) =>
      console.error('[QBO Sync/all] error:', e.message)
    );
    return res.json({ message: 'Full QuickBooks sync started in background' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// Per-entity QBO sync endpoints (optional convenience)
function makeQBOEntityRoute(path, fn, label) {
  router.post(path, async (req, res) => {
    try {
      const { accessToken, realmId, environment } = await getQBOAuth(req.user.id);
      fn(req.user.id, accessToken, realmId, environment).catch((e) =>
        console.error(`[QBO Sync${path}] error:`, e.message)
      );
      return res.json({ message: `${label} sync started in background` });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });
}

makeQBOEntityRoute('/qbo/accounts',        qboSyncAccounts,        'QuickBooks chart of accounts');
makeQBOEntityRoute('/qbo/customers',       qboSyncCustomers,       'QuickBooks customers');
makeQBOEntityRoute('/qbo/vendors',         qboSyncVendors,         'QuickBooks vendors');
makeQBOEntityRoute('/qbo/invoices',        qboSyncInvoices,        'QuickBooks invoices');
makeQBOEntityRoute('/qbo/bills',           qboSyncBills,           'QuickBooks bills');
makeQBOEntityRoute('/qbo/expenses',        qboSyncExpenses,        'QuickBooks expenses');
makeQBOEntityRoute('/qbo/journal-entries', qboSyncJournalEntries,  'QuickBooks journal entries');

// ╔════════════════════════════════════════════════════════════════════════════╗
// ║                              XERO SYNC ROUTES                              ║
// ╚════════════════════════════════════════════════════════════════════════════╝
async function getXeroAuth(userId) {
  const ctx = await getValidXeroToken(userId);
  if (!ctx) throw new Error('Xero not connected');
  return ctx;
}

router.post('/xero/all', async (req, res) => {
  try {
    const { accessToken, tenantId } = await getXeroAuth(req.user.id);
    syncAllXeroData(req.user.id, accessToken, tenantId).catch((e) =>
      console.error('[Xero Sync/all] error:', e.message)
    );
    return res.json({ message: 'Full Xero sync started in background' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

function makeXeroEntityRoute(path, fn, label) {
  router.post(path, async (req, res) => {
    try {
      const { accessToken, tenantId } = await getXeroAuth(req.user.id);
      fn(req.user.id, accessToken, tenantId).catch((e) =>
        console.error(`[Xero Sync${path}] error:`, e.message)
      );
      return res.json({ message: `${label} sync started in background` });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });
}

makeXeroEntityRoute('/xero/accounts',  xeroSyncAccounts,  'Xero chart of accounts');
makeXeroEntityRoute('/xero/customers', xeroSyncCustomers, 'Xero customers');
makeXeroEntityRoute('/xero/vendors',   xeroSyncVendors,   'Xero vendors');
makeXeroEntityRoute('/xero/invoices',  xeroSyncInvoices,  'Xero invoices');
makeXeroEntityRoute('/xero/bills',     xeroSyncBills,     'Xero bills');
makeXeroEntityRoute('/xero/expenses',  xeroSyncExpenses,  'Xero expenses');
makeXeroEntityRoute('/xero/journals',  xeroSyncJournals,  'Xero manual journals');

// Rebuild the DB-backed Xero general ledger on demand (source docs → staging →
// account_transactions) so every Xero report is served from our DB, not Xero's
// scope-gated /Journals API. Runs in the background; returns immediately.
router.post('/xero/ledger/rebuild', async (req, res) => {
  try {
    await getXeroAuth(req.user.id); // ensure connected (throws if not)
    const { rebuildXeroLedger } = require('../services/xeroPostingEngine');
    rebuildXeroLedger(req.user.id, {}).catch((e) =>
      console.error('[Xero Sync/ledger/rebuild] error:', e.message)
    );
    return res.json({ message: 'Xero ledger rebuild started in background' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

module.exports = router;
