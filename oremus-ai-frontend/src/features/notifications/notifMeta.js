// Visual metadata per notification type. `icon` is a lucide-react icon name.
export const TYPE_META = {
  info:    { icon: 'Info',         wrap: 'bg-brand-100 text-brand-600 dark:bg-brand-500/20 dark:text-brand-300' },
  success: { icon: 'CheckCircle2', wrap: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-300' },
  warning: { icon: 'AlertTriangle',wrap: 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-300' },
  error:   { icon: 'AlertCircle',  wrap: 'bg-red-100 text-red-600 dark:bg-red-500/20 dark:text-red-300' },
  finance: { icon: 'ReceiptText',  wrap: 'bg-violet-100 text-violet-600 dark:bg-violet-500/20 dark:text-violet-300' },
  sync:    { icon: 'RefreshCw',    wrap: 'bg-cyan-100 text-cyan-600 dark:bg-cyan-500/20 dark:text-cyan-300' },
  system:  { icon: 'Sparkles',     wrap: 'bg-navy-100 text-navy-600 dark:bg-navy-700/40 dark:text-navy-200' },
};

export function metaFor(type) {
  return TYPE_META[type] || TYPE_META.info;
}

// Compact relative time, e.g. "just now", "5m", "3h", "2d", or a date.
export function relativeTime(value) {
  if (!value) return '';
  const d = new Date(String(value).replace(' ', 'T'));
  const diff = Date.now() - d.getTime();
  if (Number.isNaN(diff)) return '';
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return d.toLocaleDateString();
}
