/**
 * The colours, lifted straight off the petri dish.
 *
 * BLOB paints everything the same way — a hue, a hard-lit radial gradient from
 * `hsl(h 92% 74%)` down to `hsl(h 78% 44%)`, and a glow of the same hue behind
 * it, all sitting on near-black navy. That recipe is in `src/blob/render.ts`
 * and this file is that recipe applied to a grid instead of a dish, so the two
 * worlds look like they came from the same place.
 *
 * The ladder walks the wheel the way BLOB's `hueFor` does: it starts on 194,
 * the hue the player's own blob wears, and climbs. It deliberately *skips the
 * greens* on the way up for the same reason BLOB does — green is the virus,
 * the thing you avoid — and then spends green all at once on 2048, so the tile
 * you are playing for is the one colour the board has never shown you.
 */

/** Hue per rung of the ladder: index 0 is the 2, index 1 the 4, and so on. */
const HUES = [
  194, // 2     — the player's cyan
  205, // 4
  219, // 8
  238, // 16    — indigo
  258, // 32    — violet
  278, // 64
  298, // 128   — magenta
  318, // 256
  338, // 512   — rose
  18, //  1024  — amber
  148, // 2048  — virus green, and nothing below it is allowed to be
  168, // 4096
  108, // 8192
  60, //  16384 — off the end of the wheel and into gold
];

/** `2 → 0`, `4 → 1`, `2048 → 10`. */
export const rungOf = (value: number): number => Math.round(Math.log2(Math.max(2, value))) - 1;

export const hueOf = (value: number): number => HUES[Math.min(rungOf(value), HUES.length - 1)];

export interface TileSkin {
  /** The tile face. A radial gradient, lit from the top-left like BLOB's cells. */
  background: string;
  /** Rim light, so a tile reads as a body and not a swatch. */
  border: string;
  /** Outer glow. Grows with the value — a 512 should own the board. */
  shadow: string;
  color: string;
  /** Relative to the cell, so a 4-wide and a 5-wide board both fit "1024". */
  fontSize: string;
}

/**
 * How a tile of this value is painted.
 *
 * The low rungs are held back on purpose — a board where a 2 glows as hard as a
 * 256 is a board with no read on it. Saturation and glow climb together, so
 * "how am I doing" is answerable from across the room, out of focus.
 */
export function skinFor(value: number): TileSkin {
  const hue = hueOf(value);
  const rung = rungOf(value);
  // 0 at the 2, 1 by about the 512. Everything below scales off this.
  const heat = Math.min(1, rung / 9);
  const sat = 78 + heat * 18;
  const light = 52 + heat * 12;
  const glow = 8 + heat * 30;
  const digits = String(value).length;

  return {
    background: `radial-gradient(circle at 32% 26%, hsl(${hue} ${sat}% ${light + 22}%) 0%, hsl(${hue} ${sat}% ${light}%) 46%, hsl(${hue} ${sat - 6}% ${light - 14}%) 100%)`,
    border: `hsla(${hue}, 100%, ${82 + heat * 10}%, ${0.35 + heat * 0.4})`,
    shadow: `0 0 ${glow}px hsla(${hue}, 100%, 62%, ${0.28 + heat * 0.42}), inset 0 1px 0 hsla(${hue}, 100%, 92%, 0.5)`,
    // Dark ink on a lit body: the same contrast direction as a name tag on a
    // blob, and the only one that stays legible when the glow comes up.
    color: value >= 8 ? "#050b16" : "#03080f",
    fontSize:
      digits >= 5 ? "clamp(11px, 3.6vmin, 26px)"
      : digits === 4 ? "clamp(14px, 4.6vmin, 32px)"
      : digits === 3 ? "clamp(17px, 5.6vmin, 40px)"
      : "clamp(20px, 6.6vmin, 46px)",
  };
}

/** The dish itself: BLOB's background, top to bottom. */
export const DISH_BG = "linear-gradient(180deg, #070c16 0%, #08111f 55%, #050810 100%)";
