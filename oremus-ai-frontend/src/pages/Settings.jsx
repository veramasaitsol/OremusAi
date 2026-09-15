import { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  User, Lock, Puzzle, ChevronRight, CalendarDays,
  CheckCircle2, Loader2, Unplug, ExternalLink, RefreshCw, ShieldCheck, Database,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth.js';
import {
  loadReportSettings, saveReportSettings, selectReportSettings,
} from '../features/settings/settingsSlice.js';
import {
  selectZoho,
  disconnectZoho,
  clearZohoError,
} from '../features/zoho/zohoSlice.js';
import { getZohoStartURL, getZohoReauthorizeURL } from '../features/zoho/zohoAPI.js';
import {
  selectQBO,
  disconnectQBORemote,
  clearQBOError,
} from '../features/quickbooks/quickbooksSlice.js';
import { getQBOStartURL, getQBOReauthorizeURL } from '../features/quickbooks/quickbooksAPI.js';
import {
  selectXero,
  disconnectXeroRemote,
  clearXeroError,
} from '../features/xero/xeroSlice.js';
import { getXeroStartURL, getXeroReauthorizeURL } from '../features/xero/xeroAPI.js';
import axiosClient from '../services/axiosClient.js';

// ── Section wrapper ──────────────────────────────────────────────────────────
function Section({ icon: Icon, title, subtitle, children }) {
  return (
    <section className="bg-white dark:bg-navy-900 rounded-2xl border border-navy-200 dark:border-navy-800 overflow-hidden">
      <div className="px-6 py-5 border-b border-navy-100 dark:border-navy-800 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-brand-50 dark:bg-brand-900/30 grid place-items-center text-brand-600 dark:text-brand-400">
          <Icon size={17} />
        </div>
        <div>
          <h3 className="text-[14px] font-semibold text-navy-900 dark:text-white leading-tight">
            {title}
          </h3>
          {subtitle && (
            <p className="text-[12px] text-navy-500 leading-tight mt-0.5">{subtitle}</p>
          )}
        </div>
      </div>
      <div className="divide-y divide-navy-100 dark:divide-navy-800">{children}</div>
    </section>
  );
}

// ── Financial Year ─────────────────────────────────────────────────────────
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const PLATFORM_LABEL = { zoho: 'Zoho', quickbooks: 'QuickBooks', xero: 'Xero' };

function FyPlatformRow({ platform, scope, row, effective, onSave, saving }) {
  const eff = effective || { fyStartMonth: 4 };
  const initial = () => (row?.fyStartMonth != null ? String(row.fyStartMonth) : (scope === 'own' ? '' : String(eff.fyStartMonth)));
  const [month, setMonth] = useState(initial);

  useEffect(() => { setMonth(initial()); }, [row?.fyStartMonth, scope, eff.fyStartMonth]);

  const dirty = String(month) !== initial();

  return (
    <div className="px-6 py-4 flex flex-wrap items-center gap-3">
      <span className="text-[13px] font-medium text-navy-800 dark:text-navy-200 w-24 shrink-0">
        {PLATFORM_LABEL[platform] || platform}
      </span>

      <label className="flex items-center gap-2 text-[12px] text-navy-500">
        Financial year starts
        <select
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="h-9 px-2 rounded-md border border-navy-200 dark:border-navy-700 bg-white dark:bg-navy-950 text-[13px] text-navy-800 dark:text-navy-100"
        >
          {scope === 'own' && (
            <option value="">Workspace default ({MONTH_NAMES[eff.fyStartMonth - 1]})</option>
          )}
          {MONTH_NAMES.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}
        </select>
      </label>

      <button
        type="button"
        disabled={!dirty || saving}
        onClick={() => onSave({ scope, platform, fyStartMonth: month === '' ? null : Number(month) })}
        className="ml-auto inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-white text-[12.5px] font-semibold bg-brand-600 hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
      >
        {saving ? <Loader2 size={13} className="animate-spin" /> : null} Save
      </button>
    </div>
  );
}

function FinancialYearSection() {
  const dispatch = useDispatch();
  const s = useSelector(selectReportSettings);

  useEffect(() => { dispatch(loadReportSettings()); }, [dispatch]);

  const onSave = (payload) => dispatch(saveReportSettings(payload));

  const rows = s.canEditAdmin
    ? ['zoho', 'quickbooks', 'xero'].map((p) => ({ platform: p, scope: 'admin', row: s.admin?.[p] }))
    : (s.myPlatforms || []).map((p) => ({ platform: p, scope: 'own', row: s.own?.[p] }));

  return (
    <Section
      icon={CalendarDays}
      title="Financial Year"
      subtitle={s.canEditAdmin
        ? 'Start month per platform — every client inherits these defaults'
        : 'Override the workspace default for your account only'}
    >
      {s.status === 'loading' && rows.length === 0 ? (
        <div className="px-6 py-5 text-[13px] text-navy-500 flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="px-6 py-5 text-[13px] text-navy-500">
          No accounting integration linked yet.
        </div>
      ) : (
        rows.map(({ platform, scope, row }) => (
          <FyPlatformRow
            key={platform}
            platform={platform}
            scope={scope}
            row={row}
            effective={s.effective?.[platform]}
            onSave={onSave}
            saving={s.saving}
          />
        ))
      )}
      {s.error && (
        <div className="px-6 py-3 text-[12px] text-rose-600 dark:text-rose-400">{s.error}</div>
      )}
    </Section>
  );
}

// ── Static field row ─────────────────────────────────────────────────────────
function FieldRow({ label, value }) {
  return (
    <div className="px-6 py-4 flex items-center justify-between gap-4">
      <span className="text-[13px] text-navy-500 shrink-0 w-36">{label}</span>
      <span className="text-[13px] font-medium text-navy-900 dark:text-white truncate">
        {value}
      </span>
    </div>
  );
}

// ── Zoho Books connect card ──────────────────────────────────────────────────
function ZohoConnectCard() {
  const dispatch  = useDispatch();
  const { role }  = useAuth();
  const zoho      = useSelector(selectZoho);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const isClient    = role === 'client';
  const isConnected = zoho.connected;
  const isLoading   = zoho.status === 'loading';
  const isFailed    = zoho.status === 'failed';
  const [syncingWarehouse, setSyncingWarehouse] = useState(false);
  const [warehouseMsg, setWarehouseMsg] = useState('');

  function handleConnect() {
    dispatch(clearZohoError());
    const url = getZohoStartURL();
    if (url) window.location.href = url;
  }

  function handleReauthorize() {
    dispatch(clearZohoError());
    const url = getZohoReauthorizeURL();
    if (url) window.location.href = url;
  }

  async function handleDisconnect() {
    if (!confirmDisconnect) { setConfirmDisconnect(true); return; }
    try { await axiosClient.post('/auth/zoho/disconnect'); } catch {}
    dispatch(disconnectZoho());
    setConfirmDisconnect(false);
  }

  async function handleWarehouseSync() {
    setSyncingWarehouse(true);
    setWarehouseMsg('');
    try {
      await axiosClient.post('/sync/all');
      setWarehouseMsg('Sync started in background');
    } catch (e) {
      setWarehouseMsg(e.response?.data?.error || 'Sync failed');
    } finally {
      setTimeout(() => { setSyncingWarehouse(false); setWarehouseMsg(''); }, 4000);
    }
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  return (
    <div className="px-6 py-5">
      <div className="flex items-start gap-4">

        {/* Zoho brand icon */}
        <div className="shrink-0 w-12 h-12 rounded-xl border border-navy-200 dark:border-navy-700 bg-white dark:bg-navy-800 grid place-items-center overflow-hidden">
          <svg viewBox="0 0 40 40" width="28" height="28" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="40" height="40" rx="8" fill="#E42527"/>
            <path d="M8 27.5L18.5 13H8V10.5H23L12.5 25H23V27.5H8Z" fill="white"/>
            <path d="M27.5 10C30.5 10 33 12.5 33 16.25C33 20 30.5 22.5 27.5 22.5C24.5 22.5 22 20 22 16.25C22 12.5 24.5 10 27.5 10ZM27.5 12.5C25.8 12.5 24.5 14.2 24.5 16.25C24.5 18.3 25.8 20 27.5 20C29.2 20 30.5 18.3 30.5 16.25C30.5 14.2 29.2 12.5 27.5 12.5Z" fill="white"/>
          </svg>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[14px] font-semibold text-navy-900 dark:text-white">
              Zoho Books
            </span>
            {isConnected && (
              <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 size={10} />
                Connected
              </span>
            )}
          </div>

          {/* ── CLIENT view: read-only, no action buttons ── */}
          {isClient ? (
            <div>
              <p className="text-[12.5px] text-navy-500 leading-relaxed">
                Your accounting data is synced automatically from Zoho Books.
                Integration is managed by your admin.
              </p>
              {isConnected ? (
                <div className="mt-3 flex items-center gap-2 text-[12px] text-emerald-600 dark:text-emerald-400">
                  <ShieldCheck size={14} />
                  <span>Your account is connected and syncing live data.</span>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2 text-[12px] text-amber-600 dark:text-amber-400">
                  <ShieldCheck size={14} />
                  <span>Not connected yet — contact your admin to link your Zoho Books account.</span>
                </div>
              )}
            </div>
          ) : (
            /* ── ADMIN view: full connect / disconnect controls ── */
            <div>
              <p className="text-[12.5px] text-navy-500 leading-relaxed">
                Sync invoices, expenses, contacts and reports directly from your
                Zoho Books organisation.
              </p>

              {/* Connected meta */}
              {isConnected && (
                <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[11.5px]">
                  <span className="text-navy-400">Organisation ID</span>
                  <span className="text-navy-700 dark:text-navy-300 font-mono">{zoho.orgId}</span>
                  <span className="text-navy-400">Connected on</span>
                  <span className="text-navy-700 dark:text-navy-300">{fmtDate(zoho.connectedAt)}</span>
                  <span className="text-navy-400">Token expires</span>
                  <span className="text-navy-700 dark:text-navy-300">
                    {zoho.expiresAt ? fmtDate(new Date(zoho.expiresAt).toISOString()) : '—'}
                  </span>
                </div>
              )}

              {/* Error banner */}
              {isFailed && zoho.error && (
                <p className="mt-2 text-[12px] text-red-500 dark:text-red-400">
                  ⚠ {zoho.error}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Action buttons — admin only */}
        {!isClient && (
          <div className="shrink-0 flex flex-col items-end gap-2">
            {!isConnected && (
              <>
                <button
                  onClick={handleConnect}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-[12.5px] font-semibold transition"
                >
                  {isLoading
                    ? <><Loader2 size={13} className="animate-spin" /> Connecting…</>
                    : <><ExternalLink size={13} /> Connect</>
                  }
                </button>
                <button
                  onClick={handleReauthorize}
                  className="text-[11.5px] text-navy-400 hover:text-brand-600 dark:hover:text-brand-400 transition underline-offset-2 hover:underline"
                >
                  Use a different Zoho account →
                </button>
              </>
            )}

            {isConnected && (
              <>
                <button
                  onClick={handleReauthorize}
                  title="Signs out of Zoho first, forces fresh login screen"
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-navy-200 dark:border-navy-700 hover:bg-navy-50 dark:hover:bg-navy-800 text-navy-600 dark:text-navy-300 text-[12px] font-medium transition"
                >
                  <RefreshCw size={13} /> Re-authorize
                </button>
                <button
                  onClick={handleWarehouseSync}
                  disabled={syncingWarehouse}
                  title="Pull every Zoho Books module into the data warehouse"
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-navy-200 dark:border-navy-700 hover:bg-navy-50 dark:hover:bg-navy-800 text-navy-600 dark:text-navy-300 text-[12px] font-medium transition disabled:opacity-60"
                >
                  {syncingWarehouse
                    ? <><Loader2 size={13} className="animate-spin" /> Re-syncing…</>
                    : <><Database size={13} /> Re-sync Warehouse</>
                  }
                </button>
                <button
                  onClick={handleDisconnect}
                  className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[12px] font-medium transition border ${
                    confirmDisconnect
                      ? 'border-red-400 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100'
                      : 'border-navy-200 dark:border-navy-700 hover:bg-navy-50 dark:hover:bg-navy-800 text-navy-500 dark:text-navy-400'
                  }`}
                >
                  <Unplug size={13} />
                  {confirmDisconnect ? 'Click again to confirm' : 'Disconnect'}
                </button>
                {warehouseMsg && (
                  <span className="text-[11px] text-emerald-600 dark:text-emerald-400">{warehouseMsg}</span>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── QuickBooks Online connect card ──────────────────────────────────────────
function QBOConnectCard() {
  const dispatch = useDispatch();
  const { role } = useAuth();
  const qbo      = useSelector(selectQBO);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const isClient    = role === 'client';
  const isConnected = qbo.connected;
  const isLoading   = qbo.status === 'loading';
  const isFailed    = qbo.status === 'failed';

  function handleConnect() {
    dispatch(clearQBOError());
    const url = getQBOStartURL();
    if (url) window.location.href = url;
  }

  function handleReauthorize() {
    dispatch(clearQBOError());
    const url = getQBOReauthorizeURL();
    if (url) window.location.href = url;
  }

  async function handleDisconnect() {
    if (!confirmDisconnect) { setConfirmDisconnect(true); return; }
    try { await dispatch(disconnectQBORemote()); } catch {}
    setConfirmDisconnect(false);
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  return (
    <div className="px-6 py-5">
      <div className="flex items-start gap-4">

        {/* QuickBooks brand icon */}
        <div className="shrink-0 w-12 h-12 rounded-xl border border-navy-200 dark:border-navy-700 bg-white dark:bg-navy-800 grid place-items-center overflow-hidden">
          <svg viewBox="0 0 40 40" width="28" height="28" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="40" height="40" rx="8" fill="#2CA01C"/>
            <text x="20" y="27" textAnchor="middle" fontSize="20" fontWeight="700" fontFamily="Arial, sans-serif" fill="white">qb</text>
          </svg>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[14px] font-semibold text-navy-900 dark:text-white">
              QuickBooks Online
            </span>
            {qbo.environment && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-navy-100 dark:bg-navy-800 text-navy-500 uppercase tracking-wider">
                {qbo.environment}
              </span>
            )}
            {isConnected && (
              <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 size={10} />
                Connected
              </span>
            )}
          </div>

          {/* ── CLIENT view ── */}
          {isClient ? (
            <div>
              <p className="text-[12.5px] text-navy-500 leading-relaxed">
                Your accounting data is synced automatically from QuickBooks Online.
                Integration is managed by your admin.
              </p>
              {isConnected ? (
                <div className="mt-3 flex items-center gap-2 text-[12px] text-emerald-600 dark:text-emerald-400">
                  <ShieldCheck size={14} />
                  <span>Your QuickBooks account is connected and syncing.</span>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2 text-[12px] text-amber-600 dark:text-amber-400">
                  <ShieldCheck size={14} />
                  <span>Not connected yet — contact your admin to link QuickBooks.</span>
                </div>
              )}
            </div>
          ) : (
            /* ── ADMIN view ── */
            <div>
              <p className="text-[12.5px] text-navy-500 leading-relaxed">
                Sync customers, vendors, invoices, bills and journal entries directly
                from your QuickBooks Online company.
              </p>

              {isConnected && (
                <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[11.5px]">
                  <span className="text-navy-400">Realm (Company) ID</span>
                  <span className="text-navy-700 dark:text-navy-300 font-mono">{qbo.realmId}</span>
                  <span className="text-navy-400">Environment</span>
                  <span className="text-navy-700 dark:text-navy-300 capitalize">{qbo.environment}</span>
                  <span className="text-navy-400">Connected on</span>
                  <span className="text-navy-700 dark:text-navy-300">{fmtDate(qbo.connectedAt)}</span>
                  <span className="text-navy-400">Token expires</span>
                  <span className="text-navy-700 dark:text-navy-300">
                    {qbo.expiresAt ? fmtDate(new Date(qbo.expiresAt).toISOString()) : '—'}
                  </span>
                </div>
              )}

              {isFailed && qbo.error && (
                <p className="mt-2 text-[12px] text-red-500 dark:text-red-400">
                  ⚠ {qbo.error}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Action buttons — admin only */}
        {!isClient && (
          <div className="shrink-0 flex flex-col items-end gap-2">
            {!isConnected && (
              <>
                <button
                  onClick={handleConnect}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-white text-[12.5px] font-semibold transition hover:opacity-90 disabled:opacity-60"
                  style={{ backgroundColor: '#2CA01C' }}
                >
                  {isLoading
                    ? <><Loader2 size={13} className="animate-spin" /> Connecting…</>
                    : <><ExternalLink size={13} /> Connect</>
                  }
                </button>
                <button
                  onClick={handleReauthorize}
                  className="text-[11.5px] text-navy-400 hover:text-brand-600 dark:hover:text-brand-400 transition underline-offset-2 hover:underline"
                >
                  Use a different QuickBooks company →
                </button>
              </>
            )}

            {isConnected && (
              <>
                <button
                  onClick={handleReauthorize}
                  title="Re-run the consent flow"
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-navy-200 dark:border-navy-700 hover:bg-navy-50 dark:hover:bg-navy-800 text-navy-600 dark:text-navy-300 text-[12px] font-medium transition"
                >
                  <RefreshCw size={13} /> Re-authorize
                </button>
                <button
                  onClick={handleDisconnect}
                  className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[12px] font-medium transition border ${
                    confirmDisconnect
                      ? 'border-red-400 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100'
                      : 'border-navy-200 dark:border-navy-700 hover:bg-navy-50 dark:hover:bg-navy-800 text-navy-500 dark:text-navy-400'
                  }`}
                >
                  <Unplug size={13} />
                  {confirmDisconnect ? 'Click again to confirm' : 'Disconnect'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Xero connect card ───────────────────────────────────────────────────────
function XeroConnectCard() {
  const dispatch = useDispatch();
  const { role } = useAuth();
  const xero     = useSelector(selectXero);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const isClient    = role === 'client';
  const isConnected = xero.connected;
  const isLoading   = xero.status === 'loading';
  const isFailed    = xero.status === 'failed';

  function handleConnect() {
    dispatch(clearXeroError());
    const url = getXeroStartURL();
    if (url) window.location.href = url;
  }
  function handleReauthorize() {
    dispatch(clearXeroError());
    const url = getXeroReauthorizeURL();
    if (url) window.location.href = url;
  }
  async function handleDisconnect() {
    if (!confirmDisconnect) { setConfirmDisconnect(true); return; }
    try { await dispatch(disconnectXeroRemote()); } catch {}
    setConfirmDisconnect(false);
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  return (
    <div className="px-6 py-5">
      <div className="flex items-start gap-4">

        {/* Xero brand icon */}
        <div className="shrink-0 w-12 h-12 rounded-xl border border-navy-200 dark:border-navy-700 bg-white dark:bg-navy-800 grid place-items-center overflow-hidden">
          <svg viewBox="0 0 40 40" width="28" height="28" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="40" height="40" rx="8" fill="#13B5EA"/>
            <text x="20" y="27" textAnchor="middle" fontSize="20" fontWeight="700" fontFamily="Arial, sans-serif" fill="white">X</text>
          </svg>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[14px] font-semibold text-navy-900 dark:text-white">Xero</span>
            {isConnected && (
              <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 size={10} />
                Connected
              </span>
            )}
          </div>

          {isClient ? (
            <div>
              <p className="text-[12.5px] text-navy-500 leading-relaxed">
                Your accounting data is synced automatically from Xero.
                Integration is managed by your admin.
              </p>
              {isConnected ? (
                <div className="mt-3 flex items-center gap-2 text-[12px] text-emerald-600 dark:text-emerald-400">
                  <ShieldCheck size={14} />
                  <span>Your Xero account is connected and syncing.</span>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2 text-[12px] text-amber-600 dark:text-amber-400">
                  <ShieldCheck size={14} />
                  <span>Not connected yet — contact your admin to link Xero.</span>
                </div>
              )}
            </div>
          ) : (
            <div>
              <p className="text-[12.5px] text-navy-500 leading-relaxed">
                Sync customers, vendors, invoices, bills and manual journals from
                your Xero organisation.
              </p>

              {isConnected && (
                <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-[11.5px]">
                  <span className="text-navy-400">Organisation</span>
                  <span className="text-navy-700 dark:text-navy-300">{xero.tenantName || '—'}</span>
                  <span className="text-navy-400">Tenant ID</span>
                  <span className="text-navy-700 dark:text-navy-300 font-mono break-all">{xero.tenantId}</span>
                  <span className="text-navy-400">Connected on</span>
                  <span className="text-navy-700 dark:text-navy-300">{fmtDate(xero.connectedAt)}</span>
                  <span className="text-navy-400">Token expires</span>
                  <span className="text-navy-700 dark:text-navy-300">
                    {xero.expiresAt ? fmtDate(new Date(xero.expiresAt).toISOString()) : '—'}
                  </span>
                </div>
              )}

              {isFailed && xero.error && (
                <p className="mt-2 text-[12px] text-red-500 dark:text-red-400">⚠ {xero.error}</p>
              )}
            </div>
          )}
        </div>

        {!isClient && (
          <div className="shrink-0 flex flex-col items-end gap-2">
            {!isConnected && (
              <>
                <button
                  onClick={handleConnect}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-white text-[12.5px] font-semibold transition hover:opacity-90 disabled:opacity-60"
                  style={{ backgroundColor: '#13B5EA' }}
                >
                  {isLoading
                    ? <><Loader2 size={13} className="animate-spin" /> Connecting…</>
                    : <><ExternalLink size={13} /> Connect</>
                  }
                </button>
                <button
                  onClick={handleReauthorize}
                  className="text-[11.5px] text-navy-400 hover:text-brand-600 dark:hover:text-brand-400 transition underline-offset-2 hover:underline"
                >
                  Use a different Xero organisation →
                </button>
              </>
            )}

            {isConnected && (
              <>
                <button
                  onClick={handleReauthorize}
                  title="Re-run the consent flow"
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-navy-200 dark:border-navy-700 hover:bg-navy-50 dark:hover:bg-navy-800 text-navy-600 dark:text-navy-300 text-[12px] font-medium transition"
                >
                  <RefreshCw size={13} /> Re-authorize
                </button>
                <button
                  onClick={handleDisconnect}
                  className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[12px] font-medium transition border ${
                    confirmDisconnect
                      ? 'border-red-400 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100'
                      : 'border-navy-200 dark:border-navy-700 hover:bg-navy-50 dark:hover:bg-navy-800 text-navy-500 dark:text-navy-400'
                  }`}
                >
                  <Unplug size={13} />
                  {confirmDisconnect ? 'Click again to confirm' : 'Disconnect'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Placeholder integration row ──────────────────────────────────────────────
function ComingSoonRow({ name, description }) {
  return (
    <div className="px-6 py-4 flex items-center gap-4 opacity-50">
      <div className="w-9 h-9 rounded-lg border border-navy-200 dark:border-navy-700 bg-navy-50 dark:bg-navy-800 grid place-items-center text-navy-400 text-[10px] font-bold uppercase tracking-wider shrink-0">
        {name.slice(0, 2)}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-navy-700 dark:text-navy-300">{name}</p>
        <p className="text-[11.5px] text-navy-400">{description}</p>
      </div>
      <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full bg-navy-100 dark:bg-navy-800 text-navy-400 shrink-0">
        Coming soon
      </span>
    </div>
  );
}

// ── Client data-sync card (client role only) ─────────────────────────────────
const SYNC_ENDPOINTS = {
  zoho:       '/sync/all',
  quickbooks: '/sync/qbo/all',
  xero:       '/sync/xero/all',
};
const PROVIDER_LABELS = {
  zoho:       'Zoho Books',
  quickbooks: 'QuickBooks',
  xero:       'Xero',
};

// One sync row per connected provider — each syncs independently.
function ProviderSyncRow({ provider }) {
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg]         = useState('');

  const endpoint = SYNC_ENDPOINTS[provider];
  const label    = PROVIDER_LABELS[provider] || 'accounting tool';

  async function handleSync() {
    if (syncing || !endpoint) return;
    setSyncing(true);
    setMsg('');
    try {
      await axiosClient.post(endpoint);
      setMsg('Sync started — your data will refresh in a few moments.');
    } catch {
      setMsg('Sync failed — please contact your admin if this keeps happening.');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="px-6 py-5 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-navy-800 dark:text-navy-200">
          {label}
        </p>
        <p className="text-[12px] text-navy-500">
          Fetch the most recent invoices, expenses and reports.
        </p>
        {msg && (
          <p className={`mt-2 text-[12px] ${msg.includes('failed')
            ? 'text-red-500 dark:text-red-400'
            : 'text-emerald-600 dark:text-emerald-400'}`}>
            {msg}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={handleSync}
        disabled={syncing}
        className={`inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-white text-[12.5px] font-medium transition shrink-0 bg-brand-600 hover:bg-brand-700 ${
          syncing ? 'opacity-60 cursor-not-allowed' : ''
        }`}
      >
        {syncing
          ? <><Loader2 size={14} className="animate-spin" /> Syncing…</>
          : <><RefreshCw size={14} /> Sync now</>}
      </button>
    </div>
  );
}

function ClientSyncCard() {
  const zoho = useSelector(selectZoho);
  const qbo  = useSelector(selectQBO);
  const xero = useSelector(selectXero);

  const connected = [
    zoho.connected && 'zoho',
    qbo.connected  && 'quickbooks',
    xero.connected && 'xero',
  ].filter(Boolean);

  return (
    <Section icon={Database} title="Data Sync" subtitle="Pull the latest data from your accounting tools">
      {connected.length === 0 ? (
        <div className="px-6 py-5">
          <p className="text-[13px] font-medium text-navy-800 dark:text-navy-200">No integration linked</p>
          <p className="text-[12px] text-navy-500">
            No accounting integration is linked to your account yet — contact your admin.
          </p>
        </div>
      ) : (
        connected.map((p) => <ProviderSyncRow key={p} provider={p} />)
      )}
    </Section>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function Settings() {
  const { user } = useAuth();
  const isClient = user?.role === 'client';

  return (
    <div className="p-6 lg:p-8 max-w-[860px] mx-auto flex flex-col gap-6">

      {/* ── Account ── */}
      <Section icon={User} title="Account" subtitle="Your profile information">
        <FieldRow label="Name"        value={user?.name  ?? '—'} />
        <FieldRow label="Email"       value={user?.email ?? '—'} />
        <FieldRow label="Role"        value={user?.role  ?? '—'} />
        <FieldRow label="Member since" value={user?.createdAt
          ? new Date(user.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
          : '—'}
        />
      </Section>

      {/* ── Security ── */}
      <Section icon={Lock} title="Security" subtitle="Authentication and access">
        <div className="px-6 py-4 flex items-center justify-between">
          <div>
            <p className="text-[13px] font-medium text-navy-800 dark:text-navy-200">
              Password
            </p>
            <p className="text-[12px] text-navy-500">
              Change your account password
            </p>
          </div>
          <button className="inline-flex items-center gap-1 h-9 px-4 rounded-lg border border-navy-200 dark:border-navy-700 hover:bg-navy-50 dark:hover:bg-navy-800 text-navy-700 dark:text-navy-300 text-[12.5px] font-medium transition">
            Update <ChevronRight size={13} />
          </button>
        </div>
      </Section>

      {/* ── Financial Year ── */}
      <FinancialYearSection />

      {/* ── Data Sync (client only) ── */}
      {isClient && <ClientSyncCard />}

      {/* ── Integrations (admin only) ── */}
      {!isClient && (
        <Section
          icon={Puzzle}
          title="Integrations"
          subtitle="Connect your accounting and finance tools"
        >
          <ZohoConnectCard />
          <QBOConnectCard />
          <XeroConnectCard />

          <ComingSoonRow
            name="Tally ERP"
            description="Import vouchers and ledger entries from Tally Prime"
          />
          <ComingSoonRow
            name="Razorpay"
            description="Reconcile payments and settlements automatically"
          />
          <ComingSoonRow
            name="GST Portal"
            description="Fetch GSTR-1, GSTR-3B, and ITC data"
          />
        </Section>
      )}

    </div>
  );
}
