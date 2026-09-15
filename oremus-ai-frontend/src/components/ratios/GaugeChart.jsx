/**
 * GaugeChart — semicircle gauge (no needle).
 *
 * SVG layout  ViewBox 0 0 230 120
 *   Center    CX=115  CY=108  (arc base near bottom)
 *   Radius    R=78    (stroke centre-line)
 *   Track     TW=22   (stroke-width)
 *
 * Angle convention  (pxy uses y-flip so maths angles work normally)
 *   180° = left (min)    0° = right (max)    90° = top
 *
 * ⚠️  sweep flag must be 1 (SVG-clockwise = screen-clockwise = goes UP first)
 *     Using 0 draws the bottom arc instead of the top arc.
 */

const VW = 230, VH = 120;
const CX = 115, CY = 108;
const R  = 78;
const TW = 22;

function toRad(d) { return d * Math.PI / 180; }
function ff(n)    { return n.toFixed(2); }

/** Polar → SVG XY with y-axis flip so standard maths angles work. */
function pxy(r, deg) {
  const a = toRad(deg);
  return [CX + r * Math.cos(a), CY - r * Math.sin(a)];
}

/** Value → gauge angle (180° = min, 0° = max). */
function vToDeg(v, mn, mx) {
  const t = Math.max(0, Math.min(1, (v - mn) / (mx - mn)));
  return 180 * (1 - t);
}

/**
 * Arc path from startDeg → endDeg going CLOCKWISE (sweep=1).
 * sweep=1 in SVG (y-down) = clockwise on screen = goes UP from left point
 * = draws the TOP semicircle. sweep=0 would draw the bottom — wrong!
 */
function arcPath(r, startDeg, endDeg) {
  const [sx, sy] = pxy(r, startDeg);
  const [ex, ey] = pxy(r, endDeg);
  const large    = Math.abs(startDeg - endDeg) > 180 ? 1 : 0;
  return `M ${ff(sx)} ${ff(sy)} A ${r} ${r} 0 ${large} 1 ${ff(ex)} ${ff(ey)}`;
}

export default function GaugeChart({
  value,
  min   = 0,
  max   = 100,
  benchmarks = [],      // [{ value, label }]
  color = '#10B981',
  fmt   = (v) => v.toFixed(1),
  fmtAxis,
  label,
  formula,
  interpretations = [],
}) {
  const isNull  = value == null || !isFinite(value);
  const clamped = isNull ? min : Math.max(min, Math.min(max, value));
  const valDeg  = vToDeg(clamped, min, max);
  const displayVal = isNull ? 'N/A' : fmt(value);
  const axFmt      = fmtAxis ?? fmt;

  return (
    <div className="bg-white dark:bg-navy-900 rounded-2xl border border-navy-100 dark:border-navy-800 shadow-sm p-5 flex flex-col">
      {/* Title */}
      <p className="text-[13.5px] font-bold text-navy-900 dark:text-white mb-3">
        {label}
      </p>

      <div className="flex items-start gap-4">
        {/* SVG gauge */}
        <svg
          width={VW}
          height={VH}
          viewBox={`0 0 ${VW} ${VH}`}
          className="shrink-0"
          aria-label={label}
        >
          {/* Grey background track — full 180° top semicircle */}
          <path
            d={arcPath(R, 180, 0)}
            fill="none"
            stroke="#CBD5E1"
            strokeWidth={TW}
            className="dark:[stroke:#334155]"
          />

          {/* Coloured value fill */}
          {!isNull && valDeg < 179.5 && (
            <path
              d={arcPath(R, 180, valDeg)}
              fill="none"
              stroke={color}
              strokeWidth={TW}
              strokeLinecap="butt"
            />
          )}

          {/* Benchmark tick marks (white lines crossing the track) */}
          {benchmarks.map(({ value: bv, label: bl }, i) => {
            const deg      = vToDeg(bv, min, max);
            const [x1, y1] = pxy(R - TW / 2 - 2, deg);
            const [x2, y2] = pxy(R + TW / 2 + 2, deg);
            const [lx, ly] = pxy(R + TW / 2 + 14, deg);
            const anchor   = deg > 100 ? 'end' : deg < 80 ? 'start' : 'middle';
            return (
              <g key={i}>
                <line
                  x1={ff(x1)} y1={ff(y1)}
                  x2={ff(x2)} y2={ff(y2)}
                  stroke="white"
                  strokeWidth={2}
                  className="dark:[stroke:#0f172a]"
                />
                <text
                  x={ff(lx)} y={ff(ly)}
                  textAnchor={anchor}
                  dominantBaseline="middle"
                  fontSize={8.5}
                  fill="#64748B"
                  className="dark:fill-slate-400"
                >
                  {bl}
                </text>
              </g>
            );
          })}

          {/* Centre dot — replaces needle, marks the pivot point */}
          <circle
            cx={CX} cy={CY} r={5}
            fill="#CBD5E1"
            className="dark:[fill:#334155]"
          />

          {/* Min label — bottom left */}
          <text
            x={CX - R - 4} y={CY + 7}
            textAnchor="end" fontSize={8} fill="#94A3B8"
          >
            {axFmt(min)}
          </text>

          {/* Max label — bottom right */}
          <text
            x={CX + R + 4} y={CY + 7}
            textAnchor="start" fontSize={8} fill="#94A3B8"
          >
            {axFmt(max)}
          </text>

          {/* Value — large text centred inside the arc */}
          <text
            x={CX} y={CY - 20}
            textAnchor="middle"
            fontSize={24}
            fontWeight="700"
            fill="#0F172A"
            className="dark:fill-white"
          >
            {displayVal}
          </text>
        </svg>

        {/* Formula + interpretation */}
        <div className="flex-1 min-w-0 pt-1 space-y-2">
          <p className="text-[11px] font-bold text-navy-700 dark:text-navy-200 leading-relaxed">
            {formula}
          </p>
          <ul className="space-y-[3px]">
            {interpretations.map((line, i) => (
              <li
                key={i}
                className="text-[10.5px] text-navy-500 dark:text-navy-400 leading-snug"
              >
                {line}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
