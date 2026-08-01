/**
 * DROP ZERO — the named districts.
 *
 * This is the module a screenshot is *of*. Everything else on the island is
 * ground, sky and atmosphere; the POIs are the thing a player names when they
 * call a drop, and the thing a critic looks at hardest. So it is built the way
 * an art team would build it rather than the way a demo would: a modular kit
 * with real thickness, composed procedurally, merged per material, and given a
 * per-district colour identity strong enough to read from the bus at 300 m.
 *
 * Four pieces, in dependency order:
 *
 *  1. THE GEOMETRY KIT (`Geo`, `bevelBox`, `prism`, `tube`, …). Every piece of
 *     architecture in this file is authored as a chamfered solid, never as a
 *     quad. The chamfer is 3–6 cm and it is the single highest-value detail in
 *     the module: a bevel catches the key light along every edge, which is what
 *     stops a building reading as coloured cardboard. UVs are assigned in
 *     WORLD space by dominant normal axis, so brick courses and plank lines run
 *     continuously across two boxes that happen to be flush — the tell of a
 *     cheap kit is a texture that restarts at every seam.
 *
 *  2. THE ARCHITECTURAL KIT (`wall`, `floorSlab`, `gableRoof`, `stairs`,
 *     `awning`, `gutter`, `acUnit`, …). Walls take real openings: a window is a
 *     hole with jambs, a lintel, a recessed frame, a glass pane set back 8 cm
 *     and a sill that projects and drips. Roofs have OVERHANGING EAVES and a
 *     fascia board, because an eave is what casts the shadow line that says
 *     "roof". Nothing in the kit is a single quad.
 *
 *  3. THE DISTRICTS. Ten of them, on the flat pads terrain reserves. Each has
 *     a palette (roof / wall / trim / accent), a harvest material, a silhouette
 *     rule and at least one landmark form — the clock tower, the grain silo,
 *     the gantry crane, the dish. Neon Heights is the marquee: three-storey
 *     shophouses around a plaza, all of them enterable, with interior floors
 *     and stairwells, because a town of sealed boxes is not a battle royale.
 *
 *  4. THE ROADS. A hand-authored adjacency between districts, splined,
 *     conformed to the terrain with a longitudinal smooth and a retaining
 *     skirt on the downhill side, with painted edge lines and centre dashes.
 *     Roads are what make a map read as designed rather than generated.
 *
 * Reads, all lazily and all null-checked: `materials` (every surface),
 * `terrain` (seating — with a working fallback if it failed to boot),
 * `collision` (every wall, floor and roof is registered, with the right
 * harvest kind, because harvestable geometry is how the build loop is fed).
 *
 * Publishes: `ctx.services.pois` — the `Poi[]` loot, bots and the map read.
 * It is published EMPTY at the top of the factory and filled in place, so a
 * later system that grabs the array reference during its own boot still sees
 * every district once we are done.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre. Every building is
 * axis-aligned and every floor lands on a multiple of `GRID`, because players
 * build off these surfaces and a ramp that does not meet a balcony is a bug
 * you feel in your hands.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  GRID,
  makeRng,
  type HarvestKind,
  type ImpactMaterial,
  type MaterialName,
  type MaterialsService,
  type Poi,
  type System,
  type SystemFactory,
  type QualityTier,
  type TerrainService,
  type WorldCtx,
} from "../types";

/* ------------------------------------------------------------------------ *
 * Contract shims
 *
 * Two things this module needs are not in `types.ts`, and `types.ts` is not
 * ours to edit while nine other systems are compiling against it. Both are
 * read structurally off the service objects, and both degrade to a working
 * fallback when absent.
 * ------------------------------------------------------------------------ */

/** `terrain.pads` — grid-aligned flat ground reserved for a district. */
interface PadLike {
  id: string;
  name: string;
  center: THREE.Vector3;
  radius: number;
  elevation: number;
}

/** The extras terrain publishes beyond `TerrainService`. All optional here. */
type TerrainLike = TerrainService & {
  pads?: readonly PadLike[];
  slopeAt?(x: number, z: number): number;
  coastDistanceAt?(x: number, z: number): number;
};

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

interface PoiTier {
  /** Edge chamfer, metres. Zero on `low` — 3.7× the triangles is real money. */
  bevel: number;
  /** Interior floors, stairwells and second storeys. */
  interiors: boolean;
  /** The expensive trim pass: gutters, vents, AC units, signage, kerb detail. */
  trim: boolean;
  /** Multiplier on scattered prop counts. */
  props: number;
  /** Buildings in the marquee town. */
  townBuildings: number;
  /** Metres between road spline stations. Lower = smoother terrain conform. */
  roadStep: number;
  /** Radial segments on pipes, silos, tanks. */
  round: number;
}

const TIERS: Record<QualityTier, PoiTier> = {
  low: { bevel: 0, interiors: false, trim: false, props: 0.35, townBuildings: 16, roadStep: 18, round: 8 },
  medium: { bevel: 0.035, interiors: true, trim: true, props: 0.7, townBuildings: 24, roadStep: 13, round: 10 },
  high: { bevel: 0.045, interiors: true, trim: true, props: 1.0, townBuildings: 32, roadStep: 10, round: 14 },
  ultra: { bevel: 0.055, interiors: true, trim: true, props: 1.3, townBuildings: 38, roadStep: 8, round: 20 },
};

/**
 * World metres per UV repeat, mirroring `SPEC[].metres` in materials.ts.
 * Duplicated rather than imported on purpose: systems in this engine do not
 * import each other, and a wrong number here costs texture density, not a
 * crash. Keep it in step if the material bakery is re-tuned.
 */
const TILE: Record<MaterialName, number> = {
  plaster: 3.2,
  brick: 2.4,
  woodPlank: 2.6,
  woodLog: 2.0,
  concrete: 3.6,
  asphalt: 5.0,
  metalPanel: 2.8,
  corrugated: 3.0,
  roofTile: 2.6,
  roofShingle: 3.0,
  glass: 2.0,
  rock: 4.5,
  dirt: 4.0,
  sand: 4.0,
  grass: 3.0,
  foliage: 1.0,
  bark: 2.2,
  fabric: 2.0,
  gold: 1.2,
  rubber: 1.4,
};

/** Impact family per material, mirroring materials.ts. Drives footsteps/decals. */
const IMPACT: Record<MaterialName, ImpactMaterial> = {
  plaster: "concrete",
  brick: "concrete",
  woodPlank: "wood",
  woodLog: "wood",
  concrete: "concrete",
  asphalt: "concrete",
  metalPanel: "metal",
  corrugated: "metal",
  roofTile: "concrete",
  roofShingle: "concrete",
  glass: "glass",
  rock: "concrete",
  dirt: "dirt",
  sand: "sand",
  grass: "grass",
  foliage: "grass",
  bark: "wood",
  fabric: "dirt",
  gold: "metal",
  rubber: "dirt",
};

/**
 * Floor-to-floor, exactly one grid cell. Generous for a shop but non-negotiable:
 * a player who ramps up the outside of a building has to arrive level with the
 * balcony, and that only happens if the world's floors sit on the same lattice
 * the build system snaps to.
 */
const FLOOR_H = GRID;
/** Structural wall thickness for world buildings. Reads heavier than a built wall. */
const WALL_T = 0.34;
/** Floor slab thickness. */
const SLAB_T = 0.36;
/** How far glass sits behind the face of a wall. The shadow this throws is the
 *  whole reason a window reads as a window and not a blue sticker. */
const GLASS_INSET = 0.14;

/* ------------------------------------------------------------------------ *
 * Small maths
 * ------------------------------------------------------------------------ */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const snap = (v: number, g = GRID) => Math.round(v / g) * g;

/** Deterministic pick from a table. */
function pick<T>(list: readonly T[], rng: () => number): T {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

/* ------------------------------------------------------------------------ *
 * Surfaces
 *
 * A `Surf` is a material name plus a tint. It resolves through
 * `materials.tinted()`, which caches by name+hex — so a district with forty
 * terracotta roofs pays for exactly one material, not forty.
 * ------------------------------------------------------------------------ */

interface Surf {
  name: MaterialName;
  color: number;
}

const surf = (name: MaterialName, color = 0xffffff): Surf => ({ name, color });
const surfKey = (s: Surf) => `${s.name}|${s.color.toString(16)}`;

/**
 * A district's colour identity. This is the single most important thing in the
 * module for map legibility: from the bus you cannot read a shape, you can only
 * read a roof colour, so every district commits to one and repeats it.
 */
interface Palette {
  /** The roof. The 300 m read. */
  roof: number;
  /** Roof material — tile for the town, corrugated for industry, shingle for farms. */
  roofMat: MaterialName;
  /** Wall body. */
  wall: number;
  wallMat: MaterialName;
  /** A second wall colour so a street is not monochrome. */
  wallAlt: number;
  /** Trim: fascia, frames, railings, kerbs. Usually near-white or near-black. */
  trim: number;
  /** The saturated accent — awnings, signage, doors, machinery. */
  accent: number;
  /** Second accent, used sparingly. */
  accent2: number;
  /** What the pickaxe gets out of this district's structures. */
  harvest: HarvestKind;
}

/* ------------------------------------------------------------------------ *
 * The geometry kit
 *
 * Everything below emits into a `Geo`, which is a plain triangle soup with
 * auto-oriented winding. Nothing here allocates a THREE object until
 * `toGeometry`, and every result is indexed with exactly
 * position/normal/uv — `mergeGeometries` refuses to merge geometries whose
 * attribute sets differ, and one stray tangent attribute would silently drop a
 * whole district on the floor.
 * ------------------------------------------------------------------------ */

/**
 * UV mode. `world` projects by dominant normal axis, `metre` means the author
 * wrote arc-length/along-length coordinates, and `raw` means the values are
 * already final — which is what an accumulator buffer holds once each part has
 * been resolved into it.
 */
type UvMode = "world" | "metre" | "raw";

class Geo {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];
  uvMode: UvMode = "world";
  private count = 0;

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    return this.count++;
  }

  /**
   * A triangle, wound so it faces `n`. Auto-orienting costs one cross product
   * per face and buys the right to author every piece of the kit by listing
   * corners in whatever order reads clearly, which is worth far more.
   */
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

  /** A planar quad, corners in ring order. Winding is fixed up against `n`. */
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

  /** Bake. `m` is applied first, so world-space UVs see final positions. */
  toGeometry(tile: number, m?: THREE.Matrix4): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    if (m) g.applyMatrix4(m);
    if (this.uvMode === "world") worldUv(g, tile);
    else if (this.uvMode === "metre") scaleUv(g, 1 / tile);
    return g;
  }
}

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * Resolve one authored part into an accumulator: transform it, settle its UVs
 * for good, and append.
 *
 * This exists because the first cut of this module allocated a
 * `THREE.BufferGeometry` per box and leaned on `mergeGeometries` to put ~70 000
 * of them back together. That works and it is unusably slow — several seconds
 * of boot and a GC storm. Parts now land straight in a plain array and only
 * whole CHUNKS ever become geometries, which is what `mergeGeometries` then
 * stitches at flush time.
 *
 * `transformDirection` is correct for the normal here because every matrix this
 * module builds is a rotation plus a translation. Anything scaled goes through
 * `inst()`, where the instance matrix does the work on the GPU.
 */
function appendPart(dst: Geo, src: Geo, m: THREE.Matrix4 | undefined, tile: number): void {
  const base = dst.pos.length / 3;
  const inv = 1 / tile;
  const world = src.uvMode === "world";
  for (let i = 0, j = 0; i < src.pos.length; i += 3, j += 2) {
    _p.set(src.pos[i], src.pos[i + 1], src.pos[i + 2]);
    _n.set(src.nor[i], src.nor[i + 1], src.nor[i + 2]);
    if (m) {
      _p.applyMatrix4(m);
      _n.transformDirection(m);
    }
    dst.pos.push(_p.x, _p.y, _p.z);
    dst.nor.push(_n.x, _n.y, _n.z);
    if (world) {
      const ax = Math.abs(_n.x), ay = Math.abs(_n.y), az = Math.abs(_n.z);
      if (ay >= ax && ay >= az) dst.uv.push(_p.x * inv, _p.z * inv);
      else if (ax >= az) dst.uv.push(_p.z * inv, _p.y * inv);
      else dst.uv.push(_p.x * inv, _p.y * inv);
    } else {
      dst.uv.push(src.uv[j] * inv, src.uv[j + 1] * inv);
    }
  }
  const idx = src.idx;
  for (let i = 0; i < idx.length; i++) dst.idx.push(idx[i] + base);
}

/**
 * World-space triplanar-by-dominant-axis UVs.
 *
 * Why not per-face 0..1 UVs: two boxes butted together get independent UV
 * islands, so the brick courses jump at the seam and the eye reads "kit". This
 * projects from world position, so a pier, a lintel and the wall beside them
 * share one continuous course. It is also why the whole module can place
 * geometry freely without ever thinking about texture layout.
 */
function worldUv(g: THREE.BufferGeometry, tile: number): void {
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  const n = g.getAttribute("normal") as THREE.BufferAttribute;
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const inv = 1 / tile;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i)), nz = Math.abs(n.getZ(i));
    if (ny >= nx && ny >= nz) uv.setXY(i, x * inv, z * inv);
    else if (nx >= nz) uv.setXY(i, z * inv, y * inv);
    else uv.setXY(i, x * inv, y * inv);
  }
  uv.needsUpdate = true;
}

/** Metre-authored UVs (cylinders, ribbons) scaled into tile space. */
function scaleUv(g: THREE.BufferGeometry, s: number): void {
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s);
  uv.needsUpdate = true;
}

/** Face mask bits for `bevelBox`. Dropping a hidden face is free triangles. */
const F_PX = 1, F_NX = 2, F_PY = 4, F_NY = 8, F_PZ = 16, F_NZ = 32;
const F_ALL = 63;
/** Everything but the underside — the common case for anything sitting on ground. */
const F_NO_BOTTOM = F_ALL & ~F_NY;

/**
 * A chamfered box: six inset faces, twelve edge chamfers, eight corner
 * triangles.
 *
 * The chamfer is the reason this function exists. A hard 90° edge between two
 * faces of the same material produces a single hard value step and reads as
 * paper; a 4 cm chamfer produces a bright sliver under a directional key and
 * reads as a solid object with mass. It costs 44 triangles instead of 12,
 * which is why `low` sets bevel to zero and takes the plain box.
 */
function bevelBox(hx: number, hy: number, hz: number, bevel: number, mask = F_ALL): Geo {
  const g = new Geo();
  const h = [hx, hy, hz];
  let b = Math.max(0, Math.min(bevel, hx * 0.45, hy * 0.45, hz * 0.45));
  // Below ~1 cm the chamfer is sub-pixel at any distance you would ever see the
  // piece from, and it costs 4× the vertices. Drop it.
  if (b < 0.01) b = 0;
  const p = [0, 0, 0];
  const q = [0, 0, 0];
  const r = [0, 0, 0];
  const s = [0, 0, 0];

  // --- the six faces ---
  const bits = [F_PX, F_NX, F_PY, F_NY, F_PZ, F_NZ];
  for (let a = 0; a < 3; a++) {
    for (let si = 0; si < 2; si++) {
      const sgn = si === 0 ? 1 : -1;
      if ((mask & bits[a * 2 + si]) === 0) continue;
      const u = (a + 1) % 3;
      const v = (a + 2) % 3;
      const corners: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      const pts: number[][] = corners.map(([cu, cv]) => {
        const out = [0, 0, 0];
        out[a] = sgn * h[a];
        out[u] = cu * (h[u] - b);
        out[v] = cv * (h[v] - b);
        return out;
      });
      const n = [0, 0, 0];
      n[a] = sgn;
      g.quad(
        pts[0][0], pts[0][1], pts[0][2],
        pts[1][0], pts[1][1], pts[1][2],
        pts[2][0], pts[2][1], pts[2][2],
        pts[3][0], pts[3][1], pts[3][2],
        n[0], n[1], n[2],
      );
    }
  }
  if (b <= 1e-5) return g;

  // --- twelve edge chamfers ---
  for (let a = 0; a < 3; a++) {
    for (let bb = a + 1; bb < 3; bb++) {
      const c = 3 - a - bb;
      for (let sa = -1; sa <= 1; sa += 2) {
        for (let sb = -1; sb <= 1; sb += 2) {
          for (let k = 0; k < 3; k++) { p[k] = 0; q[k] = 0; r[k] = 0; s[k] = 0; }
          p[a] = sa * h[a]; p[bb] = sb * (h[bb] - b); p[c] = -(h[c] - b);
          q[a] = sa * h[a]; q[bb] = sb * (h[bb] - b); q[c] = h[c] - b;
          r[a] = sa * (h[a] - b); r[bb] = sb * h[bb]; r[c] = h[c] - b;
          s[a] = sa * (h[a] - b); s[bb] = sb * h[bb]; s[c] = -(h[c] - b);
          const n = [0, 0, 0];
          n[a] = sa * Math.SQRT1_2;
          n[bb] = sb * Math.SQRT1_2;
          g.quad(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2], s[0], s[1], s[2], n[0], n[1], n[2]);
        }
      }
    }
  }

  // --- eight corner triangles ---
  const k = 1 / Math.sqrt(3);
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        g.tri(
          sx * hx, sy * (hy - b), sz * (hz - b),
          sx * (hx - b), sy * hy, sz * (hz - b),
          sx * (hx - b), sy * (hy - b), sz * hz,
          sx * k, sy * k, sz * k,
        );
      }
    }
  }
  return g;
}

/**
 * An extruded polygon. `outline` is a flat x,z ring (counter-clockwise in plan)
 * and the result is walls plus a fan-triangulated cap at each end. Convex only
 * — every caller here passes a convex outline, and a general tessellator is a
 * lot of code for a gable end.
 */
function prism(outline: readonly number[], y0: number, y1: number, cap = true): Geo {
  const g = new Geo();
  const n = outline.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = outline[i * 2], az = outline[i * 2 + 1];
    const j = (i + 1) % n;
    const bx = outline[j * 2], bz = outline[j * 2 + 1];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    // Outward normal for a CCW-in-plan ring viewed down +Y.
    const nx = dz / len, nz = -dx / len;
    g.quad(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az, nx, 0, nz);
  }
  if (cap) {
    for (let i = 1; i < n - 1; i++) {
      g.tri(
        outline[0], y1, outline[1],
        outline[i * 2], y1, outline[i * 2 + 1],
        outline[(i + 1) * 2], y1, outline[(i + 1) * 2 + 1],
        0, 1, 0,
      );
      g.tri(
        outline[0], y0, outline[1],
        outline[(i + 1) * 2], y0, outline[(i + 1) * 2 + 1],
        outline[i * 2], y0, outline[i * 2 + 1],
        0, -1, 0,
      );
    }
  }
  return g;
}

/**
 * A cylinder / truncated cone about +Y, with arc-length UVs.
 *
 * Authored rather than taken from `THREE.CylinderGeometry` for one reason:
 * the world-space UV projection everything else uses puts a visible pinch at
 * the 45° quadrant lines of a large silo. Arc-length U removes it, and a grain
 * silo is a 20 m landmark that gets looked at.
 */
function cylinder(rBottom: number, rTop: number, h: number, seg: number, capTop = true, capBottom = false): Geo {
  const g = new Geo();
  g.uvMode = "metre";
  const y0 = -h * 0.5, y1 = h * 0.5;
  const slope = (rBottom - rTop) / h;
  const nScale = 1 / Math.hypot(1, slope);
  const circ = Math.PI * 2 * Math.max(rBottom, rTop);
  for (let i = 0; i < seg; i++) {
    const t0 = (i / seg) * Math.PI * 2;
    const t1 = ((i + 1) / seg) * Math.PI * 2;
    const c0 = Math.cos(t0), s0 = Math.sin(t0);
    const c1 = Math.cos(t1), s1 = Math.sin(t1);
    const u0 = (i / seg) * circ, u1 = ((i + 1) / seg) * circ;
    // Flat-shaded per segment: chunky facets are the stylised-PBR read we want,
    // and they let the key light pick out every panel of a corrugated tank.
    const mc = Math.cos((t0 + t1) * 0.5), ms = Math.sin((t0 + t1) * 0.5);
    const nx = mc * nScale, ny = slope * nScale, nz = ms * nScale;
    const a = g.vert(c0 * rBottom, y0, s0 * rBottom, nx, ny, nz, u0, 0);
    const b = g.vert(c1 * rBottom, y0, s1 * rBottom, nx, ny, nz, u1, 0);
    const c = g.vert(c1 * rTop, y1, s1 * rTop, nx, ny, nz, u1, h);
    const d = g.vert(c0 * rTop, y1, s0 * rTop, nx, ny, nz, u0, h);
    g.idx.push(a, b, c, a, c, d);
    if (capTop && rTop > 1e-4) {
      const ct = g.vert(0, y1, 0, 0, 1, 0, 0, 0);
      const p0 = g.vert(c0 * rTop, y1, s0 * rTop, 0, 1, 0, c0 * rTop, s0 * rTop);
      const p1 = g.vert(c1 * rTop, y1, s1 * rTop, 0, 1, 0, c1 * rTop, s1 * rTop);
      g.idx.push(ct, p0, p1);
    }
    if (capBottom && rBottom > 1e-4) {
      const cb = g.vert(0, y0, 0, 0, -1, 0, 0, 0);
      const p0 = g.vert(c0 * rBottom, y0, s0 * rBottom, 0, -1, 0, c0 * rBottom, s0 * rBottom);
      const p1 = g.vert(c1 * rBottom, y0, s1 * rBottom, 0, -1, 0, c1 * rBottom, s1 * rBottom);
      g.idx.push(cb, p1, p0);
    }
  }
  return g;
}

/** A hemispherical dome cap about +Y. Silo tops, tank ends, the radio dish hub. */
function dome(r: number, h: number, seg: number, rings = 4): Geo {
  const g = new Geo();
  g.uvMode = "metre";
  const circ = Math.PI * 2 * r;
  for (let ri = 0; ri < rings; ri++) {
    const v0 = ri / rings, v1 = (ri + 1) / rings;
    const a0 = (v0 * Math.PI) / 2, a1 = (v1 * Math.PI) / 2;
    const r0 = Math.cos(a0) * r, r1 = Math.cos(a1) * r;
    const y0 = Math.sin(a0) * h, y1 = Math.sin(a1) * h;
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
      const u0 = (i / seg) * circ, u1 = ((i + 1) / seg) * circ;
      const mc = Math.cos((t0 + t1) * 0.5), ms = Math.sin((t0 + t1) * 0.5);
      const my = (y0 + y1) * 0.5, mr = (r0 + r1) * 0.5;
      const nl = Math.hypot(mr / r, my / h) || 1;
      const nx = (mc * (mr / r)) / nl, ny = my / h / nl, nz = (ms * (mr / r)) / nl;
      const p0 = g.vert(c0 * r0, y0, s0 * r0, nx, ny, nz, u0, v0 * h);
      const p1 = g.vert(c1 * r0, y0, s1 * r0, nx, ny, nz, u1, v0 * h);
      const p2 = g.vert(c1 * r1, y1, s1 * r1, nx, ny, nz, u1, v1 * h);
      const p3 = g.vert(c0 * r1, y1, s0 * r1, nx, ny, nz, u0, v1 * h);
      g.idx.push(p0, p1, p2, p0, p2, p3);
    }
  }
  return g;
}

/**
 * Turn a shell inside out. Used for the back of the radio dish: the materials
 * here are all `FrontSide`, so a one-sided parabola simply vanishes when you
 * walk behind it. Two shells 5 cm apart give it thickness instead.
 */
function flipFaces(g: Geo): void {
  for (let i = 0; i < g.idx.length; i += 3) {
    const t = g.idx[i + 1];
    g.idx[i + 1] = g.idx[i + 2];
    g.idx[i + 2] = t;
  }
  for (let i = 0; i < g.nor.length; i++) g.nor[i] = -g.nor[i];
}

/** Merge and dispose the parts. Everything in this module goes through here. */
function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  const merged = parts.length === 1 ? parts[0].clone() : mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) return null;
  merged.computeBoundingSphere();
  return merged;
}

/* ------------------------------------------------------------------------ *
 * The yard
 *
 * Everything the districts emit lands here. Static geometry is bucketed by
 * (merge group × surface) and merged at the end — a district is a handful of
 * draw calls, not one per shed. Repeated props go into instance buckets
 * shared across the whole island, so every crate on the map is one draw call.
 * Collision boxes are registered as they are authored, next to the geometry
 * they belong to, which is the only way they stay in step.
 * ------------------------------------------------------------------------ */

interface BoxOpts {
  /** Face mask — drop faces that are buried in another solid. */
  mask?: number;
  /** Override the tier bevel (0 for tiny trim that would vanish anyway). */
  bevel?: number;
  /** Yaw about +Y, radians. Non-zero means the collider is an approximation. */
  yaw?: number;
  /** Pitch about the local +X, radians. Roof slopes and ramps. */
  pitch?: number;
  /** Roll about the local +Z, radians. */
  roll?: number;
}

/** Build a transform. Allocates — everything in this module runs once, at boot. */
function xf(x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0): THREE.Matrix4 {
  const e = new THREE.Euler(pitch, yaw, roll, "YXZ");
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(e),
    new THREE.Vector3(1, 1, 1),
  );
}

interface InstanceBucket {
  surf: Surf;
  geo: THREE.BufferGeometry;
  ms: THREE.Matrix4[];
}

interface StaticBucket {
  surf: Surf;
  /** The open accumulator. Sealed into `chunks` when it gets big. */
  geo: Geo;
  chunks: THREE.BufferGeometry[];
}

/** Vertices per sealed chunk. Keeps the JS arrays small enough to stay fast. */
const CHUNK_VERTS = 60000;
/**
 * Anything thinner than this in every axis loses its chamfer. A 3 cm bevel on a
 * 4 cm window mullion is invisible and quadruples its vertex count, and the
 * module places tens of thousands of them.
 */
const BEVEL_MIN_HALF = 0.09;

class Yard {
  /** Merge group for everything emitted from here until it changes. */
  group = "world";
  bevel: number;

  private buckets = new Map<string, StaticBucket>();
  private insts = new Map<string, InstanceBucket>();
  private scratchBox = new THREE.Box3();
  readonly removers: Array<() => void> = [];
  /** Every geometry and material this yard owns, for teardown. */
  readonly owned: THREE.BufferGeometry[] = [];
  colliders = 0;

  constructor(
    private readonly materials: MaterialsService,
    private readonly collision: WorldCtx["services"]["collision"],
    bevel: number,
  ) {
    this.bevel = bevel;
  }

  private bucket(s: Surf): StaticBucket {
    const key = `${this.group}|${surfKey(s)}`;
    let b = this.buckets.get(key);
    if (!b) {
      const geo = new Geo();
      geo.uvMode = "raw";
      b = { surf: s, geo, chunks: [] };
      this.buckets.set(key, b);
    }
    return b;
  }

  /** A `Geo` resolved with the surface's tile density and an optional transform. */
  emit(s: Surf, g: Geo, m?: THREE.Matrix4): void {
    if (g.empty) return;
    const b = this.bucket(s);
    appendPart(b.geo, g, m, TILE[s.name]);
    if (b.geo.pos.length >= CHUNK_VERTS * 3) {
      b.chunks.push(b.geo.toGeometry(1));
      const geo = new Geo();
      geo.uvMode = "raw";
      b.geo = geo;
    }
  }

  /** The workhorse: a chamfered box at a world position. */
  box(
    s: Surf,
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    o: BoxOpts = {},
  ): void {
    if (hx <= 1e-4 || hy <= 1e-4 || hz <= 1e-4) return;
    // The size guard beats an explicit request: callers ask for a chamfer on
    // trim by habit, and on a 4 cm mullion it is invisible and quadruples the
    // vertex count of the most numerous piece in the module.
    const bev = Math.min(hx, hy, hz) < BEVEL_MIN_HALF ? 0 : o.bevel ?? this.bevel;
    const g = bevelBox(hx, hy, hz, bev, o.mask ?? F_ALL);
    this.emit(s, g, xf(cx, cy, cz, o.yaw ?? 0, o.pitch ?? 0, o.roll ?? 0));
  }

  /** A box that is also solid. The common case for structure. */
  solidBox(
    s: Surf,
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    harvest: HarvestKind | undefined,
    o: BoxOpts = {},
  ): void {
    this.box(s, cx, cy, cz, hx, hy, hz, o);
    this.solid(cx, cy, cz, hx, hy, hz, IMPACT[s.name], harvest);
  }

  /** Register a collider without any geometry (invisible blockers, roof caps). */
  solid(
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    material: ImpactMaterial,
    harvest?: HarvestKind,
    tag?: string,
  ): void {
    if (!this.collision) return;
    this.scratchBox.min.set(cx - hx, cy - hy, cz - hz);
    this.scratchBox.max.set(cx + hx, cy + hy, cz + hz);
    this.removers.push(this.collision.addBox(this.scratchBox, { material, harvest, tag }));
    this.colliders++;
  }

  /** A cylinder about +Y, optionally tipped. Pipes, silos, posts, tanks. */
  cyl(
    s: Surf,
    cx: number, cy: number, cz: number,
    rBottom: number, rTop: number, h: number,
    o: BoxOpts & { seg?: number; capTop?: boolean; capBottom?: boolean } = {},
  ): void {
    const g = cylinder(rBottom, rTop, h, o.seg ?? 10, o.capTop ?? true, o.capBottom ?? false);
    this.emit(s, g, xf(cx, cy, cz, o.yaw ?? 0, o.pitch ?? 0, o.roll ?? 0));
  }

  dome(s: Surf, cx: number, cy: number, cz: number, r: number, h: number, seg = 12, o: BoxOpts = {}): void {
    this.emit(s, dome(r, h, seg), xf(cx, cy, cz, o.yaw ?? 0, o.pitch ?? 0, o.roll ?? 0));
  }

  /**
   * A repeated prop. The prototype is built once, on first use — every later
   * call is a matrix push. This is the difference between 40 draw calls of
   * barrels and 400.
   */
  inst(key: string, s: Surf, proto: () => Geo, m: THREE.Matrix4): void {
    let b = this.insts.get(key);
    if (!b) {
      const g = proto();
      b = { surf: s, geo: g.toGeometry(TILE[s.name]), ms: [] };
      this.insts.set(key, b);
    }
    b.ms.push(m);
  }

  /** Bake every bucket into meshes under `root`. */
  flush(root: THREE.Object3D): void {
    for (const [key, b] of this.buckets) {
      if (!b.geo.empty) b.chunks.push(b.geo.toGeometry(1));
      const merged = mergeParts(b.chunks);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, this.materials.tinted(b.surf.name, b.surf.color));
      mesh.name = key;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Static for the whole match: let three skip the matrix update entirely.
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      root.add(mesh);
      this.owned.push(merged);
    }
    this.buckets.clear();

    for (const b of this.insts.values()) {
      if (b.ms.length === 0) {
        b.geo.dispose();
        continue;
      }
      const mesh = new THREE.InstancedMesh(b.geo, this.materials.tinted(b.surf.name, b.surf.color), b.ms.length);
      for (let i = 0; i < b.ms.length; i++) mesh.setMatrixAt(i, b.ms[i]);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.computeBoundingSphere();
      root.add(mesh);
      this.owned.push(b.geo);
    }
    this.insts.clear();
  }
}

/* ------------------------------------------------------------------------ *
 * The architectural kit
 *
 * Every function here is a building part with real thickness, a bevel and at
 * least one subordinate detail — a fascia on a roof, a sill under a window, a
 * coping on a parapet. That subordinate detail is where the AAA read lives:
 * the eye does not measure a wall, it measures the shadow the trim throws
 * across it.
 * ------------------------------------------------------------------------ */

type OpeningKind = "window" | "door" | "shopfront" | "hole";

interface Opening {
  /** Centre, in metres along the wall from its start corner. */
  u: number;
  w: number;
  /** Sill height above the wall base. A door is sill 0. */
  sill: number;
  h: number;
  kind: OpeningKind;
  /** Shutters/board-up for ruins and derelict sheds. */
  boarded?: boolean;
}

interface WallSpec {
  x0: number; z0: number; x1: number; z1: number;
  base: number;
  top: number;
  t?: number;
  body: Surf;
  trim: Surf;
  glass?: Surf;
  openings?: Opening[];
  harvest: HarvestKind;
  /** Height of a wider skirt at the base. Grounds the building; hides the seam. */
  plinth?: number;
  /** A projecting band at the top. The line that reads as "storey". */
  band?: boolean;
  /** Skip colliders — for a wall that is decorative infill inside another. */
  ghost?: boolean;
  /**
   * Which lateral direction faces the street: +1 or -1 along the wall's normal
   * axis. Decides which side gets the architrave and the door step.
   */
  outward?: number;
}

/**
 * A wall with real openings.
 *
 * The wall is cut into piers, sills and lintels around each opening and each
 * fragment is a solid with its own collider, so a doorway is a doorway to the
 * physics as well as to the eye. Each opening then gets:
 *   - a reveal (the lining of the hole, set back — this is what gives a window
 *     visible depth from an angle),
 *   - a projecting frame on the outer face with a mitred head,
 *   - a sill that oversails the wall face by 5 cm and throws a drip shadow,
 *   - glass 14 cm behind the face, with a mullion.
 */
function wall(y: Yard, spec: WallSpec): void {
  const t = spec.t ?? WALL_T;
  const alongX = Math.abs(spec.x1 - spec.x0) >= Math.abs(spec.z1 - spec.z0);
  const a0 = alongX ? Math.min(spec.x0, spec.x1) : Math.min(spec.z0, spec.z1);
  const a1 = alongX ? Math.max(spec.x0, spec.x1) : Math.max(spec.z0, spec.z1);
  const lat = alongX ? spec.z0 : spec.x0;
  const L = a1 - a0;
  if (L <= 0.05) return;
  const H = spec.top - spec.base;
  if (H <= 0.05) return;
  const ht = t * 0.5;

  /** Place a box in wall-local terms: centre along, half-length, y, half-height. */
  const put = (
    s: Surf,
    uc: number, hu: number,
    yc: number, hy: number,
    off = 0, hv = ht,
    o: BoxOpts = {},
    solid = false,
    harvest?: HarvestKind,
  ) => {
    if (hu <= 1e-3 || hy <= 1e-3) return;
    const x = alongX ? uc : lat + off;
    const z = alongX ? lat + off : uc;
    const hx = alongX ? hu : hv;
    const hz = alongX ? hv : hu;
    if (solid && !spec.ghost) y.solidBox(s, x, yc, z, hx, hy, hz, harvest, o);
    else y.box(s, x, yc, z, hx, hy, hz, o);
  };

  const ops = (spec.openings ?? []).slice().sort((p, q) => p.u - q.u);
  // Clip openings that a caller placed past the end of the wall — worldgen
  // trims wall lengths after the fact and a half-hanging window is ugly.
  const valid = ops.filter(
    (o) => o.u - o.w * 0.5 > 0.12 && o.u + o.w * 0.5 < L - 0.12 && o.sill + o.h < H - 0.12,
  );

  // --- piers between openings ---
  let cursor = 0;
  for (const o of valid) {
    const left = o.u - o.w * 0.5;
    if (left - cursor > 0.02) {
      put(spec.body, a0 + (cursor + left) * 0.5, (left - cursor) * 0.5, spec.base + H * 0.5, H * 0.5, 0, ht, {}, true, spec.harvest);
    }
    cursor = o.u + o.w * 0.5;
  }
  if (L - cursor > 0.02) {
    put(spec.body, a0 + (cursor + L) * 0.5, (L - cursor) * 0.5, spec.base + H * 0.5, H * 0.5, 0, ht, {}, true, spec.harvest);
  }

  // --- sill panels and lintels, plus the opening dressing ---
  for (const o of valid) {
    const uc = a0 + o.u;
    const hu = o.w * 0.5;
    const sy = spec.base + o.sill;
    const hy = spec.base + o.sill + o.h;

    if (o.sill > 0.02) {
      put(spec.body, uc, hu, spec.base + o.sill * 0.5, o.sill * 0.5, 0, ht, {}, true, spec.harvest);
    }
    const lint = spec.top - hy;
    if (lint > 0.02) {
      put(spec.body, uc, hu, hy + lint * 0.5, lint * 0.5, 0, ht, {}, true, spec.harvest);
    }

    // Reveal: a 6 cm lining set back into the hole on all four sides. Without
    // it the opening is a hole in a sheet of paper.
    const rv = 0.075;
    put(spec.trim, uc - hu + rv * 0.5, rv * 0.5, (sy + hy) * 0.5, o.h * 0.5, 0, ht * 0.72, { bevel: 0.02 });
    put(spec.trim, uc + hu - rv * 0.5, rv * 0.5, (sy + hy) * 0.5, o.h * 0.5, 0, ht * 0.72, { bevel: 0.02 });

    // Frame: proud of the OUTER face only. The inside of the opening already
    // has its reveal, and doubling the architrave inboard costs three boxes per
    // window across ten thousand windows for something nobody photographs.
    {
      const off = (spec.outward ?? 1) * (ht + 0.03);
      put(spec.trim, uc - hu - 0.05, 0.075, (sy + hy) * 0.5 + 0.05, o.h * 0.5 + 0.1, off, 0.045, { bevel: 0.02 });
      put(spec.trim, uc + hu + 0.05, 0.075, (sy + hy) * 0.5 + 0.05, o.h * 0.5 + 0.1, off, 0.045, { bevel: 0.02 });
      put(spec.trim, uc, hu + 0.13, hy + 0.075, 0.075, off, 0.055, { bevel: 0.02 });
    }

    if (o.kind === "window" || o.kind === "shopfront") {
      // Sill: oversails the face by 5 cm each side and is thicker than it needs
      // to be, which is exactly what a stone sill looks like.
      put(spec.trim, uc, hu + 0.16, sy - 0.055, 0.075, 0, ht + 0.06, { bevel: 0.025 });
      const outw = spec.outward ?? 1;
      if (o.boarded) {
        for (let i = 0; i < 3; i++) {
          const yy = lerp(sy + 0.25, hy - 0.25, i / 2);
          put(spec.trim, uc, hu - 0.02, yy, 0.09, 0, ht * 0.5, { bevel: 0.015, roll: (i - 1) * 0.045 });
        }
      } else if (spec.glass) {
        const gi = -outw * GLASS_INSET * 0.4;
        put(spec.glass, uc, hu - 0.06, (sy + hy) * 0.5, o.h * 0.5 - 0.06, gi, 0.02, { bevel: 0 });
        // One mullion and one transom: a pane with no divisions reads as a
        // rectangle of sky, not a window.
        put(spec.trim, uc, 0.035, (sy + hy) * 0.5, o.h * 0.5 - 0.06, gi, 0.045, { bevel: 0.012 });
      }
    } else if (o.kind === "door") {
      // The leaf sits recessed in the opening with a threshold and a handle.
      const leaf = surf("woodPlank", 0x6c452a);
      const outw = spec.outward ?? 1;
      put(leaf, uc, hu - 0.07, (sy + hy) * 0.5, o.h * 0.5 - 0.05, -outw * 0.06, 0.045, { bevel: 0.02 });
      put(spec.trim, uc, hu - 0.07, sy + 0.03, 0.03, 0, ht + 0.05, { bevel: 0.012 });
      put(spec.trim, uc + hu * 0.55, 0.055, sy + 1.05, 0.05, -outw * 0.115, 0.05, { bevel: 0.01 });
      // A step outside the door. Contact-point detail; you notice its absence.
      put(spec.trim, uc, hu + 0.18, sy - 0.075, 0.075, outw * (ht + 0.22), 0.26, { bevel: 0.03 });
    }
  }

  // --- plinth and band ---
  if (spec.plinth && spec.plinth > 0.02) {
    put(spec.trim, a0 + L * 0.5, L * 0.5 + 0.04, spec.base + spec.plinth * 0.5, spec.plinth * 0.5, 0, ht + 0.07, { bevel: 0.035 });
  }
  if (spec.band) {
    put(spec.trim, a0 + L * 0.5, L * 0.5 + 0.06, spec.top - 0.11, 0.085, 0, ht + 0.1, { bevel: 0.03 });
  }
}

/**
 * A floor slab, optionally with a rectangular void for a stairwell. The void
 * is what makes a building enterable in the vertical sense — a second storey
 * you cannot reach is set dressing.
 */
function floorSlab(
  y: Yard,
  x0: number, z0: number, x1: number, z1: number,
  top: number,
  s: Surf,
  harvest: HarvestKind,
  hole?: { x0: number; z0: number; x1: number; z1: number },
): void {
  const cy = top - SLAB_T * 0.5;
  const emit = (ax: number, az: number, bx: number, bz: number) => {
    const hx = (bx - ax) * 0.5, hz = (bz - az) * 0.5;
    if (hx <= 0.05 || hz <= 0.05) return;
    y.solidBox(s, ax + hx, cy, az + hz, hx, SLAB_T * 0.5, hz, harvest, { bevel: 0.03 });
  };
  if (!hole) {
    emit(x0, z0, x1, z1);
    return;
  }
  // Four bands around the void. Overlapping them at the corners would double
  // up colliders, so the north and south bands run the full width and the
  // east/west bands only span the void.
  emit(x0, z0, x1, hole.z0);
  emit(x0, hole.z1, x1, z1);
  emit(x0, hole.z0, hole.x0, hole.z1);
  emit(hole.x1, hole.z0, x1, hole.z1);
}

/**
 * A run of stairs. Treads are individual solids so the capsule walks them
 * naturally, plus a raking stringer under the nosings so it does not read as a
 * floating staircase from the side.
 */
function stairs(
  y: Yard,
  cx: number, cz: number,
  base: number, rise: number,
  width: number, run: number,
  dir: 0 | 1 | 2 | 3,
  s: Surf,
  trim: Surf,
  harvest: HarvestKind,
): void {
  const steps = Math.max(4, Math.round(rise / 0.22));
  const stepH = rise / steps;
  const stepD = run / steps;
  const alongX = dir === 0 || dir === 2;
  const sgn = dir === 0 || dir === 1 ? 1 : -1;
  for (let i = 0; i < steps; i++) {
    const d = (i + 0.5) * stepD * sgn;
    const yy = base + (i + 0.5) * stepH;
    const x = cx + (alongX ? d : 0);
    const z = cz + (alongX ? 0 : d);
    const hx = alongX ? stepD * 0.5 : width * 0.5;
    const hz = alongX ? width * 0.5 : stepD * 0.5;
    y.solidBox(s, x, yy, z, hx, stepH * 0.5, hz, harvest, { bevel: 0.02 });
    // Nosing: the 3 cm lip on the front of a tread. Pure trim, reads instantly.
    const nx = cx + (alongX ? d + stepD * 0.5 * sgn : 0);
    const nz = cz + (alongX ? 0 : d + stepD * 0.5 * sgn);
    y.box(trim, nx, base + (i + 1) * stepH - 0.02, nz,
      alongX ? 0.035 : width * 0.5, 0.025, alongX ? width * 0.5 : 0.035, { bevel: 0.012 });
  }
  // Raking stringers, one each side.
  const cxm = cx + (alongX ? run * 0.5 * sgn : 0);
  const czm = cz + (alongX ? 0 : run * 0.5 * sgn);
  const ang = Math.atan2(rise, run) * sgn;
  const len = Math.hypot(rise, run);
  for (const side of [-1, 1]) {
    const ox = alongX ? 0 : side * (width * 0.5 + 0.06);
    const oz = alongX ? side * (width * 0.5 + 0.06) : 0;
    y.box(trim, cxm + ox, base + rise * 0.5 - 0.14, czm + oz,
      alongX ? len * 0.5 : 0.06, 0.16, alongX ? 0.06 : len * 0.5,
      alongX ? { pitch: -ang } : { roll: ang, bevel: 0.02 });
  }
}

/** A railing: top rail, mid rail, balusters, end posts. Never a flat plane. */
function railing(
  y: Yard,
  x0: number, z0: number, x1: number, z1: number,
  base: number, h: number,
  s: Surf,
): void {
  const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
  const L = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
  if (L < 0.3) return;
  const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
  const hu = L * 0.5;
  const b = 0.018;
  y.box(s, cx, base + h, cz, alongX ? hu : 0.045, 0.035, alongX ? 0.045 : hu, { bevel: b });
  y.box(s, cx, base + h * 0.52, cz, alongX ? hu : 0.028, 0.024, alongX ? 0.028 : hu, { bevel: b });
  const posts = Math.max(2, Math.round(L / 0.85));
  for (let i = 0; i <= posts; i++) {
    const t = i / posts;
    const px = lerp(Math.min(x0, x1), Math.max(x0, x1), alongX ? t : 0.5);
    const pz = lerp(Math.min(z0, z1), Math.max(z0, z1), alongX ? 0.5 : t);
    const end = i === 0 || i === posts;
    const r = end ? 0.055 : 0.026;
    y.box(s, px, base + h * 0.5, pz, r, h * 0.5, r, { bevel: b });
  }
}

/** A triangular prism: the gable end, extruded along local X. */
function wedgeGeo(hx: number, hy: number, hz: number): Geo {
  const g = new Geo();
  for (const s of [1, -1]) {
    g.tri(s * hx, -hy, -hz, s * hx, -hy, hz, s * hx, hy, 0, s, 0, 0);
  }
  g.quad(-hx, -hy, -hz, hx, -hy, -hz, hx, -hy, hz, -hx, -hy, hz, 0, -1, 0);
  const sl = Math.hypot(hy, hz) || 1;
  g.quad(-hx, -hy, hz, hx, -hy, hz, hx, hy, 0, -hx, hy, 0, 0, hz / sl, hy / sl);
  g.quad(-hx, -hy, -hz, hx, -hy, -hz, hx, hy, 0, -hx, hy, 0, 0, hz / sl, -hy / sl);
  return g;
}

interface RoofSpec {
  cx: number; cz: number;
  /** Half extents of the wall box the roof sits on. */
  hx: number; hz: number;
  /** Eaves height. */
  base: number;
  rise: number;
  /** True when the ridge runs along +X. */
  ridgeX: boolean;
  overhang?: number;
  roof: Surf;
  trim: Surf;
  wall: Surf;
  harvest: HarvestKind;
  /** Emit the gable end walls. Off when another roof abuts. */
  ends?: boolean;
}

/**
 * A pitched roof with OVERHANGING EAVES.
 *
 * The overhang is not decoration. A roof flush with the wall below has no
 * shadow line at the top of the facade, and the building reads as an extruded
 * rectangle with a lid. The 0.55 m default throws a hard band across the top
 * of every wall on the sunward side and is the cheapest AAA tell in the file.
 * Under it: a soffit board, a fascia at the drip edge, and a ridge cap.
 */
function gableRoof(y: Yard, spec: RoofSpec): void {
  const o = spec.overhang ?? 0.55;
  const t = 0.24;
  const { cx, cz, base, rise, roof, trim } = spec;
  // Work in "along ridge" (u) / "across ridge" (v) terms and swap at the end.
  const hu = (spec.ridgeX ? spec.hx : spec.hz) + o;
  const hv = (spec.ridgeX ? spec.hz : spec.hx) + o;
  const theta = Math.atan2(rise, hv);
  const slope = Math.hypot(rise, hv);
  const cosT = Math.cos(theta), sinT = Math.sin(theta);

  for (const side of [1, -1]) {
    // The slab's surface normal after the transform is (side·sinθ, cosθ, 0) for
    // a Z-ridge and (0, cosθ, side·sinθ) for an X-ridge, so "side" picks which
    // half of the footprint this pitch covers and the t/2 nudge along that
    // normal lands the underside exactly on the eaves line.
    const my = base + rise * 0.5 + cosT * t * 0.5;
    const nOff = sinT * t * 0.5 * side;
    const px = cx + (spec.ridgeX ? 0 : side * hv * 0.5 + nOff);
    const pz = cz + (spec.ridgeX ? side * hv * 0.5 + nOff : 0);
    const m = spec.ridgeX
      ? xf(px, my, pz, 0, side * theta, 0)
      : xf(px, my, pz, Math.PI / 2, side * theta, 0);
    y.emit(roof, bevelBox(hu, t * 0.5, slope * 0.5, y.bevel), m);

    // Fascia: the vertical board at the drip edge, deeper than the roof slab so
    // it reads as a distinct element rather than as the slab's own edge.
    const fx = cx + (spec.ridgeX ? 0 : side * hv);
    const fz = cz + (spec.ridgeX ? side * hv : 0);
    y.box(trim, fx, base - 0.09, fz,
      spec.ridgeX ? hu + 0.04 : 0.075, 0.15, spec.ridgeX ? 0.075 : hu + 0.04, { bevel: 0.025 });

    // Soffit: closes the underside of the overhang. Without it you can see the
    // sky through the eaves from below, which looks exactly as bad as it sounds.
    const sx = cx + (spec.ridgeX ? 0 : side * (hv - o * 0.5));
    const sz = cz + (spec.ridgeX ? side * (hv - o * 0.5) : 0);
    y.box(trim, sx, base - 0.16, sz,
      spec.ridgeX ? hu : o * 0.5, 0.035, spec.ridgeX ? o * 0.5 : hu, { bevel: 0.015 });
  }

  // Ridge cap.
  y.box(trim, cx, base + rise + 0.06, cz,
    spec.ridgeX ? hu : 0.13, 0.08, spec.ridgeX ? 0.13 : hu, { bevel: 0.03 });

  // Gable ends.
  if (spec.ends !== false) {
    const ehu = (spec.ridgeX ? spec.hz : spec.hx);
    for (const side of [1, -1]) {
      const gx = spec.ridgeX ? cx + side * spec.hx : cx;
      const gz = spec.ridgeX ? cz : cz + side * spec.hz;
      const m = xf(gx, base + rise * 0.5, gz, spec.ridgeX ? Math.PI / 2 : 0);
      y.emit(spec.wall, wedgeGeo(WALL_T * 0.5, rise * 0.5, ehu), m);
    }
  }

  // One collider for the whole roof volume. Precise per-slope colliders would
  // let a player stand on a 30° pitch, which is not a thing this game wants.
  y.solid(cx, base + rise * 0.5, cz, spec.hx, rise * 0.5, spec.hz, IMPACT[roof.name], spec.harvest, "roof");
}

/** A flat roof: deck, parapet, coping, scupper. The town's shop blocks use it. */
function flatRoof(
  y: Yard,
  cx: number, cz: number, hx: number, hz: number,
  base: number,
  s: Surf, trim: Surf, harvest: HarvestKind,
  parapet = 0.72,
): void {
  y.solidBox(s, cx, base - 0.12, cz, hx, 0.12, hz, harvest, { bevel: 0.03 });
  for (const [ox, oz, ax, az] of [
    [0, hz, hx + 0.1, 0.11],
    [0, -hz, hx + 0.1, 0.11],
    [hx, 0, 0.11, hz + 0.1],
    [-hx, 0, 0.11, hz + 0.1],
  ]) {
    y.solidBox(s, cx + ox, base + parapet * 0.5, cz + oz, ax, parapet * 0.5, az, harvest, { bevel: 0.03 });
    // Coping: the capping stone. Oversails 4 cm each way and catches the sun.
    y.box(trim, cx + ox, base + parapet + 0.045, cz + oz, ax + 0.05, 0.05, az + 0.05, { bevel: 0.02 });
  }
  // A scupper and a stub of drainpipe, because a flat roof has to shed water.
  y.box(trim, cx + hx, base + 0.14, cz - hz * 0.5, 0.15, 0.07, 0.11, { bevel: 0.02 });
}

/**
 * A shopfront awning: a canted fabric slab, a front rail, two raking brackets
 * and a scalloped valance hanging off the front edge.
 */
function awning(
  y: Yard,
  x0: number, z0: number, x1: number, z1: number,
  top: number, depth: number,
  outX: number, outZ: number,
  cloth: Surf, frame: Surf,
): void {
  const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
  const L = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
  if (L < 0.8) return;
  const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
  const drop = 0.42;
  const ang = Math.atan2(drop, depth);
  const slope = Math.hypot(drop, depth);
  const m = alongX
    ? xf(cx, top - drop * 0.5, cz + outZ * depth * 0.5, 0, outZ * ang, 0)
    : xf(cx + outX * depth * 0.5, top - drop * 0.5, cz, Math.PI / 2, outX * ang, 0);
  y.emit(cloth, bevelBox(L * 0.5, 0.035, slope * 0.5, 0.02), m);
  // Front rail and valance.
  const fx = cx + outX * depth, fz = cz + outZ * depth;
  y.box(frame, fx, top - drop, fz, alongX ? L * 0.5 + 0.03 : 0.045, 0.045, alongX ? 0.045 : L * 0.5 + 0.03, { bevel: 0.015 });
  y.box(cloth, fx, top - drop - 0.15, fz, alongX ? L * 0.5 : 0.02, 0.15, alongX ? 0.02 : L * 0.5, { bevel: 0 });
  // Raking brackets at each end.
  for (const side of [-1, 1]) {
    const bx = cx + (alongX ? side * (L * 0.5 - 0.12) : outX * depth * 0.5);
    const bz = cz + (alongX ? outZ * depth * 0.5 : side * (L * 0.5 - 0.12));
    const bm = alongX
      ? xf(bx, top - drop * 0.5 + 0.06, bz, 0, outZ * ang, 0)
      : xf(bx, top - drop * 0.5 + 0.06, bz, Math.PI / 2, -outX * ang, 0);
    y.emit(frame, bevelBox(0.03, 0.05, slope * 0.5, 0.012), bm);
  }
}

/** Eaves gutter plus a downpipe with brackets. Pure trim; pure believability. */
function gutter(
  y: Yard,
  x0: number, z0: number, x1: number, z1: number,
  eaves: number, ground: number,
  s: Surf,
): void {
  const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
  const L = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
  if (L < 1) return;
  const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
  y.box(s, cx, eaves + 0.06, cz, alongX ? L * 0.5 : 0.075, 0.075, alongX ? 0.075 : L * 0.5, { bevel: 0.02 });
  const dx = alongX ? cx + L * 0.5 - 0.2 : cx;
  const dz = alongX ? cz : cz + L * 0.5 - 0.2;
  const h = Math.max(0.5, eaves - ground);
  y.cyl(s, dx, ground + h * 0.5, dz, 0.055, 0.055, h, { seg: 6, capTop: false });
  for (let i = 0; i < 3; i++) {
    const yy = ground + h * (0.2 + i * 0.32);
    y.box(s, dx, yy, dz, 0.085, 0.02, 0.085, { bevel: 0.008 });
  }
}

/** A chimney: shaft, corbelled cap, two pots. Reads at 300 m as a silhouette bump. */
function chimney(y: Yard, x: number, z: number, base: number, h: number, s: Surf, cap: Surf): void {
  y.solidBox(s, x, base + h * 0.5, z, 0.46, h * 0.5, 0.4, "stone", { bevel: 0.04 });
  y.box(cap, x, base + h + 0.07, z, 0.58, 0.08, 0.52, { bevel: 0.03 });
  y.box(cap, x, base + h + 0.19, z, 0.5, 0.05, 0.44, { bevel: 0.02 });
  for (const dx of [-0.16, 0.16]) {
    y.cyl(surf("brick", 0xb2653f), x + dx, base + h + 0.42, z, 0.09, 0.085, 0.4, { seg: 6 });
  }
}

/** A rooftop condenser: shell, louvres, fan grille, and a bent pipe into the roof. */
function acUnit(y: Yard, x: number, z: number, base: number, s: Surf, trim: Surf, yaw = 0): void {
  y.solidBox(s, x, base + 0.42, z, 0.62, 0.42, 0.48, "metal", { bevel: 0.035, yaw });
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  for (let i = 0; i < 4; i++) {
    const off = -0.28 + i * 0.19;
    y.box(trim, x + c * 0.5 - sn * off, base + 0.42 + 0.0, z + sn * 0.5 + c * off, 0.02, 0.34, 0.075, { bevel: 0.008, yaw });
  }
  y.cyl(trim, x, base + 0.86, z, 0.34, 0.34, 0.06, { seg: 10 });
  y.cyl(s, x, base + 0.9, z, 0.07, 0.07, 0.1, { seg: 6 });
  y.cyl(trim, x - c * 0.5, base + 0.2, z - sn * 0.5, 0.05, 0.05, 0.4, { seg: 6 });
}

/** A hooded wall vent. Two per building; nobody sees them and everybody feels them. */
function vent(y: Yard, x: number, z: number, yy: number, nx: number, nz: number, s: Surf): void {
  y.box(s, x + nx * 0.1, yy, z + nz * 0.1, nz !== 0 ? 0.3 : 0.11, 0.24, nz !== 0 ? 0.11 : 0.3, { bevel: 0.02 });
  for (let i = 0; i < 3; i++) {
    y.box(s, x + nx * 0.19, yy + 0.13 - i * 0.11, z + nz * 0.19,
      nz !== 0 ? 0.26 : 0.03, 0.028, nz !== 0 ? 0.03 : 0.26, { bevel: 0.006 });
  }
  y.box(s, x + nx * 0.21, yy + 0.28, z + nz * 0.21, nz !== 0 ? 0.34 : 0.09, 0.03, nz !== 0 ? 0.09 : 0.34, { bevel: 0.01 });
}

/**
 * A projecting shop sign on a bracket, with a small gooseneck lamp over it.
 * The accent colour lives here — one saturated rectangle per shopfront is what
 * gives a street its rhythm without repainting the buildings.
 */
function shopSign(
  y: Yard,
  x: number, z: number, yy: number,
  nx: number, nz: number,
  w: number,
  board: Surf, frame: Surf,
): void {
  const proj = 0.9;
  y.box(frame, x + nx * 0.16, yy, z + nz * 0.16, nz !== 0 ? 0.05 : 0.16, 0.05, nz !== 0 ? 0.16 : 0.05, { bevel: 0.012 });
  y.box(board, x + nx * proj, yy, z + nz * proj,
    nz !== 0 ? w * 0.5 : 0.055, 0.34, nz !== 0 ? 0.055 : w * 0.5, { bevel: 0.025 });
  y.box(frame, x + nx * proj, yy + 0.4, z + nz * proj,
    nz !== 0 ? w * 0.5 + 0.05 : 0.03, 0.03, nz !== 0 ? 0.03 : w * 0.5 + 0.05, { bevel: 0.008 });
  y.box(frame, x + nx * (proj * 0.55), yy + 0.62, z + nz * (proj * 0.55), 0.09, 0.06, 0.09, { bevel: 0.02 });
}

/** A run of pipe with flanges and a saddle support every few metres. */
function pipeRun(
  y: Yard,
  x0: number, z0: number, x1: number, z1: number,
  yy: number, r: number,
  s: Surf, trim: Surf, seg: number,
): void {
  const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
  const L = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
  if (L < 0.5) return;
  const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
  const rot: BoxOpts = alongX ? { roll: Math.PI / 2 } : { pitch: Math.PI / 2 };
  y.cyl(s, cx, yy, cz, r, r, L, { seg, capTop: false, ...rot });
  const flanges = Math.max(2, Math.round(L / 3.2));
  for (let i = 0; i <= flanges; i++) {
    const t = i / flanges;
    const px = alongX ? lerp(Math.min(x0, x1), Math.max(x0, x1), t) : cx;
    const pz = alongX ? cz : lerp(Math.min(z0, z1), Math.max(z0, z1), t);
    y.cyl(trim, px, yy, pz, r * 1.22, r * 1.22, 0.09, { seg, capTop: false, ...rot });
  }
  y.solid(cx, yy, cz, alongX ? L * 0.5 : r, r, alongX ? r : L * 0.5, "metal", "metal");
}

/** A caged ladder up the side of something industrial. */
function ladder(y: Yard, x: number, z: number, base: number, h: number, nx: number, nz: number, s: Surf): void {
  const side = 0.24;
  for (const sgn of [-1, 1]) {
    const ox = nz !== 0 ? sgn * side : 0;
    const oz = nz !== 0 ? 0 : sgn * side;
    y.box(s, x + ox, base + h * 0.5, z + oz, 0.035, h * 0.5, 0.035, { bevel: 0.01 });
  }
  const rungs = Math.max(3, Math.floor(h / 0.32));
  for (let i = 1; i < rungs; i++) {
    const yy = base + (i / rungs) * h;
    y.box(s, x, yy, z, nz !== 0 ? side : 0.024, 0.024, nz !== 0 ? 0.024 : side, { bevel: 0.006 });
  }
  // Hoop cage over the top two thirds.
  for (let i = 0; i < 5; i++) {
    const yy = base + h * (0.35 + i * 0.15);
    if (yy > base + h - 0.2) break;
    y.box(s, x + nx * 0.3, yy, z + nz * 0.3, nz !== 0 ? 0.34 : 0.03, 0.025, nz !== 0 ? 0.03 : 0.34, { bevel: 0.006 });
  }
}

/** A balcony: slab, two raking brackets, railing. Where players fight from. */
function balcony(
  y: Yard,
  cx: number, cz: number, hx: number, hz: number,
  top: number,
  s: Surf, trim: Surf, harvest: HarvestKind,
): void {
  y.solidBox(s, cx, top - 0.13, cz, hx, 0.13, hz, harvest, { bevel: 0.03 });
  railing(y, cx - hx, cz - hz, cx + hx, cz - hz, top, 1.05, trim);
  railing(y, cx - hx, cz + hz, cx + hx, cz + hz, top, 1.05, trim);
  railing(y, cx - hx, cz - hz, cx - hx, cz + hz, top, 1.05, trim);
  railing(y, cx + hx, cz - hz, cx + hx, cz + hz, top, 1.05, trim);
  for (const sgn of [-1, 1]) {
    y.box(trim, cx + sgn * (hx - 0.15), top - 0.5, cz, 0.06, 0.32, hz * 0.7, { bevel: 0.015, pitch: 0.5 });
  }
}

/* ------------------------------------------------------------------------ *
 * Instanced props
 *
 * Prototypes are authored with their base on y = 0 so a placement matrix is
 * just position + yaw. Every one of them has at least one subordinate part —
 * a rim on a barrel, a batten on a crate — because a plain box at 2 m reads as
 * placeholder art no matter how good the texture is.
 * ------------------------------------------------------------------------ */

function mergeGeo(into: Geo, from: Geo, m?: THREE.Matrix4): void {
  const base = into.pos.length / 3;
  if (!m) {
    for (const v of from.pos) into.pos.push(v);
    for (const v of from.nor) into.nor.push(v);
  } else {
    const nm = new THREE.Matrix3().setFromMatrix4(m).invert().transpose();
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i < from.pos.length; i += 3) {
      p.set(from.pos[i], from.pos[i + 1], from.pos[i + 2]).applyMatrix4(m);
      into.pos.push(p.x, p.y, p.z);
      n.set(from.nor[i], from.nor[i + 1], from.nor[i + 2]).applyMatrix3(nm).normalize();
      into.nor.push(n.x, n.y, n.z);
    }
  }
  for (const v of from.uv) into.uv.push(v);
  for (const i of from.idx) into.idx.push(i + base);
}

/** Shorthand: a bevelled box baked into a prototype at a local offset. */
function part(
  into: Geo,
  x: number, y: number, z: number,
  hx: number, hy: number, hz: number,
  bevel = 0.02,
  yaw = 0,
): void {
  mergeGeo(into, bevelBox(hx, hy, hz, bevel), xf(x, y, z, yaw));
}

function crateProto(): Geo {
  const g = new Geo();
  const s = 0.58;
  part(g, 0, s, 0, s, s, s, 0.03);
  // Corner battens and a diagonal brace: the difference between a crate and a
  // cube. Six extra boxes, and it survives being stood next to.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) part(g, sx * s, s, sz * s, 0.045, s, 0.045, 0.012);
  }
  part(g, 0, s * 1.55, 0, s + 0.02, 0.05, s + 0.02, 0.015);
  part(g, 0, s * 0.45, 0, s + 0.02, 0.05, s + 0.02, 0.015);
  return g;
}

function barrelProto(): Geo {
  const g = new Geo();
  mergeGeo(g, cylinder(0.34, 0.34, 0.92, 12, true, true), xf(0, 0.46, 0));
  for (const yy of [0.2, 0.46, 0.72]) {
    mergeGeo(g, cylinder(0.365, 0.365, 0.07, 12, false, false), xf(0, yy, 0));
  }
  mergeGeo(g, cylinder(0.1, 0.1, 0.05, 8, true, false), xf(0.16, 0.94, 0));
  return g;
}

function palletProto(): Geo {
  const g = new Geo();
  for (let i = 0; i < 3; i++) part(g, 0, 0.05, -0.5 + i * 0.5, 0.6, 0.05, 0.07, 0.01);
  for (let i = 0; i < 5; i++) part(g, -0.6 + i * 0.3, 0.13, 0, 0.055, 0.03, 0.6, 0.008);
  return g;
}

function sandbagProto(): Geo {
  const g = new Geo();
  for (let r = 0; r < 3; r++) {
    const n = 4 - r;
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * 0.46;
      // Heavy bevel: a sandbag is a box with all its edges rounded off.
      part(g, off + (r % 2) * 0.1, 0.13 + r * 0.24, 0, 0.24, 0.12, 0.17, 0.075, (r * 0.3 + i) * 0.08);
    }
  }
  return g;
}

function bollardProto(): Geo {
  const g = new Geo();
  mergeGeo(g, cylinder(0.13, 0.11, 0.95, 8, true, false), xf(0, 0.48, 0));
  mergeGeo(g, cylinder(0.17, 0.17, 0.09, 8, false, false), xf(0, 0.05, 0));
  mergeGeo(g, cylinder(0.12, 0.12, 0.05, 8, true, false), xf(0, 0.98, 0));
  return g;
}

function hedgeProto(): Geo {
  const g = new Geo();
  // Three stacked bevelled slabs of decreasing width: a clipped hedge has a
  // slight batter, and the stepped silhouette breaks the box read.
  part(g, 0, 0.35, 0, 1.5, 0.35, 0.62, 0.14);
  part(g, 0, 0.86, 0, 1.44, 0.2, 0.56, 0.16);
  part(g, 0, 1.12, 0, 1.32, 0.11, 0.48, 0.11);
  return g;
}

function tyreProto(): Geo {
  const g = new Geo();
  mergeGeo(g, cylinder(0.46, 0.46, 0.28, 12, true, true), xf(0, 0.15, 0));
  mergeGeo(g, cylinder(0.24, 0.24, 0.31, 10, true, true), xf(0, 0.15, 0));
  return g;
}

function containerProto(): Geo {
  const g = new Geo();
  const hx = 3.05, hy = 1.3, hz = 1.22;
  part(g, 0, hy, 0, hx, hy, hz, 0.05);
  // Corrugation ribs down both long sides, and the corner castings that make a
  // shipping container instantly recognisable from any distance.
  for (let i = 0; i < 17; i++) {
    const x = -hx + 0.2 + (i * (hx * 2 - 0.4)) / 16;
    for (const sz of [-1, 1]) part(g, x, hy, sz * (hz + 0.035), 0.07, hy - 0.14, 0.04, 0.012);
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (const sy of [0.13, 2 * hy - 0.13]) {
        part(g, sx * (hx - 0.13), sy, sz * (hz - 0.1), 0.15, 0.13, 0.14, 0.02);
      }
    }
  }
  // Door end: two leaves, four locking bars, a hinge stack.
  for (const sx of [-0.5, 0.5]) {
    part(g, hx + 0.03, hy, sx * hz * 0.5, 0.035, hy - 0.16, hz * 0.46, 0.015);
  }
  for (let i = 0; i < 4; i++) {
    part(g, hx + 0.075, hy, -hz * 0.8 + i * hz * 0.53, 0.03, hy - 0.2, 0.035, 0.008);
  }
  return g;
}

function fenceProto(): Geo {
  const g = new Geo();
  part(g, -1.9, 0.62, 0, 0.075, 0.62, 0.075, 0.015);
  part(g, 1.9, 0.62, 0, 0.075, 0.62, 0.075, 0.015);
  part(g, 0, 1.05, 0, 1.94, 0.075, 0.045, 0.012);
  part(g, 0, 0.62, 0, 1.94, 0.075, 0.045, 0.012);
  part(g, 0, 0.22, 0, 1.94, 0.06, 0.04, 0.012);
  return g;
}

function streetLampProto(): Geo {
  const g = new Geo();
  mergeGeo(g, cylinder(0.13, 0.09, 4.6, 8, false, false), xf(0, 2.3, 0));
  mergeGeo(g, cylinder(0.2, 0.2, 0.22, 8, true, false), xf(0, 0.11, 0));
  // A cranked arm rather than a straight mast: reads as street furniture, not
  // as a stick.
  part(g, 0.34, 4.62, 0, 0.42, 0.055, 0.055, 0.015);
  part(g, 0.72, 4.44, 0, 0.28, 0.11, 0.2, 0.05);
  return g;
}

function pylonProto(): Geo {
  const g = new Geo();
  mergeGeo(g, cylinder(0.22, 0.15, 8.4, 8, true, false), xf(0, 4.2, 0));
  part(g, 0, 7.7, 0, 1.55, 0.07, 0.09, 0.02);
  part(g, 0, 7.25, 0, 1.15, 0.06, 0.08, 0.02);
  for (const sx of [-1.4, -0.75, 0.75, 1.4]) part(g, sx, 7.86, 0, 0.05, 0.11, 0.05, 0.012);
  return g;
}

/* ------------------------------------------------------------------------ *
 * The building composer
 * ------------------------------------------------------------------------ */

interface BuildingSpec {
  cx: number; cz: number;
  hx: number; hz: number;
  base: number;
  floors: number;
  pal: Palette;
  rng: () => number;
  tier: PoiTier;
  roofKind: "gable" | "flat";
  /** Ground floor is retail: shopfront glazing, awning, projecting sign. */
  shop?: boolean;
  /** Which side the entrance is on: 0 = +Z, 1 = -Z, 2 = +X, 3 = -X. */
  front?: 0 | 1 | 2 | 3;
  /** Override the body colour (a street of identical walls is dead). */
  wallColor?: number;
  wallMat?: MaterialName;
  /** Ridge runs along X. Ignored for flat roofs. */
  ridgeX?: boolean;
  /** Cut the interior: floor slabs, stairwell, stairs, a partition. */
  interior?: boolean;
  /** A projecting balcony on the top storey of the front elevation. */
  balconyChance?: number;
}

/** Evenly spaced window bays for one wall of one storey. */
function bays(L: number, floor: number, shop: boolean, rng: () => number, doorAt: number | null): Opening[] {
  const out: Opening[] = [];
  // One bay per grid cell. Aligning the bay rhythm to GRID is not cosmetic:
  // a player who builds a wall against a facade lands between windows, not
  // through one.
  const n = Math.max(1, Math.round((L - 1.4) / GRID));
  if (n <= 0) return out;
  const pitch = L / n;
  for (let i = 0; i < n; i++) {
    const u = pitch * (i + 0.5);
    if (doorAt !== null && Math.abs(u - doorAt) < 1.5) continue;
    if (floor === 0 && shop) {
      out.push({ u, w: Math.min(2.7, pitch * 0.78), sill: 0.62, h: 2.35, kind: "shopfront" });
    } else {
      const w = Math.min(1.5, pitch * 0.44);
      out.push({ u, w, sill: 1.0, h: 1.85, kind: "window", boarded: rng() < 0.06 });
    }
  }
  if (doorAt !== null) out.push({ u: doorAt, w: 1.35, sill: 0, h: 2.35, kind: "door" });
  return out;
}

/**
 * One building, composed from the kit.
 *
 * Interiors are the point. Each storey gets a real floor slab with a stairwell
 * void, a flight of stairs up to it, and a partition with a doorway on the
 * ground floor — so a fight inside a shop in Neon Heights has geometry to use.
 * A district of sealed extrusions is a diorama, not a battle royale map.
 */
function building(y: Yard, spec: BuildingSpec): { top: number } {
  const { cx, cz, hx, hz, base, pal, rng, tier } = spec;
  const floors = Math.max(1, spec.floors);
  const wallMat = spec.wallMat ?? pal.wallMat;
  const body = surf(wallMat, spec.wallColor ?? pal.wall);
  const trim = surf("concrete", pal.trim);
  const glass = surf("glass", 0xdff2f7);
  const roofSurf = surf(pal.roofMat, pal.roof);
  const front = spec.front ?? 0;
  const interior = (spec.interior ?? true) && tier.interiors;
  const eaves = base + floors * FLOOR_H;

  // Wall centre-lines: outer faces land exactly on the footprint, so a player
  // building a wall against the facade is flush with it.
  const inset = WALL_T * 0.5;
  const sides: Array<{ x0: number; z0: number; x1: number; z1: number; len: number; id: number }> = [
    { x0: cx - hx, z0: cz + hz - inset, x1: cx + hx, z1: cz + hz - inset, len: hx * 2, id: 0 },
    { x0: cx - hx, z0: cz - hz + inset, x1: cx + hx, z1: cz - hz + inset, len: hx * 2, id: 1 },
    { x0: cx + hx - inset, z0: cz - hz, x1: cx + hx - inset, z1: cz + hz, len: hz * 2, id: 2 },
    { x0: cx - hx + inset, z0: cz - hz, x1: cx - hx + inset, z1: cz + hz, len: hz * 2, id: 3 },
  ];

  for (let f = 0; f < floors; f++) {
    const y0 = base + f * FLOOR_H;
    const y1 = y0 + FLOOR_H;
    for (const s of sides) {
      const isFront = s.id === front;
      const doorAt = f === 0 && isFront ? s.len * 0.5 : null;
      wall(y, {
        x0: s.x0, z0: s.z0, x1: s.x1, z1: s.z1,
        base: y0, top: y1,
        body, trim, glass,
        harvest: pal.harvest,
        openings: bays(s.len, f, !!spec.shop && isFront, rng, doorAt),
        outward: s.id === 0 || s.id === 2 ? 1 : -1,
        plinth: f === 0 ? 0.42 : 0,
        band: f < floors - 1,
      });
    }
  }

  // --- interior ---
  const ix0 = cx - hx + WALL_T, ix1 = cx + hx - WALL_T;
  const iz0 = cz - hz + WALL_T, iz1 = cz + hz - WALL_T;
  // Deliberately few distinct interior surfaces: every extra colour is another
  // material and therefore another draw call in the block's merge group, and
  // nobody is grading the tonal separation between a stair and a slab.
  const floorSurf = surf("woodPlank", 0xb08a5e);
  const stairSurf = trim;
  if (interior) {
    // Ground slab, then one slab per upper storey with a void for the flight.
    floorSlab(y, ix0, iz0, ix1, iz1, base + 0.14, trim, pal.harvest);
    const holeW = Math.min(2.6, (ix1 - ix0) * 0.45);
    const holeD = Math.min(3.6, (iz1 - iz0) * 0.5);
    const hxs = ix1 - 0.4 - holeW;
    const hzs = iz0 + 0.4;
    for (let f = 1; f < floors; f++) {
      const top = base + f * FLOOR_H;
      floorSlab(y, ix0, iz0, ix1, iz1, top, floorSurf, pal.harvest, {
        x0: hxs, z0: hzs, x1: hxs + holeW, z1: hzs + holeD,
      });
      stairs(y, hxs + holeW * 0.5, hzs + holeD, top - FLOOR_H, FLOOR_H, holeW - 0.35, holeD * 1.6, 3, stairSurf, trim, pal.harvest);
      // Landing rail around the void so the drop reads as intentional.
      railing(y, hxs, hzs, hxs + holeW, hzs, top, 1.0, trim);
    }
    // A partition with a doorway: cover, and a reason to push a corner.
    if (floors >= 1 && ix1 - ix0 > 5.5) {
      const px = (ix0 + ix1) * 0.5;
      wall(y, {
        x0: px, z0: iz0, x1: px, z1: iz1,
        base: base + 0.14, top: base + FLOOR_H - 0.18,
        t: 0.2,
        body,
        trim,
        harvest: pal.harvest,
        openings: [{ u: (iz1 - iz0) * 0.7, w: 1.2, sill: 0, h: 2.2, kind: "hole" }],
      });
    }
  }

  // --- roof ---
  if (spec.roofKind === "gable") {
    const ridgeX = spec.ridgeX ?? hx >= hz;
    const rise = Math.min(hx, hz) * 0.72 + 0.5;
    gableRoof(y, {
      cx, cz, hx, hz, base: eaves, rise, ridgeX,
      roof: roofSurf, trim, wall: body, harvest: pal.harvest,
    });
    if (tier.trim) {
      const e0 = ridgeX ? { x0: cx - hx, z0: cz + hz + 0.5, x1: cx + hx, z1: cz + hz + 0.5 }
        : { x0: cx + hx + 0.5, z0: cz - hz, x1: cx + hx + 0.5, z1: cz + hz };
      gutter(y, e0.x0, e0.z0, e0.x1, e0.z1, eaves, base, trim);
      if (rng() < 0.5) chimney(y, cx + hx * 0.45, cz - hz * 0.3, eaves + 0.4, rise + 0.9, surf("brick", 0xa9633f), trim);
    }
  } else {
    flatRoof(y, cx, cz, hx, hz, eaves, trim, trim, pal.harvest);
    if (tier.trim) {
      acUnit(y, cx - hx * 0.4, cz + hz * 0.35, eaves - 0.12, surf("metalPanel", 0xb9bec2), trim, rng() * 1.4);
      if (rng() < 0.55) acUnit(y, cx + hx * 0.45, cz - hz * 0.2, eaves - 0.12, surf("metalPanel", 0xa8adb1), trim, rng() * 1.4);
      // Stair bulkhead: the little hut over the roof access. Silhouette gold.
      if (rng() < 0.6) {
        const bw = Math.min(1.6, hx * 0.5), bd = Math.min(1.4, hz * 0.5);
        y.solidBox(surf("brick", 0xa9633f), cx + hx * 0.15, eaves + 1.2, cz - hz * 0.45, bw, 1.2, bd, pal.harvest, { bevel: 0.04 });
        y.box(trim, cx + hx * 0.15, eaves + 2.46, cz - hz * 0.45, bw + 0.12, 0.07, bd + 0.12, { bevel: 0.03 });
      }
      ladder(y, cx - hx + 0.4, cz - hz - 0.25, base + 2.4, eaves - base - 2.2, 0, -1, trim);
    }
  }

  // --- street-level dressing ---
  if (spec.shop && tier.trim) {
    const s = sides[front];
    const outZ = front === 0 ? 1 : front === 1 ? -1 : 0;
    const outX = front === 2 ? 1 : front === 3 ? -1 : 0;
    const ax0 = s.x0 + (outX ? 0 : 0.6), az0 = s.z0 + (outZ ? 0 : 0.6);
    const ax1 = s.x1 - (outX ? 0 : 0.6), az1 = s.z1 - (outZ ? 0 : 0.6);
    awning(y,
      ax0 + outX * 0.2, az0 + outZ * 0.2,
      ax1 + outX * 0.2, az1 + outZ * 0.2,
      base + 3.35, 1.25, outX, outZ,
      surf("fabric", pal.accent), trim);
    shopSign(y,
      cx + outX * hx, cz + outZ * hz, base + FLOOR_H + 0.9,
      outX, outZ, Math.min(2.6, Math.max(hx, hz)),
      surf("metalPanel", rng() < 0.5 ? pal.accent : pal.accent2), trim);
    vent(y, cx + outX * hx - outZ * 1.4, cz + outZ * hz + outX * 1.4, base + FLOOR_H - 0.6, outX, outZ, trim);
  }
  if (floors >= 2 && rng() < (spec.balconyChance ?? 0.28)) {
    const outZ = front === 0 ? 1 : front === 1 ? -1 : 0;
    const outX = front === 2 ? 1 : front === 3 ? -1 : 0;
    balcony(y,
      cx + outX * (hx + 0.7), cz + outZ * (hz + 0.7),
      outX ? 0.7 : Math.min(hx * 0.6, 2.2), outZ ? 0.7 : Math.min(hz * 0.6, 2.2),
      base + (floors - 1) * FLOOR_H + 0.16,
      trim, trim, pal.harvest);
  }

  return { top: eaves };
}

/* ------------------------------------------------------------------------ *
 * Districts
 *
 * Each builder gets a `Site`: a resolved flat pad, a palette, a private RNG
 * and the yard to emit into. Palettes are the map's legibility system — from
 * the bus you cannot read a shape, only a roof colour, so each district
 * commits to one and repeats it across every structure it owns.
 * ------------------------------------------------------------------------ */

interface Site {
  y: Yard;
  rng: () => number;
  tier: PoiTier;
  terrain?: TerrainLike;
  /** Pad centre and flat elevation. */
  cx: number;
  cz: number;
  r: number;
  gy: number;
  pal: Palette;
}

const groundAt = (s: Site, x: number, z: number): number =>
  s.terrain ? s.terrain.heightAt(x, z) : s.gy;

/**
 * The hardstanding a district sits on: one solid from the flat elevation down
 * past the lowest terrain around its edge, so the district always meets the
 * ground even if the pad moved, plus a kerb band that reads as a deliberate
 * edge rather than a clipped plane.
 */
function apron(
  s: Site,
  cx: number, cz: number, hx: number, hz: number,
  top: number,
  face: Surf, kerb: Surf,
  harvest: HarvestKind = "stone",
): void {
  let lowest = top;
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    for (const [px, pz] of [
      [cx - hx + t * hx * 2, cz - hz],
      [cx - hx + t * hx * 2, cz + hz],
      [cx - hx, cz - hz + t * hz * 2],
      [cx + hx, cz - hz + t * hz * 2],
    ]) {
      lowest = Math.min(lowest, groundAt(s, px, pz));
    }
  }
  const depth = Math.max(0.5, top - lowest + 0.9);
  s.y.solidBox(face, cx, top - depth * 0.5, cz, hx, depth * 0.5, hz, harvest, { bevel: 0.06, mask: F_NO_BOTTOM });
  // Kerb: a 12 cm lip proud of the surface all the way round.
  for (const [ox, oz, ax, az] of [
    [0, hz, hx + 0.12, 0.12],
    [0, -hz, hx + 0.12, 0.12],
    [hx, 0, 0.12, hz + 0.12],
    [-hx, 0, 0.12, hz + 0.12],
  ]) {
    s.y.box(kerb, cx + ox, top + 0.06, cz + oz, ax, 0.075, az, { bevel: 0.03 });
  }
}

/** A painted road marking. Thin, tinted concrete — cheaper than a decal system. */
function paint(y: Yard, cx: number, cz: number, hx: number, hz: number, top: number, s: Surf): void {
  y.box(s, cx, top + 0.015, cz, hx, 0.02, hz, { bevel: 0, mask: F_PY });
}

/* --------------------------------------------------------------- landmark */

/**
 * NEON HEIGHTS — the marquee. Three-by-three blocks around a central plaza,
 * every building enterable, a clock tower on the plaza's north side and enough
 * height variation that the skyline is never two of the same box in a row.
 *
 * The plan is deliberately rigid — a grid of blocks with 16 m streets — because
 * a battle royale town has to be readable at a sprint. What varies is the
 * elevation: floors 2..5, alternating roof kinds, and a body colour drawn from
 * a five-way palette so no two neighbours match.
 */
function buildNeonHeights(s: Site): void {
  const { y, rng, tier, pal } = s;
  const cx = snap(s.cx), cz = snap(s.cz), gy = s.gy;
  const BLOCK = 56, STREET = 16;
  const span = BLOCK * 1.5 + STREET;

  y.group = "neon-ground";
  apron(s, cx, cz, span, span, gy, surf("asphalt", 0x4a4c50), surf("concrete", 0xbfb9ad));

  const paintSurf = surf("concrete", 0xf0e4bd);
  const walkSurf = surf("concrete", 0xa8a49b);

  // Sidewalks: one raised slab per block, buildings sit on top of it.
  const centres = [-(BLOCK + STREET), 0, BLOCK + STREET];
  for (const bx of centres) {
    for (const bz of centres) {
      const isPlaza = bx === 0 && bz === 0;
      y.box(isPlaza ? surf("concrete", 0xcabfa8) : walkSurf,
        cx + bx, gy + 0.09, cz + bz, BLOCK * 0.5 + 2.4, 0.1, BLOCK * 0.5 + 2.4, { bevel: 0.05, mask: F_NO_BOTTOM });
      if (!isPlaza) {
        // Kerb line around the slab, and a crossing at each corner.
        for (const [ox, oz, ax, az] of [
          [0, BLOCK * 0.5 + 2.4, BLOCK * 0.5 + 2.5, 0.1],
          [0, -(BLOCK * 0.5 + 2.4), BLOCK * 0.5 + 2.5, 0.1],
          [BLOCK * 0.5 + 2.4, 0, 0.1, BLOCK * 0.5 + 2.5],
          [-(BLOCK * 0.5 + 2.4), 0, 0.1, BLOCK * 0.5 + 2.5],
        ]) {
          y.box(surf("concrete", 0xd6cfc2), cx + bx + ox, gy + 0.13, cz + bz + oz, ax, 0.09, az, { bevel: 0.025 });
        }
      }
    }
  }

  // Street markings: a dashed centre line down each avenue, zebra crossings at
  // the four plaza approaches.
  for (const off of [-(BLOCK * 0.5 + STREET * 0.5 + 2.4), BLOCK * 0.5 + STREET * 0.5 + 2.4]) {
    for (let i = -12; i <= 12; i++) {
      const t = i * 6;
      if (Math.abs(t) > span - 4) continue;
      paint(y, cx + t, cz + off, 1.4, 0.14, gy, paintSurf);
      paint(y, cx + off, cz + t, 0.14, 1.4, gy, paintSurf);
    }
  }
  for (let i = 0; i < 7; i++) {
    const o = -5.4 + i * 1.8;
    paint(y, cx + o, cz + BLOCK * 0.5 + 8, 0.32, 2.6, gy, paintSurf);
    paint(y, cx + o, cz - BLOCK * 0.5 - 8, 0.32, 2.6, gy, paintSurf);
    paint(y, cx + BLOCK * 0.5 + 8, cz + o, 2.6, 0.32, gy, paintSurf);
    paint(y, cx - BLOCK * 0.5 - 8, cz + o, 2.6, 0.32, gy, paintSurf);
  }

  // --- the buildings ---
  // Three body colours, not six. Each extra colour is another material and
  // therefore another draw call per block, and the district's identity comes
  // from the roofs anyway.
  const bodies = [0xe8d9be, 0xd3c0a4, 0xc9d1d4];
  let placed = 0;
  const top = gy + 0.19;
  for (const bx of centres) {
    for (const bz of centres) {
      if (bx === 0 && bz === 0) continue;
      // A merge group per block. Merging the whole town into one mesh would be
      // three draw calls and zero frustum culling — you would pay for every
      // building on the far side of the plaza on every frame and in every
      // shadow cascade.
      y.group = `neon-b${bx}_${bz}`;
      const edges: Array<{ ex: number; ez: number; front: 0 | 1 | 2 | 3; alongX: boolean }> = [
        { ex: 0, ez: BLOCK * 0.5, front: 0, alongX: true },
        { ex: 0, ez: -BLOCK * 0.5, front: 1, alongX: true },
        { ex: BLOCK * 0.5, ez: 0, front: 2, alongX: false },
        { ex: -BLOCK * 0.5, ez: 0, front: 3, alongX: false },
      ];
      for (const e of edges) {
        if (placed >= tier.townBuildings) break;
        const depth = 16;
        const width = rng() < 0.45 ? 32 : 20;
        const hw = width * 0.5, hd = depth * 0.5;
        const jitter = width < 40 ? snap((rng() - 0.5) * 20) : 0;
        const bcx = snap(cx + bx + (e.alongX ? jitter : e.ex - Math.sign(e.ex) * hd));
        const bcz = snap(cz + bz + (e.alongX ? e.ez - Math.sign(e.ez) * hd : jitter));
        const floors = 2 + Math.floor(rng() * 2.8);
        building(y, {
          cx: bcx, cz: bcz,
          hx: e.alongX ? hw : hd,
          hz: e.alongX ? hd : hw,
          base: top,
          floors,
          pal, rng, tier,
          roofKind: rng() < 0.55 ? "flat" : "gable",
          ridgeX: e.alongX,
          shop: true,
          front: e.front,
          wallColor: pick(bodies, rng),
          interior: true,
        });
        placed++;
      }
    }
  }

  // --- the plaza ---
  y.group = "neon-plaza";
  const pr = 11;
  // Fountain: a stepped basin, a plinth, a bowl and a jet. A plaza needs a
  // centrepiece or it reads as a car park with no cars.
  y.cyl(surf("concrete", 0xcdc4b2), cx, gy + 0.35, cz, pr, pr * 0.97, 0.7, { seg: 24, capTop: true });
  y.cyl(surf("concrete", 0xb9b0a0), cx, gy + 0.78, cz, pr * 0.93, pr * 0.93, 0.16, { seg: 24, capTop: true });
  y.cyl(surf("glass", 0x2f9fbe), cx, gy + 0.72, cz, pr * 0.88, pr * 0.88, 0.08, { seg: 24, capTop: true });
  y.solid(cx, gy + 0.4, cz, pr, 0.4, pr, "concrete", "stone");
  y.cyl(surf("concrete", 0xd3cab8), cx, gy + 1.5, cz, 1.1, 0.8, 2.0, { seg: 12 });
  y.cyl(surf("concrete", 0xd3cab8), cx, gy + 2.7, cz, 2.4, 2.4, 0.4, { seg: 16 });
  y.cyl(surf("gold", 0xd9b25a), cx, gy + 3.3, cz, 0.35, 0.28, 0.9, { seg: 10 });
  y.solid(cx, gy + 1.8, cz, 1.2, 1.8, 1.2, "concrete", "stone");

  // Benches and planters ringing the fountain.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.4;
    const bx2 = cx + Math.cos(a) * (pr + 3.4);
    const bz2 = cz + Math.sin(a) * (pr + 3.4);
    if (i % 2 === 0) {
      y.box(surf("woodPlank", 0x8a5f3a), bx2, gy + 0.52, bz2, 1.1, 0.06, 0.28, { bevel: 0.02, yaw: a });
      y.box(surf("woodPlank", 0x8a5f3a), bx2, gy + 0.86, bz2, 1.1, 0.24, 0.06, { bevel: 0.02, yaw: a });
      for (const sgn of [-1, 1]) {
        y.box(surf("metalPanel", 0x3a3d40), bx2 + Math.cos(a + Math.PI / 2) * sgn * 0.9, gy + 0.26, bz2 + Math.sin(a + Math.PI / 2) * sgn * 0.9, 0.07, 0.26, 0.24, { bevel: 0.015, yaw: a });
      }
    } else {
      y.box(surf("concrete", 0xc0b7a6), bx2, gy + 0.45, bz2, 0.75, 0.45, 0.75, { bevel: 0.05, yaw: a });
      y.inst("hedge|plaza", surf("foliage", 0x4a7a34), hedgeProto,
        xf(bx2, gy + 0.85, bz2, a).multiply(new THREE.Matrix4().makeScale(0.45, 0.5, 0.72)));
    }
  }

  // --- the clock tower ---
  // The single tallest thing in the district and the thing a player calls the
  // drop on. Four storeys of masonry, an arcaded belfry, a clock face on all
  // four elevations and a spire.
  y.group = "neon-tower";
  const tx = snap(cx), tz = snap(cz - BLOCK * 0.5 + 4);
  const th = 6, tw = 5.2;
  const stone = surf("brick", 0xcdb894);
  const trim = surf("concrete", pal.trim);
  for (let f = 0; f < 5; f++) {
    const y0 = gy + f * th * 0.9;
    const y1 = y0 + th * 0.9;
    const shrink = f * 0.16;
    const hw2 = tw - shrink;
    for (const dir of [0, 1, 2, 3]) {
      const alongX = dir < 2;
      const sgn = dir % 2 === 0 ? 1 : -1;
      wall(y, {
        x0: alongX ? tx - hw2 : tx + sgn * (hw2 - WALL_T * 0.5),
        z0: alongX ? tz + sgn * (hw2 - WALL_T * 0.5) : tz - hw2,
        x1: alongX ? tx + hw2 : tx + sgn * (hw2 - WALL_T * 0.5),
        z1: alongX ? tz + sgn * (hw2 - WALL_T * 0.5) : tz + hw2,
        base: y0, top: y1,
        body: stone, trim, glass: surf("glass", 0xd8eef4),
        harvest: "stone",
        openings: f === 0 && dir === 0
          ? [{ u: hw2, w: 1.5, sill: 0, h: 2.6, kind: "door" }]
          : [{ u: hw2, w: 1.2, sill: 1.6, h: 2.4, kind: "window" }],
        plinth: f === 0 ? 0.6 : 0,
        band: true,
      });
    }
    if (tier.interiors && f > 0) {
      floorSlab(y, tx - hw2 + 0.4, tz - hw2 + 0.4, tx + hw2 - 0.4, tz + hw2 - 0.4, y0, surf("woodPlank", 0x9c7444), "stone",
        { x0: tx + 0.4, z0: tz - hw2 + 0.6, x1: tx + hw2 - 0.6, z1: tz + hw2 * 0.2 });
      stairs(y, tx + hw2 * 0.5, tz + hw2 * 0.2, y0 - th * 0.9, th * 0.9, 1.5, 4.6, 1, surf("woodPlank", 0x8a6438), trim, "wood");
    }
  }
  const belfry = gy + 5 * th * 0.9;
  // Clock stage: a heavier cornice, then a gold-rimmed face on each elevation.
  y.box(trim, tx, belfry + 0.3, tz, tw + 0.55, 0.3, tw + 0.55, { bevel: 0.05 });
  for (const [nx, nz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const fx = tx + nx * (tw - 0.5), fz = tz + nz * (tw - 0.5);
    y.cyl(surf("gold", 0xd8b463), fx, belfry + 2.6, fz, 1.55, 1.55, 0.22,
      nz !== 0 ? { pitch: Math.PI / 2, seg: 20 } : { roll: Math.PI / 2, seg: 20 });
    y.cyl(surf("plaster", 0xf4efe2), fx + nx * 0.14, belfry + 2.6, fz + nz * 0.14, 1.32, 1.32, 0.1,
      nz !== 0 ? { pitch: Math.PI / 2, seg: 20 } : { roll: Math.PI / 2, seg: 20 });
    y.box(surf("metalPanel", 0x22242a), fx + nx * 0.24, belfry + 3.0, fz + nz * 0.24,
      nz !== 0 ? 0.07 : 0.06, 0.62, nz !== 0 ? 0.06 : 0.07, { bevel: 0.01 });
    y.box(surf("metalPanel", 0x22242a), fx + nx * 0.24, belfry + 2.6, fz + nz * 0.24,
      nz !== 0 ? 0.85 : 0.06, 0.055, nz !== 0 ? 0.06 : 0.85, { bevel: 0.01 });
  }
  const bell = belfry + 5.4;
  for (const dir of [0, 1, 2, 3]) {
    const alongX = dir < 2;
    const sgn = dir % 2 === 0 ? 1 : -1;
    wall(y, {
      x0: alongX ? tx - tw + 0.6 : tx + sgn * (tw - 0.7),
      z0: alongX ? tz + sgn * (tw - 0.7) : tz - tw + 0.6,
      x1: alongX ? tx + tw - 0.6 : tx + sgn * (tw - 0.7),
      z1: alongX ? tz + sgn * (tw - 0.7) : tz + tw - 0.6,
      base: bell - 3.4, top: bell,
      body: stone, trim,
      harvest: "stone",
      openings: [{ u: tw - 0.6, w: 2.4, sill: 0.4, h: 2.4, kind: "hole" }],
    });
  }
  y.box(trim, tx, bell + 0.3, tz, tw + 0.35, 0.3, tw + 0.35, { bevel: 0.05 });
  y.solid(tx, bell + 0.3, tz, tw, 0.3, tw, "concrete", "stone");
  // Spire: a tall pyramid plus a finial. Reads from every corner of the island.
  y.cyl(surf(pal.roofMat, pal.roof), tx, bell + 5.4, tz, tw * 1.02, 0.15, 9.6, { seg: 4, yaw: Math.PI / 4 });
  y.cyl(surf("gold", 0xdcb763), tx, bell + 10.8, tz, 0.22, 0.02, 1.4, { seg: 8 });
  y.solid(tx, bell + 5.4, tz, tw * 0.7, 4.8, tw * 0.7, "concrete", "stone");

  // --- street furniture ---
  y.group = "neon-props";
  const lamp = surf("metalPanel", 0x2f3438);
  for (const bx of centres) {
    for (const bz of centres) {
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        y.inst("lamp", lamp, streetLampProto,
          xf(cx + bx + sx * (BLOCK * 0.5 + 1.4), gy + 0.19, cz + bz + sz * (BLOCK * 0.5 + 1.4), rng() * 6.28));
        y.solid(cx + bx + sx * (BLOCK * 0.5 + 1.4), gy + 2.4, cz + bz + sz * (BLOCK * 0.5 + 1.4), 0.16, 2.4, 0.16, "metal", "metal");
      }
    }
  }
  const n = Math.round(46 * tier.props);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const rr = 14 + rng() * (span - 20);
    const px = cx + Math.cos(a) * rr, pz = cz + Math.sin(a) * rr;
    const roll = rng();
    if (roll < 0.4) y.inst("crate|town", surf("woodPlank", 0xa87c4c), crateProto, xf(px, gy + 0.19, pz, rng() * 6.28));
    else if (roll < 0.7) y.inst("barrel|town", surf("metalPanel", 0x3f6f5a), barrelProto, xf(px, gy + 0.19, pz, rng() * 6.28));
    else y.inst("bollard|town", surf("metalPanel", 0xc4562f), bollardProto, xf(px, gy + 0.19, pz, rng() * 6.28));
    y.solid(px, gy + 0.7, pz, 0.55, 0.55, 0.55, "wood", roll < 0.4 ? "wood" : "metal");
  }
}

/* ------------------------------------------------------------- industrial */

/**
 * FOUNDRY FLATS — corrugated teal, rust and concrete.
 *
 * The district that owns metal: everything here harvests as metal, which makes
 * it the drop for a player who wants to build a metal box in the endgame. The
 * silhouette is deliberately vertical and irregular — three silos, a conveyor
 * on the diagonal and a 30 m stack — so it reads against the town's flat
 * skyline from anywhere on the island.
 */
function buildFoundryFlats(s: Site): void {
  const { y, rng, tier, pal } = s;
  const cx = snap(s.cx), cz = snap(s.cz), gy = s.gy;
  const trim = surf("metalPanel", pal.trim);
  const skin = surf("corrugated", pal.wall);
  const roofS = surf("corrugated", pal.roof);

  y.group = "foundry-ground";
  apron(s, cx, cz, 96, 78, gy, surf("concrete", 0x6d6a64), surf("concrete", 0x9a958c), "stone");
  // Oil staining and bay markings — a yard with no markings reads as a slab.
  const line = surf("concrete", 0xd8cf9c);
  for (let i = -5; i <= 5; i++) {
    paint(y, cx + 52, cz + i * 7, 6, 0.14, gy, line);
  }

  // --- the main shed ---
  y.group = "foundry-shed";
  const shx = 30, shz = 17, shh = 12;
  for (const dir of [0, 1, 2, 3]) {
    const alongX = dir < 2;
    const sgn = dir % 2 === 0 ? 1 : -1;
    const L = alongX ? shx * 2 : shz * 2;
    const ops: Opening[] = [];
    // Clerestory strip: the band of high glazing every real shed has.
    for (let i = 0; i < Math.floor(L / 6); i++) ops.push({ u: 3 + i * 6, w: 3.6, sill: 8.4, h: 2.2, kind: "window" });
    if (dir === 0) {
      ops.push({ u: L * 0.28, w: 6.4, sill: 0, h: 6.2, kind: "hole" });
      ops.push({ u: L * 0.72, w: 6.4, sill: 0, h: 6.2, kind: "hole" });
    }
    if (dir === 3) ops.push({ u: L * 0.5, w: 1.5, sill: 0, h: 2.6, kind: "door" });
    wall(y, {
      x0: alongX ? cx - shx : cx + sgn * (shx - WALL_T * 0.5),
      z0: alongX ? cz + sgn * (shz - WALL_T * 0.5) : cz - shz,
      x1: alongX ? cx + shx : cx + sgn * (shx - WALL_T * 0.5),
      z1: alongX ? cz + sgn * (shz - WALL_T * 0.5) : cz + shz,
      base: gy, top: gy + shh,
      body: skin, trim, glass: surf("glass", 0xcfe6ee),
      harvest: "metal",
      openings: ops,
      plinth: 0.8,
    });
  }
  gableRoof(y, {
    cx, cz, hx: shx, hz: shz, base: gy + shh, rise: 5.2, ridgeX: true, overhang: 0.8,
    roof: roofS, trim, wall: skin, harvest: "metal",
  });
  // Roller-door tracks and a canopy over the two openings.
  for (const u of [-shx + shx * 2 * 0.28, -shx + shx * 2 * 0.72]) {
    y.box(trim, cx + u, gy + 6.5, cz + shz + 0.12, 3.6, 0.16, 0.16, { bevel: 0.02 });
    y.box(surf("metalPanel", pal.accent), cx + u, gy + 7.1, cz + shz + 0.75, 3.9, 0.09, 0.75, { bevel: 0.03, pitch: 0.16 });
  }
  if (tier.interiors) {
    // A mezzanine down one side with a flight up to it: vertical play indoors.
    floorSlab(y, cx - shx + 0.6, cz - shz + 0.6, cx + shx - 0.6, cz - shz + 9, gy + FLOOR_H,
      surf("metalPanel", 0x8d9295), "metal");
    railing(y, cx - shx + 0.6, cz - shz + 9, cx + shx - 0.6, cz - shz + 9, gy + FLOOR_H, 1.05, trim);
    stairs(y, cx - shx + 4, cz - shz + 13.5, gy, FLOOR_H, 1.6, 5.4, 1, surf("metalPanel", 0x767b7e), trim, "metal");
    // Overhead crane rail: two beams the length of the shed on corbels.
    for (const sz of [-1, 1]) {
      y.box(trim, cx, gy + 9.4, cz + sz * (shz - 1.2), shx - 0.6, 0.28, 0.2, { bevel: 0.03 });
    }
    y.box(surf("metalPanel", pal.accent), cx + 6, gy + 9.0, cz, 1.8, 0.5, shz - 1.0, { bevel: 0.04 });
  }
  if (tier.trim) {
    for (let i = 0; i < 4; i++) vent(y, cx - 18 + i * 12, cz - shz - 0.1, gy + 9.6, 0, -1, trim);
    ladder(y, cx + shx + 0.3, cz - 6, gy + 1.6, shh - 1.2, 1, 0, trim);
  }

  // --- silos and the conveyor ---
  y.group = "foundry-silos";
  const silY = gy;
  for (let i = 0; i < 3; i++) {
    const sx2 = cx - 62 + i * 13;
    const sz2 = cz - 20;
    const h = 20 - i * 1.4;
    y.cyl(surf("metalPanel", 0xcfd3d2), sx2, silY + h * 0.5, sz2, 5, 5, h, { seg: tier.round + 6, capTop: false });
    // Band rings every 4 m — what stops a silo reading as a grey tube.
    for (let b = 1; b < 5; b++) {
      y.cyl(trim, sx2, silY + b * (h / 5), sz2, 5.12, 5.12, 0.16, { seg: tier.round + 6, capTop: false });
    }
    y.cyl(surf("metalPanel", pal.accent), sx2, silY + h + 1.5, sz2, 5, 0.6, 3, { seg: tier.round + 6 });
    y.cyl(trim, sx2, silY + h + 3.4, sz2, 0.5, 0.5, 1.2, { seg: 8 });
    y.solid(sx2, silY + h * 0.5, sz2, 5, h * 0.5, 5, "metal", "metal");
    ladder(y, sx2 + 5.1, sz2, silY + 1.2, h - 1, 1, 0, trim);
    // Skirt legs, so the silo lands on the ground instead of intersecting it.
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      y.box(trim, sx2 + Math.cos(a) * 4.6, silY + 0.6, sz2 + Math.sin(a) * 4.6, 0.16, 0.6, 0.16, { bevel: 0.02, yaw: a });
    }
  }
  // The conveyor: an inclined enclosed gallery from the silos to the shed roof,
  // on trestles. The diagonal is the whole point — nothing else here is one.
  {
    const ax = cx - 36, az = cz - 20, ay = gy + 3;
    const bx = cx - shx + 4, bz = cz - 8, by = gy + shh + 4;
    const dx = bx - ax, dz = bz - az, dy = by - ay;
    const len = Math.hypot(dx, dy, dz);
    const yaw = Math.atan2(dx, dz);
    const pitch = -Math.asin(dy / len);
    const m = xf((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5, yaw, pitch, 0);
    y.emit(skin, bevelBox(1.5, 1.4, len * 0.5, y.bevel), m);
    y.emit(trim, bevelBox(1.62, 0.1, len * 0.5, 0.02), xf(
      (ax + bx) * 0.5, (ay + by) * 0.5 + 1.5, (az + bz) * 0.5, yaw, pitch, 0));
    y.solid((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5, Math.abs(dx) * 0.5 + 1.5, Math.abs(dy) * 0.5 + 1.4, Math.abs(dz) * 0.5 + 1.5, "metal", "metal");
    for (let t = 0.18; t < 0.95; t += 0.26) {
      const px = lerp(ax, bx, t), pz = lerp(az, bz, t), py = lerp(ay, by, t);
      for (const sgn of [-1, 1]) {
        y.box(trim, px + Math.cos(yaw) * sgn * 1.3, gy + (py - gy) * 0.5, pz - Math.sin(yaw) * sgn * 1.3,
          0.16, (py - gy) * 0.5, 0.16, { bevel: 0.02 });
      }
    }
  }

  // --- the stack ---
  y.group = "foundry-stack";
  const stx = cx + 34, stz = cz - 34;
  y.cyl(surf("brick", 0xa06a4c), stx, gy + 2, stz, 4.4, 3.6, 4, { seg: tier.round + 4, capTop: false });
  y.cyl(surf("brick", 0xb07350), stx, gy + 17, stz, 3.4, 2.2, 26, { seg: tier.round + 4, capTop: false });
  for (let i = 0; i < 4; i++) {
    const t = i / 4;
    y.cyl(surf("metalPanel", i % 2 ? 0xd8d2c8 : 0xc4402c), stx, gy + 6 + t * 22, stz,
      lerp(3.42, 2.3, t), lerp(3.42, 2.3, t), 1.1, { seg: tier.round + 4, capTop: false });
  }
  y.cyl(trim, stx, gy + 30.4, stz, 2.5, 2.5, 0.8, { seg: tier.round + 4, capTop: false });
  y.solid(stx, gy + 15, stz, 3.6, 15, 3.6, "concrete", "stone");
  ladder(y, stx + 3.3, stz, gy + 4, 24, 1, 0, trim);

  // --- pipework, tanks, yard clutter ---
  y.group = "foundry-yard";
  pipeRun(y, cx - 20, cz + 30, cx + 40, cz + 30, gy + 1.4, 0.42, surf("metalPanel", 0xb7b1a4), trim, tier.round);
  pipeRun(y, cx - 20, cz + 31.4, cx + 40, cz + 31.4, gy + 2.1, 0.3, surf("metalPanel", pal.accent2), trim, tier.round);
  for (let i = 0; i < 5; i++) {
    const px = cx - 16 + i * 14;
    y.box(trim, px, gy + 0.9, cz + 30.7, 0.16, 0.9, 1.4, { bevel: 0.02 });
  }
  for (let i = 0; i < 2; i++) {
    // Pressure vessels: a barrel lying on saddles with dished ends, clear of
    // the ground. Radius 4.6 with its axis at 5.4 keeps the belly 80 cm up,
    // which is where the saddles go and where the shadow reads.
    const tx2 = cx + 56, tz2 = cz - 8 + i * 16;
    const skin2 = surf("metalPanel", 0xa9b0ae);
    y.cyl(skin2, tx2, gy + 5.4, tz2, 4.6, 4.6, 6.4, { seg: tier.round + 4, capTop: false, roll: Math.PI / 2 });
    for (const sgn of [-1, 1]) {
      y.dome(skin2, tx2 + sgn * 3.2, gy + 5.4, tz2, 4.6, 1.8, tier.round + 4, { roll: -sgn * Math.PI / 2 });
      y.box(trim, tx2 + sgn * 2.4, gy + 0.5, tz2, 0.75, 0.5, 4.0, { bevel: 0.05 });
      y.box(trim, tx2 + sgn * 2.4, gy + 1.4, tz2, 0.6, 0.45, 3.2, { bevel: 0.05 });
    }
    y.solid(tx2, gy + 5.4, tz2, 5.0, 4.6, 4.6, "metal", "metal");
    ladder(y, tx2, tz2 + 4.7, gy + 0.6, 8.4, 0, 1, trim);
  }
  // Container stacks: three colours, two high, in the marked bays.
  const conCols = [0xc4562f, 0x2f6f9c, 0x4f7a44];
  for (let i = 0; i < 7; i++) {
    const bx = cx + 40 + (i % 3) * 7.4;
    const bz = cz + 4 + Math.floor(i / 3) * 14;
    const st = 1 + (rng() < 0.45 ? 1 : 0);
    for (let k = 0; k < st; k++) {
      const col = conCols[(i + k) % 3];
      y.inst(`container|${col.toString(16)}`, surf("metalPanel", col), containerProto,
        xf(bx, gy + k * 2.62, bz, Math.PI / 2));
      y.solid(bx, gy + k * 2.62 + 1.3, bz, 1.24, 1.3, 3.06, "metal", "metal");
    }
  }
  const n = Math.round(34 * tier.props);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2, rr = 24 + rng() * 48;
    const px = cx + Math.cos(a) * rr, pz = cz + Math.sin(a) * rr * 0.8;
    const roll = rng();
    if (roll < 0.45) y.inst("barrel|foundry", surf("metalPanel", 0xb0562c), barrelProto, xf(px, gy, pz, rng() * 6.28));
    else if (roll < 0.75) y.inst("pallet|foundry", surf("woodPlank", 0x9a7548), palletProto, xf(px, gy, pz, rng() * 6.28));
    else y.inst("tyre|foundry", surf("rubber", 0x2a2a2c), tyreProto, xf(px, gy, pz, rng() * 6.28));
    if (roll < 0.45) y.solid(px, gy + 0.46, pz, 0.36, 0.46, 0.36, "metal", "metal");
  }
}

/* ----------------------------------------------------------------- harbor */

/** Direction of the open sea from a point, as a unit XZ vector. */
function seawardFrom(s: Site, x: number, z: number): [number, number] {
  if (!s.terrain) return [0, 1];
  let best = 0, bx = 0, bz = 1, bestH = Infinity;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const dx = Math.cos(a), dz = Math.sin(a);
    let h = 0;
    for (let d = 40; d <= 200; d += 40) h += s.terrain.heightAt(x + dx * d, z + dz * d);
    if (h < bestH) { bestH = h; bx = dx; bz = dz; best = i; }
  }
  void best;
  return [bx, bz];
}

/**
 * SALT HARBOR — the working waterfront.
 *
 * Timber, tar and slate. The quay is a raised concrete edge, the piers walk out
 * over the water on stilts, and everything above them is wood, so the whole
 * district harvests as wood — the fastest early-game build materials on the map,
 * which is deliberate for a coastal drop.
 */
function buildSaltHarbor(s: Site): void {
  const { y, rng, tier, pal } = s;
  const cx = snap(s.cx), cz = snap(s.cz), gy = s.gy;
  const [sx, sz] = seawardFrom(s, cx, cz);
  // Snap the seaward direction to an axis: every structure in the file is
  // axis-aligned so its colliders are exact, and a 12° quay is not worth
  // losing that.
  const ax = Math.abs(sx) > Math.abs(sz) ? Math.sign(sx) : 0;
  const az = ax === 0 ? Math.sign(sz) || 1 : 0;
  const trim = surf("concrete", pal.trim);
  const plank = surf("woodPlank", pal.wall);

  y.group = "harbor-quay";
  apron(s, cx - ax * 12, cz - az * 12, ax ? 46 : 74, ax ? 74 : 46, gy,
    surf("concrete", 0x8d8880), surf("concrete", 0xb3aca0), "stone");

  // --- piers on stilts ---
  y.group = "harbor-piers";
  const deck = gy + 0.4;
  for (let p = 0; p < 3; p++) {
    const off = (p - 1) * 22;
    const px = cx + (ax ? 34 : off);
    const pz = cz + (ax ? off : 34);
    const hx = ax ? 26 : 4.6;
    const hz = ax ? 4.6 : 26;
    y.solidBox(plank, px + ax * 20, deck, pz + az * 20, hx, 0.22, hz, "wood", { bevel: 0.04 });
    // Stilts down to whatever is underneath — often the seabed.
    for (let i = -4; i <= 4; i++) {
      for (const side of [-1, 1]) {
        const lx = px + ax * 20 + (ax ? i * 5.6 : side * 3.8);
        const lz = pz + az * 20 + (ax ? side * 3.8 : i * 5.6);
        const g = groundAt(s, lx, lz);
        const h = Math.max(1.2, deck - g);
        y.cyl(surf("woodLog", 0x6b5237), lx, deck - h * 0.5, lz, 0.24, 0.28, h, { seg: 7, capTop: false });
        // Cross-brace: two logs is a pier, one log is a stick.
        if (i % 2 === 0) {
          y.box(surf("woodLog", 0x6b5237), lx, deck - h * 0.45, lz + (ax ? 0 : 0), 0.1, 0.1, 3.6,
            ax ? { yaw: Math.PI / 2, roll: 0.5 } : { roll: 0.5 });
        }
      }
    }
    railing(y, px + ax * 20 - hx, pz + az * 20 - hz, px + ax * 20 + (ax ? hx : -hx), pz + az * 20 + (ax ? -hz : hz), deck + 0.22, 1.05, surf("woodPlank", 0x8a6a44));
    // A bollard and a stack of crab pots at the pier head.
    y.inst("bollard|harbor", surf("metalPanel", 0x3d4245), bollardProto,
      xf(px + ax * 42, deck + 0.22, pz + az * 42, 0));
    for (let k = 0; k < 3; k++) {
      y.inst("crate|harbor", surf("woodPlank", 0x9b7a52), crateProto,
        xf(px + ax * 34 + (ax ? 0 : k * 1.3 - 1.3), deck + 0.22 + k * 0.02, pz + az * 34 + (ax ? k * 1.3 - 1.3 : 0), rng() * 6.28));
    }
  }

  // --- boats ---
  y.group = "harbor-boats";
  for (let b = 0; b < 4; b++) {
    const off = (b - 1.5) * 22 + 8;
    const bx = cx + (ax ? 46 : off) + (ax ? 0 : 0);
    const bz = cz + (ax ? off : 46);
    const wl = s.terrain ? Math.max(s.terrain.seaLevel, groundAt(s, bx, bz)) : gy - 1.2;
    const hull = [
      -5.4, -1.5, 3.6, -1.7, 5.8, 0, 3.6, 1.7, -5.4, 1.5,
    ];
    const rot = ax ? 0 : Math.PI / 2;
    y.emit(surf("woodPlank", pick([0xd8dbd6, 0x9c4c3a, 0x35597a], rng)),
      prism(hull, -1.1, 0.55), xf(bx, wl + 0.5, bz, rot));
    y.box(surf("woodPlank", 0x8a6a44), bx - (ax ? 1.5 : 0), wl + 1.5, bz - (ax ? 0 : 1.5), ax ? 1.8 : 1.4, 0.95, ax ? 1.4 : 1.8, { bevel: 0.05 });
    y.box(surf("glass", 0xcfe6ee), bx - (ax ? 1.5 : 0), wl + 1.9, bz - (ax ? 0 : 1.5), ax ? 1.6 : 1.2, 0.4, ax ? 1.2 : 1.6, { bevel: 0.02 });
    y.cyl(surf("woodLog", 0x7a5c3c), bx + (ax ? 1.5 : 0), wl + 3.6, bz + (ax ? 0 : 1.5), 0.13, 0.09, 5.4, { seg: 6 });
    y.box(trim, bx + (ax ? 1.5 : 0), wl + 5.4, bz + (ax ? 0 : 1.5), ax ? 2.2 : 0.05, 0.05, ax ? 0.05 : 2.2, { bevel: 0.01 });
    y.solid(bx, wl + 0.4, bz, ax ? 5.6 : 1.8, 1.4, ax ? 1.8 : 5.6, "wood", "wood");
  }

  // --- sheds, market and cottages ---
  y.group = "harbor-town";
  const inland = -1;
  for (let i = 0; i < 5; i++) {
    const off = (i - 2) * 21;
    const bx2 = snap(cx + (ax ? inland * ax * 26 : off));
    const bz2 = snap(cz + (ax ? off : inland * az * 26));
    building(y, {
      cx: bx2, cz: bz2,
      hx: ax ? 8 : 9, hz: ax ? 9 : 8,
      base: gy,
      floors: i % 2 === 0 ? 2 : 1,
      pal, rng, tier,
      roofKind: "gable",
      ridgeX: !ax,
      shop: i % 2 === 1,
      front: ax ? (ax > 0 ? 2 : 3) : (az > 0 ? 0 : 1),
      wallColor: i % 2 === 0 ? pal.wall : pal.wallAlt,
      wallMat: i % 2 === 0 ? "woodPlank" : "plaster",
    });
  }
  // The fish market: an open-sided shed. Posts, a roof, and nothing else — the
  // best kind of cover, and a landmark you can shoot through.
  {
    const mx = snap(cx + (ax ? -ax * 4 : 44));
    const mz = snap(cz + (ax ? 44 : -az * 4));
    const hx = ax ? 7 : 14, hz = ax ? 14 : 7;
    y.solidBox(surf("concrete", 0x9c968c), mx, gy + 0.2, mz, hx, 0.2, hz, "stone", { bevel: 0.05 });
    for (let i = -2; i <= 2; i++) {
      for (const side of [-1, 1]) {
        const lx = mx + (ax ? side * (hx - 0.6) : i * (hx - 1) * 0.5);
        const lz = mz + (ax ? i * (hz - 1) * 0.5 : side * (hz - 0.6));
        y.solidBox(surf("woodLog", 0x7c5c3c), lx, gy + 2.3, lz, 0.2, 2.1, 0.2, "wood", { bevel: 0.02 });
      }
    }
    gableRoof(y, { cx: mx, cz: mz, hx, hz, base: gy + 4.4, rise: 2.4, ridgeX: !ax, overhang: 1.0,
      roof: surf(pal.roofMat, pal.roof), trim, wall: plank, harvest: "wood", ends: false });
    for (let i = 0; i < 6; i++) {
      y.inst("crate|harbor", surf("woodPlank", 0x9b7a52), crateProto,
        xf(mx + (rng() - 0.5) * hx * 1.4, gy + 0.4, mz + (rng() - 0.5) * hz * 1.4, rng() * 6.28));
    }
  }

  // --- the gantry crane ---
  y.group = "harbor-crane";
  {
    const gx = snap(cx + (ax ? ax * 16 : -26));
    const gz = snap(cz + (ax ? -26 : az * 16));
    const h = 17;
    for (const sgn of [-1, 1]) {
      const lx = gx + (ax ? sgn * 5 : 0), lz = gz + (ax ? 0 : sgn * 5);
      y.solidBox(surf("metalPanel", pal.accent), lx, gy + h * 0.5, lz, 0.55, h * 0.5, 0.55, "metal", { bevel: 0.04 });
      // Lattice: diagonals up the leg. Six boxes, and the leg stops being a post.
      for (let i = 0; i < 6; i++) {
        y.box(trim, lx, gy + 1.6 + i * 2.6, lz, ax ? 0.08 : 0.9, 1.3, ax ? 0.9 : 0.08,
          { bevel: 0.01, roll: ax ? 0 : (i % 2 ? 0.6 : -0.6), pitch: ax ? (i % 2 ? 0.6 : -0.6) : 0 });
      }
    }
    y.solidBox(surf("metalPanel", pal.accent), gx, gy + h + 0.9, gz, ax ? 6 : 2, 0.9, ax ? 2 : 6, "metal", { bevel: 0.05 });
    // The boom, cantilevered out over the water, with a hook block on a cable.
    const boomLen = 22;
    const bmx = gx + (ax ? 0 : 0) + (ax ? 0 : 0);
    y.box(surf("metalPanel", pal.accent), bmx + (ax ? 0 : boomLen * 0.35), gy + h + 2.6, gz + (ax ? boomLen * 0.35 : 0),
      ax ? 1.1 : boomLen * 0.5, 0.8, ax ? boomLen * 0.5 : 1.1, { bevel: 0.05, pitch: ax ? -0.12 : 0, roll: ax ? 0 : 0.12 });
    y.box(surf("concrete", 0x8a857c), gx - (ax ? 0 : 8), gy + h + 2.6, gz - (ax ? 8 : 0), ax ? 1.6 : 2.4, 1.2, ax ? 2.4 : 1.6, { bevel: 0.05 });
    const hookX = gx + (ax ? 0 : boomLen * 0.72), hookZ = gz + (ax ? boomLen * 0.72 : 0);
    y.box(trim, hookX, gy + h * 0.72, hookZ, 0.05, h * 0.28, 0.05, { bevel: 0 });
    y.box(trim, hookX, gy + h * 0.44, hookZ, 0.42, 0.36, 0.42, { bevel: 0.04 });
  }

  const n = Math.round(30 * tier.props);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2, rr = 16 + rng() * 40;
    const px = cx + Math.cos(a) * rr - ax * 14, pz = cz + Math.sin(a) * rr - az * 14;
    if (s.terrain && s.terrain.isWater(px, pz)) continue;
    const roll = rng();
    if (roll < 0.5) y.inst("crate|harbor", surf("woodPlank", 0x9b7a52), crateProto, xf(px, groundAt(s, px, pz), pz, rng() * 6.28));
    else y.inst("barrel|harbor", surf("metalPanel", 0x3f6f5a), barrelProto, xf(px, groundAt(s, px, pz), pz, rng() * 6.28));
  }
}

/* ------------------------------------------------------------------- farm */

function baleProto(): Geo {
  const g = new Geo();
  mergeGeo(g, cylinder(0.78, 0.78, 1.5, 12, true, true), xf(0, 0.78, 0, 0, 0, Math.PI / 2));
  for (const sgn of [-1, 1]) mergeGeo(g, cylinder(0.8, 0.8, 0.08, 12, false, false), xf(sgn * 0.4, 0.78, 0, 0, 0, Math.PI / 2));
  return g;
}

function logProto(): Geo {
  const g = new Geo();
  mergeGeo(g, cylinder(0.3, 0.27, 4.2, 8, true, true), xf(0, 0.3, 0, 0, 0, Math.PI / 2));
  return g;
}

/**
 * MILL HOLLOW — barn red under a slate sky.
 *
 * The most saturated roof-and-wall pairing on the island, on purpose: it is the
 * district you can identify from the bus without reading a single shape. A
 * gambrel barn, a grain silo, a windmill and four fenced paddocks.
 */
function buildMillHollow(s: Site): void {
  const { y, rng, tier, pal } = s;
  const cx = snap(s.cx), cz = snap(s.cz), gy = s.gy;
  const trim = surf("concrete", pal.trim);
  const barnWall = surf("woodPlank", pal.wall);

  y.group = "mill-ground";
  apron(s, cx, cz, 62, 54, gy, surf("dirt", 0x9c8259), surf("woodPlank", 0x7d6242), "wood");

  // --- the barn ---
  y.group = "mill-barn";
  const bx = snap(cx - 14), bz = snap(cz - 6);
  const hx = 17, hz = 10, hgt = 8;
  for (const dir of [0, 1, 2, 3]) {
    const alongX = dir < 2;
    const sgn = dir % 2 === 0 ? 1 : -1;
    const L = alongX ? hx * 2 : hz * 2;
    const ops: Opening[] = [];
    if (dir === 0) ops.push({ u: L * 0.5, w: 6.5, sill: 0, h: 6, kind: "hole" });
    else if (dir === 2) ops.push({ u: L * 0.5, w: 2.6, sill: 0, h: 4.2, kind: "hole" });
    else for (let i = 0; i < Math.floor(L / 7); i++) ops.push({ u: 3.5 + i * 7, w: 1.2, sill: 2.4, h: 1.6, kind: "window" });
    wall(y, {
      x0: alongX ? bx - hx : bx + sgn * (hx - WALL_T * 0.5),
      z0: alongX ? bz + sgn * (hz - WALL_T * 0.5) : bz - hz,
      x1: alongX ? bx + hx : bx + sgn * (hx - WALL_T * 0.5),
      z1: alongX ? bz + sgn * (hz - WALL_T * 0.5) : bz + hz,
      base: gy, top: gy + hgt,
      body: barnWall, trim: surf("woodPlank", 0xf2ece0), glass: surf("glass", 0xdcedf2),
      harvest: "wood",
      openings: ops,
      plinth: 0.55,
    });
  }
  // Gambrel: a shallow upper pitch over a steep lower one. Two gable roofs
  // stacked is not strictly a gambrel, but it reads as one from every angle a
  // player will ever see it from and costs a fifth of a real one.
  gableRoof(y, { cx: bx, cz: bz, hx, hz, base: gy + hgt, rise: 2.6, ridgeX: true, overhang: 0.7,
    roof: surf(pal.roofMat, pal.roof), trim: surf("woodPlank", 0xf2ece0), wall: barnWall, harvest: "wood", ends: false });
  gableRoof(y, { cx: bx, cz: bz, hx, hz: hz * 0.55, base: gy + hgt + 2.6, rise: 3.2, ridgeX: true, overhang: 0.35,
    roof: surf(pal.roofMat, pal.roof), trim: surf("woodPlank", 0xf2ece0), wall: barnWall, harvest: "wood" });
  // Hay door and hoist beam in the gable, high up. Pure silhouette.
  y.box(surf("woodPlank", 0x8a6238), bx + hx - 0.05, gy + hgt + 3.4, bz, 0.12, 1.3, 1.1, { bevel: 0.02 });
  y.box(surf("woodLog", 0x6d5233), bx + hx + 0.9, gy + hgt + 5.0, bz, 1.1, 0.13, 0.13, { bevel: 0.02 });
  if (tier.interiors) {
    floorSlab(y, bx - hx + 0.5, bz - hz + 0.5, bx - 2, bz + hz - 0.5, gy + FLOOR_H, surf("woodPlank", 0x9a7644), "wood");
  }

  // --- silo ---
  y.group = "mill-silo";
  const sx = snap(cx + 10), sz2 = snap(cz - 12);
  y.cyl(surf("concrete", 0xcfc7b6), sx, gy + 8.5, sz2, 4.2, 4.2, 17, { seg: tier.round + 6, capTop: false });
  for (let b = 1; b < 6; b++) y.cyl(trim, sx, gy + b * 2.8, sz2, 4.3, 4.3, 0.12, { seg: tier.round + 6, capTop: false });
  y.dome(surf("metalPanel", 0x9aa2a4), sx, gy + 17, sz2, 4.2, 2.6, tier.round + 6);
  y.cyl(surf("metalPanel", 0x9aa2a4), sx, gy + 20.2, sz2, 0.4, 0.4, 1.2, { seg: 8 });
  y.solid(sx, gy + 8.5, sz2, 4.2, 8.5, 4.2, "concrete", "stone");
  ladder(y, sx + 4.3, sz2, gy + 1.2, 16, 1, 0, trim);

  // --- farmhouse ---
  y.group = "mill-house";
  building(y, {
    cx: snap(cx + 22), cz: snap(cz + 16), hx: 8, hz: 6, base: gy, floors: 2,
    pal, rng, tier, roofKind: "gable", ridgeX: true, front: 0,
    wallColor: 0xf0ece1, wallMat: "plaster", interior: true, balconyChance: 0,
  });
  // Porch: posts and a shed roof across the front. The detail that says "house".
  {
    const px = snap(cx + 22), pz = snap(cz + 16) + 6;
    y.solidBox(surf("woodPlank", 0xb59a72), px, gy + 0.22, pz + 1.2, 8, 0.22, 1.4, "wood", { bevel: 0.04 });
    for (const off of [-7, -2.4, 2.4, 7]) {
      y.solidBox(surf("woodPlank", 0xf0ece1), px + off, gy + 1.6, pz + 2.2, 0.13, 1.4, 0.13, "wood", { bevel: 0.02 });
    }
    y.box(surf(pal.roofMat, pal.roof), px, gy + 3.2, pz + 1.3, 8.3, 0.12, 1.7, { bevel: 0.03, pitch: -0.22 });
    railing(y, px - 8, pz + 2.4, px + 8, pz + 2.4, gy + 0.44, 0.95, surf("woodPlank", 0xf0ece1));
  }

  // --- windmill ---
  y.group = "mill-windmill";
  {
    const wx = snap(cx - 40), wz = snap(cz + 20);
    y.cyl(surf("brick", 0xcbbba4), wx, gy + 6, wz, 3.4, 2.2, 12, { seg: tier.round + 4, capTop: false });
    y.solid(wx, gy + 6, wz, 3.2, 6, 3.2, "concrete", "stone");
    y.dome(surf("roofShingle", 0x4a4238), wx, gy + 12, wz, 2.5, 2.2, tier.round + 4);
    // Sails: four boxes on a hub, each latticed with three cross-battens.
    const hubY = gy + 11.4;
    y.cyl(surf("woodLog", 0x6d5233), wx, hubY, wz + 2.6, 0.35, 0.35, 1.2, { seg: 8, pitch: Math.PI / 2 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      y.box(surf("woodPlank", 0xd9cdb4), wx + c * 5.2, hubY + sn * 5.2, wz + 3.3, 5.2, 0.75, 0.09, { bevel: 0.02, roll: a });
      for (let k = -1; k <= 1; k++) {
        y.box(surf("woodLog", 0x6d5233), wx + c * (5.2 + k * 2.4), hubY + sn * (5.2 + k * 2.4), wz + 3.4, 0.07, 0.8, 0.07, { bevel: 0.01, roll: a });
      }
    }
  }

  // --- paddocks and clutter ---
  y.group = "mill-props";
  for (let f = 0; f < 2; f++) {
    const fx = cx - 34 + f * 60, fz = cz + 34;
    for (let i = 0; i < 8; i++) {
      y.inst("fence|farm", surf("woodPlank", 0xd8d0be), fenceProto, xf(fx + i * 3.9 - 14, gy, fz, 0));
      y.inst("fence|farm", surf("woodPlank", 0xd8d0be), fenceProto, xf(fx - 14, gy, fz - i * 3.9, Math.PI / 2));
      y.solid(fx + i * 3.9 - 14, gy + 0.62, fz, 1.95, 0.62, 0.1, "wood", "wood");
    }
  }
  const n = Math.round(24 * tier.props);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2, rr = 20 + rng() * 34;
    const px = cx + Math.cos(a) * rr, pz = cz + Math.sin(a) * rr * 0.85;
    if (rng() < 0.6) {
      y.inst("bale", surf("fabric", 0xc9a45c), baleProto, xf(px, gy, pz, rng() * 6.28));
      y.solid(px, gy + 0.78, pz, 0.9, 0.78, 0.9, "dirt", "wood");
    } else {
      y.inst("crate|farm", surf("woodPlank", 0xa8804f), crateProto, xf(px, gy, pz, rng() * 6.28));
    }
  }
}

/* ---------------------------------------------------------------- mansion */

/**
 * VISTA VILLA — white plaster, slate and gold on a headland.
 *
 * The one symmetrical composition on the island. Everything else is
 * opportunistic; this is axial: a central block with a portico, two wings, a
 * terraced descent to a pool, and a parterre of clipped hedges. Symmetry is
 * what makes a building read as wealthy, and it costs nothing to author.
 */
function buildVistaVilla(s: Site): void {
  const { y, rng, tier, pal } = s;
  const cx = snap(s.cx), cz = snap(s.cz), gy = s.gy;
  const trim = surf("concrete", pal.trim);
  const stoneS = surf("plaster", pal.wall);

  y.group = "villa-ground";
  apron(s, cx, cz, 54, 46, gy, surf("concrete", 0xbcb3a2), surf("concrete", 0xd6cfc0));

  // Terraces: three steps down toward the view, each with a balustrade.
  y.group = "villa-terrace";
  for (let t = 1; t <= 3; t++) {
    const ty = gy - t * 1.2;
    y.solidBox(surf("concrete", 0xc7bfae), cx, ty - 0.6, cz + t * 9, 54 - t * 3, 0.6, 6, "stone", { bevel: 0.05 });
    railing(y, cx - 54 + t * 3, cz + t * 9 + 6, cx + 54 - t * 3, cz + t * 9 + 6, ty, 1.05, trim);
    // A flight down the axis so the terraces connect.
    stairs(y, cx, cz + t * 9 - 4.2, ty, 1.2, 5, 3.6, 0, surf("concrete", 0xd2cabb), trim, "stone");
  }

  // --- the house ---
  y.group = "villa-house";
  building(y, {
    cx, cz: snap(cz - 14), hx: 14, hz: 9, base: gy, floors: 2,
    pal, rng, tier, roofKind: "gable", ridgeX: true, front: 0,
    wallColor: pal.wall, wallMat: "plaster", interior: true, balconyChance: 1,
  });
  for (const sgn of [-1, 1]) {
    building(y, {
      cx: snap(cx + sgn * 22), cz: snap(cz - 12), hx: 8, hz: 7, base: gy, floors: 1,
      pal, rng, tier, roofKind: "gable", ridgeX: false, front: 0,
      wallColor: pal.wall, wallMat: "plaster", interior: true, balconyChance: 0,
    });
  }
  // Portico: six columns, an entablature and a pediment over the front door.
  {
    const py = gy, pz = snap(cz - 14) + 9;
    for (let i = 0; i < 6; i++) {
      const px = cx - 6.5 + i * 2.6;
      y.cyl(surf("plaster", 0xf6f2e8), px, py + 3.1, pz + 2.2, 0.42, 0.36, 6.2, { seg: tier.round, capTop: false });
      y.cyl(trim, px, py + 0.2, pz + 2.2, 0.55, 0.52, 0.4, { seg: tier.round });
      y.cyl(trim, px, py + 6.35, pz + 2.2, 0.52, 0.5, 0.34, { seg: tier.round });
      y.solid(px, py + 3.1, pz + 2.2, 0.45, 3.1, 0.45, "concrete", "stone");
    }
    y.box(trim, cx, py + 6.9, pz + 2.2, 8.2, 0.45, 1.5, { bevel: 0.04 });
    y.box(surf("plaster", 0xf6f2e8), cx, py + 7.5, pz + 2.2, 8.0, 0.2, 1.3, { bevel: 0.03 });
    y.emit(surf("plaster", 0xf6f2e8), wedgeGeo(0.7, 1.5, 8.3), xf(cx, py + 9.2, pz + 2.2, Math.PI / 2));
    y.solid(cx, py + 8, pz + 2.2, 8.2, 1.6, 1.5, "concrete", "stone");
    y.solidBox(surf("concrete", 0xd8d1c2), cx, py + 0.11, pz + 1.6, 8.4, 0.11, 3.2, "stone", { bevel: 0.04 });
  }

  // --- the pool ---
  y.group = "villa-pool";
  {
    const px = cx, pz = cz + 28;
    y.solidBox(surf("concrete", 0xd9d2c2), px, gy - 1.35, pz, 12, 0.3, 7, "stone", { bevel: 0.04 });
    for (const [ox, oz, ax2, az2] of [[0, 7, 12, 0.6], [0, -7, 12, 0.6], [12, 0, 0.6, 7.6], [-12, 0, 0.6, 7.6]]) {
      y.solidBox(surf("concrete", 0xe4ddcd), px + ox, gy - 1.0, pz + oz, ax2, 0.65, az2, "stone", { bevel: 0.05 });
    }
    // The water: a tinted glass plane just under the coping, with a darker
    // basin beneath so it has depth instead of being a blue rectangle.
    y.box(surf("concrete", 0x2f7f96), px, gy - 1.6, pz, 11.6, 0.05, 6.6, { bevel: 0 });
    y.box(surf("glass", 0x54c6de), px, gy - 0.78, pz, 11.6, 0.05, 6.6, { bevel: 0 });
    // Diving board and two loungers.
    y.box(surf("metalPanel", 0xcfd4d2), px - 12.6, gy - 0.5, pz, 1.6, 0.07, 0.5, { bevel: 0.02 });
    y.box(trim, px - 13.4, gy - 0.85, pz, 0.2, 0.35, 0.45, { bevel: 0.03 });
    for (const sgn of [-1, 1]) {
      const lx = px + sgn * 5, lz = pz + 8.6;
      y.box(surf("fabric", 0xf2ede0), lx, gy - 0.55, lz, 0.8, 0.06, 1.7, { bevel: 0.03, pitch: 0.12 });
      for (const o of [-0.6, 0.6]) y.box(trim, lx + o, gy - 0.78, lz, 0.05, 0.22, 1.6, { bevel: 0.01 });
    }
  }

  // --- parterre ---
  y.group = "villa-garden";
  const hedge = surf("foliage", 0x3f6b2e);
  for (let i = 0; i < 10; i++) {
    for (const sgn of [-1, 1]) {
      const hx2 = cx + sgn * (16 + (i % 2) * 3);
      const hz2 = cz + 2 + i * 3.4;
      y.inst("hedge|villa", hedge, hedgeProto, xf(hx2, gy, hz2, i % 2 ? Math.PI / 2 : 0));
      y.solid(hx2, gy + 0.6, hz2, 1.5, 0.6, 0.7, "grass", "wood");
    }
  }
  // Gate piers and a pair of urns on the drive.
  for (const sgn of [-1, 1]) {
    const gx = cx + sgn * 7.5, gz = cz - 42;
    y.solidBox(surf("plaster", 0xf2ede0), gx, gy + 1.6, gz, 0.85, 1.6, 0.85, "stone", { bevel: 0.05 });
    y.box(trim, gx, gy + 3.32, gz, 1.05, 0.14, 1.05, { bevel: 0.03 });
    y.cyl(surf("gold", 0xcfa953), gx, gy + 3.75, gz, 0.34, 0.24, 0.7, { seg: 10 });
  }
  const n = Math.round(10 * tier.props);
  for (let i = 0; i < n; i++) {
    const px = cx + (rng() - 0.5) * 80, pz = cz + (rng() - 0.5) * 70;
    y.inst("hedge|villa", hedge, hedgeProto, xf(px, groundAt(s, px, pz), pz, rng() * 6.28));
  }
}

/* ------------------------------------------------------------------ ruins */

/**
 * BROKEN BASILICA — a quarried hillside with a temple half out of it.
 *
 * All rock, all stone harvest, and the only district with deliberately BROKEN
 * silhouettes: columns snapped at three different heights, a collapsed
 * entablature, spoil heaps. Ruin reads as ruin only when the damage is
 * irregular, so the column heights come off the RNG and never repeat.
 */
function buildBrokenBasilica(s: Site): void {
  const { y, rng, tier } = s;
  const cx = snap(s.cx), cz = snap(s.cz), gy = s.gy;
  const rock = surf("rock", 0xa39d90);
  const cut = surf("rock", 0xb8b2a3);
  const moss = surf("rock", 0x8c9179);

  y.group = "basilica-quarry";
  // Quarry benches: four stepped shelves cut into the slope, each with a
  // rubble toe. This is the terrain the district is named for.
  for (let i = 0; i < 4; i++) {
    const w = 46 - i * 7;
    const yy = gy + i * 3.2;
    y.solidBox(cut, cx - 36, yy - 1.6, cz - 10 + i * 8, w, 1.6, 8 - i * 0.6, "stone", { bevel: 0.12, mask: F_NO_BOTTOM });
    for (let k = 0; k < 6; k++) {
      const px = cx - 36 - w + rng() * w * 2;
      const pz = cz - 10 + i * 8 + (rng() - 0.5) * 6;
      y.box(rock, px, yy - 1.9 + rng() * 0.4, pz, 0.5 + rng() * 0.9, 0.4 + rng() * 0.6, 0.5 + rng() * 0.9,
        { bevel: 0.14, yaw: rng() * 6.28, pitch: (rng() - 0.5) * 0.4 });
    }
  }

  // --- the temple ---
  y.group = "basilica-temple";
  const tx = snap(cx + 18), tz = snap(cz + 4);
  const hx = 15, hz = 10;
  // Stylobate: three steps all the way round. Nothing says "temple" faster.
  for (let i = 0; i < 3; i++) {
    y.solidBox(cut, tx, gy + 0.28 + i * 0.55, tz, hx + 2.2 - i * 0.7, 0.28, hz + 2.2 - i * 0.7, "stone", { bevel: 0.05 });
  }
  const colBase = gy + 1.65;
  const cols: Array<[number, number]> = [];
  for (let i = 0; i < 8; i++) {
    cols.push([tx - hx + 1.2 + (i * (hx * 2 - 2.4)) / 7, tz - hz + 1.2]);
    cols.push([tx - hx + 1.2 + (i * (hx * 2 - 2.4)) / 7, tz + hz - 1.2]);
  }
  for (let i = 1; i < 5; i++) {
    cols.push([tx - hx + 1.2, tz - hz + 1.2 + (i * (hz * 2 - 2.4)) / 5]);
    cols.push([tx + hx - 1.2, tz - hz + 1.2 + (i * (hz * 2 - 2.4)) / 5]);
  }
  let intact = 0;
  for (const [px, pz] of cols) {
    const roll = rng();
    const h = roll < 0.42 ? 7.2 : roll < 0.7 ? 3.4 + rng() * 2.4 : 1.1 + rng() * 1.4;
    if (h > 7) intact++;
    // Fluting: an 8- or 12-sided shaft with a slight entasis (top narrower).
    y.cyl(cut, px, colBase + h * 0.5, pz, 0.62, 0.54, h, { seg: tier.round, capTop: true });
    y.cyl(cut, px, colBase + 0.12, pz, 0.78, 0.72, 0.24, { seg: tier.round });
    if (h > 7) {
      y.cyl(cut, px, colBase + h + 0.16, pz, 0.6, 0.78, 0.32, { seg: tier.round });
      y.box(cut, px, colBase + h + 0.48, pz, 0.85, 0.16, 0.85, { bevel: 0.04 });
    }
    y.solid(px, colBase + h * 0.5, pz, 0.62, h * 0.5, 0.62, "concrete", "stone");
  }
  // The surviving stretch of entablature, over the intact colonnade only.
  if (intact > 3) {
    y.solidBox(cut, tx - hx * 0.45, colBase + 8.3, tz - hz + 1.2, hx * 0.55, 0.65, 0.95, "stone", { bevel: 0.05 });
    y.box(moss, tx - hx * 0.45, colBase + 9.1, tz - hz + 1.2, hx * 0.57, 0.16, 1.15, { bevel: 0.04 });
  }
  // Cella: the inner room, roofless, with a doorway and a fallen lintel.
  for (const dir of [0, 1, 2, 3]) {
    const alongX = dir < 2;
    const sgn = dir % 2 === 0 ? 1 : -1;
    const ihx = hx - 4, ihz = hz - 3.4;
    wall(y, {
      x0: alongX ? tx - ihx : tx + sgn * ihx,
      z0: alongX ? tz + sgn * ihz : tz - ihz,
      x1: alongX ? tx + ihx : tx + sgn * ihx,
      z1: alongX ? tz + sgn * ihz : tz + ihz,
      base: gy + 1.65, top: gy + 1.65 + (dir === 1 ? 2.6 : 5.4),
      t: 0.7,
      body: cut, trim: moss,
      harvest: "stone",
      openings: dir === 0 ? [{ u: ihx, w: 2.4, sill: 0, h: 3.6, kind: "hole" }] : [],
      plinth: 0.3,
    });
  }
  // Fallen drums and blocks across the floor: the ruin's read at ground level.
  for (let i = 0; i < 16; i++) {
    const px = tx + (rng() - 0.5) * hx * 2.2;
    const pz = tz + (rng() - 0.5) * hz * 2.2;
    if (rng() < 0.5) {
      y.cyl(cut, px, gy + 2.2, pz, 0.6, 0.56, 1.1, { seg: tier.round, roll: Math.PI / 2, yaw: rng() * 6.28 });
      y.solid(px, gy + 2.25, pz, 0.7, 0.6, 0.7, "concrete", "stone");
    } else {
      y.box(rock, px, gy + 2.05, pz, 0.7 + rng() * 0.6, 0.35, 0.6 + rng() * 0.5, { bevel: 0.1, yaw: rng() * 6.28 });
    }
  }

  // --- quarry works ---
  y.group = "basilica-works";
  const wx = snap(cx - 46), wz = snap(cz + 30);
  y.solidBox(surf("corrugated", 0x8e9490), wx, gy + 3, wz, 9, 3, 6, "metal", { bevel: 0.05, mask: F_NO_BOTTOM });
  gableRoof(y, { cx: wx, cz: wz, hx: 9, hz: 6, base: gy + 6, rise: 2, ridgeX: true, overhang: 0.6,
    roof: surf("corrugated", 0x6f7570), trim: surf("metalPanel", 0xb9bcb6), wall: surf("corrugated", 0x8e9490), harvest: "metal" });
  pipeRun(y, wx + 9, wz, wx + 26, wz, gy + 4.2, 0.5, surf("metalPanel", 0x9aa0a2), surf("metalPanel", 0x6c7274), tier.round);
  const n = Math.round(22 * tier.props);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2, rr = 20 + rng() * 44;
    const px = cx + Math.cos(a) * rr, pz = cz + Math.sin(a) * rr * 0.8;
    const g = groundAt(s, px, pz);
    if (rng() < 0.55) {
      y.box(rock, px, g + 0.55, pz, 0.55 + rng() * 0.7, 0.55, 0.5 + rng() * 0.6, { bevel: 0.15, yaw: rng() * 6.28, pitch: (rng() - 0.5) * 0.3 });
      y.solid(px, g + 0.55, pz, 0.8, 0.55, 0.8, "concrete", "stone");
    } else {
      y.inst("crate|quarry", surf("woodPlank", 0x8f6f45), crateProto, xf(px, g, pz, rng() * 6.28));
    }
  }
}

/* --------------------------------------------------------------- research */

/**
 * SIGNAL SUMMIT — the ridge station.
 *
 * White composite panels, safety orange and a 22 m dish. The dish is the whole
 * district: a parabola on an altazimuth mount, tipped 35° off vertical so it
 * catches the sky in reflection and throws a huge readable shadow across the
 * ridge. Everything else here is deliberately low so it does not compete.
 */
function buildSignalSummit(s: Site): void {
  const { y, rng, tier, pal } = s;
  const cx = snap(s.cx), cz = snap(s.cz), gy = s.gy;
  const panel = surf("metalPanel", pal.wall);
  const trim = surf("metalPanel", pal.trim);
  const accent = surf("metalPanel", pal.accent);

  y.group = "summit-ground";
  apron(s, cx, cz, 44, 40, gy, surf("concrete", 0x807d78), surf("metalPanel", pal.accent), "stone");

  // --- the dish ---
  y.group = "summit-dish";
  {
    const dx = snap(cx - 8), dz = snap(cz - 10);
    // Pedestal, turntable, yoke.
    y.cyl(surf("concrete", 0xb0aca4), dx, gy + 2.4, dz, 4.2, 3.6, 4.8, { seg: tier.round + 4 });
    y.solid(dx, gy + 2.4, dz, 4.0, 2.4, 4.0, "concrete", "stone");
    y.cyl(trim, dx, gy + 5.1, dz, 3.0, 3.0, 0.8, { seg: tier.round + 4 });
    for (const sgn of [-1, 1]) {
      y.box(accent, dx + sgn * 2.6, gy + 8.2, dz, 0.5, 3.2, 0.8, { bevel: 0.05 });
    }
    // The dish: a shallow inverted dome, a rim ring, six radial ribs and a
    // quadripod feed at the focus.
    const tilt = -0.62;
    const R = 11;
    const m = xf(dx, gy + 11.4, dz, 0, tilt, 0);
    y.emit(surf("metalPanel", 0xe8e9e6), dome(R, -3.4, tier.round + 10, 5), m);
    const back = dome(R * 0.995, -3.25, tier.round + 10, 5);
    flipFaces(back);
    y.emit(surf("metalPanel", 0xb6bbbd), back, m);
    y.emit(trim, cylinder(R, R, 0.4, tier.round + 10, false, false), xf(dx, gy + 11.4, dz, 0, tilt, 0));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI;
      y.emit(trim, bevelBox(R, 0.12, 0.16, 0.03), xf(dx, gy + 11.2, dz, a, tilt, 0));
    }
    const fdx = dx - Math.sin(tilt) * 0, fy = gy + 11.4 + Math.cos(tilt) * 6.4, fdz = dz + Math.sin(tilt) * 6.4;
    y.box(accent, fdx, fy, fdz, 0.55, 0.55, 0.9, { bevel: 0.06 });
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      y.box(trim, dx + ox * 3.4, gy + 11.4 + (fy - gy - 11.4) * 0.5, dz + oz * 3.4 + Math.sin(tilt) * 3.2,
        0.09, 3.4, 0.09, { bevel: 0.02, pitch: oz * 0.42, roll: -ox * 0.42 });
    }
    y.solid(dx, gy + 12, dz, R * 0.9, 4, R * 0.6, "metal", "metal");
  }

  // --- the labs ---
  y.group = "summit-labs";
  for (let i = 0; i < 2; i++) {
    const bx = snap(cx + 20), bz = snap(cz - 6 + i * 20);
    // On stilts: a mountain station never sits on the ground, and the gap under
    // it is a fighting space.
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      y.solidBox(trim, bx + ox * 6.4, gy + 0.7, bz + oz * 4.4, 0.3, 0.7, 0.3, "metal", { bevel: 0.03 });
    }
    floorSlab(y, bx - 7, bz - 5, bx + 7, bz + 5, gy + 1.6, surf("metalPanel", 0x9fa4a6), "metal");
    for (const dir of [0, 1, 2, 3]) {
      const alongX = dir < 2;
      const sgn = dir % 2 === 0 ? 1 : -1;
      const L = alongX ? 14 : 10;
      wall(y, {
        x0: alongX ? bx - 7 : bx + sgn * (7 - WALL_T * 0.5),
        z0: alongX ? bz + sgn * (5 - WALL_T * 0.5) : bz - 5,
        x1: alongX ? bx + 7 : bx + sgn * (7 - WALL_T * 0.5),
        z1: alongX ? bz + sgn * (5 - WALL_T * 0.5) : bz + 5,
        base: gy + 1.6, top: gy + 1.6 + 3.6,
        body: panel, trim, glass: surf("glass", 0xc9e6ef),
        harvest: "metal",
        openings: dir === 3
          ? [{ u: L * 0.5, w: 1.4, sill: 0, h: 2.4, kind: "door" }]
          : [{ u: L * 0.28, w: 2.2, sill: 1.2, h: 1.5, kind: "window" }, { u: L * 0.72, w: 2.2, sill: 1.2, h: 1.5, kind: "window" }],
      });
    }
    flatRoof(y, bx, bz, 7, 5, gy + 5.2, surf("metalPanel", 0xc8ccce), trim, "metal", 0.4);
    stairs(y, bx - 8.4, bz, gy, 1.6, 1.6, 2.4, 0, surf("metalPanel", 0x8f9497), trim, "metal");
    if (tier.trim) {
      acUnit(y, bx + 3.4, bz + 2, gy + 5.3, surf("metalPanel", 0xb9bec2), trim, 0.3);
      // Antenna array on the roof: four whips and a small drum.
      for (let k = 0; k < 4; k++) {
        y.cyl(accent, bx - 5 + k * 1.4, gy + 7.2, bz - 3.4, 0.05, 0.02, 3.6, { seg: 5 });
      }
      y.cyl(surf("metalPanel", 0xe4e6e5), bx - 2, gy + 6.6, bz + 3.2, 1.1, 1.1, 1.0, { seg: tier.round });
    }
  }

  // --- mast and clutter ---
  y.group = "summit-mast";
  {
    const mx = snap(cx + 2), mz = snap(cz + 24);
    const h = 26;
    y.cyl(trim, mx, gy + h * 0.5, mz, 0.55, 0.34, h, { seg: 6, capTop: false });
    y.solid(mx, gy + h * 0.5, mz, 0.6, h * 0.5, 0.6, "metal", "metal");
    for (let i = 0; i < 5; i++) {
      const yy = gy + 3 + i * 5;
      y.box(accent, mx, yy, mz, 1.5, 0.09, 0.11, { bevel: 0.02, yaw: i * 0.7 });
      y.cyl(i % 2 ? accent : surf("metalPanel", 0xe6e8e7), mx, yy + 1.2, mz, 0.28, 0.28, 0.5, { seg: 8 });
    }
    // Guy wires as thin raking boxes: three anchors, 120° apart.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const axp = mx + Math.cos(a) * 12, azp = mz + Math.sin(a) * 12;
      const len = Math.hypot(12, h * 0.75);
      y.box(trim, (mx + axp) * 0.5, gy + h * 0.375, (mz + azp) * 0.5, 0.035, len * 0.5, 0.035,
        { bevel: 0, yaw: a + Math.PI / 2, roll: Math.atan2(12, h * 0.75) });
      y.box(surf("concrete", 0x9c988f), axp, gy + 0.3, azp, 0.5, 0.3, 0.5, { bevel: 0.04 });
    }
  }
  const n = Math.round(14 * tier.props);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2, rr = 16 + rng() * 22;
    const px = cx + Math.cos(a) * rr, pz = cz + Math.sin(a) * rr;
    const g = groundAt(s, px, pz);
    if (rng() < 0.5) y.inst("crate|summit", surf("metalPanel", 0xd8d4cb), crateProto, xf(px, g, pz, rng() * 6.28));
    else y.inst("barrel|summit", surf("metalPanel", 0xd2762c), barrelProto, xf(px, g, pz, rng() * 6.28));
  }
  // Solar array: six tilted dark panels on a rail. Reads as "science" instantly.
  for (let i = 0; i < 6; i++) {
    const px = cx - 32, pz = cz + 6 + i * 3.4;
    // Opaque, not glass: a transparent material here lets you see the ridge
    // through the array, and a PV panel is a mirror-dark solid anyway.
    y.box(surf("metalPanel", 0x1d2a44), px, gy + 1.9, pz, 2.4, 0.07, 1.5, { bevel: 0.02, roll: 0.5 });
    for (const sgn of [-1, 1]) y.box(trim, px + sgn * 1.9, gy + 1.1, pz, 0.08, 1.1, 0.08, { bevel: 0.02 });
    y.solid(px, gy + 1.6, pz, 2.4, 1.0, 1.5, "metal", "metal");
  }
}

/* ------------------------------------------------------------ minor camps */

function tentProto(): Geo {
  const g = new Geo();
  mergeGeo(g, wedgeGeo(2.2, 1.5, 1.7), xf(0, 1.5, 0, Math.PI / 2));
  // Ridge pole overhanging both ends, and two guy pegs. Three extra boxes.
  mergeGeo(g, bevelBox(0.07, 0.07, 2.6, 0.02), xf(0, 3.02, 0));
  for (const sgn of [-1, 1]) mergeGeo(g, bevelBox(0.05, 0.28, 0.05, 0.01), xf(sgn * 2.9, 0.28, 0));
  return g;
}

/**
 * TIMBER TENTS — a logging camp. Stacked log piles, a saw shed, canvas.
 * Minor tier: four structures, no interiors, but the same trim discipline.
 */
function buildTimberTents(s: Site): void {
  const { y, rng, tier, pal } = s;
  const cx = snap(s.cx), cz = snap(s.cz), gy = s.gy;
  const trim = surf("woodPlank", pal.trim);
  y.group = "timber";
  apron(s, cx, cz, 30, 26, gy, surf("dirt", 0x8a7350), surf("woodLog", 0x6d5233), "wood");

  // Saw shed: three walls and a roof, so it is cover you can be flanked in.
  const bx = snap(cx - 10), bz = snap(cz - 6);
  for (const dir of [1, 2, 3]) {
    const alongX = dir < 2;
    const sgn = dir % 2 === 0 ? 1 : -1;
    wall(y, {
      x0: alongX ? bx - 8 : bx + sgn * (8 - WALL_T * 0.5),
      z0: alongX ? bz + sgn * (5 - WALL_T * 0.5) : bz - 5,
      x1: alongX ? bx + 8 : bx + sgn * (8 - WALL_T * 0.5),
      z1: alongX ? bz + sgn * (5 - WALL_T * 0.5) : bz + 5,
      base: gy, top: gy + 4,
      body: surf("woodPlank", pal.wall), trim, glass: surf("glass", 0xd6e9ee),
      harvest: "wood",
      openings: dir === 2 ? [{ u: 5, w: 1.6, sill: 1.2, h: 1.4, kind: "window" }] : [],
      plinth: 0.4,
    });
  }
  gableRoof(y, { cx: bx, cz: bz, hx: 8, hz: 5, base: gy + 4, rise: 2.2, ridgeX: true, overhang: 0.8,
    roof: surf(pal.roofMat, pal.roof), trim, wall: surf("woodPlank", pal.wall), harvest: "wood" });

  // Log decks: two pyramids of stacked logs, cribbed at the ends.
  for (let d = 0; d < 2; d++) {
    const lx = cx + 12, lz = cz - 8 + d * 16;
    for (let r = 0; r < 4; r++) {
      const count = 5 - r;
      for (let i = 0; i < count; i++) {
        const off = (i - (count - 1) / 2) * 0.66;
        y.inst("log", surf("bark", 0x6b5236), logProto, xf(lx + off, gy + r * 0.58, lz, 0));
      }
    }
    y.solid(lx, gy + 1.2, lz, 1.8, 1.2, 2.2, "wood", "wood");
    for (const sgn of [-1, 1]) {
      y.solidBox(surf("woodLog", 0x5f4a30), lx + sgn * 2.3, gy + 1.3, lz, 0.16, 1.3, 0.16, "wood", { bevel: 0.02 });
    }
  }

  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.6;
    const px = cx + Math.cos(a) * 16, pz = cz + Math.sin(a) * 14;
    y.inst("tent", surf("fabric", pal.accent), tentProto, xf(px, groundAt(s, px, pz), pz, a));
    y.solid(px, groundAt(s, px, pz) + 1.4, pz, 2.4, 1.4, 2.0, "dirt", "wood");
  }
  // Fire ring: eight stones and a spit. The camp's focal point.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    y.box(surf("rock", 0x8d8880), cx + Math.cos(a) * 1.5, gy + 0.16, cz + Math.sin(a) * 1.5, 0.28, 0.16, 0.28, { bevel: 0.08, yaw: a });
  }
  const n = Math.round(12 * tier.props);
  for (let i = 0; i < n; i++) {
    const px = cx + (rng() - 0.5) * 46, pz = cz + (rng() - 0.5) * 40;
    y.inst("crate|timber", surf("woodPlank", 0x9a7548), crateProto, xf(px, groundAt(s, px, pz), pz, rng() * 6.28));
  }
}

/**
 * STONEWALL STAND — a ruined hill fort. Curtain wall, one surviving corner
 * tower, tents in the bailey. All stone: the best minor drop for metal-free
 * defensive material early.
 */
function buildStonewallStand(s: Site): void {
  const { y, rng, tier, pal } = s;
  const cx = snap(s.cx), cz = snap(s.cz), gy = s.gy;
  const stone = surf("rock", pal.wall);
  const trim = surf("rock", pal.trim);
  y.group = "stonewall";
  apron(s, cx, cz, 26, 24, gy, surf("dirt", 0x8f8a76), trim, "stone");

  // Curtain wall with a gate and a collapsed stretch on the south side.
  const hx = 22, hz = 20;
  for (const dir of [0, 1, 2, 3]) {
    const alongX = dir < 2;
    const sgn = dir % 2 === 0 ? 1 : -1;
    const L = alongX ? hx * 2 : hz * 2;
    const h = dir === 0 ? 2.2 : 5.4;
    wall(y, {
      x0: alongX ? cx - hx : cx + sgn * hx,
      z0: alongX ? cz + sgn * hz : cz - hz,
      x1: alongX ? cx + hx : cx + sgn * hx,
      z1: alongX ? cz + sgn * hz : cz + hz,
      base: gy, top: gy + h,
      t: 1.0,
      body: stone, trim,
      harvest: "stone",
      openings: dir === 1 ? [{ u: L * 0.5, w: 3.4, sill: 0, h: 3.6, kind: "hole" }] : [],
      plinth: 0.5,
    });
    // Crenellations along the top of the surviving stretches.
    if (h > 3) {
      const merlons = Math.floor(L / 2.4);
      for (let i = 0; i < merlons; i++) {
        const u = -L * 0.5 + 1.2 + i * 2.4;
        if (rng() < 0.22) continue;
        y.box(stone, alongX ? cx + u : cx + sgn * hx, gy + h + 0.45, alongX ? cz + sgn * hz : cz + u,
          alongX ? 0.7 : 0.55, 0.45, alongX ? 0.55 : 0.7, { bevel: 0.06 });
      }
    }
  }
  // The tower: round, four storeys, half of its top course gone.
  const tx = cx - hx, tz = cz - hz;
  y.cyl(stone, tx, gy + 6.5, tz, 4.4, 4.0, 13, { seg: tier.round + 4, capTop: false });
  y.solid(tx, gy + 6.5, tz, 4.2, 6.5, 4.2, "concrete", "stone");
  y.cyl(trim, tx, gy + 13.3, tz, 4.6, 4.6, 0.6, { seg: tier.round + 4, capTop: true });
  for (let i = 0; i < 10; i++) {
    if (rng() < 0.3) continue;
    const a = (i / 10) * Math.PI * 2;
    y.box(stone, tx + Math.cos(a) * 4.2, gy + 14.1, tz + Math.sin(a) * 4.2, 0.62, 0.55, 0.5, { bevel: 0.06, yaw: a });
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const px = cx + Math.cos(a) * 10, pz = cz + Math.sin(a) * 9;
    y.inst("tent", surf("fabric", pal.accent), tentProto, xf(px, gy, pz, a));
    y.solid(px, gy + 1.4, pz, 2.4, 1.4, 2.0, "dirt", "wood");
  }
  const n = Math.round(12 * tier.props);
  for (let i = 0; i < n; i++) {
    const px = cx + (rng() - 0.5) * 40, pz = cz + (rng() - 0.5) * 36;
    const g = groundAt(s, px, pz);
    if (rng() < 0.5) y.inst("crate|fort", surf("woodPlank", 0x8f6f45), crateProto, xf(px, g, pz, rng() * 6.28));
    else y.box(surf("rock", 0x9a948a), px, g + 0.45, pz, 0.6, 0.45, 0.55, { bevel: 0.14, yaw: rng() * 6.28 });
  }
}

/**
 * LONELY LOOKOUT — a lighthouse on the east cliff, a keeper's cottage and a
 * fuel store. The tallest slim silhouette on the map after the stack.
 */
function buildLonelyLookout(s: Site): void {
  const { y, rng, tier, pal } = s;
  const cx = snap(s.cx), cz = snap(s.cz), gy = s.gy;
  const trim = surf("concrete", pal.trim);
  y.group = "lookout";
  apron(s, cx, cz, 22, 20, gy, surf("concrete", 0xa8a297), trim, "stone");

  // The tower: a tapered shaft in banded white and red, a gallery with a
  // railing, a glazed lantern room and a domed cap.
  const h = 26;
  y.cyl(surf("plaster", 0xf4f0e6), cx, gy + h * 0.5, cz, 3.6, 2.3, h, { seg: tier.round + 6, capTop: false });
  y.solid(cx, gy + h * 0.5, cz, 3.4, h * 0.5, 3.4, "concrete", "stone");
  for (let i = 0; i < 3; i++) {
    const t = 0.18 + i * 0.26;
    const r = lerp(3.6, 2.3, t) + 0.04;
    y.cyl(surf("plaster", pal.accent), cx, gy + t * h, cz, r, r, 2.6, { seg: tier.round + 6, capTop: false });
  }
  for (let i = 0; i < 4; i++) {
    const t = 0.22 + i * 0.19;
    const r = lerp(3.6, 2.3, t);
    const a = i * 1.9;
    y.box(surf("glass", 0xcfe6ee), cx + Math.cos(a) * r, gy + t * h, cz + Math.sin(a) * r, 0.1, 0.7, 0.5, { bevel: 0.02, yaw: a });
    y.box(trim, cx + Math.cos(a) * (r + 0.06), gy + t * h, cz + Math.sin(a) * (r + 0.06), 0.06, 0.85, 0.68, { bevel: 0.02, yaw: a });
  }
  const gal = gy + h;
  y.cyl(trim, cx, gal, cz, 3.5, 3.5, 0.35, { seg: tier.round + 6, capTop: true });
  y.solid(cx, gal, cz, 3.5, 0.35, 3.5, "metal", "metal");
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    y.box(trim, cx + Math.cos(a) * 3.35, gal + 0.65, cz + Math.sin(a) * 3.35, 0.05, 0.6, 0.05, { bevel: 0.01, yaw: a });
  }
  y.cyl(trim, cx, gal + 1.28, cz, 3.42, 3.42, 0.09, { seg: tier.round + 6, capTop: false });
  y.cyl(surf("glass", 0xdff2f7), cx, gal + 2.4, cz, 2.2, 2.2, 3.0, { seg: tier.round + 4, capTop: false });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    y.box(trim, cx + Math.cos(a) * 2.2, gal + 2.4, cz + Math.sin(a) * 2.2, 0.09, 1.5, 0.09, { bevel: 0.02, yaw: a });
  }
  y.cyl(surf("gold", 0xe0c070), cx, gal + 2.4, cz, 1.1, 1.1, 1.2, { seg: 10 });
  y.dome(surf("metalPanel", pal.roof), cx, gal + 3.9, cz, 2.4, 1.8, tier.round + 4);
  y.cyl(trim, cx, gal + 6.1, cz, 0.09, 0.03, 1.2, { seg: 6 });

  // Keeper's cottage and a fuel store.
  building(y, {
    cx: snap(cx + 12), cz: snap(cz + 10), hx: 6, hz: 5, base: gy, floors: 1,
    pal, rng, tier, roofKind: "gable", ridgeX: true, front: 0,
    wallColor: 0xeee9dc, wallMat: "plaster", interior: true, balconyChance: 0,
  });
  y.solidBox(surf("corrugated", 0x7f8a86), snap(cx - 12), gy + 1.6, snap(cz + 11), 3.4, 1.6, 2.6, "metal", { bevel: 0.05, mask: F_NO_BOTTOM });
  gableRoof(y, { cx: snap(cx - 12), cz: snap(cz + 11), hx: 3.4, hz: 2.6, base: gy + 3.2, rise: 1.1, ridgeX: true, overhang: 0.5,
    roof: surf("corrugated", 0x5f6a66), trim, wall: surf("corrugated", 0x7f8a86), harvest: "metal" });
  const n = Math.round(10 * tier.props);
  for (let i = 0; i < n; i++) {
    const px = cx + (rng() - 0.5) * 34, pz = cz + (rng() - 0.5) * 30;
    const g = groundAt(s, px, pz);
    y.inst("barrel|lookout", surf("metalPanel", 0xb04a2c), barrelProto, xf(px, g, pz, rng() * 6.28));
    y.solid(px, g + 0.46, pz, 0.36, 0.46, 0.36, "metal", "metal");
  }
}

/* ------------------------------------------------------------------------ *
 * Roads
 *
 * A hand-authored adjacency, splined and dropped onto the terrain. Two things
 * make the difference between "a grey stripe" and "a road":
 *
 *  - a LONGITUDINAL SMOOTH. The centreline height is the max of five
 *    cross-section samples, then blurred along the route, so the carriageway
 *    cuts into the uphill shoulder and rides over the downhill one instead of
 *    snaking over every hummock.
 *  - a RETAINING SKIRT. Wherever the smoothed surface floats above the ground,
 *    a vertical apron drops from the road edge to below the terrain. Without
 *    it you can see under the road, which is the single most common way a
 *    procedural road betrays itself.
 * ------------------------------------------------------------------------ */

interface RoadLink {
  a: string;
  b: string;
  /** Lateral offset of the midpoint control, metres. Gives the route a bend. */
  bow: number;
  width: number;
}

const ROAD_LINKS: RoadLink[] = [
  { a: "neon-heights", b: "lonely-lookout", bow: 90, width: 13 },
  { a: "neon-heights", b: "mill-hollow", bow: -120, width: 15 },
  { a: "neon-heights", b: "tilted-yard", bow: 150, width: 15 },
  { a: "tilted-yard", b: "palm-cove", bow: -70, width: 13 },
  { a: "tilted-yard", b: "salt-harbor", bow: 60, width: 13 },
  { a: "tilted-yard", b: "ridge-station", bow: -90, width: 13 },
  { a: "ridge-station", b: "the-quarry", bow: 70, width: 11 },
  { a: "ridge-station", b: "cargo-yard", bow: -80, width: 11 },
  { a: "the-quarry", b: "mill-hollow", bow: 40, width: 11 },
  { a: "the-quarry", b: "stonewall", bow: -50, width: 9 },
];

interface RoadNode {
  x: number;
  z: number;
  y: number;
  nx: number;
  nz: number;
}

function buildRoad(
  y: Yard,
  terrain: TerrainLike | undefined,
  from: THREE.Vector3, to: THREE.Vector3,
  bow: number, width: number, step: number,
  trimStart: number, trimEnd: number,
): void {
  const dx = to.x - from.x, dz = to.z - from.z;
  const len = Math.hypot(dx, dz);
  if (len < 40) return;
  const px = -dz / len, pz = dx / len;
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(from.x, 0, from.z),
    new THREE.Vector3(from.x + dx * 0.33 + px * bow * 0.7, 0, from.z + dz * 0.33 + pz * bow * 0.7),
    new THREE.Vector3(from.x + dx * 0.67 + px * bow, 0, from.z + dz * 0.67 + pz * bow),
    new THREE.Vector3(to.x, 0, to.z),
  ], false, "centripetal", 0.5);

  const total = curve.getLength();
  const count = Math.max(8, Math.round(total / step));
  const half = width * 0.5;
  const nodes: RoadNode[] = [];
  const tmp = new THREE.Vector3();
  const tan = new THREE.Vector3();
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    curve.getPoint(t, tmp);
    curve.getTangent(t, tan);
    const nx = -tan.z, nz = tan.x;
    const nl = Math.hypot(nx, nz) || 1;
    let hi = -Infinity;
    for (let k = -2; k <= 2; k++) {
      const o = (k / 2) * half;
      const sx = tmp.x + (nx / nl) * o, sz = tmp.z + (nz / nl) * o;
      hi = Math.max(hi, terrain ? terrain.heightAt(sx, sz) : 0);
    }
    nodes.push({ x: tmp.x, z: tmp.z, y: hi, nx: nx / nl, nz: nz / nl });
  }
  // Three blur passes. Enough to kill the hummocks, not enough to leave the
  // road hanging in the air on a real hillside.
  for (let pass = 0; pass < 3; pass++) {
    const src = nodes.map((n) => n.y);
    for (let i = 1; i < nodes.length - 1; i++) nodes[i].y = src[i - 1] * 0.25 + src[i] * 0.5 + src[i + 1] * 0.25;
  }

  const sea = terrain ? terrain.seaLevel : -999;
  const road = new Geo();
  road.uvMode = "metre";
  const skirt = new Geo();
  skirt.uvMode = "metre";
  const LIFT = 0.14;
  const CROWN = 0.13;
  let dist = 0;

  const marks: Array<[number, number, number, number, number]> = [];

  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    const tA = i / (nodes.length - 1);
    // Fade the road out inside each district's own hardstanding.
    if (tA < trimStart || tA > 1 - trimEnd) { dist += segLen; continue; }
    if (a.y < sea + 0.8 || b.y < sea + 0.8) { dist += segLen; continue; }

    const COLS = 4;
    for (let c = 0; c < COLS; c++) {
      const o0 = (c / COLS - 0.5) * width;
      const o1 = ((c + 1) / COLS - 0.5) * width;
      const cr0 = CROWN * (1 - Math.pow((o0 / half) * 1.0, 2));
      const cr1 = CROWN * (1 - Math.pow((o1 / half) * 1.0, 2));
      road.quad(
        a.x + a.nx * o0, a.y + LIFT + cr0, a.z + a.nz * o0,
        a.x + a.nx * o1, a.y + LIFT + cr1, a.z + a.nz * o1,
        b.x + b.nx * o1, b.y + LIFT + cr1, b.z + b.nz * o1,
        b.x + b.nx * o0, b.y + LIFT + cr0, b.z + b.nz * o0,
        0, 1, 0,
      );
      const uvBase = road.uv.length - 8;
      road.uv[uvBase] = o0; road.uv[uvBase + 1] = dist;
      road.uv[uvBase + 2] = o1; road.uv[uvBase + 3] = dist;
      road.uv[uvBase + 4] = o1; road.uv[uvBase + 5] = dist + segLen;
      road.uv[uvBase + 6] = o0; road.uv[uvBase + 7] = dist + segLen;
    }

    // Skirt: only where the smoothed surface stands proud of the ground.
    for (const sgn of [-1, 1]) {
      const ax = a.x + a.nx * half * sgn, az = a.z + a.nz * half * sgn;
      const bx = b.x + b.nx * half * sgn, bz = b.z + b.nz * half * sgn;
      const ag = terrain ? terrain.heightAt(ax, az) : a.y;
      const bg = terrain ? terrain.heightAt(bx, bz) : b.y;
      if (a.y + LIFT - ag < 0.12 && b.y + LIFT - bg < 0.12) continue;
      const ay = a.y + LIFT, by = b.y + LIFT;
      skirt.quad(
        ax, ay, az,
        bx, by, bz,
        bx, Math.min(bg, by) - 0.6, bz,
        ax, Math.min(ag, ay) - 0.6, az,
        a.nx * sgn, 0, a.nz * sgn,
      );
      const ub = skirt.uv.length - 8;
      skirt.uv[ub] = dist; skirt.uv[ub + 1] = 0;
      skirt.uv[ub + 2] = dist + segLen; skirt.uv[ub + 3] = 0;
      skirt.uv[ub + 4] = dist + segLen; skirt.uv[ub + 5] = -2;
      skirt.uv[ub + 6] = dist; skirt.uv[ub + 7] = -2;
    }

    // Continuous edge lines, and a dash on the centreline every other station.
    for (const sgn of [-1, 1]) {
      marks.push([
        (a.x + b.x) * 0.5 + a.nx * (half - 0.7) * sgn,
        (a.y + b.y) * 0.5 + LIFT + CROWN * 0.4,
        (a.z + b.z) * 0.5 + a.nz * (half - 0.7) * sgn,
        segLen * 0.5, Math.atan2(b.x - a.x, b.z - a.z),
      ]);
    }
    if (i % 2 === 0) {
      marks.push([
        (a.x + b.x) * 0.5, (a.y + b.y) * 0.5 + LIFT + CROWN,
        (a.z + b.z) * 0.5, segLen * 0.3, Math.atan2(b.x - a.x, b.z - a.z),
      ]);
    }
    dist += segLen;
  }

  if (!road.empty) y.emit(surf("asphalt", 0x53565b), road);
  if (!skirt.empty) y.emit(surf("dirt", 0x8f8069), skirt);
  const paintS = surf("concrete", 0xece0b4);
  for (const [mx, my, mz, hl, yaw] of marks) {
    y.box(paintS, mx, my + 0.012, mz, 0.13, 0.02, hl, { bevel: 0, mask: F_PY, yaw });
  }
}

/* ------------------------------------------------------------------------ *
 * District table
 * ------------------------------------------------------------------------ */

interface DistrictDef {
  /** Matches a terrain pad id when terrain booted; also the road-network key. */
  pad: string;
  name: string;
  tier: Poi["tier"];
  /** Poi radius published to loot and bots. */
  radius: number;
  /** Fallback centre when terrain (and therefore its pads) failed to boot. */
  fx: number;
  fz: number;
  pal: Palette;
  build: (s: Site) => void;
}

const DISTRICTS: DistrictDef[] = [
  {
    pad: "neon-heights", name: "Neon Heights", tier: "landmark", radius: 170, fx: 560, fz: -600,
    pal: {
      roof: 0xb85a34, roofMat: "roofTile", wall: 0xe8d9be, wallMat: "plaster", wallAlt: 0xd6c3a6,
      trim: 0xf4efe4, accent: 0xd4442f, accent2: 0x1f8fa8, harvest: "stone",
    },
    build: buildNeonHeights,
  },
  {
    pad: "tilted-yard", name: "Foundry Flats", tier: "major", radius: 110, fx: 330, fz: 420,
    pal: {
      roof: 0x2e7a74, roofMat: "corrugated", wall: 0x9aa5a4, wallMat: "corrugated", wallAlt: 0x7d8a89,
      trim: 0x40474a, accent: 0xe0801e, accent2: 0xc4402c, harvest: "metal",
    },
    build: buildFoundryFlats,
  },
  {
    pad: "salt-harbor", name: "Salt Harbor", tier: "major", radius: 120, fx: 120, fz: 800,
    pal: {
      roof: 0x44586b, roofMat: "roofShingle", wall: 0xdcd6c6, wallMat: "woodPlank", wallAlt: 0xb9c6c9,
      trim: 0xf4f0e6, accent: 0xc4562f, accent2: 0x2f6f9c, harvest: "wood",
    },
    build: buildSaltHarbor,
  },
  {
    pad: "mill-hollow", name: "Mill Hollow", tier: "major", radius: 95, fx: -260, fz: -520,
    pal: {
      roof: 0x45494c, roofMat: "roofShingle", wall: 0xa8321f, wallMat: "woodPlank", wallAlt: 0x8d2a1a,
      trim: 0xf2ece0, accent: 0xd8b23c, accent2: 0x3f6b2e, harvest: "wood",
    },
    build: buildMillHollow,
  },
  {
    pad: "palm-cove", name: "Vista Villa", tier: "major", radius: 100, fx: 790, fz: 300,
    pal: {
      roof: 0x6d7a86, roofMat: "roofTile", wall: 0xf4efe4, wallMat: "plaster", wallAlt: 0xe6dfd0,
      trim: 0xe6dfd0, accent: 0xcfa953, accent2: 0x3f6b2e, harvest: "stone",
    },
    build: buildVistaVilla,
  },
  {
    pad: "the-quarry", name: "Broken Basilica", tier: "major", radius: 115, fx: -560, fz: -330,
    pal: {
      roof: 0x8c9179, roofMat: "roofTile", wall: 0xb8b2a3, wallMat: "rock", wallAlt: 0xa39d90,
      trim: 0x8c9179, accent: 0x7a6a52, accent2: 0x5f6a52, harvest: "stone",
    },
    build: buildBrokenBasilica,
  },
  {
    pad: "ridge-station", name: "Signal Summit", tier: "major", radius: 72, fx: -250, fz: 60,
    pal: {
      roof: 0xd8dcde, roofMat: "metalPanel", wall: 0xe8eae9, wallMat: "metalPanel", wallAlt: 0xc8ccce,
      trim: 0x8f9497, accent: 0xe0691e, accent2: 0x2f6f9c, harvest: "metal",
    },
    build: buildSignalSummit,
  },
  {
    pad: "cargo-yard", name: "Timber Tents", tier: "minor", radius: 60, fx: -720, fz: 470,
    pal: {
      roof: 0x5f6f5a, roofMat: "corrugated", wall: 0x8a6a44, wallMat: "woodPlank", wallAlt: 0x6f5436,
      trim: 0xd8d0be, accent: 0x2f7d5a, accent2: 0xc4562f, harvest: "wood",
    },
    build: buildTimberTents,
  },
  {
    pad: "stonewall", name: "Stonewall Stand", tier: "minor", radius: 58, fx: -960, fz: -600,
    pal: {
      roof: 0x6a6f62, roofMat: "roofShingle", wall: 0x9a948a, wallMat: "rock", wallAlt: 0x877f74,
      trim: 0x7d7a70, accent: 0x8c3f2f, accent2: 0x4f5a44, harvest: "stone",
    },
    build: buildStonewallStand,
  },
  {
    pad: "lonely-lookout", name: "Lonely Lookout", tier: "minor", radius: 52, fx: 930, fz: -120,
    pal: {
      roof: 0x2f3a44, roofMat: "metalPanel", wall: 0xf4f0e6, wallMat: "plaster", wallAlt: 0xdad3c4,
      trim: 0xcfd4d2, accent: 0xc4402c, accent2: 0x2f6f9c, harvest: "stone",
    },
    build: buildLonelyLookout,
  },
];

/* ------------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------------ */

const createPois: SystemFactory = (ctx: WorldCtx): System => {
  // Published FIRST, empty, and filled in place. Loot and bots hold this exact
  // array reference; handing them a new one later would leave them with a map
  // of nowhere.
  const pois: Poi[] = [];
  ctx.services.pois = pois;

  const root = new THREE.Group();
  root.name = "dz:pois";

  const materials = ctx.services.materials;
  if (!materials) {
    // Nothing here can be drawn without the material library, but the POI list
    // still has to exist or every consumer downstream loses its map.
    console.warn("[Drop Zero] pois: no materials service; districts skipped.");
    for (const d of DISTRICTS) {
      pois.push({ name: d.name, center: new THREE.Vector3(d.fx, 0, d.fz), radius: d.radius, tier: d.tier });
    }
    return {
      name: "pois",
      dispose() {
        if (ctx.services.pois === pois) ctx.services.pois = undefined;
      },
    };
  }

  ctx.scene.add(root);
  const terrain = ctx.services.terrain as TerrainLike | undefined;
  const tier = TIERS[ctx.quality] ?? TIERS.high;
  const yard = new Yard(materials, ctx.services.collision, tier.bevel);
  // Private RNG: the districts must lay out identically no matter how much
  // entropy the systems that booted before us happened to draw from ctx.rng.
  const rng = makeRng(0x5eed_0d20);

  const pads = terrain?.pads;
  const centers = new Map<string, THREE.Vector3>();

  for (const d of DISTRICTS) {
    const pad = pads?.find((p) => p.id === d.pad);
    const px = pad ? pad.center.x : d.fx;
    const pz = pad ? pad.center.z : d.fz;
    // With no pad we still land on the grid: snap the sampled height so the
    // district's floors stay on the build lattice even on improvised ground.
    const py = pad ? pad.elevation : snap(terrain ? terrain.heightAt(px, pz) : 0);
    const site: Site = {
      y: yard,
      rng,
      tier,
      terrain,
      cx: px,
      cz: pz,
      r: pad ? pad.radius : d.radius,
      gy: py,
      pal: d.pal,
    };
    const center = new THREE.Vector3(snap(px), py, snap(pz));
    centers.set(d.pad, center);
    try {
      yard.group = d.pad;
      d.build(site);
    } catch (err) {
      // One bad district must not cost the other nine — and it must not cost
      // the road network either, which only needs the centres.
      console.error(`[Drop Zero] district "${d.name}" failed to build:`, err);
    }
    pois.push({ name: d.name, center, radius: d.radius, tier: d.tier });
  }

  // Roads last: they need every district centre resolved first.
  yard.group = "roads";
  for (const link of ROAD_LINKS) {
    const a = centers.get(link.a);
    const b = centers.get(link.b);
    if (!a || !b) continue;
    const da = DISTRICTS.find((d) => d.pad === link.a);
    const db = DISTRICTS.find((d) => d.pad === link.b);
    const total = a.distanceTo(b);
    try {
      buildRoad(
        yard, terrain, a, b, link.bow, link.width, tier.roadStep,
        clamp01(((da?.radius ?? 80) * 0.75) / Math.max(1, total)),
        clamp01(((db?.radius ?? 80) * 0.75) / Math.max(1, total)),
      );
    } catch (err) {
      console.error(`[Drop Zero] road ${link.a}→${link.b} failed:`, err);
    }
  }

  yard.flush(root);

  ctx.emit("dz:pois-ready", {
    count: pois.length,
    colliders: yard.colliders,
    meshes: root.children.length,
    names: pois.map((p) => p.name),
  });

  return {
    name: "pois",

    dispose() {
      // Order matters: pull the group out of the scene BEFORE the engine's
      // deep-disposer walks it, or it will dispose the material library's
      // shared textures out from under every other system.
      root.parent?.remove(root);
      for (const child of root.children) {
        const im = child as THREE.InstancedMesh;
        im.dispose?.();
      }
      root.clear();
      for (const g of yard.owned) g.dispose();
      yard.owned.length = 0;
      for (const r of yard.removers) r();
      yard.removers.length = 0;
      // Materials came from the shared library and are cached there by
      // name+tint — disposing them here would blank every other system that
      // asked for the same terracotta.
      if (ctx.services.pois === pois) ctx.services.pois = undefined;
    },
  };
};

export default createPois;
