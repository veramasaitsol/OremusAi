import { useDispatch, useSelector } from 'react-redux';
import { GitCompare } from 'lucide-react';
import Popover from '../ui/Popover.jsx';
import ReportFilterPill from './ReportFilterPill.jsx';
import { selectCompare, setCompare } from '../../features/reports/reportsSlice.js';
import { cn } from '../../utils/classNames.js';

const BASE_OPTIONS = [['period', 'Period'], ['year', 'Year']];
const PERIOD_OPTIONS = [
  ['previous-period', 'Previous period'],
  ['previous-month',  'Previous month'],
  ['previous-quarter','Previous quarter'],
  ['previous-year',   'Previous year'],
];

const fieldCls =
  'h-8 px-2 rounded-md bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-700 text-[12px] text-navy-900 dark:text-white outline-none focus:border-brand-400';

export default function CompareWithPopover() {
  const dispatch = useDispatch();
  const c = useSelector(selectCompare);
  const active = c.count > 1 || c.with !== 'previous-period' || c.oldestFirst;

  return (
    <Popover
      width={320}
      align="start"
      trigger={
        <ReportFilterPill
          label="Compare"
          value={c.count > 1 ? `${c.count} periods` : 'Previous period'}
          icon={GitCompare}
          active={active}
        />
      }
    >
      <div className="space-y-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-navy-400 mb-1.5">Based on</div>
          <div className="grid grid-cols-2 gap-1.5">
            {BASE_OPTIONS.map(([k, l]) => (
              <button
                type="button"
                key={k}
                onClick={() => dispatch(setCompare({ baseOn: k }))}
                className={cn(
                  'h-9 rounded-lg text-[12px] font-medium border transition',
                  c.baseOn === k
                    ? 'bg-brand-50 border-brand-200 text-brand-700 dark:bg-brand-500/15 dark:border-brand-500/40 dark:text-brand-300'
                    : 'bg-white dark:bg-navy-900 border-navy-200 dark:border-navy-700 text-navy-700 dark:text-navy-200 hover:bg-navy-50 dark:hover:bg-navy-800',
                )}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center justify-between text-[12px] text-navy-700 dark:text-navy-200">
          <span>Compare with</span>
          <select className={fieldCls} value={c.with} onChange={(e) => dispatch(setCompare({ with: e.target.value }))}>
            {PERIOD_OPTIONS.map(([k, l]) => <option value={k} key={k}>{l}</option>)}
          </select>
        </label>

        <label className="flex items-center justify-between text-[12px] text-navy-700 dark:text-navy-200">
          <span>Number of periods</span>
          <select className={fieldCls} value={c.count} onChange={(e) => dispatch(setCompare({ count: Number(e.target.value) }))}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>

        <label className="flex items-center gap-2 text-[12px] text-navy-700 dark:text-navy-200 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={c.oldestFirst}
            onChange={(e) => dispatch(setCompare({ oldestFirst: e.target.checked }))}
            className="accent-brand-500"
          />
          Arrange oldest → latest
        </label>
      </div>
    </Popover>
  );
}
