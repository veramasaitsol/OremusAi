// Shared comparators for click-to-sort report and breakdown tables.

// Breakdown dates arrive as YYYY-MM-DD, DD/MM/YYYY or MM/DD/YYYY depending on
// the report; `usDates` picks the reading for the slash forms.
function dateValue(v, usDates) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Number(m[1] + m[2] + m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const [dd, mm] = usDates ? [m[2], m[1]] : [m[1], m[2]];
    return Number(m[3] + mm.padStart(2, '0') + dd.padStart(2, '0'));
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

export function compare(a, b, kind, usDates) {
  if (kind === 'amount') {
    // A blank amount cell (an empty aging bucket) is a zero.
    const x = a === '' || a == null ? 0 : Number(a);
    const y = b === '' || b == null ? 0 : Number(b);
    return (Number.isFinite(x) ? x : -Infinity) - (Number.isFinite(y) ? y : -Infinity);
  }
  if (kind === 'date') {
    const x = dateValue(a, usDates); const y = dateValue(b, usDates);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return x - y;
  }
  return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base', numeric: true });
}

// Whether slash dates in a list read as MM/DD (US) — true once any value's
// middle part exceeds 12.
export function detectUsDates(values) {
  return values.some((v) => /^(\d{1,2})\/(\d{1,2})\//.test(String(v || '')) && Number(String(v).split('/')[1]) > 12);
}

export const looksLikeDate = (v) => /^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}\/\d{4}/.test(String(v || '').trim());

// Flat entry list sorted on entry[key]; `sort` = { key, dir } or null (original
// order). Ties keep their original order.
export function sortEntries(entries, sort, kinds) {
  if (!sort || !kinds[sort.key]) return entries;
  const kind = kinds[sort.key];
  const usDates = kind === 'date' ? detectUsDates(entries.map((e) => e[sort.key])) : false;
  const dir = sort.dir === 'desc' ? -1 : 1;
  return entries
    .map((e, i) => [e, i])
    .sort(([a, i], [b, j]) => compare(a[sort.key], b[sort.key], kind, usDates) * dir || i - j)
    .map(([e]) => e);
}

// ascending → descending → original order.
export const nextSort = (s, key) => {
  if (!s || s.key !== key) return { key, dir: 'asc' };
  return s.dir === 'asc' ? { key, dir: 'desc' } : null;
};
