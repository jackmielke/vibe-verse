/**
 * VibeWink — the iridescent "wink" emblem (two lightning eyes + a
 * curling smile). **The mark of real $VIBE.**
 *
 * This is the real glass render, not a hand-traced SVG: the brand rule is
 * "never redraw the wink" (see src/assets/brand/README.md), so the mark is a
 * transparent PNG served from the asset CDN.
 *
 * ## Two coins, two marks
 *
 * The vibeverse has a play-money ledger and a real ERC-20, and telling them
 * apart at a glance is worth a rule: **the wink means the token on Base, the
 * ✦ (`VibeCoinMark`) means the ledger balance you earn by playing.** So when
 * you claim, the number you claim into wears the proper logo.
 *
 * ## It does not spin any more
 *
 * It used to rotate about its Y axis inside a `perspective`, which is a fine
 * effect on a hero and a bad one on a mark: turning edge-on, a flat PNG
 * squashes to nothing and springs back, and what you actually see is the logo
 * pulsing wider and narrower next to a word. `spin` is opt-in now. The bob
 * stays — a slow vertical float reads as alive without distorting anything.
 */
import type { CSSProperties } from "react";
import winkGlass from "@/assets/brand/vibe-wink-glass.png.asset.json";

interface Props {
  /** Pixel size of the emblem. Default 220. */
  size?: number;
  /** Bob speed multiplier, and rotation speed when `spin` is on. */
  speed?: number;
  /**
   * Turn about the Y axis. Off by default — see the note above about a flat
   * mark squashing as it passes edge-on. Worth it on a big hero, never worth
   * it beside a number.
   */
  spin?: boolean;
  /** Phase offset in seconds so multiple wink copies don't sync. */
  phase?: number;
  className?: string;
  style?: CSSProperties;
}

export default function VibeWink({
  size = 220,
  speed = 1,
  spin = false,
  phase = 0,
  className = "",
  style,
}: Props) {
  const rotateDur = `${14 / speed}s`;
  const bobDur = `${5 / speed}s`;
  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        position: "relative",
        animation: `vibe-wink-bob ${bobDur} ease-in-out infinite`,
        animationDelay: `${phase}s`,
        perspective: "800px",
        ...style,
      }}
      aria-hidden="true"
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          transformStyle: "preserve-3d",
          animation: spin ? `vibe-wink-spin ${rotateDur} linear infinite` : undefined,
          animationDelay: spin ? `${phase}s` : undefined,
        }}
      >
        <img
          src={winkGlass.url}
          alt=""
          draggable={false}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            objectFit: "contain",
            userSelect: "none",
            filter: "drop-shadow(0 0 26px rgba(140, 220, 255, 0.35))",
          }}
        />
      </div>
    </div>
  );
}
