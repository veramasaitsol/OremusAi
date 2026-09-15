'use strict';

/**
 * Purchases by Item — Zoho Books' "Purchases by Item" layout.
 * ---------------------------------------------------------------------------
 * One row per item purchased in the period, item name ascending, with a grand
 * Total footer:
 *
 *   Item ID | Item Name | Unit | Is Combo Product |
 *   Quantity Purchased | Amount | Average Price
 *
 * Amount is the sum of the bill lines' pre-tax line totals, Quantity Purchased
 * the sum of their quantities, and Average Price = Amount / Quantity Purchased.
 *
 * Built from the synced bill line items (`zb_bill_line_items` joined to their
 * parent `bills` for the date scope), with the item master (`zb_items`) supplying
 * the unit and combo flag. Only lines that reference an item are counted — Zoho
 * excludes account-only bill lines from this report, since they purchase no item.
 *
 * Provider-agnostic in shape: it reads by (user_id, org_id), so QuickBooks and
 * Xero run through the same builder. Neither provider syncs bill LINE items
 * (their bills are account-based and their APIs expose no purchases-by-item
 * report), so those connections get the honest empty state.
 */

const pool = require('../config/db');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

async function getOrgId(userId) {
  const [[row]] = await pool.execute('SELECT org_id FROM zb_tokens WHERE user_id = ?', [userId]);
  return row?.org_id || null;
}

function resolveRange(params) {
  const from = params.from_date || params.from || null;
  const to = params.to_date || params.to || null;
  if (from && to) return { from, to };
  // Default window: the fiscal year containing today, for the per-platform
  // start month (Settings → params.fy_start_month; defaults to 4 = 1 April).
  const { fyWindow, fyMonth } = require('./reportContext');
  const _fy = fyWindow(fyMonth(params.fy_start_month));
  return { from: from || _fy.from, to: to || _fy.to };
}

async function buildPurchasesByItem(userId, params = {}) {
  const orgId = params.org_id || (await getOrgId(userId));
  if (!orgId) {
    const err = new Error('Provider not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const { from, to } = resolveRange(params);

  const [rows] = await pool.execute(
    `SELECT li.zoho_item_id                                AS itemId,
            MIN(li.item_name)                              AS itemName,
            COALESCE(NULLIF(MIN(li.unit), ''), NULLIF(MIN(it.unit), ''), '') AS unit,
            MAX(COALESCE(it.is_combo_product, 0))          AS isCombo,
            SUM(li.quantity)                               AS qty,
            SUM(li.item_total)                             AS amount
       FROM zb_bill_line_items li
       JOIN bills b
         ON b.zoho_id = li.zoho_bill_id AND b.org_id = li.org_id
       LEFT JOIN zb_items it
         ON it.zoho_item_id = li.zoho_item_id AND it.org_id = li.org_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND COALESCE(b.is_deleted, 0) = 0
        AND b.date BETWEEN ? AND ?
        AND COALESCE(li.zoho_item_id, '') <> ''
      GROUP BY li.zoho_item_id
      ORDER BY itemName ASC`,
    [userId, orgId, from, to]
  );

  const columns = [
    { key: 'label',    label: 'Item ID',            align: 'left'  },
    { key: 'itemName', label: 'Item Name',          align: 'left'  },
    { key: 'unit',     label: 'Unit',               align: 'left'  },
    { key: 'isCombo',  label: 'Is Combo Product',   align: 'left'  },
    { key: 'quantity', label: 'Quantity Purchased', align: 'right' },
    { key: 'amount',   label: 'Amount',             align: 'right', money: true },
    { key: 'avgPrice', label: 'Average Price',      align: 'right', money: true },
  ];

  const out = [];
  const grand = { qty: 0, amount: 0 };

  for (const r of rows) {
    const qty = num(r.qty);
    const amount = num(r.amount);
    out.push({
      label: String(r.itemId),
      level: 0,
      cells: {
        itemName: r.itemName || '(Unnamed item)',
        unit: r.unit || '',
        isCombo: num(r.isCombo) ? 'true' : 'false',
        quantity: round2(qty),
        amount: round2(amount),
        // Zoho shows the blended price paid, so an item bought at two different
        // rates averages them; a zero-quantity line has no price to show.
        avgPrice: qty ? round2(amount / qty) : null,
      },
    });
    grand.qty += qty;
    grand.amount += amount;
  }

  // Nothing purchased (or a provider that syncs no bill line items) — report the
  // empty state honestly rather than a lone Total row.
  if (!out.length) {
    return {
      columns,
      rows: [],
      currency: 'INR',
      empty: true,
      emptyReason: 'no_data',
      meta: { title: 'Purchases by Item', from, to, source: 'warehouse' },
    };
  }

  out.push({
    label: 'Total',
    isTotal: true,
    level: 0,
    // Average Price is deliberately blank on the Total — an average of averages
    // is not a price Zoho reports.
    cells: { quantity: round2(grand.qty), amount: round2(grand.amount), avgPrice: null },
  });

  return {
    columns,
    rows: out,
    currency: 'INR',
    zoho: {
      module: 'Purchases and Expenses',
      title: 'Purchases by Item',
      compareWith: true,
      totalCount: out.length - 1,
    },
    meta: { title: 'Purchases by Item', from, to, source: 'warehouse' },
  };
}

module.exports = { buildPurchasesByItem };
