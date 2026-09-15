import { useEffect, useRef, useState, useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { Users, ChevronDown, Check, Search, LayoutDashboard, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { fetchClients, selectAllClients, selectClientsStatus } from '../../features/clients/clientsSlice.js';
import { setViewAsClient, selectViewAsClientId } from '../../features/viewAs/viewAsSlice.js';
import { selectRole } from '../../features/auth/authSlice.js';
import { providerFromConnections } from '../../features/reports/data/providers.js';
import { cn } from '../../utils/classNames.js';

// Admin-only dashboard header control: pick a client to view the whole
// dashboard as that client. Mirrors OrgSwitcher — persists the choice and
// reloads so every page refetches with the X-Client-Id header applied.
export default function ClientSwitcher() {
  const dispatch   = useDispatch();
  const navigate   = useNavigate();
  const role       = useSelector(selectRole);
  const clients    = useSelector(selectAllClients);
  const status     = useSelector(selectClientsStatus);
  const selectedId = useSelector(selectViewAsClientId);

  const [open, setOpen] = useState(false);
  const [q, setQ]       = useState('');
  const ref = useRef(null);

  // Load the client list once (admin endpoint) — only for admins.
  useEffect(() => {
    if (role === 'admin' && status === 'idle') dispatch(fetchClients(''));
  }, [role, status, dispatch]);

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

  useEffect(() => { if (!open) setQ(''); }, [open]);

  const activeClient = useMemo(
    () => clients.find((c) => String(c.id) === String(selectedId)) || null,
    [clients, selectedId]
  );

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return clients;
    return clients.filter((c) =>
      [c.name, c.company, c.email].some((v) => (v || '').toLowerCase().includes(s))
    );
  }, [clients, q]);

  // Only admins can view as a client.
  if (role !== 'admin') return null;

  const label = activeClient
    ? (activeClient.company || activeClient.name || `Client #${activeClient.id}`)
    : 'My workspace';

  const onPick = (clientId) => {
    setOpen(false);
    const next = clientId ? String(clientId) : null;
    if (String(selectedId || '') === String(next || '')) return;
    // Persist the client's report provider alongside the id so Reports can
    // resolve the right engine synchronously after the reload (no async
    // client-list lookup that would briefly mis-resolve a deep link).
    const client = next ? clients.find((c) => String(c.id) === next) : null;
    dispatch(setViewAsClient({ id: next, provider: client ? providerFromConnections(client) : null }));
    // Reload so every page refetches with (or without) the X-Client-Id header.
    window.location.reload();
  };

  return (
    <div ref={ref} className="relative hidden md:block min-w-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-2 h-9 pl-1.5 pr-2.5 rounded-xl border transition max-w-full min-w-0',
          open || activeClient
            ? 'bg-brand-50/60 border-brand-300 dark:bg-brand-500/15 dark:border-brand-500/40'
            : 'bg-white dark:bg-navy-900 border-navy-200 dark:border-navy-700 hover:bg-navy-50 dark:hover:bg-navy-800'
        )}
        title={activeClient ? `Viewing as: ${label}` : 'Viewing your own workspace'}
      >
        <span className="w-6 h-6 rounded-md bg-gradient-to-br from-brand-500 to-cyan-500 text-white grid place-items-center shrink-0">
          {activeClient ? <Users size={13} /> : <LayoutDashboard size={13} />}
        </span>
        <span className="flex flex-col items-start leading-none min-w-0">
          <span className="text-[9px] font-semibold uppercase tracking-wide text-navy-400">
            {activeClient ? 'Viewing client' : 'Workspace'}
          </span>
          <span className="text-[12.5px] font-semibold text-navy-900 dark:text-white truncate max-w-[140px] md:max-w-[200px]">
            {label}
          </span>
        </span>
        <ChevronDown size={13} className={cn('text-navy-400 transition-transform shrink-0', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 w-[300px] max-w-[calc(100vw-1.5rem)] z-50 bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-700 rounded-xl shadow-lift overflow-hidden animate-fadein">
          <div className="px-3 py-2.5 border-b border-navy-100 dark:border-navy-800">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-navy-400" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search clients…"
                className="w-full h-8 pl-8 pr-2.5 rounded-lg bg-navy-50 dark:bg-navy-800 border border-transparent focus:border-brand-400 focus:bg-white dark:focus:bg-navy-900 text-[12.5px] outline-none placeholder:text-navy-400 text-navy-900 dark:text-white"
              />
            </div>
          </div>

          <ul className="max-h-[300px] overflow-y-auto scroll-thin py-1.5">
            {/* My workspace (admin's own data) */}
            <li>
              <button
                onClick={() => onPick(null)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2 text-left transition',
                  !selectedId ? 'bg-brand-50/60 dark:bg-brand-500/10' : 'hover:bg-navy-50 dark:hover:bg-navy-800'
                )}
              >
                <span className="w-7 h-7 rounded-md grid place-items-center text-white shrink-0 bg-gradient-to-br from-navy-500 to-navy-700">
                  <LayoutDashboard size={13} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[12.5px] font-semibold text-navy-900 dark:text-white truncate">My workspace</span>
                  <span className="block text-[11px] text-navy-500 truncate">Your own dashboard data</span>
                </span>
                {!selectedId && <Check size={14} className="text-brand-500" />}
              </button>
            </li>

            {clients.length > 0 && (
              <li className="px-3 pt-2 pb-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-navy-400">Clients</span>
              </li>
            )}

            {filtered.map((c) => {
              const selected = String(c.id) === String(selectedId);
              return (
                <li key={c.id}>
                  <button
                    onClick={() => onPick(c.id)}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3 py-2 text-left transition',
                      selected ? 'bg-brand-50/60 dark:bg-brand-500/10' : 'hover:bg-navy-50 dark:hover:bg-navy-800'
                    )}
                  >
                    <span className="w-7 h-7 rounded-md grid place-items-center text-white shrink-0 bg-gradient-to-br from-brand-500 to-cyan-500">
                      <Users size={13} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[12.5px] font-semibold text-navy-900 dark:text-white truncate">
                        {c.company || c.name || `Client #${c.id}`}
                      </span>
                      <span className="block text-[11px] text-navy-500 truncate">
                        {c.name && c.company ? `${c.name} · ` : ''}{c.email || ''}
                      </span>
                    </span>
                    {selected && <Check size={14} className="text-brand-500" />}
                  </button>
                </li>
              );
            })}

            {status === 'loading' && clients.length === 0 && (
              <li className="px-3 py-3 text-[12px] text-navy-500">Loading clients…</li>
            )}
            {status === 'succeeded' && clients.length === 0 && (
              <li className="px-3 py-3 text-[12px] text-navy-500">No clients yet.</li>
            )}
            {clients.length > 0 && filtered.length === 0 && (
              <li className="px-3 py-3 text-[12px] text-navy-500">No clients match.</li>
            )}
          </ul>

          <div className="border-t border-navy-100 dark:border-navy-800 py-1.5">
            <button
              onClick={() => { setOpen(false); navigate('/clients'); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] font-semibold text-brand-600 dark:text-brand-400 hover:bg-navy-50 dark:hover:bg-navy-800 transition"
            >
              <Plus size={14} /> Manage clients
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
