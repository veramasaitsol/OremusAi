// Period-over-period comparison, shared by every dashboard metric.
//
// previousPeriod(from, to) → the immediately preceding EQUIVALENT range:
//   • whole months (from the 1st to a month end) → the same number of whole
//     months just before:  Sep 1–30 → Aug 1–31,  Jul 1–Sep 30 → Apr 1–Jun 30,
//     Apr 1 2025–Mar 31 2026 (a full FY) → Apr 1 2024–Mar 31 2025
//   • year-to-date (starts 1 Jan or on the FY start, ends mid-month, under a
//     year) → the same dates one year earlier: Apr 1–Oct 2 → Apr 1–Oct 2 last year
//   • anything else → the same number of days just before:
//     Sep 15–30 (16 days) → Aug 30–Sep 14
// Dates are plain YYYY-MM-DD and all arithmetic is in UTC calendar days, so
// the local timezone can never shift a boundary.
//
// growthPct(current, previous) → (current − previous) / |previous| × 100, or
// null when it can't be measured (a value missing, or previous = 0 while
// current isn't). Both zero → 0 (a real "no change").
//
// The backend keeps an identical copy (oremus-ai-backend/utils/periodCompare.js)
// for the endpoints that compute their own prior period.

const DAY = 86400000;
const parse = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
};
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const lastDayOfMonth = (t) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
};
const shiftYears = (t, years) => {
  const d = new Date(t);
  const day = d.getUTCDate();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  if (d.getUTCDate() !== day) d.setUTCDate(0); // 29 Feb → 28 Feb
  return d.getTime();
};

export function previousPeriod(from, to, { fyStartMonth = 4 } = {}) {
  const f = parse(from);
  const t = parse(to);
  if (Number.isNaN(f) || Number.isNaN(t) || t < f) return null;
  const fd = new Date(f);
  const td = new Date(t);

  // Whole months → the same number of whole months immediately before.
  if (fd.getUTCDate() === 1 && t === lastDayOfMonth(t)) {
    const months = (td.getUTCFullYear() - fd.getUTCFullYear()) * 12 + (td.getUTCMonth() - fd.getUTCMonth()) + 1;
    const prevFrom = Date.UTC(fd.getUTCFullYear(), fd.getUTCMonth() - months, 1);
    return { from: iso(prevFrom), to: iso(f - DAY) };
  }

  // Year-to-date → the same dates one year earlier.
  const startsYear = fd.getUTCDate() === 1 && (fd.getUTCMonth() === 0 || fd.getUTCMonth() === fyStartMonth - 1);
  if (startsYear && t < shiftYears(f, 1)) {
    return { from: iso(shiftYears(f, -1)), to: iso(shiftYears(t, -1)) };
  }

  // Otherwise → the same number of days immediately before.
  const days = Math.round((t - f) / DAY) + 1;
  return { from: iso(f - days * DAY), to: iso(f - DAY) };
}

export function growthPct(current, previous) {
  const c = Number(current);
  const p = Number(previous);
  if (current == null || previous == null || !Number.isFinite(c) || !Number.isFinite(p)) return null;
  if (p === 0) return c === 0 ? 0 : null;
  return ((c - p) / Math.abs(p)) * 100;
}
