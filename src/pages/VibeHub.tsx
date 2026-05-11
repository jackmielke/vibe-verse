/**
 * VibeHub — `/vibe` route, the canonical destination for everything
 * $VIBE: log in, see your balance, send to community members, and
 * see who else is in.
 *
 * Layout: three columns on desktop, stacked on mobile.
 *   - Left: wallet login card + market summary
 *   - Right: full holder leaderboard
 *
 * Mounted as its own page so the experience is dedicated, and also
 * available as embeddable components in the Lobby / Garden.
 */
import { Link } from "react-router-dom";
import { ArrowLeft, Coins } from "lucide-react";
import VibeLogin from "@/components/VibeLogin";
import VibeWalletLeaderboard from "@/components/VibeWalletLeaderboard";
import VibeCoinPanel from "@/components/VibeCoinPanel";

export default function VibeHub() {
  return (
    <div className="relative w-full min-h-[100dvh] bg-black overflow-hidden text-foreground">
      {/* Subtle backdrop — same pattern as the rest of the worlds for
          visual continuity. */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at top, hsl(216 60% 12%) 0%, hsl(220 50% 4%) 70%, #000 100%)",
        }}
      />

      <div className="relative z-10 max-w-6xl mx-auto px-4 md:px-8 pt-16 md:pt-10 pb-10 flex flex-col gap-6">
        {/* Top sub-strip — clears the GlobalNav on mobile, sits naturally on desktop */}
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
              VIBE Hub
            </span>
          </div>
        </div>

        <div>
          <h1 className="font-heading text-3xl md:text-4xl font-bold text-foreground leading-tight">
            $VIBE in the community
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Connect your Base wallet to attach it to your Edge Esmeralda
            profile. Everyone else can see your live balance — and you can
            send VIBE to anyone in the community in two clicks.
          </p>
        </div>

        <div className="grid md:grid-cols-[1fr_1fr] gap-5 items-start">
          {/* Left column: login + market */}
          <div className="flex flex-col gap-5">
            <VibeLogin variant="card" />
            <VibeCoinPanel />
          </div>
          {/* Right column: leaderboard */}
          <div className="flex flex-col gap-5">
            <VibeWalletLeaderboard defaultVisible={8} maxRows={40} />
          </div>
        </div>
      </div>
    </div>
  );
}
