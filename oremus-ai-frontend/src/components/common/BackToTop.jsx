import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';

// Small floating "back to top" button for authenticated app pages. Appears once
// the window has scrolled past ~60% of a viewport height and smooth-scrolls back
// to the top (honors prefers-reduced-motion). Dark-mode aware.
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
      className={`fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-navy-200 bg-white text-navy-700 shadow-lift transition-all duration-300 hover:-translate-y-0.5 hover:text-brand-600 dark:border-navy-700 dark:bg-navy-900 dark:text-navy-200 dark:hover:text-brand-400 ${
        visible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'
      }`}
    >
      <ArrowUp size={18} />
    </button>
  );
}
