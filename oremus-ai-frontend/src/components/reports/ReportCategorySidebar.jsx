import { useDispatch, useSelector } from 'react-redux';
import {
  selectCategoriesWithCounts, selectActiveCategory, setActiveCategory,
} from '../../features/reports/reportsSlice.js';
import { resolveIcon } from './reportIcon.js';
import { cn } from '../../utils/classNames.js';

export default function ReportCategorySidebar() {
  const dispatch = useDispatch();
  const cats = useSelector(selectCategoriesWithCounts);
  const active = useSelector(selectActiveCategory);

  return (
    <aside
      className={cn(
        'bg-white dark:bg-navy-900 border border-navy-200/70 dark:border-navy-800 rounded-2xl',
        'p-2 h-fit',
        // Desktop: pin the categories column so it stays put while the report
        // cards scroll. top offset clears the sticky h-14 navbar (56px) + gap.
        'lg:sticky lg:top-[68px] lg:self-start',
        // Mobile: horizontal pill scroller
        'overflow-x-auto lg:overflow-visible scroll-thin',
      )}
    >
      <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-navy-400 font-semibold hidden lg:block">
        Categories
      </div>
      <ul className="flex lg:flex-col gap-1 min-w-max lg:min-w-0">
        {cats.map((c) => {
          const Icon = resolveIcon(c.icon);
          const isActive = active === c.id;
          return (
            <li key={c.id} className="shrink-0 lg:shrink">
              <button
                type="button"
                onClick={() => dispatch(setActiveCategory(c.id))}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12.5px] font-medium transition',
                  isActive
                    ? 'bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300'
                    : 'text-navy-600 dark:text-navy-300 hover:bg-navy-50 dark:hover:bg-navy-800',
                )}
              >
                <Icon size={18} className={cn(isActive ? 'text-brand-600 dark:text-brand-400' : 'text-navy-400')} />
                <span className="flex-1 text-left whitespace-nowrap">{c.label}</span>
                <span
                  className={cn(
                    'text-[10.5px] font-semibold px-1.5 py-0.5 rounded',
                    isActive ? 'bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-200' : 'bg-navy-100 dark:bg-navy-800 text-navy-500',
                  )}
                >
                  {c.count}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
