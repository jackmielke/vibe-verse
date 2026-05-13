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

      <div className="relative z-10 max-w-6xl mx-auto px-4 md:px-8 pt-16 md:pt-12 pb-10 flex flex-col gap-8">
        {/* ----- Hero ----- */}
        <section className="grid md:grid-cols-[1.4fr_1fr] gap-6 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-primary/10 border border-primary/30 mb-3">
              <Sparkles className="w-3 h-3 text-primary" />
              <span className="text-[10px] uppercase tracking-[0.25em] font-heading font-semibold text-primary">
                $VIBE on Base
              </span>
            </div>
            <h1 className="font-heading text-4xl md:text-5xl font-bold leading-tight tracking-tight">
              Our community currency.
            </h1>
            <p className="mt-3 text-base text-foreground/85 max-w-xl leading-relaxed">
              $VIBE is the asset behind the Edge Esmeralda + Vibe Code Residency
              community — earned by people who ship things, gifted between
              builders, and traded for buildathon prizes. Link your address
              below to show up in the holder list and see your bag live.
            </p>
            <p className="mt-2 text-sm text-muted-foreground max-w-xl leading-relaxed">
              No transactions ever happen from this app. We just read the
              public blockchain so the community can see who's holding and
              how the vibe is doing.
            </p>
          </div>

          {/* Iridescent arc — same Meshy GLB from /space, rendered
              with its own RoomEnvironment so the PBR shimmer reads
              correctly. Slow Y rotation + gentle bob. */}
          <div
            className="relative flex items-center justify-center md:justify-end"
            style={{ minHeight: 280 }}
          >
            {/* Soft mint halo so the arc has a glow well even in
                stretches of its rotation where it's edge-on. */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  "radial-gradient(circle, hsl(150 80% 60% / 0.10) 0%, transparent 60%)",
              }}
            />
            <VibeArc size={280} rotateSeconds={16} />
          </div>
        </section>

        {/* ----- Functional grid ----- */}
        <section className="grid md:grid-cols-[1fr_1fr] gap-5 items-start">
          {/* Left: account + live market */}
          <div className="flex flex-col gap-5">
            <VibeAccountCard variant="card" />
            <VibeCoinPanel />
          </div>
          {/* Right: holder leaderboard */}
          <div className="flex flex-col gap-5">
            <VibeWalletLeaderboard defaultVisible={8} maxRows={40} />
          </div>
        </section>
      </div>
    </div>
  );
}
