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
import VibeWink from "@/components/VibeWink";

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

          {/* Floating wink emblems — three copies at different sizes,
              phases, and orbits so they read as drifting in space.
              Pure SVG + CSS, very light. */}
          <div
            className="relative flex items-center justify-center md:justify-end"
            style={{ minHeight: 280 }}
          >
            <div className="absolute" style={{ top: "8%", left: "12%", opacity: 0.45 }}>
              <VibeWink size={90} speed={0.65} phase={1.4} />
            </div>
            <div className="absolute" style={{ top: "62%", left: "70%", opacity: 0.55 }}>
              <VibeWink size={70} speed={1.3} phase={3.1} />
            </div>
            <VibeWink size={240} speed={0.9} />
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
