'use strict';

/**
 * Provider-agnostic Sales-by-Customer + AR Aging Summary.
 * ---------------------------------------------------------------------------
 * Sales-by-Customer reports are built from the shared `account_transactions`
 * ledger table, which holds every provider's transaction lines in a unified
 * structure.  For invoice (ACCREC) and credit-note (ACCRECCREDIT) entries the
 * `transaction_details` column carries the customer name, `reference_number`
 * carries the invoice number, and the income account's credit/debit holds the
 * net sales amount.  This gives correct totals **including tax** for all three
 * providers — unlike the `invoices` table which stores `tax_total = 0` for
 * Xero and QuickBooks.
 *
 * The AR Aging Summary still reads from the `invoices` table because it needs
 * per-invoice due dates and current balances (including payment rewinding),
 * which are not available at the journal-line level.
 *
 *  - Sales by Customer: invoices issued within the selected period, grouped by
 *    customer, with an invoice count and total. Defaults to the current Indian
 *    fiscal year (Apr–Mar) like the other ledger reports.
 *  - AR Aging Summary: open invoices (outstanding balance) as of a date, grouped
 *    by customer into the aging buckets in BUCKETS plus a total column.
 */

const pool = require('../config/db');
const { getBaseCurrency } = require('./zohoChartOfAccountsService');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

function requireOrg(orgId) {
  if (!orgId) {
    const err = new Error('Provider not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
}

// Default selected period: current Indian fiscal year (1 Apr – 31 Mar).
function resolveRange(params) {
  const from = params.from_date || params.date_start || null;
  const to = params.to_date || params.date_end || null;
  if (from && to) return { from, to };
  // Default window: the fiscal year containing today, for the per-platform
  // start month (Settings → params.fy_start_month; defaults to 4 = 1 April).
  const { fyWindow, fyMonth } = require('./reportContext');
  const _fy = fyWindow(fyMonth(params.fy_start_month));
  return { from: from || _fy.from, to: to || _fy.to };
}

// As-of date for point-in-time aging: honour the report's "To" date (end of the
// selected period) like Zoho's "As of" field, falling back to an explicit
// as_of_date, then today.
function resolveAsOf(params = {}) {
  const raw = params.as_of_date || params.to_date || params.date_end || null;
  const d = raw ? new Date(raw) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

// Optional "From" — unlike a period report, aging itself is still computed as
// of a single date (`resolveAsOf` above); From only narrows WHICH invoices are
// considered, by their issue date, so a user can exclude old invoices from the
// summary (e.g. "only invoices raised since April"). `null` when not supplied
// (the default), which reproduces the exact prior behaviour — every invoice up
// to the as-of date is included.
function resolveFrom(params = {}) {
  const raw = params.from_date || params.date_start || null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Whole-day difference (asOf - dueDate); positive = overdue.
function daysBetween(asOf, due) {
  const MS = 24 * 60 * 60 * 1000;
  const a = Date.UTC(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
  const b = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  return Math.floor((a - b) / MS);
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Reconstruct each invoice's outstanding balance AS OF a historical date.
// `invoices.balance` stores the CURRENT balance, so a point-in-time aging run
// today would understate (or omit) any invoice that was still open on the
// as-of date but has since been settled. We rewind that: the balance on the
// as-of date equals the current balance plus every SETTLEMENT applied to the
// invoice AFTER the as-of date — and an invoice can be settled two genuinely
// different ways, both of which must be rewound or the reconstruction
// undercounts:
//   1. A cash payment (zb_customer_payments, comma-separated `invoice_numbers`
//      since one payment can cover several invoices).
//   2. A credit note applied against the invoice (zb_credit_notes — refunds,
//      discount corrections, FX-loss adjustments, etc.) — a SEPARATE
//      settlement path with no corresponding payment row at all. Proven by a
//      real case: an invoice closed by ₹69.17L cash + a same-day ₹1.57L
//      "FX Loss" credit note — rewinding only the payment left the
//      reconstructed as-of balance short by exactly the credit note's amount,
//      disagreeing with the provider's own live Aging report for that date.
// Both are matched by invoice number and distributed with the applied amount
// (amount/total − unused/balance) capped at each invoice's remaining room, so
// neither can inflate a balance past what was actually owed. This keeps the
// report dynamic — correct for any as-of date without manual per-entry fixes.
// Sets `_balanceAsOf` on every invoice row.
async function attachAsOfBalances(invoices, userId, orgId, asOf) {
  const byNum = new Map();
  for (const inv of invoices) {
    inv._balanceAsOf = num(inv.balance);
    if (inv.invoice_number) byNum.set(String(inv.invoice_number).trim(), inv);
  }

  const [payments] = await pool.execute(
    `SELECT amount, unused_amount, invoice_numbers
       FROM zb_customer_payments
      WHERE user_id = ? AND org_id = ? AND date > ?`,
    [userId, orgId, ymd(asOf)]
  );

  for (const p of payments) {
    let applied = num(p.amount) - num(p.unused_amount);
    if (applied <= 0 || !p.invoice_numbers) continue;
    for (const rawNum of String(p.invoice_numbers).split(',')) {
      const inv = byNum.get(rawNum.trim());
      if (!inv) continue;
      const room = Math.max(0, num(inv.total) - inv._balanceAsOf);
      const give = Math.min(room, applied);
      inv._balanceAsOf += give;
      applied -= give;
      if (applied <= 0) break;
    }
  }

  const [creditNotes] = await pool.execute(
    `SELECT total, balance, invoice_number
       FROM zb_credit_notes
      WHERE user_id = ? AND org_id = ? AND date > ?
        AND invoice_number IS NOT NULL AND invoice_number <> ''`,
    [userId, orgId, ymd(asOf)]
  );
  for (const cn of creditNotes) {
    const applied = num(cn.total) - num(cn.balance);
    if (applied <= 0) continue;
    const inv = byNum.get(String(cn.invoice_number).trim());
    if (!inv) continue;
    const room = Math.max(0, num(inv.total) - inv._balanceAsOf);
    inv._balanceAsOf += Math.min(room, applied);
  }
}

// ─── Sales by Customer ──────────────────────────────────────────────────────
// Built from `account_transactions` (shared ledger) instead of `invoices` so
// that tax is always included in the total — even for Xero and QuickBooks where
// the `invoices.tax_total` column is 0.  Income-account credits for ACCREC
// entries carry the full sale amount inclusive of tax; ACCRECCREDIT lines reduce
// the total (credit notes / refunds).
async function buildSalesByCustomer(userId, params = {}) {
  const orgId = params.org_id || null;
  requireOrg(orgId);
  const { from, to } = resolveRange(params);
  const platform = params.platform ? String(params.platform).toLowerCase() : null;

  // Primary: account_transactions (works for all 3 platforms).
  // Zoho sometimes posts invoice tax as separate liability lines (GST/IGST/CGST),
  // so when reporting for Zoho include those tax lines in the per-customer total.
  let txnGrouped;
  if (platform === 'zoho') {
    const [rows] = await pool.execute(
      `SELECT COALESCE(NULLIF(TRIM(at.transaction_details), ''), 'Unknown') AS customer,
              COUNT(DISTINCT at.source_id) AS cnt,
              ROUND(SUM(
                CASE
                  WHEN at.account_group = 'income' THEN at.credit - at.debit
                  WHEN LOWER(COALESCE(at.account_name, '')) REGEXP 'gst|cgst|sgst|igst|tax' THEN at.credit - at.debit
                  ELSE 0
                END
              ), 2) AS total,
              MAX(at.currency_code) AS currency
         FROM account_transactions at
        WHERE at.user_id = ? AND at.org_id = ?
          AND at.source_type IN ('ACCREC', 'ACCRECCREDIT')
          AND at.transaction_date BETWEEN ? AND ?
        GROUP BY customer
        ORDER BY total DESC`,
      [userId, orgId, from, to]
    );
    txnGrouped = rows;
  } else {
    const [rows] = await pool.execute(
      `SELECT COALESCE(NULLIF(TRIM(at.transaction_details), ''), 'Unknown') AS customer,
              COUNT(DISTINCT at.source_id) AS cnt,
              ROUND(SUM(
                CASE WHEN at.account_group = 'income'
                  THEN at.credit - at.debit
                  ELSE 0
                END
              ), 2) AS total,
              MAX(at.currency_code) AS currency
         FROM account_transactions at
        WHERE at.user_id = ? AND at.org_id = ?
          AND at.source_type IN ('ACCREC', 'ACCRECCREDIT')
          AND at.transaction_date BETWEEN ? AND ?
        GROUP BY customer
        ORDER BY total DESC`,
      [userId, orgId, from, to]
    );
    txnGrouped = rows;
  }

  // Fallback: invoices table (for connections that haven't synced ledger lines
  // yet — e.g. a brand-new Zoho connection before first sync).
  let grouped = txnGrouped;
  if (!grouped.length) {
    const [invGrouped] = await pool.execute(
      `SELECT COALESCE(NULLIF(TRIM(customer_name), ''), 'Unknown') AS customer,
              COUNT(*)    AS cnt,
              SUM(total)  AS total,
              MAX(currency_code) AS currency
         FROM invoices
        WHERE user_id = ? AND org_id = ?
          AND date BETWEEN ? AND ?
          AND LOWER(COALESCE(status, '')) NOT IN ('draft', 'approved', 'void')
        GROUP BY customer
        ORDER BY total DESC`,
      [userId, orgId, from, to]
    );
    grouped = invGrouped;
  }

  const currency = grouped.find((r) => r.currency)?.currency || 'INR';

  const columns = [
    { key: 'customer', label: 'Customer Name', align: 'left'  },
    { key: 'count',    label: 'Invoice Count', align: 'right' },
    { key: 'total',    label: 'Total',         align: 'right' },
  ];

  const rows = [];
  let totalAmount = 0;
  let totalCount = 0;
  for (const r of grouped) {
    const amt = num(r.total);
    const cnt = Number(r.cnt) || 0;
    totalAmount += amt;
    totalCount += cnt;
    rows.push({ label: r.customer, level: 1, cells: { count: cnt, total: amt } });
  }
  rows.push({
    label: 'Total',
    isTotal: true,
    cells: { count: totalCount, total: totalAmount },
  });

  return {
    columns,
    rows,
    currency,
    meta: { title: 'Sales by Customer', basis: 'Accrual', from, to },
  };
}

// ─── Sales by Customer Detail ─────────────────────────────────────────────
// Line-item level sales grouped by customer, modelled on QuickBooks' report:
//
//   <Customer>
//     <date>  <type>  <num>  <product/service>  <desc>  <qty>  <price>  <amount>  <balance>
//     ...
//     Total for <Customer>                                    <qty total>  <amount total>
//   TOTAL                                                     <qty total>  <amount total>
//
// Built from `account_transactions` (shared ledger) for all 3 platforms.
// Zoho additionally syncs per-line product/qty/rate into zb_invoice_line_items,
// so its invoices expand to one row per product line; QuickBooks & Xero render
// as a single income-account line per invoice. Balance is the running amount
// within the customer.
async function buildSalesByCustomerDetail(userId, params = {}) {
  const orgId = params.org_id || null;
  requireOrg(orgId);

  const { from, to } = resolveRange(params);

  // Primary: account_transactions (ACCREC / ACCRECCREDIT income lines).
  // Each invoice has one income-account line per entry; group by source_id to
  // get per-invoice totals, then nest under customer.
  const [txnRows] = await pool.execute(
    `SELECT at.transaction_details AS customer,
            at.source_id,
            at.reference_number AS invoice_number,
            DATE_FORMAT(at.transaction_date, '%Y-%m-%d') AS d,
            at.account_name AS product,
            at.transaction_details AS description,
            ROUND(at.credit - at.debit, 2) AS amount,
            at.currency_code,
            at.source_type
       FROM account_transactions at
      WHERE at.user_id = ? AND at.org_id = ?
        AND at.source_type IN ('ACCREC', 'ACCRECCREDIT')
        AND at.account_group = 'income'
        AND at.transaction_date BETWEEN ? AND ?
      ORDER BY at.transaction_details, at.transaction_date, at.reference_number`,
    [userId, orgId, from, to]
  );

  // Fallback: invoices table (pre-sync connections).
  let invoiceRows = [];
  if (!txnRows.length) {
    const [invRows] = await pool.execute(
      `SELECT customer_name AS customer,
              zoho_id AS source_id,
              invoice_number,
              DATE_FORMAT(date, '%Y-%m-%d') AS d,
              '' AS product,
              '' AS description,
              ROUND(total, 2) AS amount,
              ROUND(tax_total, 2) AS tax_total,
              currency_code,
              'ACCREC' AS source_type
         FROM invoices
        WHERE user_id = ? AND org_id = ?
          AND date BETWEEN ? AND ?
          AND LOWER(COALESCE(status, '')) NOT IN ('draft', 'approved', 'void')
        ORDER BY customer_name, date, invoice_number`,
      [userId, orgId, from, to]
    );
    invoiceRows = invRows;
  }

  // Also pull Zoho line items for richer detail (product/qty/price).
  const allRows = txnRows.length ? txnRows : invoiceRows;
  const zohoIds = allRows.map((r) => r.source_id).filter(Boolean);
  const linesByInvoice = new Map();
  if (zohoIds.length) {
    const placeholders = zohoIds.map(() => '?').join(',');
    const [lines] = await pool.execute(
      `SELECT zoho_invoice_id, line_position,
              COALESCE(NULLIF(TRIM(item_name), ''), NULLIF(TRIM(name), '')) AS product,
              description, quantity, rate, item_total, tax_amount
         FROM zb_invoice_line_items
        WHERE user_id = ? AND org_id = ? AND zoho_invoice_id IN (${placeholders})
        ORDER BY zoho_invoice_id, line_position`,
      [userId, orgId, ...zohoIds]
    );
    for (const ln of lines) {
      const k = String(ln.zoho_invoice_id);
      if (!linesByInvoice.has(k)) linesByInvoice.set(k, []);
      linesByInvoice.get(k).push(ln);
    }
  }

  const currency = allRows.find((r) => r.currency_code)?.currency_code || 'INR';

  // customer → array of detail entries (already in chronological order).
  const groups = new Map();
  for (const row of allRows) {
    const customer = (row.customer || '').trim() || 'Unknown';
    if (!groups.has(customer)) groups.set(customer, []);
    const entries = groups.get(customer);
    const lines = linesByInvoice.get(String(row.source_id)) || [];
    if (lines.length) {
      // Zoho keeps sales tax at the INVOICE level (invoices.tax_total) — its
      // line items carry tax_amount = 0, so raw item_total prints
      // tax-exclusive while the whole-invoice row this detail view replaced
      // (invoices.total) was tax-inclusive. Zoho's own report shows
      // tax-inclusive amounts, so the invoice's tax is spread back over its
      // lines in proportion to each line's share of the invoice (remainder on
      // the last line keeps every invoice exact). Only the invoices-table
      // fallback rows carry tax_total, so GL-driven rows (Xero/QuickBooks) and
      // lines that already carry their own tax are left untouched.
      const invTax = num(row.tax_total);
      const lineTaxSum = lines.reduce((s, ln) => s + num(ln.tax_amount), 0);
      const spread = invTax !== 0 && round2(lineTaxSum) === 0;
      const absSum = lines.reduce((s, ln) => s + Math.abs(num(ln.item_total)), 0);
      let taxLeft = spread ? invTax : 0;
      lines.forEach((ln, idx) => {
        const sign = row.source_type === 'ACCRECCREDIT' ? -1 : 1;
        const base = num(ln.item_total);
        let taxPart = 0;
        if (spread) {
          taxPart = idx === lines.length - 1 ? taxLeft
            : round2(invTax * (Math.abs(base) / (absSum || 1)));
          taxLeft = round2(taxLeft - taxPart);
        }
        entries.push({
          date:    row.d,
          type:    row.source_type === 'ACCRECCREDIT' ? 'Credit Note' : 'Invoice',
          num:     row.invoice_number || '',
          product: ln.product || '',
          desc:    ln.description || '',
          qty:     num(ln.quantity),
          price:   num(ln.rate),
          amount:  round2(sign * base + (sign > 0 ? taxPart : -taxPart)),
        });
      });
    } else {
      entries.push({
        date:    row.d,
        type:    row.source_type === 'ACCRECCREDIT' ? 'Credit Note' : 'Invoice',
        num:     row.invoice_number || '',
        product: row.product || '',
        desc:    row.description || '',
        qty:     null,
        price:   null,
        amount:  num(row.amount),
      });
    }
  }

  const columns = [
    { key: 'label',    label: 'Transaction date',        align: 'left'  },
    { key: 'type',     label: 'Transaction type',        align: 'left'  },
    { key: 'num',      label: 'Num',                     align: 'left'  },
    { key: 'product',  label: 'Product/Service',         align: 'left'  },
    { key: 'desc',     label: 'Description',             align: 'left'  },
    { key: 'qty',      label: 'Quantity',                align: 'right', money: false },
    { key: 'price',    label: 'Sales price',             align: 'right' },
    { key: 'amount',   label: 'Amount',                  align: 'right' },
    { key: 'balance',  label: 'Balance',                 align: 'right' },
  ];

  const rows = [];
  let grandAmount = 0;
  let grandQty = 0;
  let hasAnyQty = false;
  // QuickBooks lists customers alphabetically.
  const customers = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  for (const customer of customers) {
    const entries = groups.get(customer);
    rows.push({ label: customer, isHeader: true, level: 0, cells: {} });
    let running = 0;
    let groupAmount = 0;
    let groupQty = 0;
    let groupHasQty = false;
    for (const e of entries) {
      running = round2(running + num(e.amount));
      groupAmount = round2(groupAmount + num(e.amount));
      if (e.qty != null) { groupQty += num(e.qty); groupHasQty = true; hasAnyQty = true; }
      rows.push({
        label: fmtDate(e.date),
        level: 1,
        cells: {
          type:    e.type,
          num:     e.num,
          product: e.product,
          desc:    e.desc,
          qty:     e.qty != null ? e.qty : null,
          price:   e.price != null ? e.price : null,
          amount:  num(e.amount),
          balance: running,
        },
      });
    }
    rows.push({
      label: `Total for ${customer}`,
      isSubtotal: true,
      level: 0,
      cells: { qty: groupHasQty ? round2(groupQty) : null, amount: round2(groupAmount) },
    });
    grandAmount = round2(grandAmount + groupAmount);
    grandQty += groupQty;
  }
  rows.push({
    label: 'TOTAL',
    isTotal: true,
    level: 0,
    cells: { qty: hasAnyQty ? round2(grandQty) : null, amount: round2(grandAmount) },
  });

  return {
    columns,
    rows,
    currency,
    meta: { title: 'Sales by Customer Detail', basis: 'Accrual', from, to },
  };
}

// ─── Sales by Product/Service Summary ─────────────────────────────────────
// Shown instead of inventing a product when a connection syncs no invoice lines.
const NO_LINE_ITEMS = 'No invoice line items have been synced for this connection, so '
  + 'sales cannot be broken down by product or service. Use Sales by Customer for the '
  + 'invoice totals over the same period.';

// Sales aggregated by product/service, modelled on QuickBooks' report:
//
//   <Product/Service>   <Quantity>  <Amount>  <% of sales>  <Avg. price>
//   ...
//   TOTAL               <qty total> <amount>  100.0%        <avg>
//
// One builder serves all three providers off the shared `invoices` table joined
// to its lines in `zb_invoice_line_items`. % of sales = amount ÷ grand total;
// Avg. price = amount ÷ quantity (blank when quantity is unknown).
//
// ⚠️ An invoice with NO synced lines is SKIPPED, never rolled into a whole-invoice
// "Uncategorized" bucket — that invented a product/service the books never
// recorded (on Xero, which syncs no line items, it made the single row read
// "Uncategorized 42,879,050.10"). With no lines at all the report is honestly
// `unavailable`. A line carrying no item groups under "Not Specified", the label
// QuickBooks itself uses for an account-based sales line.
async function buildSalesByProductSummary(userId, params = {}) {
  const orgId = params.org_id || null;
  requireOrg(orgId);

  const { from, to } = resolveRange(params);

  const [invoices] = await pool.execute(
    `SELECT zoho_id, invoice_number, customer_name,
            DATE_FORMAT(date, '%Y-%m-%d') AS d, total, ROUND(tax_total, 2) AS tax_total,
            currency_code, exchange_rate
       FROM invoices
      WHERE user_id = ? AND org_id = ?
        AND date BETWEEN ? AND ?
        AND LOWER(COALESCE(status, '')) NOT IN ('draft', 'approved', 'void')`,
    [userId, orgId, from, to]
  );

  const invoiceIds = invoices.map((i) => i.zoho_id).filter(Boolean);
  const linesByInvoice = new Map();
  if (invoiceIds.length) {
    const placeholders = invoiceIds.map(() => '?').join(',');
    const [lines] = await pool.execute(
      `SELECT zoho_invoice_id,
              COALESCE(NULLIF(TRIM(item_name), ''), NULLIF(TRIM(name), '')) AS product,
              quantity, item_total, tax_amount
         FROM zb_invoice_line_items
        WHERE user_id = ? AND org_id = ? AND zoho_invoice_id IN (${placeholders})`,
      [userId, orgId, ...invoiceIds]
    );
    for (const ln of lines) {
      const k = String(ln.zoho_invoice_id);
      if (!linesByInvoice.has(k)) linesByInvoice.set(k, []);
      linesByInvoice.get(k).push(ln);
    }
  }

  // The report's own currency is always the org's base/reporting currency —
  // never a per-invoice currency_code — because every amount below is
  // converted to it (see `rate` in the loop) before being summed, so a report
  // spanning invoices in several currencies still foots correctly.
  const currency = await getBaseCurrency(orgId);

  // product → { qty, amount, hasQty, entries[] }. entries feed the inline
  // drill-down: each underlying invoice line (customer / invoice# / date /
  // amount) so a product row expands to reveal what makes up its total.
  const groups = new Map();
  const add = (product, qty, amount, entry) => {
    const key = product || 'Not Specified';
    if (!groups.has(key)) groups.set(key, { qty: 0, amount: 0, hasQty: false, entries: [] });
    const g = groups.get(key);
    g.amount = round2(g.amount + num(amount));
    if (qty != null) { g.qty += num(qty); g.hasQty = true; }
    if (entry) g.entries.push(entry);
  };
  for (const inv of invoices) {
    const lines = linesByInvoice.get(String(inv.zoho_id)) || [];
    // Every amount is native to the invoice's own currency_code — converted to
    // the org's base currency (see `currency` above) via the invoice's own
    // exchange_rate (the rate Zoho/QuickBooks/Xero themselves booked it at),
    // never a live/current rate, so historical reports stay stable.
    const rate = num(inv.exchange_rate) || 1;
    const entryBase = {
      name: inv.customer_name || '—',
      ref: inv.invoice_number || null,
      date: inv.d ? fmtDate(inv.d) : null,
      _sortDate: inv.d || '',
    };
    // Zoho keeps sales tax at the INVOICE level (invoices.tax_total — its line
    // items carry tax_amount = 0), so raw item_total prints tax-exclusive and
    // disagreed with the tax-inclusive Sales by Customer reports. Spread the
    // invoice's tax over its lines in proportion to each line's share of the
    // invoice (remainder on the last line keeps every invoice exact). Lines
    // that already carry their own tax, and platforms whose invoices store
    // tax_total = 0 (Xero/QuickBooks), are left untouched.
    const invTax = num(inv.tax_total);
    const lineTaxSum = lines.reduce((s, ln) => s + num(ln.tax_amount), 0);
    const spread = invTax !== 0 && round2(lineTaxSum) === 0;
    const absSum = lines.reduce((s, ln) => s + Math.abs(num(ln.item_total)), 0);
    let taxLeft = spread ? invTax : 0;
    lines.forEach((ln, idx) => {
      let amount = num(ln.item_total);
      if (spread) {
        const taxPart = idx === lines.length - 1 ? taxLeft
          : round2(invTax * (Math.abs(amount) / (absSum || 1)));
        taxLeft = round2(taxLeft - taxPart);
        amount = round2(amount + taxPart);
      }
      amount = round2(amount * rate);
      add(ln.product, ln.quantity, amount, { ...entryBase, amount });
    });
  }

  const columns = [
    { key: 'label',    label: 'Product/Service', align: 'left'  },
    { key: 'qty',      label: 'Quantity',        align: 'right', money: false },
    { key: 'amount',   label: 'Amount',          align: 'right' },
    { key: 'pct',      label: '% of sales',      align: 'right', money: false },
    { key: 'avgprice', label: 'Avg. price',      align: 'right' },
  ];

  if (!groups.size) {
    return {
      columns,
      rows: [],
      currency,
      empty: true,
      unavailable: true,
      emptyReason: 'unavailable',
      message: NO_LINE_ITEMS,
      meta: { title: 'Sales by Product/Service Summary', basis: 'Accrual', from, to },
    };
  }

  let grandAmount = 0;
  let grandQty = 0;
  let anyQty = false;
  for (const g of groups.values()) {
    grandAmount = round2(grandAmount + g.amount);
    if (g.hasQty) { grandQty += g.qty; anyQty = true; }
  }

  const rows = [];
  // QuickBooks lists products alphabetically.
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const g = groups.get(name);
    const pct = grandAmount ? round2((g.amount / grandAmount) * 100) : 0;
    const avg = g.hasQty && g.qty ? round2(g.amount / g.qty) : null;
    const drill = g.entries
      .slice()
      .sort((a, b) => String(a._sortDate).localeCompare(String(b._sortDate)))
      .map((e) => ({ name: e.name, ref: e.ref, date: e.date, amount: e.amount }));
    rows.push({
      label: name,
      level: 1,
      drill,
      cells: {
        qty:      g.hasQty ? round2(g.qty) : null,
        amount:   g.amount,
        pct,
        avgprice: avg,
      },
    });
  }
  rows.push({
    label: 'TOTAL',
    isTotal: true,
    cells: {
      qty:      anyQty ? round2(grandQty) : null,
      amount:   grandAmount,
      pct:      grandAmount ? 100 : 0,
      avgprice: anyQty && grandQty ? round2(grandAmount / grandQty) : null,
    },
  });

  return {
    columns,
    rows,
    currency,
    meta: { title: 'Sales by Product/Service Summary', basis: 'Accrual', from, to },
  };
}

// ─── AR Aging Summary ─────────────────────────────────────────────────────
// Aging buckets, in display order. `age` = whole days between the as-of date and
// the invoice's aging date (due date by default), so age <= 0 means not yet due.
// The trailing three buckets split anything over a year into 1–2 yrs, 2–3 yrs
// and older, so every outstanding amount lands in exactly one column and the
// row total always equals the sum of the buckets.
const BUCKETS = [
  { id: 'notdue',   label: 'Not due',       test: (age) => age <= 0 },
  { id: 'd1_30',    label: '1 - 30',        test: (age) => age >= 1    && age <= 30 },
  { id: 'd31_60',   label: '31 - 60',       test: (age) => age >= 31   && age <= 60 },
  { id: 'd61_90',   label: '61 - 90',       test: (age) => age >= 61   && age <= 90 },
  { id: 'd91_180',  label: '91 - 180',      test: (age) => age >= 91   && age <= 180 },
  { id: 'd180_1y',  label: '180 - 1 year',  test: (age) => age >= 181  && age <= 365 },
  { id: 'y1_2',     label: '> 1 year',      test: (age) => age >= 366  && age <= 730 },
  { id: 'y2_3',     label: '> 2 years',     test: (age) => age >= 731  && age <= 1095 },
  { id: 'y_above',  label: 'Above 2 years', test: (age) => age > 1095 },
];

function bucketFor(age) {
  return BUCKETS.find((b) => b.test(age)) || BUCKETS[BUCKETS.length - 1];
}

function fmtDate(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${dt.getFullYear()}`;
}

async function buildArAgingSummary(userId, params = {}) {
  const orgId = params.org_id || null;
  requireOrg(orgId);

  // Point-in-time as-of date — the selected "To" date (defaults to today).
  const asOf = resolveAsOf(params);
  // Optional "From" — narrows which invoices are considered by issue date;
  // aging itself still runs as of `asOf` above. `null` (no filter) by default.
  const fromDate = resolveFrom(params);

  // Age by due date (what Xero's Aged Receivables and QuickBooks' A/R Aging
  // Summary do by default); `aging_by=invoice_date` switches to the invoice date
  // like Zoho's "Aging By: Invoice Date" option. Only the bucket distribution
  // changes — the customer totals and the grand total are identical either way.
  const agingByInvoiceDate =
    String(params.aging_by || params.aging_by_date || '').toLowerCase().replace(/[\s_-]/g, '') === 'invoicedate';

  // Pull every issued invoice (NOT just currently-open ones): an invoice with a
  // zero balance today may have been open on the as-of date. attachAsOfBalances
  // rewinds post-as-of payments to recover the historical balance.
  // Statuses excluded are the non-receivable ones across all three providers:
  // Zoho draft/void, Xero DRAFT/SUBMITTED/VOIDED/DELETED, QuickBooks drafts.
  const [invoices] = await pool.execute(
    `SELECT invoice_number, customer_name, date, due_date, total, balance, currency_code, exchange_rate
       FROM invoices
      WHERE user_id = ? AND org_id = ?
        AND LOWER(COALESCE(status, '')) NOT IN ('draft', 'approved', 'submitted', 'void', 'voided', 'deleted')`,
    [userId, orgId]
  );

  await attachAsOfBalances(invoices, userId, orgId, asOf);
  // _balanceAsOf is reconstructed above entirely in the invoice's own native
  // currency (payments/credit notes applied to it are booked the same way) —
  // convert to the org's base currency only now, at the very end, so every
  // customer/bucket total that follows sums correctly across currencies.
  for (const inv of invoices) {
    inv._balanceAsOf = round2(inv._balanceAsOf * (num(inv.exchange_rate) || 1));
  }

  // Always the org's base/reporting currency, never a per-invoice code — every
  // amount below is already converted to it (see the loop above and `rate`
  // further down), so a multi-currency org's totals still foot correctly.
  const currency = await getBaseCurrency(orgId);

  const columns = [
    { key: 'customer', label: 'Customer Name', align: 'left'  },
    ...BUCKETS.map((b) => ({ key: b.id, label: b.label, align: 'right' })),
    { key: 'total', label: 'Total', align: 'right' },
  ];

  // customer → { bucketId: amount }
  const byCustomer = new Map();
  // customer → { bucketId: [ {name, ref, date, amount}, … ] } — the exact
  // invoices/credits behind each cell, for the click-to-drill-down below
  // (mirrors QuickBooks' own "click a Summary cell → see its Detail rows").
  const byCustomerDrill = new Map();
  const drillFor = (customer, bucketId) => {
    if (!byCustomerDrill.has(customer)) {
      byCustomerDrill.set(customer, Object.fromEntries(BUCKETS.map((b) => [b.id, []])));
    }
    return byCustomerDrill.get(customer)[bucketId];
  };
  const totals = Object.fromEntries(BUCKETS.map((b) => [b.id, 0]));
  let grandTotal = 0;

  for (const inv of invoices) {
    // Point-in-time: ignore invoices issued after the as-of date — they didn't
    // exist yet, so they must not appear in (or skew) a historical aging.
    if (inv.date && new Date(inv.date) > asOf) continue;
    // Optional From: exclude invoices issued before the selected start date.
    if (fromDate && inv.date && new Date(inv.date) < fromDate) continue;
    const bal = inv._balanceAsOf;
    if (bal <= 0) continue; // settled on/before the as-of date — not outstanding
    // An invoice with no due date is due on issue (that's how the providers
    // treat it) — never drop it, or the grand total stops matching the platform.
    const agingDate = agingByInvoiceDate ? inv.date : (inv.due_date || inv.date);
    if (!agingDate) continue;
    const age = daysBetween(asOf, new Date(agingDate));
    const bucket = bucketFor(age);
    const customer = (inv.customer_name || '').trim() || 'Unknown';
    if (!byCustomer.has(customer)) {
      byCustomer.set(customer, Object.fromEntries(BUCKETS.map((b) => [b.id, 0])));
    }
    byCustomer.get(customer)[bucket.id] += bal;
    totals[bucket.id] += bal;
    grandTotal += bal;
    drillFor(customer, bucket.id).push({
      name: customer, ref: inv.invoice_number || '', date: fmtDate(new Date(agingDate)), amount: round2(bal),
    });
  }

  // Standalone unapplied / overpayment customer-Payment credits still reduce a
  // customer's true outstanding receivable (QuickBooks' own A/R Aging Summary
  // nets them in) — aged by the payment's own date, same as the Detail report.
  // ⚠️ QuickBooks/Xero-specific: Zoho's own Aging Summary does NOT surface these
  // (proven — see zohoArAgingDetailService.js), so only synthetic (non-Zoho)
  // payment rows qualify: real Zoho ids are bare numeric, ours are `qbo:`/`xero:`.
  const [creditPayments] = await pool.execute(
    `SELECT customer_name, date, unused_amount, exchange_rate
       FROM zb_customer_payments
      WHERE user_id = ? AND org_id = ? AND date <= ? AND unused_amount <> 0
        AND zoho_payment_id LIKE '%:%'`,
    [userId, orgId, ymd(asOf)]
  );
  for (const p of creditPayments) {
    if (p.date && new Date(p.date) > asOf) continue;
    if (fromDate && p.date && new Date(p.date) < fromDate) continue;
    // The payment's own rate — it isn't necessarily the same invoice as above.
    const credit = round2(-num(p.unused_amount) * (num(p.exchange_rate) || 1));
    const age = daysBetween(asOf, new Date(p.date));
    const bucket = bucketFor(age);
    const customer = (p.customer_name || '').trim() || 'Unknown';
    if (!byCustomer.has(customer)) {
      byCustomer.set(customer, Object.fromEntries(BUCKETS.map((b) => [b.id, 0])));
    }
    byCustomer.get(customer)[bucket.id] += credit;
    totals[bucket.id] += credit;
    grandTotal += credit;
    drillFor(customer, bucket.id).push({
      name: customer, ref: 'Unapplied Credit', date: fmtDate(new Date(p.date)), amount: credit,
    });
  }

  const rows = [];
  const customers = [...byCustomer.keys()].sort((a, b) => a.localeCompare(b));
  for (const customer of customers) {
    const b = byCustomer.get(customer);
    const cells = {};
    const cellDrill = {};
    // Empty buckets render BLANK (not 0.00) like Xero/QuickBooks do — with nine
    // aging columns a wall of zeros hides the amounts that matter. The TOTAL row
    // below keeps real 0.00s so every column still foots.
    for (const k of BUCKETS) {
      const v = round2(b[k.id]);
      cells[k.id] = v === 0 ? '' : v;
      const entries = byCustomerDrill.get(customer)?.[k.id];
      if (entries && entries.length) cellDrill[k.id] = entries;
    }
    cells.total = round2(BUCKETS.reduce((s, k) => s + b[k.id], 0));
    // Total column drills to every entry across all buckets for this customer.
    const allEntries = BUCKETS.flatMap((k) => byCustomerDrill.get(customer)?.[k.id] || []);
    if (allEntries.length) cellDrill.total = allEntries;
    rows.push({ label: customer, level: 1, cells, cellDrill });
  }

  const totalCells = {};
  for (const k of BUCKETS) totalCells[k.id] = round2(totals[k.id]);
  totalCells.total = round2(grandTotal);
  rows.push({ label: 'TOTAL', isTotal: true, level: 0, cells: totalCells });

  return {
    columns,
    rows,
    currency,
    meta: {
      title: 'A/R Aging Summary Report',
      asOf: fmtDate(asOf),
      from: fromDate ? fmtDate(fromDate) : null,
      agingBy: agingByInvoiceDate ? 'Invoice Date' : 'Invoice Due Date',
    },
  };
}

module.exports = {
  buildSalesByCustomer,
  buildSalesByCustomerDetail,
  buildSalesByProductSummary,
  buildArAgingSummary,
  // Shared with the A/P Aging Summary so receivables and payables always age
  // into the exact same columns.
  AGING_BUCKETS: BUCKETS,
  agingBucketFor: bucketFor,
  // Shared with AR Aging Detail (zohoArAgingDetailService.js) so both reports
  // reconstruct a historical invoice balance the exact same way — including
  // both cash payments AND credit notes — and can never independently drift
  // apart the way they did before (see the credit-note rewind above).
  attachAsOfBalances,
};
