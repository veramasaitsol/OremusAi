import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import axiosClient from '../../services/axiosClient.js';

const STORAGE_KEY = 'oremus_xero_v1';

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

export const verifyXeroStatus = createAsyncThunk(
  'xero/verifyStatus',
  async (_, { dispatch, rejectWithValue }) => {
    try {
      const { data } = await axiosClient.get('/auth/xero/status');
      if (data.connected) {
        dispatch(markXeroConnected({
          tenantId:       data.tenantId ?? null,
          tenantName:     data.tenantName ?? null,
          connectedAt:    data.connectedAt ?? null,
          expiresAt:      data.expiresAt ?? null,
          managedByAdmin: data.managedByAdmin ?? false,
        }));
      } else {
        dispatch(disconnectXero());
      }
      return data;
    } catch (e) {
      return rejectWithValue(e.message);
    }
  }
);

export const disconnectXeroRemote = createAsyncThunk(
  'xero/disconnectRemote',
  async (_, { dispatch, rejectWithValue }) => {
    try {
      await axiosClient.post('/auth/xero/disconnect');
      dispatch(disconnectXero());
      return true;
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  }
);

export const refreshXeroToken = createAsyncThunk(
  'xero/refresh',
  async (_, { rejectWithValue }) => {
    try {
      const { data } = await axiosClient.post('/auth/xero/refresh');
      if (!data.access_token) throw new Error('Refresh failed — no token returned');
      return { expires_at: data.expires_at };
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  }
);

// ── Slice ────────────────────────────────────────────────────────────────────
const stored = loadPersisted();

const xeroSlice = createSlice({
  name: 'xero',
  initialState: {
    connected:      !!stored?.tenant_id,
    tenantId:       stored?.tenant_id     ?? null,
    tenantName:     stored?.tenant_name   ?? null,
    connectedAt:    stored?.connected_at  ?? null,
    expiresAt:      stored?.expires_at    ?? null,
    managedByAdmin: stored?.managed_by_admin ?? false,
    status:         'idle',
    error:          null,
  },
  reducers: {
    markXeroConnected(state, action) {
      const p = action.payload || {};
      state.connected      = true;
      state.status         = 'succeeded';
      state.tenantId       = p.tenantId       ?? state.tenantId;
      state.tenantName     = p.tenantName     ?? state.tenantName;
      state.connectedAt    = p.connectedAt    ?? new Date().toISOString();
      state.expiresAt      = p.expiresAt      ?? state.expiresAt;
      state.managedByAdmin = p.managedByAdmin ?? state.managedByAdmin;
      persist({
        tenant_id:         state.tenantId,
        tenant_name:       state.tenantName,
        connected_at:      state.connectedAt,
        expires_at:        state.expiresAt,
        managed_by_admin:  state.managedByAdmin,
      });
    },
    disconnectXero(state) {
      state.connected      = false;
      state.tenantId       = null;
      state.tenantName     = null;
      state.connectedAt    = null;
      state.expiresAt      = null;
      state.managedByAdmin = false;
      state.status         = 'idle';
      state.error          = null;
      persist(null);
    },
    clearXeroError(state) {
      state.error  = null;
      state.status = 'idle';
    },
  },
  extraReducers: (b) => {
    b
      .addCase(refreshXeroToken.fulfilled, (s, a) => {
        s.expiresAt = a.payload.expires_at;
      })
      .addCase(refreshXeroToken.rejected, (s, a) => {
        s.connected = false;
        s.error     = a.payload ?? a.error.message;
        persist(null);
      });
  },
});

export const { markXeroConnected, disconnectXero, clearXeroError } = xeroSlice.actions;

export const selectXero          = (s) => s.xero;
export const selectXeroConnected = (s) => s.xero.connected;
export const selectXeroStatus    = (s) => s.xero.status;
export const selectXeroError     = (s) => s.xero.error;

export default xeroSlice.reducer;
