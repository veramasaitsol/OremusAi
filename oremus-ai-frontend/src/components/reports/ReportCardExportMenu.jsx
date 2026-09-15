// Export dropdown for a single report CARD (the grid). Unlike ExportMenu (which
// exports the already-open report from Redux), this fetches the report's data on
// demand — so a report can be exported straight from its card without opening it
// first. Excel + PDF go through the backend API and fall back to the in-browser
// exporters; CSV stays client-side. Mirrors the viewer's ExportMenu styling.

import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Download, FileText, FileSpreadsheet, FileType, Loader2 } from 'lucide-react';
import Popover from '../ui/Popover.jsx';
import { fetchReportForExport, selectProvider, selectFilters } from '../../features/reports/reportsSlice.js';
import { selectActiveClient } from '../../features/clients/clientsSlice.js';
import { exportReportCSV, exportReportXLSX, exportReportPDF } from '../../utils/exportReport.js';
import { exportReportFile } from '../../features/reports/reportsAPI.js';

function MenuItem({ icon: Icon, label, sub, onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full text-left px-2.5 py-2 rounded-md flex items-start gap-2.5 hover:bg-navy-50 dark:hover:bg-navy-800 transition disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <Icon size={15} className="mt-0.5 text-brand-600 dark:text-brand-300 shrink-0" />
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold text-navy-800 dark:text-navy-100">{label}</span>
        <span className="block text-[11px] text-navy-500">{sub}</span>
      </span>
    </button>
  );
}

export default function ReportCardExportMenu({ report }) {
  const dispatch = useDispatch();
  const provider = useSelector(selectProvider);
  const client = useSelector(selectActiveClient);
  const filters = useSelector(selectFilters);
  const [busy, setBusy] = useState(false);

  const name = report?.name || 'Report';
  const meta = {
    company: client?.name,
    basis: filters?.basis === 'cash' ? 'Cash' : 'Accrual',
  };

  // Fetch the report's data for the active client/provider/period.
  const loadData = async () => {
    return dispatch(
      fetchReportForExport({ reportName: name, clientId: client?.id, provider: report?.provider || provider }),
    ).unwrap();
  };

  const run = async (format, close) => {
    if (busy) return;
    setBusy(true);
    try {
      const data = await loadData();
      if (format === 'csv') {
        exportReportCSV(data, name);
      } else {
        // Server-side render (real .xlsx / .pdf); fall back to in-browser export.
        try {
          await exportReportFile({ data, reportName: name, format, meta });
        } catch (e) {
          console.warn(`[ReportCardExportMenu] server ${format} export failed, using local fallback:`, e?.message);
          if (format === 'pdf') exportReportPDF(data, name, meta);
          else exportReportXLSX(data, name);
        }
      }
    } catch (e) {
      console.error(`[ReportCardExportMenu] export failed for '${name}':`, e?.message);
    } finally {
      setBusy(false);
      close?.();
    }
  };

  const trigger = (
    <button
      type="button"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-navy-500 hover:text-navy-800 dark:hover:text-white"
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Export
    </button>
  );

  return (
    <Popover width={208} align="end" trigger={trigger}>
      {({ close }) => (
        <div className="flex flex-col gap-0.5">
          <div className="px-2.5 pt-1 pb-1.5 text-[10px] uppercase tracking-wider text-navy-400 font-semibold">
            Export {busy ? '…' : ''}
          </div>
          <MenuItem
            icon={FileText}
            label="CSV (.csv)"
            sub="Comma-separated values"
            disabled={busy}
            onClick={() => run('csv', close)}
          />
          <MenuItem
            icon={FileSpreadsheet}
            label="Excel (.xlsx)"
            sub="Microsoft Excel workbook"
            disabled={busy}
            onClick={() => run('xlsx', close)}
          />
          <MenuItem
            icon={FileType}
            label="PDF (.pdf)"
            sub="Download as PDF"
            disabled={busy}
            onClick={() => run('pdf', close)}
          />
        </div>
      )}
    </Popover>
  );
}
