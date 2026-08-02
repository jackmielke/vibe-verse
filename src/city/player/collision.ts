/**
 * The terrain query layer for Vibe Island's player.
 *
 * Three questions, asked every frame: what am I standing on, is this
 * spot solid, and did I just hit my head. They used to be closures
 * halfway down a 7,400-line component, sharing a mutable module variable
 * with the movement code four hundred lines below them — which is how
 * "am I on a cloud?" ended up being answered by an altitude band. The
 * band was correct when it was written. Then the Moon settled at y=175,
 * Moon II at 205 and Mars at 240, and three entire worlds started
 * trampolining the player on every single step, because nothing in the
 * type system or the tests said a surface's bounciness is a property of
 * the surface.
 *
 * Now it is. `supportAt` returns the surface it actually found, carrying
 * its own bounciness, and a world cannot become springy by drifting into
 * a magic range of altitudes.
 */
import type { WorldBox } from "@/components/city/cardboardIsland";

/** What the player is standing on. */
export interface Surface {
  /** Absolute world Y of the surface top. */
  height: number;
  /**
   * Launch speed in m/s if this surface throws you back up, 0 if it is
   * ordinary ground. Only clouds set it.
   */
  bouncy: number;
}

export interface CollisionOptions {
  /**
   * Terrain that is computed rather than boxed — Powder Peak's snow.
   * Returns null away from that terrain. Treated as support even when it
   * sits slightly ABOVE the player, so walking uphill behaves like
   * stairs instead of running into an invisible wall.
   */
  analyticHeightAt?: (x: number, z: number) => number | null;
  /** Horizontal half-width of the player's body. */
  radius: number;
  /** Standing height, for head-bonk and blocked tests. */
  standHeight?: number;
}

/**
 * The street plate at y=0 is real ground everywhere on the surface, and
 * it COMPETES with box tops rather than acting as a fallback — otherwise
 * any box with a sunken top (the Gremlin Mines floor at y=-300 once sat
 * directly under the plaza) silently wins and the player drops through
 * downtown. Below this line the plate disappears, so visitors to the
 * mines aren't snapped 300m up to the surface.
 */
const UNDERWORLD_Y = -50;

export class CollisionWorld {
  private readonly boxes: WorldBox[];
  private readonly analyticHeightAt: ((x: number, z: number) => number | null) | null;
  private readonly radius: number;
  private readonly standHeight: number;
  /** Reused so the per-frame queries don't allocate. */
  private readonly scratch: Surface = { height: 0, bouncy: 0 };

  /** `boxes` is held live by reference — callers mutate it as worlds
   *  load and as clouds drift, and those edits must be visible here. */
  constructor(boxes: WorldBox[], opts: CollisionOptions) {
    this.boxes = boxes;
    this.analyticHeightAt = opts.analyticHeightAt ?? null;
    this.radius = opts.radius;
    this.standHeight = opts.standHeight ?? 1.7;
  }

  private overlapsXZ(b: WorldBox, x: number, z: number) {
    return (
      x >= b.minX - this.radius && x <= b.maxX + this.radius &&
      z >= b.minZ - this.radius && z <= b.maxZ + this.radius
    );
  }

  /**
   * The highest surface at or below `refY` under (x, z).
   *
   * Only surfaces at or below refY can hold you up, so a floating island
   * doesn't catch a pilot flying far beneath it.
   *
   * The returned object is REUSED between calls — read what you need
   * before calling again.
   */
  supportAt(x: number, z: number, refY: number): Surface {
    const out = this.scratch;
    let h = -Infinity;
    out.bouncy = 0;

    for (const b of this.boxes) {
      if (b.height <= refY && b.height > h && this.overlapsXZ(b, x, z)) {
        h = b.height;
        out.bouncy = b.bouncy ?? 0;
      }
    }

    const analytic = this.analyticHeightAt?.(x, z) ?? null;
    if (analytic !== null && analytic <= refY + 0.6 && analytic > h) {
      h = analytic;
      out.bouncy = 0;
    }

    if (refY >= UNDERWORLD_Y && h < 0) {
      h = 0;
      out.bouncy = 0;
    }

    out.height = h !== -Infinity ? h : refY < UNDERWORLD_Y ? refY - 9999 : 0;
    return out;
  }

  /** Convenience for callers that only want the height. */
  supportHeightAt(x: number, z: number, refY: number): number {
    return this.supportAt(x, z, refY).height;
  }

  /** True when the body (feet at y, head at y+standHeight) is inside a column. */
  isBlocked(x: number, z: number, y: number): boolean {
    for (const b of this.boxes) {
      // The 0.4 lets you step up onto a low ledge instead of being
      // stopped dead by it.
      if (y < b.height - 0.4 && y + this.standHeight > b.base && this.overlapsXZ(b, x, z)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Rising into the underside of a floating world. Returns the Y the
   * player should be clamped to, or null if the head is clear.
   */
  ceilingAt(x: number, z: number, prevY: number, y: number): number | null {
    const head = this.standHeight + 0.1; // matches the old inline 1.8
    for (const b of this.boxes) {
      if (prevY + head <= b.base && y + head > b.base && this.overlapsXZ(b, x, z)) {
        return b.base - head;
      }
    }
    return null;
  }
}
