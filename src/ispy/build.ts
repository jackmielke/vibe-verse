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

/** Deterministic noise. The level must look identical on every attempt or
    memorising it — the entire game — would be impossible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
      kind: "block", x: x - 0.25, y: y + 1, w: n + 0.5, h: 0.7,
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
   * Grid-aligned decoy geometry, **standing on something**.
   *
   * Two rules, and the second one is newer and just as important as the first.
   *
   * 1. Decoys have to look like *level*. Everything here sits on the integer
   *    grid, at the sizes real objects come in, unrotated, in the section's own
   *    colours. A decoy spike row is pixel-for-pixel a real spike row. An
   *    earlier version scattered randomly rotated, randomly scaled shapes and
   *    it read as confetti: nobody mistakes a spike tilted 37° for a hazard, so
   *    nothing was being deceived — the screen was just noisy.
   *
   * 2. Decoys have to be **grounded**. Spikes stand on the floor or on top of a
   *    pillar that reaches the floor; rows hang from a ceiling that exists.
   *    Nothing is left floating in mid-air, because a spike hanging in space is
   *    not something a level contains, and a screen full of them reads as a bug
   *    rather than as a lie.
   *
   * The one exception is the sawblade, which floats by design and always has —
   * see `gears`.
   */
  ghosts(
    x0: number,
    x1: number,
    floor: number,
    seed: number,
    opts: { density?: number; ceiling?: number; maxHeight?: number } = {},
  ) {
    const r = rng(seed);
    const density = opts.density ?? 0.55;
    const maxH = opts.maxHeight ?? 4;
    for (let x = Math.ceil(x0); x < x1; x++) {
      if (r() > density) continue;
      const roll = r();

      if (roll < 0.36) {
        // A spike row on the floor, exactly like a real one.
        const n = 1 + Math.floor(r() * 3);
        for (let i = 0; i < n && x + i < x1; i++) this.fakeSpike(x + i, floor);
        x += n;
      } else if (roll < 0.62) {
        // A plinth standing on the floor, some of them carrying spikes —
        // because real ones do, and because it gives the eye somewhere to go
        // other than the floor line.
        const w = 1 + Math.floor(r() * 3);
        const h = 1 + Math.floor(r() * Math.max(1, maxH - 1));
        this.push({ kind: "block", x, y: floor, w, h, decoy: true });
        if (r() < 0.5) for (let i = 0; i < w; i++) this.fakeSpike(x + i, floor + h);
        x += w;
      } else if (roll < 0.8 && opts.ceiling !== undefined) {
        // A row hanging from a ceiling that is actually there.
        const n = 1 + Math.floor(r() * 2);
        for (let i = 0; i < n && x + i < x1; i++)
          this.push({
            kind: "spike", x: x + i, y: opts.ceiling - 1, w: 1, h: 1, rot: 180, decoy: true,
          });
        x += n;
      } else {
        // A column, the shape a real gate is made of.
        const h = 2 + Math.floor(r() * Math.max(1, maxH));
        this.push({ kind: "block", x, y: floor, w: 1, h, decoy: true });
        x += 1;
      }
      // Breathing room. Without it, adjacent patterns fuse into one
      // fourteen-spike wall that no real level would ever contain.
      x += 1 + Math.floor(r() * 3);
    }
  }

  /**
   * Floating sawblades — the only thing in this level allowed to hang in mid
   * air, because a saw hanging in mid air is what a saw *is*. They spin, they
   * catch the light, and they are the one piece of decoration that reads as
   * deliberate rather than as debris.
   */
  gears(x0: number, x1: number, yLo: number, yHi: number, count: number, seed: number) {
    const r = rng(seed);
    for (let i = 0; i < count; i++) {
      const size = 1.5 + Math.round(r() * 2) * 0.75;
      this.push({
        kind: "saw",
        x: Math.round(x0 + r() * (x1 - x0)),
        y: Math.round(yLo + r() * (yHi - yLo)),
        w: size, h: size,
        decoy: true,
        alpha: 0.6 + r() * 0.4,
      });
    }
  }

  /** The pink question marks the level is named after. Paint, always. */
  glyphs(x0: number, x1: number, yLo: number, yHi: number, count: number, seed: number) {
    const r = rng(seed);
    for (let i = 0; i < count; i++) {
      this.push({
        kind: "glyph",
        x: x0 + r() * (x1 - x0),
        y: yLo + r() * (yHi - yLo),
        w: 1 + r() * 1.6, h: 1 + r() * 1.6,
        rot: (r() - 0.5) * 30,
        decoy: true,
        alpha: 0.35 + r() * 0.45,
      });
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
    this.push({ kind: "block", x: x0, y: y - 1.2, w: x1 - x0, h: 1.2, decoy: true });
    for (const x of [x0, x1 - 1]) {
      this.push({ kind: "block", x, y: 0, w: 1, h: y - 1.2, decoy: true });
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
