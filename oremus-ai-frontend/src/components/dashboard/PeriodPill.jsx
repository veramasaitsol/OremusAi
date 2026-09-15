import { cn } from '../../utils/classNames.js';

export default function PeriodPill({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'h-7 px-3 rounded-lg text-[12px] font-semibold transition',
        active
          ? 'bg-brand-500 text-white shadow-soft'
          : 'text-navy-600 dark:text-navy-300 hover:text-navy-900 dark:hover:text-white hover:bg-navy-100 dark:hover:bg-navy-800'
      )}
    >
      {children}
    </button>
  );
}
