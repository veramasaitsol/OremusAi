import { useDispatch, useSelector } from 'react-redux';
import { Search, Sparkles, Star } from 'lucide-react';
import Button from '../ui/Button.jsx';
import Badge from '../ui/Badge.jsx';
import { cn } from '../../utils/classNames.js';
import {
  selectQuery, selectShowFavoritesOnly,
  setQuery, setShowFavoritesOnly,
} from '../../features/reports/reportsSlice.js';

export default function ReportsHeader() {
  const dispatch = useDispatch();
  const query = useSelector(selectQuery);
  const favOnly = useSelector(selectShowFavoritesOnly);

  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10.5px] font-bold tracking-[0.2em] uppercase text-navy-500">Workspace</span>
          <span className="text-navy-300">·</span>
          <span className="text-[10.5px] text-navy-500">Reports</span>
          <Badge tone="green" dot>Live</Badge>
        </div>
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-[28px] font-bold tracking-tight text-navy-900 dark:text-white leading-none">
              Reports
            </h1>
            <p className="text-[12.5px] text-navy-500 mt-1">Templates powered by your live ledger.</p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-navy-400" />
          <input
            value={query}
            onChange={(e) => dispatch(setQuery(e.target.value))}
            placeholder="Search reports…"
            className="h-9 w-[260px] max-w-[60vw] pl-9 pr-3 rounded-lg bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-700 text-[12.5px] text-navy-900 dark:text-white outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
        <Button
          variant="secondary"
          icon={Star}
          onClick={() => dispatch(setShowFavoritesOnly(!favOnly))}
          className={cn(favOnly && 'border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/40 dark:text-amber-300')}
        >
          Favorites
        </Button>
        <Button variant="gradient" icon={Sparkles} iconSize={14}>Ask Oremus AI</Button>
      </div>
    </div>
  );
}
