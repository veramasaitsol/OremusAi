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
            ROUND(at.credit - at.debit, 2) AS amount,
            at.currency_code,
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
            ROUND(inv.tax_total, 2) AS tax_total, inv.currency_code
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
      productRows = lines.map(ln => ({
        customer:      ln.customer_name || '',
        invoice_number: ln.invoice_number || '',
        d:             ln.date ? fmtDate(ln.date) : '',
        product:       ln.product || 'Not Specified',
        description:   ln.description || '',
        amount:        round2(spreadAmt.get(ln) ?? 0),
        currency_code: ln.currency_code || 'INR',
        source_type:   'ACCREC',
        _qty:          num(ln.quantity),
        _price:        num(ln.rate),
      }));
      hasLineItems = true;
    }
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
      type:     ln.source_type === 'ACCRECCREDIT' ? 'Credit Note' : 'Invoice',
      num:      ln.invoice_number || '',
      customer: ln.customer || '',
      desc:     ln.description || '',
      qty:      hasLineItems ? (ln._qty || null) : null,
      price:    hasLineItems ? (ln._price != null ? round2(ln._price) : null) : null,
      amount:   round2(ln.source_type === 'ACCRECCREDIT' ? -(Number(ln.amount) || 0) : (Number(ln.amount) || 0)),
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
