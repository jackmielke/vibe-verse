/**
 * OwnershipCard — who holds the in-app $VIBE.
 *
 * Two views of the same live table:
 *   1. A single 100% split bar — community members vs world agents
 *      (color follows the entity kind, never rank; 2px surface gaps).
 *   2. A ranked bar list of the top holders, thin 8px marks with
 *      4px rounded data-ends and direct labels (name left, VIBE right).
 *
 * Agent wallets show their public agent name; user wallets are
 * anonymized to short refs because the `users` table is not
 * anon-readable — that's an RLS choice, not a bug.
 */
import { PieChart } from "lucide-react";
import { CHART_COLORS, FALLBACK_HOLDERS, JACK_ALLOCATION_NOTE } from "./data";
import type { EconomySnapshot } from "./useVibeDashboardData";
import { DashCard, LiveMarker, StaticMarker, fmtVibeAmount } from "./shared";

const TOP_N = 8;

export function OwnershipCard({ economy }: { economy: EconomySnapshot | null }) {
  const holders = economy?.holders ?? FALLBACK_HOLDERS;
  const live = economy != null;

  const total = holders.reduce((s, h) => s + h.balance, 0) || 1;
  const userTotal = holders.filter((h) => h.ownerKind === "user").reduce((s, h) => s + h.balance, 0);
  const agentTotal = total - userTotal;
  const userPct = Math.round((userTotal / total) * 100);

  const top = holders.slice(0, TOP_N);
  const max = top[0]?.balance ?? 1;

  return (
    <DashCard
      icon={PieChart}
      title="Ownership · in-app wallets"
      aside={live ? <LiveMarker /> : <StaticMarker label="snapshot · Jul 2026" />}
    >
      {/* Split bar: members vs agents. 2px gap between segments. */}
      <div>
        <div className="flex h-3 rounded-full overflow-hidden" role="img"
          aria-label={`Members hold ${userPct}% of in-app VIBE, agents ${100 - userPct}%`}>
          <div
            className="rounded-l-full"
            style={{ width: `${userPct}%`, background: CHART_COLORS.user, marginRight: 2 }}
            title={`Members · ${fmtVibeAmount(userTotal)} VIBE (${userPct}%)`}
          />
          <div
            className="flex-1 rounded-r-full"
            style={{ background: CHART_COLORS.agent }}
            title={`Agents · ${fmtVibeAmount(agentTotal)} VIBE (${100 - userPct}%)`}
          />
        </div>
        {/* Legend + direct labels — identity is never color-alone. */}
        <div className="flex items-center gap-4 mt-2 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: CHART_COLORS.user }} />
            Members · {userPct}%
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: CHART_COLORS.agent }} />
            World agents · {100 - userPct}%
          </span>
        </div>
      </div>

      {/* Top holders, ranked. Thin marks, direct labels, no y-axis. */}
      <div className="flex flex-col gap-2">
        {top.map((h, i) => (
          <div
            key={`${h.ownerKind}-${h.ownerRef}`}
            className="grid grid-cols-[1.25rem_minmax(7rem,10rem)_1fr_auto] items-center gap-2 group"
            title={`${h.name} · ${h.balance.toLocaleString()} VIBE`}
          >
            <span className="font-mono text-[10px] text-muted-foreground tabular-nums text-center">
              {i + 1}
            </span>
            <span className="text-xs font-heading font-semibold text-foreground truncate">
              {h.name}
            </span>
            <div className="h-2 rounded-r-[4px] transition-opacity group-hover:opacity-80"
              style={{
                width: `${Math.max(2, (h.balance / max) * 100)}%`,
                background: CHART_COLORS[h.ownerKind],
              }}
            />
            <span className="font-mono text-[11px] text-foreground/85 tabular-nums">
              {fmtVibeAmount(h.balance)}
            </span>
          </div>
        ))}
        {holders.length > TOP_N && (
          <p className="text-[10px] text-muted-foreground">
            + {holders.length - TOP_N} more wallets ·{" "}
            {fmtVibeAmount(holders.slice(TOP_N).reduce((s, h) => s + h.balance, 0))} VIBE
          </p>
        )}
      </div>

      {/* On-chain footnote — separate world from the in-app ledger. */}
      <div className="rounded-lg border border-border/60 bg-background/30 px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[10px] text-muted-foreground">
          On-chain: {JACK_ALLOCATION_NOTE} · treasury split not yet indexed here
        </p>
        <StaticMarker />
      </div>
    </DashCard>
  );
}
