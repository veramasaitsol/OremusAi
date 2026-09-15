'use strict';

/**
 * Vendor Contact List — QuickBooks' "Vendor Contact List".
 * ---------------------------------------------------------------------------
 * One row per vendor, alphabetically, carrying the contact card each platform
 * holds for that supplier:
 *
 *   Vendor | Company | Phone numbers | Email | Full name | Billing address
 *          | Account # | Tax ID | Track 1099
 *
 * This is a master list, not a period report — every vendor is shown and no
 * date filter applies, which is why QuickBooks prints it with a run timestamp
 * rather than a period. The count is footed so the sheet closes on a total.
 *
 * Built entirely from our own `vendors` warehouse, so the same builder serves
 * all three platforms. Each sync maps its own contact object onto the same
 * columns: QuickBooks' BillAddr / TaxIdentifier / Vendor1099 / AcctNum, Xero's
 * Addresses / TaxNumber / AccountNumber, Zoho's billing_address / gst_no.
 *
 * A column a platform does not keep stays blank rather than being invented —
 * Zoho and Xero have no 1099 flag (it is a US filing concept), so "Track 1099"
 * only prints for QuickBooks.
 */

const pool = require('../config/db');

async function getOrgId(userId) {
  const [[row]] = await pool.execute('SELECT org_id FROM zb_tokens WHERE user_id = ?', [userId]);
  return row?.org_id || null;
}

async function buildVendorContactList(userId, params = {}) {
  const orgId = params.org_id || (await getOrgId(userId));
  if (!orgId) {
    const err = new Error('Provider not connected (no org_id)');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const [rows] = await pool.execute(
    `SELECT contact_name, company_name, phone, email, full_name,
            billing_address, account_number, gst_no, track_1099
       FROM vendors
      WHERE user_id = ? AND org_id = ? AND COALESCE(is_deleted, 0) = 0
        AND COALESCE(NULLIF(contact_type, ''), 'vendor') = 'vendor'
      ORDER BY contact_name`,
    [userId, orgId]
  );

  const columns = [
    { key: 'label',    label: 'Vendor',        align: 'left' },
    { key: 'company',  label: 'Company',       align: 'left' },
    { key: 'phone',    label: 'Phone numbers', align: 'left' },
    { key: 'email',    label: 'Email',         align: 'left' },
    { key: 'fullName', label: 'Full name',     align: 'left' },
    { key: 'address',  label: 'Billing address', align: 'left' },
    { key: 'account',  label: 'Account #',     align: 'left' },
    { key: 'taxId',    label: 'Tax ID',        align: 'left' },
    { key: 'track1099', label: 'Track 1099',   align: 'left' },
  ];

  const out = rows.map((r) => ({
    label: r.contact_name || '(Unnamed)',
    level: 0,
    alwaysShow: true,
    cells: {
      company:  r.company_name || '',
      phone:    r.phone || '',
      email:    r.email || '',
      // QuickBooks falls back to the display name when a vendor has no
      // person-name parts, which is how its own export prints a company.
      fullName: r.full_name || r.contact_name || '',
      address:  r.billing_address || '',
      account:  r.account_number || '',
      taxId:    r.gst_no || '',
      // NULL means the platform has no such flag; only QuickBooks tracks 1099.
      track1099: r.track_1099 == null ? '' : (Number(r.track_1099) ? 'Yes' : 'No'),
    },
  }));

  if (!out.length) {
    return {
      columns,
      rows: [],
      empty: true,
      emptyReason: 'no_data',
      meta: { title: 'Vendor Contact List', source: 'warehouse' },
    };
  }

  out.push({
    label: `Total (${rows.length} vendors)`,
    isTotal: true,
    level: 0,
    alwaysShow: true,
    cells: {},
  });

  return {
    columns,
    rows: out,
    title: 'Vendor Contact List',
    meta: { title: 'Vendor Contact List', source: 'warehouse' },
  };
}

module.exports = { buildVendorContactList };
