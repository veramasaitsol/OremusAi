import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import axiosClient from '../../services/axiosClient.js';
import { QBO_ENV } from '../../config/env.js';

const STORAGE_KEY = 'oremus_qbo_v1';

// ── Persistence helpers ──────────────────────────────────────────────────────
function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function persist(data) {
  try {
    if (data) localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    else       localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

// ── Async thunks ─────────────────────────────────────────────────────────────

/**
 * Verify QuickBooks connection status with the backend.
 * Source of truth = backend qbo_tokens table.
 */
export const verifyQBOStatus = createAsyncThunk(
  'qbo/verifyStatus',
  async (_, { dispatch, rejectWithValue }) => {
    try {
      const { data } = await axiosClient.get('/auth/quickbooks/status');
      if (data.connected) {
        dispatch(markQBOConnected({
          realmId:     data.realmId ?? null,
          environment: data.environment ?? null,
          connectedAt: data.connectedAt ?? null,
          expiresAt:   data.expiresAt ?? null,
        }));
      } else {
        dispatch(disconnectQBO());
      }
      return data;
    } catch (e) {
      return rejectWithValue(e.message);
    }
  }
);

/** Trigger backend disconnect (revokes Intuit tokens and clears the DB row). */
export const disconnectQBORemote = createAsyncThunk(
  'qbo/disconnectRemote',
  async (_, { dispatch, rejectWithValue }) => {
    try {
      await axiosClient.post('/auth/quickbooks/disconnect');
      dispatch(disconnectQBO());
      return true;
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  }
);

/** Backend-driven access-token refresh. */
export const refreshQBOToken = createAsyncThunk(
  'qbo/refresh',
  async (_, { rejectWithValue }) => {
    try {
      const { data } = await axiosClient.post('/auth/quickbooks/refresh');
      if (!data.access_token) throw new Error('Refresh failed — no token returned');
      return { expires_at: data.expires_at };
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  }
);

// ── Slice ────────────────────────────────────────────────────────────────────
const stored = loadPersisted();

const qboSlice = createSlice({
  name: 'qbo',
  initialState: {
    connected:   !!stored?.realm_id,
    realmId:     stored?.realm_id     ?? null,
    environment: stored?.environment  ?? QBO_ENV,
    connectedAt: stored?.connected_at ?? null,
    expiresAt:   stored?.expires_at   ?? null,
    status:      'idle',   // 'idle' | 'loading' | 'succeeded' | 'failed'
    error:       null,
  },
  reducers: {
    markQBOConnected(state, action) {
      const p = action.payload || {};
      state.connected   = true;
      state.status      = 'succeeded';
      state.realmId     = p.realmId     ?? state.realmId;
      state.environment = p.environment ?? state.environment;
      state.connectedAt = p.connectedAt ?? new Date().toISOString();
      state.expiresAt   = p.expiresAt   ?? state.expiresAt;
      persist({
        realm_id:     state.realmId,
        environment:  state.environment,
        connected_at: state.connectedAt,
        expires_at:   state.expiresAt,
      });
    },
    disconnectQBO(state) {
      state.connected   = false;
      state.realmId     = null;
      state.connectedAt = null;
      state.expiresAt   = null;
      state.status      = 'idle';
      state.error       = null;
      persist(null);
    },
    clearQBOError(state) {
      state.error  = null;
      state.status = 'idle';
    },
  },
  extraReducers: (b) => {
    b
      .addCase(refreshQBOToken.fulfilled, (s, a) => {
        s.expiresAt = a.payload.expires_at;
      })
      .addCase(refreshQBOToken.rejected, (s, a) => {
        s.connected = false;
        s.error     = a.payload ?? a.error.message;
        persist(null);
      });
  },
});

export const { markQBOConnected, disconnectQBO, clearQBOError } = qboSlice.actions;

// ── Selectors ────────────────────────────────────────────────────────────────
export const selectQBO           = (s) => s.qbo;
export const selectQBOConnected  = (s) => s.qbo.connected;
export const selectQBOStatus     = (s) => s.qbo.status;
export const selectQBOError      = (s) => s.qbo.error;

export default qboSlice.reducer;
