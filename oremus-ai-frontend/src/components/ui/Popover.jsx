import { useEffect, useRef, useState, cloneElement } from 'react';
import { cn } from '../../utils/classNames.js';

const ALIGN = {
  start: 'left-0',
  end:   'right-0',
  center: 'left-1/2 -translate-x-1/2',
};

/**
 * Popover — anchored dropdown panel.
 *   <Popover trigger={<button>Open</button>} align="end" width={320}>
 *     <Panel/>
 *   </Popover>
 * The trigger element receives onClick (preserving its own) to toggle.
 */
export default function Popover({
  trigger,
  children,
  align = 'start',
  width = 280,
  className = '',
  open: controlledOpen,
  onOpenChange,
}) {
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = (v) => {
    if (!isControlled) setUncontrolledOpen(v);
    onOpenChange?.(v);
  };

  const wrapperRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const enhancedTrigger = cloneElement(trigger, {
    onClick: (e) => {
      trigger.props.onClick?.(e);
      setOpen(!open);
    },
    'aria-expanded': open,
    'aria-haspopup': 'true',
  });

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      {enhancedTrigger}
      {open && (
        <div
          style={{ width }}
          className={cn(
            'absolute top-full mt-1.5 z-30',
            'bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-800',
            'rounded-xl shadow-lift p-3 animate-fadein',
            ALIGN[align] || ALIGN.start,
            className,
          )}
        >
          {typeof children === 'function' ? children({ close: () => setOpen(false) }) : children}
        </div>
      )}
    </div>
  );
}
