import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import * as api from './clientsAPI.js';

const SEL_KEY = 'oremus_selected_client_v1';

function loadSelectedId(list) {
  try {
    const id = localStorage.getItem(SEL_KEY);
    if (id && list.some((c) => c.id === id || c.id === Number(id))) return id;
  } catch {}
  return list[0]?.id ?? null;
}

// ── Async thunks ─────────────────────────────────────────────────────────────

export const fetchClients = createAsyncThunk(
  'clients/fetch',
  async (search = '', { rejectWithValue }) => {
    try {
      const { data } = await api.fetchClients(search);
      return data;
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  }
);

export const createClient = createAsyncThunk(
  'clients/create',
  async (payload, { rejectWithValue }) => {
    try {
      return await api.createClient(payload);
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  }
);

export const updateClient = createAsyncThunk(
  'clients/update',
  async ({ id, ...payload }, { rejectWithValue }) => {
    try {
      await api.updateClient(id, payload);
      return { id, ...payload };
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  }
);

export const deleteClient = createAsyncThunk(
  'clients/delete',
  async (id, { rejectWithValue }) => {
    try {
      await api.deleteClient(id);
      return id;
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  }
);

export const connectClientZoho = createAsyncThunk(
  'clients/connectZoho',
  async (clientId, { rejectWithValue }) => {
    try {
      const { url, clientToken } = await api.getClientZohoConnectURL(clientId);
      // Store which client we're connecting so ZohoCallback can redirect back to /clients
      sessionStorage.setItem('oremus_connect_for_client', String(clientId));
      // Store the client JWT so ZohoCallback can pass it to the exchange endpoint
      sessionStorage.setItem('oremus_client_connect_token', clientToken || '');
      // Navigate to the Zoho OAuth start URL
      window.location.href = url;
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  }
);

export const disconnectClientZoho = createAsyncThunk(
  'clients/disconnectZoho',
  async (clientId, { rejectWithValue }) => {
    try {
      await api.disconnectClientZoho(clientId);
      return clientId;
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  }
);

export const connectClientQBO = createAsyncThunk(
  'clients/connectQBO',
  async (clientId, { rejectWithValue }) => {
    try {
      const { url, clientToken } = await api.getClientQBOConnectURL(clientId);
      sessionStorage.setItem('oremus_connect_for_client', String(clientId));
      sessionStorage.setItem('oremus_client_connect_token', clientToken || '');
      window.location.href = url;
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  }
);

export const disconnectClientQBO = createAsyncThunk(
  'clients/disconnectQBO',
  async (clientId, { rejectWithValue }) => {
    try {
      await api.disconnectClientQBO(clientId);
      return clientId;
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  }
);

export const connectClientXero = createAsyncThunk(
  'clients/connectXero',
  async (clientId, { rejectWithValue }) => {
    try {
      const { url, clientToken } = await api.getClientXeroConnectURL(clientId);
      sessionStorage.setItem('oremus_connect_for_client', String(clientId));
      sessionStorage.setItem('oremus_client_connect_token', clientToken || '');
      window.location.href = url;
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  }
);

export const disconnectClientXero = createAsyncThunk(
  'clients/disconnectXero',
  async (clientId, { rejectWithValue }) => {
    try {
      await api.disconnectClientXero(clientId);
      return clientId;
    } catch (e) {
      return rejectWithValue(e.response?.data?.error || e.message);
    }
  }
);

// ── Slice ─────────────────────────────────────────────────────────────────────
const clientsSlice = createSlice({
  name: 'clients',
  initialState: {
    list:       [],
    selectedId: null,
    status:     'idle',  // 'idle' | 'loading' | 'succeeded' | 'failed'
    error:      null,
    mutating:   false,   // true while create/update/delete is in flight
  },
  reducers: {
    selectClient(state, action) {
      state.selectedId = action.payload;
      try { localStorage.setItem(SEL_KEY, String(action.payload)); } catch {}
    },
    clearClientsError(state) {
      state.error = null;
    },
  },
  extraReducers: (b) => {
    b
      // ── fetchClients ──
      .addCase(fetchClients.pending,   (s) => { s.status = 'loading'; s.error = null; })
      .addCase(fetchClients.fulfilled, (s, a) => {
        s.status     = 'succeeded';
        s.list       = a.payload;
        s.selectedId = loadSelectedId(a.payload);
      })
      .addCase(fetchClients.rejected,  (s, a) => { s.status = 'failed'; s.error = a.payload; })

      // ── createClient ──
      .addCase(createClient.pending,   (s) => { s.mutating = true; s.error = null; })
      .addCase(createClient.fulfilled, (s, a) => {
        s.mutating = false;
        s.list.unshift(a.payload);
        if (!s.selectedId) s.selectedId = a.payload.id;
      })
      .addCase(createClient.rejected,  (s, a) => { s.mutating = false; s.error = a.payload; })

      // ── updateClient ──
      .addCase(updateClient.pending,   (s) => { s.mutating = true; s.error = null; })
      .addCase(updateClient.fulfilled, (s, a) => {
        s.mutating = false;
        const idx = s.list.findIndex((c) => String(c.id) === String(a.payload.id));
        if (idx !== -1) s.list[idx] = { ...s.list[idx], ...a.payload };
      })
      .addCase(updateClient.rejected,  (s, a) => { s.mutating = false; s.error = a.payload; })

      // ── deleteClient ──
      .addCase(deleteClient.pending,   (s) => { s.mutating = true; s.error = null; })
      .addCase(deleteClient.fulfilled, (s, a) => {
        s.mutating = false;
        s.list = s.list.filter((c) => String(c.id) !== String(a.payload));
        if (String(s.selectedId) === String(a.payload))
          s.selectedId = s.list[0]?.id ?? null;
      })
      .addCase(deleteClient.rejected,  (s, a) => { s.mutating = false; s.error = a.payload; })

      // ── disconnectClientZoho ──
      .addCase(disconnectClientZoho.fulfilled, (s, a) => {
        const c = s.list.find((x) => String(x.id) === String(a.payload));
        if (c) c.zoho_connected = false;
      })

      // ── disconnectClientQBO ──
      .addCase(disconnectClientQBO.fulfilled, (s, a) => {
        const c = s.list.find((x) => String(x.id) === String(a.payload));
        if (c) c.qbo_connected = false;
      })

      // ── disconnectClientXero ──
      .addCase(disconnectClientXero.fulfilled, (s, a) => {
        const c = s.list.find((x) => String(x.id) === String(a.payload));
        if (c) c.xero_connected = false;
      });
  },
});

export const { selectClient, clearClientsError } = clientsSlice.actions;

// ── Selectors ─────────────────────────────────────────────────────────────────
export const selectAllClients   = (s) => s.clients.list;
export const selectClientsStatus = (s) => s.clients.status;
export const selectClientsError  = (s) => s.clients.error;
export const selectClientsMutating = (s) => s.clients.mutating;
// The client every report/dashboard header should say is "active" — the one
// the admin is actually viewing right now (the top-bar "Viewing Client"
// switcher, `viewAsSlice.clientId`), which is also the single source of
// truth the axios interceptor reads for the X-Client-Id header. `null` =
// admin's own workspace, matching viewAsSlice's own convention — no
// fallback to "the first client in the list", which was the bug: every
// report viewer and Dashboard.jsx read `clients.selectedId` here instead
// (a separate, legacy field only ever SET as a side effect of connecting a
// client's provider from the /clients management page). Since a full page
// reload resets `clients.selectedId` to nothing on every client switch, it
// fell through to `list[0]` — labelling every report with whichever client
// happened to sort first, regardless of which client's data was actually
// being shown (that part was always correct, sourced from the X-Client-Id
// header independently of this selector).
export const selectActiveClient = (s) =>
  s.clients.list.find((c) => String(c.id) === String(s.viewAs.clientId)) || null;

export default clientsSlice.reducer;
