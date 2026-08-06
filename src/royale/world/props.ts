/**
 * DROP ZERO — the props layer.
 *
 * The districts are the architecture; this is everything that makes the island
 * look *lived in* and gives the pickaxe something to eat. Cars parked on the
 * verge, a bus slumped outside the terminal, shipping containers stacked four
 * high at the yard, lamp posts that come on as the sun goes down, chain-link
 * around the compound, pylons striding across the hills with their cables
 * sagging between them, and several thousand boulders shouldered into the
 * hillsides.
 *
 * No service is published. Props decorate, and they register colliders — that
 * is the whole contract. Everything reads `materials`, `terrain`, `collision`,
 * `pois` and `sky` lazily and null-checked, because boot order is a guarantee
 * about ordering, not about success.
 *
 * ── Why this module is shaped the way it is ───────────────────────────────
 *
 *  1. NOTHING IS A BOX. Every solid in here is a chamfered solid (`bevelBox`)
 *     or a lofted shell (`loft`). A hard 90° arris between two faces of the
 *     same material produces one hard value step and reads as folded paper; a
 *     4 cm chamfer produces a bright sliver under the key light and reads as
 *     an object with mass. It is the cheapest AAA tell there is, and `low`
 *     is the only tier that goes without.
 *
 *  2. VEHICLES ARE LOFTED, NOT ASSEMBLED. A car built from boxes looks like a
 *     car built from boxes. `loft()` runs a rounded-rectangle cross-section
 *     down the length of the body with the width, height and corner radius
 *     varying per station, which is how you get the slightly over-inflated
 *     Fortnite bulge — shoulders that swell over the wheel arches, a roof that
 *     tucks in, a nose that drops. Wheels are a real torus tyre on a dished
 *     rim with spokes, glass is set back behind its frame, and the lights are
 *     recessed lenses on their own emissive material.
 *
 *  3. EVERYTHING NUMEROUS IS INSTANCED, AND PARTITIONED BY REGION. One
 *     `InstancedMesh` per (prototype × surface × region), where a region is a
 *     district or a 900 m wilderness cell. Partitioning costs draw calls and
 *     buys frustum culling: a single island-wide instanced mesh has an
 *     island-sized bounding sphere and is therefore submitted in full on every
 *     frame no matter where the camera looks. Region buckets are cullable, and
 *     they are also the unit the shadow-distance pass works on.
 *
 *  4. PER-INSTANCE COLOUR. The material library's shared shader patch applies
 *     `instanceColor` itself (r160 routes it into `vColor` but only *applies*
 *     it under `USE_COLOR`), so a hundred cars off one metal material are a
 *     hundred different cars. Paint is drawn from a stylised automotive palette
 *     and then jittered in HSL — value and saturation, never hue, because a
 *     hue-jittered red is a different car and a value-jittered red is the same
 *     car in different weather.
 *
 *  5. WEAR IS GEOMETRY, NOT A TEXTURE TRICK. Every prop that sits on the
 *     ground gets a dirt skirt: a low, slightly oversized ring of the `dirt`
 *     material at its base, which is what stops a prop reading as pasted onto
 *     the terrain. Rust, streaking and dents come from the metal materials'
 *     own painted roughness, plus a rusted tint on a deterministic fraction of
 *     every metal prop.
 *
 *  6. PLACEMENT IS EARNED. Every scatter candidate is rejected if it is in
 *     water, on a slope past ~30° (`slopeAt` is `1 - n.y`, so 30° reads 0.134),
 *     too close to a sibling prop, or overlapping something already registered
 *     with `collision` — which, since `pois` boots before us, means every
 *     building, wall and pier on the island. That last test is the reason no
 *     car ends up inside a shop.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  makeRng,
  type CollisionService,
  type HarvestKind,
  type ImpactMaterial,
  type MaterialName,
  type MaterialsService,
  type Poi,
  type QualityTier,
  type SkyService,
  type System,
  type SystemFactory,
  type TerrainService,
  type WorldCtx,
} from "../types";

/* ------------------------------------------------------------------------ *
 * Contract shims
 *
 * `types.ts` is not ours to edit while the rest of the world is compiling
 * against it, so the extras terrain publishes beyond `TerrainService` are read
 * structurally and every one of them is optional with a working fallback.
 * ------------------------------------------------------------------------ */

interface PadLike {
  id: string;
  name: string;
  center: THREE.Vector3;
  radius: number;
  elevation: number;
}

type TerrainLike = TerrainService & {
  pads?: readonly PadLike[];
  /** 0 = flat, 1 = vertical. `1 - normal.y`. */
  slopeAt?(x: number, z: number): number;
  /** Signed metres to the coastline, positive inland. */
  coastDistanceAt?(x: number, z: number): number;
  /** Metres of water above the ground, 0 on land. */
  waterDepthAt?(x: number, z: number): number;
  /** Baked macro AO, 0..1. Darkens props sitting in gullies. */
  aoAt?(x: number, z: number): number;
  /** Normalised [sand, grass, dirt, rock] cover. */
  surfaceWeightsAt?(x: number, z: number, out?: Float32Array): Float32Array;
  readonly islandRadius?: number;
};

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

interface PropTier {
  /** Edge chamfer in metres. Zero on `low` — a chamfer is 3.7× the triangles. */
  bevel: number;
  /** Multiplier on every scattered count. */
  density: number;
  /** Boulders across the wilderness before rejection. */
  rocks: number;
  /** Radial segments on wheels, drums, pipes. */
  round: number;
  /** Tyre tube segments. */
  tyreSeg: number;
  /** Icosphere subdivisions for boulders. 1 = 80 tris, 2 = 320. */
  rockSubdiv: number;
  /** Catenary cables between pylons, and the light cones under lamps. */
  extras: boolean;
  /** Metres past which a region's props stop casting shadows. */
  shadowDist: number;
  /** Small trim: mirrors, aerials, wheel spokes, hose reels, hinges. */
  trim: boolean;
}

/**
 * `low` gets no chamfer and a third of the props, but it keeps the *big*
 * silhouettes — vehicles, containers, pylons, water towers — because those are
 * what a player navigates by. What it loses is clutter, which is the cheapest
 * thing on the island to lose and the least missed.
 */
const TIERS: Record<QualityTier, PropTier> = {
  low: { bevel: 0, density: 0.34, rocks: 420, round: 8, tyreSeg: 5, rockSubdiv: 1, extras: false, shadowDist: 85, trim: false },
  medium: { bevel: 0.03, density: 0.68, rocks: 950, round: 10, tyreSeg: 6, rockSubdiv: 1, extras: true, shadowDist: 140, trim: true },
  high: { bevel: 0.042, density: 1.0, rocks: 1600, round: 13, tyreSeg: 7, rockSubdiv: 2, extras: true, shadowDist: 195, trim: true },
  ultra: { bevel: 0.052, density: 1.35, rocks: 2400, round: 18, tyreSeg: 9, rockSubdiv: 2, extras: true, shadowDist: 270, trim: true },
};

/**
 * World metres per UV repeat, mirroring `SPEC[].metres` in materials.ts.
 * Duplicated rather than imported: systems in this engine do not import each
 * other, and a stale number here costs texture density, not a crash.
 */
const TILE: Record<MaterialName, number> = {
  plaster: 3.2, brick: 2.4, woodPlank: 2.6, woodLog: 2.0, concrete: 3.6,
  asphalt: 5.0, metalPanel: 2.8, corrugated: 3.0, roofTile: 2.6,
  roofShingle: 3.0, glass: 2.0, rock: 4.5, dirt: 4.0, sand: 4.0, grass: 3.0,
  foliage: 1.0, bark: 2.2, fabric: 2.0, gold: 1.2, rubber: 1.4,
};

/** Impact family per material, mirroring `SPEC[].impact`. */
const IMPACT: Record<MaterialName, ImpactMaterial> = {
  plaster: "concrete", brick: "concrete", woodPlank: "wood", woodLog: "wood",
  concrete: "concrete", asphalt: "concrete", metalPanel: "metal",
  corrugated: "metal", roofTile: "concrete", roofShingle: "concrete",
  glass: "glass", rock: "concrete", dirt: "dirt", sand: "sand", grass: "grass",
  foliage: "grass", bark: "wood", fabric: "dirt", gold: "metal", rubber: "dirt",
};

/**
 * `slopeAt` returns `1 - n.y`, so this is 30°. Anything steeper and a prop
 * either floats at one corner or buries itself at the other, and both read as
 * a bug from ten metres away.
 */
const MAX_SLOPE = 0.134;
/** Boulders are allowed to sit on much steeper ground — they *are* the slope. */
const MAX_ROCK_SLOPE = 0.44;

/** Wilderness partition cell. See note 3 in the header. */
const WILD_CELL = 900;

/** Deterministic layout seed. See the note at the factory. */
const PROPS_SEED = 0x0dd_c0de;

/* ------------------------------------------------------------------------ *
 * Small maths
 * ------------------------------------------------------------------------ */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const TAU = Math.PI * 2;

function pick<T>(list: readonly T[], rng: () => number): T {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

/** Range helper that reads better than `a + rng() * (b - a)` at every call site. */
const rand = (rng: () => number, a: number, b: number) => a + rng() * (b - a);

/** Integer hash → [0,1). Used by the boulder deformer, which must not consume rng. */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = seed ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Trilinear value noise on a lattice. Cheap, and boulders do not need better. */
function vnoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  let acc = 0;
  for (let k = 0; k < 2; k++) {
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const w = (i ? ux : 1 - ux) * (j ? uy : 1 - uy) * (k ? uz : 1 - uz);
        acc += w * hash3(xi + i, yi + j, zi + k, seed);
      }
    }
  }
  return acc;
}

/**
 * Jitter a paint colour in HSL. Lightness and saturation only — a hue-shifted
 * red is a different car, a value-shifted red is the same car after a winter.
 */
const _c = new THREE.Color();
function weather(hex: number, rng: () => number, amount = 1): number {
  _c.setHex(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  _c.getHSL(hsl);
  const l = clamp01(hsl.l * (1 + (rng() - 0.5) * 0.30 * amount));
  const s = clamp01(hsl.s * (1 - rng() * 0.28 * amount));
  _c.setHSL(hsl.h, s, l);
  return _c.getHex();
}

/** Push a colour toward oxide orange-brown. The rust pass for metal props. */
function rusted(hex: number, t: number): number {
  _c.setHex(hex);
  _c.lerp(new THREE.Color(0x6e3a1e), clamp01(t));
  return _c.getHex();
}

/* ------------------------------------------------------------------------ *
 * The geometry kit
 *
 * Everything is authored into a `Geo` — a plain triangle soup with
 * auto-oriented winding and exactly position/normal/uv, because
 * `mergeGeometries` silently refuses to merge geometries whose attribute sets
 * differ and one stray attribute would drop a whole prop family on the floor.
 * ------------------------------------------------------------------------ */

/** `world` projects by dominant normal axis; `metre` is author-space arc length. */
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

  /** A triangle wound to face `n`. One cross product buys the right to list
   *  corners in whatever order reads clearly at the call site. */
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

  toGeometry(tile: number, m?: THREE.Matrix4): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    if (m) g.applyMatrix4(m);
    if (this.uvMode === "world") worldUv(g, tile);
    else if (this.uvMode === "metre") scaleUv(g, 1 / tile);
    g.computeBoundingSphere();
    return g;
  }
}

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * Resolve one authored part into an accumulator: transform it, settle its UVs
 * for good, append. Parts land in plain arrays and only whole prototypes ever
 * become `BufferGeometry`, because `mergeGeometries` over ten thousand
 * one-box geometries is measured in seconds and a GC storm.
 *
 * `transformDirection` is correct for the normal because every matrix built in
 * this module is a rotation plus a translation; anything scaled is scaled by
 * the instance matrix, on the GPU.
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
 * Object-space triplanar-by-dominant-axis UVs.
 *
 * Per-face 0..1 UVs give two butted boxes independent UV islands, so the metal
 * grain jumps at the seam and the eye reads "kit". Projecting from position
 * means a bumper, a wing and the sill below them share one continuous grain.
 * For an instanced prototype the projection is in *prototype* space, which is
 * what we want — otherwise every instance would be a different bake and the
 * whole point of instancing would go with it.
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

function scaleUv(g: THREE.BufferGeometry, s: number): void {
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s);
  uv.needsUpdate = true;
}

/** Face mask bits. Dropping a face buried inside another solid is free tris. */
const F_PX = 1, F_NX = 2, F_PY = 4, F_NY = 8, F_PZ = 16, F_NZ = 32;
const F_ALL = 63;
const F_NO_BOTTOM = F_ALL & ~F_NY;

/**
 * A chamfered box: six inset faces, twelve edge chamfers, eight corner
 * triangles. The single highest-value function in the module — see note 1.
 */
function bevelBox(hx: number, hy: number, hz: number, bevel: number, mask = F_ALL): Geo {
  const g = new Geo();
  const h = [hx, hy, hz];
  let b = Math.max(0, Math.min(bevel, hx * 0.45, hy * 0.45, hz * 0.45));
  // Below ~1 cm the chamfer is sub-pixel at every distance the piece is ever
  // seen from, and it costs 4× the vertices. Drop it.
  if (b < 0.01) b = 0;
  const p = [0, 0, 0], q = [0, 0, 0], r = [0, 0, 0], s = [0, 0, 0];

  const bits = [F_PX, F_NX, F_PY, F_NY, F_PZ, F_NZ];
  for (let a = 0; a < 3; a++) {
    for (let si = 0; si < 2; si++) {
      const sgn = si === 0 ? 1 : -1;
      if ((mask & bits[a * 2 + si]) === 0) continue;
      const u = (a + 1) % 3;
      const v = (a + 2) % 3;
      const corners: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      const pts = corners.map(([cu, cv]) => {
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

/** A cylinder / truncated cone about +Y with arc-length UVs, flat-shaded per
 *  segment — chunky facets are the stylised-PBR read this world is built on. */
function cylinder(rBottom: number, rTop: number, h: number, seg: number, capTop = true, capBottom = false): Geo {
  const g = new Geo();
  g.uvMode = "metre";
  const y0 = -h * 0.5, y1 = h * 0.5;
  const slope = (rBottom - rTop) / Math.max(h, 1e-4);
  const nScale = 1 / Math.hypot(1, slope);
  const circ = TAU * Math.max(rBottom, rTop);
  for (let i = 0; i < seg; i++) {
    const t0 = (i / seg) * TAU, t1 = ((i + 1) / seg) * TAU;
    const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
    const u0 = (i / seg) * circ, u1 = ((i + 1) / seg) * circ;
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

/**
 * A torus about +Y — tyres, hose reels, life rings, the rolled lip of a drum.
 * `flat` gives the tread a faceted read that catches the key light per block
 * rather than smearing one highlight round the whole tyre.
 */
function torus(R: number, r: number, segMajor: number, segMinor: number, flat = false): Geo {
  const g = new Geo();
  g.uvMode = "metre";
  const circ = TAU * R;
  for (let i = 0; i < segMajor; i++) {
    const a0 = (i / segMajor) * TAU, a1 = ((i + 1) / segMajor) * TAU;
    for (let j = 0; j < segMinor; j++) {
      const b0 = (j / segMinor) * TAU, b1 = ((j + 1) / segMinor) * TAU;
      const pt = (a: number, b: number) => {
        const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
        return [ca * (R + r * cb), r * sb, sa * (R + r * cb), ca * cb, sb, sa * cb];
      };
      const P00 = pt(a0, b0), P10 = pt(a1, b0), P11 = pt(a1, b1), P01 = pt(a0, b1);
      const am = (a0 + a1) * 0.5, bm = (b0 + b1) * 0.5;
      const F = pt(am, bm);
      const nrm = (P: number[]) => (flat ? [F[3], F[4], F[5]] : [P[3], P[4], P[5]]);
      const u0 = (i / segMajor) * circ, u1 = ((i + 1) / segMajor) * circ;
      const v0 = (j / segMinor) * TAU * r, v1 = ((j + 1) / segMinor) * TAU * r;
      const n0 = nrm(P00), n1 = nrm(P10), n2 = nrm(P11), n3 = nrm(P01);
      const i0 = g.vert(P00[0], P00[1], P00[2], n0[0], n0[1], n0[2], u0, v0);
      const i1 = g.vert(P10[0], P10[1], P10[2], n1[0], n1[1], n1[2], u1, v0);
      const i2 = g.vert(P11[0], P11[1], P11[2], n2[0], n2[1], n2[2], u1, v1);
      const i3 = g.vert(P01[0], P01[1], P01[2], n3[0], n3[1], n3[2], u0, v1);
      g.idx.push(i0, i1, i2, i0, i2, i3);
    }
  }
  return g;
}

/** An extruded convex polygon: walls plus fan-triangulated caps. Hulls,
 *  gable ends, wedge ramps, the plan of a boat deck. */
function prism(outline: readonly number[], y0: number, y1: number, cap = true): Geo {
  const g = new Geo();
  const n = outline.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = outline[i * 2], az = outline[i * 2 + 1];
    const j = (i + 1) % n;
    const bx = outline[j * 2], bz = outline[j * 2 + 1];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    g.quad(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az, dz / len, 0, -dx / len);
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

/* ---------------------------------------------------------------- lofting */

/**
 * One cross-section of a lofted shell, in the XY plane at a station along Z.
 *
 *   hw     half-width
 *   yb/yt  bottom and top of the section
 *   r      corner radius — the bulge control. A big `r` on a wide section is
 *          the shoulder swelling over a wheel arch; a small `r` on a narrow
 *          one is a crisp roof edge.
 *   cx     lateral offset, for a cab that sits off-centre
 */
interface Station {
  z: number;
  hw: number;
  yb: number;
  yt: number;
  r: number;
  cx?: number;
}

/** A rounded-rectangle ring in XY, CCW seen from +Z. `seg` per corner. */
function ringPts(st: Station, seg: number): number[][] {
  const cx = st.cx ?? 0;
  const hy = (st.yt - st.yb) * 0.5;
  const cy = (st.yt + st.yb) * 0.5;
  const r = Math.max(0, Math.min(st.r, st.hw * 0.98, hy * 0.98));
  const ix = st.hw - r, iy = hy - r;
  const out: number[][] = [];
  const corners: Array<[number, number, number]> = [
    [ix, iy, 0], [-ix, iy, Math.PI * 0.5], [-ix, -iy, Math.PI], [ix, -iy, Math.PI * 1.5],
  ];
  for (const [ox, oy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI * 0.5);
      out.push([cx + ox + Math.cos(a) * r, cy + oy + Math.sin(a) * r]);
    }
  }
  return out;
}

/**
 * Loft a chain of rounded-rectangle stations along Z into a closed shell.
 *
 * This is what makes the vehicles read as vehicles. A car assembled from boxes
 * has flat sides and hard shoulders; a lofted car has a section that grows over
 * the arches and tucks under the sills, which is exactly the cartooned bulge
 * the art direction asks for. Normals are averaged along the ring so the body
 * shades smoothly and faceted only where the stations are far apart.
 */
function loft(stations: Station[], seg: number, capFront = true, capBack = true): Geo {
  const g = new Geo();
  const rings = stations.map((s) => ringPts(s, seg));
  const n = rings[0].length;
  for (let s = 0; s < rings.length - 1; s++) {
    const A = rings[s], B = rings[s + 1];
    const za = stations[s].z, zb = stations[s + 1].z;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      // Ring-tangent normal, tilted by the longitudinal slope of the shell so
      // a tapering nose does not shade as if it were a straight tube.
      const tx = A[j][0] - A[i][0], ty = A[j][1] - A[i][1];
      const tl = Math.hypot(tx, ty) || 1;
      let nx = ty / tl, ny = -tx / tl;
      const dz = zb - za;
      const dr = Math.hypot(B[i][0] - A[i][0], B[i][1] - A[i][1]);
      const outward = (B[i][0] - A[i][0]) * nx + (B[i][1] - A[i][1]) * ny;
      const nz = dz !== 0 ? -Math.sign(dz) * (outward / Math.max(dr, 1e-5)) * (dr / Math.hypot(dr, dz)) : 0;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl;
      g.quad(
        A[i][0], A[i][1], za,
        A[j][0], A[j][1], za,
        B[j][0], B[j][1], zb,
        B[i][0], B[i][1], zb,
        nx, ny, nz / nl,
      );
    }
  }
  const capRing = (ring: number[][], z: number, sgn: number) => {
    let cx = 0, cy = 0;
    for (const p of ring) { cx += p[0]; cy += p[1]; }
    cx /= ring.length; cy /= ring.length;
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      g.tri(cx, cy, z, ring[i][0], ring[i][1], z, ring[j][0], ring[j][1], z, 0, 0, sgn);
    }
  };
  if (capBack) capRing(rings[0], stations[0].z, -1);
  if (capFront) capRing(rings[rings.length - 1], stations[stations.length - 1].z, 1);
  return g;
}

/**
 * A deformed icosphere. Boulders, and nothing else.
 *
 * Flat-shaded on purpose: a smooth-normalled noise sphere reads as a potato,
 * and a faceted one reads as rock, because real rock breaks along planes. Two
 * octaves of value noise — one for the big lobes, one for the chip detail —
 * plus a vertical squash so boulders sit rather than balance.
 */
function boulder(radius: number, subdiv: number, seed: number, lumpiness = 0.34): Geo {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  });
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < subdiv; s++) {
    const mid = new Map<number, number>();
    const next: number[][] = [];
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * 100000 + b : b * 100000 + a;
      const hit = mid.get(key);
      if (hit !== undefined) return hit;
      const va = verts[a], vb = verts[b];
      const m = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2];
      const l = Math.hypot(m[0], m[1], m[2]);
      verts.push([m[0] / l, m[1] / l, m[2] / l]);
      const id = verts.length - 1;
      mid.set(key, id);
      return id;
    };
    for (const f of faces) {
      const a = midpoint(f[0], f[1]), b = midpoint(f[1], f[2]), c = midpoint(f[2], f[0]);
      next.push([f[0], a, c], [f[1], b, a], [f[2], c, b], [a, b, c]);
    }
    faces = next;
  }

  // Displace. The 2.1 / 5.7 lattice frequencies are decorrelated on purpose:
  // an integer ratio makes the lobes line up and the boulder turns into a die.
  const disp = verts.map((v) => {
    const big = vnoise3(v[0] * 2.1 + 11, v[1] * 2.1 + 4, v[2] * 2.1 + 7, seed) - 0.5;
    const chip = vnoise3(v[0] * 5.7 - 3, v[1] * 5.7 + 19, v[2] * 5.7 - 8, seed ^ 0x9e37) - 0.5;
    const k = radius * (1 + big * lumpiness * 2 + chip * lumpiness * 0.55);
    // Squash: boulders sit on the ground, they do not balance on it.
    return [v[0] * k, v[1] * k * 0.78, v[2] * k];
  });

  const g = new Geo();
  for (const f of faces) {
    const a = disp[f[0]], b = disp[f[1]], c = disp[f[2]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    g.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], nx, ny, nz);
  }
  return g;
}

/** Turn a shell inside out — one-sided materials vanish from behind otherwise. */
function flipFaces(g: Geo): void {
  for (let i = 0; i < g.idx.length; i += 3) {
    const t = g.idx[i + 1];
    g.idx[i + 1] = g.idx[i + 2];
    g.idx[i + 2] = t;
  }
  for (let i = 0; i < g.nor.length; i++) g.nor[i] = -g.nor[i];
}

/** Build a rotation+translation. Everything here runs once, at boot. */
function xf(x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ")),
    new THREE.Vector3(1, 1, 1),
  );
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  const merged = parts.length === 1 ? parts[0].clone() : mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) return null;
  merged.computeBoundingSphere();
  return merged;
}

/* ------------------------------------------------------------------------ *
 * Surfaces
 *
 * A `Surf` is a material reference plus a tint. Library materials resolve
 * through `materials.tinted()`, which caches by name+hex, so forty white cars
 * and forty red ones cost two materials rather than eighty. A handful of
 * surfaces cannot come from the library — anything emissive, the chain-link
 * cutout, the light cones — and those are authored locally, procedurally, and
 * disposed by us.
 * ------------------------------------------------------------------------ */

/** Locally-authored materials. Everything else is a `MaterialName`. */
type LocalId = "lens" | "chainLink" | "lightCone" | "signFace";

/** Metres per UV repeat for the local materials. */
const LOCAL_TILE: Record<LocalId, number> = { lens: 1, chainLink: 1, lightCone: 1, signFace: 1 };

const LOCAL_IMPACT: Record<LocalId, ImpactMaterial> = {
  lens: "glass", chainLink: "metal", lightCone: "glass", signFace: "metal",
};

/**
 * The lens atlas is one texture with a warm cell and a red cell side by side,
 * so every lit surface in the world — street lamps, headlamps, tail lamps —
 * comes off ONE material. Two emissive materials would be two more
 * `InstancedMesh` per vehicle per region, which is the most expensive way
 * imaginable to buy a colour that a texture coordinate gives away for free.
 */
const LENS_WARM: readonly [number, number, number, number] = [0.01, 0.01, 0.49, 0.99];
const LENS_RED: readonly [number, number, number, number] = [0.51, 0.01, 0.99, 0.99];

type SurfId = MaterialName | LocalId;

interface Surf {
  m: SurfId;
  color: number;
}

const surf = (m: SurfId, color = 0xffffff): Surf => ({ m, color });
const surfKey = (s: Surf) => `${s.m}|${s.color.toString(16)}`;
const isLocal = (m: SurfId): m is LocalId => m in LOCAL_TILE;
const tileOf = (m: SurfId): number => (isLocal(m) ? LOCAL_TILE[m] : TILE[m]);
const impactOf = (m: SurfId): ImpactMaterial => (isLocal(m) ? LOCAL_IMPACT[m] : IMPACT[m]);

/** Which per-instance colour a part takes. `none` skips `instanceColor`
 *  entirely for that part, which saves the attribute and the define. */
type TintSlot = "none" | "body" | "accent";

/* ------------------------------------------------------------------------ *
 * Locally-authored materials
 *
 * Painted on a Canvas2D at boot like everything else in this world. The
 * emissive set is the reason this exists: `MaterialsService` has no emissive
 * channel, and a lamp post whose head does not light up at dusk is the single
 * most obvious missing thing in a night-capable map.
 * ------------------------------------------------------------------------ */

type Ctx2D = CanvasRenderingContext2D;

function makeCanvas(size: number): Ctx2D | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d", { willReadFrequently: false });
  return g ?? null;
}

function finish(tex: THREE.Texture, srgb: boolean, aniso: number): THREE.Texture {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = aniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * A lamp lens: a frosted disc with a hot centre and a cool rim, plus the
 * radial ribbing a real prismatic lens has. Doubles as the emissive map, so
 * the glow is brightest where the filament is rather than uniform across the
 * whole head — a flat emissive rectangle is the thing that reads as "web".
 */
function paintLensCell(g: Ctx2D, n: number, cx: number, cy: number, r: number, warm: boolean): void {
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  if (warm) {
    grad.addColorStop(0, "#fffdf2");
    grad.addColorStop(0.35, "#ffe3a8");
    grad.addColorStop(0.72, "#d99a3c");
    grad.addColorStop(1, "#2a1e0e");
  } else {
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(0.4, "#ffd8d2");
    grad.addColorStop(0.8, "#c23421");
    grad.addColorStop(1, "#2a0a06");
  }
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cy, r * 0.99, 0, TAU);
  g.fill();
  // Prismatic ribs. Sub-pixel at range, but at 2 m they are what says "lens"
  // rather than "painted circle".
  g.save();
  g.beginPath();
  g.arc(cx, cy, r, 0, TAU);
  g.clip();
  g.globalCompositeOperation = "overlay";
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    g.strokeStyle = i % 2 ? "rgba(255,255,255,0.30)" : "rgba(0,0,0,0.22)";
    g.lineWidth = Math.max(1, n / 180);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r * 0.14, cy + Math.sin(a) * r * 0.14);
    g.lineTo(cx + Math.cos(a) * r * 0.96, cy + Math.sin(a) * r * 0.96);
    g.stroke();
  }
  for (let i = 1; i <= 3; i++) {
    g.strokeStyle = "rgba(255,255,255,0.18)";
    g.lineWidth = Math.max(1, n / 220);
    g.beginPath();
    g.arc(cx, cy, (r * i) / 4, 0, TAU);
    g.stroke();
  }
  g.restore();
}

/** Warm cell left, red cell right. See `LENS_WARM` / `LENS_RED`. */
function paintLensAtlas(g: Ctx2D, n: number): void {
  g.fillStyle = "#0d0f11";
  g.fillRect(0, 0, n, n);
  paintLensCell(g, n, n * 0.25, n * 0.5, n * 0.24, true);
  paintLensCell(g, n, n * 0.75, n * 0.5, n * 0.24, false);
}

/**
 * Chain-link: a diamond mesh with a wire highlight and a shadow side, painted
 * into the alpha channel so it becomes a real cutout. A chain-link fence drawn
 * as a translucent grey plane is a dead giveaway; drawn as a cutout it throws
 * a diamond shadow and you can shoot through the holes.
 */
function paintChainLink(g: Ctx2D, n: number): void {
  g.clearRect(0, 0, n, n);
  const pitch = n / 6;
  const draw = (dx: number, style: string, w: number, off: number) => {
    g.strokeStyle = style;
    g.lineWidth = w;
    g.lineCap = "round";
    for (let i = -8; i <= 14; i++) {
      g.beginPath();
      g.moveTo(i * pitch + off, -n);
      g.lineTo(i * pitch + off + dx * n * 2, n * 2);
      g.stroke();
    }
  };
  // Shadowed under-wire first, then the lit wire slightly offset. Two strokes
  // is all it takes for the mesh to read as round wire instead of tape.
  draw(1, "rgba(24,28,30,0.85)", Math.max(1.4, n / 46), n * 0.012);
  draw(-1, "rgba(24,28,30,0.85)", Math.max(1.4, n / 46), n * 0.012);
  draw(1, "rgba(196,203,206,0.95)", Math.max(1, n / 64), 0);
  draw(-1, "rgba(174,181,184,0.95)", Math.max(1, n / 64), 0);
}

/** Four road-sign faces in a 2×2 atlas. Abstract shapes, no real-world marks. */
function paintSigns(g: Ctx2D, n: number): void {
  const h = n / 2;
  const cell = (cx: number, cy: number, bg: string) => {
    g.fillStyle = bg;
    g.fillRect(cx, cy, h, h);
    g.strokeStyle = "rgba(0,0,0,0.28)";
    g.lineWidth = h * 0.03;
    g.strokeRect(cx + h * 0.05, cy + h * 0.05, h * 0.9, h * 0.9);
  };
  // 0,0 — warning diamond
  cell(0, 0, "#e8b528");
  g.save();
  g.translate(h * 0.5, h * 0.5);
  g.rotate(Math.PI / 4);
  g.strokeStyle = "#1a1a1a";
  g.lineWidth = h * 0.05;
  g.strokeRect(-h * 0.28, -h * 0.28, h * 0.56, h * 0.56);
  g.restore();
  g.fillStyle = "#1a1a1a";
  g.fillRect(h * 0.46, h * 0.24, h * 0.08, h * 0.34);
  g.beginPath();
  g.arc(h * 0.5, h * 0.66, h * 0.055, 0, TAU);
  g.fill();

  // 1,0 — stop octagon
  cell(h, 0, "#b8321f");
  g.fillStyle = "#f2ece0";
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.PI / 8;
    const px = h + h * 0.5 + Math.cos(a) * h * 0.36;
    const py = h * 0.5 + Math.sin(a) * h * 0.36;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.closePath();
  g.lineWidth = h * 0.04;
  g.strokeStyle = "#f2ece0";
  g.stroke();
  g.fillRect(h + h * 0.28, h * 0.44, h * 0.44, h * 0.11);

  // 0,1 — direction chevrons
  cell(0, h, "#2f6f4f");
  g.strokeStyle = "#f2ece0";
  g.lineWidth = h * 0.07;
  for (let i = 0; i < 3; i++) {
    const x = h * (0.28 + i * 0.18);
    g.beginPath();
    g.moveTo(x, h + h * 0.32);
    g.lineTo(x + h * 0.14, h + h * 0.5);
    g.lineTo(x, h + h * 0.68);
    g.stroke();
  }

  // 1,1 — speed disc
  cell(h, h, "#f2ece0");
  g.fillStyle = "#b8321f";
  g.beginPath();
  g.arc(h * 1.5, h * 1.5, h * 0.38, 0, TAU);
  g.fill();
  g.fillStyle = "#f2ece0";
  g.beginPath();
  g.arc(h * 1.5, h * 1.5, h * 0.29, 0, TAU);
  g.fill();
  g.fillStyle = "#1a1a1a";
  g.font = `bold ${h * 0.3}px sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("50", h * 1.5, h * 1.52);
}

/** A soft cone falloff: bright at the apex, gone at the rim. */
function paintCone(g: Ctx2D, n: number): void {
  const grad = g.createLinearGradient(0, 0, 0, n);
  grad.addColorStop(0, "rgba(255,228,168,0.95)");
  grad.addColorStop(0.45, "rgba(255,216,150,0.34)");
  grad.addColorStop(1, "rgba(255,204,132,0.0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, n, n);
}

interface LocalMaterials {
  get(id: LocalId): THREE.Material;
  /** Drive the emissive set off the sky. 0 = full day, 1 = full night. */
  setNight(night: number, flicker: number): void;
  dispose(): void;
}

function buildLocalMaterials(quality: QualityTier, aniso: number): LocalMaterials {
  const size = quality === "low" ? 64 : quality === "ultra" ? 256 : 128;
  const textures: THREE.Texture[] = [];
  const materials = new Map<LocalId, THREE.Material>();

  const canvasTex = (n: number, paint: (g: Ctx2D, n: number) => void, srgb: boolean): THREE.Texture | null => {
    const g = makeCanvas(n);
    if (!g) return null;
    paint(g, n);
    const t = finish(new THREE.CanvasTexture(g.canvas), srgb, aniso);
    textures.push(t);
    return t;
  };

  const lensTex = canvasTex(size * 2, paintLensAtlas, true);
  const linkTex = canvasTex(size * 2, paintChainLink, true);
  const signTex = canvasTex(size * 2, paintSigns, true);
  const coneTex = canvasTex(size, paintCone, true);
  // The cone's gradient spans the volume exactly once. Repeat wrapping would
  // put a hard bright band back at the bottom edge where it should have faded
  // to nothing.
  if (coneTex) {
    coneTex.wrapS = THREE.ClampToEdgeWrapping;
    coneTex.wrapT = THREE.ClampToEdgeWrapping;
  }
  if (lensTex) {
    // Atlas: clamping stops the warm cell bleeding into the red one at the
    // coarsest mip, which shows up as pink headlamps at 100 m.
    lensTex.wrapS = THREE.ClampToEdgeWrapping;
    lensTex.wrapT = THREE.ClampToEdgeWrapping;
  }

  const emissiveMat = (map: THREE.Texture | null, base: number, glow: number, rough: number) => {
    const m = new THREE.MeshStandardMaterial({
      map,
      emissiveMap: map,
      color: base,
      emissive: new THREE.Color(glow),
      emissiveIntensity: 0,
      roughness: rough,
      metalness: 0.05,
      envMapIntensity: 1.2,
    });
    // A lens is a lens from both sides — the head of a lamp post is read from
    // underneath as often as from the side.
    m.side = THREE.DoubleSide;
    return m;
  };

  materials.set("lens", emissiveMat(lensTex, 0xc4cacd, 0xffe0b0, 0.20));

  const link = new THREE.MeshStandardMaterial({
    map: linkTex,
    color: 0xc9d0d3,
    roughness: 0.52,
    metalness: 0.85,
    envMapIntensity: 1.1,
    side: THREE.DoubleSide,
    alphaTest: 0.42,
    transparent: false,
  });
  link.shadowSide = THREE.DoubleSide;
  materials.set("chainLink", link);

  const sign = new THREE.MeshStandardMaterial({
    map: signTex,
    color: 0xffffff,
    roughness: 0.42,
    metalness: 0.15,
    envMapIntensity: 0.9,
    side: THREE.DoubleSide,
  });
  materials.set("signFace", sign);

  /**
   * The light cone is the one `MeshBasicMaterial` in the module, and it is the
   * right tool: it is not a surface, it is a volume of scattered light, and
   * shading it would be physically wrong as well as slower. Additive, no depth
   * write, so a hundred of them layer without z-fighting the posts they hang
   * from.
   */
  const cone = new THREE.MeshBasicMaterial({
    map: coneTex,
    color: 0xffd79a,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
  materials.set("lightCone", cone);

  return {
    get(id) {
      const m = materials.get(id);
      if (m) return m;
      // Should be unreachable; a missing local material must not throw during
      // worldgen and take the whole prop layer with it.
      const fallback = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.8 });
      materials.set(id, fallback);
      return fallback;
    },
    setNight(night, flick) {
      // 2.4 is where the bloom in postfx starts to bite on a 0.35 m lens —
      // bright enough to read as "on" from 200 m, short of a white blob. The
      // same value drives the vehicle lamps, which is not a compromise: at
      // night a parked car's lenses catching the street light is exactly what
      // this looks like.
      (materials.get("lens") as THREE.MeshStandardMaterial).emissiveIntensity = night * 2.4 * flick;
      (materials.get("lightCone") as THREE.MeshBasicMaterial).opacity = night * 0.17 * flick;
    },
    dispose() {
      for (const m of materials.values()) m.dispose();
      materials.clear();
      for (const t of textures) t.dispose();
      textures.length = 0;
    },
  };
}

/* ------------------------------------------------------------------------ *
 * The depot
 *
 * Prototypes are built once and instanced per region. Static one-off geometry
 * (cables, fence runs, the dirt skirts under everything) is merged per
 * (region × surface). Colliders are registered as props are placed, next to
 * the geometry they belong to, which is the only way they stay in step.
 * ------------------------------------------------------------------------ */

interface CollideBox {
  cx: number; cy: number; cz: number;
  hx: number; hy: number; hz: number;
  /** Override the def's harvest for one box — a bus shelter's glass vs frame. */
  harvest?: HarvestKind;
  material?: ImpactMaterial;
}

interface BoxOpts {
  mask?: number;
  bevel?: number;
  yaw?: number;
  pitch?: number;
  roll?: number;
  tint?: TintSlot;
}

interface PartAcc {
  surf: Surf;
  tint: TintSlot;
  geo: Geo;
}

/**
 * The dirt collar. A low, slightly oversized ring of `dirt` around the base of
 * a prop — one ring of quads, no alpha, eight triangles. It is the difference
 * between an object standing on the ground and an object pasted onto it, and
 * it is the reason `PropDef.skirt` exists.
 */
function groundSkirt(hx: number, hz: number, spread = 0.34, height = 0.05): Geo {
  const g = new Geo();
  const x0 = hx, z0 = hz, x1 = hx + spread, z1 = hz + spread;
  const ring: Array<[number, number, number, number]> = [
    [-x1, -z1, -x0, -z0], [x1, -z1, x0, -z0], [x1, z1, x0, z0], [-x1, z1, -x0, z0],
  ];
  for (let i = 0; i < 4; i++) {
    const a = ring[i], b = ring[(i + 1) % 4];
    g.quad(a[0], 0, a[1], b[0], 0, b[1], b[2], height, b[3], a[2], height, a[3], 0, 1, 0);
  }
  return g;
}

/** Anything thinner than this loses its chamfer — invisible, and 4× the verts. */
const BEVEL_MIN_HALF = 0.055;

/**
 * The authoring surface every prototype is written against. Emits into
 * per-(surface × tint) accumulators, and collects prototype-space collider
 * boxes alongside.
 */
class PropBuilder {
  readonly parts = new Map<string, PartAcc>();
  readonly boxes: CollideBox[] = [];

  constructor(readonly bevel: number, readonly tier: PropTier, readonly rng: () => number) {}

  emit(s: Surf, g: Geo, m?: THREE.Matrix4, tint: TintSlot = "none"): void {
    if (g.empty) return;
    const key = `${surfKey(s)}|${tint}`;
    let acc = this.parts.get(key);
    if (!acc) {
      const geo = new Geo();
      geo.uvMode = "raw";
      acc = { surf: s, tint, geo };
      this.parts.set(key, acc);
    }
    appendPart(acc.geo, g, m, tileOf(s.m));
  }

  box(s: Surf, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, o: BoxOpts = {}): void {
    if (hx <= 1e-4 || hy <= 1e-4 || hz <= 1e-4) return;
    const bev = Math.min(hx, hy, hz) < BEVEL_MIN_HALF ? 0 : o.bevel ?? this.bevel;
    this.emit(s, bevelBox(hx, hy, hz, bev, o.mask ?? F_ALL), xf(cx, cy, cz, o.yaw ?? 0, o.pitch ?? 0, o.roll ?? 0), o.tint ?? "none");
  }

  cyl(
    s: Surf, cx: number, cy: number, cz: number,
    rb: number, rt: number, h: number,
    o: BoxOpts & { seg?: number; capTop?: boolean; capBottom?: boolean } = {},
  ): void {
    this.emit(
      s,
      cylinder(rb, rt, h, o.seg ?? this.tier.round, o.capTop ?? true, o.capBottom ?? false),
      xf(cx, cy, cz, o.yaw ?? 0, o.pitch ?? 0, o.roll ?? 0),
      o.tint ?? "none",
    );
  }

  torus(
    s: Surf, cx: number, cy: number, cz: number,
    R: number, r: number,
    o: BoxOpts & { major?: number; minor?: number; flat?: boolean } = {},
  ): void {
    this.emit(
      s,
      torus(R, r, o.major ?? this.tier.round, o.minor ?? this.tier.tyreSeg, o.flat ?? false),
      xf(cx, cy, cz, o.yaw ?? 0, o.pitch ?? 0, o.roll ?? 0),
      o.tint ?? "none",
    );
  }

  loft(s: Surf, stations: Station[], m?: THREE.Matrix4, tint: TintSlot = "none", seg = 3, capFront = true, capBack = true): void {
    this.emit(s, loft(stations, seg, capFront, capBack), m, tint);
  }

  /** A collider in prototype space. Transformed with the instance at place time. */
  solid(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, o: Partial<CollideBox> = {}): void {
    this.boxes.push({ cx, cy, cz, hx, hy, hz, harvest: o.harvest, material: o.material });
  }

  /** A box that is also solid — the common case for anything you can hide behind. */
  solidBox(
    s: Surf, cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    o: BoxOpts & Partial<CollideBox> = {},
  ): void {
    this.box(s, cx, cy, cz, hx, hy, hz, o);
    this.solid(cx, cy, cz, hx, hy, hz, { harvest: o.harvest, material: o.material ?? impactOf(s.m) });
  }

}

interface PropDef {
  key: string;
  build(b: PropBuilder): void;
  harvest?: HarvestKind;
  /** Approximate footprint radius. Feeds the spacing grid and the clearance test. */
  clear: number;
  /** `near` meshes stop casting past `tier.shadowDist`; `never` never casts. */
  shadow?: "always" | "near" | "never";
  /**
   * How instances of this prop are bucketed into `InstancedMesh`es.
   *
   * `"global"` (the default) is one bucket for the whole island: minimum draw
   * calls, no frustum culling. `"cell"` partitions by district / wilderness
   * cell: cullable, and the unit the shadow-distance pass works on, at the
   * cost of one draw call per part per occupied region.
   *
   * The rule is population. A prop family in the low hundreds is cheaper
   * global — a hundred vehicles is 200 k triangles, which a GPU does not
   * notice, while six parts × twelve regions is seventy-two draw calls, which
   * it very much does. A family in the thousands (boulders, fence panels) is
   * the other way round and must be partitioned, because *those* are where the
   * triangles actually are.
   */
  region?: "cell" | "global";
  /**
   * Half-extents of the dirt collar stamped under this prop at placement time.
   * Emitted into the region's shared static bucket rather than into the
   * prototype, so every skirt on the island costs one draw call in total
   * instead of one per prop family.
   */
  skirt?: readonly [number, number];
}

interface BakedPart {
  surf: Surf;
  tint: TintSlot;
  geo: THREE.BufferGeometry;
}

interface BakedProto {
  parts: BakedPart[];
  boxes: CollideBox[];
}

interface Placement {
  m: THREE.Matrix4;
  body: THREE.Color;
  accent: THREE.Color;
}

interface Group {
  def: PropDef;
  proto: BakedProto;
  items: Placement[];
}

interface StaticBucket {
  surf: Surf;
  geo: Geo;
  chunks: THREE.BufferGeometry[];
  shadow: "always" | "near" | "never";
}

/** Vertices per sealed chunk. Keeps the JS accumulator arrays cache-friendly. */
const CHUNK_VERTS = 48000;

/** A mesh plus what the shadow pass needs to know about it. */
interface ShadowEntry {
  mesh: THREE.Mesh;
  mode: "always" | "near" | "never";
  center: THREE.Vector3;
  radius: number;
}

const _box = new THREE.Box3();
const _v = new THREE.Vector3();

class Depot {
  private protos = new Map<string, BakedProto>();
  private groups = new Map<string, Group>();
  private statics = new Map<string, StaticBucket>();

  readonly removers: Array<() => void> = [];
  readonly owned: THREE.BufferGeometry[] = [];
  readonly shadowEntries: ShadowEntry[] = [];
  colliders = 0;
  placed = 0;

  constructor(
    private readonly materials: MaterialsService,
    private readonly local: LocalMaterials,
    private readonly collision: CollisionService | undefined,
    private readonly tier: PropTier,
    private readonly rng: () => number,
  ) {}

  private material(s: Surf): THREE.Material {
    if (isLocal(s.m)) return this.local.get(s.m);
    return this.materials.tinted(s.m, s.color);
  }

  private proto(def: PropDef): BakedProto {
    let p = this.protos.get(def.key);
    if (!p) {
      const b = new PropBuilder(this.tier.bevel, this.tier, this.rng);
      def.build(b);
      const parts: BakedPart[] = [];
      for (const acc of b.parts.values()) {
        if (acc.geo.empty) continue;
        parts.push({ surf: acc.surf, tint: acc.tint, geo: acc.geo.toGeometry(1) });
      }
      p = { parts, boxes: b.boxes };
      this.protos.set(def.key, p);
    }
    return p;
  }

  /**
   * Place one prop. `m` must be rotation + translation only: colliders are
   * axis-aligned boxes, and a scaled instance would need the scale folded into
   * every one of them. Rocks, which *do* want per-instance scale, register
   * their collider explicitly through `solidWorld`.
   */
  place(def: PropDef, region: string, m: THREE.Matrix4, body?: number, accent?: number): void {
    const proto = this.proto(def);
    const key = `${def.key}|${region}`;
    let g = this.groups.get(key);
    if (!g) {
      g = { def, proto, items: [] };
      this.groups.set(key, g);
    }
    g.items.push({
      m,
      body: new THREE.Color(body ?? 0xffffff),
      accent: new THREE.Color(accent ?? 0xffffff),
    });
    this.placed++;

    if (!this.collision) return;
    for (const cb of proto.boxes) {
      // OBB → AABB. Props are axis-aligned or yawed; taking the transformed
      // corner hull keeps a 45°-parked car solid without needing an oriented
      // broadphase, at the cost of a slightly generous box, which for cover
      // geometry is the safe direction to be wrong in.
      _box.makeEmpty();
      for (let i = 0; i < 8; i++) {
        _v.set(
          cb.cx + (i & 1 ? cb.hx : -cb.hx),
          cb.cy + (i & 2 ? cb.hy : -cb.hy),
          cb.cz + (i & 4 ? cb.hz : -cb.hz),
        ).applyMatrix4(m);
        _box.expandByPoint(_v);
      }
      this.removers.push(this.collision.addBox(_box, {
        material: cb.material ?? "metal",
        harvest: cb.harvest ?? def.harvest,
        tag: def.key,
      }));
      this.colliders++;
    }
  }

  /** Register a collider with no prototype behind it — scaled props, terrain
   *  furniture whose geometry lives in a static bucket. */
  solidWorld(
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    material: ImpactMaterial, harvest?: HarvestKind, tag?: string,
  ): void {
    if (!this.collision) return;
    _box.min.set(cx - hx, cy - hy, cz - hz);
    _box.max.set(cx + hx, cy + hy, cz + hz);
    this.removers.push(this.collision.addBox(_box, { material, harvest, tag }));
    this.colliders++;
  }

  /** One-off merged geometry: cable spans, fence runs, jetty planking. */
  static(region: string, s: Surf, g: Geo, m?: THREE.Matrix4, shadow: "always" | "near" | "never" = "near"): void {
    if (g.empty) return;
    const key = `${region}|${surfKey(s)}|${shadow}`;
    let b = this.statics.get(key);
    if (!b) {
      const geo = new Geo();
      geo.uvMode = "raw";
      b = { surf: s, geo, chunks: [], shadow };
      this.statics.set(key, b);
    }
    appendPart(b.geo, g, m, tileOf(s.m));
    if (b.geo.pos.length >= CHUNK_VERTS * 3) {
      b.chunks.push(b.geo.toGeometry(1));
      const geo = new Geo();
      geo.uvMode = "raw";
      b.geo = geo;
    }
  }

  /** Bake every bucket into meshes under `root`. */
  flush(root: THREE.Object3D): void {
    for (const [key, g] of this.groups) {
      if (g.items.length === 0) continue;
      const mode = g.def.shadow ?? "near";
      for (const part of g.proto.parts) {
        const mesh = new THREE.InstancedMesh(part.geo, this.material(part.surf), g.items.length);
        for (let i = 0; i < g.items.length; i++) {
          mesh.setMatrixAt(i, g.items[i].m);
          if (part.tint === "body") mesh.setColorAt(i, g.items[i].body);
          else if (part.tint === "accent") mesh.setColorAt(i, g.items[i].accent);
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.name = `dz:prop:${key}:${part.surf.m}`;
        mesh.castShadow = mode !== "never";
        // A light cone is a volume; it must never write to the shadow map.
        if (part.surf.m === "lightCone") {
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          mesh.renderOrder = 3;
        } else {
          mesh.receiveShadow = true;
        }
        mesh.computeBoundingSphere();
        const bs = mesh.boundingSphere;
        root.add(mesh);
        if (mesh.castShadow && bs) {
          this.shadowEntries.push({ mesh, mode, center: bs.center.clone(), radius: bs.radius });
        }
        // The prototype geometry is shared across every region bucket of the
        // same prop, so it is only owned once. `protos` is the owner of record.
      }
    }
    this.groups.clear();

    for (const [key, b] of this.statics) {
      if (!b.geo.empty) b.chunks.push(b.geo.toGeometry(1));
      const merged = mergeParts(b.chunks);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, this.material(b.surf));
      mesh.name = `dz:props:${key}`;
      mesh.castShadow = b.shadow !== "never";
      mesh.receiveShadow = b.surf.m !== "lightCone";
      if (b.surf.m === "lightCone") {
        mesh.castShadow = false;
        mesh.renderOrder = 3;
      }
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      root.add(mesh);
      this.owned.push(merged);
      const bs = merged.boundingSphere;
      if (mesh.castShadow && bs) {
        this.shadowEntries.push({ mesh, mode: b.shadow, center: bs.center.clone(), radius: bs.radius });
      }
    }
    this.statics.clear();
  }

  dispose(): void {
    for (const p of this.protos.values()) for (const part of p.parts) part.geo.dispose();
    this.protos.clear();
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    for (const r of this.removers) r();
    this.removers.length = 0;
    this.shadowEntries.length = 0;
  }
}

/* ------------------------------------------------------------------------ *
 * Shared surfaces
 * ------------------------------------------------------------------------ */

/**
 * Deliberately few. Every distinct (surface × tint) inside a prototype is one
 * more `InstancedMesh` per region, so `S_RIM` is the same hex as `S_CHROME`
 * and `S_BLACK` is the same hex as `S_TYRE` — they read as different materials
 * because they are different *shapes* under different light, and merging them
 * halves the vehicle draw call count for nothing anyone can see.
 */
const S_TYRE = surf("rubber", 0x2a2c2e);
const S_RIM = surf("metalPanel", 0xdde3e7);
const S_CHROME = surf("metalPanel", 0xdde3e7);
const S_DARK = surf("metalPanel", 0x33393e);
const S_BLACK = surf("rubber", 0x2a2c2e);
const S_GLASS = surf("glass", 0xcfe4ea);
const S_STEEL = surf("metalPanel", 0x9aa3a8);
const S_GALV = surf("metalPanel", 0xb7bfc3);
const S_CONCRETE = surf("concrete", 0xbdb8ac);
const S_WOOD = surf("woodPlank", 0xffffff);
const S_LOG = surf("woodLog", 0xffffff);
const S_ROCK = surf("rock", 0xffffff);
const S_DIRT = surf("dirt", 0x6f5f47);
const S_RUST = surf("metalPanel", 0x7a4526);
const S_CORR = surf("corrugated", 0xffffff);

/**
 * Stylised automotive paint. Saturated but not fluorescent — this is the
 * palette that has to sit next to terracotta roofs and deep grass without
 * either shouting or disappearing.
 */
const CAR_PAINT = [
  0xc23f2b, 0x2f6f9c, 0xe2c04c, 0xeee7dc, 0x39424a, 0x4d7a49,
  0xcf7328, 0x7c4f96, 0x33a096, 0xa9b0b5, 0x8c2f3a, 0x5f6f7a,
];
/** Working vehicles: municipal yellows, fleet whites, contractor oranges. */
const WORK_PAINT = [0xe0a72b, 0xe8e2d6, 0xd4691f, 0x3f6f4f, 0x2f5f8c, 0xb8452c];

/* ------------------------------------------------------------------------ *
 * The vehicle kit
 * ------------------------------------------------------------------------ */

/**
 * A road wheel: a flat-faceted tyre on a dished rim with spokes, a hub cap and
 * a valve stem. The axle runs along X, which is the convention every vehicle
 * in this module is authored to (length along Z, width along X).
 *
 * The tyre is faceted rather than smooth because a smooth torus smears one
 * long specular streak round the whole circumference and reads as a rubber
 * doughnut; facets break it into blocks and read as tread.
 */
function wheel(b: PropBuilder, x: number, y: number, z: number, R: number, halfW: number, hub = true): void {
  const tube = Math.min(halfW, R * 0.36);
  b.torus(S_TYRE, x, y, z, R - tube, tube, { roll: Math.PI / 2, flat: true, major: b.tier.round, minor: b.tier.tyreSeg });
  // Rim: a dish set inboard of the tyre shoulder so the tyre wall reads proud.
  b.cyl(S_RIM, x, y, z, R - tube * 1.25, R - tube * 1.25, halfW * 1.4, { roll: Math.PI / 2, seg: b.tier.round, capBottom: true });
  if (!hub) return;
  const face = x >= 0 ? halfW * 0.72 : -halfW * 0.72;
  b.cyl(S_CHROME, x + face, y, z, R * 0.24, R * 0.20, 0.05, { roll: Math.PI / 2, seg: Math.max(6, b.tier.round - 2), capBottom: true });
  if (!b.tier.trim) return;
  // Five spokes. At 4 m they are three pixels each and they are still the
  // difference between a wheel and a black circle.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    const rr = (R - tube * 1.3) * 0.55;
    b.box(S_RIM, x + face * 0.55, y + Math.sin(a) * rr, z + Math.cos(a) * rr, 0.02, R * 0.30, 0.045, { yaw: 0, roll: 0, pitch: -a, bevel: 0 });
  }
}

/**
 * A headlamp / taillamp cluster: a lens plate recessed behind a chrome bezel.
 * `warm` picks the atlas cell. The facing is taken from the sign of `z`, which
 * is correct for every vehicle in this module because they are all authored
 * nose-toward-+Z.
 */
function lamp(b: PropBuilder, warm: boolean, x: number, y: number, z: number, hx: number, hy: number, depth: number): void {
  const face = z >= 0 ? 1 : -1;
  b.box(S_CHROME, x, y, z - face * 0.005, hx + 0.035, hy + 0.035, depth * 0.7, { bevel: 0.02 });
  const [u0, v0, u1, v1] = warm ? LENS_WARM : LENS_RED;
  b.emit(surf("lens"), uvQuad(hx, hy, u0, v0, u1, v1), xf(x, y, z + face * (depth + 0.012), face > 0 ? 0 : Math.PI));
}

/**
 * A car greenhouse: a glass shell, a body-coloured roof cap and real pillars.
 *
 * Doing it as one tinted box with a window decal is the classic web-game
 * shortcut and it always reads flat, because a window is a *recess*: the glass
 * has to sit behind the pillars for the eye to accept it.
 */
function greenhouse(
  b: PropBuilder, stations: Station[], pillarZ: number[], hw: number, roofTop: number, pillarW = 0.055,
): void {
  b.loft(S_GLASS, stations, undefined, "none", 3, true, true);
  const roof: Station[] = stations.map((s) => ({
    z: s.z, hw: s.hw + 0.045, yb: Math.min(s.yt - 0.085, roofTop - 0.085), yt: Math.min(s.yt, roofTop), r: s.r * 0.7,
  }));
  b.loft(surf("metalPanel", 0xffffff), roof, undefined, "body", 3, true, true);
  for (const pz of pillarZ) {
    // Find the local roof height by linear search — stations are few and this
    // runs once per prototype, not per instance.
    let top = roofTop;
    for (let i = 0; i < stations.length - 1; i++) {
      if (pz >= stations[i].z && pz <= stations[i + 1].z) {
        const t = (pz - stations[i].z) / Math.max(1e-4, stations[i + 1].z - stations[i].z);
        top = lerp(stations[i].yt, stations[i + 1].yt, t);
        break;
      }
    }
    const base = stations[0].yb;
    for (const sx of [-1, 1]) {
      b.box(surf("metalPanel", 0xffffff), sx * (hw + 0.012), (base + top) * 0.5, pz, pillarW, (top - base) * 0.5, pillarW * 1.6, { bevel: 0.02, tint: "body" });
    }
  }
}

/** The chrome window surround + belt line. One thin loft, enormous value. */
function beltLine(b: PropBuilder, stations: Station[], y: number, grow: number): void {
  const belt: Station[] = stations.map((s) => ({ z: s.z, hw: s.hw + grow, yb: y - 0.028, yt: y + 0.028, r: 0.022 }));
  b.loft(S_CHROME, belt, undefined, "none", 2, true, true);
}

/**
 * A four-door saloon. The workhorse of the map: parked on verges, abandoned
 * at junctions, nose-down in ditches.
 */
const DEF_SEDAN: PropDef = {
  key: "veh.sedan",
  harvest: "metal",
  clear: 3.2,
  shadow: "always",
  build(b) {
    const body: Station[] = [
      { z: -2.18, hw: 0.72, yb: 0.56, yt: 0.94, r: 0.20 },
      { z: -1.90, hw: 0.88, yb: 0.44, yt: 1.01, r: 0.24 },
      { z: -1.10, hw: 0.93, yb: 0.40, yt: 1.04, r: 0.26 },
      { z: 0.00, hw: 0.95, yb: 0.38, yt: 1.05, r: 0.28 },
      { z: 1.10, hw: 0.93, yb: 0.40, yt: 1.03, r: 0.26 },
      { z: 1.78, hw: 0.86, yb: 0.44, yt: 0.97, r: 0.24 },
      { z: 2.16, hw: 0.70, yb: 0.58, yt: 0.86, r: 0.20 },
    ];
    b.loft(surf("metalPanel", 0xffffff), body, undefined, "body", 3);
    beltLine(b, body, 1.005, 0.012);

    const cabin: Station[] = [
      { z: -1.52, hw: 0.78, yb: 1.00, yt: 1.06, r: 0.10 },
      { z: -1.22, hw: 0.81, yb: 1.00, yt: 1.40, r: 0.16 },
      { z: -0.20, hw: 0.83, yb: 1.00, yt: 1.49, r: 0.18 },
      { z: 0.52, hw: 0.81, yb: 1.00, yt: 1.47, r: 0.18 },
      { z: 1.10, hw: 0.73, yb: 1.00, yt: 1.20, r: 0.14 },
      { z: 1.36, hw: 0.64, yb: 1.00, yt: 1.05, r: 0.09 },
    ];
    greenhouse(b, cabin, [-1.18, -0.18, 0.95], 0.83, 1.49);

    // Bumpers, sills and the underbody shadow-catcher.
    b.box(S_DARK, 0, 0.60, 2.22, 0.92, 0.15, 0.11, { bevel: 0.05 });
    b.box(S_DARK, 0, 0.60, -2.24, 0.90, 0.15, 0.11, { bevel: 0.05 });
    b.box(S_BLACK, 0, 0.40, 0, 0.97, 0.045, 1.75, { bevel: 0.02 });
    b.box(S_BLACK, 0, 0.30, 0, 0.80, 0.10, 1.45, { bevel: 0.03 });

    // Grille: a recessed dark panel with slats across it.
    b.box(S_BLACK, 0, 0.82, 2.19, 0.52, 0.13, 0.05, { bevel: 0.01 });
    for (let i = 0; i < 3; i++) {
      b.box(S_CHROME, 0, 0.76 + i * 0.06, 2.215, 0.50, 0.014, 0.03, { bevel: 0 });
    }
    lamp(b, true,-0.62, 0.86, 2.16, 0.20, 0.09, 0.04);
    lamp(b, true,0.62, 0.86, 2.16, 0.20, 0.09, 0.04);
    lamp(b, false,-0.58, 0.88, -2.20, 0.19, 0.10, 0.04);
    lamp(b, false,0.58, 0.88, -2.20, 0.19, 0.10, 0.04);
    b.box(S_CHROME, 0, 0.70, -2.28, 0.16, 0.06, 0.015, { bevel: 0 });

    if (b.tier.trim) {
      // Mirrors on stalks, door handles, an exhaust, a fuel flap.
      for (const sx of [-1, 1]) {
        b.box(surf("metalPanel", 0xffffff), sx * 0.97, 1.13, 0.98, 0.05, 0.03, 0.03, { bevel: 0, tint: "body" });
        b.box(surf("metalPanel", 0xffffff), sx * 1.06, 1.15, 0.98, 0.055, 0.055, 0.09, { bevel: 0.02, tint: "body" });
        b.box(S_CHROME, sx * 0.955, 0.95, 0.35, 0.012, 0.022, 0.09, { bevel: 0 });
        b.box(S_CHROME, sx * 0.955, 0.95, -0.62, 0.012, 0.022, 0.09, { bevel: 0 });
        // The door shut line — a 2 cm dark recess. Without it the flank is a
        // single unbroken panel and the car reads as a bar of soap.
        b.box(S_BLACK, sx * 0.952, 0.72, -0.13, 0.008, 0.30, 0.012, { bevel: 0 });
        b.box(S_BLACK, sx * 0.952, 0.72, 1.02, 0.008, 0.30, 0.012, { bevel: 0 });
      }
      b.cyl(S_CHROME, -0.42, 0.46, -2.30, 0.045, 0.05, 0.14, { pitch: Math.PI / 2, seg: 8 });
    }

    wheel(b, -0.88, 0.40, 1.38, 0.40, 0.13);
    wheel(b, 0.88, 0.40, 1.38, 0.40, 0.13);
    wheel(b, -0.88, 0.40, -1.36, 0.40, 0.13);
    wheel(b, 0.88, 0.40, -1.36, 0.40, 0.13);

    b.solid(0, 0.78, 0, 0.98, 0.78, 2.28, { harvest: "metal", material: "metal" });
  },
};

/** A compact hatchback. Same kit, shorter tail — the silhouette variety that
 *  stops a car park reading as a clone stamp. */
const DEF_HATCH: PropDef = {
  key: "veh.hatch",
  harvest: "metal",
  clear: 2.8,
  shadow: "always",
  build(b) {
    const body: Station[] = [
      { z: -1.78, hw: 0.78, yb: 0.50, yt: 1.16, r: 0.22 },
      { z: -1.45, hw: 0.87, yb: 0.42, yt: 1.14, r: 0.24 },
      { z: -0.60, hw: 0.90, yb: 0.38, yt: 1.06, r: 0.26 },
      { z: 0.35, hw: 0.91, yb: 0.37, yt: 1.05, r: 0.27 },
      { z: 1.25, hw: 0.87, yb: 0.40, yt: 1.00, r: 0.24 },
      { z: 1.72, hw: 0.68, yb: 0.55, yt: 0.90, r: 0.19 },
    ];
    b.loft(surf("metalPanel", 0xffffff), body, undefined, "body", 3);
    beltLine(b, body, 1.0, 0.012);

    const cabin: Station[] = [
      { z: -1.62, hw: 0.76, yb: 1.02, yt: 1.40, r: 0.14 },
      { z: -1.05, hw: 0.80, yb: 1.02, yt: 1.50, r: 0.17 },
      { z: -0.10, hw: 0.81, yb: 1.02, yt: 1.50, r: 0.17 },
      { z: 0.62, hw: 0.74, yb: 1.02, yt: 1.26, r: 0.14 },
      { z: 0.94, hw: 0.63, yb: 1.02, yt: 1.06, r: 0.09 },
    ];
    greenhouse(b, cabin, [-1.10, -0.18, 0.52], 0.81, 1.50);

    b.box(S_DARK, 0, 0.58, 1.78, 0.88, 0.15, 0.10, { bevel: 0.05 });
    b.box(S_DARK, 0, 0.58, -1.84, 0.86, 0.15, 0.10, { bevel: 0.05 });
    b.box(S_BLACK, 0, 0.38, 0, 0.93, 0.045, 1.45, { bevel: 0.02 });
    b.box(S_BLACK, 0, 0.80, 1.74, 0.46, 0.11, 0.045, { bevel: 0.01 });
    lamp(b, true,-0.58, 0.90, 1.72, 0.19, 0.10, 0.04);
    lamp(b, true,0.58, 0.90, 1.72, 0.19, 0.10, 0.04);
    lamp(b, false,-0.62, 1.00, -1.80, 0.13, 0.16, 0.04);
    lamp(b, false,0.62, 1.00, -1.80, 0.13, 0.16, 0.04);
    if (b.tier.trim) {
      for (const sx of [-1, 1]) {
        b.box(surf("metalPanel", 0xffffff), sx * 1.0, 1.14, 0.60, 0.06, 0.05, 0.09, { bevel: 0.02, tint: "body" });
        b.box(S_BLACK, sx * 0.912, 0.72, 0.06, 0.008, 0.30, 0.012, { bevel: 0 });
      }
      // Roof rails — a silhouette break that shows even at 200 m.
      for (const sx of [-1, 1]) b.box(S_DARK, sx * 0.62, 1.53, -0.35, 0.035, 0.03, 0.55, { bevel: 0.01 });
    }

    wheel(b, -0.84, 0.37, 1.06, 0.37, 0.12);
    wheel(b, 0.84, 0.37, 1.06, 0.37, 0.12);
    wheel(b, -0.84, 0.37, -1.14, 0.37, 0.12);
    wheel(b, 0.84, 0.37, -1.14, 0.37, 0.12);
    b.solid(0, 0.80, -0.03, 0.94, 0.80, 1.88, { harvest: "metal", material: "metal" });
  },
};

/** A pickup with a real drop-side bed you can stand in. */
const DEF_PICKUP: PropDef = {
  key: "veh.pickup",
  harvest: "metal",
  clear: 3.6,
  shadow: "always",
  build(b) {
    const cabBody: Station[] = [
      { z: -0.30, hw: 0.99, yb: 0.60, yt: 1.32, r: 0.20 },
      { z: 0.60, hw: 1.00, yb: 0.56, yt: 1.32, r: 0.22 },
      { z: 1.60, hw: 0.98, yb: 0.54, yt: 1.24, r: 0.24 },
      { z: 2.30, hw: 0.92, yb: 0.58, yt: 1.10, r: 0.22 },
      { z: 2.62, hw: 0.74, yb: 0.66, yt: 1.02, r: 0.18 },
    ];
    b.loft(surf("metalPanel", 0xffffff), cabBody, undefined, "body", 3);

    const cabin: Station[] = [
      { z: -0.22, hw: 0.90, yb: 1.28, yt: 1.90, r: 0.14 },
      { z: 0.42, hw: 0.91, yb: 1.28, yt: 1.92, r: 0.16 },
      { z: 1.10, hw: 0.86, yb: 1.28, yt: 1.66, r: 0.15 },
      { z: 1.36, hw: 0.78, yb: 1.28, yt: 1.36, r: 0.10 },
    ];
    greenhouse(b, cabin, [-0.18, 0.98], 0.91, 1.92, 0.07);

    // The bed: floor, two sides with a rolled top rail, a tailgate, and ribs.
    const bedY = 0.96;
    b.box(surf("metalPanel", 0xffffff), 0, bedY, -1.55, 0.98, 0.07, 1.32, { tint: "body" });
    for (const sx of [-1, 1]) {
      b.box(surf("metalPanel", 0xffffff), sx * 0.94, bedY + 0.30, -1.55, 0.055, 0.30, 1.32, { tint: "body" });
      b.box(S_DARK, sx * 0.94, bedY + 0.62, -1.55, 0.075, 0.035, 1.34, { bevel: 0.02 });
    }
    b.box(surf("metalPanel", 0xffffff), 0, bedY + 0.30, -2.85, 0.98, 0.30, 0.06, { tint: "body" });
    b.box(S_DARK, 0, bedY + 0.62, -2.85, 1.00, 0.035, 0.08, { bevel: 0.02 });
    if (b.tier.trim) {
      for (let i = -1; i <= 1; i++) {
        b.box(S_DARK, 0, bedY + 0.08, -1.55 + i * 0.62, 0.90, 0.02, 0.045, { bevel: 0 });
      }
      // Roll bar over the cab. Chunky, and it makes the silhouette unmistakable.
      for (const sx of [-1, 1]) b.cyl(S_STEEL, sx * 0.72, 1.60, -0.32, 0.05, 0.05, 1.28, { seg: 8 });
      b.cyl(S_STEEL, 0, 2.22, -0.32, 0.05, 0.05, 1.44, { roll: Math.PI / 2, seg: 8 });
      b.box(S_DARK, 0, 2.30, -0.32, 0.42, 0.09, 0.10, { bevel: 0.02 });
      lamp(b, true,-0.24, 2.30, -0.24, 0.09, 0.07, 0.03);
      lamp(b, true,0.24, 2.30, -0.24, 0.09, 0.07, 0.03);
    }

    b.box(S_DARK, 0, 0.72, 2.70, 0.98, 0.17, 0.12, { bevel: 0.05 });
    b.box(S_DARK, 0, 0.72, -2.94, 0.98, 0.17, 0.12, { bevel: 0.05 });
    b.box(S_BLACK, 0, 0.98, 2.62, 0.60, 0.16, 0.05, { bevel: 0.01 });
    lamp(b, true,-0.70, 1.02, 2.60, 0.20, 0.11, 0.04);
    lamp(b, true,0.70, 1.02, 2.60, 0.20, 0.11, 0.04);
    lamp(b, false,-0.82, 1.14, -2.90, 0.11, 0.19, 0.04);
    lamp(b, false,0.82, 1.14, -2.90, 0.11, 0.19, 0.04);

    wheel(b, -0.94, 0.50, 1.70, 0.50, 0.17);
    wheel(b, 0.94, 0.50, 1.70, 0.50, 0.17);
    wheel(b, -0.94, 0.50, -1.85, 0.50, 0.17);
    wheel(b, 0.94, 0.50, -1.85, 0.50, 0.17);
    b.solid(0, 1.00, -0.10, 1.02, 1.00, 2.95, { harvest: "metal", material: "metal" });
  },
};

/** A box van. Flat slab sides make it the best mid-street cover on the map. */
const DEF_VAN: PropDef = {
  key: "veh.van",
  harvest: "metal",
  clear: 3.8,
  shadow: "always",
  build(b) {
    const nose: Station[] = [
      { z: 1.05, hw: 1.02, yb: 0.52, yt: 2.28, r: 0.26 },
      { z: 1.95, hw: 1.00, yb: 0.50, yt: 2.16, r: 0.30 },
      { z: 2.48, hw: 0.92, yb: 0.56, yt: 1.86, r: 0.28 },
      { z: 2.72, hw: 0.74, yb: 0.66, yt: 1.52, r: 0.22 },
    ];
    b.loft(surf("metalPanel", 0xffffff), nose, undefined, "body", 3);
    // Windscreen + door glass, set behind the pillar line.
    b.box(S_GLASS, 0, 1.72, 2.42, 0.80, 0.34, 0.10, { bevel: 0.02, pitch: -0.22 });
    for (const sx of [-1, 1]) b.box(S_GLASS, sx * 0.98, 1.66, 1.80, 0.05, 0.28, 0.42, { bevel: 0.02 });

    // The cargo box, in corrugated so it reads as a different material to the
    // cab even at distance — that contrast is what makes a van a van.
    b.box(S_CORR, 0, 1.42, -1.20, 1.06, 1.00, 2.32, { bevel: 0.05, tint: "body" });
    b.box(S_DARK, 0, 2.44, -1.20, 1.08, 0.045, 2.34, { bevel: 0.02 });
    for (let i = -2; i <= 2; i++) {
      for (const sx of [-1, 1]) b.box(S_DARK, sx * 1.07, 1.42, -1.20 + i * 0.55, 0.02, 0.98, 0.035, { bevel: 0 });
    }
    // Rear doors: two leaves, a centre seam and two locking bars.
    b.box(S_DARK, 0, 1.42, -3.53, 1.04, 0.98, 0.03, { bevel: 0.02, tint: "body" });
    b.box(S_DARK, 0, 1.42, -3.56, 0.02, 0.96, 0.02, { bevel: 0 });
    for (const sx of [-1, 1]) b.cyl(S_STEEL, sx * 0.55, 1.42, -3.58, 0.028, 0.028, 1.70, { seg: 6 });

    b.box(S_DARK, 0, 0.66, 2.80, 1.00, 0.17, 0.11, { bevel: 0.05 });
    b.box(S_BLACK, 0, 0.98, 2.70, 0.62, 0.18, 0.05, { bevel: 0.01 });
    lamp(b, true,-0.74, 1.02, 2.68, 0.21, 0.12, 0.04);
    lamp(b, true,0.74, 1.02, 2.68, 0.21, 0.12, 0.04);
    lamp(b, false,-0.88, 0.86, -3.58, 0.12, 0.20, 0.04);
    lamp(b, false,0.88, 0.86, -3.58, 0.12, 0.20, 0.04);
    if (b.tier.trim) {
      for (const sx of [-1, 1]) b.box(surf("metalPanel", 0xffffff), sx * 1.12, 1.72, 1.98, 0.08, 0.13, 0.05, { bevel: 0.02, tint: "body" });
    }

    wheel(b, -0.96, 0.48, 1.86, 0.48, 0.16);
    wheel(b, 0.96, 0.48, 1.86, 0.48, 0.16);
    wheel(b, -0.96, 0.48, -2.10, 0.48, 0.16);
    wheel(b, 0.96, 0.48, -2.10, 0.48, 0.16);
    b.solid(0, 1.20, -0.35, 1.08, 1.20, 3.30, { harvest: "metal", material: "metal" });
  },
};

/** The bus. A landmark-scale prop: it blocks a street, you can fight around it,
 *  and it is the only vehicle that reads from the drop. */
const DEF_BUS: PropDef = {
  key: "veh.bus",
  harvest: "metal",
  clear: 6.5,
  shadow: "always",
  build(b) {
    const hull: Station[] = [
      { z: -5.40, hw: 1.22, yb: 0.62, yt: 3.02, r: 0.34 },
      { z: -4.90, hw: 1.28, yb: 0.58, yt: 3.10, r: 0.30 },
      { z: -1.00, hw: 1.30, yb: 0.56, yt: 3.14, r: 0.26 },
      { z: 3.20, hw: 1.30, yb: 0.56, yt: 3.14, r: 0.26 },
      { z: 4.85, hw: 1.26, yb: 0.60, yt: 3.02, r: 0.30 },
      { z: 5.35, hw: 1.10, yb: 0.70, yt: 2.72, r: 0.32 },
    ];
    b.loft(surf("metalPanel", 0xffffff), hull, undefined, "body", 4);

    // Window band: one continuous glass loft inset 4 cm, then vertical pillars
    // struck across it. Cheap, and it gives the flank the horizontal read a bus
    // has to have.
    const band: Station[] = hull.map((s) => ({ z: s.z, hw: s.hw - 0.04, yb: 1.72, yt: 2.72, r: 0.14 }));
    b.loft(S_GLASS, band, undefined, "none", 3);
    for (let i = -4; i <= 4; i++) {
      for (const sx of [-1, 1]) {
        b.box(surf("metalPanel", 0xffffff), sx * 1.29, 2.22, i * 1.16, 0.035, 0.52, 0.06, { bevel: 0.015, tint: "body" });
      }
    }
    // Roof ribs, skirt, and the destination blind above the screen.
    for (let i = -4; i <= 4; i++) b.box(S_DARK, 0, 3.16, i * 1.15, 1.24, 0.025, 0.05, { bevel: 0 });
    b.box(S_DARK, 0, 0.60, 0, 1.32, 0.14, 5.35, { bevel: 0.03 });
    b.box(S_BLACK, 0, 2.90, 5.30, 0.86, 0.18, 0.05, { bevel: 0.01 });
    b.box(S_GLASS, 0, 2.28, 5.32, 1.06, 0.52, 0.05, { bevel: 0.02 });
    b.box(S_GLASS, 0, 2.28, -5.44, 1.02, 0.44, 0.05, { bevel: 0.02 });
    // Door: a recessed double leaf, the accent colour, on the kerb side.
    b.box(S_DARK, 1.31, 1.60, 3.30, 0.05, 1.00, 0.62, { bevel: 0.02 });
    b.box(S_GLASS, 1.33, 1.72, 3.30, 0.03, 0.80, 0.54, { bevel: 0.01 });
    b.box(S_DARK, 1.31, 1.60, -2.30, 0.05, 1.00, 0.62, { bevel: 0.02 });

    b.box(S_DARK, 0, 0.78, 5.44, 1.24, 0.20, 0.12, { bevel: 0.05 });
    b.box(S_DARK, 0, 0.78, -5.52, 1.24, 0.20, 0.12, { bevel: 0.05 });
    lamp(b, true,-0.92, 1.06, 5.40, 0.22, 0.13, 0.05);
    lamp(b, true,0.92, 1.06, 5.40, 0.22, 0.13, 0.05);
    lamp(b, false,-0.98, 1.10, -5.50, 0.16, 0.24, 0.05);
    lamp(b, false,0.98, 1.10, -5.50, 0.16, 0.24, 0.05);

    for (const z of [3.60, -3.00, -4.10]) {
      wheel(b, -1.22, 0.56, z, 0.56, 0.19, z !== -4.10);
      wheel(b, 1.22, 0.56, z, 0.56, 0.19, z !== -4.10);
    }
    b.solid(0, 1.85, 0, 1.34, 1.30, 5.55, { harvest: "metal", material: "metal" });
  },
};

/** A farm tractor: tall narrow bonnet, huge rear wheels, a glass cab on a frame. */
const DEF_TRACTOR: PropDef = {
  key: "veh.tractor",
  harvest: "metal",
  clear: 3.0,
  shadow: "always",
  build(b) {
    const bonnet: Station[] = [
      { z: -0.10, hw: 0.44, yb: 0.94, yt: 1.62, r: 0.14 },
      { z: 0.80, hw: 0.42, yb: 0.92, yt: 1.60, r: 0.16 },
      { z: 1.60, hw: 0.38, yb: 0.90, yt: 1.44, r: 0.16 },
      { z: 1.86, hw: 0.30, yb: 0.94, yt: 1.30, r: 0.12 },
    ];
    b.loft(surf("metalPanel", 0xffffff), bonnet, undefined, "body", 3);
    // Chassis spine + rear transmission housing.
    b.box(S_DARK, 0, 0.86, 0.60, 0.30, 0.22, 1.30, { bevel: 0.03 });
    b.box(surf("metalPanel", 0xffffff), 0, 1.06, -0.90, 0.46, 0.42, 0.90, { bevel: 0.05, tint: "body" });
    b.box(S_DARK, 0, 0.62, -0.90, 0.34, 0.26, 0.70, { bevel: 0.03 });

    // Cab: four pipe posts, a flat roof and glass all round. Reads instantly.
    const cabY0 = 1.30, cabY1 = 2.48;
    for (const sx of [-1, 1]) {
      for (const cz of [-1.28, 0.02]) {
        b.cyl(S_DARK, sx * 0.62, (cabY0 + cabY1) * 0.5, cz, 0.045, 0.045, cabY1 - cabY0, { seg: 6 });
      }
    }
    b.box(S_GLASS, 0, 1.92, 0.04, 0.60, 0.56, 0.03, { bevel: 0.01 });
    for (const sx of [-1, 1]) b.box(S_GLASS, sx * 0.62, 1.92, -0.62, 0.03, 0.56, 0.62, { bevel: 0.01 });
    b.box(surf("metalPanel", 0xffffff), 0, 2.54, -0.62, 0.74, 0.07, 0.86, { bevel: 0.04, tint: "body" });
    b.box(S_DARK, 0, 2.62, -0.62, 0.60, 0.03, 0.72, { bevel: 0 });
    // Exhaust stack with a rain cap — the tractor's whole silhouette signature.
    b.cyl(S_DARK, 0.30, 1.94, 0.72, 0.055, 0.048, 1.10, { seg: 8 });
    b.cyl(S_DARK, 0.30, 2.52, 0.72, 0.075, 0.075, 0.05, { seg: 8, capBottom: true });
    if (b.tier.trim) {
      b.box(S_BLACK, 0, 1.22, 1.84, 0.24, 0.16, 0.04, { bevel: 0.01 });
      lamp(b, true,-0.30, 1.36, 1.82, 0.09, 0.07, 0.03);
      lamp(b, true,0.30, 1.36, 1.82, 0.09, 0.07, 0.03);
      for (const sx of [-1, 1]) b.box(S_DARK, sx * 0.66, 2.46, 0.06, 0.09, 0.08, 0.09, { bevel: 0.02 });
    }
    // Wheels: the rear pair are the reason you can see a tractor from a ridge.
    wheel(b, -0.78, 0.42, 1.34, 0.42, 0.13);
    wheel(b, 0.78, 0.42, 1.34, 0.42, 0.13);
    wheel(b, -0.86, 0.82, -1.00, 0.82, 0.26);
    wheel(b, 0.86, 0.82, -1.00, 0.82, 0.26);
    // Cleated rear tread: eight angled blocks per wheel, the classic read.
    if (b.tier.trim) {
      for (const sx of [-1, 1]) {
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU;
          b.box(S_TYRE, sx * 0.86, 0.82 + Math.sin(a) * 0.76, -1.00 + Math.cos(a) * 0.76, 0.24, 0.06, 0.10, { pitch: -a, roll: 0.35, bevel: 0.02 });
        }
      }
    }
    b.solid(0, 1.30, 0.10, 0.90, 1.30, 2.10, { harvest: "metal", material: "metal" });
  },
};

/**
 * A burnt-out shell. Same loft, no glass, no wheels on one side, and a
 * charcoal body tint applied at placement. Wrecks are what make a map feel
 * like something happened here rather than like a showroom.
 */
const DEF_WRECK: PropDef = {
  key: "veh.wreck",
  harvest: "metal",
  clear: 3.0,
  skirt: [1.0, 2.1],
  shadow: "always",
  build(b) {
    const body: Station[] = [
      { z: -2.05, hw: 0.70, yb: 0.44, yt: 0.86, r: 0.18 },
      { z: -1.70, hw: 0.86, yb: 0.34, yt: 0.94, r: 0.22 },
      { z: -0.30, hw: 0.92, yb: 0.30, yt: 0.98, r: 0.26 },
      { z: 1.10, hw: 0.88, yb: 0.32, yt: 0.92, r: 0.24 },
      { z: 1.95, hw: 0.66, yb: 0.46, yt: 0.80, r: 0.18 },
    ];
    b.loft(surf("metalPanel", 0xffffff), body, undefined, "body", 3);
    // A collapsed roof: the cabin loft, crushed and pushed off-axis.
    const cabin: Station[] = [
      { z: -1.40, hw: 0.72, yb: 0.92, yt: 1.10, r: 0.10 },
      { z: -0.40, hw: 0.76, yb: 0.92, yt: 1.24, r: 0.14 },
      { z: 0.60, hw: 0.70, yb: 0.92, yt: 1.12, r: 0.12 },
      { z: 1.00, hw: 0.58, yb: 0.92, yt: 0.98, r: 0.08 },
    ];
    b.loft(surf("metalPanel", 0xffffff), cabin, xf(0.06, 0, 0, 0, 0, -0.07), "body", 3);
    b.box(S_BLACK, 0, 0.30, 0, 0.94, 0.05, 1.75, { bevel: 0.02 });
    b.box(S_RUST, 0, 0.52, 2.05, 0.86, 0.13, 0.09, { bevel: 0.04 });
    // Three wheels, one hub bare and one tyre lying flat beside the car.
    wheel(b, -0.84, 0.34, 1.24, 0.34, 0.12);
    wheel(b, 0.84, 0.34, -1.22, 0.34, 0.12);
    wheel(b, -0.84, 0.34, -1.22, 0.34, 0.12);
    b.cyl(S_RUST, 0.86, 0.30, 1.24, 0.20, 0.18, 0.14, { roll: Math.PI / 2, seg: 8, capBottom: true });
    b.torus(S_TYRE, 1.70, 0.13, 0.55, 0.30, 0.13, { flat: true, major: 10, minor: 5 });
    b.solid(0, 0.66, 0, 0.96, 0.66, 2.10, { harvest: "metal", material: "metal" });
  },
};

/* ------------------------------------------------------------------------ *
 * Segment helpers
 *
 * Lattice towers, scaffolding and boat rigging are all "a bar from A to B",
 * and authoring those by hand-deriving Euler angles at every call site is how
 * a module like this turns into a swamp.
 * ------------------------------------------------------------------------ */

/** A square-section strut from A to B. Local +Z is mapped onto the segment. */
function strut(
  b: PropBuilder, s: Surf,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  r: number, bevel?: number,
): void {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return;
  const yaw = Math.atan2(dx, dz);
  const pitch = -Math.asin(Math.max(-1, Math.min(1, dy / len)));
  b.box(s, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, r, r, len / 2, { yaw, pitch, bevel });
}

/** A round pipe from A to B. Local +Y is mapped onto the segment. */
function pipe(
  b: PropBuilder, s: Surf,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  r: number, seg?: number,
): void {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return;
  const yaw = Math.atan2(dx, dz);
  const pitch = Math.acos(Math.max(-1, Math.min(1, dy / len)));
  b.cyl(s, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, r, r, len, { yaw, pitch, seg, capBottom: true });
}

/**
 * A swept tube along a polyline. Used for the catenary cables, which are the
 * one thing in the module authored in world space rather than as a prototype:
 * every span has a different length, a different sag and a different pair of
 * end heights, so there is nothing to instance.
 *
 * Parallel transport would be correct; a fixed up-vector is not, and for a
 * cable that never rolls it is indistinguishable and a third of the code.
 */
function tubeAlong(points: THREE.Vector3[], r: number, seg: number): Geo {
  const g = new Geo();
  g.uvMode = "metre";
  if (points.length < 2) return g;
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const side = new THREE.Vector3();
  const norm = new THREE.Vector3();
  let dist = 0;
  const rings: number[][][] = [];
  const lens: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const c = points[Math.min(points.length - 1, i + 1)];
    dir.subVectors(c, a).normalize();
    side.crossVectors(dir, up).normalize();
    if (!isFinite(side.x) || side.lengthSq() < 1e-6) side.set(1, 0, 0);
    norm.crossVectors(side, dir).normalize();
    const ring: number[][] = [];
    for (let j = 0; j < seg; j++) {
      const a2 = (j / seg) * TAU;
      const ca = Math.cos(a2) * r, sa = Math.sin(a2) * r;
      ring.push([
        points[i].x + side.x * ca + norm.x * sa,
        points[i].y + side.y * ca + norm.y * sa,
        points[i].z + side.z * ca + norm.z * sa,
        side.x * Math.cos(a2) + norm.x * Math.sin(a2),
        side.y * Math.cos(a2) + norm.y * Math.sin(a2),
        side.z * Math.cos(a2) + norm.z * Math.sin(a2),
      ]);
    }
    if (i > 0) dist += points[i].distanceTo(points[i - 1]);
    lens.push(dist);
    rings.push(ring);
  }
  const circ = TAU * r;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const k = (j + 1) % seg;
      const A = rings[i][j], B = rings[i][k], C = rings[i + 1][k], D = rings[i + 1][j];
      const u0 = (j / seg) * circ, u1 = ((j + 1) / seg) * circ;
      const i0 = g.vert(A[0], A[1], A[2], A[3], A[4], A[5], u0, lens[i]);
      const i1 = g.vert(B[0], B[1], B[2], B[3], B[4], B[5], u1, lens[i]);
      const i2 = g.vert(C[0], C[1], C[2], C[3], C[4], C[5], u1, lens[i + 1]);
      const i3 = g.vert(D[0], D[1], D[2], D[3], D[4], D[5], u0, lens[i + 1]);
      g.idx.push(i0, i1, i2, i0, i2, i3);
    }
  }
  return g;
}

/**
 * An open cone about -Y, UV'd 0..1 top to bottom. The lamp light volume.
 * Authored rather than taken from `cylinder()` because the gradient has to
 * span the cone exactly once and `cylinder()` writes metre-space V.
 */
function coneGeo(rTop: number, rBottom: number, h: number, seg: number): Geo {
  const g = new Geo();
  g.uvMode = "metre";
  for (let i = 0; i < seg; i++) {
    const t0 = (i / seg) * TAU, t1 = ((i + 1) / seg) * TAU;
    const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
    const a = g.vert(c0 * rTop, 0, s0 * rTop, c0, 0, s0, i / seg, 0);
    const b2 = g.vert(c1 * rTop, 0, s1 * rTop, c1, 0, s1, (i + 1) / seg, 0);
    const c = g.vert(c1 * rBottom, -h, s1 * rBottom, c1, 0, s1, (i + 1) / seg, 1);
    const d = g.vert(c0 * rBottom, -h, s0 * rBottom, c0, 0, s0, i / seg, 1);
    g.idx.push(a, b2, c, a, c, d);
  }
  return g;
}

/** A textured quad with explicit UVs — sign faces and chain-link panels. */
function uvQuad(w: number, h: number, u0: number, v0: number, u1: number, v1: number, nz = 1): Geo {
  const g = new Geo();
  g.uvMode = "metre";
  const a = g.vert(-w, -h, 0, 0, 0, nz, u0, v1);
  const b = g.vert(w, -h, 0, 0, 0, nz, u1, v1);
  const c = g.vert(w, h, 0, 0, 0, nz, u1, v0);
  const d = g.vert(-w, h, 0, 0, 0, nz, u0, v0);
  if (nz > 0) g.idx.push(a, b, c, a, c, d);
  else g.idx.push(a, c, b, a, d, c);
  return g;
}

/* ------------------------------------------------------------------------ *
 * Street furniture
 * ------------------------------------------------------------------------ */

/** Lamp head height. Also the length of the light cone, so they stay in step. */
const LAMP_H = 6.6;

const DEF_LAMP: PropDef = {
  key: "st.lamp",
  harvest: "metal",
  clear: 1.4,
  skirt: [0.27, 0.27],
  shadow: "always",
  build(b) {
    // Cast base with an access hatch and its four bolts. Nobody consciously
    // sees this; everybody notices when a post grows straight out of the road.
    b.cyl(S_CONCRETE, 0, 0.11, 0, 0.26, 0.23, 0.22, { seg: 10 });
    b.cyl(S_DARK, 0, 0.36, 0, 0.155, 0.135, 0.34, { seg: 10 });
    b.box(S_DARK, 0, 0.40, 0.135, 0.075, 0.15, 0.02, { bevel: 0.01 });
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      b.box(S_GALV, sx * 0.05, 0.40 + sy * 0.12, 0.15, 0.014, 0.014, 0.012, { bevel: 0 });
    }
    b.cyl(S_GALV, 0, 0.53 + (LAMP_H - 0.53) * 0.5, 0, 0.105, 0.068, LAMP_H - 0.53, { seg: b.tier.round });

    // The arm: four short segments on an arc. A straight arm reads municipal
    // and cheap; a curved one reads designed, and it costs three more boxes.
    const R = 1.05;
    let px = 0, py = LAMP_H, pz = 0;
    for (let i = 1; i <= 4; i++) {
      const a = (i / 4) * (Math.PI * 0.5);
      const nx2 = Math.sin(a) * R;
      const ny2 = LAMP_H + (1 - Math.cos(a)) * R * 0.62;
      pipe(b, S_GALV, px, py, pz, nx2, ny2, 0, 0.055, 8);
      px = nx2; py = ny2; pz = 0;
    }
    // Head: a tapered housing with a lens plate underneath and a cap on top.
    b.box(S_GALV, px + 0.42, py + 0.02, 0, 0.46, 0.075, 0.20, { bevel: 0.045 });
    b.box(S_DARK, px + 0.42, py - 0.06, 0, 0.42, 0.03, 0.17, { bevel: 0.02 });
    b.emit(surf("lens"), uvQuad(0.38, 0.15, LENS_WARM[0], LENS_WARM[1], LENS_WARM[2], LENS_WARM[3]), xf(px + 0.42, py - 0.095, 0, 0, -Math.PI / 2, 0));
    if (b.tier.extras) {
      b.emit(surf("lightCone"), coneGeo(0.30, 2.6, LAMP_H + 0.6, 10), xf(px + 0.42, py - 0.12, 0));
    }
    b.solid(0, 1.6, 0, 0.17, 1.6, 0.17, { harvest: "metal", material: "metal" });
  },
};

const DEF_BENCH: PropDef = {
  key: "st.bench",
  harvest: "wood",
  clear: 1.6,
  skirt: [0.85, 0.36],
  shadow: "near",
  build(b) {
    for (const sx of [-1, 1]) {
      // Cast end frame: foot, upright, seat rail, raked back rail, armrest.
      const x = sx * 0.78;
      b.box(S_DARK, x, 0.035, 0, 0.055, 0.035, 0.30, { bevel: 0.02 });
      b.box(S_DARK, x, 0.24, 0.16, 0.045, 0.24, 0.045, { bevel: 0.02 });
      b.box(S_DARK, x, 0.24, -0.16, 0.045, 0.24, 0.045, { bevel: 0.02 });
      b.box(S_DARK, x, 0.46, 0, 0.045, 0.03, 0.28, { bevel: 0.02 });
      strut(b, S_DARK, x, 0.46, -0.20, x, 0.90, -0.34, 0.04);
      b.box(S_DARK, x, 0.72, 0.02, 0.045, 0.03, 0.24, { bevel: 0.02 });
    }
    for (let i = 0; i < 4; i++) {
      b.box(S_WOOD, 0, 0.50, -0.21 + i * 0.145, 0.82, 0.028, 0.058, { bevel: 0.012 });
    }
    for (let i = 0; i < 3; i++) {
      const t = i / 2;
      b.box(S_WOOD, 0, 0.60 + t * 0.28, -0.235 - t * 0.088, 0.82, 0.055, 0.026, { bevel: 0.012, pitch: 0.30 });
    }
    if (b.tier.trim) {
      for (const sx of [-1, 1]) for (let i = 0; i < 4; i++) {
        b.box(S_CHROME, sx * 0.72, 0.53, -0.21 + i * 0.145, 0.012, 0.008, 0.012, { bevel: 0 });
      }
    }
    b.solid(0, 0.45, 0, 0.85, 0.45, 0.32, { harvest: "wood", material: "wood" });
  },
};

const DEF_BIN: PropDef = {
  key: "st.bin",
  harvest: "metal",
  clear: 0.9,
  skirt: [0.32, 0.32],
  shadow: "near",
  build(b) {
    b.cyl(S_GALV, 0, 0.45, 0, 0.28, 0.31, 0.86, { seg: b.tier.round, tint: "body" });
    // Vertical ribs. A plain cylinder is the flattest thing you can put in a
    // street; ribs give it eight highlights instead of one.
    const ribs = Math.max(8, b.tier.round);
    for (let i = 0; i < ribs; i++) {
      const a = (i / ribs) * TAU;
      b.box(S_GALV, Math.cos(a) * 0.30, 0.45, Math.sin(a) * 0.30, 0.02, 0.40, 0.035, { yaw: -a, bevel: 0.008, tint: "body" });
    }
    b.torus(S_DARK, 0, 0.90, 0, 0.30, 0.035, { major: b.tier.round, minor: 5 });
    b.cyl(S_DARK, 0, 0.95, 0, 0.32, 0.26, 0.10, { seg: b.tier.round });
    b.cyl(S_DARK, 0, 1.02, 0, 0.13, 0.13, 0.05, { seg: 8 });
    b.solid(0, 0.48, 0, 0.32, 0.48, 0.32, { harvest: "metal", material: "metal" });
  },
};

const DEF_HYDRANT: PropDef = {
  key: "st.hydrant",
  harvest: "metal",
  clear: 0.7,
  skirt: [0.22, 0.22],
  shadow: "near",
  build(b) {
    const s = surf("metalPanel", 0xffffff);
    b.cyl(S_DARK, 0, 0.035, 0, 0.24, 0.22, 0.07, { seg: 10 });
    b.cyl(s, 0, 0.09, 0, 0.19, 0.17, 0.06, { seg: 10, tint: "body" });
    b.cyl(s, 0, 0.40, 0, 0.135, 0.125, 0.58, { seg: 10, tint: "body" });
    b.torus(s, 0, 0.70, 0, 0.135, 0.032, { major: 10, minor: 5, tint: "body" });
    b.cyl(s, 0, 0.76, 0, 0.155, 0.135, 0.10, { seg: 10, tint: "body" });
    // Domed bonnet + the pentagon operating nut on top.
    b.cyl(s, 0, 0.84, 0, 0.13, 0.075, 0.08, { seg: 10, tint: "body" });
    b.cyl(S_CHROME, 0, 0.90, 0, 0.045, 0.038, 0.06, { seg: 5 });
    for (const sx of [-1, 1]) {
      b.cyl(s, sx * 0.155, 0.50, 0, 0.075, 0.068, 0.10, { roll: Math.PI / 2, seg: 8, tint: "body" });
      b.cyl(S_CHROME, sx * 0.215, 0.50, 0, 0.078, 0.072, 0.04, { roll: Math.PI / 2, seg: 6 });
    }
    b.cyl(s, 0, 0.50, 0.155, 0.075, 0.068, 0.10, { pitch: Math.PI / 2, seg: 8, tint: "body" });
    b.solid(0, 0.45, 0, 0.24, 0.45, 0.24, { harvest: "metal", material: "metal" });
  },
};

const DEF_CONE: PropDef = {
  key: "st.cone",
  harvest: "metal",
  clear: 0.5,
  shadow: "never",
  build(b) {
    b.box(surf("rubber", 0x39424a), 0, 0.02, 0, 0.20, 0.022, 0.20, { bevel: 0.02 });
    b.cyl(surf("rubber", 0xd4551f), 0, 0.33, 0, 0.155, 0.035, 0.60, { seg: 10 });
    // The retro band. Two centimetres of near-white is what makes a cone read
    // as a cone in shadow instead of an orange smudge.
    b.cyl(surf("rubber", 0xf0ece2), 0, 0.44, 0, 0.10, 0.086, 0.10, { seg: 10 });
    b.cyl(surf("rubber", 0xd4551f), 0, 0.63, 0, 0.036, 0.030, 0.06, { seg: 8 });
  },
};

const DEF_SIGN: PropDef = {
  key: "st.sign",
  harvest: "metal",
  clear: 0.8,
  shadow: "near",
  build(b) {
    b.cyl(S_CONCRETE, 0, 0.05, 0, 0.14, 0.12, 0.10, { seg: 8 });
    b.cyl(S_GALV, 0, 1.35, 0, 0.045, 0.042, 2.60, { seg: 8 });
    b.box(S_GALV, 0, 2.40, 0, 0.34, 0.34, 0.022, { bevel: 0.02 });
    // Atlas cell picked per prototype, not per instance — variation comes from
    // placing more than one sign def, which costs one more prototype and keeps
    // every sign of a kind in a single instanced draw.
    b.emit(surf("signFace"), uvQuad(0.32, 0.32, 0.5, 0, 1, 0.5), xf(0, 2.40, 0.024));
    b.emit(surf("signFace"), uvQuad(0.32, 0.32, 0.5, 0, 1, 0.5, -1), xf(0, 2.40, -0.024));
    b.solid(0, 1.30, 0, 0.10, 1.30, 0.10, { harvest: "metal", material: "metal" });
  },
};

const DEF_SIGN_WARN: PropDef = {
  key: "st.signWarn",
  harvest: "metal",
  clear: 0.8,
  shadow: "near",
  build(b) {
    b.cyl(S_CONCRETE, 0, 0.05, 0, 0.14, 0.12, 0.10, { seg: 8 });
    b.cyl(S_GALV, 0, 1.10, 0, 0.042, 0.040, 2.10, { seg: 8 });
    b.box(S_GALV, 0, 1.98, 0, 0.30, 0.30, 0.022, { bevel: 0.02, roll: Math.PI / 4 });
    b.emit(surf("signFace"), uvQuad(0.28, 0.28, 0, 0, 0.5, 0.5), xf(0, 1.98, 0.024, 0, 0, Math.PI / 4));
    b.emit(surf("signFace"), uvQuad(0.28, 0.28, 0, 0, 0.5, 0.5, -1), xf(0, 1.98, -0.024, 0, 0, Math.PI / 4));
    b.solid(0, 1.05, 0, 0.09, 1.05, 0.09, { harvest: "metal", material: "metal" });
  },
};

const DEF_SHELTER: PropDef = {
  key: "st.shelter",
  harvest: "metal",
  clear: 3.2,
  shadow: "always",
  build(b) {
    const L = 2.0, D = 0.70, H = 2.45;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      b.box(S_DARK, sx * L, H / 2, sz * D, 0.06, H / 2, 0.06, { bevel: 0.02 });
    }
    // Curved roof: five short slabs on an arc, plus a drip fascia.
    for (let i = 0; i < 5; i++) {
      const t = i / 4 - 0.5;
      b.box(S_GALV, 0, H + 0.06 - t * t * 0.34, t * 1.5, L + 0.16, 0.035, 0.20, { pitch: t * 0.44, bevel: 0.02, tint: "body" });
    }
    b.box(S_DARK, 0, H + 0.02, -0.86, L + 0.18, 0.05, 0.05, { bevel: 0.02 });
    b.box(S_DARK, 0, H - 0.06, 0.86, L + 0.18, 0.05, 0.05, { bevel: 0.02 });
    // Back and one end in glass, set into the frame.
    b.box(S_GLASS, 0, 1.30, -D, L - 0.06, 1.05, 0.02, { bevel: 0.01 });
    b.box(S_GLASS, -L, 1.30, 0, 0.02, 1.05, D - 0.06, { bevel: 0.01 });
    b.box(S_DARK, 0, 0.22, -D, L, 0.22, 0.05, { bevel: 0.02 });
    // Bench and timetable.
    for (let i = 0; i < 3; i++) b.box(S_WOOD, 0, 0.52, -D + 0.14 + i * 0.15, L - 0.22, 0.03, 0.06, { bevel: 0.012 });
    for (const sx of [-1, 1]) b.box(S_DARK, sx * (L - 0.30), 0.26, -D + 0.28, 0.04, 0.26, 0.16, { bevel: 0.02 });
    b.box(S_GALV, L - 0.02, 1.45, 0, 0.03, 0.42, 0.30, { bevel: 0.02 });
    b.emit(surf("signFace"), uvQuad(0.26, 0.38, 0, 0.5, 0.5, 1), xf(L + 0.02, 1.45, 0, Math.PI / 2, 0, 0));
    b.solid(0, 1.20, -D, L + 0.1, 1.20, 0.12, { harvest: "metal", material: "metal" });
    b.solid(-L, 1.20, 0, 0.10, 1.20, D, { harvest: "metal", material: "metal" });
    b.solid(0, 2.50, 0, L + 0.18, 0.14, 0.90, { harvest: "metal", material: "metal" });
  },
};

/** 2.4 m of wood picket fence, run end-to-end along X. */
const DEF_PICKET: PropDef = {
  key: "st.picket",
  harvest: "wood",
  clear: 1.3,
  region: "cell",
  shadow: "near",
  build(b) {
    for (const sx of [-1, 1]) {
      b.box(S_LOG, sx * 1.18, 0.60, 0, 0.075, 0.60, 0.075, { bevel: 0.02 });
      b.box(S_LOG, sx * 1.18, 1.235, 0, 0.09, 0.045, 0.09, { bevel: 0.03 });
    }
    for (const y of [0.38, 0.88]) b.box(S_WOOD, 0, y, 0, 1.18, 0.045, 0.028, { bevel: 0.012 });
    for (let i = 0; i < 9; i++) {
      const x = -1.06 + i * 0.265;
      b.box(S_WOOD, x, 0.56, 0, 0.055, 0.56, 0.020, { bevel: 0.012 });
      // Pointed cap: a small pyramid, four triangles, and it is the entire
      // reason the fence reads as a picket fence from 40 m.
      const g = new Geo();
      const w = 0.055, t = 0.020, h = 0.09, y0 = 1.12;
      for (let k = 0; k < 4; k++) {
        const c: Array<[number, number]> = [[-w, -t], [w, -t], [w, t], [-w, t]];
        const a = c[k], d = c[(k + 1) % 4];
        g.tri(a[0], y0, a[1], d[0], y0, d[1], 0, y0 + h, 0, 0, 0.4, 0);
      }
      b.emit(S_WOOD, g, xf(x, 0, 0));
    }
    b.solid(0, 0.60, 0, 1.22, 0.60, 0.08, { harvest: "wood", material: "wood" });
  },
};

/** 3 m of chain-link on galvanised posts. Cutout mesh, so you shoot through it. */
const DEF_CHAINLINK: PropDef = {
  key: "st.chainlink",
  harvest: "metal",
  clear: 1.6,
  shadow: "near",
  build(b) {
    for (const sx of [-1, 1]) {
      b.cyl(S_GALV, sx * 1.48, 1.02, 0, 0.05, 0.046, 2.04, { seg: 8 });
      b.cyl(S_GALV, sx * 1.48, 2.06, 0, 0.055, 0.03, 0.06, { seg: 8 });
    }
    b.cyl(S_GALV, 0, 1.98, 0, 0.032, 0.032, 2.96, { roll: Math.PI / 2, seg: 6 });
    b.cyl(S_GALV, 0, 0.10, 0, 0.026, 0.026, 2.96, { roll: Math.PI / 2, seg: 6 });
    // 3 m × 1.9 m of mesh at 0.5 m per texture repeat.
    b.emit(surf("chainLink"), uvQuad(1.48, 0.95, 0, 0, 6, 3.8), xf(0, 1.05, 0));
    if (b.tier.trim) {
      // Barbed-wire outriggers. Pure silhouette, and they say "compound".
      for (const sx of [-1, 1]) {
        strut(b, S_GALV, sx * 1.48, 2.04, 0, sx * 1.48, 2.32, -0.18, 0.018);
        for (let i = 0; i < 3; i++) {
          b.cyl(S_GALV, 0, 2.12 + i * 0.09, -0.06 - i * 0.055, 0.012, 0.012, 2.96, { roll: Math.PI / 2, seg: 4 });
        }
      }
    }
    b.solid(0, 1.02, 0, 1.52, 1.02, 0.08, { harvest: "metal", material: "metal" });
  },
};

/** A high-voltage lattice pylon. 24 m, and the tallest thing in the wilds. */
const DEF_PYLON: PropDef = {
  key: "st.pylon",
  harvest: "metal",
  clear: 6,
  skirt: [3.0, 3.0],
  shadow: "always",
  build(b) {
    const H = 24, base = 2.9, top = 0.85;
    const legAt = (t: number) => lerp(base, top, t);
    const corner = (i: number, t: number): [number, number] => {
      const s = legAt(t);
      return [(i & 1 ? 1 : -1) * s, (i & 2 ? 1 : -1) * s];
    };
    // Legs.
    for (let i = 0; i < 4; i++) {
      const a = corner(i, 0), c = corner(i, 1);
      strut(b, S_GALV, a[0], 0, a[1], c[0], H, c[1], 0.085);
    }
    // Belt rings + X bracing per bay. Nine bays is enough that the lattice
    // reads as lattice from the ground and cheap enough to instance.
    const bays = b.tier.trim ? 9 : 5;
    // Corner bits are (x, z) sign, so the perimeter order is 0,1,3,2 — not
    // 0,1,2,3, which would draw two diagonals and no sides.
    const order = [0, 1, 3, 2];
    for (let k = 0; k <= bays; k++) {
      const t = k / bays;
      const y = t * H;
      for (let e = 0; e < 4; e++) {
        const a = corner(order[e], t), c = corner(order[(e + 1) % 4], t);
        strut(b, S_GALV, a[0], y, a[1], c[0], y, c[1], 0.05);
      }
      if (k === bays) break;
      const t1 = (k + 1) / bays, y1 = t1 * H;
      for (let e = 0; e < 4; e++) {
        const i0 = order[e], i1 = order[(e + 1) % 4];
        const a = corner(i0, t), c = corner(i1, t);
        const a1 = corner(i0, t1), c1 = corner(i1, t1);
        strut(b, S_GALV, a[0], y, a[1], c1[0], y1, c1[1], 0.038);
        strut(b, S_GALV, c[0], y, c[1], a1[0], y1, a1[1], 0.038);
      }
    }
    // Two cross-arms, each a tapered lattice cantilever with three insulators.
    for (const [armY, armL] of [[H * 0.74, 5.4], [H * 0.93, 4.0]] as Array<[number, number]>) {
      for (const sx of [-1, 1]) {
        strut(b, S_GALV, 0, armY, 0, sx * armL, armY, 0, 0.06);
        strut(b, S_GALV, 0, armY + 1.5, 0, sx * armL, armY + 0.1, 0, 0.045);
        for (let i = 1; i <= 3; i++) {
          const x = sx * armL * (i / 3.2);
          strut(b, S_GALV, x, armY, 0, x * 0.72, armY + 1.5 * (1 - i / 4.4), 0, 0.03);
        }
        // Insulator string: five glass discs on a stem.
        for (let i = 0; i < 5; i++) {
          b.cyl(S_GLASS, sx * armL * 0.92, armY - 0.20 - i * 0.16, 0, 0.10, 0.10, 0.05, { seg: 8 });
        }
        b.cyl(S_DARK, sx * armL * 0.92, armY - 0.52, 0, 0.026, 0.026, 0.90, { seg: 6 });
      }
    }
    b.cyl(S_GALV, 0, H + 0.9, 0, 0.05, 0.02, 1.8, { seg: 6 });
    b.solid(0, 3.0, 0, base + 0.3, 3.0, base + 0.3, { harvest: "metal", material: "metal" });
  },
};

/** A stilted water tower. Every rural district gets one; they are landmarks. */
const DEF_WATERTOWER: PropDef = {
  key: "st.watertower",
  harvest: "metal",
  clear: 7,
  shadow: "always",
  build(b) {
    const H = 12.5, spread = 3.4, R = 3.1;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      const x0 = Math.cos(a) * spread, z0 = Math.sin(a) * spread;
      const x1 = Math.cos(a) * (R * 0.78), z1 = Math.sin(a) * (R * 0.78);
      strut(b, S_GALV, x0, 0, z0, x1, H, z1, 0.11);
      b.box(S_CONCRETE, x0, 0.20, z0, 0.42, 0.20, 0.42, { bevel: 0.04 });
    }
    for (let k = 1; k <= 3; k++) {
      const t = k / 4, y = t * H;
      for (let i = 0; i < 4; i++) {
        const a0 = (i / 4) * TAU + Math.PI / 4, a1 = ((i + 1) / 4) * TAU + Math.PI / 4;
        const r0 = lerp(spread, R * 0.78, t);
        const r1 = lerp(spread, R * 0.78, (k + 1) / 4);
        const y1 = ((k + 1) / 4) * H;
        strut(b, S_GALV, Math.cos(a0) * r0, y, Math.sin(a0) * r0, Math.cos(a1) * r0, y, Math.sin(a1) * r0, 0.05);
        if (k < 3) {
          strut(b, S_GALV, Math.cos(a0) * r0, y, Math.sin(a0) * r0, Math.cos(a1) * r1, y1, Math.sin(a1) * r1, 0.035);
          strut(b, S_GALV, Math.cos(a1) * r0, y, Math.sin(a1) * r0, Math.cos(a0) * r1, y1, Math.sin(a0) * r1, 0.035);
        }
      }
    }
    // Tank: a conical bottom, a ribbed barrel and a shallow cone roof.
    b.cyl(S_CORR, 0, H + 0.55, 0, 0.6, R, 1.1, { seg: b.tier.round + 4, tint: "body" });
    b.cyl(S_CORR, 0, H + 2.9, 0, R, R, 3.6, { seg: b.tier.round + 4, tint: "body", capBottom: false });
    for (let i = 0; i < 3; i++) b.torus(S_GALV, 0, H + 1.4 + i * 1.4, 0, R + 0.02, 0.05, { major: b.tier.round + 4, minor: 5 });
    b.cyl(S_CORR, 0, H + 5.1, 0, R + 0.15, 0.35, 0.8, { seg: b.tier.round + 4, tint: "body" });
    b.cyl(S_GALV, 0, H + 5.6, 0, 0.30, 0.24, 0.4, { seg: 8 });
    // Catwalk + handrail round the barrel, and the ladder up to it.
    b.cyl(S_GALV, 0, H + 1.05, 0, R + 0.55, R + 0.55, 0.05, { seg: b.tier.round + 6, capBottom: true });
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU;
      b.box(S_GALV, Math.cos(a) * (R + 0.5), H + 1.5, Math.sin(a) * (R + 0.5), 0.022, 0.42, 0.022, { bevel: 0 });
    }
    b.torus(S_GALV, 0, H + 1.92, 0, R + 0.5, 0.028, { major: b.tier.round + 6, minor: 4 });
    for (let i = 0; i < Math.round(H / 0.34); i++) {
      b.box(S_GALV, 0, 0.5 + i * 0.34, spread * 0.72, 0.20, 0.018, 0.018, { bevel: 0 });
    }
    for (const sx of [-1, 1]) b.cyl(S_GALV, sx * 0.20, H * 0.5 + 0.25, spread * 0.72, 0.022, 0.022, H - 0.5, { seg: 5 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      b.solid(Math.cos(a) * spread * 0.6, 2.2, Math.sin(a) * spread * 0.6, 0.30, 2.2, 0.30, { harvest: "metal", material: "metal" });
    }
    b.solid(0, H + 2.9, 0, R, 3.0, R, { harvest: "metal", material: "metal" });
  },
};

/* ------------------------------------------------------------------------ *
 * Industrial
 * ------------------------------------------------------------------------ */

/**
 * A 20-foot shipping container. Length runs along X so a stacked row reads as
 * a wall. Corrugated skin, real corner castings, a proper door end with four
 * locking bars — and, at `high` and above, a grime band along the bottom rail
 * where every container on earth is filthy.
 */
const DEF_CONTAINER: PropDef = {
  key: "ind.container",
  harvest: "metal",
  clear: 4.2,
  skirt: [3.06, 1.24],
  shadow: "always",
  build(b) {
    const L = 3.03, W = 1.22, H = 1.30;
    b.box(S_CORR, 0, H, 0, L - 0.06, H - 0.08, W - 0.05, { bevel: 0.05, tint: "body" });
    // Top and bottom rails, in a colour that never matches the paint — every
    // container in the world has bare or differently-painted structure.
    for (const sy of [-1, 1]) {
      b.box(S_DARK, 0, H + sy * (H - 0.06), 0, L, 0.075, W, { bevel: 0.03 });
    }
    for (const sx of [-1, 1]) b.box(S_DARK, sx * L, H, 0, 0.055, H - 0.02, W, { bevel: 0.03, tint: "body" });
    // Corner castings. Eight little dark blocks, and they are the single most
    // recognisable detail on the object.
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      b.box(S_DARK, sx * (L - 0.09), H + sy * (H - 0.09), sz * (W - 0.09), 0.11, 0.10, 0.11, { bevel: 0.02 });
    }
    // Vertical corrugation ribs, plus the roof's transverse ones.
    const ribs = b.tier.trim ? 13 : 7;
    for (let i = 0; i < ribs; i++) {
      const x = -L + 0.22 + (i * (2 * L - 0.44)) / (ribs - 1);
      for (const sz of [-1, 1]) b.box(S_CORR, x, H, sz * (W + 0.015), 0.05, H - 0.14, 0.03, { bevel: 0.012, tint: "body" });
    }
    // Door end: two leaves, locking bars, hinges, handles, a placard.
    b.box(S_CORR, -L - 0.03, H, 0, 0.03, H - 0.10, W - 0.08, { bevel: 0.02, tint: "body" });
    for (let i = 0; i < 4; i++) {
      const z = -0.78 + i * 0.52;
      b.cyl(S_DARK, -L - 0.07, H, z, 0.035, 0.035, H * 1.8, { seg: 6 });
      b.box(S_DARK, -L - 0.09, H + 0.10, z, 0.045, 0.075, 0.075, { bevel: 0.02 });
    }
    b.box(surf("plaster", 0xe8e2d4), -L - 0.06, H + 0.45, 0.55, 0.015, 0.16, 0.24, { bevel: 0 });
    if (b.tier.trim) {
      // The grime band. Dirt, not paint — it has to survive the body tint.
      for (const sz of [-1, 1]) b.box(S_DIRT, 0, 0.22, sz * (W + 0.02), L - 0.12, 0.18, 0.012, { bevel: 0 });
    }
    b.solid(0, H, 0, L + 0.06, H, W + 0.04, { harvest: "metal", material: "metal" });
  },
};

const DEF_PALLET: PropDef = {
  key: "ind.pallet",
  harvest: "wood",
  clear: 0.9,
  shadow: "near",
  build(b) {
    for (const z of [-0.5, 0, 0.5]) b.box(S_WOOD, 0, 0.055, z, 0.60, 0.055, 0.07, { bevel: 0.012 });
    for (const z of [-0.5, 0, 0.5]) b.box(S_WOOD, 0, 0.012, z, 0.60, 0.012, 0.09, { bevel: 0.008 });
    for (let i = 0; i < 5; i++) {
      b.box(S_WOOD, 0, 0.122, -0.55 + i * 0.275, 0.60, 0.012, 0.075, { bevel: 0.008 });
    }
    if (b.tier.trim) {
      for (let i = 0; i < 5; i++) for (const sx of [-1, 0, 1]) {
        b.box(S_CHROME, sx * 0.52, 0.135, -0.55 + i * 0.275, 0.012, 0.004, 0.012, { bevel: 0 });
      }
    }
    b.solid(0, 0.07, 0, 0.60, 0.07, 0.60, { harvest: "wood", material: "wood" });
  },
};

const DEF_DRUM: PropDef = {
  key: "ind.drum",
  harvest: "metal",
  clear: 0.7,
  skirt: [0.30, 0.30],
  shadow: "near",
  build(b) {
    const s = surf("metalPanel", 0xffffff);
    b.cyl(s, 0, 0.44, 0, 0.29, 0.29, 0.86, { seg: b.tier.round, tint: "body", capBottom: true });
    // Rolling hoops: the two ribs a drum is rolled on. Also, structurally, the
    // thing that stops it reading as a soup can.
    for (const y of [0.30, 0.58]) b.torus(s, 0, y, 0, 0.295, 0.032, { major: b.tier.round, minor: 5, tint: "body" });
    for (const y of [0.03, 0.85]) b.torus(S_DARK, 0, y, 0, 0.285, 0.035, { major: b.tier.round, minor: 5 });
    b.cyl(S_DARK, 0, 0.885, 0, 0.27, 0.27, 0.03, { seg: b.tier.round });
    b.cyl(S_CHROME, 0.15, 0.905, 0, 0.045, 0.042, 0.03, { seg: 6 });
    b.solid(0, 0.44, 0, 0.30, 0.44, 0.30, { harvest: "metal", material: "metal" });
  },
};

const DEF_CRATE: PropDef = {
  key: "ind.crate",
  harvest: "wood",
  clear: 0.9,
  skirt: [0.56, 0.56],
  shadow: "near",
  build(b) {
    const h = 0.55;
    b.box(S_WOOD, 0, h, 0, h, h, h, { bevel: b.bevel, tint: "body" });
    // Corner battens and diagonal cross-braces on every face. A plain wooden
    // cube is the most obviously procedural object it is possible to place.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      b.box(S_LOG, sx * h, h, sz * h, 0.045, h, 0.045, { bevel: 0.015 });
    }
    for (const sy of [-1, 1]) for (const sx of [-1, 1]) {
      b.box(S_LOG, sx * h, h + sy * h, 0, 0.045, 0.045, h, { bevel: 0.015 });
      b.box(S_LOG, 0, h + sy * h, sx * h, h, 0.045, 0.045, { bevel: 0.015 });
    }
    if (b.tier.trim) {
      for (const sz of [-1, 1]) {
        strut(b, S_LOG, -h * 0.85, h - h * 0.85, sz * (h + 0.01), h * 0.85, h + h * 0.85, sz * (h + 0.01), 0.032);
      }
      for (const sx of [-1, 1]) {
        strut(b, S_LOG, sx * (h + 0.01), h - h * 0.85, -h * 0.85, sx * (h + 0.01), h + h * 0.85, h * 0.85, 0.032);
      }
    }
    b.solid(0, h, 0, h + 0.05, h, h + 0.05, { harvest: "wood", material: "wood" });
  },
};

/** A three-lift scaffold bay. Boards on top, so you can actually stand on it. */
const DEF_SCAFFOLD: PropDef = {
  key: "ind.scaffold",
  harvest: "metal",
  clear: 2.6,
  skirt: [1.06, 0.72],
  shadow: "always",
  build(b) {
    const W = 1.0, D = 0.65, LIFT = 2.0, lifts = 3;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      b.cyl(S_GALV, sx * W, (LIFT * lifts) / 2, sz * D, 0.045, 0.045, LIFT * lifts + 0.2, { seg: 7 });
      b.box(S_CONCRETE, sx * W, 0.04, sz * D, 0.14, 0.04, 0.14, { bevel: 0.02 });
    }
    for (let k = 1; k <= lifts; k++) {
      const y = k * LIFT;
      for (const sz of [-1, 1]) {
        b.cyl(S_GALV, 0, y, sz * D, 0.038, 0.038, W * 2, { roll: Math.PI / 2, seg: 6 });
        b.cyl(S_GALV, 0, y - 0.5, sz * D, 0.032, 0.032, W * 2, { roll: Math.PI / 2, seg: 6 });
      }
      for (const sx of [-1, 1]) b.cyl(S_GALV, sx * W, y, 0, 0.038, 0.038, D * 2, { pitch: Math.PI / 2, seg: 6 });
      // Boards, and the couplers that hold everything together.
      for (let i = 0; i < 3; i++) {
        b.box(S_WOOD, 0, y + 0.07, -D + 0.22 + i * 0.42, W - 0.02, 0.022, 0.20, { bevel: 0.01 });
      }
      if (b.tier.trim) {
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          b.cyl(S_DARK, sx * W, y, sz * D, 0.062, 0.062, 0.11, { seg: 6 });
        }
      }
    }
    for (const sz of [-1, 1]) {
      strut(b, S_GALV, -W, 0.1, sz * D, W, LIFT * 2, sz * D, 0.03);
      strut(b, S_GALV, W, LIFT, sz * D, -W, LIFT * lifts, sz * D, 0.03);
    }
    b.solid(0, LIFT * lifts * 0.5, 0, W + 0.1, LIFT * lifts * 0.5, D + 0.1, { harvest: "metal", material: "metal" });
  },
};

/** A trestle of large-bore pipes. Cover, and the pickaxe loves it. */
const DEF_PIPES: PropDef = {
  key: "ind.pipes",
  harvest: "metal",
  clear: 2.2,
  skirt: [1.1, 1.7],
  shadow: "near",
  build(b) {
    for (const sz of [-1, 1]) {
      b.box(S_LOG, 0, 0.12, sz * 1.5, 1.1, 0.12, 0.12, { bevel: 0.02 });
      for (const sx of [-1, 1]) b.box(S_LOG, sx * 1.05, 0.45, sz * 1.5, 0.08, 0.45, 0.10, { bevel: 0.02 });
    }
    const lay = (y: number, xs: number[]) => {
      for (const x of xs) {
        b.cyl(S_RUST, x, y, 0, 0.30, 0.30, 3.4, { pitch: Math.PI / 2, seg: b.tier.round, capBottom: true });
        // Flanges at both ends: bolt circles are what make a pipe read as
        // plant rather than as a tube.
        for (const sz of [-1, 1]) b.torus(S_DARK, x, y, sz * 1.7, 0.32, 0.055, { pitch: Math.PI / 2, major: b.tier.round, minor: 5 });
      }
    };
    lay(0.55, [-0.66, 0, 0.66]);
    lay(1.15, [-0.33, 0.33]);
    b.solid(0, 0.72, 0, 1.05, 0.72, 1.72, { harvest: "metal", material: "metal" });
  },
};

/** A stack of six tyres. Ubiquitous at yards and harbours, three surfaces. */
const DEF_TYRESTACK: PropDef = {
  key: "ind.tyres",
  harvest: "metal",
  clear: 0.8,
  skirt: [0.46, 0.46],
  shadow: "near",
  build(b) {
    for (let i = 0; i < 5; i++) {
      const a = i * 0.7;
      b.torus(S_TYRE, Math.cos(a) * 0.03, 0.14 + i * 0.20, Math.sin(a) * 0.03, 0.34, 0.13, {
        major: b.tier.round, minor: b.tier.tyreSeg, flat: true, yaw: a,
      });
    }
    b.solid(0, 0.55, 0, 0.48, 0.55, 0.48, { harvest: "metal", material: "metal" });
  },
};

/* ------------------------------------------------------------------------ *
 * Boats
 * ------------------------------------------------------------------------ */

/** A clinker rowing boat. Hull lofted, thwarts across, oars shipped inside. */
const DEF_ROWBOAT: PropDef = {
  key: "sea.rowboat",
  harvest: "wood",
  clear: 2.4,
  shadow: "always",
  build(b) {
    const hull: Station[] = [
      { z: -1.85, hw: 0.24, yb: 0.24, yt: 0.62, r: 0.14 },
      { z: -1.10, hw: 0.62, yb: 0.10, yt: 0.58, r: 0.20 },
      { z: 0.00, hw: 0.76, yb: 0.04, yt: 0.56, r: 0.24 },
      { z: 1.10, hw: 0.66, yb: 0.10, yt: 0.58, r: 0.20 },
      { z: 2.00, hw: 0.20, yb: 0.26, yt: 0.66, r: 0.12 },
    ];
    b.loft(surf("woodPlank", 0xffffff), hull, undefined, "body", 3);
    // Cockpit: a recess in the deck, plus a gunwale rail round the opening.
    b.box(surf("woodPlank", 0x6b563c), 0, 0.53, 0.05, 0.52, 0.06, 1.35, { bevel: 0.03 });
    const rail: Station[] = hull.map((s) => ({ z: s.z, hw: s.hw + 0.02, yb: s.yt - 0.05, yt: s.yt + 0.03, r: 0.03 }));
    b.loft(surf("woodPlank", 0x8a6a44), rail, undefined, "none", 2);
    for (const z of [-0.55, 0.35]) b.box(S_WOOD, 0, 0.56, z, 0.58, 0.026, 0.12, { bevel: 0.012 });
    if (b.tier.trim) {
      // Oars, shipped diagonally, and a coil of rope at the bow.
      for (const sx of [-1, 1]) {
        b.cyl(S_LOG, sx * 0.25, 0.62, -0.20, 0.030, 0.026, 2.30, { pitch: Math.PI / 2, yaw: sx * 0.13, seg: 6 });
        b.box(S_WOOD, sx * 0.40, 0.62, -1.30, 0.055, 0.014, 0.28, { bevel: 0.01, yaw: sx * 0.13 });
      }
      for (let i = 0; i < 3; i++) b.torus(surf("fabric", 0xc8b48c), 0, 0.60 + i * 0.035, 1.35, 0.12, 0.025, { major: 8, minor: 4 });
    }
    b.solid(0, 0.35, 0, 0.78, 0.35, 1.95, { harvest: "wood", material: "wood" });
  },
};

/** A small trawler: wheelhouse aft, mast forward, tyre fenders over the side. */
const DEF_TRAWLER: PropDef = {
  key: "sea.trawler",
  harvest: "wood",
  clear: 5.5,
  shadow: "always",
  build(b) {
    const hull: Station[] = [
      { z: -3.60, hw: 0.85, yb: -0.55, yt: 1.20, r: 0.26 },
      { z: -2.40, hw: 1.30, yb: -0.80, yt: 1.16, r: 0.32 },
      { z: 0.00, hw: 1.45, yb: -0.90, yt: 1.10, r: 0.36 },
      { z: 2.30, hw: 1.24, yb: -0.75, yt: 1.20, r: 0.32 },
      { z: 3.90, hw: 0.62, yb: -0.42, yt: 1.44, r: 0.22 },
      { z: 4.35, hw: 0.22, yb: -0.20, yt: 1.52, r: 0.12 },
    ];
    b.loft(surf("woodPlank", 0xffffff), hull, undefined, "body", 4);
    // A boot-top stripe at the waterline. One 12 cm band, and the hull stops
    // reading as a single slab of colour.
    const boot: Station[] = hull.map((s) => ({ z: s.z, hw: s.hw + 0.02, yb: -0.06, yt: 0.06, r: 0.04 }));
    b.loft(surf("metalPanel", 0x2a3a46), boot, undefined, "none", 3);
    const rail: Station[] = hull.map((s) => ({ z: s.z, hw: s.hw + 0.03, yb: s.yt - 0.08, yt: s.yt + 0.05, r: 0.05 }));
    b.loft(surf("woodPlank", 0x8a6a44), rail, undefined, "none", 3);
    // Deck, wheelhouse, funnel.
    b.box(surf("woodPlank", 0x9a7a52), 0, 1.06, 0, 1.32, 0.06, 3.30, { bevel: 0.02 });
    b.box(surf("metalPanel", 0xefeade), 0, 1.85, -1.95, 1.05, 0.80, 0.95, { bevel: 0.06, tint: "accent" });
    b.box(S_GLASS, 0, 2.05, -1.02, 0.86, 0.34, 0.05, { bevel: 0.02 });
    for (const sx of [-1, 1]) b.box(S_GLASS, sx * 1.07, 2.05, -1.95, 0.04, 0.30, 0.60, { bevel: 0.02 });
    b.box(surf("metalPanel", 0xefeade), 0, 2.70, -1.95, 1.12, 0.06, 1.02, { bevel: 0.04, tint: "accent" });
    b.cyl(S_DARK, 0, 3.00, -2.55, 0.16, 0.15, 0.60, { seg: 8 });
    // Mast, boom and stays.
    b.cyl(S_LOG, 0, 3.20, 0.60, 0.10, 0.07, 4.20, { seg: 8 });
    b.cyl(S_LOG, 0, 4.55, 1.35, 0.055, 0.045, 1.70, { pitch: Math.PI / 2 + 0.30, seg: 6 });
    if (b.tier.trim) {
      strut(b, S_GALV, 0, 5.20, 0.60, 0, 1.15, 3.60, 0.014);
      strut(b, S_GALV, 0, 5.20, 0.60, 0, 1.15, -2.60, 0.014);
      // Fenders over the side. Every working boat has them and they are the
      // detail that says "this thing gets used".
      for (const sx of [-1, 1]) for (const z of [-0.9, 0.4, 1.7]) {
        b.torus(S_TYRE, sx * 1.5, 0.62, z, 0.24, 0.09, { roll: Math.PI / 2, major: 9, minor: 5, flat: true });
      }
      for (let i = 0; i < 4; i++) {
        b.box(S_GALV, 0, 1.30, 2.30 + i * 0.02, 0.9 - i * 0.1, 0.35, 0.02, { bevel: 0 });
      }
    }
    b.solid(0, 1.20, 0, 1.45, 1.20, 4.10, { harvest: "wood", material: "wood" });
    b.solid(0, 1.90, -1.95, 1.08, 0.85, 1.0, { harvest: "wood", material: "wood" });
  },
};

/** A timber mooring post — dolphins, jetty heads, the harbour edge. */
const DEF_BOLLARD: PropDef = {
  key: "sea.bollard",
  harvest: "wood",
  clear: 0.6,
  shadow: "near",
  build(b) {
    b.cyl(S_LOG, 0, 0.55, 0, 0.19, 0.17, 1.10, { seg: 9 });
    b.cyl(S_LOG, 0, 1.14, 0, 0.22, 0.16, 0.10, { seg: 9 });
    b.torus(surf("metalPanel", 0x4a4038), 0, 0.92, 0, 0.185, 0.022, { major: 9, minor: 4 });
    if (b.tier.trim) {
      for (let i = 0; i < 3; i++) b.torus(surf("fabric", 0xbca88a), 0, 0.62 + i * 0.05, 0, 0.23, 0.028, { major: 10, minor: 4 });
    }
    b.solid(0, 0.55, 0, 0.20, 0.55, 0.20, { harvest: "wood", material: "wood" });
  },
};

/* ------------------------------------------------------------------------ *
 * Rocks
 *
 * Four prototypes, each a differently-seeded and differently-lumpy icosphere,
 * scattered with per-instance scale, yaw and a tint that runs from cold grey
 * through to a warm iron brown. Four is the number where the eye stops seeing
 * repeats once rotation and non-uniform scale are in play; two is not enough
 * and eight is triangles nobody notices.
 * ------------------------------------------------------------------------ */

function rockDef(key: string, seed: number, lumps: number, squat: number, big: boolean): PropDef {
  return {
    key,
    harvest: "stone",
    clear: 1.0,
    shadow: "near",
    // The one family on the island that genuinely has to be partitioned:
    // thousands of instances spread over 9 km², and by some distance the
    // largest single block of triangles this module puts in the scene.
    region: "cell",
    build(b) {
      // Small stones take one subdivision (80 triangles) whatever the tier —
      // at the size they are placed, the second subdivision is invisible and
      // there are twenty times as many of them.
      const g = boulder(1, big ? b.tier.rockSubdiv : Math.min(1, b.tier.rockSubdiv), seed, lumps);
      // Squat rides on the prototype rather than on the instance matrix so
      // instances keep a uniform scale and their colliders stay honest.
      b.emit(S_ROCK, g, new THREE.Matrix4().makeScale(1, squat, 1), "body");
    },
  };
}

/** Debris: ankle to knee height, everywhere. */
const DEF_ROCKS: PropDef[] = [
  rockDef("rock.a", 0x51a3, 0.30, 0.86, false),
  rockDef("rock.b", 0x9d4c, 0.40, 0.66, false),
];
/** Outcrops: the ones you take cover behind, and the ones worth the triangles. */
const DEF_BOULDERS: PropDef[] = [
  rockDef("rock.c", 0x2f71, 0.26, 1.02, true),
  rockDef("rock.d", 0xc0de, 0.46, 0.78, true),
];

/** Boulder tints. Cold granite through to iron-stained sandstone. */
const ROCK_TINTS = [0xa8a49c, 0x9a978f, 0xb2ada2, 0x8e8a82, 0xa8977f, 0x94897a, 0xb8b4a8];

/* ------------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------------ */

/** Rejection sampling with a spacing constraint. A uniform scatter clumps —
 *  Poisson-ish spacing is what makes a field of boulders read as authored. */
class Spacing {
  private cells = new Map<number, number[]>();

  constructor(private readonly cell: number) {}

  private key(cx: number, cz: number): number {
    return ((cx & 0xffff) << 16) | (cz & 0xffff);
  }

  free(x: number, z: number, r: number): boolean {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    const span = Math.ceil(r / this.cell);
    const r2 = r * r;
    for (let i = -span; i <= span; i++) {
      for (let j = -span; j <= span; j++) {
        const list = this.cells.get(this.key(cx + i, cz + j));
        if (!list) continue;
        for (let k = 0; k < list.length; k += 2) {
          const dx = list[k] - x, dz = list[k + 1] - z;
          if (dx * dx + dz * dz < r2) return false;
        }
      }
    }
    return true;
  }

  add(x: number, z: number): void {
    const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    const list = this.cells.get(k);
    if (list) list.push(x, z);
    else this.cells.set(k, [x, z]);
  }
}

interface PlaceOpts {
  yaw?: number;
  /** Small tips off vertical. Boulders and wrecks; never a parked car. */
  pitch?: number;
  roll?: number;
  body?: number;
  accent?: number;
  /** Uniform scale. Colliders are derived from the transformed corners, so a
   *  scaled instance still gets an honest box. */
  scale?: number;
  /** Sink the prop into the ground. Boulders want this; a car does not. */
  sink?: number;
  /** Minimum distance to any other prop placed through the same placer. */
  spacing?: number;
  maxSlope?: number;
  /** Allow placement over water — boats, jetty furniture. */
  water?: boolean;
  /** Skip the collision clearance test (fence runs, container stacks). */
  crowd?: boolean;
  /** Explicit Y. Used when the caller already knows the surface. */
  y?: number;
}

const _qv = new THREE.Vector3();

class Placer {
  readonly spacing = new Spacing(6);
  rejected = 0;

  constructor(
    private readonly depot: Depot,
    private readonly terrain: TerrainLike | undefined,
    private readonly collision: CollisionService | undefined,
    private readonly regionOf: (x: number, z: number) => string,
  ) {}

  groundAt(x: number, z: number): number {
    return this.terrain ? this.terrain.heightAt(x, z) : 0;
  }

  /** Attempt one placement. Returns the resolved Y, or null if rejected. */
  try(def: PropDef, x: number, z: number, o: PlaceOpts = {}): number | null {
    const t = this.terrain;
    if (t) {
      if (!o.water && t.isWater(x, z)) { this.rejected++; return null; }
      const slope = t.slopeAt ? t.slopeAt(x, z) : 0;
      if (slope > (o.maxSlope ?? MAX_SLOPE)) { this.rejected++; return null; }
    }
    const spacing = o.spacing ?? def.clear;
    if (spacing > 0 && !this.spacing.free(x, z, spacing)) { this.rejected++; return null; }

    const y = o.y ?? this.groundAt(x, z) - (o.sink ?? 0);
    const scale = o.scale ?? 1;

    if (!o.crowd && this.collision) {
      // The clearance test. `pois` boots before us, so every wall, pier and
      // silo on the island is already in the broadphase — this is what keeps
      // a parked car out of a shopfront without either module knowing about
      // the other.
      _qv.set(x, y + 1.0, z);
      if (this.collision.query(_qv, def.clear * scale * 0.55).length > 0) { this.rejected++; return null; }
    }

    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(o.pitch ?? 0, o.yaw ?? 0, o.roll ?? 0, "YXZ")),
      new THREE.Vector3(scale, scale, scale),
    );
    const region = def.region === "cell" ? this.regionOf(x, z) : "global";
    this.depot.place(def, region, m, o.body, o.accent);
    if (def.skirt) {
      // Skirts go into the region's shared static bucket. They are flat, they
      // never cast, and they are the cheapest possible answer to the "prop
      // pasted onto terrain" tell.
      this.depot.static(
        this.regionOf(x, z), S_DIRT,
        groundSkirt(def.skirt[0] * scale, def.skirt[1] * scale, 0.16 + def.clear * 0.08),
        m, "never",
      );
    }
    if (spacing > 0) this.spacing.add(x, z);
    return y;
  }
}

function weighted<T>(table: ReadonlyArray<readonly [T, number]>, rng: () => number): T {
  let total = 0;
  for (const [, w] of table) total += w;
  let r = rng() * total;
  for (const [v, w] of table) {
    r -= w;
    if (r <= 0) return v;
  }
  return table[table.length - 1][0];
}

/* ---------------------------------------------------------- district table */

type DistrictKind = "urban" | "industrial" | "harbor" | "rural" | "suburb" | "ruin" | "tech" | "camp" | "coastal";

interface KindSpec {
  /** General outskirts clutter, weighted. */
  clutter: ReadonlyArray<readonly [PropDef, number]>;
  vehicles: ReadonlyArray<readonly [PropDef, number]>;
  /** Vehicles per 100 m of district radius. */
  cars: number;
  /** Lamp posts round the ring. */
  lamps: number;
  fence: "picket" | "chain" | "none";
  /** Container stacks; each is a row of 3–5 with a second tier. */
  stacks: number;
  boats: number;
  tower: boolean;
  /** Clutter items per 100 m of radius. */
  clutterRate: number;
  paint: readonly number[];
}

const KINDS: Record<DistrictKind, KindSpec> = {
  urban: {
    clutter: [[DEF_BIN, 4], [DEF_HYDRANT, 2], [DEF_BENCH, 3], [DEF_CONE, 3], [DEF_SIGN, 2], [DEF_SHELTER, 1], [DEF_CRATE, 1], [DEF_PALLET, 1]],
    vehicles: [[DEF_SEDAN, 5], [DEF_HATCH, 4], [DEF_VAN, 2], [DEF_BUS, 1], [DEF_PICKUP, 2], [DEF_WRECK, 1]],
    cars: 7, lamps: 16, fence: "none", stacks: 0, boats: 0, tower: false, clutterRate: 13, paint: CAR_PAINT,
  },
  industrial: {
    clutter: [[DEF_DRUM, 5], [DEF_PALLET, 4], [DEF_CRATE, 3], [DEF_TYRESTACK, 2], [DEF_PIPES, 2], [DEF_SCAFFOLD, 1], [DEF_CONE, 3], [DEF_BIN, 1]],
    vehicles: [[DEF_PICKUP, 4], [DEF_VAN, 3], [DEF_WRECK, 3], [DEF_SEDAN, 2], [DEF_TRACTOR, 1]],
    cars: 5, lamps: 9, fence: "chain", stacks: 4, boats: 0, tower: true, clutterRate: 17, paint: WORK_PAINT,
  },
  harbor: {
    clutter: [[DEF_BOLLARD, 5], [DEF_CRATE, 4], [DEF_DRUM, 3], [DEF_PALLET, 3], [DEF_TYRESTACK, 3], [DEF_BENCH, 1], [DEF_BIN, 1]],
    vehicles: [[DEF_PICKUP, 4], [DEF_VAN, 2], [DEF_SEDAN, 2], [DEF_WRECK, 2], [DEF_TRACTOR, 1]],
    cars: 4, lamps: 11, fence: "chain", stacks: 2, boats: 7, tower: false, clutterRate: 16, paint: WORK_PAINT,
  },
  rural: {
    clutter: [[DEF_CRATE, 3], [DEF_DRUM, 2], [DEF_PALLET, 2], [DEF_PICKET, 3], [DEF_TYRESTACK, 1], [DEF_SIGN_WARN, 1]],
    vehicles: [[DEF_TRACTOR, 4], [DEF_PICKUP, 4], [DEF_WRECK, 2], [DEF_SEDAN, 1]],
    cars: 3, lamps: 4, fence: "picket", stacks: 0, boats: 0, tower: true, clutterRate: 10, paint: WORK_PAINT,
  },
  suburb: {
    clutter: [[DEF_BIN, 3], [DEF_BENCH, 2], [DEF_HYDRANT, 2], [DEF_PICKET, 2], [DEF_CONE, 1], [DEF_SIGN, 1]],
    vehicles: [[DEF_SEDAN, 5], [DEF_HATCH, 4], [DEF_PICKUP, 2], [DEF_VAN, 1]],
    cars: 5, lamps: 12, fence: "picket", stacks: 0, boats: 0, tower: false, clutterRate: 10, paint: CAR_PAINT,
  },
  ruin: {
    clutter: [[DEF_CRATE, 2], [DEF_DRUM, 2], [DEF_PALLET, 1], [DEF_SIGN_WARN, 2], [DEF_CONE, 2], [DEF_SCAFFOLD, 2]],
    vehicles: [[DEF_WRECK, 5], [DEF_PICKUP, 1]],
    cars: 3, lamps: 2, fence: "none", stacks: 1, boats: 0, tower: false, clutterRate: 9, paint: WORK_PAINT,
  },
  tech: {
    clutter: [[DEF_DRUM, 3], [DEF_CRATE, 3], [DEF_SCAFFOLD, 2], [DEF_CONE, 3], [DEF_PIPES, 2], [DEF_SIGN_WARN, 2]],
    vehicles: [[DEF_VAN, 4], [DEF_PICKUP, 3], [DEF_SEDAN, 1]],
    cars: 3, lamps: 7, fence: "chain", stacks: 2, boats: 0, tower: false, clutterRate: 12, paint: WORK_PAINT,
  },
  camp: {
    clutter: [[DEF_CRATE, 4], [DEF_DRUM, 3], [DEF_PALLET, 2], [DEF_TYRESTACK, 2], [DEF_PICKET, 2]],
    vehicles: [[DEF_PICKUP, 4], [DEF_TRACTOR, 2], [DEF_WRECK, 2]],
    cars: 3, lamps: 3, fence: "picket", stacks: 1, boats: 0, tower: false, clutterRate: 12, paint: WORK_PAINT,
  },
  coastal: {
    clutter: [[DEF_BOLLARD, 3], [DEF_CRATE, 2], [DEF_DRUM, 2], [DEF_BENCH, 2], [DEF_SIGN_WARN, 1]],
    vehicles: [[DEF_HATCH, 3], [DEF_PICKUP, 2], [DEF_WRECK, 1]],
    cars: 2, lamps: 6, fence: "none", stacks: 0, boats: 3, tower: false, clutterRate: 9, paint: CAR_PAINT,
  },
};

/** The districts `pois.ts` publishes, by name. Anything unknown falls back to
 *  a tier-appropriate kind, so a renamed district degrades instead of vanishing. */
const KIND_BY_NAME: Record<string, DistrictKind> = {
  "Neon Heights": "urban",
  "Foundry Flats": "industrial",
  "Salt Harbor": "harbor",
  "Mill Hollow": "rural",
  "Vista Villa": "suburb",
  "Broken Basilica": "ruin",
  "Signal Summit": "tech",
  "Timber Tents": "camp",
  "Stonewall Stand": "rural",
  "Lonely Lookout": "coastal",
};

/**
 * The road network, mirrored from `pois.ts` by district NAME rather than pad
 * id, because names are what the `Poi[]` service actually carries. `bow` and
 * the spline form are copied verbatim: get them wrong and the lamp posts march
 * across a field beside the road instead of along it.
 */
const ROAD_LINKS: ReadonlyArray<readonly [string, string, number, number]> = [
  ["Neon Heights", "Lonely Lookout", 90, 13],
  ["Neon Heights", "Mill Hollow", -120, 15],
  ["Neon Heights", "Foundry Flats", 150, 15],
  ["Foundry Flats", "Vista Villa", -70, 13],
  ["Foundry Flats", "Salt Harbor", 60, 13],
  ["Foundry Flats", "Signal Summit", -90, 13],
  ["Signal Summit", "Broken Basilica", 70, 11],
  ["Signal Summit", "Timber Tents", -80, 11],
  ["Broken Basilica", "Mill Hollow", 40, 11],
  ["Broken Basilica", "Stonewall Stand", -50, 9],
];

/* ------------------------------------------------------------------------ *
 * Passes
 * ------------------------------------------------------------------------ */

/** Yaw that maps the prototype's local +X onto a world XZ direction. */
const yawForX = (dx: number, dz: number) => Math.atan2(-dz, dx);
/** Yaw that maps the prototype's local +Z (vehicle forward) onto a direction. */
const yawForZ = (dx: number, dz: number) => Math.atan2(dx, dz);

interface Pass {
  depot: Depot;
  placer: Placer;
  terrain: TerrainLike | undefined;
  pois: readonly Poi[];
  tier: PropTier;
  rng: () => number;
}

/** Paint for one vehicle: a jittered palette colour, occasionally rusted out. */
function vehiclePaint(spec: KindSpec, def: PropDef, rng: () => number): number {
  if (def === DEF_WRECK) return weather(0x4d443c, rng, 1.4);
  const base = weather(pick(spec.paint, rng), rng);
  // One car in eight has been sitting out in the salt air for a decade.
  return rng() < 0.13 ? rusted(base, 0.35 + rng() * 0.3) : base;
}

function populateDistrict(w: Pass, poi: Poi, density: number): void {
  const kind = KIND_BY_NAME[poi.name] ?? (poi.tier === "landmark" ? "urban" : poi.tier === "major" ? "industrial" : "rural");
  const spec = KINDS[kind];
  const { rng, placer } = w;
  const R = poi.radius;
  const cx = poi.center.x, cz = poi.center.z;

  // --- outskirts clutter -------------------------------------------------
  // Biased to the outer half of the district: `pois.ts` fills its own cores
  // with yard dressing, and doubling up there produces interpenetration that
  // no clearance test can fully save.
  const clutterN = Math.round(spec.clutterRate * (R / 100) * density * 4);
  for (let i = 0; i < clutterN; i++) {
    const a = rng() * TAU;
    const rad = R * (0.42 + 0.66 * Math.sqrt(rng()));
    const def = weighted(spec.clutter, rng);
    const isMetal = def.harvest === "metal";
    const body = isMetal
      ? (rng() < 0.4 ? rusted(weather(pick(spec.paint, rng), rng), 0.3 + rng() * 0.4) : weather(pick(spec.paint, rng), rng))
      : weather(0xd8cbb2, rng, 0.7);
    placer.try(def, cx + Math.cos(a) * rad, cz + Math.sin(a) * rad, {
      yaw: rng() * TAU, body, accent: weather(pick(spec.paint, rng), rng),
      spacing: def.clear * 1.35,
    });
  }

  // --- vehicles ----------------------------------------------------------
  const carN = Math.max(1, Math.round(spec.cars * (R / 100) * density * 1.6));
  for (let i = 0; i < carN; i++) {
    const a = rng() * TAU;
    const rad = R * (0.40 + 0.68 * Math.sqrt(rng()));
    const def = weighted(spec.vehicles, rng);
    // Three quarters of the traffic is parked square to the world grid,
    // because every street and hardstanding in `pois.ts` is axis-aligned. The
    // rest is abandoned at an angle, which is what stops a car park looking
    // like a spreadsheet.
    const yaw = rng() < 0.75
      ? Math.round(rng() * 4) * (Math.PI / 2) + (rng() - 0.5) * 0.07
      : rng() * TAU;
    placer.try(def, cx + Math.cos(a) * rad, cz + Math.sin(a) * rad, {
      yaw,
      body: vehiclePaint(spec, def, rng),
      accent: weather(pick(spec.paint, rng), rng),
      spacing: def.clear * 1.5,
      roll: def === DEF_WRECK ? (rng() - 0.5) * 0.12 : 0,
    });
  }

  // --- lamp posts round the ring ----------------------------------------
  const lampN = Math.round(spec.lamps * Math.min(1.25, density + 0.15));
  for (let i = 0; i < lampN; i++) {
    const a = (i / Math.max(1, lampN)) * TAU + rng() * 0.06;
    const rad = R * (0.88 + rng() * 0.14);
    const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
    // Arm points back toward the district centre — a lamp lighting the fields
    // instead of the street is the sort of thing you notice once and never
    // stop noticing.
    placer.try(DEF_LAMP, x, z, { yaw: yawForX(cx - x, cz - z), spacing: 9 });
  }

  if (kind === "urban" || kind === "suburb") {
    for (let i = 0; i < 3; i++) {
      const a = rng() * TAU;
      const rad = R * (0.72 + rng() * 0.28);
      const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
      placer.try(DEF_SHELTER, x, z, {
        yaw: yawForZ(cx - x, cz - z), spacing: 14,
        body: weather(0x2f6f9c, rng),
      });
    }
  }

  // --- perimeter fencing -------------------------------------------------
  if (spec.fence !== "none" && density > 0.4) {
    const def = spec.fence === "picket" ? DEF_PICKET : DEF_CHAINLINK;
    const segLen = spec.fence === "picket" ? 2.36 : 2.96;
    const runs = spec.fence === "picket" ? 4 : 3;
    for (let r = 0; r < runs; r++) {
      const rad = R * (0.94 + rng() * 0.16);
      let a = rng() * TAU;
      const segs = 5 + Math.floor(rng() * 9);
      const step = segLen / rad;
      for (let i = 0; i < segs; i++) {
        const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
        // Tangent of the arc, which is what the fence panel has to lie along.
        placer.try(def, x, z, { yaw: yawForX(-Math.sin(a), Math.cos(a)), spacing: 0, crowd: i > 0 });
        a += step;
      }
    }
  }

  // --- container stacks --------------------------------------------------
  for (let s = 0; s < Math.round(spec.stacks * density); s++) {
    const a = rng() * TAU;
    const rad = R * (0.55 + rng() * 0.5);
    const bx = cx + Math.cos(a) * rad, bz = cz + Math.sin(a) * rad;
    const yaw = Math.round(rng() * 4) * (Math.PI / 2);
    const dirX = Math.cos(yaw + Math.PI / 2), dirZ = -Math.sin(yaw + Math.PI / 2);
    const rows = 3 + Math.floor(rng() * 3);
    const base = placer.try(DEF_CONTAINER, bx, bz, {
      yaw, body: weather(pick(CONTAINER_PAINT, rng), rng), spacing: 8,
    });
    if (base === null) continue;
    for (let i = 1; i < rows; i++) {
      const x = bx + dirX * 2.62 * i, z = bz + dirZ * 2.62 * i;
      placer.try(DEF_CONTAINER, x, z, {
        yaw, y: placer.groundAt(x, z), body: weather(pick(CONTAINER_PAINT, rng), rng),
        spacing: 0, crowd: true,
      });
    }
    // Second and third tiers, thinning as they go. A yard of single-height
    // boxes reads as a car park; a stack reads as a yard.
    for (let tierIdx = 1; tierIdx <= 2; tierIdx++) {
      for (let i = 0; i < rows; i++) {
        if (rng() > 0.62 - tierIdx * 0.22) continue;
        const x = bx + dirX * 2.62 * i, z = bz + dirZ * 2.62 * i;
        placer.try(DEF_CONTAINER, x, z, {
          yaw: yaw + (rng() - 0.5) * 0.03,
          y: placer.groundAt(x, z) + 2.62 * tierIdx,
          body: weather(pick(CONTAINER_PAINT, rng), rng),
          spacing: 0, crowd: true,
        });
      }
    }
  }

  // --- one water tower, on the high side ---------------------------------
  if (spec.tower && density > 0.4) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = rng() * TAU;
      const rad = R * (0.62 + rng() * 0.35);
      if (placer.try(DEF_WATERTOWER, cx + Math.cos(a) * rad, cz + Math.sin(a) * rad, {
        yaw: rng() * TAU, spacing: 26, body: weather(0xd8d2c4, rng, 0.6),
      }) !== null) break;
    }
  }

  // --- boats -------------------------------------------------------------
  if (spec.boats > 0) placeBoats(w, poi, Math.round(spec.boats * density));
}

/** Container livery. Faded, and never the same twice in a row on a stack. */
const CONTAINER_PAINT = [
  0xb8452c, 0x2f6f9c, 0x3f7a52, 0xd8a72b, 0xa8a49c, 0x8c4f2f, 0x2f5f8c, 0x6d4f7a,
];

/**
 * Moored and beached boats. Depth-tested rather than distance-tested: a boat
 * beached 30 m up a mudflat and a boat floating in 12 m of water both read as
 * mistakes, and only the depth tells them apart.
 */
function placeBoats(w: Pass, poi: Poi, count: number): void {
  const { rng, placer, terrain } = w;
  if (!terrain) return;
  const sea = terrain.seaLevel;
  const depthAt = (x: number, z: number) =>
    terrain.waterDepthAt ? terrain.waterDepthAt(x, z) : Math.max(0, sea - terrain.heightAt(x, z));

  let made = 0;
  for (let attempt = 0; attempt < count * 60 && made < count; attempt++) {
    const a = rng() * TAU;
    const rad = poi.radius * (0.85 + rng() * 1.15);
    const x = poi.center.x + Math.cos(a) * rad;
    const z = poi.center.z + Math.sin(a) * rad;
    const d = depthAt(x, z);
    const big = rng() < 0.42;
    // A trawler needs water under it; a rowboat is happy in the shallows or
    // pulled up onto the sand.
    if (big) {
      if (d < 1.4 || d > 6) continue;
      if (placer.try(DEF_TRAWLER, x, z, {
        yaw: rng() * TAU, y: sea + 0.62, water: true, crowd: true, spacing: 13,
        body: weather(pick([0xefeade, 0x2f6f9c, 0xb8452c, 0x3f7a52], rng), rng),
        accent: weather(0xefeade, rng, 0.5),
      }) !== null) made++;
    } else {
      const beached = d < 0.25;
      if (d > 1.6) continue;
      if (placer.try(DEF_ROWBOAT, x, z, {
        yaw: rng() * TAU,
        y: beached ? terrain.heightAt(x, z) - 0.05 : sea - 0.24,
        pitch: beached ? (rng() - 0.5) * 0.14 : 0,
        roll: beached ? (rng() - 0.5) * 0.22 : 0,
        water: true, crowd: true, spacing: 5,
        body: weather(pick([0xd8cbb2, 0x2f6f9c, 0xb8452c, 0xefeade], rng), rng),
      }) !== null) made++;
    }
  }

  // Mooring posts along the water's edge.
  for (let i = 0; i < count * 2; i++) {
    const a = rng() * TAU;
    const rad = poi.radius * (0.8 + rng() * 0.7);
    const x = poi.center.x + Math.cos(a) * rad;
    const z = poi.center.z + Math.sin(a) * rad;
    if (depthAt(x, z) > 0.3) continue;
    placer.try(DEF_BOLLARD, x, z, { yaw: rng() * TAU, spacing: 3.5, maxSlope: 0.3 });
  }
}

/**
 * Roadside furniture.
 *
 * The spline is reproduced exactly from `pois.ts` — same four control points,
 * same centripetal Catmull-Rom, same 0.5 tension — because the whole value of
 * this pass is that the lamp posts stand on the verge of the actual road
 * rather than in a field near it. If the road module is ever re-tuned, this is
 * the thing that has to move with it.
 */
function populateRoads(w: Pass, density: number): void {
  const { rng, placer, pois } = w;
  const byName = new Map(pois.map((p) => [p.name, p]));
  const tmp = new THREE.Vector3();
  const tan = new THREE.Vector3();

  for (const [aName, bName, bow, width] of ROAD_LINKS) {
    const A = byName.get(aName), B = byName.get(bName);
    if (!A || !B) continue;
    const dx = B.center.x - A.center.x, dz = B.center.z - A.center.z;
    const len = Math.hypot(dx, dz);
    if (len < 40) continue;
    const px = -dz / len, pz = dx / len;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(A.center.x, 0, A.center.z),
      new THREE.Vector3(A.center.x + dx * 0.33 + px * bow * 0.7, 0, A.center.z + dz * 0.33 + pz * bow * 0.7),
      new THREE.Vector3(A.center.x + dx * 0.67 + px * bow, 0, A.center.z + dz * 0.67 + pz * bow),
      new THREE.Vector3(B.center.x, 0, B.center.z),
    ], false, "centripetal", 0.5);

    const total = curve.getLength();
    // Stay clear of each district's own hardstanding — that ground already
    // belongs to the district pass.
    const t0 = clamp01((A.radius * 0.95) / total);
    const t1 = 1 - clamp01((B.radius * 0.95) / total);
    if (t1 <= t0) continue;

    const half = width * 0.5;
    const step = 34 / Math.max(1, total);
    let side = 1;
    let i = 0;
    for (let t = t0; t < t1; t += step, i++) {
      curve.getPoint(t, tmp);
      curve.getTangent(t, tan);
      const nx = -tan.z, nz = tan.x;
      const nl = Math.hypot(nx, nz) || 1;
      const ox = (nx / nl) * side, oz = (nz / nl) * side;

      // Lamp on the verge, arm swung out over the carriageway.
      const lx = tmp.x + ox * (half + 2.1), lz = tmp.z + oz * (half + 2.1);
      placer.try(DEF_LAMP, lx, lz, { yaw: yawForX(-ox, -oz), spacing: 10, maxSlope: 0.22 });
      side = -side;

      if (i % 3 === 1) {
        const sx = tmp.x - ox * (half + 1.7), sz = tmp.z - oz * (half + 1.7);
        const def = rng() < 0.5 ? DEF_SIGN : DEF_SIGN_WARN;
        placer.try(def, sx, sz, { yaw: yawForZ(-ox, -oz), spacing: 6, maxSlope: 0.24 });
      }
      if (rng() < 0.16 * density) {
        // Abandoned traffic, nose along the road, pulled onto the shoulder.
        const def = weighted([[DEF_SEDAN, 4], [DEF_HATCH, 3], [DEF_WRECK, 3], [DEF_VAN, 2], [DEF_PICKUP, 2]] as const, rng);
        const vx = tmp.x + ox * (half - 1.1), vz = tmp.z + oz * (half - 1.1);
        placer.try(def, vx, vz, {
          yaw: yawForZ(tan.x, tan.z) + (rng() - 0.5) * 0.5,
          body: vehiclePaint(KINDS.urban, def, rng),
          spacing: def.clear * 1.4, maxSlope: 0.22,
        });
      }
      if (rng() < 0.14 * density) {
        // A cone taper: five cones stepping across the lane. Reads as roadworks.
        const n = 3 + Math.floor(rng() * 3);
        for (let k = 0; k < n; k++) {
          const tt = t + (k * 3.4) / Math.max(1, total);
          if (tt >= t1) break;
          curve.getPoint(tt, tmp);
          curve.getTangent(tt, tan);
          const mx = -tan.z, mz = tan.x;
          const ml = Math.hypot(mx, mz) || 1;
          const off = half - 0.9 - k * 0.55;
          placer.try(DEF_CONE, tmp.x + (mx / ml) * off * side, tmp.z + (mz / ml) * off * side, {
            yaw: rng() * TAU, spacing: 1.2, maxSlope: 0.24,
          });
        }
      }
    }
  }
}

/**
 * The boulder field.
 *
 * Two thirds of the placements are singles and the rest are clusters, because
 * real rock outcrops come in families. Scale follows a cubic so the map is
 * mostly ankle-height debris with a handful of 4 m monsters — a uniform
 * distribution gives you a field of identical medium rocks, which is the most
 * procedural-looking thing it is possible to do to a landscape.
 */
function scatterRocks(w: Pass, count: number): void {
  const { rng, placer, terrain, depot, pois } = w;
  const size = terrain ? terrain.worldSize : 1500;
  const nearDistrict = (x: number, z: number): boolean => {
    for (const p of pois) {
      const dx = x - p.center.x, dz = z - p.center.z;
      if (dx * dx + dz * dz < (p.radius * 0.9) * (p.radius * 0.9)) return true;
    }
    return false;
  };

  const drop = (x: number, z: number, scale: number): void => {
    const table = scale >= 1.35 ? DEF_BOULDERS : DEF_ROCKS;
    const def = table[Math.floor(rng() * table.length) % table.length];
    const y = placer.try(def, x, z, {
      yaw: rng() * TAU,
      pitch: (rng() - 0.5) * 0.26,
      roll: (rng() - 0.5) * 0.26,
      scale,
      // Buried to a quarter of their radius. A boulder resting exactly on the
      // surface reads as dropped in; a buried one reads as exposed by weather.
      sink: scale * 0.26,
      spacing: scale * 2.1,
      maxSlope: MAX_ROCK_SLOPE,
      body: weather(pick(ROCK_TINTS, rng), rng, 0.8),
      crowd: scale < 1.1,
    });
    if (y === null) return;
    // Only the ones you can actually take cover behind get a collider — a
    // pebble that stops a bullet is worse than a pebble you can walk over.
    if (scale >= 1.15) {
      depot.solidWorld(x, y + scale * 0.42, z, scale * 0.78, scale * 0.52, scale * 0.78, "concrete", "stone", "rock");
    }
  };

  for (let i = 0; i < count; i++) {
    const x = (rng() * 2 - 1) * size;
    const z = (rng() * 2 - 1) * size;
    if (nearDistrict(x, z)) continue;
    const scale = 0.42 + Math.pow(rng(), 2.7) * 4.3;
    drop(x, z, scale);
    // Cluster: a parent boulder with its own debris field.
    if (scale > 1.4 && rng() < 0.45) {
      const kids = 2 + Math.floor(rng() * 4);
      for (let k = 0; k < kids; k++) {
        const a = rng() * TAU;
        const d = scale * (1.3 + rng() * 2.2);
        drop(x + Math.cos(a) * d, z + Math.sin(a) * d, scale * (0.25 + rng() * 0.45));
      }
    }
  }
}

/**
 * The transmission line: a chain of pylons across the island with catenary
 * cables slung between them.
 *
 * The sag is the whole point. A straight cable between two towers reads as a
 * wire-frame debug line; a sagging one reads as weight. 3.4 % of the span is
 * the number that looks right at these tower heights — real lines run 2–5 %.
 */
function buildPowerLine(w: Pass): void {
  const { placer, depot, terrain, rng, tier } = w;
  if (!tier.extras) return;

  const route: Array<[number, number]> = [
    [-1180, 420], [-760, 250], [-330, 60], [120, -160], [560, -330], [980, -470], [1240, -600],
  ];
  const path = new THREE.CatmullRomCurve3(
    route.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, "centripetal", 0.5,
  );
  const total = path.getLength();
  const spans = Math.max(4, Math.round(total / 165));

  const ARMS: Array<[number, number]> = [[24 * 0.74, 5.4], [24 * 0.93, 4.0]];
  const anchors: THREE.Vector3[][] = [];
  const tmp = new THREE.Vector3();
  const tan = new THREE.Vector3();

  for (let i = 0; i <= spans; i++) {
    const t = i / spans;
    path.getPoint(t, tmp);
    path.getTangent(t, tan);
    let x = tmp.x, z = tmp.z;
    // Nudge along the tangent until the ground will take a tower.
    let y: number | null = null;
    for (let attempt = 0; attempt < 8 && y === null; attempt++) {
      const off = attempt === 0 ? 0 : (attempt % 2 ? 1 : -1) * Math.ceil(attempt / 2) * 22;
      const ax = tmp.x + tan.x * off, az = tmp.z + tan.z * off;
      y = placer.try(DEF_PYLON, ax, az, {
        yaw: yawForX(-tan.z, tan.x), spacing: 90, maxSlope: 0.30,
        body: weather(0xb7bfc3, rng, 0.5),
      });
      if (y !== null) { x = ax; z = az; }
    }
    if (y === null) { anchors.push([]); continue; }

    const yaw = yawForX(-tan.z, tan.x);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const set: THREE.Vector3[] = [];
    for (const [armY, armL] of ARMS) {
      for (const sx of [-1, 1]) {
        const lx = sx * armL * 0.92;
        // Local +X → (cos yaw, -sin yaw). Local +Z is unused: the anchors sit
        // on the arm axis.
        set.push(new THREE.Vector3(x + lx * cy, y + armY - 1.42, z - lx * sy));
      }
    }
    anchors.push(set);
  }

  const cable = surf("metalPanel", 0x3a3f42);
  const SAMPLES = tier.trim ? 14 : 8;
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i], b = anchors[i + 1];
    if (a.length === 0 || b.length === 0 || a.length !== b.length) continue;
    for (let k = 0; k < a.length; k++) {
      const span = a[k].distanceTo(b[k]);
      if (span > 320) continue;
      const sag = span * 0.034;
      const pts: THREE.Vector3[] = [];
      for (let s = 0; s <= SAMPLES; s++) {
        const t = s / SAMPLES;
        pts.push(new THREE.Vector3(
          lerp(a[k].x, b[k].x, t),
          lerp(a[k].y, b[k].y, t) - sag * 4 * t * (1 - t),
          lerp(a[k].z, b[k].z, t),
        ));
      }
      // One region for every cable on the island: they are a few thousand
      // triangles in total and partitioning them would cost more in draw calls
      // than it could ever save in culling.
      depot.static("power", cable, tubeAlong(pts, 0.075, 4), undefined, "never");
    }
  }
  void terrain;
}

/** Wilderness dressing: fence lines with nothing behind them, a lone wreck on
 *  a track, a stack of tyres at a field gate. Signals of habitation between
 *  the districts, which is the difference between a map and a level. */
function scatterWilds(w: Pass, density: number): void {
  const { rng, placer, terrain, pois } = w;
  const size = terrain ? terrain.worldSize : 1500;
  const nearDistrict = (x: number, z: number, k: number): boolean => {
    for (const p of pois) {
      const dx = x - p.center.x, dz = z - p.center.z;
      if (dx * dx + dz * dz < (p.radius * k) * (p.radius * k)) return true;
    }
    return false;
  };

  // Field boundaries: long runs of picket, following a slowly-turning heading.
  const runs = Math.round(22 * density);
  for (let r = 0; r < runs; r++) {
    let x = (rng() * 2 - 1) * size * 0.8;
    let z = (rng() * 2 - 1) * size * 0.8;
    if (nearDistrict(x, z, 1.15)) continue;
    let heading = rng() * TAU;
    const segs = 8 + Math.floor(rng() * 26);
    let broken = 0;
    for (let i = 0; i < segs; i++) {
      const dirX = Math.cos(heading), dirZ = Math.sin(heading);
      // Gaps where the fence has fallen down. A perfect fence is a suspicious
      // fence; three panels missing is a farm.
      if (rng() > 0.09) {
        if (placer.try(DEF_PICKET, x, z, { yaw: yawForX(dirX, dirZ), spacing: 0, crowd: true, maxSlope: 0.22 }) === null) {
          broken++;
          if (broken > 4) break;
        } else broken = 0;
      }
      x += dirX * 2.36;
      z += dirZ * 2.36;
      heading += (rng() - 0.5) * 0.09;
    }
  }

  // Lone props: a derelict at a passing place, tyres at a gate, an oil drum.
  const singles = Math.round(70 * density);
  for (let i = 0; i < singles; i++) {
    const x = (rng() * 2 - 1) * size * 0.88;
    const z = (rng() * 2 - 1) * size * 0.88;
    if (nearDistrict(x, z, 1.1)) continue;
    const def = weighted([
      [DEF_WRECK, 4], [DEF_TYRESTACK, 3], [DEF_DRUM, 3], [DEF_CRATE, 2],
      [DEF_PALLET, 2], [DEF_TRACTOR, 1], [DEF_SIGN_WARN, 2], [DEF_PICKUP, 1],
    ] as const, rng);
    placer.try(def, x, z, {
      yaw: rng() * TAU,
      roll: def === DEF_WRECK ? (rng() - 0.5) * 0.16 : 0,
      body: def.harvest === "metal" ? rusted(weather(pick(WORK_PAINT, rng), rng), 0.3 + rng() * 0.4) : weather(0xcbbb9c, rng),
      spacing: def.clear * 2.4,
      maxSlope: 0.2,
    });
  }

  // Shoreline: driftwood boats and mooring posts on the open coast.
  if (terrain) {
    const depthAt = (x: number, z: number) =>
      terrain.waterDepthAt ? terrain.waterDepthAt(x, z) : Math.max(0, terrain.seaLevel - terrain.heightAt(x, z));
    for (let i = 0; i < Math.round(40 * density); i++) {
      const a = rng() * TAU;
      const rr = (terrain.islandRadius ?? size * 0.72) * (0.95 + rng() * 0.12);
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (nearDistrict(x, z, 1.2)) continue;
      if (depthAt(x, z) > 0.2) continue;
      placer.try(rng() < 0.35 ? DEF_ROWBOAT : DEF_BOLLARD, x, z, {
        yaw: rng() * TAU,
        roll: (rng() - 0.5) * 0.24,
        spacing: 8, maxSlope: 0.26,
        body: weather(0xc9b697, rng, 1.1),
      });
    }
  }
}

/* ------------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------------ */

/** Re-evaluated at 6 Hz; a shadow-caster flag does not need frame accuracy. */
const SHADOW_TICK = 1 / 6;

const createProps: SystemFactory = (ctx: WorldCtx): System => {
  const root = new THREE.Group();
  root.name = "dz:props";

  const materials = ctx.services.materials;
  if (!materials) {
    // Every prop in here is a textured surface. Without the library there is
    // nothing to draw, and drawing untextured stand-ins would be worse than
    // drawing nothing at all.
    console.warn("[Drop Zero] props: no materials service; the map ships bare.");
    return { name: "props" };
  }

  const tier = TIERS[ctx.quality] ?? TIERS.high;
  const terrain = ctx.services.terrain as TerrainLike | undefined;
  const pois = ctx.services.pois ?? [];

  /**
   * A private RNG, seeded from a constant.
   *
   * `ctx.rng` is shared and its call count depends on how much entropy the
   * systems that booted before us happened to draw — so using it directly
   * would mean the boulder field moves whenever an unrelated system changes.
   * Same reasoning, and the same fix, as `pois.ts`. Determinism is the point;
   * the *source* of the determinism is not.
   */
  const rng = makeRng(PROPS_SEED);

  let maxAniso = 4;
  try {
    maxAniso = Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy());
  } catch {
    maxAniso = 1;
  }

  const local = buildLocalMaterials(ctx.quality, maxAniso);
  const depot = new Depot(materials, local, ctx.services.collision, tier, rng);

  const regionOf = (x: number, z: number): string => {
    for (const p of pois) {
      const dx = x - p.center.x, dz = z - p.center.z;
      const r = p.radius * 1.3;
      if (dx * dx + dz * dz < r * r) return p.name;
    }
    return `wild:${Math.floor(x / WILD_CELL)},${Math.floor(z / WILD_CELL)}`;
  };

  const placer = new Placer(depot, terrain, ctx.services.collision, regionOf);
  const pass: Pass = { depot, placer, terrain, pois, tier, rng };
  const density = tier.density;

  // Order matters, and it is the reverse of importance: the passes that run
  // first get the ground they want, and everything after them has to fit round
  // what is already registered with `collision`. Districts and roads are what
  // the player actually looks at, so they choose first.
  const stages: Array<[string, () => void]> = [
    ["districts", () => { for (const poi of pois) populateDistrict(pass, poi, density); }],
    ["roads", () => populateRoads(pass, density)],
    ["power", () => buildPowerLine(pass)],
    ["wilds", () => scatterWilds(pass, density)],
    ["rocks", () => scatterRocks(pass, Math.round(tier.rocks))],
  ];
  for (const [label, fn] of stages) {
    try {
      fn();
    } catch (err) {
      // One bad pass must not cost the other four, and it absolutely must not
      // take the world down: props are decoration, not a dependency.
      console.error(`[Drop Zero] props pass "${label}" failed:`, err);
    }
  }

  depot.flush(root);
  ctx.scene.add(root);

  ctx.emit("dz:props-ready", {
    placed: depot.placed,
    colliders: depot.colliders,
    meshes: root.children.length,
    rejected: placer.rejected,
  });

  let shadowClock = SHADOW_TICK;
  let disposed = false;
  const camPos = new THREE.Vector3();

  return {
    name: "props",

    update(dt, c) {
      // --- dusk ------------------------------------------------------------
      // Lamps strike at 0.42 daylight and are at full output by 0.12. Real
      // photocells have exactly this hysteresis-free lag, and doing it as a
      // ramp rather than a switch means the world never pops.
      const sky = c.services.sky as SkyService | undefined;
      const daylight = sky ? sky.daylight : 1;
      const night = clamp01((0.42 - daylight) / 0.30);
      // Two decorrelated slow sines: a mains hum and a much slower warm-up
      // drift. Neither is visible on its own; together the street stops
      // looking like it is lit by a single unchanging value.
      const t = c.elapsed;
      const flicker = 1 + Math.sin(t * 6.1) * 0.010 + Math.sin(t * 0.83 + 1.7) * 0.024;
      local.setNight(night, flicker);

      // --- shadow LOD ------------------------------------------------------
      shadowClock += dt;
      if (shadowClock < SHADOW_TICK) return;
      shadowClock = 0;
      camPos.copy(c.camera.position);
      const near = tier.shadowDist;
      for (const e of depot.shadowEntries) {
        // Distance to the region bucket's shell, not its centre: a district's
        // worth of props is 200 m across and testing its centre would switch
        // the whole bucket off while the player stands in the middle of it.
        const d = camPos.distanceTo(e.center) - e.radius;
        const limit = e.mode === "always" ? near * 2.2 : near;
        const on = d < limit;
        if (e.mesh.castShadow !== on) e.mesh.castShadow = on;
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      // Pull the group before the engine's deep-disposer can walk it: the
      // library materials and their textures are shared with every other
      // system and disposing them here would blank the island.
      root.parent?.remove(root);
      for (const child of root.children) {
        const im = child as THREE.InstancedMesh;
        im.dispose?.();
      }
      root.clear();
      depot.dispose();
      local.dispose();
    },
  };
};

export default createProps;
