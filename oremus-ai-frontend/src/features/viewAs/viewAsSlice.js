import { createSlice } from '@reduxjs/toolkit';

// Admin "view as client" — which client's data the admin is currently viewing
// on the dashboard. Persisted to localStorage and read by the axios interceptor
// so every request carries the X-Client-Id header. null = admin's own workspace.
// The client's report provider (from its connection flags) is stored alongside
// so pages like Reports can resolve it synchronously — no async client-list
// lookup that would briefly mis-resolve a deep link.
const VIEW_AS_KEY = 'oremus_view_client_v1';
const VIEW_AS_PROVIDER_KEY = 'oremus_view_client_provider_v1';

export function getViewAsClientId() {
  try {
    return localStorage.getItem(VIEW_AS_KEY) || null;
  } catch {
    return null;
  }
}
export function getViewAsProvider() {
  try {
    return localStorage.getItem(VIEW_AS_PROVIDER_KEY) || null;
  } catch {
    return null;
  }
}
function persistViewAs(id, provider) {
  try {
    if (id) localStorage.setItem(VIEW_AS_KEY, String(id));
    else    localStorage.removeItem(VIEW_AS_KEY);
    if (provider) localStorage.setItem(VIEW_AS_PROVIDER_KEY, String(provider));
    else          localStorage.removeItem(VIEW_AS_PROVIDER_KEY);
  } catch {}
}

const viewAsSlice = createSlice({
  name: 'viewAs',
  initialState: {
    clientId: getViewAsClientId(),
    provider: getViewAsProvider(),
  },
  reducers: {
    // Accept { id, provider } (from ClientSwitcher) or a plain id string.
    setViewAsClient(state, action) {
      const payload = action.payload;
      const isObj = payload && typeof payload === 'object';
      state.clientId = isObj ? (payload.id ? String(payload.id) : null) : (payload ? String(payload) : null);
      state.provider = isObj ? (payload.provider || null) : null;
      persistViewAs(state.clientId, state.provider);
    },
    clearViewAsClient(state) {
      state.clientId = null;
      state.provider = null;
      persistViewAs(null, null);
    },
  },
});

export const { setViewAsClient, clearViewAsClient } = viewAsSlice.actions;
export const selectViewAsClientId = (s) => s.viewAs.clientId;
export const selectViewAsProvider  = (s) => s.viewAs.provider;
export default viewAsSlice.reducer;
