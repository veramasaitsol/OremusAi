'use strict';

/**
 * Recurring Invoices Report — provider-agnostic (Zoho, QuickBooks, Xero).
 * ---------------------------------------------------------------------------
 * Lists all recurring invoice templates for the connected organisation,
 * grouped by status (Active / Inactive), with a summary footer:
 *
 *   Recurrence Name | Customer | Frequency | Amount | Next Invoice | Status
 *
 * Reads the shared `zb_recurring_invoices` table which stores recurring
 * templates for all 3 platforms (distinguished by the `platform` column).
 */

const pool = require('../config/db');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function ymd(d) {
  if (!d) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const dt = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(d) {
  const iso = ymd(d);
  if (!iso) return '';
  const [y, m, dd] = iso.split('-');
  return `${dd} ${MONTHS[Number(m) - 1]} ${y}`;
}

function prettyStatus(s) {
  if (!s) return '';
  return String(s).charAt(0).toUpperCase() + String(s).slice(1).toLowerCase();
}

function prettyFrequency(freq, every) {
  if (!freq) return '';
  const f = String(freq).toLowerCase().replace(/s$/, ''); // "months" → "month"
  const n = Number(every) || 1;
  if (n === 1) return `Every ${f.charAt(0).toUpperCase() + f.slice(1)}`;
  return `Every ${n} ${f.charAt(0).toUpperCase() + f.slice(1)}s`;
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

// Detect platform from user's tokens.
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
  { key: 'label',        label: 'Recurrence Name', align: 'left'  },
  { key: 'customer',     label: 'Customer',        align: 'left'  },
  { key: 'frequency',    label: 'Frequency',       align: 'left'  },
  { key: 'amount',       label: 'Amount',          align: 'right' },
  { key: 'startDate',    label: 'Start Date',      align: 'left'  },
  { key: 'nextDate',     label: 'Next Invoice',    align: 'left'  },
  { key: 'status',       label: 'Status',          align: 'left'  },
];

/**
 * Build the Recurring Invoices report.
 * @param {number} userId
 * @param {object} params - { org_id, platform, status }
 */
async function buildRecurringInvoices(userId, params = {}) {
  const orgId = await resolveOrgId(userId, params.org_id);

  const platform = params.platform || await detectPlatform(userId);

  // Build query — filter by user_id, optionally by org_id.
  // When org_id is unavailable (admin without X-Client-Id), show all recurring
  // invoices for the user across all orgs.
  const where = ['ri.user_id = ?', 'ri.is_deleted = 0'];
  const args = [userId];

  if (orgId) {
    where.push('ri.org_id = ?');
    args.push(orgId);
  }

  // Optional status filter
  if (params.status) {
    where.push('ri.status = ?');
    args.push(params.status);
  }

  const [rows] = await pool.execute(
    `SELECT ri.recurrence_name, ri.customer_name, ri.status,
            ri.recurrence_frequency, ri.repeat_every,
            ROUND(ri.total, 2) AS total, ri.currency_code,
            ri.start_date, ri.end_date,
            ri.next_invoice_date, ri.last_sent_date,
            ri.reference_number, ri.platform
       FROM zb_recurring_invoices ri
      WHERE ${where.join(' AND ')}
      ORDER BY ri.status ASC, ri.recurrence_name ASC`,
    args
  );

  const currency = rows.find((r) => r.currency_code)?.currency_code || 'INR';

  // No recurring templates for this org — still render the report's full
  // format (column headers) with a "No data available" note inside instead of
  // a bare "no transactions during the selected date range" message.
  if (!rows.length) {
    return {
      columns: COLUMNS,
      rows: [],
      currency,
      zoho: { emptyText: 'No data available' },
      meta: { title: 'Recurring Invoices', platform, total: 0, activeTotal: 0 },
    };
  }

  const rows_out = [];
  let grandTotal = 0;
  let totalCount = 0;

  for (const r of rows) {
    const amt = num(r.total);
    grandTotal += amt;
    totalCount++;

    rows_out.push({
      label: r.recurrence_name || '(Unnamed)',
      level: 1,
      cells: {
        customer:  r.customer_name || '—',
        frequency: prettyFrequency(r.recurrence_frequency, r.repeat_every),
        amount:    amt,
        startDate: fmtDate(r.start_date),
        nextDate:  fmtDate(r.next_invoice_date),
        status:    prettyStatus(r.status),
      },
    });
  }

  // Summary footer
  rows_out.push({
    label: 'Total',
    isTotal: true,
    cells: {
      customer:  `${totalCount} recurring`,
      frequency: '',
      amount:    round2(grandTotal),
      startDate: '',
      nextDate:  '',
      status:    '',
    },
  });

  return {
    columns: COLUMNS,
    rows: rows_out,
    currency,
    meta: {
      title: 'Recurring Invoices',
      platform,
      total: totalCount,
      activeTotal: rows.filter(r => String(r.status).toLowerCase() === 'active').length,
    },
  };
}

module.exports = { buildRecurringInvoices };
