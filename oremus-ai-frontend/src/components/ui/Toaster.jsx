import { useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { subscribe, dismissToast } from '../../utils/toastStore.js';
import { cn } from '../../utils/classNames.js';

const ICONS = { error: AlertCircle, success: CheckCircle2, info: Info };

const STYLES = {
  error:   'border-red-200 dark:border-red-800 text-red-700 dark:text-red-300',
  success: 'border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300',
  info:    'border-navy-200 dark:border-navy-700 text-navy-700 dark:text-navy-200',
};

const ICON_COLORS = {
  error:   'text-red-500',
  success: 'text-emerald-500',
  info:    'text-brand-500',
};

export default function Toaster() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => subscribe(setToasts), []);

  if (!toasts.length) return null;

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-[360px] w-[calc(100vw-2rem)] sm:w-auto pointer-events-none">
      {toasts.map((t) => {
        const Icon = ICONS[t.type] || Info;
        return (
          <div
            key={t.id}
            role="alert"
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 px-4 py-3 rounded-xl shadow-lg animate-fadein',
              'bg-white dark:bg-navy-900 border text-[13px] font-medium',
              STYLES[t.type] || STYLES.info,
            )}
          >
            <Icon size={16} className={cn('shrink-0 mt-0.5', ICON_COLORS[t.type] || ICON_COLORS.info)} />
            <span className="flex-1 leading-snug">{t.message}</span>
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              className="shrink-0 text-navy-400 hover:text-navy-600 dark:hover:text-navy-200 transition"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
