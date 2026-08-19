/**
 * Collision, gathered from every system that has an opinion about it.
 *
 * Buildings, interiors and the odd solid prop each hand over a list of boxes
 * and a list of standable decks; the ground itself comes from `cityplan.ts`.
 * This module is the one place that knows about all of them, and it exists so
 * that `world.ts` does not have to and so the whole thing can be tested
 * without a renderer.
 *
 * ## Why a grid and not a loop
 *
 * The first version was a linear scan, which is the right first version: a
 * hundred boxes at sixty frames is nothing. Then the props system arrived with
 * eight hundred more, and the camera rig asks the same question seven times a
 * frame while it looks for somewhere to stand — so the honest number is closer
 * to half a million comparisons a second for an answer that is nearly always
 * "no". A uniform grid over the island turns that into four or five.
 *
 * A uniform grid rather than a tree because the city is a disc 800 m across
 * with an almost even distribution of buildings: the case a BVH is better at
 * does not occur here, and the grid has no build cost worth measuring and no
 * balance to go wrong.
 *
 * ## One-way decks, and why `fromY` exists
 *
 * Every standable surface is one-way: it catches you from above and is not
 * there from below. Fly up past a balcony and you keep going; fall onto it and
 * you land. Without that, a jetpack world clips you onto the underside of
 * every roof you pass, which makes the whole vertical half of the city
 * unusable. The rule is enforced by looking support up from where the body
 * *was* rather than from where it now is — that is what the `fromY` argument
 * of `supportAt` means, and callers must pass the previous frame's height.
 */
import { surfaceAt } from "./cityplan";
import { DECKS } from "./config";

/** An axis-aligned box you cannot walk through. */
export interface Blocker {
  x: number;
  z: number;
  /** Half-extents on x and z. */
  hx: number;
  hz: number;
  /** Standable roof. */
  top: number;
  /** Underside — you can fly beneath a thing without being stopped by it. */
  bottom: number;
}

/** A flat surface you can stand on: a roof, a mezzanine, a platform. */
export interface Deck {
  y: number;
  /** Circular decks carry a radius; rectangular ones carry half-extents. */
  r?: number;
  x?: number;
  z?: number;
  hx?: number;
  hz?: number;
}

const CELL = 24;

export interface CollisionWorld {
  /** True if a body of radius `pad` at (x, z, y) would be inside something. */
  blockedAt(x: number, z: number, y: number, pad?: number): boolean;
  /** Highest standable surface at (x, z) at or below `fromY`. */
  supportAt(x: number, z: number, fromY: number): number;
  /** How many boxes and decks are in play, for the debug overlay. */
  readonly counts: { blockers: number; decks: number };
}

export function buildCollision(blockers: Blocker[], decks: Deck[]): CollisionWorld {
  /* ---- index the boxes ---- */
  const grid = new Map<number, number[]>();
  // Keys are packed into one integer so the map does not hash strings sixty
  // times a frame. The island fits inside ±512 m, so ten bits a side is ample.
  const key = (gx: number, gz: number) => ((gx + 512) << 11) | (gz + 512);

  for (let i = 0; i < blockers.length; i++) {
    const b = blockers[i];
    const x0 = Math.floor((b.x - b.hx) / CELL);
    const x1 = Math.floor((b.x + b.hx) / CELL);
    const z0 = Math.floor((b.z - b.hz) / CELL);
    const z1 = Math.floor((b.z + b.hz) / CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) {
        const k = key(gx, gz);
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
      }
    }
  }

  /* ---- index the decks the same way ---- */
  const deckGrid = new Map<number, number[]>();
  /** Decks with a radius are island-wide; keep them in a list of their own. */
  const roundDecks: Deck[] = [];
  for (let i = 0; i < decks.length; i++) {
    const d = decks[i];
    if (d.r !== undefined) {
      roundDecks.push(d);
      continue;
    }
    const cx = d.x ?? 0;
    const cz = d.z ?? 0;
    const hx = d.hx ?? 0;
    const hz = d.hz ?? 0;
    const x0 = Math.floor((cx - hx) / CELL);
    const x1 = Math.floor((cx + hx) / CELL);
    const z0 = Math.floor((cz - hz) / CELL);
    const z1 = Math.floor((cz + hz) / CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) {
        const k = key(gx, gz);
        const list = deckGrid.get(k);
        if (list) list.push(i);
        else deckGrid.set(k, [i]);
      }
    }
  }

  return {
    counts: { blockers: blockers.length, decks: decks.length },

    blockedAt(x, z, y, pad = 0.6) {
      const cell = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
      if (!cell) return false;
      for (let i = 0; i < cell.length; i++) {
        const b = blockers[cell[i]];
        // Not inside a thing you are standing on the roof of, and not inside
        // one you are flying underneath.
        if (y >= b.top - 0.15 || y < b.bottom - 0.15) continue;
        if (Math.abs(x - b.x) <= b.hx + pad && Math.abs(z - b.z) <= b.hz + pad) return true;
      }
      return false;
    },

    supportAt(x, z, fromY) {
      /* The ground first. `surfaceAt` already knows about the deck, the kerb,
       * the promenade rings and the void. */
      const ground = surfaceAt(x, z);
      let best = ground.kind === "void" ? -Infinity : ground.y;

      /* Then anything built on top of it. */
      const cell = deckGrid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
      if (cell) {
        for (let i = 0; i < cell.length; i++) {
          const d = decks[cell[i]];
          if (d.y > fromY || d.y <= best) continue;
          if (
            Math.abs(x - (d.x ?? 0)) <= (d.hx ?? 0) &&
            Math.abs(z - (d.z ?? 0)) <= (d.hz ?? 0)
          ) {
            best = d.y;
          }
        }
      }
      for (let i = 0; i < roundDecks.length; i++) {
        const d = roundDecks[i];
        if (d.y > fromY || d.y <= best) continue;
        const dx = x - (d.x ?? 0);
        const dz = z - (d.z ?? 0);
        if (dx * dx + dz * dz <= (d.r ?? 0) * (d.r ?? 0)) best = d.y;
      }

      return best;
    },
  };
}

/**
 * The promenade rings, as decks, so a body can stand on them.
 *
 * `surfaceAt` already reports them, so this is only needed by anything that
 * wants the list rather than a query — the minimap, a debug overlay, or a
 * system placing rail posts.
 */
export function promenadeDecks(): Deck[] {
  return DECKS.slice(1).map((d) => ({ y: d.y, r: d.outer }));
}
