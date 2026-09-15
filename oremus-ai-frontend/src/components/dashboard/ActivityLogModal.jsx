import { useEffect } from 'react';
import * as Icons from 'lucide-react';
import { X, History } from 'lucide-react';

const ICON_BG = {
  blue:   'bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400',
  green:  'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400',
  amber:  'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
  purple: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400',
  navy:   'bg-navy-100 text-navy-600 dark:bg-navy-800 dark:text-navy-300',
};

export default function ActivityLogModal({ items = [], onClose }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <>
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-40 animate-fadein"
        onClick={onClose}
      />
      <div className="fixed right-0 top-0 h-full w-full max-w-[420px] bg-white dark:bg-navy-950 shadow-2xl z-50 flex flex-col animate-slidein-right">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-navy-100 dark:border-navy-800">
          <div className="w-9 h-9 rounded-xl grid place-items-center" style={{ background: '#2563EB18' }}>
            <History size={16} style={{ color: '#2563EB' }} />
          </div>
          <div className="flex-1">
            <div className="text-[15px] font-bold text-navy-900 dark:text-white">Activity Log</div>
            <div className="text-[11px] text-navy-400">{items.length} recent event{items.length !== 1 ? 's' : ''}</div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg grid place-items-center text-navy-400 hover:text-navy-700 dark:hover:text-white hover:bg-navy-100 dark:hover:bg-navy-800 transition"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {items.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-[13px] text-navy-400">No recent activity</div>
          ) : (
            <ol className="relative ml-1 border-l border-navy-200 dark:border-navy-800 space-y-4">
              {items.map((a, i) => {
                const Icon = Icons[a.icon] || Icons.Circle;
                return (
                  <li key={i} className="pl-4 relative">
                    <span className={`absolute -left-[11px] top-0 w-5 h-5 rounded-md ring-4 ring-white dark:ring-navy-950 grid place-items-center ${ICON_BG[a.tone]}`}>
                      <Icon size={10} />
                    </span>
                    <div className="text-[12.5px] text-navy-900 dark:text-white leading-tight">
                      <span className="font-bold">{a.who}</span>{' '}
                      <span className="text-navy-500">{a.what}</span>
                    </div>
                    <div className="text-[12px] font-semibold text-navy-700 dark:text-navy-200 mt-0.5">{a.target}</div>
                    <div className="text-[10.5px] text-navy-400 mt-0.5">{a.t} ago</div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </>
  );
}
