// Date-range presets shared by the reports filter bar and the loadReportData
// thunk. Fiscal-year presets follow the configured fiscal-year start month for
// the active platform (Settings → Financial Year), so "This/Previous fiscal
// year" and the fiscal-quarter presets line up with the connected accounting
// org. Defaults to 1 April (Indian FY) until Settings loads a different month.

// Fiscal-year start month, 1..12. `settingsSlice` calls setFiscalYearStartMonth
// with the platform's configured value on load / org switch — mirrors
// setActiveCurrency in src/utils/fmt.js.
let _fyStartMonth = 4;
export function setFiscalYearStartMonth(m) {
  const n = Number(m);
  if (Number.isInteger(n) && n >= 1 && n <= 12) _fyStartMonth = n;
}
export function getFiscalYearStartMonth() {
  return _fyStartMonth;
}
// 0-indexed start month (0 = January) for Date math.
const fyM0 = () => _fyStartMonth - 1;

// Point-in-time / cumulative-snapshot reports — Balance Sheet, aging, Vendor
// Balance Detail, Chart of Accounts. These show a position "as of" a single
// date rather than activity over a range, so (like every platform's own
// report) they should default to TODAY, never to a range preset such as
// "Previous fiscal year" — a client whose data only starts partway through
// the current FY would otherwise open every one of these reports to a blank
// snapshot from before they had any transactions. Canonical list shared by the
// report viewer (which report names hide the "From" box / show "As of") and
// reportsSlice (which report names get today's date instead of the shared
// date-range preset) so the two can never drift apart.
export const AS_OF_REPORT_NAMES = new Set([
  'Balance Sheet', 'Balance Sheet Summary', 'Balance Sheet Detail',
  'Balance Sheet Comparison', 'Horizontal Balance Sheet',
  'AR Aging Summary', 'A/R Aging Summary', 'Aged Receivables Summary',
  'AR Aging Detail', 'A/R Aging Detail', 'Aged Receivables Detail',
  'AP Aging Summary', 'A/P Aging Summary', 'Aged Payables Summary',
  'AP Aging Detail', 'A/P Aging Detail', 'Aged Payables Detail',
  'Vendor Balance Detail', 'Chart of Accounts',
]);

export const DATE_PRESETS = [
  ['this-fiscal-year',     'This fiscal year'],
  ['previous-fiscal-year', 'Previous fiscal year'],
  ['today',                'Today'],
  ['this-week',            'This week'],
  ['this-month',           'This month'],
  ['this-quarter',         'This quarter'],
  ['this-year',            'This year (Jan–Dec)'],
  ['ytd',                  'Year to date'],
  ['yesterday',            'Yesterday'],
  ['previous-week',        'Previous week'],
  ['previous-month',       'Previous month'],
  ['previous-quarter',     'Previous quarter'],
  ['previous-year',        'Previous year (Jan–Dec)'],
  ['custom',               'Custom range'],
];

// Open reports on the previous fiscal year by default: the current fiscal year
// is typically only a month or two in (sparse/near-empty), whereas the prior
// FY has a full year of posted data — matching what Zoho shows out of the box.
export const DEFAULT_DATE_RANGE = 'previous-fiscal-year';

export const dateLabel = (id) =>
  DATE_PRESETS.find(([k]) => k === id)?.[1] || 'This fiscal year';

// Format a Date as YYYY-MM-DD using its LOCAL components. Using toISOString()
// here would shift dates built with new Date(y, m, d) back by a day in
// positive-UTC-offset timezones (e.g. IST), breaking fiscal-year boundaries.
export const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// Today as YYYY-MM-DD (local). The default "as of" for AS_OF_REPORT_NAMES.
export const todayYmd = () => ymd(new Date());

// Calendar year in which the fiscal year containing `today` began — e.g. for a
// 1-April FY: on 2026-06-01 → 2026, on 2026-02-01 → 2025. For a 1-January FY it
// is always today's calendar year.
function fiscalStartYear(today) {
  return today.getMonth() >= fyM0() ? today.getFullYear() : today.getFullYear() - 1;
}

// Resolve a DATE_PRESETS key into concrete { from_date, to_date } (YYYY-MM-DD)
// so the Zoho-live backend receives explicit dates.
export function resolvePresetRange(preset, custom = {}) {
  const today = new Date();
  const start = new Date(today); const end = new Date(today);
  const fy = fiscalStartYear(today);
  const y = today.getFullYear();
  const m = today.getMonth();
  const calQ = Math.floor(m / 3);                 // calendar quarter index
  const endLastMonth = new Date(y, m, 0);         // last day of the previous month
  // Fiscal-quarter boundaries anchored on the configured FY start month.
  const fMonthIdx = (m - fyM0() + 12) % 12;       // months since the FY start
  const fqIdx = Math.floor(fMonthIdx / 3);
  const fqStartAbs = fyM0() + fqIdx * 3;          // 0..21
  const fqStart = new Date(fy + Math.floor(fqStartAbs / 12), fqStartAbs % 12, 1);
  const fqEnd = new Date(fqStart.getFullYear(), fqStart.getMonth() + 3, 0);
  const lastFqStart = new Date(fqStart.getFullYear(), fqStart.getMonth() - 3, 1);
  const lastFqEnd = new Date(fqStart.getFullYear(), fqStart.getMonth(), 0);
  // Fiscal-year boundaries for the configured start month.
  const fyStart = new Date(fy, fyM0(), 1);              // start of the FY containing today
  const fyEnd = new Date(fy + 1, fyM0(), 0);            // its last day (day before next FY)
  const prevFyStart = new Date(fy - 1, fyM0(), 1);
  const prevFyEnd = new Date(fy, fyM0(), 0);
  switch (preset) {
    case 'this-fiscal-year':     return { from_date: ymd(fyStart),     to_date: ymd(today) };
    case 'previous-fiscal-year': return { from_date: ymd(prevFyStart), to_date: ymd(prevFyEnd) };
    case 'today':            return { from_date: ymd(today), to_date: ymd(today) };
    case 'yesterday':        start.setDate(start.getDate() - 1); end.setDate(end.getDate() - 1); return { from_date: ymd(start), to_date: ymd(end) };
    case 'this-week':        start.setDate(today.getDate() - today.getDay()); return { from_date: ymd(start), to_date: ymd(today) };
    case 'previous-week':    end.setDate(today.getDate() - today.getDay() - 1); start.setDate(end.getDate() - 6); return { from_date: ymd(start), to_date: ymd(end) };
    case 'this-month':       return { from_date: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), to_date: ymd(today) };
    case 'previous-month':   return { from_date: ymd(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to_date: ymd(new Date(today.getFullYear(), today.getMonth(), 0)) };
    case 'this-quarter':     { const q = Math.floor(today.getMonth() / 3); return { from_date: ymd(new Date(today.getFullYear(), q * 3, 1)), to_date: ymd(today) }; }
    case 'previous-quarter': { const q = Math.floor(today.getMonth() / 3); return { from_date: ymd(new Date(today.getFullYear(), (q - 1) * 3, 1)), to_date: ymd(new Date(today.getFullYear(), q * 3, 0)) }; }
    case 'this-year':        return { from_date: ymd(new Date(today.getFullYear(), 0, 1)), to_date: ymd(today) };
    case 'ytd':              return { from_date: ymd(new Date(today.getFullYear(), 0, 1)), to_date: ymd(today) };
    case 'previous-year':    return { from_date: ymd(new Date(today.getFullYear() - 1, 0, 1)), to_date: ymd(new Date(today.getFullYear() - 1, 11, 31)) };
    // ── Extended QuickBooks-style "Report period" options ──────────────────
    case 'all-dates':                    return { from_date: '1900-01-01', to_date: ymd(today) };
    case 'this-week-to-date':            { const s = new Date(today); s.setDate(today.getDate() - today.getDay()); return { from_date: ymd(s), to_date: ymd(today) }; }
    case 'this-month-to-date':           return { from_date: ymd(new Date(y, m, 1)), to_date: ymd(today) };
    case 'this-quarter-to-date':         return { from_date: ymd(new Date(y, calQ * 3, 1)), to_date: ymd(today) };
    case 'this-fiscal-quarter':          return { from_date: ymd(fqStart), to_date: ymd(fqEnd) };
    case 'this-fiscal-quarter-to-date':  return { from_date: ymd(fqStart), to_date: ymd(today) };
    case 'this-year-to-date':            return { from_date: ymd(new Date(y, 0, 1)), to_date: ymd(today) };
    case 'this-year-to-last-month':      return { from_date: ymd(new Date(y, 0, 1)), to_date: ymd(endLastMonth) };
    case 'this-fiscal-year-full':        return { from_date: ymd(fyStart), to_date: ymd(fyEnd) };
    case 'this-fiscal-year-to-last-month': return { from_date: ymd(fyStart), to_date: ymd(endLastMonth) };
    case 'last-6-months':                return { from_date: ymd(new Date(y, m - 6, 1)), to_date: ymd(new Date(y, m, 0)) };
    case 'last-week':                    { const e = new Date(today); e.setDate(today.getDate() - today.getDay() - 1); const s = new Date(e); s.setDate(e.getDate() - 6); return { from_date: ymd(s), to_date: ymd(e) }; }
    case 'last-week-to-date':
    case 'last-week-to-today':           { const s = new Date(today); s.setDate(today.getDate() - today.getDay() - 7); return { from_date: ymd(s), to_date: ymd(today) }; }
    case 'last-month':                   return { from_date: ymd(new Date(y, m - 1, 1)), to_date: ymd(new Date(y, m, 0)) };
    case 'last-month-to-date':
    case 'last-month-to-today':          return { from_date: ymd(new Date(y, m - 1, 1)), to_date: ymd(today) };
    case 'last-quarter':                 return { from_date: ymd(new Date(y, (calQ - 1) * 3, 1)), to_date: ymd(new Date(y, calQ * 3, 0)) };
    case 'last-quarter-to-date':         return { from_date: ymd(new Date(y, (calQ - 1) * 3, 1)), to_date: ymd(today) };
    case 'last-fiscal-quarter':          return { from_date: ymd(lastFqStart), to_date: ymd(lastFqEnd) };
    case 'last-fiscal-quarter-to-date':  return { from_date: ymd(lastFqStart), to_date: ymd(today) };
    case 'last-year-to-date':            return { from_date: ymd(new Date(y - 1, 0, 1)), to_date: ymd(new Date(y - 1, m, today.getDate())) };
    case 'last-fiscal-year-to-date':     return { from_date: ymd(prevFyStart), to_date: ymd(new Date(y - 1, m, today.getDate())) };
    case 'last-quarter-to-today':        return { from_date: ymd(new Date(y, (calQ - 1) * 3, 1)), to_date: ymd(today) };
    case 'last-year-to-last-month':      return { from_date: ymd(new Date(y - 1, 0, 1)), to_date: ymd(new Date(y - 1, m, 0)) };
    case 'last-fiscal-year-to-last-month': return { from_date: ymd(prevFyStart), to_date: ymd(new Date(y - 1, m, 0)) };
    case 'since-30-days':                { const s = new Date(today); s.setDate(today.getDate() - 30); return { from_date: ymd(s), to_date: ymd(today) }; }
    case 'since-60-days':                { const s = new Date(today); s.setDate(today.getDate() - 60); return { from_date: ymd(s), to_date: ymd(today) }; }
    case 'since-90-days':                { const s = new Date(today); s.setDate(today.getDate() - 90); return { from_date: ymd(s), to_date: ymd(today) }; }
    case 'since-365-days':               { const s = new Date(today); s.setDate(today.getDate() - 365); return { from_date: ymd(s), to_date: ymd(today) }; }
    case 'next-week':                    { const s = new Date(today); s.setDate(today.getDate() - today.getDay() + 7); const e = new Date(s); e.setDate(s.getDate() + 6); return { from_date: ymd(s), to_date: ymd(e) }; }
    case 'next-4-weeks':                 { const e = new Date(today); e.setDate(today.getDate() + 28); return { from_date: ymd(today), to_date: ymd(e) }; }
    case 'next-month':                   return { from_date: ymd(new Date(y, m + 1, 1)), to_date: ymd(new Date(y, m + 2, 0)) };
    case 'next-quarter':                 return { from_date: ymd(new Date(y, (calQ + 1) * 3, 1)), to_date: ymd(new Date(y, (calQ + 2) * 3, 0)) };
    case 'next-year':                    return { from_date: ymd(new Date(y + 1, 0, 1)), to_date: ymd(new Date(y + 1, 11, 31)) };
    case 'custom':           return { from_date: custom?.from || ymd(today), to_date: custom?.to || ymd(today) };
    default:                 return { from_date: ymd(fyStart), to_date: ymd(today) };
  }
}
