'use client';

import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';

// Small, classic floating "back to top" button. Appears after the viewport has
// scrolled past one screen height and smooth-scrolls to the top. Honors
// prefers-reduced-motion (jumps instantly instead of animating).
export default function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > window.innerHeight * 0.6);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const toTop = () => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  };

  return (
    <button
      type="button"
      onClick={toTop}
      aria-label="Back to top"
      className={`fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-navy-100 bg-white text-navy-700 shadow-lift transition-all duration-300 hover:-translate-y-0.5 hover:bg-navy-50 hover:text-brand-600 ${
        visible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'
      }`}
    >
      <ArrowUp size={18} />
    </button>
  );
}
