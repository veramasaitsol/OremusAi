import { useEffect, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { Building2, ChevronDown, Check, Loader2 } from 'lucide-react';
import {
  selectOrgList,
  selectOrgSelectedId,
  selectActiveOrg,
  selectOrgSwitching,
  switchOrganization,
} from '../../features/orgs/orgsSlice.js';
import { cn } from '../../utils/classNames.js';

export default function OrgSwitcher() {
  const dispatch  = useDispatch();
  const orgs      = useSelector(selectOrgList);
  const selectedId = useSelector(selectOrgSelectedId);
  const active    = useSelector(selectActiveOrg);
  const switching = useSelector(selectOrgSwitching);

  const [open, setOpen] = useState(false);
  const [pickError, setPickError] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // No organizations at all (non-Zoho accounts) → hide entirely.
  if (!orgs || orgs.length === 0) return null;

  // Single org → show the org name as a static badge (same look as the
  // switcher, just no dropdown), so the header reads consistently with
  // multi-org accounts.
  if (orgs.length === 1) {
    const only = active || orgs[0];
    const onlyLabel = only?.org_name || only?.name || only?.org_id || 'Organization';
    return (
      <div className="flex items-center gap-2 h-9 pl-1.5 pr-2.5 rounded-xl border bg-white dark:bg-navy-900 border-navy-200 dark:border-navy-700 max-w-full min-w-0">
        <span className="w-6 h-6 rounded-md bg-gradient-to-br from-brand-500 to-cyan-500 text-white grid place-items-center shrink-0">
          <Building2 size={13} />
        </span>
        <span className="text-[12.5px] font-semibold text-navy-900 dark:text-white leading-tight truncate max-w-[110px] sm:max-w-[150px] md:max-w-[200px]">
          {onlyLabel}
        </span>
      </div>
    );
  }

  const label = active?.org_name || 'Select organization';

  const onPick = (orgId) => {
    setOpen(false);
    if (String(orgId) === String(selectedId)) return;
    // Sync the active org on the backend first (the slice persists it only after
    // the backend confirms), then reload so every page refetches with the new
    // X-Org-Id header applied. On failure show the reason and keep the dropdown
    // open so the user can retry — never silently switch headers out from under
    // the backend's active org.
    setPickError(null);
    dispatch(switchOrganization(orgId))
      .unwrap()
      .then(() => window.location.reload())
      .catch((err) => {
        setPickError(err || 'Could not switch organization — please try again.');
        setOpen(true);
      });
  };

  return (
    <div ref={ref} className="relative block min-w-0">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={switching}
        className={cn(
          'flex items-center gap-2 h-9 pl-1.5 pr-2.5 rounded-xl border transition max-w-full min-w-0',
          open
            ? 'bg-brand-50/60 border-brand-300 dark:bg-brand-500/15 dark:border-brand-500/40'
            : 'bg-white dark:bg-navy-900 border-navy-200 dark:border-navy-700 hover:bg-navy-50 dark:hover:bg-navy-800'
        )}
      >
        <span className="w-6 h-6 rounded-md bg-gradient-to-br from-brand-500 to-cyan-500 text-white grid place-items-center shrink-0">
          {switching ? <Loader2 size={13} className="animate-spin" /> : <Building2 size={13} />}
        </span>
        <span className="text-[12.5px] font-semibold text-navy-900 dark:text-white leading-tight truncate max-w-[110px] sm:max-w-[150px] md:max-w-[200px]">
          {label}
        </span>
        <ChevronDown size={13} className={cn('text-navy-400 transition-transform shrink-0', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 w-[280px] sm:w-[300px] max-w-[calc(100vw-1.5rem)] z-50 bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-700 rounded-xl shadow-lift overflow-hidden animate-fadein">
          <div className="px-3 py-2 border-b border-navy-100 dark:border-navy-800">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-navy-400">
              Organizations
            </span>
          </div>
          {pickError && (
            <div className="px-3 py-2 border-t border-red-100 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 text-[11.5px] text-red-600 dark:text-red-400">
              {pickError}
            </div>
          )}
          <ul className="max-h-[280px] overflow-y-auto scroll-thin py-1.5">
            {orgs.map((o) => {
              const selected = String(o.org_id) === String(selectedId);
              return (
                <li key={o.org_id}>
                  <button
                    onClick={() => onPick(o.org_id)}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3 py-2 text-left transition',
                      selected ? 'bg-brand-50/60 dark:bg-brand-500/10' : 'hover:bg-navy-50 dark:hover:bg-navy-800'
                    )}
                  >
                    <span className="w-7 h-7 rounded-md grid place-items-center text-white shrink-0 bg-gradient-to-br from-brand-500 to-cyan-500">
                      <Building2 size={13} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[12.5px] font-semibold text-navy-900 dark:text-white truncate">
                        {o.org_name || o.name || o.org_id}
                      </span>
                      <span className="block text-[11px] text-navy-500 truncate">
                        {o.currency ? `${o.currency} · ` : ''}{o.org_id}
                      </span>
                    </span>
                    {selected && <Check size={14} className="text-brand-500" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
