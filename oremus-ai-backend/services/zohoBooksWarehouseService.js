'use strict';
// Zoho Books Warehouse — Foundation sync service.
// Pulls every Zoho Books module via paginated GET and upserts into the zb_*
// silver tables. Records bronze (raw payload) + audit (run + run_items +
// watermarks) for every module.
//
// Public entry points:
//   syncAllZohoBooksWarehouse(userId, accessToken, orgId, opts)
//   syncSingleModule(userId, accessToken, orgId, module)

const axios = require('axios');
const pool  = require('../config/db');

const API_BASE = process.env.ZOHO_API_BASE || 'https://www.zohoapis.in/books/v3';
const PER_PAGE = 200;

// Rate-limit protection tunables.
// Small delay between paged requests keeps us under Zoho's per-minute throttle;
// bounded retry/backoff rides out transient 429/network blips without hammering.
const ZB_PAGE_DELAY_MS = parseInt(process.env.ZB_PAGE_DELAY_MS || '250', 10);
const ZB_MAX_RETRIES   = parseInt(process.env.ZB_MAX_RETRIES   || '3', 10);
// Per-request timeout. WITHOUT this, a Zoho socket that opens but never responds
// hangs the GET forever, freezing the whole run (and every later org, since the
// orchestrator is sequential) — observed as a module stuck "running" with fetched=0.
// On timeout axios throws ECONNABORTED (no .response) → treated as transient → retried.
const ZB_REQUEST_TIMEOUT_MS = parseInt(process.env.ZB_REQUEST_TIMEOUT_MS || '30000', 10);

// ═════════════════════════════════════════════════════════════════════════════
// 1. Common helpers
// ═════════════════════════════════════════════════════════════════════════════

function headers(accessToken) {
  return { Authorization: `Zoho-oauthtoken ${accessToken}` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Raised when Zoho signals the daily API quota is exhausted (code 45) or stays
// throttled (HTTP 429) after retries. The orchestrator catches this to stop the
// current org's run cleanly — watermarks make the next run resume where it left.
class RateLimitError extends Error {
  constructor(message) {
    super(message || 'Zoho API rate/quota limit reached');
    this.name = 'RateLimitError';
    this.isRateLimit = true;
  }
}

// Zoho's daily-quota response carries code 45 (also used by the health check in
// routes/zbWarehouse.js); the per-minute throttle surfaces as HTTP 429.
function isRateLimitData(data) {
  if (!data) return false;
  if (data.code === 45) return true;
  const m = String(data.message || '').toLowerCase();
  return m.includes('rate limit') || m.includes('too many request');
}

// Single GET with bounded retry/backoff. Throws RateLimitError on the daily
// quota (no retry — it won't recover today) or on a persistent 429. Other
// transient errors are retried, then re-thrown for the caller to handle.
async function zohoGet(url, params, accessToken) {
  let lastErr;
  for (let attempt = 1; attempt <= ZB_MAX_RETRIES; attempt += 1) {
    try {
      const response = await axios.get(url, { headers: headers(accessToken), params, timeout: ZB_REQUEST_TIMEOUT_MS });
      if (isRateLimitData(response.data)) throw new RateLimitError(response.data?.message);
      return response;
    } catch (e) {
      if (e instanceof RateLimitError) throw e;
      // Daily quota surfaced as an HTTP error body — stop, do not retry.
      if (e?.response?.data?.code === 45) throw new RateLimitError(e.response.data.message);
      lastErr = e;
      const transient = e?.response?.status === 429 || !e?.response;
      if (transient && attempt < ZB_MAX_RETRIES) {
        await sleep(500 * 2 ** (attempt - 1)); // 500ms, 1s, 2s …
        continue;
      }
      // Persistent throttle → signal the orchestrator to stop this org.
      if (e?.response?.status === 429) throw new RateLimitError(e.response?.data?.message || 'HTTP 429');
      throw e;
    }
  }
  throw lastErr;
}

function toMysqlDt(s) {
  if (!s) return null;
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 19).replace('T', ' ');
  } catch { return null; }
}

function toMysqlDate(s) {
  if (!s) return null;
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch { return null; }
}

function toMysqlTime(s) {
  if (!s) return null;
  // Zoho returns "HH:MM" or "HH:MM AM/PM"
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(s)) return s.length === 5 ? `${s}:00` : s;
  return null;
}

// Zoho's last_modified_time query param expects ISO 8601 with a timezone
// offset (e.g. "2026-05-27T09:02:58+0000"). MySQL DATETIME strings ("2026-05-27
// 09:02:58") are rejected.
function toZohoDt(s) {
  if (!s) return null;
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().replace(/\.\d{3}Z$/, '+0000');
  } catch { return null; }
}

function safeJson(v) {
  if (v == null) return null;
  try { return JSON.stringify(v); } catch { return null; }
}

function num(v) {
  if (v == null || v === '') return 0;
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
}

function intOrNull(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v);
  return isNaN(n) ? null : n;
}

function bool(v) { return v ? 1 : 0; }

function str(v, max) {
  if (v == null) return null;
  const s = String(v);
  return max ? s.slice(0, max) : s;
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Bronze — raw payload archive
// ═════════════════════════════════════════════════════════════════════════════

async function archiveRaw({ userId, orgId, endpoint, params, response, syncRunId, startedAt }) {
  try {
    const body = response?.data ? JSON.stringify(response.data) : null;
    const size = body ? body.length : 0;
    const status = response?.status ?? null;
    const duration = startedAt ? (Date.now() - startedAt) : null;
    const [r] = await pool.execute(
      `INSERT INTO zb_raw_payloads
        (user_id, org_id, endpoint, method, request_params,
         response_status, response_body, response_size,
         page, per_page, fetched_at, duration_ms, sync_run_id)
       VALUES (?,?,?,'GET',?,?,?,?,?,?,NOW(),?,?)`,
      [
        userId, orgId, endpoint, safeJson(params),
        status, body, size,
        params?.page ?? null, params?.per_page ?? null,
        duration, syncRunId ?? null,
      ]
    );
    return r.insertId;
  } catch (e) {
    console.error('[ZB raw archive] failed:', e.message);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Audit — run lifecycle + watermarks
// ═════════════════════════════════════════════════════════════════════════════

async function startRun(userId, orgId, runType, modules, triggerSource) {
  const [r] = await pool.execute(
    `INSERT INTO zb_sync_runs
       (user_id, org_id, run_type, trigger_source, started_at, status, modules_requested)
     VALUES (?,?,?,?, NOW(), 'running', ?)`,
    [userId, orgId, runType, triggerSource || null, safeJson(modules)]
  );
  return { id: r.insertId };
}

async function finishRun(runId, status, summary) {
  await pool.execute(
    `UPDATE zb_sync_runs
       SET completed_at = NOW(),
           status       = ?,
           error_summary = ?
     WHERE id = ?`,
    [status, summary || null, runId]
  );
}

async function bumpRunCounts(runId, { inserted = 0, updated = 0, failed = 0, calls = 0 } = {}) {
  await pool.execute(
    `UPDATE zb_sync_runs
       SET records_inserted = records_inserted + ?,
           records_updated  = records_updated  + ?,
           records_failed   = records_failed   + ?,
           api_calls_made   = api_calls_made   + ?
     WHERE id = ?`,
    [inserted, updated, failed, calls, runId]
  );
}

async function startRunItem(runId, module, endpoint) {
  const [r] = await pool.execute(
    `INSERT INTO zb_sync_run_items (sync_run_id, module, endpoint, started_at, status)
     VALUES (?,?,?, NOW(), 'running')`,
    [runId, module, endpoint || null]
  );
  return r.insertId;
}

async function finishRunItem(itemId, status, counts, error) {
  await pool.execute(
    `UPDATE zb_sync_run_items
       SET completed_at     = NOW(),
           status           = ?,
           api_calls        = ?,
           records_fetched  = ?,
           records_inserted = ?,
           records_updated  = ?,
           records_failed   = ?,
           error            = ?
     WHERE id = ?`,
    [status,
      counts?.calls    ?? 0,
      counts?.fetched  ?? 0,
      counts?.inserted ?? 0,
      counts?.updated  ?? 0,
      counts?.failed   ?? 0,
      error || null, itemId]
  );
}

async function getWatermark(userId, orgId, module) {
  const [rows] = await pool.execute(
    `SELECT last_modified_after FROM zb_sync_watermarks WHERE user_id=? AND org_id=? AND module=?`,
    [userId, orgId, module]
  );
  return rows[0]?.last_modified_after || null;
}

async function setWatermark(userId, orgId, module, ts, recordsTotal) {
  await pool.execute(
    `INSERT INTO zb_sync_watermarks (user_id, org_id, module, last_modified_after, last_synced_at, records_total)
     VALUES (?,?,?,?, NOW(), ?)
     ON DUPLICATE KEY UPDATE
       last_modified_after = VALUES(last_modified_after),
       last_synced_at      = VALUES(last_synced_at),
       records_total       = VALUES(records_total)`,
    [userId, orgId, module, ts, recordsTotal ?? 0]
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Pagination helpers
// ═════════════════════════════════════════════════════════════════════════════

async function fetchAllPages({ accessToken, orgId, endpoint, params, listKey, userId, syncRunId, archive = true }) {
  const all = [];
  let page = 1;
  let calls = 0;
  while (true) {
    const startedAt = Date.now();
    const url = `${API_BASE}${endpoint}`;
    const reqParams = { organization_id: orgId, page, per_page: PER_PAGE, ...(params || {}) };
    let response;
    try {
      response = await zohoGet(url, reqParams, accessToken);
    } catch (e) {
      if (e instanceof RateLimitError) throw e; // bubble up — abort org, keep progress
      console.warn(`[ZB] ${endpoint} page=${page} failed:`, e.response?.data?.message || e.message);
      break;
    }
    calls += 1;
    const data = response.data || {};
    if (archive) await archiveRaw({ userId, orgId, endpoint, params: reqParams, response, syncRunId, startedAt });

    if (data.code !== 0 && data.code !== undefined) {
      // Zoho returns code=0 on success; non-zero indicates error
      console.warn(`[ZB] ${endpoint} code=${data.code}: ${data.message}`);
      break;
    }

    // The list payload key varies per endpoint — accept listKey hint or auto-detect
    let items = [];
    if (listKey && Array.isArray(data[listKey])) items = data[listKey];
    else {
      const k = Object.keys(data).find((x) => Array.isArray(data[x]) && x !== 'page_context');
      if (k) items = data[k];
    }
    all.push(...items);

    if (!data.page_context?.has_more_page) break;
    page += 1;
    if (page > 500) break;  // safety
    if (ZB_PAGE_DELAY_MS > 0) await sleep(ZB_PAGE_DELAY_MS); // throttle paging
  }
  return { items: all, calls };
}

async function fetchOne({ accessToken, orgId, endpoint, dataKey, userId, syncRunId, archive = true }) {
  const startedAt = Date.now();
  const url = `${API_BASE}${endpoint}`;
  const params = { organization_id: orgId };
  let response;
  try {
    response = await zohoGet(url, params, accessToken);
  } catch (e) {
    if (e instanceof RateLimitError) throw e; // bubble up — abort org, keep progress
    console.warn(`[ZB] ${endpoint} fetchOne failed:`, e.response?.data?.message || e.message);
    return null;
  }
  if (archive) await archiveRaw({ userId, orgId, endpoint, params, response, syncRunId, startedAt });
  const data = response.data || {};
  if (data.code !== 0 && data.code !== undefined) return null;
  return dataKey ? data[dataKey] : data;
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Module sync functions
// Each returns { calls, fetched, inserted, updated, failed }
// ═════════════════════════════════════════════════════════════════════════════

async function syncOrganization(userId, accessToken, orgId, runId) {
  // Single org details
  const org = await fetchOne({
    accessToken, orgId, userId, syncRunId: runId,
    endpoint: '/organizations/' + orgId, dataKey: 'organization',
  });
  if (!org) return { calls: 1, fetched: 0, inserted: 0, updated: 0, failed: 0 };
  await pool.execute(
    `INSERT INTO zb_organizations
       (user_id, org_id, name, contact_name, email, phone, fax,
        industry_type, industry_size, fiscal_year_start_month, language_code,
        date_format, field_separator, time_zone, is_org_active,
        currency_id, currency_code, currency_symbol, currency_format, price_precision,
        country, state, city, street_address1, street_address2, zip,
        org_address, remit_to_address, is_default_org, plan_type, plan_name,
        trial_expiry_date, is_trial_expired, tax_group_enabled, is_gst_registered,
        gst_no, tax_id, source, custom_fields_json,
        zoho_created_time, zoho_last_modified_time, synced_at)
     VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?,
             ?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?, NOW())
     ON DUPLICATE KEY UPDATE
       name = VALUES(name), contact_name = VALUES(contact_name), email = VALUES(email),
       phone = VALUES(phone), industry_type = VALUES(industry_type),
       fiscal_year_start_month = VALUES(fiscal_year_start_month),
       time_zone = VALUES(time_zone), currency_code = VALUES(currency_code),
       currency_symbol = VALUES(currency_symbol), country = VALUES(country),
       state = VALUES(state), city = VALUES(city), zip = VALUES(zip),
       gst_no = VALUES(gst_no), zoho_last_modified_time = VALUES(zoho_last_modified_time),
       synced_at = NOW()`,
    [
      userId, orgId,
      str(org.name, 255), str(org.contact_name, 255), str(org.email, 255),
      str(org.phone, 50), str(org.fax, 50),
      str(org.industry_type, 100), str(org.industry_size, 100), str(org.fiscal_year_start_month, 20),
      str(org.language_code, 10), str(org.date_format, 50), str(org.field_separator, 10),
      str(org.time_zone, 100), bool(org.is_org_active),
      str(org.currency_id, 100), str(org.currency_code, 3), str(org.currency_symbol, 10),
      str(org.currency_format, 50), intOrNull(org.price_precision) ?? 2,
      str(org.country, 100), str(org.state, 100), str(org.city, 100),
      str(org.street_address1, 255), str(org.street_address2, 255), str(org.zip, 20),
      str(org.org_address, 1000), str(org.remit_to_address, 1000), bool(org.is_default_org),
      intOrNull(org.plan_type), str(org.plan_name, 100),
      toMysqlDate(org.trial_expiry_date), bool(org.is_trial_expired),
      bool(org.tax_group_enabled), bool(org.is_gst_registered),
      str(org.gst_no, 20), str(org.tax_id, 100), str(org.source, 50),
      safeJson(org.custom_fields),
      toMysqlDt(org.created_time), toMysqlDt(org.last_modified_time),
    ]
  );
  return { calls: 1, fetched: 1, inserted: 1, updated: 0, failed: 0 };
}

async function syncCurrencies(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/settings/currencies', listKey: 'currencies',
    userId, syncRunId: runId,
  });
  let n = 0;
  for (const c of items) {
    await pool.execute(
      `INSERT INTO zb_currencies
         (user_id, org_id, zoho_currency_id, currency_code, currency_name, currency_symbol,
          price_precision, currency_format, is_base_currency, exchange_rate, effective_date)
       VALUES (?,?,?,?,?,?, ?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         currency_code = VALUES(currency_code), currency_name = VALUES(currency_name),
         currency_symbol = VALUES(currency_symbol), price_precision = VALUES(price_precision),
         currency_format = VALUES(currency_format), is_base_currency = VALUES(is_base_currency),
         exchange_rate = VALUES(exchange_rate), synced_at = NOW()`,
      [
        userId, orgId, str(c.currency_id, 100), str(c.currency_code, 3),
        str(c.currency_name, 100), str(c.currency_symbol, 10),
        intOrNull(c.price_precision) ?? 2, str(c.currency_format, 50),
        bool(c.is_base_currency), num(c.exchange_rate) || 1.0,
        toMysqlDate(c.effective_date),
      ]
    );
    n += 1;
  }
  return { calls, fetched: items.length, inserted: n, updated: 0, failed: 0 };
}

async function syncChartOfAccounts(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/chartofaccounts', listKey: 'chartofaccounts',
    userId, syncRunId: runId,
  });
  let n = 0;
  for (const a of items) {
    await pool.execute(
      `INSERT INTO zb_chart_of_accounts
         (user_id, org_id, zoho_account_id, account_code, account_name,
          account_type, account_type_formatted, account_subtype, parent_account_id,
          description, currency_id, currency_code,
          is_active, is_system_account, can_show_in_ze, can_delete, is_default_account,
          include_in_vat_return, current_balance, current_balance_formatted,
          documents_count, has_transactions, custom_fields_json,
          zoho_created_time, zoho_last_modified_time)
       VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?, ?,?)
       ON DUPLICATE KEY UPDATE
         account_code = VALUES(account_code), account_name = VALUES(account_name),
         account_type = VALUES(account_type), account_subtype = VALUES(account_subtype),
         description = VALUES(description),
         is_active = VALUES(is_active), current_balance = VALUES(current_balance),
         zoho_last_modified_time = VALUES(zoho_last_modified_time),
         synced_at = NOW()`,
      [
        userId, orgId, str(a.account_id, 100), str(a.account_code, 64), str(a.account_name, 255),
        str(a.account_type, 64), str(a.account_type_formatted, 255),
        str(a.account_subtype, 64), str(a.parent_account_id, 100),
        str(a.description, 1000), str(a.currency_id, 100), str(a.currency_code, 3),
        bool(a.is_active), bool(a.is_system_account), bool(a.can_show_in_ze),
        bool(a.can_delete), bool(a.is_default_account),
        bool(a.include_in_vat_return), num(a.current_balance),
        str(a.current_balance_formatted, 50),
        intOrNull(a.documents_count) ?? 0, bool(a.has_transactions),
        safeJson(a.custom_fields),
        toMysqlDt(a.created_time), toMysqlDt(a.last_modified_time),
      ]
    );
    n += 1;
  }
  return { calls, fetched: items.length, inserted: n, updated: 0, failed: 0 };
}

async function syncTaxes(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/settings/taxes', listKey: 'taxes',
    userId, syncRunId: runId,
  });
  let n = 0;
  for (const t of items) {
    await pool.execute(
      `INSERT INTO zb_tax_rates
         (user_id, org_id, zoho_tax_id, tax_name, tax_percentage, tax_type,
          tax_specification, output_tax_account_id, input_tax_account_id,
          zoho_tax_authority_id, zoho_tax_exemption_id, is_value_added,
          is_default_tax, is_editable, country_code)
       VALUES (?,?,?,?,?,?, ?,?,?, ?,?,?, ?,?,?)
       ON DUPLICATE KEY UPDATE
         tax_name = VALUES(tax_name), tax_percentage = VALUES(tax_percentage),
         tax_type = VALUES(tax_type), synced_at = NOW()`,
      [
        userId, orgId, str(t.tax_id, 100), str(t.tax_name, 255),
        num(t.tax_percentage), str(t.tax_type, 64),
        str(t.tax_specification, 64), str(t.output_tax_account_id, 100), str(t.input_tax_account_id, 100),
        str(t.tax_authority_id, 100), str(t.tax_exemption_id, 100),
        bool(t.is_value_added), bool(t.is_default_tax), bool(t.is_editable),
        str(t.country_code, 10),
      ]
    );
    // If this is a tax_group, write its component taxes
    if (Array.isArray(t.taxes) && t.tax_type === 'tax_group') {
      for (let i = 0; i < t.taxes.length; i++) {
        const sub = t.taxes[i];
        await pool.execute(
          `INSERT INTO zb_tax_group_taxes
             (user_id, org_id, zoho_tax_group_id, zoho_tax_id, display_order)
           VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE display_order = VALUES(display_order)`,
          [userId, orgId, str(t.tax_id, 100), str(sub.tax_id, 100), i]
        );
      }
    }
    n += 1;
  }
  return { calls, fetched: items.length, inserted: n, updated: 0, failed: 0 };
}

async function syncItems(userId, accessToken, orgId, runId) {
  const wm = await getWatermark(userId, orgId, 'items');
  const params = wm ? { last_modified_time: toZohoDt(wm), sort_column: 'last_modified_time', sort_order: 'A' } : { sort_column: 'last_modified_time', sort_order: 'A' };
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/items', listKey: 'items', params,
    userId, syncRunId: runId,
  });
  let n = 0, maxMod = null;
  for (const it of items) {
    await pool.execute(
      `INSERT INTO zb_items
         (user_id, org_id, zoho_item_id, name, item_name, description,
          rate, unit, status, source, is_combo_product, is_linked_with_zohocrm,
          item_type, product_type, has_attachment, is_taxable, tax_id, tax_name,
          tax_percentage, tax_type, account_id, account_name,
          purchase_account_id, purchase_account_name, inventory_account_id,
          purchase_description, purchase_rate, vendor_id, vendor_name,
          reorder_level, stock_on_hand, available_stock,
          sku, upc, ean, isbn, part_number, hsn_or_sac, brand, manufacturer,
          custom_fields_json, zoho_created_time, zoho_last_modified_time)
       VALUES (?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,
               ?,?,?,?,?,?,?,?, ?,?,?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name), description = VALUES(description), rate = VALUES(rate),
         status = VALUES(status), stock_on_hand = VALUES(stock_on_hand),
         available_stock = VALUES(available_stock),
         zoho_last_modified_time = VALUES(zoho_last_modified_time), synced_at = NOW()`,
      [
        userId, orgId, str(it.item_id, 100), str(it.name, 255), str(it.item_name || it.name, 255),
        str(it.description, 2000),
        num(it.rate), str(it.unit, 50), str(it.status, 50), str(it.source, 50),
        bool(it.is_combo_product), bool(it.is_linked_with_zohocrm),
        str(it.item_type, 50), str(it.product_type, 50),
        bool(it.has_attachment), bool(it.is_taxable),
        str(it.tax_id, 100), str(it.tax_name, 255), num(it.tax_percentage), str(it.tax_type, 64),
        str(it.account_id, 100), str(it.account_name, 255),
        str(it.purchase_account_id, 100), str(it.purchase_account_name, 255), str(it.inventory_account_id, 100),
        str(it.purchase_description, 2000), num(it.purchase_rate),
        str(it.vendor_id, 100), str(it.vendor_name, 255),
        num(it.reorder_level), num(it.stock_on_hand), num(it.available_stock),
        str(it.sku, 100), str(it.upc, 100), str(it.ean, 100), str(it.isbn, 100), str(it.part_number, 100),
        str(it.hsn_or_sac, 50), str(it.brand, 100), str(it.manufacturer, 255),
        safeJson(it.custom_fields),
        toMysqlDt(it.created_time), toMysqlDt(it.last_modified_time),
      ]
    );
    n += 1;
    if (it.last_modified_time && (!maxMod || it.last_modified_time > maxMod)) maxMod = it.last_modified_time;
  }
  if (maxMod) await setWatermark(userId, orgId, 'items', toMysqlDt(maxMod), n);
  return { calls, fetched: items.length, inserted: n, updated: 0, failed: 0 };
}

// ═════════════════════════════════════════════════════════════════════════════
// Tax authorities + exemptions
// ═════════════════════════════════════════════════════════════════════════════

async function syncTaxAuthorities(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/settings/taxauthorities', listKey: 'tax_authorities',
    userId, syncRunId: runId,
  });
  for (const a of items) {
    await pool.execute(
      `INSERT INTO zb_tax_authorities (user_id, org_id, zoho_tax_authority_id, tax_authority_name, description)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE tax_authority_name=VALUES(tax_authority_name), synced_at=NOW()`,
      [userId, orgId, str(a.tax_authority_id, 100), str(a.tax_authority_name, 255), str(a.description, 1000)]
    );
  }
  return { calls, fetched: items.length, inserted: items.length, updated: 0, failed: 0 };
}

async function syncTaxExemptions(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/settings/taxexemptions', listKey: 'tax_exemptions',
    userId, syncRunId: runId,
  });
  for (const e of items) {
    await pool.execute(
      `INSERT INTO zb_tax_exemptions (user_id, org_id, zoho_tax_exemption_id, tax_exemption_code, description)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE tax_exemption_code=VALUES(tax_exemption_code), synced_at=NOW()`,
      [userId, orgId, str(e.tax_exemption_id, 100), str(e.tax_exemption_code, 64), str(e.description, 1000)]
    );
  }
  return { calls, fetched: items.length, inserted: items.length, updated: 0, failed: 0 };
}

// ═════════════════════════════════════════════════════════════════════════════
// Contacts (customers + vendors)
// ═════════════════════════════════════════════════════════════════════════════

async function upsertContact(userId, orgId, c) {
  // Warehouse contacts feed BOTH legacy tables: customers and vendors each
  // mirror the full contact set (reports filter on contact_type).
  const contactSql = (tbl) =>
    `INSERT INTO ${tbl}
       (user_id, org_id, zoho_id, contact_name, company_name, contact_type,
        customer_sub_type, status, source, is_linked_with_zohocrm, zohocrm_contact_id,
        outstanding_receivable_amount, outstanding_receivable_amount_bcy,
        unused_credits_receivable_amount, unused_credits_receivable_amount_bcy,
        outstanding_payable_amount, outstanding_payable_amount_bcy,
        unused_credits_payable_amount, unused_credits_payable_amount_bcy,
        currency_id, currency_code, currency_symbol, exchange_rate,
        tax_id, tax_name, tax_percentage, tax_authority_id, tax_authority_name,
        tax_exemption_id, tax_exemption_code, tax_treatment, gst_no, gst_treatment,
        place_of_contact, vat_reg_no, vat_treatment,
        payment_terms, payment_terms_label, credit_limit,
        pricebook_id, pricebook_name, default_templates_json,
        notes, customer_currency_summary_json, primary_contact_id,
        language_code, language_code_formatted, facebook, twitter,
        custom_fields_json, zoho_created_time, zoho_last_modified_time, synced_at)
     VALUES (?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?, ?,?,?, ?,?,?, ?,?,?,?, ?,?,?, NOW())
     ON DUPLICATE KEY UPDATE
       contact_name = VALUES(contact_name), company_name = VALUES(company_name),
       contact_type = VALUES(contact_type), status = VALUES(status),
       outstanding_receivable_amount = VALUES(outstanding_receivable_amount),
       outstanding_payable_amount = VALUES(outstanding_payable_amount),
       gst_no = VALUES(gst_no), gst_treatment = VALUES(gst_treatment),
       zoho_last_modified_time = VALUES(zoho_last_modified_time), synced_at = NOW()`;
  const contactParams = [
      userId, orgId, str(c.contact_id, 100), str(c.contact_name, 255), str(c.company_name, 255),
      str(c.contact_type, 50),
      str(c.customer_sub_type, 50), str(c.status, 50), str(c.source, 50),
      bool(c.is_linked_with_zohocrm), str(c.zohocrm_contact_id, 100),
      num(c.outstanding_receivable_amount), num(c.outstanding_receivable_amount_bcy),
      num(c.unused_credits_receivable_amount), num(c.unused_credits_receivable_amount_bcy),
      num(c.outstanding_payable_amount), num(c.outstanding_payable_amount_bcy),
      num(c.unused_credits_payable_amount), num(c.unused_credits_payable_amount_bcy),
      str(c.currency_id, 100), str(c.currency_code, 3), str(c.currency_symbol, 10),
      num(c.exchange_rate) || 1.0,
      str(c.tax_id, 100), str(c.tax_name, 255), num(c.tax_percentage),
      str(c.tax_authority_id, 100), str(c.tax_authority_name, 255),
      str(c.tax_exemption_id, 100), str(c.tax_exemption_code, 64), str(c.tax_treatment, 64),
      str(c.gst_no, 20), str(c.gst_treatment, 50),
      str(c.place_of_contact, 100), str(c.vat_reg_no, 50), str(c.vat_treatment, 50),
      intOrNull(c.payment_terms) ?? 0, str(c.payment_terms_label, 64),
      num(c.credit_limit),
      str(c.pricebook_id, 100), str(c.pricebook_name, 255),
      safeJson(c.default_templates),
      str(c.notes, 2000), safeJson(c.customer_currency_summary),
      str(c.primary_contact_id, 100),
      str(c.language_code, 10), str(c.language_code_formatted, 64),
      str(c.facebook, 255), str(c.twitter, 255),
      safeJson(c.custom_fields),
      toMysqlDt(c.created_time), toMysqlDt(c.last_modified_time),
  ];
  for (const tbl of ['customers', 'vendors']) {
    await pool.execute(contactSql(tbl), contactParams);
  }
  // Contact persons + addresses (if present in the detail payload)
  if (Array.isArray(c.contact_persons)) {
    for (const p of c.contact_persons) {
      await pool.execute(
        `INSERT INTO zb_contact_persons
           (user_id, org_id, zoho_contact_person_id, zoho_contact_id,
            salutation, first_name, last_name, email, phone, mobile,
            skype, designation, department, is_primary_contact, is_added_in_portal)
         VALUES (?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           first_name = VALUES(first_name), last_name = VALUES(last_name),
           email = VALUES(email), phone = VALUES(phone), synced_at = NOW()`,
        [
          userId, orgId, str(p.contact_person_id, 100), str(c.contact_id, 100),
          str(p.salutation, 20), str(p.first_name, 100), str(p.last_name, 100),
          str(p.email, 255), str(p.phone, 50), str(p.mobile, 50),
          str(p.skype, 100), str(p.designation, 100), str(p.department, 100),
          bool(p.is_primary_contact), bool(p.is_added_in_portal),
        ]
      );
    }
  }
  for (const t of ['billing', 'shipping']) {
    const a = t === 'billing' ? c.billing_address : c.shipping_address;
    if (!a || !a.address) continue;
    await pool.execute(
      `INSERT INTO zb_contact_addresses
         (user_id, org_id, zoho_address_id, zoho_contact_id, address_type,
          attention, address, street2, city, state, state_code, zip,
          country, country_code, fax, phone)
       VALUES (?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?)`,
      [
        userId, orgId, str(a.address_id, 100), str(c.contact_id, 100), t,
        str(a.attention, 255), str(a.address, 255), str(a.street2, 255),
        str(a.city, 100), str(a.state, 100), str(a.state_code, 20), str(a.zip, 20),
        str(a.country, 100), str(a.country_code, 10), str(a.fax, 50), str(a.phone, 50),
      ]
    );
  }
}

async function syncContacts(userId, accessToken, orgId, runId) {
  // We sync customers and vendors as a single contacts list (Zoho merges them).
  const wm = await getWatermark(userId, orgId, 'contacts');
  const params = wm ? { last_modified_time: toZohoDt(wm), sort_column: 'last_modified_time', sort_order: 'A' } : { sort_column: 'last_modified_time', sort_order: 'A' };
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/contacts', listKey: 'contacts', params,
    userId, syncRunId: runId,
  });
  let n = 0, maxMod = null;
  for (const c of items) {
    try {
      await upsertContact(userId, orgId, c);
      n += 1;
      if (c.last_modified_time && (!maxMod || c.last_modified_time > maxMod)) maxMod = c.last_modified_time;
    } catch (e) {
      console.warn('[ZB contact] failed', c.contact_id, e.message);
    }
  }
  if (maxMod) await setWatermark(userId, orgId, 'contacts', toMysqlDt(maxMod), n);
  return { calls, fetched: items.length, inserted: n, updated: 0, failed: items.length - n };
}

// ═════════════════════════════════════════════════════════════════════════════
// Projects / Tasks / Time entries
// ═════════════════════════════════════════════════════════════════════════════

async function syncProjects(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/projects', listKey: 'projects',
    userId, syncRunId: runId,
  });
  for (const p of items) {
    await pool.execute(
      `INSERT INTO zb_projects
         (user_id, org_id, zoho_project_id, project_name, customer_id, customer_name,
          status, description, billing_type, rate, budget_type, budget_hours, budget_amount,
          total_hours, billed_hours, un_billed_hours,
          currency_id, currency_code, custom_fields_json,
          zoho_created_time, zoho_last_modified_time)
       VALUES (?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?, ?,?,?, ?,?)
       ON DUPLICATE KEY UPDATE
         project_name = VALUES(project_name), status = VALUES(status),
         total_hours = VALUES(total_hours), billed_hours = VALUES(billed_hours),
         un_billed_hours = VALUES(un_billed_hours),
         zoho_last_modified_time = VALUES(zoho_last_modified_time), synced_at = NOW()`,
      [
        userId, orgId, str(p.project_id, 100), str(p.project_name, 255),
        str(p.customer_id, 100), str(p.customer_name, 255),
        str(p.status, 50), str(p.description, 2000), str(p.billing_type, 50),
        num(p.rate), str(p.budget_type, 50), num(p.budget_hours), num(p.budget_amount),
        num(p.total_hours), num(p.billed_hours), num(p.un_billed_hours),
        str(p.currency_id, 100), str(p.currency_code, 3), safeJson(p.custom_fields),
        toMysqlDt(p.created_time), toMysqlDt(p.last_modified_time),
      ]
    );
  }
  return { calls, fetched: items.length, inserted: items.length, updated: 0, failed: 0 };
}

async function syncTimeEntries(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/projects/timeentries', listKey: 'time_entries',
    userId, syncRunId: runId,
  });
  for (const t of items) {
    await pool.execute(
      `INSERT INTO zb_time_entries
         (user_id, org_id, zoho_time_entry_id, zoho_project_id, zoho_task_id,
          user_zoho_id, user_name, project_name, task_name, customer_id, customer_name,
          log_date, begin_time, end_time, log_time, hours, is_billable, billed_status,
          zoho_invoice_id, invoice_status, notes,
          zoho_created_time, zoho_last_modified_time)
       VALUES (?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?, ?,?)
       ON DUPLICATE KEY UPDATE
         hours = VALUES(hours), is_billable = VALUES(is_billable),
         billed_status = VALUES(billed_status),
         zoho_invoice_id = VALUES(zoho_invoice_id),
         zoho_last_modified_time = VALUES(zoho_last_modified_time), synced_at = NOW()`,
      [
        userId, orgId, str(t.time_entry_id, 100), str(t.project_id, 100), str(t.task_id, 100),
        str(t.user_id, 100), str(t.user_name, 255),
        str(t.project_name, 255), str(t.task_name, 255),
        str(t.customer_id, 100), str(t.customer_name, 255),
        toMysqlDate(t.log_date), toMysqlTime(t.begin_time), toMysqlTime(t.end_time),
        str(t.log_time, 20), num(t.hours), bool(t.is_billable), str(t.billed_status, 50),
        str(t.invoice_id, 100), str(t.invoice_status, 50),
        str(t.notes, 2000),
        toMysqlDt(t.created_time), toMysqlDt(t.last_modified_time),
      ]
    );
  }
  return { calls, fetched: items.length, inserted: items.length, updated: 0, failed: 0 };
}

// ═════════════════════════════════════════════════════════════════════════════
// Invoices (header from list, lines from detail call)
// ═════════════════════════════════════════════════════════════════════════════

async function upsertInvoiceHeader(userId, orgId, inv) {
  await pool.execute(
    `INSERT INTO invoices
       (user_id, org_id, zoho_id, invoice_number, reference_number,
        zoho_customer_id, customer_name, email, status, date, due_date,
        currency_id, currency_code, currency_symbol, exchange_rate,
        sub_total, tax_total, discount, discount_amount, adjustment, shipping_charge,
        total, balance, payment_made, credits_applied, write_off_amount,
        sub_total_bcy, tax_total_bcy, total_bcy, balance_bcy,
        is_inclusive_tax, gst_no, gst_treatment, place_of_supply,
        salesperson_id, salesperson_name, template_id, template_name,
        billing_address_json, shipping_address_json,
        notes, terms, documents_count,
        custom_fields_json, zoho_created_time, zoho_last_modified_time, synced_at)
     VALUES (?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?, ?,?,?, ?,?,?, NOW())
     ON DUPLICATE KEY UPDATE
       invoice_number = VALUES(invoice_number), status = VALUES(status),
       zoho_customer_id = VALUES(zoho_customer_id), customer_name = VALUES(customer_name),
       recurring_invoice_id = VALUES(recurring_invoice_id),
       sub_total = VALUES(sub_total), tax_total = VALUES(tax_total),
       discount = VALUES(discount), discount_amount = VALUES(discount_amount),
       total = VALUES(total), balance = VALUES(balance),
       payment_made = VALUES(payment_made),
       sub_total_bcy = VALUES(sub_total_bcy), tax_total_bcy = VALUES(tax_total_bcy),
       total_bcy = VALUES(total_bcy), balance_bcy = VALUES(balance_bcy),
       zoho_last_modified_time = VALUES(zoho_last_modified_time), synced_at = NOW()`,
    [
      userId, orgId, str(inv.invoice_id, 100), str(inv.invoice_number, 100), str(inv.reference_number, 100),
      str(inv.customer_id, 100), str(inv.customer_name, 255), str(inv.email, 255),
      str(inv.status, 50), toMysqlDate(inv.date), toMysqlDate(inv.due_date),
      str(inv.currency_id, 100), str(inv.currency_code, 3), str(inv.currency_symbol, 10),
      num(inv.exchange_rate) || 1.0,
      num(inv.sub_total), num(inv.tax_total), num(inv.discount), num(inv.discount_amount),
      num(inv.adjustment), num(inv.shipping_charge),
      num(inv.total), num(inv.balance), num(inv.payment_made),
      num(inv.credits_applied), num(inv.write_off_amount),
      num(inv.sub_total_bcy), num(inv.tax_total_bcy), num(inv.total_bcy), num(inv.balance_bcy),
      bool(inv.is_inclusive_tax), str(inv.gst_no, 20), str(inv.gst_treatment, 50), str(inv.place_of_supply, 100),
      str(inv.salesperson_id, 100), str(inv.salesperson_name, 255),
      str(inv.template_id, 100), str(inv.template_name, 255),
      safeJson(inv.billing_address), safeJson(inv.shipping_address),
      str(inv.notes, 4000), str(inv.terms, 4000), intOrNull(inv.documents) ?? 0,
      safeJson(inv.custom_fields),
      toMysqlDt(inv.created_time), toMysqlDt(inv.last_modified_time),
    ]
  );
  // Line items (if available in the list payload — sometimes only in detail call)
  if (Array.isArray(inv.line_items)) {
    for (let i = 0; i < inv.line_items.length; i++) {
      const li = inv.line_items[i];
      await pool.execute(
        `INSERT INTO zb_invoice_line_items
           (user_id, org_id, zoho_line_item_id, zoho_invoice_id, line_position,
            zoho_item_id, item_name, description, unit, hsn_or_sac, account_id, account_name,
            quantity, rate, discount, discount_amount, item_total, item_total_inclusive_of_tax,
            tax_id, tax_name, tax_type, tax_percentage, tax_amount,
            project_id, custom_fields_json)
         VALUES (?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?)
         ON DUPLICATE KEY UPDATE
           item_name = VALUES(item_name), quantity = VALUES(quantity),
           rate = VALUES(rate), item_total = VALUES(item_total), tax_amount = VALUES(tax_amount)`,
        [
          userId, orgId, str(li.line_item_id, 100), str(inv.invoice_id, 100), i,
          str(li.item_id, 100), str(li.name || li.item_name, 255), str(li.description, 2000),
          str(li.unit, 50), str(li.hsn_or_sac, 50),
          str(li.account_id, 100), str(li.account_name, 255),
          num(li.quantity), num(li.rate), num(li.discount), num(li.discount_amount),
          num(li.item_total), num(li.item_total_inclusive_of_tax),
          str(li.tax_id, 100), str(li.tax_name, 255), str(li.tax_type, 64),
          num(li.tax_percentage), num(li.tax_amount),
          str(li.project_id, 100), safeJson(li.custom_fields),
        ]
      );
    }
  }
}

async function syncInvoices(userId, accessToken, orgId, runId) {
  const wm = await getWatermark(userId, orgId, 'invoices');
  const params = wm ? { last_modified_time: toZohoDt(wm), sort_column: 'last_modified_time', sort_order: 'A' } : { sort_column: 'last_modified_time', sort_order: 'A' };
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/invoices', listKey: 'invoices', params,
    userId, syncRunId: runId,
  });
  let n = 0, maxMod = null, detailCalls = 0;
  for (const inv of items) {
    try {
      // The /invoices LIST payload does NOT include sub_total / tax_total / line_items
      // (only `total` + `balance`). Those live only on the per-invoice DETAIL call, so
      // fetch it and merge — otherwise sub_total/tax_total persist as 0 (wrong "Total
      // Sales" / "Total Tax Amount" vs Zoho's Sales Summary). Fall back to the list row
      // if the detail fetch fails.
      const detail = await fetchOne({
        accessToken, orgId, endpoint: `/invoices/${inv.invoice_id}`,
        dataKey: 'invoice', userId, syncRunId: runId,
      });
      detailCalls += 1;
      await upsertInvoiceHeader(userId, orgId, detail ? { ...inv, ...detail } : inv);
      n += 1;
      if (inv.last_modified_time && (!maxMod || inv.last_modified_time > maxMod)) maxMod = inv.last_modified_time;
    } catch (e) {
      console.warn('[ZB invoice]', inv.invoice_id, e.message);
    }
  }
  if (maxMod) await setWatermark(userId, orgId, 'invoices', toMysqlDt(maxMod), n);
  return { calls: calls + detailCalls, fetched: items.length, inserted: n, updated: 0, failed: items.length - n };
}

// ═════════════════════════════════════════════════════════════════════════════
// Bills, Customer Payments, Vendor Payments, Credit Notes, Vendor Credits,
// Expenses, Journals, Bank Accounts, Bank Transactions
// (compact upsert pattern — same as invoices)
// ═════════════════════════════════════════════════════════════════════════════

// Bill line items live ONLY on the /bills/{id} DETAIL payload (the LIST omits
// them and the tax breakdown). Mirrors zb_invoice_line_items.
async function upsertBillLineItems(userId, orgId, bill) {
  if (!Array.isArray(bill.line_items)) return;
  for (let i = 0; i < bill.line_items.length; i++) {
    const li = bill.line_items[i];
    await pool.execute(
      `INSERT INTO zb_bill_line_items
         (user_id, org_id, zoho_line_item_id, zoho_bill_id, line_position,
          zoho_item_id, item_name, description, unit, hsn_or_sac, account_id, account_name,
          quantity, rate, discount, discount_amount, item_total, item_total_inclusive_of_tax,
          tax_id, tax_name, tax_type, tax_percentage, tax_amount,
          tds_tax_name, tds_tax_amount, tds_tax_percentage, custom_fields_json)
       VALUES (?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?)
       ON DUPLICATE KEY UPDATE
         item_name = VALUES(item_name), description = VALUES(description),
         quantity = VALUES(quantity), rate = VALUES(rate),
         item_total = VALUES(item_total), tax_amount = VALUES(tax_amount),
         tax_name = VALUES(tax_name), tax_percentage = VALUES(tax_percentage),
         tds_tax_name = VALUES(tds_tax_name), tds_tax_amount = VALUES(tds_tax_amount),
         tds_tax_percentage = VALUES(tds_tax_percentage),
         account_name = VALUES(account_name), hsn_or_sac = VALUES(hsn_or_sac)`,
      [
        userId, orgId, str(li.line_item_id, 100), str(bill.bill_id, 100), i,
        str(li.item_id, 100), str(li.name || li.item_name, 255), str(li.description, 2000),
        str(li.unit, 50), str(li.hsn_or_sac, 50),
        str(li.account_id, 100), str(li.account_name, 255),
        num(li.quantity), num(li.rate), num(li.discount), num(li.discount_amount),
        num(li.item_total), num(li.item_total_inclusive_of_tax),
        str(li.tax_id, 100), str(li.tax_name, 255), str(li.tax_type, 64),
        num(li.tax_percentage), num(li.tax_amount),
        str(li.tds_tax_name, 255), num(li.tds_tax_amount), num(li.tds_tax_percentage),
        safeJson(li.custom_fields),
      ]
    );
  }
}

async function syncBills(userId, accessToken, orgId, runId) {
  const wm = await getWatermark(userId, orgId, 'bills');
  const params = wm ? { last_modified_time: toZohoDt(wm), sort_column: 'last_modified_time', sort_order: 'A' } : { sort_column: 'last_modified_time', sort_order: 'A' };
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/bills', listKey: 'bills', params,
    userId, syncRunId: runId,
  });
  let n = 0, maxMod = null, detailCalls = 0;
  for (const listRow of items) {
    try {
      // The /bills LIST payload omits sub_total / tax_total / line_items — those
      // live only on the per-bill DETAIL call. Fetch + merge so the purchase tax
      // (input GST / ITC) and line items are captured. Fall back to the list row.
      const detail = await fetchOne({
        accessToken, orgId, endpoint: `/bills/${listRow.bill_id}`,
        dataKey: 'bill', userId, syncRunId: runId,
      });
      detailCalls += 1;
      const b = detail ? { ...listRow, ...detail } : listRow;
      await pool.execute(
        `INSERT INTO bills
           (user_id, org_id, zoho_id, bill_number, reference_number, status,
            zoho_vendor_id, vendor_name, zoho_purchaseorder_id,
            date, due_date, payment_terms, payment_terms_label,
            sub_total, tax_total, discount, discount_amount,
            adjustment, total, total_bcy, balance, balance_bcy,
            payment_made, vendor_credits_applied,
            is_inclusive_tax, gst_no, gst_treatment, place_of_supply,
            currency_id, currency_code, currency_symbol, exchange_rate,
            notes, terms, documents_count,
            custom_fields_json, zoho_created_time, zoho_last_modified_time, synced_at)
         VALUES (?,?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?, ?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?, NOW())
         ON DUPLICATE KEY UPDATE
           status = VALUES(status), total = VALUES(total), balance = VALUES(balance),
           sub_total = VALUES(sub_total), tax_total = VALUES(tax_total),
           payment_made = VALUES(payment_made),
           zoho_last_modified_time = VALUES(zoho_last_modified_time), synced_at = NOW()`,
        [
          userId, orgId, str(b.bill_id, 100), str(b.bill_number, 100),
          str(b.reference_number, 100), str(b.status, 50),
          str(b.vendor_id, 100), str(b.vendor_name, 255), str(b.purchaseorder_id, 100),
          toMysqlDate(b.date), toMysqlDate(b.due_date),
          intOrNull(b.payment_terms) ?? 0, str(b.payment_terms_label, 64),
          num(b.sub_total), num(b.tax_total), num(b.discount), num(b.discount_amount),
          num(b.adjustment), num(b.total), num(b.total_bcy), num(b.balance), num(b.balance_bcy),
          num(b.payment_made), num(b.vendor_credits_applied),
          bool(b.is_inclusive_tax), str(b.gst_no, 20), str(b.gst_treatment, 50), str(b.place_of_supply, 100),
          str(b.currency_id, 100), str(b.currency_code, 3), str(b.currency_symbol, 10),
          num(b.exchange_rate) || 1.0,
          str(b.notes, 4000), str(b.terms, 4000), intOrNull(b.documents) ?? 0,
          safeJson(b.custom_fields),
          toMysqlDt(b.created_time), toMysqlDt(b.last_modified_time),
        ]
      );
      await upsertBillLineItems(userId, orgId, b);
      n += 1;
      if (b.last_modified_time && (!maxMod || b.last_modified_time > maxMod)) maxMod = b.last_modified_time;
    } catch (e) {
      if (e instanceof RateLimitError) throw e; // bubble up — abort org, keep progress
      console.warn('[ZB bill]', listRow.bill_id, e.message);
    }
  }
  if (maxMod) await setWatermark(userId, orgId, 'bills', toMysqlDt(maxMod), n);
  return { calls: calls + detailCalls, fetched: items.length, inserted: n, updated: 0, failed: items.length - n };
}

async function syncCustomerPayments(userId, accessToken, orgId, runId) {
  const wm = await getWatermark(userId, orgId, 'customer_payments');
  const params = wm ? { last_modified_time: toZohoDt(wm), sort_column: 'last_modified_time', sort_order: 'A' } : { sort_column: 'last_modified_time', sort_order: 'A' };
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/customerpayments', listKey: 'customerpayments', params,
    userId, syncRunId: runId,
  });
  let n = 0, maxMod = null;
  for (const p of items) {
    try {
      await pool.execute(
        `INSERT INTO zb_customer_payments
           (user_id, org_id, zoho_payment_id, payment_number, zoho_customer_id, customer_name,
            email, date, amount, amount_bcy, unused_amount, exchange_rate,
            payment_mode, description, reference_number,
            account_id, account_name, account_type, currency_id, currency_code,
            currency_symbol, status, has_attachment, documents_count, invoice_numbers,
            custom_fields_json, zoho_created_time, zoho_last_modified_time)
         VALUES (?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?)
         ON DUPLICATE KEY UPDATE
           amount = VALUES(amount), status = VALUES(status),
           zoho_last_modified_time = VALUES(zoho_last_modified_time), synced_at = NOW()`,
        [
          userId, orgId, str(p.payment_id, 100), str(p.payment_number, 100),
          str(p.customer_id, 100), str(p.customer_name, 255), str(p.email, 255),
          toMysqlDate(p.date), num(p.amount), num(p.amount_bcy),
          num(p.unused_amount), num(p.exchange_rate) || 1.0,
          str(p.payment_mode, 50), str(p.description, 2000), str(p.reference_number, 100),
          str(p.account_id, 100), str(p.account_name, 255), str(p.account_type, 50),
          str(p.currency_id, 100), str(p.currency_code, 3), str(p.currency_symbol, 10),
          str(p.status, 50), bool(p.has_attachment), intOrNull(p.documents) ?? 0,
          str(p.invoice_numbers, 1000),
          safeJson(p.custom_fields),
          toMysqlDt(p.created_time), toMysqlDt(p.last_modified_time),
        ]
      );
      // Payment-invoice mapping (if present in list response)
      if (Array.isArray(p.invoices)) {
        for (const i of p.invoices) {
          await pool.execute(
            `INSERT INTO zb_customer_payment_invoices
               (user_id, org_id, zoho_payment_id, zoho_invoice_id, invoice_number,
                invoice_date, invoice_amount, amount_applied, apply_date)
             VALUES (?,?,?,?,?, ?,?,?,?)
             ON DUPLICATE KEY UPDATE amount_applied=VALUES(amount_applied)`,
            [userId, orgId, str(p.payment_id, 100), str(i.invoice_id, 100),
             str(i.invoice_number, 100), toMysqlDate(i.invoice_date),
             num(i.invoice_amount), num(i.amount_applied), toMysqlDate(i.apply_date)]
          );
        }
      }
      n += 1;
      if (p.last_modified_time && (!maxMod || p.last_modified_time > maxMod)) maxMod = p.last_modified_time;
    } catch (e) {
      console.warn('[ZB cust_pay]', p.payment_id, e.message);
    }
  }
  if (maxMod) await setWatermark(userId, orgId, 'customer_payments', toMysqlDt(maxMod), n);
  return { calls, fetched: items.length, inserted: n, updated: 0, failed: items.length - n };
}

async function syncVendorPayments(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/vendorpayments', listKey: 'vendorpayments',
    userId, syncRunId: runId,
  });
  let n = 0;
  for (const p of items) {
    try {
      await pool.execute(
        `INSERT INTO zb_vendor_payments
           (user_id, org_id, zoho_vendor_payment_id, payment_number,
            zoho_vendor_id, vendor_name, date, amount, amount_bcy,
            exchange_rate, payment_mode, description, reference_number,
            account_id, account_name, paid_through_account_id, paid_through_account_name,
            currency_id, currency_code, status,
            zoho_created_time, zoho_last_modified_time)
         VALUES (?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?, ?,?)
         ON DUPLICATE KEY UPDATE amount=VALUES(amount), status=VALUES(status), synced_at=NOW()`,
        [
          userId, orgId, str(p.payment_id, 100), str(p.payment_number, 100),
          str(p.vendor_id, 100), str(p.vendor_name, 255),
          toMysqlDate(p.date), num(p.amount), num(p.amount_bcy),
          num(p.exchange_rate) || 1.0, str(p.payment_mode, 50),
          str(p.description, 2000), str(p.reference_number, 100),
          str(p.account_id, 100), str(p.account_name, 255),
          str(p.paid_through_account_id, 100), str(p.paid_through_account_name, 255),
          str(p.currency_id, 100), str(p.currency_code, 3), str(p.status, 50),
          toMysqlDt(p.created_time), toMysqlDt(p.last_modified_time),
        ]
      );
      if (Array.isArray(p.bills)) {
        for (const b of p.bills) {
          await pool.execute(
            `INSERT INTO zb_vendor_payment_bills
               (user_id, org_id, zoho_vendor_payment_id, zoho_bill_id, bill_number,
                bill_date, bill_amount, amount_applied, apply_date)
             VALUES (?,?,?,?,?, ?,?,?,?)
             ON DUPLICATE KEY UPDATE amount_applied=VALUES(amount_applied)`,
            [userId, orgId, str(p.payment_id, 100), str(b.bill_id, 100),
             str(b.bill_number, 100), toMysqlDate(b.bill_date),
             num(b.bill_amount), num(b.amount_applied), toMysqlDate(b.apply_date)]
          );
        }
      }
      n += 1;
    } catch (e) {
      console.warn('[ZB vendor_pay]', p.payment_id, e.message);
    }
  }
  return { calls, fetched: items.length, inserted: n, updated: 0, failed: items.length - n };
}

// Credit note line items — and the per-rate tax breakdown the Tax Summary is
// built from — live ONLY on the /creditnotes/{id} DETAIL payload, exactly like
// invoices and bills. Mirrors zb_invoice_line_items.
async function upsertCreditNoteLineItems(userId, orgId, cn) {
  if (!Array.isArray(cn.line_items)) return;
  for (let i = 0; i < cn.line_items.length; i++) {
    const li = cn.line_items[i];
    await pool.execute(
      `INSERT INTO zb_credit_note_line_items
         (user_id, org_id, zoho_line_item_id, zoho_creditnote_id, line_position,
          zoho_item_id, item_name, description, unit, hsn_or_sac, account_id, account_name,
          quantity, rate, discount, discount_amount, item_total, item_total_inclusive_of_tax,
          tax_id, tax_name, tax_type, tax_percentage, tax_amount,
          project_id, custom_fields_json)
       VALUES (?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?)
       ON DUPLICATE KEY UPDATE
         item_name = VALUES(item_name), quantity = VALUES(quantity),
         rate = VALUES(rate), item_total = VALUES(item_total),
         tax_id = VALUES(tax_id), tax_name = VALUES(tax_name),
         tax_type = VALUES(tax_type), tax_percentage = VALUES(tax_percentage),
         tax_amount = VALUES(tax_amount)`,
      [
        userId, orgId, str(li.line_item_id, 100), str(cn.creditnote_id, 100), i,
        str(li.item_id, 100), str(li.name || li.item_name, 255), str(li.description, 2000),
        str(li.unit, 50), str(li.hsn_or_sac, 50),
        str(li.account_id, 100), str(li.account_name, 255),
        num(li.quantity), num(li.rate), num(li.discount), num(li.discount_amount),
        num(li.item_total), num(li.item_total_inclusive_of_tax),
        str(li.tax_id, 100), str(li.tax_name, 255), str(li.tax_type, 64),
        num(li.tax_percentage), num(li.tax_amount),
        str(li.project_id, 100), safeJson(li.custom_fields),
      ]
    );
  }
}

async function syncCreditNotes(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/creditnotes', listKey: 'creditnotes',
    userId, syncRunId: runId,
  });
  let n = 0, detailCalls = 0;
  for (const listRow of items) {
    // The LIST payload carries neither sub_total/tax_total nor the line items,
    // so merge the detail over it and fall back to the list row if it fails.
    let c = listRow;
    try {
      const detail = await fetchOne({
        accessToken, orgId, endpoint: `/creditnotes/${listRow.creditnote_id}`,
        dataKey: 'creditnote', userId, syncRunId: runId,
      });
      detailCalls += 1;
      if (detail) c = { ...listRow, ...detail };
    } catch (e) {
      console.warn('[ZB credit_note detail]', listRow.creditnote_id, e.message);
    }
    try {
      await pool.execute(
        `INSERT INTO zb_credit_notes
           (user_id, org_id, zoho_creditnote_id, creditnote_number, reference_number,
            status, zoho_customer_id, customer_name, email, date, reason,
            sub_total, tax_total, total, total_bcy, balance, balance_bcy,
            credits_applied, refunded_amount,
            currency_id, currency_code, exchange_rate,
            is_inclusive_tax, gst_no, gst_treatment,
            notes, terms, documents_count, invoice_id, invoice_number,
            zoho_created_time, zoho_last_modified_time)
         VALUES (?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?, ?,?,?, ?,?,?, ?,?,?,?,?, ?,?)
         ON DUPLICATE KEY UPDATE status=VALUES(status), balance=VALUES(balance),
           sub_total=VALUES(sub_total), tax_total=VALUES(tax_total),
           total=VALUES(total), total_bcy=VALUES(total_bcy), synced_at=NOW()`,
        [
          userId, orgId, str(c.creditnote_id, 100), str(c.creditnote_number, 100),
          str(c.reference_number, 100), str(c.status, 50),
          str(c.customer_id, 100), str(c.customer_name, 255), str(c.email, 255),
          toMysqlDate(c.date), str(c.reason, 255),
          num(c.sub_total), num(c.tax_total), num(c.total), num(c.total_bcy),
          num(c.balance), num(c.balance_bcy),
          num(c.credits_applied), num(c.refunded_amount),
          str(c.currency_id, 100), str(c.currency_code, 3), num(c.exchange_rate) || 1.0,
          bool(c.is_inclusive_tax), str(c.gst_no, 20), str(c.gst_treatment, 50),
          str(c.notes, 4000), str(c.terms, 4000), intOrNull(c.documents) ?? 0,
          str(c.invoice_id, 100), str(c.invoice_number, 100),
          toMysqlDt(c.created_time), toMysqlDt(c.last_modified_time),
        ]
      );
      if (Array.isArray(c.invoices_credited)) {
        for (const i of c.invoices_credited) {
          await pool.execute(
            `INSERT INTO zb_credit_note_invoices
               (user_id, org_id, zoho_creditnote_id, zoho_invoice_id, invoice_number, amount_applied, apply_date)
             VALUES (?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE amount_applied=VALUES(amount_applied)`,
            [userId, orgId, str(c.creditnote_id, 100), str(i.invoice_id, 100),
             str(i.invoice_number, 100), num(i.amount_applied), toMysqlDate(i.apply_date)]
          );
        }
      }
      await upsertCreditNoteLineItems(userId, orgId, c);
      n += 1;
    } catch (e) {
      console.warn('[ZB credit_note]', c.creditnote_id, e.message);
    }
  }
  return { calls: calls + detailCalls, fetched: items.length, inserted: n, updated: 0, failed: items.length - n };
}

async function syncVendorCredits(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/vendorcredits', listKey: 'vendor_credits',
    userId, syncRunId: runId,
  });
  let n = 0;
  for (const v of items) {
    try {
      await pool.execute(
        `INSERT INTO zb_vendor_credits
           (user_id, org_id, zoho_vendor_credit_id, vendor_credit_number, reference_number,
            status, zoho_vendor_id, vendor_name, date,
            sub_total, tax_total, total, total_bcy, balance,
            credits_applied, refunded_amount,
            currency_id, currency_code, exchange_rate,
            zoho_created_time, zoho_last_modified_time)
         VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?, ?,?,?, ?,?)
         ON DUPLICATE KEY UPDATE status=VALUES(status), balance=VALUES(balance), synced_at=NOW()`,
        [
          userId, orgId, str(v.vendor_credit_id, 100), str(v.vendor_credit_number, 100),
          str(v.reference_number, 100), str(v.status, 50),
          str(v.vendor_id, 100), str(v.vendor_name, 255), toMysqlDate(v.date),
          num(v.sub_total), num(v.tax_total), num(v.total), num(v.total_bcy), num(v.balance),
          num(v.credits_applied), num(v.refunded_amount),
          str(v.currency_id, 100), str(v.currency_code, 3), num(v.exchange_rate) || 1.0,
          toMysqlDt(v.created_time), toMysqlDt(v.last_modified_time),
        ]
      );
      n += 1;
    } catch (e) {
      console.warn('[ZB vendor_credit]', v.vendor_credit_id, e.message);
    }
  }
  return { calls, fetched: items.length, inserted: n, updated: 0, failed: items.length - n };
}

async function syncExpenses(userId, accessToken, orgId, runId) {
  const wm = await getWatermark(userId, orgId, 'expenses');
  // /expenses sorts by 'date', not 'last_modified_time' (Zoho restriction)
  const params = wm ? { last_modified_time: toZohoDt(wm), sort_column: 'date', sort_order: 'A' } : { sort_column: 'date', sort_order: 'A' };
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/expenses', listKey: 'expenses', params,
    userId, syncRunId: runId,
  });
  let n = 0, maxMod = null;
  for (const e of items) {
    try {
      await pool.execute(
        `INSERT INTO expense_entries
           (user_id, org_id, zoho_id, expense_type, date, status,
            account_id, account_name, paid_through_account_id, paid_through_account_name,
            zoho_vendor_id, vendor_name, zoho_customer_id, customer_name,
            amount, bcy_amount, total, total_without_tax, sub_total, tax_amount,
            tax_id, tax_name, tax_percentage, is_inclusive_tax,
            is_personal, is_billable, is_reimbursable, reimbursable_amount,
            invoice_id, invoice_number, invoice_status,
            project_id, project_name, has_attachment, documents_count,
            description, notes, currency_id, currency_code, exchange_rate,
            reference_number, recurring_expense_id, gst_no, gst_treatment,
            custom_fields_json, zoho_created_time, zoho_last_modified_time)
         VALUES (?,?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,
                 ?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?)
         ON DUPLICATE KEY UPDATE
           status = VALUES(status), amount = VALUES(amount), total = VALUES(total),
           zoho_last_modified_time = VALUES(zoho_last_modified_time), synced_at = NOW()`,
        [
          userId, orgId, str(e.expense_id, 100), str(e.expense_type, 50),
          toMysqlDate(e.date), str(e.status, 50),
          str(e.account_id, 100), str(e.account_name, 255),
          str(e.paid_through_account_id, 100), str(e.paid_through_account_name, 255),
          str(e.vendor_id, 100), str(e.vendor_name, 255),
          str(e.customer_id, 100), str(e.customer_name, 255),
          num(e.amount), num(e.bcy_amount), num(e.total),
          num(e.total_without_tax), num(e.sub_total), num(e.tax_amount),
          str(e.tax_id, 100), str(e.tax_name, 255), num(e.tax_percentage),
          bool(e.is_inclusive_tax),
          bool(e.is_personal), bool(e.is_billable), bool(e.is_reimbursable),
          num(e.reimbursable_amount),
          str(e.invoice_id, 100), str(e.invoice_number, 100), str(e.invoice_status, 50),
          str(e.project_id, 100), str(e.project_name, 255),
          bool(e.has_attachment), intOrNull(e.documents) ?? 0,
          str(e.description, 4000), str(e.notes, 4000),
          str(e.currency_id, 100), str(e.currency_code, 3),
          num(e.exchange_rate) || 1.0,
          str(e.reference_number, 100), str(e.recurring_expense_id, 100),
          str(e.gst_no, 20), str(e.gst_treatment, 50),
          safeJson(e.custom_fields),
          toMysqlDt(e.created_time), toMysqlDt(e.last_modified_time),
        ]
      );
      n += 1;
      if (e.last_modified_time && (!maxMod || e.last_modified_time > maxMod)) maxMod = e.last_modified_time;
    } catch (err) {
      console.warn('[ZB expense]', e.expense_id, err.message);
    }
  }
  if (maxMod) await setWatermark(userId, orgId, 'expenses', toMysqlDt(maxMod), n);
  return { calls, fetched: items.length, inserted: n, updated: 0, failed: items.length - n };
}

async function syncJournals(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/journals', listKey: 'journals',
    userId, syncRunId: runId,
  });
  let n = 0;
  for (const j of items) {
    try {
      await pool.execute(
        `INSERT INTO zb_journals
           (user_id, org_id, zoho_journal_id, journal_number, reference_number,
            journal_date, journal_type, status, notes,
            currency_id, currency_code, currency_symbol, exchange_rate,
            total, total_debit, total_credit, total_bcy,
            include_in_vat_return, is_inclusive_tax,
            product_type, documents_count,
            zoho_created_time, zoho_last_modified_time)
         VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?, ?,?, ?,?)
         ON DUPLICATE KEY UPDATE
           status = VALUES(status), total = VALUES(total),
           zoho_last_modified_time = VALUES(zoho_last_modified_time), synced_at = NOW()`,
        [
          userId, orgId, str(j.journal_id, 100), str(j.journal_number || j.entry_number, 100),
          str(j.reference_number, 100),
          toMysqlDate(j.journal_date), str(j.journal_type, 50), str(j.status, 50),
          str(j.notes, 4000),
          str(j.currency_id, 100), str(j.currency_code, 3), str(j.currency_symbol, 10),
          num(j.exchange_rate) || 1.0,
          num(j.total), num(j.total_debit), num(j.total_credit), num(j.total_bcy),
          bool(j.include_in_vat_return), bool(j.is_inclusive_tax),
          str(j.product_type, 50), intOrNull(j.documents) ?? 0,
          toMysqlDt(j.created_time), toMysqlDt(j.last_modified_time),
        ]
      );
      if (Array.isArray(j.line_items)) {
        for (let i = 0; i < j.line_items.length; i++) {
          const li = j.line_items[i];
          await pool.execute(
            `INSERT INTO zb_journal_line_items
               (user_id, org_id, zoho_line_item_id, zoho_journal_id, line_position,
                account_id, account_name, account_type, description,
                debit_or_credit, amount, amount_bcy,
                tax_id, tax_amount,
                customer_id, customer_name, vendor_id, vendor_name,
                project_id, contact_id)
             VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?, ?,?,?,?, ?,?)
             ON DUPLICATE KEY UPDATE amount=VALUES(amount), description=VALUES(description)`,
            [
              userId, orgId, str(li.line_id || li.account_id + ':' + i, 100),
              str(j.journal_id, 100), i,
              str(li.account_id, 100), str(li.account_name, 255), str(li.account_type, 50),
              str(li.description, 2000),
              str(li.debit_or_credit, 10), num(li.amount), num(li.bcy_amount),
              str(li.tax_id, 100), num(li.tax_amount),
              str(li.customer_id, 100), str(li.customer_name, 255),
              str(li.vendor_id, 100), str(li.vendor_name, 255),
              str(li.project_id, 100), str(li.contact_id, 100),
            ]
          );
        }
      }
      n += 1;
    } catch (e) {
      console.warn('[ZB journal]', j.journal_id, e.message);
    }
  }
  return { calls, fetched: items.length, inserted: n, updated: 0, failed: items.length - n };
}

async function syncBankAccounts(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/bankaccounts', listKey: 'bankaccounts',
    userId, syncRunId: runId,
  });
  for (const a of items) {
    await pool.execute(
      `INSERT INTO zb_bank_accounts
         (user_id, org_id, zoho_account_id, account_name, account_code, account_number,
          account_type, bank_name, routing_number, swift_code, bank_address, description,
          currency_id, currency_code, bcy_account_balance, account_balance,
          uncategorized_transactions, is_primary_account, is_paypal_account,
          is_active, is_feeds_active, paypal_email_address,
          last_feed_status, last_feed_date, feed_aggregator_name,
          zoho_created_time, zoho_last_modified_time)
       VALUES (?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?, ?,?,?, ?,?)
       ON DUPLICATE KEY UPDATE
         account_balance=VALUES(account_balance), is_active=VALUES(is_active), synced_at=NOW()`,
      [
        userId, orgId, str(a.account_id, 100), str(a.account_name, 255),
        str(a.account_code, 64), str(a.account_number, 64),
        str(a.account_type, 50), str(a.bank_name, 255),
        str(a.routing_number, 50), str(a.swift_code, 50),
        str(a.bank_address, 2000), str(a.description, 2000),
        str(a.currency_id, 100), str(a.currency_code, 3),
        num(a.bcy_account_balance), num(a.account_balance),
        intOrNull(a.uncategorized_transactions) ?? 0,
        bool(a.is_primary_account), bool(a.is_paypal_account),
        bool(a.is_active), bool(a.is_feeds_active), str(a.paypal_email_address, 255),
        str(a.last_feed_status, 50), toMysqlDt(a.last_feed_date),
        str(a.feed_aggregator_name, 100),
        toMysqlDt(a.created_time), toMysqlDt(a.last_modified_time),
      ]
    );
  }
  return { calls, fetched: items.length, inserted: items.length, updated: 0, failed: 0 };
}

// Bank transactions are no longer warehoused in `zb_bank_transactions` (that
// table was removed). The legacy `zohoService.syncBankTransactions` keeps the
// canonical `bank_transactions` table populated; reports/dashboard read from it.

// ═════════════════════════════════════════════════════════════════════════════
// Estimates, Sales Orders, Purchase Orders, Delivery Challans (compact)
// ═════════════════════════════════════════════════════════════════════════════

async function syncEstimates(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/estimates', listKey: 'estimates',
    userId, syncRunId: runId,
  });
  for (const e of items) {
    await pool.execute(
      `INSERT INTO zb_estimates
         (user_id, org_id, zoho_estimate_id, estimate_number, reference_number,
          status, zoho_customer_id, customer_name, email,
          date, expiry_date, accepted_date,
          sub_total, tax_total, total, total_bcy,
          currency_id, currency_code, exchange_rate, is_inclusive_tax,
          zoho_created_time, zoho_last_modified_time)
       VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?, ?,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status), total=VALUES(total), synced_at=NOW()`,
      [
        userId, orgId, str(e.estimate_id, 100), str(e.estimate_number, 100),
        str(e.reference_number, 100), str(e.status, 50),
        str(e.customer_id, 100), str(e.customer_name, 255), str(e.email, 255),
        toMysqlDate(e.date), toMysqlDate(e.expiry_date), toMysqlDate(e.accepted_date),
        num(e.sub_total), num(e.tax_total), num(e.total), num(e.total_bcy),
        str(e.currency_id, 100), str(e.currency_code, 3), num(e.exchange_rate) || 1.0,
        bool(e.is_inclusive_tax),
        toMysqlDt(e.created_time), toMysqlDt(e.last_modified_time),
      ]
    );
  }
  return { calls, fetched: items.length, inserted: items.length, updated: 0, failed: 0 };
}

async function syncSalesOrders(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/salesorders', listKey: 'salesorders',
    userId, syncRunId: runId,
  });
  for (const s of items) {
    await pool.execute(
      `INSERT INTO zb_sales_orders
         (user_id, org_id, zoho_salesorder_id, salesorder_number, reference_number,
          status, zoho_customer_id, customer_name, date,
          sub_total, tax_total, total, total_bcy,
          currency_id, currency_code, exchange_rate,
          zoho_created_time, zoho_last_modified_time)
       VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?, ?,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status), total=VALUES(total), synced_at=NOW()`,
      [
        userId, orgId, str(s.salesorder_id, 100), str(s.salesorder_number, 100),
        str(s.reference_number, 100), str(s.status, 50),
        str(s.customer_id, 100), str(s.customer_name, 255), toMysqlDate(s.date),
        num(s.sub_total), num(s.tax_total), num(s.total), num(s.total_bcy),
        str(s.currency_id, 100), str(s.currency_code, 3), num(s.exchange_rate) || 1.0,
        toMysqlDt(s.created_time), toMysqlDt(s.last_modified_time),
      ]
    );
  }
  return { calls, fetched: items.length, inserted: items.length, updated: 0, failed: 0 };
}

async function syncPurchaseOrders(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/purchaseorders', listKey: 'purchaseorders',
    userId, syncRunId: runId,
  });
  for (const p of items) {
    await pool.execute(
      `INSERT INTO zb_purchase_orders
         (user_id, org_id, zoho_purchaseorder_id, purchaseorder_number, reference_number,
          status, zoho_vendor_id, vendor_name, date,
          sub_total, tax_total, total, total_bcy,
          currency_id, currency_code, exchange_rate,
          zoho_created_time, zoho_last_modified_time)
       VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?, ?,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status), total=VALUES(total), synced_at=NOW()`,
      [
        userId, orgId, str(p.purchaseorder_id, 100), str(p.purchaseorder_number, 100),
        str(p.reference_number, 100), str(p.status, 50),
        str(p.vendor_id, 100), str(p.vendor_name, 255), toMysqlDate(p.date),
        num(p.sub_total), num(p.tax_total), num(p.total), num(p.total_bcy),
        str(p.currency_id, 100), str(p.currency_code, 3), num(p.exchange_rate) || 1.0,
        toMysqlDt(p.created_time), toMysqlDt(p.last_modified_time),
      ]
    );
  }
  return { calls, fetched: items.length, inserted: items.length, updated: 0, failed: 0 };
}

async function syncRecurringInvoices(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/recurringinvoices', listKey: 'recurring_invoices',
    userId, syncRunId: runId,
  });
  for (const r of items) {
    await pool.execute(
      `INSERT INTO zb_recurring_invoices
         (user_id, org_id, platform, recurring_id, recurrence_name, reference_number,
          status, customer_id, customer_name,
          recurrence_frequency, repeat_every, start_date, end_date,
          next_invoice_date, last_sent_date,
          total, sub_total, tax_total,
          currency_id, currency_code, exchange_rate, is_inclusive_tax,
          created_time, last_modified_time)
       VALUES (?,?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?, ?,?,?, ?,?,?,?, ?,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status), total=VALUES(total),
         recurrence_name=VALUES(recurrence_name), customer_name=VALUES(customer_name),
         next_invoice_date=VALUES(next_invoice_date), synced_at=NOW()`,
      [
        userId, orgId, 'zoho', str(r.recurring_invoice_id, 100), str(r.recurrence_name, 255),
        str(r.reference_number, 100), str(r.status, 50),
        str(r.customer_id, 100), str(r.customer_name, 255),
        str(r.recurrence_frequency, 50), intOrNull(r.repeat_every) ?? 1,
        toMysqlDate(r.start_date), toMysqlDate(r.end_date),
        toMysqlDate(r.next_invoice_date), toMysqlDate(r.last_sent_date),
        num(r.total), num(r.sub_total), num(r.tax_total),
        str(r.currency_id, 100), str(r.currency_code, 3),
        num(r.exchange_rate) || 1.0, bool(r.is_inclusive_tax),
        toMysqlDt(r.created_time), toMysqlDt(r.last_modified_time),
      ]
    );
  }
  return { calls, fetched: items.length, inserted: items.length, updated: 0, failed: 0 };
}

async function syncRecurringBills(userId, accessToken, orgId, runId) {
  const { items, calls } = await fetchAllPages({
    accessToken, orgId, endpoint: '/recurringbills', listKey: 'recurring_bills',
    userId, syncRunId: runId,
  });
  for (const r of items) {
    await pool.execute(
      `INSERT INTO zb_recurring_bills
         (user_id, org_id, zoho_recurring_bill_id, recurrence_name, reference_number,
          status, zoho_vendor_id, vendor_name,
          recurrence_frequency, repeat_every, start_date, end_date,
          next_bill_date, last_sent_date,
          total, sub_total, tax_total,
          currency_id, currency_code, exchange_rate, is_inclusive_tax,
          zoho_created_time, zoho_last_modified_time)
       VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?, ?,?,?, ?,?,?,?, ?,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status), total=VALUES(total), synced_at=NOW()`,
      [
        userId, orgId, str(r.recurring_bill_id, 100), str(r.recurrence_name, 255),
        str(r.reference_number, 100), str(r.status, 50),
        str(r.vendor_id, 100), str(r.vendor_name, 255),
        str(r.recurrence_frequency, 50), intOrNull(r.repeat_every) ?? 1,
        toMysqlDate(r.start_date), toMysqlDate(r.end_date),
        toMysqlDate(r.next_bill_date), toMysqlDate(r.last_sent_date),
        num(r.total), num(r.sub_total), num(r.tax_total),
        str(r.currency_id, 100), str(r.currency_code, 3),
        num(r.exchange_rate) || 1.0, bool(r.is_inclusive_tax),
        toMysqlDt(r.created_time), toMysqlDt(r.last_modified_time),
      ]
    );
  }
  return { calls, fetched: items.length, inserted: items.length, updated: 0, failed: 0 };
}

// ═════════════════════════════════════════════════════════════════════════════
// Orchestrator
// ═════════════════════════════════════════════════════════════════════════════

const MODULE_FUNCTIONS = {
  organization:        { fn: syncOrganization,       endpoint: '/organizations/:id' },
  currencies:          { fn: syncCurrencies,         endpoint: '/settings/currencies' },
  tax_authorities:     { fn: syncTaxAuthorities,     endpoint: '/settings/taxauthorities' },
  tax_exemptions:      { fn: syncTaxExemptions,      endpoint: '/settings/taxexemptions' },
  taxes:               { fn: syncTaxes,              endpoint: '/settings/taxes' },
  chart_of_accounts:   { fn: syncChartOfAccounts,    endpoint: '/chartofaccounts' },
  items:               { fn: syncItems,              endpoint: '/items' },
  contacts:            { fn: syncContacts,           endpoint: '/contacts' },
  projects:            { fn: syncProjects,           endpoint: '/projects' },
  time_entries:        { fn: syncTimeEntries,        endpoint: '/projects/timeentries' },
  estimates:           { fn: syncEstimates,          endpoint: '/estimates' },
  sales_orders:        { fn: syncSalesOrders,        endpoint: '/salesorders' },
  purchase_orders:     { fn: syncPurchaseOrders,     endpoint: '/purchaseorders' },
  invoices:            { fn: syncInvoices,           endpoint: '/invoices' },
  recurring_invoices:  { fn: syncRecurringInvoices,  endpoint: '/recurringinvoices' },
  recurring_bills:     { fn: syncRecurringBills,     endpoint: '/recurringbills' },
  bills:               { fn: syncBills,              endpoint: '/bills' },
  customer_payments:   { fn: syncCustomerPayments,   endpoint: '/customerpayments' },
  vendor_payments:     { fn: syncVendorPayments,     endpoint: '/vendorpayments' },
  credit_notes:        { fn: syncCreditNotes,        endpoint: '/creditnotes' },
  vendor_credits:      { fn: syncVendorCredits,      endpoint: '/vendorcredits' },
  expenses:            { fn: syncExpenses,           endpoint: '/expenses' },
  journals:            { fn: syncJournals,           endpoint: '/journals' },
  bank_accounts:       { fn: syncBankAccounts,       endpoint: '/bankaccounts' },
  // bank_transactions: handled by the legacy zohoService sync into `bank_transactions`
  // (the `zb_bank_transactions` warehouse table was removed; both held identical data).
};

const MODULE_ORDER = [
  'organization',
  'currencies', 'tax_authorities', 'tax_exemptions', 'taxes',
  'chart_of_accounts',
  'items',
  'contacts',
  'projects', 'time_entries',
  'estimates', 'sales_orders', 'purchase_orders',
  'recurring_invoices', 'recurring_bills',
  'invoices', 'bills',
  'customer_payments', 'vendor_payments',
  'credit_notes', 'vendor_credits',
  'expenses',
  'journals',
  'bank_accounts',
];

async function syncAll(userId, accessToken, orgId, opts = {}) {
  const runType = opts.runType || 'incremental';
  const modules = opts.modules || MODULE_ORDER;
  const triggerSource = opts.triggerSource || 'api';
  const run = await startRun(userId, orgId, runType, modules, triggerSource);
  console.log(`[ZB Warehouse] Run ${run.id} started — type=${runType} modules=${modules.length}`);

  const errors = [];
  let rateLimited = false;
  for (const mod of modules) {
    const def = MODULE_FUNCTIONS[mod];
    if (!def) { console.warn(`[ZB] unknown module: ${mod}`); continue; }
    const itemId = await startRunItem(run.id, mod, def.endpoint);
    try {
      const counts = await def.fn(userId, accessToken, orgId, run.id);
      await finishRunItem(itemId, 'succeeded', counts, null);
      await bumpRunCounts(run.id, { inserted: counts.inserted, updated: counts.updated, failed: counts.failed, calls: counts.calls });
      console.log(`[ZB Warehouse] ${mod}: fetched=${counts.fetched} inserted=${counts.inserted} failed=${counts.failed}`);
    } catch (e) {
      const msg = e.message || String(e);
      await finishRunItem(itemId, 'failed', {}, msg);
      errors.push(`${mod}: ${msg}`);
      console.error(`[ZB Warehouse] ${mod} FAILED:`, msg);
      // Quota/throttle hit — stop this org now so we don't burn more calls; the
      // watermark checkpoints let the next run resume from here.
      if (e instanceof RateLimitError || e?.isRateLimit) { rateLimited = true; break; }
    }
  }
  const finalStatus = rateLimited
    ? 'rate_limited'
    : (errors.length === 0 ? 'succeeded' : (errors.length === modules.length ? 'failed' : 'partial'));
  await finishRun(run.id, finalStatus, errors.length ? errors.join(' | ') : null);
  console.log(`[ZB Warehouse] Run ${run.id} ${finalStatus} (errors: ${errors.length})`);
  if (rateLimited) {
    const err = new RateLimitError(`Run ${run.id} stopped (org=${orgId}): ${errors[errors.length - 1]}`);
    err.runId = run.id;
    throw err;
  }
  return { runId: run.id, status: finalStatus, errors };
}

async function syncSingle(userId, accessToken, orgId, module) {
  return syncAll(userId, accessToken, orgId, { modules: [module], runType: 'entity' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-org orchestrator — the single entry point for "sync everything this
// connection can see". A Zoho account may expose several organizations
// (e.g. CAPTUM + Xoot); every zb_* table is keyed (user_id, org_id, record_id)
// so the orgs never overlap. Used by OAuth, the manual sync routes, and cron so
// there is one consistent multi-org path.
//
// Resolves one valid token for the user, then syncs each connected org
// sequentially. If an org hits Zoho's daily quota it stops the whole run early
// (remaining orgs share the same account/token, so the quota is gone) — the
// watermark checkpoints make the next run resume from where it left off.
async function syncAllOrgsForUser(userId, opts = {}) {
  const { getValidToken } = require('./zohoService'); // lazy — avoid circular require
  const accessToken = await getValidToken(userId);
  if (!accessToken) {
    console.warn(`[ZB Warehouse] syncAllOrgsForUser(${userId}): no valid Zoho token`);
    return { orgs: 0, completed: [], stopped: 'no_token' };
  }
  const [orgs] = await pool.execute(
    'SELECT org_id FROM zb_oauth_organizations WHERE user_id = ? ORDER BY org_id ASC',
    [userId]
  );
  if (!orgs.length) {
    return { orgs: 0, completed: [], stopped: 'no_orgs' };
  }

  const completed = [];
  for (const { org_id: orgId } of orgs) {
    try {
      const result = await syncAll(userId, accessToken, orgId, opts);
      completed.push({ orgId, status: result.status, runId: result.runId });
    } catch (e) {
      if (e instanceof RateLimitError || e?.isRateLimit) {
        const remaining = orgs
          .map((o) => o.org_id)
          .filter((id) => id !== orgId && !completed.find((c) => c.orgId === id));
        console.warn(`[ZB Warehouse] rate limit on org=${orgId}; stopping. remaining=${remaining.join(',') || 'none'} — resumes next run`);
        completed.push({ orgId, status: 'rate_limited', runId: e.runId });
        return { orgs: orgs.length, completed, stopped: 'rate_limit', remaining };
      }
      console.error(`[ZB Warehouse] org=${orgId} sync error:`, e.message);
      completed.push({ orgId, status: 'failed', error: e.message });
    }
  }
  return { orgs: orgs.length, completed, stopped: null };
}

module.exports = {
  syncAllZohoBooksWarehouse: syncAll,
  syncSingleModule: syncSingle,
  syncAllOrgsForUser,
  MODULE_ORDER,
  MODULE_FUNCTIONS,
  startRun, finishRun,
  getWatermark, setWatermark,
};
