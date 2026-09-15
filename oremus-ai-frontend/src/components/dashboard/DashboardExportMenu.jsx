// Export dropdown for the Overview dashboard. Flattens the live dashboard state
// (summary · KPIs · top customers/vendors · expense mix · monthly trend) into
// the shared { columns, rows, currency } report shape and reuses the in-browser
// XLSX / PDF exporters so the dashboard can be downloaded like any report.

import { FileSpreadsheet, FileType, Download } from 'lucide-react';
import Popover from '../ui/Popover.jsx';
import Button from '../ui/Button.jsx';
import { exportReportXLSX, exportReportPDF } from '../../utils/exportReport.js';

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

// Build the { columns, rows, currency } shape consumed by the exporters.
function buildExport(dash, currencyFallback) {
  const rs = dash?.rawStats || {};
  const currency = rs.currency || currencyFallback || 'INR';
  const columns = [
    { key: 'label', label: 'Metric' },
    { key: 'value', label: 'Value', align: 'right' },
  ];
  const rows = [];
  const head = (label) => rows.push({ label, level: 0, isHeader: true, cells: {} });
  const row  = (label, value) => rows.push({ label, level: 1, cells: { value: value == null ? '' : value } });

  head('Summary');
  const netProfit = (rs.totalRevenue || 0) - (rs.totalExpenses || 0);
  row('Total Revenue', rs.totalRevenue);
  row('Total Expenses', rs.totalExpenses);
  row('Net Profit', netProfit);
  row('Outstanding Receivables', rs.outstandingReceivables);
  row('Payments Received', rs.totalPayments);
  row('Invoices', rs.totalInvoices);
  row('Customers', rs.totalCustomers);

  if (dash?.kpis?.length) {
    head('Key Metrics');
    dash.kpis.forEach((k) => row(k.label, k.value));
  }
  if (dash?.topCustomers?.length) {
    head('Top Customers');
    dash.topCustomers.forEach((c) => row(c.name || 'Unnamed', c.amount));
  }
  if (dash?.topVendors?.length) {
    head('Top Vendors');
    dash.topVendors.forEach((v) => row(v.name || 'Unnamed', v.amount));
  }
  if (dash?.expenseMix?.length) {
    head('Expense Mix (% of spend)');
    dash.expenseMix.forEach((e) => row(e.name || 'Other', e.value));
  }
  // revExp values are stored in ₹thousands → scale back to actual amounts.
  if (dash?.revExp?.length) {
    head('Monthly Revenue');
    dash.revExp.forEach((d) => row(d.m, (d.rev || 0) * 1000));
    head('Monthly Expenses');
    dash.revExp.forEach((d) => row(d.m, (d.exp || 0) * 1000));
    head('Monthly Profit');
    dash.revExp.forEach((d) => row(d.m, (d.profit || 0) * 1000));
  }
  return { columns, rows, currency };
}

export default function DashboardExportMenu({ dash, reportName = 'Dashboard', meta = {}, disabled = false }) {
  const run = (format) => {
    const data = buildExport(dash, meta.currency);
    if (!data.rows.length) return;
    if (format === 'pdf') exportReportPDF(data, reportName, meta);
    else exportReportXLSX(data, reportName);
  };

  const trigger = (
    <Button variant="secondary" icon={Download} disabled={disabled}>Export</Button>
  );

  return (
    <Popover width={216} align="end" trigger={trigger}>
      {({ close }) => (
        <div className="flex flex-col gap-0.5">
          <div className="px-2.5 pt-1 pb-1.5 text-[10px] uppercase tracking-wider text-navy-400 font-semibold">
            Export dashboard
          </div>
          <MenuItem
            icon={FileSpreadsheet}
            label="Excel (.xlsx)"
            sub="Microsoft Excel workbook"
            onClick={() => { run('xlsx'); close(); }}
          />
          <MenuItem
            icon={FileType}
            label="PDF (.pdf)"
            sub="Download / print as PDF"
            onClick={() => { run('pdf'); close(); }}
          />
        </div>
      )}
    </Popover>
  );
}
