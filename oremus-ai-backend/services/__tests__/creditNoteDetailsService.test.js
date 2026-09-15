'use strict';

// Credit Notes must ALWAYS return the report's column format. When the org has
// no credit notes (the case for every platform right now) it returns the
// skeleton + { zoho: { emptyText: 'No data available' } } instead of nothing —
// mirrors zohoRecurringInvoicesService.
jest.mock('../../config/db', () => ({ execute: jest.fn(), query: jest.fn() }));

const pool = require('../../config/db');
const { buildCreditNoteDetails } = require('../zohoCreditNoteDetailsService');

const EXPECTED_KEYS = ['date', 'creditnote_number', 'label', 'status', 'total', 'balance'];

beforeEach(() => {
  pool.execute.mockReset();
});

describe('buildCreditNoteDetails — always returns the report format', () => {
  test('no resolvable org → column skeleton + "No data available"', async () => {
    pool.execute.mockResolvedValueOnce([[]]); // zb_tokens lookup: no row

    const res = await buildCreditNoteDetails(1, { platform: 'zoho' });

    expect(res._noLocalData).toBeUndefined();
    expect(res.columns.map((c) => c.key)).toEqual(EXPECTED_KEYS);
    expect(res.rows).toEqual([]);
    expect(res.zoho).toEqual({ emptyText: 'No data available' });
    expect(res.meta.title).toBe('Credit Note Details');
    expect(res.meta.platform).toBe('zoho');
  });

  test('org present but zero credit notes → same skeleton (any platform)', async () => {
    pool.execute.mockResolvedValueOnce([[]]); // zb_credit_notes query: no rows

    const res = await buildCreditNoteDetails(7, {
      org_id: 'REALM-123', platform: 'quickbooks',
      from_date: '2025-04-01', to_date: '2026-03-31',
    });

    expect(res.columns.map((c) => c.key)).toEqual(EXPECTED_KEYS);
    expect(res.rows).toEqual([]);
    expect(res.zoho.emptyText).toBe('No data available');
    expect(res.meta.platform).toBe('quickbooks');
    expect(res.meta.from).toBe('2025-04-01');
    expect(res.meta.to).toBe('2026-03-31');
    // org_id came from params → no token lookup needed
    expect(pool.execute).toHaveBeenCalledTimes(1);
  });

  test('with credit notes → data rows + Total, no emptyText', async () => {
    pool.execute.mockResolvedValueOnce([[
      { date: '2025-05-02', creditnote_number: 'CN-1', customer_name: 'Acme',
        status: 'open', total: 100, balance: 40, currency_code: 'USD' },
      { date: '2025-06-11', creditnote_number: 'CN-2', customer_name: 'Globex',
        status: 'closed', total: 250, balance: 0, currency_code: 'USD' },
    ]]);

    const res = await buildCreditNoteDetails(7, { org_id: 'TEN-9', platform: 'xero' });

    expect(res.zoho).toBeUndefined();
    expect(res.currency).toBe('USD');
    expect(res.rows).toHaveLength(3); // 2 notes + Total
    const total = res.rows[res.rows.length - 1];
    expect(total.isTotal).toBe(true);
    expect(total.cells.total).toBe(350);
    expect(total.cells.balance).toBe(40);
    expect(res.columns.map((c) => c.key)).toEqual(EXPECTED_KEYS);
  });
});
