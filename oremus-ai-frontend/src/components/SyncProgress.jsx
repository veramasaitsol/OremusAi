import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import axiosClient from '../services/axiosClient.js';
import { cn } from '../utils/classNames.js';

// Live background-sync tracker for a single client account. Polls the backend
// /api/sync/progress endpoint (scoped to the client via X-Client-Id) and renders
// a compact percentage bar while data is still syncing — or a green "Synced"
// once nothing is pending. Polling only continues while a sync is running, so
// an idle page makes exactly one request.
export default function SyncProgress({ clientId }) {
  const [state, setState] = useState({
    loading: true,
    syncing: false,
    percent: 100,
    pending: 0,
    connected: false,
    error: false,
  });

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const load = async () => {
      try {
        const { data } = await axiosClient.get('/sync/progress', {
          headers: { 'X-Client-Id': clientId },
        });
        if (cancelled) return;
        const connected = Object.values(data.platforms || {}).find((p) => p && p.connected);
        setState({
          loading: false,
          syncing: !!data.syncing,
          percent: connected ? connected.percent : 100,
          pending: connected ? connected.pending : 0,
          connected: !!connected,
          error: false,
        });
        // Keep polling while any platform is mid-sync; otherwise stop.
        clearTimeout(timer);
        if (data.syncing) timer = setTimeout(load, 4000);
      } catch {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: true }));
      }
    };

    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [clientId]);

  if (state.loading) return <span className="block h-5" aria-hidden="true" />;
  if (state.error || !state.connected) return null;

  // Fully synced + idle → a quiet green check, no bar.
  if (!state.syncing && state.pending <= 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
        {/* <CheckCircle2 size={11} /> Synced */}
      </span>
    );
  }

  const pct = Math.max(0, Math.min(100, Math.round(state.percent)));
  const pending = Math.max(0, Math.min(100, Math.round(state.pending)));
  return (
    <div className="w-full max-w-[170px]">
      {/* <div className="flex items-center gap-1.5 text-[11px] font-semibold">
        {state.syncing ? (
          <Loader2 size={11} className="animate-spin text-brand-500 shrink-0" />
        ) : (
          <AlertTriangle size={11} className="text-amber-500 shrink-0" />
        )}
        <span className={cn(
          'truncate',
          state.syncing
            ? 'text-brand-600 dark:text-brand-400'
            : 'text-amber-600 dark:text-amber-400'
        )}>
          {state.syncing ? `Syncing… ${pct}%` : `Sync pending · ${pending}%`}
        </span>
      </div>
      <div className="mt-1 h-1 rounded-full bg-navy-100 dark:bg-navy-800 overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            state.syncing ? 'bg-gradient-to-r from-brand-500 to-cyan-500' : 'bg-amber-400'
          )}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div> */}
    </div>
  );
}
