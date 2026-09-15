// Concurrency helpers shared by the provider integrations (Zoho / QuickBooks /
// Xero) to cut wasted outbound API calls and avoid token-refresh races.
//
// singleFlight: collapse concurrent calls for the same key into ONE in-flight
// promise. Token refresh is the motivating case — QuickBooks and Xero ROTATE
// their refresh tokens, so two simultaneous refreshes race: the second uses a
// refresh_token the first already invalidated → REAUTH_REQUIRED. Deduping per
// key (userId) means a burst of requests that all find an expired token issue a
// single refresh POST and share its result. Per-process only, which is enough:
// the race happens within one request burst served by one process.
//
// withRetry: retry an async fn on transient throttling (HTTP 429 / 503) with
// exponential backoff, honouring a Retry-After header when present. Used to wrap
// provider sync reads so a single rate-limit hiccup doesn't abort the whole sync.

function singleFlight(map, key, fn) {
  const existing = map.get(key);
  if (existing) return existing;
  const p = (async () => fn())();
  map.set(key, p);
  // Clear the slot once settled so the next expiry triggers a fresh refresh.
  p.finally(() => {
    if (map.get(key) === p) map.delete(key);
  });
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parse a Retry-After header (seconds, or an HTTP-date) into milliseconds.
function retryAfterMs(headers) {
  const ra = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (ra == null) return null;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(ra);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

async function withRetry(fn, { tries = 3, baseMs = 1000 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (e) {
      const status = e?.response?.status;
      const transient = status === 429 || status === 503;
      attempt += 1;
      if (!transient || attempt >= tries) throw e;
      const wait = retryAfterMs(e?.response?.headers) ?? baseMs * 2 ** (attempt - 1);
      await sleep(wait);
    }
  }
}

module.exports = { singleFlight, withRetry };
