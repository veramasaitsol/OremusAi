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

// Push the effective FY start month for `platform` into the date-range util
// (module-level, mirrors setActiveCurrency).
export function applyReportSettings(effective, platform) {
  const s = effective && platform && effective[platform];
  if (s) setFiscalYearStartMonth(s.fyStartMonth);
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
    canEditAdmin: false,
    canEditOwn: false,
    saving: false,
    error: null,
  },
  reducers: {},
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
      })
      .addCase(loadReportSettings.rejected, (s, a) => { s.status = 'failed'; s.error = a.error?.message || 'load failed'; })
      .addCase(saveReportSettings.pending, (s) => { s.saving = true; s.error = null; })
      .addCase(saveReportSettings.fulfilled, (s) => { s.saving = false; })
      .addCase(saveReportSettings.rejected, (s, a) => { s.saving = false; s.error = a.payload || 'save failed'; });
  },
});

export const selectReportSettings = (s) => s.settings;
export const selectEffectiveReportSettings = (s) => s.settings.effective;

export default settingsSlice.reducer;
