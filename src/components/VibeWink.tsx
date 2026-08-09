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
 * ## It holds still
 *
 * It used to do two things at once and neither of them helped. It rotated
 * about its Y axis inside a `perspective`, so a flat PNG passing edge-on
 * squashed to nothing and sprang back — the logo appeared to pulse wider and
 * narrower beside the word it was labelling. And it bobbed up and down on a
 * five-second loop, which is charming exactly once and then is a thing moving
 * in the corner of your eye on every page in the app.
 *
 * Both are opt-in now and nothing opts in. A logo's job is to sit still and be
 * recognised; if a surface genuinely wants motion it can ask for it, and it
 * should have to be a decision rather than the default everywhere.
 */
import type { CSSProperties } from "react";
import winkGlass from "@/assets/brand/vibe-wink-glass.png.asset.json";

interface Props {
  /** Pixel size of the emblem. Default 220. */
  size?: number;
  /** Animation speed multiplier, when `spin` or `bob` is on. */
  speed?: number;
  /**
   * Turn about the Y axis. Off by default — a flat mark squashes to nothing as
   * it passes edge-on. Worth it on a big hero, never worth it beside a number.
   */
  spin?: boolean;
  /** Float gently up and down. Off by default; see the note above. */
  bob?: boolean;
  /** Phase offset in seconds so multiple wink copies don't sync. */
  phase?: number;
  className?: string;
  style?: CSSProperties;
}

export default function VibeWink({
  size = 220,
  speed = 1,
  spin = false,
  bob = false,
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
        animation: bob ? `vibe-wink-bob ${bobDur} ease-in-out infinite` : undefined,
        animationDelay: bob ? `${phase}s` : undefined,
        /* Only when something is actually turning. A `perspective` on a static
           element costs a compositor layer for nothing. */
        perspective: spin ? "800px" : undefined,
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
