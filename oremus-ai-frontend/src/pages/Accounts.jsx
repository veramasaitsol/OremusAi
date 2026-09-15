import { useEffect, useMemo, useState, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  Loader2, RefreshCw, Search, Layers, AlertCircle, ExternalLink, ShieldCheck,
} from 'lucide-react';
import axiosClient from '../services/axiosClient.js';
import { selectQBO } from '../features/quickbooks/quickbooksSlice.js';
import { getQBOStartURL } from '../features/quickbooks/quickbooksAPI.js';
import { selectXero } from '../features/xero/xeroSlice.js';
import { getXeroStartURL } from '../features/xero/xeroAPI.js';
import { selectZoho } from '../features/zoho/zohoSlice.js';
import { selectRole } from '../features/auth/authSlice.js';
import { selectViewAsClientId } from '../features/viewAs/viewAsSlice.js';
import {
  fetchClients, selectAllClients, selectClientsStatus,
} from '../features/clients/clientsSlice.js';
import { cn } from '../utils/classNames.js';
import AccountLedgerModal from '../components/reports/AccountLedgerModal.jsx';
import Skeleton from '../components/ui/Skeleton.jsx';

// ── Colour scheme per classification ────────────────────────────────────────
const CLASS_COLORS = {
  Asset:     { bg: 'bg-emerald-50  dark:bg-emerald-900/20', text: 'text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500' },
  Liability: { bg: 'bg-red-50      dark:bg-red-900/20',     text: 'text-red-700     dark:text-red-400',     dot: 'bg-red-500' },
  Equity:    { bg: 'bg-violet-50   dark:bg-violet-900/20',  text: 'text-violet-700  dark:text-violet-400',  dot: 'bg-violet-500' },
  Revenue:   { bg: 'bg-cyan-50     dark:bg-cyan-900/20',    text: 'text-cyan-700    dark:text-cyan-400',    dot: 'bg-cyan-500' },
  Expense:   { bg: 'bg-amber-50    dark:bg-amber-900/20',   text: 'text-amber-700   dark:text-amber-400',   dot: 'bg-amber-500' },
  Uncategorized: { bg: 'bg-navy-50 dark:bg-navy-900/40', text: 'text-navy-600 dark:text-navy-300', dot: 'bg-navy-400' },
};

const CLASS_ORDER = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense', 'Uncategorized'];

function fmtMoney(n, ccy = 'USD') {
  if (n == null || isNaN(Number(n))) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: ccy || 'USD',
      maximumFractionDigits: 2,
    }).format(Number(n));
  } catch {
    return Number(n).toFixed(2);
  }
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return '—'; }
}

// ── Summary tile ────────────────────────────────────────────────────────────
function SummaryTile({ classification, total, count }) {
  const c = CLASS_COLORS[classification] || CLASS_COLORS.Uncategorized;
  return (
    <div className={cn('rounded-xl border border-navy-200 dark:border-navy-800 p-4', c.bg)}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className={cn('w-2 h-2 rounded-full', c.dot)} />
        <span className={cn('text-[11px] font-semibold uppercase tracking-wider', c.text)}>
          {classification}
        </span>
      </div>
      <div className="text-[18px] font-bold text-navy-900 dark:text-white truncate">
        {fmtMoney(total)}
      </div>
      <div className="text-[11px] text-navy-500 mt-0.5">{count} account{count === 1 ? '' : 's'}</div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────
// Map a client row's connection to the Accounts source key.
function clientSource(c) {
  if (!c) return null;
  if (c.integration_type === 'zoho'       || c.zoho_connected) return 'zoho';
  if (c.integration_type === 'quickbooks' || c.qbo_connected)  return 'quickbooks';
  if (c.integration_type === 'xero'       || c.xero_connected) return 'xero';
  return null;
}

export default function Accounts() {
  const dispatch  = useDispatch();
  const qbo       = useSelector(selectQBO);
  const xero      = useSelector(selectXero);
  const zoho      = useSelector(selectZoho);
  const role      = useSelector(selectRole);
  // Admin "view as client": when a client is selected in the header dropdown the
  // backend already scopes reads via X-Client-Id — here we pick the matching
  // provider endpoint from THAT client's connection instead of the admin's own.
  const viewAsId       = useSelector(selectViewAsClientId);
  const clients        = useSelector(selectAllClients);
  const clientsStatus  = useSelector(selectClientsStatus);

  // Ensure the client list is available so we can resolve the viewed client's
  // provider (the header switcher normally loads it; this is a safety net).
  useEffect(() => {
    if (viewAsId && clientsStatus === 'idle') dispatch(fetchClients(''));
  }, [viewAsId, clientsStatus, dispatch]);

  const viewClient = useMemo(
    () => (viewAsId ? clients.find((c) => String(c.id) === String(viewAsId)) || null : null),
    [viewAsId, clients]
  );
  // While viewing a client whose row hasn't loaded yet, hold off on a fetch
  // rather than hitting the wrong provider endpoint.
  const awaitingClient = !!viewAsId && !viewClient;

  // Decide which source to show. Viewing a client → that client's provider.
  // Otherwise the admin's own connection (Zoho first, then QB, then Xero).
  const source       = viewAsId
    ? clientSource(viewClient)
    : zoho.connected
      ? 'zoho'
      : qbo.connected
        ? 'quickbooks'
        : xero.connected
          ? 'xero'
          : null;
  const sourceLabel  = source === 'zoho' ? 'Zoho Books'
                     : source === 'quickbooks' ? 'QuickBooks'
                     : source === 'xero' ? 'Xero'
                     : 'accounting';
  const isConnected  = !!source;
  // Hide admin connect/sync/reconnect controls both for real clients and when an
  // admin is viewing as a client (those would act on the admin's own account).
  const isClient     = role === 'client' || !!viewAsId;
  const apiPath      = source === 'zoho'  ? '/zoho/accounts'
                     : source === 'xero'  ? '/xero/accounts'
                     : '/quickbooks/accounts';
  const syncPath     = source === 'zoho'  ? '/zoho/accounts'
                     : source === 'xero'  ? '/xero/accounts'
                     : '/quickbooks/accounts';
  const startURL     = source === 'xero' ? getXeroStartURL : getQBOStartURL;

  const [accounts, setAccounts]   = useState([]);
  const [totals, setTotals]       = useState({});
  const [status, setStatus]       = useState('idle'); // idle | loading | succeeded | failed
  const [error, setError]         = useState(null);
  const [search, setSearch]       = useState('');
  const [classFilter, setClassFilter] = useState('all');
  const [syncing, setSyncing]     = useState(false);
  const [ledger, setLedger]       = useState(null); // { accountRef, accountName, currency }

  const load = useCallback(async () => {
    // Don't fetch until we know the viewed client's provider — avoids hitting
    // the wrong endpoint on the first render after picking a client.
    if (awaitingClient) return;
    setStatus('loading'); setError(null);
    try {
      const { data } = await axiosClient.get(apiPath);
      setAccounts(data.data || []);
      setTotals(data.totals || {});
      setStatus('succeeded');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setStatus('failed');
    }
  }, [apiPath, awaitingClient]);

  // Always attempt to load whatever has been synced into the DB.
  // The Redux `isConnected` flag races with verifyQBOStatus() on layout mount —
  // if we gate on it here, users see the "Not connected" CTA even when their
  // accounts are already present in the DB.
  useEffect(() => {
    load();
  }, [load]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      await axiosClient.post(syncPath);
      setTimeout(() => load(), 1500);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setTimeout(() => setSyncing(false), 1500);
    }
  }, [load, syncPath]);

  // ── Derived: filtered list ──
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return accounts.filter((a) => {
      if (classFilter !== 'all' && (a.classification || 'Uncategorized') !== classFilter) return false;
      if (!q) return true;
      return (
        (a.name || '').toLowerCase().includes(q) ||
        (a.fully_qualified_name || '').toLowerCase().includes(q) ||
        (a.account_number || '').toLowerCase().includes(q) ||
        (a.account_type || '').toLowerCase().includes(q)
      );
    });
  }, [accounts, search, classFilter]);

  const classifications = useMemo(() => {
    const present = new Set(accounts.map((a) => a.classification || 'Uncategorized'));
    return CLASS_ORDER.filter((c) => present.has(c));
  }, [accounts]);

  const lastSyncedAt = accounts[0]?.synced_at;

  // ── Not connected AND no synced data yet: show CTA ──
  // (If we have data from a previous sync we still render it below, even if
  //  the live OAuth token has lapsed — re-sync just needs a reconnection.)
  if (!isConnected && status === 'succeeded' && accounts.length === 0) {
    return (
      <div className="p-6 lg:p-8 max-w-[1000px] mx-auto">
        <div className="bg-white dark:bg-navy-900 rounded-2xl border border-navy-200 dark:border-navy-800 p-12 text-center">
          <div className="w-16 h-16 rounded-2xl mx-auto grid place-items-center mb-4"
               style={{ backgroundColor: '#2CA01C' }}>
            <Layers size={28} className="text-white" />
          </div>
          <h2 className="text-[18px] font-bold text-navy-900 dark:text-white mb-1">
            Chart of Accounts
          </h2>

          {isClient ? (
            <>
              <p className="text-[13px] text-navy-500 mb-6 max-w-md mx-auto leading-relaxed">
                Your accounting integration hasn't been linked yet. Your admin can
                connect QuickBooks or Xero on your behalf from the Clients page —
                once connected, your full Chart of Accounts will appear here.
              </p>
              <div className="inline-flex items-center gap-2 text-[12px] text-amber-600 dark:text-amber-400">
                <ShieldCheck size={14} />
                <span>Managed by your admin</span>
              </div>
            </>
          ) : (
            <>
              <p className="text-[13px] text-navy-500 mb-6 max-w-md mx-auto leading-relaxed">
                Connect QuickBooks Online or Xero to import and view your full
                Chart of Accounts here, with live balances and classifications.
              </p>
              <div className="flex gap-2 justify-center">
                <button
                  onClick={() => { const u = getQBOStartURL(); if (u) window.location.href = u; }}
                  className="inline-flex items-center gap-1.5 h-10 px-5 rounded-lg text-white text-[13px] font-semibold transition hover:opacity-90"
                  style={{ backgroundColor: '#2CA01C' }}
                >
                  <ExternalLink size={14} /> Connect QuickBooks
                </button>
                <button
                  onClick={() => { const u = getXeroStartURL(); if (u) window.location.href = u; }}
                  className="inline-flex items-center gap-1.5 h-10 px-5 rounded-lg text-white text-[13px] font-semibold transition hover:opacity-90"
                  style={{ backgroundColor: '#13B5EA' }}
                >
                  <ExternalLink size={14} /> Connect Xero
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-[1200px] mx-auto">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-[22px] font-bold text-navy-900 dark:text-white leading-tight">
            Chart of Accounts
          </h1>
          <p className="text-[13px] text-navy-500 mt-0.5">
            {accounts.length} accounts synced from {sourceLabel}
            {lastSyncedAt && <> · last synced {fmtDate(lastSyncedAt)}</>}
          </p>
        </div>
        {!isClient && (
          <button
            onClick={handleSync}
            disabled={syncing || status === 'loading' || !isConnected}
            title={!isConnected ? `Reconnect ${sourceLabel} to re-sync` : ''}
            className={cn(
              'inline-flex items-center gap-1.5 h-9 px-4 rounded-xl text-[13px] font-semibold text-white transition shadow-soft',
              'bg-gradient-to-r from-brand-500 to-cyan-500 hover:from-brand-600 hover:to-cyan-600 disabled:opacity-60'
            )}
          >
            {syncing
              ? <><Loader2 size={14} className="animate-spin" /> Syncing…</>
              : <><RefreshCw size={14} /> Re-sync from {sourceLabel}</>
            }
          </button>
        )}
      </div>

      {/* ── Reconnect banner if data is stale (token lapsed) ── */}
      {!isConnected && accounts.length > 0 && (
        <div className="mb-4 px-4 py-3 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 text-[12.5px] flex items-center gap-2.5">
          <AlertCircle size={15} className="shrink-0" />
          <span className="flex-1">
            Showing previously-synced data. The {sourceLabel} session has ended — {isClient ? 'your admin needs to reconnect' : 'reconnect to fetch fresh balances'}.
          </span>
          {!isClient && (
            <button
              onClick={() => { const u = startURL(); if (u) window.location.href = u; }}
              className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11.5px] font-semibold text-white transition hover:opacity-90"
              style={{ backgroundColor: source === 'xero' ? '#13B5EA' : '#2CA01C' }}
            >
              <ExternalLink size={11} /> Reconnect
            </button>
          )}
        </div>
      )}

      {/* ── Summary tiles ── */}
      {Object.keys(totals).length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          {classifications.map((c) => (
            <SummaryTile
              key={c}
              classification={c}
              total={totals[c] ?? 0}
              count={accounts.filter((a) => (a.classification || 'Uncategorized') === c).length}
            />
          ))}
        </div>
      )}

      {/* ── Filter row ── */}
      <div className="bg-white dark:bg-navy-900 rounded-2xl border border-navy-200 dark:border-navy-800 overflow-hidden">
        <div className="px-6 py-4 border-b border-navy-100 dark:border-navy-800 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-navy-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, number, or type…"
              className="w-full h-9 pl-9 pr-3 rounded-lg text-[13px] bg-navy-50 dark:bg-navy-800 border border-navy-200 dark:border-navy-700 focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-400/20"
            />
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => setClassFilter('all')}
              className={cn(
                'h-8 px-3 rounded-lg text-[12px] font-medium transition border',
                classFilter === 'all'
                  ? 'border-brand-400 bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-400'
                  : 'border-navy-200 dark:border-navy-700 text-navy-500 hover:bg-navy-50 dark:hover:bg-navy-800'
              )}
            >
              All ({accounts.length})
            </button>
            {classifications.map((c) => {
              const cc = CLASS_COLORS[c] || CLASS_COLORS.Uncategorized;
              const isActive = classFilter === c;
              const count = accounts.filter((a) => (a.classification || 'Uncategorized') === c).length;
              return (
                <button
                  key={c}
                  onClick={() => setClassFilter(c)}
                  className={cn(
                    'h-8 px-3 rounded-lg text-[12px] font-medium transition border inline-flex items-center gap-1.5',
                    isActive
                      ? `border-current ${cc.text} ${cc.bg}`
                      : 'border-navy-200 dark:border-navy-700 text-navy-500 hover:bg-navy-50 dark:hover:bg-navy-800'
                  )}
                >
                  <span className={cn('w-1.5 h-1.5 rounded-full', cc.dot)} />
                  {c} ({count})
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Loading / error / empty / list ── */}
        {status === 'loading' && (
          <div className="overflow-x-auto" role="status" aria-busy="true" aria-label="Loading accounts">
            <table className="w-full text-[13px]">
              <thead className="bg-navy-50 dark:bg-navy-900/60 text-navy-500 text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="text-left  px-6 py-3 font-semibold">Account</th>
                  <th className="text-left  px-4 py-3 font-semibold">Type / Sub-type</th>
                  <th className="text-left  px-4 py-3 font-semibold">Classification</th>
                  <th className="text-left  px-4 py-3 font-semibold">Number</th>
                  <th className="text-right px-4 py-3 font-semibold">Balance</th>
                  <th className="text-right px-6 py-3 font-semibold">With sub-accts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-100 dark:divide-navy-800">
                {Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    <td className="px-6 py-3"><Skeleton className="h-3.5 w-40" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-3 w-32" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-3 w-24" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-3 w-16" /></td>
                    <td className="px-4 py-3"><Skeleton className="h-3 w-20 ml-auto" /></td>
                    <td className="px-6 py-3"><Skeleton className="h-3 w-10 ml-auto" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <span className="sr-only">Loading accounts…</span>
          </div>
        )}

        {status === 'failed' && (
          <div className="px-6 py-12 flex items-center justify-center gap-2 text-red-500 dark:text-red-400 text-[13px]">
            <AlertCircle size={16} /> {error || 'Failed to load accounts'}
          </div>
        )}

        {status === 'succeeded' && filtered.length === 0 && (
          <div className="px-6 py-16 flex flex-col items-center justify-center text-center text-navy-400">
            <Layers size={32} className="mb-2 opacity-50" />
            <p className="text-[13px] font-medium">No accounts match your filters</p>
            {accounts.length === 0 && (
              <p className="text-[12px] mt-1 max-w-sm">
                If you just connected QuickBooks, the sync is running in the background.
                Click "Re-sync" or refresh in a few seconds.
              </p>
            )}
          </div>
        )}

        {status === 'succeeded' && filtered.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-navy-50 dark:bg-navy-900/60 text-navy-500 text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="text-left  px-6 py-3 font-semibold">Account</th>
                  <th className="text-left  px-4 py-3 font-semibold">Type / Sub-type</th>
                  <th className="text-left  px-4 py-3 font-semibold">Classification</th>
                  <th className="text-left  px-4 py-3 font-semibold">Number</th>
                  <th className="text-right px-4 py-3 font-semibold">Balance</th>
                  <th className="text-right px-6 py-3 font-semibold">With sub-accts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-100 dark:divide-navy-800">
                {filtered.map((a) => {
                  const cc = CLASS_COLORS[a.classification || 'Uncategorized'] || CLASS_COLORS.Uncategorized;
                  // QuickBooks accounts drill into their posted ledger.
                  const drillable = source === 'quickbooks' && !!a.qbo_id;
                  return (
                    <tr
                      key={a.qbo_id}
                      onClick={drillable
                        ? () => setLedger({ accountRef: String(a.qbo_id), accountName: a.fully_qualified_name || a.name, currency: a.currency })
                        : undefined}
                      className={cn(
                        'group hover:bg-navy-50/60 dark:hover:bg-navy-800/40 transition',
                        drillable && 'cursor-pointer',
                        !a.active && 'opacity-50'
                      )}
                    >
                      <td className="px-6 py-3">
                        <div className="font-medium text-navy-900 dark:text-white">
                          {a.is_sub_account ? <span className="text-navy-400 mr-1">└</span> : null}
                          {a.name || '(unnamed)'}
                        </div>
                        {a.fully_qualified_name && a.fully_qualified_name !== a.name && (
                          <div className="text-[11px] text-navy-400 truncate max-w-[280px]">
                            {a.fully_qualified_name}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-navy-700 dark:text-navy-300">
                        <div>{a.account_type || '—'}</div>
                        {a.account_sub_type && (
                          <div className="text-[11px] text-navy-400">{a.account_sub_type}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn(
                          'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold',
                          cc.bg, cc.text
                        )}>
                          <span className={cn('w-1.5 h-1.5 rounded-full', cc.dot)} />
                          {a.classification || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-navy-500 font-mono text-[12px]">
                        {a.account_number || '—'}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-navy-700 dark:text-navy-300">
                        {fmtMoney(a.current_balance, a.currency)}
                      </td>
                      <td className="px-6 py-3 text-right tabular-nums font-semibold text-navy-900 dark:text-white">
                        {fmtMoney(a.current_balance_with_sub_accounts, a.currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <AccountLedgerModal
        open={!!ledger}
        onClose={() => setLedger(null)}
        accountRef={ledger?.accountRef}
        accountName={ledger?.accountName}
        currency={ledger?.currency}
      />
    </div>
  );
}
