import * as Icons from 'lucide-react';
import Tile from './Tile.jsx';

const ICON_BG = {
  blue:   'bg-brand-100 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400',
  green:  'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400',
  amber:  'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
  purple: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400',
  navy:   'bg-navy-100 text-navy-600 dark:bg-navy-800 dark:text-navy-300',
};

export default function ActivityTile({ items = [], onViewLog }) {
  return (
    <Tile padding="p-4" className="h-full">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11.5px] font-bold uppercase tracking-[0.14em] text-navy-500">Recent activity</div>
        <button onClick={onViewLog} className="text-[10.5px] font-semibold text-brand-600 hover:underline">View log →</button>
      </div>
      {items.length === 0 ? (
        <div className="flex items-center justify-center py-8">
          <p className="text-[12px] text-navy-400">No recent activity</p>
        </div>
      ) : (
        <ol className="relative ml-1 border-l border-navy-200 dark:border-navy-800 space-y-3">
          {items.map((a, i) => {
            const Icon = Icons[a.icon] || Icons.Circle;
            return (
              <li key={i} className="pl-4 relative">
                <span className={`absolute -left-[11px] top-0 w-5 h-5 rounded-md ring-4 ring-white dark:ring-navy-900 grid place-items-center ${ICON_BG[a.tone]}`}>
                  <Icon size={10} />
                </span>
                <div className="text-[11.5px] text-navy-900 dark:text-white leading-tight">
                  <span className="font-bold">{a.who}</span>{' '}
                  <span className="text-navy-500">{a.what}</span>
                </div>
                <div className="text-[11px] font-semibold text-navy-700 dark:text-navy-200 truncate mt-0.5">{a.target}</div>
                <div className="text-[10px] text-navy-400 mt-0.5">{a.t} ago</div>
              </li>
            );
          })}
        </ol>
      )}
    </Tile>
  );
}
