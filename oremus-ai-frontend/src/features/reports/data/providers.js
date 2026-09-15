// Source-of-truth list of supported report providers.
// Each provider is rendered as its own page (/reports/:provider) and
// has its own category list + report catalog. The Reports module
// uses this map to look up branding (label, icon, color, initial)
// and to validate the URL `:provider` segment.

export const PROVIDERS = {
  zoho: {
    id: 'zoho',
    label: 'Zoho Reports',
    short: 'Zoho',
    icon: 'BookOpen',
    color: '#E42527',
    soft: 'rgba(228,37,39,0.10)',
    initial: 'Z',
    tagline: 'Templates powered by your Zoho Books ledger.',
    accent: 'red',
  },
  quickbooks: {
    id: 'quickbooks',
    label: 'QuickBooks Reports',
    short: 'QuickBooks',
    icon: 'BadgeDollarSign',
    color: '#2CA01C',
    soft: 'rgba(44,160,28,0.12)',
    initial: 'Q',
    tagline: 'QuickBooks Online reports synced live to your workspace.',
    accent: 'green',
  },
  xero: {
    id: 'xero',
    label: 'Xero Reports',
    short: 'Xero',
    icon: 'Cloud',
    color: '#13B5EA',
    soft: 'rgba(19,181,234,0.12)',
    initial: 'X',
    tagline: 'Xero accounting reports mirrored to Oremus.',
    accent: 'cyan',
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
export const DEFAULT_PROVIDER = 'zoho';

export function getProvider(id) {
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
}

export function isValidProvider(id) {
  return Boolean(PROVIDERS[id]);
}

// Map a client's connection flags (from the clients list endpoint) to the
// report provider to use for that client. Order matches the backend's
// detection order (Zoho → QuickBooks → Xero). Returns null when the client
// has no connected platform.
export function providerFromConnections(c) {
  if (!c) return null;
  if (c.zoho_connected) return 'zoho';
  if (c.qbo_connected)  return 'quickbooks';
  if (c.xero_connected) return 'xero';
  return null;
}
