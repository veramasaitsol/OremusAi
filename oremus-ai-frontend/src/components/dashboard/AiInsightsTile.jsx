import * as Icons from 'lucide-react';
import { Sparkles } from 'lucide-react';
import Tile from './Tile.jsx';
import Badge from '../ui/Badge.jsx';

const ICON_BG = {
  green: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-300',
  amber: 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-300',
  blue:  'bg-brand-100 text-brand-600 dark:bg-brand-500/20 dark:text-brand-300',
};

export default function AiInsightsTile({ items = [], onAsk }) {
  return (
    <Tile padding="p-4" className="h-full">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-brand-500 to-cyan-500 text-white grid place-items-center">
            <Sparkles size={13} />
          </div>
          <div>
            <div className="text-[12px] font-bold text-navy-900 dark:text-white">Oremus AI</div>
            <div className="text-[10px] text-navy-500">{items.length} insights for this period</div>
          </div>
        </div>
        <button onClick={onAsk} className="text-[10.5px] font-semibold text-brand-600 hover:underline">Ask →</button>
      </div>
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <div className="w-10 h-10 rounded-full bg-brand-50 dark:bg-brand-500/10 grid place-items-center mb-3">
            <Sparkles size={18} className="text-brand-400" />
          </div>
          <p className="text-[12px] font-medium text-navy-600 dark:text-navy-400">No insights yet</p>
          <p className="text-[11px] text-navy-400 mt-1 max-w-[180px]">Connect Zoho Books and sync data to generate AI insights.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {items.map((ins, i) => {
            const Icon = Icons[ins.icon] || Icons.Lightbulb;
            const badgeTone = ins.tone === 'amber' ? 'amber' : ins.tone === 'green' ? 'green' : 'blue';
            return (
              <div key={i} className="rounded-lg border border-navy-100 dark:border-navy-800 bg-navy-50/50 dark:bg-navy-800/30 p-3">
                <div className="flex items-start gap-2">
                  <div className={`w-6 h-6 rounded-md grid place-items-center shrink-0 ${ICON_BG[ins.tone]}`}>
                    <Icon size={11} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <Badge tone={badgeTone} className="!text-[9px]">{ins.tag}</Badge>
                    </div>
                    <div className="text-[12px] font-semibold text-navy-900 dark:text-white leading-tight">{ins.title}</div>
                    <p className="text-[11px] text-navy-600 dark:text-navy-400 mt-1 leading-snug">{ins.body}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Tile>
  );
}
