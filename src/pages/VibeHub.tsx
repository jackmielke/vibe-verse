/**
 * VibeHub — `/vibe`. The community-currency hub.
 *
 * Branding: Vibe Coin is "our community currency and asset" — the
 * page leads with that promise and uses the same robot avatar from
 * /space (rendered live via VibeyOrbit) so it feels continuous with
 * the rest of the world.
 *
 * Layout:
 *   - Hero: brand + tagline + live Vibey orbit ornament
 *   - Below: account card + market ticker on the left, holder
 *     leaderboard on the right
 *
 * Components below are all reusable — drop them into any other
 * surface if you want a smaller hub elsewhere.
 */
import { Link } from "react-router-dom";
import { ArrowLeft, Coins, Sparkles } from "lucide-react";
import VibeAccountCard from "@/components/VibeAccountCard";
import VibeWalletLeaderboard from "@/components/VibeWalletLeaderboard";
import VibeCoinPanel from "@/components/VibeCoinPanel";
import VibeyOrbit from "@/components/VibeyOrbit";

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

      <div className="relative z-10 max-w-6xl mx-auto px-4 md:px-8 pt-16 md:pt-10 pb-10 flex flex-col gap-8">
        {/* Top sub-strip — clears the GlobalNav on mobile */}
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to="/"
            className="glass-panel rounded-full px-3 py-2 flex items-center gap-2 hover:bg-muted transition-colors"
          >
            <ArrowLeft className="w-4 h-4 text-primary" />
            <span className="text-[11px] font-heading font-semibold tracking-widest uppercase">
              Back to village
            </span>
          </Link>
          <div className="glass-panel rounded-full px-3 py-2 flex items-center gap-2">
            <Coins className="w-4 h-4 text-primary" />
            <span className="text-[11px] font-heading font-semibold tracking-widest uppercase text-primary">
              VIBE Coin
            </span>
          </div>
        </div>

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
              public blockchain so Vibey can see who's holding and how the
              vibe is doing.
            </p>
          </div>

          {/* Live Vibey ornament — slowly orbits + plays Idle. Same
              robot as /space so the brand is continuous. */}
          <div className="flex items-center justify-center md:justify-end">
            <div
              className="relative rounded-full"
              style={{
                background:
                  "radial-gradient(circle, hsl(150 80% 60% / 0.12) 0%, transparent 65%)",
              }}
            >
              <VibeyOrbit size={260} tint="#73ffb8" />
            </div>
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
