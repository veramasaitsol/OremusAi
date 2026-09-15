// Full-page host for the currently open report. The viewer takes over the whole
// viewport (not a centered modal) so reports read like a dedicated page, with
// the viewer's own top bar providing the Back button. The UI is COMMON across
// every provider (Zoho / QuickBooks / Xero) — one consistent report experience —
// while the data flow (loadReportData, view, filters, drill-downs) stays
// provider-aware via report.provider. Role/permissions only gate client access.

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';
import { ArrowLeft, FileSearch } from 'lucide-react';
import ReportViewer from './quickbooks/QBReportViewer.jsx';
import ExecutiveSummaryViewer from './ExecutiveSummaryViewer.jsx';
import BudgetSummaryViewer from './BudgetSummaryViewer.jsx';
import BudgetVarianceViewer from './BudgetVarianceViewer.jsx';
import CashSummaryViewer from './CashSummaryViewer.jsx';
import CashFlowsDirectViewer from './CashFlowsDirectViewer.jsx';
import ForeignCurrencyGainsViewer from './ForeignCurrencyGainsViewer.jsx';
import InventoryItemSummaryViewer from './InventoryItemSummaryViewer.jsx';
import ZohoDetailReportViewer from './ZohoDetailReportViewer.jsx';
import GstReturnsWorkbookViewer from './GstReturnsWorkbookViewer.jsx';
import {
  selectOpenReport, selectIsViewerOpen,
  selectReportData, selectReportStatus,
  closeReport, loadReportData,
} from '../../features/reports/reportsSlice.js';
import { selectActiveClient } from '../../features/clients/clientsSlice.js';

// Some report cards route to dedicated "special" viewers (Bank Reconciliation,
// Tax Liability, Budget Summary, etc.) that assume a populated, report-shaped
// payload. When the active provider's API has no equivalent for that report, the
// backend returns an honest `unavailable` payload — which those viewers can't
// render (they'd try to print column objects into the DOM and crash). This guard
// renders one clean full-page "not available" state instead, BEFORE any viewer.
function UnavailableReport({ name, message, onBack }) {
  return (
    <>
      <div className="flex items-center gap-3 border-b border-gray-200 dark:border-navy-800 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-navy-800"
        >
          <ArrowLeft size={16} />
          Back
        </button>
        <span className="truncate text-sm font-semibold text-gray-900 dark:text-white">{name}</span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-100 dark:bg-navy-800">
          <FileSearch size={28} className="text-gray-400 dark:text-gray-500" />
        </div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Not available for this connection</h3>
        <p className="mt-1 max-w-md text-sm text-gray-500 dark:text-gray-400">
          {message
            || "Your accounting provider's API doesn't offer this report, so there's nothing to display here."}
        </p>
      </div>
    </>
  );
}

export default function ReportViewerModal() {
  const dispatch = useDispatch();
  const open = useSelector(selectIsViewerOpen);
  const report = useSelector(selectOpenReport);
  const client = useSelector(selectActiveClient);
  const data = useSelector(selectReportData);
  const status = useSelector(selectReportStatus);
  const showUnavailable = status === 'succeeded' && data?.unavailable;

  // Kick off data fetch whenever a new report is opened.
  useEffect(() => {
    if (open && report?.name) {
      dispatch(loadReportData({ reportName: report.name, clientId: client?.id, provider: report.provider }));
    }
  }, [dispatch, open, report?.name, client?.id]);

  // Esc closes the page; lock body scroll while the full-page report is open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') dispatch(closeReport()); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, dispatch]);

  if (!open || !report) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-white dark:bg-navy-950 animate-fadein">
      {showUnavailable ? (
        <UnavailableReport name={report.name} message={data?.message} onBack={() => dispatch(closeReport())} />
      ) : report.name === 'Executive Summary' ? (
        <ExecutiveSummaryViewer />
      ) : report.name === 'Budget Summary' ? (
        <BudgetSummaryViewer />
      ) : report.name === 'Budget Variance' ? (
        <BudgetVarianceViewer />
      ) : report.name === 'Cash Summary' ? (
        <CashSummaryViewer />
      ) : report.name === 'Statement of Cash Flows - Direct' ? (
        <CashFlowsDirectViewer />
      ) : report.name === 'Foreign Currency Gains and Losses' ? (
        <ForeignCurrencyGainsViewer />
      ) : report.name === 'Inventory Item Summary' ? (
        <InventoryItemSummaryViewer />
      ) : report.name === 'GST Returns Workbook' ? (
        <GstReturnsWorkbookViewer />
      ) : report.name === 'Credit Notes' || report.name === 'Credit Note Details'
        || report.name === 'Recurring Invoices' || report.name === 'Recurring Invoice Details'
        || report.name === 'Purchases by Item' || report.name === 'Tax Liability'
        || report.name === 'TDS Summary' || report.name === 'Realized Gain or Loss' ? (
        <ZohoDetailReportViewer />
      ) : (
        <ReportViewer />
      )}
    </div>,
    document.body,
  );
}
