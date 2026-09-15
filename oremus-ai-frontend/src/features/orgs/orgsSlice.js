import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import axiosClient from '../../services/axiosClient.js';

// localStorage key for the currently selected organization. Read by the axios
// interceptor so every request carries the X-Org-Id header for org scoping.
// An org id here is provider-agnostic: a Zoho org_id, a QuickBooks realm_id or
// a Xero tenant_id.
export const SELECTED_ORG_KEY = 'oremus_selected_org_v1';

export function getSelectedOrgId() {
  try {
    return localStorage.getItem(SELECTED_ORG_KEY) || null;
  } catch {
    return null;
  }
}
function persistSelectedOrgId(orgId) {
  try {
    if (orgId) localStorage.setItem(SELECTED_ORG_KEY, String(orgId));
    else       localStorage.removeItem(SELECTED_ORG_KEY);
  } catch {}
}

// Providers to probe, in the same precedence the dashboard uses.
const PROVIDERS = ['zoho', 'quickbooks', 'xero'];

async function loadForProvider(provider) {
  if (provider === 'zoho') {
    // Zoho keeps its active org on /status; the other providers return it inline.
    const [{ data: orgData }, { data: statusData }] = await Promise.all([
      axiosClient.get('/auth/zoho/organizations'),
      axiosClient.get('/auth/zoho/status').catch(() => ({ data: {} })),
    ]);
    return {
      organizations: orgData.organizations ?? [],
      activeOrgId:   statusData?.organizationId ?? null,
    };
  }
  const { data } = await axiosClient.get(`/auth/${provider}/organizations`);
  return {
    organizations: data.organizations ?? [],
    activeOrgId:   data.activeOrgId ?? null,
  };
}

// ── Thunks ─────────────────────────────────────────────────────────────────
// Probe each provider for its org list and keep the first non-empty one. Works
// for whichever platform the account is connected to (Zoho / QuickBooks / Xero),
// each of which now exposes multiple organizations.
export const loadOrganizations = createAsyncThunk(
  'orgs/load',
  async () => {
    for (const provider of PROVIDERS) {
      try {
        const res = await loadForProvider(provider);
        if (res.organizations.length > 0) {
          return { provider, ...res };
        }
      } catch (_) { /* provider not connected / endpoint missing — try next */ }
    }
    return { provider: null, organizations: [], activeOrgId: null };
  }
);

// Switch the active organization on the resolved provider. The X-Org-Id header
// (set from localStorage) drives filtering across the app; the backend call
// keeps the persisted active org in sync for reports + sync.
export const switchOrganization = createAsyncThunk(
  'orgs/switch',
  async (orgId, { getState, rejectWithValue }) => {
    if (!orgId) return rejectWithValue('orgId is required');
    const provider = getState().orgs.provider || 'zoho';
    try {
      await axiosClient.post(`/auth/${provider}/select-org`, { orgId });
      persistSelectedOrgId(orgId);
      return orgId;
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  }
);

// ── Slice ──────────────────────────────────────────────────────────────────
const orgsSlice = createSlice({
  name: 'orgs',
  initialState: {
    list:       [],
    provider:   null,
    selectedId: getSelectedOrgId(),
    status:     'idle',   // 'idle' | 'loading' | 'succeeded' | 'failed'
    switching:  false,
    error:      null,
  },
  reducers: {
    clearOrgs(state) {
      state.list       = [];
      state.provider   = null;
      state.selectedId = null;
      state.status     = 'idle';
      persistSelectedOrgId(null);
    },
  },
  extraReducers: (b) => {
    b
      .addCase(loadOrganizations.pending,   (s) => { s.status = 'loading'; s.error = null; })
      .addCase(loadOrganizations.fulfilled, (s, a) => {
        s.status = 'succeeded';
        s.list   = a.payload.organizations;
        s.provider = a.payload.provider;
        // Prefer the persisted selection; fall back to the backend's active org,
        // then to the first org in the list.
        const ids = a.payload.organizations.map((o) => String(o.org_id));
        let sel = s.selectedId && ids.includes(String(s.selectedId)) ? String(s.selectedId) : null;
        if (!sel && a.payload.activeOrgId && ids.includes(String(a.payload.activeOrgId))) {
          sel = String(a.payload.activeOrgId);
        }
        if (!sel && a.payload.organizations.length > 0) {
          sel = String(a.payload.organizations[0].org_id);
        }
        const prevSel = s.selectedId;
        s.selectedId = sel;
        persistSelectedOrgId(sel);
        // If the auto-resolved org differs from what was previously selected,
        // flag it so the dashboard knows to refetch.
        s.orgJustResolved = sel !== prevSel;
      })
      .addCase(loadOrganizations.rejected,  (s, a) => { s.status = 'failed'; s.error = a.payload; })

      .addCase(switchOrganization.pending,   (s) => { s.switching = true;  s.error = null; })
      .addCase(switchOrganization.fulfilled, (s, a) => { s.switching = false; s.selectedId = String(a.payload); })
      .addCase(switchOrganization.rejected,  (s, a) => { s.switching = false; s.error = a.payload; });
  },
});

export const { clearOrgs } = orgsSlice.actions;

// ── Selectors ────────────────────────────────────────────────────────────────
export const selectOrgList       = (s) => s.orgs.list;
export const selectOrgProvider   = (s) => s.orgs.provider;
export const selectOrgSelectedId  = (s) => s.orgs.selectedId;
export const selectOrgSwitching   = (s) => s.orgs.switching;
export const selectActiveOrg = (s) =>
  s.orgs.list.find((o) => String(o.org_id) === String(s.orgs.selectedId)) || null;

export default orgsSlice.reducer;
