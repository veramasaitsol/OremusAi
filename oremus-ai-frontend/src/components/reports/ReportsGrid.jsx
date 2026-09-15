import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { FileSearch } from 'lucide-react';
import EmptyState from '../ui/EmptyState.jsx';
import ReportCard from './ReportCard.jsx';
import Button from '../ui/Button.jsx';
import {
  selectVisibleReports, selectFavorites,
  toggleFavorite,
  selectActiveCategory, setActiveCategory,
} from '../../features/reports/reportsSlice.js';
import { slugifyReport } from '../../features/reports/data/slugs.js';

export default function ReportsGrid() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const reports = useSelector(selectVisibleReports);
  const favorites = useSelector(selectFavorites);
  const activeCategory = useSelector(selectActiveCategory);

  if (reports.length === 0) {
    return (
      <EmptyState
        icon={FileSearch}
        title="No reports match your filters"
        description="Try clearing the search or switching to All reports to see every template."
        action={<Button variant="secondary" onClick={() => dispatch(setActiveCategory('all'))}>Show all reports</Button>}
      />
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-[13px] font-semibold text-navy-700 dark:text-navy-200 capitalize">
          {activeCategory === 'all' ? 'All reports' : activeCategory}
        </h2>
        <span className="text-[11.5px] text-navy-500">{reports.length} report{reports.length === 1 ? '' : 's'}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {reports.map((r) => (
          <ReportCard
            key={`${r.category}-${r.name}`}
            report={r}
            isFavorite={!!favorites[r.name]}
            onToggleFavorite={(name) => dispatch(toggleFavorite(name))}
            onOpen={(rep) => navigate(`/reports/${slugifyReport(rep.name)}`)}
          />
        ))}
      </div>
    </div>
  );
}
