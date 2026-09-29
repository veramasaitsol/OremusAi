import { useMemo, useState } from 'react';
import { cn } from '../../utils/classNames.js';
import { sortEntries, nextSort } from '../../utils/sortCompare.js';
import { SortHeaderButton } from './useReportSort.jsx';

/**
 * Click-to-sort state for a breakdown table. `sort` is { key, dir } or null
 * (original order). Clicking a column cycles ascending → descending → off.
 * `kinds` maps a sortable key to 'name' | 'date' | 'amount'.
 */
export function useSortedEntries(entries, kinds) {
  const [sort, setSort] = useState(null);
  const sorted = useMemo(() => sortEntries(entries, sort, kinds), [entries, sort, kinds]);
  const toggle = (key) => setSort((s) => nextSort(s, key));
  return { sorted, sort, toggle, reset: () => setSort(null) };
}

// A header cell with a sort icon; `sort`/`onSort` come from useSortedEntries.
export default function SortableTh({ label, sortKey, sort, onSort, align = 'left', className }) {
  const active = sort?.key === sortKey;
  return (
    <th
      className={cn(className, align === 'right' ? 'text-right' : 'text-left')}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <SortHeaderButton label={label} active={active} dir={sort?.dir} align={align} onClick={() => onSort(sortKey)} />
    </th>
  );
}
