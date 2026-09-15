import IconBadge from './IconBadge.jsx';
import { cn } from '../../utils/classNames.js';

export default function EmptyState({ icon, title, description, action, className = '', tone = 'navy' }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center py-12 px-6',
        'border border-dashed border-navy-200 dark:border-navy-800 rounded-2xl',
        'bg-white/60 dark:bg-navy-900/40',
        className,
      )}
    >
      {icon && <IconBadge icon={icon} tone={tone} size="lg" className="mb-4" />}
      {title && <h3 className="text-[14.5px] font-semibold text-navy-900 dark:text-white">{title}</h3>}
      {description && (
        <p className="mt-1 text-[12.5px] text-navy-500 dark:text-navy-400 max-w-sm">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
