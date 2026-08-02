import type { CSSProperties } from "react";

/**
 * Vibe Kart — the logo.
 *
 * The letterforms are drawn as paths rather than set in a font, for one blunt
 * reason: the game ships no web fonts, and a title screen whose wordmark is
 * "whatever `system-ui` resolves to at weight 900" is not a title screen. Eight
 * glyphs — V I B E K A R T — on a 100-unit em box with a 22-unit stem is a
 * small price for a mark that looks identical on every machine.
 *
 * The chunk comes from stacking, not from thickness. Each word is drawn five
 * times: an extruded stack of shifted dark copies for depth, a heavy dark
 * outline, a cream rim, the coloured face, and a gloss clipped to the top
 * third. That is the same recipe every first-party kart-racer logo uses, and it
 * survives being scaled from a phone to a 1600-pixel screenshot because every
 * layer is a stroke width in the same user units.
 */

/** Counters (the holes in B, A and R) are extra subpaths, cut with even-odd. */
interface Glyph {
  d: string;
  w: number;
}

const GLYPHS: Record<string, Glyph> = {
  V: { d: "M0 0 H24 L35 66 L46 0 H70 L48 100 H22 Z", w: 70 },
  I: { d: "M0 0 H22 V100 H0 Z", w: 22 },
  B: {
    d:
      "M0 0 H44 C60 0 68 9 68 24 C68 34 63 42 55 46 C64 50 70 58 70 70 C70 88 60 100 42 100 H0 Z" +
      "M22 18 V40 H40 C46 40 49 36 49 29 C49 22 46 18 40 18 Z" +
      "M22 58 V82 H42 C48 82 51 78 51 70 C51 62 48 58 42 58 Z",
    w: 70,
  },
  E: { d: "M0 0 H62 V19 H22 V39 H56 V57 H22 V81 H64 V100 H0 Z", w: 64 },
  K: { d: "M0 0 H22 V40 L52 0 H76 L42 46 L78 100 H54 L30 62 L22 72 V100 H0 Z", w: 78 },
  A: { d: "M26 0 H50 L76 100 H54 L49 78 H27 L22 100 H0 Z M31 60 H45 L38 30 Z", w: 76 },
  R: {
    d:
      "M0 0 H44 C62 0 71 10 71 29 C71 42 65 51 54 55 L74 100 H51 L34 60 H22 V100 H0 Z" +
      "M22 18 V43 H41 C47 43 51 38 51 30 C51 22 47 18 41 18 Z",
    w: 74,
  },
  T: { d: "M0 0 H68 V19 H45 V100 H23 V19 H0 Z", w: 68 },
};

/** Space between glyphs, in em units. Tight — the mark should feel packed. */
const TRACK = 9;

interface WordProps {
  text: string;
  /** Gradient stops of the face, top to bottom. */
  from: string;
  to: string;
  /** Colour of the extruded stack under the face. */
  shade: string;
  /** Degrees of skew — the whole mark leans into the corner. */
  skew?: number;
  className?: string;
  style?: CSSProperties;
}

function Word({ text, from, to, shade, skew = -6, className, style }: WordProps) {
  const letters = text.split("");
  let x = 0;
  const placed = letters.map((ch) => {
    const g = GLYPHS[ch];
    const at = x;
    x += (g?.w ?? 40) + TRACK;
    return { ch, g, at };
  });
  const width = Math.max(1, x - TRACK);
  const id = `vk-lg-${text.toLowerCase()}`;
  // Room for the extrude below and the outline all round.
  const pad = 16;
  const depth = 11;

  const paths = (props: Record<string, unknown>) =>
    placed.map(({ ch, g, at }, i) =>
      g ? <path key={`${ch}${i}`} d={g.d} transform={`translate(${at} 0)`} fillRule="evenodd" {...props} /> : null,
    );

  return (
    <svg
      viewBox={`${-pad} ${-pad} ${width + pad * 2} ${100 + pad * 2 + depth}`}
      className={className}
      style={style}
      aria-label={text}
      role="img"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={from} />
          <stop offset="0.52" stopColor={to} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
        <clipPath id={`${id}-gloss`}>
          <rect x={-pad} y={-pad} width={width + pad * 2} height={pad + 40} />
        </clipPath>
      </defs>

      <g transform={`skewX(${skew})`}>
        {/* Extrude: shifted dark copies, densest nearest the face. */}
        <g fill={shade}>
          {Array.from({ length: depth }, (_, k) => (
            <g key={k} transform={`translate(0 ${depth - k})`}>
              {paths({})}
            </g>
          ))}
        </g>
        {/* Dark outline, then the cream rim, then the face. */}
        <g fill="#0a1120" stroke="#0a1120" strokeWidth={17} strokeLinejoin="round">
          {paths({})}
        </g>
        <g fill="#fff4d6" stroke="#fff4d6" strokeWidth={8} strokeLinejoin="round">
          {paths({})}
        </g>
        <g fill={`url(#${id})`}>{paths({})}</g>
        <g clipPath={`url(#${id}-gloss)`} fill="#ffffff" opacity={0.3}>
          {paths({})}
        </g>
      </g>
    </svg>
  );
}

/**
 * The full lock-up. `VIBE` rides above and behind `KART`, which is the hero —
 * bigger, gold, and skewed a degree harder so the pair reads as motion rather
 * than as two lines of type.
 */
export function KartLogo({ className }: { className?: string }) {
  return (
    <div
      className={className}
      style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center" }}
    >
      <Word
        text="VIBE"
        from="#ff8fb8"
        to="#ff2d6f"
        shade="#8c0f3c"
        skew={-7}
        style={{ width: "34vmin", filter: "drop-shadow(0 1.4vmin 1.8vmin rgba(0,0,0,0.55))" }}
      />
      <Word
        text="KART"
        from="#ffe98a"
        to="#ff9f1c"
        shade="#8f3d00"
        skew={-9}
        style={{
          width: "62vmin",
          marginTop: "-3.2vmin",
          filter: "drop-shadow(0 1.8vmin 2.4vmin rgba(0,0,0,0.6))",
        }}
      />
    </div>
  );
}

export default KartLogo;
