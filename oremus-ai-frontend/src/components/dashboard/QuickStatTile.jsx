import * as Icons from 'lucide-react';
import Tile from './Tile.jsx';
import CountUpValue from './CountUpValue.jsx';

export default function QuickStatTile({ label, value, sub, accent = '#2563EB', icon }) {
  const Icon = icon ? Icons[icon] || Icons.Circle : null;
  return (
    <Tile padding="p-4" className="h-full">
      <div className="flex items-center gap-3">
        {Icon && (
          <div
            className="w-10 h-10 rounded-lg grid place-items-center shrink-0"
            style={{ background: accent + '18', color: accent }}
          >
            <Icon size={16} />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-navy-500">{label}</div>
          <div className="text-[clamp(13px,1.2vw,17px)] font-bold tabular-nums text-navy-900 dark:text-white leading-tight truncate">
            <CountUpValue value={value} />
          </div>
          {sub && <div className="text-[10.5px] text-navy-500 mt-0.5 truncate">{sub}</div>}
        </div>
      </div>
    </Tile>
  );
}
