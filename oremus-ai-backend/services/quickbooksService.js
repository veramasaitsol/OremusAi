'use strict';
// QuickBooks Online API sync service
// Fetches customers, vendors, invoices, bills, purchases (expenses), and
// journal entries via the QBO Query API and upserts them into MySQL.

const axios = require('axios');
const crypto = require('crypto');
const pool  = require('../config/db');
const cache = require('../utils/cache');
const { reauthError } = require('../utils/reauthError');
const { tableExists } = require('../utils/tableExists');
const { currencySymbol } = require('../utils/currencySymbols');

// ── URL helpers ────────────────────────────────────────────────────────────────
const QBO_TOKEN_URL  = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const QBO_AUTH_URL   = 'https://appcenter.intuit.com/connect/oauth2';

function getApiBase(env) {
  return env === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function qboHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept:        'application/json',
  };
}

const MINOR_VERSION = process.env.QBO_MINOR_VERSION || '70';

// ── Run a SQL query against QBO via the /query endpoint ───────────────────────
// QB Query API uses STARTPOSITION + MAXRESULTS (max 1000).
async function qboQuery(realmId, accessToken, environment, sql) {
  const apiBase = getApiBase(environment);
  const url = `${apiBase}/v3/company/${realmId}/query`;
  const res = await axios.get(url, {
    headers: qboHeaders(accessToken),
    params:  { query: sql, minorversion: MINOR_VERSION },
  });
  return res.data?.QueryResponse || {};
}

// ── Fetch all pages of an entity via the Query API ────────────────────────────
async function fetchAllEntities(realmId, accessToken, environment, entity, whereClause = '') {
  const results = [];
  const pageSize = 1000;
  let start = 1;
  // QBO requires SELECT * — projection isn't supported.
  while (true) {
    const where = whereClause ? ` ${whereClause}` : '';
    const sql = `SELECT * FROM ${entity}${where} STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
    const data = await qboQuery(realmId, accessToken, environment, sql);
    const items = data[entity] || [];
    results.push(...items);
    if (items.length < pageSize) break;
    start += pageSize;
  }
  return results;
}

// ── Sync customers ────────────────────────────────────────────────────────────
async function syncCustomers(userId, accessToken, realmId, environment) {
  const customers = await fetchAllEntities(realmId, accessToken, environment, 'Customer');
  if (customers.length === 0) return 0;

  const conn = await pool.getConnection();
  try {
    for (const c of customers) {
      const email = c.PrimaryEmailAddr?.Address || null;
      const phone = c.PrimaryPhone?.FreeFormNumber || null;
      const balance = parseFloat(c.Balance ?? 0);
      const company = c.CompanyName || null;
      const displayName = c.DisplayName || c.FullyQualifiedName || c.Name || null;
      // Reuse the existing customers table (originally for Zoho). qbo_id distinguishes the row.
      // org_id stores the realmId for QBO rows.
      // zoho_id is NOT NULL UNIQUE so we synthesize a non-colliding value per QB id.
      const syntheticZohoId = `qbo:${c.Id}`;
      await conn.execute(
        `INSERT INTO customers
           (user_id, org_id, zoho_id, qbo_id, contact_name, company_name,
            email, phone, outstanding_receivable_amount, status, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           qbo_id                        = VALUES(qbo_id),
           contact_name                  = VALUES(contact_name),
           company_name                  = VALUES(company_name),
           email                         = VALUES(email),
           phone                         = VALUES(phone),
           outstanding_receivable_amount = VALUES(outstanding_receivable_amount),
           status                        = VALUES(status),
           synced_at                     = NOW()`,
        [
          userId, realmId, syntheticZohoId, c.Id,
          displayName, company, email, phone,
          balance, c.Active === false ? 'inactive' : 'active',
        ]
      );
    }
  } finally {
    conn.release();
  }
  return customers.length;
}

// Flatten a QBO PhysicalAddress into the single line the contact reports print.
function qboAddress(a) {
  if (!a) return null;
  const parts = [
    a.Line1, a.Line2, a.Line3, a.Line4, a.Line5,
    a.City, a.CountrySubDivisionCode, a.PostalCode, a.Country,
  ].map((p) => String(p ?? '').trim()).filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

// ── Sync vendors ──────────────────────────────────────────────────────────────
async function syncVendors(userId, accessToken, realmId, environment) {
  const vendors = await fetchAllEntities(realmId, accessToken, environment, 'Vendor');
  if (vendors.length === 0) return 0;

  const conn = await pool.getConnection();
  try {
    for (const v of vendors) {
      const email = v.PrimaryEmailAddr?.Address || null;
      const phone = v.PrimaryPhone?.FreeFormNumber || null;
      const balance = parseFloat(v.Balance ?? 0);
      const fullName = [v.GivenName, v.MiddleName, v.FamilyName, v.Suffix]
        .map((p) => String(p ?? '').trim()).filter(Boolean).join(' ') || null;
      const syntheticZohoId = `qbo:${v.Id}`;
      await conn.execute(
        `INSERT INTO vendors
           (user_id, org_id, zoho_id, qbo_id, contact_name, company_name,
            email, phone, outstanding_payable_amount, status,
            billing_address, full_name, account_number, track_1099, gst_no, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           qbo_id                     = VALUES(qbo_id),
           contact_name               = VALUES(contact_name),
           company_name               = VALUES(company_name),
           email                      = VALUES(email),
           phone                      = VALUES(phone),
           outstanding_payable_amount = VALUES(outstanding_payable_amount),
           status                     = VALUES(status),
           billing_address            = VALUES(billing_address),
           full_name                  = VALUES(full_name),
           account_number             = VALUES(account_number),
           track_1099                 = VALUES(track_1099),
           gst_no                     = VALUES(gst_no),
           synced_at                  = NOW()`,
        [
          userId, realmId, syntheticZohoId, v.Id,
          v.DisplayName || v.CompanyName || null,
          v.CompanyName || null, email, phone, balance,
          v.Active === false ? 'inactive' : 'active',
          qboAddress(v.BillAddr), fullName, v.AcctNum || null,
          v.Vendor1099 ? 1 : 0, v.TaxIdentifier || null,
        ]
      );
    }
  } finally {
    conn.release();
  }
  return vendors.length;
}

// ── Sync invoices ─────────────────────────────────────────────────────────────
async function syncInvoices(userId, accessToken, realmId, environment) {
  const invoices = await fetchAllEntities(realmId, accessToken, environment, 'Invoice');
  if (invoices.length === 0) return 0;

  // QBO invoice payloads already carry the full `Line` array, so we persist the
  // per-line SalesItemLineDetail rows into the SHARED `zb_invoice_line_items`
  // table (reusing it with synthetic `qbo:` keys, per the no-new-tables rule).
  // This is what feeds the line-level reports (Sales by Customer/Product Detail
  // + Sales by Product/Service Summary) with the real product/service breakdown
  // instead of a single invoice-level "Uncategorized" row.
  const hasLineItems = await tableExists('zb_invoice_line_items');

  const conn = await pool.getConnection();
  try {
    for (const inv of invoices) {
      const syntheticZohoId = `qbo:${inv.Id}`;
      const total = parseFloat(inv.TotalAmt ?? 0);
      const balance = parseFloat(inv.Balance ?? 0);
      const status = balance <= 0 ? 'paid' : 'open';
      // CurrencyRef is only present on invoices from a multi-currency-enabled
      // company; absent otherwise, so this stays null rather than guessing USD.
      const currencyCode = inv.CurrencyRef?.value || null;
      const exchangeRate = inv.ExchangeRate != null ? parseFloat(inv.ExchangeRate) : null;
      await conn.execute(
        `INSERT INTO invoices
           (user_id, org_id, zoho_id, qbo_id, invoice_number, customer_name,
            date, due_date, total, balance, status,
            currency_code, currency_symbol, exchange_rate, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           qbo_id          = VALUES(qbo_id),
           invoice_number  = VALUES(invoice_number),
           customer_name   = VALUES(customer_name),
           date            = VALUES(date),
           due_date        = VALUES(due_date),
           total           = VALUES(total),
           balance         = VALUES(balance),
           status          = VALUES(status),
           currency_code   = VALUES(currency_code),
           currency_symbol = VALUES(currency_symbol),
           exchange_rate   = VALUES(exchange_rate),
           synced_at       = NOW()`,
        [
          userId, realmId, syntheticZohoId, inv.Id,
          inv.DocNumber || null,
          inv.CustomerRef?.name || null,
          inv.TxnDate || null,
          inv.DueDate || null,
          total, balance, status,
          currencyCode, currencySymbol(currencyCode), exchangeRate,
        ]
      );

      if (hasLineItems) await syncInvoiceLineItems(conn, userId, realmId, inv, `qbo:${inv.Id}`);
    }
  } finally {
    conn.release();
  }
  return invoices.length;
}

// ── Sync sales receipts → shared `invoices` table ─────────────────────────────
// A QBO SalesReceipt is a paid-on-the-spot sale. QuickBooks' sales reports
// (Sales by Customer / Product) include them alongside invoices, so we persist
// them into the same shared `invoices` table (status 'paid', balance 0) with a
// namespaced key `qbo:sr:<Id>` to avoid colliding with Invoice Ids, plus their
// SalesItemLineDetail lines into `zb_invoice_line_items`.
async function syncSalesReceipts(userId, accessToken, realmId, environment) {
  const receipts = await fetchAllEntities(realmId, accessToken, environment, 'SalesReceipt');
  if (receipts.length === 0) return 0;

  const hasLineItems = await tableExists('zb_invoice_line_items');

  const conn = await pool.getConnection();
  try {
    for (const sr of receipts) {
      const key = `qbo:sr:${sr.Id}`;
      const total = parseFloat(sr.TotalAmt ?? 0);
      const currencyCode = sr.CurrencyRef?.value || null;
      const exchangeRate = sr.ExchangeRate != null ? parseFloat(sr.ExchangeRate) : null;
      await conn.execute(
        `INSERT INTO invoices
           (user_id, org_id, zoho_id, qbo_id, invoice_number, customer_name,
            date, due_date, total, balance, status,
            currency_code, currency_symbol, exchange_rate, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           qbo_id          = VALUES(qbo_id),
           invoice_number  = VALUES(invoice_number),
           customer_name   = VALUES(customer_name),
           date            = VALUES(date),
           total           = VALUES(total),
           balance         = VALUES(balance),
           status          = VALUES(status),
           currency_code   = VALUES(currency_code),
           currency_symbol = VALUES(currency_symbol),
           exchange_rate   = VALUES(exchange_rate),
           synced_at       = NOW()`,
        [
          userId, realmId, key, sr.Id,
          sr.DocNumber || null,
          sr.CustomerRef?.name || null,
          sr.TxnDate || null,
          sr.TxnDate || null,
          total, 0, 'paid',
          currencyCode, currencySymbol(currencyCode), exchangeRate,
        ]
      );
      if (hasLineItems) await syncInvoiceLineItems(conn, userId, realmId, sr, key);
    }
  } finally {
    conn.release();
  }
  return receipts.length;
}

// Persist a QBO invoice/sales-receipt's product/service lines into the shared
// line-item table. Only SalesItemLineDetail lines (actual product/service, incl.
// QBO-India GST items like Output CGST/SGST/IGST which are modelled as line
// items) are stored; SubTotal/DiscountLineDetail lines are skipped. `keyBase`
// mirrors the header row's zoho_id (`qbo:<Id>` or `qbo:sr:<Id>`) so
// zoho_invoice_id joins invoices.zoho_id; zoho_line_item_id = `<keyBase>:<Line.Id>`.
async function syncInvoiceLineItems(conn, userId, realmId, doc, keyBase) {
  const lines = (doc.Line || []).filter((ln) => ln.DetailType === 'SalesItemLineDetail');
  const invKey = keyBase;
  for (const ln of lines) {
    const det = ln.SalesItemLineDetail || {};
    const lineId = ln.Id != null ? String(ln.Id) : String(ln.LineNum ?? 0);
    const itemName = det.ItemRef?.name || null;
    const amount = parseFloat(ln.Amount ?? 0);
    const qty = det.Qty != null ? parseFloat(det.Qty) : null;
    const rate = det.UnitPrice != null ? parseFloat(det.UnitPrice) : (qty ? amount / qty : null);
    await conn.execute(
      `INSERT INTO zb_invoice_line_items
         (user_id, org_id, zoho_line_item_id, zoho_invoice_id, line_position,
          zoho_item_id, item_name, name, description, quantity, rate, item_total)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         zoho_invoice_id = VALUES(zoho_invoice_id),
         line_position   = VALUES(line_position),
         zoho_item_id    = VALUES(zoho_item_id),
         item_name       = VALUES(item_name),
         name            = VALUES(name),
         description     = VALUES(description),
         quantity        = VALUES(quantity),
         rate            = VALUES(rate),
         item_total      = VALUES(item_total)`,
      [
        userId, realmId, `${invKey}:${lineId}`, invKey,
        ln.LineNum != null ? Number(ln.LineNum) : 0,
        det.ItemRef?.value || null,
        itemName, itemName,
        ln.Description || null,
        qty, rate, amount,
      ]
    );
  }
}

// The "item" a QBO bill line purchased. An ItemBasedExpenseLineDetail line
// references a real product/service; QBO bills are usually account-based, so
// there the line's own Description is the purchased item (the same books
// entered in Zoho carry that text as the item name), falling back to the
// expense account it hits. Lines with neither (SubTotal/Discount) are skipped.
function qboBillLineItem(ln) {
  const item = ln.ItemBasedExpenseLineDetail?.ItemRef;
  if (item?.value) return { id: `qbo:${item.value}`, name: item.name || item.value };
  const det = ln.AccountBasedExpenseLineDetail;
  if (!det) return null;
  const name = String(ln.Description || '').trim() || det.AccountRef?.name || '';
  if (!name) return null;
  // zoho_item_id is varchar(100) and a description can be longer, so the group
  // key is a digest of the name rather than the name itself.
  return { id: `qbo:l:${crypto.createHash('md5').update(name).digest('hex').slice(0, 16)}`, name };
}

// Persist a bill's QBO expense lines into the SHARED `zb_bill_line_items` table
// (keyed on the synthetic `qbo:<Id>` so zoho_bill_id joins bills.zoho_id), which
// is what "Purchases by Item" and the purchase-tax reports read.
async function syncBillLineItems(conn, userId, realmId, bill, keyBase) {
  const lines = bill.Line || [];
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
    const item = qboBillLineItem(ln);
    if (!item) continue;
    const det = ln.ItemBasedExpenseLineDetail || ln.AccountBasedExpenseLineDetail || {};
    const amount = parseFloat(ln.Amount ?? 0);
    const qty = det.Qty != null ? parseFloat(det.Qty) : 1;
    const rate = det.UnitPrice != null ? parseFloat(det.UnitPrice) : (qty ? amount / qty : 0);
    const lineId = ln.Id != null ? String(ln.Id) : String(ln.LineNum ?? i);
    await conn.execute(
      `INSERT INTO zb_bill_line_items
         (user_id, org_id, zoho_line_item_id, zoho_bill_id, line_position,
          zoho_item_id, item_name, description, account_id, account_name,
          quantity, rate, item_total)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         zoho_bill_id  = VALUES(zoho_bill_id),
         line_position = VALUES(line_position),
         zoho_item_id  = VALUES(zoho_item_id),
         item_name     = VALUES(item_name),
         description   = VALUES(description),
         account_id    = VALUES(account_id),
         account_name  = VALUES(account_name),
         quantity      = VALUES(quantity),
         rate          = VALUES(rate),
         item_total    = VALUES(item_total)`,
      [
        userId, realmId, `${keyBase}:${lineId}`, keyBase,
        ln.LineNum != null ? Number(ln.LineNum) : i,
        item.id, item.name.slice(0, 255), ln.Description || null,
        det.AccountRef?.value || null, det.AccountRef?.name || null,
        qty, rate, amount,
      ]
    );
  }
}

// ── Sync bills ────────────────────────────────────────────────────────────────
async function syncBills(userId, accessToken, realmId, environment) {
  const bills = await fetchAllEntities(realmId, accessToken, environment, 'Bill');
  if (bills.length === 0) return 0;

  const hasLineItems = await tableExists('zb_bill_line_items');
  const conn = await pool.getConnection();
  try {
    for (const b of bills) {
      const syntheticZohoId = `qbo:${b.Id}`;
      const total = parseFloat(b.TotalAmt ?? 0);
      const balance = parseFloat(b.Balance ?? 0);
      const status = balance <= 0 ? 'paid' : 'open';
      await conn.execute(
        `INSERT INTO bills
           (user_id, org_id, zoho_id, qbo_id, bill_number, vendor_name,
            date, due_date, total, balance, status, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           qbo_id      = VALUES(qbo_id),
           bill_number = VALUES(bill_number),
           vendor_name = VALUES(vendor_name),
           date        = VALUES(date),
           due_date    = VALUES(due_date),
           total       = VALUES(total),
           balance     = VALUES(balance),
           status      = VALUES(status),
           synced_at   = NOW()`,
        [
          userId, realmId, syntheticZohoId, b.Id,
          b.DocNumber || null,
          b.VendorRef?.name || null,
          b.TxnDate || null,
          b.DueDate || null,
          total, balance, status,
        ]
      );
      if (hasLineItems) await syncBillLineItems(conn, userId, realmId, b, syntheticZohoId);
    }
  } finally {
    conn.release();
  }
  return bills.length;
}

// ── Sync expenses (QBO "Purchase" entity) ─────────────────────────────────────
async function syncExpenses(userId, accessToken, realmId, environment) {
  const purchases = await fetchAllEntities(realmId, accessToken, environment, 'Purchase');
  if (purchases.length === 0) return 0;

  const conn = await pool.getConnection();
  try {
    for (const p of purchases) {
      const syntheticZohoId = `qbo:${p.Id}`;
      const total = parseFloat(p.TotalAmt ?? 0);
      // The expense's account is typically the FIRST AccountBasedExpenseLineDetail line.
      const firstLine = (p.Line || []).find((ln) => ln.DetailType === 'AccountBasedExpenseLineDetail');
      const accountName = firstLine?.AccountBasedExpenseLineDetail?.AccountRef?.name || null;
      const vendorName = p.EntityRef?.name || null;
      const description = (p.Line || [])
        .map((ln) => ln.Description)
        .filter(Boolean)
        .join(' | ') || p.PrivateNote || null;
      await conn.execute(
        `INSERT INTO expense_entries
           (user_id, org_id, zoho_id, qbo_id, account_name, expense_date,
            amount, vendor_name, description, status, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           qbo_id        = VALUES(qbo_id),
           account_name  = VALUES(account_name),
           expense_date  = VALUES(expense_date),
           amount        = VALUES(amount),
           vendor_name   = VALUES(vendor_name),
           description   = VALUES(description),
           status        = VALUES(status),
           synced_at     = NOW()`,
        [
          userId, realmId, syntheticZohoId, p.Id,
          accountName, p.TxnDate || null,
          total, vendorName, description,
          p.PaymentType || 'recorded',
        ]
      );
    }
  } finally {
    conn.release();
  }
  return purchases.length;
}

// ── Sync customer payments (QBO "Payment" entity) ─────────────────────────────
// Into the shared `zb_customer_payments` table (already populated by Zoho with
// real `unused_amount` data) using the same `qbo:<Id>` synthetic-id pattern as
// syncBills/syncExpenses. This is what lets the AR Aging Detail report include
// standalone unapplied/overpayment customer-payment credits — QuickBooks was
// never syncing Payment entities at all before this, so those credits silently
// vanished from every report that reads this table.
function extractPaymentInvoiceNumbers(payment) {
  const nums = [];
  for (const line of payment.Line || []) {
    for (const item of line.LineEx?.any || []) {
      if (item?.value?.Name === 'txnReferenceNumber' && item?.value?.Value) {
        nums.push(item.value.Value);
      }
    }
  }
  return nums.join(',') || null;
}

async function syncCustomerPayments(userId, accessToken, realmId, environment) {
  const payments = await fetchAllEntities(realmId, accessToken, environment, 'Payment');
  if (payments.length === 0) return 0;

  const conn = await pool.getConnection();
  try {
    for (const p of payments) {
      const syntheticZohoId = `qbo:${p.Id}`;
      const amount = parseFloat(p.TotalAmt ?? 0);
      const unusedAmount = parseFloat(p.UnappliedAmt ?? 0);
      // QBO's Payment entity carries no separate realised-FX figure — set
      // amount_bcy = amount * exchange_rate so this row contributes exactly
      // ZERO to the Realized Gain/Loss report's `amount_bcy − amount*rate`
      // calc instead of fabricating a bogus gain/loss for foreign-currency
      // payments (unlike Zoho, which reports the real booked base amount).
      const exchangeRate = parseFloat(p.ExchangeRate ?? 1) || 1;
      const amountBcy = amount * exchangeRate;
      await conn.execute(
        `INSERT INTO zb_customer_payments
           (user_id, org_id, zoho_payment_id, customer_name, date, amount,
            amount_bcy, exchange_rate, unused_amount, currency_code,
            invoice_numbers, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           customer_name    = VALUES(customer_name),
           date             = VALUES(date),
           amount           = VALUES(amount),
           amount_bcy       = VALUES(amount_bcy),
           exchange_rate    = VALUES(exchange_rate),
           unused_amount    = VALUES(unused_amount),
           currency_code    = VALUES(currency_code),
           invoice_numbers  = VALUES(invoice_numbers),
           synced_at        = NOW()`,
        [
          userId, realmId, syntheticZohoId,
          p.CustomerRef?.name || null,
          p.TxnDate || null,
          amount, amountBcy, exchangeRate, unusedAmount,
          p.CurrencyRef?.value || null,
          extractPaymentInvoiceNumbers(p),
        ]
      );
    }
  } finally {
    conn.release();
  }
  return payments.length;
}

// ── Sync journal entries → account_transactions (shared GL table) ─────────────
// QB JournalEntry has multiple Line items, each with a Posting type (Debit/Credit).
// We write one ledger row per posting line into the existing shared
// `account_transactions` table (the same table Zoho's GL lands in), tagged with
// the platform-unique `qbo_id`. The composite unique key on this table is
// (user_id, transaction_id, transaction_number, account_id); we set
// transaction_id = `qbo:<journalId>` and transaction_number = line index so each
// posting line is unique and the upsert is idempotent.
async function syncJournalEntries(userId, accessToken, realmId, environment) {
  const entries = await fetchAllEntities(realmId, accessToken, environment, 'JournalEntry');
  if (entries.length === 0) return 0;

  let lineCount = 0;
  const conn = await pool.getConnection();
  try {
    for (const je of entries) {
      const lines = (je.Line || []).filter((ln) => ln.DetailType === 'JournalEntryLineDetail');
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        const det = ln.JournalEntryLineDetail || {};
        const amount = parseFloat(ln.Amount ?? 0);
        const isDebit = det.PostingType === 'Debit';
        const txnId = `qbo:${je.Id}`;
        // account_id is part of the unique key and NOT NULL — fall back to a
        // synthetic per-line ref when QB omits the account reference.
        const accountId = det.AccountRef?.value || `qbo:${je.Id}:${i}`;
        await conn.execute(
          `INSERT INTO account_transactions
             (user_id, org_id, platform, transaction_id, account_id, transaction_date,
              account_name, transaction_details, transaction_type,
              transaction_number, reference_number, debit, credit, balance,
              balance_type, source_type, source_id, line_number, tax_type,
              tax_amount, currency_code, synced_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
           ON DUPLICATE KEY UPDATE
             transaction_date    = VALUES(transaction_date),
             account_name        = VALUES(account_name),
             transaction_details = VALUES(transaction_details),
             transaction_type    = VALUES(transaction_type),
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
            userId, String(realmId), 'quickbooks', txnId, String(accountId),
            je.TxnDate || null,
            det.AccountRef?.name || null,
            ln.Description || je.PrivateNote || null,
            'JournalEntry',
            String(i),
            je.DocNumber || null,
            isDebit ? amount : 0,
            isDebit ? 0      : amount,
            amount,
            isDebit ? 'D' : 'C',
            'JournalEntry',
            je.Id,
            i,
            null,
            0,
            je.CurrencyRef?.value || null,
          ]
        );
        lineCount += 1;
      }
    }
  } finally {
    conn.release();
  }
  console.log(`[QBO Journals] Synced ${entries.length} journal entries (${lineCount} lines) for userId=${userId} realmId=${realmId}`);
  return entries.length;
}

// ── Sync FULL general ledger → account_transactions (DB-backed reports) ──────
// QB's GeneralLedger report is the authoritative, COMPLETE double-entry ledger:
// every posting from invoices, bills, payments, expenses AND manual journals,
// tying out to QuickBooks exactly. We store one row per posting line into the
// shared `account_transactions` table (org_id = realm_id) tagged with the
// Zoho-vocabulary account_group + account_type_code so the provider-agnostic
// Zoho report builders (P&L / Balance Sheet / Trial Balance / GL) run straight
// off our DB — NO live QBO Reports call at report time. This REPLACES
// syncJournalEntries: the GL report is a superset that already includes manual
// journal entries, so running both would double-count.
//
// The GeneralLedger report carries no currency column at all, so a row's own
// transaction currency has to be looked up from the source document it came
// from — which every row already identifies via source_type/source_id (the
// report's own "Transaction Type" + entity id). QBO_GL_TYPE_TO_ENTITY maps the
// report's display type string to the Query API entity name needed for that
// lookup; buildQboCurrencyMap fetches each entity type referenced (only the
// types actually present in this report) and keeps just {Id, CurrencyRef}.
const QBO_GL_TYPE_TO_ENTITY = {
  'Journal Entry':               'JournalEntry',
  'Bill':                        'Bill',
  'Invoice':                     'Invoice',
  'Payment':                     'Payment',
  'Bill Payment (Check)':        'BillPayment',
  'Bill Payment (Credit Card)':  'BillPayment',
  'Expense':                     'Purchase',
  'Check':                       'Purchase',
  'Credit Card Expense':         'Purchase',
  'Deposit':                     'Deposit',
  'Transfer':                    'Transfer',
  'Credit Memo':                 'CreditMemo',
  'Vendor Credit':               'VendorCredit',
  'Sales Receipt':               'SalesReceipt',
  'Refund Receipt':              'RefundReceipt',
};

async function buildQboCurrencyMap(realmId, accessToken, environment, neededEntities) {
  const map = {}; // `${entity}:${id}` -> currency code (e.g. 'USD', 'EUR')
  await Promise.all([...neededEntities].map(async (entity) => {
    try {
      const items = await fetchAllEntities(realmId, accessToken, environment, entity);
      for (const item of items) {
        const code = item.CurrencyRef?.value;
        if (code && item.Id != null) map[`${entity}:${item.Id}`] = code;
      }
    } catch (e) {
      console.warn(`[QBO currency map] ${entity} fetch failed:`, e.response?.data?.Fault?.Error?.[0]?.Message || e.message);
    }
  }));
  return map;
}

async function syncGeneralLedger(userId, accessToken, realmId, environment) {
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const qboReports = require('./quickbooksReportsService');

  // 1) Chart of Accounts → classification map (Zoho vocab + normal side).
  const accounts = await fetchAllEntities(realmId, accessToken, environment, 'Account');
  const acctMap = {};
  for (const a of accounts) {
    const group = qbClassificationToGroup(a.Classification);
    const normalSide = (group === 'liability' || group === 'equity' || group === 'income')
      ? 'credit' : 'debit';
    acctMap[String(a.Id)] = {
      name: a.Name || a.FullyQualifiedName || null,
      group,
      code: qbAccountTypeToCode(a.AccountType),
      normalSide,
    };
  }

  // 2) Full-history GL report (company inception → today). Convert each row's
  //    signed, account-natural amount into universal debit/credit via each
  //    account's normal balance side so the ledger ties out (ΣDr == ΣCr).
  const today = new Date().toISOString().slice(0, 10);
  const raw = await qboReports.fetchRawQboReport(realmId, accessToken, environment,
    'GeneralLedger', { start_date: '1901-01-01', end_date: today, minorversion: MINOR_VERSION });
  const gl = qboReports.transformGeneralLedger(raw);
  const classMap = {};
  for (const [id, m] of Object.entries(acctMap)) classMap[id] = m.normalSide;
  qboReports.applyGlNormalSides(gl, classMap);

  // 2.5) Per-row transaction currency (see QBO_GL_TYPE_TO_ENTITY above) — only
  // fetch the entity types this report actually references. Falls back to the
  // company's own home currency ONLY when a row's source document can't be
  // matched to one (e.g. Transfers, which QBO doesn't tag with a CurrencyRef
  // at all) — never substituted for a row whose document DOES carry a currency.
  const typesPresent = new Set();
  for (const r of gl.rows) {
    const entity = QBO_GL_TYPE_TO_ENTITY[r.cells?.type || r.sourceType];
    if (entity) typesPresent.add(entity);
  }
  const currencyMap = await buildQboCurrencyMap(realmId, accessToken, environment, typesPresent);
  const [[orgRow]] = await pool.execute(
    'SELECT currency FROM qbo_organizations WHERE user_id = ? AND realm_id = ? LIMIT 1',
    [userId, String(realmId)]
  ).catch(() => [[null]]);
  const homeCurrency = orgRow?.currency || null;

  // 3) Replace existing GL lines (KEEP the AccountBalance snapshot rows from
  //    syncAccounts — they carry transaction_date = NULL / debit = credit = 0 so
  //    the sum-based builders ignore them) and insert the fresh ledger.
  const conn = await pool.getConnection();
  let n = 0;
  try {
    await conn.beginTransaction();
    await conn.execute(
      `DELETE FROM account_transactions
        WHERE user_id = ? AND org_id = ? AND transaction_type <> 'AccountBalance'`,
      [userId, String(realmId)]
    );
    let idx = 0;
    for (const r of gl.rows) {
      if (r.isHeader || r.isSubtotal || r.isTotal) continue;
      const ref = r.accountRef ? String(r.accountRef) : null;
      if (!ref) continue; // a posting line must belong to an account
      const date = /^\d{4}-\d{2}-\d{2}/.test(String(r.label || ''))
        ? String(r.label).slice(0, 10) : null;
      if (!date) continue; // skip non-dated rows (beginning-balance headers)
      const debit  = round2(r.cells?.debit);
      const credit = round2(r.cells?.credit);
      if (debit === 0 && credit === 0) continue;
      const acct  = acctMap[ref] || {};
      const txnId = r.sourceRef ? `qbo:${r.sourceRef}` : `qbo:gl:${idx}`;
      const glType = r.cells?.type || r.sourceType || null;
      const glEntity = QBO_GL_TYPE_TO_ENTITY[glType];
      const currencyCode =
        (glEntity && r.sourceRef != null && currencyMap[`${glEntity}:${r.sourceRef}`]) || homeCurrency || null;
      await conn.execute(
        `INSERT INTO account_transactions
           (user_id, org_id, platform, transaction_id, account_id, transaction_date,
            account_name, account_group, account_type_code, transaction_details,
            transaction_type, transaction_number, reference_number,
            debit, credit, balance, balance_type,
            source_type, source_id, line_number, tax_type, tax_amount, currency_code, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
        [
          userId, String(realmId), 'quickbooks', txnId, ref, date,
          acct.name || r.cells?.account || null,
          acct.group || null, acct.code || null,
          r.cells?.memo || r.cells?.name || null,
          glType || 'GeneralLedger',
          String(idx),
          r.cells?.docnum || null,
          debit, credit,
          round2(r.cells?.balance != null ? r.cells.balance : debit - credit),
          debit >= credit ? 'D' : 'C',
          glType,
          r.sourceRef || null,
          idx,
          null,
          0,
          currencyCode,
        ]
      );
      idx += 1; n += 1;
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  console.log(`[QBO GL] Stored ${n} general-ledger lines in account_transactions for userId=${userId} realmId=${realmId}`);
  return n;
}

// ── QB Account → account_transactions classification maps ────────────────────
// Reduced-schema deployments have no qbo_accounts master table, so the QB Chart
// of Accounts is stored as one "balance snapshot" row per account in
// account_transactions (transaction_type='AccountBalance'), mirroring how Zoho's
// account-level balances already live there. The dashboard's balance-based
// metrics (Cash on Hand, liquidity, efficiency, compliance) read the latest
// balance + classification per account from this table.

// QB Classification → account_group (asset|liability|equity|income|expense).
function qbClassificationToGroup(classification) {
  switch (String(classification || '').toLowerCase()) {
    case 'asset':     return 'asset';
    case 'liability': return 'liability';
    case 'equity':    return 'equity';
    case 'revenue':   return 'income';
    case 'expense':   return 'expense';
    default:          return null;
  }
}

// QB AccountType → the account_type_code vocabulary the dashboard already uses
// for Zoho (bank, accounts_receivable, accounts_payable, other_current_asset,
// fixed_asset, other_current_liability, …). Unknown types fall back to a
// snake_case slug so nothing is silently lost.
function qbAccountTypeToCode(accountType) {
  const t = String(accountType || '').trim().toLowerCase();
  const map = {
    'bank':                     'bank',
    'accounts receivable':      'accounts_receivable',
    'accounts payable':         'accounts_payable',
    'other current asset':      'other_current_asset',
    'other current assets':     'other_current_asset',
    'fixed asset':              'fixed_asset',
    'other asset':              'other_asset',
    'credit card':              'credit_card',
    'other current liability':  'other_current_liability',
    'long term liability':      'long_term_liability',
    'equity':                   'equity',
    'income':                   'income',
    'other income':             'other_income',
    'expense':                  'expense',
    'other expense':            'other_expense',
    'cost of goods sold':       'cost_of_goods_sold',
  };
  return map[t] || (t ? t.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') : null);
}

// Store QB accounts as AccountBalance snapshot rows in account_transactions.
// Idempotent on the (user_id, transaction_id, transaction_number, account_id)
// unique key. Uses CurrentBalance (own balance, EXCLUDING sub-accounts) so a
// SUM across the whole tree stays correct with no double counting. debit/credit
// are 0 and transaction_date is NULL, so these rows never enter any flow/period
// query — only the "latest balance per account" balance-sheet reads pick them up.
async function writeQBAccountBalances(userId, realmId, accounts) {
  if (!accounts.length) return 0;
  const conn = await pool.getConnection();
  let n = 0;
  try {
    for (const a of accounts) {
      const group   = qbClassificationToGroup(a.Classification);
      const code    = qbAccountTypeToCode(a.AccountType);
      const bal     = parseFloat(a.CurrentBalance ?? 0);
      const balType = (group === 'liability' || group === 'equity' || group === 'income') ? 'C' : 'D';
      await conn.execute(
        `INSERT INTO account_transactions
           (user_id, org_id, platform, transaction_id, account_id, transaction_date,
            account_name, account_group, account_type_code, transaction_details,
            transaction_type, transaction_number, reference_number,
            debit, credit, balance, balance_type,
            source_type, source_id, line_number, tax_type, tax_amount, currency_code, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           account_name      = VALUES(account_name),
           account_group     = VALUES(account_group),
           account_type_code = VALUES(account_type_code),
           balance           = VALUES(balance),
           balance_type      = VALUES(balance_type),
           source_type       = VALUES(source_type),
           source_id         = VALUES(source_id),
           currency_code     = VALUES(currency_code),
           synced_at         = NOW()`,
        [
          userId, String(realmId), 'quickbooks', `qbo:acct:${a.Id}`, String(a.Id), null,
          a.Name || a.FullyQualifiedName || null, group, code, null,
          'AccountBalance', '', null,
          0, 0, bal, balType,
          'AccountBalance', a.Id, 0, null, 0, a.CurrencyRef?.value || null,
        ]
      );
      n += 1;
    }
  } finally { conn.release(); }
  console.log(`[QBO Accounts] Stored ${n} account-balance snapshots in account_transactions for userId=${userId} realmId=${realmId}`);
  return n;
}

// ── Sync Chart of Accounts (QBO Account entity) ──────────────────────────────
// QB API ref: https://developer.intuit.com/.../api/accounting/all-entities/account
async function syncAccounts(userId, accessToken, realmId, environment) {
  const accounts = await fetchAllEntities(realmId, accessToken, environment, 'Account');
  if (accounts.length === 0) return 0;

  // Reduced-schema deployments (no qbo_accounts master table) store the Chart of
  // Accounts as AccountBalance snapshot rows in account_transactions instead, so
  // the dashboard's balance-based metrics work without the dedicated table.
  if (!(await tableExists('qbo_accounts'))) {
    return writeQBAccountBalances(userId, realmId, accounts);
  }

  // Normalise QB datetime ('2024-04-12T08:30:00-07:00') → MySQL DATETIME
  const toMysqlDt = (iso) => {
    if (!iso) return null;
    try { return new Date(iso).toISOString().slice(0, 19).replace('T', ' '); }
    catch { return null; }
  };

  const conn = await pool.getConnection();
  try {
    for (const a of accounts) {
      await conn.execute(
        `INSERT INTO qbo_accounts
           (user_id, realm_id, qbo_id, name, fully_qualified_name,
            account_type, account_sub_type, classification, account_number,
            description, current_balance, current_balance_with_sub_accounts,
            currency, parent_qbo_id, is_sub_account, active,
            qbo_created_at, qbo_updated_at, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
         ON DUPLICATE KEY UPDATE
           name                              = VALUES(name),
           fully_qualified_name              = VALUES(fully_qualified_name),
           account_type                      = VALUES(account_type),
           account_sub_type                  = VALUES(account_sub_type),
           classification                    = VALUES(classification),
           account_number                    = VALUES(account_number),
           description                       = VALUES(description),
           current_balance                   = VALUES(current_balance),
           current_balance_with_sub_accounts = VALUES(current_balance_with_sub_accounts),
           currency                          = VALUES(currency),
           parent_qbo_id                     = VALUES(parent_qbo_id),
           is_sub_account                    = VALUES(is_sub_account),
           active                            = VALUES(active),
           qbo_created_at                    = VALUES(qbo_created_at),
           qbo_updated_at                    = VALUES(qbo_updated_at),
           synced_at                         = NOW()`,
        [
          userId, realmId, a.Id,
          a.Name || null,
          a.FullyQualifiedName || null,
          a.AccountType || null,
          a.AccountSubType || null,
          a.Classification || null,
          a.AcctNum || null,
          a.Description || null,
          parseFloat(a.CurrentBalance ?? 0),
          parseFloat(a.CurrentBalanceWithSubAccounts ?? 0),
          a.CurrencyRef?.value || null,
          a.ParentRef?.value || null,
          a.SubAccount ? 1 : 0,
          a.Active === false ? 0 : 1,
          toMysqlDt(a.MetaData?.CreateTime),
          toMysqlDt(a.MetaData?.LastUpdatedTime),
        ]
      );
    }
  } finally {
    conn.release();
  }
  // Bust the read cache so /api/quickbooks/accounts reflects the fresh sync
  // immediately rather than waiting out the TTL (ENHANCEMENTS Task E).
  cache.invalidate('qbo-accounts');
  cache.invalidate('qbo-accounts-summary');
  console.log(`[QBO Accounts] Synced ${accounts.length} accounts for userId=${userId} realmId=${realmId}`);
  return accounts.length;
}

// ── Master sync ──────────────────────────────────────────────────────────────
async function syncAllQBOData(userId, accessToken, realmId, environment) {
  console.log(`[QBO Sync] Starting userId=${userId} realmId=${realmId} env=${environment}`);
  const results = await Promise.allSettled([
    syncAccounts(userId, accessToken, realmId, environment),
    syncCustomers(userId, accessToken, realmId, environment),
    syncVendors(userId, accessToken, realmId, environment),
    syncInvoices(userId, accessToken, realmId, environment),
    syncSalesReceipts(userId, accessToken, realmId, environment),
    syncBills(userId, accessToken, realmId, environment),
    syncExpenses(userId, accessToken, realmId, environment),
    syncCustomerPayments(userId, accessToken, realmId, environment),
  ]);
  const [acct, cust, vend, inv, srec, bil, exp, cpay] = results.map((r) =>
    r.status === 'fulfilled' ? r.value : `ERR: ${r.reason?.message}`
  );
  // Build the FULL general ledger AFTER the accounts sync (it needs the Chart
  // of Accounts for classification). Run sequentially + isolated so a GL
  // failure never aborts the entity sync above. This is what powers the
  // DB-backed QB reports (no live QBO Reports call at report time).
  let gl;
  try {
    gl = await syncGeneralLedger(userId, accessToken, realmId, environment);
  } catch (e) {
    gl = `ERR: ${e.message}`;
    console.error('[QBO Sync] general ledger failed:', e.message);
  }
  console.log(`[QBO Sync] Done — accounts:${acct} customers:${cust} vendors:${vend} invoices:${inv} salesReceipts:${srec} bills:${bil} expenses:${exp} customerPayments:${cpay} ledger:${gl}`);
}

// ── Fetch CompanyInfo to get the company name / country / currency ───────────
async function fetchCompanyInfo(accessToken, realmId, environment) {
  const apiBase = getApiBase(environment);
  try {
    const res = await axios.get(
      `${apiBase}/v3/company/${realmId}/companyinfo/${realmId}`,
      { headers: qboHeaders(accessToken), params: { minorversion: MINOR_VERSION } }
    );
    const info = res.data?.CompanyInfo || {};

    // QBO CompanyInfo has NO home-currency field — the previous code stored
    // `SupportedLanguages` ("en") here by mistake. The home currency lives in
    // the Preferences entity (CurrencyPrefs.HomeCurrency). Fetch it best-effort.
    let currency = null;
    try {
      const pref = await axios.get(
        `${apiBase}/v3/company/${realmId}/preferences`,
        { headers: qboHeaders(accessToken), params: { minorversion: MINOR_VERSION } }
      );
      currency = pref.data?.Preferences?.CurrencyPrefs?.HomeCurrency?.value || null;
    } catch (pe) {
      console.warn('[QBO] preferences (home currency) fetch failed:', pe.response?.data || pe.message);
    }

    return {
      companyName:      info.CompanyName || null,
      legalName:        info.LegalName || null,
      country:          info.Country || null,
      currency,
      fiscalYearStart:  info.FiscalYearStartMonth || null,
    };
  } catch (e) {
    console.warn('[QBO] companyinfo fetch failed:', e.response?.data || e.message);
    return {};
  }
}

// ── Exchange authorization code for tokens (used by callback / exchange) ─────
async function exchangeCodeForTokens(code, redirectUri) {
  const basic = Buffer
    .from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`)
    .toString('base64');
  const params = new URLSearchParams({
    grant_type:   'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const res = await axios.post(QBO_TOKEN_URL, params.toString(), {
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
  });
  return res.data; // { access_token, refresh_token, expires_in, x_refresh_token_expires_in, token_type }
}

// ── Revoke a token (called on disconnect) ────────────────────────────────────
async function revokeToken(token) {
  if (!token) return;
  const basic = Buffer
    .from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`)
    .toString('base64');
  try {
    await axios.post(QBO_REVOKE_URL, { token }, {
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
  } catch { /* best-effort */ }
}

// ── Get a valid access token, refreshing if necessary ────────────────────────
// `realmId` (optional) selects a specific connected company once qbo_tokens
// holds more than one row per user (db/multi-org-migration.sql). Before that
// migration there is only ever one row, so the arg is a no-op. When it's given
// but no matching row exists we fall back to the user's active/only row.
async function getValidQBOToken(userId, realmId = null) {
  let rows;
  if (realmId) {
    [rows] = await pool.execute(
      'SELECT access_token, refresh_token, expires_at, realm_id, environment FROM qbo_tokens WHERE user_id = ? AND realm_id = ? LIMIT 1',
      [userId, String(realmId)]
    );
  }
  if (!rows || !rows[0]) {
    // Prefer the active row when the is_active column exists; otherwise any row.
    try {
      [rows] = await pool.execute(
        `SELECT access_token, refresh_token, expires_at, realm_id, environment
           FROM qbo_tokens WHERE user_id = ?
          ORDER BY COALESCE(is_active, 1) DESC, updated_at DESC LIMIT 1`,
        [userId]
      );
    } catch (_) {
      [rows] = await pool.execute(
        'SELECT access_token, refresh_token, expires_at, realm_id, environment FROM qbo_tokens WHERE user_id = ? LIMIT 1',
        [userId]
      );
    }
  }
  if (!rows[0]) return null;

  const tok = rows[0];
  if (!tok.expires_at || Date.now() < Number(tok.expires_at) - 60_000) {
    return { accessToken: tok.access_token, realmId: tok.realm_id, environment: tok.environment };
  }
  if (!tok.refresh_token) return null;

  const fresh = await refreshQBOToken(userId, tok.refresh_token, tok.realm_id);
  return {
    accessToken: fresh.access_token,
    realmId:     tok.realm_id,
    environment: tok.environment,
  };
}

// ── Effective QB user resolver ──────────────────────────────────────────────
// Returns the user_id whose qbo_tokens/qbo_accounts rows should be used for
// the given requester.
//
// • If the requester has their own qbo_tokens row → use their own user_id.
// • Otherwise, if the requester is a CLIENT whose users.integration_type is
//   'quickbooks', fall back to the first admin who has a qbo_tokens row.
//   This is the "company-owned connection" model: a single admin connects
//   QuickBooks once, and all client users tagged for QB share that view.
// • In all other cases, return the requester's id unchanged (which yields
//   an empty result set, the correct outcome for unconnected users).
async function getEffectiveQBUserId(userId) {
  const [own] = await pool.execute(
    'SELECT 1 FROM qbo_tokens WHERE user_id = ? LIMIT 1',
    [userId]
  );
  if (own.length) return userId;

  const [u] = await pool.execute(
    'SELECT role, integration_type FROM users WHERE id = ? LIMIT 1',
    [userId]
  );
  if (!u[0]) return userId;
  if (u[0].role === 'client' && u[0].integration_type === 'quickbooks') {
    const [admin] = await pool.execute(
      `SELECT u.id
         FROM users u
         JOIN qbo_tokens t ON t.user_id = u.id
        WHERE u.role = 'admin'
        ORDER BY u.id ASC
        LIMIT 1`
    );
    if (admin[0]) return admin[0].id;
  }
  return userId;
}

// ── Refresh access token. Intuit rotates refresh tokens — store the new one. ─
async function refreshQBOToken(userId, currentRefreshToken, realmId = null) {
  const basic = Buffer
    .from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`)
    .toString('base64');
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: currentRefreshToken,
  });
  let res;
  try {
    res = await axios.post(QBO_TOKEN_URL, params.toString(), {
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    });
  } catch (e) {
    // Intuit rejected the refresh (revoked, expired >100d, or the token belongs
    // to a different OAuth app than QBO_CLIENT_ID).
    throw reauthError('quickbooks', e.response?.data?.error_description || e.response?.data?.error || e.message);
  }
  const { access_token, refresh_token, expires_in } = res.data;
  if (!access_token) throw reauthError('quickbooks', res.data?.error || 'no access_token returned');

  const expires_at = Date.now() + (expires_in ?? 3600) * 1000;
  // Scope the write to the specific realm when given (multi-company); otherwise
  // update the user's row(s) as before.
  const where = realmId ? 'WHERE user_id = ? AND realm_id = ?' : 'WHERE user_id = ?';
  const args = realmId
    ? [access_token, refresh_token ?? null, expires_at, userId, String(realmId)]
    : [access_token, refresh_token ?? null, expires_at, userId];
  await pool.execute(
    `UPDATE qbo_tokens
       SET access_token  = ?,
           refresh_token = COALESCE(?, refresh_token),
           expires_at    = ?,
           updated_at    = NOW()
     ${where}`,
    args
  );
  return { access_token, refresh_token: refresh_token ?? currentRefreshToken, expires_at };
}

module.exports = {
  // OAuth
  QBO_AUTH_URL,
  QBO_TOKEN_URL,
  QBO_REVOKE_URL,
  getApiBase,
  exchangeCodeForTokens,
  refreshQBOToken,
  revokeToken,
  getValidQBOToken,
  getEffectiveQBUserId,
  fetchCompanyInfo,
  // Sync
  syncAllQBOData,
  syncAccounts,
  syncCustomers,
  syncVendors,
  syncInvoices,
  syncSalesReceipts,
  syncBills,
  syncExpenses,
  syncCustomerPayments,
  syncJournalEntries,
  syncGeneralLedger,
};
