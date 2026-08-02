/**
 * I SPY — the authoring kit.
 *
 * The level is written as patterns dropped at x positions rather than as a
 * list of 1,400 rectangles, because a list of 1,400 rectangles is unreadable
 * and unfixable. Every pattern here is *known clearable from flat ground*:
 * see the arithmetic in `JUMP_WINDOW` below, and `level.test.ts`, which flies
 * a bot through the finished level and fails the build if it cannot reach the
 * end.
 */
import type { Grav, Level, Mode, Obj, Section } from "./types";

/**
 * A 1× cube jump traces y(d) = 2.08d − 0.415d², where d is blocks travelled
 * since takeoff (v0 = 20.8, g = 83, speed = 10). It peaks 2.6 blocks high
 * after 2.5 blocks and lands after 5.01.
 *
 * Consequences worth keeping in your head while authoring:
 *   • a ground spike (needs y > 1) is cleared from 0.54 to 4.47 blocks out,
 *   • a spike on a 1-block plinth (y > 2) from 1.25 to 3.76,
 *   • so a run of three ground spikes is comfortable and five is impossible.
 */
export const JUMP_WINDOW = { clearsSpikeFrom: 0.54, to: 4.47, apex: 2.5 };

export function arcHeight(d: number): number {
  return 2.08 * d - 0.415 * d * d;
}

/**
 * ONE JUMP IS ONE BEAT IS FIVE BLOCKS.
 *
 * This is the spine of the whole level and it is why the speed never changes.
 * The soundtrack runs at 120 BPM, so a beat is half a second. A 1× cube jump
 * hangs for 0.501 s and covers 5.01 blocks. Round that to five and three
 * separate grids collapse into one:
 *
 *   • the music's beat grid,
 *   • the level's block grid,
 *   • and the player's jump rhythm.
 *
 * Jump on a beat and you land on the next one, ready to jump again. A run of
 * hazards one beat apart is a run of jumps on the downbeat. That is what makes
 * a Geometry Dash level feel like it was cut to its music instead of merely
 * played over it, and it is the difference between this level and the one that
 * used to be here, whose hazards sat wherever the arithmetic left them.
 *
 * A speed portal would break all three alignments at once, so there are none.
 */
export const BPM = 120;
export const BEAT = 5;

/**
 * Left edge of a run of `n` tiles placed under the apex of a jump taken on
 * beat `b`.
 *
 * The offset shifts left as the run grows so that the whole run stays inside
 * the *conservative* window — the one that asks for a full block of clearance
 * over every spike, rather than the one that merely avoids the hitboxes. A
 * three-run at offset 2 puts its last spike 4.5 blocks out, where the arc has
 * dropped to 0.96 blocks: survivable only because a spike's kill box stops at
 * 0.7, which is not a margin worth building a level on. At offset 1 the same
 * run sits at 1.5 / 2.5 / 3.5 blocks out, under 2.19 / 2.61 / 2.19 of cube.
 */
export function onBeat(b: number, n = 1): number {
  return b * BEAT + (n >= 3 ? 1 : 2);
}

/** Where a jump taken on beat `b` puts you down: the top of beat b + 1. */
export function landing(b: number): number {
  return (b + 1) * BEAT;
}

/**
 * A piece of hand-drawn dressing, at an x offset inside its bar.
 *
 * There is deliberately no random number generator in this file. Everything in
 * the level, foreground and background, is placed by hand.
 */
export type Motif =
  | ["ridge", number, number]
  | ["tower", number, number]
  | ["plinth", number, number, number, boolean?]
  | ["gears", number, number]
  | ["mark", number, number]
  | ["hang", number, number]
  /** A dim tower on the course behind the play lane. Depth, not obstacle. */
  | ["far", number, number];

export interface DressOpts {
  /** Length of one bar of dressing, in blocks. Eight beats by default. */
  barBlocks?: number;
  /** Clamp for tower and plinth heights, for use inside a corridor. */
  maxHeight?: number;
  /** Surface the dressing stands on. */
  floor?: number;
  /** Surface a "hang" motif hangs from. Omit and hangs are skipped. */
  ceiling?: number;
}

export class Builder {
  readonly objects: Obj[] = [];
  readonly sections: Section[] = [];

  push(o: Obj): Obj {
    this.objects.push(o);
    return o;
  }

  section(s: Section) {
    this.sections.push(s);
  }

  // ── primitives ─────────────────────────────────────────────────────────

  block(x: number, y: number, w = 1, h = 1, o: Partial<Obj> = {}) {
    return this.push({ kind: "block", x, y, w, h, ...o });
  }

  spike(x: number, y = 0, o: Partial<Obj> = {}) {
    return this.push({ kind: "spike", x, y, w: 1, h: 1, ...o });
  }

  /** `n` spikes in a row starting at x. Three is the honest maximum. */
  spikes(x: number, n: number, y = 0, o: Partial<Obj> = {}) {
    for (let i = 0; i < n; i++) this.spike(x + i, y, o);
  }

  /** A run of `n` real spikes cleared by jumping on beat `b`. */
  beatSpikes(b: number, n = 1, o: Partial<Obj> = {}) {
    this.spikes(onBeat(b, n), n, 0, o);
  }

  /** The same run, in paint. Decoys sit on the beat too — otherwise the music
      would tell you which ones were real and the level would solve itself. */
  fakeBeatSpikes(b: number, n = 1) {
    this.fakeSpikes(onBeat(b, n), n);
  }

  /**
   * Spikes hanging point-down at `y`, which kill you *for jumping*.
   *
   * This is the trap the level is built on. Over-jumping is otherwise free —
   * a jump lands exactly one beat later, so an unnecessary one costs nothing —
   * which would make every decoy harmless. Put real teeth at head height over
   * a row of painted floor spikes and the decoy becomes lethal: the honest
   * move is to walk straight through it, and the instinct is to jump.
   */
  ceilingSpikes(x: number, n: number, y = 3, mount = true) {
    for (let i = 0; i < n; i++) this.spike(x + i, y, { rot: 180 });
    if (mount) this.beam(x, n, y);
  }

  fakeCeilingSpikes(x: number, n: number, y = 3, mount = true) {
    for (let i = 0; i < n; i++)
      this.push({ kind: "spike", x: x + i, y, w: 1, h: 1, rot: 180, decoy: true });
    if (mount) this.beam(x, n, y);
  }

  /**
   * The girder a row of hanging teeth is bolted to.
   *
   * Decoy, always — a solid block at head height would either be landed on or
   * killed against, and the trap needs the air above the spikes to stay air.
   * It is here purely so the teeth are attached to something: a row of spikes
   * hanging in empty sky reads as a rendering bug, not as a level.
   *
   * Pass `mount = false` wherever a real ceiling already exists (the ship
   * tunnel, the ball corridor) — the teeth are hanging off that, and a second
   * bar inside it is just an object nobody can see.
   */
  private beam(x: number, n: number, y: number) {
    this.push({
      kind: "block", x: x - 0.5, y: y + 1, w: n + 1, h: 0.5,
      decoy: true, mount: true,
    });
  }

  /** A secret coin. Never on the safe line — that is the entire point. */
  coin(x: number, y: number) {
    return this.push({ kind: "coin", x: x - 0.6, y: y - 0.6, w: 1.2, h: 1.2 });
  }

  saw(x: number, y: number, size = 2, o: Partial<Obj> = {}) {
    return this.push({ kind: "saw", x, y, w: size, h: size, ...o });
  }

  pad(x: number, y = 0, boost: Obj["boost"] = "yellow") {
    return this.push({ kind: "pad", x, y, w: 1, h: 0.3, boost });
  }

  orb(x: number, y: number, boost: Obj["boost"] = "yellow") {
    // Orbs are generous: you get a whole block and a bit of slack around one.
    return this.push({ kind: "orb", x: x - 0.3, y: y - 0.3, w: 1.6, h: 1.6, boost });
  }

  portal(x: number, y: number, p: { to?: Mode; grav?: Grav; speed?: number }) {
    return this.push({ kind: "portal", x, y, w: 1, h: 3, ...p });
  }

  /** A solid ceiling from x0 to x1, one block thick, its underside at y. */
  roof(x0: number, x1: number, y: number, o: Partial<Obj> = {}) {
    return this.block(x0, y, x1 - x0, 1.2, o);
  }

  /** A solid floor slab from x0 to x1 whose top face is at y. */
  slab(x0: number, x1: number, y: number, o: Partial<Obj> = {}) {
    return this.block(x0, y - 1.2, x1 - x0, 1.2, o);
  }

  // ── the lie ────────────────────────────────────────────────────────────

  /**
   * A row of decoy spikes on a surface. The commonest lie in the level.
   */
  ridge(x: number, n: number, y = 0) {
    for (let i = 0; i < n; i++) this.fakeSpike(x + i, y);
  }

  /** A one-block column with a wider cap — a pillar, not a stray rectangle. */
  tower(x: number, h: number, floor = 0) {
    this.push({ kind: "block", x, y: floor, w: 1, h, decoy: true });
    this.push({ kind: "block", x: x - 0.5, y: floor + h, w: 2, h: 0.5, decoy: true });
  }

  /** A block standing on the floor, optionally with spikes along its top. */
  plinth(x: number, w: number, h: number, spiked = false, floor = 0) {
    this.push({ kind: "block", x, y: floor, w, h, decoy: true });
    if (spiked) this.ridge(x, w, floor + h);
  }

  /** Two gears on a bracket. The only thing in the level allowed to float. */
  gearPair(x: number, y: number) {
    this.push({ kind: "saw", x, y, w: 2, h: 2, decoy: true, alpha: 0.9 });
    this.push({ kind: "saw", x: x + 2.5, y: y + 1.5, w: 1.5, h: 1.5, decoy: true, alpha: 0.7 });
  }

  /** One question mark. The level is named after these. */
  mark(x: number, y: number, size = 1.5) {
    this.push({ kind: "glyph", x, y, w: size, h: size, decoy: true, alpha: 0.7 });
  }

  /** A row of painted teeth hanging off a ceiling that exists. */
  hang(x: number, n: number, ceiling: number) {
    for (let i = 0; i < n; i++)
      this.push({
        kind: "spike", x: x + i, y: ceiling - 1, w: 1, h: 1, rot: 180, decoy: true,
      });
  }

  /**
   * Lay a bar of hand-drawn dressing along a stretch of level.
   *
   * There is no randomness anywhere in this file any more, and that is the
   * point. Scattering decoration with a seeded PRNG produces something that is
   * *technically* deterministic and still looks like debris — clumps, gaps,
   * three towers in a row and then forty empty blocks, none of it saying
   * anything. It reads as spawned, because it was.
   *
   * So the dressing is drawn by hand, one bar at a time, and tiled. That is
   * how real levels in this genre are built: a designer draws eight beats of
   * background they like and reuses it down the length of the level, varying
   * which bar goes where. `BARS` in level.ts is that drawing, and you can read
   * the shape of it straight off the page.
   */
  dress(x0: number, x1: number, bars: Motif[][], opts: DressOpts = {}) {
    const span = opts.barBlocks ?? 40;
    const cap = opts.maxHeight ?? 99;
    const floor = opts.floor ?? 0;
    let bar = 0;
    for (let base = x0; base < x1; base += span, bar++) {
      for (const m of bars[bar % bars.length]) {
        const x = base + m[1];
        if (x < x0 || x >= x1 - 0.5) continue;
        switch (m[0]) {
          case "ridge":
            this.ridge(x, m[2], floor);
            break;
          case "tower":
            this.tower(x, Math.min(m[2], cap), floor);
            break;
          case "plinth":
            this.plinth(x, m[2], Math.min(m[3], cap), m[4] ?? false, floor);
            break;
          case "gears":
            this.gearPair(x, m[2]);
            break;
          case "mark":
            this.mark(x, m[2]);
            break;
          case "hang":
            if (opts.ceiling !== undefined) this.hang(x, m[2], opts.ceiling);
            break;
          case "far":
            this.push({
              kind: "block", x, y: floor, w: 2, h: Math.min(m[2], cap + 3),
              decoy: true, back: true, alpha: 0.5,
            });
            break;
        }
      }
    }
  }

  /** One decoy spike, on the grid, identical to a real one. */
  fakeSpike(x: number, y = 0) {
    return this.push({ kind: "spike", x, y, w: 1, h: 1, decoy: true });
  }

  /** A row of decoy spikes standing on the floor, indistinguishable from
      the row of real ones you will meet four blocks later. */
  fakeSpikes(x: number, n: number, y = 0) {
    for (let i = 0; i < n; i++) this.fakeSpike(x + i, y);
  }

  /** Ground you cannot stand on. Rests on decoy columns, so even the lie
      obeys gravity. */
  fakeSlab(x0: number, x1: number, y: number) {
    this.push({ kind: "block", x: x0, y: y - 1, w: x1 - x0, h: 1, decoy: true });
    for (const x of [x0, x1 - 1]) {
      this.push({ kind: "block", x, y: 0, w: 1, h: y - 1, decoy: true });
    }
  }

  /**
   * A checkpoint. Crossing one banks the run; dying after it puts you back
   * here rather than at the start. Not a collider — `World` skips them and
   * the engine watches the player's x instead.
   */
  checkpoint(x: number) {
    return this.push({ kind: "checkpoint", x, y: 0, w: 0.5, h: 7 });
  }

  /**
   * A wave tube: a corridor of a given half-height whose centreline is a
   * piecewise-linear path through `nodes` ([x, y] pairs). The wave dies on
   * contact with anything, so the tube is the level here — there is nothing
   * else in it.
   */
  tube(nodes: Array<[number, number]>, half = 1.8) {
    const centre = (x: number) => {
      for (let i = 0; i < nodes.length - 1; i++) {
        const [x0, y0] = nodes[i];
        const [x1, y1] = nodes[i + 1];
        if (x >= x0 && x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
      return nodes[nodes.length - 1][1];
    };
    const from = nodes[0][0];
    const to = nodes[nodes.length - 1][0];
    for (let x = from; x < to; x += 1) {
      const c = centre(x + 0.5);
      this.slab(x, x + 1.01, c - half, { plain: true });
      this.roof(x, x + 1.01, c + half, { plain: true });
    }
  }

  finish(length: number, start: Level["start"]): Level {
    this.sections.sort((a, b) => a.x - b.x);
    return { objects: this.objects, sections: this.sections, length, start };
  }
}
