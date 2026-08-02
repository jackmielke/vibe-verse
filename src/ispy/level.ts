/**
 * I SPY — the level.
 *
 * A tribute to the Geometry Dash level of the same name, whose whole idea is
 * that you cannot trust your eyes: the screen is packed with things that look
 * exactly like the things that kill you, and almost none of them do. You are
 * not meant to read this level. You are meant to learn it.
 *
 * Everything runs at 1× (10.4 blocks/second) so the jump arithmetic in
 * `build.ts` holds everywhere, and `level.test.ts` can hold the author to it.
 *
 * Six movements:
 *   THE QUIET PART  cube    0–110   honest. Teaches the language.
 *   I SPY           cube  110–212   the language starts lying.
 *   MIRROR          ship  212–312   gates you have to find inside the noise.
 *   STROBE          ball  312–400   pink and lime, flipping between ceilings.
 *   GREEN           wave  400–492   one long tube through a green blowout.
 *   EVERYTHING      cube  492–604   all of it at once.
 */
import { Builder, rng } from "./build";
import { SPEEDS } from "./physics";
import type { Level } from "./types";

const ONE = SPEEDS.one;

export function buildISpy(): Level {
  const b = new Builder();

  // ── palettes ───────────────────────────────────────────────────────────
  b.section({
    x: 0, name: "The quiet part",
    bg: ["#02060a", "#07161d"], solid: "#e8f7ff", hazard: "#ffffff",
    accent: "#2ee6c8", ground: "#071820", strobe: 0.1,
  });
  b.section({
    x: 110, name: "I spy",
    bg: ["#03040a", "#160726"], solid: "#f4f4ff", hazard: "#ffffff",
    accent: "#ff2fbf", ground: "#12061e", strobe: 0.22,
  });
  b.section({
    x: 212, name: "Mirror",
    bg: ["#01080c", "#0a2028"], solid: "#dffbff", hazard: "#ffffff",
    accent: "#25f2ff", ground: "#03151b", strobe: 0.3,
  });
  b.section({
    x: 312, name: "Strobe",
    bg: ["#ff1e8e", "#e8ff3a"], solid: "#fff7fb", hazard: "#ff1744",
    accent: "#faff00", ground: "#ff2d95", strobe: 0.95,
  });
  b.section({
    x: 400, name: "Green",
    bg: ["#0bff6a", "#003d1a"], solid: "#ffffff", hazard: "#00e05a",
    accent: "#b6ff2f", ground: "#00cc4d", strobe: 0.8,
  });
  b.section({
    x: 492, name: "Everything",
    bg: ["#08010f", "#2b0033"], solid: "#ffffff", hazard: "#ff2fbf",
    accent: "#ff2fbf", ground: "#180322", strobe: 0.45,
  });

  quietPart(b);
  iSpy(b);
  mirror(b);
  strobe(b);
  green(b);
  everything(b);
  paint(b);

  return b.finish(604, { mode: "cube", speed: ONE, grav: 1, y: 0 });
}

/* ── 0–110 ────────────────────────────────────────────────────────────────
   Nothing here lies. Every spike is a spike. That is the point: you spend
   eleven seconds learning what a real hazard looks like, so that the next
   hundred blocks have something to lie about. */
function quietPart(b: Builder) {
  b.spike(16);
  b.spike(23);
  b.spikes(30, 2);
  b.block(39, 0, 4, 1);
  b.spike(49);
  b.spikes(56, 3);
  b.pad(64);
  b.spikes(66, 3);
  b.spike(73);
  b.block(80, 0, 3, 2);
  b.spike(88);
  b.spikes(96, 2);
  b.spike(104);

  // The first decoys in the game float well above your head, where they can
  // be studied safely. Two seconds of "so THAT'S what a lie looks like".
  b.noise(88, 109, 4.5, 11, 16, 1207, { glyphs: 5 });
  b.noise(20, 80, 9, 15, 14, 33, { back: true, big: true });
}

/* ── 110–212 ──────────────────────────────────────────────────────────────
   Now they are on the floor, in your lane, at your height. */
function iSpy(b: Builder) {
  b.fakeSpikes(118, 3); // run straight through them
  b.fakeSpikes(122, 2);
  b.spikes(128, 2); // these do not care what you learned at 118

  b.noise(132, 143, 0, 5, 22, 91, { glyphs: 6 });
  b.spike(137);
  b.fakeSpikes(140, 3);

  b.fakeSlab(146, 153, 3.2); // a floor that is a photograph of a floor
  b.spike(148);
  b.spikes(155, 3);

  b.noise(158, 172, 0, 6, 26, 512, { glyphs: 8 });
  // The signature move: real, lethal, and drawn at 8% opacity. Learn it or
  // spend a pulse — those are the only two ways through, and both are fair.
  b.spike(163, 0, { alpha: 0.08 });
  b.pad(170);
  b.spikes(172, 3);

  b.fakeSpikes(180, 4);
  b.spike(184, 0, { alpha: 0.1 });
  b.noise(176, 196, 0, 7, 24, 77, { glyphs: 7 });

  b.block(191, 0, 3, 1);
  b.fakeSlab(196, 201, 2.4);
  b.spikes(198, 2);
  b.spike(206);
  b.noise(196, 211, 3, 10, 14, 4242, { glyphs: 4 });
}

/* ── 212–312 ──────────────────────────────────────────────────────────────
   Ship. A tunnel eight blocks tall with a gate every ten blocks, and enough
   painted rubbish inside it that finding the gate is the whole job. */
function mirror(b: Builder) {
  const CEIL = 9.5;
  b.portal(210, 0, { to: "ship" });
  b.roof(212, 313, CEIL);

  // Gate openings, bottom edge of a 4.4-block hole. Never moves more than two
  // blocks between gates — a ship covers two blocks vertically in about half
  // a second, and the gates are a second apart.
  const gates = [2, 3, 1, 2, 4, 3, 1, 3, 5, 2];
  gates.forEach((lo, i) => {
    const x = 219 + i * 10;
    if (lo > 0) b.block(x, 0, 1.6, lo);
    b.block(x, lo + 4.4, 1.6, CEIL - (lo + 4.4));
    // Two thirds of what is drawn across the opening is paint.
    b.noise(x - 0.6, x + 2.4, lo + 0.2, lo + 4, 5, 900 + i, {});
  });

  // Real saws, in the gates you have already learned to trust.
  b.saw(249.4, 4.6, 1.6);
  b.saw(289.4, 1.2, 1.6);

  b.noise(214, 312, 0.5, 9, 60, 31337, { glyphs: 14 });
  b.noise(214, 312, 1, 8.5, 30, 999, { back: true, big: true });
}

/* ── 312–400 ──────────────────────────────────────────────────────────────
   Ball, between a floor and a ceiling six blocks apart, in the pink-and-lime
   blowout the level is famous for. Tap to fall the other way. */
function strobe(b: Builder) {
  b.portal(310, 0, { to: "ball" });
  b.roof(312, 401, 6);

  // Alternating floors: a run of spikes on one surface, then the other. Ten
  // blocks apart — a flip crosses the six-block gap in about 3.6. */
  const rows: Array<[number, number, "floor" | "ceil"]> = [
    [320, 2, "floor"],
    [330, 2, "ceil"],
    [340, 3, "floor"],
    [350, 2, "ceil"],
    [360, 2, "floor"],
    [370, 3, "ceil"],
    [380, 2, "floor"],
    [390, 2, "ceil"],
  ];
  for (const [x, n, side] of rows) {
    if (side === "floor") b.spikes(x, n, 0);
    else b.spikes(x, n, 5, { rot: 180 });
    // and the same row again, four blocks earlier, in paint
    b.fakeSpikes(x - 5, n, side === "floor" ? 0 : 5);
  }

  b.noise(314, 400, 0.5, 5.5, 55, 8080, { glyphs: 18 });
  b.noise(314, 400, 0, 6, 26, 606, { back: true, big: true });
}

/* ── 400–492 ──────────────────────────────────────────────────────────────
   Wave. One continuous tube whose centreline wanders. The wave dies on
   contact with anything solid, so the tube is drawn wide — 3.6 blocks — and
   then filled with green paint until you cannot see where it goes. */
function green(b: Builder) {
  b.portal(398, 0, { to: "wave" });

  // Centreline: piecewise linear, never steeper than half of what the wave
  // can climb, so there is always room to correct.
  const nodes: Array<[number, number]> = [
    [398, 2.2], [416, 2.2], [436, 6.4], [452, 6.4],
    [466, 2.6], [478, 5.2], [490, 2.0], [494, 2.0],
  ];
  const centre = (x: number) => {
    for (let i = 0; i < nodes.length - 1; i++) {
      const [x0, y0] = nodes[i];
      const [x1, y1] = nodes[i + 1];
      if (x >= x0 && x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
    return nodes[nodes.length - 1][1];
  };

  const HALF = 1.8;
  for (let x = 398; x < 494; x += 1) {
    const c = centre(x + 0.5);
    b.slab(x, x + 1.01, c - HALF, { plain: true });
    b.roof(x, x + 1.01, c + HALF, { plain: true });
  }

  // Paint the tube shut.
  b.noise(400, 492, 0, 12, 70, 55055, { glyphs: 20 });
  b.noise(400, 492, 0, 14, 34, 66066, { back: true, big: true });

  b.portal(492, 0, { to: "cube" });
}

/* ── 492–604 ──────────────────────────────────────────────────────────────
   Cube again, with everything the level has taught you, and one orb. */
function everything(b: Builder) {
  b.spike(502);
  b.fakeSpikes(506, 3);
  b.spikes(512, 2);
  b.noise(496, 530, 0, 8, 30, 12321, { glyphs: 10 });

  b.pad(520);
  b.spikes(522, 3);
  b.spike(530, 0, { alpha: 0.09 });

  b.block(538, 0, 3, 2);
  b.fakeSlab(543, 549, 2);
  b.spikes(546, 2);

  // The orb: nothing under it but floor, and floor is not enough here.
  b.spikes(556, 3);
  b.orb(556.5, 3.2, "yellow");
  b.spikes(560, 2);

  b.noise(534, 580, 0, 9, 34, 45654, { glyphs: 12 });
  b.fakeSpikes(566, 4);
  b.spike(572);
  b.spikes(579, 2);
  b.spike(587);
  b.spikes(593, 2);

  // The last twenty blocks are empty and quiet, so you can watch it happen.
  b.noise(596, 604, 3, 12, 10, 1, { glyphs: 6 });
}

/* ── the paint ────────────────────────────────────────────────────────────
   Everything above is the level. This is the lie, laid over all of it in one
   continuous pass so there is no stretch of screen that reads as "clean" and
   therefore safe. It starts at 112 — the quiet part stays honest, because a
   player who has never seen a real spike has nothing to be fooled about yet.

   Density is deliberately highest in the first six blocks of air, which is
   exactly where a cube spends its life. */
function paint(b: Builder) {
  const START = 112;
  const END = 604;
  const CHUNK = 8;
  for (let x = START; x < END; x += CHUNK) {
    const seed = 700000 + x * 13;
    b.noise(x, x + CHUNK, -0.2, 6.5, 11, seed, { glyphs: 2 });
    b.noise(x, x + CHUNK, 5, 12, 5, seed + 1, { glyphs: 1 });
    b.noise(x, x + CHUNK, 0, 14, 4, seed + 2, { back: true, big: true });
  }
}

/** Named beats for the progress readout, so a run reads as a place. */
export const CHAPTERS: Array<{ at: number; name: string }> = [
  { at: 0, name: "The quiet part" },
  { at: 110, name: "I spy" },
  { at: 212, name: "Mirror" },
  { at: 312, name: "Strobe" },
  { at: 400, name: "Green" },
  { at: 492, name: "Everything" },
];

/** Only used by the renderer's starfield — kept here so the level file owns
    every deterministic seed in the world. */
export const DECOR_SEED = 4041;
export const decorRng = () => rng(DECOR_SEED);
