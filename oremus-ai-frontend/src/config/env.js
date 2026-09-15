// ─────────────────────────────────────────────────────────────────────────────
// Centralized environment configuration.
// Single source of truth for every Vite env var (VITE_*) used across the app.
// This is the ONLY module that reads `import.meta.env` directly — callers import
// the named constants below instead, so endpoints/credentials live in one place.
// All values come from the single `.env` file at the project root.
// ─────────────────────────────────────────────────────────────────────────────

const env = import.meta.env;

// ─── API endpoints ──────────────────────────────────────────────────────────
// Backend API root (includes the `/api` prefix, no trailing slash). The default
// is chosen by build mode: the LOCAL backend when running `npm run dev`
// (import.meta.env.DEV === true), the LIVE API for production builds
// (`npm run build`). Set VITE_API_URL to override either (e.g. to point a local
// dev build at the deployed backend, or a staging URL).
const LOCAL_API_URL = 'http://localhost:5001/api';
const LIVE_API_URL  = 'https://api.oremuscorp.ai/api';
const DEFAULT_API_URL = env.DEV ? LOCAL_API_URL : LIVE_API_URL;
export const API_BASE = env.VITE_API_URL || DEFAULT_API_URL;

// Backend origin WITHOUT the `/api` suffix — used to build OAuth start URLs,
// e.g. `${BACKEND_ROOT}/api/auth/zoho/start`.
export const BACKEND_ROOT = (env.VITE_API_URL || DEFAULT_API_URL).replace(/\/api\/?$/, '');

// Oremus AI query service — lives on its own origin, separate from the backend.
// export const AI_API_URL = env.VITE_AI_API_URL || 'http://192.168.1.118:8000/api/v1';
export const AI_API_URL = env.VITE_AI_API_URL || 'http://10.10.9.253:8000/api/v1';

// Public marketing site URL (canonical links / JSON-LD).
export const SITE_URL = env.VITE_SITE_URL || 'https://oremusai.vensframe.com';

// ─── Zoho Books OAuth ───────────────────────────────────────────────────────
export const ZOHO_CLIENT_ID    = env.VITE_ZOHO_CLIENT_ID;
export const ZOHO_REDIRECT_URI = env.VITE_ZOHO_REDIRECT_URI;
export const ZOHO_AUTH_URL     = env.VITE_ZOHO_AUTH_URL;
export const ZOHO_TOKEN_URL    = env.VITE_ZOHO_TOKEN_URL;
export const ZOHO_ACCOUNTS_URL = env.VITE_ZOHO_ACCOUNTS_URL;
export const ZOHO_API_BASE     = env.VITE_ZOHO_API_BASE;
export const ZOHO_ORG_ID       = env.VITE_ZOHO_ORG_ID;

// ─── QuickBooks Online ──────────────────────────────────────────────────────
export const QBO_ENV = env.VITE_QBO_ENV || 'sandbox';
