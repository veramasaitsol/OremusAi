import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import * as LucideIcons from 'lucide-react';
import { ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { SIDEBAR_ITEMS } from './sidebarItems.js';
import { toggleSidebar, setMobileSidebar } from '../../features/ui/uiSlice.js';
import { selectRole, selectUser } from '../../features/auth/authSlice.js';
import Logo from '../ui/Logo.jsx';
import { cn } from '../../utils/classNames.js';

const resolveIcon = (name) => LucideIcons[name] || LucideIcons.Circle;

// Filter items by role and (for clients) permission. Applies at both top
// level and nested children — groups whose entire child list is filtered out
// are themselves dropped.
function visibleItems(role, permissions, items, integrationType) {
  const passesGate = (item) => {
    if (item.roles && !item.roles.includes(role)) return false;
    // Provider-scoped items (e.g. report children) are shown to a client only
    // when they match the integration the admin assigned. Admins see all.
    if (role === 'client' && item.provider && item.provider !== integrationType) {
      return false;
    }
    if (role === 'client' && item.permission) {
      return permissions.includes(item.permission);
    }
    return true;
  };

  return items
    .filter(passesGate)
    .map((i) => (i.children
      ? { ...i, children: i.children.filter(passesGate) }
      : i))
    .filter((i) => !i.children || i.children.length > 0);
}

// Top-level NavLink (flat sidebar entry).
function SidebarLink({ item, collapsed, onNavigate }) {
  const Icon = resolveIcon(item.icon);
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'group w-full flex items-center gap-3 py-2 rounded-lg text-[13px] font-medium transition relative',
          collapsed ? 'justify-center px-0' : 'px-3',
          isActive
            ? 'nav-item-active text-brand-600 dark:text-brand-400'
            : 'text-navy-600 dark:text-navy-300 hover:bg-navy-100/70 dark:hover:bg-navy-800/60 hover:text-navy-900 dark:hover:text-white'
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon size={17} className={isActive ? 'text-brand-500' : ''} />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">{item.label}</span>
              {item.badge && (
                <span
                  className={cn(
                    'text-[9.5px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded',
                    item.badge === 'New'
                      ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400'
                      : 'bg-navy-100 dark:bg-navy-800 text-navy-500'
                  )}
                >
                  {item.badge}
                </span>
              )}
            </>
          )}
          {isActive && <span className="absolute left-0 w-0.5 h-5 bg-brand-500 rounded-r" />}
        </>
      )}
    </NavLink>
  );
}

// Expandable group with children. Auto-expands when a child route is active.
function SidebarGroup({ item, collapsed, onNavigate }) {
  const { pathname } = useLocation();
  const Icon = resolveIcon(item.icon);

  const childActive = item.children.some((c) => pathname.startsWith(c.to));
  const [open, setOpen] = useState(childActive);

  useEffect(() => {
    if (childActive) setOpen(true);
  }, [childActive]);

  // Collapsed mode: show parent as a single icon link to the first child.
  if (collapsed) {
    return (
      <NavLink
        to={item.children[0]?.to || '#'}
        onClick={onNavigate}
        className={cn(
          'group w-full flex items-center justify-center py-2 rounded-lg text-[13px] font-medium transition relative',
          childActive
            ? 'nav-item-active text-brand-600 dark:text-brand-400'
            : 'text-navy-600 dark:text-navy-300 hover:bg-navy-100/70 dark:hover:bg-navy-800/60 hover:text-navy-900 dark:hover:text-white'
        )}
        title={item.label}
      >
        <Icon size={17} className={childActive ? 'text-brand-500' : ''} />
        {childActive && <span className="absolute left-0 w-0.5 h-5 bg-brand-500 rounded-r" />}
      </NavLink>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'group w-full flex items-center gap-3 py-2 rounded-lg text-[13px] font-medium transition relative px-3',
          childActive
            ? 'text-brand-700 dark:text-brand-300'
            : 'text-navy-600 dark:text-navy-300 hover:bg-navy-100/70 dark:hover:bg-navy-800/60 hover:text-navy-900 dark:hover:text-white'
        )}
        aria-expanded={open}
      >
        <Icon size={17} className={childActive ? 'text-brand-500' : ''} />
        <span className="flex-1 text-left">{item.label}</span>
        {item.badge && (
          <span className="text-[9.5px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-navy-100 dark:bg-navy-800 text-navy-500">
            {item.badge}
          </span>
        )}
        <ChevronDown
          size={14}
          className={cn('text-navy-400 transition-transform shrink-0', open ? 'rotate-0' : '-rotate-90')}
        />
        {childActive && <span className="absolute left-0 w-0.5 h-5 bg-brand-500 rounded-r" />}
      </button>

      {open && (
        <ul className="mt-0.5 mb-1 ml-3 pl-3 border-l border-navy-200/70 dark:border-navy-800 flex flex-col gap-0.5">
          {item.children.map((child) => {
            const ChildIcon = resolveIcon(child.icon);
            return (
              <li key={child.id}>
                <NavLink
                  to={child.to}
                  end={child.end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2.5 py-1.5 px-2.5 rounded-md text-[12.5px] font-medium transition',
                      isActive
                        ? 'bg-brand-50/70 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300'
                        : 'text-navy-600 dark:text-navy-300 hover:bg-navy-100/70 dark:hover:bg-navy-800/60 hover:text-navy-900 dark:hover:text-white'
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{
                          background: isActive
                            ? (child.accent || '#2563EB')
                            : 'rgba(148,163,184,0.55)',
                        }}
                      />
                      <ChildIcon
                        size={14}
                        className={isActive ? '' : 'text-navy-400'}
                        style={isActive ? { color: child.accent || '#2563EB' } : undefined}
                      />
                      <span className="flex-1">{child.label}</span>
                      {child.badge && (
                        <span className="text-[9.5px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-navy-100 dark:bg-navy-800 text-navy-500">
                          {child.badge}
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function Sidebar() {
  const dispatch = useDispatch();
  const role        = useSelector(selectRole);
  const user        = useSelector(selectUser);
  const collapsed   = useSelector((s) => s.ui.sidebarCollapsed);
  const mobileOpen  = useSelector((s) => s.ui.mobileSidebarOpen);

  const permissions = Array.isArray(user?.permissions)
    ? user.permissions
    : typeof user?.permissions === 'string'
      ? (() => { try { return JSON.parse(user.permissions); } catch { return []; } })()
      : [];

  const integrationType = user?.integrationType || 'none';
  const items = visibleItems(role, permissions, SIDEBAR_ITEMS, integrationType);
  const closeMobile = () => dispatch(setMobileSidebar(false));

  return (
    <>
      {/* mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-navy-950/40 lg:hidden"
          onClick={closeMobile}
        />
      )}

      <aside
        className={cn(
          'bg-white dark:bg-navy-900 border-r border-navy-200/70 dark:border-navy-800',
          'flex flex-col h-screen z-50',
          'transition-[width,transform] duration-200',
          collapsed ? 'w-[72px]' : 'w-[244px]',
          'fixed inset-y-0 left-0',
          mobileOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full',
          'lg:sticky lg:top-0 lg:translate-x-0 lg:shadow-none lg:shrink-0'
        )}
      >
        {/* Logo */}
        <div
          className={cn(
            'h-14 flex items-center border-b border-navy-200/70 dark:border-navy-800',
            collapsed ? 'justify-center' : 'px-5'
          )}
        >
          <div className="flex items-center gap-2.5">
            <Logo size={28} />
            {!collapsed && (
              <div>
                <div className="font-bold text-[15px] tracking-tight text-navy-900 dark:text-white">Oremus</div>
                <div className="text-[10px] uppercase tracking-wider text-navy-500">Finance · AI</div>
              </div>
            )}
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto scroll-thin py-3 px-2">
          {!collapsed && (
            <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-navy-400 font-semibold">
              Workspace
            </div>
          )}
          <ul className="flex flex-col gap-0.5">
            {items.map((item) => {
              // A group with a single visible child (e.g. a client scoped to one
              // report provider) collapses into a direct link straight to that
              // child — clicking the parent navigates there with no expand step.
              const node = item.children
                ? (item.children.length === 1
                    ? <SidebarLink item={{ ...item, to: item.children[0].to, end: item.children[0].end }} collapsed={collapsed} onNavigate={closeMobile} />
                    : <SidebarGroup item={item} collapsed={collapsed} onNavigate={closeMobile} />)
                : <SidebarLink item={item} collapsed={collapsed} onNavigate={closeMobile} />;
              return <li key={item.id}>{node}</li>;
            })}
          </ul>
        </nav>

        {/* Collapse toggle */}
        <button
          onClick={() => dispatch(toggleSidebar())}
          className="m-2 mt-0 h-8 rounded-lg border border-navy-200 dark:border-navy-700 text-navy-500 hover:bg-navy-50 dark:hover:bg-navy-800 flex items-center justify-center gap-1.5 text-[11px] font-medium"
        >
          {collapsed ? <ChevronRight size={14} /> : (<><ChevronLeft size={14} /> Collapse</>)}
        </button>
      </aside>
    </>
  );
}
