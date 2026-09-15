import { Table } from 'lucide-react';
import ReportChart from './ReportChart.jsx';

/**
 * Tiny preview chart used inside the view sidebar buttons.
 * Reuses the same Recharts wrapper in `compact` mode.
 */
export default function MiniReportChart({ kind, data }) {
  if (!data) {
    return (
      <div className="w-full h-full grid place-items-center text-navy-300">
        <Table size={16} />
      </div>
    );
  }
  if (kind === 'table') {
    return (
      <div className="w-full h-full grid place-items-center text-navy-400">
        <Table size={18} />
      </div>
    );
  }
  return (
    <div className="w-full h-full pointer-events-none">
      <ReportChart kind={kind} data={data} height={56} compact />
    </div>
  );
}
