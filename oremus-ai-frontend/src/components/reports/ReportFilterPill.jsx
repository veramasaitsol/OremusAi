import { ChevronDown } from 'lucide-react';
import { cn } from '../../utils/classNames.js';

/**
 * Compact pill button for filter bars.
 * Pure presentational — wrap with <Popover> to add a dropdown.
 */
export default function ReportFilterPill({
  label,
  value,
  icon: Icon,
  active = false,
  showCaret = true,
  className = '',
  ...rest
}) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border text-[12.5px] font-medium transition',
        active
          ? 'bg-brand-50 border-brand-200 text-brand-700 dark:bg-brand-500/10 dark:border-brand-500/40 dark:text-brand-300'
          : 'bg-white dark:bg-navy-900 border-navy-200 dark:border-navy-700 text-navy-700 dark:text-navy-200 hover:bg-navy-50 dark:hover:bg-navy-800',
        className,
      )}
      {...rest}
    >
      {Icon && <Icon size={13} className="text-navy-400" />}
      <span className="text-navy-500 dark:text-navy-400">{label}:</span>
      <span className="font-semibold">{value}</span>
      {showCaret && <ChevronDown size={13} className="text-navy-400 ml-0.5" />}
    </button>
  );
}
