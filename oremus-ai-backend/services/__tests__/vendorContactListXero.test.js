'use strict';

// Vendor Contact List for Xero: QuickBooks' list of active vendors, from the
// suppliers the Xero sync stores, with Xero's contact fields mapped onto it.
jest.mock('../../config/db', () => ({ execute: jest.fn(), query: jest.fn() }));

let pool;

beforeEach(() => {
  jest.resetModules();
  pool = require('../../config/db');
});

function mockDb({ xero = true, vendors = [] }) {
  pool.execute.mockImplementation(async (sql) => {
    if (/FROM xero_organizations/.test(sql)) return [xero ? [{ x: 1 }] : []];
    if (/FROM vendors/.test(sql)) {
      // The query itself must leave archived suppliers out for Xero.
      const activeOnly = /status, 'active'\) = 'active'/.test(sql);
      return [vendors.filter((v) => !activeOnly || (v.status || 'active') === 'active')];
    }
    return [[]];
  });
}

const vendor = (o) => ({
  contact_name: 'Bitla & Co.', company_name: 'Bitla & Co.', phone: '+91 40 23456789', email: 'accounts@bitla.in',
  full_name: null, billing_address: 'Plot No.21 Hyderabad 500004 India', account_number: '4746003110',
  gst_no: '36AAAFB1234C1Z5', track_1099: null, status: 'active', ...o,
});

test('Xero: active suppliers only, no Track 1099 column, Company blank when it repeats the name', async () => {
  mockDb({
    vendors: [
      vendor({}),
      vendor({ contact_name: 'Applaud Solutions UK Limited', company_name: 'Applaud Solutions UK Limited', full_name: 'James Reid' }),
      vendor({ contact_name: 'Old Courier', company_name: 'Old Courier', status: 'inactive' }),
    ],
  });
  const { buildVendorContactList } = require('../zohoVendorContactListService');
  const r = await buildVendorContactList(27, { org_id: 'tenant-1' });
  expect(r.columns.map((c) => c.label)).toEqual(
    ['Vendor', 'Company', 'Phone numbers', 'Email', 'Full name', 'Billing address', 'Account #', 'Tax ID']);
  expect(r.rows.map((x) => x.label)).toEqual(['Bitla & Co.', 'Applaud Solutions UK Limited', 'Total (2 vendors)']);
  expect(r.rows[0].cells).toEqual(expect.objectContaining({
    company: '', phone: '+91 40 23456789', fullName: 'Bitla & Co.', account: '4746003110', taxId: '36AAAFB1234C1Z5',
  }));
  expect(r.rows[1].cells.fullName).toBe('James Reid');
});

test('QuickBooks / Zoho keep their columns and Company as synced', async () => {
  mockDb({ xero: false, vendors: [vendor({ track_1099: 1 })] });
  const { buildVendorContactList } = require('../zohoVendorContactListService');
  const r = await buildVendorContactList(28, { org_id: 'realm-1' });
  expect(r.columns.map((c) => c.key)).toContain('track1099');
  expect(r.rows[0].cells).toEqual(expect.objectContaining({ company: 'Bitla & Co.', track1099: 'Yes' }));
});

describe('Xero contact fields', () => {
  const { xeroPhone, xeroAddress } = jest.requireActual('../xeroService');

  test('primary phone like QuickBooks: default, else mobile / direct / fax, with country and area code', () => {
    expect(xeroPhone([
      { PhoneType: 'DEFAULT', PhoneNumber: '' },
      { PhoneType: 'DDI', PhoneNumber: '23456789', PhoneAreaCode: '40', PhoneCountryCode: '+91' },
      { PhoneType: 'MOBILE', PhoneNumber: '9876543210', PhoneCountryCode: '91' },
    ])).toBe('+91 9876543210');
    expect(xeroPhone([{ PhoneType: 'DEFAULT', PhoneNumber: '23456789', PhoneAreaCode: '40', PhoneCountryCode: '91' }])).toBe('+91 40 23456789');
    expect(xeroPhone([{ PhoneType: 'DEFAULT', PhoneNumber: '' }])).toBeNull();
  });

  test('billing address: the postal (PO box) address Xero prints on documents, else the street address', () => {
    expect(xeroAddress([
      { AddressType: 'STREET', AddressLine1: 'Plot 5', City: 'Hyderabad' },
      { AddressType: 'POBOX', AddressLine1: 'PO Box 12', City: 'Hyderabad', PostalCode: '500032', Country: 'India' },
    ])).toBe('PO Box 12 Hyderabad 500032 India');
    expect(xeroAddress([{ AddressType: 'POBOX' }, { AddressType: 'STREET', AddressLine1: 'Plot 5', City: 'Hyderabad' }]))
      .toBe('Plot 5 Hyderabad');
  });
});
