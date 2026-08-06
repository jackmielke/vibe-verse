/**
 * Ten levels, one per corner of the vibeverse.
 *
 * Each picks its own **tuning** — a tempo, a blocks-per-beat and a jump apex —
 * and everything else falls out of those three numbers (see `derive` in
 * physics.ts). That is what makes these different games rather than different
 * paint: the moon has a slow tempo and a huge floaty arc, the kart track is
 * fast and flat, and in both of them one jump is still exactly one beat, so
 * every level stays welded to its own music.
 *
 * The scores are written by hand, beat by beat. Nothing here is generated.
 */
import { Builder, type CubeBeat, type Motif } from "../build";
import type { Level, Section } from "../types";

/* ── shared background bars ───────────────────────────────────────────────
   Drawn by hand, eight beats each, tiled. Architecture only: every spike in
   this game is a real one, so a painted spike is not a thing a level may
   contain. A building can be scenery because nobody has ever mistaken a
   building for a spike. */

const BAR_CITY: Motif[] = [
  ["far", 0, 6], ["far", 5, 9], ["far", 12, 5], ["far", 17, 11],
  ["far", 23, 7], ["far", 29, 10], ["far", 35, 6],
  ["plinth", 4, 3, 2], ["tower", 10, 4], ["mark", 15, 6],
  ["plinth", 17, 2, 3], ["tower", 25, 6], ["plinth", 30, 4, 2], ["tower", 38, 3],
];

/** Masts and cable towers. */
const BAR_BRIDGE: Motif[] = [
  ["far", 1, 14], ["far", 9, 5], ["far", 20, 16], ["far", 30, 6], ["far", 36, 9],
  ["tower", 2, 11], ["plinth", 12, 3, 2], ["mark", 17, 8],
  ["tower", 21, 13], ["plinth", 28, 2, 3], ["tower", 34, 5],
];

/** Palms and huts: short, wide, friendly. */
const BAR_ISLAND: Motif[] = [
  ["far", 2, 5], ["far", 11, 7], ["far", 21, 4], ["far", 31, 6],
  ["plinth", 3, 4, 2], ["tower", 9, 5], ["plinth", 15, 3, 1],
  ["mark", 20, 5], ["plinth", 24, 5, 2], ["tower", 32, 6], ["plinth", 36, 3, 1],
];

/** Gantries and dishes: tall, thin, cold. */
const BAR_STATION: Motif[] = [
  ["far", 0, 12], ["far", 7, 16], ["far", 15, 9], ["far", 24, 18], ["far", 33, 11],
  ["tower", 3, 9], ["tower", 11, 14], ["mark", 18, 10],
  ["plinth", 21, 2, 5], ["tower", 27, 12], ["plinth", 34, 3, 3],
];

/** Stacks and rigs: dense, blocky, loud. */
const BAR_RIG: Motif[] = [
  ["far", 1, 8], ["far", 6, 13], ["far", 13, 7], ["far", 19, 15],
  ["far", 26, 9], ["far", 32, 12], ["far", 38, 7],
  ["plinth", 2, 4, 3], ["tower", 8, 7], ["plinth", 14, 3, 4],
  ["mark", 19, 7], ["tower", 22, 9], ["plinth", 28, 5, 3], ["tower", 35, 6],
];

/** Almost nothing. For the levels that want the dark. */
const BAR_EMPTY: Motif[] = [
  ["far", 6, 8], ["far", 22, 11], ["far", 34, 6],
  ["tower", 12, 4], ["mark", 27, 5],
];

/** Low and flat, for corridors where nothing may reach the ceiling. */
const BAR_LOW: Motif[] = [
  ["plinth", 1, 3, 2], ["plinth", 12, 2, 3], ["mark", 17, 3],
  ["plinth", 19, 3, 2], ["plinth", 28, 4, 2], ["tower", 34, 3],
];

type Pal = Omit<Section, "x">;

/** Build a palette without repeating the field names eleven times. */
function pal(
  name: string,
  bg: [string, string],
  solid: string,
  hazard: string,
  accent: string,
  ground: string,
  strobe: number,
): Pal {
  return { name, bg, solid, hazard, accent, ground, strobe };
}

function sections(b: Builder, list: Array<[number, Pal]>) {
  for (const [at, p] of list) b.section({ x: b.beat(at), ...p });
}

/* ═════════════════════════════════════════════════════════════════════════
   1. FREE FALL — San Francisco
   Fog, and a bridge you fly through. 128 BPM, standard arc.
   ═════════════════════════════════════════════════════════════════════════ */
export function buildFreeFall(): Level {
  const b = new Builder({
    id: "free-fall",
    name: "Free Fall",
    world: "San Francisco",
    tagline: "Fog on the bay, and a bridge you fly the cables of.",
    tuning: { bpm: 128, blocksPerBeat: 5, apex: 2.6 },
  });

  sections(b, [
    [0, pal("Approach", ["#0b1620", "#243b४a".replace("४", "4")], "#e6f0f6", "#ffffff", "#ff7a3d", "#101f29", 0.12)],
    [26, pal("The cables", ["#101d28", "#3a4d58"], "#f2f7fb", "#ffffff", "#ff9a52", "#16242e", 0.24)],
    [50, pal("Under the deck", ["#060d13", "#1b2a33"], "#dfeaf2", "#ffd9c2", "#ff7a3d", "#0a141b", 0.3)],
    [72, pal("Out to sea", ["#122431", "#4a6a78"], "#ffffff", "#ffffff", "#8fd8ff", "#16303d", 0.2)],
  ]);

  for (const n of [26, 38, 50, 62, 72, 84]) b.checkpoint(b.beat(n));

  b.cube([
    ["spikes", 3, 1], ["spikes", 5, 2], ["spikes", 8, 1],
    ["step", 10, 5, 1], ["spikes", 14, 2], ["saw", 17, 2.6],
    ["spikes", 20, 3], ["spikes", 22, 2], ["teeth", 24, 3],
  ]);
  b.dress(b.beat(0), b.beat(26), [BAR_BRIDGE, BAR_CITY], { maxHeight: 8 });

  // The cables: a ship climb that keeps stepping up, like the span itself.
  b.ship(26, 50, [2, 3, 4, 3, 4, 5, 4, 3, 2, 3, 4, 2]);
  b.dress(b.beat(26), b.beat(50), [BAR_LOW], { maxHeight: 4, ceiling: 9.5 });
  b.saws(b.beat(33) + 0.5, 5, 1.5);
  b.saws(b.beat(43) + 0.5, 2, 1.5);

  b.cube([
    ["spikes", 53, 2], ["teeth", 55, 3], ["spikes", 58, 2],
    ["step", 60, 5, 2], ["spikes", 64, 3], ["saw", 66, 2.6],
    ["spikes", 69, 2],
  ]);
  b.dress(b.beat(50), b.beat(72), [BAR_CITY, BAR_BRIDGE], { maxHeight: 7 });

  // Out over the water: the fog closes in and the level becomes a wave.
  b.wave(72, 90, [
    [71, 2.4], [76, 2.4], [80, 6], [84, 3], [88, 5.5], [91, 2.4],
  ]);
  for (let n = 74; n < 90; n += 5) b.saws(b.beat(n), 10, 2);

  b.cube([["spikes", 93, 2], ["spikes", 95, 1]]);
  b.dress(b.beat(90), b.beat(96), [BAR_EMPTY], { maxHeight: 5 });

  // Coins: the apex of a jump you did not have to make.
  b.coinOnBeat(6);
  b.coinOnBeat(51);

  return b.finish(96, { mode: "cube", grav: 1, y: 0 });
}

/* ═════════════════════════════════════════════════════════════════════════
   2. CARDBOARD — Vibe Island
   Papercraft, warm, and floaty: 100 BPM with a six-block beat and a tall arc,
   so every jump hangs. The gentlest level in the set.
   ═════════════════════════════════════════════════════════════════════════ */
export function buildCardboard(): Level {
  const b = new Builder({
    id: "cardboard",
    name: "Cardboard",
    world: "Vibe Island",
    tagline: "Papercraft and warm light. Long, slow, floaty jumps.",
    tuning: { bpm: 100, blocksPerBeat: 6, apex: 3.2 },
  });

  sections(b, [
    [0, pal("The lawn", ["#8fd3ff", "#ffe9b8"], "#fff8e8", "#ff8a5c", "#2fbf71", "#c98b4b", 0.08)],
    [24, pal("The huts", ["#7ec9ff", "#ffd79a"], "#fffdf6", "#ff7043", "#26a65b", "#b87a3f", 0.14)],
    [46, pal("The lagoon", ["#5fc3e4", "#bff0ff"], "#ffffff", "#ff6f4a", "#00b4d8", "#1c7a94", 0.18)],
    [66, pal("Sunset", ["#ff9e6d", "#ffd9a0"], "#fffaf2", "#e8452c", "#ffb703", "#a8552c", 0.22)],
  ]);

  for (const n of [16, 30, 46, 58, 70, 80]) b.checkpoint(b.beat(n));

  b.cube([
    ["spikes", 3, 1], ["spikes", 6, 1], ["step", 9, 6, 1],
    ["spikes", 13, 2], ["spikes", 16, 1], ["pad", 19],
    ["spikes", 22, 2],
  ]);
  b.dress(b.beat(0), b.beat(24), [BAR_ISLAND], { maxHeight: 5 });

  b.cube([
    ["spikes", 26, 2], ["teeth", 29, 2], ["step", 32, 7, 2],
    ["spikes", 36, 2], ["spikes", 39, 3], ["saw", 41, 3.2],
    ["spikes", 44, 2],
  ]);
  b.dress(b.beat(24), b.beat(46), [BAR_ISLAND, BAR_CITY], { maxHeight: 6 });

  // The lagoon: a wide, forgiving tube.
  b.wave(46, 64, [[45, 3], [50, 3], [55, 7], [60, 3], [65, 4]], 2.1);
  for (let n = 48; n < 64; n += 6) b.saws(b.beat(n), 11, 2);

  b.cube([
    ["spikes", 68, 1], ["spikes", 71, 2], ["step", 74, 6, 1],
    ["spikes", 78, 2], ["pad", 81], ["spikes", 84, 2],
  ]);
  b.dress(b.beat(64), b.beat(88), [BAR_ISLAND], { maxHeight: 6 });

  // Coins: the apex of a jump you did not have to make.
  b.coinOnBeat(4);
  b.coinOnBeat(27);
  b.coinOnBeat(66);

  return b.finish(88, { mode: "cube", grav: 1, y: 0 });
}

/* ═════════════════════════════════════════════════════════════════════════
   3. UNIT 7 — Space Outpost
   The lowest gravity in the set: 96 BPM, six blocks a beat, a 3.6-block apex.
   Jumps hang for two thirds of a second and the ship drifts like it is in a
   vacuum, because the tuning makes the flying modes floaty too.
   ═════════════════════════════════════════════════════════════════════════ */
export function buildUnit7(): Level {
  const b = new Builder({
    id: "unit-7",
    name: "Unit 7",
    world: "Space Outpost",
    tagline: "Low gravity. Everything hangs, including you.",
    tuning: { bpm: 96, blocksPerBeat: 6, apex: 3.6 },
  });

  sections(b, [
    [0, pal("Airlock", ["#05060f", "#131a3a"], "#dfe4ff", "#ffffff", "#7c8cff", "#0a0d1f", 0.14)],
    [22, pal("The gantry", ["#070a1a", "#1d2450"], "#e8ecff", "#ffffff", "#a78bfa", "#101538", 0.26)],
    [46, pal("Orbit", ["#02030a", "#0b1030"], "#ffffff", "#8fe4ff", "#38bdf8", "#060a1c", 0.34)],
    [72, pal("The long fall", ["#0a0620", "#2a1550"], "#f2e9ff", "#ffffff", "#c084fc", "#150a30", 0.4)],
  ]);

  for (const n of [22, 34, 46, 58, 72, 84]) b.checkpoint(b.beat(n));

  b.cube([
    ["spikes", 3, 1], ["spikes", 6, 2], ["step", 9, 6, 2],
    ["spikes", 13, 2], ["teeth", 16, 3], ["spikes", 19, 2],
  ]);
  b.dress(b.beat(0), b.beat(22), [BAR_STATION], { maxHeight: 9 });

  b.ship(22, 46, [3, 4, 3, 2, 3, 4, 5, 4, 3, 2, 3, 4], 10.5);
  b.dress(b.beat(22), b.beat(46), [BAR_LOW], { maxHeight: 4, ceiling: 10.5 });
  b.saws(b.beat(30), 6, 2);
  b.saws(b.beat(40), 3, 2);

  b.ball(46, 70, [
    [50, 2, "floor"], [54, 2, "ceil"], [58, 3, "floor"],
    [62, 2, "ceil"], [66, 2, "floor"],
  ], 7);
  b.dress(b.beat(46), b.beat(70), [BAR_LOW], { maxHeight: 4, ceiling: 7 });
  b.saws(b.beat(60), 3.2, 2);

  b.cube([
    ["spikes", 74, 2], ["saw", 77, 3.6], ["spikes", 80, 3],
    ["step", 83, 6, 2], ["spikes", 87, 2], ["spikes", 90, 2],
  ]);
  b.dress(b.beat(70), b.beat(96), [BAR_STATION], { maxHeight: 10 });

  // Coins: the apex of a jump you did not have to make.
  b.coinOnBeat(4);
  b.coinOnBeat(72);

  return b.finish(96, { mode: "cube", grav: 1, y: 0 });
}

/* ═════════════════════════════════════════════════════════════════════════
   4. AFTERPARTY — EDM Town
   The fastest cube in the set: 140 BPM on a four-block beat, so a jump lasts
   0.43 s. Tight, bright, and relentless.
   ═════════════════════════════════════════════════════════════════════════ */
export function buildAfterparty(): Level {
  const b = new Builder({
    id: "afterparty",
    name: "Afterparty",
    world: "EDM Town",
    tagline: "140 BPM. Short jumps, no gaps, and the lights never stop.",
    tuning: { bpm: 140, blocksPerBeat: 4, apex: 2.2 },
  });

  sections(b, [
    [0, pal("Doors", ["#12021e", "#2d0a4a"], "#ffe9ff", "#ff2bd6", "#ff2bd6", "#1a0430", 0.4)],
    [28, pal("Main room", ["#ff2bd6", "#2b1bff"], "#ffffff", "#ffe600", "#00f0ff", "#7a1090", 0.95)],
    [56, pal("The booth", ["#04001a", "#1b0060"], "#e0e8ff", "#ff2bd6", "#7dffd4", "#0a0330", 0.6)],
    [84, pal("Sunrise", ["#ff7a2b", "#ffe600"], "#fffdf0", "#e8102b", "#ff2bd6", "#a83a10", 0.85)],
  ]);

  for (const n of [16, 28, 42, 56, 70, 84, 98]) b.checkpoint(b.beat(n));

  b.cube([
    ["spikes", 4, 1], ["spikes", 6, 1], ["spikes", 8, 2],
    ["spikes", 11, 1], ["spikes", 13, 2], ["teeth", 16, 3],
    ["spikes", 19, 2], ["spikes", 21, 1], ["spikes", 23, 2], ["spikes", 25, 1],
  ]);
  b.dress(b.beat(0), b.beat(28), [BAR_RIG, BAR_CITY], { maxHeight: 7 });

  b.cube([
    ["spikes", 30, 2], ["spikes", 32, 1], ["saw", 34, 2.2],
    ["spikes", 37, 2], ["step", 39, 4, 1], ["spikes", 43, 2],
    ["spikes", 45, 1], ["teeth", 47, 3], ["spikes", 50, 2], ["spikes", 52, 2],
  ]);
  b.dress(b.beat(28), b.beat(56), [BAR_RIG], { maxHeight: 8 });

  b.ball(56, 82, [
    [60, 2, "floor"], [64, 2, "ceil"], [68, 3, "floor"],
    [72, 2, "ceil"], [76, 2, "floor"], [79, 2, "ceil"],
  ], 6);
  b.dress(b.beat(56), b.beat(82), [BAR_LOW], { maxHeight: 3, ceiling: 6 });
  b.saws(b.beat(70), 3, 2);

  b.cube([
    ["spikes", 86, 2], ["spikes", 88, 1], ["spikes", 90, 2],
    ["pad", 93], ["spikes", 96, 2], ["spikes", 98, 1],
    ["spikes", 100, 2], ["spikes", 103, 2], ["spikes", 106, 1],
  ]);
  b.dress(b.beat(82), b.beat(110), [BAR_RIG, BAR_CITY], { maxHeight: 8 });

  // Coins: the apex of a jump you did not have to make.
  b.coinOnBeat(2);
  b.coinOnBeat(84);

  return b.finish(112, { mode: "cube", grav: 1, y: 0 });
}

/* ═════════════════════════════════════════════════════════════════════════
   5. HYDRO — Seafair
   The wave level. Two long tubes and very little ground, because a hydroplane
   race is a thing you steer rather than a thing you jump.
   ═════════════════════════════════════════════════════════════════════════ */
export function buildHydro(): Level {
  const b = new Builder({
    id: "hydro",
    name: "Hydro",
    world: "Seafair",
    tagline: "Mostly wave. Steer the wake, and try not to touch anything.",
    tuning: { bpm: 118, blocksPerBeat: 5, apex: 2.6 },
  });

  sections(b, [
    [0, pal("The dock", ["#04121c", "#0d3550"], "#eaf6ff", "#ffffff", "#38bdf8", "#07202f", 0.16)],
    [18, pal("First heat", ["#06263a", "#1179b0"], "#ffffff", "#ffe600", "#7dffd4", "#0a3a55", 0.34)],
    [48, pal("The turn", ["#021a2a", "#0a5a86"], "#f0fbff", "#ff5c3d", "#38bdf8", "#063348", 0.4)],
    [74, pal("The straight", ["#0a4a70", "#9fe8ff"], "#ffffff", "#ff5c3d", "#ffffff", "#0d5c86", 0.28)],
  ]);

  for (const n of [18, 32, 48, 60, 74, 88]) b.checkpoint(b.beat(n));

  b.cube([
    ["spikes", 3, 1], ["spikes", 6, 2], ["step", 9, 5, 1], ["spikes", 13, 2],
  ]);
  b.dress(b.beat(0), b.beat(18), [BAR_RIG], { maxHeight: 6 });

  b.wave(18, 46, [
    [17, 2.4], [22, 2.4], [27, 6.5], [32, 3], [37, 6.5], [42, 2.6], [47, 3.4],
  ], 1.9);
  for (let n = 20; n < 46; n += 6) b.saws(b.beat(n), 11, 2);

  b.cube([
    ["spikes", 50, 2], ["teeth", 53, 3], ["spikes", 56, 2],
    ["step", 58, 5, 2], ["spikes", 62, 3], ["saw", 65, 2.6], ["spikes", 68, 2],
  ]);
  b.dress(b.beat(48), b.beat(74), [BAR_RIG, BAR_CITY], { maxHeight: 7 });

  b.wave(74, 96, [
    [73, 3], [78, 3], [83, 7], [88, 3.5], [93, 6], [97, 3],
  ], 1.9);
  for (let n = 76; n < 96; n += 6) b.saws(b.beat(n), 11.5, 2);

  b.cube([["spikes", 99, 2]]);
  b.dress(b.beat(96), b.beat(100), [BAR_EMPTY], { maxHeight: 4 });

  // Coins: the apex of a jump you did not have to make.
  b.coinOnBeat(4);
  b.coinOnBeat(71);

  return b.finish(100, { mode: "cube", grav: 1, y: 0 });
}

/* ═════════════════════════════════════════════════════════════════════════
   6. NIGHT SHIFT — Five Nights at Vibey's
   Slow, heavy and nearly black. 84 BPM with a wide beat: you have time to
   think, and almost nothing to look at while you do it. The level where the
   sonar earns its place.
   ═════════════════════════════════════════════════════════════════════════ */
export function buildNightShift(): Level {
  const b = new Builder({
    id: "night-shift",
    name: "Night Shift",
    world: "Five Nights at Vibey's",
    tagline: "Slow, heavy and nearly black. Bring the sonar.",
    tuning: { bpm: 84, blocksPerBeat: 5.5, apex: 2.8 },
  });

  sections(b, [
    [0, pal("Midnight", ["#050203", "#150406"], "#d8cfc8", "#ffffff", "#b91c1c", "#0a0405", 0.06)],
    [20, pal("The hall", ["#030101", "#1a0508"], "#cfc4bb", "#ff3b3b", "#7f1d1d", "#0d0304", 0.12)],
    [44, pal("The kitchen", ["#0a0402", "#241008"], "#e8dccb", "#ff6b3b", "#c2410c", "#160804", 0.18)],
    [64, pal("Six a.m.", ["#1a1004", "#5a3a10"], "#fff4d8", "#ffb703", "#ffd166", "#3a2408", 0.3)],
  ]);

  for (const n of [20, 32, 44, 56, 64, 74]) b.checkpoint(b.beat(n));

  b.cube([
    ["spikes", 4, 1], ["spikes", 8, 2], ["step", 11, 6, 1],
    ["spikes", 15, 1], ["teeth", 18, 3],
  ]);
  b.dress(b.beat(0), b.beat(20), [BAR_EMPTY], { maxHeight: 5 });

  b.cube([
    ["spikes", 22, 2], ["spikes", 26, 1, { alpha: 0.14 }], ["saw", 29, 2.8],
    ["spikes", 33, 2], ["teeth", 36, 3], ["spikes", 40, 2],
  ]);
  b.dress(b.beat(20), b.beat(44), [BAR_EMPTY, BAR_RIG], { maxHeight: 6 });

  b.ship(44, 62, [2, 3, 2, 4, 3, 2, 3, 2, 3], 9);
  b.dress(b.beat(44), b.beat(62), [BAR_LOW], { maxHeight: 4, ceiling: 9 });
  b.saws(b.beat(52), 4.5, 2);

  b.cube([
    ["spikes", 66, 2], ["spikes", 70, 1, { alpha: 0.14 }],
    ["spikes", 74, 2], ["pad", 77], ["spikes", 81, 2],
  ]);
  b.dress(b.beat(62), b.beat(84), [BAR_EMPTY], { maxHeight: 5 });

  // Coins: the apex of a jump you did not have to make.
  b.coinOnBeat(6);
  b.coinOnBeat(24);
  b.coinOnBeat(68);

  return b.finish(84, { mode: "cube", grav: 1, y: 0 });
}

/* ═════════════════════════════════════════════════════════════════════════
   7. GRAND PRIX — Vibe Kart
   The fastest thing here: 150 BPM. Long clean straights and sudden corners.
   ═════════════════════════════════════════════════════════════════════════ */
export function buildGrandPrix(): Level {
  const b = new Builder({
    id: "grand-prix",
    name: "Grand Prix",
    world: "Vibe Kart",
    tagline: "150 BPM. Long straights, late corners, no time to think.",
    tuning: { bpm: 150, blocksPerBeat: 4.5, apex: 2.4 },
  });

  sections(b, [
    [0, pal("Grid", ["#0a0a0c", "#26262c"], "#ffffff", "#e11d48", "#fbbf24", "#141418", 0.2)],
    [30, pal("Sector one", ["#12060a", "#4a1020"], "#fff0f3", "#e11d48", "#fb7185", "#22080e", 0.42)],
    [62, pal("Sector two", ["#06120a", "#0d4a26"], "#f0fff5", "#22c55e", "#86efac", "#082a16", 0.42)],
    [94, pal("Last lap", ["#1a1204", "#5a3c0a"], "#fffbe8", "#fbbf24", "#fde047", "#2e2006", 0.6)],
  ]);

  for (const n of [18, 30, 46, 62, 78, 94, 108]) b.checkpoint(b.beat(n));

  b.cube([
    ["spikes", 4, 1], ["spikes", 7, 2], ["spikes", 10, 1],
    ["step", 13, 5, 1], ["spikes", 17, 2], ["spikes", 20, 2],
    ["saw", 23, 2.4], ["spikes", 27, 2],
  ]);
  b.dress(b.beat(0), b.beat(30), [BAR_RIG, BAR_CITY], { maxHeight: 7 });

  b.cube([
    ["spikes", 32, 2], ["spikes", 35, 1], ["teeth", 38, 3],
    ["spikes", 42, 2], ["pad", 45], ["spikes", 49, 2],
    ["spikes", 52, 3], ["spikes", 55, 1], ["spikes", 58, 2],
  ]);
  b.dress(b.beat(30), b.beat(62), [BAR_CITY, BAR_RIG], { maxHeight: 8 });

  b.ball(62, 92, [
    [66, 2, "floor"], [70, 2, "ceil"], [74, 3, "floor"],
    [78, 2, "ceil"], [82, 2, "floor"], [86, 3, "ceil"],
  ], 6);
  b.dress(b.beat(62), b.beat(92), [BAR_LOW], { maxHeight: 3, ceiling: 6 });
  b.saws(b.beat(80), 3, 2);

  b.cube([
    ["spikes", 96, 2], ["spikes", 99, 2], ["saw", 102, 2.4],
    ["spikes", 106, 2], ["spikes", 109, 1], ["spikes", 112, 2], ["spikes", 115, 2],
  ]);
  b.dress(b.beat(92), b.beat(120), [BAR_RIG], { maxHeight: 8 });

  // Coins: the apex of a jump you did not have to make.
  b.coinOnBeat(5);
  b.coinOnBeat(94);

  return b.finish(120, { mode: "cube", grav: 1, y: 0 });
}

/* ═════════════════════════════════════════════════════════════════════════
   8. THE LONG SILENCE — The Vibeverse
   Deep space, monochrome, and almost entirely wave. 90 BPM.
   ═════════════════════════════════════════════════════════════════════════ */
export function buildLongSilence(): Level {
  const b = new Builder({
    id: "long-silence",
    name: "The Long Silence",
    world: "The Vibeverse",
    tagline: "Deep space, one colour, and a very long tube.",
    tuning: { bpm: 90, blocksPerBeat: 6, apex: 3 },
  });

  sections(b, [
    [0, pal("Drift", ["#000306", "#031018"], "#cfeaf5", "#ffffff", "#25f2ff", "#010a10", 0.1)],
    [20, pal("The corridor", ["#000508", "#04202c"], "#e8fbff", "#8fe4ff", "#25f2ff", "#021620", 0.24)],
    [52, pal("Something out there", ["#01060a", "#062a38"], "#ffffff", "#25f2ff", "#7dffd4", "#031c26", 0.34)],
    [72, pal("Silence", ["#000204", "#020e14"], "#dff6ff", "#ffffff", "#25f2ff", "#01080c", 0.14)],
  ]);

  for (const n of [20, 34, 52, 62, 72, 80]) b.checkpoint(b.beat(n));

  b.cube([
    ["spikes", 3, 1], ["spikes", 7, 2], ["step", 10, 6, 2], ["spikes", 14, 2],
  ]);
  b.dress(b.beat(0), b.beat(20), [BAR_STATION], { maxHeight: 9 });

  b.wave(20, 50, [
    [19, 3], [24, 3], [29, 7.5], [34, 3.5], [39, 7], [44, 3], [49, 5], [51, 3],
  ], 2);
  for (let n = 22; n < 50; n += 7) b.saws(b.beat(n), 12, 2.5);

  b.ship(52, 70, [3, 4, 5, 4, 3, 2, 3, 4, 3], 11);
  b.dress(b.beat(52), b.beat(70), [BAR_LOW], { maxHeight: 4, ceiling: 11 });
  b.saws(b.beat(60), 5.5, 2);

  b.cube([
    ["spikes", 74, 2], ["saw", 77, 3], ["spikes", 80, 2], ["spikes", 83, 1],
  ]);
  b.dress(b.beat(70), b.beat(84), [BAR_STATION, BAR_EMPTY], { maxHeight: 10 });

  // Coins: the apex of a jump you did not have to make.
  b.coinOnBeat(5);
  b.coinOnBeat(76);

  return b.finish(84, { mode: "cube", grav: 1, y: 0 });
}

/* ═════════════════════════════════════════════════════════════════════════
   9. GENESIS — Evolve
   Organic, green, and growing: every platform is taller than the last.
   ═════════════════════════════════════════════════════════════════════════ */
export function buildGenesis(): Level {
  const b = new Builder({
    id: "genesis",
    name: "Genesis",
    world: "Genesis Bloom",
    tagline: "Something is growing, and the level grows with it.",
    tuning: { bpm: 110, blocksPerBeat: 5, apex: 2.8 },
  });

  sections(b, [
    [0, pal("Spore", ["#02120a", "#06301a"], "#eafff0", "#ffffff", "#4ade80", "#04200f", 0.12)],
    [24, pal("Sprout", ["#04200f", "#0d5c2a"], "#f0fff5", "#a3e635", "#4ade80", "#073d1c", 0.24)],
    [48, pal("Canopy", ["#0a3d18", "#3fa34d"], "#ffffff", "#ffe600", "#bbf7d0", "#0d5228", 0.34)],
    [70, pal("Bloom", ["#3fa34d", "#f7ff9c"], "#ffffff", "#e8452c", "#ffe600", "#2b7a3a", 0.42)],
  ]);

  for (const n of [16, 30, 48, 60, 70, 82]) b.checkpoint(b.beat(n));

  b.cube([
    ["spikes", 3, 1], ["step", 6, 5, 1], ["spikes", 10, 2],
    ["step", 13, 5, 2], ["spikes", 17, 2], ["teeth", 20, 3],
  ]);
  b.dress(b.beat(0), b.beat(24), [BAR_ISLAND], { maxHeight: 6 });

  b.cube([
    ["spikes", 26, 2], ["step", 29, 5, 2], ["spikes", 33, 3],
    ["saw", 36, 2.8], ["spikes", 39, 2], ["pad", 42], ["spikes", 45, 2],
  ]);
  b.dress(b.beat(24), b.beat(48), [BAR_ISLAND, BAR_CITY], { maxHeight: 8 });

  b.ship(48, 68, [2, 3, 4, 5, 4, 3, 4, 5, 3], 10);
  b.dress(b.beat(48), b.beat(68), [BAR_LOW], { maxHeight: 4, ceiling: 10 });
  b.saws(b.beat(56), 5, 2);

  b.cube([
    ["spikes", 72, 2], ["step", 75, 5, 2], ["spikes", 79, 3],
    ["teeth", 82, 3], ["spikes", 85, 2], ["spikes", 88, 2],
  ]);
  b.dress(b.beat(68), b.beat(92), [BAR_ISLAND], { maxHeight: 9 });

  // Coins: the apex of a jump you did not have to make.
  b.coinOnBeat(4);
  b.coinOnBeat(90);

  return b.finish(92, { mode: "cube", grav: 1, y: 0 });
}

/* ═════════════════════════════════════════════════════════════════════════
   10. FRACTAL HALL — Fractal Museum
   Pale, symmetric and geometric. The second half answers the first: the same
   score, in the same order, with the ceiling and the floor swapped over.
   ═════════════════════════════════════════════════════════════════════════ */
export function buildFractalHall(): Level {
  const b = new Builder({
    id: "fractal-hall",
    name: "Fractal Hall",
    world: "Fractal Museum",
    tagline: "Symmetric. The back half answers the front half, upside down.",
    tuning: { bpm: 126, blocksPerBeat: 5, apex: 2.6 },
  });

  sections(b, [
    [0, pal("West wing", ["#f6f2ff", "#d9cfff"], "#3b2a5a", "#7c3aed", "#a78bfa", "#c4b5fd", 0.12)],
    [24, pal("The mirror", ["#efe6ff", "#b9a8ff"], "#2e1f4a", "#6d28d9", "#c084fc", "#a78bfa", 0.24)],
    [48, pal("East wing", ["#e9e0ff", "#8b7bd8"], "#241640", "#5b21b6", "#ddd6fe", "#8b7bd8", 0.3)],
    [72, pal("The atrium", ["#fdfaff", "#cfc0ff"], "#1e1236", "#7c3aed", "#f5d0fe", "#b7a6f0", 0.2)],
  ]);

  for (const n of [16, 24, 36, 48, 60, 72, 84]) b.checkpoint(b.beat(n));

  // The theme, stated plainly.
  const THEME: CubeBeat[] = [
    ["spikes", 3, 1], ["spikes", 6, 2], ["step", 9, 5, 1],
    ["spikes", 13, 2], ["teeth", 16, 3], ["spikes", 19, 2], ["spikes", 21, 1],
  ];
  b.cube(THEME);
  b.dress(b.beat(0), b.beat(24), [BAR_STATION], { maxHeight: 8 });

  // …and again, transposed twenty-four beats and answered by a sawblade
  // wherever the first statement had teeth.
  b.cube(
    THEME.map((m) => {
      const shifted = [...m] as CubeBeat;
      (shifted[1] as number) = (m[1] as number) + 24;
      if (shifted[0] === "teeth") return ["saw", (m[1] as number) + 24, 2.6] as CubeBeat;
      return shifted;
    }),
  );
  b.dress(b.beat(24), b.beat(48), [BAR_STATION, BAR_CITY], { maxHeight: 9 });

  b.ship(48, 70, [3, 2, 3, 4, 3, 2, 3, 4, 3, 2], 9.5);
  b.dress(b.beat(48), b.beat(70), [BAR_LOW], { maxHeight: 4, ceiling: 9.5 });
  b.saws(b.beat(56), 4.6, 1.5);
  b.saws(b.beat(64), 2, 1.5);

  // The theme once more, at the end, with the answer and the statement
  // interleaved a beat apart.
  b.cube([
    ["spikes", 74, 1], ["spikes", 76, 2], ["step", 79, 5, 1],
    ["spikes", 83, 2], ["saw", 85, 2.6], ["spikes", 88, 2], ["spikes", 90, 2],
  ]);
  b.dress(b.beat(70), b.beat(96), [BAR_STATION], { maxHeight: 9 });

  // Coins: the apex of a jump you did not have to make.
  b.coinOnBeat(23);
  b.coinOnBeat(72);

  return b.finish(96, { mode: "cube", grav: 1, y: 0 });
}
