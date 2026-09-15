import { lazy } from 'react';

// Wraps React.lazy so a failed dynamic import — typically a STALE CHUNK after a
// new deploy changed the asset hashes (e.g. "Failed to fetch dynamically imported
// module: .../assets/RevenueMetrics-XXXX.js") — triggers a single full page reload
// to fetch the fresh index.html with the new chunk URLs, instead of crashing the
// view. A sessionStorage flag prevents an infinite reload loop if the chunk is
// genuinely broken (then the error is rethrown so the ErrorBoundary can show it).
const RELOAD_KEY = 'lazyWithRetry:reloaded';

export default function lazyWithRetry(factory) {
  return lazy(async () => {
    try {
      const mod = await factory();
      window.sessionStorage.removeItem(RELOAD_KEY);
      return mod;
    } catch (err) {
      if (!window.sessionStorage.getItem(RELOAD_KEY)) {
        window.sessionStorage.setItem(RELOAD_KEY, '1');
        window.location.reload();
        // Keep Suspense pending while the page reloads.
        return new Promise(() => {});
      }
      throw err;
    }
  });
}
