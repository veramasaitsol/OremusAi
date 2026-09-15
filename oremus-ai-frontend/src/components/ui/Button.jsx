import { cn } from '../../utils/classNames.js';

const SIZES = {
  sm: 'h-8 px-2.5 text-[12px]',
  md: 'h-9 px-3.5 text-[12.5px]',
  lg: 'h-10 px-4 text-[13px]',
};
const VARIANTS = {
  primary:   'bg-brand-500 hover:bg-brand-600 text-white shadow-soft',
  secondary: 'bg-white dark:bg-navy-800 border border-navy-200 dark:border-navy-700 text-navy-700 dark:text-navy-200 hover:bg-navy-50 dark:hover:bg-navy-700',
  ghost:     'text-navy-600 dark:text-navy-300 hover:bg-navy-100 dark:hover:bg-navy-800',
  danger:    'bg-red-500 hover:bg-red-600 text-white',
  gradient:  'text-white shadow-soft hover:shadow-lift bg-gradient-to-r from-brand-500 to-cyan-500 hover:from-brand-600 hover:to-cyan-600',
};

export default function Button({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  iconSize = 14,
  children,
  className = '',
  ...rest
}) {
  return (
    <button
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg font-semibold transition',
        SIZES[size],
        VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {Icon && <Icon size={iconSize} />}
      {children}
    </button>
  );
}
