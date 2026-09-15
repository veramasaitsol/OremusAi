'use strict';
// Zoho Books API sync service
// Fetches customers, vendors, invoices, bills, expenses, daybook
// and upserts them into MySQL.

const axios = require('axios');
const pool  = require('../config/db');
const { reauthError } = require('../utils/reauthError');
const { tableExists } = require('../utils/tableExists');

const API_BASE = process.env.ZOHO_API_BASE || 'https://www.zohoapis.in/books/v3';

function zohoHeaders(accessToken) {
  return { Authorization: `Zoho-oauthtoken ${accessToken}` };
}

// ── Fetch all pages of a Zoho list endpoint ────────────────────────────────────
async function fetchAllPages(url, params, accessToken) {
  const results = [];
  let page = 1;
  while (true) {
    const res  = await axios.get(url, {
      headers: zohoHeaders(accessToken),
      params:  { ...params, page, per_page: 200 },
    });
    const data = res.data;
    if (data.code !== 0) break;

    const key   = Object.keys(data).find((k) => Array.isArray(data[k]) && k !== 'books');
    const items = key ? data[key] : [];
    results.push(...items);

    if (!data.page_context?.has_more_page) break;
    page++;
  }
  return results;
}

// ── Sync customers ─────────────────────────────────────────────────────────────
async function syncCustomers(userId, accessToken, orgId) {
  const contacts = await fetchAllPages(
    `${API_BASE}/contacts`,
    { organization_id: orgId, contact_type: 'customer', filter_by: 'Status.Active' },
    accessToken
  );
  if (contacts.length === 0) return 0;

  const conn = await pool.getConnection();
  try {
    for (const c of contacts) {
      await conn.execute(
        `INSERT INTO customers
           (user_id, org_id, zoho_id, contact_name, company_name,
            email, phone, outstanding_receivable_amount, status, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           contact_name                  = VALUES(contact_name),
           company_name                  = VALUES(company_name),
           email                         = VALUES(email),
           phone                         = VALUES(phone),
           outstanding_receivable_amount = VALUES(outstanding_receivable_amount),
           status                        = VALUES(status),
           synced_at                     = NOW()`,
        [
          userId, orgId, c.contact_id, c.contact_name,
          c.company_name || null, c.email || null, c.phone || null,
          parseFloat(c.outstanding_receivable_amount ?? 0),
          c.status || 'active',
        ]
      );
    }
  } finally {
    conn.release();
  }
  return contacts.length;
}

// Flatten a Zoho address object into the single line the contact reports print.
function zohoAddress(a) {
  if (!a || typeof a !== 'object') return null;
  const parts = [a.attention, a.address, a.street2, a.city, a.state, a.zip, a.country]
    .map((p) => String(p ?? '').trim()).filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

// ── Sync vendors ───────────────────────────────────────────────────────────────
async function syncVendors(userId, accessToken, orgId) {
  const contacts = await fetchAllPages(
    `${API_BASE}/contacts`,
    { organization_id: orgId, contact_type: 'vendor', filter_by: 'Status.Active' },
    accessToken
  );
  if (contacts.length === 0) return 0;

  const conn = await pool.getConnection();
  try {
    for (const c of contacts) {
      await conn.execute(
        `INSERT INTO vendors
           (user_id, org_id, zoho_id, contact_name, company_name,
            email, phone, outstanding_payable_amount, status,
            billing_address, full_name, gst_no, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           contact_name               = VALUES(contact_name),
           company_name               = VALUES(company_name),
           email                      = VALUES(email),
           phone                      = VALUES(phone),
           outstanding_payable_amount = VALUES(outstanding_payable_amount),
           status                     = VALUES(status),
           billing_address            = VALUES(billing_address),
           full_name                  = VALUES(full_name),
           gst_no                     = VALUES(gst_no),
           synced_at                  = NOW()`,
        [
          userId, orgId, c.contact_id, c.contact_name,
          c.company_name || null, c.email || null, c.phone || null,
          parseFloat(c.outstanding_payable_amount ?? 0),
          c.status || 'active',
          zohoAddress(c.billing_address),
          [c.first_name, c.last_name].map((p) => String(p ?? '').trim()).filter(Boolean).join(' ') || null,
          c.gst_no || null,
        ]
      );
    }
  } finally {
    conn.release();
  }
  return contacts.length;
}

// ── Sync invoices ──────────────────────────────────────────────────────────────
async function syncInvoices(userId, accessToken, orgId) {
  const invoices = await fetchAllPages(
    `${API_BASE}/invoices`,
    { organization_id: orgId, sort_column: 'date', sort_order: 'D' },
    accessToken
  );
  if (invoices.length === 0) return 0;

  const conn = await pool.getConnection();
  try {
    for (const inv of invoices) {
      await conn.execute(
        `INSERT INTO invoices
           (user_id, org_id, zoho_id, invoice_number, customer_name,
            date, due_date, total, balance, status, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           invoice_number = VALUES(invoice_number),
           customer_name  = VALUES(customer_name),
           date           = VALUES(date),
           due_date       = VALUES(due_date),
           total          = VALUES(total),
           balance        = VALUES(balance),
           status         = VALUES(status),
           synced_at      = NOW()`,
        [
          userId, orgId, inv.invoice_id,
          inv.invoice_number || null, inv.customer_name || null,
          inv.date || null, inv.due_date || null,
          parseFloat(inv.total ?? 0), parseFloat(inv.balance ?? 0),
          inv.status || null,
        ]
      );
    }
  } finally {
    conn.release();
  }
  return invoices.length;
}

// ── Sync bills ─────────────────────────────────────────────────────────────────
async function syncBills(userId, accessToken, orgId) {
  const bills = await fetchAllPages(
    `${API_BASE}/bills`,
    { organization_id: orgId, sort_column: 'date', sort_order: 'D' },
    accessToken
  );
  if (bills.length === 0) return 0;

  const conn = await pool.getConnection();
  try {
    for (const b of bills) {
      await conn.execute(
        `INSERT INTO bills
           (user_id, org_id, zoho_id, bill_number, vendor_name,
            date, due_date, total, balance, status, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           bill_number = VALUES(bill_number),
           vendor_name = VALUES(vendor_name),
           date        = VALUES(date),
           due_date    = VALUES(due_date),
           total       = VALUES(total),
           balance     = VALUES(balance),
           status      = VALUES(status),
           synced_at   = NOW()`,
        [
          userId, orgId, b.bill_id,
          b.bill_number || null, b.vendor_name || null,
          b.date || null, b.due_date || null,
          parseFloat(b.total ?? 0), parseFloat(b.balance ?? 0),
          b.status || null,
        ]
      );
    }
  } finally {
    conn.release();
  }
  return bills.length;
}

// ── Sync expenses ──────────────────────────────────────────────────────────────
async function syncExpenses(userId, accessToken, orgId) {
  const expenses = await fetchAllPages(
    `${API_BASE}/expenses`,
    { organization_id: orgId, sort_column: 'date', sort_order: 'D' },
    accessToken
  );
  if (expenses.length === 0) return 0;

  const conn = await pool.getConnection();
  try {
    for (const e of expenses) {
      await conn.execute(
        `INSERT INTO expense_entries
           (user_id, org_id, zoho_id, account_name, expense_date,
            amount, vendor_name, description, status, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           account_name  = VALUES(account_name),
           expense_date  = VALUES(expense_date),
           amount        = VALUES(amount),
           vendor_name   = VALUES(vendor_name),
           description   = VALUES(description),
           status        = VALUES(status),
           synced_at     = NOW()`,
        [
          userId, orgId, e.expense_id,
          e.account_name || null, e.date || null,
          parseFloat(e.total ?? e.amount ?? 0),
          e.vendor_name || null, e.description || null,
          e.status || null,
        ]
      );
    }
  } finally {
    conn.release();
  }
  return expenses.length;
}

// ── Sync Day Book ──────────────────────────────────────────────────────────────
async function syncDayBook(userId, accessToken, orgId) {
  const url  = `${API_BASE}/reports/daybook`;
  const rows = [];
  let page   = 1;

  while (true) {
    const res  = await axios.get(url, {
      headers: zohoHeaders(accessToken),
      params: { organization_id: orgId, page, usestate: true, response_option: 0 },
    });
    const data = res.data;
    if (data.code !== 0) {
      console.warn(`[DayBook] Zoho error ${data.code}: ${data.message}`);
      break;
    }
    rows.push(...(data.daybook ?? []));
    if (!data.page_context?.has_more_page) break;
    page++;
  }

  if (rows.length === 0) return 0;

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
           transaction_date = VALUES(transaction_date),
           transaction_type = VALUES(transaction_type),
           reference_number = VALUES(reference_number),
           description      = VALUES(description),
           debit            = VALUES(debit),
           credit           = VALUES(credit),
           account_name     = VALUES(account_name),
           entity_name      = VALUES(entity_name),
           synced_at        = NOW()`,
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
  console.log(`[DayBook] Synced ${rows.length} rows for orgId=${orgId}`);
  return rows.length;
}

// ── Parse Zoho net_amount string → { balance, balance_type }
// Examples: "118.00 Dr"  → { balance: 118,       balance_type: 'D' }
//           "4,66,984.00 Cr" → { balance: 466984, balance_type: 'C' }
function parseNetAmount(str) {
  if (!str) return { balance: 0, balance_type: null };
  const s    = String(str).trim();
  const type = s.endsWith('Cr') ? 'C' : s.endsWith('Dr') ? 'D' : null;
  // Strip everything except digits and decimal point
  const num  = parseFloat(s.replace(/[^0-9.]/g, '')) || 0;
  return { balance: num, balance_type: type };
}

// ── Sync Account Transactions (Zoho "Account Transactions" report) ─────────────
// Endpoint: GET /reports/accounttransaction  (singular — Zoho's actual URL)
//
// Response structure (doubly-nested, group_by=none collapses to one outer group):
//   data.account_transactions[0].account_transactions  → actual rows
//
// One transaction_id can appear on multiple rows (one per account touched),
// so the DB unique key is (user_id, transaction_id, account_id).
//
// fromDate / toDate: 'YYYY-MM-DD'. Defaults to full history (2000-01-01 → today).
async function syncAccountTransactions(userId, accessToken, orgId, fromDate, toDate) {
  const today    = new Date().toISOString().slice(0, 10);
  // Default: last 5 years — wide enough to be useful, avoids timeout on huge datasets.
  // Callers can pass explicit fromDate/toDate to override.
  const fiveYearsAgo = new Date(new Date().setFullYear(new Date().getFullYear() - 5))
    .toISOString().slice(0, 10);
  const from     = fromDate || fiveYearsAgo;
  const to       = toDate   || today;

  const baseParams = {
    organization_id: orgId,
    from_date:       from,
    to_date:         to,
    sort_column:     'date',
    sort_order:      'A',
    per_page:        200,
  };

  const allRows = [];
  let page      = 1;

  while (true) {
    const res  = await axios.get(`${API_BASE}/reports/accounttransaction`, {
      headers: zohoHeaders(accessToken),
      params:  { ...baseParams, page },
    });
    const data = res.data;

    if (data.code !== 0) {
      console.warn(`[AccountTxn] Zoho error ${data.code}: ${data.message}`);
      break;
    }

    // The response is doubly-nested when group_by=none:
    //   data.account_transactions[0].account_transactions  = actual rows
    const outerGroups = data.account_transactions ?? [];
    for (const group of outerGroups) {
      const rows = group.account_transactions ?? [];
      allRows.push(...rows);
    }

    if (!data.page_context?.has_more_page) break;
    page++;
  }

  if (allRows.length === 0) {
    console.log(`[AccountTxn] No rows returned for userId=${userId} orgId=${orgId}`);
    return 0;
  }

  // Archive the verbatim Zoho JSON alongside the normalized ledger row, in the
  // same code path / same source API (/reports/accounttransaction). Degrades
  // cleanly on deployments that haven't applied db/raw-transactions.sql.
  const storeRaw = await tableExists('zoho_raw_transactions');

  const conn = await pool.getConnection();
  try {
    for (const t of allRows) {
      const txnId     = t.transaction_id || `${t.date ?? ''}-${t.transaction_type ?? ''}-${t.entity_number ?? ''}-${t.account_id ?? ''}`;
      const accountId = t.account_id     || (t.account_name ? t.account_name.replace(/\s+/g, '_').slice(0, 100) : 'unknown');
      const { balance, balance_type } = parseNetAmount(t.net_amount);

      // account_group / account_type_code come from the nested 'account' object
      const acctGroup    = t.account?.account_group || null;   // 'income','expense','asset','liability','equity'
      const acctTypeCode = t.account?.account_type  || null;   // 'income','expense','accounts_receivable',…

      await conn.execute(
        `INSERT INTO account_transactions
           (user_id, org_id, platform, transaction_id, account_id, transaction_date,
            account_name, account_group, account_type_code,
            transaction_details, transaction_type, transaction_number,
            reference_number, debit, credit, balance, balance_type,
            source_type, source_id, line_number, tax_type, tax_amount, currency_code, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           transaction_date    = VALUES(transaction_date),
           account_name        = VALUES(account_name),
           account_group       = VALUES(account_group),
           account_type_code   = VALUES(account_type_code),
           transaction_details = VALUES(transaction_details),
           transaction_type    = VALUES(transaction_type),
           transaction_number  = VALUES(transaction_number),
           reference_number    = VALUES(reference_number),
           debit               = VALUES(debit),
           credit              = VALUES(credit),
           balance             = VALUES(balance),
           balance_type        = VALUES(balance_type),
           source_type         = VALUES(source_type),
           source_id           = VALUES(source_id),
           line_number         = VALUES(line_number),
           tax_type            = VALUES(tax_type),
           tax_amount          = VALUES(tax_amount),
           currency_code       = VALUES(currency_code),
           synced_at           = NOW()`,
        [
          userId, orgId, 'zoho',
          txnId,  accountId,
          t.date                || null,
          t.account_name        || null,
          acctGroup,
          acctTypeCode,
          t.transaction_details || null,
          t.transaction_type    || null,
          t.entity_number       || '',
          // ^ part of the unique key — '' (not NULL) so dedup stays idempotent
          t.reference_number    || null,
          parseFloat(t.debit  || 0),
          parseFloat(t.credit || 0),
          balance,
          balance_type,
          t.transaction_type    || null,
          t.transaction_id      || null,
          0,
          null,
          0,
          t.currency_code       || null,
        ]
      );

      if (storeRaw) {
        await conn.execute(
          `INSERT INTO zoho_raw_transactions
             (user_id, org_id, source_endpoint, transaction_id, transaction_number, account_id, raw_json, synced_at)
           VALUES (?,?,?,?,?,?,?,NOW())
           ON DUPLICATE KEY UPDATE
             raw_json  = VALUES(raw_json),
             synced_at = NOW()`,
          [
            userId, orgId, 'reports/accounttransaction',
            txnId, t.entity_number || '', accountId,
            JSON.stringify(t),
          ]
        );
      }
    }
  } finally {
    conn.release();
  }

  console.log(`[AccountTxn] Synced ${allRows.length} rows for userId=${userId} orgId=${orgId} (${from} → ${to})`);
  return allRows.length;
}

// ── Sync Bank Transactions ─────────────────────────────────────────────────────
// Endpoint: GET /banktransactions
// Response key: banktransactions  (flat paginated list, standard page_context)
async function syncBankTransactions(userId, accessToken, orgId, fromDate, toDate) {
  const url        = `${API_BASE}/banktransactions`;
  const baseParams = {
    organization_id: orgId,
    sort_column:     'date',
    sort_order:      'D',
    per_page:        200,
    filter_by:       'Status.All',
  };
  if (fromDate) baseParams.date_start = fromDate;
  if (toDate)   baseParams.date_end   = toDate;

  const allRows = [];
  let page      = 1;

  while (true) {
    const res  = await axios.get(url, {
      headers: zohoHeaders(accessToken),
      params:  { ...baseParams, page },
    });
    const data = res.data;

    if (data.code !== 0) {
      console.warn(`[BankTxn] Zoho error ${data.code}: ${data.message}`);
      break;
    }

    const batch = data.banktransactions ?? [];
    allRows.push(...batch);
    if (!data.page_context?.has_more_page) break;
    page++;
  }

  if (allRows.length === 0) {
    console.log(`[BankTxn] No rows returned for userId=${userId} orgId=${orgId}`);
    return 0;
  }

  const conn = await pool.getConnection();
  try {
    for (const t of allRows) {
      // running_balance can be an empty string when not provided
      const runningBalance = t.running_balance !== '' && t.running_balance != null
        ? parseFloat(t.running_balance)
        : 0;

      await conn.execute(
        `INSERT INTO bank_transactions
           (user_id, org_id, transaction_id, transaction_date, amount,
            transaction_type, transaction_type_formatted, status, source,
            account_id, account_name, account_type,
            customer_id, payee, description, currency_code,
            debit_or_credit, offset_account_name, reference_number,
            reconcile_status, imported_transaction_id, running_balance, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           transaction_date           = VALUES(transaction_date),
           amount                     = VALUES(amount),
           transaction_type           = VALUES(transaction_type),
           transaction_type_formatted = VALUES(transaction_type_formatted),
           status                     = VALUES(status),
           source                     = VALUES(source),
           account_id                 = VALUES(account_id),
           account_name               = VALUES(account_name),
           account_type               = VALUES(account_type),
           customer_id                = VALUES(customer_id),
           payee                      = VALUES(payee),
           description                = VALUES(description),
           currency_code              = VALUES(currency_code),
           debit_or_credit            = VALUES(debit_or_credit),
           offset_account_name        = VALUES(offset_account_name),
           reference_number           = VALUES(reference_number),
           reconcile_status           = VALUES(reconcile_status),
           imported_transaction_id    = VALUES(imported_transaction_id),
           running_balance            = VALUES(running_balance),
           synced_at                  = NOW()`,
        [
          userId,
          orgId,
          t.transaction_id,
          t.date                       || null,
          parseFloat(t.amount          || 0),
          t.transaction_type           || null,
          t.transaction_type_formatted || null,
          t.status                     || null,
          t.source                     || null,
          t.account_id                 || null,
          t.account_name               || null,
          t.account_type               || null,
          t.customer_id                || null,
          t.payee                      || null,
          t.description                || null,
          t.currency_code              || null,
          t.debit_or_credit            || null,
          t.offset_account_name        || null,
          t.reference_number           || null,
          t.reconcile_status           || null,
          t.imported_transaction_id    || null,
          runningBalance,
        ]
      );
    }
  } finally {
    conn.release();
  }

  console.log(`[BankTxn] Synced ${allRows.length} rows for userId=${userId} orgId=${orgId}`);
  return allRows.length;
}

// ── Master sync ────────────────────────────────────────────────────────────────
async function syncAllZohoData(userId, accessToken, orgId) {
  console.log(`[Zoho Sync] Starting userId=${userId} orgId=${orgId}`);
  const results = await Promise.allSettled([
    syncCustomers(userId, accessToken, orgId),
    syncVendors(userId, accessToken, orgId),
    syncInvoices(userId, accessToken, orgId),
    syncBills(userId, accessToken, orgId),
    syncExpenses(userId, accessToken, orgId),
    syncDayBook(userId, accessToken, orgId),
    syncAccountTransactions(userId, accessToken, orgId),
    syncBankTransactions(userId, accessToken, orgId),
  ]);
  const [cust, vend, inv, bil, exp, day, acct, bank] = results.map((r) =>
    r.status === 'fulfilled' ? r.value : `ERR: ${r.reason?.message}`
  );
  console.log(`[Zoho Sync] Done — customers:${cust} vendors:${vend} invoices:${inv} bills:${bil} expenses:${exp} daybook:${day} acct_txn:${acct} bank_txn:${bank}`);
}

// ── Get or auto-refresh access token ──────────────────────────────────────────
async function getValidToken(userId) {
  const [rows] = await pool.execute(
    'SELECT access_token, refresh_token, expires_at FROM zb_tokens WHERE user_id = ?',
    [userId]
  );
  if (!rows[0]) return null;

  const tok = rows[0];
  if (!tok.expires_at || Date.now() < Number(tok.expires_at) - 60_000) {
    return tok.access_token;
  }
  if (!tok.refresh_token) return null;

  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: tok.refresh_token,
  });
  let res;
  try {
    res = await axios.post(
      `${process.env.ZOHO_ACCOUNTS_URL}/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
  } catch (e) {
    // Zoho's token endpoint rejected the refresh (e.g. revoked token, or the
    // refresh_token belongs to a different OAuth app than ZOHO_CLIENT_ID).
    throw reauthError('zoho', e.response?.data?.error || e.response?.data?.message || e.message);
  }
  const { access_token, expires_in } = res.data;
  if (!access_token) {
    // Zoho returns HTTP 200 with { error: 'invalid_code' | 'invalid_client' | … }
    // when the refresh_token can't be honored by the configured client.
    throw reauthError('zoho', res.data?.error || 'no access_token returned');
  }

  const expires_at = Date.now() + (expires_in ?? 3600) * 1000;
  await pool.execute(
    'UPDATE zb_tokens SET access_token = ?, expires_at = ? WHERE user_id = ?',
    [access_token, expires_at, userId]
  );
  return access_token;
}

// ── Effective Zoho user resolver ──────────────────────────────────────────
// Returns the user_id whose zb_tokens / zb_* rows should be used for the
// given requester. Same model as QB/Xero: client users tagged for Zoho
// inherit the admin's "company-owned" Zoho connection.
async function getEffectiveZohoUserId(userId) {
  const [own] = await pool.execute(
    'SELECT 1 FROM zb_tokens WHERE user_id = ? LIMIT 1',
    [userId]
  );
  if (own.length) return userId;

  const [u] = await pool.execute(
    'SELECT role, integration_type FROM users WHERE id = ? LIMIT 1',
    [userId]
  );
  if (!u[0]) return userId;
  if (u[0].role === 'client' && u[0].integration_type === 'zoho') {
    const [admin] = await pool.execute(
      `SELECT u.id
         FROM users u
         JOIN zb_tokens t ON t.user_id = u.id
        WHERE u.role = 'admin'
        ORDER BY u.id ASC
        LIMIT 1`
    );
    if (admin[0]) return admin[0].id;
  }
  return userId;
}

module.exports = { syncAllZohoData, syncAccountTransactions, syncBankTransactions, getValidToken, getEffectiveZohoUserId };
