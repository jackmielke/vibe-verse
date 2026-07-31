/**
 * Vibe Kart — small UI helpers.
 *
 * Formatting only: nothing here reads a service or touches the DOM, so it can
 * be called from a render, from a frame callback, or from a test.
 */

/** `1:04.382`, the split format every racing game has used since the arcades. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds - m * 60);
  const ms = Math.floor((seconds - m * 60 - s) * 1000);
  return `${m}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

/** `+2.41` — a gap, signed, two decimals. */
export function formatGap(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0.001) return "—";
  return `+${seconds.toFixed(2)}`;
}

const SUFFIX = ["th", "st", "nd", "rd"];

/** `1 → st`, `2 → nd`, `13 → th`. The number itself is drawn separately. */
export function ordinalSuffix(n: number): string {
  const v = n % 100;
  return SUFFIX[(v - 20) % 10] ?? SUFFIX[v] ?? SUFFIX[0];
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Frame-rate independent exponential approach. Every eased HUD value uses this
 * rather than a fixed lerp factor, so the needle settles identically at 30, 60
 * and 144 Hz — and identically again when the screenshot harness steps by hand.
 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** `0x3ad9ff → #3ad9ff`, for the colours that arrive as numbers from presets. */
export function hex(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
}

/** Mix two `#rrggbb` strings. Used for the drift charge ramp. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const k = clamp01(t);
  const r = Math.round((pa >> 16) + ((pb >> 16) - (pa >> 16)) * k);
  const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * k);
  const bl = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * k);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0")}`;
}

/** Mini-turbo tier colours: none, blue, orange, purple. Same ramp as the sparks. */
export const TIER_COLOR = ["#7fa8c8", "#3ad9ff", "#ffa919", "#b57bff"] as const;
export const TIER_NAME = ["", "Mini-Turbo", "Super Mini-Turbo", "Ultra Mini-Turbo"] as const;

/** Weight-class label, title-cased for the select screen. */
export function weightLabel(weight: string): string {
  return weight.charAt(0).toUpperCase() + weight.slice(1);
}

/**
 * Grand-prix points for an eight-kart field — the Mario Kart Wii table, which
 * is the one built for eight racers: winning is worth three finishes in the
 * middle of the pack, and nobody scores nothing.
 */
export const POINTS = [15, 12, 10, 8, 6, 4, 2, 1] as const;

export function pointsFor(place: number): number {
  return POINTS[clamp(place - 1, 0, POINTS.length - 1)] ?? 1;
}
