import { configureStore } from '@reduxjs/toolkit';
import authReducer from '../features/auth/authSlice.js';
import uiReducer from '../features/ui/uiSlice.js';
import clientsReducer from '../features/clients/clientsSlice.js';
import dashboardReducer from '../features/dashboard/dashboardSlice.js';
import filtersReducer from '../features/filters/filtersSlice.js';
import zohoReducer from '../features/zoho/zohoSlice.js';
import qboReducer from '../features/quickbooks/quickbooksSlice.js';
import xeroReducer from '../features/xero/xeroSlice.js';
import reportsReducer from '../features/reports/reportsSlice.js';
import orgsReducer from '../features/orgs/orgsSlice.js';
import notificationsReducer from '../features/notifications/notificationsSlice.js';
import viewAsReducer from '../features/viewAs/viewAsSlice.js';
import settingsReducer from '../features/settings/settingsSlice.js';
import { setActiveCurrency } from '../utils/fmt.js';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    ui: uiReducer,
    clients: clientsReducer,
    dashboard: dashboardReducer,
    filters: filtersReducer,
    zoho: zohoReducer,
    qbo: qboReducer,
    xero: xeroReducer,
    reports: reportsReducer,
    orgs: orgsReducer,
    notifications: notificationsReducer,
    viewAs: viewAsReducer,
    settings: settingsReducer,
  },
});

// Redux is the single source of truth for the active display currency. The
// formatting util (utils/fmt.js) reads a module-level default, so mirror the
// store value into it on every state change — this keeps `fmt()`/`fmtMoneyCompact()`
// correct everywhere without threading a currency prop through dozens of callers.
store.subscribe(() => {
  setActiveCurrency(store.getState().ui.activeCurrency);
});

if (import.meta.env.DEV) window.__REDUX_STORE__ = store;
