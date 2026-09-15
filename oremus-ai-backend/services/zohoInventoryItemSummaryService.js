'use strict';

/**
 * Inventory Item Summary — Xero's "Inventory Item Summary (Qty)".
 * ---------------------------------------------------------------------------
 * One row per item, grouped by whether the platform tracks its stock, with a
 * total per group and a grand total:
 *
 *   Item Code | Item Name | Opening Balance | Purchases | Sales | Adjustments
 *             | Closing Balance
 *
 * Opening Balance, Purchases, Adjustments and Closing Balance are QUANTITIES —
 * how many were on hand at the start, bought, adjusted during the period and
 * left at the end. "Sales" shows the sales VALUE (the money the period's sales
 * brought in) for every item; the former second Sales column (quantity) was
 * removed and the quantity is still computed internally for the closing
 * balance.
 *
 * Quantities are only meaningful for an item the platform keeps a stock ledger
 * for. Everything else — services, and goods bought and sold straight to an
 * expense account — sits under "Untracked" with zeroes, exactly as Xero prints
 * it: the quantity on such a line never moves an inventory asset, so there is
 * no balance to carry.
 *
 * Built entirely from our own warehouse, so the same builder serves all three
 * platforms:
 *  - the item list is the item master (`zb_items`) unioned with every item
 *    actually invoiced or billed, which is how QuickBooks and Xero — who sync
 *    no item master — still get their items;
 *  - movements come from the invoice and bill lines that reference an item,
 *    with everything dated before the period opening the balance.
 *
 * A line that names no item is left out. QuickBooks and Xero bills are usually
 * account-based, and the sync keys such a line by a digest of its description
 * (`qbo:l:…` / `xero:l:…`) so the purchase reports can group by it — but a
 * one-off description is not a stocked item and has no place on this report.
 */

const pool = require('../config/db');
const { getBaseCurrency } = require('./zohoChartOfAccountsService');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

async function getOrgId(userId) {
  const [[row]] = await pool.execute('SELECT org_id FROM zb_tokens WHERE user_id = ?', [userId]);
  return row?.org_id || null;
}

function resolveRange(params) {
  const from = params.from_date || params.from || null;
  const to = params.to_date || params.to || null;
  if (from && to) return { from: String(from).slice(0, 10), to: String(to).slice(0, 10) };
  // Default window: the fiscal year containing today, for the per-platform
  // start month (Settings → params.fy_start_month; defaults to 4 = 1 April).
  const { fyWindow, fyMonth } = require('./reportContext');
  const _fy = fyWindow(fyMonth(params.fy_start_month));
  return { from: from || _fy.from, to: to || _fy.to };
}

async function buildInventoryItemSummary(userId, params = {}) {
  const orgId = params.org_id || (await getOrgId(userId));
  if (!orgId) {
    const err = new Error('Provider not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const { from, to } = resolveRange(params);

  const [master] = await pool.execute(
    `SELECT zoho_item_id AS id,
            COALESCE(NULLIF(sku, ''), '')                   AS code,
            COALESCE(NULLIF(item_name, ''), name, '')       AS name,
            product_type, inventory_account_id, initial_stock
       FROM zb_items
      WHERE user_id = ? AND org_id = ? AND COALESCE(is_deleted, 0) = 0`,
    [userId, orgId]
  );

  // Sold: quantity and value inside the period, quantity before it.
  const [sold] = await pool.execute(
    `SELECT li.zoho_item_id AS id, MIN(li.item_name) AS name,
            SUM(CASE WHEN i.date BETWEEN ? AND ? THEN li.quantity   ELSE 0 END) AS qty,
            SUM(CASE WHEN i.date BETWEEN ? AND ? THEN li.item_total ELSE 0 END) AS value,
            SUM(CASE WHEN i.date < ? THEN li.quantity ELSE 0 END)               AS priorQty
       FROM zb_invoice_line_items li
       JOIN invoices i
         ON i.zoho_id = li.zoho_invoice_id AND i.org_id = li.org_id AND i.user_id = li.user_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND COALESCE(i.is_deleted, 0) = 0
        AND LOWER(COALESCE(i.status, '')) NOT IN ('draft', 'void', 'voided')
        AND i.date <= ?
        AND COALESCE(li.zoho_item_id, '') <> ''
        AND li.zoho_item_id NOT LIKE '%:l:%'
      GROUP BY li.zoho_item_id`,
    [from, to, from, to, from, userId, orgId, to]
  );

  // Bought: the same, off the bills.
  const [bought] = await pool.execute(
    `SELECT li.zoho_item_id AS id, MIN(li.item_name) AS name,
            SUM(CASE WHEN b.date BETWEEN ? AND ? THEN li.quantity ELSE 0 END) AS qty,
            SUM(CASE WHEN b.date < ? THEN li.quantity ELSE 0 END)             AS priorQty
       FROM zb_bill_line_items li
       JOIN bills b
         ON b.zoho_id = li.zoho_bill_id AND b.org_id = li.org_id AND b.user_id = li.user_id
      WHERE li.user_id = ? AND li.org_id = ?
        AND COALESCE(b.is_deleted, 0) = 0
        AND b.date <= ?
        AND COALESCE(li.zoho_item_id, '') <> ''
        AND li.zoho_item_id NOT LIKE '%:l:%'
      GROUP BY li.zoho_item_id`,
    [from, to, from, userId, orgId, to]
  );

  const currency = await getBaseCurrency(orgId);

  const columns = [
    { key: 'label',       label: 'Item Code',       align: 'left'  },
    { key: 'name',        label: 'Item Name',       align: 'left'  },
    { key: 'opening',     label: 'Opening Balance', align: 'right' },
    { key: 'purchases',   label: 'Purchases',       align: 'right' },
    { key: 'sales',       label: 'Sales',           align: 'right' },
    { key: 'adjustments', label: 'Adjustments',     align: 'right' },
    { key: 'closing',     label: 'Closing Balance', align: 'right' },
  ];

  // Every item we know of, whether it has a master record or only ever showed
  // up on a document.
  const items = new Map();
  const upsert = (id, patch) => {
    const key = String(id);
    if (!items.has(key)) items.set(key, { code: '', name: '', tracked: false, initial: 0 });
    Object.assign(items.get(key), patch);
  };

  for (const m of master) {
    upsert(m.id, {
      code: m.code || '',
      name: m.name || '',
      // Xero's split: stock the platform keeps a ledger for versus everything
      // else. Zoho marks that with a goods item pointing at an inventory account.
      tracked: m.product_type === 'goods'
        && m.inventory_account_id != null && String(m.inventory_account_id) !== '',
      initial: num(m.initial_stock),
    });
  }
  for (const s of sold) if (!items.has(String(s.id))) upsert(s.id, { name: s.name || '' });
  for (const b of bought) if (!items.has(String(b.id))) upsert(b.id, { name: b.name || '' });

  const soldBy = new Map(sold.map((r) => [String(r.id), r]));
  const boughtBy = new Map(bought.map((r) => [String(r.id), r]));

  const tracked = [];
  const untracked = [];

  for (const [id, it] of items) {
    const s = soldBy.get(id);
    const b = boughtBy.get(id);

    // Quantities are reported for tracked stock only — a closing balance of two
    // units of a consultancy service would be a fiction. The sales value is
    // reported for every item, since money earned means the same either way.
    // Single Sales column: shows the sales VALUE (money) for every item — the
    // separate quantity Sales column was removed. The sold QUANTITY is still
    // derived internally because the closing balance is quantity maths.
    const salesQty = it.tracked ? round2(num(s?.qty)) : 0;
    const cells = { name: it.name, opening: 0, purchases: 0, sales: round2(num(s?.value)), adjustments: 0, closing: 0 };
    if (it.tracked) {
      cells.opening = round2(it.initial + num(b?.priorQty) - num(s?.priorQty));
      cells.purchases = round2(num(b?.qty));
      // No platform in the warehouse syncs a stock-adjustment ledger, so the
      // closing balance is what the documents leave behind.
      cells.closing = round2(cells.opening + cells.purchases - salesQty);
    }

    (it.tracked ? tracked : untracked).push({ label: it.code, level: 2, cells, sortName: it.name });
  }

  const byCode = (a, b) => (a.label || '\uffff').localeCompare(b.label || '\uffff')
    || String(a.sortName || '').localeCompare(String(b.sortName || ''));
  tracked.sort(byCode);
  untracked.sort(byCode);

  const VALUE_KEYS = ['opening', 'purchases', 'sales', 'adjustments', 'closing'];
  const totalOf = (list) => {
    const t = {};
    for (const k of VALUE_KEYS) t[k] = round2(list.reduce((a, r) => a + num(r.cells[k]), 0));
    return t;
  };

  const rows = [];
  for (const g of [{ label: 'Tracked', list: tracked }, { label: 'Untracked', list: untracked }]) {
    if (!g.list.length) continue;
    rows.push({ label: g.label, isHeader: true, level: 0, cells: {} });
    for (const r of g.list) rows.push({ label: r.label, level: r.level, alwaysShow: true, cells: r.cells });
    rows.push({ label: `Total ${g.label}`, isSubtotal: true, level: 1, alwaysShow: true, cells: totalOf(g.list) });
  }

  if (!rows.length) {
    return {
      columns,
      rows: [],
      currency,
      empty: true,
      emptyReason: 'no_data',
      meta: { title: 'Inventory Item Summary (Qty)', from, to, source: 'warehouse' },
    };
  }

  rows.push({
    label: 'Total',
    isTotal: true,
    level: 0,
    alwaysShow: true,
    cells: totalOf([...tracked, ...untracked]),
  });

  return {
    columns,
    rows,
    currency,
    title: 'Inventory Item Summary (Qty)',
    meta: {
      title: 'Inventory Item Summary (Qty)',
      from,
      to,
      groupBy: 'Inventory Type',
      source: 'warehouse',
    },
  };
}

module.exports = { buildInventoryItemSummary };
