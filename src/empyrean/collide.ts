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
 *
 * ## Things that move: `MovingFrame`
 *
 * The grid is built once and never rebuilt, which is exactly right for a city
 * and useless for a tram. A box that changes cell every second cannot live in
 * a static index; and an *oblique* box cannot live in an axis-aligned one
 * without over-covering the ground beside it — which for a blocker is a
 * rounding error and for a deck is a body standing on thin air next to a
 * tram.
 *
 * So anything that moves — and anything that is simply a rigid cluster of
 * boxes at an angle the grid cannot hold — is a **`MovingFrame`**: a pose
 * (`x`, `y`, `z`, `yaw`), a velocity, a cull radius, and its blockers and
 * decks written *in the frame's own coordinates*. Every query transforms the
 * point into the frame and tests axis-aligned boxes there, so a tram at 43
 * degrees is as exact as one on an axis, and moving it is four numbers rather
 * than an index to rebuild.
 *
 * Frames are scanned linearly, because there are a handful and each is
 * rejected by a single squared-distance test. A hundred would want an index;
 * seven do not.
 *
 * ## `carryAt`, and why this file knows about velocity
 *
 * A *rising* deck picks a body up for free: `flight.ts` looks support up from
 * `prevY + CLIMB`, so a floor that has come up under you catches you, and the
 * spire's lift is nothing but a `Deck` whose `y` changes. A deck that moves
 * **sideways** cannot do that, because support is looked up by XZ and the
 * floor has left: a body standing on a tram that slides out from under it is
 * a body standing in the air where the tram used to be.
 *
 * `carryAt` is the missing primitive. It answers "the surface holding this
 * body up is moving, and this is how fast", and `flight.ts` adds that to the
 * body's *position* — never to its velocity, which would fling you across the
 * city the moment you stepped off.
 *
 * ## `pushOutAt`, the other thing a frame needs
 *
 * `blockedAt` refuses a *move*; it does not resolve a body that is already
 * inside something. For static geometry that has never mattered, because a
 * building does not arrive — you can only ever be outside one, and the
 * three-way slide in `flight.ts` keeps you there.
 *
 * Moving frames break that, and they break it hard. The body's radius is
 * 0.6 m, so a 0.14 m tram wall is a 1.48 m exclusion band, and a *tram pulls
 * up next to you*. Stand at the platform edge as one arrives, or in a doorway
 * as the doors shut, and the band closes around a body that is already inside
 * it — at which point every direction it can step is still inside it, all
 * three slide tests fail, and the body is frozen until the tram leaves. A
 * motionless grounded player is also exactly what a stalled tram looks like
 * from outside, which makes it expensive to diagnose as well as bad to be in.
 *
 * So a frame that can close around you has to be able to let you out.
 * `pushOutAt` reports the shortest way out of a moving frame's box, in the
 * frame's own axes, and `flight.ts` walks the body along it. It is only ever
 * a nudge onto ground the body could have stood on anyway: out of a doorway
 * into the car, or back from the platform edge onto the platform. Static
 * boxes are deliberately not scanned — nothing static ever closes on you, and
 * a body that could push its way out of a building is a different world.
 *
 * `carryAt` answers "you are on it"; this answers "you are in it".
 *
 * ## What `carryAt` will and will not answer for
 *
 * It answers only for a body standing **on a frame's own deck, at that deck's
 * own height**. Not for one near it, beside it, under it, or in the air over
 * it. That footprint-and-height test is the whole safety argument: carrying
 * too much is far worse than carrying too little, because a body glued to a
 * frame it is not standing in gets dragged through a building, whereas a body
 * carried too little simply falls off a tram — which is embarrassing, visible,
 * and survivable.
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

/**
 * A rigid cluster of boxes and decks with a pose and a velocity.
 *
 * Everything in `blockers` and `decks` is written in the frame's own
 * coordinates: `x`/`z` across and along it, `top`/`bottom`/`y` measured from
 * the frame's own origin. The pose fields are meant to be **mutated in place**
 * every frame by whoever owns the thing — the arrays are read on every query,
 * so swapping `blockers` for a different prebuilt array is how a door opens
 * without allocating or re-indexing anything.
 *
 * A stationary frame is a legal and useful degenerate case: the tram platforms
 * are oblique rectangles that the grid would have to over-cover, and they use
 * a frame with a zero velocity for exactly that reason.
 */
export interface MovingFrame {
  /** Origin in world space. */
  x: number;
  y: number;
  z: number;
  /** Yaw of the frame's local axes, radians; same convention as everything. */
  yaw: number;
  /** The frame's own velocity in world space, m/s. */
  vx: number;
  vy: number;
  vz: number;
  /**
   * Yaw rate, radians per second.
   *
   * Not a refinement — without it a passenger on anything that turns walks
   * slowly out through the side of it. A carry is a rigid motion, and a rigid
   * motion is a translation *and* a rotation about the frame's own origin. A
   * tram on a 218 m ring turns at 0.07 rad/s, which slides somebody standing
   * a metre off its centre line six metres down the car over one lap.
   *
   * Both this and the velocity are best written as "what the frame actually
   * did last step, over dt" rather than derived from its heading. The tram's
   * heading is interpolated between the samples of a polyline while its
   * position moves along the chords, and the two differ by half a segment's
   * turn — which is a systematic sideways drift of about seven millimetres a
   * frame, and a passenger on the roadway inside three seconds.
   */
  w: number;
  /**
   * Cull radius about the origin, metres. A query further out than this from
   * (`x`, `z`) skips the frame entirely, which is the only reason a linear
   * scan is acceptable. Make it generous: too small is a tram you fall
   * through.
   */
  radius: number;
  /** Boxes you cannot walk through, in the frame's coordinates. */
  blockers: Blocker[];
  /** Standable surfaces, in the frame's coordinates. */
  decks: Deck[];
}

/**
 * Filled by `carryAt`: the rigid motion of the deck under a body.
 *
 * `x`/`y`/`z` are the velocity of the frame's origin, `w` its yaw rate, and
 * `px`/`pz` the origin itself — the pivot the rotation is about. Hoisted into
 * a struct the caller owns, so a frame path never allocates.
 */
export interface CarryOut {
  x: number;
  y: number;
  z: number;
  w: number;
  px: number;
  pz: number;
}

const CELL = 24;

/**
 * How exactly a body's feet must agree with a deck's height to be carried by
 * it. `flight.ts` passes back the very number `supportAt` gave it, so this is
 * only guarding against float drift — it is deliberately far too tight to
 * catch anything standing on a different surface at a similar height.
 */
const CARRY_TOL = 0.03;

/**
 * How far past the edge of a box `pushOutAt` puts a body, metres.
 *
 * Not a fudge. Resolving the overlap to exactly zero leaves the body on the
 * boundary, and `blockedAt` tests with `<=`, so a body standing precisely
 * there is still blocked and still cannot take a step in most directions —
 * the shove happens, achieves nothing anybody can feel, and the body is stuck
 * on a knife edge instead of stuck in a wall. Five centimetres is under a
 * frame of walking and puts it decisively outside.
 */
const PUSH_SKIN = 0.05;

export interface CollisionWorld {
  /** True if a body of radius `pad` at (x, z, y) would be inside something. */
  blockedAt(x: number, z: number, y: number, pad?: number): boolean;
  /**
   * `blockedAt` against the static world only, ignoring every moving frame.
   *
   * The carry needs this and nothing else needs it. A carry is a rigid
   * translation of a frame, so it can never push a body into that frame's own
   * walls — but the frame's boxes are still standing where they were *last*
   * frame while the body is being moved to where it will be *next* frame, so
   * testing against them would refuse a perfectly good carry roughly whenever
   * the tram was moving. Testing against the static city is the check that
   * actually means something: it is what stops a carrier dragging a passenger
   * through a building.
   */
  blockedStaticAt(x: number, z: number, y: number, pad?: number): boolean;
  /** Highest standable surface at (x, z) at or below `fromY`. */
  supportAt(x: number, z: number, fromY: number): number;
  /**
   * If the surface at (x, z, y) is a moving frame's deck, write that frame's
   * velocity into `out` and return true. `y` must be the value `supportAt`
   * returned — see `CARRY_TOL`.
   */
  carryAt(x: number, z: number, y: number, out: CarryOut): boolean;
  /**
   * If (x, z, y) is *inside* a moving frame's box, write the shortest vector
   * that gets it out into `out.x` / `out.z` and return true.
   *
   * Moving frames only. See the note above: a body already inside an
   * exclusion band cannot step out of one, because every step it can take is
   * still inside it, and only something that arrived can put it there.
   */
  pushOutAt(x: number, z: number, y: number, pad: number, out: CarryOut): boolean;
  /** How many boxes, decks and frames are in play, for the debug overlay. */
  readonly counts: { blockers: number; decks: number; frames: number };
}

export function buildCollision(
  blockers: Blocker[],
  decks: Deck[],
  frames: MovingFrame[] = [],
): CollisionWorld {
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

  /* ---- the moving frames ----------------------------------------------
   * Two scratch numbers rather than a returned pair: this runs several times
   * a frame per query and per frame there are several queries, and the one
   * rule this whole directory agrees on is that the frame path allocates
   * nothing. */
  let lx = 0;
  let lz = 0;
  /** Transform a world XZ into a frame's coordinates. False if out of range. */
  const toLocal = (f: MovingFrame, x: number, z: number): boolean => {
    const dx = x - f.x;
    const dz = z - f.z;
    if (dx * dx + dz * dz > f.radius * f.radius) return false;
    const c = Math.cos(f.yaw);
    const s = Math.sin(f.yaw);
    // The inverse of three's makeRotationY, which sends local (1,0,0) to
    // world (cos, 0, -sin).
    lx = dx * c - dz * s;
    lz = dx * s + dz * c;
    return true;
  };

  const staticBlocked = (x: number, z: number, y: number, pad: number): boolean => {
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
  };

  return {
    counts: { blockers: blockers.length, decks: decks.length, frames: frames.length },

    blockedStaticAt(x, z, y, pad = 0.6) {
      return staticBlocked(x, z, y, pad);
    },

    blockedAt(x, z, y, pad = 0.6) {
      if (staticBlocked(x, z, y, pad)) return true;
      for (let fi = 0; fi < frames.length; fi++) {
        const f = frames[fi];
        if (!toLocal(f, x, z)) continue;
        const ly = y - f.y;
        const list = f.blockers;
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          if (ly >= b.top - 0.15 || ly < b.bottom - 0.15) continue;
          if (Math.abs(lx - b.x) <= b.hx + pad && Math.abs(lz - b.z) <= b.hz + pad) return true;
        }
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

      /* And then anything that is currently driving past. Same one-way rule:
       * a tram roof you are flying under is not a floor. */
      for (let fi = 0; fi < frames.length; fi++) {
        const f = frames[fi];
        if (!toLocal(f, x, z)) continue;
        const list = f.decks;
        for (let i = 0; i < list.length; i++) {
          const d = list[i];
          const wy = f.y + d.y;
          if (wy > fromY || wy <= best) continue;
          if (
            Math.abs(lx - (d.x ?? 0)) <= (d.hx ?? 0) &&
            Math.abs(lz - (d.z ?? 0)) <= (d.hz ?? 0)
          ) {
            best = wy;
          }
        }
      }

      return best;
    },

    pushOutAt(x, z, y, pad, out) {
      let bestOverlap = 0;
      let px = 0;
      let pz = 0;
      for (let fi = 0; fi < frames.length; fi++) {
        const f = frames[fi];
        if (!toLocal(f, x, z)) continue;
        const ly = y - f.y;
        const list = f.blockers;
        const c = Math.cos(f.yaw);
        const sn = Math.sin(f.yaw);
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          if (ly >= b.top - 0.15 || ly < b.bottom - 0.15) continue;
          const dx = lx - b.x;
          const dz = lz - b.z;
          const ox = b.hx + pad + PUSH_SKIN - Math.abs(dx);
          const oz = b.hz + pad + PUSH_SKIN - Math.abs(dz);
          if (ox <= 1e-4 || oz <= 1e-4) continue;
          /* Out along whichever axis is shorter, which for a wall is always
             straight out of it and never along it. Deepest box wins, so a
             body in a corner is resolved by the wall it is furthest into. */
          const depth = Math.min(ox, oz);
          if (depth <= bestOverlap) continue;
          bestOverlap = depth;
          const ux = ox <= oz ? (dx < 0 ? -ox : ox) : 0;
          const uz = ox <= oz ? 0 : dz < 0 ? -oz : oz;
          // Back into world axes; the box was axis-aligned in the frame.
          px = ux * c + uz * sn;
          pz = -ux * sn + uz * c;
        }
      }
      if (bestOverlap <= 0) return false;
      out.x = px;
      out.z = pz;
      return true;
    },

    carryAt(x, z, y, out) {
      for (let fi = 0; fi < frames.length; fi++) {
        const f = frames[fi];
        if (!toLocal(f, x, z)) continue;
        const list = f.decks;
        for (let i = 0; i < list.length; i++) {
          const d = list[i];
          if (Math.abs(f.y + d.y - y) > CARRY_TOL) continue;
          if (
            Math.abs(lx - (d.x ?? 0)) <= (d.hx ?? 0) &&
            Math.abs(lz - (d.z ?? 0)) <= (d.hz ?? 0)
          ) {
            out.x = f.vx;
            out.y = f.vy;
            out.z = f.vz;
            out.w = f.w;
            out.px = f.x;
            out.pz = f.z;
            return true;
          }
        }
      }
      return false;
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
