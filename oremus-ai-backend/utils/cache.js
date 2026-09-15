'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Lightweight in-process TTL cache (Phase 9 caching layer).
//
// Zero dependencies — a Map with per-key expiry. Suited to single-process
// dashboard/analytics responses where a few seconds of staleness is fine.
// `wrap()` provides single-flight de-duplication so concurrent misses for the
// same key only run the loader once.
// ─────────────────────────────────────────────────────────────────────────────

const store = new Map();    // key -> { value, expiresAt }
const inflight = new Map(); // key -> Promise

function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt && hit.expiresAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

function set(key, value, ttlMs = 60000) {
  store.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : 0 });
  return value;
}

// Invalidate exact key or every key starting with `prefix:`.
function invalidate(prefix) {
  if (!prefix) { store.clear(); return; }
  if (store.has(prefix)) store.delete(prefix);
  for (const k of store.keys()) if (k.startsWith(prefix + ':')) store.delete(k);
}

async function wrap(key, ttlMs, loader) {
  const cached = get(key);
  if (cached !== undefined) return cached;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const value = await loader();
      set(key, value, ttlMs);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

module.exports = { get, set, invalidate, wrap };
