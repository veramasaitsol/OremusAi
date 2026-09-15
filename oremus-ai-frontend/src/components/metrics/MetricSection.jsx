/**
 * Base wrapper for a financial metrics section (Revenue, Profitability, etc.)
 * Renders a numbered section header + children.
 */
import { AlertTriangle } from 'lucide-react';
import { fmt, fmtMoneyCompact } from '../../utils/fmt.js';
import CountUpValue from '../dashboard/CountUpValue.jsx';

export default function MetricSection({ num, title, subtitle, badge, children }) {
  return (
    <div className="rounded-2xl border border-navy-200/70 dark:border-navy-800 bg-white dark:bg-navy-900 overflow-hidden">
      {/* Section header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-navy-100 dark:border-navy-800/60">
        <div className="flex items-center gap-3">
          <div>
            <div className="text-[14px] font-bold text-navy-900 dark:text-white leading-tight">{title}</div>
            {subtitle && <div className="text-[11px] text-navy-400">{subtitle}</div>}
          </div>
        </div>
        {badge && (
          <div className="text-[11.5px] font-semibold text-right whitespace-nowrap"
            style={{ color: badge.color || '#10B981' }}>
            {badge.dot && <span className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle" style={{ background: badge.color || '#10B981' }} />}
            {badge.text}
          </div>
        )}
      </div>

      <div className="p-5">
        {children}
      </div>
    </div>
  );
}

/** Reusable mini KPI card used inside sections */
export function MiniKpi({ label, value, sub, delta, color = '#2563EB', icon: Icon, isText }) {
  const up = (delta ?? 0) >= 0;
  return (
    <div className="rounded-xl border border-navy-100 dark:border-navy-800 p-3.5 bg-navy-50/50 dark:bg-navy-800/50">
      <div className="flex items-start justify-between gap-1 mb-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-navy-500 leading-tight">{label}</div>
        {Icon && (
          <div className="w-6 h-6 rounded-lg grid place-items-center flex-shrink-0" style={{ background: color + '18', color }}>
            <Icon size={11} />
          </div>
        )}
      </div>
      <div className="text-[clamp(14px,1.4vw,19px)] font-bold text-navy-900 dark:text-white leading-tight tabular-nums truncate">
        <CountUpValue value={isText ? value : (typeof value === 'number' ? fmtFull(value) : value)} />
      </div>
      {(sub || delta != null) && (
        <div className="flex items-center justify-between mt-1 gap-1">
          {sub && <div className="text-[10.5px] text-navy-400 truncate">{sub}</div>}
          {delta != null && (
            <div className={`text-[10.5px] font-semibold whitespace-nowrap ${up ? 'text-emerald-600' : 'text-red-500'}`}>
              {up ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}%
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Compact (Cr/L/k) — used for chart axis ticks where space is tight.
export function fmtINR(n) {
  if (n == null || isNaN(n)) return fmtMoneyCompact(0);
  return fmtMoneyCompact(n);
}

// Full grouped digits — used for card/inline values and tooltips.
export function fmtFull(n) {
  if (n == null || isNaN(n)) return fmt(0);
  return fmt(n);
}

export const AXIS_STYLE = { fontSize: 10, fill: '#94a3b8', fillOpacity: 1 };

export function SectionSkeleton() {
  return (
    <div className="rounded-2xl border border-navy-200/70 dark:border-navy-800 bg-white dark:bg-navy-900 p-5 space-y-4">
      <div className="h-4 w-40 rounded skeleton" />
      <div className="grid grid-cols-4 gap-3">
        {[0, 1, 2, 3].map(i => <div key={i} className="h-20 rounded-xl skeleton" />)}
      </div>
      <div className="h-44 rounded-xl skeleton" />
    </div>
  );
}

// Honest failure state — an API error renders as an explicit error + Retry
// instead of empty charts that look like "no data".
export function SectionError({ message, onRetry }) {
  return (
    <div className="rounded-2xl border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 p-6">
      <div className="flex items-center gap-2 text-[12.5px] font-semibold text-red-700 dark:text-red-300 mb-1">
        <AlertTriangle size={14} className="shrink-0" /> Could not load this section
      </div>
      {message && (
        <div className="text-[11.5px] text-red-600 dark:text-red-400/80 mb-3 break-words">{message}</div>
      )}
      <button
        onClick={onRetry}
        className="h-8 px-3 rounded-lg bg-red-600 hover:bg-red-700 text-white text-[12px] font-semibold transition"
      >Retry</button>
    </div>
  );
}
