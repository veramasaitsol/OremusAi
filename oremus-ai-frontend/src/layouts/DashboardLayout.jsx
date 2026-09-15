import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import Sidebar from '../components/layout/Sidebar.jsx';
import Navbar from '../components/layout/Navbar.jsx';
import BackToTop from '../components/common/BackToTop.jsx';
import axiosClient from '../services/axiosClient.js';
import { setActiveCurrency } from '../features/ui/uiSlice.js';
import { verifyZohoStatus } from '../features/zoho/zohoSlice.js';
import { verifyQBOStatus } from '../features/quickbooks/quickbooksSlice.js';
import { verifyXeroStatus } from '../features/xero/xeroSlice.js';
import { loadOrganizations } from '../features/orgs/orgsSlice.js';
import { loadReportSettings, applyReportSettings } from '../features/settings/settingsSlice.js';

const TITLES = {
  '/dashboard':     { title: 'Dashboard',     subtitle: 'Bento overview · live financials' },
  '/analytics':     { title: 'AI Analytics',  subtitle: 'Insights and forecasts' },
  '/admin':         { title: 'Admin Console', subtitle: 'Workspace administration' },
  '/transactions':  { title: 'Transactions',  subtitle: 'Day book entries' },
  '/reports':       { title: 'Reports',       subtitle: 'P&L · cashflow · trial balance' },
  '/customers':     { title: 'Customers',     subtitle: 'Receivables and contacts' },
  '/vendors':       { title: 'Vendors',       subtitle: 'Payables and contacts' },
  '/expenses':      { title: 'Expenses',      subtitle: 'Categorized spend' },
  '/invoices':      { title: 'Invoices',      subtitle: 'AR & AP documents' },
  '/documents':     { title: 'Documents',     subtitle: 'Files and receipts' },
  '/notifications': { title: 'Notifications', subtitle: 'Updates and alerts' },
  '/clients':       { title: 'Clients',       subtitle: 'Manage client workspaces' },
  '/employees':     { title: 'Employees',     subtitle: 'Team and permissions' },
  '/billing':       { title: 'Billing',       subtitle: 'Plans and invoices' },
  '/settings':      { title: 'Settings',      subtitle: 'Profile and preferences' },
};

export default function DashboardLayout() {
  const dispatch     = useDispatch();
  const { pathname } = useLocation();
  const meta         = TITLES[pathname] || { title: 'Oremus', subtitle: '' };

  // Silently verify integration connection state on every layout mount
  // so the Settings page and ClientSwitcher reflect the real DB state.
  useEffect(() => {
    dispatch(verifyZohoStatus());
    dispatch(verifyQBOStatus());
    dispatch(verifyXeroStatus());
    dispatch(loadOrganizations());
    dispatch(loadReportSettings());
  }, [dispatch]);

  // Push the active platform's Financial-Year start month + Date format into the
  // module-level formatting utils (mirrors the currency subscription in store.js),
  // so preset date ranges and report date cells follow Settings.
  const settingsEffective = useSelector((s) => s.settings.effective);
  const orgProvider = useSelector((s) => s.orgs.provider);
  const firstMyPlatform = useSelector((s) => s.settings.myPlatforms[0]);
  const activeProvider = orgProvider || firstMyPlatform || null;
  useEffect(() => {
    if (activeProvider) applyReportSettings(settingsEffective, activeProvider);
  }, [settingsEffective, activeProvider]);

  // Resolve the connected company's display currency ONCE and apply it globally
  // (USD for QuickBooks, org currency for Xero/Zoho) so every module — Ratios,
  // Transactions, Reports, etc. — renders money in the right currency instead of
  // defaulting to ₹. Stored in Redux (ui.activeCurrency) — the store subscription
  // keeps the formatting util and every subscribed component in sync, so no
  // manual re-render tick is needed.
  useEffect(() => {
    let cancelled = false;
    axiosClient.get('/dashboard')
      .then((r) => {
        const c = r.data?.data?.currency;
        if (!cancelled && c) dispatch(setActiveCurrency(c));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [dispatch]);

  return (
    <div className="flex min-h-screen bg-navy-50 dark:bg-navy-950">
      <Sidebar />
      <main className="flex-1 min-w-0 flex flex-col">
        <Navbar title={meta.title} subtitle={meta.subtitle} />
        <div className="flex-1 animate-fadein">
          <Outlet />
        </div>
      </main>
      <BackToTop />
    </div>
  );
}
