/**
 * I SPY — the level.
 *
 * A tribute to the Geometry Dash level of the same name, whose whole idea is
 * that you cannot trust your eyes: the screen is packed with things that look
 * exactly like the things that kill you, and almost none of them do. You are
 * not meant to read this level. You are meant to learn it.
 *
 * It is written on beats, not on blocks. One jump is one beat is five blocks
 * (see `BEAT` in build.ts), so `b.beatSpikes(23, 2)` means "on beat 23 the
 * player jumps, and this is what they jump over". Read the beat numbers down
 * the page and you are reading the rhythm the level is played to.
 *
 * The decoys are on the beat as well. They have to be: put them off it and the
 * music tells you which spikes are real, and the level solves itself.
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
import { BEAT, Builder, onBeat, rng } from "./build";
import { SPEEDS } from "./physics";
import type { Level } from "./types";

const ONE = SPEEDS.one;
/** Blocks per beat — 5. Written as `beat(n)` where an x is wanted. */
const beat = (n: number) => n * BEAT;
const END = beat(120);

export function buildISpy(): Level {
  const b = new Builder();

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

  return b.finish(END, { mode: "cube", speed: ONE, grav: 1, y: 0 });
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
  for (const n of [21, 31, 42, 52, 62, 71, 80, 89, 98, 106, 113]) b.checkpoint(beat(n));
}

/* ── beats 0–21 ───────────────────────────────────────────────────────────
   Nothing here lies. Every spike is a spike, every jump is on the downbeat,
   and the rhythm is deliberately slow — a jump every two or three beats — so
   that by beat 21 the player is counting without having been told to. */
function quietPart(b: Builder) {
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
  b.ghosts(beat(17), beat(21), 0, 1207, { density: 0.6, maxHeight: 3 });
  b.gears(beat(6), beat(21), 5, 11, 5, 1207);
  b.glyphs(beat(17), beat(21), 4, 9, 4, 1208);
}

/* ── beats 21–42 ──────────────────────────────────────────────────────────
   The lying starts, and it is not "spikes you can ignore" — an unnecessary
   jump lands on the next beat and costs nothing, so a harmless decoy is
   genuinely harmless. What makes a decoy lethal is what is over it. */
function iSpy(b: Builder) {
  // Beat 22: pure paint, and nothing above it. A free lesson.
  b.fakeBeatSpikes(22, 3);

  // Beat 24: real. Same picture as beat 22.
  b.beatSpikes(24, 2);

  // ── The trap the level is built on ─────────────────────────────────────
  // Beat 26: painted spikes on the floor, real teeth at head height. Walk
  // through the fake and live; jump the fake and die on the ceiling. It is
  // the first time in the level that the honest move is to do nothing.
  b.fakeBeatSpikes(26, 3);
  b.ceilingSpikes(onBeat(26, 3), 4, 3);

  // Beat 28: the mirror image — real floor, painted ceiling. Jump.
  b.beatSpikes(28, 2);
  b.fakeCeilingSpikes(onBeat(28, 2), 3, 3);

  b.beatSpikes(30, 3);

  // Beat 31: a floor that is a photograph of a floor, standing on painted
  // columns, over a real pit.
  b.fakeSlab(beat(31) + 1, beat(32) + 3, 3.2);

  // Real, lethal, and drawn at 8% opacity. Learn it or spend a ping — those
  // are the only two ways through, and both are fair.
  b.beatSpikes(32, 1, { alpha: 0.08 });

  // COIN 1 sits over beat 33, at the exact height of a jump's apex, on a beat
  // with nothing to jump. The only way to it is a jump you did not have to
  // make — seven beats after being taught that jumping is what kills you.
  b.coin(beat(33) + 2.5, 2.6);

  // Beat 34: the trap again, now that you have been taught to distrust it.
  b.fakeBeatSpikes(34, 3);
  b.ceilingSpikes(onBeat(34, 3), 4, 3);

  b.beatSpikes(36, 2);

  b.ghosts(beat(22), beat(37), 0, 91, { density: 0.85, maxHeight: 4 });
  b.gears(beat(22), beat(37), 4, 11, 9, 512);
  b.glyphs(beat(22), beat(37), 3, 10, 9, 92);
}

/* ── beats 38–42 ──────────────────────────────────────────────────────────
   The wave, early.

   The full wave section is at beat 80, forty seconds in, which most people
   were never going to reach — the best-looking mode in the game was hidden
   behind the hardest half of the level. So here is five beats of it at the
   eighteen-second mark, as a taster and as a transition into the ship: a
   clean tube, no paint inside it, nothing to learn except what a wave is. */
function waveTaster(b: Builder) {
  b.portal(beat(38) - 2, 0, { to: "wave" });
  b.tube([
    [beat(38) - 1, 2.4],
    [beat(39), 2.4],
    [beat(40), 5.2],
    [beat(41), 2.6],
    [beat(42) - 1.5, 3.2],
  ], 1.9);
  b.gears(beat(38), beat(42), 7, 12, 4, 7788);
  b.glyphs(beat(38), beat(42), 7, 12, 3, 7789);
}

/* ── beats 42–62 ──────────────────────────────────────────────────────────
   Ship. A tunnel with a gate every two beats, and enough painted rubbish
   inside it that finding the gate is the whole job. */
function mirror(b: Builder) {
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
    // From the tunnel floor, not from the gate's lip — the ghost band is
    // wider than the gate block, so anything rooted at the lip would be
    // standing on nothing for most of its width.
    b.ghosts(x - 1, x + 3, 0, 900 + i, { density: 0.9, maxHeight: lo + 3 });
  });

  // Real saws, in gates you have already learned to trust.
  b.saw(beat(49) + 0.4, 4.6, 1.6);
  b.saw(beat(57) + 0.4, 1.2, 1.6);

  // COIN 2 rides the ceiling between the two highest gates — the one stretch
  // of tunnel where there is room above the line, and you still have to give
  // up the middle of the corridor for four beats to take it.
  b.coin(beat(52), 7.8);

  b.ghosts(beat(42), beat(62), 0, 31337, { density: 0.8, ceiling: CEIL, maxHeight: 5 });
  b.gears(beat(42), beat(62), 1, 8, 14, 999);
  b.glyphs(beat(42), beat(62), 1, 8, 12, 31338);
}

/* ── beats 62–80 ──────────────────────────────────────────────────────────
   Ball, between a floor and a ceiling six blocks apart, in the pink-and-lime
   blowout the level is famous for. Tap to fall the other way. */
function strobe(b: Builder) {
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
    // …and the same row again, one beat earlier, in paint. A painted ceiling
    // row has to hang like a real one — an upright spike at y = 5 with six
    // blocks of air under it is not a decoy, it is a mistake.
    if (side === "floor") b.fakeSpikes(x - BEAT, count, 0);
    else b.fakeCeilingSpikes(x - BEAT, count, 5, false);
  }

  b.ghosts(beat(62), beat(80), 0, 8080, { density: 0.9, ceiling: 6, maxHeight: 3 });
  b.gears(beat(62), beat(80), 1, 5, 12, 606);
  b.glyphs(beat(62), beat(80), 1, 5, 14, 8081);
}

/* ── beats 80–98 ──────────────────────────────────────────────────────────
   Wave. One continuous tube whose centreline wanders, its corners on beats.
   The wave dies on contact with anything solid, so the tube is drawn wide —
   3.6 blocks — and then filled with green paint until you cannot see where it
   goes. */
function green(b: Builder) {
  b.portal(beat(80) - 2, 0, { to: "wave" });

  b.tube([
    [beat(79), 2.2], [beat(83), 2.2], [beat(87), 6.4], [beat(90), 6.4],
    [beat(93), 2.6], [beat(95), 5.2], [beat(98), 2.0], [beat(99), 2.0],
  ]);

  // No ghosts inside a wave tube: the wave dies on contact with anything, so
  // a corridor you cannot read is not a hard section, it is a coin flip. The
  // green does the lying here, and the gears do the decorating.
  b.gears(beat(80), beat(98), 8, 13, 16, 66066);
  b.glyphs(beat(80), beat(98), 8, 13, 12, 55056);

  b.portal(beat(98) + 1, 0, { to: "cube" });
}

/* ── beats 98–120 ─────────────────────────────────────────────────────────
   Cube again, with everything the level has taught you, at a beat a jump. */
function everything(b: Builder) {
  b.beatSpikes(100);
  b.fakeBeatSpikes(101, 3);
  b.beatSpikes(102, 2);

  b.ghosts(beat(99), beat(104), 0, 12321, { density: 0.9, maxHeight: 4 });
  b.glyphs(beat(99), beat(106), 3, 10, 8, 12322);

  // The trap, a third time, with the rest of the level shouting over it.
  b.fakeBeatSpikes(104, 3);
  b.ceilingSpikes(onBeat(104, 3), 4, 3);

  b.pad(beat(106));
  b.spikes(onBeat(106, 3), 3);
  b.beatSpikes(108, 1, { alpha: 0.09 });

  b.block(beat(110), 0, 3, 2);
  b.fakeSlab(beat(111) + 1, beat(112) + 2, 2);
  b.beatSpikes(111, 2);

  // The orb: nothing under it but a pit, and the floor is not enough here.
  b.spikes(onBeat(113, 3), 3);
  b.orb(onBeat(113) + 0.5, 3.2, "yellow");
  b.beatSpikes(115, 2);

  // COIN 3 hangs over the decoy row at beat 116 — so the jump that takes it
  // is precisely the jump the level has spent a minute teaching you not to
  // make. Land on beat 117 and the real row is already there: the coin costs
  // you a jump you did not need and a chain jump you now cannot miss.
  b.fakeBeatSpikes(116, 2);
  b.coin(beat(116) + 2.5, 2.6);
  b.beatSpikes(117, 2);

  b.ghosts(beat(107), beat(118), 0, 45654, { density: 0.9, maxHeight: 5 });
  b.gears(beat(99), beat(118), 5, 12, 14, 2);
  b.glyphs(beat(107), beat(118), 4, 11, 10, 45655);

  // The last two beats are empty and quiet, so you can watch it happen.
  b.glyphs(beat(118), beat(120), 4, 11, 5, 1);
}

/* ── the paint ────────────────────────────────────────────────────────────
   Everything above is the level. This is the lie, laid over all of it in one
   continuous pass so there is no stretch of screen that reads as "clean" and
   therefore safe. It starts at beat 21 — the quiet part stays honest, because
   a player who has never seen a real spike has nothing to be fooled about yet.

   Density is deliberately highest in the first six blocks of air, which is
   exactly where a cube spends its life. */
function paint(b: Builder) {
  for (let n = 21; n < 120; n += 2) {
    // The two wave stretches are left alone. A wave dies on contact with
    // anything, so paint inside its tube would be indistinguishable from a
    // wall and the section would stop being a test of nerve.
    if ((n >= 37 && n < 42) || (n >= 79 && n < 99)) continue;
    const seed = 700000 + n * 13;
    b.ghosts(beat(n), beat(n + 2), 0, seed, { density: 0.75, maxHeight: 5 });
    b.gears(beat(n), beat(n + 2), 5, 12, 1, seed + 1);
    b.glyphs(beat(n), beat(n + 2), 3, 11, 2, seed + 2);
  }
}

/** Named beats for the progress readout, so a run reads as a place. */
export const CHAPTERS: Array<{ at: number; name: string }> = [
  { at: 0, name: "The quiet part" },
  { at: beat(21), name: "I spy" },
  { at: beat(42), name: "Mirror" },
  { at: beat(62), name: "Strobe" },
  { at: beat(80), name: "Green" },
  { at: beat(98), name: "Everything" },
];

/** Only used by the renderer's starfield — kept here so the level file owns
    every deterministic seed in the world. */
export const DECOR_SEED = 4041;
export const decorRng = () => rng(DECOR_SEED);
