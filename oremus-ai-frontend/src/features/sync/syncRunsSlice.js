import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import axiosClient from '../../services/axiosClient.js';

// Background provider syncs (Zoho / QuickBooks / Xero) the signed-in user
// started — e.g. an admin connecting a client — or that sync their own data.
// Served by GET /api/sync/runs: every running sync with its progress, plus the
// ones that finished in the last few minutes with their outcome.
export const loadSyncRuns = createAsyncThunk('syncRuns/load', async () => {
  const { data } = await axiosClient.get('/sync/runs');
  return data.runs || [];
});

// Mark that a sync is about to start (an OAuth connect just completed, or a
// "Sync now" was clicked). The server starts it in the background, so the bar
// keeps looking for it for a short while even if the first poll misses it.
const EXPECT_KEY = 'oremus_sync_expected_at';
export const SYNC_STARTED_EVENT = 'oremus:sync-started';
export function expectSyncRun() {
  try { sessionStorage.setItem(EXPECT_KEY, String(Date.now())); } catch { /* storage unavailable */ }
  // Wakes the progress bar if it's already mounted (a sync started in-page).
  window.dispatchEvent(new Event(SYNC_STARTED_EVENT));
}
export function syncRunExpectedSince() {
  try {
    const t = Number(sessionStorage.getItem(EXPECT_KEY));
    return Number.isFinite(t) && t > 0 ? t : null;
  } catch {
    return null;
  }
}
export function clearSyncRunExpected() {
  try { sessionStorage.removeItem(EXPECT_KEY); } catch { /* storage unavailable */ }
}

const syncRunsSlice = createSlice({
  name: 'syncRuns',
  initialState: { runs: [], loaded: false },
  reducers: {},
  extraReducers: (b) => {
    b.addCase(loadSyncRuns.fulfilled, (s, a) => { s.runs = a.payload; s.loaded = true; });
    // A failed poll keeps the last known state — the bar shouldn't flicker away.
  },
});

export const selectSyncRuns = (s) => s.syncRuns.runs;
export const selectActiveSyncRuns = (s) => s.syncRuns.runs.filter((r) => r.status === 'running');
// Latest run for one client's data (newest first from the server).
export const selectSyncRunForClient = (clientUserId) => (s) =>
  s.syncRuns.runs.find((r) => String(r.clientUserId) === String(clientUserId)) || null;

export default syncRunsSlice.reducer;
