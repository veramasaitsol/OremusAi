import { cn } from '../../utils/classNames.js';

// Lightweight placeholder block used while data loads. Reserves the real
// element's footprint to avoid layout shift, and uses Tailwind's built-in
// `animate-pulse` (no extra CSS) for a subtle shimmer. Decorative only, so it
// is hidden from assistive tech — the surrounding container should carry the
// aria-busy/role="status" semantics.
export default function Skeleton({ className, rounded = 'rounded-md', ...rest }) {
  return (
    <span
      aria-hidden="true"
      className={cn('block animate-pulse bg-navy-100 dark:bg-navy-800/70', rounded, className)}
      {...rest}
    />
  );
}
