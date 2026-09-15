import { useDispatch, useSelector } from 'react-redux';
import { Columns3 } from 'lucide-react';
import Popover from '../ui/Popover.jsx';
import ReportFilterPill from './ReportFilterPill.jsx';
import {
  selectFilters, selectReportData, setHiddenColumn,
} from '../../features/reports/reportsSlice.js';

export default function ColumnsPopover() {
  const dispatch = useDispatch();
  const filters = useSelector(selectFilters);
  const data = useSelector(selectReportData);

  if (!data?.columns) return null;

  const hidden = filters.hiddenColumns;
  const hiddenCount = Object.keys(hidden).length;

  return (
    <Popover
      width={260}
      align="start"
      trigger={
        <ReportFilterPill
          label="Columns"
          value={hiddenCount ? `${data.columns.length - hiddenCount}/${data.columns.length}` : 'All'}
          icon={Columns3}
          active={hiddenCount > 0}
        />
      }
    >
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider font-semibold text-navy-400 mb-1.5 px-1">Columns</div>
        {data.columns.map((col) => (
          <label
            key={col.key}
            className="flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-navy-700 dark:text-navy-200 hover:bg-navy-50 dark:hover:bg-navy-800 cursor-pointer"
          >
            <input
              type="checkbox"
              checked={!hidden[col.key]}
              onChange={(e) => dispatch(setHiddenColumn({ key: col.key, hidden: !e.target.checked }))}
              className="accent-brand-500"
            />
            {col.label}
          </label>
        ))}
      </div>
    </Popover>
  );
}
