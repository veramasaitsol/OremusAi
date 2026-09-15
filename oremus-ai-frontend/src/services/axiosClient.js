import axios from 'axios';
import { API_BASE } from '../config/env.js';
import { getSelectedOrgId } from '../features/orgs/orgsSlice.js';
import { getViewAsClientId } from '../features/viewAs/viewAsSlice.js';

// In development Vite proxies /api → http://localhost:5001/api (no CORS).
// In production set VITE_API_URL to the deployed backend origin.
const axiosClient = axios.create({
  baseURL: API_BASE,
  // Generous timeout: on slow connections the dashboard fires many requests at
  // once and queued XHRs count wait time against this limit — 15s made slow
  // networks fail (and render zeros) instead of loading slowly.
  timeout: 45000,
  headers: { 'Content-Type': 'application/json' },
});

axiosClient.interceptors.request.use((config) => {
  try {
    const raw   = localStorage.getItem('oremus_current_v1');
    const token = raw ? JSON.parse(raw)?.token : null;
    if (token) config.headers.Authorization = `Bearer ${token}`;
  } catch {}
  try {
    // Admin "view as client" takes precedence — the backend resolves the
    // client's own org, so the admin's X-Org-Id must NOT be sent alongside it.
    const viewAsClientId = getViewAsClientId();
    if (viewAsClientId) {
      config.headers['X-Client-Id'] = viewAsClientId;
    } else {
      const orgId = getSelectedOrgId();
      if (orgId) config.headers['X-Org-Id'] = orgId;
    }
  } catch {}
  return config;
});

// On a 401 from an authenticated request, the session/token is no longer valid
// (expired or revoked). Clear the stale session and bounce to the login page
// with a flag so it can show a "session expired" notice. Guards:
//  - skip auth endpoints (a wrong-password login also returns 401)
//  - only act when a session actually existed (avoid loops on the login page)
let sessionExpiredHandled = false;
axiosClient.interceptors.response.use(
  (r) => r,
  (err) => {
    try {
      const status = err?.response?.status;
      const url    = err?.config?.url || '';
      const isAuthRoute = url.includes('/auth/login')
        || url.includes('/auth/forgot-password')
        || url.includes('/auth/reset-password');
      const hadSession  = !!localStorage.getItem('oremus_current_v1');
      if (status === 401 && hadSession && !isAuthRoute && !sessionExpiredHandled
          && typeof window !== 'undefined') {
        sessionExpiredHandled = true;
        try { localStorage.removeItem('oremus_current_v1'); } catch {}
        if (!window.location.pathname.startsWith('/login')) {
          window.location.assign('/login?expired=1');
        }
      }
    } catch {}
    return Promise.reject(err);
  }
);

export default axiosClient;
