import { cn } from '../../utils/classNames.js';

const TONES = {
  navy:   'bg-navy-100 text-navy-700 dark:bg-navy-800 dark:text-navy-300',
  blue:   'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
  green:  'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
  amber:  'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  red:    'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-400',
  cyan:   'bg-cyan-50 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300',
  purple: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
};
const DOTS = {
  navy: 'bg-navy-500', blue: 'bg-brand-500', green: 'bg-emerald-500',
  amber: 'bg-amber-500', red: 'bg-red-500', cyan: 'bg-cyan-500', purple: 'bg-violet-500',
};

export default function Badge({ tone = 'navy', dot = false, className = '', children }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold', TONES[tone], className)}>
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full', DOTS[tone])} />}
      {children}
    </span>
  );
}
