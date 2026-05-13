/**
 * VibeWink — the iridescent "wink" emblem (two lightning eyes + a
 * curling smile). Used as the brand ornament on /vibe and anywhere
 * else we want the Vibe Coin energy without the robot character.
 *
 * Built as inline SVG with a holographic gradient stroke + soft
 * chromatic-aberration glow so it reads as glassy 3D against the
 * page's deep-space backdrop. Includes a 3D-feeling rotation
 * animation (CSS rotateY on the parent so the wink reads as
 * spinning in place) and a gentle vertical bob.
 *
 * Set `count={3}` (or whatever) to scatter several at varying
 * sizes / positions for a "floating in circles" feel — see VibeHub
 * for the placement.
 */
import type { CSSProperties } from "react";

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
        // Faux 3D — the outer wrapper bobs, the inner wrapper rotates
        // around the Y axis so the wink reads as a glass object
        // spinning in space.
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
        <svg
          viewBox="0 0 200 200"
          width={size}
          height={size}
          style={{
            display: "block",
            // Chromatic aberration via stacked drop-shadows in
            // complementary hues — sells the "iridescent glass" look
            // without needing a heavy filter chain.
            filter: [
              "drop-shadow(-1px 0 0 rgba(255, 80, 200, 0.7))",
              "drop-shadow(1px 0 0 rgba(80, 220, 255, 0.7))",
              "drop-shadow(0 0 12px rgba(255, 255, 255, 0.25))",
              "drop-shadow(0 0 28px rgba(140, 220, 255, 0.35))",
            ].join(" "),
          }}
        >
          <defs>
            {/* Holographic gradient — cycles pink → cyan → mint → gold
                so the stroke reads as oil-slick / iridescent. */}
            <linearGradient id="vibeWinkHolo" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%"   stopColor="#ff7fc8" />
              <stop offset="35%"  stopColor="#8de3ff" />
              <stop offset="65%"  stopColor="#a8ffd6" />
              <stop offset="100%" stopColor="#ffe27a" />
            </linearGradient>
            <linearGradient id="vibeWinkHoloAlt" x1="100%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%"   stopColor="#9be0ff" />
              <stop offset="50%"  stopColor="#ffffff" />
              <stop offset="100%" stopColor="#ff9be0" />
            </linearGradient>
          </defs>

          {/* Eyes — two lightning bolts. Smaller left, bigger right
              (to match the brand image, where the right eye is the
              dominant gesture). */}
          <g
            fill="none"
            stroke="url(#vibeWinkHolo)"
            strokeWidth={6}
            strokeLinejoin="round"
            strokeLinecap="round"
          >
            {/* Left eye — small lightning */}
            <path d="M 70 70 L 60 85 L 75 85 L 65 100" />
            {/* Right eye — big lightning, the focal one */}
            <path d="M 140 60 L 118 90 L 135 90 L 113 120" />
          </g>

          {/* Smile — long curve that hooks up at the right end. */}
          <g
            fill="none"
            stroke="url(#vibeWinkHoloAlt)"
            strokeWidth={7}
            strokeLinejoin="round"
            strokeLinecap="round"
          >
            <path d="M 55 135 Q 100 175 145 145 L 150 130" />
            {/* Tiny upward flourish at the smile's tail. */}
            <path d="M 145 145 L 148 130 L 155 138" />
          </g>

          {/* Inner highlight — thin white pass on top of everything
              so the strokes feel like glass with a specular edge. */}
          <g
            fill="none"
            stroke="rgba(255,255,255,0.55)"
            strokeWidth={1.4}
            strokeLinejoin="round"
            strokeLinecap="round"
          >
            <path d="M 70 70 L 60 85 L 75 85 L 65 100" />
            <path d="M 140 60 L 118 90 L 135 90 L 113 120" />
            <path d="M 55 135 Q 100 175 145 145 L 150 130" />
          </g>
        </svg>
      </div>
    </div>
  );
}
