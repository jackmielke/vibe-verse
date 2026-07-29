/**
 * Formatting for numbers a player reads in motion.
 *
 * Two rules drive everything here:
 *   1. Digits must not reflow. "9" → "10" must not shift the label next to
 *      it, so counters are padded and typeset tabular.
 *   2. Precision drops off with distance and magnitude. Nobody needs
 *      "1,247.38 m" at a glance; they need "1.2 KM".
 */

/** Metres → the string the compass and objective tracker show. */
export function distance(m: number): string {
  if (!isFinite(m)) return "—";
  if (m < 10) return `${m.toFixed(1)}M`;
  if (m < 1000) return `${Math.round(m)}M`;
  if (m < 10000) return `${(m / 1000).toFixed(2)}KM`;
  return `${(m / 1000).toFixed(1)}KM`;
}

/** Metres → altitude readout. Always integer; altitude fidgets enough. */
export function altitude(m: number): string {
  const v = Math.max(0, Math.round(m));
  return v >= 1000 ? `${(v / 1000).toFixed(2)}K` : String(v);
}

/** m/s → km/h, integer, for vehicle and wingsuit speed. */
export function kmh(ms: number): number {
  return Math.round(ms * 3.6);
}

/** m/s → mph. The vehicle HUD offers both; SF is an American city. */
export function mph(ms: number): number {
  return Math.round(ms * 2.23694);
}

/** Pad an integer for a fixed-width counter. */
export function pad(n: number, width: number): string {
  const s = String(Math.max(0, Math.round(n)));
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

/** 1_248_300 → "1,248,300". Chaos scores get big. */
export function group(n: number): string {
  const v = Math.round(n);
  const s = Math.abs(v).toString();
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return v < 0 ? `-${out}` : out;
}

/** Compact form for the chaos meter's headline: 1.2M, 84.5K, 940. */
export function compact(n: number): string {
  const v = Math.abs(Math.round(n));
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}K`;
  return group(n);
}

const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/**
 * World yaw (radians) → compass bearing in degrees, 0..360.
 *
 * The world is +X east / +Z south / -Z north, and `frame.yaw` is measured so
 * that forward = (-sin y, 0, -cos y): yaw 0 looks north. That makes the
 * conversion a straight radians-to-degrees with a wrap, and getting this
 * wrong is how a compass ends up mirrored, so it lives in exactly one place.
 */
export function yawToBearing(yaw: number): number {
  let deg = (yaw * 180) / Math.PI;
  deg %= 360;
  if (deg < 0) deg += 360;
  return deg;
}

/** World-space direction from A to B → bearing in degrees, 0..360. */
export function bearingTo(fromX: number, fromZ: number, toX: number, toZ: number): number {
  // North is -Z, east is +X.
  let deg = (Math.atan2(toX - fromX, -(toZ - fromZ)) * 180) / Math.PI;
  deg %= 360;
  if (deg < 0) deg += 360;
  return deg;
}

/** Bearing degrees → "NE", "SSW"-free 8-point cardinal. */
export function cardinal(deg: number): string {
  return CARDINALS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** Shortest signed difference between two bearings, -180..180. */
export function bearingDelta(a: number, b: number): number {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/** 17.42 → "17:25". Time of day for the photo-mode scrubber and map. */
export function clockTime(hours: number): string {
  const h24 = ((hours % 24) + 24) % 24;
  const h = Math.floor(h24);
  const m = Math.floor((h24 - h) * 60);
  return `${pad(h, 2)}:${pad(m, 2)}`;
}

/** 17.42 → "5:25 PM". Used where the tone should be civilian, not military. */
export function clockTime12(hours: number): string {
  const h24 = ((hours % 24) + 24) % 24;
  let h = Math.floor(h24);
  const m = Math.floor((h24 - h) * 60);
  const pm = h >= 12;
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${pad(m, 2)} ${pm ? "PM" : "AM"}`;
}

/** Seconds → "1:04". Timers, respawn countdowns, mission clocks. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${pad(s % 60, 2)}`;
}

/** 0.37 → "37%". */
export function percent(frac: number, digits = 0): string {
  return `${(frac * 100).toFixed(digits)}%`;
}

/** A key code from a KeyboardEvent → the glyph shown in the controls list. */
export function keyGlyph(code: string): string {
  if (!code) return "—";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `NUM ${code.slice(6)}`;
  if (code.startsWith("Arrow")) {
    const dir = code.slice(5);
    return dir === "Up" ? "↑" : dir === "Down" ? "↓" : dir === "Left" ? "←" : "→";
  }
  if (code.startsWith("Mouse")) {
    const n = code.slice(5);
    return n === "0" ? "LMB" : n === "1" ? "MMB" : n === "2" ? "RMB" : `M${n}`;
  }
  if (code === "WheelUp") return "WHEEL ↑";
  if (code === "WheelDown") return "WHEEL ↓";
  const named: Record<string, string> = {
    Space: "SPACE",
    ShiftLeft: "L SHIFT",
    ShiftRight: "R SHIFT",
    ControlLeft: "L CTRL",
    ControlRight: "R CTRL",
    AltLeft: "L ALT",
    AltRight: "R ALT",
    Escape: "ESC",
    Enter: "ENTER",
    Tab: "TAB",
    Backspace: "BKSP",
    CapsLock: "CAPS",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
  };
  return named[code] ?? code.toUpperCase();
}
