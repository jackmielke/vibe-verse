/**
 * The Vibecoin mark — the currency's face.
 *
 * A currency needs one shape that means "this is money here", and it has to
 * survive being 14 pixels wide in a nav pill *and* 128 pixels wide on the coin
 * page. So: a struck coin, not an illustration. A rim, a face, and the `✦`
 * glyph the worlds already print, with a light source at the top-left that
 * makes it read as metal rather than as a sticker.
 *
 * Deliberately not the ringed world from `VibeMark` — that mark means "the
 * VibeVerse, take me home", and a coin that looks like the home button is a
 * coin people will click to leave.
 */
import { useId } from "react";

export default function VibeCoinMark({
  size = 16,
  /** Cuts the rim highlight and glow. Use inside dense rows of small text. */
  flat = false,
  className,
}: {
  size?: number;
  flat?: boolean;
  className?: string;
}) {
  /* Gradients live in <defs> and defs are global to the document, so two coins
     on one page with the same id would silently share the first one's fill.
     useId is per-instance and stable across hydration. */
  const uid = useId().replace(/:/g, "");
  const face = `vc-face-${uid}`;
  const rim = `vc-rim-${uid}`;
  const shine = `vc-shine-${uid}`;

  /* Below about 20px the milling and the specular sweep stop being detail and
     start being noise that eats the glyph — at nav size the coin was reading as
     a plain green dot. Small coins are drawn flat whether or not the caller
     asked, because a mark you cannot identify is not a mark. */
  const plain = flat || size < 20;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      aria-hidden
      focusable="false"
    >
      <defs>
        {/* The face is DARK and the glyph is light. The first cut had it the
            other way round — a bright mint face with a deep teal ✦ struck into
            it — which looked like a coin at 128px and like a green dot at 17.
            Light-on-dark survives the shrink. */}
        <radialGradient id={face} cx="34%" cy="26%" r="80%">
          <stop offset="0%" stopColor="#1d6f60" />
          <stop offset="55%" stopColor="#0d4a41" />
          <stop offset="100%" stopColor="#06251f" />
        </radialGradient>
        <linearGradient id={rim} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#eafff8" />
          <stop offset="38%" stopColor="#7dffd4" />
          <stop offset="62%" stopColor="#59b8ff" />
          <stop offset="100%" stopColor="#0d6b5c" />
        </linearGradient>
        <linearGradient id={shine} x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Rim, then face inset by the rim's width — a struck edge, not a stroke. */}
      <circle cx="16" cy="16" r="15" fill={`url(#${rim})`} />
      <circle cx="16" cy="16" r="12.4" fill={`url(#${face})`} />

      {/* Milled edge. Twelve ticks reads as knurling without turning into a
          grey ring at 128px. */}
      {!plain &&
        Array.from({ length: 12 }, (_, i) => {
          const a = (i / 12) * Math.PI * 2;
          const r0 = 12.9;
          const r1 = 14.5;
          return (
            <line
              key={i}
              x1={16 + Math.cos(a) * r0}
              y1={16 + Math.sin(a) * r0}
              x2={16 + Math.cos(a) * r1}
              y2={16 + Math.sin(a) * r1}
              stroke="#04322b"
              strokeOpacity="0.35"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          );
        })}

      {/* Specular sweep, under the glyph so it lights the face rather than
          washing out the thing the face is for. */}
      {!plain && (
        <ellipse
          cx="12"
          cy="10.5"
          rx="7.5"
          ry="4.6"
          fill={`url(#${shine})`}
          transform="rotate(-28 12 10.5)"
        />
      )}

      {/* The glyph. A dark shadow a hair below a bright face makes it look
          raised off the coin rather than printed on it — and the bright pass is
          the one doing the work at nav size. */}
      {!plain && (
        <text
          x="16"
          y="17.3"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="19"
          fill="#02201b"
          fillOpacity="0.85"
        >
          ✦
        </text>
      )}
      <text
        x="16"
        y="16"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={plain ? 21 : 19}
        fill="#9dffe0"
      >
        ✦
      </text>
    </svg>
  );
}
