import { createSlice } from '@reduxjs/toolkit';

const THEME_KEY = 'oremus_theme_v1';
const COLLAPSE_KEY = 'oremus_sidebar_v1';
const CURRENCY_KEY = 'oremus_active_currency_v1';

function readTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'light'; } catch { return 'light'; }
}
function readCollapsed() {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}
function readCurrency() {
  try { return localStorage.getItem(CURRENCY_KEY) || 'INR'; } catch { return 'INR'; }
}

const uiSlice = createSlice({
  name: 'ui',
  initialState: {
    theme: readTheme(),
    sidebarCollapsed: readCollapsed(),
    mobileSidebarOpen: false,
    // Display currency for money rendering (single source of truth — the
    // formatting util mirrors this so `fmt()` defaults stay correct).
    activeCurrency: readCurrency(),
  },
  reducers: {
    toggleTheme(s) {
      s.theme = s.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(THEME_KEY, s.theme); } catch {}
    },
    setTheme(s, a) {
      s.theme = a.payload;
      try { localStorage.setItem(THEME_KEY, s.theme); } catch {}
    },
    toggleSidebar(s) {
      s.sidebarCollapsed = !s.sidebarCollapsed;
      try { localStorage.setItem(COLLAPSE_KEY, s.sidebarCollapsed ? '1' : '0'); } catch {}
    },
    setMobileSidebar(s, a) { s.mobileSidebarOpen = !!a.payload; },
    setActiveCurrency(s, a) {
      s.activeCurrency = a.payload ? String(a.payload).toUpperCase() : 'INR';
      try { localStorage.setItem(CURRENCY_KEY, s.activeCurrency); } catch {}
    },
  },
});

export const { toggleTheme, setTheme, toggleSidebar, setMobileSidebar, setActiveCurrency } = uiSlice.actions;
export const selectActiveCurrency = (s) => s.ui.activeCurrency;
export default uiSlice.reducer;
