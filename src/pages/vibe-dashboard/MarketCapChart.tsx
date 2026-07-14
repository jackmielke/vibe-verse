/**
 * MarketCapChart — market cap over time, honestly.
 *
 * We only know two points: the ~$1.5M peak and ~$90K as of Jul 2026.
 * So the chart draws exactly two labeled markers joined by a DASHED
 * connector — dashes meaning "path between not recorded", never a
 * fabricated curve. When live history gets indexed (GeckoTerminal
 * OHLCV would do), swap the points array and make the line solid.
 */
import { TrendingDown } from "lucide-react";
import { MARKET_CAP_POINTS } from "./data";
import { DashCard, StaticMarker, fmtUsd } from "./shared";

const W = 560;
const H = 200;
const PAD = { top: 30, right: 30, bottom: 28, left: 48 };
const Y_MAX = 1_600_000;
const GRID = [500_000, 1_000_000, 1_500_000];

const plotW = W - PAD.left - PAD.right;
const plotH = H - PAD.top - PAD.bottom;
const y = (usd: number) => PAD.top + (1 - usd / Y_MAX) * plotH;
// Second point sits at 72% so its value label fits to its right,
// clear of the dashed connector.
const xs = [PAD.left + plotW * 0.16, PAD.left + plotW * 0.72];

export function MarketCapChart() {
  const [peak, now] = MARKET_CAP_POINTS;
  const drop = Math.round((1 - now.usd / peak.usd) * 100);

  return (
    <DashCard
      icon={TrendingDown}
      title="Market cap over time"
      aside={<StaticMarker label="2 known points · Jul 2026" />}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label={`Market cap fell from ${fmtUsd(peak.usd)} at peak to about ${fmtUsd(now.usd)} in July 2026 — a ${drop}% drop. Only these two points are known.`}
      >
        {/* Recessive dotted gridlines + muted axis labels */}
        {GRID.map((g) => (
          <g key={g}>
            <line
              x1={PAD.left} x2={W - PAD.right} y1={y(g)} y2={y(g)}
              stroke="hsl(160 20% 40%)" strokeOpacity={0.25}
              strokeWidth={1} strokeDasharray="2 4"
            />
            <text
              x={PAD.left - 8} y={y(g) + 3} textAnchor="end"
              fontSize={10} fill="hsl(160 15% 60%)"
            >
              {fmtUsd(g)}
            </text>
          </g>
        ))}
        {/* Baseline */}
        <line
          x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)}
          stroke="hsl(160 20% 40%)" strokeOpacity={0.4} strokeWidth={1}
        />

        {/* Dashed connector — unknown path between the two facts */}
        <line
          x1={xs[0]} y1={y(peak.usd)} x2={xs[1]} y2={y(now.usd)}
          stroke="#0D9C6B" strokeWidth={2} strokeDasharray="6 6"
          strokeLinecap="round" opacity={0.75}
        />

        {/* The two known points: 10px markers with a surface ring */}
        {MARKET_CAP_POINTS.map((p, i) => (
          <circle
            key={p.label}
            cx={xs[i]} cy={y(p.usd)} r={5}
            fill="#0D9C6B" stroke="hsl(216 40% 14%)" strokeWidth={2}
          >
            <title>{`${p.label}: ${fmtUsd(p.usd)} (${p.note})`}</title>
          </circle>
        ))}

        {/* Direct value labels beside each mark; the x-axis carries
            the time labels so nothing repeats. */}
        <text x={xs[0] + 12} y={y(peak.usd) + 4} fontSize={12} fontWeight={600}
          fill="hsl(160 100% 92%)">
          {fmtUsd(peak.usd)}
        </text>
        <text x={xs[1] + 12} y={y(now.usd) + 4} fontSize={12} fontWeight={600}
          fill="hsl(160 100% 92%)">
          ≈{fmtUsd(now.usd)}
        </text>
        {/* Drop annotation in the empty space under the connector */}
        <text x={(xs[0] + xs[1]) / 2} y={(y(peak.usd) + y(now.usd)) / 2 + 26}
          textAnchor="middle" fontSize={10} fill="hsl(160 15% 60%)">
          −{drop}% from peak
        </text>

        {/* x labels under each point */}
        {MARKET_CAP_POINTS.map((p, i) => (
          <text
            key={p.label} x={xs[i]} y={H - 8} textAnchor="middle"
            fontSize={10} fill="hsl(160 15% 60%)"
          >
            {p.label}
          </text>
        ))}
      </svg>

      <p className="text-[10px] text-muted-foreground leading-snug">
        Only these two points are actually known — the dashed line means the
        path between them was never recorded, not that the drop was linear.
        Wire GeckoTerminal OHLCV here for real history.
      </p>
    </DashCard>
  );
}
