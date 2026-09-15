import { Shield, Users, Activity, CheckCircle2, Server, Database } from 'lucide-react';
import Frame from './Frame.jsx';

const USERS = [
  { name: 'Maya Sharma', email: 'maya@oremus.com', role: 'Admin', tone: 'bg-brand-50 text-brand-700' },
  { name: 'Acme Logistics', email: 'finance@acme.in', role: 'Client', tone: 'bg-navy-100 text-navy-600' },
  { name: 'Northbeam Studio', email: 'ops@northbeam.io', role: 'Client', tone: 'bg-navy-100 text-navy-600' },
  { name: 'Daniel Okoye', email: 'daniel@oremus.com', role: 'Admin', tone: 'bg-brand-50 text-brand-700' },
];

const HEALTH = [
  { icon: Server, label: 'API uptime', value: '99.99%' },
  { icon: Database, label: 'Sync jobs', value: '1,791 ok' },
  { icon: Activity, label: 'Active sessions', value: '42' },
];

export default function AdminMock() {
  return (
    <Frame url="app.oremusai.com/admin">
      <div className="bg-navy-50/40 p-4 lg:p-5">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-navy-900 text-white"><Shield size={14} /></span>
          <div>
            <p className="text-xs font-bold text-navy-900">Admin Console</p>
            <p className="text-[10px] text-navy-400">Workspace administration · role-based access</p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {HEALTH.map((h) => (
            <div key={h.label} className="rounded-xl border border-navy-100 bg-white p-3 shadow-soft">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-50 text-brand-600"><h.icon size={13} /></span>
              <p className="mt-2 text-sm font-bold text-navy-900">{h.value}</p>
              <p className="text-[10px] text-navy-400">{h.label}</p>
            </div>
          ))}
        </div>

        <div className="mt-3 rounded-xl border border-navy-100 bg-white p-4 shadow-soft">
          <div className="mb-3 flex items-center justify-between">
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-navy-700"><Users size={13} /> Users & roles</p>
            <span className="rounded-md bg-brand-500 px-2 py-1 text-[10px] font-semibold text-white">+ Invite</span>
          </div>
          <div className="space-y-1.5">
            {USERS.map((u) => (
              <div key={u.email} className="flex items-center justify-between rounded-lg border border-navy-100 px-3 py-2">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-cyan-500 text-[10px] font-bold text-white">
                    {u.name.split(' ').map((s) => s[0]).join('').slice(0, 2)}
                  </span>
                  <div>
                    <p className="text-[11px] font-semibold text-navy-900">{u.name}</p>
                    <p className="text-[9.5px] text-navy-400">{u.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[9.5px] font-semibold ${u.tone}`}>{u.role}</span>
                  <CheckCircle2 size={13} className="text-emerald-500" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Frame>
  );
}
