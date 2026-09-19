'use strict';
// ISO 4217 code → symbol, for platforms (QuickBooks, Xero) whose API gives a
// currency CODE but no symbol. Zoho's own API already returns currency_symbol
// directly, so this isn't needed there. Fixed, non-invented mapping — not
// derived from any one client's data. Unmapped codes fall back to the code
// itself (e.g. "AED"), never a fabricated symbol.
const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥', CNY: '¥', AUD: 'A$',
  CAD: 'C$', CHF: 'CHF', SGD: 'S$', AED: 'د.إ', HKD: 'HK$', NZD: 'NZ$',
  ZAR: 'R', SEK: 'kr', NOK: 'kr', DKK: 'kr', MXN: 'MX$', BRL: 'R$',
};

function currencySymbol(code) {
  return code ? (CURRENCY_SYMBOLS[code] || code) : null;
}

module.exports = { CURRENCY_SYMBOLS, currencySymbol };
