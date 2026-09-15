import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { ChevronDown, UserCircle, Settings, LogOut } from 'lucide-react';
import { logout } from '../../features/auth/authSlice.js';
import { cn } from '../../utils/classNames.js';

export default function ProfileMenu({ user }) {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
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

  const name    = user?.name  || 'User';
  const email   = user?.email || '';
  const rawRole = user?.role;
  const role    = rawRole === 'admin' ? 'Admin' : rawRole === 'client' ? 'Client' : 'User';
  const initial = (name || 'U').slice(0, 1).toUpperCase();

  // Normalise permissions (may be array, JSON string, or null)
  const permissions = Array.isArray(user?.permissions)
    ? user.permissions
    : typeof user?.permissions === 'string'
      ? (() => { try { return JSON.parse(user.permissions); } catch { return []; } })()
      : [];

  const isClient = rawRole === 'client';

  // For clients, only show a menu item if they have the matching permission.
  // Admins always see everything.
  const canSeeProfile  = !isClient || permissions.includes('Profile');
  const canSeeSettings = !isClient || permissions.includes('Settings');

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-2.5 h-10 pl-1 pr-3 rounded-xl transition',
          open ? 'bg-brand-50/40 dark:bg-brand-500/10' : 'hover:bg-navy-100 dark:hover:bg-navy-800'
        )}
      >
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-400 to-cyan-500 text-white grid place-items-center text-[13px] font-bold">
          {initial}
        </div>
        <div className="text-left hidden md:block">
          <div className="text-[12.5px] font-semibold text-navy-900 dark:text-white leading-tight">{name}</div>
          <div className="text-[10.5px] text-navy-500 leading-tight">{role}</div>
        </div>
        <ChevronDown size={13} className={cn('text-navy-400 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-64 z-50 bg-white dark:bg-navy-900 border border-navy-200 dark:border-navy-700 rounded-xl shadow-lift overflow-hidden animate-fadein">
          <div className="px-4 py-3 border-b border-navy-100 dark:border-navy-800">
            <div className="text-[13.5px] font-bold text-navy-900 dark:text-white">{name}</div>
            <div className="text-[11.5px] text-navy-500 mt-0.5 truncate">{email}</div>
          </div>
          <ul className="py-1.5">
            {canSeeProfile && (
              <li>
                <button
                  onClick={() => { setOpen(false); navigate('/settings'); }}
                  className="w-full flex items-center gap-3 px-4 py-2 text-[13px] text-navy-700 dark:text-navy-200 hover:bg-navy-50 dark:hover:bg-navy-800 transition"
                >
                  <UserCircle size={16} className="text-navy-500" /> Profile
                </button>
              </li>
            )}
            {canSeeSettings && (
              <li>
                <button
                  onClick={() => { setOpen(false); navigate('/settings'); }}
                  className="w-full flex items-center gap-3 px-4 py-2 text-[13px] text-navy-700 dark:text-navy-200 hover:bg-navy-50 dark:hover:bg-navy-800 transition"
                >
                  <Settings size={16} className="text-navy-500" /> Settings
                </button>
              </li>
            )}
          </ul>
          <div className="border-t border-navy-100 dark:border-navy-800 py-1.5">
            <button
              onClick={() => { setOpen(false); dispatch(logout()); navigate('/login'); }}
              className="w-full flex items-center gap-3 px-4 py-2 text-[13px] font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition"
            >
              <LogOut size={16} /> Logout
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
