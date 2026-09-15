import { createSlice, createSelector } from '@reduxjs/toolkit';

export const PERIODS = [
  { id: 'today',        label: 'Today'            },
  { id: 'this_week',    label: 'This Week'         },
  { id: 'this_month',   label: 'This Month'        },
  { id: 'this_quarter', label: 'This Quarter'      },
  { id: 'this_year',    label: 'This Year'         },
  { id: 'yesterday',    label: 'Yesterday'         },
  { id: 'prev_week',    label: 'Previous Week'     },
  { id: 'prev_month',   label: 'Previous Month'    },
  { id: 'prev_quarter', label: 'Previous Quarter'  },
  { id: 'prev_year',    label: 'Previous Year'     },
  { id: 'custom',       label: 'Custom'            },
];

const initialState = {
  searchQuery: '',
  // APPLIED date filter — the only values that drive data fetches. These change
  // solely via applyFilters() (the "Apply" button), never on a raw date/period
  // click, so selecting a date no longer fires the API immediately.
  period: 'prev_year',
  customRange: { from: null, to: null },
  // DRAFT (pending) date filter — the period dropdowns/pills write here as the
  // user picks. Mirrors the applied values until committed by applyFilters().
  draftPeriod: 'prev_year',
  draftCustomRange: { from: null, to: null },
  basis: 'accrual', // 'accrual' | 'cash' — accounting basis for dashboard metrics
  customer: '',     // selected customer id ('' = all customers) — /metrics filter
  currency: '',     // selected currency id ('' = org base currency) — /metrics filter
};

const filtersSlice = createSlice({
  name: 'filters',
  initialState,
  reducers: {
    setSearchQuery(s, a) { s.searchQuery = a.payload; },
    // Date/period setters stage into DRAFT only — no fetch until applyFilters().
    setPeriod(s, a)      { s.draftPeriod = a.payload; },
    setCustomRange(s, a) { s.draftCustomRange = a.payload; },
    // Commit the pending date filter → applied. Consumers read the applied
    // period/customRange, so this is what actually triggers the refetch.
    applyFilters(s) {
      s.period = s.draftPeriod;
      s.customRange = s.draftCustomRange;
    },
    setBasis(s, a)       { s.basis = a.payload === 'cash' ? 'cash' : 'accrual'; },
    setCustomer(s, a)    { s.customer = a.payload || ''; },
    setCurrency(s, a)    { s.currency = a.payload || ''; },
    resetFilters()       { return initialState; },
  },
});

export const { setSearchQuery, setPeriod, setCustomRange, applyFilters, setBasis, setCustomer, setCurrency, resetFilters } = filtersSlice.actions;

export const selectSearchQuery = (s) => s.filters.searchQuery;
export const selectPeriod      = (s) => s.filters.period;
export const selectCustomRange = (s) => s.filters.customRange;
// Draft (pending) selectors — filter controls read these for their active state.
export const selectDraftPeriod      = (s) => s.filters.draftPeriod;
export const selectDraftCustomRange = (s) => s.filters.draftCustomRange;
// True when the pending date filter differs from what's applied (enables/
// highlights the Apply button).
export const selectFiltersDirty = (s) =>
  s.filters.draftPeriod !== s.filters.period ||
  s.filters.draftCustomRange.from !== s.filters.customRange.from ||
  s.filters.draftCustomRange.to !== s.filters.customRange.to;
export const selectBasis       = (s) => s.filters.basis || 'accrual';
export const selectCustomer    = (s) => s.filters.customer || '';
export const selectCurrency    = (s) => s.filters.currency || '';

const periodLabel = (period, customRange) => {
  if (period === 'custom' && customRange.from && customRange.to) {
    return `${customRange.from} → ${customRange.to}`;
  }
  return PERIODS.find((p) => p.id === period)?.label || 'This Year';
};

// Label of the APPLIED period (what the loaded data reflects — used in headers).
export const selectPeriodLabel = (s) => periodLabel(s.filters.period, s.filters.customRange);
// Label of the DRAFT period (what the user is about to apply — used in controls).
export const selectDraftPeriodLabel = (s) => periodLabel(s.filters.draftPeriod, s.filters.draftCustomRange);

// Format using LOCAL date components, NOT toISOString(): toISOString converts to
// UTC, which in IST (UTC+5:30) shifts a local-midnight date back a day (e.g.
// new Date(2026,5,1) → "2026-05-31"), breaking month/quarter/week boundaries.
const fmt = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Indian fiscal year runs Apr 1 – Mar 31.
const fyStartYear = (d) => (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1);

// Sunday-based week start
const weekStart = (d) => {
  const s = new Date(d);
  s.setDate(d.getDate() - d.getDay());
  s.setHours(0, 0, 0, 0);
  return s;
};

// Calendar quarter helpers
const qOf     = (mo) => Math.floor(mo / 3);
const qStart  = (y, q) => new Date(y, q * 3, 1);
const qEnd    = (y, q) => new Date(y, q * 3 + 3, 0);

export const selectDateRange = createSelector(
  selectPeriod,
  selectCustomRange,
  (period, customRange) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const y = today.getFullYear();
    const m = today.getMonth();

    if (period === 'custom') {
      return {
        from: customRange.from || `${y}-01-01`,
        to:   customRange.to   || fmt(today),
      };
    }

    switch (period) {
      case 'today':
        return { from: fmt(today), to: fmt(today) };

      case 'yesterday': {
        const d = new Date(today); d.setDate(today.getDate() - 1);
        return { from: fmt(d), to: fmt(d) };
      }

      case 'this_week':
        return { from: fmt(weekStart(today)), to: fmt(today) };

      case 'prev_week': {
        const thisSun = weekStart(today);
        const prevSat = new Date(thisSun); prevSat.setDate(thisSun.getDate() - 1);
        const prevSun = weekStart(prevSat);
        return { from: fmt(prevSun), to: fmt(prevSat) };
      }

      case 'this_month':
        return { from: fmt(new Date(y, m, 1)), to: fmt(new Date(y, m + 1, 0)) };

      case 'prev_month':
        return { from: fmt(new Date(y, m - 1, 1)), to: fmt(new Date(y, m, 0)) };

      case 'this_quarter': {
        const q = qOf(m);
        return { from: fmt(qStart(y, q)), to: fmt(qEnd(y, q)) };
      }

      case 'prev_quarter': {
        let q = qOf(m) - 1; let qy = y;
        if (q < 0) { q = 3; qy -= 1; }
        return { from: fmt(qStart(qy, q)), to: fmt(qEnd(qy, q)) };
      }

      case 'this_year': {
        const fy = fyStartYear(today);
        return { from: `${fy}-04-01`, to: `${fy + 1}-03-31` };
      }

      case 'prev_year': {
        const fy = fyStartYear(today) - 1;
        return { from: `${fy}-04-01`, to: `${fy + 1}-03-31` };
      }

      default: {
        const fy = fyStartYear(today);
        return { from: `${fy}-04-01`, to: fmt(today) };
      }
    }
  }
);

export default filtersSlice.reducer;
