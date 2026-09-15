import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { fetchDashboard } from './dashboardAPI.js';

export const loadDashboard = createAsyncThunk(
  'dashboard/load',
  async ({ clientId, from, to, basis } = {}) => fetchDashboard({ clientId, from, to, basis })
);

const dashboardSlice = createSlice({
  name: 'dashboard',
  initialState: {
    revExp: [],
    cashFlow: [],
    kpis: [],
    expenseMix: [],
    topCustomers: [],
    topVendors: [],
    compliances: [],
    aiInsights: [],
    activity: [],
    rawStats: {},
    status: 'idle',
    error: null,
  },
  reducers: {},
  extraReducers: (b) => {
    b.addCase(loadDashboard.pending, (s) => { s.status = 'loading'; s.error = null; })
     .addCase(loadDashboard.fulfilled, (s, a) => {
       s.status = 'succeeded';
       Object.assign(s, a.payload);
     })
     .addCase(loadDashboard.rejected, (s, a) => {
       s.status = 'failed';
       s.error = a.error.message;
     });
  },
});

export default dashboardSlice.reducer;
