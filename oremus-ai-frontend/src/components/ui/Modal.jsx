import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../utils/classNames.js';

const SIZE = {
  full: 'inset-2 sm:inset-4 lg:inset-6 xl:inset-8',
  lg:   'inset-x-4 inset-y-8 sm:inset-x-12 sm:inset-y-16 max-w-5xl mx-auto',
  md:   'inset-x-4 inset-y-12 sm:inset-x-auto sm:inset-y-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-[640px]',
};

export default function Modal({ open, onClose, size = 'full', children, className = '' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 animate-fadein">
      <div
        className="absolute inset-0 bg-navy-900/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'absolute bg-white dark:bg-navy-950 border border-navy-200 dark:border-navy-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden',
          SIZE[size] || SIZE.full,
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
