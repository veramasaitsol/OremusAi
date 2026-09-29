import { compare, detectUsDates, looksLikeDate } from './sortCompare.js';

// Column-header sorting for { columns, rows } reports.
//
// Report rows are a flattened tree: section headers, the rows inside them
// (which may carry their own deeper sub-rows), "Total for …" subtotals and a
// grand TOTAL. Sorting only reorders SIBLINGS — rows at the same level between
// the same structural rows — and moves each row together with its sub-rows,
// so headers, subtotals and totals never leave their place and every section
// still foots.

const isStructuralFlag = (r) => r.isHeader === true || r.isSubtotal || r.isTotal || r.isOpening;

// Which kind of sort a column gets, or null when it isn't sortable. Only name,
// date and amount columns sort. `isLabel` = the row-label column (r.label).
export function sortKindFor(col, isLabel, rows) {
  if (isLabel) {
    const sample = rows.filter((r) => !isStructuralFlag(r) && r.label != null && r.label !== '').slice(0, 20);
    return sample.length && sample.every((r) => looksLikeDate(r.label)) ? 'date' : 'name';
  }
  const label = `${col.key} ${col.label || ''}`.toLowerCase();
  if (/date/.test(label)) return 'date';
  if (col.align === 'right' && col.money !== false) return 'amount';
  if (/name|vendor|customer|payee|counterparty|description|account/.test(label)) return 'name';
  return null;
}

const isStructural = (r, next) => {
  if (isStructuralFlag(r)) return true;
  // Older reports mark a section title only by having deeper rows beneath it
  // and no amounts of its own.
  if (r.isHeader == null && next && (next.level || 0) > (r.level || 0)) {
    return !Object.values(r.cells || {}).some((v) => v !== '' && v != null);
  }
  return false;
};

// col = { key, isLabel, getValue? }: isLabel sorts on r.label, otherwise
// r.cells[key] — or getValue(r, key) for a viewer that derives its cells.
export function sortReportRows(rows, col, kind, dir) {
  if (!kind || rows.length < 2) return rows;
  const valueOf = (r) => (col.isLabel ? r.label : col.getValue ? col.getValue(r, col.key) : r.cells?.[col.key]);
  const usDates = kind === 'date' ? detectUsDates(rows.map(valueOf)) : false;
  const sign = dir === 'desc' ? -1 : 1;

  const sortSlice = (list) => {
    const out = [];
    let i = 0;
    while (i < list.length) {
      const r = list[i];
      const lvl = r.level || 0;
      if (isStructural(r, list[i + 1])) { out.push(r); i += 1; continue; }

      // A run of sibling rows at this level; each takes its deeper sub-rows.
      const items = [];
      while (i < list.length) {
        const head = list[i];
        if ((head.level || 0) !== lvl || isStructural(head, list[i + 1])) break;
        let j = i + 1;
        while (j < list.length && (list[j].level || 0) > lvl) j += 1;
        items.push({ head, children: sortSlice(list.slice(i + 1, j)), pos: items.length });
        i = j;
      }
      items.sort((a, b) => compare(valueOf(a.head), valueOf(b.head), kind, usDates) * sign || a.pos - b.pos);
      for (const it of items) out.push(it.head, ...it.children);
    }
    return out;
  };
  return sortSlice(rows);
}
