// ─── Zoho Books OAuth helpers ───────────────────────────────────────────────
// All credentials come from the centralized config (src/config/env.js).
// Token exchange and refresh happen server-side via the backend (/api/auth/zoho/*).

import {
  BACKEND_ROOT,
  ZOHO_ACCOUNTS_URL,
} from '../../config/env.js';

/**
 * Returns the backend URL that initiates the Zoho OAuth flow.
 * The backend builds the correct auth URL using its own ZOHO_REDIRECT_URI
 * (from server env) — this fixes the "Invalid Redirect URI" error that occurs
 * when the frontend bundle has a localhost redirect URI baked in at build time.
 *
 * The user's JWT is passed as ?token= so the backend can identify the user
 * after Zoho's callback (carried as OAuth state parameter).
 */
export function getZohoStartURL() {
  const raw   = localStorage.getItem('oremus_current_v1');
  const token = raw ? (() => { try { return JSON.parse(raw)?.token; } catch { return null; } })() : null;
  if (!token) return null;

  return `${BACKEND_ROOT}/api/auth/zoho/start?token=${encodeURIComponent(token)}`;
}

/**
 * Returns the Zoho signout URL that redirects to the backend OAuth start
 * after signing out. Use this for the "Re-authorize" button so users are
 * forced to log into Zoho fresh — fixes "no login screen" when already
 * logged into Zoho in another tab.
 */
export function getZohoReauthorizeURL() {
  const startURL = getZohoStartURL();
  if (!startURL) return null;

  // Zoho signout URL → after signout, redirects to Zoho login then auth
  const ACCOUNTS_BASE = ZOHO_ACCOUNTS_URL
    ?.replace('/oauth/v2', '') ?? 'https://accounts.zoho.in';
  return `${ACCOUNTS_BASE}/signout?redirecturl=${encodeURIComponent(startURL)}`;
}

// ── Keep legacy exports so any other imports don't break ─────────────────────
/** @deprecated Use getZohoStartURL() instead */
export function buildAuthURL() {
  return getZohoStartURL();
}
/** @deprecated Use getZohoReauthorizeURL() instead */
export function buildSwitchAccountURL() {
  return getZohoReauthorizeURL();
}

