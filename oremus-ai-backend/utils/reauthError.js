// Shared "re-authorization required" error for OAuth token-refresh failures
// (Zoho / QuickBooks / Xero). A provider refresh_token can stop being honored
// when it is revoked, expired, or was issued by a DIFFERENT OAuth app than the
// one currently configured (client_id/secret mismatch). None of these are
// recoverable server-side — the org must reconnect — so we surface a single,
// typed, HTTP-401 error carrying the provider and the real upstream reason
// instead of a cryptic 500 ("Token refresh failed") or 400.
const LABELS = { zoho: 'Zoho', quickbooks: 'QuickBooks', xero: 'Xero' };

function reauthError(provider, reason) {
  const label = LABELS[provider] || provider;
  const err = new Error(`${label} re-authorization required — please reconnect ${label}. (${reason})`);
  err.code = 'REAUTH_REQUIRED';
  err.provider = provider;
  err.reason = reason;
  err.status = 401;
  return err;
}

module.exports = { reauthError };
