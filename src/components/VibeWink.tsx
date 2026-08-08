/**
 * VibeWink — the iridescent "wink" emblem (two lightning eyes + a
 * curling smile).
 *
 * This is the real glass render, not a hand-traced SVG: the brand rule is
 * "never redraw the wink" (see src/assets/brand/README.md), so the mark is a
 * transparent PNG served from the asset CDN. The bob + Y-axis spin stay in
 * CSS so it still reads as a glass object turning in space.
 */
import type { CSSProperties } from "react";
import winkGlass from "@/assets/brand/vibe-wink-glass.png.asset.json";

interface Props {
  /** Pixel size of the emblem. Default 220. */
  size?: number;
  /** Tilt / rotate speed multiplier. 1 = ~14s rotation. */
  speed?: number;
  /** Phase offset in seconds so multiple wink copies don't sync. */
  phase?: number;
  className?: string;
  style?: CSSProperties;
}

export default function VibeWink({
  size = 220,
  speed = 1,
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
          animation: `vibe-wink-spin ${rotateDur} linear infinite`,
          animationDelay: `${phase}s`,
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
