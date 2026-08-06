/**
 * I SPY — the level.
 *
 * Every spike in here is a real spike and every sawblade kills. It began as a
 * tribute to the Geometry Dash level of the same name, which is built on
 * painted hazards you cannot tell from lethal ones; that idea is gone, on
 * purpose, and what is left is a level where what you see is what is there.
 *
 * It is written on beats, not on blocks. One jump is one beat is five blocks
 * (see `BEAT` in build.ts), so `b.beatSpikes(23, 2)` means "on beat 23 the
 * player jumps, and this is what they jump over". Read the beat numbers down
 * the page and you are reading the rhythm the level is played to.
 *
 * The background is architecture only — see BAR_STREET and friends below. It
 * is drawn behind the play field and dimmed, and it contains no spikes,
 * because a painted spike is exactly the thing this level no longer has.
 *
 * Six movements, 120 beats, sixty seconds:
 *   THE QUIET PART  cube   b0–21    honest. Teaches the language.
 *   I SPY           cube   b21–37   the language starts lying.
 *   (the taster)    wave   b38–42   five beats of wave, eighteen seconds in.
 *   MIRROR          ship   b42–62   gates you have to find inside the noise.
 *   STROBE          ball   b62–80   pink and lime, flipping between ceilings.
 *   GREEN           wave   b80–98   one long tube through a green blowout.
 *   EVERYTHING      cube   b98–120  all of it at once.
 */
import { Builder, type Motif } from "../build";
import { CLASSIC } from "../physics";
import type { Level } from "../types";

/* ── the background ───────────────────────────────────────────────────────
   Four bars of skyline, drawn by hand, eight beats each, tiled along the
   level in an order chosen per movement.

   It is architecture and nothing else. There used to be painted spikes in
   here — rows that looked exactly like the lethal ones and were not — and
   they are gone: **every spike in this game kills you.** A building can be
   scenery because nobody has ever mistaken a building for a spike.

   The x numbers are blocks from the start of the bar; read a column of them
   and you are reading the silhouette. */

/** Low and busy: a street of short buildings. */
const BAR_STREET: Motif[] = [
  ["far", 0, 6], ["far", 5, 9], ["far", 12, 5], ["far", 17, 11],
  ["far", 23, 7], ["far", 29, 10], ["far", 35, 6],
  ["plinth", 4, 3, 2],
  ["tower", 10, 4],
  ["mark", 15, 6],
  ["plinth", 17, 2, 3],
  ["tower", 25, 6],
  ["plinth", 30, 4, 2],
  ["tower", 38, 3],
];

/** Tall and open: fewer things, further apart, reaching higher. */
const BAR_SPIRES: Motif[] = [
  ["far", 2, 12], ["far", 8, 7], ["far", 14, 13], ["far", 21, 8],
  ["far", 27, 12], ["far", 33, 6], ["far", 38, 10],
  ["tower", 2, 7],
  ["plinth", 9, 2, 4],
  ["plinth", 18, 4, 2],
  ["mark", 23, 7],
  ["tower", 25, 5],
  ["tower", 33, 8],
  ["mark", 36, 4],
];

/** Flat: for corridors, where nothing may be taller than the ceiling. */
const BAR_LOW: Motif[] = [
  ["plinth", 1, 3, 2],
  ["plinth", 12, 2, 3],
  ["mark", 17, 3],
  ["plinth", 19, 3, 2],
  ["plinth", 28, 4, 2],
  ["tower", 34, 3],
];

/** Sparse: the quiet part, and the run-out at the end. */
const BAR_SPARSE: Motif[] = [
  ["far", 3, 7], ["far", 14, 10], ["far", 26, 6], ["far", 34, 9],
  ["tower", 4, 3],
  ["mark", 12, 6],
  ["plinth", 33, 2, 2],
];

export function buildISpy(): Level {
  const b = new Builder({
    id: "i-spy",
    name: "I Spy",
    world: "The neon district",
    tagline: "Where it started. A city at night, and everything in it can kill you.",
    tuning: CLASSIC,
  });
  const beat = (n: number) => b.beat(n);
  const onBeat = (n: number, k = 1) => b.onBeat(n, k);
  const BEAT = CLASSIC.blocksPerBeat;

  // ── palettes ───────────────────────────────────────────────────────────
  b.section({
    x: 0, name: "The quiet part",
    bg: ["#02060a", "#07161d"], solid: "#e8f7ff", hazard: "#ffffff",
    accent: "#2ee6c8", ground: "#071820", strobe: 0.1,
  });
  b.section({
    x: beat(21), name: "I spy",
    bg: ["#03040a", "#160726"], solid: "#f4f4ff", hazard: "#ffffff",
    accent: "#ff2fbf", ground: "#12061e", strobe: 0.22,
  });
  b.section({
    x: beat(42), name: "Mirror",
    bg: ["#01080c", "#0a2028"], solid: "#dffbff", hazard: "#ffffff",
    accent: "#25f2ff", ground: "#03151b", strobe: 0.3,
  });
  b.section({
    x: beat(62), name: "Strobe",
    bg: ["#ff1e8e", "#e8ff3a"], solid: "#fff7fb", hazard: "#ff1744",
    accent: "#faff00", ground: "#ff2d95", strobe: 0.95,
  });
  b.section({
    x: beat(80), name: "Green",
    bg: ["#0bff6a", "#003d1a"], solid: "#ffffff", hazard: "#00e05a",
    accent: "#b6ff2f", ground: "#00cc4d", strobe: 0.8,
  });
  b.section({
    x: beat(98), name: "Everything",
    bg: ["#08010f", "#2b0033"], solid: "#ffffff", hazard: "#ff2fbf",
    accent: "#ff2fbf", ground: "#180322", strobe: 0.45,
  });

  checkpoints(b);
  quietPart(b);
  iSpy(b);
  waveTaster(b);
  mirror(b);
  strobe(b);
  green(b);
  everything(b);
  paint(b);

  return b.finish(120, { mode: "cube", grav: 1, y: 0 });
}

/**
 * Checkpoints.
 *
 * Not in the original — Geometry Dash gives you the whole level or nothing,
 * and that is a fine bargain when the level can be read on sight. This one
 * cannot, by construction, so a sixty-second reset for a mistake at 90% is not
 * difficulty, it is a tax on having been curious.
 *
 * One at the mouth of each movement, plus one halfway through the long ones,
 * always on clear ground you can be dropped onto. `PURIST` in the menu turns
 * them all off for the original bargain.
 */
function checkpoints(b: Builder) {
  const beat = (n: number) => b.beat(n);
  for (const n of [21, 31, 42, 52, 62, 71, 80, 89, 98, 106, 113]) b.checkpoint(beat(n));
}

/* ── beats 0–21 ───────────────────────────────────────────────────────────
   Nothing here lies. Every spike is a spike, every jump is on the downbeat,
   and the rhythm is deliberately slow — a jump every two or three beats — so
   that by beat 21 the player is counting without having been told to. */
function quietPart(b: Builder) {
  const beat = (n: number) => b.beat(n);
  const onBeat = (n: number, k = 1) => b.onBeat(n, k);
  const BEAT = b.meta.tuning.blocksPerBeat;
  b.beatSpikes(3);
  b.beatSpikes(5);
  b.beatSpikes(7, 2);

  // Land on the platform exactly on beat 11: a jump lands where the next beat
  // starts, so a platform whose edge is on a beat is a platform you cannot
  // miss. This is the level teaching you what the timing is worth.
  b.beatSpikes(10);
  b.block(beat(11), 0, 5, 1);

  b.beatSpikes(13, 2);
  // A pad on the beat launches you without an input, on the same arc a jump
  // would have. The rhythm continues through it.
  b.pad(beat(15));
  b.spikes(onBeat(15, 3), 3);
  b.beatSpikes(17);
  b.beatSpikes(19, 2);

  // The first decoys stand on the floor beside real ones, where they can be
  // compared. Two seconds of "so THAT'S what a lie looks like" — built as real
  // geometry, because that is what they are pretending to be.
  b.dress(beat(13), beat(21), [BAR_SPARSE], { maxHeight: 3 });

  // The first sawblade in the game hangs where nothing can reach it. You get
  // eight seconds to learn what one looks like before one is in your way.
  b.saws(beat(9), 5.5, 2);

  // COIN 3, over beat 20 — the one beat in the quiet part with nothing after
  // it. Everywhere else in this level, the gap between two hazards is a beat
  // you land on and immediately jump off again, and a coin there asks for a
  // detour with no room to take it. The solver rejected three placements
  // before this one, which is the whole reason it flies these levels.
  b.coinOnBeat(20);
}

/* ── beats 21–42 ──────────────────────────────────────────────────────────
   The lying starts, and it is not "spikes you can ignore" — an unnecessary
   jump lands on the next beat and costs nothing, so a harmless decoy is
   genuinely harmless. What makes a decoy lethal is what is over it. */
function iSpy(b: Builder) {
  const beat = (n: number) => b.beat(n);
  const onBeat = (n: number, k = 1) => b.onBeat(n, k);
  const BEAT = b.meta.tuning.blocksPerBeat;
  b.beatSpikes(22, 2);
  b.beatSpikes(24, 2);

  // ── The move the level is built on ─────────────────────────────────────
  // Beat 26: clear floor, real teeth at head height. Run straight through it.
  // The honest move is to do nothing, which is the hardest thing to do in a
  // game whose only verb is jump.
  b.ceilingSpikes(onBeat(26, 3), 5, 3);

  // Beat 28: floor spikes under an open sky. Now you jump.
  b.beatSpikes(28, 2);

  b.beatSpikes(30, 3);

  // Beat 32: a real sawblade at head height. Same instruction as the teeth,
  // said with the other shape, so both readings have to be learned.
  b.saws(beat(32) + 1, 2.6, 2.5);

  // Real, lethal, and drawn at 15% opacity — the one thing left in the level
  // that is hard to *see* rather than hard to do. Learn it or spend a ping.
  b.beatSpikes(34, 1, { alpha: 0.15 });

  // COIN 1 sits over beat 33, at the exact height of a jump's apex, on a beat
  // with nothing to jump — and one beat after a saw that punishes jumping.
  b.coin(beat(33) + 2.5, 2.6);

  b.beatSpikes(36, 2);

  b.dress(beat(21), beat(37), [BAR_STREET, BAR_SPIRES], { maxHeight: 6 });
}

/* ── beats 38–42 ──────────────────────────────────────────────────────────
   The wave, early.

   The full wave section is at beat 80, forty seconds in, which most people
   were never going to reach — the best-looking mode in the game was hidden
   behind the hardest half of the level. So here is five beats of it at the
   eighteen-second mark, as a taster and as a transition into the ship: a
   clean tube, no paint inside it, nothing to learn except what a wave is. */
function waveTaster(b: Builder) {
  const beat = (n: number) => b.beat(n);
  const onBeat = (n: number, k = 1) => b.onBeat(n, k);
  const BEAT = b.meta.tuning.blocksPerBeat;
  b.portal(beat(38) - 2, 0, { to: "wave" });
  b.tube([
    [beat(38) - 1, 2.4],
    [beat(39), 2.4],
    [beat(40), 5.2],
    [beat(41), 2.6],
    [beat(42) - 1.5, 3.2],
  ], 1.9);
  // Well clear of the tube: a wave dies on contact with anything, and a saw
  // is now anything.
  b.saws(beat(39), 9, 2);
  b.mark(beat(41), 10);
}

/* ── beats 42–62 ──────────────────────────────────────────────────────────
   Ship. A tunnel with a gate every two beats, and enough painted rubbish
   inside it that finding the gate is the whole job. */
function mirror(b: Builder) {
  const beat = (n: number) => b.beat(n);
  const onBeat = (n: number, k = 1) => b.onBeat(n, k);
  const BEAT = b.meta.tuning.blocksPerBeat;
  const CEIL = 9.5;
  b.portal(beat(42) - 2, 0, { to: "ship" });
  b.roof(beat(42), beat(62) + 1, CEIL);

  // Openings on the two-beat pulse, never moving more than two blocks at a
  // time: a ship covers two blocks vertically in about half a second, and the
  // gates are a second apart.
  const gates = [2, 3, 1, 2, 4, 3, 1, 3, 5, 2];
  gates.forEach((lo, i) => {
    const x = beat(43 + i * 2);
    if (lo > 0) b.block(x, 0, 1.6, lo);
    b.block(x, lo + 4.4, 1.6, CEIL - (lo + 4.4));
    // Background masonry between the gates, so the tunnel has walls rather
    // than a void either side of the opening.
    b.plinth(x + 3, 2, Math.max(1, lo));
  });

  // Real saws, in gates you have already learned to trust.
  b.saws(beat(49) + 0.5, 4.5, 1.5);
  b.saws(beat(57) + 0.5, 1, 1.5);

  // COIN 2 rides the ceiling between the two highest gates — the one stretch
  // of tunnel where there is room above the line, and you still have to give
  // up the middle of the corridor for four beats to take it.
  b.coin(beat(52), 7.8);

  b.dress(beat(42), beat(62), [BAR_LOW, BAR_STREET], { maxHeight: 5, ceiling: CEIL });
}

/* ── beats 62–80 ──────────────────────────────────────────────────────────
   Ball, between a floor and a ceiling six blocks apart, in the pink-and-lime
   blowout the level is famous for. Tap to fall the other way. */
function strobe(b: Builder) {
  const beat = (n: number) => b.beat(n);
  const onBeat = (n: number, k = 1) => b.onBeat(n, k);
  const BEAT = b.meta.tuning.blocksPerBeat;
  b.portal(beat(62) - 2, 0, { to: "ball" });
  b.roof(beat(62), beat(80) + 1, 6);

  // Two beats between rows: a flip crosses the six-block gap in about 3.6
  // blocks, so two beats is comfortable and one is not.
  const rows: Array<[number, number, "floor" | "ceil"]> = [
    [64, 2, "floor"],
    [66, 2, "ceil"],
    [68, 3, "floor"],
    [70, 2, "ceil"],
    [72, 2, "floor"],
    [74, 3, "ceil"],
    [76, 2, "floor"],
    [78, 2, "ceil"],
  ];
  for (const [n, count, side] of rows) {
    const x = beat(n);
    if (side === "floor") b.spikes(x, count, 0);
    else b.spikes(x, count, 5, { rot: 180 });

  }

  // One saw dead in the middle of the corridor, on the beat you would have
  // been coasting through.
  b.saws(beat(73), 2.5, 2);

  b.dress(beat(62), beat(80), [BAR_LOW], { maxHeight: 3, ceiling: 6 });
}

/* ── beats 80–98 ──────────────────────────────────────────────────────────
   Wave. One continuous tube whose centreline wanders, its corners on beats.
   The wave dies on contact with anything solid, so the tube is drawn wide —
   3.6 blocks — and then filled with green paint until you cannot see where it
   goes. */
function green(b: Builder) {
  const beat = (n: number) => b.beat(n);
  const onBeat = (n: number, k = 1) => b.onBeat(n, k);
  const BEAT = b.meta.tuning.blocksPerBeat;
  b.portal(beat(80) - 2, 0, { to: "wave" });

  b.tube([
    [beat(79), 2.2], [beat(83), 2.2], [beat(87), 6.4], [beat(90), 6.4],
    [beat(93), 2.6], [beat(95), 5.2], [beat(98), 2.0], [beat(99), 2.0],
  ]);

  // No dressing inside a wave tube: the wave dies on contact with anything,
  // so a corridor you cannot read is not a hard section, it is a coin flip.
  // The green does the lying here, and the gears do the decorating — placed
  // above the tube, where they can be seen and never confused for a wall.
  for (let n = 82; n < 98; n += 5) b.saws(beat(n), 11, 2);
  for (let n = 84; n < 98; n += 6) b.mark(beat(n), 13);

  b.portal(beat(98) + 1, 0, { to: "cube" });
}

/* ── beats 98–120 ─────────────────────────────────────────────────────────
   Cube again, with everything the level has taught you, at a beat a jump. */
function everything(b: Builder) {
  const beat = (n: number) => b.beat(n);
  const onBeat = (n: number, k = 1) => b.onBeat(n, k);
  const BEAT = b.meta.tuning.blocksPerBeat;
  b.beatSpikes(100);
  b.beatSpikes(102, 2);

  // The head-height move again, with the level shouting over it.
  b.ceilingSpikes(onBeat(104, 3), 5, 3);
  b.saws(beat(107) + 1, 2.6, 2.5);

  b.pad(beat(109));
  b.spikes(onBeat(109, 3), 3);
  b.beatSpikes(111, 1, { alpha: 0.15 });

  b.block(beat(113), 0, 3, 2);

  // The orb: nothing under it but a pit, and the floor is not enough here.
  b.spikes(onBeat(114, 3), 3);
  b.orb(onBeat(114) + 0.5, 3.2, "yellow");

  b.beatSpikes(117, 2);

  b.dress(beat(98), beat(118), [BAR_SPIRES, BAR_STREET], { maxHeight: 6 });

  // The last two beats are empty and quiet, so you can watch it happen.
  b.dress(beat(118), beat(120), [BAR_SPARSE], { maxHeight: 3 });
}

/* ── the paint ────────────────────────────────────────────────────────────
   Everything above is the level. This is the lie, laid over all of it in one
   continuous pass so there is no stretch of screen that reads as "clean" and
   therefore safe. It starts at beat 21 — the quiet part stays honest, because
   a player who has never seen a real spike has nothing to be fooled about yet.

   Density is deliberately highest in the first six blocks of air, which is
   exactly where a cube spends its life. */
function paint(b: Builder) {
  const beat = (n: number) => b.beat(n);
  const onBeat = (n: number, k = 1) => b.onBeat(n, k);
  const BEAT = b.meta.tuning.blocksPerBeat;
  // Each movement dresses itself now, in `quietPart`, `iSpy`, `mirror`,
  // `strobe` and `everything`. There is nothing left to sprinkle over the top
  // — which is the whole improvement. What used to be here was a pass that
  // scattered another eight hundred objects across the level with a seeded
  // PRNG, and no amount of tuning made a scatter look like a decision.
  void b;
}
