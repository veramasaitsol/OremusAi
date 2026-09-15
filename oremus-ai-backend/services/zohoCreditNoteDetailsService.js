'use strict';

/**
 * Credit Note Details — built locally from the synced `zb_credit_notes` header
 * table instead of Zoho's live `/reports/creditnotedetails` endpoint. The live
 * transform (transformCreditNoteDetails) uses ONLY header fields
 * (date, creditnote_number, customer_name, status, total, balance), so the
 * header table is sufficient and we avoid spending a Zoho API call per load.
 *
 * Provider-agnostic: the same builder serves Zoho, QuickBooks and Xero. It is
 * scoped by (user_id, org_id) where org_id is the Zoho org / QBO realm_id / Xero
 * tenant_id — the caller passes it as params.org_id (X-Org-Id switcher or the
 * provider adapter).
 *
 * When the org has NO credit-note rows for the range, the report still renders
 * its full FORMAT — the column headers — with a "No data available" note inside,
 * instead of a bare empty sheet. Mirrors zohoRecurringInvoicesService so all
 * three platforms show the report skeleton rather than nothing.
 */

const pool = require('../config/db');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function r2(n) {
  return Math.round(num(n) * 100) / 100;
}

const COLUMNS = [
  { key: 'date',              label: 'Date',          align: 'left'  },
  { key: 'creditnote_number', label: 'Credit Note #', align: 'left'  },
  { key: 'label',             label: 'Customer',      align: 'left'  },
  { key: 'status',            label: 'Status',        align: 'left'  },
  { key: 'total',             label: 'Total',         align: 'right' },
  { key: 'balance',           label: 'Balance',       align: 'right' },
];

// Report-shaped "no data" payload: the full column skeleton + an emptyText note
// so the viewer renders the report FORMAT with "No data available" inside,
// instead of a blank sheet or a "no transactions" message.
function emptySkeleton({ currency = 'INR', platform = 'zoho', from = null, to = null } = {}) {
  return {
    columns: COLUMNS,
    rows: [],
    currency,
    zoho: { emptyText: 'No data available' },
    meta: { title: 'Credit Note Details', platform, from, to, source: 'ledger' },
  };
}

// Resolve the org to report on: an explicit org (X-Org-Id switcher / provider
// adapter) wins, otherwise fall back to the Zoho connection's primary org.
async function resolveOrgId(userId, params) {
  if (params.org_id) return params.org_id;
  const [[row]] = await pool.execute(
    'SELECT org_id FROM zb_tokens WHERE user_id = ?',
    [userId]
  );
  return row?.org_id || null;
}

// Period window: explicit from/to wins, else no date filter (all credit notes).
function resolveRange(params) {
  const to = params.to_date || params.date_end || null;
  const from = params.from_date || params.date_start || null;
  return { from, to };
}

async function buildCreditNoteDetails(userId, params = {}) {
  const platform = params.platform || 'zoho';
  const { from, to } = resolveRange(params);

  const orgId = await resolveOrgId(userId, params);
  if (!orgId) return emptySkeleton({ platform, from, to });

  const where = ['user_id = ?', 'org_id = ?'];
  const args = [userId, orgId];
  if (from && to) {
    where.push('date BETWEEN ? AND ?');
    args.push(from, to);
  }

  const [notes] = await pool.execute(
    `SELECT date, creditnote_number, customer_name, status,
            total, balance, currency_code
       FROM zb_credit_notes
      WHERE ${where.join(' AND ')}
      ORDER BY date ASC`,
    args
  );

  const currency = notes.find((n) => n.currency_code)?.currency_code || 'INR';

  // No credit notes for this org / range — still render the report's format
  // (column headers) with "No data available" instead of a bare empty sheet.
  if (!notes.length) return emptySkeleton({ currency, platform, from, to });

  const rows = [];
  let totT = 0;
  let totB = 0;
  for (const n of notes) {
    const total = r2(n.total);
    const balance = r2(n.balance);
    rows.push({
      label: n.customer_name || '—',
      cells: {
        date: n.date ? String(n.date).slice(0, 10) : '',
        creditnote_number: n.creditnote_number || '',
        status: n.status || '',
        total,
        balance,
      },
    });
    totT += total;
    totB += balance;
  }
  rows.push({ label: 'Total', isTotal: true, cells: { total: r2(totT), balance: r2(totB) } });

  return {
    columns: COLUMNS,
    rows,
    currency,
    meta: { title: 'Credit Note Details', platform, from, to, source: 'ledger' },
  };
}

module.exports = { buildCreditNoteDetails };
