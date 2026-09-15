import { Users, Plus, CheckCircle2 } from 'lucide-react';
import Frame from './Frame.jsx';

const CLIENTS = [
  { name: 'Acme Logistics', sector: 'Logistics', provider: 'Zoho Books', connected: true, tone: 'bg-emerald-50 text-emerald-700' },
  { name: 'Northbeam Studio', sector: 'Creative', provider: 'QuickBooks', connected: true, tone: 'bg-blue-50 text-blue-700' },
  { name: 'Vensframe Inc.', sector: 'Software', provider: 'Xero', connected: true, tone: 'bg-cyan-50 text-cyan-700' },
  { name: 'Harbor Retail', sector: 'Retail', provider: 'Connect', connected: false, tone: 'bg-navy-100 text-navy-500' },
];

export default function ClientsMock() {
  return (
    <Frame url="app.oremusai.com/clients">
      <div className="bg-navy-50/40 p-4 lg:p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500 text-white"><Users size={14} /></span>
            <div>
              <p className="text-xs font-bold text-navy-900">Clients</p>
              <p className="text-[10px] text-navy-400">Manage clients & their accounting integrations</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 rounded-md bg-navy-900 px-2.5 py-1.5 text-[10px] font-semibold text-white"><Plus size={11} /> Add client</span>
        </div>

        <div className="overflow-hidden rounded-xl border border-navy-100 bg-white shadow-soft">
          <div className="grid grid-cols-12 border-b border-navy-100 bg-navy-50/60 px-4 py-2 text-[9px] font-bold uppercase tracking-wider text-navy-400">
            <span className="col-span-5">Client</span>
            <span className="col-span-3">Sector</span>
            <span className="col-span-4">Integration</span>
          </div>
          {CLIENTS.map((c) => (
            <div key={c.name} className="grid grid-cols-12 items-center border-b border-navy-100 px-4 py-2.5 last:border-0">
              <div className="col-span-5 flex items-center gap-2.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-cyan-500 text-[10px] font-bold text-white">
                  {c.name.split(' ').map((s) => s[0]).join('').slice(0, 2)}
                </span>
                <p className="text-[11px] font-semibold text-navy-900">{c.name}</p>
              </div>
              <span className="col-span-3 text-[10.5px] text-navy-500">{c.sector}</span>
              <div className="col-span-4">
                {c.connected ? (
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9.5px] font-semibold ${c.tone}`}>
                    <CheckCircle2 size={11} /> {c.provider}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-md border border-brand-200 px-2 py-0.5 text-[9.5px] font-semibold text-brand-600">
                    + {c.provider}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-3 flex gap-3">
          {['Zoho Books', 'QuickBooks', 'Xero'].map((p) => (
            <div key={p} className="flex-1 rounded-lg border border-navy-100 bg-white px-3 py-2 text-center text-[10px] font-semibold text-navy-600 shadow-soft">{p}</div>
          ))}
        </div>
      </div>
    </Frame>
  );
}
