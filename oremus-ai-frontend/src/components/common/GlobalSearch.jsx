import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, FileText, ArrowDownLeft, ArrowUpRight, BookOpen, Receipt, Loader2 } from 'lucide-react';
import axiosClient from '../../services/axiosClient.js';
import { cn } from '../../utils/classNames.js';
import { fmtMoneyCompact } from '../../utils/fmt.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtAmt(n) {
  if (!n && n !== 0) return '';
  return fmtMoneyCompact(n);   // currency-aware compact (USD/₹/…)
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
}

const TYPE_ICON = {
  invoice:     FileText,
  transaction: ArrowDownLeft,
  account:     BookOpen,
  bill:        Receipt,
};

const TYPE_COLOR = {
  invoice:     'text-brand-600 bg-brand-50 dark:bg-brand-500/15',
  transaction: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-500/15',
  account:     'text-violet-600 bg-violet-50 dark:bg-violet-500/15',
  bill:        'text-amber-600 bg-amber-50 dark:bg-amber-500/15',
};

const TYPE_ROUTE = {
  invoice:     '/invoices',
  transaction: '/transactions',
  account:     '/transactions',
  bill:        '/vendors',
};

// ── Debounce ──────────────────────────────────────────────────────────────────
function useDebounce(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ── Main component ────────────────────────────────────────────────────────────
export default function GlobalSearch({ className = '' }) {
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open,    setOpen]    = useState(false);
  const [focused, setFocused] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);

  const inputRef     = useRef(null);
  const containerRef = useRef(null);
  const navigate     = useNavigate();
  const debouncedQ   = useDebounce(query, 280);

  // ── Fetch results ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (debouncedQ.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    axiosClient.get('/search', { params: { q: debouncedQ } })
      .then(r => {
        if (!cancelled) {
          setResults(r.data.data || []);
          setOpen(true);
          setActiveIdx(-1);
        }
      })
      .catch(() => { if (!cancelled) setResults([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [debouncedQ]);

  // ── Close on outside click ───────────────────────────────────────────────────
  useEffect(() => {
    const h = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        setFocused(false);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  // ── ⌘K shortcut ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setFocused(true);
      }
      if (e.key === 'Escape') {
        setOpen(false);
        inputRef.current?.blur();
        setFocused(false);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ── Keyboard nav inside dropdown ─────────────────────────────────────────────
  const onKeyDown = (e) => {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, -1));
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      handleSelect(results[activeIdx]);
    }
  };

  const handleSelect = useCallback((item) => {
    setOpen(false);
    setQuery('');
    navigate(TYPE_ROUTE[item.type] || '/transactions');
  }, [navigate]);

  const clear = () => {
    setQuery('');
    setResults([]);
    setOpen(false);
    inputRef.current?.focus();
  };

  const showDropdown = open && (results.length > 0 || (loading && query.length >= 2));

  // Group results by category
  const grouped = results.reduce((acc, r) => {
    if (!acc[r.category]) acc[r.category] = [];
    acc[r.category].push(r);
    return acc;
  }, {});

  return (
    <div ref={containerRef} className={cn('relative flex-1 max-w-[600px]', className)}>
      {/* Input */}
      <div className={cn(
        'flex items-center gap-2.5 h-10 px-3.5 rounded-xl border transition-all duration-150',
        'bg-white dark:bg-navy-900',
        focused || open
          ? 'border-brand-400 ring-4 ring-brand-100 dark:ring-brand-500/15 shadow-soft'
          : 'border-navy-200 dark:border-navy-700 shadow-soft hover:border-navy-300 dark:hover:border-navy-600'
      )}>
        <Search size={15} className="text-navy-400 shrink-0" />

        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => { setFocused(true); if (results.length > 0) setOpen(true); }}
          onKeyDown={onKeyDown}
          placeholder="Search transactions, customers, accounts, invoices..."
          className="flex-1 bg-transparent text-[13px] text-navy-900 dark:text-white placeholder:text-navy-400 outline-none min-w-0"
        />

        {loading && <Loader2 size={13} className="text-brand-500 animate-spin shrink-0" />}

        {query && !loading && (
          <button onClick={clear} className="h-5 w-5 grid place-items-center rounded-md text-navy-400 hover:text-navy-600 hover:bg-navy-100 dark:hover:bg-navy-800 shrink-0 transition">
            <X size={12} />
          </button>
        )}

        {!query && (
          <kbd className="hidden sm:flex items-center gap-0.5 h-5 px-1.5 rounded-md bg-navy-100 dark:bg-navy-800 border border-navy-200 dark:border-navy-700 text-[10px] font-mono font-semibold text-navy-400 shrink-0">
            ⌘ K
          </kbd>
        )}
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute left-0 right-0 top-full mt-2 z-50 bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-700 rounded-2xl shadow-lift overflow-hidden animate-fadein">
          {loading && results.length === 0 ? (
            <div className="flex items-center justify-center py-8 gap-2 text-[13px] text-navy-400">
              <Loader2 size={14} className="animate-spin" />
              Searching…
            </div>
          ) : results.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-navy-400">
              No results for "<span className="font-semibold text-navy-600 dark:text-navy-300">{query}</span>"
            </div>
          ) : (
            <div className="max-h-[420px] overflow-y-auto py-2">
              {Object.entries(grouped).map(([category, items]) => (
                <div key={category}>
                  <div className="px-3.5 pt-2 pb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-navy-400">
                    {category}s
                  </div>
                  {items.map((item, i) => {
                    const globalIdx = results.indexOf(item);
                    const Icon = TYPE_ICON[item.type] || FileText;
                    const colorCls = TYPE_COLOR[item.type] || 'text-navy-500 bg-navy-100';
                    const isActive = globalIdx === activeIdx;

                    return (
                      <button
                        key={i}
                        onMouseEnter={() => setActiveIdx(globalIdx)}
                        onClick={() => handleSelect(item)}
                        className={cn(
                          'w-full flex items-center gap-3 px-3.5 py-2.5 text-left transition-colors',
                          isActive
                            ? 'bg-brand-50 dark:bg-brand-500/10'
                            : 'hover:bg-navy-50 dark:hover:bg-navy-800/60'
                        )}
                      >
                        {/* Icon */}
                        <div className={cn('w-7 h-7 rounded-lg grid place-items-center shrink-0', colorCls)}>
                          <Icon size={13} />
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-semibold text-navy-900 dark:text-white truncate">
                              {item.title}
                            </span>
                            {item.ref && (
                              <span className="text-[10.5px] text-navy-400 shrink-0">{item.ref}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            {item.status && (
                              <span className="text-[10.5px] text-navy-400 capitalize">{item.status}</span>
                            )}
                            {item.date && (
                              <span className="text-[10.5px] text-navy-400">{fmtDate(item.date)}</span>
                            )}
                          </div>
                        </div>

                        {/* Amount */}
                        {item.amount > 0 && (
                          <div className="text-[13px] font-bold text-navy-800 dark:text-navy-100 shrink-0">
                            {fmtAmt(item.amount)}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}

              {/* Footer hint */}
              <div className="mx-3 mt-1 mb-2 pt-2 border-t border-navy-100 dark:border-navy-800 flex items-center gap-3 text-[10px] text-navy-400">
                <span><kbd className="px-1 py-0.5 rounded bg-navy-100 dark:bg-navy-800 font-mono">↑↓</kbd> navigate</span>
                <span><kbd className="px-1 py-0.5 rounded bg-navy-100 dark:bg-navy-800 font-mono">↵</kbd> open</span>
                <span><kbd className="px-1 py-0.5 rounded bg-navy-100 dark:bg-navy-800 font-mono">Esc</kbd> close</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
