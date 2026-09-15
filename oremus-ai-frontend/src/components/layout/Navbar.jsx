import { useSelector, useDispatch } from 'react-redux';
import { Sun, Moon, Menu } from 'lucide-react';
import { toggleTheme, setMobileSidebar } from '../../features/ui/uiSlice.js';
import { selectUser } from '../../features/auth/authSlice.js';
import ProfileMenu from './ProfileMenu.jsx';
import OrgSwitcher from './OrgSwitcher.jsx';
import ClientSwitcher from './ClientSwitcher.jsx';
import NotificationsBell from './NotificationsBell.jsx';

export default function Navbar() {
  const dispatch = useDispatch();
  const theme    = useSelector((s) => s.ui.theme);
  const user     = useSelector(selectUser);
  const dark     = theme === 'dark';

  return (
    <header className="h-14 sticky top-0 z-30 bg-white/90 dark:bg-navy-900/90 backdrop-blur-md border-b border-navy-200/70 dark:border-navy-800 flex items-center px-4 gap-3">

      {/* Mobile hamburger */}
      <button
        onClick={() => dispatch(setMobileSidebar(true))}
        className="lg:hidden h-8 w-8 rounded-lg hover:bg-navy-100 dark:hover:bg-navy-800 text-navy-500 grid place-items-center shrink-0"
        aria-label="Open menu"
      >
        <Menu size={17} />
      </button>

      {/* Admin "view as client" switcher (admins only) */}
      <ClientSwitcher />

      {/* Organization switcher (multi-org Zoho accounts only) */}
      <OrgSwitcher />

      {/* Flex spacer — keeps right-side actions anchored to the right edge */}
      <div className="flex-1" />

      {/* ── Right actions ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* Theme toggle */}
        <button
          onClick={() => dispatch(toggleTheme())}
          className="h-9 w-9 rounded-lg hover:bg-navy-100 dark:hover:bg-navy-800 text-navy-500 grid place-items-center transition"
          aria-label="Toggle theme"
        >
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        {/* Notifications */}
        <NotificationsBell />

        {/* Profile */}
        <ProfileMenu user={user} />
      </div>
    </header>
  );
}
