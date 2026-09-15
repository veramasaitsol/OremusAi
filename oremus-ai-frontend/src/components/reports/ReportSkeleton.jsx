import Skeleton from '../ui/Skeleton.jsx';
import { cn } from '../../utils/classNames.js';

// Loading placeholder shaped like a financial statement table: a column-header
// row followed by indented label rows with right-aligned value columns. Used by
// the report viewers in place of a bare "Loading…" line so the layout doesn't
// jump when real rows arrive.
//
// `rows` controls how many body rows to draw; `cols` how many value columns.
export default function ReportSkeleton({ rows = 12, cols = 1 }) {
  // Varied label widths + indents so it reads like a real statement.
  const shapes = [
    { w: 'w-44', indent: 0, strong: true },
    { w: 'w-56', indent: 1 },
    { w: 'w-48', indent: 1 },
    { w: 'w-52', indent: 1 },
    { w: 'w-40', indent: 0, strong: true },
    { w: 'w-60', indent: 1 },
    { w: 'w-44', indent: 1 },
    { w: 'w-56', indent: 1 },
    { w: 'w-36', indent: 1 },
    { w: 'w-48', indent: 0, strong: true },
    { w: 'w-52', indent: 1 },
    { w: 'w-44', indent: 1 },
  ];

  return (
    <div className="py-4" role="status" aria-busy="true" aria-label="Loading report">
      {/* Column header row */}
      <div className="flex items-center gap-6 pb-3 mb-3 border-b border-navy-100 dark:border-navy-800">
        <Skeleton className="h-3.5 w-32" />
        <div className="flex-1" />
        {Array.from({ length: cols }).map((_, c) => (
          <Skeleton key={c} className="h-3.5 w-24" />
        ))}
      </div>

      {/* Body rows */}
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => {
          const s = shapes[i % shapes.length];
          return (
            <div key={i} className="flex items-center gap-6">
              <div className={cn(s.indent === 1 && 'pl-6')}>
                <Skeleton className={cn('h-3', s.w, s.strong && 'h-3.5')} />
              </div>
              <div className="flex-1" />
              {Array.from({ length: cols }).map((_, c) => (
                <Skeleton key={c} className={cn('h-3 w-20', s.strong && 'w-24')} />
              ))}
            </div>
          );
        })}
      </div>

      <span className="sr-only">Loading report…</span>
    </div>
  );
}
