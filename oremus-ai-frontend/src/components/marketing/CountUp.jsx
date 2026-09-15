'use client';

import { useEffect, useRef, useState } from 'react';

// Animated number that counts up when scrolled into view. Parses the numeric
// part of a string like "2.4M+", "97.8%", "14×", "99.99%" and animates it while
// preserving the prefix/suffix. Honors prefers-reduced-motion (shows final value).
function parse(str) {
  const m = String(str).match(/^([^\d.-]*)(-?[\d.]+)(.*)$/);
  if (!m) return { prefix: '', num: null, suffix: str, decimals: 0 };
  const [, prefix, numStr, suffix] = m;
  const decimals = numStr.includes('.') ? numStr.split('.')[1].length : 0;
  return { prefix, num: parseFloat(numStr), suffix, decimals };
}

export default function CountUp({ value, duration = 1600, className = '' }) {
  const { prefix, num, suffix, decimals } = parse(value);
  const [display, setDisplay] = useState(num == null ? value : `${prefix}0${decimals ? '.' + '0'.repeat(decimals) : ''}${suffix}`);
  const ref = useRef(null);
  const done = useRef(false);

  useEffect(() => {
    if (num == null) return undefined;
    const el = ref.current;
    if (!el) return undefined;

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setDisplay(value); return undefined; }

    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting && !done.current) {
          done.current = true;
          const start = performance.now();
          const tick = (now) => {
            const t = Math.min(1, (now - start) / duration);
            const eased = 1 - Math.pow(1 - t, 3);
            const current = (num * eased).toFixed(decimals);
            setDisplay(`${prefix}${current}${suffix}`);
            if (t < 1) requestAnimationFrame(tick);
            else setDisplay(value);
          };
          requestAnimationFrame(tick);
        }
      });
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, [num, decimals, prefix, suffix, value, duration]);

  return <span ref={ref} className={className}>{display}</span>;
}
