// ─── Xero OAuth helpers ─────────────────────────────────────────────────────
// All token storage and refresh happens server-side. The frontend just navigates
// to the backend's /api/auth/xero/start endpoint, which builds the consent URL
// using the server's XERO_CLIENT_ID and redirects to Xero.

import { BACKEND_ROOT } from '../../config/env.js';

export function getXeroStartURL() {
  const raw   = localStorage.getItem('oremus_current_v1');
  const token = raw ? (() => { try { return JSON.parse(raw)?.token; } catch { return null; } })() : null;
  if (!token) return null;

  return `${BACKEND_ROOT}/api/auth/xero/start?token=${encodeURIComponent(token)}`;
}

export function getXeroReauthorizeURL() {
  return getXeroStartURL();
}
