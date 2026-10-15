import { useSelector } from 'react-redux';
import { Loader2, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { selectSyncRunForClient } from '../features/sync/syncRunsSlice.js';
import { cn } from '../utils/classNames.js';

// Per-client sync status on the Clients list: a small percentage bar while
// that client's data is syncing, then the outcome of the latest sync for a few
// minutes (hover a failure for the reason). Reads the runs the global
// SyncStatusBar already polls — no requests of its own.
export default function SyncProgress({ clientId }) {
  const run = useSelector(selectSyncRunForClient(clientId));
  if (!run) return null;

  if (run.status === 'running') {
    return (
      <div className="w-full max-w-[170px]" title={run.stage ? `Fetching ${run.stage}` : 'Starting…'}>
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-brand-600 dark:text-brand-400">
          <Loader2 size={11} className="animate-spin shrink-0" />
          <span className="truncate">Syncing… {run.percent}%</span>
        </div>
        <div className="mt-1 h-1 rounded-full bg-navy-100 dark:bg-navy-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-brand-500 to-cyan-500 transition-[width] duration-700"
            style={{ width: `${Math.max(3, run.percent)}%` }}
          />
        </div>
      </div>
    );
  }

  const outcome = {
    succeeded: { Icon: CheckCircle2,  text: 'Synced',             cls: 'text-emerald-600 dark:text-emerald-400' },
    partial:   { Icon: AlertTriangle, text: 'Synced with issues', cls: 'text-amber-600 dark:text-amber-400' },
    failed:    { Icon: XCircle,       text: 'Sync failed',        cls: 'text-red-600 dark:text-red-400' },
  }[run.status];
  if (!outcome) return null;
  const { Icon, text, cls } = outcome;

  return (
    <span
      className={cn('inline-flex items-center gap-1 text-[11px] font-medium', cls, run.error && 'cursor-help')}
      title={run.error || undefined}
    >
      <Icon size={11} className="shrink-0" /> {text}
    </span>
  );
}
