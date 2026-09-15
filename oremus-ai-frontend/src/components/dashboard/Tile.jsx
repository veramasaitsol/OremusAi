import { cn } from '../../utils/classNames.js';

export default function Tile({ className = '', children, dark = false, padding = 'p-5', onClick }) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'rounded-2xl overflow-hidden transition relative',
        padding,
        dark
          ? 'bg-navy-900 text-white border border-navy-800 dark:bg-black dark:border-navy-800'
          : 'bg-white dark:bg-navy-900 border border-navy-200/70 dark:border-navy-800 hover:shadow-card',
        className
      )}
    >
      {children}
    </div>
  );
}
