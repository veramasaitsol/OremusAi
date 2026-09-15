import * as Icons from 'lucide-react';
import Tile from './Tile.jsx';
import Badge from '../ui/Badge.jsx';

const TONE = {
  red: { bg: 'bg-red-100 dark:bg-red-500/15', text: 'text-red-700 dark:text-red-400' },
  amber: { bg: 'bg-amber-100 dark:bg-amber-500/15', text: 'text-amber-700 dark:text-amber-400' },
  green: { bg: 'bg-emerald-100 dark:bg-emerald-500/15', text: 'text-emerald-700 dark:text-emerald-400' },
};

export default function ComplianceTile({ items = [] }) {
  const dueSoon = items.filter((c) => c.tone === 'amber' || c.tone === 'red').length;
  return (
    <Tile padding="p-4" className="h-full">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11.5px] font-bold uppercase tracking-[0.14em] text-navy-500">Compliance</div>
        {dueSoon > 0 && <Badge tone="amber">{dueSoon} due soon</Badge>}
      </div>
      {items.length === 0 ? (
        <div className="flex items-center justify-center py-6">
          <p className="text-[12px] text-navy-400">No compliance items</p>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {items?.slice(0, 5).map((c) => {
            const T = TONE[c.tone] || TONE.amber;
            const Icon = Icons[c.icon] || Icons.AlertCircle;
            return (
              <li key={c.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-navy-50 dark:hover:bg-navy-800/40">
                <div className={`w-7 h-7 rounded-md ${T.bg} ${T.text} grid place-items-center shrink-0`}>
                  <Icon size={12} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-semibold text-navy-900 dark:text-white truncate">{c.title}</div>
                  <div className={`text-[10.5px] font-semibold ${T.text}`}>{c.due}</div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Tile>
  );
}
