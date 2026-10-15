import { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import {
  loadSyncRuns,
  selectSyncRuns,
  syncRunExpectedSince,
  clearSyncRunExpected,
  SYNC_STARTED_EVENT,
} from '../../features/sync/syncRunsSlice.js';
import { loadUnreadCount } from '../../features/notifications/notificationsSlice.js';
import { fetchClients } from '../../features/clients/clientsSlice.js';
import { toast } from '../../utils/toastStore.js';

// Global background-sync indicator, mounted once in the dashboard layout so it
// stays visible on every page while a sync runs:
//   · a thin progress line along the very top of the window, and
//   · a strip under the navbar per running sync — who, which provider, what
//     it's fetching right now, and how far along it is.
// When a sync finishes it raises a toast (success / finished with issues /
// failed, with the reason) and refreshes the notification bell; the server
// also records the same outcome as a persistent notification.
//
// Polls GET /api/sync/runs only while something is running (or was just
// started); an idle page makes one request per navigation.

const POLL_MS = 2500;
// After a Connect / Sync-now, keep looking this long for the run to appear.
const EXPECT_WINDOW_MS = 30000;
const TOASTED_KEY = 'oremus_sync_toasted';

function loadToasted() {
  try { return new Set(JSON.parse(localStorage.getItem(TOASTED_KEY) || '[]')); } catch { return new Set(); }
}
function saveToasted(ids) {
  try { localStorage.setItem(TOASTED_KEY, JSON.stringify([...ids].slice(-50))); } catch { /* storage unavailable */ }
}

function announce(run) {
  const who = run.label || 'your account';
  const P = run.providerLabel;
  if (run.status === 'succeeded') {
    toast.success(`${P} sync completed for ${who}. All data is up to date.`, 7000);
  } else if (run.status === 'partial') {
    toast.warning(`${P} sync for ${who} finished with issues — ${run.error || 'some data could not be fetched.'}`, 15000);
  } else if (run.status === 'failed') {
    toast.error(`${P} sync failed for ${who} — ${run.error || 'unknown error.'}`, 15000);
  }
}

export default function SyncStatusBar() {
  const dispatch     = useDispatch();
  const { pathname } = useLocation();
  const runs         = useSelector(selectSyncRuns);
  const active       = runs.filter((r) => r.status === 'running');
  const toasted      = useRef(null);
  if (!toasted.current) toasted.current = loadToasted();
  const [kick, setKick] = useState(0);

  // A sync started elsewhere in the app (Settings "Sync now") restarts polling.
  useEffect(() => {
    const onStart = () => setKick((k) => k + 1);
    window.addEventListener(SYNC_STARTED_EVENT, onStart);
    return () => window.removeEventListener(SYNC_STARTED_EVENT, onStart);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      let next = null;
      try { next = await dispatch(loadSyncRuns()).unwrap(); } catch { /* keep last state */ }
      if (cancelled) return;
      const running = !!next?.some((r) => r.status === 'running');
      const expectedAt = syncRunExpectedSince();
      const waiting = !!expectedAt && Date.now() - expectedAt < EXPECT_WINDOW_MS;
      if (expectedAt && (running || !waiting)) clearSyncRunExpected();
      if (running || waiting) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [dispatch, pathname, kick]);

  // Announce each finished run once (per browser).
  useEffect(() => {
    let announced = false;
    for (const run of runs) {
      if (run.status === 'running' || toasted.current.has(run.id)) continue;
      toasted.current.add(run.id);
      announce(run);
      announced = true;
    }
    if (!announced) return;
    saveToasted(toasted.current);
    dispatch(loadUnreadCount());
    // The client list shows connection state — refresh it once data has landed.
    if (pathname === '/clients') dispatch(fetchClients());
  }, [runs, dispatch, pathname]);

  if (!active.length) return null;

  const overall = Math.round(active.reduce((s, r) => s + r.percent, 0) / active.length);

  return (
    <>
      <div
        className="fixed top-0 inset-x-0 h-[3px] z-[70] pointer-events-none"
        role="progressbar"
        aria-label="Sync progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={overall}
      >
        <div
          className="h-full bg-gradient-to-r from-brand-500 to-cyan-500 shadow-[0_0_8px_rgba(6,182,212,0.6)] transition-[width] duration-700 ease-out"
          style={{ width: `${Math.max(3, overall)}%` }}
        />
      </div>

      <div
        className="sticky top-14 z-20 border-b border-navy-200/70 dark:border-navy-800 bg-white/95 dark:bg-navy-900/95 backdrop-blur-md divide-y divide-navy-100 dark:divide-navy-800"
        aria-live="polite"
      >
        {active.map((r) => (
          <div key={r.id} className="px-4 lg:px-6 py-2 flex items-center gap-3 text-[12.5px] min-w-0">
            <Loader2 size={14} className="animate-spin text-brand-500 shrink-0" />
            <span className="font-semibold text-navy-900 dark:text-white truncate">
              Syncing {r.label || 'your data'} · {r.providerLabel}
            </span>
            <span className="text-navy-500 truncate hidden sm:inline">
              {r.stage ? `— fetching ${r.stage}` : '— starting…'}
            </span>
            <div className="ml-auto flex items-center gap-2 shrink-0">
              <span className="hidden md:inline text-[11px] text-navy-400 tabular-nums">
                {r.stepsDone}/{r.stepsTotal} steps
              </span>
              <div className="w-24 sm:w-40 h-1.5 rounded-full bg-navy-100 dark:bg-navy-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-brand-500 to-cyan-500 transition-[width] duration-700 ease-out"
                  style={{ width: `${Math.max(3, r.percent)}%` }}
                />
              </div>
              <span className="w-9 text-right font-semibold tabular-nums text-navy-700 dark:text-navy-200">
                {r.percent}%
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
