/**
 * DROP ZERO — the build system.
 *
 * Publishes `BuildService`. This is the module that makes the game a battle
 * royale instead of a shooter, and it is judged almost entirely on feel: the
 * wall has to be in front of you before you have finished thinking about it,
 * the ramp has to be under your feet on the frame you jumped, and the whole
 * tower has to come down when you shoot its legs out.
 *
 * ── The five things that make building feel right ──────────────────────────
 *
 *  1. ZERO INPUT LATENCY. Edge-triggered input (`pressed`, `rotate`, the
 *     rising edge of `fire`) is consumed inside `fixed()` and latched, rather
 *     than the usual buffer-in-update/consume-in-fixed dance. `update()` runs
 *     *after* every fixed step in a frame, so buffering there costs a whole
 *     frame on every single placement — 16 ms you can feel in a build fight.
 *     The latch is cleared in `update()`, which is what makes "consume in
 *     fixed" exactly-once even when the engine runs six sim steps in one frame.
 *
 *  2. THE COLLIDER EXISTS BEFORE THE PIECE DOES. A placed piece registers its
 *     collision boxes immediately at full extent and only *then* animates in
 *     over BUILD_TIME. Ramp-rushing is jumping onto a ramp that is 12 % built;
 *     if collision waited for the animation the whole mechanic would be a
 *     coin flip. What the 0.4 s buys is the HP curve — a fresh wall really is
 *     made of paper, and pushing through someone's build before it hardens is
 *     a legitimate way to win a fight.
 *
 *  3. GENEROUS SNAPPING, HONEST VALIDATION. The preview derives from the aim
 *     ray but snaps hard to the 4 m lattice and to the nearest of four axes,
 *     so there is no such thing as a "nearly aligned" wall. Validation is the
 *     opposite of generous and it is *visible*: green means it will go there,
 *     red means it will not, and the two never lie.
 *
 *  4. STRUCTURAL INTEGRITY IS A GRAPH, NOT A HEURISTIC. Every piece claims a
 *     handful of lattice nodes (the corner posts of its cell). Two pieces are
 *     connected iff they share a node. A flood fill from the ground-anchored
 *     pieces marks everything still standing; whatever the fill misses is
 *     scheduled to fall, staggered by distance from the break so a tower comes
 *     down over a beat instead of vanishing in one frame. It is the single
 *     most satisfying thing in the game and it is worth the bookkeeping.
 *
 *  5. ONE DRAW CALL PER (KIND × EDIT MASK × MATERIAL). Pieces are batched into
 *     `InstancedMesh`es keyed by their geometry, with per-instance tint,
 *     roughness jitter, build progress and damage carried on instanced
 *     attributes. A tower of 200 pieces is a handful of draw calls, and the
 *     per-instance jitter is what stops 200 identical walls reading as
 *     wallpaper.
 *
 * ── Why the geometry is shaped the way it is ───────────────────────────────
 *
 * Nothing here is a cube. A build piece is a *framed slab*: a chamfered
 * perimeter frame, chamfered mullions between the 3 × 3 edit cells, and nine
 * recessed panels, plus family-specific relief on top — battens and bolt
 * plates on wood, offset courses and corner quoins on stone, ribs and rivets
 * on metal. The recess is what gives every piece a real contact shadow at its
 * own seams; the chamfer is what gives every edge a bright sliver under the
 * key light. Both are cheap and both are the difference between "AAA" and
 * "someone's Three.js demo".
 *
 * The edit mask is not an afterthought bolted onto that — it *is* the model.
 * Wall, floor and ramp are all the same masked slab under different matrices,
 * so a doorway is just cell (1,0) and (1,1) switched off, and the frame around
 * the hole falls out of the mullion logic for free.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";
import {
  GRID,
  WALL_THICKNESS,
  type BuildKind,
  type BuildPiece,
  type BuildService,
  type ColliderOpts,
  type CollisionService,
  type DamageSource,
  type HarvestKind,
  type ImpactMaterial,
  type InventoryService,
  type MaterialName,
  type MaterialsService,
  type QualityTier,
  type System,
  type SystemFactory,
  type TerrainService,
  type WorldCtx,
} from "../types";

/* ------------------------------------------------------------------------ *
 * Contract shims
 *
 * `types.ts` belongs to every system at once and is not ours to edit while
 * twelve other modules are compiling against it, so anything we need beyond
 * the published interfaces is read structurally, optionally, with a fallback
 * that works when it is absent.
 * ------------------------------------------------------------------------ */

/**
 * Collision publishes an allocation-free overlap test beyond `CollisionService`
 * specifically so build validation does not have to allocate a handle per
 * candidate to answer a yes/no question. If it ever goes away we fall back to
 * `query`, which is correct and merely slower.
 */
type CollisionLike = CollisionService & {
  overlapBox?(box: THREE.Box3, filter?: (opts: ColliderOpts) => boolean): boolean;
};

/** Terrain's slope query, used to reject anchoring a piece to a cliff face. */
type TerrainLike = TerrainService & {
  slopeAt?(x: number, z: number): number;
};

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

/** Half a piece thickness. Used constantly; naming it once avoids typos. */
const HALF_T = WALL_THICKNESS * 0.5;

/**
 * How far in front of the player a piece may be placed. Fortnite's is a shade
 * over two cells; the value that matters is that it is *more* than one cell,
 * so you can throw a wall at the far side of the gap you are about to jump,
 * and *less* than three, so you cannot wall someone in from across a room.
 */
const BUILD_RANGE = 10.5;

/** Reach for entering edit mode. Deliberately shorter — editing is intimate. */
const EDIT_RANGE = 7.5;

/** Pickaxe reach. Slightly generous so a swing at a tree trunk never whiffs. */
const HARVEST_RANGE = 3.4;

/** Seconds between pickaxe swings. Fortnite's is ~0.6; this is the same feel. */
const SWING_INTERVAL = 0.62;

/**
 * Where in the swing the trace happens. The hit must land *after* the arm has
 * visibly moved or the feedback reads as precognition, and well before the
 * animation ends or the next swing feels blocked.
 */
const SWING_IMPACT = 0.17;

/** Material cost of one piece, for every kind. Fortnite charges a flat 10. */
const PIECE_COST = 10;

/**
 * Seconds from placement to full HP. 0.4 s is the number the whole mechanic
 * hangs off: long enough that pushing through a fresh wall is a real option,
 * short enough that a wall you threw up to block a shotgun actually blocks it.
 */
const BUILD_TIME = 0.4;

/** Fraction of max HP a piece spawns with. */
const BUILD_START_HP = 0.1;

/**
 * Fraction of BUILD_TIME spent growing to full size. The rest of the build is
 * an emissive sweep over already-full geometry — a piece that is still
 * physically small when you are trying to hide behind it is a lie, because its
 * collider has been full-size since frame one.
 */
const GROW_FRACTION = 0.45;

/** Full HP per material. Wood is fast and weak, metal is slow and strong. */
const PIECE_HP: Record<HarvestKind, number> = { wood: 150, stone: 300, metal: 500 };

/**
 * Seconds between placements while the fire button is held. 70 ms is just
 * under the fastest a human turns a corner, which is what makes a held-button
 * ramp rush lay a continuous run instead of a dotted line. A change of target
 * cell bypasses this entirely — see `tryPlace`.
 */
const PLACE_INTERVAL = 0.07;

/**
 * Hard ceiling on live pieces. Past this the oldest piece is quietly retired
 * rather than letting a fifteen-minute match walk the draw call count and the
 * collider table off a cliff. Retirement is silent and skips the collapse
 * cascade, because a piece disappearing from under a fight it is no longer
 * part of should not bring a tower down somewhere else.
 */
const MAX_PIECES = 1400;

/**
 * A lattice node counts as ground-anchored when the terrain reaches to within
 * this far below it. Generous on purpose: real ground is not on the 4 m grid,
 * and a build that refuses to anchor on a gentle slope is a build system
 * players stop trusting.
 */
const GROUND_TOLERANCE = 1.25;

/** Seconds of stagger per metre of distance from the break, when a tower falls. */
const COLLAPSE_STAGGER = 0.011;
/** Ceiling on that stagger, so the far side of a mega-build still falls today. */
const COLLAPSE_MAX_DELAY = 0.85;

/** Pickaxe damage to a built piece. ~3 swings through wood, 10 through metal. */
const PICKAXE_BUILD_DAMAGE = 52;

/** Harvest yield per swing, before the weak-point bonus. */
const HARVEST_YIELD: Record<HarvestKind, number> = { wood: 14, stone: 12, metal: 10 };

/** Radius of the blue weak point, in metres, and how long one lives. */
const WEAK_RADIUS = 0.34;
const WEAK_LIFETIME = 4.2;
/** How far off the last hit the next weak point spawns. */
const WEAK_SPREAD = 0.55;

/** Impact family per build material — footsteps, bullet decals, break debris. */
const IMPACT_OF: Record<HarvestKind, ImpactMaterial> = {
  wood: "wood",
  stone: "concrete",
  metal: "metal",
};

/** Which library material each build family is skinned with. */
const SURFACE_OF: Record<HarvestKind, MaterialName> = {
  wood: "woodPlank",
  stone: "rock",
  metal: "metalPanel",
};

/**
 * World metres per UV repeat, mirroring `SPEC[].metres` in materials.ts.
 * Duplicated rather than imported — systems in this engine do not import each
 * other, and a stale number here costs texture density, not a crash.
 */
const TILE_OF: Record<HarvestKind, number> = { wood: 2.6, stone: 4.5, metal: 2.8 };

/**
 * Base tint multiplied over the library albedo, per family. These are the
 * silhouette colours the game is read by at 100 m — Fortnite's builds are
 * colour-coded on purpose and so are ours: warm amber wood, bone-grey stone,
 * cold blue-grey metal. Kept light because they multiply an already-pigmented
 * albedo map, and ACES will take the top off anything hotter.
 */
const TINT_OF: Record<HarvestKind, number> = {
  wood: 0xe8bb84,
  stone: 0xd2d2cc,
  metal: 0xb4bfcb,
};

/** Ghost colours. Saturated enough to read against sky, grass and concrete. */
const GHOST_OK = new THREE.Color(0x3ff08a);
const GHOST_BAD = new THREE.Color(0xff3b4e);
/** The blue every Fortnite player reads as "this is yours / this is a weak spot". */
const ACCENT = new THREE.Color(0x3fc6ff);

interface BuildTier {
  /** Edge chamfer in metres. Zero on `low` — a chamfer is ~3.7× the triangles. */
  bevel: number;
  /**
   * Family relief level. 0 = frame and panels only, 1 = one band of relief per
   * edit cell, 2 = the full trim pass with bolt plates, quoins and rivets.
   */
  detail: 0 | 1 | 2;
  /**
   * Collider steps under a ramp. An AABB broadphase cannot represent a 45°
   * plane, so the ramp's collision is a staircase beneath its visual slab; more
   * steps means the player's feet track the plank surface more closely.
   * The step rise must stay under collision's 0.62 m STEP_HEIGHT or the ramp
   * becomes unclimbable, which caps this at 7 from below.
   */
  rampSteps: number;
  /** Debris chunks thrown per destroyed piece, on top of `vfx.buildBreak`. */
  debris: number;
}

/**
 * `low` keeps every silhouette and every gameplay guarantee and loses only
 * surface relief — a build fight has to be legible on a phone, and what makes
 * it legible is the frame, the colour and the ghost, none of which are here.
 */
const TIERS: Record<QualityTier, BuildTier> = {
  low: { bevel: 0, detail: 0, rampSteps: 8, debris: 0 },
  medium: { bevel: 0.022, detail: 1, rampSteps: 10, debris: 4 },
  high: { bevel: 0.032, detail: 2, rampSteps: 12, debris: 7 },
  ultra: { bevel: 0.04, detail: 2, rampSteps: 14, debris: 10 },
};

/* ------------------------------------------------------------------------ *
 * Small maths
 * ------------------------------------------------------------------------ */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Integer hash → [0,1). Per-piece jitter must not disturb the world RNG. */
function hash2i(a: number, b: number): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Full 3 × 3 edit mask — every cell solid. Bit i = column (i % 3), row (i / 3). */
const MASK_FULL = 0b111111111;
const maskHas = (mask: number, col: number, row: number) => (mask & (1 << (row * 3 + col))) !== 0;

/* ------------------------------------------------------------------------ *
 * The geometry kit
 *
 * A plain triangle soup with auto-oriented winding and no UV storage: UVs are
 * derived at bake time by projecting position along the dominant normal axis,
 * which is the only projection that lets a frame rail, the panel behind it and
 * the batten on top of it share one continuous grain rather than each getting
 * its own 0..1 island and a visible seam between them.
 * ------------------------------------------------------------------------ */

class Geo {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly idx: number[] = [];
  private n = 0;

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    return this.n++;
  }

  /** A triangle wound to face `n`, so call sites may list corners in any order. */
  tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    nx: number, ny: number, nz: number,
  ): void {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const flip = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz < 0;
    const i0 = this.vert(ax, ay, az, nx, ny, nz);
    const i1 = this.vert(bx, by, bz, nx, ny, nz);
    const i2 = this.vert(cx, cy, cz, nx, ny, nz);
    if (flip) this.idx.push(i0, i2, i1);
    else this.idx.push(i0, i1, i2);
  }

  /** A planar quad, corners in ring order, winding fixed up against `n`. */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
  ): void {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const flip = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz < 0;
    const i0 = this.vert(ax, ay, az, nx, ny, nz);
    const i1 = this.vert(bx, by, bz, nx, ny, nz);
    const i2 = this.vert(cx, cy, cz, nx, ny, nz);
    const i3 = this.vert(dx, dy, dz, nx, ny, nz);
    if (flip) this.idx.push(i0, i3, i2, i0, i2, i1);
    else this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  /**
   * `tile` is world metres per UV repeat for the material this will wear.
   * Projection happens in *piece-local* space, which is what we want: every
   * instance is then the same bake, which is the entire point of instancing.
   */
  toGeometry(tile: number, uvOffset: number): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const count = this.pos.length / 3;
    const uv = new Float32Array(count * 2);
    const inv = 1 / tile;
    for (let i = 0; i < count; i++) {
      const x = this.pos[i * 3], y = this.pos[i * 3 + 1], z = this.pos[i * 3 + 2];
      const nx = Math.abs(this.nor[i * 3]);
      const ny = Math.abs(this.nor[i * 3 + 1]);
      const nz = Math.abs(this.nor[i * 3 + 2]);
      let u: number, v: number;
      if (ny >= nx && ny >= nz) { u = x; v = z; }
      else if (nx >= nz) { u = z; v = y; }
      else { u = x; v = y; }
      uv[i * 2] = u * inv + uvOffset;
      uv[i * 2 + 1] = v * inv + uvOffset;
    }
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const _v = new THREE.Vector3();
const _n3 = new THREE.Vector3();

/** Append `src` into `dst` through a rigid transform (rotation + translation). */
function append(dst: Geo, src: Geo, m: THREE.Matrix4): void {
  const base = dst.pos.length / 3;
  for (let i = 0; i < src.pos.length; i += 3) {
    _v.set(src.pos[i], src.pos[i + 1], src.pos[i + 2]).applyMatrix4(m);
    _n3.set(src.nor[i], src.nor[i + 1], src.nor[i + 2]).transformDirection(m);
    dst.pos.push(_v.x, _v.y, _v.z);
    dst.nor.push(_n3.x, _n3.y, _n3.z);
  }
  for (let i = 0; i < src.idx.length; i++) dst.idx.push(src.idx[i] + base);
}

/** Smallest chamfer worth paying 3.7× the triangles for. See `boxTo`. */
const MIN_BEVEL = 0.016;

/** Face mask bits. Dropping a face buried inside another solid is free triangles. */
const F_PX = 1, F_NX = 2, F_PY = 4, F_NY = 8, F_PZ = 16, F_NZ = 32;
const F_ALL = 63;

/**
 * A chamfered box in min/max form: six inset faces, twelve edge chamfers,
 * eight corner triangles.
 *
 * The single highest-value function in this file. A hard 90° arris between two
 * faces of the same material gives one hard value step and reads as folded
 * paper; a 3 cm chamfer catches the key light as a bright sliver along every
 * edge and reads as an object with mass. It is the cheapest AAA tell there is.
 */
function boxTo(
  g: Geo,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  bevel: number,
  mask = F_ALL,
): void {
  const c = [(x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5];
  const h = [(x1 - x0) * 0.5, (y1 - y0) * 0.5, (z1 - z0) * 0.5];
  if (h[0] <= 0 || h[1] <= 0 || h[2] <= 0) return;

  let b = Math.max(0, Math.min(bevel, h[0] * 0.42, h[1] * 0.42, h[2] * 0.42));
  // A chamfer costs 3.7× the triangles of a plain box, so it is spent only
  // where it is visible. The clamp above shrinks it to fit the *thinnest* axis,
  // which means every scrap of trim — a rivet, a batten, a bolt head — asks for
  // a 7 mm chamfer it is far too small to show. 16 mm is the width at which the
  // sliver of key light along an edge survives at arm's length; below it the
  // chamfer is sub-pixel at every distance a build piece is ever read from.
  if (b < MIN_BEVEL) b = 0;

  const bits = [F_PX, F_NX, F_PY, F_NY, F_PZ, F_NZ];
  for (let a = 0; a < 3; a++) {
    for (let si = 0; si < 2; si++) {
      if ((mask & bits[a * 2 + si]) === 0) continue;
      const sgn = si === 0 ? 1 : -1;
      const u = (a + 1) % 3;
      const v = (a + 2) % 3;
      const corners: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      const pts = corners.map(([cu, cv]) => {
        const out = [c[0], c[1], c[2]];
        out[a] = c[a] + sgn * h[a];
        out[u] = c[u] + cu * (h[u] - b);
        out[v] = c[v] + cv * (h[v] - b);
        return out;
      });
      const nrm = [0, 0, 0];
      nrm[a] = sgn;
      g.quad(
        pts[0][0], pts[0][1], pts[0][2],
        pts[1][0], pts[1][1], pts[1][2],
        pts[2][0], pts[2][1], pts[2][2],
        pts[3][0], pts[3][1], pts[3][2],
        nrm[0], nrm[1], nrm[2],
      );
    }
  }
  if (b <= 1e-5) return;

  const p = [0, 0, 0], q = [0, 0, 0], r = [0, 0, 0], s = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    for (let bb = a + 1; bb < 3; bb++) {
      const o = 3 - a - bb;
      for (let sa = -1; sa <= 1; sa += 2) {
        for (let sb = -1; sb <= 1; sb += 2) {
          p[a] = c[a] + sa * h[a];       p[bb] = c[bb] + sb * (h[bb] - b); p[o] = c[o] - (h[o] - b);
          q[a] = c[a] + sa * h[a];       q[bb] = c[bb] + sb * (h[bb] - b); q[o] = c[o] + (h[o] - b);
          r[a] = c[a] + sa * (h[a] - b); r[bb] = c[bb] + sb * h[bb];       r[o] = c[o] + (h[o] - b);
          s[a] = c[a] + sa * (h[a] - b); s[bb] = c[bb] + sb * h[bb];       s[o] = c[o] - (h[o] - b);
          const nrm = [0, 0, 0];
          nrm[a] = sa * Math.SQRT1_2;
          nrm[bb] = sb * Math.SQRT1_2;
          g.quad(
            p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2], s[0], s[1], s[2],
            nrm[0], nrm[1], nrm[2],
          );
        }
      }
    }
  }

  const k = 1 / Math.sqrt(3);
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        g.tri(
          c[0] + sx * h[0], c[1] + sy * (h[1] - b), c[2] + sz * (h[2] - b),
          c[0] + sx * (h[0] - b), c[1] + sy * h[1], c[2] + sz * (h[2] - b),
          c[0] + sx * (h[0] - b), c[1] + sy * (h[1] - b), c[2] + sz * h[2],
          sx * k, sy * k, sz * k,
        );
      }
    }
  }
}

/* ------------------------------------------------------------------------ *
 * The framed slab
 *
 * Wall, floor and ramp are all one shape under three matrices. See the header.
 * Authored in the XY plane: x ∈ [0, w], y ∈ [0, h], thickness straddling z = 0.
 * ------------------------------------------------------------------------ */

/** Perimeter frame width. Reads as a stud at 4 m and as a border at 40 m. */
const FRAME_W = 0.3;
/** Mullion width between edit cells. */
const MULLION_W = 0.17;
/** How far a panel sits back from the frame face. This is where the AO lives. */
const PANEL_INSET = 0.055;

interface SlabCells {
  /** Panel rect for edit cell (col, row), in slab space. */
  x0: number[]; x1: number[]; y0: number[]; y1: number[];
}

/** Precompute the nine panel rects for a w × h slab. */
function slabCells(w: number, h: number): SlabCells {
  const iw = (w - 2 * FRAME_W - 2 * MULLION_W) / 3;
  const ih = (h - 2 * FRAME_W - 2 * MULLION_W) / 3;
  const x0: number[] = [], x1: number[] = [], y0: number[] = [], y1: number[] = [];
  for (let i = 0; i < 3; i++) {
    x0.push(FRAME_W + i * (iw + MULLION_W));
    x1.push(FRAME_W + i * (iw + MULLION_W) + iw);
    y0.push(FRAME_W + i * (ih + MULLION_W));
    y1.push(FRAME_W + i * (ih + MULLION_W) + ih);
  }
  return { x0, x1, y0, y1 };
}

/**
 * Family relief inside one panel rect. This is the "small-scale detail" pass —
 * without it a build piece is a flat colour field with a chamfer around it,
 * which is exactly what a critic screenshots.
 *
 * Wood gets horizontal battens with a visible gap (the studs read edge-on);
 * stone gets two offset courses so the joints stagger between rows like real
 * coursed rubble; metal gets a vertical rib and a rivet line.
 */
function panelRelief(
  g: Geo,
  family: HarvestKind,
  px0: number, py0: number, px1: number, py1: number,
  col: number, row: number,
  /** Panel surface this relief sits on, in slab z. */
  face: number,
  /** +1 for the front face, -1 for the back — relief always grows outward. */
  dir: number,
  tier: BuildTier,
): void {
  if (tier.detail === 0) return;
  const w = px1 - px0;
  const h = py1 - py0;
  if (w < 0.2 || h < 0.2) return;

  /**
   * Emit a slab of relief between `lo` and `hi` metres out from the panel
   * surface, on whichever face we were handed. Sorting the two z values here
   * rather than at every call site is what lets the three families below be
   * written once and mirrored for free — and `boxTo` rejects an inside-out box
   * silently, which would have made a back face with no relief on it very hard
   * to spot.
   */
  const rel = (
    x0: number, y0: number, x1: number, y1: number,
    lo: number, hi: number, bevel: number,
  ) => {
    const a = face + dir * lo;
    const b = face + dir * hi;
    boxTo(g, x0, y0, Math.min(a, b), x1, y1, Math.max(a, b), bevel);
  };

  // Relief never rises past the frame plane, so a piece stays inside its own
  // 0.25 m thickness and can never poke through the wall stacked behind it.
  const OUT = PANEL_INSET * 0.62;
  const bands = tier.detail === 2 ? 2 : 1;

  if (family === "wood") {
    // Battens run across the plank grain, which is what a real board-and-batten
    // panel does and what makes the wall read as *built* rather than moulded.
    for (let i = 0; i < bands; i++) {
      const cy = py0 + h * ((i + 0.5) / bands);
      const t = Math.min(0.075, h * 0.16);
      rel(px0 + 0.02, cy - t, px1 - 0.02, cy + t, 0, OUT, 0.01);
    }
    if (tier.detail === 2) {
      // A single bolt head per panel, alternating corner, so no two adjacent
      // cells carry the same silhouette.
      const bx = (col + row) % 2 === 0 ? px0 + 0.11 : px1 - 0.11;
      const by = row === 2 ? py1 - 0.11 : py0 + 0.11;
      rel(bx - 0.045, by - 0.045, bx + 0.045, by + 0.045, 0, OUT + 0.012, 0.012);
    }
    return;
  }

  if (family === "stone") {
    // Two courses per cell. Only the upper one is split, and the split walks
    // with the row — that stagger is what sells "coursed rubble" rather than
    // "chequerboard", and doing it with three boxes instead of six is the
    // difference between a stone wall and a stone wall you cannot afford.
    for (let i = 0; i < 2; i++) {
      const cy0 = py0 + (h * i) / 2 + 0.018;
      const cy1 = py0 + (h * (i + 1)) / 2 - 0.018;
      if ((i + row) % 2 === 0) {
        rel(px0 + 0.018, cy0, px1 - 0.018, cy1, 0, OUT, 0.012);
      } else {
        const split = px0 + w * (row % 2 === 0 ? 0.42 : 0.6);
        rel(px0 + 0.018, cy0, split - 0.022, cy1, 0, OUT, 0.012);
        rel(split + 0.022, cy0, px1 - 0.018, cy1, 0, OUT, 0.012);
      }
    }
    return;
  }

  // Metal: a pressed vertical rib down the middle plus a rivet line along it.
  // The rib is the stiffener you would actually press into a steel panel, and
  // it is what catches a moving specular streak as the sun crosses the sky.
  const rx = (px0 + px1) * 0.5;
  rel(rx - 0.055, py0 + 0.03, rx + 0.055, py1 - 0.03, 0, OUT, 0.015);
  if (tier.detail === 2) {
    for (let i = 0; i < 2; i++) {
      const ry = py0 + h * (0.26 + 0.48 * i);
      rel(rx - 0.032, ry - 0.032, rx + 0.032, ry + 0.032, OUT - 0.004, OUT + 0.026, 0.014);
    }
  }
}

/**
 * Build one masked framed slab.
 *
 * `plain` drops the chamfer and all relief — used for the placement ghost and
 * the edit highlight, which are hologram overlays where an extra 700 triangles
 * buys nothing and a clean `EdgesGeometry` silhouette buys everything.
 */
function slabGeo(
  w: number,
  h: number,
  mask: number,
  family: HarvestKind,
  tier: BuildTier,
  plain: boolean,
): Geo {
  const g = new Geo();
  const bevel = plain ? 0 : tier.bevel;
  const detailTier: BuildTier = plain ? { ...tier, bevel: 0, detail: 0 } : tier;
  const cells = slabCells(w, h);
  const zF = HALF_T;   // front face
  const zB = -HALF_T;  // back face

  // --- perimeter frame ----------------------------------------------------
  // Full thickness, so the frame is what a bullet, a shoulder and the key light
  // all meet first. The two side rails are shortened so the corners are single
  // solids rather than four boxes fighting over the same volume — overlapping
  // chamfers at a corner produce z-fighting slivers that sparkle when you move.
  boxTo(g, 0, 0, zB, w, FRAME_W, zF, bevel);
  boxTo(g, 0, h - FRAME_W, zB, w, h, zF, bevel);
  boxTo(g, 0, FRAME_W, zB, FRAME_W, h - FRAME_W, zF, bevel);
  boxTo(g, w - FRAME_W, FRAME_W, zB, w, h - FRAME_W, zF, bevel);

  // A shallow lip proud of the frame on both faces. One extra shadow line all
  // the way round the piece, which is what stops a wall reading as a slab of
  // colour when you are stood right against it.
  if (!plain && tier.detail > 0) {
    const lip = 0.055;
    boxTo(g, 0.04, 0.04, zF, w - 0.04, FRAME_W - 0.05, zF + lip, bevel * 0.6);
    boxTo(g, 0.04, h - FRAME_W + 0.05, zF, w - 0.04, h - 0.04, zF + lip, bevel * 0.6);
    boxTo(g, 0.04, 0.04, zB - lip, w - 0.04, FRAME_W - 0.05, zB, bevel * 0.6);
    boxTo(g, 0.04, h - FRAME_W + 0.05, zB - lip, w - 0.04, h - 0.04, zB, bevel * 0.6);
  }

  // --- mullions -----------------------------------------------------------
  // Emitted only where an adjacent cell is solid, so carving a doorway leaves
  // a real door frame instead of a bar across the opening. Contiguous runs are
  // merged before emitting: an unedited wall is 2 + 2 boxes, not 6 + 6.
  for (let k = 0; k < 2; k++) {
    const mx0 = cells.x1[k];
    const mx1 = cells.x0[k + 1];
    let run = -1;
    for (let row = 0; row <= 3; row++) {
      const need = row < 3 && (maskHas(mask, k, row) || maskHas(mask, k + 1, row));
      if (need && run < 0) run = row;
      else if (!need && run >= 0) {
        boxTo(g, mx0, cells.y0[run] - MULLION_W, zB, mx1, cells.y1[row - 1] + MULLION_W, zF, bevel);
        run = -1;
      }
    }
  }
  for (let k = 0; k < 2; k++) {
    const my0 = cells.y1[k];
    const my1 = cells.y0[k + 1];
    let run = -1;
    for (let col = 0; col <= 3; col++) {
      const need = col < 3 && (maskHas(mask, col, k) || maskHas(mask, col, k + 1));
      if (need && run < 0) run = col;
      else if (!need && run >= 0) {
        boxTo(g, cells.x0[run] - MULLION_W, my0, zB, cells.x1[col - 1] + MULLION_W, my1, zF, bevel);
        run = -1;
      }
    }
  }

  // --- panels -------------------------------------------------------------
  // Recessed on both faces. The recess is a real 5.5 cm step, so it casts a
  // real contact shadow into the frame rather than faking one with an AO map.
  //
  // The nine cells are merged into maximal rectangles first. That is free
  // visually — the mullions sit at full thickness *in front* of the recess, so
  // they still draw the grooves between cells whether the material behind them
  // is one box or nine — and an unedited wall drops from nine chamfered boxes
  // to one, which is 350 triangles per piece across a whole build fight.
  for (const [c0, r0, c1, r1] of maskRects(mask)) {
    boxTo(
      g,
      cells.x0[c0], cells.y0[r0], zB + PANEL_INSET,
      cells.x1[c1], cells.y1[r1], zF - PANEL_INSET,
      bevel,
    );
  }
  // Relief stays per cell — it is what gives the wall its rhythm, and merging
  // it would give one wall-sized batten instead of nine panel-sized ones.
  // Both faces get it: you place a wall and then run round it, and a piece
  // detailed on one side and blank on the other is worse than one blank on both.
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      if (!maskHas(mask, col, row)) continue;
      const px0 = cells.x0[col], px1 = cells.x1[col];
      const py0 = cells.y0[row], py1 = cells.y1[row];
      panelRelief(g, family, px0, py0, px1, py1, col, row, zF - PANEL_INSET, 1, detailTier);
      panelRelief(g, family, px0, py0, px1, py1, col, row, zB + PANEL_INSET, -1, detailTier);
    }
  }

  // --- corner trim --------------------------------------------------------
  // Family-specific wear at the contact points, which is where a real structure
  // is reinforced and where a fake one gives itself away by having nothing.
  if (!plain && tier.detail === 2) {
    const corners: Array<[number, number]> = [
      [FRAME_W * 0.5, FRAME_W * 0.5],
      [w - FRAME_W * 0.5, FRAME_W * 0.5],
      [FRAME_W * 0.5, h - FRAME_W * 0.5],
      [w - FRAME_W * 0.5, h - FRAME_W * 0.5],
    ];
    for (let i = 0; i < corners.length; i++) {
      const [cx, cy] = corners[i];
      if (family === "wood") {
        // Gusset plate — a flat strap bolted across the joint.
        boxTo(g, cx - 0.12, cy - 0.12, zF, cx + 0.12, cy + 0.12, zF + 0.035, 0.014);
        boxTo(g, cx - 0.12, cy - 0.12, zB - 0.035, cx + 0.12, cy + 0.12, zB, 0.014);
      } else if (family === "stone") {
        // Quoin — an oversized dressed corner block, proud of the frame.
        boxTo(g, cx - 0.15, cy - 0.15, zB - 0.03, cx + 0.15, cy + 0.15, zF + 0.03, tier.bevel * 1.6);
      } else {
        boxTo(g, cx - 0.055, cy - 0.055, zF, cx + 0.055, cy + 0.055, zF + 0.03, 0.016);
        boxTo(g, cx - 0.055, cy - 0.055, zB - 0.03, cx + 0.055, cy + 0.055, zB, 0.016);
      }
    }
  }

  return g;
}

/**
 * The cone (Fortnite's pyramid/roof piece). Not a slab — four trapezoidal
 * faces rising to a small flat cap, on a base ring, with hip battens down the
 * four diagonals.
 *
 * Truncated rather than pointed on purpose: a true apex is a degenerate vertex
 * where four normals meet, it shades badly, and a small cap plate reads as a
 * finished ridge instead of a mistake.
 */
function coneGeo(family: HarvestKind, tier: BuildTier, plain: boolean): Geo {
  const g = new Geo();
  const bevel = plain ? 0 : tier.bevel;
  const S = GRID;
  const mid = S * 0.5;
  /** Height of the flat cap. Just under a full cell so it tucks under a floor. */
  const apexY = S * 0.92;
  /** Half-width of the cap plate. */
  const capR = 0.36;
  /** Height of the base kerb the four faces spring from. */
  const ringH = 0.34;
  /** Slab thickness of each sloped face. */
  const t = WALL_THICKNESS * 0.72;

  // Base ring: a full-thickness kerb around the cell footprint. It is what the
  // cone actually stands on, what a player's feet register at the edge, and
  // what gives the silhouette a hard bottom line instead of a feathered one.
  boxTo(g, 0, 0, 0, S, ringH, WALL_THICKNESS, bevel);
  boxTo(g, 0, 0, S - WALL_THICKNESS, S, ringH, S, bevel);
  boxTo(g, 0, 0, WALL_THICKNESS, WALL_THICKNESS, ringH, S - WALL_THICKNESS, bevel);
  boxTo(g, S - WALL_THICKNESS, 0, WALL_THICKNESS, S, ringH, S - WALL_THICKNESS, bevel);

  /**
   * The four base edges, listed anticlockwise seen from above so that
   * `edge × up` points outward on every one of them without a special case.
   */
  const edges: Array<[number, number, number, number]> = [
    [0, 0, S, 0], // north
    [S, 0, S, S], // east
    [S, S, 0, S], // south
    [0, S, 0, 0], // west
  ];

  for (let f = 0; f < 4; f++) {
    const [ax, az, bx, bz] = edges[f];
    // Top edge: the base edge scaled in toward the centre at cap height.
    const k = capR / mid;
    const tax = mid + (ax - mid) * k, taz = mid + (az - mid) * k;
    const tbx = mid + (bx - mid) * k, tbz = mid + (bz - mid) * k;

    // Face normal: (base edge) × (rake). Both live in the face, so the cross
    // product is exactly perpendicular to it; the winding fix in `Geo.quad`
    // then guarantees the triangles face the way we say they do.
    //   e = (ex, 0, ez)  the base edge
    //   r = (rx, ry, rz)  the rake, base corner up to cap corner
    //   n = e × r = ( -ez·ry , ez·rx - ex·rz , ex·ry )
    const ex = bx - ax, ez = bz - az;
    const rx = tax - ax, ry = apexY - ringH, rz = taz - az;
    let nx = -ez * ry;
    let ny = ez * rx - ex * rz;
    let nz2 = ex * ry;
    const nl = Math.hypot(nx, ny, nz2) || 1;
    nx /= nl; ny /= nl; nz2 /= nl;
    const ox = nx * t, oy = ny * t, oz = nz2 * t;

    // Outer skin.
    g.quad(
      ax + ox, ringH + oy, az + oz,
      bx + ox, ringH + oy, bz + oz,
      tbx + ox, apexY + oy, tbz + oz,
      tax + ox, apexY + oy, taz + oz,
      nx, ny, nz2,
    );
    // Under-side. A single-sided pyramid shell is the classic cheap tell —
    // you see straight through it the moment you stand underneath one.
    g.quad(
      ax, ringH, az,
      bx, ringH, bz,
      tbx, apexY, tbz,
      tax, apexY, taz,
      -nx, -ny, -nz2,
    );
    // Eaves rim, where the slab meets the kerb. This is the shadow line that
    // makes the roof read as a thing with thickness from 40 m away.
    g.quad(
      ax, ringH, az,
      bx, ringH, bz,
      bx + ox, ringH + oy, bz + oz,
      ax + ox, ringH + oy, az + oz,
      0, -1, 0,
    );
    // Ridge rim, under the cap plate.
    g.quad(
      tax, apexY, taz,
      tbx, apexY, tbz,
      tbx + ox, apexY + oy, tbz + oz,
      tax + ox, apexY + oy, taz + oz,
      0, 1, 0,
    );

    if (!plain && tier.detail > 0) {
      // Hip batten up the corner where this face meets the next, sitting proud
      // of the skin. It is the single detail that makes a pyramid read as a
      // roof rather than as a cone primitive, and it costs two triangles.
      const hx = ax - mid, hz = az - mid;
      const hl = Math.hypot(hx, hz) || 1;
      const wx = (-hz / hl) * 0.1, wz = (hx / hl) * 0.1;
      const p = 0.05; // proud of the skin
      g.quad(
        ax + wx + nx * (t + p), ringH + ny * (t + p), az + wz + nz2 * (t + p),
        ax - wx + nx * (t + p), ringH + ny * (t + p), az - wz + nz2 * (t + p),
        tax - wx * 0.45 + nx * (t + p), apexY + ny * (t + p), taz - wz * 0.45 + nz2 * (t + p),
        tax + wx * 0.45 + nx * (t + p), apexY + ny * (t + p), taz + wz * 0.45 + nz2 * (t + p),
        nx, ny, nz2,
      );
      // Two courses of family relief banded across the face, so the slope is
      // not one unbroken field of albedo.
      if (family !== "wood" || tier.detail === 2) {
        for (let i = 1; i <= 2; i++) {
          const u = i / 3;
          const l0x = ax + (tax - ax) * u, l0z = az + (taz - az) * u;
          const l1x = bx + (tbx - bx) * u, l1z = bz + (tbz - bz) * u;
          const ly = ringH + (apexY - ringH) * u;
          const b0 = 0.055;
          g.quad(
            l0x + nx * (t + b0), ly + ny * (t + b0), l0z + nz2 * (t + b0),
            l1x + nx * (t + b0), ly + ny * (t + b0), l1z + nz2 * (t + b0),
            l1x + nx * t, ly - 0.09 + ny * t, l1z + nz2 * t,
            l0x + nx * t, ly - 0.09 + ny * t, l0z + nz2 * t,
            nx, ny, nz2,
          );
        }
      }
    }
  }

  // Cap plate, oversized so it overhangs the four ridges and throws a thin
  // shadow onto them — exactly what the ridge cap on a real hip roof does.
  boxTo(
    g,
    mid - capR - 0.08, apexY - 0.03, mid - capR - 0.08,
    mid + capR + 0.08, apexY + 0.14, mid + capR + 0.08,
    bevel,
  );

  return g;
}

/* ------------------------------------------------------------------------ *
 * Piece geometry, keyed and cached
 * ------------------------------------------------------------------------ */

/** Slab dimensions per kind, in slab space. */
const SLAB_W = GRID;
/** A ramp's slab spans the hypotenuse of the 4 × 4 cell it climbs. */
const RAMP_LEN = Math.SQRT2 * GRID;

/**
 * Maps slab space (x right, y up, z out of the face) into cell-local space for
 * each kind. Cell-local space has its origin at the cell's minimum corner, so
 * every piece's geometry has y ∈ [-0.25, 4] — which is exactly what the shader
 * needs to drive the ground-grime gradient and the build sweep off `position.y`
 * with no extra uniforms.
 */
function faceMatrix(kind: BuildKind): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (kind === "wall") {
    // Wall: the slab plane already *is* the wall plane, sitting on the cell's
    // north edge (z = 0) and spanning x ∈ [0, 4].
    return m.identity();
  }
  if (kind === "floor") {
    // Rotate the slab flat and drop it so its top face lands exactly on the
    // grid plane — you stand on a floor's top, and a floor whose surface is
    // half a thickness off the lattice makes every stacked build wrong.
    return m.makeTranslation(0, -HALF_T, 0).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  }
  if (kind === "ramp") {
    // Rise from the cell's south edge (z = 4, y = 0) to its north edge
    // (z = 0, y = 4). -45° about X puts slab +y along that climb; the extra
    // -HALF_T along slab z puts the *walking surface* on the incline rather
    // than the slab's centre plane.
    return m
      .makeTranslation(0, 0, GRID)
      .multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 4))
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, -HALF_T));
  }
  return m.identity();
}

const FACE_MATRIX: Record<BuildKind, THREE.Matrix4> = {
  wall: faceMatrix("wall"),
  floor: faceMatrix("floor"),
  ramp: faceMatrix("ramp"),
  cone: faceMatrix("cone"),
};

const SLAB_H: Record<BuildKind, number> = {
  wall: GRID,
  floor: GRID,
  ramp: RAMP_LEN,
  cone: GRID,
};

/** Build the cell-local geometry soup for one (kind, mask, family). */
function pieceGeo(kind: BuildKind, mask: number, family: HarvestKind, tier: BuildTier, plain: boolean): Geo {
  if (kind === "cone") return coneGeo(family, tier, plain);
  const slab = slabGeo(SLAB_W, SLAB_H[kind], mask, family, tier, plain);
  const out = new Geo();
  append(out, slab, FACE_MATRIX[kind]);
  if (kind === "ramp" && !plain && tier.detail > 0) {
    // Nosing lips across the climb. They break the plank surface into treads,
    // which is both a strong readability cue at range ("that is a ramp, I can
    // climb it") and the thing that hides the ±0.15 m staircase quantisation
    // of the collider underneath. See BuildTier.rampSteps.
    const steps = 4;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const y = GRID * t;
      const z = GRID * (1 - t);
      const lip = new Geo();
      boxTo(lip, 0.16, y + 0.02, z - 0.075, GRID - 0.16, y + 0.105, z + 0.075, tier.bevel * 0.7);
      append(out, lip, new THREE.Matrix4());
    }
    // Side stringers: the beams a real ramp would be carried on. Without them
    // the ramp is a floating plank and its silhouette from the side is a line.
    for (let s = 0; s < 2; s++) {
      const x = s === 0 ? 0 : GRID - 0.22;
      const st = new Geo();
      // A stepped stringer approximates the raking beam without a custom prism.
      // Deliberately unchamfered: eight of these ride under every ramp in the
      // game, and their edges are in shadow under the deck where a chamfer
      // would never catch the key light anyway.
      for (let i = 0; i < 4; i++) {
        const t0 = i / 4, t1 = (i + 1) / 4;
        boxTo(
          st,
          x, GRID * t0 - 0.34, GRID * (1 - t1),
          x + 0.22, GRID * t1 + 0.02, GRID * (1 - t0),
          0,
        );
      }
      append(out, st, new THREE.Matrix4());
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Placement lattice
 * ------------------------------------------------------------------------ */

/**
 * Where a piece sits, in integer lattice coordinates.
 *
 * For `wall`, (a, b, c) is a *grid line*, not a cell: `rot` 0 means the wall
 * runs along X at z = c·GRID, `rot` 1 means it runs along Z at x = a·GRID.
 * Canonicalising walls onto edges rather than onto "the north face of cell N"
 * is what stops two players (or one player and their own preview) putting two
 * coincident walls on opposite sides of the same seam.
 *
 * For `floor` / `ramp` / `cone`, (a, b, c) is the cell and `rot` is the quarter
 * turn about its centre.
 */
interface Loc {
  kind: BuildKind;
  a: number;
  b: number;
  c: number;
  rot: number;
}

/**
 * Slot identity. Floor / ramp / cone deliberately ignore rotation: one cell
 * holds at most one of each, whichever way round it is turned. Walls key on
 * their axis because a cell corner legitimately carries two.
 */
function locKey(l: Loc): string {
  const r = l.kind === "wall" ? l.rot & 1 : 0;
  return `${l.kind}|${l.a}|${l.b}|${l.c}|${r}`;
}

/**
 * The four quarter turns about the cell centre, and the wall's single axis
 * flip, baked once. `locMatrix` runs on every preview frame and once per
 * animating piece per fixed step; building three fresh Matrix4s each time is
 * garbage churn on the hottest path this module has.
 */
const QUARTER_TURN: THREE.Matrix4[] = [0, 1, 2, 3].map((r) => {
  const half = GRID * 0.5;
  return new THREE.Matrix4()
    .makeTranslation(half, 0, half)
    .multiply(new THREE.Matrix4().makeRotationY((-r * Math.PI) / 2))
    .multiply(new THREE.Matrix4().makeTranslation(-half, 0, -half));
});
const WALL_AXIS_Z = new THREE.Matrix4().makeRotationY(-Math.PI / 2);

/** Cell-local → world transform for a placement. */
function locMatrix(l: Loc, out: THREE.Matrix4): THREE.Matrix4 {
  out.makeTranslation(l.a * GRID, l.b * GRID, l.c * GRID);
  if (l.kind === "wall") {
    // Axis 1 rotates the authored wall (along +X at z = 0) a quarter turn about
    // the cell's own corner so it runs along +Z at x = 0.
    if ((l.rot & 1) === 1) out.multiply(WALL_AXIS_Z);
    return out;
  }
  return out.multiply(QUARTER_TURN[l.rot & 3]);
}

/**
 * Greedy maximal rectangles over a 3 × 3 mask. Turns a nine-cell edit into the
 * one to three boxes the broadphase actually needs — an unedited wall is a
 * single collider, and a doorway is three.
 */
function maskRects(mask: number): Array<[number, number, number, number]> {
  const used = [false, false, false, false, false, false, false, false, false];
  const out: Array<[number, number, number, number]> = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      if (used[row * 3 + col] || !maskHas(mask, col, row)) continue;
      let c1 = col;
      while (c1 + 1 < 3 && maskHas(mask, c1 + 1, row) && !used[row * 3 + c1 + 1]) c1++;
      let r1 = row;
      grow: while (r1 + 1 < 3) {
        for (let cc = col; cc <= c1; cc++) {
          if (!maskHas(mask, cc, r1 + 1) || used[(r1 + 1) * 3 + cc]) break grow;
        }
        r1++;
      }
      for (let rr = row; rr <= r1; rr++) for (let cc = col; cc <= c1; cc++) used[rr * 3 + cc] = true;
      out.push([col, row, c1, r1]);
    }
  }
  return out;
}

const _m4 = new THREE.Matrix4();
/** Separate from `_m4`: `colliderBoxes` and `pieceBox` are called back to back. */
const _colM = new THREE.Matrix4();

/**
 * World-space collider boxes for a placement.
 *
 * Walls and floors follow their edit mask exactly, so a doorway is a hole you
 * can walk through and a floor hatch is a hole you can fall down. Ramps get a
 * staircase (an AABB broadphase cannot hold a 45° plane) and cones get a
 * stepped pyramid; both are hidden under a smooth visual surface.
 */
function colliderBoxes(l: Loc, mask: number, tier: BuildTier): THREE.Box3[] {
  const m = locMatrix(l, _colM);
  const out: THREE.Box3[] = [];

  if (l.kind === "wall" || l.kind === "floor") {
    const w = SLAB_W;
    const h = SLAB_H[l.kind];
    const cells = slabCells(w, h);
    const face = FACE_MATRIX[l.kind];
    for (const [c0, r0, c1, r1] of maskRects(mask)) {
      // Snap the rect out to the frame/mullion midlines so adjacent rects
      // butt cleanly and there is no 2 cm slot between two solid cells for a
      // sprinting capsule's continuous-collision sweep to squeeze into.
      const x0 = c0 === 0 ? 0 : cells.x0[c0] - MULLION_W * 0.5;
      const x1 = c1 === 2 ? w : cells.x1[c1] + MULLION_W * 0.5;
      const y0 = r0 === 0 ? 0 : cells.y0[r0] - MULLION_W * 0.5;
      const y1 = r1 === 2 ? h : cells.y1[r1] + MULLION_W * 0.5;
      const b = new THREE.Box3(
        new THREE.Vector3(x0, y0, -HALF_T),
        new THREE.Vector3(x1, y1, HALF_T),
      );
      b.applyMatrix4(face);
      b.applyMatrix4(m);
      out.push(b);
    }
    return out;
  }

  if (l.kind === "ramp") {
    const steps = tier.rampSteps;
    for (let i = 0; i < steps; i++) {
      const z1 = GRID * (1 - i / steps);
      const z0 = GRID * (1 - (i + 1) / steps);
      // Top of the step sits at 62 % of the way up its own span rather than at
      // the midpoint. Erring high leaves the player a few centimetres *above*
      // the plank, which is invisible; erring low sinks their feet into it,
      // which is not.
      const top = GRID * ((i + 0.62) / steps);
      const b = new THREE.Box3(
        new THREE.Vector3(0, -HALF_T, z0),
        new THREE.Vector3(GRID, top, z1),
      );
      b.applyMatrix4(m);
      out.push(b);
    }
    return out;
  }

  // Cone: four shrinking slabs. Standing on a cone should be possible but
  // awkward, which four terraces gets exactly right.
  const levels = 4;
  for (let i = 0; i < levels; i++) {
    const t0 = i / levels;
    const t1 = (i + 1) / levels;
    const inset = GRID * 0.5 * t0 * 0.86;
    const b = new THREE.Box3(
      new THREE.Vector3(inset, GRID * t0 * 0.92, inset),
      new THREE.Vector3(GRID - inset, GRID * t1 * 0.92, GRID - inset),
    );
    b.applyMatrix4(m);
    out.push(b);
  }
  return out;
}

/** Overall world AABB of a placement — what `BuildPiece.box` reports. */
function pieceBox(l: Loc, out: THREE.Box3): THREE.Box3 {
  const m = locMatrix(l, _m4);
  if (l.kind === "wall") {
    out.min.set(0, 0, -HALF_T);
    out.max.set(GRID, GRID, HALF_T);
  } else if (l.kind === "floor") {
    out.min.set(0, -WALL_THICKNESS, 0);
    out.max.set(GRID, 0, GRID);
  } else {
    // Ramps hang their stringers a little below the cell floor and overshoot
    // the far edge by the thickness of the slab; cones overhang at the cap.
    // The margin matters because this box is what `vfx.buildBreak` fills with
    // debris, and debris that starts inside the piece looks like it spawned.
    out.min.set(-0.05, -0.45, -0.3);
    out.max.set(GRID + 0.05, GRID + 0.2, GRID + 0.05);
  }
  return out.applyMatrix4(m);
}

/**
 * The lattice nodes a placement claims. Two pieces are connected — for the
 * purposes of structural integrity — exactly when they share one.
 *
 * Ramps and cones claim all eight corners of their cell rather than only the
 * four their geometry genuinely touches. That is deliberate over-connection:
 * Fortnite is forgiving about what holds a ramp up, and a build game whose
 * towers fall down for reasons the player cannot see is a build game nobody
 * builds in.
 */
function locNodes(l: Loc, into: string[]): void {
  into.length = 0;
  const { a, b, c } = l;
  if (l.kind === "wall") {
    if ((l.rot & 1) === 0) {
      into.push(`${a},${b},${c}`, `${a + 1},${b},${c}`, `${a},${b + 1},${c}`, `${a + 1},${b + 1},${c}`);
    } else {
      into.push(`${a},${b},${c}`, `${a},${b},${c + 1}`, `${a},${b + 1},${c}`, `${a},${b + 1},${c + 1}`);
    }
    return;
  }
  if (l.kind === "floor") {
    into.push(`${a},${b},${c}`, `${a + 1},${b},${c}`, `${a},${b},${c + 1}`, `${a + 1},${b},${c + 1}`);
    return;
  }
  for (let dy = 0; dy <= 1; dy++) {
    for (let dz = 0; dz <= 1; dz++) {
      for (let dx = 0; dx <= 1; dx++) into.push(`${a + dx},${b + dy},${c + dz}`);
    }
  }
}

/* ------------------------------------------------------------------------ *
 * The piece record
 * ------------------------------------------------------------------------ */

interface Piece extends BuildPiece {
  loc: Loc;
  /** 3 × 3 edit mask. MASK_FULL until someone edits it. */
  mask: number;
  /** Seconds since placement, capped at BUILD_TIME. */
  age: number;
  /** Hit flash, 0..1, decays. Rides the same attribute as build progress. */
  flash: number;
  /** Total damage taken. `hp` is derived from this — see `curveHp`. */
  damage: number;
  /** Lattice nodes this piece claims. */
  nodes: string[];
  /** True when the terrain or the static world holds this piece up directly. */
  anchored: boolean;
  /** Set once a collapse is scheduled, so it cannot be scheduled twice. */
  falling: boolean;
  fallAt: number;
  removers: Array<() => void>;
  batch: Batch | null;
  index: number;
  /** Per-instance albedo tint and roughness multiplier. */
  tint: THREE.Color;
  rough: number;
  /** Cached world matrix, so the growth animation does not rebuild it. */
  matrix: THREE.Matrix4;
  /** Monotonic placement order, for MAX_PIECES retirement. */
  serial: number;
}

/* ------------------------------------------------------------------------ *
 * Instanced batches
 * ------------------------------------------------------------------------ */

/**
 * Per-instance data the shader reads. Four attributes rather than three so
 * roughness can ride along in `aDzTint.w` — uniform roughness across a wall of
 * fifty identical panels is the loudest "this is a Three.js demo" tell there
 * is, and it costs one float to kill.
 */
const ATTR_TINT = "aDzTint";
const ATTR_BUILD = "aDzBuild";
const ATTR_WEAR = "aDzWear";

/** Instances a batch starts with. Doubles on demand up to BATCH_MAX. */
const BATCH_START = 64;
const BATCH_MAX = 1024;

/** Scratch for the build-up growth transform. See `Batch.write`. */
const _growM = new THREE.Matrix4();
const _growScale = new THREE.Matrix4();

class Batch {
  mesh: THREE.InstancedMesh;
  readonly pieces: Piece[] = [];
  private capacity: number;
  private tintAttr!: THREE.InstancedBufferAttribute;
  private buildAttr!: THREE.InstancedBufferAttribute;
  private wearAttr!: THREE.InstancedBufferAttribute;
  /** Set when the instance count changed; the bounding sphere is refit lazily. */
  private boundsDirty = true;

  constructor(
    readonly key: string,
    private geometry: THREE.BufferGeometry,
    private material: THREE.Material,
    private parent: THREE.Object3D,
    private castShadow: boolean,
  ) {
    this.capacity = BATCH_START;
    this.mesh = this.makeMesh(this.capacity);
    parent.add(this.mesh);
  }

  private makeMesh(capacity: number): THREE.InstancedMesh {
    // Attributes live on the geometry, so a resized batch needs a fresh
    // geometry *view*. Cloning shares nothing dangerous — three copies the
    // attribute arrays — and the source geometry stays the cache's to own.
    const geo = this.geometry.clone();
    this.tintAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.buildAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.wearAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.tintAttr.setUsage(THREE.DynamicDrawUsage);
    this.buildAttr.setUsage(THREE.DynamicDrawUsage);
    this.wearAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(ATTR_TINT, this.tintAttr);
    geo.setAttribute(ATTR_BUILD, this.buildAttr);
    geo.setAttribute(ATTR_WEAR, this.wearAttr);

    const mesh = new THREE.InstancedMesh(geo, this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.castShadow = this.castShadow;
    mesh.receiveShadow = true;
    mesh.name = `build:${this.key}`;
    // Built structures are the one thing in the world that must never pop out
    // of the frustum early — a wall you are hiding behind that vanishes when
    // you look 5° away is unforgiving in a way nothing else here is. The refit
    // below keeps the sphere honest instead.
    mesh.frustumCulled = true;
    return mesh;
  }

  private grow(): void {
    const next = Math.min(BATCH_MAX, this.capacity * 2);
    if (next === this.capacity) return;
    const old = this.mesh;
    this.capacity = next;
    this.mesh = this.makeMesh(next);
    this.parent.add(this.mesh);
    for (let i = 0; i < this.pieces.length; i++) this.write(i);
    this.mesh.count = this.pieces.length;
    old.removeFromParent();
    old.geometry.dispose();
    this.boundsDirty = true;
  }

  get full(): boolean {
    return this.pieces.length >= BATCH_MAX;
  }

  add(p: Piece): void {
    if (this.pieces.length >= this.capacity) this.grow();
    if (this.pieces.length >= this.capacity) return;
    p.batch = this;
    p.index = this.pieces.length;
    this.pieces.push(p);
    this.write(p.index);
    this.mesh.count = this.pieces.length;
    this.boundsDirty = true;
  }

  remove(p: Piece): void {
    if (p.batch !== this) return;
    const i = p.index;
    const last = this.pieces.length - 1;
    if (i !== last) {
      const moved = this.pieces[last];
      this.pieces[i] = moved;
      moved.index = i;
      this.write(i);
    }
    this.pieces.pop();
    this.mesh.count = this.pieces.length;
    p.batch = null;
    p.index = -1;
    this.boundsDirty = true;
  }

  /**
   * Push one piece's transform and per-instance data into the buffers.
   *
   * The build-up growth is applied HERE, on the way to the GPU, and never
   * written back into `Piece.matrix`. That matrix is the piece's *logical*
   * placement and half a dozen things read it as ground truth — the edit-cell
   * picker, the edit overlay, the outline. Letting a 0.4 s animation scale it
   * meant aiming at a doorway cell on a wall you had just placed picked the
   * wrong cell, or no cell at all.
   *
   * Growth is on the instance matrix rather than in the vertex shader so the
   * shadow the piece casts grows with it — a full-size shadow under a piece
   * that is 20 % built is the kind of thing you cannot unsee.
   */
  write(i: number): void {
    const p = this.pieces[i];
    if (!p) return;
    const g = clamp01(p.age / BUILD_TIME / GROW_FRACTION);
    if (g < 1) {
      const ease = 1 - (1 - g) * (1 - g);
      _growScale.makeScale(0.9 + 0.1 * ease, Math.max(0.02, ease), 0.9 + 0.1 * ease);
      _growM.multiplyMatrices(p.matrix, _growScale);
      this.mesh.setMatrixAt(i, _growM);
    } else {
      this.mesh.setMatrixAt(i, p.matrix);
    }
    const t = i * 4;
    this.tintAttr.array[t] = p.tint.r;
    this.tintAttr.array[t + 1] = p.tint.g;
    this.tintAttr.array[t + 2] = p.tint.b;
    this.tintAttr.array[t + 3] = p.rough;
    // Build progress carries the hit flash above 1.0 — see the shader patch.
    const progress = clamp01(p.age / BUILD_TIME);
    this.buildAttr.array[i] = progress + p.flash;
    this.wearAttr.array[i] = clamp01((1 - p.hp / p.maxHp - 0.12) / 0.88);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.tintAttr.needsUpdate = true;
    this.buildAttr.needsUpdate = true;
    this.wearAttr.needsUpdate = true;
  }

  refitBounds(): void {
    if (!this.boundsDirty) return;
    this.boundsDirty = false;
    if (this.pieces.length === 0) return;
    this.mesh.computeBoundingSphere();
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.pieces.length = 0;
  }
}

/* ------------------------------------------------------------------------ *
 * The shader patch
 *
 * One patch, applied to the three family materials. Everything it adds is
 * per-instance and free at rest:
 *
 *   · albedo tint + roughness jitter, so no two panels are the same surface;
 *   · a grime gradient up from the piece's own base, because every structure
 *     in the world is dirtiest where it meets the ground and a build that is
 *     uniformly clean floats;
 *   · the build-up sweep — a bright band that climbs the piece over 0.4 s and
 *     leaves behind finished material;
 *   · a hit flash and a char-and-crack darkening driven by remaining HP, so
 *     you can read a wall's health across a room without a health bar.
 * ------------------------------------------------------------------------ */

function patchBuildMaterial(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        attribute vec4 ${ATTR_TINT};
        attribute float ${ATTR_BUILD};
        attribute float ${ATTR_WEAR};
        varying vec4 vDzTint;
        varying float vDzBuild;
        varying float vDzWear;
        varying float vDzLocalY;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        vDzTint = ${ATTR_TINT};
        vDzBuild = ${ATTR_BUILD};
        vDzWear = ${ATTR_WEAR};
        // Piece-local height in metres. Every piece is authored with its base
        // at y = 0 in cell space, so this is directly usable as both the grime
        // gradient and the build sweep coordinate with no extra uniforms.
        vDzLocalY = position.y;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        varying vec4 vDzTint;
        varying float vDzBuild;
        varying float vDzWear;
        varying float vDzLocalY;
        // Grime is recomputed in each chunk it is needed in rather than shared
        // through a local: the chunks are independent insertion points and one
        // of them moving in a future three release must not break the others.
        float dzGrime( float y ) { return 1.0 - smoothstep( 0.0, 0.62, y ); }`,
      )
      .replace(
        "#include <map_fragment>",
        /* glsl */ `#include <map_fragment>
        diffuseColor.rgb *= vDzTint.rgb;
        float dzG = dzGrime( vDzLocalY );
        // Ground grime: darker and browner at the base of every piece.
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.62, 0.58, 0.52 ), dzG * 0.8 );
        // Damage: char toward the same place regardless of family, so a broken
        // wall reads as broken and not as a different material.
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.40, 0.36, 0.33 ), vDzWear );`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        /* glsl */ `#include <roughnessmap_fragment>
        // Per-instance roughness jitter plus a rougher base and rougher damage.
        // The single cheapest fix for the plastic look uniform roughness gives.
        roughnessFactor = clamp(
          roughnessFactor * vDzTint.w + dzGrime( vDzLocalY ) * 0.16 + vDzWear * 0.26,
          0.045, 1.0 );`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
        // Above 1.0 the attribute encodes a hit flash rather than build
        // progress — one attribute, two jobs, and neither needs a branch.
        float dzFlash = max( 0.0, vDzBuild - 1.0 );
        float dzP = min( vDzBuild, 1.0 );
        // The sweep runs from below the base to above the top so the band is
        // fully off-screen at both ends of the animation.
        float dzHead = mix( -0.7, 4.9, dzP );
        float dzBand = 1.0 - smoothstep( 0.0, 0.62, abs( vDzLocalY - dzHead ) );
        totalEmissiveRadiance += vec3( 0.24, 0.70, 1.30 ) * dzBand * ( 1.0 - dzP ) * 2.6;
        // A dim overall charge while unfinished, so the piece reads as "not
        // done yet" even from the one angle where the band is edge-on.
        totalEmissiveRadiance += vec3( 0.08, 0.30, 0.60 ) * ( 1.0 - dzP ) * 0.7;
        totalEmissiveRadiance += vec3( 1.0, 0.46, 0.16 ) * dzFlash * 1.6;`,
      );
  };
}

/* ------------------------------------------------------------------------ *
 * The placement ghost
 *
 * A translucent hologram with a fresnel rim, a scrolling scan band and a bright
 * edge outline. Green means it will go there; red means it will not. Nothing
 * else in the game is allowed to be those two colours, which is what lets the
 * answer be read peripherally while you are looking at the person shooting you.
 * ------------------------------------------------------------------------ */

const GHOST_VERT = /* glsl */ `
  varying vec3 vNrm;
  varying vec3 vViewDir;
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    vNrm = normalize( normalMatrix * normal );
    vViewDir = normalize( -mv.xyz );
    gl_Position = projectionMatrix * mv;
  }
`;

const GHOST_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uPop;
  varying vec3 vNrm;
  varying vec3 vViewDir;
  varying vec3 vLocal;
  void main() {
    // Fresnel: the rim is where a hologram reads, the middle is where it gets
    // in the way of seeing the fight.
    float f = 1.0 - abs( dot( normalize( vNrm ), normalize( vViewDir ) ) );
    f = pow( clamp( f, 0.0, 1.0 ), 1.7 );
    // A 25 cm lattice in piece space, so the ghost carries the grid it is
    // about to snap to rather than just asserting that it snapped.
    vec3 gcell = abs( fract( vLocal * 4.0 ) - 0.5 );
    float grid = 1.0 - smoothstep( 0.32, 0.47, min( min( gcell.x, gcell.y ), gcell.z ) );
    // Scan band climbing the piece, which is what makes a stationary preview
    // feel live rather than pasted.
    float scan = smoothstep( 0.75, 1.0, sin( vLocal.y * 2.4 - uTime * 3.4 ) );
    float a = uOpacity * ( 0.16 + f * 0.72 + grid * 0.20 + scan * 0.16 + uPop * 0.5 );
    vec3 col = uColor * ( 0.7 + f * 0.9 + scan * 0.5 + uPop );
    gl_FragColor = vec4( col, clamp( a, 0.0, 0.95 ) );
  }
`;

/* ------------------------------------------------------------------------ *
 * The weak point marker
 *
 * Fortnite's blue circle. A ring that pulses, drawn on the surface you are
 * about to hit, that doubles the yield of the swing that lands inside it. It
 * is a tiny mechanic that turns pure downtime into a skill check, and its
 * absence is the first thing a Fortnite player notices in a clone.
 * ------------------------------------------------------------------------ */

const WEAK_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uFade;
  varying vec2 vXy;
  void main() {
    float r = length( vXy );
    if ( r > 1.0 ) discard;
    float pulse = 0.5 + 0.5 * sin( uTime * 7.0 );
    // Two rings: a hard outer edge that says "this is the boundary", and a
    // soft breathing core that says "this is live".
    float ring = smoothstep( 0.94, 0.80, r ) - smoothstep( 0.74, 0.58, r );
    float core = ( 1.0 - smoothstep( 0.0, 0.42, r ) ) * ( 0.35 + pulse * 0.4 );
    float a = ( ring * 1.15 + core ) * uFade;
    vec3 col = mix( vec3( 0.16, 0.62, 1.0 ), vec3( 0.72, 0.94, 1.0 ), core + ring * pulse * 0.4 );
    gl_FragColor = vec4( col * ( 1.4 + pulse * 0.6 ), clamp( a, 0.0, 1.0 ) );
  }
`;

const WEAK_VERT = /* glsl */ `
  varying vec2 vXy;
  void main() {
    vXy = position.xy * 2.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

/* ------------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------------ */

/** Extras this system offers beyond the shared `BuildService` contract. */
export interface BuildSystemService extends BuildService {
  /** Live edit mask of the piece under the crosshair, or null. */
  readonly editMask: number;
  /** Cycle wood → stone → metal. Bound to T, and called by the HUD. */
  cycleMaterial(dir?: number): void;
  /** True while a valid, affordable placement is under the crosshair. */
  readonly canPlace: boolean;
}

const createBuilding: SystemFactory = (ctx: WorldCtx): System => {
  const tier = TIERS[ctx.quality] ?? TIERS.high;

  /* ---------------------------------------------------------------- state */

  const root = new THREE.Group();
  root.name = "build";
  // Matrices are written per instance; the group itself never moves, so we can
  // skip its per-frame world-matrix update entirely.
  root.matrixAutoUpdate = false;
  ctx.scene.add(root);

  const pieces = new Map<string, Piece>();
  /** Coarse spatial index by build cell, for queryPieces and explosions. */
  const cellIndex = new Map<string, Set<Piece>>();
  /** node key → pieces claiming it. The structural graph's adjacency. */
  const nodeIndex = new Map<string, Set<Piece>>();
  const batches = new Map<string, Batch>();
  /** Pieces mid-build or mid-flash; the only ones written every frame. */
  const animating = new Set<Piece>();
  /** Scheduled collapses, ordered by time. */
  const falling: Piece[] = [];

  const geoCache = new Map<string, THREE.BufferGeometry>();
  const familyMaterials = new Map<HarvestKind, THREE.MeshStandardMaterial>();

  let nextId = 1;
  let serial = 0;
  let pieceCount = 0;
  let structureDirty = false;
  let disposed = false;
  let now = 0;

  // --- input latches -------------------------------------------------------
  // Edge-triggered input is consumed in fixed() and cleared in update(). See
  // note 1 in the file header for why the usual buffer-in-update is wrong here.
  let latchRotate = false;
  let latchEdit = false;
  let latchCycle = false;
  let latchToggle = false;
  let latchReset = false;
  let prevFire = false;
  let firePressedEdge = false;

  let rotOffset = 0;
  let lastKind: BuildKind = "wall";
  let placeCooldown = 0;
  let lastPlacedKey = "";
  let swingTimer = 0;
  /** Set at swing start, fires SWING_IMPACT later. -1 when idle. */
  let swingImpactAt = -1;

  /* -------------------------------------------------------------- service */

  /**
   * Published before a single geometry is baked. Every function it points at is
   * a hoisted declaration, so this can go right at the top of the factory where
   * it belongs: weapons, combat and the HUD all boot after us and at least one
   * of them will look for `ctx.services.build` inside its own factory.
   */
  const service: BuildSystemService = {
    get selected(): BuildKind | null {
      // One source of truth. `input.buildKind` is what the keyboard writes and
      // what the player system reads to pose the character; mirroring it into a
      // second field is how the two end up disagreeing.
      return ctx.input.buildKind;
    },
    set selected(v: BuildKind | null) {
      ctx.input.buildKind = v;
      if (v) lastKind = v;
    },
    material: "wood",
    place: () => tryPlace(true),
    damagePiece,
    queryPieces,
    get editing() {
      return editPiece !== null;
    },
    get pieceCount() {
      return pieceCount;
    },
    get editMask() {
      return editPiece ? editMaskDraft : MASK_FULL;
    },
    get canPlace() {
      return previewValid;
    },
    cycleMaterial,
  };
  ctx.services.build = service;

  /* ------------------------------------------------------------- ghost/UI */

  const ghostUniforms = {
    uColor: { value: GHOST_OK.clone() },
    uTime: { value: 0 },
    uOpacity: { value: 0.72 },
    uPop: { value: 0 },
  };
  const ghostMaterial = new THREE.ShaderMaterial({
    uniforms: ghostUniforms,
    vertexShader: GHOST_VERT,
    fragmentShader: GHOST_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // The preview is an interface element that happens to live in the scene.
    // Tone-mapping it would let a bright sky wash the "blocked" red out to pink
    // exactly when the player most needs to read it.
    toneMapped: false,
  });
  const ghostLineMaterial = new THREE.LineBasicMaterial({
    color: GHOST_OK.clone(),
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    toneMapped: false,
  });
  /**
   * A shared empty placeholder. The ghost swaps geometry from a cache it does
   * not own the lifetime of at teardown time, and pointing both objects back at
   * one throwaway is how the engine's `disposeSceneGraph` sweep is guaranteed
   * not to find (and free) a cache entry twice.
   */
  const emptyGeo = new THREE.BufferGeometry();
  const ghostMesh = new THREE.Mesh(emptyGeo, ghostMaterial);
  const ghostLines = new THREE.LineSegments(emptyGeo, ghostLineMaterial);
  ghostMesh.frustumCulled = false;
  ghostLines.frustumCulled = false;
  ghostMesh.renderOrder = 900;
  ghostLines.renderOrder = 901;
  ghostMesh.visible = false;
  ghostLines.visible = false;
  ghostMesh.matrixAutoUpdate = false;
  ghostLines.matrixAutoUpdate = false;
  root.add(ghostMesh, ghostLines);
  /** Ghost geometry per (kind, family). Owned here; twelve entries at most. */
  const ghostCache = new Map<string, { geo: THREE.BufferGeometry; edges: THREE.BufferGeometry }>();
  let ghostGeoKey = "";
  let ghostPop = 0;

  // --- edit overlay --------------------------------------------------------
  // The one place a `MeshBasicMaterial` is right: this is interface drawn in
  // world space, it must not take light from the scene, and it must not be
  // tone-mapped or a bright sky would wash the cell states into each other.
  const editMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const editGeo = new THREE.BufferGeometry();
  {
    // Nine quads, two triangles each. Positions are rewritten whenever the
    // edited piece changes; colours whenever the draft mask changes.
    const pos = new Float32Array(9 * 4 * 3);
    const col = new Float32Array(9 * 4 * 3);
    const idx: number[] = [];
    for (let i = 0; i < 9; i++) {
      const b = i * 4;
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    editGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    editGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    editGeo.setIndex(idx);
  }
  const editMesh = new THREE.Mesh(editGeo, editMaterial);
  editMesh.frustumCulled = false;
  editMesh.renderOrder = 902;
  editMesh.visible = false;
  editMesh.matrixAutoUpdate = false;
  root.add(editMesh);

  const editOutlineMaterial = new THREE.LineBasicMaterial({
    color: ACCENT.clone(),
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    toneMapped: false,
  });
  const editOutline = new THREE.LineSegments(emptyGeo, editOutlineMaterial);
  editOutline.frustumCulled = false;
  editOutline.renderOrder = 903;
  editOutline.visible = false;
  editOutline.matrixAutoUpdate = false;
  root.add(editOutline);
  let editOutlineGeo: THREE.BufferGeometry | null = null;

  let editPiece: Piece | null = null;
  let editMaskDraft = MASK_FULL;
  let editHoverCell = -1;
  const editMatrix = new THREE.Matrix4();

  // --- weak point ----------------------------------------------------------
  const weakUniforms = { uTime: { value: 0 }, uFade: { value: 0 } };
  const weakMaterial = new THREE.ShaderMaterial({
    uniforms: weakUniforms,
    vertexShader: WEAK_VERT,
    fragmentShader: WEAK_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
  });
  const weakGeo = new THREE.PlaneGeometry(WEAK_RADIUS * 2, WEAK_RADIUS * 2);
  const weakMesh = new THREE.Mesh(weakGeo, weakMaterial);
  weakMesh.frustumCulled = false;
  weakMesh.renderOrder = 890;
  weakMesh.visible = false;
  root.add(weakMesh);

  interface WeakPoint {
    /** Identity of the surface it belongs to, so it dies when you switch trees. */
    owner: string;
    point: THREE.Vector3;
    normal: THREE.Vector3;
    expires: number;
  }
  let weak: WeakPoint | null = null;

  /* ---------------------------------------------------------- scratch ---- */

  const _eye = new THREE.Vector3();
  const _look = new THREE.Vector3();
  const _target = new THREE.Vector3();
  const _tmp = new THREE.Vector3();
  const _tmp2 = new THREE.Vector3();
  const _mat = new THREE.Matrix4();
  const _inv = new THREE.Matrix4();
  const _nodes: string[] = [];
  const _boxA = new THREE.Box3();
  const _boxB = new THREE.Box3();
  const _color = new THREE.Color();

  /* ------------------------------------------------------- material bake */

  /**
   * One material per family, built from the shared library's *maps* rather than
   * by cloning its material.
   *
   * Cloning would drop the library's `onBeforeCompile` (three's `Material.copy`
   * does not carry it) and would fight ours for the same hook. Reusing the maps
   * costs nothing and keeps every built wall in the same texture set as the
   * building it is nailed to — and it means we must never dispose those
   * textures, because they are the library's, not ours.
   */
  function familyMaterial(family: HarvestKind): THREE.MeshStandardMaterial {
    const cached = familyMaterials.get(family);
    if (cached) return cached;

    const lib = ctx.services.materials as MaterialsService | undefined;
    const src = lib?.get(SURFACE_OF[family]) as THREE.MeshStandardMaterial | undefined;
    const mat = new THREE.MeshStandardMaterial({
      color: TINT_OF[family],
      // Pinned to 1 where a map exists: the map carries the real values and a
      // second scalar on top of it is just a way to lose the variation.
      roughness: src?.roughnessMap ? 1 : family === "metal" ? 0.42 : 0.82,
      metalness: src?.metalnessMap ? 1 : family === "metal" ? 0.75 : 0.04,
      map: src?.map ?? null,
      normalMap: src?.normalMap ?? null,
      aoMap: src?.aoMap ?? null,
      roughnessMap: src?.roughnessMap ?? null,
      metalnessMap: src?.metalnessMap ?? null,
      envMapIntensity: family === "metal" ? 1.05 : 0.6,
    });
    if (src?.normalScale) mat.normalScale.copy(src.normalScale);
    mat.name = `dz:build-${family}`;
    patchBuildMaterial(mat);
    familyMaterials.set(family, mat);
    return mat;
  }

  function batchFor(kind: BuildKind, mask: number, family: HarvestKind): Batch | null {
    const key = `${kind}|${mask}|${family}`;
    const b = batches.get(key);
    if (b && !b.full) return b;
    if (b && b.full) {
      // Spill: a second batch under a suffixed key. Reaching 1024 instances of
      // one exact (kind, mask, material) is a mega-build, and paying one extra
      // draw call for it beats refusing to render the 1025th wall.
      let n = 1;
      while (true) {
        const spillKey = `${key}#${n}`;
        const s = batches.get(spillKey);
        if (!s) return makeBatch(spillKey, kind, mask, family);
        if (!s.full) return s;
        n++;
        if (n > 8) return null;
      }
    }
    return makeBatch(key, kind, mask, family);
  }

  function makeBatch(key: string, kind: BuildKind, mask: number, family: HarvestKind): Batch | null {
    const geoKey = `${kind}|${mask}|${family}`;
    let geo = geoCache.get(geoKey);
    if (!geo) {
      const soup = pieceGeo(kind, mask, family, tier, false);
      if (soup.empty) return null;
      // A per-family UV offset so wood, stone and metal do not all sample the
      // same corner of their (different) textures in lockstep.
      const off = family === "wood" ? 0 : family === "stone" ? 0.37 : 0.71;
      geo = soup.toGeometry(TILE_OF[family], off);
      geoCache.set(geoKey, geo);
    }
    const b = new Batch(key, geo, familyMaterial(family), root, ctx.quality !== "low");
    batches.set(key, b);
    return b;
  }

  /* -------------------------------------------------------- spatial index */

  const cellKeyOf = (p: Piece) => `${p.loc.a >> 1},${p.loc.b},${p.loc.c >> 1}`;

  function indexPiece(p: Piece): void {
    const ck = cellKeyOf(p);
    let set = cellIndex.get(ck);
    if (!set) cellIndex.set(ck, (set = new Set()));
    set.add(p);
    for (const n of p.nodes) {
      let ns = nodeIndex.get(n);
      if (!ns) nodeIndex.set(n, (ns = new Set()));
      ns.add(p);
    }
  }

  function unindexPiece(p: Piece): void {
    const ck = cellKeyOf(p);
    const set = cellIndex.get(ck);
    if (set) {
      set.delete(p);
      // Give the map back: a long match that builds and breaks across the whole
      // island would otherwise leak one entry per cell ever touched.
      if (set.size === 0) cellIndex.delete(ck);
    }
    for (const n of p.nodes) {
      const ns = nodeIndex.get(n);
      if (!ns) continue;
      ns.delete(p);
      if (ns.size === 0) nodeIndex.delete(n);
    }
  }

  function queryPieces(center: THREE.Vector3, radius: number): BuildPiece[] {
    const out: BuildPiece[] = [];
    if (!(radius > 0)) return out;
    const step = GRID * 2;
    const x0 = Math.floor((center.x - radius) / step);
    const x1 = Math.floor((center.x + radius) / step);
    const y0 = Math.floor((center.y - radius) / GRID);
    const y1 = Math.floor((center.y + radius) / GRID);
    const z0 = Math.floor((center.z - radius) / step);
    const z1 = Math.floor((center.z + radius) / step);
    const r2 = radius * radius;
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const set = cellIndex.get(`${x},${y},${z}`);
          if (!set) continue;
          for (const p of set) {
            const d = p.box.distanceToPoint(center);
            if (d * d <= r2) out.push(p);
          }
        }
      }
    }
    return out;
  }

  /* ----------------------------------------------------------- placement */

  /**
   * Where the crosshair lands, clamped to build range. Returns the world point
   * the placement lattice is derived from.
   */
  function aimPoint(out: THREE.Vector3): boolean {
    const player = ctx.services.player;
    if (!player) return false;
    player.eye(_eye);
    player.look(_look);
    if (!Number.isFinite(_eye.x) || _look.lengthSq() < 1e-8) return false;

    const collision = ctx.services.collision;
    let dist = BUILD_RANGE;
    if (collision) {
      const hit = collision.raycast(_eye, _look, BUILD_RANGE);
      // Pull back a hair off the surface so a wall aimed at the ground snaps to
      // the cell in front of it rather than the cell underneath it.
      if (hit) dist = Math.max(0.6, hit.distance - 0.08);
    }
    out.copy(_eye).addScaledVector(_look, dist);
    return true;
  }

  /** Which of the four cardinals the player is facing. 0 = -Z, 1 = +X, 2 = +Z, 3 = -X. */
  function cardinal(): number {
    if (Math.abs(_look.z) >= Math.abs(_look.x)) return _look.z < 0 ? 0 : 2;
    return _look.x > 0 ? 1 : 3;
  }

  /**
   * Snap the aim point onto the build lattice for the selected kind.
   *
   * Walls land on the nearest grid *line* perpendicular to the way you are
   * facing, which is what makes "turn and throw a wall" land where your body
   * expects rather than where your crosshair happened to be. Floors, ramps and
   * cones land on the cell the crosshair is in, at the nearest lattice level —
   * `round` and not `floor`, because a floor placed while stood on the ground
   * should appear under your feet and not one storey down.
   */
  function snapLoc(kind: BuildKind, point: THREE.Vector3, out: Loc): Loc {
    out.kind = kind;
    const card = cardinal();
    if (kind === "wall") {
      // Q flips a wall between the two axes rather than spinning it, because a
      // wall has no meaningful third or fourth orientation.
      const axis = (card % 2 === 0 ? 0 : 1) ^ (rotOffset & 1);
      out.rot = axis;
      out.b = Math.floor(point.y / GRID + 1e-4);
      if (axis === 0) {
        out.a = Math.floor(point.x / GRID);
        out.c = Math.round(point.z / GRID);
      } else {
        out.a = Math.round(point.x / GRID);
        out.c = Math.floor(point.z / GRID);
      }
      return out;
    }
    out.a = Math.floor(point.x / GRID);
    out.c = Math.floor(point.z / GRID);
    out.b = kind === "floor" ? Math.round(point.y / GRID) : Math.floor(point.y / GRID + 0.25);
    // A ramp or cone always rises away from you unless Q says otherwise; a
    // floor's rotation only ever matters for how an edit mask is oriented.
    out.rot = kind === "floor" ? rotOffset & 3 : (card + rotOffset) & 3;
    return out;
  }

  /** Terrain height sampled across a placement's footprint, taking the max. */
  function groundUnder(l: Loc): number {
    const terrain = ctx.services.terrain as TerrainLike | undefined;
    if (!terrain) return -Infinity;
    let best = -Infinity;
    // Four corners plus the centre. Five samples is enough to catch a ridge
    // running under the cell and cheap enough to run on every preview frame.
    const px = l.a * GRID;
    const pz = l.c * GRID;
    const span = l.kind === "wall" ? ((l.rot & 1) === 0 ? [GRID, 0] : [0, GRID]) : [GRID, GRID];
    for (let i = 0; i < 5; i++) {
      const u = i === 4 ? 0.5 : i & 1;
      const v = i === 4 ? 0.5 : (i >> 1) & 1;
      const h = terrain.heightAt(px + span[0] * u, pz + span[1] * v);
      if (h > best) best = h;
    }
    return best;
  }

  /** Is a placement held up by the terrain or by a static world collider? */
  function isAnchored(l: Loc): boolean {
    pieceBox(l, _boxA);
    const baseY = _boxA.min.y;
    const ground = groundUnder(l);
    if (Number.isFinite(ground) && ground >= baseY - GROUND_TOLERANCE) return true;

    // Rooftops, container stacks, bridge decks: anything static directly under
    // the piece counts. A thin probe slab, so a wall does not anchor itself to
    // the building it is stood beside.
    const collision = ctx.services.collision as CollisionLike | undefined;
    if (!collision) return false;
    _boxB.copy(_boxA);
    _boxB.min.y = baseY - 0.5;
    _boxB.max.y = baseY + 0.05;
    _boxB.expandByScalar(-0.05);
    if (_boxB.min.x >= _boxB.max.x) return false;
    if (collision.overlapBox) return collision.overlapBox(_boxB, (o) => !o.built);
    _boxB.getCenter(_tmp);
    for (const h of collision.query(_tmp, GRID * 0.7)) {
      if (!h.opts.built && h.box.intersectsBox(_boxB)) return true;
    }
    return false;
  }

  /** Does the placement connect to something already standing? */
  function connectsToStructure(l: Loc): boolean {
    locNodes(l, _nodes);
    for (const n of _nodes) {
      const set = nodeIndex.get(n);
      if (!set) continue;
      for (const p of set) if (!p.falling) return true;
    }
    return false;
  }

  /**
   * Is the volume free? Built pieces are excluded from the sweep and handled by
   * the slot map instead: two pieces of different kinds legitimately share a
   * cell (a ramp under a cone, a floor under both) and an AABB test cannot tell
   * that from a real conflict.
   */
  function volumeClear(l: Loc, mask: number): boolean {
    const collision = ctx.services.collision as CollisionLike | undefined;
    if (!collision) return true;
    const boxes = colliderBoxes(l, mask, tier);
    for (const b of boxes) {
      // Shrink before testing. Every legal build touches the world — a floor
      // rests on dirt, a wall shares a seam with the wall beside it — and a
      // strict test would call all of it a collision.
      _boxB.copy(b).expandByScalar(-0.09);
      if (_boxB.min.x >= _boxB.max.x || _boxB.min.y >= _boxB.max.y || _boxB.min.z >= _boxB.max.z) {
        continue;
      }
      if (collision.overlapBox) {
        if (collision.overlapBox(_boxB, (o) => !o.built)) return false;
      } else {
        _boxB.getCenter(_tmp);
        for (const h of collision.query(_tmp, GRID)) {
          if (!h.opts.built && h.box.intersectsBox(_boxB)) return false;
        }
      }
    }
    return true;
  }

  /**
   * The single validity question, answered once per fixed step and reused by
   * both the ghost colour and the placement itself — the two must never be able
   * to disagree, which is why they are literally the same call.
   */
  interface Validity {
    ok: boolean;
    afford: boolean;
    reason: "" | "occupied" | "blocked" | "unsupported" | "cost" | "range";
  }
  const validity: Validity = { ok: false, afford: false, reason: "" };

  function validate(l: Loc, mask: number): Validity {
    validity.ok = false;
    validity.reason = "";
    const inv = ctx.services.inventory;
    validity.afford = !inv || inv[service.material] >= PIECE_COST;

    if (pieces.has(locKey(l))) {
      validity.reason = "occupied";
      return validity;
    }
    // Below sea level is not a build; it is a way to hide a wall no one can
    // shoot. The terrain system owns the waterline, so ask it.
    const terrain = ctx.services.terrain;
    if (terrain) {
      pieceBox(l, _boxA);
      if (_boxA.max.y < terrain.seaLevel - 0.5) {
        validity.reason = "blocked";
        return validity;
      }
    }
    if (!volumeClear(l, mask)) {
      validity.reason = "blocked";
      return validity;
    }
    if (!isAnchored(l) && !connectsToStructure(l)) {
      validity.reason = "unsupported";
      return validity;
    }
    if (!validity.afford) {
      validity.reason = "cost";
      return validity;
    }
    validity.ok = true;
    return validity;
  }

  const previewLoc: Loc = { kind: "wall", a: 0, b: 0, c: 0, rot: 0 };
  let previewValid = false;
  let previewKey = "";
  let previewActive = false;
  const previewMatrix = new THREE.Matrix4();

  /** Recompute the preview transform + validity. Runs once per fixed step. */
  function updatePreview(): void {
    const kind = ctx.input.buildKind;
    previewActive = false;
    if (!kind || editPiece || !ctx.services.player?.controllable) return;
    if (!aimPoint(_target)) return;
    snapLoc(kind, _target, previewLoc);
    const v = validate(previewLoc, MASK_FULL);
    previewValid = v.ok;
    previewActive = true;
    locMatrix(previewLoc, previewMatrix);
    const key = locKey(previewLoc);
    if (key !== previewKey) {
      previewKey = key;
      // A short white bloom on every snap. The preview moves in 4 m jumps and
      // without a transition the eye reads it as teleporting rather than
      // tracking, which is the difference between "snappy" and "twitchy".
      ghostPop = 1;
    }
  }

  /* -------------------------------------------------------------- placing */

  function tryPlace(force: boolean): BuildPiece | null {
    if (!previewActive || editPiece) return null;
    const kind = ctx.input.buildKind;
    if (!kind) return null;

    const key = locKey(previewLoc);
    // A change of target bypasses the rate limit entirely: that is what turns a
    // held mouse button into a continuous ramp run instead of a dotted line.
    if (!force && placeCooldown > 0 && key === lastPlacedKey) return null;

    let v = validate(previewLoc, MASK_FULL);
    if (!v.ok && v.reason === "cost") {
      // Auto-swap to a material you can actually afford, the way the real game
      // does. Running dry mid-fight and silently placing nothing is a death.
      const order: HarvestKind[] = ["wood", "stone", "metal"];
      const inv = ctx.services.inventory;
      if (inv) {
        for (const m of order) {
          if (m !== service.material && inv[m] >= PIECE_COST) {
            service.material = m;
            v = validate(previewLoc, MASK_FULL);
            break;
          }
        }
      }
    }
    if (!v.ok) {
      if (force && v.reason) {
        ctx.services.audio?.play("build-deny", { volume: 0.35 });
      }
      return null;
    }

    const inv = ctx.services.inventory;
    if (inv && !inv.spendMaterial(service.material, PIECE_COST)) return null;

    const piece = spawnPiece({ ...previewLoc }, service.material, MASK_FULL, "player");
    if (!piece) {
      // Refund: charging for a piece that never appeared is the worst possible
      // failure mode in a game where materials are the resource you fight over.
      inv?.addMaterial(service.material, PIECE_COST);
      return null;
    }
    lastPlacedKey = key;
    placeCooldown = PLACE_INTERVAL;
    return piece;
  }

  function spawnPiece(loc: Loc, family: HarvestKind, mask: number, owner: string): Piece | null {
    if (pieces.has(locKey(loc))) return null;
    if (pieceCount >= MAX_PIECES) retireOldest();

    const maxHp = PIECE_HP[family];
    const p: Piece = {
      id: nextId++,
      kind: loc.kind,
      material: family,
      cell: new THREE.Vector3(loc.a, loc.b, loc.c),
      rotation: loc.rot,
      hp: Math.max(1, Math.round(maxHp * BUILD_START_HP)),
      maxHp,
      complete: false,
      owner,
      box: new THREE.Box3(),
      loc,
      mask,
      age: 0,
      flash: 0,
      damage: 0,
      nodes: [],
      anchored: false,
      falling: false,
      fallAt: 0,
      removers: [],
      batch: null,
      index: -1,
      tint: new THREE.Color(),
      rough: 1,
      matrix: new THREE.Matrix4(),
      serial: serial++,
    };

    locNodes(loc, _nodes);
    p.nodes = _nodes.slice();
    p.anchored = isAnchored(loc);
    pieceBox(loc, p.box);
    locMatrix(loc, p.matrix);

    // Per-instance jitter, hashed off the lattice so a rebuilt world is
    // identical and so two adjacent pieces are never the same shade. Value and
    // saturation only — a hue-shifted plank is a different plank, a
    // value-shifted one is the same plank in different weather.
    const h1 = hash2i(loc.a * 73856093 + loc.c, loc.b * 19349663 + loc.kind.length);
    const h2 = hash2i(loc.c * 83492791 + loc.b, loc.a * 2971215073);
    const shade = 1 + (h1 - 0.5) * 0.17;
    p.tint.setRGB(shade * (1 + (h2 - 0.5) * 0.04), shade, shade * (1 - (h2 - 0.5) * 0.05));
    p.rough = 0.82 + h2 * 0.4;

    attachToBatch(p);
    registerColliders(p);
    pieces.set(locKey(loc), p);
    indexPiece(p);
    pieceCount++;
    animating.add(p);
    structureDirty = true;

    ctx.services.audio?.play("build-place", { position: p.box.getCenter(_tmp).clone(), volume: 0.8 });
    return p;
  }

  function attachToBatch(p: Piece): void {
    const b = batchFor(p.kind, p.mask, p.material);
    if (b) b.add(p);
  }

  function registerColliders(p: Piece): void {
    const collision = ctx.services.collision;
    if (!collision) return;
    const opts: ColliderOpts = {
      material: IMPACT_OF[p.material],
      harvest: p.material,
      built: true,
      tag: "build",
      owner: p,
    };
    for (const b of colliderBoxes(p.loc, p.mask, tier)) {
      p.removers.push(collision.addBox(b, opts));
    }
  }

  function clearColliders(p: Piece): void {
    for (const r of p.removers) r();
    p.removers.length = 0;
  }

  /** Silent removal used by MAX_PIECES pressure. No debris, no cascade. */
  function retireOldest(): void {
    let oldest: Piece | null = null;
    for (const p of pieces.values()) {
      if (!oldest || p.serial < oldest.serial) oldest = p;
    }
    if (oldest) removePiece(oldest, false);
  }

  function removePiece(p: Piece, cascade: boolean): void {
    if (!pieces.has(locKey(p.loc))) return;
    clearColliders(p);
    p.batch?.remove(p);
    unindexPiece(p);
    pieces.delete(locKey(p.loc));
    animating.delete(p);
    pieceCount--;
    const i = falling.indexOf(p);
    if (i >= 0) falling.splice(i, 1);
    if (cascade) structureDirty = true;
  }

  /* ------------------------------------------------------------- damage */

  /**
   * Ceiling on a piece's HP right now — full for a finished piece, and on the
   * ramp for one still building.
   *
   * Damage is tracked separately and subtracted from this rather than
   * decremented out of `hp` directly, for two reasons. It keeps damage taken
   * during the 0.4 s build-up (assigning `hp` from the curve each step would
   * silently heal it, deleting the "push through a fresh wall" mechanic the
   * build delay exists to create); and it lands on *exactly* `maxHp` at the
   * end, where accumulating 48 floating-point increments lands on 149.99999
   * and leaves every finished wall in the game reading one HP short forever.
   */
  function curveHp(p: Piece): number {
    const t = Math.min(1, p.age / BUILD_TIME);
    return p.maxHp * (BUILD_START_HP + (1 - BUILD_START_HP) * t);
  }

  function damagePiece(piece: BuildPiece, amount: number, source: DamageSource): void {
    const p = piece as Piece;
    if (!p || !pieces.has(locKey(p.loc))) return;
    if (!(amount > 0)) return;
    p.damage += amount;
    p.hp = curveHp(p) - p.damage;
    p.flash = Math.min(1, p.flash + 0.55);
    animating.add(p);

    if (p.hp > 0) {
      p.batch?.write(p.index);
      ctx.services.audio?.play("build-hit", {
        position: p.box.getCenter(_tmp).clone(),
        volume: 0.5,
        rate: 0.9 + Math.random() * 0.2,
      });
      return;
    }
    destroyPiece(p, source);
  }

  function destroyPiece(p: Piece, source?: DamageSource): void {
    const vfx = ctx.services.vfx;
    const centre = p.box.getCenter(new THREE.Vector3());
    // Only a *shot* piece seeds the stagger origin. A piece falling as part of
    // a collapse must not re-seed it, or the wave would chase itself around the
    // structure and arrive everywhere at once.
    if (!p.falling) lastBreak.copy(centre);
    vfx?.buildBreak(p.box.clone(), p.material);
    if (tier.debris > 0) {
      // A little extra smoke on top of the debris the VFX system throws. A
      // structure failing should momentarily obscure the space it occupied —
      // that is what makes shooting a wall down a tactic and not just damage.
      vfx?.smoke(centre, tier.debris * 0.35);
    }
    ctx.services.audio?.play("build-break", { position: centre, volume: 0.9 });
    void source;
    removePiece(p, true);
  }

  /* ------------------------------------------------- structural integrity */

  const supported = new Set<Piece>();
  const bfsQueue: Piece[] = [];
  /** Centre of the last piece to die. The collapse stagger radiates from here. */
  const lastBreak = new THREE.Vector3();

  /**
   * Flood fill from every ground-anchored piece; anything the fill misses has
   * lost its legs and is scheduled to fall.
   *
   * Full recompute rather than an incremental one, deliberately. An incremental
   * removal test has to answer "is there still *another* path to ground", which
   * is a full search in the worst case anyway; and at MAX_PIECES this walks
   * ~1400 pieces × ~6 nodes once per destruction, which is nothing next to the
   * particle burst that destruction just spawned.
   */
  function rebuildSupport(): void {
    supported.clear();
    bfsQueue.length = 0;
    for (const p of pieces.values()) {
      if (p.anchored && !p.falling) {
        supported.add(p);
        bfsQueue.push(p);
      }
    }
    for (let head = 0; head < bfsQueue.length; head++) {
      const p = bfsQueue[head];
      for (const n of p.nodes) {
        const set = nodeIndex.get(n);
        if (!set) continue;
        for (const q of set) {
          if (q.falling || supported.has(q)) continue;
          supported.add(q);
          bfsQueue.push(q);
        }
      }
    }

    for (const p of pieces.values()) {
      if (supported.has(p) || p.falling) continue;
      // Stagger by distance from the break — the piece that actually died, not
      // an arbitrary member of the orphaned set — so a tower peels apart from
      // the wound outward over most of a second instead of every piece in it
      // vanishing on the same frame. This is the money shot of the whole system.
      const d = p.box.getCenter(_tmp).distanceTo(lastBreak);
      p.falling = true;
      p.fallAt =
        now + Math.min(COLLAPSE_MAX_DELAY, 0.04 + d * COLLAPSE_STAGGER) + Math.random() * 0.04;
      falling.push(p);
    }
  }

  function stepCollapse(): void {
    if (falling.length === 0) return;
    for (let i = falling.length - 1; i >= 0; i--) {
      const p = falling[i];
      if (p.fallAt > now) continue;
      falling.splice(i, 1);
      // `falling` stays set through the destroy so `destroyPiece` can tell a
      // collapse from a kill and leave the stagger origin where the shot was.
      destroyPiece(p);
    }
  }

  /* --------------------------------------------------------------- edit */

  /**
   * Ray → which of the nine edit cells. Works by pulling the ray into slab
   * space, where the answer is two divisions. Returns -1 for a miss.
   */
  function pickEditCell(p: Piece): number {
    const player = ctx.services.player;
    if (!player) return -1;
    player.eye(_eye);
    player.look(_look);
    _mat.copy(p.matrix).multiply(FACE_MATRIX[p.kind]);
    _inv.copy(_mat).invert();
    _tmp.copy(_eye).applyMatrix4(_inv);
    _tmp2.copy(_look).transformDirection(_inv);
    if (Math.abs(_tmp2.z) < 1e-5) return -1;
    const t = -_tmp.z / _tmp2.z;
    if (t < 0 || t > EDIT_RANGE * 1.4) return -1;
    const x = _tmp.x + _tmp2.x * t;
    const y = _tmp.y + _tmp2.y * t;
    const w = SLAB_W;
    const h = SLAB_H[p.kind];
    if (x < 0 || x > w || y < 0 || y > h) return -1;
    const col = clamp(Math.floor((x / w) * 3), 0, 2);
    const row = clamp(Math.floor((y / h) * 3), 0, 2);
    return row * 3 + col;
  }

  function enterEdit(): void {
    const player = ctx.services.player;
    const collision = ctx.services.collision;
    if (!player || !collision) return;
    player.eye(_eye);
    player.look(_look);
    const hit = collision.raycast(_eye, _look, EDIT_RANGE);
    const p = hit?.piece as Piece | undefined;
    // Cones and ramps have no meaningful 3 × 3 face to carve; the real game
    // edits them into shapes that need their own geometry family, and shipping
    // a broken version of that is worse than shipping the two that matter.
    if (!p || !pieces.has(locKey(p.loc)) || (p.kind !== "wall" && p.kind !== "floor")) return;
    editPiece = p;
    editMaskDraft = p.mask;
    editHoverCell = -1;
    buildEditOverlay(p);
    ctx.services.audio?.play("build-edit-open", { volume: 0.5 });
  }

  function buildEditOverlay(p: Piece): void {
    const w = SLAB_W;
    const h = SLAB_H[p.kind];
    const pos = editGeo.getAttribute("position") as THREE.BufferAttribute;
    const pad = 0.06;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const i = (row * 3 + col) * 4;
        const x0 = (col / 3) * w + pad;
        const x1 = ((col + 1) / 3) * w - pad;
        const y0 = (row / 3) * h + pad;
        const y1 = ((row + 1) / 3) * h - pad;
        pos.setXYZ(i, x0, y0, 0);
        pos.setXYZ(i + 1, x1, y0, 0);
        pos.setXYZ(i + 2, x1, y1, 0);
        pos.setXYZ(i + 3, x0, y1, 0);
      }
    }
    pos.needsUpdate = true;
    editGeo.computeBoundingSphere();

    // The overlay floats just off whichever face the player is on, so it never
    // z-fights with the panel it describes and never hides behind it.
    const player = ctx.services.player;
    let side = 1;
    if (player) {
      _mat.copy(p.matrix).multiply(FACE_MATRIX[p.kind]);
      _inv.copy(_mat).invert();
      _tmp.copy(player.position).applyMatrix4(_inv);
      side = _tmp.z >= 0 ? 1 : -1;
    }
    editMatrix
      .copy(p.matrix)
      .multiply(FACE_MATRIX[p.kind])
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, side * (HALF_T + 0.035)));
    editMesh.matrix.copy(editMatrix);
    // Manual matrices under a `matrixAutoUpdate: false` root need the world
    // matrix invalidated by hand, or the overlay draws at the world origin.
    editMesh.matrixWorldNeedsUpdate = true;
    editMesh.visible = true;

    editOutlineGeo?.dispose();
    const soup = pieceGeo(p.kind, p.mask, p.material, tier, true);
    const plain = soup.toGeometry(1, 0);
    editOutlineGeo = new THREE.EdgesGeometry(plain, 28);
    plain.dispose();
    editOutline.geometry = editOutlineGeo;
    editOutline.matrix.copy(p.matrix);
    editOutline.matrixWorldNeedsUpdate = true;
    editOutline.visible = true;
    refreshEditColors();
  }

  function refreshEditColors(): void {
    const col = editGeo.getAttribute("color") as THREE.BufferAttribute;
    for (let i = 0; i < 9; i++) {
      const solid = (editMaskDraft & (1 << i)) !== 0;
      const hovered = i === editHoverCell;
      // Solid cells sit back in cool blue; cells you have carved glow amber, so
      // the shape of the hole you are about to cut is readable at a glance.
      if (solid) _color.setRGB(0.16, 0.46, 0.78);
      else _color.setRGB(1.0, 0.62, 0.14);
      if (hovered) _color.multiplyScalar(2.1);
      for (let k = 0; k < 4; k++) col.setXYZ(i * 4 + k, _color.r, _color.g, _color.b);
    }
    col.needsUpdate = true;
  }

  function applyEdit(): void {
    const p = editPiece;
    editPiece = null;
    editMesh.visible = false;
    editOutline.visible = false;
    if (!p || !pieces.has(locKey(p.loc))) return;
    // Carving every cell would leave a frame with nothing in it, which reads as
    // a bug and is not something the real game lets you do either.
    if (editMaskDraft === 0 || editMaskDraft === p.mask) return;

    p.mask = editMaskDraft;
    p.batch?.remove(p);
    attachToBatch(p);
    clearColliders(p);
    registerColliders(p);
    ctx.services.audio?.play("build-edit-apply", {
      position: p.box.getCenter(_tmp).clone(),
      volume: 0.7,
    });
  }

  function updateEdit(): void {
    const p = editPiece;
    if (!p) return;
    if (!pieces.has(locKey(p.loc)) || !ctx.services.player?.controllable) {
      editPiece = null;
      editMesh.visible = false;
      editOutline.visible = false;
      return;
    }
    const cell = pickEditCell(p);
    if (cell !== editHoverCell) {
      editHoverCell = cell;
      refreshEditColors();
    }
    if (firePressedEdge && cell >= 0) {
      editMaskDraft ^= 1 << cell;
      refreshEditColors();
      ctx.services.audio?.play("build-edit-tick", { volume: 0.4 });
    }
    if (latchReset) {
      editMaskDraft = MASK_FULL;
      refreshEditColors();
    }
    // Confirmation is NOT handled here. The edit key is consumed once, at the
    // top of fixed(), where it means "open if closed, apply if open" — checking
    // the same latch again down here would open edit mode and confirm it in the
    // same 8 ms step, which looks exactly like the key not working at all.
  }

  /* ----------------------------------------------------------- harvesting */

  /** Stable identity for the thing a harvest ray hit, so a weak point sticks. */
  function harvestOwnerKey(hit: { piece?: BuildPiece; object?: THREE.Object3D; point: THREE.Vector3 }): string {
    if (hit.piece) return `p${(hit.piece as Piece).id}`;
    if (hit.object) return `o${hit.object.id}`;
    // Anonymous static collider: quantise the impact to a 2 m lattice. Coarse
    // enough that a tree trunk is one thing, fine enough that two trees are two.
    return `s${Math.round(hit.point.x / 2)},${Math.round(hit.point.y / 2)},${Math.round(hit.point.z / 2)}`;
  }

  function swingPickaxe(): void {
    const player = ctx.services.player;
    const collision = ctx.services.collision;
    if (!player || !collision) return;
    player.eye(_eye);
    player.look(_look);
    const hit = collision.raycast(_eye, _look, HARVEST_RANGE);
    if (!hit) {
      ctx.services.audio?.play("pickaxe-whoosh", { volume: 0.4 });
      return;
    }

    const vfx = ctx.services.vfx;
    const kind = hit.harvest;
    const key = harvestOwnerKey(hit);

    // Weak point: a swing landing inside the live marker on the *same* surface
    // pays double. Missing it costs nothing, which is the right shape for a
    // bonus that has to be discoverable without a tutorial.
    let crit = false;
    if (weak && weak.owner === key && weak.expires > now) {
      crit = hit.point.distanceTo(weak.point) <= WEAK_RADIUS * 1.15;
    }

    if (kind) {
      const inv = ctx.services.inventory;
      const yield_ = Math.round(HARVEST_YIELD[kind] * (crit ? 2 : 1));
      inv?.addMaterial(kind, yield_);
      vfx?.harvestBurst(hit.point.clone(), kind);
      if (crit) {
        vfx?.harvestBurst(hit.point.clone().addScaledVector(hit.normal, 0.12), kind);
        vfx?.damageNumber(hit.point.clone(), yield_, true, false);
        ctx.services.audio?.play("harvest-crit", { position: hit.point.clone(), volume: 0.9 });
      } else {
        ctx.services.audio?.play("pickaxe-hit", {
          position: hit.point.clone(),
          volume: 0.7,
          rate: 0.94 + Math.random() * 0.12,
        });
      }
      ctx.emit("dz:harvest", { kind, amount: yield_, crit });
      // Move the marker: a new one appears just off the impact, on the same
      // surface plane, and the old one dies with it.
      spawnWeakPoint(key, hit.point, hit.normal);
    } else {
      vfx?.impact(hit.point.clone(), hit.normal.clone(), hit.material);
      ctx.services.audio?.play("pickaxe-hit", { position: hit.point.clone(), volume: 0.5 });
    }

    // Your own builds are pickaxeable, the same as in the real game — it is how
    // you take a wall back down without spending a magazine on it.
    if (hit.piece) damagePiece(hit.piece, PICKAXE_BUILD_DAMAGE * (crit ? 2 : 1), { by: "player", weapon: "pickaxe" });
  }

  function spawnWeakPoint(owner: string, point: THREE.Vector3, normal: THREE.Vector3): void {
    // Offset within the surface plane: build any vector not parallel to the
    // normal, take two cross products, and walk a random distance along them.
    _tmp.set(0, 1, 0);
    if (Math.abs(normal.dot(_tmp)) > 0.9) _tmp.set(1, 0, 0);
    _tmp2.crossVectors(normal, _tmp).normalize();
    _tmp.crossVectors(normal, _tmp2).normalize();
    const a = Math.random() * Math.PI * 2;
    const r = WEAK_SPREAD * (0.45 + Math.random() * 0.55);
    const p = point.clone()
      .addScaledVector(_tmp2, Math.cos(a) * r)
      .addScaledVector(_tmp, Math.sin(a) * r)
      // Off the surface so it never z-fights the thing it is drawn on.
      .addScaledVector(normal, 0.02);
    weak = { owner, point: p, normal: normal.clone(), expires: now + WEAK_LIFETIME };
  }

  /* ------------------------------------------------------------ ghost art */

  function refreshGhost(): void {
    if (!previewActive) {
      ghostMesh.visible = false;
      ghostLines.visible = false;
      return;
    }
    const kind = previewLoc.kind;
    const key = `${kind}|${service.material}`;
    if (key !== ghostGeoKey) {
      ghostGeoKey = key;
      let pair = ghostCache.get(key);
      if (!pair) {
        // Cached, not rebuilt. There are only twelve of these and cycling
        // material mid-fight must not cost an `EdgesGeometry` rebuild — that is
        // a visible hitch at exactly the wrong moment.
        const soup = pieceGeo(kind, MASK_FULL, service.material, tier, true);
        const geo = soup.toGeometry(1, 0);
        // Threshold 28° on the bevel-free ghost geometry gives exactly the box
        // arrises and nothing else. Run on the chamfered geometry it would give
        // either everything or nothing, because there every arris is two 45°
        // folds and no single threshold separates them from the bevel itself.
        pair = { geo, edges: new THREE.EdgesGeometry(geo, 28) };
        ghostCache.set(key, pair);
      }
      ghostMesh.geometry = pair.geo;
      ghostLines.geometry = pair.edges;
    }
    // Both objects have `matrixAutoUpdate` off, so the world matrix has to be
    // invalidated by hand — without this the ghost renders at the origin
    // forever, because `root` never marks itself dirty either.
    ghostMesh.matrix.copy(previewMatrix);
    ghostLines.matrix.copy(previewMatrix);
    ghostMesh.matrixWorldNeedsUpdate = true;
    ghostLines.matrixWorldNeedsUpdate = true;
    ghostMesh.visible = true;
    ghostLines.visible = true;
    const col = previewValid ? GHOST_OK : GHOST_BAD;
    ghostUniforms.uColor.value.copy(col);
    ghostLineMaterial.color.copy(col);
    ghostLineMaterial.opacity = previewValid ? 0.95 : 0.8;
  }

  /* -------------------------------------------------------------- helpers */

  function cycleMaterial(dir = 1): void {
    const order: HarvestKind[] = ["wood", "stone", "metal"];
    const i = order.indexOf(service.material);
    service.material = order[(i + (dir > 0 ? 1 : 2)) % 3];
    ghostGeoKey = ""; // force a rebake so the ghost wears the new family
    ctx.services.audio?.play("build-swap", { volume: 0.45 });
  }

  /** Is the player holding the pickaxe (and therefore able to harvest)? */
  function pickaxeReady(): boolean {
    if (ctx.input.buildKind) return false;
    const inv = ctx.services.inventory as InventoryService | undefined;
    if (!inv) return true;
    const active = inv.active;
    // Slot 0 is the pickaxe by contract. Treat an empty slot 0 as the pickaxe
    // too — an inventory that failed to seed its loadout must not cost the
    // player the ability to gather.
    if (active) return active.kind === "pickaxe";
    return inv.activeSlot === 0;
  }

  /* ---------------------------------------------------------------- fixed */

  function fixed(dt: number): void {
    now += dt;
    if (placeCooldown > 0) placeCooldown -= dt;

    const input = ctx.input;

    // --- edge-triggered input, consumed exactly once per frame ------------
    if (!latchRotate && input.rotate) {
      latchRotate = true;
      rotOffset = (rotOffset + 1) & 3;
      ghostPop = 1;
      ctx.services.audio?.play("build-rotate", { volume: 0.45 });
    }
    if (!latchCycle && input.pressed.has("KeyT")) {
      latchCycle = true;
      cycleMaterial(1);
    }
    if (!latchToggle && input.pressed.has("KeyB")) {
      latchToggle = true;
      service.selected = input.buildKind ? null : lastKind;
    }
    if (!latchReset && input.pressed.has("KeyR")) latchReset = true;
    if (!firePressedEdge && input.fire && !prevFire) firePressedEdge = true;

    // KeyG is shared with inventory's "drop the active item" (see the report
    // note). Editing only claims it when the crosshair is genuinely on one of
    // your own pieces, which is exactly when you would never mean to drop.
    if (!latchEdit && (input.pressed.has("KeyG") || input.drop)) {
      latchEdit = true;
      if (editPiece) applyEdit();
      else if (input.locked) enterEdit();
    }

    // --- structural integrity --------------------------------------------
    if (structureDirty) {
      structureDirty = false;
      rebuildSupport();
    }
    stepCollapse();

    // --- build-up ---------------------------------------------------------
    if (animating.size > 0) {
      for (const p of animating) {
        let live = false;
        if (p.age < BUILD_TIME) {
          p.age = Math.min(BUILD_TIME, p.age + dt);
          p.hp = curveHp(p) - p.damage;
          if (p.age >= BUILD_TIME) p.complete = true;
          // The visible growth is applied in `Batch.write` off `age`, so this
          // loop only has to keep `age` moving.
          live = true;
        }
        if (p.flash > 0) {
          p.flash = Math.max(0, p.flash - dt * 4.5);
          live = true;
        }
        if (p.hp <= 0) {
          // Shot to bits before it finished. Deleting the current element of a
          // Set mid-iteration is defined behaviour, and `destroyPiece` only
          // ever removes from `animating`, never adds.
          destroyPiece(p);
          continue;
        }
        p.batch?.write(p.index);
        if (!live) animating.delete(p);
      }
    }

    // --- preview / place / edit / harvest ---------------------------------
    updatePreview();
    if (editPiece) {
      // `updatePreview` bails out while editing, so the ghost would otherwise
      // stay frozen on screen wherever it was when edit mode opened.
      ghostMesh.visible = false;
      ghostLines.visible = false;
      updateEdit();
    } else {
      refreshGhost();
      if (input.fire && ctx.services.player?.controllable && input.buildKind) {
        tryPlace(firePressedEdge);
      }
    }

    // --- pickaxe ----------------------------------------------------------
    if (swingTimer > 0) swingTimer -= dt;
    if (swingImpactAt >= 0 && now >= swingImpactAt) {
      swingImpactAt = -1;
      swingPickaxe();
    }
    if (input.fire && swingTimer <= 0 && !editPiece && pickaxeReady() && ctx.services.player?.controllable) {
      swingTimer = SWING_INTERVAL;
      swingImpactAt = now + SWING_IMPACT;
      ctx.emit("dz:pickaxe", { at: now });
      ctx.services.audio?.play("pickaxe-swing", { volume: 0.5 });
    }
  }

  /* --------------------------------------------------------------- update */

  function update(dt: number): void {
    // Clearing the latches here — after every fixed step of this frame has run
    // and before the engine wipes `pressed` — is what makes consuming edges in
    // fixed() exactly-once. See note 1 in the header.
    latchRotate = false;
    latchEdit = false;
    latchCycle = false;
    latchToggle = false;
    latchReset = false;
    firePressedEdge = false;
    prevFire = ctx.input.fire;

    ghostUniforms.uTime.value = ctx.elapsed;
    ghostPop = Math.max(0, ghostPop - dt * 7);
    ghostUniforms.uPop.value = ghostPop * ghostPop;
    weakUniforms.uTime.value = ctx.elapsed;

    // --- weak point marker -------------------------------------------------
    const showWeak = !!weak && weak.expires > now && !ctx.input.buildKind;
    if (showWeak && weak) {
      const remain = weak.expires - now;
      weakUniforms.uFade.value = clamp01(remain * 2.2) * clamp01((WEAK_LIFETIME - remain) * 6);
      weakMesh.position.copy(weak.point);
      // Face the surface, not the camera: a decal that swims as you strafe
      // reads as UI stuck to the screen rather than a spot on the tree.
      _tmp.copy(weak.point).add(weak.normal);
      weakMesh.lookAt(_tmp);
      weakMesh.visible = true;
    } else {
      weakMesh.visible = false;
      if (weak && weak.expires <= now) weak = null;
    }

    for (const b of batches.values()) b.refitBounds();

    // The HUD reads engine events only, so everything it needs about building
    // goes out here rather than through a reach into this system.
    const inv = ctx.services.inventory;
    ctx.emit("dz:build", {
      kind: ctx.input.buildKind,
      material: service.material,
      editing: editPiece !== null,
      canPlace: previewValid,
      reason: validity.reason,
      pieces: pieceCount,
      wood: inv?.wood ?? 0,
      stone: inv?.stone ?? 0,
      metal: inv?.metal ?? 0,
      cost: PIECE_COST,
    });
  }

  /* --------------------------------------------------------------- system */

  interface FixedSystem extends System {
    fixed(dt: number, ctx: WorldCtx): void;
  }

  const sys: FixedSystem = {
    name: "building",
    fixed(dt) {
      if (disposed) return;
      fixed(dt);
    },
    update(dt) {
      if (disposed) return;
      update(dt);
    },
    dispose() {
      disposed = true;

      // Colliders first: a piece whose mesh is gone but whose box is still in
      // the broadphase is an invisible wall in the *next* world the visitor
      // opens, because nothing else ever removes it.
      for (const p of pieces.values()) clearColliders(p);
      pieces.clear();
      cellIndex.clear();
      nodeIndex.clear();
      animating.clear();
      falling.length = 0;
      supported.clear();
      pieceCount = 0;

      for (const b of batches.values()) b.dispose();
      batches.clear();
      // Batch meshes clone their geometry; these are the originals the cache
      // owns and nobody else will free them.
      for (const g of geoCache.values()) g.dispose();
      geoCache.clear();
      // Our materials, but NOT their maps — those belong to the material
      // library and disposing them here would blank every wall on the island.
      for (const m of familyMaterials.values()) m.dispose();
      familyMaterials.clear();

      for (const g of ghostCache.values()) {
        g.geo.dispose();
        g.edges.dispose();
      }
      ghostCache.clear();
      ghostMesh.geometry = emptyGeo;
      ghostLines.geometry = emptyGeo;
      ghostMaterial.dispose();
      ghostLineMaterial.dispose();
      editOutline.geometry = emptyGeo;
      editOutlineGeo?.dispose();
      editOutlineGeo = null;
      editOutlineMaterial.dispose();
      editGeo.dispose();
      editMaterial.dispose();
      weakGeo.dispose();
      weakMaterial.dispose();
      weak = null;
      // Last, once every object that could still be pointing at it has been
      // repointed — the ghost, the outline and the edit overlay all park here.
      emptyGeo.dispose();

      root.removeFromParent();
      root.clear();

      if (ctx.services.build === service) ctx.services.build = undefined;
    },
  };

  return sys;
};

export default createBuilding;
