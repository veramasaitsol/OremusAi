import ReportsHeader from '../ReportsHeader.jsx';
import ReportCategorySidebar from '../ReportCategorySidebar.jsx';
import ReportsGrid from '../ReportsGrid.jsx';
import ReportViewerModal from '../ReportViewerModal.jsx';

// Default card-grid layout used by Zoho Reports — kept identical to the
// previous look of the unified Reports module so existing users see no
// regression when they land on /reports/zoho.
export default function ZohoReportsLayout() {
  return (
    <div className="p-6 lg:p-7 max-w-[1600px] mx-auto">
      <ReportsHeader />

      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-4 mt-5">
        <ReportCategorySidebar />
        <ReportsGrid />
      </div>

      <ReportViewerModal />

      <div className="mt-6 text-center text-[11px] text-navy-400">
        Reports · powered by your live ledger
      </div>
    </div>
  );
}
