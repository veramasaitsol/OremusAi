'use strict';

// Receivables for the Quick Ratio / AR Days: the A/R-typed account plus the
// trade receivables some QuickBooks companies keep as Other Current Assets
// (card / payment-processor settlements) — never tax, refund or related-party
// "receivables".
jest.mock('../../config/db', () => ({ execute: jest.fn(), query: jest.fn() }));
const { isTradeReceivable } = require('../keyRatiosService');

test.each([
  ['accounts_receivable', 'Accounts Receivable (A/R)', true],
  ['other_current_asset', 'Clipper Receivable', true],
  ['other_current_asset', 'Circle K Receivable', true],
  ['other_current_asset', 'Credit Card Receivable', true],
  ['other_current_asset', 'TDS Receivable FY 25-26', false],
  ['other_current_asset', 'IT Refund Receivable', false],
  ['other_current_asset', 'Related Party Receivables', false],
  ['other_current_asset', 'Employee Advance', false],
  ['fixed_asset', 'Clipper Receivable', false],
])('%s · %s → %s', (typeCode, name, expected) => {
  expect(isTradeReceivable(typeCode, name)).toBe(expected);
});
