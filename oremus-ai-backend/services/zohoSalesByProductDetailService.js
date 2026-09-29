'use strict';

/**
 * Sales by Product/Service Detail — ONE provider-agnostic builder (Zoho, QB, Xero).
 * ---------------------------------------------------------------------------
 * Line-level sales grouped by the product/service actually recorded on the
 * invoice line, modelled on QuickBooks' "Sales by Product/Service Detail":
 *
 *   <Product/Service>
 *     <date>  Invoice  <num>  <customer>  <description>  <qty>  <price>  <amount>  <bal>
 *     ...
 *   Total for <Product/Service>                              <qty>        <amount>
 *   ...
 *   TOTAL                                                    <qty>        <amount>
 *
 * PRIMARY SOURCE: the shared `account_transactions` ledger table.  For Xero,
 * Zoho, and QuickBooks, every ACCREC / ACCRECCREDIT entry carries:
 *   - `account_name`          → acts as the product/service (revenue account)
 *   - `transaction_details`   → customer name
 *   - `reference_number`      → invoice number
 *   - `transaction_date`      → date
 *   - `credit - debit`        → net sale amount
 *
 * FALLBACK: the `zb_invoice_line_items` table (Zoho only — it syncs per-line
 * product/qty/rate).  This is used when `account_transactions` has no ACCREC
 * income lines (e.g. a brand-new connection before first sync).
 *
 * ⚠️ An invoice with NO synced lines is therefore SKIPPED, never emitted as a
 * whole-invoice "Uncategorized" row.  When a connection has no data at all the
 * report is honestly `unavailable` with a message saying why.
 *
 * A line with no item on it (an account-based line) groups under
 * "Not Specified", exactly as QuickBooks labels it — that line is real, only
 * its product reference is absent.
 */

const pool = require('../config/db');
const { invoiceFxContext, rateToBase } = require('./invoiceFx');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// DD/MM/YYYY, the same display format every other report in this suite uses.
function fmtDate(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d).slice(0, 10);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${dt.getFullYear()}`;
}

// YYYY-MM-DD for a DB date (Date or string). Rows keep this and are formatted
// once for display — formatting twice swapped day and month for days ≤ 12.
function isoDate(d) {
  if (!d) return '';
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return String(d).slice(0, 10);
}

function resolveRange(params) {
  const from = params.from_date || params.date_start || params.from || null;
  const to = params.to_date || params.date_end || params.to || null;
  if (from && to) return { from, to };
  // Default to the current Indian fiscal year (Apr–Mar), like the other reports.
  // Default window: the fiscal year containing today, for the per-platform
  // start month (Settings → params.fy_start_month; defaults to 4 = 1 April).
  const { fyWindow, fyMonth } = require('./reportContext');
  const _fy = fyWindow(fyMonth(params.fy_start_month));
  return { from: from || _fy.from, to: to || _fy.to };
}

// Resolve org_id from any platform's token table.
async function resolveOrgId(userId, paramsOrgId) {
  if (paramsOrgId) return paramsOrgId;
  const [[zoho]] = await pool.execute(
    'SELECT org_id FROM zb_tokens WHERE user_id = ? LIMIT 1', [userId]
  );
  if (zoho?.org_id) return zoho.org_id;
  const [[xero]] = await pool.execute(
    'SELECT tenant_id AS org_id FROM xero_tokens WHERE user_id = ? LIMIT 1', [userId]
  );
  if (xero?.org_id) return xero.org_id;
  const [[qbo]] = await pool.execute(
    'SELECT realm_id AS org_id FROM qbo_tokens WHERE user_id = ? LIMIT 1', [userId]
  );
  return qbo?.org_id || null;
}

// Detect which platform the user is connected to.
async function detectPlatform(userId) {
  const [[xero]] = await pool.execute(
    'SELECT 1 FROM xero_tokens WHERE user_id = ? LIMIT 1', [userId]
  );
  if (xero) return 'xero';
  const [[qbo]] = await pool.execute(
    'SELECT 1 FROM qbo_tokens WHERE user_id = ? LIMIT 1', [userId]
  );
  if (qbo) return 'quickbooks';
  return 'zoho';
}

const COLUMNS = [
  { key: 'label',    label: 'Transaction date',   align: 'left'  },
  { key: 'type',     label: 'Transaction type',   align: 'left'  },
  { key: 'num',      label: 'Num',                align: 'left'  },
  { key: 'customer', label: 'Customer full name', align: 'left'  },
  { key: 'desc',     label: 'Description',        align: 'left'  },
  { key: 'qty',      label: 'Quantity',           align: 'right', money: false },
  { key: 'price',    label: 'Sales price',        align: 'right' },
  { key: 'amount',   label: 'Amount',             align: 'right' },
  { key: 'balance',  label: 'Balance',            align: 'right' },
];

/**
 * Build the report from `account_transactions` — works for all 3 platforms.
 * The `account_name` on the income line acts as the product/service.
 */
async function buildFromAccountTransactions(userId, orgId, from, to) {
  const [rows] = await pool.execute(
    `SELECT at.transaction_details AS customer,
            at.reference_number    AS invoice_number,
            DATE_FORMAT(at.transaction_date, '%Y-%m-%d') AS d,
            at.account_name        AS product,
            at.transaction_details AS description,
            ROUND(COALESCE(at.base_credit, at.credit) - COALESCE(at.base_debit, at.debit), 2) AS amount,
            COALESCE(at.base_currency_code, at.currency_code) AS currency_code,
            at.source_type
       FROM account_transactions at
      WHERE at.user_id = ? AND at.org_id = ?
        AND at.source_type IN ('ACCREC', 'ACCRECCREDIT')
        AND at.account_group = 'income'
        AND at.transaction_date BETWEEN ? AND ?
      ORDER BY at.account_name, at.transaction_date, at.reference_number`,
    [userId, orgId, from, to]
  );
  return rows;
}

/**
 * Fallback: build from `zb_invoice_line_items` (Zoho — has per-line product/qty/rate).
 */
async function buildFromInvoiceLineItems(userId, orgId, from, to) {
  const [lines] = await pool.execute(
    `SELECT COALESCE(NULLIF(TRIM(li.item_name), ''), NULLIF(TRIM(li.name), '')) AS product,
            li.description, li.quantity, li.rate, li.item_total, li.tax_amount,
            li.zoho_invoice_id, inv.invoice_number, inv.customer_name, inv.date,
            ROUND(inv.tax_total, 2) AS tax_total, inv.currency_code, inv.exchange_rate
       FROM zb_invoice_line_items li
       JOIN invoices inv
         ON inv.zoho_id = li.zoho_invoice_id
        AND inv.user_id = li.user_id
        AND inv.org_id  = li.org_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND inv.date BETWEEN ? AND ?
        AND LOWER(COALESCE(inv.status, '')) NOT IN ('draft', 'approved', 'void')
      ORDER BY inv.date ASC, inv.invoice_number ASC, li.line_position ASC`,
    [userId, orgId, from, to]
  );
  return lines;
}

async function isQuickBooksOrg(orgId) {
  const [[r]] = await pool.execute('SELECT 1 AS x FROM qbo_organizations WHERE realm_id = ? LIMIT 1', [String(orgId)])
    .catch(() => [[null]]);
  return !!r;
}

// QuickBooks sales documents that post to income accounts — the transaction
// types its Sales by Product/Service Detail lists.
const QBO_SALES_TYPES = ['Invoice', 'Sales Receipt', 'Credit Memo', 'Refund Receipt'];

// Every credit memo in the ledger (any date — claiming payments needs them all),
// as { id: 'qbo:<id>', date, customer } with the customer when a line names one.
async function qboAllCreditMemos(userId, orgId, customers) {
  const [rows] = await pool.execute(
    `SELECT source_id, DATE_FORMAT(MIN(transaction_date), '%Y-%m-%d') AS d,
            GROUP_CONCAT(DISTINCT TRIM(transaction_details) SEPARATOR '\u001f') AS texts
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND source_type = 'Credit Memo'
      GROUP BY source_id`,
    [userId, orgId]
  );
  return rows.map((r) => ({
    id: `qbo:${r.source_id}`,
    date: r.d,
    customer: String(r.texts || '').split('\u001f').map((t) => t.trim()).find((t) => customers.has(t.toLowerCase())) || '',
  }));
}

/**
 * QuickBooks sales documents with no synced line items, one row per income-
 * account line of the ledger (already in the home currency): product = the
 * income account, description = the line's text, customer = the document's
 * A/R (or other non-income) line name. Credit/refund lines debit income and so
 * come out negative. `covered` = documents already reported from line items
 * ("qbo:<id>"), which are skipped so nothing is counted twice.
 */
async function qboLedgerSalesRows(userId, orgId, from, to, covered) {
  const ph = QBO_SALES_TYPES.map(() => '?').join(',');
  const [lines] = await pool.execute(
    `SELECT source_type, source_id, reference_number, transaction_date,
            account_name, account_group, transaction_details,
            COALESCE(base_credit, credit) - COALESCE(base_debit, debit) AS net
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND source_type IN (${ph})
        AND transaction_date BETWEEN ? AND ?
      ORDER BY transaction_date, source_id, id`,
    [userId, orgId, ...QBO_SALES_TYPES, from, `${to} 23:59:59`]
  );
  // The GL Name column holds the customer; when it's blank the line carries its
  // memo instead, so prefer a line whose text is a known customer name.
  const [cust] = await pool.execute(
    `SELECT DISTINCT TRIM(customer_name) AS n FROM invoices WHERE user_id = ? AND org_id = ? AND COALESCE(customer_name, '') <> ''
     UNION SELECT DISTINCT TRIM(contact_name) FROM customers WHERE user_id = ? AND org_id = ? AND COALESCE(contact_name, '') <> ''`,
    [userId, orgId, userId, orgId]
  ).catch(() => [[]]);
  const customers = new Set(cust.map((c) => String(c.n).toLowerCase()));
  const docs = new Map();
  for (const l of lines) {
    const id = `qbo:${l.source_id}`;
    if (covered.has(id)) continue;
    if (!docs.has(id)) docs.set(id, { customer: '', lines: [] });
    const d = docs.get(id);
    const text = String(l.transaction_details || '').trim();
    if (l.account_group === 'income') d.lines.push(l);
    if (!text) continue;
    // A memo is never shown as the customer; unknown stays blank.
    if (!d.customer && customers.has(text.toLowerCase())) d.customer = text;
  }
  const itemOf = await qboItemByAccount(userId, orgId);
  const memoCustomer = await qboCreditMemoCustomers(userId, orgId, await qboAllCreditMemos(userId, orgId, customers));
  const out = [];
  for (const [id, d] of docs) {
    for (const l of d.lines) {
      out.push({
        customer:       d.customer || memoCustomer.get(id) || '',
        invoice_number: l.reference_number || '',
        d:              isoDate(l.transaction_date),
        product:        itemOf.get(l.account_name) || l.account_name || 'Not Specified',
        description:    l.transaction_details || '',
        amount:         round2(num(l.net)),
        source_type:    'LEDGER',
        _type:          l.source_type,
      });
    }
  }
  return out;
}

// QuickBooks groups this report by ITEM, but a document without synced line
// items only has its income ACCOUNT in the ledger ("License/Saas Fees" vs the
// item "License /Saas Fees"). Learn account → item from invoices that have
// both: a line item and a ledger income line of the same document and amount
// pair up; each account takes the item it pairs with most often.
async function qboItemByAccount(userId, orgId) {
  const [pairs] = await pool.execute(
    `SELECT at.account_name,
            COALESCE(NULLIF(TRIM(li.item_name), ''), NULLIF(TRIM(li.name), '')) AS item,
            COUNT(*) AS n
       FROM account_transactions at
       JOIN zb_invoice_line_items li
         ON li.user_id = at.user_id
        AND li.org_id COLLATE utf8mb4_unicode_ci = at.org_id COLLATE utf8mb4_unicode_ci
        AND li.zoho_invoice_id COLLATE utf8mb4_unicode_ci = CONCAT('qbo:', at.source_id) COLLATE utf8mb4_unicode_ci
      WHERE at.user_id = ? AND at.org_id = ? AND at.source_type = 'Invoice' AND at.account_group = 'income'
        AND ABS((at.credit - at.debit) - li.item_total) < 0.01
      GROUP BY at.account_name, item`,
    [userId, orgId]
  );
  const best = new Map();
  for (const p of pairs) {
    if (!p.item) continue;
    const cur = best.get(p.account_name);
    if (!cur || Number(p.n) > cur.n) best.set(p.account_name, { item: p.item, n: Number(p.n) });
  }
  return new Map([...best].map(([k, v]) => [k, v.item]));
}

// Customer of a credit memo whose ledger lines carry no customer name.
// QuickBooks applies a credit memo to an invoice through a zero-amount Payment
// of the SAME customer, dated on or after the credit memo. Credit memos with a
// known customer claim their own such payment first; each remaining one takes
// the nearest unclaimed zero-amount payment within 90 days after it.
async function qboCreditMemoCustomers(userId, orgId, memos) {
  const unknown = memos.filter((m) => !m.customer);
  if (!unknown.length) return new Map();
  const [pays] = await pool.execute(
    `SELECT zoho_payment_id, TRIM(customer_name) AS customer, DATE_FORMAT(date, '%Y-%m-%d') AS d
       FROM zb_customer_payments
      WHERE user_id = ? AND org_id = ? AND COALESCE(is_deleted, 0) = 0 AND amount = 0
      ORDER BY date, zoho_payment_id`,
    [userId, orgId]
  );
  const claimed = new Set();
  const nearest = (m, sameCustomer) => pays.find((p) => !claimed.has(p.zoho_payment_id)
    && p.d >= m.date
    && (Date.parse(p.d) - Date.parse(m.date)) / 86400000 <= 90
    && (!sameCustomer || p.customer.toLowerCase() === m.customer.toLowerCase()));
  for (const m of [...memos].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!m.customer) continue;
    const p = nearest(m, true);
    if (p) claimed.add(p.zoho_payment_id);
  }
  const out = new Map();
  for (const m of [...unknown].sort((a, b) => a.date.localeCompare(b.date))) {
    const p = nearest(m, false);
    if (!p) continue;
    claimed.add(p.zoho_payment_id);
    out.set(m.id, p.customer);
  }
  return out;
}

// QuickBooks' realised exchange gain/loss account on customer documents.
const FX_ACCOUNT_RE = /exchange\s*(gain|loss)|reali[sz]ed\s*(currency|exchange)\s*(gain|loss)/i;
const QBO_CUSTOMER_DOC_TYPES = ['Payment', 'Invoice', 'Credit Memo', 'Sales Receipt', 'Refund Receipt'];

/**
 * Exchange gain/loss on QuickBooks customer documents. When a foreign-currency
 * invoice is paid (or a credit applied) at a different rate, QuickBooks posts
 * the difference to its Exchange Gain or Loss account on that Payment, and
 * lists it in this report under "Not Specified" — one row per such line, as
 * the document's own type/number/date/customer. Gain = positive, loss =
 * negative. These lines are never on an income account, so they can't
 * duplicate an invoice/credit-memo row.
 */
async function qboExchangeGainLossRows(userId, orgId, from, to) {
  const ph = QBO_CUSTOMER_DOC_TYPES.map(() => '?').join(',');
  const [lines] = await pool.execute(
    `SELECT id, source_type, source_id, reference_number, transaction_date,
            account_name, transaction_details,
            COALESCE(base_credit, credit) - COALESCE(base_debit, debit) AS net
       FROM account_transactions
      WHERE user_id = ? AND org_id = ? AND source_type IN (${ph})
        AND source_id IN (
              SELECT source_id FROM account_transactions
               WHERE user_id = ? AND org_id = ? AND source_type IN (${ph})
                 AND transaction_date BETWEEN ? AND ?
                 AND account_name REGEXP 'exchange[[:space:]]*(gain|loss)|reali[sz]ed[[:space:]]*(currency|exchange)[[:space:]]*(gain|loss)')
      ORDER BY transaction_date, source_id, id`,
    [userId, orgId, ...QBO_CUSTOMER_DOC_TYPES, userId, orgId, ...QBO_CUSTOMER_DOC_TYPES, from, `${to} 23:59:59`]
  );
  // Customer = the document's A/R (or bank) line Name.
  const customerOf = new Map();
  for (const l of lines) {
    const key = `${l.source_type}|${l.source_id}`;
    if (!FX_ACCOUNT_RE.test(l.account_name || '') && l.transaction_details && !customerOf.has(key)) {
      customerOf.set(key, String(l.transaction_details).trim());
    }
  }
  const out = [];
  for (const l of lines) {
    if (!FX_ACCOUNT_RE.test(l.account_name || '')) continue;
    if (round2(num(l.net)) === 0) continue;
    out.push({
      customer:       customerOf.get(`${l.source_type}|${l.source_id}`) || '',
      invoice_number: l.reference_number || '',
      d:              isoDate(l.transaction_date),
      product:        'Not Specified',
      description:    '',
      amount:         round2(num(l.net)),
      source_type:    'LEDGER',
      _type:          l.source_type,
    });
  }
  return out;
}

/**
 * @param {number} userId  effective connection owner
 * @param {object} params  { from_date, to_date, org_id }
 */
async function buildSalesByProductDetail(userId, params = {}) {
  const orgId = await resolveOrgId(userId, params.org_id);
  if (!orgId) {
    const err = new Error('Provider not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const { from, to } = resolveRange(params);
  const meta = { title: 'Sales by Product/Service Detail', basis: 'Accrual', from, to, source: 'ledger' };

  // ── Primary: account_transactions (all 3 platforms) ──
  const txnRows = await buildFromAccountTransactions(userId, orgId, from, to);

  // ── Fallback: zb_invoice_line_items (Zoho with per-line product data) ──
  let productRows = txnRows;
  let hasLineItems = false;
  if (!txnRows.length) {
    const lines = await buildFromInvoiceLineItems(userId, orgId, from, to);
    if (lines.length) {
      // Zoho keeps sales tax at the INVOICE level (invoices.tax_total — its line
      // items carry tax_amount = 0), so raw item_total prints tax-exclusive and
      // disagreed with the tax-inclusive Sales by Customer reports. Spread each
      // invoice's tax over its lines in proportion to every line's share of the
      // invoice (remainder on the last line keeps each invoice exact). Lines
      // already carrying their own tax, and invoices with tax_total = 0
      // (Xero/QuickBooks), are left untouched.
      const byInvoice = new Map();
      for (const ln of lines) {
        const k = String(ln.zoho_invoice_id ?? `${ln.invoice_number}|${ln.customer_name}`);
        if (!byInvoice.has(k)) byInvoice.set(k, []);
        byInvoice.get(k).push(ln);
      }
      const spreadAmt = new Map();
      for (const invLines of byInvoice.values()) {
        const invTax = Number(invLines[0]?.tax_total) || 0;
        const lineTaxSum = invLines.reduce((s, ln) => s + (Number(ln.tax_amount) || 0), 0);
        const spread = invTax !== 0 && round2(lineTaxSum) === 0;
        const absSum = invLines.reduce((s, ln) => s + Math.abs(Number(ln.item_total) || 0), 0);
        let taxLeft = spread ? invTax : 0;
        invLines.forEach((ln, idx) => {
          const base = Number(ln.item_total) || 0;
          let amount = base;
          if (spread) {
            const taxPart = idx === invLines.length - 1 ? taxLeft
              : round2(invTax * (Math.abs(base) / (absSum || 1)));
            taxLeft = round2(taxLeft - taxPart);
            amount = round2(base + taxPart);
          }
          spreadAmt.set(ln, amount);
        });
      }
      // Lines are in each invoice's own currency (a CAD invoice in a USD
      // company) — convert amount and price at the invoice's booked rate
      // (invoices.exchange_rate) so the report reads in the base currency.
      const fx = await invoiceFxContext(orgId);
      productRows = lines.map(ln => {
        const m = rateToBase(ln.currency_code, ln.exchange_rate, fx);
        return {
          customer:      ln.customer_name || '',
          invoice_number: ln.invoice_number || '',
          d:             isoDate(ln.date),
          product:       ln.product || 'Not Specified',
          description:   ln.description || '',
          amount:        round2((spreadAmt.get(ln) ?? 0) * m),
          currency_code: fx.base,
          source_type:   'ACCREC',
          _docId:        ln.zoho_invoice_id != null ? String(ln.zoho_invoice_id) : null,
          _qty:          num(ln.quantity),
          _price:        round2(num(ln.rate) * m),
        };
      });
      hasLineItems = true;
    }
  }

  // QuickBooks: invoice line items are the only synced sales documents, so
  // Credit Memos, Sales Receipts, Refund Receipts (and any invoice without
  // synced lines) come from the ledger — see qboLedgerSalesRows.
  if (await isQuickBooksOrg(orgId)) {
    const covered = new Set(productRows.map((r) => r._docId).filter(Boolean));
    const extra = await qboLedgerSalesRows(userId, orgId, from, to, covered);
    const fxRows = await qboExchangeGainLossRows(userId, orgId, from, to);
    if (extra.length || fxRows.length) productRows = productRows.concat(extra, fxRows);
  }

  if (!productRows.length) {
    return {
      columns: COLUMNS,
      rows: [],
      currency: 'INR',
      empty: true,
      unavailable: true,
      emptyReason: 'unavailable',
      message: 'No invoice line items have been synced for this connection, so sales '
        + 'cannot be broken down by product or service. Use Sales by Customer for the '
        + 'invoice totals over the same period.',
      meta,
    };
  }

  const currency = productRows[0]?.currency_code || 'INR';

  // product → its lines, in document order.
  const groups = new Map();
  for (const ln of productRows) {
    const key = ln.product || 'Not Specified';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      date:     ln.d,
      type:     ln._type || (ln.source_type === 'ACCRECCREDIT' ? 'Credit Note' : 'Invoice'),
      num:      ln.invoice_number || '',
      customer: ln.customer || '',
      desc:     ln.description || '',
      qty:      hasLineItems && !ln._type ? (ln._qty || null) : null,
      price:    hasLineItems && !ln._type ? (ln._price != null ? round2(ln._price) : null) : null,
      // Ledger-sourced rows (_type set) already carry their sign: a credit memo
      // debits income, so it's negative.
      amount:   round2(!ln._type && ln.source_type === 'ACCRECCREDIT' ? -(Number(ln.amount) || 0) : (Number(ln.amount) || 0)),
    });
  }

  const rows = [];
  let grandAmount = 0;
  let grandQty = 0;
  let anyQty = false;
  // Products alphabetically, as the platform reports list them.
  for (const name of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    const entries = groups.get(name);
    rows.push({ label: name, isHeader: true, level: 0, cells: {} });
    let running = 0;
    let groupAmount = 0;
    let groupQty = 0;
    let groupHasQty = false;
    for (const e of entries) {
      running = round2(running + e.amount);
      groupAmount = round2(groupAmount + e.amount);
      if (e.qty != null) { groupQty += e.qty; groupHasQty = true; anyQty = true; }
      rows.push({
        label: fmtDate(e.date),
        level: 1,
        cells: {
          type:     e.type,
          num:      e.num,
          customer: e.customer,
          desc:     e.desc,
          qty:      e.qty,
          price:    e.price,
          amount:   e.amount,
          balance:  running,
        },
      });
    }
    rows.push({
      label: `Total for ${name}`,
      isSubtotal: true,
      level: 0,
      cells: { qty: groupHasQty ? round2(groupQty) : null, amount: groupAmount },
    });
    grandAmount = round2(grandAmount + groupAmount);
    grandQty += groupQty;
  }
  rows.push({
    label: 'TOTAL',
    isTotal: true,
    level: 0,
    cells: { qty: anyQty ? round2(grandQty) : null, amount: grandAmount },
  });

  return { columns: COLUMNS, rows, currency, meta };
}

module.exports = { buildSalesByProductDetail };
