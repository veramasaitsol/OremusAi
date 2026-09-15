import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import axiosClient from '../../services/axiosClient.js';
import { ZOHO_REDIRECT_URI, ZOHO_ORG_ID } from '../../config/env.js';

// Connection metadata only — access/refresh tokens live exclusively in the
// backend DB and are used only at sync time. This slice never persists or
// exposes credentials to the browser.
const STORAGE_KEY = 'oremus_zoho_v1';

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
 * Exchange a one-time OAuth code for tokens via the backend.
 * The backend does the server-to-server exchange with Zoho (no CORS / proxy needed),
 * saves tokens to the DB, and kicks off the background sync.
 * Works in both dev and production builds.
 */
export const connectZoho = createAsyncThunk(
  'zoho/connect',
  async (payload, { rejectWithValue }) => {
    // Accept either a plain code string (original flow) or { code, state } object
    // (admin-for-client flow where 'state' carries the client's JWT for user attribution).
    const code  = typeof payload === 'string' ? payload : payload?.code;
    const state = typeof payload === 'string' ? undefined : payload?.state;

    try {
      const { data } = await axiosClient.post('/auth/zoho/exchange', {
        code,
        redirect_uri: ZOHO_REDIRECT_URI,
        ...(state ? { state } : {}),
      });

      if (!data.success) throw new Error(data.error || 'Token exchange failed');

      return { organizationId: data.organizationId, expiresAt: data.expires_at ?? null };
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  }
);

/**
 * Verify Zoho connection status with the backend.
 * - If backend says connected  → mark connected in Redux (source of truth)
 * - If backend says not connected → clear any stale localStorage state
 * Call this on every layout mount so the popup always reflects reality.
 */
export const verifyZohoStatus = createAsyncThunk(
  'zoho/verifyStatus',
  async (_, { dispatch, rejectWithValue }) => {
    try {
      const { data } = await axiosClient.get('/auth/zoho/status');
      if (data.connected) {
        // Backend confirmed → mark connected and store org ID
        dispatch(markZohoConnected({
          orgId: data.organizationId ?? null,
          expiresAt: data.expiresAt ?? null,
        }));
      } else {
        // Backend has no valid token — wipe stale local state
        dispatch(disconnectZoho());
      }
      return data;
    } catch (e) {
      // Network/auth error — leave existing state as-is
      return rejectWithValue(e.message);
    }
  }
);

// ── Slice ────────────────────────────────────────────────────────────────────
const stored = loadPersisted();

const zohoSlice = createSlice({
  name: 'zoho',
  initialState: {
    connected:   !!stored?.organization_id,
    orgId:       stored?.organization_id ?? ZOHO_ORG_ID ?? null,
    connectedAt: stored?.connected_at  ?? null,
    expiresAt:   stored?.expires_at    ?? null,
    status:      'idle',   // 'idle' | 'loading' | 'succeeded' | 'failed'
    error:       null,
  },
  reducers: {
    // Called when backend OAuth flow completes (status=success redirect)
    markZohoConnected(state, action) {
      const p = action.payload || {};
      state.connected  = true;
      state.status     = 'succeeded';
      state.connectedAt = p.connectedAt ?? new Date().toISOString();
      if (p.orgId) state.orgId = p.orgId;
      if (p.expiresAt) state.expiresAt = p.expiresAt;
      persist({
        organization_id: state.orgId,
        connected_at:    state.connectedAt,
        expires_at:      state.expiresAt,
      });
    },
    disconnectZoho(state) {
      state.connected   = false;
      state.orgId       = null;
      state.connectedAt = null;
      state.expiresAt   = null;
      state.status      = 'idle';
      state.error       = null;
      persist(null);
    },
    clearZohoError(state) {
      state.error  = null;
      state.status = 'idle';
    },
  },
  extraReducers: (b) => {
    b
      // ── connectZoho ──
      .addCase(connectZoho.pending,   (s)    => { s.status = 'loading'; s.error = null; })
      .addCase(connectZoho.fulfilled, (s, a) => {
        s.status      = 'succeeded';
        s.connected   = true;
        s.connectedAt = new Date().toISOString();
        if (a.payload.organizationId) s.orgId = a.payload.organizationId;
        if (a.payload.expiresAt) s.expiresAt = a.payload.expiresAt;
        persist({
          organization_id: s.orgId,
          connected_at:    s.connectedAt,
          expires_at:      s.expiresAt,
        });
      })
      .addCase(connectZoho.rejected,  (s, a) => {
        s.status = 'failed';
        s.error  = a.payload ?? a.error.message;
      });
  },
});

export const { disconnectZoho, clearZohoError, markZohoConnected } = zohoSlice.actions;

// ── Selectors ────────────────────────────────────────────────────────────────
export const selectZoho          = (s) => s.zoho;
export const selectZohoConnected = (s) => s.zoho.connected;
export const selectZohoStatus    = (s) => s.zoho.status;
export const selectZohoError     = (s) => s.zoho.error;

export default zohoSlice.reducer;
