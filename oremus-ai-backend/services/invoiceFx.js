'use strict';

/**
 * Invoice → base-currency conversion, using the exchange rate stored on the
 * invoice itself (invoices.exchange_rate — the rate the platform booked the
 * invoice at), for reports built from the `invoices` warehouse rather than the
 * ledger (AR Aging, Sales by Product/Service, …).
 *
 * The platforms store that rate in opposite directions:
 *   - QuickBooks ExchangeRate and Zoho exchange_rate = base units per 1 unit of
 *     the invoice currency (CAD invoice in a USD company: 0.723) → multiply.
 *   - Xero CurrencyRate = invoice-currency units per 1 base unit
 *     (USD invoice in an INR org: 0.0105) → divide.
 * An invoice already in the base currency, or with no usable rate, is left as is.
 */

const pool = require('../config/db');
const { getBaseCurrency } = require('./zohoChartOfAccountsService');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

const ctxCache = new Map();

// { base, divide } for an org — cached per process (neither changes).
async function invoiceFxContext(orgId) {
  const key = String(orgId || '');
  if (ctxCache.has(key)) return ctxCache.get(key);
  const [[xero]] = await pool.execute('SELECT 1 AS x FROM xero_organizations WHERE tenant_id = ? LIMIT 1', [key])
    .catch(() => [[null]]);
  const ctx = { base: await getBaseCurrency(orgId), divide: !!xero };
  ctxCache.set(key, ctx);
  return ctx;
}

// Multiplier taking an amount in `currencyCode` to the base currency.
function rateToBase(currencyCode, exchangeRate, ctx) {
  const code = String(currencyCode || '').toUpperCase();
  if (!code || !ctx?.base || code === ctx.base) return 1;
  const r = num(exchangeRate);
  if (r <= 0) return 1;
  return ctx.divide ? 1 / r : r;
}

// Amount in the invoice's currency → base currency, at the invoice's own rate.
function toBase(amount, inv, ctx) {
  const m = rateToBase(inv?.currency_code, inv?.exchange_rate, ctx);
  return m === 1 ? num(amount) : round2(num(amount) * m);
}

// Convert invoice rows in place: total / balance / _balanceAsOf and the as-of
// breakdown lines. Call AFTER attachAsOfBalances — that rewind runs in the
// invoice's own currency (payments and credit notes are recorded in it too).
function convertInvoicesToBase(invoices, ctx) {
  for (const inv of invoices) {
    const m = rateToBase(inv.currency_code, inv.exchange_rate, ctx);
    if (m === 1) continue;
    inv.native_currency_code = inv.currency_code;
    for (const k of ['total', 'balance', '_balanceAsOf', 'tax_total']) {
      if (inv[k] != null) inv[k] = round2(num(inv[k]) * m);
    }
    if (Array.isArray(inv._breakdown)) {
      inv._breakdown = inv._breakdown.map((b) => ({ ...b, amount: b.amount == null ? b.amount : round2(num(b.amount) * m) }));
    }
    inv.currency_code = ctx.base;
  }
  return invoices;
}

module.exports = { invoiceFxContext, rateToBase, toBase, convertInvoicesToBase };
