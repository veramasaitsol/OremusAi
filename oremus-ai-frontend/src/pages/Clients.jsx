import { useEffect, useState, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  Search, Plus, RefreshCw, Pencil, Trash2, X,
  Loader2, AlertCircle, CheckCircle2, Unplug,
} from 'lucide-react';
import {
  fetchClients,
  deleteClient,
  selectClient,
  connectClientZoho,
  disconnectClientZoho,
  connectClientQBO,
  disconnectClientQBO,
  connectClientXero,
  disconnectClientXero,
  selectAllClients,
  selectClientsStatus,
  selectClientsError,
  selectClientsMutating,
} from '../features/clients/clientsSlice.js';
import AddClientModal from '../components/modals/AddClientModal.jsx';
import Skeleton from '../components/ui/Skeleton.jsx';
import SyncProgress from '../components/SyncProgress.jsx';
import { cn } from '../utils/classNames.js';

// ── Integration config ────────────────────────────────────────────────────────

const INTEGRATIONS = {
  zoho:       { label: 'Zoho Books', initial: 'Z', color: '#E42527', bg: 'bg-[#E42527]' },
  quickbooks: { label: 'QuickBooks', initial: 'Q', color: '#2CA01C', bg: 'bg-[#2CA01C]' },
  xero:       { label: 'Xero',       initial: 'X', color: '#13B5EA', bg: 'bg-[#13B5EA]' },
  none:       { label: 'None',       initial: '—', color: '#94a3b8', bg: 'bg-navy-400'   },
};

const STATUS_COLORS = {
  Active:    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  Pending:   'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  Suspended: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

// ── Client avatar ─────────────────────────────────────────────────────────────

function ClientAvatar({ name }) {
  const initials = (name || 'C')
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('');
  return (
    <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500 to-cyan-500 text-white text-[13px] font-bold grid place-items-center shrink-0">
      {initials}
    </span>
  );
}

// ── Integration badge ─────────────────────────────────────────────────────────

function IntegrationBadge({ type, connected, clientId, onConnect, onDisconnect, loading }) {
  const cfg = INTEGRATIONS[type] || INTEGRATIONS.none;
  const [confirmDisc, setConfirmDisc] = useState(false);

  if (!type || type === 'none') {
    return <span className="text-[12px] text-navy-400 italic">No integration</span>;
  }

  if (connected) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 size={13} />
          Connected
        </span>
        <button
          onClick={() => {
            if (!confirmDisc) { setConfirmDisc(true); return; }
            setConfirmDisc(false);
            onDisconnect(clientId, type);
          }}
          onBlur={() => setTimeout(() => setConfirmDisc(false), 200)}
          title={`Disconnect ${cfg.label}`}
          className={cn(
            'inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px] font-medium transition border',
            confirmDisc
              ? 'border-red-400 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400'
              : 'border-navy-200 dark:border-navy-700 text-navy-400 hover:border-red-300 hover:text-red-500'
          )}
        >
          <Unplug size={11} />
          {confirmDisc ? 'Confirm?' : 'Disconnect'}
        </button>
      </div>
    );
  }

  // Not connected — show Connect button. Zoho, QuickBooks and Xero are all live.
  const isLive = type === 'zoho' || type === 'quickbooks' || type === 'xero';

  return (
    <button
      onClick={() => isLive ? onConnect(clientId, type) : undefined}
      disabled={loading || !isLive}
      title={isLive ? `Connect ${cfg.label}` : `${cfg.label} integration coming soon`}
      className={cn(
        'inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-semibold transition',
        isLive
          ? 'text-white hover:opacity-90 active:scale-95 disabled:opacity-60'
          : 'bg-navy-100 dark:bg-navy-800 text-navy-400 cursor-not-allowed',
      )}
      style={isLive ? { backgroundColor: cfg.color } : undefined}
    >
      {loading
        ? <Loader2 size={12} className="animate-spin" />
        : (
          <span className="w-4 h-4 rounded text-white text-[10px] font-bold grid place-items-center"
                style={{ backgroundColor: isLive ? 'rgba(255,255,255,0.25)' : undefined }}>
            {cfg.initial}
          </span>
        )
      }
      {isLive ? `Connect ${cfg.label}` : `${cfg.label} — Soon`}
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Clients() {
  const dispatch  = useDispatch();
  const clients   = useSelector(selectAllClients);
  const status    = useSelector(selectClientsStatus);
  const apiError  = useSelector(selectClientsError);
  const mutating  = useSelector(selectClientsMutating);

  const [search,       setSearch]       = useState('');
  const [showAdd,      setShowAdd]      = useState(false);
  const [editTarget,   setEditTarget]   = useState(null);   // client being edited
  const [deleteTarget, setDeleteTarget] = useState(null);   // client id pending delete confirm
  const [connecting,   setConnecting]   = useState(null);   // client id currently connecting

  // Load clients on mount
  useEffect(() => { dispatch(fetchClients()); }, [dispatch]);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => dispatch(fetchClients(search)), 300);
    return () => clearTimeout(t);
  }, [search, dispatch]);

  const handleConnect = useCallback(async (clientId, type) => {
    setConnecting(clientId);
    dispatch(selectClient(clientId));
    if (type === 'quickbooks') {
      await dispatch(connectClientQBO(clientId));
    } else if (type === 'xero') {
      await dispatch(connectClientXero(clientId));
    } else {
      await dispatch(connectClientZoho(clientId));
    }
    setConnecting(null);
  }, [dispatch]);

  const handleDisconnect = useCallback(async (clientId, type) => {
    if (type === 'quickbooks') {
      await dispatch(disconnectClientQBO(clientId));
    } else if (type === 'xero') {
      await dispatch(disconnectClientXero(clientId));
    } else {
      await dispatch(disconnectClientZoho(clientId));
    }
    dispatch(fetchClients(search));
  }, [dispatch, search]);

  const handleDeleteConfirm = useCallback(async (clientId) => {
    await dispatch(deleteClient(clientId));
    setDeleteTarget(null);
  }, [dispatch]);

  const connected = clients.filter((c) => c.zoho_connected || c.qbo_connected || c.xero_connected).length;
  const loading   = status === 'loading';

  return (
    <div className="p-4 lg:p-6 max-w-[1600px] mx-auto">

      {/* ── Page header ── */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-[22px] font-bold text-navy-900 dark:text-white leading-tight">
            Clients
          </h1>
          <p className="text-[13px] text-navy-500 mt-0.5">
            Manage clients &amp; their accounting integrations
          </p>
        </div>
        <button
          onClick={() => { setEditTarget(null); setShowAdd(true); }}
          className={cn(
            'inline-flex items-center gap-1.5 h-9 px-4 rounded-xl text-[13px] font-semibold text-white transition shadow-soft',
            'bg-gradient-to-r from-brand-500 to-cyan-500 hover:from-brand-600 hover:to-cyan-600'
          )}
        >
          <Plus size={14} /> Add client
        </button>
      </div>

      {/* ── Table card ── */}
      <div className="bg-white dark:bg-navy-900 rounded-2xl border border-navy-200 dark:border-navy-800 overflow-hidden">

        {/* ── Toolbar ── */}
        <div className="px-5 py-4 border-b border-navy-100 dark:border-navy-800 flex items-center gap-3">
          <div className="relative flex-1 max-w-[320px]">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-navy-400 pointer-events-none" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search clients…"
              className={cn(
                'w-full h-9 pl-8 pr-3 rounded-lg text-[13px]',
                'bg-navy-50 dark:bg-navy-800',
                'border border-navy-200 dark:border-navy-700',
                'focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-400/20',
                'placeholder:text-navy-400 text-navy-900 dark:text-white'
              )}
            />
          </div>

          <div className="flex items-center gap-2 ml-auto">
            {/* Stats chip */}
            {!loading && (
              <span className="text-[12px] text-navy-500 font-medium">
                {clients.length} client{clients.length !== 1 ? 's' : ''}
                {connected > 0 && ` · ${connected} connected`}
              </span>
            )}
            <button
              onClick={() => dispatch(fetchClients(search))}
              className="h-8 w-8 rounded-lg flex items-center justify-center text-navy-400 hover:bg-navy-100 dark:hover:bg-navy-800 hover:text-navy-600 transition"
              title="Refresh"
            >
              <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
            </button>
          </div>
        </div>

        {/* ── Error banner ── */}
        {apiError && (
          <div className="px-5 py-3 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 flex items-center justify-between gap-3 text-[12.5px] text-red-600 dark:text-red-400">
            <span className="flex items-center gap-2">
              <AlertCircle size={13} />
              We couldn’t load your clients right now. Please try again.
            </span>
            <button
              type="button"
              onClick={() => dispatch(fetchClients(search))}
              className="shrink-0 font-semibold underline underline-offset-2 hover:no-underline"
            >
              Try again
            </button>
          </div>
        )}

        {/* ── Table header ── */}
        <div className="grid grid-cols-[1fr_160px_240px_80px] px-5 py-2.5 border-b border-navy-100 dark:border-navy-800">
          {['CLIENT', 'MOBILE', 'INTEGRATION', ''].map((h) => (
            <span key={h} className="text-[10.5px] font-bold tracking-[0.12em] uppercase text-navy-400">
              {h}
            </span>
          ))}
        </div>

        {/* ── Table body ── */}
        {loading && clients.length === 0 ? (
          <div className="divide-y divide-navy-100 dark:divide-navy-800" role="status" aria-busy="true" aria-label="Loading clients">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="grid grid-cols-[1fr_160px_240px_80px] items-center px-5 py-3.5">
                <div className="flex items-center gap-3 min-w-0">
                  <Skeleton className="w-9 h-9" rounded="rounded-xl" />
                  <div className="min-w-0 space-y-1.5">
                    <Skeleton className="h-3.5 w-36" />
                    <Skeleton className="h-3 w-44" />
                  </div>
                </div>
                <Skeleton className="h-3 w-24" />
                <div className="flex items-center gap-2">
                  <Skeleton className="w-5 h-5" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-3 w-8 ml-auto" />
              </div>
            ))}
            <span className="sr-only">Loading clients…</span>
          </div>
        ) : clients.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-12 h-12 rounded-2xl bg-navy-100 dark:bg-navy-800 grid place-items-center mb-3">
              <Plus size={20} className="text-navy-400" />
            </div>
            <p className="text-[14px] font-semibold text-navy-700 dark:text-navy-300 mb-1">No clients yet</p>
            <p className="text-[12.5px] text-navy-400 mb-4">
              Add your first client to get started.
            </p>
            <button
              onClick={() => setShowAdd(true)}
              className="h-8 px-4 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-[12.5px] font-semibold transition"
            >
              + Add client
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-navy-100 dark:divide-navy-800">
            {clients.map((client) => {
              const cfg = INTEGRATIONS[client.integration_type] || INTEGRATIONS.none;
              return (
                <li
                  key={client.id}
                  className="grid grid-cols-[1fr_160px_240px_80px] items-center px-5 py-3.5 hover:bg-navy-50/50 dark:hover:bg-navy-800/40 transition group"
                >
                  {/* CLIENT */}
                  <div className="flex items-center gap-3 min-w-0">
                    <ClientAvatar name={client.name} />
                    <div className="min-w-0">
                      <p className="text-[13.5px] font-semibold text-navy-900 dark:text-white truncate leading-tight">
                        {client.name}
                      </p>
                      <p className="text-[12px] text-navy-500 truncate leading-tight mt-0.5">
                        {client.email}
                      </p>
                    </div>
                    <span className={cn(
                      'ml-2 text-[10.5px] font-semibold px-2 py-0.5 rounded-full shrink-0',
                      STATUS_COLORS[client.status] || STATUS_COLORS.Active
                    )}>
                      {client.status}
                    </span>
                  </div>

                  {/* MOBILE */}
                  <span className="text-[13px] text-navy-600 dark:text-navy-400 truncate">
                    {client.mobile || '—'}
                  </span>

                  {/* INTEGRATION */}
                  <div className="flex flex-col gap-1.5 min-w-0">
                    <div className="flex items-center gap-2">
                      {client.integration_type && client.integration_type !== 'none' && (
                        <span
                          className={cn('w-5 h-5 rounded-md text-white text-[10px] font-bold grid place-items-center shrink-0', cfg.bg)}
                          title={cfg.label}
                        >
                          {cfg.initial}
                        </span>
                      )}
                      <IntegrationBadge
                        type={client.integration_type}
                        connected={
                          client.integration_type === 'quickbooks' ? client.qbo_connected
                          : client.integration_type === 'xero'      ? client.xero_connected
                          : client.zoho_connected
                        }
                        clientId={client.id}
                        onConnect={handleConnect}
                        onDisconnect={handleDisconnect}
                        loading={connecting === client.id}
                      />
                    </div>
                    {/* Live background-sync tracker: % synced while pending, then ✓ Synced */}
                    {(client.integration_type === 'quickbooks' ? client.qbo_connected
                      : client.integration_type === 'xero' ? client.xero_connected
                      : client.zoho_connected) && <SyncProgress clientId={client.id} />}
                  </div>

                  {/* ACTIONS */}
                  <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition">
                    <button
                      onClick={() => { setEditTarget(client); setShowAdd(true); }}
                      className="h-7 w-7 rounded-lg flex items-center justify-center text-navy-400 hover:bg-navy-100 dark:hover:bg-navy-800 hover:text-brand-600 transition"
                      title="Edit"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={() => setDeleteTarget(client.id === deleteTarget ? null : client.id)}
                      className={cn(
                        'h-7 w-7 rounded-lg flex items-center justify-center transition',
                        deleteTarget === client.id
                          ? 'bg-red-50 dark:bg-red-900/20 text-red-500'
                          : 'text-navy-400 hover:bg-navy-100 dark:hover:bg-navy-800 hover:text-red-500'
                      )}
                      title={deleteTarget === client.id ? 'Click again to delete' : 'Delete'}
                    >
                      {mutating && deleteTarget === client.id
                        ? <Loader2 size={12} className="animate-spin" />
                        : <Trash2 size={12} />
                      }
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ── Delete confirm toast ── */}
      {deleteTarget && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-fadein">
          <div className="flex items-center gap-3 px-4 py-3 bg-red-600 text-white rounded-xl shadow-xl text-[13px] font-medium">
            <AlertCircle size={14} />
            <span>Delete this client? All their data will be lost.</span>
            <button
              onClick={() => handleDeleteConfirm(deleteTarget)}
              className="px-3 py-1 rounded-lg bg-white/20 hover:bg-white/30 transition text-[12px] font-semibold ml-1"
            >
              Confirm
            </button>
            <button
              onClick={() => setDeleteTarget(null)}
              className="p-1 rounded hover:bg-white/20 transition"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      {/* ── Add / Edit modal ── */}
      {showAdd && (
        <AddClientModal
          editClient={editTarget}
          onClose={() => {
            setShowAdd(false);
            setEditTarget(null);
            dispatch(fetchClients(search));
          }}
        />
      )}
    </div>
  );
}
