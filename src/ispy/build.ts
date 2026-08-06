/**
 * I SPY — the authoring kit.
 *
 * A level is written as patterns dropped on beats rather than as a list of
 * rectangles at x coordinates, because a list of rectangles is unreadable and
 * unfixable. `b.beatSpikes(23, 2)` means "on beat 23 the player jumps, and
 * this is what they jump over"; read the beat numbers down a level file and
 * you are reading its rhythm.
 *
 * Every pattern here is *known clearable from flat ground* at whatever tuning
 * the level chose — the arithmetic is solved per level in `derive`, and
 * `ispy.test.ts` flies a solver through every level in the registry and fails
 * the build if any one of them cannot be finished.
 */
import { derive } from "./physics";
import type { Derived } from "./physics";
import type { Grav, Level, Mode, Obj, Section, Tuning } from "./types";

/**
 * A piece of hand-drawn background, at an x offset inside its bar.
 *
 * Architecture only. There are no spike motifs here and there never will be
 * again: every spike in this game is a real one that kills you, so a painted
 * spike is not a thing a level is allowed to contain. Buildings can be scenery
 * because nobody has ever mistaken a building for a spike.
 */
export type Motif =
  | ["tower", number, number]
  | ["plinth", number, number, number]
  | ["mark", number, number]
  /** A dimmer, taller course further back. Depth, not obstacle. */
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

/** One beat of a cube score. See `Builder.cube`. */
export type CubeBeat =
  | ["spikes", number, number, Partial<Obj>?]
  | ["teeth", number, number]
  | ["saw", number, number?]
  | ["pad", number]
  | ["step", number, number, number]
  | ["orb", number, number];

export interface LevelMeta {
  id: string;
  name: string;
  world: string;
  tagline: string;
  tuning: Tuning;
}

/**
 * The height of a cube's jump arc `d` blocks after takeoff, at a given tuning.
 *
 * y(d) = v0·(d/s) − ½g·(d/s)². At the classic tuning that is
 * 2.08d − 0.415d²: a peak of 2.6 blocks at 2.5 blocks out, landing at 5.01.
 * A ground spike needs a block of clearance, which holds from 0.54 to 4.47
 * blocks out — so a run of three is comfortable and a run of five is not.
 */
export function arcHeightAt(t: Derived, d: number): number {
  const time = d / t.speed;
  return t.jump * time - 0.5 * t.gravity * time * time;
}

export class Builder {
  readonly objects: Obj[] = [];
  readonly sections: Section[] = [];
  /** Every physics constant this level runs on, solved from its tuning. */
  readonly t: Derived;

  constructor(readonly meta: LevelMeta) {
    this.t = derive(meta.tuning);
  }

  /** x of the start of beat `n`. */
  beat(n: number): number {
    return n * this.meta.tuning.blocksPerBeat;
  }

  /**
   * Left edge of a run of `n` tiles placed under the apex of a jump taken on
   * beat `b`.
   *
   * The offset shifts left as the run grows so the whole run stays inside the
   * conservative window — the one that asks for a full block of clearance over
   * every spike, rather than the one that merely avoids the hitboxes.
   */
  onBeat(b: number, n = 1): number {
    const apexDist = this.meta.tuning.blocksPerBeat / 2;
    return this.beat(b) + Math.round(apexDist - (n >= 3 ? 1.5 : 0.5));
  }

  /** Height of the jump arc `d` blocks after takeoff, at this level's tuning. */
  arc(d: number): number {
    return arcHeightAt(this.t, d);
  }

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
    this.spikes(this.onBeat(b, n), n, 0, o);
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

  /**
   * The girder a row of hanging teeth is bolted to.
   *
   * Real solid geometry, and safely so: the top of a cube at the apex of a
   * jump is 3.6 blocks up, and the girder's underside is at 4. Nothing can
   * ever touch it, so it can be honest without being in the way.
   *
   * It is here so the teeth are attached to something — a row of spikes
   * hanging in empty sky reads as a rendering bug, not as a level.
   *
   * Pass `mount = false` wherever a real ceiling already exists (the ship
   * tunnel, the ball corridor) — the teeth are hanging off that, and a second
   * bar inside it is just an object nobody can see.
   */
  private beam(x: number, n: number, y: number) {
    this.push({ kind: "block", x: x - 0.5, y: y + 1, w: n + 1, h: 0.5, mount: true });
  }

  /**
   * A secret coin at the apex of a jump taken on beat `n` — from flat ground,
   * on a beat with nothing to jump.
   *
   * This is the only placement worth having and it took a while to see why.
   * A coin has to be *off* the line a player already flies, or it collects
   * itself, and *reachable*, or it is decoration. The apex of an unnecessary
   * jump is exactly both: the safe line runs along the floor two blocks below
   * it, and getting it costs one deliberate press on a beat that did not ask
   * for one. Every other placement I tried — pinned to a tunnel roof, sitting
   * on the apex of a jump you had to make anyway — failed one half or the
   * other, and `canCollect` in the tests caught all of them.
   */
  coinOnBeat(n: number) {
    return this.coin(this.beat(n) + this.meta.tuning.blocksPerBeat / 2, this.meta.tuning.apex);
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

  /**
   * A portal, and it is twelve blocks tall on purpose.
   *
   * It used to be three, which is fine in a level whose jump peaks at 2.6 —
   * and silently broken in one whose jump peaks at 3.6, where a cube arriving
   * mid-jump sails clean over the trigger and carries on into the next section
   * still being a cube. That is exactly what happened to Unit 7: it flew the
   * ship tunnel on foot and hit the first gate at 26%.
   *
   * A portal is a trigger, not an obstacle, so a generous box is the correct
   * box. The renderer caps what it *draws* to a doorway near the floor.
   */
  portal(x: number, y: number, p: { to?: Mode; grav?: Grav; speed?: number }) {
    return this.push({ kind: "portal", x, y, w: 1, h: 12, ...p });
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

  /** A pillar with a cap, on the background course. */
  tower(x: number, h: number, floor = 0) {
    this.push({ kind: "block", x, y: floor, w: 1, h, decoy: true, back: true, alpha: 0.8 });
    this.push({
      kind: "block", x: x - 0.5, y: floor + h, w: 2, h: 0.5,
      decoy: true, back: true, alpha: 0.8,
    });
  }

  /** A block of building on the background course. */
  plinth(x: number, w: number, h: number, floor = 0) {
    this.push({ kind: "block", x, y: floor, w, h, decoy: true, back: true, alpha: 0.8 });
  }

  /**
   * A real sawblade. Spins, floats, and kills — which is what a sawblade is
   * for and what it had never been allowed to do here until now.
   *
   * Every one is placed by hand at a height chosen against the jump arc, and
   * `ispy.test.ts` flies the level to prove the placements are survivable.
   * Nothing about a lethal object may be left to chance.
   */
  saws(x: number, y: number, size = 2) {
    return this.push({ kind: "saw", x, y, w: size, h: size });
  }

  /** One question mark. The level is named after these. */
  mark(x: number, y: number, size = 1.5) {
    this.push({ kind: "glyph", x, y, w: size, h: size, decoy: true, back: true, alpha: 0.6 });
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
    const span = opts.barBlocks ?? this.meta.tuning.blocksPerBeat * 8;
    const cap = opts.maxHeight ?? 99;
    const floor = opts.floor ?? 0;
    let bar = 0;
    for (let base = x0; base < x1; base += span, bar++) {
      for (const m of bars[bar % bars.length]) {
        const x = base + m[1];
        if (x < x0 || x >= x1 - 0.5) continue;
        switch (m[0]) {
          case "tower":
            this.tower(x, Math.min(m[2], cap), floor);
            break;
          case "plinth":
            this.plinth(x, m[2], Math.min(m[3], cap), floor);
            break;
          case "mark":
            this.mark(x, m[2]);
            break;
          case "far":
            this.push({
              kind: "block", x, y: floor, w: 2, h: Math.min(m[2], cap + 3),
              decoy: true, back: true, alpha: 0.4,
            });
            break;
        }
      }
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

  // ── sections ───────────────────────────────────────────────────────────

  /**
   * A cube stretch, written as a score: one entry per beat that has anything
   * on it. Nothing is generated — the array *is* the level — but the geometry
   * of each entry is solved from the level's own tuning, so the same score
   * plays correctly under a floaty moon gravity and a heavy one.
   *
   *   ["spikes", 12, 2]   on beat 12 you jump, over two spikes
   *   ["teeth", 16, 4]    on beat 16 you must NOT jump; four teeth overhead
   *   ["saw", 20, 2.6]    a sawblade at that height, same instruction
   *   ["pad", 24]         a pad that launches you on the beat
   *   ["step", 28, 5, 1]  a platform you land on, five wide and one high
   *   ["orb", 32, 3.2]    an orb at that height over a pit of three spikes
   */
  cube(score: CubeBeat[]) {
    const apex = this.meta.tuning.apex;
    // Head height: just above the top of a jump, so jumping is what hits it.
    const head = Math.round((apex + 0.4) * 2) / 2;
    for (const entry of score) {
      const [kind, at] = entry;
      switch (kind) {
        case "spikes":
          this.beatSpikes(at, entry[2], entry[3] ?? {});
          break;
        case "teeth":
          this.ceilingSpikes(this.onBeat(at, entry[2]), entry[2] + 1, head);
          break;
        case "saw":
          this.saws(this.beat(at) + 1, entry[2] ?? head, 2.5);
          break;
        case "pad":
          this.pad(this.beat(at));
          this.spikes(this.onBeat(at, 3), 3);
          break;
        case "step":
          // A jump on beat `at` lands exactly where beat at+1 starts, so a
          // platform whose edge is on a beat is a platform you cannot miss.
          this.block(this.beat(at + 1), 0, entry[2], entry[3]);
          break;
        case "orb":
          this.spikes(this.onBeat(at, 3), 3);
          this.orb(this.onBeat(at) + 0.5, entry[2], "yellow");
          break;
      }
    }
  }

  /**
   * A ship tunnel. One gate every two beats, each an opening of 4.4 blocks
   * whose floor is the next number in `gates`. A ship covers roughly two apex
   * heights of altitude in a beat at any tuning, so a gate that moves two
   * blocks in two beats is comfortable everywhere.
   */
  ship(from: number, to: number, gates: number[], ceiling = 9.5) {
    this.portal(this.beat(from) - 2, 0, { to: "ship" });
    this.roof(this.beat(from), this.beat(to) + 1, ceiling);
    gates.forEach((lo, i) => {
      const x = this.beat(from + 1 + i * 2);
      if (x > this.beat(to) - 2) return;
      if (lo > 0) this.block(x, 0, 1.6, lo);
      this.block(x, lo + 4.4, 1.6, ceiling - (lo + 4.4));
      this.plinth(x + 3, 2, Math.max(1, lo));
    });
    // Back to the cube on the way out. Without this the player leaves a ship
    // tunnel still flying a ship, which the solver survives — it just flies
    // over the next section — so it never showed up as a failure, only as a
    // level that had quietly stopped being the level it was written as.
    this.portal(this.beat(to), 0, { to: "cube" });
  }

  /**
   * A ball corridor: a floor, a ceiling, and rows of spikes on one or the
   * other. A flip crosses the corridor in well under a beat, so rows two
   * beats apart are comfortable and rows one beat apart are not.
   */
  ball(from: number, to: number, rows: Array<[number, number, "floor" | "ceil"]>, ceiling = 6) {
    this.portal(this.beat(from) - 2, 0, { to: "ball" });
    this.roof(this.beat(from), this.beat(to) + 1, ceiling);
    for (const [at, n, side] of rows) {
      if (side === "floor") this.spikes(this.beat(at), n, 0);
      else this.spikes(this.beat(at), n, ceiling - 1, { rot: 180 });
    }
    this.portal(this.beat(to), 0, { to: "cube" });
  }

  /**
   * A wave tube, its centreline given as [beat, height] corners. The wave dies
   * on contact with anything, so nothing else goes in here — a corridor you
   * cannot read is not a hard section, it is a coin flip.
   */
  wave(from: number, to: number, corners: Array<[number, number]>, half = 1.8) {
    this.portal(this.beat(from) - 2, 0, { to: "wave" });
    this.tube(
      corners.map(([n, y]) => [this.beat(n), y] as [number, number]),
      half,
    );
    this.portal(this.beat(to), 0, { to: "cube" });
  }

  finish(beats: number, start: Omit<Level["start"], "speed">): Level {
    this.sections.sort((a, b) => a.x - b.x);
    return {
      ...this.meta,
      objects: this.objects,
      sections: this.sections,
      length: this.beat(beats),
      start: { ...start, speed: this.t.speed },
    };
  }
}
