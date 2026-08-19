/**
 * SPLASH ROYALE — THE LIDO.
 *
 * A municipal water park on the north-east coast: a separate realm inside the
 * same world. It is not a second island and it is not a second engine — it is
 * one more `System`, sitting on the same terrain, registering into the same
 * collision broadphase and publishing into the same `ctx.services.pois` that
 * loot, bots and the map already read. Drop on it and the game treats it like
 * any other landmark; stand in it and it should not feel like the island at
 * all: turquoise tile, safety yellow, sun-bleached plastic, chlorine geometry.
 *
 * WHY IT IS ITS OWN FILE. `pois.ts` is 3 900 lines of town/harbour/farm kit and
 * a lido shares almost none of its vocabulary — no gable roofs, no shopfronts,
 * no brick. What it needs instead is pools with shelving floors, swept flumes,
 * a current, and paving with holes in it. So this module carries its own small
 * kit in the same *style* (chamfered solids, world-space UVs, merge-per-surface,
 * collide-as-you-author) without importing a line of it. Systems in this engine
 * never import each other; that rule is what lets both files be re-authored
 * independently.
 *
 * THE SITE IS MEASURED, NOT ASSUMED. The island has no flat pad here — the
 * ground is a 36 m shelf that falls away to the north-east toward the beach,
 * and the terrain module is not ours to edit. So the park is authored as three
 * axis-aligned TERRACES whose tops are resolved at boot from the terrain that
 * is actually there: `deckTop = round(maxTerrain / GRID) * GRID`, nudged up a
 * cell if the highest ground would poke through the paving. Each terrace then
 * fills down to the lowest ground under it, and the fill is a retaining wall —
 * which is what a real coastal lido is. The resolved elevations ship in
 * `dz:lido-ready`, so a probe can check what the ground did rather than what
 * this comment hoped it would do.
 *
 * WHAT IS IN IT
 *   · a tower of slides — helical flume, open half-pipe, near-vertical drop —
 *     landing in splash pools. 28 m tall, and the point of it is the skyline.
 *   · a wave pool with a real shelving floor you can run into, lane ropes and
 *     a deep end.
 *   · a lazy river ring with a current that moves you (see FLOW, below).
 *   · splash pads: timed ground jets, a tipping bucket tower, hoops.
 *   · a three-height diving stack with springboards over a deep pool.
 *   · the furniture that makes it read as a place: loungers, parasols, a
 *     shuttered kiosk, changing cabins, lockers, turnstiles, lifeguard chairs,
 *     a first-aid hut, hedges, a car park and a bus stop.
 *   · SIGNAGE with real lettering, painted into one 1024² atlas so the whole
 *     park's twenty-odd signs cost one draw call and one texture.
 *
 * FLOW — how the river carries you WITHOUT touching player.ts.
 * Two channels, because there are two kinds of consumer:
 *   1. `ctx.services.lido.flowAt(x, y, z, out)` — a published flow field. Any
 *      system that wants to know which way the water is going can ask.
 *   2. `dz:soak` — the engine event `player.ts` already listens to, whose
 *      payload is a velocity impulse for a named actor. The river emits a
 *      small one every fixed step while the local player is in the channel, so
 *      the current is exactly the same mechanism as being shoved by a Firehose
 *      and needs no new code over there. Water mode only: that handler is
 *      gated on the mode, which is correct — the classic build has no lido
 *      swimmers, and classic must not regress.
 *
 * Reads (all lazily, all null-checked): `materials`, `terrain`, `collision`,
 * `wetness` (the deck starts slick and is topped up, because a lido is never
 * dry), `player` (only to know whether it should be pushed).
 * Publishes: `ctx.services.lido`, plus one `Poi` named "The Lido", tier
 * "landmark", appended to the list `pois.ts` owns.
 *
 * BOOT: this is a consumer of terrain, collision, materials, pois and wetness,
 * and a producer for loot, bots and the map. It must therefore boot after
 * `createWetness` and before `createLoot`. See the note at the bottom of the
 * file for the exact line.
 *
 * Convention, as everywhere: +X east, +Z south, +Y up, 1 unit = 1 metre, and
 * every walkable floor lands on a multiple of `GRID` so players can build off
 * it.
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
  type QualityTier,
  type System,
  type SystemFactory,
  type TerrainService,
  type WorldCtx,
} from "../types";

/* ------------------------------------------------------------------------ *
 * Contract shims
 *
 * Same reason `pois.ts` has them: these ride on service objects rather than in
 * `types.ts`, which is shared and is being compiled against by twenty other
 * systems right now. Read structurally, null-checked, and every one of them
 * degrades to "the park still builds, it just does less".
 * ------------------------------------------------------------------------ */

/** The extras terrain publishes beyond `TerrainService`. All optional here. */
type TerrainLike = TerrainService & {
  slopeAt?(x: number, z: number): number;
  coastDistanceAt?(x: number, z: number): number;
};

/** The two calls this module makes into the wetness field, if it booted. */
interface WetnessLike {
  splash(point: THREE.Vector3, radius: number, amount: number): void;
  wetnessAt?(x: number, z: number): number;
}

/** What the lido publishes for anyone who wants to read the park. */
export interface LidoService {
  /** Park centre and its published POI radius. */
  readonly center: THREE.Vector3;
  readonly radius: number;
  /** Resolved terrace elevations, world Y. All multiples of `GRID`. */
  readonly decks: Readonly<Record<"main" | "entrance" | "lower", number>>;
  /**
   * Water current at a point, metres per second, written into `out`.
   *
   * Non-zero only inside the lazy river channel and only between the channel
   * floor and its coping — a player on the bridge over the river is not in it.
   * Returns `out` always, zeroed when there is no current, so a caller can use
   * it without branching.
   */
  flowAt(x: number, y: number, z: number, out?: THREE.Vector3): THREE.Vector3;
  /** True when a point is inside the park's footprint (any terrace). */
  contains(x: number, z: number): boolean;
  /** Every pool in the park, for anything that wants to find water. */
  readonly pools: readonly LidoPool[];
}

/** One body of water in the park. */
export interface LidoPool {
  id: string;
  name: string;
  /** Water surface centre, world space. `y` is the waterline. */
  center: THREE.Vector3;
  /** Half-extents of the water surface in X and Z. */
  hx: number;
  hz: number;
  /** Deepest water, metres. */
  depth: number;
}

declare module "../types" {
  interface WorldServices {
    /**
     * The Lido: terrace elevations, the lazy river's flow field and the list
     * of pools. Absent when the system failed to boot, like every service.
     */
    lido?: LidoService;
  }
}

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

interface LidoTier {
  /** Edge chamfer, metres. Zero on `low`: 3.7× the triangles is real money. */
  bevel: number;
  /** Radial/arc segments on flumes, the river ring and round trim. */
  round: number;
  /** Steps in a shelving pool floor. Fewer steps = a coarser slope, unseen
   *  under water but felt in the shallow end, so `low` still gets eight. */
  shelf: number;
  /** Multiplier on furniture counts — loungers, parasols, cabins, bollards. */
  props: number;
  /** Ground jets on the splash pad. */
  jets: number;
  /** Rubber rings drifting round the lazy river. */
  rings: number;
  /** The expensive trim pass: drains, hose, bunting, kerb detail, lockers. */
  trim: boolean;
  /** Signs are one draw call whatever the tier; this is the atlas resolution. */
  signPx: number;
}

const TIERS: Record<QualityTier, LidoTier> = {
  low: { bevel: 0, round: 8, shelf: 8, props: 0.4, jets: 9, rings: 5, trim: false, signPx: 512 },
  medium: { bevel: 0.035, round: 12, shelf: 14, props: 0.75, jets: 14, rings: 8, trim: true, signPx: 1024 },
  high: { bevel: 0.045, round: 16, shelf: 20, props: 1, jets: 20, rings: 11, trim: true, signPx: 1024 },
  ultra: { bevel: 0.055, round: 22, shelf: 26, props: 1.25, jets: 26, rings: 14, trim: true, signPx: 2048 },
};

/**
 * World metres per UV repeat, mirroring `SPEC[].metres` in materials.ts — the
 * same duplication `pois.ts` carries, for the same reason: systems here do not
 * import each other, and a wrong number costs texture density, not a crash.
 */
const TILE: Record<MaterialName, number> = {
  plaster: 3.2, brick: 2.4, woodPlank: 2.6, woodLog: 2.0, concrete: 3.6, asphalt: 5.0,
  metalPanel: 2.8, corrugated: 3.0, roofTile: 2.6, roofShingle: 3.0, glass: 2.0, rock: 4.5,
  dirt: 4.0, sand: 4.0, grass: 3.0, foliage: 1.0, bark: 2.2, fabric: 2.0, gold: 1.2, rubber: 1.4,
};

/** Impact family per material, mirroring materials.ts. Footsteps and decals. */
const IMPACT: Record<MaterialName, ImpactMaterial> = {
  plaster: "concrete", brick: "concrete", woodPlank: "wood", woodLog: "wood", concrete: "concrete",
  asphalt: "concrete", metalPanel: "metal", corrugated: "metal", roofTile: "concrete",
  roofShingle: "concrete", glass: "glass", rock: "concrete", dirt: "dirt", sand: "sand",
  grass: "grass", foliage: "grass", bark: "wood", fabric: "dirt", gold: "metal", rubber: "dirt",
};

/* ------------------------------------------------------------------------ *
 * The palette
 *
 * Municipal pool, slightly worn. Two rules carried over from `pois.ts`, both
 * of which are about how `materials.tinted()` behaves rather than about taste:
 *
 *  · A TINT MULTIPLIES, IN LINEAR SPACE, into a map that is already painted.
 *    So a "concrete grey" tint over the concrete plate lands at a sixth of the
 *    value the hex implies. Ground tints here are therefore near-white; the
 *    darkness in this park comes from the WET tint being deliberately half the
 *    dry one, which is the correct relationship and reads immediately.
 *  · SATURATION IS FOR OBJECTS, NOT GROUND. The turquoise belongs on tile and
 *    plastic, where there is a highlight to carry it.
 * ------------------------------------------------------------------------ */

/** Dry deck paving: warm, near-white, sun-bleached. */
const DECK_DRY = 0xf4e6cd;
/** Wet concrete round the pools. Half the dry value: this is the whole tell. */
const DECK_WET = 0x8f9a99;
/** Painted deck markings and lane hatching. Paint is near-white. */
const DECK_LINE = 0xfff8ea;
/** The kerb and coping stone: a value step up from the deck. */
const COPING = 0xfbf1de;
/** Pool tile, the colour the park is named for. */
const TILE_TURQ = 0x2ea8c0;
/** Pool tile, the lighter band at the waterline. */
const TILE_PALE = 0x8fd8e2;
/** Pool floor: pale tile so the water reads as shallow at the near end. */
const TILE_FLOOR = 0xa9e0e6;
/** The water itself. */
const WATER_TINT = 0x2fb6cb;
/** Safety yellow — handrails, bollards, the height post, hazard hatching. */
const SAFETY = 0xf0bc2c;
/** Faded municipal red — flume, roof trim, the first-aid cross, old paint. */
const FADED_RED = 0xc0503a;
/** Municipal blue — flume, doors, the bus shelter, lane ropes. */
const MUNI_BLUE = 0x2f7fae;
/** Municipal green — hedges read as this under the foliage map. */
const HEDGE = 0x4d7a3a;
/** Sun-bleached plastic — loungers, cabins, changing doors. */
const PLASTIC = 0xe4dccb;
/** Galvanised handrail / locker steel. */
const STEEL = 0xc3c9cb;
/** Dark grey trim: gratings, shutter, drain covers, tarmac markings. */
const GRIME = 0x6f7472;
/** The white render on every building in the park. */
const RENDER_WHITE = 0xf6f1e4;

/* ------------------------------------------------------------------------ *
 * Small maths
 * ------------------------------------------------------------------------ */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const snap = (v: number, g = GRID) => Math.round(v / g) * g;
const TAU = Math.PI * 2;

/* ------------------------------------------------------------------------ *
 * Surfaces
 * ------------------------------------------------------------------------ */

interface Surf {
  name: MaterialName;
  color: number;
}

const surf = (name: MaterialName, color = 0xffffff): Surf => ({ name, color });
const surfKey = (s: Surf) => `${s.name}|${s.color.toString(16)}`;

/* ------------------------------------------------------------------------ *
 * The geometry kit
 *
 * Triangle soup with auto-oriented winding, exactly as `pois.ts` does it and
 * for the same three reasons: nothing allocates a THREE object until the
 * bucket is flushed, every result carries exactly position/normal/uv so
 * `mergeGeometries` will accept it, and UVs project from WORLD space by
 * dominant normal axis so tile courses run continuously across two boxes that
 * happen to be flush.
 * ------------------------------------------------------------------------ */

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

  /** A triangle wound to face `n`. One cross product buys authoring freedom. */
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

  /** A planar quad, corners in ring order. Winding fixed up against `n`. */
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

  /** A quad with explicit per-corner UVs. Signs and painted markings. */
  quadUv(
    p: readonly number[],
    n: readonly number[],
    uvs: readonly number[],
  ): void {
    const i0 = this.vert(p[0], p[1], p[2], n[0], n[1], n[2], uvs[0], uvs[1]);
    const i1 = this.vert(p[3], p[4], p[5], n[0], n[1], n[2], uvs[2], uvs[3]);
    const i2 = this.vert(p[6], p[7], p[8], n[0], n[1], n[2], uvs[4], uvs[5]);
    const i3 = this.vert(p[9], p[10], p[11], n[0], n[1], n[2], uvs[6], uvs[7]);
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2];
    const vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    const flip = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2] < 0;
    if (flip) this.idx.push(i0, i3, i2, i0, i2, i1);
    else this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  /** Bake. `m` applies first, so world-space UVs see final positions. */
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
 * Resolve one authored part into an accumulator: transform, settle UVs for
 * good, append. Only whole chunks ever become `BufferGeometry`, because a
 * geometry per box and a `mergeGeometries` at the end is a GC storm.
 */
function appendPart(dst: Geo, src: Geo, m: THREE.Matrix4 | undefined, tile: number): void {
  const base = dst.pos.length / 3;
  const inv = 1 / tile;
  const world = src.uvMode === "world";
  const raw = src.uvMode === "raw";
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
    } else if (raw) {
      // Already final — a sign's atlas coordinates, or a resolved accumulator.
      dst.uv.push(src.uv[j], src.uv[j + 1]);
    } else {
      dst.uv.push(src.uv[j] * inv, src.uv[j + 1] * inv);
    }
  }
  const idx = src.idx;
  for (let i = 0; i < idx.length; i++) dst.idx.push(idx[i] + base);
}

/** World-space triplanar-by-dominant-axis UVs. Keeps tile courses continuous. */
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

/** Metre-authored UVs (swept flumes, the river channel) scaled into tile space. */
function scaleUv(g: THREE.BufferGeometry, s: number): void {
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s);
  uv.needsUpdate = true;
}

/** Face mask bits. Dropping a face that is buried in another solid is free. */
const F_PX = 1, F_NX = 2, F_PY = 4, F_NY = 8, F_PZ = 16, F_NZ = 32;
const F_ALL = 63;
const F_NO_BOTTOM = F_ALL & ~F_NY;
const F_TOP = F_PY;

/**
 * A chamfered box. The chamfer is the highest-value detail in the whole kit:
 * a hard 90° edge between two faces of one material reads as paper, a 4 cm
 * chamfer catches the key light and reads as mass. 44 triangles instead of 12,
 * which is why `low` sets bevel to zero.
 */
function bevelBox(hx: number, hy: number, hz: number, bevel: number, mask = F_ALL): Geo {
  const g = new Geo();
  const h = [hx, hy, hz];
  let b = Math.max(0, Math.min(bevel, hx * 0.45, hy * 0.45, hz * 0.45));
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

/** A cylinder / truncated cone about +Y with arc-length UVs. Posts, pipes. */
function cylinder(rBottom: number, rTop: number, h: number, seg: number, capTop = true, capBottom = false): Geo {
  const g = new Geo();
  g.uvMode = "metre";
  const y0 = -h * 0.5, y1 = h * 0.5;
  const slope = (rBottom - rTop) / h;
  const nScale = 1 / Math.hypot(1, slope);
  const circ = Math.PI * 2 * Math.max(rBottom, rTop);
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

/** A torus about +Y — rubber rings, hoops, the coil of hose. */
function torus(r: number, tube: number, seg: number, tubeSeg = 8, arc = TAU): Geo {
  const g = new Geo();
  g.uvMode = "metre";
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * arc, a1 = ((i + 1) / seg) * arc;
    for (let j = 0; j < tubeSeg; j++) {
      const b0 = (j / tubeSeg) * TAU, b1 = ((j + 1) / tubeSeg) * TAU;
      const pt = (a: number, b: number) => {
        const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
        return [ca * (r + tube * cb), tube * sb, sa * (r + tube * cb), ca * cb, sb, sa * cb];
      };
      const p0 = pt(a0, b0), p1 = pt(a1, b0), p2 = pt(a1, b1), p3 = pt(a0, b1);
      const i0 = g.vert(p0[0], p0[1], p0[2], p0[3], p0[4], p0[5], a0 * r, b0 * tube);
      const i1 = g.vert(p1[0], p1[1], p1[2], p1[3], p1[4], p1[5], a1 * r, b0 * tube);
      const i2 = g.vert(p2[0], p2[1], p2[2], p2[3], p2[4], p2[5], a1 * r, b1 * tube);
      const i3 = g.vert(p3[0], p3[1], p3[2], p3[3], p3[4], p3[5], a0 * r, b1 * tube);
      g.idx.push(i0, i1, i2, i0, i2, i3);
    }
  }
  return g;
}

/** One station of a swept path: where it is, and which way is along/across. */
interface Frame {
  /** Centre of the cross-section. */
  p: THREE.Vector3;
  /** Unit lateral (the section's local +X), always horizontal. */
  right: THREE.Vector3;
  /** Unit up for the section's local +Y. */
  up: THREE.Vector3;
  /** Arc length from the start, metres. Drives the V coordinate. */
  s: number;
}

/**
 * Sweep an open cross-section along a path of frames.
 *
 * This is the primitive the whole slide tower and the lazy river are made of,
 * and the reason the module has one at all: a flume is a U-shaped gutter that
 * corkscrews, and there is no way to build that out of boxes that does not
 * look like it was built out of boxes. The section is authored in metres in
 * section-local (x = across, y = up); UVs are (across, along) in metres, so
 * one `scaleUv` at bake time puts the material's own tile density on it.
 *
 * `closed` stitches the last station back to the first — the lazy river ring.
 */
function sweep(frames: readonly Frame[], section: ReadonlyArray<readonly [number, number]>, closed = false): Geo {
  const g = new Geo();
  g.uvMode = "metre";
  const n = frames.length;
  if (n < 2 || section.length < 2) return g;
  const ring = new Array<number>(section.length * 3);
  const prev = new Array<number>(section.length * 3);
  // Cumulative across-distance for the U coordinate, so a wide section does
  // not stretch its texture over the narrow part of the profile.
  const across: number[] = [0];
  for (let k = 1; k < section.length; k++) {
    across.push(across[k - 1] + Math.hypot(section[k][0] - section[k - 1][0], section[k][1] - section[k - 1][1]));
  }
  const count = closed ? n : n - 1;
  for (let i = 0; i <= count; i++) {
    const f = frames[i % n];
    for (let k = 0; k < section.length; k++) {
      const [sx, sy] = section[k];
      ring[k * 3] = f.p.x + f.right.x * sx + f.up.x * sy;
      ring[k * 3 + 1] = f.p.y + f.right.y * sx + f.up.y * sy;
      ring[k * 3 + 2] = f.p.z + f.right.z * sx + f.up.z * sy;
    }
    if (i > 0) {
      const s0 = frames[i - 1].s;
      // A closed loop's last span has to measure back to the start, not to 0.
      const s1 = i === n ? frames[n - 1].s + frames[0].p.distanceTo(frames[n - 1].p) : frames[i].s;
      for (let k = 0; k < section.length - 1; k++) {
        const a = [prev[k * 3], prev[k * 3 + 1], prev[k * 3 + 2]];
        const b = [prev[(k + 1) * 3], prev[(k + 1) * 3 + 1], prev[(k + 1) * 3 + 2]];
        const c = [ring[(k + 1) * 3], ring[(k + 1) * 3 + 1], ring[(k + 1) * 3 + 2]];
        const d = [ring[k * 3], ring[k * 3 + 1], ring[k * 3 + 2]];
        // Face normal from the quad itself: a swept section can twist, and a
        // section-space normal would be wrong the moment it does.
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        const i0 = g.vert(a[0], a[1], a[2], nx, ny, nz, across[k], s0);
        const i1 = g.vert(b[0], b[1], b[2], nx, ny, nz, across[k + 1], s0);
        const i2 = g.vert(c[0], c[1], c[2], nx, ny, nz, across[k + 1], s1);
        const i3 = g.vert(d[0], d[1], d[2], nx, ny, nz, across[k], s1);
        g.idx.push(i0, i1, i2, i0, i2, i3);
      }
    }
    for (let k = 0; k < ring.length; k++) prev[k] = ring[k];
  }
  return g;
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

/** Build a transform. Allocates — everything in this module runs once, at boot. */
function xf(x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0): THREE.Matrix4 {
  const e = new THREE.Euler(pitch, yaw, roll, "YXZ");
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(e),
    new THREE.Vector3(1, 1, 1),
  );
}

/* ------------------------------------------------------------------------ *
 * The signage atlas
 *
 * SIGNS ARE THE CHEAPEST REALISM IN THE PARK and the most easily got wrong.
 * A lido without lettering is a set of coloured boxes; a lido with NO RUNNING
 * stencilled on the deck and a faded opening-hours board by the turnstiles is
 * a place somebody runs. But twenty signs authored the obvious way is twenty
 * textures and twenty draw calls, which this frame budget does not have.
 *
 * So every sign in the park is painted into ONE canvas at boot — a grid of
 * 4 × 8 cells, each 2:1, a few of them ganged into taller panels — and every
 * sign quad carries UVs into it. One texture, one material, one draw call for
 * the whole park's typography, and adding a sign costs a table row.
 *
 * No external assets: this is a 2D canvas painted with system fonts, exactly
 * like the material bakery does its plates.
 * ------------------------------------------------------------------------ */

interface SignDef {
  /** Grid column 0..3 and row 0..7 of the cell's top-left. */
  col: number;
  row: number;
  /** Cells tall. 1 for a strip sign, 2–3 for a notice board. */
  tall?: number;
  /** Panel colour and ink. */
  bg: number;
  fg: number;
  /** A coloured band across the head of the panel, for a title bar. */
  band?: number;
  /** Lines of text. The first is set largest. */
  lines: string[];
  /** Weathering: 0 clean, 1 sun-bleached and streaked. */
  worn?: number;
}

/**
 * The park's whole vocabulary of printed matter. Kept as one table because
 * that is the thing a reviewer reads to decide whether this place is real.
 */
const SIGNS: Record<string, SignDef> = {
  lido: { col: 0, row: 0, tall: 2, bg: 0x1f8fa8, fg: 0xfdf6e6, lines: ["THE LIDO", "EST. 1954"], worn: 0.35 },
  hours: {
    col: 2, row: 0, tall: 3, bg: 0xf2ead6, fg: 0x333029, band: 0x2f7fae, worn: 0.85,
    lines: ["OPENING HOURS", "MON–FRI  07:00–19:30", "SAT–SUN  08:00–20:00", "LAST ENTRY 45 MIN", "BEFORE CLOSING"],
  },
  norunning: { col: 0, row: 2, bg: 0xf0bc2c, fg: 0x241f18, lines: ["NO RUNNING"], worn: 0.5 },
  deepend: { col: 1, row: 2, bg: 0xf0bc2c, fg: 0x241f18, lines: ["DEEP END", "2.6 m"], worn: 0.3 },
  shallow: { col: 0, row: 3, bg: 0xf2ead6, fg: 0x2f7fae, lines: ["SHALLOW END", "0.4 m"], worn: 0.4 },
  nodiving: { col: 1, row: 3, bg: 0xc0503a, fg: 0xfdf6e6, lines: ["NO DIVING"], worn: 0.45 },
  rules: {
    col: 2, row: 3, tall: 3, bg: 0xf6f1e4, fg: 0x3a362d, band: 0xc0503a, worn: 0.7,
    lines: ["POOL RULES", "1. NO RUNNING ON THE DECK", "2. SHOWER BEFORE SWIMMING", "3. NO GLASS BEYOND THIS POINT", "4. CHILDREN MUST BE SUPERVISED", "5. OBEY THE LIFEGUARD"],
  },
  tickets: { col: 0, row: 4, bg: 0x2f7fae, fg: 0xfdf6e6, lines: ["TICKETS"], worn: 0.3 },
  changing: { col: 1, row: 4, bg: 0x2f7fae, fg: 0xfdf6e6, lines: ["CHANGING", "& LOCKERS"], worn: 0.3 },
  firstaid: { col: 0, row: 5, bg: 0xf6f1e4, fg: 0xc0503a, lines: ["FIRST AID"], worn: 0.2 },
  snacks: { col: 1, row: 5, bg: 0xc0503a, fg: 0xfdf6e6, lines: ["SNACKS · ICES", "CHIPS · TEA"], worn: 0.55 },
  height: { col: 0, row: 6, bg: 0xf0bc2c, fg: 0x241f18, lines: ["YOU MUST BE", "THIS TALL", "1.2 m"], worn: 0.4 },
  lifeguard: { col: 1, row: 6, bg: 0xf0bc2c, fg: 0x241f18, lines: ["LIFEGUARD", "ON DUTY"], worn: 0.35 },
  wavepool: { col: 2, row: 6, bg: 0x1f8fa8, fg: 0xfdf6e6, lines: ["WAVE POOL", "WAVES ON THE HOUR"], worn: 0.4 },
  lazyriver: { col: 3, row: 6, bg: 0x1f8fa8, fg: 0xfdf6e6, lines: ["LAZY RIVER", "→ ONE WAY"], worn: 0.4 },
  slides: { col: 2, row: 2, bg: 0xc0503a, fg: 0xfdf6e6, lines: ["SLIDES ↑", "ONE AT A TIME"], worn: 0.5 },
  carpark: { col: 3, row: 2, bg: 0x2f7fae, fg: 0xfdf6e6, lines: ["CAR PARK", "P"], worn: 0.6 },
  busstop: { col: 3, row: 3, bg: 0xf6f1e4, fg: 0x241f18, band: 0x2f7fae, lines: ["BUS STOP", "SERVICE 4 · 4A", "TO NEON HEIGHTS"], worn: 0.75 },
  lanes: { col: 3, row: 4, bg: 0xf6f1e4, fg: 0x2f7fae, lines: ["LANES", "1  2  3  4  5  6"], worn: 0.5 },
  bucket: { col: 3, row: 5, bg: 0xf0bc2c, fg: 0x241f18, lines: ["SPLASH ZONE", "MIND THE BUCKET"], worn: 0.45 },
  closed: { col: 0, row: 7, bg: 0xf2ead6, fg: 0x8a3a2c, lines: ["POOL 3 CLOSED", "FOR MAINTENANCE"], worn: 0.9 },
  towel: { col: 1, row: 7, bg: 0xf6f1e4, fg: 0x3a362d, lines: ["NO TOWELS", "ON LOUNGERS"], worn: 0.8 },
};

const SIGN_COLS = 4;
const SIGN_ROWS = 8;

/** Atlas rectangle for a sign, in UV space. */
function signUv(id: string): [number, number, number, number] {
  const d = SIGNS[id];
  if (!d) return [0, 0, 1, 1];
  const u0 = d.col / SIGN_COLS;
  const u1 = (d.col + 1) / SIGN_COLS;
  // Canvas V runs down, UV runs up: row 0 is the TOP of the canvas.
  const v1 = 1 - d.row / SIGN_ROWS;
  const v0 = 1 - (d.row + (d.tall ?? 1)) / SIGN_ROWS;
  return [u0, v0, u1, v1];
}

/**
 * Paint the atlas. Everything is drawn in cell-relative coordinates and text
 * is measured and shrunk to fit, so a longer line never runs off its panel —
 * which is the failure mode that makes procedural signage look procedural.
 */
function paintSignAtlas(px: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const g = canvas.getContext("2d");
  if (!g) return canvas;
  const cw = px / SIGN_COLS;
  const ch = px / SIGN_ROWS;
  // Transparent nothing behind the cells: a sign quad only ever samples its
  // own cell, and a filled background would bleed at the mip levels.
  g.clearRect(0, 0, px, px);

  const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
  for (const def of Object.values(SIGNS)) {
    const x = def.col * cw;
    const y = def.row * ch;
    const w = cw;
    const h = ch * (def.tall ?? 1);
    const pad = Math.max(3, w * 0.035);

    // Panel, with a darker rim so the sign reads as a plate with an edge.
    g.fillStyle = hex(def.bg);
    g.fillRect(x + pad * 0.5, y + pad * 0.5, w - pad, h - pad);
    g.strokeStyle = "rgba(0,0,0,0.35)";
    g.lineWidth = Math.max(2, w * 0.012);
    g.strokeRect(x + pad * 0.5, y + pad * 0.5, w - pad, h - pad);

    let top = y + pad;
    if (def.band) {
      g.fillStyle = hex(def.band);
      g.fillRect(x + pad * 0.5, y + pad * 0.5, w - pad, h * 0.17);
      top = y + h * 0.17;
    }

    // Type. The first line is the shout; the rest is the small print.
    const lines = def.lines;
    const inner = w - pad * 3;
    const avail = h - (top - y) - pad * 1.6;
    const slot = avail / lines.length;
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (let i = 0; i < lines.length; i++) {
      const lead = i === 0 && lines.length > 1;
      let size = slot * (lead ? 0.74 : 0.6);
      g.fillStyle = def.band && i === 0 ? "#fdf6e6" : hex(def.fg);
      for (let guard = 0; guard < 12; guard++) {
        g.font = `${lead || lines.length === 1 ? "700" : "600"} ${size.toFixed(1)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
        if (g.measureText(lines[i]).width <= inner) break;
        size *= 0.88;
      }
      g.fillText(lines[i], x + w * 0.5, top + slot * (i + 0.5), inner);
    }

    // Weathering: a sun-bleach wash from the top and two rain streaks. Cheap,
    // and it is the difference between "a sign" and "a sign that has been
    // outdoors since 1954".
    const worn = def.worn ?? 0;
    if (worn > 0) {
      const wash = g.createLinearGradient(x, y, x, y + h);
      wash.addColorStop(0, `rgba(255,252,240,${0.36 * worn})`);
      wash.addColorStop(1, "rgba(255,252,240,0)");
      g.fillStyle = wash;
      g.fillRect(x + pad * 0.5, y + pad * 0.5, w - pad, h - pad);
      g.fillStyle = `rgba(90,88,78,${0.10 * worn})`;
      for (let i = 0; i < 3; i++) {
        const sx = x + pad + (w - pad * 2) * (0.18 + 0.32 * i);
        g.fillRect(sx, y + pad, Math.max(1, w * 0.012), h - pad * 2);
      }
    }
  }
  return canvas;
}

/* ------------------------------------------------------------------------ *
 * The yard
 *
 * Everything the park emits lands here: static geometry bucketed by
 * (group × surface) and merged at flush, repeated furniture into instance
 * buckets, custom-material geometry (water, signage) into its own buckets, and
 * collision boxes registered next to the geometry they belong to — which is
 * the only way the two stay in step.
 * ------------------------------------------------------------------------ */

interface BoxOpts {
  mask?: number;
  bevel?: number;
  yaw?: number;
  pitch?: number;
  roll?: number;
}

interface StaticBucket {
  surf: Surf;
  geo: Geo;
  chunks: THREE.BufferGeometry[];
}

interface CustomBucket {
  mat: THREE.Material;
  geo: Geo;
  chunks: THREE.BufferGeometry[];
  /** Custom buckets are authored in world space and never re-projected. */
  transparent: boolean;
}

interface InstanceBucket {
  surf: Surf;
  geo: THREE.BufferGeometry;
  ms: THREE.Matrix4[];
}

/** Vertices per sealed chunk. Keeps the JS accumulators small enough to stay fast. */
const CHUNK_VERTS = 60000;
/** Below this half-extent a chamfer is invisible and quadruples the vert count. */
const BEVEL_MIN_HALF = 0.09;

class Yard {
  group = "lido";
  bevel: number;

  private buckets = new Map<string, StaticBucket>();
  private customs = new Map<string, CustomBucket>();
  private insts = new Map<string, InstanceBucket>();
  private scratch = new THREE.Box3();
  readonly removers: Array<() => void> = [];
  readonly owned: THREE.BufferGeometry[] = [];
  /** Materials this module made itself and must therefore dispose itself. */
  readonly ownedMats: THREE.Material[] = [];
  readonly ownedTex: THREE.Texture[] = [];
  colliders = 0;
  tris = 0;

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

  /** A `Geo` resolved with the surface's tile density and a transform. */
  emit(s: Surf, g: Geo, m?: THREE.Matrix4): void {
    if (g.empty) return;
    const b = this.bucket(s);
    appendPart(b.geo, g, m, TILE[s.name]);
    this.tris += g.idx.length / 3;
    if (b.geo.pos.length >= CHUNK_VERTS * 3) {
      b.chunks.push(b.geo.toGeometry(1));
      const geo = new Geo();
      geo.uvMode = "raw";
      b.geo = geo;
    }
  }

  /**
   * Geometry on a material this module owns — pool water and the sign atlas.
   * `make` runs once, on first use; the yard disposes what it made.
   */
  custom(key: string, make: () => THREE.Material, g: Geo, m?: THREE.Matrix4, transparent = false): void {
    if (g.empty) return;
    let b = this.customs.get(key);
    if (!b) {
      const mat = make();
      this.ownedMats.push(mat);
      const geo = new Geo();
      geo.uvMode = "raw";
      b = { mat, geo, chunks: [], transparent };
      this.customs.set(key, b);
    }
    appendPart(b.geo, g, m, 1);
    this.tris += g.idx.length / 3;
  }

  /** The workhorse: a chamfered box at a world position. */
  box(
    s: Surf,
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    o: BoxOpts = {},
  ): void {
    if (hx <= 1e-4 || hy <= 1e-4 || hz <= 1e-4) return;
    const bev = Math.min(hx, hy, hz) < BEVEL_MIN_HALF ? 0 : o.bevel ?? this.bevel;
    this.emit(s, bevelBox(hx, hy, hz, bev, o.mask ?? F_ALL), xf(cx, cy, cz, o.yaw ?? 0, o.pitch ?? 0, o.roll ?? 0));
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
    // A yawed box gets an AABB that contains it: over-blocking a corner is far
    // less bad than letting a player stand inside a wall.
    const yaw = o.yaw ?? 0;
    if (Math.abs(yaw) > 1e-3) {
      const c = Math.abs(Math.cos(yaw)), s2 = Math.abs(Math.sin(yaw));
      this.solid(cx, cy, cz, hx * c + hz * s2, hy, hx * s2 + hz * c, IMPACT[s.name], harvest);
    } else {
      this.solid(cx, cy, cz, hx, hy, hz, IMPACT[s.name], harvest);
    }
  }

  /** Register a collider without any geometry: blockers, caps, chute beds. */
  solid(
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    material: ImpactMaterial,
    harvest?: HarvestKind,
    tag?: string,
  ): void {
    if (!this.collision) return;
    this.scratch.min.set(cx - hx, cy - hy, cz - hz);
    this.scratch.max.set(cx + hx, cy + hy, cz + hz);
    this.removers.push(this.collision.addBox(this.scratch, { material, harvest, tag: tag ?? "lido" }));
    this.colliders++;
  }

  /** A cylinder about +Y, optionally tipped. Posts, pipes, bollards, jets. */
  cyl(
    s: Surf,
    cx: number, cy: number, cz: number,
    rBottom: number, rTop: number, h: number,
    o: BoxOpts & { seg?: number; capTop?: boolean; capBottom?: boolean } = {},
  ): void {
    this.emit(
      s,
      cylinder(rBottom, rTop, h, o.seg ?? 10, o.capTop ?? true, o.capBottom ?? false),
      xf(cx, cy, cz, o.yaw ?? 0, o.pitch ?? 0, o.roll ?? 0),
    );
  }

  /** A torus about +Y. Hoops, rings, the coil of hose. */
  ring(s: Surf, cx: number, cy: number, cz: number, r: number, tube: number, seg: number, o: BoxOpts & { tubeSeg?: number; arc?: number } = {}): void {
    this.emit(s, torus(r, tube, seg, o.tubeSeg ?? 8, o.arc ?? TAU), xf(cx, cy, cz, o.yaw ?? 0, o.pitch ?? 0, o.roll ?? 0));
  }

  /**
   * A repeated prop. The prototype is built once, on first use; every later
   * call is a matrix push. This is the difference between 40 draw calls of
   * loungers and 400.
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
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      root.add(mesh);
      this.owned.push(merged);
    }
    this.buckets.clear();

    for (const [key, b] of this.customs) {
      if (!b.geo.empty) b.chunks.push(b.geo.toGeometry(1));
      const merged = mergeParts(b.chunks);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, b.mat);
      mesh.name = `lido:${key}`;
      // Water and signs receive shadows and must not cast them: a transparent
      // sheet casting an opaque shadow onto the pool floor is the single most
      // common way procedural water gives itself away.
      mesh.castShadow = !b.transparent;
      mesh.receiveShadow = true;
      mesh.renderOrder = b.transparent ? 2 : 0;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      root.add(mesh);
      this.owned.push(merged);
    }
    this.customs.clear();

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
      mesh.computeBoundingSphere();
      root.add(mesh);
      this.owned.push(b.geo);
    }
    this.insts.clear();
  }
}

/* ------------------------------------------------------------------------ *
 * The park
 *
 * One shared context, the way `pois.ts` hands each district a `Site`. It
 * carries the yard, the tier, a private RNG, a ground sampler that works with
 * or without terrain, and the two lists the system publishes afterwards.
 * ------------------------------------------------------------------------ */

interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

const rectHas = (r: Rect, x: number, z: number) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
const rectCx = (r: Rect) => (r.x0 + r.x1) * 0.5;
const rectCz = (r: Rect) => (r.z0 + r.z1) * 0.5;

interface Park {
  y: Yard;
  rng: () => number;
  tier: LidoTier;
  terrain?: TerrainLike;
  /** Ground height, with a flat fallback if terrain never booted. */
  ground(x: number, z: number): number;
  /** Resolved terrace tops, all multiples of GRID. */
  main: number;
  entrance: number;
  lower: number;
  pools: LidoPool[];
  /** Points the wetness field is asked to keep wet. */
  wet: THREE.Vector3[];
  /** Make (once) the material the sign atlas is drawn with. */
  signMat: () => THREE.Material;
  /** Make (once) the pool water material. */
  waterMat: () => THREE.Material;
}

/* ------------------------------------------------------------------- paving */

/**
 * Paving with holes in it.
 *
 * A pool deck is a slab with pools cut out of it, and a slab that covers the
 * pool is the whole park ruined — so the deck is rasterised into `cell`-metre
 * bays, bays inside a hole are dropped, and consecutive surviving bays in a
 * row are merged into one box. The result is a few dozen boxes rather than a
 * few thousand, the seams land on a regular grid and read as slab joints
 * (which is exactly what municipal paving is), and every run registers one
 * collider.
 *
 * `surfAt` is what makes the ground around a pool read as WET: the run breaks
 * whenever the surface changes, so the dark band by the water costs nothing
 * extra and follows the pool's actual shape.
 */
function pave(
  p: Park,
  rect: Rect,
  top: number,
  base: Surf,
  opts: {
    holes?: readonly Rect[];
    /**
     * A hole that is not a rectangle — the lazy river's ring. Called with the
     * bay centre and the margin the caller must keep clear of, which is the
     * bay's half-diagonal plus the coping: a bay is only kept when the WHOLE
     * bay is outside the channel, or the deck grows a metre out over the water.
     */
    hole?: (x: number, z: number, margin: number) => boolean;
    cell?: number;
    thickness?: number;
    surfAt?: (x: number, z: number) => Surf;
    harvest?: HarvestKind;
    /** Skip the collider — for a thin painted overlay. */
    noSolid?: boolean;
  } = {},
): void {
  const cell = opts.cell ?? 4;
  const th = opts.thickness ?? 0.5;
  // Pool rects are inflated by the basin wall plus its coping, so the paving
  // stops outside the stone rim rather than out over the water.
  const holes = (opts.holes ?? []).map((h) => ({ x0: h.x0 - 1.4, x1: h.x1 + 1.4, z0: h.z0 - 1.4, z1: h.z1 + 1.4 }));
  const nx = Math.max(1, Math.round((rect.x1 - rect.x0) / cell));
  const nz = Math.max(1, Math.round((rect.z1 - rect.z0) / cell));
  const dx = (rect.x1 - rect.x0) / nx;
  const dz = (rect.z1 - rect.z0) / nz;
  for (let j = 0; j < nz; j++) {
    const z0 = rect.z0 + j * dz;
    const zc = z0 + dz * 0.5;
    let runStart = -1;
    let runSurf: Surf | null = null;
    let runLift = 0;
    const flushRun = (endExclusive: number) => {
      if (runStart < 0 || !runSurf) return;
      const x0 = rect.x0 + runStart * dx;
      const x1 = rect.x0 + endExclusive * dx;
      const hx = (x1 - x0) * 0.5;
      const cx = (x0 + x1) * 0.5;
      const y = top + runLift;
      p.y.box(runSurf, cx, y - th * 0.5, zc, hx, th * 0.5, dz * 0.5, { mask: F_NO_BOTTOM, bevel: 0.03 });
      if (!opts.noSolid) {
        p.y.solid(cx, y - th * 0.5, zc, hx, th * 0.5, dz * 0.5, IMPACT[runSurf.name], opts.harvest);
      }
      runStart = -1;
      runSurf = null;
    };
    for (let i = 0; i < nx; i++) {
      const xc = rect.x0 + i * dx + dx * 0.5;
      let blocked = false;
      for (const h of holes) {
        if (xc > h.x0 && xc < h.x1 && zc > h.z0 && zc < h.z1) { blocked = true; break; }
      }
      if (!blocked && opts.hole) blocked = opts.hole(xc, zc, Math.hypot(dx, dz) * 0.5 + 0.55);
      const s = blocked ? null : opts.surfAt ? opts.surfAt(xc, zc) : base;
      if (!s) {
        flushRun(i);
        continue;
      }
      /**
       * THE LAST 45 cm.
       *
       * `fitDeck` guarantees no ground stands more than half a metre above the
       * terrace, and it cannot do better than that without eroding the park
       * down to nothing: the shelf here is nominally flat at exactly 36 m, but
       * a fifth of it carries up to 0.45 m of terrain noise on top of that, and
       * that fifth is scattered all over the deck rather than gathered at one
       * edge.
       *
       * So the residual is absorbed HERE, by letting an individual bay ride up
       * over the ground it sits on. The deck is dead flat over the 80% that is
       * below the terrace and heaves by a few centimetres over the rest, which
       * is what a fifty-year-old municipal deck looks like anyway — and which
       * is the only version of this where no grass ever grows through the
       * paving. Lifts are quantised so neighbouring bays still merge into runs.
       */
      const lift = Math.min(0.6, Math.max(0, Math.ceil((p.ground(xc, zc) + 0.05 - top) / 0.05) * 0.05));
      if (runStart < 0) {
        runStart = i;
        runSurf = s;
        runLift = lift;
      } else if (runSurf && (runSurf.name !== s.name || runSurf.color !== s.color || lift !== runLift)) {
        flushRun(i);
        runStart = i;
        runSurf = s;
        runLift = lift;
      }
    }
    flushRun(nx);
  }
}

/**
 * The mass a terrace stands on.
 *
 * On the uphill side this is buried and costs nothing. On the seaward side it
 * is the retaining wall the whole park is built on, and it is the difference
 * between a lido cut into a hillside and a car park floating over one.
 *
 * It is built the same way the paving is — rasterised into bays, bays inside a
 * hole dropped, survivors run-merged — for one reason that is not obvious and
 * cost an afternoon: A SOLID BLOCK UNDER THE WHOLE TERRACE WOULD FILL THE
 * POOLS. Every basin and the lazy river channel is a void BELOW deck level, so
 * a player standing on a pool floor would be standing inside the terrace's own
 * collider and get shoved out of the water. The holes are inflated by 1.5 m so
 * the mass never touches a basin wall; the gap is a metre underground and
 * nobody will ever see it.
 *
 * Each run finds its own bottom from the ground under it, so the mass follows
 * the hillside down instead of hanging one enormous box off the highest corner.
 */
function terraceMass(
  p: Park,
  rect: Rect,
  top: number,
  face: Surf,
  lip: Surf,
  holes: readonly Rect[] = [],
  hole?: (x: number, z: number, margin: number) => boolean,
): number {
  const grown = holes.map((h) => ({ x0: h.x0 - 1.5, x1: h.x1 + 1.5, z0: h.z0 - 1.5, z1: h.z1 + 1.5 }));
  const cell = 4;
  const nx = Math.max(1, Math.round((rect.x1 - rect.x0) / cell));
  const nz = Math.max(1, Math.round((rect.z1 - rect.z0) / cell));
  const dx = (rect.x1 - rect.x0) / nx;
  const dz = (rect.z1 - rect.z0) / nz;
  const massTop = top - 0.52;
  let deepest = 0;
  for (let j = 0; j < nz; j++) {
    const z0 = rect.z0 + j * dz;
    const zc = z0 + dz * 0.5;
    let runStart = -1;
    const flushRun = (endExclusive: number) => {
      if (runStart < 0) return;
      const x0 = rect.x0 + runStart * dx;
      const x1 = rect.x0 + endExclusive * dx;
      let lowest = massTop;
      for (let k = 0; k <= 6; k++) {
        const x = lerp(x0, x1, k / 6);
        lowest = Math.min(lowest, p.ground(x, z0), p.ground(x, z0 + dz));
      }
      const depth = Math.max(0.9, massTop - lowest + 1.4);
      deepest = Math.max(deepest, depth);
      p.y.solidBox(
        face, (x0 + x1) * 0.5, massTop - depth * 0.5, zc,
        (x1 - x0) * 0.5, depth * 0.5, dz * 0.5, "stone",
        { bevel: 0.05, mask: F_NO_BOTTOM },
      );
      runStart = -1;
    };
    for (let i = 0; i < nx; i++) {
      const xc = rect.x0 + i * dx + dx * 0.5;
      let blocked = false;
      for (const h of grown) {
        if (xc > h.x0 && xc < h.x1 && zc > h.z0 && zc < h.z1) { blocked = true; break; }
      }
      if (!blocked && hole) blocked = hole(xc, zc, Math.hypot(dx, dz) * 0.5 + 1.5);
      if (blocked) flushRun(i);
      else if (runStart < 0) runStart = i;
    }
    flushRun(nx);
  }
  // Coping lip: 14 cm proud, all the way round. It is the shadow line that
  // tells the eye where the terrace ends and the drop begins.
  const hx = (rect.x1 - rect.x0) * 0.5;
  const hz = (rect.z1 - rect.z0) * 0.5;
  const cx = rectCx(rect);
  const cz = rectCz(rect);
  for (const [ox, oz, ahx, ahz] of [
    [0, hz, hx + 0.14, 0.14],
    [0, -hz, hx + 0.14, 0.14],
    [hx, 0, 0.14, hz + 0.14],
    [-hx, 0, 0.14, hz + 0.14],
  ]) {
    p.y.box(lip, cx + ox, top + 0.07, cz + oz, ahx, 0.09, ahz, { bevel: 0.03 });
  }
  return deepest;
}

/* --------------------------------------------------------------------- pools */

interface PoolSpec {
  id: string;
  name: string;
  /** The water surface footprint. */
  rect: Rect;
  /** Deck level the pool is cut into. */
  deck: number;
  /** Depth at the `z0` (north) end and at the `z1` (south) end, metres. */
  depthA: number;
  depthB: number;
  /** Shelve along "z" (default) or "x". */
  axis?: "x" | "z";
  /** Tile colour of the basin walls. */
  tile?: number;
  /** Steps into the water at the shallow end. */
  steps?: boolean;
  /** Lane ropes across the pool, and how many lanes. */
  lanes?: number;
}

/**
 * A pool: basin, shelving floor, waterline band, coping and water.
 *
 * Two decisions in here are load-bearing for how the park PLAYS, not for how
 * it looks:
 *
 *  · THE FLOOR IS REAL COLLISION, in `tier.shelf` bands. So the shallow end is
 *    somewhere you can run — which is what makes a wave pool a place to fight
 *    rather than a hole — and the deep end is somewhere you are slow and
 *    exposed. Under water the steps are invisible; in the 40 cm end they are
 *    3 cm and you feel nothing.
 *  · THE BASIN WALLS STOP 45 cm BELOW THE COPING. Registered flush to the top
 *    they would fence the pool off completely: a capsule cannot climb, so the
 *    water would be scenery. Stopping them short means you walk off the edge
 *    and drop in, and the shallow end (or the corner steps) is how you get out.
 */
function pool(p: Park, spec: PoolSpec): LidoPool {
  const { rect, deck } = spec;
  const tile = surf("concrete", spec.tile ?? TILE_TURQ);
  const pale = surf("concrete", TILE_PALE);
  /**
   * Three floor tints by depth rather than one.
   *
   * Water this clear hides nothing, so the only depth cue a still frame has is
   * the floor's own value — and a pool with one flat floor colour reads as a
   * sheet of cyan paint whatever its geometry is doing underneath. Three steps
   * is enough: the eye reads the gradient, not the bands.
   */
  const floorTints = [surf("concrete", TILE_FLOOR), surf("concrete", 0x7cc9d6), surf("concrete", 0x4fa8bd)];
  const coping = surf("concrete", COPING);
  const axis = spec.axis ?? "z";
  const deepest = Math.max(spec.depthA, spec.depthB);
  const hx = (rect.x1 - rect.x0) * 0.5;
  const hz = (rect.z1 - rect.z0) * 0.5;
  const cx = rectCx(rect);
  const cz = rectCz(rect);
  /** Freeboard: real pools run their water a hand's width below the coping. */
  const waterY = deck - 0.22;

  // --- basin walls. Thickness is outboard of the water rect, so the water
  // surface exactly meets the tile.
  const WT = 0.45;
  const wallTop = deck - 0.45;
  for (const [ox, oz, ahx, ahz] of [
    [0, -hz - WT * 0.5, hx + WT, WT * 0.5],
    [0, hz + WT * 0.5, hx + WT, WT * 0.5],
    [-hx - WT * 0.5, 0, WT * 0.5, hz],
    [hx + WT * 0.5, 0, WT * 0.5, hz],
  ]) {
    const wallBottom = deck - deepest - 1.0;
    const h = (wallTop - wallBottom) * 0.5;
    p.y.box(tile, cx + ox, wallTop - h, cz + oz, ahx, h + 0.45, ahz, { bevel: 0.04 });
    p.y.solid(cx + ox, wallTop - h, cz + oz, ahx, h, ahz, "concrete", "stone");
    // The pale band at the waterline: 40 cm of lighter tile, which is what
    // makes a pool read as a pool in a still frame.
    p.y.box(pale, cx + ox, waterY - 0.2, cz + oz, ahx * 1.001, 0.2, ahz * 1.001, { bevel: 0 });
  }

  // --- shelving floor, in bands along the chosen axis.
  const bands = Math.max(4, Math.round(p.tier.shelf));
  for (let i = 0; i < bands; i++) {
    const t0 = i / bands;
    const t1 = (i + 1) / bands;
    const tm = (t0 + t1) * 0.5;
    const d = lerp(spec.depthA, spec.depthB, tm);
    const floorTop = deck - d;
    const thick = 0.8;
    const floorS = floorTints[Math.min(2, Math.floor((d / Math.max(0.6, deepest)) * 3))];
    if (axis === "z") {
      const z0 = lerp(rect.z0, rect.z1, t0);
      const z1 = lerp(rect.z0, rect.z1, t1);
      p.y.box(floorS, cx, floorTop - thick * 0.5, (z0 + z1) * 0.5, hx, thick * 0.5, (z1 - z0) * 0.5, { mask: F_NO_BOTTOM, bevel: 0.02 });
      p.y.solid(cx, floorTop - thick * 0.5, (z0 + z1) * 0.5, hx, thick * 0.5, (z1 - z0) * 0.5, "concrete", "stone");
    } else {
      const x0 = lerp(rect.x0, rect.x1, t0);
      const x1 = lerp(rect.x0, rect.x1, t1);
      p.y.box(floorS, (x0 + x1) * 0.5, floorTop - thick * 0.5, cz, (x1 - x0) * 0.5, thick * 0.5, hz, { mask: F_NO_BOTTOM, bevel: 0.02 });
      p.y.solid((x0 + x1) * 0.5, floorTop - thick * 0.5, cz, (x1 - x0) * 0.5, thick * 0.5, hz, "concrete", "stone");
    }
  }

  /**
   * The coping: a wide stone rim, slightly proud, that the deck's paving stops
   * outside of.
   *
   * IT IS 1.7 m WIDE FOR A REASON, and the reason is visible in a photograph
   * rather than in the code. `pave` drops a bay whenever any part of it would
   * overhang the water, so it stops a bay's half-diagonal clear of the pool —
   * about 1.4 m. A 55 cm coping therefore left an 85 cm slot all the way round
   * every pool, looking down onto the top of the terrace mass half a metre
   * below. It reads as a trench. The coping has to be at least as wide as the
   * gap the paving leaves, and a broad stone surround is what a real pool has.
   */
  const CW = 1.7;
  for (const [ox, oz, ahx, ahz] of [
    [0, -hz - CW * 0.5, hx + CW, CW * 0.5],
    [0, hz + CW * 0.5, hx + CW, CW * 0.5],
    [-hx - CW * 0.5, 0, CW * 0.5, hz],
    [hx + CW * 0.5, 0, CW * 0.5, hz],
  ]) {
    p.y.box(coping, cx + ox, deck - 0.09, cz + oz, ahx, 0.11, ahz, { bevel: 0.035 });
    p.y.solid(cx + ox, deck - 0.25, cz + oz, ahx, 0.25, ahz, "concrete", "stone");
  }

  // --- the water. One horizontal face on the shared transparent material, so
  // every pool in the park is a single extra draw call.
  {
    const g = new Geo();
    g.uvMode = "raw";
    g.quad(
      rect.x0, waterY, rect.z0,
      rect.x1, waterY, rect.z0,
      rect.x1, waterY, rect.z1,
      rect.x0, waterY, rect.z1,
      0, 1, 0,
    );
    p.y.custom("water", p.waterMat, g, undefined, true);
  }

  // --- steps out of the shallow end, in the corner, so the pool is never a
  // trap even at the deep end (you swim to the shallow end and walk).
  if (spec.steps !== false) {
    const shallowAtZ0 = spec.depthA < spec.depthB;
    const sz = shallowAtZ0 ? rect.z0 + 1.4 : rect.z1 - 1.4;
    const sx = rect.x0 + 2.2;
    for (let i = 0; i < 3; i++) {
      const y = deck - 0.4 - i * 0.34;
      p.y.box(pale, sx, y - 0.17, sz + (shallowAtZ0 ? i * 0.55 : -i * 0.55), 1.5, 0.17, 0.28, { bevel: 0.03 });
      p.y.solid(sx, y - 0.17, sz + (shallowAtZ0 ? i * 0.55 : -i * 0.55), 1.5, 0.17, 0.28, "concrete", "stone");
    }
  }

  // --- lane ropes: floats on a line, alternating colour, strung across the
  // short axis. Two instance buckets for the whole park.
  if (spec.lanes && spec.lanes > 1) {
    const n = spec.lanes;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const count = Math.max(6, Math.round((axis === "z" ? hx * 2 : hz * 2) / 0.9));
      for (let k = 0; k < count; k++) {
        const u = (k + 0.5) / count;
        const x = axis === "z" ? lerp(rect.x0, rect.x1, u) : lerp(rect.x0, rect.x1, t);
        const z = axis === "z" ? lerp(rect.z0, rect.z1, t) : lerp(rect.z0, rect.z1, u);
        const blue = k % 2 === 0;
        p.y.inst(
          blue ? "float-blue" : "float-white",
          surf("rubber", blue ? MUNI_BLUE : 0xf2ede0),
          () => cylinder(0.15, 0.15, 0.42, 6, true, true),
          xf(x, waterY + 0.08, z, 0, axis === "z" ? Math.PI / 2 : 0, axis === "z" ? 0 : Math.PI / 2),
        );
      }
    }
  }

  // --- wet ground all round the rim. The deck by a pool is never dry.
  const perim = Math.max(4, Math.round((hx + hz) / 3));
  for (let i = 0; i < perim; i++) {
    const t = (i + 0.5) / perim;
    p.wet.push(new THREE.Vector3(lerp(rect.x0, rect.x1, t), deck + 0.08, rect.z0 - 1.1));
    p.wet.push(new THREE.Vector3(lerp(rect.x0, rect.x1, t), deck + 0.08, rect.z1 + 1.1));
  }

  const entry: LidoPool = {
    id: spec.id,
    name: spec.name,
    center: new THREE.Vector3(cx, waterY, cz),
    hx,
    hz,
    depth: deepest,
  };
  p.pools.push(entry);
  return entry;
}

/* ------------------------------------------------------------------- fittings */

/**
 * A flight of steps between two levels. Real steps, each one solid, because
 * the whole park is built on terraces and a terrace you cannot walk off is a
 * wall. Rise is held near 18 cm — the height a capsule steps up without a jump.
 */
function stairs(
  p: Park,
  x: number, z: number,
  fromY: number, toY: number,
  width: number,
  dir: "north" | "south" | "east" | "west",
  s: Surf,
): void {
  const rise = Math.abs(toY - fromY);
  if (rise < 0.05) return;
  const n = Math.max(1, Math.round(rise / 0.18));
  const step = rise / n;
  const tread = 0.34;
  const dx = dir === "east" ? 1 : dir === "west" ? -1 : 0;
  const dz = dir === "south" ? 1 : dir === "north" ? -1 : 0;
  const down = toY < fromY;
  for (let i = 0; i < n; i++) {
    const y = down ? fromY - (i + 1) * step : fromY + (i + 1) * step;
    const cx = x + dx * (i + 0.5) * tread;
    const cz = z + dz * (i + 0.5) * tread;
    const hx = dx !== 0 ? tread * 0.5 : width * 0.5;
    const hz = dz !== 0 ? tread * 0.5 : width * 0.5;
    // Each tread is a solid to its own level plus a skirt, so the flight is one
    // continuous ramp of collision rather than a row of floating slabs.
    const h = (y - Math.min(fromY, toY) + 0.6) * 0.5;
    p.y.box(s, cx, y - h, cz, hx, h, hz, { mask: F_NO_BOTTOM, bevel: 0.03 });
    p.y.solid(cx, y - h, cz, hx, h, hz, "concrete", "stone");
  }
}

/** A tubular handrail with posts. Poolside, stairs, the diving stack. */
function railing(
  p: Park,
  x0: number, z0: number, x1: number, z1: number,
  y: number, s: Surf, height = 1.06,
): void {
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 0.2) return;
  const yaw = Math.atan2(dx, dz);
  const posts = Math.max(2, Math.round(len / 2.1));
  for (let i = 0; i <= posts; i++) {
    const t = i / posts;
    p.y.cyl(s, x0 + dx * t, y + height * 0.5, z0 + dz * t, 0.045, 0.045, height, { seg: 6 });
  }
  for (const hy of [height, height * 0.55]) {
    p.y.cyl(s, x0 + dx * 0.5, y + hy, z0 + dz * 0.5, 0.045, 0.045, len, { seg: 6, yaw, pitch: Math.PI / 2 });
  }
}

/** A run of clipped hedge. Instanced, in 2 m lengths, with a little jitter. */
function hedgeRun(p: Park, x0: number, z0: number, x1: number, z1: number, y: number, h = 1.3): void {
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  const n = Math.max(1, Math.round(len / 2));
  const yaw = Math.atan2(dx, dz);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const jitter = (p.rng() - 0.5) * 0.12;
    p.y.inst(
      "hedge",
      surf("foliage", HEDGE),
      () => bevelBox(1.0, 0.65, 0.55, 0.14),
      xf(x0 + dx * t, y + h * 0.5 + jitter, z0 + dz * t, yaw),
    );
  }
  // One collider for the whole run: a hedge is cover, and 40 boxes to describe
  // a straight line is a waste of the broadphase.
  const hx = Math.abs(dx) * 0.5 + 0.6;
  const hz = Math.abs(dz) * 0.5 + 0.6;
  p.y.solid(x0 + dx * 0.5, y + h * 0.5, z0 + dz * 0.5, hx, h * 0.5, hz, "grass", "wood");
}

/** Chain-link fence: posts, two rails, and a mesh panel that reads at distance. */
function fenceRun(p: Park, x0: number, z0: number, x1: number, z1: number, y: number, h = 2.2): void {
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 0.5) return;
  const yaw = Math.atan2(dx, dz);
  const posts = Math.max(2, Math.round(len / 3));
  const steel = surf("metalPanel", STEEL);
  for (let i = 0; i <= posts; i++) {
    const t = i / posts;
    p.y.cyl(steel, x0 + dx * t, y + h * 0.5, z0 + dz * t, 0.06, 0.06, h, { seg: 6 });
  }
  for (const hy of [h - 0.08, h * 0.5]) {
    p.y.cyl(steel, x0 + dx * 0.5, y + hy, z0 + dz * 0.5, 0.04, 0.04, len, { seg: 6, yaw, pitch: Math.PI / 2 });
  }
  // The mesh itself: one thin slab. It is 4 cm of geometry standing in for a
  // texture we would otherwise have to author, and at 10 m it is honest.
  p.y.box(surf("metalPanel", STEEL), x0 + dx * 0.5, y + h * 0.5, z0 + dz * 0.5, len * 0.5, h * 0.5 - 0.1, 0.02, { yaw, bevel: 0 });
  p.y.solid(x0 + dx * 0.5, y + h * 0.5, z0 + dz * 0.5, Math.abs(dx) * 0.5 + 0.1, h * 0.5, Math.abs(dz) * 0.5 + 0.1, "metal", "metal");
}

/* -------------------------------------------------------------------- signs */

/**
 * A sign panel standing in the world, sampling its cell of the atlas.
 *
 * Panels are emitted as a single quad on the shared atlas material with a
 * plate behind them, so the whole park's typography is one draw call. The
 * plate matters: a floating quad has no thickness and reads as a decal, and a
 * 4 cm plate with a bevel throws the shadow that says "screwed to a post".
 */
function signPanel(
  p: Park,
  id: string,
  cx: number, cy: number, cz: number,
  width: number,
  yaw: number,
  o: { postsTo?: number; plate?: Surf; both?: boolean } = {},
): void {
  const def = SIGNS[id];
  if (!def) return;
  const h = (width * (def.tall ?? 1)) / 2;
  const [u0, v0, u1, v1] = signUv(id);
  const nx = Math.sin(yaw), nz = Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const hw = width * 0.5, hh = h * 0.5;
  const eps = 0.035;
  const g = new Geo();
  g.uvMode = "raw";
  const corner = (sr: number, su: number) => [
    cx + rx * hw * sr + nx * eps,
    cy + hh * su,
    cz + rz * hw * sr + nz * eps,
  ];
  const a = corner(-1, -1), b = corner(1, -1), c = corner(1, 1), d = corner(-1, 1);
  g.quadUv(
    [a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]],
    [nx, 0, nz],
    [u0, v0, u1, v0, u1, v1, u0, v1],
  );
  if (o.both) {
    // Double-sided signs are read from both approaches; the back is mirrored so
    // the text runs the right way round rather than backwards.
    const a2 = [cx + rx * hw + -nx * eps, cy - hh, cz + rz * hw - nz * eps];
    const b2 = [cx - rx * hw - nx * eps, cy - hh, cz - rz * hw - nz * eps];
    const c2 = [cx - rx * hw - nx * eps, cy + hh, cz - rz * hw - nz * eps];
    const d2 = [cx + rx * hw - nx * eps, cy + hh, cz + rz * hw - nz * eps];
    g.quadUv(
      [a2[0], a2[1], a2[2], b2[0], b2[1], b2[2], c2[0], c2[1], c2[2], d2[0], d2[1], d2[2]],
      [-nx, 0, -nz],
      [u0, v0, u1, v0, u1, v1, u0, v1],
    );
  }
  p.y.custom("signs", p.signMat, g);

  const plate = o.plate ?? surf("metalPanel", STEEL);
  p.y.box(plate, cx, cy, cz, hw + 0.06, hh + 0.06, 0.035, { yaw, bevel: 0.02 });
  if (o.postsTo !== undefined) {
    const steel = surf("metalPanel", STEEL);
    const legs = width > 2.4 ? [-1, 1] : [0];
    for (const sgn of legs) {
      const px = cx + rx * hw * 0.62 * sgn;
      const pz = cz + rz * hw * 0.62 * sgn;
      const top = cy - hh;
      const hgt = Math.max(0.2, top - o.postsTo);
      p.y.cyl(steel, px, o.postsTo + hgt * 0.5, pz, 0.05, 0.05, hgt, { seg: 6 });
      p.y.solid(px, o.postsTo + hgt * 0.5, pz, 0.09, hgt * 0.5, 0.09, "metal", "metal");
    }
  }
}

/** A sign stencilled flat on the ground: NO RUNNING, lane numbers, bay marks. */
function signFloor(p: Park, id: string, cx: number, cy: number, cz: number, width: number, yaw: number): void {
  const def = SIGNS[id];
  if (!def) return;
  const depth = (width * (def.tall ?? 1)) / 2;
  const [u0, v0, u1, v1] = signUv(id);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const hw = width * 0.5, hd = depth * 0.5;
  const y = cy + 0.03;
  const g = new Geo();
  g.uvMode = "raw";
  const corner = (sr: number, sf: number) => [cx + rx * hw * sr + fx * hd * sf, y, cz + rz * hw * sr + fz * hd * sf];
  const a = corner(-1, -1), b = corner(1, -1), c = corner(1, 1), d = corner(-1, 1);
  g.quadUv(
    [a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]],
    [0, 1, 0],
    [u0, v0, u1, v0, u1, v1, u0, v1],
  );
  p.y.custom("signs", p.signMat, g);
}

/* ----------------------------------------------------------------- buildings */

interface ShedOpts {
  wall: Surf;
  roof: Surf;
  trim: Surf;
  /** An opening per side, as a fraction along the wall and a width. */
  door?: { side: "n" | "s" | "e" | "w"; w: number; t?: number };
  /** A shuttered serving hatch: an opening with a roller shutter half down. */
  hatch?: { side: "n" | "s" | "e" | "w"; w: number; t?: number; drop?: number };
  /** A canopy projecting from one side. */
  awning?: { side: "n" | "s" | "e" | "w"; depth: number; color: number };
  /** Parapet height above the roof slab. */
  parapet?: number;
}

/**
 * The park's one building type, in four sizes: kiosk, changing block, plant
 * room, first-aid hut. Flat roofs with a projecting fascia — because a flat
 * roof with no eave is the flattest thing in 3D, and 20 cm of overhang buys
 * the shadow line that says the wall has a top.
 *
 * The roof slab is solid, so every hut in the park is a place to fight from.
 */
function shed(p: Park, r: Rect, base: number, height: number, o: ShedOpts): void {
  const T = 0.3;
  const cx = rectCx(r), cz = rectCz(r);
  const hx = (r.x1 - r.x0) * 0.5, hz = (r.z1 - r.z0) * 0.5;

  // Floor slab, so an interior is a floor rather than a hole in the deck.
  p.y.box(surf("concrete", DECK_DRY), cx, base - 0.12, cz, hx, 0.12, hz, { mask: F_NO_BOTTOM, bevel: 0.02 });

  const sides: Array<{ id: "n" | "s" | "e" | "w"; ax: "x" | "z"; c: number; a0: number; a1: number }> = [
    { id: "n", ax: "x", c: r.z0 + T * 0.5, a0: r.x0, a1: r.x1 },
    { id: "s", ax: "x", c: r.z1 - T * 0.5, a0: r.x0, a1: r.x1 },
    { id: "w", ax: "z", c: r.x0 + T * 0.5, a0: r.z0, a1: r.z1 },
    { id: "e", ax: "z", c: r.x1 - T * 0.5, a0: r.z0, a1: r.z1 },
  ];

  for (const side of sides) {
    const len = side.a1 - side.a0;
    const openings: Array<{ a: number; w: number; y0: number; y1: number; shutter?: number }> = [];
    if (o.door && o.door.side === side.id) {
      const t = o.door.t ?? 0.5;
      openings.push({ a: side.a0 + len * t, w: o.door.w, y0: base, y1: base + Math.min(2.2, height - 0.4) });
    }
    if (o.hatch && o.hatch.side === side.id) {
      const t = o.hatch.t ?? 0.5;
      openings.push({
        a: side.a0 + len * t, w: o.hatch.w,
        y0: base + 1.05, y1: base + Math.min(2.3, height - 0.35),
        shutter: o.hatch.drop ?? 0.45,
      });
    }
    // Solid runs between the openings.
    const cuts = openings.map((x) => [x.a - x.w * 0.5, x.a + x.w * 0.5]).sort((a, b) => a[0] - b[0]);
    let cursor = side.a0;
    const emitRun = (a0: number, a1: number, y0: number, y1: number) => {
      if (a1 - a0 < 0.02 || y1 - y0 < 0.02) return;
      const am = (a0 + a1) * 0.5;
      const ah = (a1 - a0) * 0.5;
      const ym = (y0 + y1) * 0.5;
      const yh = (y1 - y0) * 0.5;
      if (side.ax === "x") {
        p.y.box(o.wall, am, ym, side.c, ah, yh, T * 0.5, { bevel: 0.04 });
        p.y.solid(am, ym, side.c, ah, yh, T * 0.5, IMPACT[o.wall.name], "stone");
      } else {
        p.y.box(o.wall, side.c, ym, am, T * 0.5, yh, ah, { bevel: 0.04 });
        p.y.solid(side.c, ym, am, T * 0.5, yh, ah, IMPACT[o.wall.name], "stone");
      }
    };
    for (const [a0, a1] of cuts) {
      emitRun(cursor, a0, base, base + height);
      cursor = a1;
    }
    emitRun(cursor, side.a1, base, base + height);
    // Head and cill above/below each opening, plus the shutter if it has one.
    for (const op of openings) {
      emitRun(op.a - op.w * 0.5, op.a + op.w * 0.5, op.y1, base + height);
      if (op.y0 > base) emitRun(op.a - op.w * 0.5, op.a + op.w * 0.5, base, op.y0);
      if (op.shutter) {
        const drop = op.shutter * (op.y1 - op.y0);
        const ym = op.y1 - drop * 0.5;
        // Corrugated slats, half pulled down, and a counter board under it.
        if (side.ax === "x") {
          p.y.box(surf("corrugated", 0x9aa2a4), op.a, ym, side.c - 0.02, op.w * 0.5, drop * 0.5, 0.05, { bevel: 0 });
          p.y.box(o.trim, op.a, op.y0 - 0.06, side.c - 0.24, op.w * 0.5 + 0.12, 0.07, 0.34, { bevel: 0.03 });
        } else {
          p.y.box(surf("corrugated", 0x9aa2a4), side.c - 0.02, ym, op.a, 0.05, drop * 0.5, op.w * 0.5, { bevel: 0 });
          p.y.box(o.trim, side.c - 0.24, op.y0 - 0.06, op.a, 0.34, 0.07, op.w * 0.5 + 0.12, { bevel: 0.03 });
        }
      }
    }
  }

  // Roof slab with a 22 cm overhang and a fascia band in the trim colour.
  const roofY = base + height;
  p.y.box(o.roof, cx, roofY + 0.13, cz, hx + 0.22, 0.13, hz + 0.22, { bevel: 0.04 });
  p.y.solid(cx, roofY + 0.13, cz, hx + 0.22, 0.13, hz + 0.22, IMPACT[o.roof.name], "stone");
  p.y.box(o.trim, cx, roofY + 0.02, cz, hx + 0.26, 0.06, hz + 0.26, { bevel: 0.02 });
  if (o.parapet) {
    for (const [ox, oz, ahx, ahz] of [
      [0, hz + 0.14, hx + 0.24, 0.1],
      [0, -hz - 0.14, hx + 0.24, 0.1],
      [hx + 0.14, 0, 0.1, hz + 0.24],
      [-hx - 0.14, 0, 0.1, hz + 0.24],
    ]) {
      p.y.box(o.wall, cx + ox, roofY + 0.26 + o.parapet * 0.5, cz + oz, ahx, o.parapet * 0.5, ahz, { bevel: 0.03 });
      p.y.solid(cx + ox, roofY + 0.26 + o.parapet * 0.5, cz + oz, ahx, o.parapet * 0.5, ahz, IMPACT[o.wall.name], "stone");
    }
  }

  if (o.awning) {
    const d = o.awning.depth;
    const aw = surf("fabric", o.awning.color);
    const sgnX = o.awning.side === "e" ? 1 : o.awning.side === "w" ? -1 : 0;
    const sgnZ = o.awning.side === "s" ? 1 : o.awning.side === "n" ? -1 : 0;
    const ax = cx + sgnX * (hx + d * 0.5);
    const az = cz + sgnZ * (hz + d * 0.5);
    const ahx = sgnX !== 0 ? d * 0.5 : hx + 0.2;
    const ahz = sgnZ !== 0 ? d * 0.5 : hz + 0.2;
    // Tipped 9°, so it sheds water and is not another horizontal plane.
    p.y.box(aw, ax, roofY - 0.35, az, ahx, 0.05, ahz, {
      bevel: 0.02,
      pitch: sgnZ !== 0 ? sgnZ * 0.16 : 0,
      roll: sgnX !== 0 ? -sgnX * 0.16 : 0,
    });
    const steel = surf("metalPanel", STEEL);
    for (const sgn of [-1, 1]) {
      const px = sgnX !== 0 ? ax : cx + sgn * (hx - 0.3);
      const pz = sgnZ !== 0 ? az : cz + sgn * (hz - 0.3);
      p.y.cyl(steel, px, roofY - 0.75, pz, 0.04, 0.04, 0.8, { seg: 6 });
    }
  }
}

/* ------------------------------------------------------------------ furniture
 *
 * Prototypes, in local space with the origin on the ground. Every one of these
 * is placed by the dozen, so all of them go through `Yard.inst` and cost one
 * draw call each for the whole park.
 * ---------------------------------------------------------------------- */

/** Lounger frame: legs, rails and a reclined back. */
function loungerFrame(): Geo {
  const g = new Geo();
  const add = (b: Geo, m: THREE.Matrix4) => appendPart(g, b, m, 1);
  const bar = (l: number, t: number) => bevelBox(l * 0.5, t, t, t * 0.6);
  // Four legs.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) add(bevelBox(0.035, 0.16, 0.035, 0.012), xf(sx * 0.32, 0.16, sz * 0.72));
  }
  // Bed rails and slats.
  add(bar(1.7, 0.04), xf(0, 0.34, -0.36, 0, 0, 0));
  for (const sx of [-1, 1]) add(bar(1.5, 0.035), xf(sx * 0.34, 0.34, 0, Math.PI / 2));
  // The back, tipped up 34° — the single detail that makes it a lounger.
  add(bevelBox(0.34, 0.03, 0.42, 0.02), xf(0, 0.52, 0.5, 0, -0.6));
  return g;
}

/** The pad on top of it. Separate bucket so the fabric can be its own colour. */
function loungerPad(): Geo {
  const g = new Geo();
  appendPart(g, bevelBox(0.32, 0.045, 0.62, 0.03), xf(0, 0.4, -0.14), 1);
  appendPart(g, bevelBox(0.31, 0.04, 0.4, 0.03), xf(0, 0.57, 0.5, 0, -0.6), 1);
  return g;
}

/** Parasol: pole plus a shallow cone. */
function parasolPole(): Geo {
  const g = new Geo();
  appendPart(g, cylinder(0.05, 0.045, 2.3, 8), xf(0, 1.15, 0), 1);
  appendPart(g, cylinder(0.34, 0.3, 0.09, 10), xf(0, 0.05, 0), 1);
  return g;
}

function parasolCanopy(): Geo {
  const g = new Geo();
  // A cone with a tiny top disc: a parasol is a shallow pyramid, not a dome.
  appendPart(g, cylinder(1.55, 0.09, 0.42, 10, true, true), xf(0, 2.34, 0), 1);
  return g;
}

/** A tall lifeguard chair with a ladder up the back. */
function lifeguardChair(): Geo {
  const g = new Geo();
  const add = (b: Geo, m: THREE.Matrix4) => appendPart(g, b, m, 1);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) add(bevelBox(0.05, 1.15, 0.05, 0.02), xf(sx * 0.42, 1.15, sz * 0.4));
  }
  add(bevelBox(0.5, 0.05, 0.45, 0.02), xf(0, 2.3, 0));
  add(bevelBox(0.5, 0.42, 0.05, 0.02), xf(0, 2.72, 0.42));
  for (const sx of [-1, 1]) add(bevelBox(0.05, 0.3, 0.05, 0.02), xf(sx * 0.45, 2.6, -0.4));
  add(bevelBox(0.5, 0.04, 0.04, 0.015), xf(0, 2.9, -0.4));
  // Ladder rungs.
  for (let i = 0; i < 5; i++) add(bevelBox(0.36, 0.025, 0.025, 0.01), xf(0, 0.4 + i * 0.4, -0.42));
  // Footrest.
  add(bevelBox(0.44, 0.03, 0.04, 0.015), xf(0, 1.15, 0.4));
  return g;
}

/** A three-armed turnstile on a post. */
function turnstile(): Geo {
  const g = new Geo();
  appendPart(g, cylinder(0.13, 0.11, 1.0, 10), xf(0, 0.5, 0), 1);
  appendPart(g, cylinder(0.09, 0.09, 0.16, 10), xf(0, 1.02, 0), 1);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    appendPart(g, cylinder(0.035, 0.035, 0.78, 6), xf(Math.cos(a) * 0.39, 1.02, Math.sin(a) * 0.39, 0, Math.PI / 2, 0).multiply(new THREE.Matrix4().makeRotationY(-a)), 1);
  }
  return g;
}

/** Safety bollard with a reflective collar moulded in. */
function bollard(): Geo {
  const g = new Geo();
  appendPart(g, cylinder(0.13, 0.11, 0.9, 10), xf(0, 0.45, 0), 1);
  appendPart(g, cylinder(0.14, 0.14, 0.1, 10), xf(0, 0.72, 0), 1);
  return g;
}

/** A litter bin, mesh body and a domed cap. */
function litterBin(): Geo {
  const g = new Geo();
  appendPart(g, cylinder(0.28, 0.31, 0.78, 10), xf(0, 0.39, 0), 1);
  appendPart(g, cylinder(0.33, 0.28, 0.1, 10), xf(0, 0.83, 0), 1);
  return g;
}

/** A cast-iron drain grate, sitting flush. */
function drainGrate(): Geo {
  const g = new Geo();
  appendPart(g, bevelBox(0.3, 0.03, 0.3, 0.02), xf(0, 0.015, 0), 1);
  for (let i = -2; i <= 2; i++) appendPart(g, bevelBox(0.26, 0.02, 0.025, 0), xf(0, 0.05, i * 0.1), 1);
  return g;
}

/** A rubber ring. Also the animated one that drifts round the river. */
function rubberRing(): Geo {
  return torus(0.62, 0.2, 12, 8);
}

/* ------------------------------------------------------------------ animation
 *
 * The handful of things in the park that MOVE own their own meshes rather than
 * going through the yard, because the yard's whole job is to merge geometry
 * into something that never moves again.
 *
 * Everything here obeys the same rule: THE AT-REST STATE IS VISIBLE. A jet
 * that animates from zero height photographs as absent — and the capture
 * harness disables animation — so every jet has a standing plume it never
 * drops below, and one of the two dump buckets is authored permanently tipped
 * with its curtain of water already falling.
 * ---------------------------------------------------------------------- */

interface JetSet {
  mesh: THREE.InstancedMesh;
  /** x, y (nozzle mouth), z, phase, period, peak height. */
  items: Array<{ x: number; y: number; z: number; phase: number; period: number; peak: number }>;
}

interface RingSet {
  mesh: THREE.InstancedMesh;
  /** Arc length along the river centreline, metres. */
  s: number[];
  speed: number[];
  spin: number[];
}

interface BucketRig {
  pivot: THREE.Object3D;
  sheet: THREE.Mesh;
  period: number;
  phase: number;
  /** Height of the curtain when full. */
  fall: number;
}

class Animated {
  readonly jets: JetSet[] = [];
  readonly rings: RingSet[] = [];
  readonly buckets: BucketRig[] = [];
  readonly geos: THREE.BufferGeometry[] = [];
  readonly objects: THREE.Object3D[] = [];

  dispose(): void {
    for (const o of this.objects) {
      o.parent?.remove(o);
      const im = o as THREE.InstancedMesh;
      im.dispose?.();
    }
    for (const g of this.geos) g.dispose();
    this.geos.length = 0;
    this.objects.length = 0;
    this.jets.length = 0;
    this.rings.length = 0;
    this.buckets.length = 0;
  }
}

/* ------------------------------------------------------------------------ *
 * The plan
 *
 * Nominal footprints, in world metres. These are not arbitrary: the island has
 * no reserved pad here, so they were chosen against a survey of the actual
 * height field — a 36 m shelf between Neon Heights and the north-east beach,
 * rising to about 44 m at its south-east corner and falling to the sea across
 * its north-east one. The park uses all three: main deck on the shelf, the
 * entrance up on the high corner, the diving and splash terrace a step down
 * toward the water.
 *
 * Every rect below is a STARTING POINT. `fitDeck` erodes it against the ground
 * that is really there and picks the elevation, because terrain is regenerated
 * from noise and a hand-tuned constant that stops being true is how a district
 * ends up with a hillside coming through its floor.
 * ------------------------------------------------------------------------ */

const PLAN = {
  /**
   * The shelf, all of it, as ONE terrace: tower of slides at the seaward end,
   * wave pool and lazy river in the middle, frontage along the south.
   *
   * It was three rectangles once — deck, wing and tower — and that was wrong
   * in a way worth writing down. `fitDeck` erodes each rect independently, so
   * two neighbouring terraces on the SAME 36 m shelf eroded by different
   * amounts and left a sixteen-metre canyon of raw hillside between them, with
   * two splash pools hanging over the edge of it. One rect cannot disagree
   * with itself, and everything inside it is placed as a fraction OF it, so
   * the whole layout now slides together when the ground argues.
   */
  main: { x0: 696, x1: 808, z0: -828, z1: -664 } as Rect,
  /** A step down toward the beach: diving stack, splash pads, the closed pool. */
  lower: { x0: 816, x1: 872, z0: -832, z1: -780 } as Rect,
  /** Up on the high corner: turnstiles, car park, the bus stop. */
  entrance: { x0: 808, x1: 880, z0: -744, z1: -656 } as Rect,
};

/**
 * How high a terrace has to stand for its pools to fit under it.
 *
 * THIS IS THE ONE RULE THE WHOLE PARK IS SHAPED BY, and it took a photograph
 * to see it. Terrain is not ours to edit, so a basin cannot be DUG: a pool cut
 * 2.6 m into a deck that is sitting on the ground is a hole with the hillside
 * still in it, and what you get is a wave pool full of grass. Verified from
 * the deck at eye height, which is the only way it shows.
 *
 * So a terrace with water on it stands on a podium at least as deep as its
 * deepest pool, and the fill IS the basin. That is also what a real lido on a
 * slope looks like: a concrete table with the pools inside the table.
 */
function poolClearance(p: Park, base: number, pools: ReadonlyArray<{ rect: Rect; depth: number }>): number {
  let top = base;
  for (const { rect, depth } of pools) {
    let hi = -Infinity;
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        hi = Math.max(hi, p.ground(lerp(rect.x0, rect.x1, i / 8), lerp(rect.z0, rect.z1, j / 8)));
      }
    }
    // 0.45 m of slab under the basin floor, then round up to the build grid.
    top = Math.max(top, Math.ceil((hi + depth + 0.45) / GRID) * GRID);
  }
  return top;
}

/**
 * Resolve a terrace against the ground it is standing on.
 *
 * The elevation is the median of the sampled ground snapped to `GRID` — the
 * median rather than the mean because a single high corner should not lift the
 * whole deck, and snapped because players build off these floors and a deck at
 * 37.2 m makes every ramp meet it wrong.
 *
 * Then the edges are eroded, worst first, until nothing inside the rect stands
 * more than `TOL` above the deck. That is the whole trick: filling DOWN is
 * free (it becomes the retaining wall), but there is no cutting — terrain is
 * not ours to edit — so any ground above the deck would burst through the
 * paving as a grass mound in the middle of a swimming pool.
 */
interface FittedDeck {
  rect: Rect;
  top: number;
  /** Metres of fill under the highest part of the terrace. */
  fill: number;
  /** How many 4 m bites the fit took out of the nominal rect. */
  eroded: number;
  /** Highest ground left inside the rect, for telemetry. */
  hi: number;
}

function fitDeck(p: Park, nominal: Rect, maxErodeSteps = 2, step = 4): FittedDeck {
  // Half a metre: what `pave` can absorb by riding a bay up over the ground.
  const TOL = 0.5;
  const rect: Rect = { ...nominal };
  const sampleMax = (r: Rect, edge?: "x0" | "x1" | "z0" | "z1") => {
    let hi = -Infinity;
    const nx = Math.max(2, Math.round((r.x1 - r.x0) / 4));
    const nz = Math.max(2, Math.round((r.z1 - r.z0) / 4));
    for (let i = 0; i <= nx; i++) {
      for (let j = 0; j <= nz; j++) {
        const x = lerp(r.x0, r.x1, i / nx);
        const z = lerp(r.z0, r.z1, j / nz);
        if (edge === "x0" && i > 1) continue;
        if (edge === "x1" && i < nx - 1) continue;
        if (edge === "z0" && j > 1) continue;
        if (edge === "z1" && j < nz - 1) continue;
        hi = Math.max(hi, p.ground(x, z));
      }
    }
    return hi;
  };
  // Median height, on a coarse grid.
  const hs: number[] = [];
  for (let i = 0; i <= 12; i++) {
    for (let j = 0; j <= 12; j++) {
      hs.push(p.ground(lerp(rect.x0, rect.x1, i / 12), lerp(rect.z0, rect.z1, j / 12)));
    }
  }
  hs.sort((a, b) => a - b);
  // The 35th percentile, not the median: a terrace wants to sit on the flat
  // that most of it is standing on, and let the erosion pass walk the rect off
  // whatever is rising at one corner. Taking the median instead lifted the
  // main deck a whole cell onto a four-metre plinth over ground it was already
  // level with — which is measurable in `dz:lido-ready` and was.
  let top = snap(hs[Math.floor(hs.length * 0.35)]);
  let eroded = 0;

  for (let n = 0; n < maxErodeSteps; n++) {
    if (sampleMax(rect) <= top + TOL) break;
    // Erode whichever edge band is the highest — the ground rises from one
    // side, so this walks the rect off the hill rather than shrinking it
    // uniformly and losing the flat.
    const edges: Array<"x0" | "x1" | "z0" | "z1"> = ["x0", "x1", "z0", "z1"];
    let worst: "x0" | "x1" | "z0" | "z1" = "x0";
    let worstH = -Infinity;
    for (const e of edges) {
      const h = sampleMax(rect, e);
      if (h > worstH) { worstH = h; worst = e; }
    }
    if (worst === "x0") rect.x0 += step;
    else if (worst === "x1") rect.x1 -= step;
    else if (worst === "z0") rect.z0 += step;
    else rect.z1 -= step;
    eroded++;
  }
  // Last resort: if the ground still wins, lift the deck a cell at a time. A
  // four-metre plinth is ugly; a hill through the changing rooms is broken.
  for (let n = 0; n < 3 && sampleMax(rect) > top + TOL; n++) top += GRID;

  let lowest = Infinity;
  for (let i = 0; i <= 12; i++) {
    for (let j = 0; j <= 12; j++) {
      lowest = Math.min(lowest, p.ground(lerp(rect.x0, rect.x1, i / 12), lerp(rect.z0, rect.z1, j / 12)));
    }
  }
  return { rect, top, fill: Math.max(0, top - lowest), eroded, hi: sampleMax(rect) };
}

/* ------------------------------------------------------------------------ *
 * Flumes
 *
 * A water slide is the one shape in this park that cannot be made of boxes.
 * It is a U-section gutter that corkscrews, banks into its own curves and
 * flattens out into a run-out, so it is authored as a PATH and swept.
 *
 * The path is a Catmull-Rom through a handful of control points, resampled at
 * even arc length. The section is a closed shell — inner surface, rims, outer
 * surface — so one sweep produces a slide with visible thickness rather than a
 * one-sided ribbon that disappears when you walk under it.
 * ------------------------------------------------------------------------ */

const _up = new THREE.Vector3(0, 1, 0);
/** Module scratch, reused by the flow field and the wet-band test. */
const _flowScratch = new THREE.Vector3();

/**
 * Frames along a path, with banking.
 *
 * `bank` rolls the section into the turn in proportion to how hard the path
 * is turning. Without it a helical flume looks like a hosepipe; with it the
 * rider is held against the outside wall, which is what a flume is for.
 */
function framesFrom(points: readonly THREE.Vector3[], bankGain = 0.8, closed = false): Frame[] {
  const out: Frame[] = [];
  let s = 0;
  let lastRight: THREE.Vector3 | null = null;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    // A ring has no ends: its first station's tangent has to see the last
    // station, or the seam gets a kink and the river visibly starts somewhere.
    const prev = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const t = new THREE.Vector3().subVectors(next, prev);
    if (t.lengthSq() < 1e-8) t.set(0, 0, 1);
    t.normalize();
    const right = new THREE.Vector3().crossVectors(_up, t);
    if (right.lengthSq() < 1e-4) right.copy(lastRight ?? new THREE.Vector3(1, 0, 0));
    right.normalize();
    const up = new THREE.Vector3().crossVectors(t, right).normalize();
    // Turn rate between the two neighbouring segments, signed about the local
    // up, becomes the roll angle.
    if (bankGain > 0 && (closed || (i > 0 && i < n - 1))) {
      const a = new THREE.Vector3().subVectors(points[i], prev).normalize();
      const b = new THREE.Vector3().subVectors(next, points[i]).normalize();
      const turn = Math.asin(clamp01(Math.abs(new THREE.Vector3().crossVectors(a, b).length())) ) * Math.sign(new THREE.Vector3().crossVectors(a, b).dot(up) || 1);
      const roll = Math.max(-0.6, Math.min(0.6, -turn * bankGain * 4));
      right.applyAxisAngle(t, roll);
      up.applyAxisAngle(t, roll);
    }
    if (i > 0) s += points[i].distanceTo(points[i - 1]);
    out.push({ p: points[i].clone(), right, up, s });
    lastRight = right;
  }
  return out;
}

/** Resample a control polygon into an even-arc-length path. */
function smoothPath(control: readonly THREE.Vector3[], stations: number): THREE.Vector3[] {
  const curve = new THREE.CatmullRomCurve3(control.map((v) => v.clone()), false, "catmullrom", 0.5);
  return curve.getSpacedPoints(Math.max(4, stations));
}

/** The closed U-shell cross-section of a flume, in section-local metres. */
function flumeSection(r: number, rim: number, t: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const N = 8;
  pts.push([-r, r + rim]);
  for (let i = 0; i <= N; i++) {
    const a = Math.PI + (i / N) * Math.PI;
    pts.push([Math.cos(a) * r, r + Math.sin(a) * r]);
  }
  pts.push([r, r + rim]);
  pts.push([r + t, r + rim]);
  for (let i = N; i >= 0; i--) {
    const a = Math.PI + (i / N) * Math.PI;
    pts.push([Math.cos(a) * (r + t), r + Math.sin(a) * (r + t)]);
  }
  pts.push([-(r + t), r + rim]);
  pts.push([-r, r + rim]);
  return pts;
}

interface FlumeOpts {
  radius: number;
  rim: number;
  thickness: number;
  shell: Surf;
  /** Run water down the inside. */
  water?: boolean;
  /** Deck level under the flume; supports drop to it. */
  supportTo?: number;
  supportEvery?: number;
  supportSurf?: Surf;
  /** Collide every Nth station. */
  collideEvery?: number;
}

/** Sweep one flume, its water, its supports and its colliders. */
function flume(p: Park, path: readonly THREE.Vector3[], o: FlumeOpts): void {
  const frames = framesFrom(path);
  p.y.emit(o.shell, sweep(frames, flumeSection(o.radius, o.rim, o.thickness)));
  if (o.water !== false) {
    const wr = o.radius * 0.74;
    const wy = o.radius * 0.24;
    const g = sweep(frames, [[-wr, wy], [0, wy * 0.55], [wr, wy]]);
    g.uvMode = "raw";
    p.y.custom("water", p.waterMat, g, undefined, true);
  }
  const steel = o.supportSurf ?? surf("metalPanel", STEEL);
  if (o.supportTo !== undefined) {
    const every = o.supportEvery ?? 6;
    for (let i = every; i < frames.length - 1; i += every) {
      const f = frames[i];
      const h = f.p.y - o.supportTo;
      if (h < 1.2) continue;
      p.y.cyl(steel, f.p.x, o.supportTo + h * 0.5, f.p.z, 0.17, 0.13, h, { seg: 8 });
      p.y.solid(f.p.x, o.supportTo + h * 0.5, f.p.z, 0.26, h * 0.5, 0.26, "metal", "metal");
    }
  }
  const ce = o.collideEvery ?? 3;
  const hr = o.radius + o.thickness;
  for (let i = 0; i < frames.length; i += ce) {
    const f = frames[i];
    // The chute's own bounding box at this station. Approximate — a swept
    // helix cannot be described by an AABB — but it makes the slide a solid
    // object you can shoot, stand under and build against.
    p.y.solid(f.p.x, f.p.y + o.radius * 0.6, f.p.z, hr, o.radius * 0.85, hr, "concrete", "stone", "lido-flume");
  }
}

/* -------------------------------------------------------------- slide tower */

/**
 * THE TOWER OF SLIDES. The silhouette the park is recognised by from the
 * drop bus, and the reason the lido reads as somewhere else from 800 m away:
 * nothing else on this island is a 28 m open lattice with coloured tubes
 * corkscrewing off it.
 *
 * Three slides, three characters, because a tower with three of the same slide
 * is a tower with one slide on it:
 *   · the HELIX, off the middle landing — two and a quarter turns, banked.
 *   · the OPEN HALF-PIPE, off the first landing — wide, shallow, and the one
 *     you can see somebody's whole run down.
 *   · the DROP, off the top — a near-vertical 12 m plunge into a long flat
 *     run-out, which is the only one with a queue in real life.
 *
 * The stair core is real: every flight is walkable collision, so the tower is
 * the best vantage in the park and the fight over it is the point.
 */
function buildSlideTower(p: Park, cx: number, cz: number, deck: number, poolDeck: number): void {
  const t = p.tier;
  const concrete = surf("concrete", RENDER_WHITE);
  const steel = surf("metalPanel", STEEL);
  const trim = surf("metalPanel", MUNI_BLUE);
  const HALF = 6.5;
  const STOREY = GRID * 2;
  const TOP = STOREY * 3;

  // --- four corner columns and the landing slabs they carry.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      p.y.solidBox(concrete, cx + sx * (HALF - 0.55), deck + TOP * 0.5, cz + sz * (HALF - 0.55), 0.55, TOP * 0.5, 0.55, "stone", { bevel: 0.05 });
    }
  }
  for (let level = 1; level <= 3; level++) {
    const y = deck + STOREY * level;
    // A slab with a stairwell void: two halves, leaving a 3 m slot open.
    for (const sx of [-1, 1]) {
      p.y.solidBox(concrete, cx + sx * (HALF - 2.4) , y - 0.2, cz, 2.5, 0.2, HALF, "stone", { bevel: 0.04 });
    }
    p.y.solidBox(concrete, cx, y - 0.2, cz + HALF - 1.4, 2.2, 0.2, 1.4, "stone", { bevel: 0.04 });
    // Railings all the way round the landing, with a gap at the slide mouth.
    railing(p, cx - HALF, cz - HALF, cx + HALF, cz - HALF, y, steel);
    railing(p, cx - HALF, cz + HALF, cx + HALF, cz + HALF, y, steel);
    railing(p, cx - HALF, cz - HALF, cx - HALF, cz + HALF, y, steel);
    if (level !== 2) railing(p, cx + HALF, cz - HALF, cx + HALF, cz + HALF, y, steel);
    // Kick plate: 20 cm of solid at the deck edge so a dropped body does not
    // slide straight off, and a value band that reads from the ground.
    p.y.box(trim, cx, y - 0.02, cz - HALF, HALF, 0.16, 0.1, { bevel: 0.03 });
    p.y.box(trim, cx, y - 0.02, cz + HALF, HALF, 0.16, 0.1, { bevel: 0.03 });
  }

  // --- the stair core: two switchback flights per storey inside the tower.
  for (let level = 0; level < 3; level++) {
    const y0 = deck + STOREY * level;
    const half = STOREY * 0.5;
    stairs(p, cx - 2.0, cz - HALF + 1.0, y0, y0 + half, 2.2, "south", concrete);
    stairs(p, cx + 2.0, cz + HALF - 1.0, y0 + half, y0 + STOREY, 2.2, "north", concrete);
    // The half-landing the switchback turns on.
    p.y.solidBox(concrete, cx, y0 + half - 0.15, cz + HALF - 1.2, 2.4, 0.15, 1.2, "stone", { bevel: 0.03 });
  }

  // --- the top: a shade canopy and a mast, so the silhouette has a finial
  // rather than stopping dead.
  const topY = deck + TOP;
  p.y.box(surf("corrugated", FADED_RED), cx, topY + 2.9, cz, HALF * 0.8, 0.14, HALF * 0.8, { bevel: 0.05 });
  p.y.solid(cx, topY + 2.9, cz, HALF * 0.8, 0.14, HALF * 0.8, "metal", "metal");
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      p.y.cyl(steel, cx + sx * (HALF * 0.7), topY + 1.45, cz + sz * (HALF * 0.7), 0.07, 0.07, 2.9, { seg: 6 });
    }
  }
  p.y.cyl(steel, cx, topY + 5.2, cz, 0.06, 0.03, 4.6, { seg: 6 });
  signPanel(p, "slides", cx, deck + 2.6, cz - HALF - 0.2, 2.6, 0, { postsTo: deck, both: true });

  // --- SLIDE 1: the helix, off the middle landing, running out to the east.
  {
    const r = 7.6;
    const y0 = deck + STOREY * 2 - 0.4;
    const hubX = cx + HALF + 0.4 + r;
    const hubZ = cz;
    // 2.25 turns puts the exit tangent pointing due east, which is where its
    // splash pool is. A helix that ends pointing at the tower it came off is
    // the classic procedural-slide mistake.
    const turns = 2.25;
    const drop = y0 - (poolDeck + 1.0);
    const seg = Math.max(18, Math.round(t.round * 2.2));
    const ctrl: THREE.Vector3[] = [new THREE.Vector3(cx + HALF + 0.4, y0, cz)];
    for (let i = 0; i <= seg; i++) {
      const u = i / seg;
      const a = Math.PI + u * turns * TAU;
      // Eased descent: steep in the middle of the corkscrew, gentle at both
      // ends, so the entry does not drop you and the exit does not launch you.
      ctrl.push(new THREE.Vector3(
        hubX + Math.cos(a) * r,
        y0 - drop * (u * u * 0.35 + u * 0.65),
        hubZ + Math.sin(a) * r,
      ));
    }
    ctrl.push(new THREE.Vector3(cx + 20, poolDeck + 0.95, cz - r));
    ctrl.push(new THREE.Vector3(cx + 26, poolDeck + 0.8, cz - r));
    flume(p, smoothPath(ctrl, Math.max(30, t.round * 4)), {
      radius: 1.05, rim: 0.55, thickness: 0.13,
      shell: surf("plaster", SAFETY),
      supportTo: deck, supportEvery: 7, collideEvery: 4,
    });
  }

  // --- SLIDE 2: the open half-pipe, off the first landing. Wide and shallow,
  // with one long banked right-hander round the west face of the tower.
  {
    const y0 = deck + STOREY - 0.4;
    const ctrl = [
      new THREE.Vector3(cx - HALF - 0.4, y0, cz - 1.5),
      new THREE.Vector3(cx - 13, y0 - 2.1, cz - 4),
      new THREE.Vector3(cx - 19, y0 - 4.2, cz - 9),
      new THREE.Vector3(cx - 22.5, y0 - 5.8, cz - 15),
      new THREE.Vector3(cx - 24, y0 - 6.8, cz - 20),
      new THREE.Vector3(cx - 24, poolDeck + 0.85, cz - 25),
    ];
    flume(p, smoothPath(ctrl, Math.max(26, t.round * 3)), {
      radius: 1.5, rim: 0.2, thickness: 0.14,
      shell: surf("plaster", MUNI_BLUE),
      supportTo: deck, supportEvery: 6, collideEvery: 4,
    });
  }

  // --- SLIDE 3: the drop. Near vertical for eighteen metres, then a curve
  // into a long flat run-out. The one that reads from the other side of the
  // island, and the reason the tower is 28 m rather than 16.
  {
    const y0 = deck + TOP - 0.6;
    const ctrl = [
      new THREE.Vector3(cx, y0, cz - HALF - 0.4),
      new THREE.Vector3(cx, y0 - 1.1, cz - HALF - 2.2),
      new THREE.Vector3(cx, y0 - 8, cz - HALF - 3.1),
      new THREE.Vector3(cx, y0 - 15, cz - HALF - 3.7),
      new THREE.Vector3(cx, y0 - 19, cz - HALF - 6.5),
      new THREE.Vector3(cx, poolDeck + 1.3, cz - HALF - 11.5),
      new THREE.Vector3(cx, poolDeck + 0.95, cz - HALF - 17),
      new THREE.Vector3(cx, poolDeck + 0.8, cz - HALF - 22.5),
    ];
    flume(p, smoothPath(ctrl, Math.max(24, t.round * 3)), {
      radius: 0.95, rim: 0.7, thickness: 0.13,
      shell: surf("plaster", FADED_RED),
      supportTo: deck, supportEvery: 5, collideEvery: 3,
    });
  }
}

/**
 * Where each slide throws you. The tower builder and the terrace that places
 * the splash pools have to agree about this to the metre, so they share one
 * table rather than each carrying its own copy of the arithmetic.
 */
const RUNOUT = {
  helix: { dx: 30, dz: -7.6 },
  pipe: { dx: -24, dz: -29 },
  drop: { dx: 0, dz: -31 },
};

/* ------------------------------------------------------------------------ *
 * The lazy river
 *
 * A closed ring channel with a current in it. Two things make it worth the
 * code: it is the only water in the world that MOVES YOU, and it is a ring, so
 * the fight inside it is a chase that can never quite end.
 *
 * The centreline is a rounded rectangle sampled at even spacing. Everything
 * else — the swept channel, the water ribbon, the flow field, the drifting
 * rings, the hole the paving leaves for it — is derived from that one array,
 * so there is exactly one description of where the river is.
 * ------------------------------------------------------------------------ */

interface RiverPath {
  pts: THREE.Vector3[];
  tan: THREE.Vector3[];
  /** Cumulative arc length at each station, and the loop's total. */
  cum: number[];
  total: number;
  half: number;
  deckY: number;
  floorY: number;
  waterY: number;
  /** Metres per second the current carries a floating body. */
  speed: number;
  /** Signed lateral distance and the tangent at the nearest point. */
  nearest(x: number, z: number, out: THREE.Vector3): number;
  /** Position on the centreline at arc length `s`, wrapped. */
  at(s: number, out: THREE.Vector3): THREE.Vector3;
}

function loopCentreline(cx: number, cz: number, hx: number, hz: number, rc: number, step: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const push = (x: number, z: number) => pts.push(new THREE.Vector3(x, 0, z));
  const straight = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / step));
    for (let i = 0; i < n; i++) push(lerp(x0, x1, i / n), lerp(z0, z1, i / n));
  };
  const arc = (ax: number, az: number, a0: number, a1: number) => {
    const n = Math.max(2, Math.round((Math.abs(a1 - a0) * rc) / step));
    for (let i = 0; i < n; i++) {
      const a = lerp(a0, a1, i / n);
      push(ax + Math.cos(a) * rc, az + Math.sin(a) * rc);
    }
  };
  straight(cx + hx, cz - hz + rc, cx + hx, cz + hz - rc);
  arc(cx + hx - rc, cz + hz - rc, 0, Math.PI / 2);
  straight(cx + hx - rc, cz + hz, cx - hx + rc, cz + hz);
  arc(cx - hx + rc, cz + hz - rc, Math.PI / 2, Math.PI);
  straight(cx - hx, cz + hz - rc, cx - hx, cz - hz + rc);
  arc(cx - hx + rc, cz - hz + rc, Math.PI, Math.PI * 1.5);
  straight(cx - hx + rc, cz - hz, cx + hx - rc, cz - hz);
  arc(cx + hx - rc, cz - hz + rc, Math.PI * 1.5, Math.PI * 2);
  return pts;
}

function buildLazyRiver(p: Park, cx: number, cz: number, hx: number, hz: number, deck: number): RiverPath {
  const HALF = 2.7;
  const DEPTH = 1.3;
  const rc = Math.min(hx, hz) * 0.62;
  const pts = loopCentreline(cx, cz, hx, hz, rc, 2.4);
  const n = pts.length;
  for (const v of pts) v.y = deck;

  const tan: THREE.Vector3[] = [];
  const cum: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n];
    const b = pts[(i + 1) % n];
    tan.push(new THREE.Vector3().subVectors(b, a).setY(0).normalize());
    cum.push(total);
    total += pts[i].distanceTo(pts[(i + 1) % n]);
  }

  const frames = framesFrom(pts, 0, true);
  // Channel: coping wing, wall down, floor, wall up, coping wing. The wings
  // are 1.4 m so the paving can stop well clear of the water and still be met.
  // Wings of 2.8 m for the same reason the pool coping is 1.7 m wide: the
  // paving cannot end closer than a bay's half-diagonal from the water, so the
  // channel's own stone has to reach out and meet it or there is a slot down
  // onto the terrace mass all the way round the ring.
  const section: Array<[number, number]> = [
    [-HALF - 2.8, 0.06], [-HALF - 0.08, 0.06], [-HALF, -DEPTH],
    [HALF, -DEPTH], [HALF + 0.08, 0.06], [HALF + 2.8, 0.06],
  ];
  p.y.emit(surf("concrete", TILE_PALE), sweep(frames, section, true));
  {
    const g = sweep(frames, [[-HALF + 0.06, -0.3], [HALF - 0.06, -0.3]], true);
    g.uvMode = "raw";
    p.y.custom("water", p.waterMat, g, undefined, true);
  }
  // Floor collision. One block per station: over-covering at the corners is
  // buried under the island and the deck, and the alternative is a channel you
  // fall through.
  for (let i = 0; i < n; i += 1) {
    p.y.solid(pts[i].x, deck - DEPTH - 0.4, pts[i].z, 1.6, 0.4, 1.6, "concrete", "stone", "lido-river");
  }

  const _seg = new THREE.Vector3();
  const _rel = new THREE.Vector3();
  const river: RiverPath = {
    pts, tan, cum, total,
    half: HALF,
    deckY: deck,
    floorY: deck - DEPTH,
    waterY: deck - 0.3,
    // 1.15 m/s: a real lazy river runs about a metre a second. Fast enough
    // that you visibly travel, slow enough that you can still fight in it.
    speed: 1.15,
    nearest(x, z, out) {
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        _seg.subVectors(b, a);
        const len2 = _seg.x * _seg.x + _seg.z * _seg.z;
        const t = len2 > 1e-6 ? clamp01(((x - a.x) * _seg.x + (z - a.z) * _seg.z) / len2) : 0;
        const px = a.x + _seg.x * t;
        const pz = a.z + _seg.z * t;
        const d = Math.hypot(x - px, z - pz);
        if (d < best) {
          best = d;
          _rel.copy(tan[i]);
        }
      }
      out.copy(_rel);
      return best;
    },
    at(s, out) {
      let u = s % total;
      if (u < 0) u += total;
      let i = 0;
      while (i < n - 1 && cum[i + 1] <= u) i++;
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const segLen = (i === n - 1 ? total : cum[i + 1]) - cum[i];
      const t = segLen > 1e-6 ? (u - cum[i]) / segLen : 0;
      return out.set(lerp(a.x, b.x, t), a.y, lerp(a.z, b.z, t));
    },
  };
  return river;
}

/** True when a point is inside the river's channel, with a margin. */
function riverHole(river: RiverPath): (x: number, z: number, margin: number) => boolean {
  const scratch = new THREE.Vector3();
  return (x, z, margin) => river.nearest(x, z, scratch) < river.half + 0.9 + margin;
}

/* ----------------------------------------------------------------- splash pad */

/**
 * The splash pad: a wet-play square of timed ground jets, hoops and two dump
 * buckets. This is where the park is loudest, and it is deliberately the one
 * open area with no cover in it — a killing field with a bucket over it.
 */
function buildSplashPad(
  p: Park,
  anim: Animated,
  root: THREE.Object3D,
  r: Rect,
  deck: number,
  mat: THREE.Material,
  solidMat: THREE.Material,
): void {
  const t = p.tier;
  const cx = rectCx(r), cz = rectCz(r);
  const hx = (r.x1 - r.x0) * 0.5, hz = (r.z1 - r.z0) * 0.5;

  // A shallow dished apron in wet blue tile, one step down from the deck so
  // the water it throws has somewhere to go.
  p.y.box(surf("concrete", TILE_PALE), cx, deck - 0.13, cz, hx, 0.09, hz, { bevel: 0.03, mask: F_NO_BOTTOM });
  p.y.solid(cx, deck - 0.16, cz, hx, 0.12, hz, "concrete", "stone");
  for (let i = 0; i < 3; i++) {
    const rr = (i + 1) * Math.min(hx, hz) * 0.24;
    p.y.ring(surf("concrete", TILE_TURQ), cx, deck - 0.04, cz, rr, 0.09, Math.max(14, t.round), { tubeSeg: 5 });
  }

  // --- jets. Nozzles are static geometry; the plumes are one instanced mesh.
  const count = Math.max(4, Math.round(t.jets));
  const jets: JetSet["items"] = [];
  const cols = Math.max(2, Math.round(Math.sqrt(count * (hx / hz))));
  const rows = Math.max(2, Math.round(count / cols));
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = lerp(r.x0 + 2.5, r.x1 - 2.5, cols === 1 ? 0.5 : i / (cols - 1));
      const z = lerp(r.z0 + 2.5, r.z1 - 2.5, rows === 1 ? 0.5 : j / (rows - 1));
      p.y.cyl(surf("metalPanel", STEEL), x, deck - 0.02, z, 0.13, 0.09, 0.14, { seg: 8 });
      jets.push({
        x, y: deck + 0.04, z,
        phase: p.rng() * TAU,
        // Neighbouring jets on different periods is what makes a splash pad
        // read as a machine rather than as a sprinkler.
        period: 2.4 + p.rng() * 3.6,
        peak: 1.8 + p.rng() * 2.6,
      });
    }
  }
  if (jets.length) {
    const geo = cylinder(0.075, 0.03, 1, 6, true, false).toGeometry(1);
    // Unit-height plume with its base at the origin, so the instance matrix
    // can scale it in Y and the mouth of the nozzle stays put.
    geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, mat, jets.length);
    mesh.name = "lido:jets";
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    root.add(mesh);
    anim.geos.push(geo);
    anim.objects.push(mesh);
    anim.jets.push({ mesh, items: jets });
  }

  // --- hoops: three arches over the pad, in park colours.
  const hoopColors = [SAFETY, MUNI_BLUE, FADED_RED];
  for (let i = 0; i < 3; i++) {
    const z = lerp(r.z0 + 3.5, r.z1 - 3.5, i / 2);
    const rr = Math.min(3.4, hx * 0.55);
    // pitch is NEGATIVE. `torus` builds its arc in the XZ plane with z ≥ 0, and
    // +90° about X sends that half UNDER the deck: the first capture of the
    // splash pad had three arches in it and none of them above ground.
    p.y.ring(surf("plaster", hoopColors[i]), cx, deck, z, rr, 0.2, Math.max(12, t.round), { tubeSeg: 6, pitch: -Math.PI / 2, arc: Math.PI });
    p.y.cyl(surf("plaster", hoopColors[i]), cx - rr, deck + 0.5, z, 0.24, 0.22, 1.0, { seg: 8 });
    p.y.cyl(surf("plaster", hoopColors[i]), cx + rr, deck + 0.5, z, 0.24, 0.22, 1.0, { seg: 8 });
    p.y.solid(cx - rr, deck + 1.2, z, 0.3, 1.2, 0.3, "concrete", "stone");
    p.y.solid(cx + rr, deck + 1.2, z, 0.3, 1.2, 0.3, "concrete", "stone");
  }

  // --- two dump buckets. One is animated; the other is authored permanently
  // tipped with its curtain already falling, so the park has a bucket going
  // over in EVERY frame — including a screenshot taken with animation
  // disabled, which is how this world is reviewed.
  for (let i = 0; i < 2; i++) {
    const bx = lerp(r.x0 + 4, r.x1 - 4, i === 0 ? 0.24 : 0.76);
    const bz = r.z0 + hz * 0.62;
    const H = 5.2;
    const steel = surf("metalPanel", STEEL);
    for (const sx of [-1, 1]) {
      p.y.cyl(steel, bx + sx * 1.9, deck + H * 0.5, bz, 0.22, 0.19, H, { seg: 8 });
      p.y.solid(bx + sx * 1.9, deck + H * 0.5, bz, 0.28, H * 0.5, 0.28, "metal", "metal");
      p.y.cyl(steel, bx + sx * 1.35, deck + H * 0.55, bz, 0.08, 0.08, H * 0.9, { seg: 6, roll: sx * 0.42 });
    }
    p.y.cyl(steel, bx, deck + H, bz, 0.12, 0.12, 4.2, { seg: 6, pitch: Math.PI / 2, yaw: Math.PI / 2 });
    // Feed pipe and its header, so the water has somewhere to come from.
    p.y.cyl(steel, bx, deck + H * 0.5, bz + 1.2, 0.11, 0.11, H, { seg: 6 });
    p.y.cyl(steel, bx, deck + H - 0.3, bz + 0.6, 0.1, 0.1, 1.3, { seg: 6, pitch: Math.PI / 2 });

    // The bucket: a five-box open box, hung under the crossbar.
    const bucketGeo = new Geo();
    const shell = 0.09;
    appendPart(bucketGeo, bevelBox(1.6, shell, 1.25, 0.05), xf(0, -1.75, 0), 1);
    for (const sx of [-1, 1]) appendPart(bucketGeo, bevelBox(shell, 0.95, 1.25, 0.05), xf(sx * 1.6, -0.9, 0), 1);
    for (const sz of [-1, 1]) appendPart(bucketGeo, bevelBox(1.6, 0.95, shell, 0.05), xf(0, -0.9, sz * 1.25), 1);
    // The hoop it hangs from, so it reads as pivoting rather than floating.
    appendPart(bucketGeo, torus(0.5, 0.07, 10, 5, Math.PI), xf(0, -0.2, 0, 0, -Math.PI / 2), 1);

    if (i === 1) {
      // Tipped at 106°, water already falling. Static, merged, free.
      p.y.emit(surf("plaster", SAFETY), bucketGeo, xf(bx, deck + H, bz, 0, 0, 1.85));
      p.y.solid(bx, deck + H - 1.1, bz, 1.5, 0.8, 1.1, "metal", "metal");
      const curtain = new Geo();
      curtain.uvMode = "raw";
      const cw = 1.15;
      const fall = H - 1.5;
      curtain.quad(
        bx - cw, deck + H - 1.2, bz - 0.5,
        bx + cw, deck + H - 1.2, bz - 0.5,
        bx + cw * 1.35, deck + H - 1.2 - fall, bz - 0.7,
        bx - cw * 1.35, deck + H - 1.2 - fall, bz - 0.7,
        0, 0, -1,
      );
      p.y.custom("water", p.waterMat, curtain, undefined, true);
      p.wet.push(new THREE.Vector3(bx, deck + 0.1, bz - 0.7));
    } else {
      const pivot = new THREE.Object3D();
      pivot.position.set(bx, deck + H, bz);
      root.add(pivot);
      anim.objects.push(pivot);
      const bg = bucketGeo.toGeometry(TILE.plaster);
      const live = new THREE.Mesh(bg, solidMat);
      live.castShadow = true;
      pivot.add(live);
      anim.geos.push(bg);

      // The curtain is a plane hanging from the lip, scaled in Y as it pours.
      const sheetGeo = new THREE.PlaneGeometry(2.3, 1);
      sheetGeo.translate(0, -0.5, 0);
      const sheet = new THREE.Mesh(sheetGeo, mat);
      sheet.position.set(bx, deck + H - 1.2, bz - 0.6);
      sheet.scale.set(1, 0.001, 1);
      sheet.visible = false;
      root.add(sheet);
      anim.geos.push(sheetGeo);
      anim.objects.push(sheet);
      anim.buckets.push({ pivot, sheet, period: 11, phase: 3.5, fall: H - 1.5 });
      p.y.solid(bx, deck + H - 1.1, bz, 1.5, 0.8, 1.1, "metal", "metal");
    }
  }

  signPanel(p, "bucket", cx, deck + 2.3, r.z1 + 0.4, 3.0, Math.PI, { postsTo: deck });
  for (let i = 0; i < 6; i++) {
    const x = lerp(r.x0 + 1, r.x1 - 1, p.rng());
    const z = lerp(r.z0 + 1, r.z1 - 1, p.rng());
    p.wet.push(new THREE.Vector3(x, deck + 0.1, z));
  }
}

/* --------------------------------------------------------------- diving stack */

/**
 * The diving stack: three platforms and two springboards over the deep pool.
 *
 * The heights are 4, 8 and 12 m — GRID multiples, not because a real stack
 * uses them but because players build off every floor in this world and a
 * platform at 10.0 m is a platform their ramps arrive under.
 */
function buildDivingStack(p: Park, cx: number, cz: number, deck: number): void {
  const concrete = surf("concrete", RENDER_WHITE);
  const steel = surf("metalPanel", STEEL);
  const trim = surf("metalPanel", MUNI_BLUE);
  const TOP = GRID * 3;

  // Spine: a blade wall rather than four columns, so the stack reads as one
  // sculptural object from across the park.
  p.y.solidBox(concrete, cx, deck + TOP * 0.5, cz, 3.2, TOP * 0.5, 0.85, "stone", { bevel: 0.06 });
  p.y.solidBox(concrete, cx, deck + 0.35, cz, 4.4, 0.35, 3.0, "stone", { bevel: 0.05 });

  for (let level = 1; level <= 3; level++) {
    const y = deck + GRID * level;
    const over = 1.4 + level * 0.5;
    // Platform: cantilevered toward the water (−Z), with a lip and a fascia.
    p.y.solidBox(concrete, cx, y - 0.22, cz - over * 0.5 - 0.4, 1.9, 0.22, over * 0.5 + 0.9, "stone", { bevel: 0.05 });
    p.y.box(trim, cx, y - 0.42, cz - over - 1.25, 1.95, 0.1, 0.08, { bevel: 0.02 });
    // Railings down both sides, open at the end. A diving platform you cannot
    // fall off is a balcony.
    for (const sx of [-1, 1]) {
      railing(p, cx + sx * 1.85, cz + 0.4, cx + sx * 1.85, cz - over - 1.2, y, steel, 1.0);
    }
    stairs(p, cx + 2.2, cz + 0.6, y - GRID, y, 1.6, "east", concrete);
    p.y.solidBox(concrete, cx + 3.6, y - 0.2, cz + 0.6, 1.5, 0.2, 1.4, "stone", { bevel: 0.04 });
    railing(p, cx + 2.2, cz + 1.6, cx + 5.0, cz + 1.6, y, steel, 1.0);
  }

  // Springboards, at 1 m and at deck level, on real fulcrums.
  for (let i = 0; i < 2; i++) {
    const bx = cx + (i === 0 ? -6.2 : -10.4);
    const by = deck + (i === 0 ? 1.2 : 0.6);
    const plinth = by - deck;
    p.y.solidBox(concrete, bx, deck + plinth * 0.5, cz + 0.6, 0.9, plinth * 0.5, 1.4, "stone", { bevel: 0.05 });
    // The board: 4.6 m of white plank, tipped down 3° at the tip because a
    // board that is dead level reads as a shelf.
    p.y.box(surf("plaster", RENDER_WHITE), bx, by + 0.1, cz - 1.9, 0.42, 0.07, 2.4, { bevel: 0.03, pitch: 0.05 });
    p.y.solid(bx, by + 0.1, cz - 1.9, 0.42, 0.12, 2.4, "wood", "wood");
    p.y.cyl(steel, bx, by - 0.05, cz - 0.2, 0.11, 0.11, 0.9, { seg: 8, pitch: Math.PI / 2, yaw: Math.PI / 2 });
    railing(p, bx - 0.75, cz + 0.9, bx - 0.75, cz - 0.6, by, steel, 0.95);
    railing(p, bx + 0.75, cz + 0.9, bx + 0.75, cz - 0.6, by, steel, 0.95);
  }
}

/* ------------------------------------------------------------------ deck kit */

/** A row of loungers with a parasol between every second pair. */
function loungerRow(p: Park, x0: number, z: number, count: number, spacing: number, deck: number, yaw: number): void {
  const frame = surf("plaster", PLASTIC);
  const padA = surf("fabric", MUNI_BLUE);
  const padB = surf("fabric", FADED_RED);
  for (let i = 0; i < count; i++) {
    const x = x0 + i * spacing;
    const jitter = (p.rng() - 0.5) * 0.16;
    const m = xf(x, deck, z + jitter, yaw + (p.rng() - 0.5) * 0.09);
    p.y.inst("lounger", frame, loungerFrame, m);
    p.y.inst(i % 2 === 0 ? "lounger-pad-a" : "lounger-pad-b", i % 2 === 0 ? padA : padB, loungerPad, m);
    if (i % 3 === 1) {
      const pm = xf(x + spacing * 0.5, deck, z + 1.5, p.rng() * TAU);
      p.y.inst("parasol-pole", surf("metalPanel", STEEL), parasolPole, pm);
      p.y.inst(
        i % 6 === 1 ? "parasol-a" : "parasol-b",
        surf("fabric", i % 6 === 1 ? SAFETY : FADED_RED),
        parasolCanopy,
        pm,
      );
      p.y.solid(x + spacing * 0.5, deck + 1.2, z + 1.5, 0.12, 1.2, 0.12, "metal", "metal");
    }
  }
}

/** A run of changing cabins: one block, doors in four colours, two ajar. */
function changingCabins(p: Park, x0: number, z: number, count: number, deck: number): void {
  const W = 1.9;
  const D = 2.1;
  const H = 2.4;
  const body = surf("plaster", RENDER_WHITE);
  const roof = surf("metalPanel", MUNI_BLUE);
  const doorColors = [MUNI_BLUE, SAFETY, FADED_RED];
  p.y.solidBox(body, x0 + count * W * 0.5, deck + H * 0.5, z, count * W * 0.5, H * 0.5, D * 0.5, "stone", { bevel: 0.05 });
  p.y.box(roof, x0 + count * W * 0.5, deck + H + 0.09, z, count * W * 0.5 + 0.18, 0.09, D * 0.5 + 0.18, { bevel: 0.04 });
  for (let i = 0; i < count; i++) {
    const x = x0 + (i + 0.5) * W;
    // Divider fins, so the block reads as cabins rather than as a long shed.
    p.y.box(body, x - W * 0.5, deck + H * 0.5, z - D * 0.5 - 0.06, 0.07, H * 0.5, 0.14, { bevel: 0.03 });
    const ajar = i % 4 === 2;
    const dc = doorColors[i % doorColors.length];
    // A door that is ajar is hung on its hinge and swung 42° — the detail that
    // makes a row of cabins look used.
    const hx = ajar ? 0.06 : W * 0.42;
    const hz = ajar ? W * 0.42 : 0.05;
    const px = ajar ? x - W * 0.42 + 0.4 : x;
    const pz = ajar ? z - D * 0.5 - 0.45 : z - D * 0.5 - 0.05;
    p.y.box(surf("woodPlank", dc), px, deck + 1.05, pz, hx, 1.0, hz, { bevel: 0.03, yaw: ajar ? 0.7 : 0 });
    p.y.cyl(surf("metalPanel", STEEL), px + (ajar ? 0.3 : W * 0.3), deck + 1.05, pz + (ajar ? 0.25 : -0.08), 0.03, 0.03, 0.22, { seg: 5 });
  }
  p.y.box(roof, x0 + count * W * 0.5, deck + H + 0.02, z, count * W * 0.5 + 0.22, 0.05, D * 0.5 + 0.22, { bevel: 0.02 });
}

/** A bank of lockers under the changing block's canopy. */
function lockerBank(p: Park, x0: number, x1: number, z: number, deck: number): void {
  const steel = surf("metalPanel", STEEL);
  const w = x1 - x0;
  p.y.solidBox(steel, (x0 + x1) * 0.5, deck + 0.95, z, w * 0.5, 0.95, 0.35, "metal", { bevel: 0.03 });
  const cols = Math.max(2, Math.round(w / 0.42));
  for (let i = 0; i <= cols; i++) {
    p.y.box(surf("metalPanel", MUNI_BLUE), lerp(x0, x1, i / cols), deck + 0.95, z - 0.36, 0.015, 0.93, 0.02, { bevel: 0 });
  }
  for (let i = 0; i < cols; i++) {
    for (const row of [0.55, 1.42]) {
      p.y.cyl(surf("metalPanel", STEEL), lerp(x0, x1, (i + 0.72) / cols), deck + row, z - 0.38, 0.022, 0.022, 0.09, { seg: 5, pitch: Math.PI / 2 });
    }
  }
}

/** A bus shelter: four posts, a curved roof, a bench and a timetable. */
function busShelter(p: Park, cx: number, cz: number, deck: number, yaw: number): void {
  const steel = surf("metalPanel", STEEL);
  const glass = surf("glass", 0xdfeef2);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      p.y.cyl(steel, cx + sx * 2.2, deck + 1.25, cz + sz * 0.9, 0.07, 0.07, 2.5, { seg: 6 });
    }
  }
  p.y.box(surf("metalPanel", MUNI_BLUE), cx, deck + 2.6, cz, 2.5, 0.08, 1.2, { bevel: 0.04, roll: 0.06 });
  p.y.solid(cx, deck + 2.6, cz, 2.5, 0.12, 1.2, "metal", "metal");
  p.y.box(glass, cx, deck + 1.3, cz + 0.95, 2.3, 1.15, 0.03, { bevel: 0 });
  p.y.box(surf("woodPlank", 0xa88a5e), cx, deck + 0.48, cz + 0.5, 2.0, 0.05, 0.22, { bevel: 0.03 });
  p.y.solid(cx, deck + 0.48, cz + 0.5, 2.0, 0.25, 0.3, "wood", "wood");
  for (const sx of [-1, 1]) p.y.box(steel, cx + sx * 1.7, deck + 0.24, cz + 0.5, 0.05, 0.24, 0.2, { bevel: 0.02 });
  signPanel(p, "busstop", cx + 2.9, deck + 2.2, cz, 1.3, yaw, { postsTo: deck, both: true });
}

/** The height-check post at the slide queue: a striped board with a limit. */
function heightPost(p: Park, x: number, z: number, deck: number, yaw: number): void {
  p.y.box(surf("plaster", SAFETY), x, deck + 1.1, z, 0.22, 1.1, 0.09, { bevel: 0.03, yaw });
  for (let i = 0; i < 6; i++) {
    p.y.box(surf("plaster", i % 2 ? FADED_RED : 0xf6f1e4), x, deck + 0.2 + i * 0.36, z - 0.055, 0.23, 0.16, 0.05, { bevel: 0, yaw });
  }
  p.y.solid(x, deck + 1.1, z, 0.25, 1.1, 0.25, "concrete", "stone");
  signPanel(p, "height", x, deck + 2.5, z, 1.2, yaw, {});
}

/** A coil of hose on a wall bracket. Ten seconds of geometry, and it works. */
function hoseCoil(p: Park, x: number, y: number, z: number, yaw: number): void {
  const hose = surf("rubber", 0x2f6b3f);
  for (let i = 0; i < 4; i++) {
    p.y.ring(hose, x, y - i * 0.055, z, 0.38 - i * 0.045, 0.045, 12, { tubeSeg: 5, pitch: Math.PI / 2, yaw });
  }
  p.y.cyl(surf("metalPanel", STEEL), x, y, z + 0.12, 0.05, 0.05, 0.3, { seg: 6, pitch: Math.PI / 2, yaw });
  // The last metre of it hanging down the wall, because a perfectly coiled
  // hose is a prop and a hose with a tail is a place somebody works.
  p.y.cyl(hose, x + 0.34, y - 0.55, z, 0.045, 0.045, 1.1, { seg: 5 });
}

/* ------------------------------------------------------------------------ *
 * Assembly
 *
 * Everything above is kit; this is the plan of the park. Positions are
 * fractions of the FITTED terrace rather than absolute metres, so when
 * `fitDeck` erodes a terrace off a hillside the layout moves with it instead
 * of hanging over the edge.
 * ------------------------------------------------------------------------ */

/** A step between two terraces, built only if they actually differ. */
function stepBetween(
  p: Park, fromY: number, toY: number,
  x: number, z: number, width: number,
  dir: "north" | "south" | "east" | "west",
  s: Surf,
): void {
  if (Math.abs(fromY - toY) < 0.3) return;
  stairs(p, x, z, fromY, toY, width, dir, s);
  // A handrail down the middle of anything wider than three metres, because
  // that is what municipal stairs have and it is the detail nobody draws.
  if (width > 3) {
    const run = Math.abs(fromY - toY) / 0.18 * 0.34;
    const dx = dir === "east" ? run : dir === "west" ? -run : 0;
    const dz = dir === "south" ? run : dir === "north" ? -run : 0;
    railing(p, x, z, x + dx, z + dz, Math.max(fromY, toY) - 0.4, surf("metalPanel", STEEL), 1.0);
  }
}

interface BuiltPark {
  river: RiverPath | null;
  bounds: Rect;
  center: THREE.Vector3;
  radius: number;
  /** Every terrace as it was actually fitted. Reported in `dz:lido-ready`. */
  terraces: Record<string, FittedDeck>;
}

function buildPark(
  p: Park,
  anim: Animated,
  root: THREE.Object3D,
  waterMesh: THREE.Material,
  solidMat: THREE.Material,
): BuiltPark {
  const t = p.tier;
  const dry = surf("concrete", DECK_DRY);
  const wetS = surf("concrete", DECK_WET);
  const coping = surf("concrete", COPING);
  const white = surf("plaster", RENDER_WHITE);
  const steel = surf("metalPanel", STEEL);
  const blue = surf("metalPanel", MUNI_BLUE);
  const red = surf("metalPanel", FADED_RED);

  // ---------------------------------------------------------------- terraces
  // Erosion budgets differ on purpose. The main shelf is flat and must keep
  // its size, so it gets two bites and then absorbs the rest in the paving.
  // The sea terrace is a hillside — eroding it would shrink it to nothing, so
  // it takes none and stands on a taller wall instead. The entrance corner is
  // the one place with a real hill in it, and eroding that hill away is
  // exactly what should happen: what is left is the flat bit by the road.
  const M = fitDeck(p, PLAN.main, 2);
  const L = fitDeck(p, PLAN.lower, 0);
  const E = fitDeck(p, PLAN.entrance, 3);
  p.main = M.top;
  p.entrance = E.top;
  p.lower = L.top;

  /** Everything on the main terrace is placed as a fraction of the FITTED
   *  rect: u runs west→east, v runs seaward(north)→inland(south). */
  const mx = (u: number) => lerp(M.rect.x0, M.rect.x1, u);
  const mz = (v: number) => lerp(M.rect.z0, M.rect.z1, v);

  // ---------------------------------------------------------------- the water
  const wave: Rect = { x0: mx(0.05), x1: mx(0.47), z0: mz(0.36), z1: mz(0.62) };
  const riverCx = mx(0.78);
  const riverCz = mz(0.50);
  const riverHx = (M.rect.x1 - M.rect.x0) * 0.155;
  const riverHz = (M.rect.z1 - M.rect.z0) * 0.16;

  // The tower stands at the seaward end of the same terrace, and its three
  // slides throw riders at three splash pools. Tower and pools are worked out
  // together, HERE, because the paving has to know to leave holes for them.
  const towerX = mx(0.38);
  const towerZ = mz(0.24);
  const splash: Record<string, Rect> = {
    helix: {
      x0: towerX + RUNOUT.helix.dx - 7, x1: towerX + RUNOUT.helix.dx + 7,
      z0: towerZ + RUNOUT.helix.dz - 7, z1: towerZ + RUNOUT.helix.dz + 7,
    },
    pipe: {
      x0: towerX + RUNOUT.pipe.dx - 8, x1: towerX + RUNOUT.pipe.dx + 8,
      z0: towerZ + RUNOUT.pipe.dz - 7, z1: towerZ + RUNOUT.pipe.dz + 7,
    },
    drop: {
      x0: towerX + RUNOUT.drop.dx - 7, x1: towerX + RUNOUT.drop.dx + 7,
      z0: towerZ + RUNOUT.drop.dz - 8, z1: towerZ + RUNOUT.drop.dz + 8,
    },
  };
  const splashRects = Object.values(splash);

  // The main terrace now knows what water it carries, so it can stand high
  // enough to hold it. Raising `top` never invalidates the layout above: every
  // rect on this terrace is a fraction of `M.rect`, which does not move.
  M.top = poolClearance(p, M.top, [
    { rect: wave, depth: 2.6 },
    ...splashRects.map((r) => ({ rect: r, depth: 1.0 })),
  ]);
  p.main = M.top;

  // The river is cut into the finished deck, so it is built only once the
  // terrace has been lifted to clear its pools.
  const river = buildLazyRiver(p, riverCx, riverCz, riverHx, riverHz, M.top);
  const inRiver = riverHole(river);

  // Wet-band rule: the deck is dark and slick within three and a half metres
  // of any water. It follows the pools' real shapes for free.
  const wetRects: Rect[] = [wave, ...splashRects];
  const surfAt = (x: number, z: number): Surf => {
    for (const r of wetRects) {
      if (x > r.x0 - 3.6 && x < r.x1 + 3.6 && z > r.z0 - 3.6 && z < r.z1 + 3.6) return wetS;
    }
    const scratch = _flowScratch;
    if (river.nearest(x, z, scratch) < river.half + 4.4) return wetS;
    return dry;
  };

  terraceMass(p, M.rect, M.top, white, coping, [wave, ...splashRects], inRiver);
  pave(p, M.rect, M.top, dry, { holes: [wave, ...splashRects], hole: inRiver, cell: 2, surfAt, harvest: "stone" });

  pool(p, {
    id: "wave", name: "Wave Pool", rect: wave, deck: M.top,
    // Deep at the north end, walk-in at the south. The shallow end faces the
    // entrance, so the first water you meet is water you can run in.
    depthA: 2.6, depthB: 0.4, axis: "z", lanes: 4, tile: TILE_TURQ,
  });

  // The wave machine at the deep end: a plant house with grilles and a walkway.
  {
    const wm: Rect = { x0: wave.x0, x1: wave.x1, z0: wave.z0 - 6.4, z1: wave.z0 - 1.6 };
    shed(p, wm, M.top, 3.6, { wall: white, roof: blue, trim: coping, parapet: 0.5 });
    for (let i = 0; i < 6; i++) {
      const x = lerp(wm.x0 + 2, wm.x1 - 2, i / 5);
      p.y.box(surf("corrugated", 0x9aa2a4), x, M.top + 1.8, wm.z1 - 0.02, 1.5, 0.85, 0.06, { bevel: 0 });
    }
    signPanel(p, "wavepool", rectCx(wm), M.top + 4.6, wm.z1 + 0.1, 4.4, 0, {});
    signPanel(p, "deepend", wave.x1 + 1.6, M.top + 1.5, wave.z0 + 3, 2.2, Math.PI * 0.5, { postsTo: M.top });
    signPanel(p, "shallow", wave.x1 + 1.6, M.top + 1.5, wave.z1 - 3, 2.2, Math.PI * 0.5, { postsTo: M.top });
    signPanel(p, "lanes", wave.x0 - 1.6, M.top + 1.5, rectCz(wave), 2.4, -Math.PI * 0.5, { postsTo: M.top });
    signPanel(p, "nodiving", wave.x0 + 6, M.top + 1.4, wave.z1 + 1.8, 2.0, Math.PI, { postsTo: M.top });
  }

  // Lifeguard chairs: one at each end of the wave pool, one on the river.
  const chairS = surf("plaster", PLASTIC);
  for (const [cx2, cz2] of [
    [wave.x1 + 2.4, wave.z0 + 4],
    [wave.x0 - 2.4, wave.z1 - 5],
    [riverCx - riverHx - 5.5, riverCz + 6],
  ]) {
    p.y.inst("guard-chair", chairS, lifeguardChair, xf(cx2, M.top, cz2, cx2 > riverCx ? -0.6 : 0.6));
    p.y.solid(cx2, M.top + 1.4, cz2, 0.55, 1.4, 0.55, "wood", "wood");
  }
  signPanel(p, "lifeguard", wave.x1 + 2.4, M.top + 3.6, wave.z0 + 4, 1.6, Math.PI, {});

  // --- the river island: hedged, with two bridges over the channel and the
  // one bench in the park nobody ever gets to sit on.
  {
    const ix = riverCx, iz = riverCz;
    const ihx = riverHx - river.half - 2.2;
    const ihz = riverHz - river.half - 2.2;
    hedgeRun(p, ix - ihx * 0.7, iz - ihz * 0.55, ix + ihx * 0.7, iz - ihz * 0.55, M.top);
    hedgeRun(p, ix - ihx * 0.7, iz + ihz * 0.55, ix + ihx * 0.7, iz + ihz * 0.55, M.top);
    for (let i = 0; i < Math.round(4 * t.props); i++) {
      const px = ix + (p.rng() - 0.5) * ihx * 1.2;
      const pz = iz + (p.rng() - 0.5) * ihz * 1.2;
      const m = xf(px, M.top, pz, p.rng() * TAU);
      p.y.inst("parasol-pole", surf("metalPanel", STEEL), parasolPole, m);
      p.y.inst("parasol-a", surf("fabric", SAFETY), parasolCanopy, m);
    }
    for (const sz of [-1, 1]) {
      const bz = iz + sz * riverHz;
      p.y.solidBox(coping, ix, M.top + 0.06, bz, 1.6, 0.16, river.half + 3.2, "stone", { bevel: 0.04 });
      railing(p, ix - 1.6, bz - river.half - 2, ix - 1.6, bz + river.half + 2, M.top + 0.2, steel, 1.0);
      railing(p, ix + 1.6, bz - river.half - 2, ix + 1.6, bz + river.half + 2, M.top + 0.2, steel, 1.0);
    }
    signPanel(p, "lazyriver", ix + riverHx + 1.2, M.top + 1.6, iz - riverHz * 0.5, 2.6, -Math.PI * 0.5, { postsTo: M.top });
  }

  // --- rubber rings, drifting round the ring. Instanced, per-instance colour.
  {
    const count = Math.max(3, Math.round(t.rings));
    const geo = rubberRing().toGeometry(TILE.rubber);
    const mesh = new THREE.InstancedMesh(geo, solidMat, count);
    mesh.name = "lido:rings";
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const cols = [0xf0bc2c, 0xc0503a, 0x2f7fae, 0x4aa96c, 0xf6f1e4];
    const set: RingSet = { mesh, s: [], speed: [], spin: [] };
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      set.s.push((i / count) * river.total + p.rng() * 4);
      set.speed.push(river.speed * (0.85 + p.rng() * 0.3));
      set.spin.push((p.rng() - 0.5) * 0.7);
      mesh.setColorAt(i, c.setHex(cols[i % cols.length]));
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    root.add(mesh);
    anim.geos.push(geo);
    anim.objects.push(mesh);
    anim.rings.push(set);
  }

  // ------------------------------------------------------- the south frontage
  {
    const zRow = mz(0.955);
    const cabinCount = Math.max(4, Math.round(8 * t.props));
    changingCabins(p, mx(0.05), zRow, cabinCount, M.top);
    signPanel(p, "changing", mx(0.05) + cabinCount * 0.95, M.top + 3.1, zRow - 1.2, 3.2, 0, {});
    lockerBank(p, mx(0.36), mx(0.46), zRow + 0.6, M.top);

    // The kiosk: shuttered hatch, awning, counter, bins, and the hose on its
    // flank. This is the corner of the park that has to look USED.
    const kiosk: Rect = { x0: mx(0.52), x1: mx(0.66), z0: mz(0.86), z1: mz(0.97) };
    shed(p, kiosk, M.top, 3.2, {
      wall: white, roof: red, trim: coping,
      hatch: { side: "n", w: 3.2, t: 0.5, drop: 0.42 },
      door: { side: "e", w: 1.1, t: 0.7 },
      awning: { side: "n", depth: 2.4, color: FADED_RED },
      parapet: 0.45,
    });
    signPanel(p, "snacks", rectCx(kiosk), M.top + 3.9, kiosk.z0 - 0.05, 4.2, 0, {});
    hoseCoil(p, kiosk.x0 - 0.2, M.top + 1.7, rectCz(kiosk), -Math.PI * 0.5);
    for (let i = 0; i < 3; i++) {
      p.y.inst("bin", surf("metalPanel", MUNI_BLUE), litterBin, xf(kiosk.x1 + 1.6 + i * 1.4, M.top, kiosk.z0 - 2.2, p.rng() * TAU));
    }
    signPanel(p, "rules", kiosk.x1 + 5.5, M.top + 2.4, mz(0.92), 2.2, 0, { postsTo: M.top });

    // First-aid hut, with the only cross in the park.
    const aid: Rect = { x0: mx(0.72), x1: mx(0.82), z0: mz(0.86), z1: mz(0.96) };
    shed(p, aid, M.top, 3.0, { wall: white, roof: blue, trim: coping, door: { side: "n", w: 1.2, t: 0.5 } });
    p.y.box(surf("plaster", FADED_RED), rectCx(aid), M.top + 2.2, aid.z0 - 0.02, 0.7, 0.22, 0.06, { bevel: 0.02 });
    p.y.box(surf("plaster", FADED_RED), rectCx(aid), M.top + 2.2, aid.z0 - 0.02, 0.22, 0.7, 0.06, { bevel: 0.02 });
    signPanel(p, "firstaid", rectCx(aid), M.top + 3.5, aid.z0 - 0.05, 2.6, 0, {});

    // Loungers, in rows, facing the water like everybody does.
    const rows = Math.max(1, Math.round(2 * t.props));
    for (let r2 = 0; r2 < rows; r2++) {
      loungerRow(p, mx(0.07), mz(0.66) + r2 * 4.2, Math.max(4, Math.round(9 * t.props)), 2.7, M.top, 0);
    }
    signPanel(p, "towel", mx(0.07), M.top + 1.3, mz(0.63), 1.8, 0, { postsTo: M.top });

    // The south-east quarter was 60 m of empty paving in the first wide shot.
    // A lido's deck is never empty: it is loungers, planters, bins and the bench
    // nobody sits on. All instanced, so this costs matrices, not draw calls.
    for (let r2 = 0; r2 < Math.max(1, Math.round(2 * t.props)); r2++) {
      loungerRow(p, mx(0.53), mz(0.68) + r2 * 4.2, Math.max(3, Math.round(6 * t.props)), 2.7, M.top, Math.PI);
    }
    for (let i = 0; i < Math.max(3, Math.round(7 * t.props)); i++) {
      const px = lerp(mx(0.12), mx(0.92), i / 6);
      // Planters: a stone trough with a clipped ball of hedge in it.
      p.y.solidBox(coping, px, M.top + 0.35, mz(0.735), 1.1, 0.35, 1.1, "stone", { bevel: 0.05 });
      p.y.inst("hedge", surf("foliage", HEDGE), () => bevelBox(1.0, 0.65, 0.55, 0.14), xf(px, M.top + 0.7, mz(0.735), i * 0.7));
      if (i % 2 === 0) {
        p.y.inst("bin", surf("metalPanel", MUNI_BLUE), litterBin, xf(px + 3.4, M.top, mz(0.735), p.rng() * TAU));
      } else {
        // A slatted bench, back to the water, facing the wrong way as always.
        p.y.box(surf("woodPlank", 0xa88a5e), px + 3.4, M.top + 0.45, mz(0.735), 1.0, 0.05, 0.24, { bevel: 0.03 });
        p.y.box(surf("woodPlank", 0xa88a5e), px + 3.4, M.top + 0.72, mz(0.735) + 0.26, 1.0, 0.26, 0.05, { bevel: 0.03 });
        for (const sx of [-1, 1]) p.y.box(surf("metalPanel", STEEL), px + 3.4 + sx * 0.85, M.top + 0.22, mz(0.735), 0.05, 0.22, 0.22, { bevel: 0.02 });
        p.y.solid(px + 3.4, M.top + 0.45, mz(0.735), 1.1, 0.45, 0.3, "wood", "wood");
      }
    }
    p.y.inst("guard-chair", surf("plaster", PLASTIC), lifeguardChair, xf(mx(0.63), M.top, mz(0.63), Math.PI));
    p.y.solid(mx(0.63), M.top + 1.4, mz(0.63), 0.55, 1.4, 0.55, "wood", "wood");
    signFloor(p, "norunning", mx(0.55), M.top, mz(0.62), 5.4, 0);
    signFloor(p, "norunning", mx(0.30), M.top, mz(0.30), 5.4, Math.PI * 0.5);
  }

  // Drains, in the wet band where the fall would actually take the water.
  if (t.trim) {
    for (let i = 0; i < 10; i++) {
      const x = lerp(wave.x0, wave.x1, (i + 0.5) / 10);
      p.y.inst("drain", surf("metalPanel", GRIME), drainGrate, xf(x, M.top + 0.01, wave.z1 + 2.6, 0));
      p.y.inst("drain", surf("metalPanel", GRIME), drainGrate, xf(x, M.top + 0.01, wave.z0 - 2.6, 0));
    }
  }

  // ------------------------------------------------------- the tower of slides
  for (const [id, r] of Object.entries(splash)) {
    pool(p, {
      id: `splash-${id}`, name: "Splash Pool", rect: r, deck: M.top,
      depthA: 1.0, depthB: 0.9, axis: "z", steps: true, tile: TILE_TURQ,
    });
  }
  buildSlideTower(p, towerX, towerZ, M.top, M.top);
  heightPost(p, towerX - 7.6, towerZ + 6.9, M.top, 0);
  // The queue rail at the foot of the tower stair — the one piece of furniture
  // that tells you this thing has a line.
  for (let i = 0; i < 3; i++) {
    railing(p, towerX - 5.5, towerZ + 8.4 + i * 1.6, towerX + 5.5, towerZ + 8.4 + i * 1.6, M.top, steel, 1.0);
  }

  // --------------------------------------------------------- the sea terrace
  //
  // A step down toward the beach: the diving stack over its deep pool, the
  // splash pad, and the one drained basin with a CLOSED FOR MAINTENANCE board
  // on it, because every municipal pool in the world has one.
  const dive: Rect = {
    x0: lerp(L.rect.x0, L.rect.x1, 0.07), x1: lerp(L.rect.x0, L.rect.x1, 0.42),
    z0: lerp(L.rect.z0, L.rect.z1, 0.10), z1: lerp(L.rect.z0, L.rect.z1, 0.66),
  };
  const padRect: Rect = {
    x0: lerp(L.rect.x0, L.rect.x1, 0.52), x1: lerp(L.rect.x0, L.rect.x1, 0.94),
    z0: lerp(L.rect.z0, L.rect.z1, 0.16), z1: lerp(L.rect.z0, L.rect.z1, 0.72),
  };
  const closedPool: Rect = {
    x0: lerp(L.rect.x0, L.rect.x1, 0.08), x1: lerp(L.rect.x0, L.rect.x1, 0.30),
    z0: lerp(L.rect.z0, L.rect.z1, 0.80), z1: lerp(L.rect.z0, L.rect.z1, 0.95),
  };
  L.top = poolClearance(p, L.top, [{ rect: dive, depth: 3.6 }, { rect: closedPool, depth: 1.9 }]);
  p.lower = L.top;
  terraceMass(p, L.rect, L.top, white, coping, [dive, padRect, closedPool]);
  pave(p, L.rect, L.top, dry, {
    holes: [dive, padRect, closedPool], cell: 2, harvest: "stone",
    surfAt: (x, z) => (x > dive.x0 - 4 && x < dive.x1 + 4 && z > dive.z0 - 4 && z < dive.z1 + 4 ? wetS : dry),
  });
  pool(p, {
    id: "dive", name: "Diving Pool", rect: dive, deck: L.top,
    depthA: 3.6, depthB: 3.4, axis: "z", steps: true, tile: TILE_TURQ,
  });
  buildDivingStack(p, rectCx(dive), dive.z1 + 3.4, L.top);
  signPanel(p, "deepend", dive.x0 - 1.6, L.top + 1.5, rectCz(dive), 2.2, -Math.PI * 0.5, { postsTo: L.top });
  buildSplashPad(p, anim, root, padRect, L.top, waterMesh, solidMat);

  // The drained one. No water surface, a tide line of old grime, a barrier
  // across it and a board nobody has taken down.
  {
    const cx2 = rectCx(closedPool), cz2 = rectCz(closedPool);
    const hx2 = (closedPool.x1 - closedPool.x0) * 0.5, hz2 = (closedPool.z1 - closedPool.z0) * 0.5;
    for (const [ox, oz, ahx, ahz] of [
      [0, -hz2, hx2 + 0.4, 0.4], [0, hz2, hx2 + 0.4, 0.4],
      [-hx2, 0, 0.4, hz2], [hx2, 0, 0.4, hz2],
    ]) {
      p.y.box(surf("concrete", 0x9fb7ac), cx2 + ox, L.top - 0.85, cz2 + oz, ahx, 0.85, ahz, { bevel: 0.04 });
      p.y.solid(cx2 + ox, L.top - 0.85, cz2 + oz, ahx, 0.85, ahz, "concrete", "stone");
    }
    p.y.box(surf("concrete", 0x9fb7ac), cx2, L.top - 1.75, cz2, hx2, 0.15, hz2, { bevel: 0.02 });
    p.y.solid(cx2, L.top - 1.75, cz2, hx2, 0.15, hz2, "concrete", "stone");
    p.y.inst("drain", surf("metalPanel", GRIME), drainGrate, xf(cx2, L.top - 1.58, cz2, 0));
    for (const sx of [-1, 1]) {
      p.y.cyl(surf("metalPanel", SAFETY), cx2 + sx * hx2, L.top + 0.55, cz2 - hz2 - 0.6, 0.06, 0.06, 1.1, { seg: 6 });
    }
    p.y.box(surf("metalPanel", SAFETY), cx2, L.top + 0.95, cz2 - hz2 - 0.6, hx2, 0.06, 0.05, { bevel: 0.02 });
    signPanel(p, "closed", cx2, L.top + 1.5, cz2 - hz2 - 0.6, 2.6, 0, {});
  }
  stepBetween(p, M.top, L.top, M.rect.x1 + 0.3, lerp(L.rect.z0, L.rect.z1, 0.55), 5, "east", coping);

  // ------------------------------------------------------------ the entrance
  //
  // Up on the high corner, where the road from Neon Heights arrives: car park,
  // bus stop, turnstiles, and the sign the whole place is named by.
  const ex = (u: number) => lerp(E.rect.x0, E.rect.x1, u);
  const ez = (v: number) => lerp(E.rect.z0, E.rect.z1, v);
  terraceMass(p, E.rect, E.top, white, coping);
  /**
   * The car park is CONCRETE with a grey tint, not the asphalt material, and
   * that is not a stylistic choice. `tinted()` multiplies in linear space into
   * a plate that is already painted, and the asphalt plate is painted at 0.027
   * linear — so even a near-white tint over it lands at about 0.02, i.e. a
   * surface darker than any real material. The first capture of this terrace
   * came back as a black lake with a sign floating over it. `pois.ts` carries
   * the same warning; this is what ignoring it looks like.
   */
  const tarmac = surf("concrete", 0xd6cec0);
  pave(p, E.rect, E.top, dry, { cell: 4, harvest: "stone", surfAt: (x) => (x > ex(0.18) ? tarmac : dry) });

  // Parking bays, painted. Nine of them and a disabled bay by the gate.
  for (let i = 0; i < Math.max(4, Math.round(9 * t.props)); i++) {
    const z = ez(0.30) + i * 2.8;
    if (z > E.rect.z1 - 3) break;
    p.y.box(surf("concrete", DECK_LINE), ex(0.62), E.top + 0.02, z, 2.6, 0.02, 0.07, { bevel: 0, mask: F_TOP });
  }
  p.y.box(surf("concrete", DECK_LINE), ex(0.62), E.top + 0.02, ez(0.30) - 1.4, 2.6, 0.02, 0.07, { bevel: 0, mask: F_TOP });
  signPanel(p, "carpark", ex(0.92), E.top + 2.4, ez(0.34), 2.2, -Math.PI * 0.5, { postsTo: E.top });
  busShelter(p, ex(0.45), E.rect.z1 - 4.5, E.top, 0);
  // A lifting barrier on the car park approach, arm up, with hazard banding.
  {
    const bxx = ex(0.30);
    const bzz = ez(0.24);
    p.y.solidBox(surf("metalPanel", STEEL), bxx, E.top + 0.55, bzz, 0.24, 0.55, 0.24, "metal", { bevel: 0.03 });
    p.y.cyl(surf("plaster", 0xf6f1e4), bxx + 1.9, E.top + 1.05, bzz, 0.07, 0.07, 3.8, { seg: 6, pitch: Math.PI / 2, yaw: Math.PI / 2 });
    for (let i = 0; i < 4; i++) {
      p.y.box(surf("plaster", FADED_RED), bxx + 0.6 + i * 0.9, E.top + 1.05, bzz, 0.22, 0.075, 0.075, { bevel: 0 });
    }
    p.y.inst("bin", surf("metalPanel", MUNI_BLUE), litterBin, xf(bxx - 1.2, E.top, bzz + 1.6, 0.4));
  }
  hedgeRun(p, ex(0.16), ez(0.30), ex(0.16), E.rect.z1 - 6, E.top);
  for (let i = 0; i < Math.max(3, Math.round(8 * t.props)); i++) {
    p.y.inst("bollard", surf("plaster", SAFETY), bollard, xf(ex(0.20), E.top, ez(0.28) + i * 3.2, 0));
    p.y.solid(ex(0.20), E.top + 0.45, ez(0.28) + i * 3.2, 0.16, 0.45, 0.16, "concrete", "stone");
  }

  // The gate: ticket kiosk, three turnstiles, the hours board, the big sign.
  {
    const gateZ = ez(0.16);
    const kiosk: Rect = { x0: ex(0.05), x1: ex(0.34), z0: gateZ - 4.4, z1: gateZ + 0.6 };
    shed(p, kiosk, E.top, 3.4, {
      wall: white, roof: blue, trim: coping,
      hatch: { side: "s", w: 2.4, t: 0.5, drop: 0.3 },
      door: { side: "e", w: 1.1, t: 0.5 },
      parapet: 0.6,
    });
    signPanel(p, "tickets", rectCx(kiosk), E.top + 4.2, kiosk.z1 + 0.05, 3.0, Math.PI, {});
    signPanel(p, "hours", kiosk.x1 + 2.6, E.top + 2.0, kiosk.z1 + 0.4, 1.8, Math.PI, { postsTo: E.top });
    for (let i = 0; i < 3; i++) {
      const tx = ex(0.46) + i * 1.9;
      p.y.inst("turnstile", surf("metalPanel", STEEL), turnstile, xf(tx, E.top, gateZ, 0));
      p.y.solid(tx, E.top + 0.55, gateZ, 0.2, 0.55, 0.2, "metal", "metal");
      p.y.box(surf("plaster", RENDER_WHITE), tx + 0.95, E.top + 0.6, gateZ, 0.12, 0.6, 0.9, { bevel: 0.04 });
      p.y.solid(tx + 0.95, E.top + 0.6, gateZ, 0.12, 0.6, 0.9, "concrete", "stone");
    }
    // The arch over the gate, and THE LIDO across it.
    for (const sx of [-1, 1]) {
      const px = sx < 0 ? ex(0.42) : ex(0.86);
      p.y.solidBox(white, px, E.top + 3.0, gateZ, 0.45, 3.0, 0.45, "stone", { bevel: 0.05 });
    }
    p.y.solidBox(surf("plaster", MUNI_BLUE), ex(0.64), E.top + 6.3, gateZ, (ex(0.86) - ex(0.42)) * 0.5 + 0.45, 0.3, 0.35, "stone", { bevel: 0.04 });
    // Hung UNDER the beam. At 5.2 m wide and centred on 5.1 it was a 5 m
    // square with the beam straight through the middle of the word LIDO.
    signPanel(p, "lido", ex(0.64), E.top + 4.0, gateZ + 0.15, 3.6, 0, { both: true });
  }

  // The grand stair down onto the main deck, and a hedge along the drop.
  stepBetween(p, E.top, M.top, E.rect.x0 - 0.3, ez(0.26), 7, "west", coping);
  hedgeRun(p, E.rect.x0 - 1, ez(0.42), E.rect.x0 - 1, E.rect.z1 - 2, E.top);

  // ------------------------------------------------------------- the fringe
  //
  // Hedge and chain-link round the outside. A park with no edge is a plaza;
  // the fence is what makes the turnstile mean something.
  const bounds: Rect = {
    x0: Math.min(M.rect.x0, L.rect.x0, E.rect.x0),
    x1: Math.max(M.rect.x1, L.rect.x1, E.rect.x1),
    z0: Math.min(M.rect.z0, L.rect.z0, E.rect.z0),
    z1: Math.max(M.rect.z1, L.rect.z1, E.rect.z1),
  };
  {
    const y0 = M.top;
    // South frontage and the west flank get the fence; the seaward edges get
    // the retaining wall and a railing instead, because a chain-link fence
    // along a nine-metre drop hides the one view the park has.
    fenceRun(p, M.rect.x0 - 0.6, M.rect.z1 + 0.6, M.rect.x1 + 0.6, M.rect.z1 + 0.6, y0);
    // The west flank's fence breaks for the side steps: a park with exactly one
    // way in is a park nobody can leave, and the deck now stands a storey above
    // the field it looks out over.
    fenceRun(p, M.rect.x0 - 0.6, M.rect.z1 + 0.6, M.rect.x0 - 0.6, mz(0.62), y0);
    fenceRun(p, M.rect.x0 - 0.6, mz(0.48), M.rect.x0 - 0.6, mz(0.30), y0);
    stairs(p, M.rect.x0 - 0.3, mz(0.55), M.top, p.ground(M.rect.x0 - 8, mz(0.55)), 4.4, "west", coping);
    railing(p, M.rect.x0 - 0.3, mz(0.55) - 2.4, M.rect.x0 - 9, mz(0.55) - 2.4, M.top - 0.5, steel, 1.0);
    railing(p, M.rect.x0 - 0.3, mz(0.55) + 2.4, M.rect.x0 - 9, mz(0.55) + 2.4, M.top - 0.5, steel, 1.0);
    hedgeRun(p, M.rect.x0 - 2.2, M.rect.z1 + 2.2, mx(0.5), M.rect.z1 + 2.2, y0);
    railing(p, M.rect.x0 + 0.4, M.rect.z0 + 0.4, M.rect.x1 - 0.4, M.rect.z0 + 0.4, y0, steel, 1.1);
    railing(p, M.rect.x0 + 0.4, M.rect.z0 + 0.4, M.rect.x0 + 0.4, mz(0.30), y0, steel, 1.1);
    railing(p, L.rect.x0 + 0.4, L.rect.z0 + 0.4, L.rect.x1 - 0.4, L.rect.z0 + 0.4, L.top, steel, 1.1);
    fenceRun(p, L.rect.x1 + 0.6, L.rect.z0, L.rect.x1 + 0.6, L.rect.z1, L.top);
  }

  const center = new THREE.Vector3((bounds.x0 + bounds.x1) * 0.5, M.top, (bounds.z0 + bounds.z1) * 0.5);
  const radius = Math.hypot(bounds.x1 - bounds.x0, bounds.z1 - bounds.z0) * 0.5;
  return { river, bounds, center, radius, terraces: { main: M, lower: L, entrance: E } };
}

/* ------------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------------ */

/** Nominal park centre, used only when terrain or materials never booted. */
const FALLBACK_CENTER = new THREE.Vector3(788, 36, -744);

const createLido: SystemFactory = (ctx: WorldCtx): System => {
  const pois = ctx.services.pois ?? (ctx.services.pois = []);
  const poi: Poi = {
    name: "The Lido",
    center: FALLBACK_CENTER.clone(),
    radius: 104,
    tier: "landmark",
  };
  pois.push(poi);

  const dropPoi = () => {
    const i = pois.indexOf(poi);
    if (i >= 0) pois.splice(i, 1);
  };

  const materials = ctx.services.materials;
  if (!materials) {
    // The POI still has to exist or loot, bots and the map lose the place —
    // exactly the bargain `pois.ts` makes when the bakery fails.
    console.warn("[Drop Zero] lido: no materials service; the park is a name on the map only.");
    return { name: "lido", dispose: dropPoi };
  }

  const tier = TIERS[ctx.quality] ?? TIERS.high;
  const terrain = ctx.services.terrain as TerrainLike | undefined;
  const root = new THREE.Group();
  root.name = "dz:lido";
  ctx.scene.add(root);

  // Private RNG: the park must lay out identically however much entropy the
  // systems that booted before us happened to draw from ctx.rng.
  const rng = makeRng(0x11d0_5eed);
  const yard = new Yard(materials, ctx.services.collision, tier.bevel);
  const anim = new Animated();

  /**
   * Pool water. Ours, not the library's, so it is ours to dispose.
   *
   * `depthWrite: false` is the important flag: with it on, the water surface
   * writes depth and the tiled floor 2.6 m under it stops being drawn at all
   * on some sort orders — a pool of flat cyan paint. Off, the floor reads
   * through it, which is the whole reason to have a shelving floor.
   */
  let waterMat: THREE.MeshStandardMaterial | null = null;
  /** Driven from `update` off `ctx.elapsed`. Never wall clock — see the note there. */
  const waterTime = { value: 0 };
  const makeWater = (): THREE.Material => {
    waterMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(WATER_TINT),
      transparent: true,
      /*
       * 0.58, not the 0.74 this started at. The Fresnel term below RAISES
       * alpha toward 1 as the view flattens, so this number is now only the
       * head-on case — the one where you are meant to see the tiled floor. Left
       * at 0.74 the pool came out as opaque turquoise milk from every angle,
       * which threw away the shelving floor that depthWrite:false exists to
       * show.
       */
      opacity: 0.58,
      roughness: 0.09,
      metalness: 0,
      envMap: materials.env ?? null,
      envMapIntensity: 1.15,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    /**
     * What makes it read as water rather than as cyan paint.
     *
     * The material above is already physically reasonable — low roughness, an
     * environment map, alpha under one — and it still photographed as a flat
     * sheet of colour, because a perfectly flat surface with a static
     * reflection has nothing in it that moves or changes with angle. Three
     * things fix that, and they are cheap because they are all one fragment:
     *
     *  1. RIPPLE. Two layers of gradient noise scrolling across world XZ at
     *     different rates and scales, perturbing the normal. World space, not
     *     UV: every pool, the lazy river and the splash pads share this one
     *     material, and a UV-space ripple would run in a different direction
     *     in each of them and break at every seam between two surfaces that
     *     are the same body of water.
     *
     *  2. FRESNEL. The single strongest cue that a surface is water. Looking
     *     down into a pool you see the floor; looking along it you see the
     *     sky, almost opaquely. A constant alpha of 0.74 everywhere throws
     *     that away, which is most of why the flat version read as paint —
     *     the far end of a pool should be a mirror and it was a window.
     *
     *  3. TINT, weighted by the same Fresnel. Where you are looking INTO the
     *     water rather than off it, the red end of what comes back has been
     *     through a depth of it and is gone. This is the cheap half of a
     *     transmission model and it is the half you can see.
     *
     * There was a fourth, and it is worth recording as a warning rather than
     * quietly dropping: thickening the water by how far the VIEW RAY travels
     * through it. Physically reasonable, and it saturates — standing in the
     * pool the ray is near-horizontal across the whole visible surface, so
     * every pixel pinned to maximum depth and the tiled floor disappeared
     * under a flat sheet of turquoise milk. At a grazing angle what you see is
     * the reflection, which is what Fresnel already says; ray length is not an
     * independent term, it is the same term counted twice.
     *
     * All three ride on `#include <normal_fragment_maps>` / the alpha at the
     * end of the fragment, so the standard lighting path — including the
     * env map, the shadows and the fog every other surface here uses — is
     * untouched. Nothing about this needs a second render target.
     */
    waterMat.onBeforeCompile = (shader) => {
      shader.uniforms.uLidoTime = waterTime;

      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
           varying vec3 vLidoWorld;`,
        )
        .replace(
          "#include <worldpos_vertex>",
          `#include <worldpos_vertex>
           vLidoWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
           uniform float uLidoTime;
           varying vec3 vLidoWorld;

           /* Value noise with a smooth derivative. Cheap, and the derivative
              is what we actually want: the gradient IS the ripple's slope, so
              the normal falls out without a second tap. */
           float lidoHash(vec2 p) {
             return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
           }
           vec3 lidoNoiseD(vec2 p) {
             vec2 i = floor(p);
             vec2 f = fract(p);
             vec2 u = f * f * (3.0 - 2.0 * f);
             vec2 du = 6.0 * f * (1.0 - f);
             float a = lidoHash(i);
             float b = lidoHash(i + vec2(1.0, 0.0));
             float c = lidoHash(i + vec2(0.0, 1.0));
             float d = lidoHash(i + vec2(1.0, 1.0));
             float k1 = b - a;
             float k2 = c - a;
             float k3 = a - b - c + d;
             return vec3(
               a + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
               du.x * (k1 + k3 * u.y),
               du.y * (k2 + k3 * u.x)
             );
           }`,
        )
        .replace(
          "#include <normal_fragment_maps>",
          `#include <normal_fragment_maps>
           {
             /* Two scales, drifting on different headings so neither one ever
                reads as a repeating direction. 1.7 m and 0.55 m: the coarse
                layer is what breaks up the sky reflection at a distance, the
                fine one is what you see at your feet. */
             vec3 nA = lidoNoiseD(vLidoWorld.xz * 1.15 + vec2(0.07, 0.041) * uLidoTime * 6.0);
             vec3 nB = lidoNoiseD(vLidoWorld.xz * 3.40 + vec2(-0.052, 0.089) * uLidoTime * 6.0);
             /* Shallow on purpose. A pool is not the open sea: the amplitude
                that reads right is the one that bends the REFLECTION, not one
                that visibly deforms the surface. Past about 0.1 the sky in it
                turns to gravel. */
             vec2 slope = nA.yz * 0.055 + nB.yz * 0.028;
             /* normal is in VIEW space here, and the slope was derived from
                world XZ. Rotating the perturbation into view space is not
                optional: added raw, the ripple is pinned to the screen and
                slides around the pool as the player turns, which looks like a
                bug in the camera rather than like water. */
             vec3 rippleW = vec3(slope.x, 0.0, slope.y);
             normal = normalize(normal + (viewMatrix * vec4(rippleW, 0.0)).xyz);
           }`,
        )
        .replace(
          "#include <dithering_fragment>",
          `{
             vec3 viewDir = normalize(vViewPosition);
             /* Schlick against the RIPPLED normal, so the mirror band at the
                far end of the pool shimmers instead of sitting there as a hard
                edge. 0.02 is water's F0. */
             float fres = 0.02 + 0.98 * pow(clamp(1.0 - dot(normalize(normal), viewDir), 0.0, 1.0), 5.0);

             /* Fresnel is the WHOLE alpha story, and getting there took one
                wrong turn worth recording. The first version also thickened the
                water by how far the view ray travels through it — physically
                reasonable, and it saturates: standing in the pool, the ray is
                near-horizontal across the entire visible surface, so every
                pixel pinned to maximum depth and the floor vanished under a
                flat sheet of milk. At a grazing angle what you actually see is
                the REFLECTION, which is what Fresnel already says. */
             gl_FragColor.a = clamp(mix(gl_FragColor.a, 1.0, fres), 0.0, 1.0);

             /* Bluer where you are looking INTO the water rather than off it —
                the red end goes first through any real depth of it. Applied to
                the composed colour so it tints the floor showing through,
                which is the only place the effect is visible at all. */
             gl_FragColor.rgb *= mix(vec3(1.0), vec3(0.78, 0.95, 1.05), (1.0 - fres) * 0.55);
           }
           #include <dithering_fragment>`,
        );
    };
    /* Changing onBeforeCompile after a material has been used needs this, and
       it is set once here rather than trusted to the first-use path. */
    waterMat.customProgramCacheKey = () => "lido-water-v1";

    return waterMat;
  };

  /** The signage atlas, painted once. */
  let signTex: THREE.CanvasTexture | null = null;
  let signMatCache: THREE.Material | null = null;
  const makeSign = (): THREE.Material => {
    if (signMatCache) return signMatCache;
    if (typeof document === "undefined") {
      // No DOM (a headless test importing this module): the park still builds,
      // it just has blank plates where the lettering would be.
      signMatCache = new THREE.MeshStandardMaterial({ color: 0xf6f1e4, roughness: 0.6 });
      return signMatCache;
    }
    signTex = new THREE.CanvasTexture(paintSignAtlas(tier.signPx));
    signTex.colorSpace = THREE.SRGBColorSpace;
    signTex.anisotropy = 4;
    signTex.needsUpdate = true;
    signMatCache = new THREE.MeshStandardMaterial({
      map: signTex,
      roughness: 0.58,
      metalness: 0,
      transparent: true,
      // Alpha test rather than blending: the atlas gutters are empty and a
      // blended sign sorts against the water it hangs over.
      alphaTest: 0.35,
    });
    return signMatCache;
  };

  const park: Park = {
    y: yard,
    rng,
    tier,
    terrain,
    ground: (x, z) => (terrain ? terrain.heightAt(x, z) : FALLBACK_CENTER.y),
    main: FALLBACK_CENTER.y,
    entrance: FALLBACK_CENTER.y,
    lower: FALLBACK_CENTER.y,
    pools: [],
    wet: [],
    signMat: makeSign,
    waterMat: makeWater,
  };

  let built: BuiltPark | null = null;
  try {
    built = buildPark(park, anim, root, makeWater(), materials.tinted("plaster", SAFETY));
  } catch (err) {
    // A park that half-built is still a landmark with loot in it; a park that
    // took the world down with it is a broken match.
    console.error("[Drop Zero] lido failed to build:", err);
  }
  yard.flush(root);

  const center = built ? built.center.clone() : FALLBACK_CENTER.clone();
  center.y = park.main;
  poi.center.copy(center);
  // The POI radius is not decoration: `vegetation.ts` and `props.ts` both skip
  // anything inside a registered POI, so a radius smaller than the park is a
  // park with saplings coming up through the changing rooms. It covers the
  // whole footprint, not the paved middle.
  poi.radius = built ? Math.min(132, Math.max(80, built.radius * 0.94)) : 104;

  const river = built?.river ?? null;
  const bounds = built?.bounds ?? {
    x0: center.x - 100, x1: center.x + 100, z0: center.z - 90, z1: center.z + 90,
  };

  const service: LidoService = {
    center,
    radius: poi.radius,
    decks: { main: park.main, entrance: park.entrance, lower: park.lower },
    flowAt(x, y, z, out) {
      const v = out ?? new THREE.Vector3();
      v.set(0, 0, 0);
      if (!river) return v;
      // Only in the channel, and only between its floor and its coping: the
      // bridge over the river is not in the river.
      if (y < river.floorY - 0.8 || y > river.deckY + 0.6) return v;
      const d = river.nearest(x, z, _flowScratch);
      if (d > river.half) return v;
      // Full speed mid-channel, easing off against the walls the way real
      // water does — and, more usefully, so a body pinned to the wall in a
      // fight is not also being dragged along it at full rate.
      const edge = clamp01((river.half - d) / (river.half * 0.5));
      return v.copy(_flowScratch).multiplyScalar(river.speed * (0.45 + 0.55 * edge));
    },
    contains(x, z) {
      return x >= bounds.x0 - 4 && x <= bounds.x1 + 4 && z >= bounds.z0 - 4 && z <= bounds.z1 + 4;
    },
    pools: park.pools,
  };
  ctx.services.lido = service;

  /**
   * Wet by default.
   *
   * A lido's deck is never dry, so the wetness field is asked for a puddle at
   * every point the park thinks water lands — pool rims, the splash pad, under
   * the dump bucket. They EVAPORATE, though (that is the whole design of that
   * system), so a single splash at boot would leave the park bone dry ninety
   * seconds into the match. They are therefore topped up round-robin, a few a
   * second, which merges into the existing puddle rather than allocating a new
   * one and so costs nothing in that system's fixed pool.
   */
  let wetCursor = 0;
  let nextTopUp = 0;
  let primed = false;
  const topUp = (n: number) => {
    // Resolved every time rather than captured: the park boots BEFORE the
    // wetness system (it has to, so vegetation skips the site), so the service
    // does not exist yet at factory time and the first frame is where the deck
    // actually gets wet.
    const wetness = (ctx.services as { wetness?: WetnessLike }).wetness;
    if (!wetness || park.wet.length === 0) return false;
    for (let i = 0; i < n; i++) {
      const pt = park.wet[wetCursor % park.wet.length];
      wetCursor++;
      wetness.splash(pt, 2.3, 2.4);
    }
    return true;
  };

  ctx.emit("dz:lido-ready", {
    decks: { main: park.main, entrance: park.entrance, lower: park.lower },
    terraces: built
      ? Object.fromEntries(
          Object.entries(built.terraces).map(([k, v]) => [
            k,
            { top: v.top, fill: Math.round(v.fill * 10) / 10, eroded: v.eroded, hi: Math.round(v.hi * 10) / 10, rect: v.rect },
          ]),
        )
      : null,
    meshNames: root.children.map((c) => c.name),
    center: { x: center.x, y: center.y, z: center.z },
    radius: poi.radius,
    bounds,
    pools: park.pools.map((x) => ({ id: x.id, x: x.center.x, z: x.center.z, depth: x.depth })),
    river: river ? { length: Math.round(river.total), speed: river.speed, stations: river.pts.length } : null,
    colliders: yard.colliders,
    triangles: Math.round(yard.tris),
    meshes: root.children.length,
    wetSpots: park.wet.length,
    signs: Object.keys(SIGNS).length,
  });

  // ------------------------------------------------------------------ update
  const _m = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3();
  const _ringP = new THREE.Vector3();
  const _flow = new THREE.Vector3();

  return {
    name: "lido",

    /** Cosmetics only. Everything here is timed off `ctx.elapsed`. */
    update(dt, c) {
      const t = c.elapsed;

      // The pool ripple. `ctx.elapsed` and not a wall clock: under software
      // rendering the simulation runs a few hundred times slower than the wall,
      // and a surface animated off `performance.now()` tears across the frame
      // while everything else in the park moves at a sensible rate.
      waterTime.value = t;

      for (const set of anim.jets) {
        for (let i = 0; i < set.items.length; i++) {
          const j = set.items[i];
          // A raised sine, so a jet spends most of its cycle low and fires in
          // bursts — and never goes to zero, because a jet that vanishes
          // photographs as a park with no jets in it.
          const phase = (t / j.period + j.phase) % 1;
          const pulse = Math.max(0, Math.sin(phase * TAU));
          const h = 0.7 + j.peak * Math.pow(pulse, 0.55);
          _pos.set(j.x, j.y, j.z);
          _quat.identity();
          _scale.set(1, h, 1);
          _m.compose(_pos, _quat, _scale);
          set.mesh.setMatrixAt(i, _m);
        }
        set.mesh.instanceMatrix.needsUpdate = true;
      }

      for (const b of anim.buckets) {
        const phase = ((t + b.phase) % b.period) / b.period;
        // Fills for four fifths of the cycle, goes over in a fifth of it.
        const tip = phase < 0.8 ? 0 : Math.sin(((phase - 0.8) / 0.2) * Math.PI);
        b.pivot.rotation.z = tip * 1.9;
        const pouring = tip > 0.35;
        b.sheet.visible = pouring;
        if (pouring) b.sheet.scale.set(1, b.fall * Math.min(1, (tip - 0.35) * 3), 1);
      }

      for (const set of anim.rings) {
        if (!river) break;
        for (let i = 0; i < set.s.length; i++) {
          set.s[i] += set.speed[i] * dt;
          river.at(set.s[i], _ringP);
          river.nearest(_ringP.x, _ringP.z, _flow);
          _pos.set(_ringP.x, river.waterY + 0.06, _ringP.z);
          _quat.setFromAxisAngle(_up, Math.atan2(_flow.x, _flow.z) + set.spin[i] * t);
          _scale.set(1, 1, 1);
          _m.compose(_pos, _quat, _scale);
          set.mesh.setMatrixAt(i, _m);
        }
        set.mesh.instanceMatrix.needsUpdate = true;
      }

      // Wet by default, then kept wet. The whole set goes down on the first
      // frame that finds a wetness field; after that a couple a second is
      // enough to outrun evaporation, and each one merges into the puddle
      // already there rather than allocating a new one.
      if (!primed) primed = topUp(park.wet.length);
      else if (t >= nextTopUp) {
        nextTopUp = t + 0.4;
        topUp(2);
      }
    },

    /**
     * THE CURRENT — how the river moves you without touching `player.ts`.
     *
     * It is a CONVEYOR: every fixed step, the local player's position is
     * advanced along the flow. Two things had to be measured before it ended
     * up that way, and both are worth keeping.
     *
     *  1. AN IMPULSE ALONE DOES NOTHING TO A STANDING BODY. The first version
     *     only emitted `dz:soak` — the event `weapons` already uses to shove
     *     someone with a Firehose, whose payload is a velocity delta for a
     *     named actor. Dropped in the channel with no input, the player moved
     *     7 cm in 3.5 simulated seconds while this system delivered 316
     *     impulses totalling 6.8 m/s of Δv. Raising the impulse eightfold got
     *     that to 20 cm. Whatever the movement code does to a grounded body
     *     with no input, it does it *after* our shove and *before* it
     *     integrates, so the shove never reaches the position.
     *  2. `teleport()` IS THE WRONG TOOL. It zeroes velocity, so calling it
     *     120 times a second would mean nobody could swim, run or be knocked
     *     about inside the river at all.
     *
     * So the position is advanced directly and velocity is left alone: the
     * player's own movement, the knockback from a soaking and the current all
     * add up, which is exactly what floating down a lazy river being shot at
     * should feel like. The `dz:soak` impulse is still sent, small, so the
     * water has some inertia and leaving the channel is a shove rather than a
     * wall.
     *
     * Nothing here is specific to the local player beyond `services.player`;
     * anything else that wants the current reads `lido.flowAt()`.
     */
    fixed(dt, c) {
      if (!river) return;
      const player = c.services.player;
      if (!player) return;
      const pos = player.position;
      if (pos.y < river.floorY - 0.9 || pos.y > river.deckY + 0.5) return;
      const d = river.nearest(pos.x, pos.z, _flow);
      if (d > river.half) return;
      // Full rate mid-channel, easing off against the walls: real water does
      // that, and it also means a body pinned to the wall in a fight is not
      // being dragged along it at full speed.
      const speed = river.speed * (0.45 + 0.55 * clamp01((river.half - d) / (river.half * 0.5)));
      pos.x += _flow.x * speed * dt;
      pos.z += _flow.z * speed * dt;
      const along = player.velocity.x * _flow.x + player.velocity.z * _flow.z;
      if (along < speed) {
        const add = Math.min(2.2 * dt, speed - along);
        c.emit("dz:soak", { id: "player", px: _flow.x * add, py: 0, pz: _flow.z * add });
      }
    },

    dispose() {
      // Order matters, exactly as in pois.ts: pull the group before the
      // engine's deep-disposer walks it, or it disposes the shared material
      // library's textures out from under every other system.
      root.parent?.remove(root);
      anim.dispose();
      for (const child of root.children) {
        const im = child as THREE.InstancedMesh;
        im.dispose?.();
      }
      root.clear();
      for (const g of yard.owned) g.dispose();
      yard.owned.length = 0;
      for (const r of yard.removers) r();
      yard.removers.length = 0;
      // Materials from the shared library are cached there by name+tint and
      // are NOT ours to dispose; the two we made ourselves are.
      for (const m of yard.ownedMats) m.dispose();
      yard.ownedMats.length = 0;
      waterMat?.dispose();
      signMatCache?.dispose();
      signTex?.dispose();
      signTex = null;
      signMatCache = null;
      waterMat = null;
      dropPoi();
      if (ctx.services.lido === service) ctx.services.lido = undefined;
    },
  };
};

export default createLido;

/**
 * BOOT — the exact line, and where it goes.
 *
 * In `src/royale/boot.ts`, import it with the other world modules:
 *
 *     import createLido from "./world/lido";
 *
 * and add ONE stage to `STAGES`, immediately after "Building the districts"
 * (`createPois`) and before "Scattering the props" (`createProps`) — position
 * 9 of the list, index 8:
 *
 *     { label: "Opening the lido", factory: createLido },
 *
 * Why exactly there:
 *   · AFTER `pois`, because the park appends to the `Poi[]` that system
 *     publishes, and after `terrain`, `collision` and `materials`, which are
 *     the three services it cannot build without.
 *   · BEFORE `props` and `vegetation`, which is the part that is easy to get
 *     wrong. Both of those skip anything inside a registered POI — that is
 *     what `inPoi()` in vegetation.ts is for. Boot the lido after them and the
 *     treeline has already been planted through the middle of the wave pool
 *     and there is a poplar coming up through the changing rooms.
 *   · BEFORE `loot`, `bots` and `storm`, all of which read `ctx.services.pois`
 *     at their own boot — a landmark added after them is a landmark with no
 *     chests in it and no bot ever dropping on it.
 *   · The one thing this ordering costs is that `wetness` is not up yet, so
 *     the park cannot splash during its own boot. It primes the deck on its
 *     first `update()` instead, which is the same frame as far as a player is
 *     concerned. See `topUp`.
 */
