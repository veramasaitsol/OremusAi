'use strict';
// Xero API sync service
// OAuth 2.0 + data sync (Accounts, Contacts, Invoices, Bills, Bank-Spend, Manual Journals).
//
// References:
//   https://developer.xero.com/documentation/guides/oauth2/overview/
//   https://developer.xero.com/documentation/api/accounting/overview

const axios = require('axios');
const crypto = require('crypto');
const pool  = require('../config/db');
const { reauthError } = require('../utils/reauthError');
const { tableExists } = require('../utils/tableExists');

const XERO_AUTH_URL    = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL   = 'https://identity.xero.com/connect/token';
const XERO_REVOKE_URL  = 'https://identity.xero.com/connect/revocation';
const XERO_API_BASE    = 'https://api.xero.com/api.xro/2.0';
const XERO_CONNECTIONS = 'https://api.xero.com/connections';

function xeroHeaders(accessToken, tenantId) {
  return {
    Authorization:      `Bearer ${accessToken}`,
    'Xero-tenant-id':   tenantId,
    Accept:             'application/json',
  };
}

// ── OAuth: exchange auth code for tokens ─────────────────────────────────────
async function exchangeCodeForTokens(code, redirectUri) {
  const basic = Buffer
    .from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`)
    .toString('base64');
  const params = new URLSearchParams({
    grant_type:   'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const res = await axios.post(XERO_TOKEN_URL, params.toString(), {
    headers: {
      Authorization:  `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept:         'application/json',
    },
  });
  return res.data; // { access_token, refresh_token, expires_in, token_type, scope, id_token }
}

// ── Revoke a token (called on disconnect) ────────────────────────────────────
async function revokeToken(token) {
  if (!token) return;
  const basic = Buffer
    .from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`)
    .toString('base64');
  try {
    await axios.post(XERO_REVOKE_URL,
      new URLSearchParams({ token }).toString(),
      {
        headers: {
          Authorization:  `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept:         'application/json',
        },
      }
    );
  } catch { /* best-effort */ }
}

// ── Fetch the list of tenants the user authorised ────────────────────────────
async function fetchTenants(accessToken) {
  const res = await axios.get(XERO_CONNECTIONS, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  return res.data || [];
}

// ── Fetch organisation metadata ──────────────────────────────────────────────
async function fetchOrganisation(accessToken, tenantId) {
  try {
    const res = await axios.get(`${XERO_API_BASE}/Organisation`, {
      headers: xeroHeaders(accessToken, tenantId),
    });
    return res.data?.Organisations?.[0] || null;
  } catch (e) {
    console.warn('[Xero] organisation fetch failed:', e.response?.data || e.message);
    return null;
  }
}

// ── Refresh access token (Xero rotates refresh tokens — store the new one). ─
async function refreshXeroToken(userId, currentRefreshToken) {
  const basic = Buffer
    .from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`)
    .toString('base64');
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: currentRefreshToken,
  });
  let res;
  try {
    res = await axios.post(XERO_TOKEN_URL, params.toString(), {
      headers: {
        Authorization:  `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept:         'application/json',
      },
    });
  } catch (e) {
    // Xero rejected the refresh (revoked, expired >60d, or the token belongs to
    // a different OAuth app than XERO_CLIENT_ID).
    throw reauthError('xero', e.response?.data?.error || e.response?.data?.error_description || e.message);
  }
  const { access_token, refresh_token, expires_in } = res.data;
  if (!access_token) throw reauthError('xero', res.data?.error || 'no access_token returned');

  const expires_at = Date.now() + (expires_in ?? 1800) * 1000;
  await pool.execute(
    `UPDATE xero_tokens
       SET access_token  = ?,
           refresh_token = COALESCE(?, refresh_token),
           expires_at    = ?,
           updated_at    = NOW()
     WHERE user_id = ?`,
    [access_token, refresh_token ?? null, expires_at, userId]
  );
  return { access_token, refresh_token: refresh_token ?? currentRefreshToken, expires_at };
}

// ── Get a valid access token, refreshing if necessary ───────────────────────
// One OAuth grant covers every tenant the Xero user authorised, so the token is
// shared. `tenantId` (optional) overrides which tenant the caller wants to act
// on — validated against xero_organizations so a caller can't target a tenant
// the user never connected. Without it, the active tenant (xero_tokens.tenant_id)
// is used.
async function getValidXeroToken(userId, tenantId = null) {
  const [rows] = await pool.execute(
    'SELECT access_token, refresh_token, expires_at, tenant_id FROM xero_tokens WHERE user_id = ?',
    [userId]
  );
  if (!rows[0]) return null;
  const tok = rows[0];

  let activeTenant = tok.tenant_id;
  if (tenantId && String(tenantId) !== String(tok.tenant_id)) {
    try {
      const [[owned]] = await pool.execute(
        'SELECT tenant_id FROM xero_organizations WHERE user_id = ? AND tenant_id = ? LIMIT 1',
        [userId, String(tenantId)]
      );
      if (owned) activeTenant = owned.tenant_id;
    } catch (_) { /* xero_organizations optional — fall back to the stored tenant */ }
  }

  if (!tok.expires_at || Date.now() < Number(tok.expires_at) - 60_000) {
    return { accessToken: tok.access_token, tenantId: activeTenant };
  }
  if (!tok.refresh_token) return null;
  const fresh = await refreshXeroToken(userId, tok.refresh_token);
  return { accessToken: fresh.access_token, tenantId: activeTenant };
}

// ── Effective Xero user resolver (mirrors getEffectiveQBUserId) ─────────────
// • Returns the user's own user_id if they have a xero_tokens row.
// • Else if user is a client with integration_type='xero', returns the first
//   admin who has a xero_tokens row (so the client inherits admin's connection).
// • Else returns the user_id unchanged.
async function getEffectiveXeroUserId(userId) {
  const [own] = await pool.execute(
    'SELECT 1 FROM xero_tokens WHERE user_id = ? LIMIT 1',
    [userId]
  );
  if (own.length) return userId;

  const [u] = await pool.execute(
    'SELECT role, integration_type FROM users WHERE id = ? LIMIT 1',
    [userId]
  );
  if (!u[0]) return userId;
  if (u[0].role === 'client' && u[0].integration_type === 'xero') {
    const [admin] = await pool.execute(
      `SELECT u.id
         FROM users u
         JOIN xero_tokens t ON t.user_id = u.id
        WHERE u.role = 'admin'
        ORDER BY u.id ASC
        LIMIT 1`
    );
    if (admin[0]) return admin[0].id;
  }
  return userId;
}

// ═════════════════════════════════════════════════════════════════════════════
//                              SYNC FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════

// Xero datetime → MySQL DATETIME
function toMysqlDt(input) {
  if (!input) return null;
  // Xero returns either ISO ("2024-01-15T10:30:00Z") or .NET ("/Date(1705314600000+0000)/")
  let d;
  if (typeof input === 'string' && input.startsWith('/Date(')) {
    const ms = parseInt(input.replace(/\/Date\((-?\d+).*\)\//, '$1'));
    d = new Date(ms);
  } else {
    d = new Date(input);
  }
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Xero date → MySQL DATE
function toMysqlDate(input) {
  const dt = toMysqlDt(input);
  return dt ? dt.slice(0, 10) : null;
}

// ── Chunked bulk INSERT helper ───────────────────────────────────────────────
// Collapses a per-row INSERT loop into one multi-row statement per chunk, which
// removes the network round-trip that dominated sync time (one round-trip per
// row → one per ~500 rows). `rows` is an array of value-tuples; the SQL must use
// the `VALUES ?` placeholder. mysql2 only expands that nested-array form on
// conn.query() (NOT the prepared-statement conn.execute()), so we use query()
// here. ON DUPLICATE KEY UPDATE is preserved by the caller's SQL, so the insert
// stays exactly as idempotent as the old row-by-row version. Chunked to stay
// under max_allowed_packet on large syncs.
async function bulkInsert(conn, sql, rows, chunkSize = 500) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += chunkSize) {
    await conn.query(sql, [rows.slice(i, i + chunkSize)]);
  }
}

// ── Paginated Xero list fetch ────────────────────────────────────────────────
// Xero caps every list endpoint (Invoices, Bills, Contacts, BankTransactions,
// ManualJournals) at 100 records/page and requires the `page` query param to
// walk them. A single un-paginated GET silently truncates at the first 100
// records — which is why an org with >100 invoices only ever synced 100. This
// walks page 1,2,3… until a short page (<100) signals the end and returns every
// record. `key` is the response array property (e.g. 'Invoices'). The /Accounts
// endpoint is NOT paginated (returns all at once) so it keeps its plain GET.
const XERO_PAGE_SIZE = 100;
async function xeroGetAllPages(url, headers, params, key) {
  const all = [];
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await axios.get(url, { headers, params: { ...params, page } });
    const batch = res.data?.[key] || [];
    all.push(...batch);
    if (batch.length < XERO_PAGE_SIZE) break;
    page += 1;
  }
  return all;
}

// Sum the balance per account from the TrialBalance report and write it back
// to xero_accounts.balance. Best-effort — failures don't block other syncs.
async function fetchAndStoreBalances(userId, accessToken, tenantId) {
  try {
    const res = await axios.get(`${XERO_API_BASE}/Reports/TrialBalance`, {
      headers: xeroHeaders(accessToken, tenantId),
    });
    const report = res.data?.Reports?.[0];
    const rows = report?.Rows || [];

    const balanceByAccountId = {};
    const visit = (rs) => {
      for (const r of rs || []) {
        if (r.Rows) visit(r.Rows);
        const cells = r.Cells || [];
        // The TrialBalance row format is [Account, Debit, Credit, YTDDebit, YTDCredit]
        // The Account cell carries an Attribute with the AccountID.
        const accountAttr = cells[0]?.Attributes?.find?.((a) => a.Id === 'account');
        const accountId   = accountAttr?.Value;
        if (!accountId) continue;
        const debit  = parseFloat(cells[1]?.Value ?? 0) || 0;
        const credit = parseFloat(cells[2]?.Value ?? 0) || 0;
        balanceByAccountId[accountId] = debit - credit;
      }
    };
    visit(rows);

    const ids = Object.keys(balanceByAccountId);
    if (ids.length === 0) return;
    // xero_accounts master table is optional on reduced-schema deployments —
    // skip the balance write-back cleanly (ledger stays in account_transactions).
    if (!(await tableExists('xero_accounts'))) return;
    const conn = await pool.getConnection();
    try {
      for (const id of ids) {
        await conn.execute(
          `UPDATE xero_accounts SET balance = ? WHERE user_id = ? AND xero_id = ?`,
          [balanceByAccountId[id], userId, id]
        );
      }
    } finally {
      conn.release();
    }
  } catch (e) {
    console.warn('[Xero] TrialBalance fetch failed:', e.response?.data || e.message);
  }
}

// ── Sync Chart of Accounts ───────────────────────────────────────────────────
async function syncAccounts(userId, accessToken, tenantId) {
  const res = await axios.get(`${XERO_API_BASE}/Accounts`, {
    headers: xeroHeaders(accessToken, tenantId),
  });
  const accounts = res.data?.Accounts || [];
  if (accounts.length === 0) return 0;

  const now = new Date();
  const rows = accounts.map((a) => [
    userId, tenantId, a.AccountID,
    a.Code || null, a.Name || null, a.Type || null, a.TaxType || null,
    a.Class || null, a.Description || null,
    a.EnablePaymentsToAccount ? 1 : 0,
    a.ShowInExpenseClaims ? 1 : 0,
    a.Status || null,
    a.BankAccountNumber || null, a.BankAccountType || null,
    a.CurrencyCode || null,
    a.ReportingCode || null, a.ReportingCodeName || null,
    a.HasAttachments ? 1 : 0,
    toMysqlDt(a.UpdatedDateUTC),
    now,
  ]);

  const conn = await pool.getConnection();
  try {
    await bulkInsert(conn,
      `INSERT INTO xero_accounts
         (user_id, tenant_id, xero_id, code, name, type, tax_type, class, description,
          enable_payments_to_account, show_in_expense_claims, status,
          bank_account_number, bank_account_type, currency_code,
          reporting_code, reporting_code_name, has_attachments, updated_date_utc, synced_at)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         code                       = VALUES(code),
         name                       = VALUES(name),
         type                       = VALUES(type),
         tax_type                   = VALUES(tax_type),
         class                      = VALUES(class),
         description                = VALUES(description),
         enable_payments_to_account = VALUES(enable_payments_to_account),
         show_in_expense_claims     = VALUES(show_in_expense_claims),
         status                     = VALUES(status),
         bank_account_number        = VALUES(bank_account_number),
         bank_account_type          = VALUES(bank_account_type),
         currency_code              = VALUES(currency_code),
         reporting_code             = VALUES(reporting_code),
         reporting_code_name        = VALUES(reporting_code_name),
         has_attachments            = VALUES(has_attachments),
         updated_date_utc           = VALUES(updated_date_utc),
         synced_at                  = VALUES(synced_at)`,
      rows
    );
  } finally {
    conn.release();
  }

  // Best-effort balance population (separate report endpoint)
  await fetchAndStoreBalances(userId, accessToken, tenantId);

  console.log(`[Xero Accounts] Synced ${accounts.length} accounts for userId=${userId} tenant=${tenantId}`);
  return accounts.length;
}

// ── Sync customers (Contacts where IsCustomer=true) ──────────────────────────
async function syncCustomers(userId, accessToken, tenantId) {
  const contacts = await xeroGetAllPages(
    `${XERO_API_BASE}/Contacts`, xeroHeaders(accessToken, tenantId),
    { where: 'IsCustomer==true' }, 'Contacts'
  );
  if (contacts.length === 0) return 0;

  const now = new Date();
  const rows = contacts.map((c) => {
    const email = c.EmailAddress || null;
    const phone = c.Phones?.find?.((p) => p.PhoneNumber)?.PhoneNumber || null;
    // customers.zoho_id is NOT NULL UNIQUE — synthesize a non-colliding value
    return [
      userId, tenantId, `xero:${c.ContactID}`, c.ContactID,
      c.Name || null, c.CompanyName || c.Name || null,
      email, phone,
      parseFloat(c.Balances?.AccountsReceivable?.Outstanding ?? 0),
      c.ContactStatus === 'ACTIVE' ? 'active' : 'inactive',
      now,
    ];
  });

  const conn = await pool.getConnection();
  try {
    await bulkInsert(conn,
      `INSERT INTO customers
         (user_id, org_id, zoho_id, xero_id, contact_name, company_name,
          email, phone, outstanding_receivable_amount, status, synced_at)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         xero_id                       = VALUES(xero_id),
         contact_name                  = VALUES(contact_name),
         company_name                  = VALUES(company_name),
         email                         = VALUES(email),
         phone                         = VALUES(phone),
         outstanding_receivable_amount = VALUES(outstanding_receivable_amount),
         status                        = VALUES(status),
         synced_at                     = VALUES(synced_at)`,
      rows
    );
  } finally {
    conn.release();
  }
  return contacts.length;
}

// Flatten a Xero Address into the single line the contact reports print. Xero
// keeps a STREET and a POBOX address per contact; the street one is the billing
// address a supplier invoice is addressed to.
function xeroAddress(addresses) {
  const list = Array.isArray(addresses) ? addresses : [];
  const a = list.find((x) => x.AddressType === 'STREET' && (x.AddressLine1 || x.City))
    || list.find((x) => x.AddressLine1 || x.City);
  if (!a) return null;
  const parts = [
    a.AddressLine1, a.AddressLine2, a.AddressLine3, a.AddressLine4,
    a.City, a.Region, a.PostalCode, a.Country,
  ].map((p) => String(p ?? '').trim()).filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

// ── Sync vendors (Contacts where IsSupplier=true) ────────────────────────────
async function syncVendors(userId, accessToken, tenantId) {
  const contacts = await xeroGetAllPages(
    `${XERO_API_BASE}/Contacts`, xeroHeaders(accessToken, tenantId),
    { where: 'IsSupplier==true' }, 'Contacts'
  );
  if (contacts.length === 0) return 0;

  const now = new Date();
  const rows = contacts.map((v) => {
    const email = v.EmailAddress || null;
    const phone = v.Phones?.find?.((p) => p.PhoneNumber)?.PhoneNumber || null;
    const fullName = [v.FirstName, v.LastName]
      .map((p) => String(p ?? '').trim()).filter(Boolean).join(' ') || null;
    return [
      userId, tenantId, `xero:${v.ContactID}`, v.ContactID,
      v.Name || null, v.CompanyName || v.Name || null,
      email, phone,
      parseFloat(v.Balances?.AccountsPayable?.Outstanding ?? 0),
      v.ContactStatus === 'ACTIVE' ? 'active' : 'inactive',
      xeroAddress(v.Addresses), fullName, v.AccountNumber || null, v.TaxNumber || null,
      now,
    ];
  });

  const conn = await pool.getConnection();
  try {
    await bulkInsert(conn,
      `INSERT INTO vendors
         (user_id, org_id, zoho_id, xero_id, contact_name, company_name,
          email, phone, outstanding_payable_amount, status,
          billing_address, full_name, account_number, gst_no, synced_at)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         xero_id                    = VALUES(xero_id),
         contact_name               = VALUES(contact_name),
         company_name               = VALUES(company_name),
         email                      = VALUES(email),
         phone                      = VALUES(phone),
         outstanding_payable_amount = VALUES(outstanding_payable_amount),
         status                     = VALUES(status),
         billing_address            = VALUES(billing_address),
         full_name                  = VALUES(full_name),
         account_number             = VALUES(account_number),
         gst_no                     = VALUES(gst_no),
         synced_at                  = VALUES(synced_at)`,
      rows
    );
  } finally {
    conn.release();
  }
  return contacts.length;
}

// ── Sync invoices (Type=ACCREC) ──────────────────────────────────────────────
async function syncInvoices(userId, accessToken, tenantId) {
  const items = await xeroGetAllPages(
    `${XERO_API_BASE}/Invoices`, xeroHeaders(accessToken, tenantId),
    { Statuses: 'AUTHORISED,PAID', where: 'Type=="ACCREC"' }, 'Invoices'
  );
  if (items.length === 0) return 0;

  const now = new Date();
  const rows = items.map((inv) => [
    userId, tenantId, `xero:${inv.InvoiceID}`, inv.InvoiceID,
    inv.InvoiceNumber || null,
    inv.Contact?.Name || null,
    toMysqlDate(inv.Date),
    toMysqlDate(inv.DueDate),
    parseFloat(inv.Total ?? 0),
    parseFloat(inv.AmountDue ?? 0),
    inv.Status === 'PAID' ? 'paid' : 'open',
    now,
  ]);

  const conn = await pool.getConnection();
  try {
    await bulkInsert(conn,
      `INSERT INTO invoices
         (user_id, org_id, zoho_id, xero_id, invoice_number, customer_name,
          date, due_date, total, balance, status, synced_at)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         xero_id        = VALUES(xero_id),
         invoice_number = VALUES(invoice_number),
         customer_name  = VALUES(customer_name),
         date           = VALUES(date),
         due_date       = VALUES(due_date),
         total          = VALUES(total),
         balance        = VALUES(balance),
         status         = VALUES(status),
         synced_at      = VALUES(synced_at)`,
      rows
    );
  } finally {
    conn.release();
  }
  return items.length;
}

// The "item" a Xero bill line purchased. Xero only sets ItemCode when the line
// references an inventory item; most bills are account-based, so the line's own
// Description is the purchased item (the same books entered in Zoho carry that
// text as the item name), falling back to the expense account it hits. Lines
// with neither have nothing to report and are skipped.
function xeroBillLineItem(l, accountNames) {
  if (l.ItemCode) return { id: `xero:${l.ItemCode}`, name: l.ItemCode };
  const name = String(l.Description || '').trim()
    || accountNames.get(String(l.AccountCode)) || l.AccountCode || '';
  if (!name) return null;
  // zoho_item_id is varchar(100) and a description can be longer, so the group
  // key is a digest of the name rather than the name itself.
  return { id: `xero:l:${crypto.createHash('md5').update(name).digest('hex').slice(0, 16)}`, name };
}

// Persist a bill's Xero LineItems into the SHARED `zb_bill_line_items` table
// (keyed on the synthetic `xero:<InvoiceID>` so zoho_bill_id joins bills.zoho_id),
// which is what "Purchases by Item" and the purchase-tax reports read.
async function syncBillLineItems(conn, userId, tenantId, bills) {
  // Xero puts only the account CODE on a line, so name the un-described lines
  // after their expense account rather than showing a bare code.
  const accountNames = new Map();
  try {
    const [accts] = await conn.query(
      'SELECT code, name FROM xero_accounts WHERE user_id = ? AND tenant_id = ?',
      [userId, tenantId]
    );
    for (const a of accts) if (a.code) accountNames.set(String(a.code), a.name);
  } catch (_) { /* accounts not synced yet — fall back to the code */ }

  const rows = [];
  for (const b of bills) {
    const billKey = `xero:${b.InvoiceID}`;
    (b.LineItems || []).forEach((l, i) => {
      const item = xeroBillLineItem(l, accountNames);
      if (!item) return;
      const amount = parseFloat(l.LineAmount ?? 0);
      const qty = l.Quantity != null ? parseFloat(l.Quantity) : 1;
      const rate = l.UnitAmount != null ? parseFloat(l.UnitAmount) : (qty ? amount / qty : 0);
      rows.push([
        userId, tenantId, `${billKey}:${l.LineItemID || i}`, billKey, i,
        item.id, item.name.slice(0, 255), l.Description || null,
        l.AccountCode || null, qty, rate, amount,
        parseFloat(l.TaxAmount ?? 0),
      ]);
    });
  }
  if (!rows.length) return;
  await bulkInsert(conn,
    `INSERT INTO zb_bill_line_items
       (user_id, org_id, zoho_line_item_id, zoho_bill_id, line_position,
        zoho_item_id, item_name, description, account_id,
        quantity, rate, item_total, tax_amount)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       zoho_bill_id  = VALUES(zoho_bill_id),
       line_position = VALUES(line_position),
       zoho_item_id  = VALUES(zoho_item_id),
       item_name     = VALUES(item_name),
       description   = VALUES(description),
       account_id    = VALUES(account_id),
       quantity      = VALUES(quantity),
       rate          = VALUES(rate),
       item_total    = VALUES(item_total),
       tax_amount    = VALUES(tax_amount)`,
    rows
  );
}

// ── Sync bills (Type=ACCPAY) ─────────────────────────────────────────────────
async function syncBills(userId, accessToken, tenantId) {
  const items = await xeroGetAllPages(
    `${XERO_API_BASE}/Invoices`, xeroHeaders(accessToken, tenantId),
    { Statuses: 'AUTHORISED,PAID', where: 'Type=="ACCPAY"' }, 'Invoices'
  );
  if (items.length === 0) return 0;

  const now = new Date();
  const rows = items.map((b) => [
    userId, tenantId, `xero:${b.InvoiceID}`, b.InvoiceID,
    b.InvoiceNumber || null,
    b.Contact?.Name || null,
    toMysqlDate(b.Date),
    toMysqlDate(b.DueDate),
    parseFloat(b.Total ?? 0),
    parseFloat(b.AmountDue ?? 0),
    b.Status === 'PAID' ? 'paid' : 'open',
    now,
  ]);

  const conn = await pool.getConnection();
  try {
    await bulkInsert(conn,
      `INSERT INTO bills
         (user_id, org_id, zoho_id, xero_id, bill_number, vendor_name,
          date, due_date, total, balance, status, synced_at)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         xero_id     = VALUES(xero_id),
         bill_number = VALUES(bill_number),
         vendor_name = VALUES(vendor_name),
         date        = VALUES(date),
         due_date    = VALUES(due_date),
         total       = VALUES(total),
         balance     = VALUES(balance),
         status      = VALUES(status),
         synced_at   = VALUES(synced_at)`,
      rows
    );
    if (await tableExists('zb_bill_line_items')) {
      await syncBillLineItems(conn, userId, tenantId, items);
    }
  } finally {
    conn.release();
  }
  return items.length;
}

// ── Sync expenses (Xero "BankTransactions" with Type=SPEND) ─────────────────
async function syncExpenses(userId, accessToken, tenantId) {
  const items = await xeroGetAllPages(
    `${XERO_API_BASE}/BankTransactions`, xeroHeaders(accessToken, tenantId),
    { where: 'Type=="SPEND"' }, 'BankTransactions'
  );
  if (items.length === 0) return 0;

  const now = new Date();
  const rows = items.map((t) => {
    const firstLine = (t.LineItems || [])[0];
    const accountName = firstLine?.AccountCode || t.BankAccount?.Name || null;
    const description = (t.LineItems || []).map((l) => l.Description).filter(Boolean).join(' | ') || null;
    return [
      userId, tenantId, `xero:${t.BankTransactionID}`, t.BankTransactionID,
      accountName, toMysqlDate(t.Date),
      parseFloat(t.Total ?? 0), t.Contact?.Name || null, description,
      t.Status || 'AUTHORISED',
      now,
    ];
  });

  const conn = await pool.getConnection();
  try {
    await bulkInsert(conn,
      `INSERT INTO expense_entries
         (user_id, org_id, zoho_id, xero_id, account_name, expense_date,
          amount, vendor_name, description, status, synced_at)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         xero_id      = VALUES(xero_id),
         account_name = VALUES(account_name),
         expense_date = VALUES(expense_date),
         amount       = VALUES(amount),
         vendor_name  = VALUES(vendor_name),
         description  = VALUES(description),
         status       = VALUES(status),
         synced_at    = VALUES(synced_at)`,
      rows
    );
  } finally {
    conn.release();
  }
  return items.length;
}

// ── Sync bank transactions → shared bank_transactions (cash ledger) ─────────
// Cash-basis reports (Cash Summary, Statement of Cash Flows - Direct) read from
// the shared `bank_transactions` table, which until now only held Zoho cash
// movements. Mirror Xero's bank activity into the same table (keyed by the
// platform-unique `xero:<BankTransactionID>`) so those reports work for Xero
// exactly like they do for Zoho — no dedicated Xero table.
//
// Sign convention matches the Zoho cash reports: debit_or_credit = 'debit' is
// money IN (Xero RECEIVE), 'credit' is money OUT (Xero SPEND). transaction_type
// maps to the same labels the builders classify by (customer_payment / expense).
async function syncBankTransactions(userId, accessToken, tenantId) {
  const items = await xeroGetAllPages(
    `${XERO_API_BASE}/BankTransactions`, xeroHeaders(accessToken, tenantId),
    {}, 'BankTransactions'
  );
  if (items.length === 0) return 0;

  const now = new Date();
  const rows = items.map((t) => {
    const isReceive = String(t.Type || '').startsWith('RECEIVE');
    const firstLine = (t.LineItems || [])[0];
    return [
      userId, String(tenantId), `xero:${t.BankTransactionID}`,
      toMysqlDate(t.Date), Math.abs(parseFloat(t.Total ?? 0)),
      isReceive ? 'customer_payment' : 'expense',
      isReceive ? 'Customer Payment' : 'Expense',
      t.Status || 'AUTHORISED', 'xero',
      t.BankAccount?.Name || null, 'bank',
      t.Contact?.Name || null,
      (t.LineItems || []).map((l) => l.Description).filter(Boolean).join(' | ') || null,
      t.CurrencyCode || null,
      isReceive ? 'debit' : 'credit',
      firstLine?.AccountCode || t.Contact?.Name || null,
      t.BankTransactionID,
      now,
    ];
  });

  const conn = await pool.getConnection();
  try {
    await bulkInsert(conn,
      `INSERT INTO bank_transactions
         (user_id, org_id, transaction_id, transaction_date, amount,
          transaction_type, transaction_type_formatted, status, source,
          account_name, account_type, payee, description, currency_code,
          debit_or_credit, offset_account_name, xero_id, synced_at)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         transaction_date=VALUES(transaction_date), amount=VALUES(amount),
         transaction_type=VALUES(transaction_type),
         transaction_type_formatted=VALUES(transaction_type_formatted),
         status=VALUES(status), account_name=VALUES(account_name),
         payee=VALUES(payee), description=VALUES(description),
         currency_code=VALUES(currency_code), debit_or_credit=VALUES(debit_or_credit),
         offset_account_name=VALUES(offset_account_name), xero_id=VALUES(xero_id),
         synced_at=VALUES(synced_at)`,
      rows
    );
  } finally {
    conn.release();
  }
  console.log(`[Xero Bank] Synced ${items.length} bank transactions for userId=${userId} tenant=${tenantId}`);
  return items.length;
}

// ── Sync manual journals → shared account_transactions (GL) ─────────────────
// Mirrors the QuickBooks journal-entry sync: one row per JournalLine into the
// shared account_transactions table (the same table Zoho GL lands in), keyed by
// platform-unique IDs. No dedicated Xero journal table.
async function syncManualJournals(userId, accessToken, tenantId) {
  const journals = await xeroGetAllPages(
    `${XERO_API_BASE}/ManualJournals`, xeroHeaders(accessToken, tenantId),
    {}, 'ManualJournals'
  );
  if (journals.length === 0) return 0;

  // Archive verbatim Xero JSON from the same /ManualJournals source API that
  // feeds account_transactions. Degrades cleanly if db/raw-transactions.sql
  // hasn't been applied.
  const storeRaw = await tableExists('xero_raw_transactions');

  const now = new Date();
  const rawRows = [];
  const lineRows = [];
  for (const j of journals) {
    if (storeRaw) {
      rawRows.push([userId, String(tenantId), 'ManualJournals', `xero:${j.ManualJournalID}`, JSON.stringify(j), now]);
    }
    const lines = j.JournalLines || [];
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const amount = parseFloat(ln.LineAmount ?? 0);
      const isDebit = amount >= 0;
      const accountId = ln.AccountID || ln.AccountCode || `xero:${j.ManualJournalID}:${i}`;
      lineRows.push([
        userId, String(tenantId), 'xero', `xero:${j.ManualJournalID}`, String(accountId),
        toMysqlDt(j.Date),
        ln.AccountCode || null,
        ln.Description || j.Narration || null,
        'ManualJournal',
        String(i), j.Narration || null,
        isDebit ? Math.abs(amount) : 0,
        isDebit ? 0                : Math.abs(amount),
        Math.abs(amount),
        isDebit ? 'D' : 'C',
        'ManualJournal',
        j.ManualJournalID,
        i,
        ln.TaxType || null,
        parseFloat(ln.TaxAmount ?? 0),
        null,
        now,
      ]);
    }
  }

  const conn = await pool.getConnection();
  try {
    if (storeRaw) {
      // raw_json can be large — smaller chunk keeps each packet under the limit.
      await bulkInsert(conn,
        `INSERT INTO xero_raw_transactions
           (user_id, tenant_id, source_endpoint, transaction_id, raw_json, synced_at)
         VALUES ?
         ON DUPLICATE KEY UPDATE raw_json = VALUES(raw_json), synced_at = VALUES(synced_at)`,
        rawRows, 100
      );
    }
    await bulkInsert(conn,
      `INSERT INTO account_transactions
         (user_id, org_id, platform, transaction_id, account_id, transaction_date,
          account_name, transaction_details, transaction_type,
          transaction_number, reference_number, debit, credit, balance,
          balance_type, source_type, source_id, line_number, tax_type,
          tax_amount, currency_code, synced_at)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         transaction_date=VALUES(transaction_date), account_name=VALUES(account_name),
         transaction_details=VALUES(transaction_details), transaction_type=VALUES(transaction_type),
         reference_number=VALUES(reference_number), debit=VALUES(debit), credit=VALUES(credit),
         balance=VALUES(balance), balance_type=VALUES(balance_type),
         source_type=VALUES(source_type), source_id=VALUES(source_id), line_number=VALUES(line_number),
         tax_type=VALUES(tax_type), tax_amount=VALUES(tax_amount), currency_code=VALUES(currency_code),
         synced_at=VALUES(synced_at)`,
      lineRows
    );
  } finally {
    conn.release();
  }
  console.log(`[Xero Journals] Synced ${journals.length} manual journals (${lineRows.length} lines) for userId=${userId} tenant=${tenantId}`);
  return journals.length;
}

// ── Sync the full GL journal → shared account_transactions ──────────────────
// Xero's /Journals endpoint is the authoritative general ledger: EVERY posted
// transaction (invoices, bills, payments, bank transactions, manual journals)
// emits balanced journal lines here, so this — not /ManualJournals (manual-only)
// — is the proper source for Transaction Detail by Account / GL reports, the
// same role account_transactions plays for Zoho. Each JournalLine.NetAmount is
// signed (positive = debit, negative = credit) and the lines of a journal sum to
// zero. Paginated by `offset` = highest JournalNumber seen (100 journals/page).
// Requires the `accounting.journals.read` scope on the connection.
async function syncJournals(userId, accessToken, tenantId) {
  let offset = 0;
  let totalJournals = 0;
  let lineCount = 0;
  // Archive verbatim Xero JSON from the same /Journals source API that feeds
  // account_transactions. Degrades cleanly if db/raw-transactions.sql is absent.
  const storeRaw = await tableExists('xero_raw_transactions');
  const conn = await pool.getConnection();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await axios.get(`${XERO_API_BASE}/Journals`, {
        headers: xeroHeaders(accessToken, tenantId),
        params: { offset },
      });
      const journals = res.data?.Journals || [];
      if (journals.length === 0) break;

      for (const j of journals) {
        if (storeRaw) {
          await conn.execute(
            `INSERT INTO xero_raw_transactions
               (user_id, tenant_id, source_endpoint, transaction_id, raw_json, synced_at)
             VALUES (?,?,?,?,?,NOW())
             ON DUPLICATE KEY UPDATE raw_json = VALUES(raw_json), synced_at = NOW()`,
            [userId, String(tenantId), 'Journals', `xero:${j.JournalID}`, JSON.stringify(j)]
          );
        }
        const lines = j.JournalLines || [];
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i];
          const amount = parseFloat(ln.NetAmount ?? 0);
          const isDebit = amount >= 0;
          const txnId = `xero:${j.JournalID}`;
          // Make each line unique within the journal so the ON DUPLICATE KEY on
          // (user_id, transaction_id, transaction_number, account_id) never merges
          // two lines: the unique part is the line index baked into account_id,
          // while account_name keeps the real (groupable) account name and
          // transaction_number carries Xero's display "Journal ID" (JournalNumber).
          const accountId = `${ln.AccountID || ln.AccountCode || 'noacct'}:${i}`;
          const journalNo = Number.isFinite(j.JournalNumber) ? String(j.JournalNumber) : String(i);
          await conn.execute(
            `INSERT INTO account_transactions
               (user_id, org_id, platform, transaction_id, account_id, transaction_date,
                account_name, transaction_details, transaction_type,
                transaction_number, reference_number, debit, credit, balance,
                balance_type, source_type, source_id, line_number, tax_type,
                tax_amount, currency_code, synced_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
             ON DUPLICATE KEY UPDATE
               transaction_date=VALUES(transaction_date), account_name=VALUES(account_name),
               transaction_details=VALUES(transaction_details), transaction_type=VALUES(transaction_type),
               reference_number=VALUES(reference_number), debit=VALUES(debit), credit=VALUES(credit),
               balance=VALUES(balance), balance_type=VALUES(balance_type),
               source_type=VALUES(source_type), source_id=VALUES(source_id), line_number=VALUES(line_number),
               tax_type=VALUES(tax_type), tax_amount=VALUES(tax_amount), currency_code=VALUES(currency_code),
               synced_at=NOW()`,
            [
              userId, String(tenantId), 'xero', txnId, String(accountId),
              toMysqlDt(j.JournalDate),
              ln.AccountName || ln.AccountCode || null,
              ln.Description || null,
              j.SourceType || 'Journal',
              journalNo, j.Reference || null,
              isDebit ? Math.abs(amount) : 0,
              isDebit ? 0                : Math.abs(amount),
              Math.abs(amount),
              isDebit ? 'D' : 'C',
              j.SourceType || 'Journal',
              j.SourceID || j.JournalID,
              i,
              ln.TaxType || null,
              parseFloat(ln.TaxAmount ?? 0),
              null,
            ]
          );
          lineCount += 1;
        }
        if (Number.isFinite(j.JournalNumber)) offset = Math.max(offset, j.JournalNumber);
      }

      totalJournals += journals.length;
      if (journals.length < 100) break;
    }
  } finally {
    conn.release();
  }
  console.log(`[Xero GL] Synced ${totalJournals} journals (${lineCount} lines) for userId=${userId} tenant=${tenantId}`);
  return totalJournals;
}

// ── Master sync ─────────────────────────────────────────────────────────────
async function syncAllXeroData(userId, accessToken, tenantId) {
  console.log(`[Xero Sync] Starting userId=${userId} tenant=${tenantId}`);
  const results = await Promise.allSettled([
    syncAccounts(userId, accessToken, tenantId),
    syncCustomers(userId, accessToken, tenantId),
    syncVendors(userId, accessToken, tenantId),
    syncInvoices(userId, accessToken, tenantId),
    syncBills(userId, accessToken, tenantId),
    syncExpenses(userId, accessToken, tenantId),
    syncBankTransactions(userId, accessToken, tenantId),
    // Manual journals → account_transactions. NOTE: the richer /Journals GL
    // (syncJournals) is NOT run here because Xero gates that endpoint behind the
    // premium Advanced tier and grants no accounting.journals.read scope for
    // granular apps (connections from 29 Apr 2026), so it only ever 401s and
    // would add log noise. syncJournals stays exported for any future
    // journal-capable connection — but do NOT run both at once (they'd
    // double-count manual journals: distinct ManualJournalID vs JournalID keys).
    syncManualJournals(userId, accessToken, tenantId),
  ]);
  const [acct, cust, vend, inv, bil, exp, bank, jrn] = results.map((r) =>
    r.status === 'fulfilled' ? r.value : `ERR: ${r.reason?.message}`
  );
  console.log(`[Xero Sync] Done — accounts:${acct} customers:${cust} vendors:${vend} invoices:${inv} bills:${bil} expenses:${exp} bank:${bank} manualJournals:${jrn}`);

  // Rebuild the DB-backed general ledger (account_transactions) via the Path B
  // posting engine so every Xero report (P&L / BS / TB / GL / Bank & Executive
  // Summary) reflects this sync — Xero's own /Journals GL is scope-gated (401),
  // so we synthesize a balanced double-entry ledger from the source documents.
  // Runs AFTER the silver-table sync (it reads the freshly synced xero_accounts)
  // and is lazy-required to avoid a circular module dependency. Isolated so a
  // rebuild failure never fails the sync.
  try {
    const { rebuildXeroLedger } = require('./xeroPostingEngine');
    const led = await rebuildXeroLedger(userId, {});
    console.log(`[Xero Sync] Ledger rebuilt — promoted ${led.promoted} lines to account_transactions`);
  } catch (e) {
    console.error('[Xero Sync] Ledger rebuild failed:', e.message);
  }
}

module.exports = {
  XERO_AUTH_URL,
  XERO_TOKEN_URL,
  XERO_REVOKE_URL,
  XERO_API_BASE,
  exchangeCodeForTokens,
  refreshXeroToken,
  revokeToken,
  fetchTenants,
  fetchOrganisation,
  getValidXeroToken,
  getEffectiveXeroUserId,
  syncAllXeroData,
  syncAccounts,
  syncCustomers,
  syncVendors,
  syncInvoices,
  syncBills,
  syncExpenses,
  syncBankTransactions,
  syncManualJournals,
  syncJournals,
};
