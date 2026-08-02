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
 *   I SPY           cube   b21–42   the language starts lying.
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

  // The first decoys sit well above your head, where they can be studied
  // safely. Two seconds of "so THAT'S what a lie looks like" — drawn as real
  // geometry, because that is what they are pretending to be.
  b.ghosts(beat(17), beat(21), 5, 9, 1207, { density: 0.75 });
  b.glyphs(beat(17), beat(21), 5, 11, 5, 1208);
  b.backdrop(6, beat(21), 6, 15, 16, 33);
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

  b.ghosts(beat(29), beat(31), 0, 4, 91, { density: 0.95 });
  b.glyphs(beat(29), beat(31), 1, 7, 6, 92);

  // Beat 31: a floor that is a photograph of a floor, over a real pit.
  b.fakeSlab(beat(31) + 1, beat(32) + 3, 3.2);
  b.beatSpikes(31, 2);

  b.beatSpikes(33, 3);

  b.ghosts(beat(34), beat(37), 0, 5, 512, { density: 0.95 });
  b.glyphs(beat(34), beat(37), 1, 8, 8, 513);
  // Real, lethal, and drawn at 8% opacity. Learn it or spend a pulse — those
  // are the only two ways through, and both are fair.
  b.beatSpikes(35, 1, { alpha: 0.08 });

  // Beat 37: the trap again, now that you have been taught to distrust it.
  b.fakeBeatSpikes(37, 3);
  b.ceilingSpikes(onBeat(37, 3), 4, 3);

  // COIN 1 sits over beat 39, at the exact height of a jump's apex — so the
  // only way to it is to jump a beat you did not have to jump. Two beats
  // after being taught that jumping is what kills you.
  b.coin(beat(39) + 2.5, 2.6);
  b.beatSpikes(40, 2);

  b.ghosts(beat(38), beat(42), 0, 5, 77, { density: 0.9 });
  b.glyphs(beat(38), beat(42), 1, 8, 7, 78);
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
    b.ghosts(x - 1, x + 3, lo + 1, lo + 3, 900 + i, { density: 0.85, ceiling: lo + 4.4 });
  });

  // Real saws, in gates you have already learned to trust.
  b.saw(beat(49) + 0.4, 4.6, 1.6);
  b.saw(beat(57) + 0.4, 1.2, 1.6);

  // COIN 2 rides the ceiling between the two highest gates — the one stretch
  // of tunnel where there is room above the line, and you still have to give
  // up the middle of the corridor for four beats to take it.
  b.coin(beat(52), 7.8);

  b.ghosts(beat(42), beat(62), 1, 7, 31337, { density: 0.85, ceiling: CEIL });
  b.glyphs(beat(42), beat(62), 1, 8, 14, 31338);
  b.backdrop(beat(42), beat(62), 0, 10, 26, 999);
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
    // …and the same row again, one beat earlier, in paint.
    b.fakeSpikes(x - BEAT, count, side === "floor" ? 0 : 5);
  }

  b.ghosts(beat(62), beat(80), 0, 4, 8080, { density: 0.95, ceiling: 6 });
  b.glyphs(beat(62), beat(80), 1, 5, 18, 8081);
  b.backdrop(beat(62), beat(80), 0, 7, 24, 606);
}

/* ── beats 80–98 ──────────────────────────────────────────────────────────
   Wave. One continuous tube whose centreline wanders, its corners on beats.
   The wave dies on contact with anything solid, so the tube is drawn wide —
   3.6 blocks — and then filled with green paint until you cannot see where it
   goes. */
function green(b: Builder) {
  b.portal(beat(80) - 2, 0, { to: "wave" });

  const nodes: Array<[number, number]> = [
    [79, 2.2], [83, 2.2], [87, 6.4], [90, 6.4],
    [93, 2.6], [95, 5.2], [98, 2.0], [99, 2.0],
  ];
  const centre = (x: number) => {
    for (let i = 0; i < nodes.length - 1; i++) {
      const [n0, y0] = nodes[i];
      const [n1, y1] = nodes[i + 1];
      const x0 = beat(n0);
      const x1 = beat(n1);
      if (x >= x0 && x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
    return nodes[nodes.length - 1][1];
  };

  const HALF = 1.8;
  for (let x = beat(79); x < beat(99); x += 1) {
    const c = centre(x + 0.5);
    b.slab(x, x + 1.01, c - HALF, { plain: true });
    b.roof(x, x + 1.01, c + HALF, { plain: true });
  }

  b.ghosts(beat(80), beat(98), 0, 10, 55055, { density: 0.9 });
  b.glyphs(beat(80), beat(98), 1, 11, 20, 55056);
  b.backdrop(beat(80), beat(98), 0, 13, 30, 66066);

  b.portal(beat(98) + 1, 0, { to: "cube" });
}

/* ── beats 98–120 ─────────────────────────────────────────────────────────
   Cube again, with everything the level has taught you, at a beat a jump. */
function everything(b: Builder) {
  b.beatSpikes(100);
  b.fakeBeatSpikes(101, 3);
  b.beatSpikes(102, 2);

  b.ghosts(beat(99), beat(104), 0, 6, 12321, { density: 0.95 });
  b.glyphs(beat(99), beat(106), 1, 9, 10, 12322);

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

  b.ghosts(beat(107), beat(118), 0, 6, 45654, { density: 0.9 });
  b.glyphs(beat(107), beat(118), 1, 9, 12, 45655);

  // The last two beats are empty and quiet, so you can watch it happen.
  b.glyphs(beat(118), beat(120), 3, 11, 6, 1);
  b.backdrop(beat(98), beat(120), 4, 13, 22, 2);
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
    const seed = 700000 + n * 13;
    b.ghosts(beat(n), beat(n + 2), 0, 5, seed, { density: 0.85 });
    b.ghosts(beat(n), beat(n + 2), 6, 10, seed + 1, { density: 0.45 });
    b.glyphs(beat(n), beat(n + 2), 1, 10, 2, seed + 2);
    b.backdrop(beat(n), beat(n + 2), 2, 14, 3, seed + 3);
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
