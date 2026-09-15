// Currency → display symbol + locale used for grouping/decimals.
// Indian Rupee uses en-IN (lakh/crore comma placement); everything else en-US.
const CURRENCY_META = {
  INR: { symbol: '₹', locale: 'en-IN' },
  USD: { symbol: '$', locale: 'en-US' },
  EUR: { symbol: '€', locale: 'en-IE' },
  GBP: { symbol: '£', locale: 'en-GB' },
  AED: { symbol: 'د.إ', locale: 'en-AE' },
};

function meta(code) {
  if (!code) return CURRENCY_META.USD;
  return CURRENCY_META[String(code).toUpperCase()] || { symbol: code + ' ', locale: 'en-US' };
}

// Active display currency for callers that don't pass an explicit `currency`
// (e.g. the dashboard tiles). Defaults to INR so existing Zoho/legacy behaviour
// is unchanged; the dashboard sets it to the connected company's currency
// (USD for QuickBooks, the org currency for Xero) so figures render with the
// correct symbol everywhere.
let _activeCurrency = 'INR';
export function setActiveCurrency(code) {
  if (code) _activeCurrency = String(code).toUpperCase();
}
export function getActiveCurrency() {
  return _activeCurrency;
}

// `locale` lets a caller override the currency-derived digit grouping — used
// by the report viewer's "Number format" filter (Indian lakh/crore vs
// International thousands) so picking it actually changes the printed digits
// instead of being a decorative no-op.
// `parens: true` renders a negative in accounting style — `(1,234.00)` with no
// leading minus — used by the Balance Sheet.
export function fmt(n, opts = {}) {
  const { dec = 0, sign, currency, locale, parens = false } = opts;
  const m = meta(currency || _activeCurrency);
  const useSign = sign != null ? sign : m.symbol;
  if (n == null || isNaN(n)) return useSign + '0';
  const abs = Math.abs(n);
  const v = abs.toLocaleString(locale || m.locale, {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
  if (n < 0 && parens) return `(${useSign}${v})`;
  return (n < 0 ? '-' : '') + useSign + v;
}

// Compact money with currency-appropriate abbreviations: Indian Cr/L/k for INR,
// Western k/M/B for everything else. Used by the dashboard tiles in place of
// their previously INR-only formatters.
export function fmtMoneyCompact(n, currency = _activeCurrency) {
  const sym = currencySymbol(currency);
  if (n == null || isNaN(n)) return sym + '0';
  const abs = Math.abs(n);
  const s = n < 0 ? '-' : '';
  if (String(currency).toUpperCase() === 'INR') {
    if (abs >= 1e7) return `${s}${sym}${(abs / 1e7).toFixed(1)}Cr`;
    if (abs >= 1e5) return `${s}${sym}${(abs / 1e5).toFixed(1)}L`;
    if (abs >= 1e3) return `${s}${sym}${(abs / 1e3).toFixed(0)}k`;
    return `${s}${sym}${Math.round(abs)}`;
  }
  if (abs >= 1e9) return `${s}${sym}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${s}${sym}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${s}${sym}${(abs / 1e3).toFixed(1)}k`;
  return `${s}${sym}${Math.round(abs)}`;
}

export function fmtPct(n, dec = 1) {
  if (n == null || isNaN(n)) return '0%';
  return `${n.toFixed(dec)}%`;
}

export function fmtCompact(n) {
  if (n == null || isNaN(n)) return '0';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

// Format a selected period as "1 Apr 2024 – 31 Mar 2025" from ISO date strings.
export function fmtDateRange(from, to) {
  const one = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  if (!from || !to) return '';
  return `${one(from)} – ${one(to)}`;
}

export function currencySymbol(code) {
  return meta(code).symbol;
}

// Locale used for digit grouping (en-IN = lakh/crore commas for INR). Used by
// the count-up animation so in-progress values stay comma-grouped.
export function currencyLocale(code) {
  return meta(code).locale;
}
