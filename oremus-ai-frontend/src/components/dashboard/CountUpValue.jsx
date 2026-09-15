import { useEffect, useRef, useState } from 'react';
import { currencyLocale, getActiveCurrency } from '../../utils/fmt.js';

// Animated number for dashboard values. Parses the numeric part of an
// already-formatted string — "₹3.5Cr", "-₹3.9Cr", "₹2953.1k/mo", "63.2%",
// "35117k", "89" — and counts it up from 0 → target while preserving the
// prefix/suffix. Re-animates whenever the value changes (e.g. period switch).
// Non-numeric strings ("—", "…", "Healthy") render unchanged. Honors
// prefers-reduced-motion (jumps straight to the final value).
function parse(str) {
  const s = String(str);
  const m = s.match(/^(-?[^\d-]*)(-?[\d.,]+)(.*)$/);
  if (!m) return { prefix: '', num: null, suffix: s, decimals: 0 };
  const [, prefix, numStr, suffix] = m;
  const clean = numStr.replace(/,/g, '');
  const num = parseFloat(clean);
  if (isNaN(num)) return { prefix: '', num: null, suffix: s, decimals: 0 };
  const decimals = clean.includes('.') ? clean.split('.')[1].length : 0;
  return { prefix, num, suffix, decimals };
}

export default function CountUpValue({ value, duration = 1000, className = '' }) {
  const { prefix, num, suffix, decimals } = parse(value);
  const locale = currencyLocale(getActiveCurrency());
  const group = (v) => v.toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const [display, setDisplay] = useState(
    num == null ? String(value) : `${prefix}${group(0)}${suffix}`
  );
  const rafRef = useRef(null);

  useEffect(() => {
    if (num == null) { setDisplay(String(value)); return undefined; }

    const reduce = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setDisplay(String(value)); return undefined; }

    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      if (t < 1) {
        setDisplay(`${prefix}${group(num * eased)}${suffix}`);
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setDisplay(String(value)); // exact original string (keeps grouping/format)
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [value, num, decimals, prefix, suffix, duration]);

  return <span className={className}>{display}</span>;
}
