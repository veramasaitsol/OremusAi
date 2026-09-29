import { useState } from 'react';
import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import { cn } from '../../utils/classNames.js';
import { sortKindFor, sortReportRows } from '../../utils/sortReportRows.js';

// Header button with the sort icon, shared by every report table.
export function SortHeaderButton({ label, active, dir, align, onClick }) {
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Sort by ${label || 'name'}`}
      className={cn(
        'inline-flex items-center gap-1 hover:text-brand-600',
        align === 'right' && 'flex-row-reverse',
        active && 'text-brand-600',
      )}
    >
      {label}
      <Icon size={11} className={active ? '' : 'opacity-50'} />
    </button>
  );
}

/**
 * Click-to-sort for a report's rows (name, date and amount columns only).
 * Rows keep their section structure — see sortReportRows.
 *
 *   const { rows: shown, header } = useReportSort(rows, { onChange });
 *   <th>{header(col)}</th>                 // a value column (cells[col.key])
 *   <th>{header(col, { isLabel: true })}</th>  // the row-label column
 *
 * `header` returns the plain label for a column that doesn't sort.
 * `onChange` runs on every sort change (reset row-index keyed UI state there).
 * `getValue(row, key)` reads a value column when it isn't simply row.cells[key].
 */
export function useReportSort(rows = [], { onChange, getValue } = {}) {
  const [sort, setSort] = useState(null); // { key, isLabel, kind, dir }

  const shown = sort ? sortReportRows(rows, { key: sort.key, isLabel: sort.isLabel, getValue }, sort.kind, sort.dir) : rows;

  const header = (col, { isLabel = false, label } = {}) => {
    const text = label ?? col.label;
    const kind = sortKindFor(col, isLabel, rows);
    if (!kind) return text;
    const key = isLabel ? 'label' : col.key;
    const active = sort?.key === key;
    return (
      <SortHeaderButton
        label={text}
        active={active}
        dir={sort?.dir}
        align={col.align || (isLabel ? 'left' : 'right')}
        onClick={() => {
          setSort((s) => {
            if (!s || s.key !== key) return { key, isLabel, kind, dir: 'asc' };
            return s.dir === 'asc' ? { ...s, dir: 'desc' } : null;
          });
          onChange?.();
        }}
      />
    );
  };

  return { rows: shown, header, sort };
}
