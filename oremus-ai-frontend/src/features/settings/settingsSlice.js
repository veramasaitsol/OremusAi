import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import axiosClient from '../../services/axiosClient.js';
import { setFiscalYearStartMonth } from '../reports/data/dateRanges.js';

// Report settings — per-platform Financial Year start month.
// GET /api/settings/report returns:
//   { effective: { zoho|quickbooks|xero: { fyStartMonth } },
//     admin?: { <platform>: { fyStartMonth | null } },   // admins
//     own?:   { <platform>: { fyStartMonth | null } },   // clients
//     myPlatforms, defaults, canEditAdmin, canEditOwn }

export const loadReportSettings = createAsyncThunk(
  'settings/loadReport',
  async () => {
    const { data } = await axiosClient.get('/settings/report');
    return data;
  },
);

// scope: 'admin' | 'own'
export const saveReportSettings = createAsyncThunk(
  'settings/saveReport',
  async ({ scope, platform, fyStartMonth }, { dispatch, rejectWithValue }) => {
    try {
      await axiosClient.put('/settings/report', { scope, platform, fyStartMonth });
      await dispatch(loadReportSettings());
      return { platform, scope };
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  },
);

// System default FY start month per platform — used until /settings/report
// loads (the server is the source of truth: client → admin → system default).
export const SYSTEM_DEFAULT_FY = { zoho: 4, quickbooks: 1, xero: 1 };

// The resolved FY start month for `platform` (1..12).
export function resolveFyStartMonth(effective, platform) {
  const m = Number(effective && platform && effective[platform]?.fyStartMonth);
  if (Number.isInteger(m) && m >= 1 && m <= 12) return m;
  return SYSTEM_DEFAULT_FY[platform] || 4;
}

// Push the active platform's FY start month everywhere it's used: the Redux
// state (dashboard period presets re-derive from it) and the report
// date-range util (module-level, mirrors setActiveCurrency).
export function applyReportSettings(effective, platform, dispatch) {
  if (!platform) return;
  const month = resolveFyStartMonth(effective, platform);
  setFiscalYearStartMonth(month);
  if (dispatch) dispatch(setActiveFyStartMonth(month));
}

const settingsSlice = createSlice({
  name: 'settings',
  initialState: {
    status: 'idle',        // 'idle' | 'loading' | 'succeeded' | 'failed'
    effective: {},         // { platform: { fyStartMonth } }
    admin: null,
    own: null,
    myPlatforms: [],
    defaults: { fyStartMonth: 4 },
    inherited: {},          // { platform: { fyStartMonth } } — what "inherit" resolves to
    systemDefaults: SYSTEM_DEFAULT_FY,
    activeFyStartMonth: 4,  // resolved FY of the platform currently being viewed
    canEditAdmin: false,
    canEditOwn: false,
    saving: false,
    error: null,
  },
  reducers: {
    setActiveFyStartMonth(s, a) {
      const m = Number(a.payload);
      if (Number.isInteger(m) && m >= 1 && m <= 12) s.activeFyStartMonth = m;
    },
  },
  extraReducers: (b) => {
    b
      .addCase(loadReportSettings.pending, (s) => { s.status = 'loading'; s.error = null; })
      .addCase(loadReportSettings.fulfilled, (s, a) => {
        s.status = 'succeeded';
        s.effective = a.payload.effective || {};
        s.admin = a.payload.admin || null;
        s.own = a.payload.own || null;
        s.myPlatforms = a.payload.myPlatforms || [];
        s.defaults = a.payload.defaults || s.defaults;
        s.canEditAdmin = !!a.payload.canEditAdmin;
        s.canEditOwn = !!a.payload.canEditOwn;
        s.inherited = a.payload.inherited || {};
        s.systemDefaults = a.payload.systemDefaults || s.systemDefaults;
      })
      .addCase(loadReportSettings.rejected, (s, a) => { s.status = 'failed'; s.error = a.error?.message || 'load failed'; })
      .addCase(saveReportSettings.pending, (s) => { s.saving = true; s.error = null; })
      .addCase(saveReportSettings.fulfilled, (s) => { s.saving = false; })
      .addCase(saveReportSettings.rejected, (s, a) => { s.saving = false; s.error = a.payload || 'save failed'; });
  },
});

export const { setActiveFyStartMonth } = settingsSlice.actions;

export const selectReportSettings = (s) => s.settings;
export const selectActiveFyStartMonth = (s) => s.settings?.activeFyStartMonth || 4;
export const selectEffectiveReportSettings = (s) => s.settings.effective;

export default settingsSlice.reducer;
