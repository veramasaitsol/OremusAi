// Period-over-period growth indicator, shared by every dashboard surface so
// growth, decline and zero render identically: "▲ +X.X%" / "▼ -X.X%", and "—"
// when there is nothing to compare against (never a fake 0.0%). `inverse`
// flips the colour for metrics where a fall is good (e.g. burn).
export const formatGrowth = (value) => {
  const n = Number(value);
  return `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}%`;
};

export default function GrowthBadge({ value, inverse = false, className = '' }) {
  if (value == null || !Number.isFinite(Number(value))) {
    return (
      <span className={`whitespace-nowrap text-navy-400 ${className}`} title="No previous-period data to compare">—</span>
    );
  }
  const up = Number(value) >= 0;
  const positive = inverse ? !up : up;
  const color = positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
  return (
    <span className={`font-semibold whitespace-nowrap tabular-nums ${color} ${className}`} title="vs previous period">
      {up ? '▲' : '▼'} {formatGrowth(value)}
    </span>
  );
}

// Every KPI card shows its growth vs the previous period, unless the card
// opts out (`growthOnTile: false`) or already prints that same growth figure in
// its value or subtitle — so the same comparison is never shown twice. (A
// different percentage, such as EBITDA's margin, is not a duplicate.)
export function showsGrowthOnTile(kpi, displayValue) {
  if (!kpi || kpi.growthOnTile === false) return false;
  if (kpi.delta == null || !Number.isFinite(Number(kpi.delta))) return true; // shows "—"
  const g = Math.abs(Number(kpi.delta)).toFixed(2);
  const printed = `${String(displayValue ?? '')} ${String(kpi.sub ?? '')}`;
  return !new RegExp(`(^|[^\\d.])${g.replace('.', '\\.')}%`).test(printed);
}
