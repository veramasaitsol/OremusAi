import { useEffect } from 'react';

// Lightweight title manager for the public marketing pages. The Next port uses
// `export const metadata`; here we just set document.title on mount (no
// react-helmet dependency). Restores the base title on unmount.
const BASE = 'Oremus AI';

export default function Seo({ title, fullTitle }) {
  useEffect(() => {
    const prev = document.title;
    document.title = fullTitle || (title ? `${title} — ${BASE}` : BASE);
    return () => { document.title = prev; };
  }, [title, fullTitle]);
  return null;
}
