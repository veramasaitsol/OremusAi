import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import Tile from './Tile.jsx';
import Badge from '../ui/Badge.jsx';
import CountUpValue from './CountUpValue.jsx';
import { fmt, fmtMoneyCompact } from '../../utils/fmt.js';

const AxisStyle = { fontSize: 10, fill: 'currentColor', fillOpacity: 0.55 };

export default function CashFlowTile({ data = [] }) {
  const net     = data.reduce((s, d) => s + (d.inflow || 0) - (d.outflow || 0), 0);
  const netFmt  = net === 0 ? fmt(0) : `${net >= 0 ? '+' : ''}${fmt(net * 1000)}`;
  const netTone = net >= 0 ? 'green' : 'red';
  return (
    <Tile padding="p-4" className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-[11.5px] font-bold uppercase tracking-[0.14em] text-navy-500">Cash flow</div>
          <div className="text-[10.5px] text-navy-500">Inflow vs outflow · period</div>
        </div>
        {data.length > 0 && <Badge tone={netTone} dot><CountUpValue value={netFmt} /> net</Badge>}
      </div>
      <div className="flex-1 min-h-[140px] -mx-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
            <XAxis dataKey="m" tick={AxisStyle} axisLine={false} tickLine={false} />
            <YAxis tick={AxisStyle} axisLine={false} tickLine={false} tickFormatter={(v) => fmtMoneyCompact(v * 1000)} />
            <Tooltip
              contentStyle={{
                borderRadius: 8,
                border: '1px solid rgba(100,116,139,0.2)',
                fontSize: 11.5,
                background: 'rgba(255,255,255,0.97)',
                color: '#0F172A',
              }}
              formatter={(v) => fmt(v * 1000)}
            />
            <Bar isAnimationActive={false} dataKey="inflow"  fill="#10B981" radius={[3, 3, 0, 0]} barSize={7} />
            <Bar isAnimationActive={false} dataKey="outflow" fill="#EF4444" radius={[3, 3, 0, 0]} barSize={7} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Tile>
  );
}
