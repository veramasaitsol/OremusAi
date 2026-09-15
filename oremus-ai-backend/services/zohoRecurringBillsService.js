'use strict';

/**
 * Recurring Bills — modelled on Zoho Books' "Recurring Bills".
 * ---------------------------------------------------------------------------
 * Active recurring bill schedules with their vendor, frequency, next run date
 * and amount:
 *
 *   Profile Name | Vendor | Frequency | Start Date | Next Bill Date | Status | Amount
 *
 * Sourced from the synced Zoho warehouse (zb_recurring_bills). The schedule is
 * a master list (not period-bound); the from/to range is accepted but ignored
 * apart from being echoed in the report header, matching Zoho's behaviour.
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

const fmtDate = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${dt.getFullYear()}`;
};

function prettyFreq(freq, every) {
  if (!freq) return '';
  const f = String(freq).toLowerCase();
  const n = num(every) || 1;
  const label = { days: 'Day', weeks: 'Week', months: 'Month', years: 'Year' }[f] || freq;
  return n > 1 ? `Every ${n} ${label}s` : label + 'ly';
}

async function buildRecurringBills(userId, params = {}) {
  const orgId = params.org_id || (await getOrgId(userId));
  if (!orgId) {
    const err = new Error('Zoho not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const { from, to } = resolveRange(params);

  const [rows] = await pool.execute(
    `SELECT recurrence_name, vendor_name, recurrence_frequency, repeat_every,
            start_date, next_bill_date, status, total
       FROM zb_recurring_bills
      WHERE user_id = ? AND org_id = ? AND COALESCE(is_deleted, 0) = 0
      ORDER BY (status = 'active') DESC, recurrence_name`,
    [userId, orgId]
  );

  const columns = [
    { key: 'label',     label: 'Profile Name',  align: 'left'  },
    { key: 'vendor',    label: 'Vendor',        align: 'left'  },
    { key: 'frequency', label: 'Frequency',     align: 'left'  },
    { key: 'start',     label: 'Start Date',    align: 'left'  },
    { key: 'next',      label: 'Next Bill Date', align: 'left'  },
    { key: 'status',    label: 'Status',        align: 'left'  },
    { key: 'amount',    label: 'Amount',        align: 'right' },
  ];

  const out = [];
  let grand = 0;
  for (const r of rows) {
    out.push({
      label: r.recurrence_name || '(Unnamed profile)',
      level: 0,
      cells: {
        vendor: r.vendor_name || '',
        frequency: prettyFreq(r.recurrence_frequency, r.repeat_every),
        start: fmtDate(r.start_date),
        next: fmtDate(r.next_bill_date),
        status: r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : '',
        amount: round2(r.total),
      },
    });
    grand += num(r.total);
  }

  if (rows.length) {
    out.push({ label: 'Total', isTotal: true, level: 0, cells: { amount: round2(grand) } });
  }

  return {
    columns,
    rows: out,
    currency: 'INR',
    meta: {
      title: 'Recurring Bills',
      from, to,
      source: 'warehouse',
      note: rows.length ? undefined : 'No recurring bill schedules found.',
    },
  };
}

module.exports = { buildRecurringBills };
