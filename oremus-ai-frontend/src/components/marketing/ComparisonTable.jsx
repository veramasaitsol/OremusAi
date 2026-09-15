import { Fragment } from 'react';
import { Check, X } from 'lucide-react';
import { COMPARISON } from './data.js';

function Cell({ value }) {
  if (value === true) return <Check size={18} className="mx-auto text-brand-500" />;
  if (value === false) return <X size={16} className="mx-auto text-navy-300" />;
  return <span className="text-sm font-medium text-navy-700">{value}</span>;
}

// Server component. Horizontally scrollable on mobile so nothing overflows.
export default function ComparisonTable() {
  return (
    <div className="overflow-x-auto scroll-thin rounded-2xl border border-navy-100 bg-white shadow-card">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead>
          <tr className="border-b border-navy-100 bg-navy-50/60">
            <th className="px-5 py-4 text-sm font-semibold text-navy-900">Features</th>
            <th className="px-5 py-4 text-center text-sm font-semibold text-navy-900">Starter</th>
            <th className="px-5 py-4 text-center text-sm font-semibold text-brand-600">Business</th>
            <th className="px-5 py-4 text-center text-sm font-semibold text-navy-900">Enterprise</th>
          </tr>
        </thead>
        <tbody>
          {COMPARISON.map((section) => (
            <Fragment key={section.group}>
              <tr className="bg-navy-50/40">
                <td colSpan={4} className="px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-navy-500">
                  {section.group}
                </td>
              </tr>
              {section.rows.map((row) => (
                <tr key={row.label} className="border-b border-navy-100 last:border-0">
                  <td className="px-5 py-3.5 text-sm text-navy-700">{row.label}</td>
                  <td className="px-5 py-3.5 text-center"><Cell value={row.starter} /></td>
                  <td className="px-5 py-3.5 text-center"><Cell value={row.business} /></td>
                  <td className="px-5 py-3.5 text-center"><Cell value={row.enterprise} /></td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
