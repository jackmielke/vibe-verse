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
 * A 1× cube jump traces y(d) = 2d − 0.3837d², where d is blocks travelled
 * since takeoff (v0 = 20.8, g = 83, speed = 10.4). It peaks at 2.6 blocks
 * high after 2.6 blocks, and lands after 5.21.
 *
 * Consequences worth keeping in your head while authoring:
 *   • a ground spike (needs y > 1) is cleared from 0.55 to 4.66 blocks out,
 *   • a spike on a 1-block plinth (y > 2) from 1.28 to 3.93,
 *   • so a run of three ground spikes is comfortable and five is impossible.
 */
export const JUMP_WINDOW = { clearsSpikeFrom: 0.55, to: 4.66, apex: 2.6 };

export function arcHeight(d: number): number {
  return 2 * d - 0.3837 * d * d;
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
   * Grid-aligned decoy geometry.
   *
   * This is the level's whole trick and it only works if the decoys look like
   * *level*. Earlier versions scattered randomly rotated, randomly sized
   * shapes, which reads as confetti: you cannot mistake a spike tilted 37°
   * and scaled to 1.8× for a real hazard, so nothing is being deceived —
   * the screen is just noisy.
   *
   * So every ghost here sits on the integer grid, at the sizes real objects
   * come in, unrotated, in the section's own colours. A decoy spike row on
   * the floor is pixel-for-pixel a real spike row. That is the point.
   */
  ghosts(
    x0: number,
    x1: number,
    yLo: number,
    yHi: number,
    seed: number,
    opts: { density?: number; ceiling?: number } = {},
  ) {
    const r = rng(seed);
    const density = opts.density ?? 0.55;
    for (let x = Math.ceil(x0); x < x1; x++) {
      if (r() > density) continue;
      const roll = r();
      const y = Math.round(yLo + r() * (yHi - yLo));

      if (roll < 0.34) {
        // A spike row, standing on a floor exactly like a real one. Three is
        // the cap for the same reason it is the cap for real ones: a longer
        // row is not clearable, so it reads as scenery and fools nobody.
        const n = 1 + Math.floor(r() * 3);
        for (let i = 0; i < n && x + i < x1; i++) this.fakeSpike(x + i, y);
        x += n;
      } else if (roll < 0.58) {
        // A platform. Some of them carry spikes, because real ones do.
        const w = 1 + Math.floor(r() * 3);
        this.push({ kind: "block", x, y, w, h: 1, decoy: true });
        if (r() < 0.45) for (let i = 0; i < w; i++) this.fakeSpike(x + i, y + 1);
        x += w;
      } else if (roll < 0.72) {
        // A hanging row off a ceiling, pointing down.
        const top = opts.ceiling ?? yHi;
        const n = 1 + Math.floor(r() * 2);
        for (let i = 0; i < n && x + i < x1; i++)
          this.push({ kind: "spike", x: x + i, y: top - 1, w: 1, h: 1, rot: 180, decoy: true });
        x += n;
      } else if (roll < 0.86) {
        this.push({ kind: "saw", x, y, w: 2, h: 2, decoy: true });
        x += 2;
      } else {
        // A pillar: the shape a real gate is made of.
        const h = 2 + Math.floor(r() * 3);
        this.push({ kind: "block", x, y, w: 1, h, decoy: true });
        x += 1;
      }
      // Breathing room. Without it, adjacent patterns fuse into one
      // fourteen-spike wall that no real level would ever contain.
      x += 1 + Math.floor(r() * 3);
    }
  }

  /**
   * The layer behind the game: big, soft, slow, dimmed, and free to be as
   * loose as it likes precisely *because* it is never mistaken for geometry.
   * All of the level's visual richness comes from here, so the play layer can
   * stay clean and legible.
   */
  backdrop(x0: number, x1: number, yLo: number, yHi: number, count: number, seed: number) {
    const r = rng(seed);
    for (let i = 0; i < count; i++) {
      const x = x0 + r() * (x1 - x0);
      const y = yLo + r() * (yHi - yLo);
      const s = 2 + r() * 5;
      const roll = r();
      this.push({
        kind: roll < 0.55 ? "spike" : roll < 0.85 ? "block" : "saw",
        x, y, w: s, h: s * (roll < 0.55 ? 1 : 0.5 + r()),
        rot: (r() - 0.5) * 160,
        decoy: true, back: true,
        alpha: 0.18 + r() * 0.26,
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

  /** Ground you cannot stand on. */
  fakeSlab(x0: number, x1: number, y: number) {
    return this.push({
      kind: "block", x: x0, y: y - 1.2, w: x1 - x0, h: 1.2, decoy: true,
    });
  }

  /**
   * A checkpoint. Crossing one banks the run; dying after it puts you back
   * here rather than at the start. Not a collider — `World` skips them and
   * the engine watches the player's x instead.
   */
  checkpoint(x: number) {
    return this.push({ kind: "checkpoint", x, y: 0, w: 0.5, h: 7 });
  }

  finish(length: number, start: Level["start"]): Level {
    this.sections.sort((a, b) => a.x - b.x);
    return { objects: this.objects, sections: this.sections, length, start };
  }
}
