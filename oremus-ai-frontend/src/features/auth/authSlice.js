import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { loginRequest, quickLoginRequest } from './authAPI.js';

const STORAGE_KEY = 'oremus_current_v1';

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function persist(user) {
  try {
    if (user) localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

// Clear any stale Zoho popup-skip flag so the connection modal always
// re-evaluates on a fresh login (session storage survives page refresh
// within the same tab, so without this the popup stays hidden).
function clearZohoSessionFlags() {
  try {
    sessionStorage.removeItem('oremus_zoho_modal_skipped');
    sessionStorage.removeItem('oremus_qbo_modal_skipped');
    sessionStorage.removeItem('oremus_xero_modal_skipped');
  } catch {}
}

// Expire all readable browser cookies on logout (across the current path and
// each parent domain) so no stale auth/session cookies linger after sign-out.
function clearBrowserCookies() {
  try {
    if (typeof document === 'undefined' || !document.cookie) return;
    const host = window.location.hostname;
    const domains = ['', host, '.' + host];
    document.cookie.split(';').forEach((c) => {
      const name = c.split('=')[0].trim();
      if (!name) return;
      domains.forEach((d) => {
        document.cookie =
          `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/` +
          (d ? `; domain=${d}` : '');
      });
    });
  } catch {}
}

export const login = createAsyncThunk('auth/login', async (creds, { rejectWithValue }) => {
  try {
    const user = await loginRequest(creds);
    persist(user);
    clearZohoSessionFlags();
    return user;
  } catch (e) {
    return rejectWithValue(e.message);
  }
});

export const quickLogin = createAsyncThunk('auth/quickLogin', async ({ role }) => {
  const user = await quickLoginRequest({ role });
  persist(user);
  clearZohoSessionFlags();
  return user;
});

const initial = loadPersisted();

const authSlice = createSlice({
  name: 'auth',
  initialState: {
    user: initial,
    role: initial?.role || null,
    status: 'idle',
    error: null,
  },
  reducers: {
    logout(state) {
      state.user = null;
      state.role = null;
      state.error = null;
      state.status = 'idle';
      persist(null);
      clearZohoSessionFlags();
      clearBrowserCookies();
    },
  },
  extraReducers: (b) => {
    b.addCase(login.pending, (s) => { s.status = 'loading'; s.error = null; })
     .addCase(login.fulfilled, (s, a) => {
       s.status = 'succeeded';
       s.user = a.payload;
       s.role = a.payload.role;
     })
     .addCase(login.rejected, (s, a) => {
       s.status = 'failed';
       s.error = a.payload || a.error.message;
     })
     .addCase(quickLogin.fulfilled, (s, a) => {
       s.user = a.payload;
       s.role = a.payload.role;
       s.status = 'succeeded';
     });
  },
});

export const { logout } = authSlice.actions;

export const selectUser = (s) => s.auth.user;
export const selectRole = (s) => s.auth.role;
export const selectIsAuthed = (s) => !!s.auth.user;

export default authSlice.reducer;
