/**
 * VibeDashboard — `/vibe-dashboard`. Jack's one-glance view of the
 * $VIBE economy: ownership, supply, market cap, and the buildathon
 * payout checklist. ("$VIBE dashboard of ownership/supply/market cap
 * — 'claude pls'", from the Notion notes. Done.)
 *
 * Native VibeVerse surface: same navy starfield + glass-panel + mint
 * system as /coin. Every number wears a provenance pill — mint "live"
 * for real reads (Supabase economy tables, GeckoTerminal, Base RPC),
 * amber for the Jul-2026 static snapshot. Nothing here ever hard-
 * crashes on a failed fetch; each card degrades to its marked snapshot.
 */
import { LayoutDashboard } from "lucide-react";
import { HeadlineTiles } from "./HeadlineTiles";
import { MarketCapChart } from "./MarketCapChart";
import { OwnershipCard } from "./OwnershipCard";
import { LedgerFeed } from "./LedgerFeed";
import { PayoutsCard } from "./PayoutsCard";
import {
  useEconomy,
  useMarketCap,
  useTreasuryBalance,
} from "./useVibeDashboardData";

export function VibeDashboard() {
  const { economy, loading } = useEconomy();
  const marketCap = useMarketCap();
  const treasuryBalance = useTreasuryBalance();

  return (
    <div className="relative w-full min-h-[100dvh] bg-black overflow-hidden text-foreground">
      {/* Same deep starfield family as /coin and /space. */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at top, hsl(216 60% 12%) 0%, hsl(220 50% 4%) 70%, #000 100%)",
        }}
      />

      <div className="relative z-10 max-w-5xl mx-auto px-4 md:px-6 pt-28 md:pt-24 pb-12 flex flex-col gap-4">
        {/* Header */}
        <header className="flex flex-col gap-1.5 mb-2">
          <div className="inline-flex items-center gap-2 self-start px-2.5 py-1 rounded-full bg-primary/10 border border-primary/30">
            <LayoutDashboard className="w-3 h-3 text-primary" />
            <span className="text-[10px] uppercase tracking-[0.25em] font-heading font-semibold text-primary">
              $VIBE · Dashboard
            </span>
          </div>
          <h1 className="font-heading text-3xl md:text-4xl font-bold leading-tight tracking-tight">
            Ownership · supply · market cap
          </h1>
          <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
            The state of the $VIBE economy at a glance — live in-app ledger
            reads, on-chain reference points, and the buildathon payout
            checklist. Amber pills mark Jul-2026 snapshot values still
            waiting on a live source
            {loading && " · loading live data…"}
          </p>
        </header>

        {/* 1 · Headline tiles */}
        <HeadlineTiles
          economy={economy}
          marketCap={marketCap}
          treasuryBalance={treasuryBalance}
        />

        {/* 2 · Two-column body on desktop, stacked on mobile */}
        <div className="grid lg:grid-cols-2 gap-4 items-start">
          <div className="flex flex-col gap-4">
            <MarketCapChart />
            <OwnershipCard economy={economy} />
          </div>
          <div className="flex flex-col gap-4">
            <PayoutsCard />
            <LedgerFeed economy={economy} />
          </div>
        </div>

        <footer className="text-[10px] text-muted-foreground/70 text-center pt-2">
          In-app economy reads are public (RLS read-only) · on-chain figures
          reference the canonical $VIBE pool on Base · valuation story lives at{" "}
          <a
            href="https://edgeesmeralda.lovable.app/vibe"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-primary transition-colors"
          >
            edgeesmeralda.lovable.app/vibe
          </a>
        </footer>
      </div>
    </div>
  );
}
