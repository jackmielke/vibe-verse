/**
 * The Magician's world, as data.
 *
 * Everything Vibey can change about the valley is a field on `WorldState`.
 * The voice agent's tools produce *patches* to it; the renderer in `world/`
 * eases the scene toward whatever it currently says. Nothing in here knows
 * about three.js, WebRTC or React, which is what makes it testable and what
 * lets the same patch arrive from a spoken sentence, a typed spell, or a
 * script driving the page from outside.
 */

export type Weather = "clear" | "cloudy" | "rain" | "storm" | "snow" | "fog";
export type Season = "spring" | "summer" | "autumn" | "winter";
export type Gravity = "normal" | "moon" | "heavy";

export type PropKind =
  | "tree"
  | "sakura"
  | "maple"
  | "pine"
  | "bamboo"
  | "lantern"
  | "torii"
  | "house"
  | "shrine"
  | "rock"
  | "campfire"
  | "flowers"
  | "crystal"
  | "fox"
  | "snowman"
  | "mushroom"
  | "pagoda"
  | "windmill"
  | "boulder"
  | "rocket"
  | "ufo"
  | "balloon"
  | "birds";

export const PROP_KINDS: PropKind[] = [
  "tree", "sakura", "maple", "pine", "bamboo", "lantern", "torii", "house", "shrine",
  "rock", "campfire", "flowers", "crystal", "fox", "snowman", "mushroom", "pagoda",
  "windmill", "boulder", "rocket", "ufo", "balloon", "birds",
];

/** Named places in the valley the player (or a spawn) can be sent to. */
export type Place = "village" | "shrine" | "bridge" | "screen" | "torii" | "paddies" | "hilltop" | "lake" | "here" | "around";
export const PLACES: Place[] = ["village", "shrine", "bridge", "screen", "torii", "paddies", "hilltop", "lake", "here", "around"];

export interface Prop {
  id: number;
  kind: PropKind;
  x: number;
  z: number;
  /** Uniform scale multiplier, 1 = the kind's natural size. */
  scale: number;
  /** Optional colour override as a CSS hex string. */
  color?: string;
  /** Yaw in radians. */
  yaw: number;
}

/** What the Magic Screen in the square is running: code a model wrote a moment ago. */
export interface ScreenProgram {
  code: string;
  title: string;
  /** What was asked for, in the asker's words. */
  request: string;
  /** Wall-clock ms it started, so every viewer's clock agrees. */
  at: number;
}

/** A paper lantern set on the river with a wish written on it. */
export interface Wish {
  id: number;
  text: string;
  /** Wall-clock ms when it was released: where it has drifted is a function of this. */
  born: number;
}

export interface Palette {
  /** Zenith colour. */
  sky: string;
  /** Horizon colour. */
  horizon: string;
  /** Multiplied into the ground and foliage. `#ffffff` is untouched. */
  ground: string;
}

export interface WorldState {
  /** Name Vibey has given the place. */
  title: string;
  /** Hours, 0–24. 6 is dawn, 12 noon, 18 sunset, 0 midnight. */
  timeOfDay: number;
  /** Whether the clock runs on its own (a day is ~10 minutes). */
  clockRunning: boolean;
  weather: Weather;
  season: Season;
  /** 0–1. Moves the trees, the petals, the rain, the clouds. */
  wind: number;
  /** Compass bearing the wind blows *toward*, radians. */
  windDirection: number;
  /** 0–1 on top of whatever the weather implies. */
  fog: number;
  /** null means "let the time of day decide". */
  palette: Palette | null;
  lanternsLit: boolean | "auto";
  fireflies: boolean | "auto";
  /** Sakura petals in the air, 0–1. `auto` follows the season. */
  petals: number | "auto";
  /** Fireballs from the mountain. `rate` is per second. */
  fireballs: { on: boolean; rate: number };
  gravity: Gravity;
  /** Player walk speed multiplier. */
  speed: number;
  /** What the wooden sign by the bridge says. */
  sign: string;
  /** How many times the player has been hit by a fireball. */
  hits: number;
  props: Prop[];
  /** Rising water: 0 is the river in its banks, 1 is the valley flooded. */
  flood: number;
  /** Aurora over the ridge, 0–1. */
  aurora: number;
  /** Stars even by day, meteor showers: 0–1 extra sparkle. */
  meteors: number;
  /** The scene scale for the "make everything tiny/giant" trick, 0.5–2. */
  giant: number;
  /** Lanterns floating down the river, everybody's. */
  wishes: Wish[];
  /** The Magic Screen's program; null is its own welcome card. */
  screen: ScreenProgram | null;
  /** Somebody is having a program written: the request and the draft so far. */
  screenWriting: { request: string; code: string; at: number } | null;
}

export const DEFAULT_STATE: WorldState = {
  title: "Hoshimura",
  timeOfDay: 16.5,
  clockRunning: false,
  weather: "clear",
  season: "spring",
  wind: 0.25,
  windDirection: 0.8,
  fog: 0,
  palette: null,
  lanternsLit: "auto",
  fireflies: "auto",
  petals: "auto",
  fireballs: { on: false, rate: 0.6 },
  gravity: "normal",
  speed: 1,
  sign: "Welcome to Hoshimura",
  hits: 0,
  props: [],
  flood: 0,
  aurora: 0,
  meteors: 0,
  giant: 1,
  wishes: [],
  screen: null,
  screenWriting: null,
};

export type Patch = Partial<Omit<WorldState, "props">> & { props?: Prop[] };

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Apply a patch, clamping everything numeric into the range the renderer expects. */
export function applyPatch(state: WorldState, patch: Patch): WorldState {
  const next: WorldState = { ...state, ...patch };
  next.timeOfDay = ((next.timeOfDay % 24) + 24) % 24;
  next.wind = clamp(next.wind, 0, 1);
  next.fog = clamp(next.fog, 0, 1);
  next.speed = clamp(next.speed, 0.3, 4);
  next.flood = clamp(next.flood, 0, 1);
  next.aurora = clamp(next.aurora, 0, 1);
  next.meteors = clamp(next.meteors, 0, 1);
  next.giant = clamp(next.giant, 0.4, 2.5);
  if (typeof next.petals === "number") next.petals = clamp(next.petals, 0, 1);
  next.fireballs = { on: !!next.fireballs.on, rate: clamp(next.fireballs.rate, 0.1, 5) };
  if (next.props.length > 400) next.props = next.props.slice(next.props.length - 400);
  // A lantern lives five minutes; the river holds forty at most.
  const now = Date.now();
  next.wishes = (next.wishes ?? []).filter((w) => now - w.born < 300_000).slice(-40);
  if (next.screen === undefined) next.screen = null;
  if (next.screen && next.screen.code.length > 40000) next.screen = null;
  if (next.screenWriting === undefined) next.screenWriting = null;
  return next;
}

// ---------------------------------------------------------------------------
// Derived values: what the state *means* for the renderer.
// ---------------------------------------------------------------------------

/** How dark it is, 0 (noon) to 1 (midnight). */
export function nightness(t: number): number {
  // Sun elevation as a cosine over the day; full dark below about -0.2.
  const s = Math.cos(((t - 12) / 24) * Math.PI * 2);
  return clamp((0.15 - s) / 0.55, 0, 1);
}

export function isNight(state: WorldState): boolean {
  return nightness(state.timeOfDay) > 0.6;
}

export function lanternsOn(state: WorldState): boolean {
  // Lit from golden hour, the way a village lights up while the sky is still
  // bright: the glow against a sunset is the whole picture.
  if (state.lanternsLit === "auto") return nightness(state.timeOfDay) > 0.35 || (state.timeOfDay >= 17 && state.timeOfDay < 19.5) || state.weather === "fog" || state.weather === "storm";
  return state.lanternsLit;
}

export function firefliesOn(state: WorldState): boolean {
  if (state.fireflies === "auto") return isNight(state) && state.weather !== "snow" && state.weather !== "storm" && state.season !== "winter";
  return state.fireflies;
}

export function petalDensity(state: WorldState): number {
  if (state.petals !== "auto") return state.petals;
  if (state.season === "spring") return 0.6;
  if (state.season === "autumn") return 0.35;
  return 0;
}

/** Rain and snow put fireballs out. That is the whole point of the fireballs. */
export function fireballsFizzle(state: WorldState): boolean {
  return state.weather === "rain" || state.weather === "storm" || state.weather === "snow" || state.flood > 0.5;
}

export function rainAmount(state: WorldState): number {
  if (state.weather === "rain") return 0.7;
  if (state.weather === "storm") return 1;
  return 0;
}

export function snowAmount(state: WorldState): number {
  return state.weather === "snow" ? 1 : 0;
}

export function cloudAmount(state: WorldState): number {
  switch (state.weather) {
    case "clear": return 0.25;
    case "cloudy": return 0.8;
    case "rain": return 0.9;
    case "storm": return 1;
    case "snow": return 0.85;
    case "fog": return 0.6;
  }
}

export function fogDensity(state: WorldState): number {
  // Enough haze that the far hills recede and pale, which is most of what
  // makes a valley read as deep; near things are untouched.
  const base = { clear: 0.0052, cloudy: 0.0065, rain: 0.01, storm: 0.012, snow: 0.013, fog: 0.03 }[state.weather];
  return base + state.fog * 0.03 + nightness(state.timeOfDay) * 0.002;
}

/** Ground is white when it is winter or snowing. */
export function snowCover(state: WorldState): number {
  let s = state.season === "winter" ? 0.85 : 0;
  if (state.weather === "snow") s = Math.max(s, 1);
  return s;
}

/** A short, honest description of the world for the agent to read back. */
export function describeState(state: WorldState): string {
  const h = Math.floor(state.timeOfDay);
  const m = Math.round((state.timeOfDay - h) * 60);
  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const counts = new Map<string, number>();
  for (const p of state.props) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  const spawned = [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(", ") || "nothing extra";
  return [
    `Place: ${state.title}, a small valley village in rural Japan (river, rice paddies, a shrine on the hill, a torii gate, a wooden bridge).`,
    `Time ${time} (${isNight(state) ? "night" : nightness(state.timeOfDay) > 0.3 ? "dusk/dawn" : "day"}), clock ${state.clockRunning ? "running" : "stopped"}.`,
    `Weather ${state.weather}, season ${state.season}, wind ${Math.round(state.wind * 100)}%, extra fog ${Math.round(state.fog * 100)}%.`,
    `Lanterns ${lanternsOn(state) ? "lit" : "dark"}, fireflies ${firefliesOn(state) ? "out" : "none"}, petals ${Math.round(petalDensity(state) * 100)}%.`,
    `Fireballs ${state.fireballs.on ? `ON at ${state.fireballs.rate}/s${fireballsFizzle(state) ? " but the weather is putting them out" : ""}` : "off"}; player hit ${state.hits} times.`,
    `Gravity ${state.gravity}, speed x${state.speed}, flood ${Math.round(state.flood * 100)}%, aurora ${Math.round(state.aurora * 100)}%, meteors ${Math.round(state.meteors * 100)}%, scale x${state.giant}.`,
    `Palette ${state.palette ? `custom (sky ${state.palette.sky}, horizon ${state.palette.horizon}, ground ${state.palette.ground})` : "natural"}.`,
    `Spawned by magic: ${spawned}. The sign reads: "${state.sign}".`,
    `The Magic Screen in the square shows ${state.screen ? `"${state.screen.title}"` : "its welcome card"}${state.screenWriting ? `; a new program is being written ("${state.screenWriting.request}")` : ""}. Lanterns on the river: ${state.wishes.length}.`,
  ].join("\n");
}
