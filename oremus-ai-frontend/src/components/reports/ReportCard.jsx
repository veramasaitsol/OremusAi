import { Star, Eye } from 'lucide-react';
import IconBadge from '../ui/IconBadge.jsx';
import { iconForReport } from './reportIcon.js';
import { cn } from '../../utils/classNames.js';
import ReportCardExportMenu from './ReportCardExportMenu.jsx';

export default function ReportCard({ report, isFavorite = false, onOpen, onToggleFavorite }) {
  const Icon = iconForReport(report.name);

  return (
    <div
      className={cn(
        'group report-card relative flex flex-col',
        'bg-white dark:bg-navy-900 border border-navy-200/70 dark:border-navy-800',
        'rounded-2xl shadow-card hover:shadow-lift hover:-translate-y-0.5 transition',
        'p-4'
      )}
      data-report={report.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}
    >
      <div className="flex items-start justify-between">
        <IconBadge icon={Icon} tone="brand" size="md" />
        <button
          type="button"
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={(e) => { e.stopPropagation(); onToggleFavorite?.(report.name); }}
          className={cn(
            'h-7 w-7 rounded-lg grid place-items-center transition',
            isFavorite ? 'text-amber-500' : 'text-navy-300 hover:text-amber-500 hover:bg-navy-50 dark:hover:bg-navy-800',
          )}
        >
          <Star size={15} fill={isFavorite ? 'currentColor' : 'none'} />
        </button>
      </div>

      <button
        type="button"
        onClick={() => onOpen?.(report)}
        className="text-left mt-3"
      >
        <h3 className="text-[13.5px] font-semibold text-navy-900 dark:text-white leading-tight">
          {report.name}
        </h3>
        <p className="mt-1 text-[11.5px] text-navy-500 dark:text-navy-400 line-clamp-2">
          {report.desc}
        </p>
      </button>

      <div className="mt-4 pt-3 border-t border-navy-100 dark:border-navy-800 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onOpen?.(report)}
          className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand-600 hover:text-brand-700 dark:text-brand-400"
        >
          <Eye size={13} /> View
        </button>
        <ReportCardExportMenu report={report} />
      </div>
    </div>
  );
}
