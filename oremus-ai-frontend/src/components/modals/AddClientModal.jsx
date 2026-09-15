import { useState, useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { X, Eye, EyeOff, Loader2 } from 'lucide-react';
import {
  createClient,
  updateClient,
  clearClientsError,
  selectClientsMutating,
  selectClientsError,
} from '../../features/clients/clientsSlice.js';
import { cn } from '../../utils/classNames.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUSES = ['Active', 'Pending', 'Suspended'];

const INTEGRATIONS = [
  { id: 'zoho', label: 'Zoho Books', color: '#E42527', initial: 'Z', bg: 'bg-[#E42527]' },
  { id: 'quickbooks', label: 'QuickBooks', color: '#2CA01C', initial: 'Q', bg: 'bg-[#2CA01C]' },
  { id: 'xero', label: 'Xero', color: '#13B5EA', initial: 'X', bg: 'bg-[#13B5EA]' },
];

const ALL_PERMISSIONS = [
  'Dashboard', 'Day Book',
  'Reports', 'AI Analytics',
  'Customers', 'Vendors',
  'Expenses', 'Invoices',
  'Accounts', 'Documents',
  'Notifications', 'Settings',
  'Profile', 'Billing',
];

const DEFAULT_PERMISSIONS = ['Dashboard', 'Profile'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function Label({ children }) {
  return (
    <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-navy-400 dark:text-navy-500 mb-2.5">
      {children}
    </p>
  );
}

function Field({ label, error, children }) {
  return (
    <div>
      <p className="text-[11px] font-semibold text-navy-500 dark:text-navy-400 uppercase tracking-wide mb-1">
        {label}
      </p>
      {children}
      {error && <p className="mt-0.5 text-[11px] text-red-500">{error}</p>}
    </div>
  );
}

function Input({ className, ...props }) {
  return (
    <input
      className={cn(
        'w-full h-10 px-3 rounded-lg text-[13px] text-navy-900 dark:text-white',
        'bg-navy-50 dark:bg-navy-800',
        'border border-navy-200 dark:border-navy-700',
        'focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-400/20',
        'placeholder:text-navy-400',
        className
      )}
      {...props}
    />
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AddClientModal({ onClose, editClient = null }) {
  const dispatch = useDispatch();
  const mutating = useSelector(selectClientsMutating);
  const apiError = useSelector(selectClientsError);
  const isEdit = !!editClient;

  const [showPw, setShowPw] = useState(false);

  const [form, setForm] = useState({
    name: editClient?.name || '',
    company: editClient?.company || '',
    mobile: editClient?.mobile || '',
    email: editClient?.email || '',
    password: '',
    status: editClient?.status || 'Active',
    integration_type: editClient?.integration_type || 'zoho',
    permissions: editClient?.permissions || [...DEFAULT_PERMISSIONS],
  });

  const [errors, setErrors] = useState({});
  const overlayRef = useRef(null);

  // Close on Escape
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Clear API error on unmount
  useEffect(() => () => { dispatch(clearClientsError()); }, [dispatch]);

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  }

  function togglePermission(p) {
    setForm((f) => ({
      ...f,
      permissions: f.permissions.includes(p)
        ? f.permissions.filter((x) => x !== p)
        : [...f.permissions, p],
    }));
  }

  function validate() {
    const e = {};
    if (!form.name.trim()) e.name = 'Contact name is required';
    if (!form.email.trim()) e.email = 'Email is required';
    else if (!/\S+@\S+\.\S+/.test(form.email)) e.email = 'Enter a valid email';
    if (!isEdit && !form.password) e.password = 'Password is required';
    if (!isEdit && form.password && form.password.length < 4)
      e.password = 'Minimum 4 characters';
    return e;
  }

  async function handleSubmit() {
    const e = validate();
    if (Object.keys(e).length) { setErrors(e); return; }

    const payload = {
      name: form.name.trim(),
      company: form.company.trim(),
      mobile: form.mobile.trim(),
      email: form.email.trim().toLowerCase(),
      status: form.status,
      integration_type: form.integration_type,
      permissions: form.permissions,
      ...(form.password ? { password: form.password } : {}),
    };

    const action = isEdit
      ? dispatch(updateClient({ id: editClient.id, ...payload }))
      : dispatch(createClient(payload));

    const result = await action;
    if (!result.error) onClose();
  }

  const statusColor = {
    Active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    Pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    Suspended: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  };

  return (
    <div
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
      className="fixed inset-0 z-[100] flex items-stretch justify-end bg-navy-950/50 backdrop-blur-sm animate-fadein"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'relative flex flex-col w-full max-w-[520px] h-full',
          'bg-white dark:bg-navy-900',
          'border-l border-navy-200 dark:border-navy-700',
          'shadow-2xl',
          'animate-slide-left',
        )}
      >
        {/* ── Gradient top bar ── */}
        <div className="h-1 w-full bg-gradient-to-r from-brand-500 via-cyan-400 to-brand-600 shrink-0" />

        {/* ── Header ── */}
        <div className="flex items-start justify-between px-6 pt-5 pb-4 shrink-0">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={cn(
                'inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-0.5 rounded-full',
                statusColor[form.status] || statusColor.Active
              )}>
                <span className="w-1.5 h-1.5 rounded-full bg-current" />
                {form.status}
              </span>
            </div>
            <h2 className="text-[20px] font-bold text-navy-900 dark:text-white leading-tight">
              {isEdit ? 'Edit client' : 'Add client'}
            </h2>
            <p className="text-[12.5px] text-navy-500 mt-0.5">
              {isEdit ? "Update this client's details." : 'Onboard a new client to the platform'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="mt-1 h-7 w-7 rounded-lg flex items-center justify-center text-navy-400 hover:bg-navy-100 dark:hover:bg-navy-800 hover:text-navy-700 dark:hover:text-white transition"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto px-6 pb-2 space-y-6">

          {/* ── CLIENT DETAILS ── */}
          <div>
            <Label>Client Details</Label>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <Field label="Contact Name" error={errors.name}>
                <Input
                  placeholder="Full name"
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  className={errors.name ? 'border-red-400 focus:border-red-400 focus:ring-red-400/20' : ''}
                />
              </Field>
              <Field label="Company">
                <Input
                  placeholder="Company name"
                  value={form.company}
                  onChange={(e) => set('company', e.target.value)}
                />
              </Field>
              <Field label="Mobile Number">
                <Input
                  placeholder="+91 98765 43210"
                  value={form.mobile}
                  onChange={(e) => set('mobile', e.target.value)}
                />
              </Field>
              <Field label="Email Address" error={errors.email}>
                <Input
                  type="email"
                  placeholder="email@company.com"
                  value={form.email}
                  onChange={(e) => set('email', e.target.value)}
                  className={errors.email ? 'border-red-400 focus:border-red-400 focus:ring-red-400/20' : ''}
                />
              </Field>
            </div>

            {/* Password */}
            <Field label={isEdit ? 'New Password (optional)' : 'Password'} error={errors.password}>
              <div className="relative">
                <Input
                  type={showPw ? 'text' : 'password'}
                  placeholder="At least 4 characters"
                  value={form.password}
                  onChange={(e) => set('password', e.target.value)}
                  className={cn('pr-10', errors.password ? 'border-red-400 focus:border-red-400 focus:ring-red-400/20' : '')}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-navy-400 hover:text-navy-600 transition"
                >
                  {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </Field>
          </div>

          {/* ── STATUS ── */}
          <div>
            <Label>Status</Label>
            <div className="flex gap-2">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  onClick={() => set('status', s)}
                  className={cn(
                    'h-8 px-4 rounded-lg text-[12.5px] font-semibold transition border',
                    form.status === s
                      ? 'bg-brand-600 border-brand-600 text-white'
                      : 'bg-white dark:bg-navy-800 border-navy-200 dark:border-navy-700 text-navy-600 dark:text-navy-300 hover:border-navy-300'
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* ── ACCOUNTING INTEGRATION ── */}
          <div>
            <Label>Accounting Integration</Label>
            <p className="text-[12px] text-navy-500 dark:text-navy-400 mb-3 -mt-1">
              Pick one platform to sync this client's books from. You can connect it from
              the table after the client is added.
            </p>
            <div className="flex flex-col gap-2">
              {INTEGRATIONS.map(({ id, label, initial, bg }) => (
                <label
                  key={id}
                  className={cn(
                    'flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition',
                    form.integration_type === id
                      ? 'border-brand-400 bg-brand-50/60 dark:bg-brand-900/20'
                      : 'border-navy-200 dark:border-navy-700 hover:bg-navy-50 dark:hover:bg-navy-800'
                  )}
                >
                  <input
                    type="radio"
                    name="integration"
                    value={id}
                    checked={form.integration_type === id}
                    onChange={() => set('integration_type', id)}
                    className="sr-only"
                  />
                  <span className={cn('w-8 h-8 rounded-lg grid place-items-center text-white text-[13px] font-bold shrink-0', bg)}>
                    {initial}
                  </span>
                  <span className="text-[13.5px] font-semibold text-navy-800 dark:text-navy-200">
                    {label}
                  </span>
                  <span className={cn(
                    'ml-auto w-4 h-4 rounded-full border-2 transition flex items-center justify-center',
                    form.integration_type === id
                      ? 'border-brand-500 bg-brand-500'
                      : 'border-navy-300 dark:border-navy-600'
                  )}>
                    {form.integration_type === id && (
                      <span className="w-1.5 h-1.5 rounded-full bg-white" />
                    )}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* ── ACCESS PERMISSIONS ── */}
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <Label>Access Permissions</Label>
              <div className="flex items-center gap-3 text-[11.5px] font-medium -mt-[10px]">
                <button onClick={() => set('permissions', [...ALL_PERMISSIONS])} className="text-brand-600 dark:text-brand-400 hover:underline">
                  Select all
                </button>
                <span className="text-navy-300">·</span>
                <button onClick={() => set('permissions', [])} className="text-navy-400 hover:underline">
                  Clear
                </button>
                <span className="text-navy-300">·</span>
                <button onClick={() => set('permissions', [...DEFAULT_PERMISSIONS])} className="text-navy-400 hover:underline">
                  Defaults
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {ALL_PERMISSIONS.map((perm) => {
                const checked = form.permissions.includes(perm);
                return (
                  <label
                    key={perm}
                    className={cn(
                      'flex items-center gap-2.5 px-3 py-2.5 rounded-lg border cursor-pointer transition select-none',
                      checked
                        ? 'border-brand-400 bg-brand-50/60 dark:bg-brand-900/20'
                        : 'border-navy-200 dark:border-navy-700 hover:bg-navy-50 dark:hover:bg-navy-800'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePermission(perm)}
                      className="sr-only"
                    />
                    <span className={cn(
                      'w-4 h-4 rounded flex items-center justify-center border shrink-0 transition',
                      checked
                        ? 'bg-brand-600 border-brand-600'
                        : 'border-navy-300 dark:border-navy-600'
                    )}>
                      {checked && (
                        <svg viewBox="0 0 10 8" width="9" fill="none">
                          <path d="M1 4l2.5 2.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                    <span className="text-[12px] font-medium text-navy-700 dark:text-navy-300 truncate">
                      {perm}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="shrink-0 px-6 py-4 border-t border-navy-100 dark:border-navy-800 flex flex-col gap-2">
          {apiError && (
            <p className="text-[12px] text-red-500 dark:text-red-400 text-center -mb-1">
              ⚠ {apiError}
            </p>
          )}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 h-10 rounded-xl border border-navy-200 dark:border-navy-700 text-[13px] font-semibold text-navy-600 dark:text-navy-300 hover:bg-navy-50 dark:hover:bg-navy-800 transition"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={mutating}
              className={cn(
                'flex-1 h-10 rounded-xl font-semibold text-[13px] text-white transition',
                'bg-gradient-to-r from-brand-500 to-cyan-500',
                'hover:from-brand-600 hover:to-cyan-600',
                'disabled:opacity-60 inline-flex items-center justify-center gap-2'
              )}
            >
              {mutating
                ? <><Loader2 size={14} className="animate-spin" /> Saving…</>
                : <>{isEdit ? 'Save changes' : '+ Create client'}</>
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
