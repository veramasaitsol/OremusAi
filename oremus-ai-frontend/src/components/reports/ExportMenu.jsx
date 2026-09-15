// Dropdown that exports the currently-open report to CSV or Excel. Reads the
// transformed report data + open-report meta straight from Redux so every
// viewer (Zoho / QuickBooks / Xero) can drop it in with its own trigger button
// and keep its exact styling. No-op (disabled-looking) when no data is loaded.

import { useSelector } from 'react-redux';
import { FileText, FileSpreadsheet, FileType } from 'lucide-react';
import Popover from '../ui/Popover.jsx';
import { selectReportData, selectOpenReport } from '../../features/reports/reportsSlice.js';
import { exportReportCSV, exportReportXLSX, exportReportPDF } from '../../utils/exportReport.js';
import { exportReportFile } from '../../features/reports/reportsAPI.js';

function MenuItem({ icon: Icon, label, sub, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-2.5 py-2 rounded-md flex items-start gap-2.5 hover:bg-navy-50 dark:hover:bg-navy-800 transition"
    >
      <Icon size={15} className="mt-0.5 text-brand-600 dark:text-brand-300 shrink-0" />
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold text-navy-800 dark:text-navy-100">{label}</span>
        <span className="block text-[11px] text-navy-500">{sub}</span>
      </span>
    </button>
  );
}

export default function ExportMenu({ trigger, meta }) {
  const data = useSelector(selectReportData);
  const report = useSelector(selectOpenReport);
  const name = report?.name || 'Report';

  // Generate the file on the backend; fall back to the in-browser exporter if
  // the API is unreachable so export never silently fails.
  const serverExport = async (format) => {
    try {
      await exportReportFile({ data, reportName: name, format, meta: meta || {} });
    } catch (e) {
      console.warn(`[ExportMenu] server ${format} export failed, using local fallback:`, e?.message);
      if (format === 'pdf') exportReportPDF(data, name, meta || {});
      else exportReportXLSX(data, name);
    }
  };

  return (
    <Popover width={208} align="end" trigger={trigger}>
      {({ close }) => (
        <div className="flex flex-col gap-0.5">
          <div className="px-2.5 pt-1 pb-1.5 text-[10px] uppercase tracking-wider text-navy-400 font-semibold">
            Export
          </div>
          <MenuItem
            icon={FileText}
            label="CSV (.csv)"
            sub="Comma-separated values"
            onClick={() => { exportReportCSV(data, name); close(); }}
          />
          <MenuItem
            icon={FileSpreadsheet}
            label="Excel (.xlsx)"
            sub="Microsoft Excel workbook"
            onClick={() => { serverExport('xlsx'); close(); }}
          />
          <MenuItem
            icon={FileType}
            label="PDF (.pdf)"
            sub="Download as PDF"
            onClick={() => { serverExport('pdf'); close(); }}
          />
        </div>
      )}
    </Popover>
  );
}
