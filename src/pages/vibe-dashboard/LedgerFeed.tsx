/**
 * LedgerFeed — supply & flow. The most recent vibe_ledger entries:
 * treasury mints (starter grants, game rewards) and wallet-to-wallet
 * flows (tips, items, services, bounties), amounts + relative time.
 */
import {
  ArrowRightLeft,
  Gamepad2,
  Gift,
  HandCoins,
  ScrollText,
  ShoppingBag,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FALLBACK_LEDGER, type LedgerRow } from "./data";
import type { EconomySnapshot } from "./useVibeDashboardData";
import { DashCard, LiveMarker, StaticMarker, timeAgo } from "./shared";

const REASON_META: Record<string, { icon: LucideIcon; label: string }> = {
  starter: { icon: Sparkles, label: "mint · starter grant" },
  game_reward: { icon: Gamepad2, label: "mint · game reward" },
  tip: { icon: HandCoins, label: "tip" },
  service: { icon: Gift, label: "service" },
  item: { icon: ShoppingBag, label: "item" },
  bounty: { icon: HandCoins, label: "bounty payout" },
};

function Row({ entry }: { entry: LedgerRow }) {
  const meta = REASON_META[entry.reason] ?? { icon: ArrowRightLeft, label: entry.reason };
  const Icon = meta.icon;
  const isMint = entry.fromKind === "system";
  return (
    <li className="flex items-center gap-3 rounded-lg border border-border/40 bg-background/30 px-3 py-2">
      <span className="w-7 h-7 rounded-full bg-primary/15 border border-primary/25 flex items-center justify-center shrink-0">
        <Icon className="w-3.5 h-3.5 text-primary" />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-foreground truncate">
          <span className="font-heading font-semibold">{meta.label}</span>
          <span className="text-muted-foreground"> → {entry.toName}</span>
        </p>
        {entry.memo && (
          <p className="text-[10px] text-muted-foreground truncate">{entry.memo}</p>
        )}
      </div>
      <div className="text-right shrink-0">
        <p className="font-mono text-xs font-semibold text-primary tabular-nums">
          {isMint ? "+" : ""}
          {entry.amount.toLocaleString()} <span className="text-[9px]">VIBE</span>
        </p>
        <p className="text-[9px] text-muted-foreground">{timeAgo(entry.createdAt)}</p>
      </div>
    </li>
  );
}

export function LedgerFeed({ economy }: { economy: EconomySnapshot | null }) {
  const ledger = economy?.ledger ?? FALLBACK_LEDGER;
  const live = economy != null;
  return (
    <DashCard
      icon={ScrollText}
      title="Supply & flow · recent ledger"
      aside={live ? <LiveMarker /> : <StaticMarker label="snapshot · Jul 2026" />}
    >
      {ledger.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No ledger activity yet — the feed fills in as the economy moves.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {ledger.map((e) => (
            <Row key={e.id} entry={e} />
          ))}
        </ul>
      )}
      <p className="text-[9px] text-muted-foreground/70">
        Mints come from the system treasury; everything else is wallet → wallet.
      </p>
    </DashCard>
  );
}
