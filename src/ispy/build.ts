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
   * Scatter convincing rubbish. Decoys are drawn by exactly the same code
   * that draws the real thing — the renderer is never told which is which —
   * so the only way to tell them apart is to have been here before, or to
   * spend a pulse.
   */
  noise(
    x0: number,
    x1: number,
    yLo: number,
    yHi: number,
    count: number,
    seed: number,
    opts: { glyphs?: number; back?: boolean; big?: boolean } = {},
  ) {
    const r = rng(seed);
    for (let i = 0; i < count; i++) {
      const x = x0 + r() * (x1 - x0);
      const y = yLo + r() * (yHi - yLo);
      const roll = r();
      const back = opts.back ?? false;
      if (roll < 0.5) {
        const s = opts.big ? 1 + r() * 2.6 : 0.6 + r() * 1.5;
        this.push({
          kind: "spike", x, y, w: s, h: s,
          rot: (r() - 0.5) * 220, decoy: true, back,
          alpha: back ? 0.35 + r() * 0.3 : 0.75 + r() * 0.25,
        });
      } else if (roll < 0.78) {
        const w = 0.6 + r() * 2.4;
        this.push({
          kind: "block", x, y, w, h: w * (0.4 + r()),
          rot: (r() - 0.5) * 60, decoy: true, back,
          alpha: back ? 0.25 + r() * 0.25 : 0.6 + r() * 0.4,
        });
      } else {
        this.push({
          kind: "saw", x, y, w: 1 + r() * 1.8, h: 1 + r() * 1.8,
          rot: r() * 360, decoy: true, back, alpha: back ? 0.3 : 0.8,
        });
      }
    }
    const g = opts.glyphs ?? 0;
    for (let i = 0; i < g; i++) {
      const x = x0 + r() * (x1 - x0);
      const y = yLo + r() * (yHi - yLo);
      this.push({
        kind: "glyph", x, y, w: 0.8 + r() * 1.4, h: 0.8 + r() * 1.4,
        rot: (r() - 0.5) * 50, decoy: true, alpha: 0.4 + r() * 0.5,
      });
    }
  }

  /** A row of decoy spikes standing on the floor, indistinguishable from
      the row of real ones you will meet four blocks later. */
  fakeSpikes(x: number, n: number, y = 0) {
    for (let i = 0; i < n; i++)
      this.push({ kind: "spike", x: x + i, y, w: 1, h: 1, decoy: true });
  }

  /** Ground you cannot stand on. */
  fakeSlab(x0: number, x1: number, y: number) {
    return this.push({
      kind: "block", x: x0, y: y - 1.2, w: x1 - x0, h: 1.2, decoy: true,
    });
  }

  finish(length: number, start: Level["start"]): Level {
    this.sections.sort((a, b) => a.x - b.x);
    return { objects: this.objects, sections: this.sections, length, start };
  }
}
