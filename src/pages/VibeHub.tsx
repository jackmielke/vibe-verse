/**
 * VibeHub — `/vibe`. The community-currency hub.
 *
 * Branding: Vibe Coin is "our community currency and asset" — the
 * page leads with that promise. The hero ornament is the iridescent
 * "wink" emblem (lightning eyes + smile) rendered as inline SVG with
 * a holographic stroke and a slow 3D-feeling rotation. Three copies
 * float at varying sizes / orbits for depth.
 *
 * Layout:
 *   - Hero: brand + tagline + drifting wink emblems
 *   - Below: account card + market ticker on the left, holder
 *     leaderboard on the right
 */
import { Sparkles } from "lucide-react";
import VibeAccountCard from "@/components/VibeAccountCard";
import VibeWalletLeaderboard from "@/components/VibeWalletLeaderboard";
import VibeCoinPanel from "@/components/VibeCoinPanel";
import VibeArc from "@/components/VibeArc";

export default function VibeHub() {
  return (
    <div className="relative w-full min-h-[100dvh] bg-black overflow-hidden text-foreground">
      {/* Deep starfield gradient — same family as /space + /lobby so
          this page reads as part of the same world. */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at top, hsl(216 60% 12%) 0%, hsl(220 50% 4%) 70%, #000 100%)",
        }}
      />

      {/* Single column, top-to-bottom reading order. Tighter max-width
          (~720px) so each block has a coherent visual rhythm and
          nothing feels lonely in a half-empty column. */}
      <div className="relative z-10 max-w-[720px] mx-auto px-4 md:px-6 pt-16 md:pt-12 pb-10 flex flex-col gap-8">
        {/* ----- Hero ----- */}
        <section className="flex flex-col items-center text-center gap-5">
          {/* Iridescent arc — smaller (~35% smaller than before) and
              rotating at half speed. Hover to spin it 4× faster. */}
          <div className="relative" style={{ minHeight: 200 }}>
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  "radial-gradient(circle, hsl(150 80% 60% / 0.10) 0%, transparent 60%)",
              }}
            />
            <VibeArc size={182} rotateSeconds={32} />
          </div>

          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-primary/10 border border-primary/30">
            <Sparkles className="w-3 h-3 text-primary" />
            <span className="text-[10px] uppercase tracking-[0.25em] font-heading font-semibold text-primary">
              $VIBE on Base
            </span>
          </div>
          <h1 className="font-heading text-4xl md:text-5xl font-bold leading-tight tracking-tight">
            Our community currency.
          </h1>
          <p className="text-base text-foreground/85 max-w-xl leading-relaxed">
            $VIBE is the asset behind the Edge Esmeralda + Vibe Code Residency
            community — earned by people who ship things, gifted between
            builders, and traded for buildathon prizes. Link your address
            below to show up in the holder list and see your bag live.
          </p>
          <p className="text-sm text-muted-foreground max-w-xl leading-relaxed -mt-2">
            No transactions ever happen from this app. We just read the
            public blockchain so the community can see who's holding and
            how the vibe is doing.
          </p>
        </section>

        {/* ----- Account + Market + Holders, stacked ----- */}
        <VibeAccountCard variant="card" />
        <VibeCoinPanel />
        <VibeWalletLeaderboard defaultVisible={8} maxRows={40} />
      </div>
    </div>
  );
}
