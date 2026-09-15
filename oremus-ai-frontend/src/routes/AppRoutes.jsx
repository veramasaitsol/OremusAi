import { Routes, Route } from 'react-router-dom';
import ScrollToTop from '../components/common/ScrollToTop.jsx';
import DashboardLayout from '../layouts/DashboardLayout.jsx';
import ProtectedRoute from './ProtectedRoute.jsx';
import Login from '../pages/Login.jsx';
import ForgotPassword from '../pages/ForgotPassword.jsx';
import ResetPassword from '../pages/ResetPassword.jsx';
import Dashboard from '../pages/Dashboard.jsx';
import Settings from '../pages/Settings.jsx';
import ZohoCallback from '../pages/ZohoCallback.jsx';
import QuickBooksCallback from '../pages/QuickBooksCallback.jsx';
import XeroCallback from '../pages/XeroCallback.jsx';
import ErrorBoundary from '../components/common/ErrorBoundary.jsx';
import Placeholder from '../pages/Placeholder.jsx';
import Transactions from '../pages/Transactions.jsx';
import Ratios from '../pages/Ratios.jsx';
import KeyRatiosSummary from '../pages/KeyRatiosSummary.jsx';
import Clients from '../pages/Clients.jsx';
import Accounts from '../pages/Accounts.jsx';
import Analytics from '../pages/Analytics.jsx';
import Reports from '../pages/Reports.jsx';
import Notifications from '../pages/Notifications.jsx';
import NotFound from '../pages/NotFound.jsx';
import MarketingLayout from '../layouts/MarketingLayout.jsx';
import Landing from '../pages/marketing/Landing.jsx';
import Features from '../pages/marketing/Features.jsx';
import Services from '../pages/marketing/Services.jsx';
import Pricing from '../pages/marketing/Pricing.jsx';
import About from '../pages/marketing/About.jsx';
import Contact from '../pages/marketing/Contact.jsx';
import Privacy from '../pages/marketing/Privacy.jsx';
import Terms from '../pages/marketing/Terms.jsx';

function P({ roles, permission, children }) {
  return <ProtectedRoute roles={roles} permission={permission}>{children}</ProtectedRoute>;
}

export default function AppRoutes() {
  return (
    <>
    <ScrollToTop />
    <Routes>
      {/* Public marketing site (no auth) */}
      <Route element={<MarketingLayout />}>
        <Route path="/" element={<Landing />} />
        <Route path="/features" element={<Features />} />
        <Route path="/services" element={<Services />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/about" element={<About />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
      </Route>

      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />

      {/* Zoho OAuth callback — protected but no dashboard chrome */}
      <Route path="/auth/zoho/callback" element={<P><ZohoCallback /></P>} />

      {/* QuickBooks OAuth callback — protected but no dashboard chrome */}
      <Route path="/auth/quickbooks/callback" element={<P><QuickBooksCallback /></P>} />

      {/* Xero OAuth callback — protected but no dashboard chrome */}
      <Route path="/auth/xero/callback" element={<P><XeroCallback /></P>} />

      <Route element={<P><DashboardLayout /></P>}>
        <Route path="/dashboard"     element={<ErrorBoundary><Dashboard /></ErrorBoundary>} />
        <Route path="/analytics"     element={<ErrorBoundary><Analytics /></ErrorBoundary>} />
        <Route path="/ratios"        element={<ErrorBoundary><Ratios /></ErrorBoundary>} />
        <Route path="/ratios/summary" element={<ErrorBoundary><KeyRatiosSummary /></ErrorBoundary>} />
        <Route path="/transactions"  element={<ErrorBoundary><Transactions /></ErrorBoundary>} />
        <Route path="/accounts"      element={<ErrorBoundary><Accounts /></ErrorBoundary>} />
        <Route path="/reports"              element={<P permission="Reports"><ErrorBoundary><Reports /></ErrorBoundary></P>} />
        <Route path="/reports/:reportSlug"  element={<P permission="Reports"><ErrorBoundary><Reports /></ErrorBoundary></P>} />
        <Route path="/customers"     element={<Placeholder title="Customers"     icon="Users" />} />
        <Route path="/vendors"       element={<Placeholder title="Vendors"       icon="Truck" />} />
        <Route path="/expenses"      element={<Placeholder title="Expenses"      icon="Wallet" />} />
        <Route path="/invoices"      element={<Placeholder title="Invoices"      icon="ReceiptText" />} />
        <Route path="/documents"     element={<Placeholder title="Documents"     icon="Folder" />} />
        <Route path="/notifications" element={<ErrorBoundary><Notifications /></ErrorBoundary>} />
        <Route path="/settings"      element={<Settings />} />

        {/* Admin only */}
        <Route path="/admin"     element={<P roles={['admin']}><Placeholder title="Admin Console" icon="Shield" description="Workspace administration. Admin only." /></P>} />
        <Route path="/clients"   element={<P roles={['admin']}><ErrorBoundary><Clients /></ErrorBoundary></P>} />
        <Route path="/employees" element={<P roles={['admin']}><Placeholder title="Employees"     icon="Briefcase" description="Team and permissions. Admin only." /></P>} />

        {/* Client only */}
        <Route path="/billing" element={<P roles={['client']}><Placeholder title="Billing" icon="Wallet" description="Plans and invoices. Clients only." /></P>} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
    </>
  );
}
