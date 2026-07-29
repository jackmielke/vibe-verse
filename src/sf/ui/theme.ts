/**
 * The design language for SAN FRANCISCO: FREE FALL.
 *
 * One file, one vocabulary. Every panel, meter and marker in `src/sf/ui`
 * resolves its colour and timing from here so the interface reads as a single
 * designed object rather than twelve components that each picked their own
 * blue. The tokens are exported twice — as JS constants (for canvas drawing,
 * which cannot read CSS variables) and as CSS custom properties (for DOM,
 * which needs to respond live to the colour-blind palette switch).
 *
 * Art direction, stated plainly so it survives contact with future edits:
 *   - ONE signal colour. Orange #ff6a2b. It means "the game is talking to
 *     you". If everything is orange, nothing is.
 *   - Near-black surfaces at low alpha with a real backdrop blur. Never a
 *     flat opaque panel floating over the render.
 *   - Type is thin, uppercase, widely tracked for labels; heavy and tabular
 *     for numbers. Numbers never reflow while counting.
 *   - 1px rules at 12-20% white. They are structure, not decoration.
 *   - Motion is 120-220ms on a fast-out curve. Anything slower feels like a
 *     website; anything faster reads as a glitch.
 */

/* ------------------------------------------------------------------ *
 * Palette
 * ------------------------------------------------------------------ */

export const COLORS = {
  /** The signal. Objectives, focus, the player's own agency. */
  signal: "#ff6a2b",
  signalBright: "#ff8a4c",
  signalDeep: "#c2410c",
  /** Surfaces. */
  ink: "#05060a",
  ink2: "#0b0d12",
  ink3: "#151922",
  paper: "#f2f4f7",
  muted: "#8b93a1",
  mutedDim: "#5b6270",
  /** State. */
  danger: "#ff3b30",
  warn: "#ffb02b",
  good: "#3ddc84",
  info: "#4cc3ff",
  /** Systems. */
  chaos: "#ffb02b",
  heat: "#ff2d20",
  /** Map. */
  water: "#0a1620",
  waterDeep: "#060d14",
  land: "#171b21",
  landHi: "#232830",
  park: "#16241b",
  road: "#3a4250",
  roadMajor: "#5c6676",
  roadBoulevard: "#7d8899",
} as const;

/** Colour-blind safe substitutions. Only the state hues move; the signal
 *  orange survives every common deficiency and stays put. */
export const CVD_PALETTES = {
  none: {},
  /** Protanopia — red is dark and desaturated. Push danger to magenta. */
  protan: { danger: "#e5399a", good: "#3aa0ff", heat: "#e5399a", warn: "#ffd23b" },
  /** Deuteranopia — the common one. Same axis, slightly different balance. */
  deutan: { danger: "#e5399a", good: "#4db4ff", heat: "#ff4fa3", warn: "#ffd84d" },
  /** Tritanopia — blue/yellow collapse. Keep red, move "good" to teal. */
  tritan: { danger: "#ff4136", good: "#00c2b2", heat: "#ff4136", warn: "#ff8fa3", info: "#ff7ba8" },
} as const;

export type CvdMode = keyof typeof CVD_PALETTES;

/* ------------------------------------------------------------------ *
 * Motion
 * ------------------------------------------------------------------ */

export const MOTION = {
  /** Snap — hit markers, key presses, toggles. */
  fast: 120,
  /** Standard — panels, list rows, meters. */
  base: 170,
  /** Considered — full-screen transitions. */
  slow: 220,
  /** The house curve: leaves instantly, arrives softly. */
  ease: "cubic-bezier(0.16, 0.84, 0.28, 1)",
  /** For things that must feel mechanical (meters filling). */
  easeLinearish: "cubic-bezier(0.4, 0.0, 0.6, 1)",
  /** Overshoot, used sparingly — chaos tier promotions only. */
  easeBack: "cubic-bezier(0.2, 1.5, 0.4, 1)",
} as const;

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

export const LAYOUT = {
  /** Safe-area inset from the viewport edge, px at scale 1. */
  edge: 28,
  /** Radius on glass panels. Small — this is a HUD, not a card. */
  radius: 6,
  /** Hairline width. */
  rule: 1,
} as const;

/* ------------------------------------------------------------------ *
 * z-order — one place, so nothing fights
 * ------------------------------------------------------------------ */

export const Z = {
  worldMarkers: 10,
  hud: 20,
  notifications: 30,
  minimap: 25,
  weaponWheel: 40,
  fullscreenOverlay: 50,
  menu: 60,
  photo: 55,
  loading: 70,
  chrome: 15,
} as const;

/* ------------------------------------------------------------------ *
 * Helpers used by canvas renderers (which cannot read CSS vars)
 * ------------------------------------------------------------------ */

/** Resolve a state colour through the active colour-blind palette. */
export function cvdColor(key: keyof typeof COLORS, mode: CvdMode): string {
  const patch = CVD_PALETTES[mode] as Partial<Record<string, string>>;
  return patch[key as string] ?? COLORS[key];
}

/** `#rrggbb` + alpha → `rgba(...)`. Hoisted parse, no allocation in loops. */
export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Linear blend of two `#rrggbb` strings — for meters that shift hue. */
export function mixHex(a: string, b: string, t: number): string {
  const na = parseInt(a.slice(1), 16);
  const nb = parseInt(b.slice(1), 16);
  const r = Math.round(((na >> 16) & 255) * (1 - t) + ((nb >> 16) & 255) * t);
  const g = Math.round(((na >> 8) & 255) * (1 - t) + ((nb >> 8) & 255) * t);
  const bl = Math.round((na & 255) * (1 - t) + (nb & 255) * t);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0")}`;
}

/**
 * Health → colour. Deliberately not a smooth green→red ramp: the player
 * needs to read *state*, and three discrete bands with short crossfades are
 * far easier to parse in peripheral vision than a continuous gradient.
 */
export function healthColor(frac: number, mode: CvdMode = "none"): string {
  const good = cvdColor("good", mode);
  const warn = cvdColor("warn", mode);
  const danger = cvdColor("danger", mode);
  if (frac > 0.62) return good;
  if (frac > 0.55) return mixHex(warn, good, (frac - 0.55) / 0.07);
  if (frac > 0.3) return warn;
  if (frac > 0.24) return mixHex(danger, warn, (frac - 0.24) / 0.06);
  return danger;
}
