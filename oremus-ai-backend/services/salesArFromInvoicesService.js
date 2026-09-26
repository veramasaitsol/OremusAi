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

// Sales-document source_type codes, by platform. Each connected org belongs to
// exactly one platform, so one combined IN-list works everywhere with no
// per-platform branching: Zoho stores its own lowercase type ('invoice' /
// 'creditnote'), QuickBooks stores its own display label ('Invoice' /
// 'Credit Memo' — see glTypeLabel's note that QuickBooks already stores its
// printed labels), Xero its document type ('ACCREC' / 'ACCRECCREDIT').
const SALES_INVOICE_TYPES = ['invoice', 'Invoice', 'ACCREC'];
const SALES_CREDITNOTE_TYPES = ['creditnote', 'Credit Memo', 'ACCRECCREDIT'];
const SALES_DOC_TYPES = [...SALES_INVOICE_TYPES, ...SALES_CREDITNOTE_TYPES];
const inList = (arr) => arr.map(() => '?').join(',');
const isCreditNoteType = (sourceType) => SALES_CREDITNOTE_TYPES.includes(sourceType);

// Customer-payment source_type codes, by platform — used only to find realized
// FX gain/loss (see fxAdjustmentsByCustomer below).
const SALES_PAYMENT_TYPES = ['Payment', 'customer_payment', 'BankRECEIVE'];
// A multi-currency invoice is raised at one exchange rate and paid at another;
// the difference is realized as a gain/loss at settlement, on a NON-asset line
// of the customer's own payment transaction (e.g. QuickBooks: source_type
// 'Payment', account "Exchange Gain or Loss"). The platform's own Sales by
// Customer total includes this — confirmed against a live QuickBooks org
// where the gap was ₹15,698.54, exactly the sum of these lines for the period
// — so leaving it out understates the customer's true net sales value.
const FX_ADJUSTMENT_RE = /exchange\s*(gain|loss)|reali[sz]ed\s*(currency|exchange)\s*(gain|loss)/i;

// One row per (customer, fx adjustment amount) for the period — resolved via
// a self-join to the SAME transaction's own Accounts Receivable line, which is
// where the customer name actually lives (the FX line's own `transaction_details`
// just says "Exchange Gain or Loss"). Additive and platform-agnostic: an org
// with no such postings (most Zoho/Xero orgs today) gets an empty result back,
// so this can never change a total where the pattern doesn't occur.
async function fxAdjustmentsByCustomer(userId, orgId, from, to) {
  const [rows] = await pool.execute(
    `SELECT COALESCE(NULLIF(TRIM(cust.customer_name), ''), 'Unknown') AS customer,
            ROUND(SUM(COALESCE(fx.base_credit, fx.credit) - COALESCE(fx.base_debit, fx.debit)), 2) AS total
       FROM account_transactions fx
       JOIN (
         SELECT transaction_id, MIN(transaction_details) AS customer_name
           FROM account_transactions
          WHERE user_id = ? AND org_id = ?
            AND account_type_code = 'accounts_receivable'
            AND transaction_details IS NOT NULL AND TRIM(transaction_details) <> ''
          GROUP BY transaction_id
       ) cust ON cust.transaction_id = fx.transaction_id
      WHERE fx.user_id = ? AND fx.org_id = ?
        AND fx.source_type IN (${inList(SALES_PAYMENT_TYPES)})
        AND fx.account_group <> 'asset'
        AND fx.transaction_date BETWEEN ? AND ?
        AND fx.account_name REGEXP ?
      GROUP BY customer`,
    [userId, orgId, userId, orgId, ...SALES_PAYMENT_TYPES, from, to, FX_ADJUSTMENT_RE.source]
  );
  const map = new Map();
  for (const r of rows) {
    const amt = round2(r.total);
    if (amt) map.set(r.customer, amt);
  }
  return map;
}

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
    // Every step that moves _balanceAsOf away from the live `balance` is
    // recorded here too — this is what the AR Aging Detail "Balance" column's
    // click-through breakdown shows: exactly how the as-of figure was
    // reconstructed, not just the final number.
    inv._breakdown = [{ name: inv.customer_name || null, ref: inv.invoice_number || null, date: null, type: 'Current balance', amount: inv._balanceAsOf }];
    if (inv.invoice_number) byNum.set(String(inv.invoice_number).trim(), inv);
  }

  const [payments] = await pool.execute(
    `SELECT amount, unused_amount, invoice_numbers, date, payment_number
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
      if (give > 0) {
        inv._balanceAsOf += give;
        inv._breakdown.push({
          name: inv.customer_name || null, ref: p.payment_number || 'Payment',
          date: p.date ? String(p.date).slice(0, 10) : null,
          type: 'Payment reversed (settled after as-of date)', amount: give,
        });
      }
      applied -= give;
      if (applied <= 0) break;
    }
  }

  const [creditNotes] = await pool.execute(
    `SELECT total, balance, invoice_number, date, creditnote_number
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
    const give = Math.min(room, applied);
    if (give > 0) {
      inv._balanceAsOf += give;
      inv._breakdown.push({
        name: inv.customer_name || null, ref: cn.creditnote_number || 'Credit Note',
        date: cn.date ? String(cn.date).slice(0, 10) : null,
        type: 'Credit note reversed (applied after as-of date)', amount: give,
      });
    }
  }
}

// ─── Sales by Customer ──────────────────────────────────────────────────────
// Built from `account_transactions` (shared ledger) instead of `invoices` so
// that tax is always included in the total — even for Xero and QuickBooks where
// the `invoices.tax_total` column is 0.
//
// The sale's true, tax-inclusive value is every NON-ASSET line the document
// posts (income, tax-liability, and any contra-revenue/expense-classified
// line a platform's chart of accounts routes part of a credit note through —
// confirmed against a live Zoho org's own "Sales by Customer" report) — never
// just the account_group = 'income' lines alone, which silently drops
// whichever portion of a document lands on a differently-classified account.
// This also works out to be the platform-agnostic formula: whatever the
// asset-side of a balanced document settles to (Accounts Receivable for a
// still-open invoice, straight to a bank/cash account for one posted as
// already paid — Xero's posting engine does this for some documents), the
// non-asset side is always its exact negation, so summing it needs no
// per-platform branching or asset-account-type guessing.
async function buildSalesByCustomer(userId, params = {}) {
  const orgId = params.org_id || null;
  requireOrg(orgId);
  const { from, to } = resolveRange(params);

  // Primary: account_transactions (works for all 3 platforms, one query).
  //
  // Resolve customer PER DOCUMENT first (inner query, grouped by transaction_id),
  // then group documents by that resolved customer — never group raw ledger rows
  // directly by their own transaction_details. A document's non-asset (income)
  // line sometimes carries line-item memo text instead of a customer name there
  // (e.g. a QuickBooks Credit Memo whose GL report leaves that row's own "Name"
  // cell blank — our sync then falls back to the memo, see quickbooksService.js),
  // while its Accounts Receivable line — the sub-ledger control account actually
  // tied to a customer — reliably carries the real name. Preferring the AR line
  // per document avoids splitting one document's amount into a bogus, memo-named
  // "customer" row (confirmed: every SALES_DOC_TYPES document across all 3
  // platforms has an AR line, so the memo-only fallback below is theoretical).
  const [txnGrouped] = await pool.execute(
    `SELECT COALESCE(NULLIF(TRIM(doc.customer), ''), 'Unknown') AS customer,
            COUNT(DISTINCT CASE WHEN doc.source_type IN (${inList(SALES_INVOICE_TYPES)})
                                 THEN doc.source_id END) AS cnt,
            ROUND(SUM(doc.amount), 2) AS total,
            MAX(COALESCE(doc.base_currency_code, doc.currency_code)) AS currency
       FROM (
         SELECT at.transaction_id,
                MAX(at.source_id) AS source_id,
                MAX(at.source_type) AS source_type,
                COALESCE(
                  MAX(CASE WHEN at.account_type_code = 'accounts_receivable' THEN NULLIF(TRIM(at.transaction_details), '') END),
                  MAX(CASE WHEN at.account_group <> 'asset' THEN NULLIF(TRIM(at.transaction_details), '') END)
                ) AS customer,
                ROUND(SUM(CASE WHEN at.account_group <> 'asset' THEN COALESCE(at.base_credit, at.credit) - COALESCE(at.base_debit, at.debit) ELSE 0 END), 2) AS amount,
                MAX(at.currency_code) AS currency_code,
                MAX(at.base_currency_code) AS base_currency_code
           FROM account_transactions at
          WHERE at.user_id = ? AND at.org_id = ?
            AND at.source_type IN (${inList(SALES_DOC_TYPES)})
            AND at.transaction_date BETWEEN ? AND ?
          GROUP BY at.transaction_id
       ) doc
      GROUP BY customer
      ORDER BY total DESC`,
    [...SALES_INVOICE_TYPES, userId, orgId, ...SALES_DOC_TYPES, from, to]
  );

  // Fallback: invoices table (for connections that haven't synced ledger lines
  // yet — e.g. a brand-new Zoho connection before first sync). Realized FX
  // adjustments only ever exist once the ledger itself is synced, so they're
  // deliberately skipped on this fallback path too — nothing to attribute them to.
  let grouped = txnGrouped;
  let fx = new Map();
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
  } else {
    fx = await fxAdjustmentsByCustomer(userId, orgId, from, to);
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
  const seenFx = new Set();
  for (const r of grouped) {
    let amt = num(r.total);
    const cnt = Number(r.cnt) || 0;
    if (fx.has(r.customer)) { amt = round2(amt + fx.get(r.customer)); seenFx.add(r.customer); }
    totalAmount += amt;
    totalCount += cnt;
    rows.push({ label: r.customer, level: 1, cells: { count: cnt, total: amt } });
  }
  // A customer whose only activity in the period was a payment settling a
  // PRIOR period's invoice (so they never appear in `grouped` above) still
  // needs their realized FX adjustment counted — same as the platform does.
  for (const [customer, amt] of fx) {
    if (seenFx.has(customer)) continue;
    totalAmount = round2(totalAmount + amt);
    rows.push({ label: customer, level: 1, cells: { count: 0, total: amt } });
  }
  rows.sort((a, b) => (b.cells.total || 0) - (a.cells.total || 0));
  rows.push({
    label: 'Total',
    isTotal: true,
    cells: { count: totalCount, total: round2(totalAmount) },
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

  // Primary: account_transactions (invoice / credit-note documents — see
  // SALES_DOC_TYPES for each platform's own source_type spelling). A document's
  // true, tax-inclusive value is every NON-ASSET line it posts (income,
  // tax-liability, any contra-revenue-classified line) — never just its
  // account_group = 'income' line(s) alone, which silently drops whatever
  // portion lands on a differently-classified account (see buildSalesByCustomer
  // for the full reasoning) — so group by transaction_id first to get one
  // correct, fully-summed row per document, then nest under customer.
  //
  // `customer` is resolved from the document's Accounts Receivable line, not
  // whichever line happens to be scanned — the income line's own
  // transaction_details is sometimes line-item memo text rather than a
  // customer name (e.g. a QuickBooks Credit Memo — see buildSalesByCustomer),
  // and grouping by (source_id, transaction_details) as before would split
  // that one document into two rows, one of them a bogus memo-named
  // "customer". `description` keeps that non-asset line's own text separately
  // — still useful context, just not a customer identity.
  const [txnRows] = await pool.execute(
    `SELECT COALESCE(
              MAX(CASE WHEN at.account_type_code = 'accounts_receivable' THEN NULLIF(TRIM(at.transaction_details), '') END),
              MAX(CASE WHEN at.account_group <> 'asset' THEN NULLIF(TRIM(at.transaction_details), '') END)
            ) AS customer,
            MAX(at.source_id) AS source_id,
            MAX(at.reference_number) AS invoice_number,
            DATE_FORMAT(MAX(at.transaction_date), '%Y-%m-%d') AS d,
            MAX(at.account_name) AS product,
            MAX(CASE WHEN at.account_group <> 'asset' THEN at.transaction_details END) AS description,
            ROUND(SUM(CASE WHEN at.account_group <> 'asset' THEN COALESCE(at.base_credit, at.credit) - COALESCE(at.base_debit, at.debit) ELSE 0 END), 2) AS amount,
            MAX(COALESCE(at.base_currency_code, at.currency_code)) AS currency_code,
            MAX(at.source_type) AS source_type
       FROM account_transactions at
      WHERE at.user_id = ? AND at.org_id = ?
        AND at.source_type IN (${inList(SALES_DOC_TYPES)})
        AND at.transaction_date BETWEEN ? AND ?
      GROUP BY at.transaction_id
      ORDER BY customer, d, invoice_number`,
    [userId, orgId, ...SALES_DOC_TYPES, from, to]
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
        const sign = isCreditNoteType(row.source_type) ? -1 : 1;
        const base = num(ln.item_total);
        let taxPart = 0;
        if (spread) {
          taxPart = idx === lines.length - 1 ? taxLeft
            : round2(invTax * (Math.abs(base) / (absSum || 1)));
          taxLeft = round2(taxLeft - taxPart);
        }
        entries.push({
          date:    row.d,
          type:    isCreditNoteType(row.source_type) ? 'Credit Note' : 'Invoice',
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
        type:    isCreditNoteType(row.source_type) ? 'Credit Note' : 'Invoice',
        num:     row.invoice_number || '',
        product: row.product || '',
        desc:    row.description || '',
        qty:     null,
        price:   null,
        amount:  num(row.amount),
      });
    }
  }

  // Realized FX gain/loss on customer payment settlement (see buildSalesByCustomer
  // for the full explanation) — same source/query, so this Detail report's total
  // always ties to the Summary report's total exactly. Only meaningful once the
  // ledger itself is synced (txnRows), same condition the Summary report uses.
  if (txnRows.length) {
    const fx = await fxAdjustmentsByCustomer(userId, orgId, from, to);
    for (const [customer, amt] of fx) {
      if (!groups.has(customer)) groups.set(customer, []);
      groups.get(customer).push({
        date:    to,
        type:    'Exchange Gain/Loss',
        num:     '',
        product: '',
        desc:    'Realized exchange gain/loss on payment settlement',
        qty:     null,
        price:   null,
        amount:  amt,
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
            currency_code
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

  const currency = invoices.find((r) => r.currency_code)?.currency_code || 'INR';

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

  // Determine as-of date from params (point-in-time snapshot date)
  const today = new Date().toISOString().slice(0, 10);
  const asOfRaw = params.to_date || params.as_of_date || params.to || params.asOf || today;
  const asOfDate = asOfRaw ? new Date(asOfRaw) : new Date();
  const asOf = Number.isNaN(asOfDate.getTime()) ? new Date() : asOfDate;

  // Age by due date (what Xero's Aged Receivables and QuickBooks' A/R Aging
  // Summary do by default); `aging_by=invoice_date` switches to the invoice date
  // like Zoho's "Aging By: Invoice Date" option. Only the bucket distribution
  // changes — the customer totals and the grand total are identical either way.
  const agingByInvoiceDate =
    String(params.aging_by || params.aging_by_date || '').toLowerCase().replace(/[\s_-]/g, '') === 'invoicedate';

  // Pull every invoice issued on or before the as-of date. An AR Aging report is
  // an "as of" point-in-time snapshot, not a date-range statement. Any invoice
  // issued on or before the snapshot date must be included so attachAsOfBalances
  // can rewind settlements made after the snapshot date and calculate the
  // historical open balance.
  // Statuses excluded are the non-receivable ones across all three providers:
  // Zoho draft/void, Xero DRAFT/SUBMITTED/VOIDED/DELETED, QuickBooks drafts.
  const [invoices] = await pool.execute(
    `SELECT invoice_number, customer_name, date, due_date, total, balance, currency_code
       FROM invoices
      WHERE user_id = ? AND org_id = ?
        AND date <= ?
        AND LOWER(COALESCE(status, '')) NOT IN ('draft', 'approved', 'submitted', 'void', 'voided', 'deleted')`,
    [userId, orgId, ymd(asOf)]
  );

  await attachAsOfBalances(invoices, userId, orgId, asOf);

  const currency = invoices.find((r) => r.currency_code)?.currency_code || 'INR';

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
    `SELECT customer_name, date, unused_amount
       FROM zb_customer_payments
      WHERE user_id = ? AND org_id = ? AND date <= ? AND unused_amount <> 0
        AND zoho_payment_id LIKE '%:%'`,
    [userId, orgId, ymd(asOf)]
  );
  for (const p of creditPayments) {
    const credit = -num(p.unused_amount);
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
