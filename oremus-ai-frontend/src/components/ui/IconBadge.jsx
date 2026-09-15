import { cn } from '../../utils/classNames.js';

const TONES = {
  brand: 'bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300',
  navy:  'bg-navy-100 text-navy-700 dark:bg-navy-800 dark:text-navy-200',
  cyan:  'bg-cyan-50 text-cyan-600 dark:bg-cyan-500/15 dark:text-cyan-300',
  amber: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
  green: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
  red:   'bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300',
  purple:'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
};

const SIZE = {
  sm: { box: 'h-7 w-7 rounded-lg',     icon: 14 },
  md: { box: 'h-9 w-9 rounded-lg',     icon: 17 },
  lg: { box: 'h-11 w-11 rounded-xl',   icon: 20 },
};

export default function IconBadge({ icon: Icon, tone = 'brand', size = 'md', className = '' }) {
  const s = SIZE[size] || SIZE.md;
  return (
    <span className={cn('inline-flex items-center justify-center shrink-0', s.box, TONES[tone] || TONES.brand, className)}>
      {Icon && <Icon size={s.icon} />}
    </span>
  );
}
