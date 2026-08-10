/**
 * SPLASH ROYALE — wetness.
 *
 * The mechanic that makes the water mode more than a re-skin of DROP ZERO.
 * Four things live here, and they are all the same idea seen from different
 * angles: **water that lands somewhere stays there, and the map remembers.**
 *
 *   1. PUDDLES     water that lands accumulates into pooled ground decals that
 *                  grow, glint and evaporate. `splash()` / `wetnessAt()`.
 *   2. SLIPPING    those puddles cut ground friction, so sprinting into a big
 *                  one slides you across it. `frictionAt()`.
 *   3. WET TRACKS  a soaked player prints fading footprints behind them, and
 *                  anyone can follow the trail. `track()` / `trailNear()`.
 *   4. ECONOMY     drying stations restore dryness fast, water sources refill
 *                  tanks. `stations` / `dryingRateAt()` / `sourceNear()`.
 *
 * Together they turn "how wet am I" from a health bar into *information*.
 * Winning a fight leaves you dripping, and dripping leaves a trail — so the
 * reward for the kill is that you are now the easiest player on the island to
 * hunt, and the drying station is a place worth fighting over rather than a
 * regen timer. That loop is the whole reason this file exists.
 *
 * ── Why it is its own system rather than part of the player ───────────────
 * Puddles outlive the player who made them, bots need to read the same trail
 * data the renderer draws, and the HUD wants the nearest station without
 * knowing what a station is made of. One owner, one pool, one service.
 *
 * ── Mode gate ─────────────────────────────────────────────────────────────
 * `/drop-zero` is live and its loop is verified. In `classic` this system
 * allocates nothing, adds nothing to the scene and publishes an INERT service
 * whose `frictionAt` is a constant 1 and whose `wetnessAt` is a constant 0 —
 * so a caller in the player system can multiply unconditionally and classic
 * behaviour is a no-op multiply by one rather than a branch someone forgets.
 *
 * ── Timing ────────────────────────────────────────────────────────────────
 * Every rate, lifetime and age in this file is in SIMULATED seconds, measured
 * off `ctx.elapsed` and the `dt` handed to `fixed()`. Under SwiftSHADER the
 * simulation runs hundreds of times slower than wall clock, and anything timed
 * off `performance.now()` silently becomes a different game. Accumulation and
 * evaporation are physics and live in `fixed()`; uniform pushes and buffer
 * uploads are cosmetics and live in `update()`.
 *
 * ── Art direction ─────────────────────────────────────────────────────────
 * Water reads through TRANSPARENCY, REFRACTION and SPARKLE, never as blue
 * paint. A puddle is drawn with premultiplied alpha so one pass does two jobs
 * at once: the alpha channel *darkens* the ground underneath (roughness down,
 * not hue to blue) while the colour channel *adds* a sky reflection, a tight
 * sun glint riding an animated ripple normal, and a bright meniscus at the
 * rim. Nothing here is a blue circle.
 *
 * ── Consumes, all lazily and all null-checked ─────────────────────────────
 * `terrain` (ground height/normal/slope, the sea), `collision` (built floors
 * under a splash; prop colliders), `pois` (where stations and sources go),
 * `sky` (sun direction and daylight drive the glint and the evaporation
 * rate), `storm` (inside the Downpour it is raining, so puddles grow instead
 * of drying), `materials` (PBR for the props), `net` (remote splashes make
 * puddles too). Every one may be absent.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { WATER } from "../mode/water";
import type {
  CollisionService,
  MaterialsService,
  Poi,
  QualityTier,
  SkyService,
  StormService,
  System,
  SystemFactory,
  TerrainService,
  WorldCtx,
} from "../types";

/* ------------------------------------------------------------------------ *
 * Public contract
 * ------------------------------------------------------------------------ */

/** A warm-air blower at a POI. Contested ground: there are only a handful. */
export interface DryingStation {
  id: string;
  /** Display name for the HUD and for squad callouts. */
  name: string;
  /** Ground point at the mouth of the blower — stand here. */
  position: THREE.Vector3;
  /** Metres of effect. Full rate inside `radius * 0.6`, tapering to the rim. */
  radius: number;
  /** Dryness per SIMULATED second restored at the core. */
  rate: number;
  /** POI this belongs to, or null when placed on a fallback ring. */
  poi: string | null;
}

/** Somewhere you can refill a tank: the sea, a pool, a hydrant, a tower. */
export interface WaterSource {
  id: string;
  kind: "sea" | "pool" | "hydrant" | "tower";
  /** Centre of the water. For `sea` this is the nearest wet point found. */
  position: THREE.Vector3;
  /** Metres from `position` at which you count as "at" the source. */
  radius: number;
  /**
   * Multiplier on the weapon's own `dunkTime` refill speed. Plumbed sources
   * are pressurised and fill faster than standing in the surf — which is the
   * whole reason to walk to one.
   */
  refillRate: number;
  poi: string | null;
}

/** One wet footprint, as bots read it. */
export interface WetTrail {
  playerId: string;
  /** Live reference into a scratch vector — copy it if you keep it. */
  point: THREE.Vector3;
  /** Simulated seconds since it was printed. */
  age: number;
  /** 0..1 — how wet the player was. Louder trail = wetter quarry. */
  strength: number;
  /** Direction of travel when it was printed, radians. */
  yaw: number;
}

/** What the wetness system publishes. Every method is safe on the inert one. */
export interface WetnessService {
  /**
   * Water landed here. `radius` is the footprint of the splash in metres and
   * `amount` is how much water it was, in arbitrary but consistent units
   * (a stream droplet is ~0.3; a burst water balloon is ~9). Merges into a
   * nearby puddle when there is one, allocates from the pool when there is
   * not, and evicts the smallest puddle when the pool is full.
   */
  splash(point: THREE.Vector3, radius: number, amount: number): void;
  /** 0..1 standing water at a ground position. Includes the shallow sea. */
  wetnessAt(x: number, z: number): number;
  /**
   * Ground-friction multiplier, `SLIP_FLOOR`..1. The player system multiplies
   * this into its own friction — it never needs to know a puddle exists.
   */
  frictionAt(x: number, z: number): number;
  /**
   * A soaked player is standing here. Rate-limited internally to one print per
   * stride, so callers may pass a foot position every step without thinking
   * about it. `wetness` is 0..1; below `TRACK_MIN_WETNESS` nothing prints.
   */
  track(playerId: string, point: THREE.Vector3, wetness: number): void;
  /** Freshest footprint within `range`, ignoring `excludeId`. Bots hunt on this. */
  trailNear(point: THREE.Vector3, range: number, excludeId?: string): WetTrail | null;
  /** Every drying station on the map. Do not mutate. */
  readonly stations: readonly DryingStation[];
  /** Nearest station within `range` (default: unlimited). */
  stationNear(point: THREE.Vector3, range?: number): DryingStation | null;
  /** Dryness per SIMULATED second a blower is giving this point. 0 outside one. */
  dryingRateAt(point: THREE.Vector3): number;
  /** Every placed water prop. The sea is not in here — it is everywhere. */
  readonly sources: readonly WaterSource[];
  /** Nearest refill within `range`, including the sea. Null when dry ground. */
  sourceNear(point: THREE.Vector3, range: number): WaterSource | null;
  readonly puddleCount: number;
  readonly trackCount: number;
  /** Wipe every puddle and footprint. For a match restart. */
  clear(): void;
}

declare module "../types" {
  interface WorldServices {
    /**
     * Standing water, slip, wet footprints and the map's water economy.
     * Present but inert in `classic` mode; absent only if the system failed
     * to boot at all. Callers must still null-check, as with every service.
     */
    wetness?: WetnessService;
  }
}

/** Payload emitted on `dz:wet` for the HUD, a few times a second. */
export interface WetEvent {
  /** Standing water under the player, 0..1. */
  wetness: number;
  friction: number;
  /** Metres to the nearest station, and whether the player is inside it. */
  stationName: string | null;
  stationDist: number;
  inStation: boolean;
  /** Metres to the nearest refill, and whether the player is in range. */
  sourceKind: WaterSource["kind"] | null;
  sourceDist: number;
  atSource: boolean;
  puddles: number;
  tracks: number;
}

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

/**
 * Pool sizes. Puddles and footprints are both capped ring-buffer pools drawn
 * as one InstancedMesh each, so the cost of a twenty-minute match is bounded
 * at exactly two extra draw calls no matter how much water gets thrown.
 */
interface WetBudget {
  puddles: number;
  tracks: number;
  stations: number;
  sources: number;
  /** Disc tessellation. A puddle is never more than ~5 m across. */
  discSegs: number;
  /** The shimmer column over a station is the first thing to go. */
  shimmer: boolean;
}

const BUDGETS: Record<QualityTier, WetBudget> = {
  low: { puddles: 64, tracks: 96, stations: 3, sources: 8, discSegs: 14, shimmer: false },
  medium: { puddles: 128, tracks: 192, stations: 4, sources: 12, discSegs: 20, shimmer: true },
  high: { puddles: 224, tracks: 320, stations: 5, sources: 14, discSegs: 26, shimmer: true },
  ultra: { puddles: 320, tracks: 448, stations: 5, sources: 16, discSegs: 32, shimmer: true },
};

/* ------------------------------------------------------------------- puddles */

/**
 * Volume → radius. A puddle spreads as the square root of what fell in it,
 * which is both roughly true and, more importantly, means the first squirt
 * makes a visible mark while the twentieth only widens it a little. Without
 * the sqrt a firefight paints the ground into one flat sheet.
 */
const PUDDLE_R_BASE = 0.34;
const PUDDLE_R_SCALE = 0.55;
/** Hard cap on a *dynamic* puddle. Pools (permanent) are allowed past it. */
const PUDDLE_R_MAX = 4.6;
/** Below this volume a puddle is gone. */
const PUDDLE_R_MIN_VOLUME = 0.02;

/**
 * A new splash merges into an existing puddle when it lands inside this
 * fraction of that puddle's radius. Generous: two people trading shots at one
 * doorway should carve one growing pond, not forty overlapping discs, and the
 * pool is small enough that overlapping discs would evict each other anyway.
 */
const PUDDLE_MERGE_FRACTION = 1.15;
/** Extra metres of merge tolerance on top of that fraction. */
const PUDDLE_MERGE_SLACK = 0.7;

/**
 * Evaporation. Two terms, because one is not enough: the proportional term
 * (`PUDDLE_DECAY`) makes big puddles shrink fast at first and slow as they
 * get small, and the constant term (`PUDDLE_EVAP`) is what finally closes
 * them out — with decay alone a puddle takes forever to reach zero and the
 * pool fills up with invisible slivers.
 *
 * At noon: a single-squirt puddle is gone in ~17 s, a balloon burst in ~70 s.
 * Long enough that a fight leaves a readable mark on the ground; short enough
 * that the island is not a swamp by circle four.
 */
const PUDDLE_DECAY = 0.035;
const PUDDLE_EVAP = 0.055;
/** Evaporation multiplier from full night to full noon. Sun dries things. */
const PUDDLE_SUN_MIN = 0.45;
const PUDDLE_SUN_MAX = 1.5;
/** Volume added per simulated second to a puddle standing in the Downpour. */
const PUDDLE_RAIN_GAIN = 0.4;
/** Seconds a puddle takes to fade in. Water spreading, not a decal popping. */
const PUDDLE_FADE_IN = 0.28;
/** Volume at which a puddle reads as "deep" — full darkening, full slip. */
const PUDDLE_DEEP_VOLUME = 7;

/**
 * Puddles do not form on a hillside; the water runs off. Above this slope
 * (0 flat, 1 vertical) a splash is discarded, and below it the radius is
 * scaled down as the ground tilts — which also keeps the flat disc we draw
 * close enough to the ground that it never floats.
 */
const PUDDLE_MAX_SLOPE = 0.42;

/* -------------------------------------------------------------------- slip */

/**
 * Ground friction on soaked ground.
 *
 * The mode table already fixes what a fresh balloon puddle does to movement
 * (`WATER.balloon.puddleFriction`, 0.72 — a speed multiplier the player system
 * applies separately). Friction is the other half of that: this is what lets
 * you keep your momentum instead of stopping, which is what makes a slide a
 * slide. Deriving the floor from the same number keeps the two in step if the
 * balance table ever moves.
 *
 * 0.18 means a sprinting player carries roughly five times as far across deep
 * water as across grass — long enough to overshoot a doorway and be funny,
 * short enough to recover before you fall off anything.
 */
const SLIP_FLOOR = WATER.balloon.puddleFriction * 0.25;
/**
 * Friction falls off faster than wetness rises, so the *edge* of a puddle is
 * already slick. A puddle you can walk to the middle of before it does
 * anything reads as broken.
 */
const SLIP_CURVE = 0.7;

/* ------------------------------------------------------------------ tracks */

/** Simulated seconds a footprint takes to dry to nothing. */
const TRACK_LIFE = 30;
/** Metres between prints. Roughly one human stride. */
const TRACK_STRIDE = 1.05;
/** Below this wetness you are not dripping enough to leave anything. */
const TRACK_MIN_WETNESS = 0.06;
/** Lateral offset of each foot from the centre line, metres. */
const TRACK_FOOT_OFFSET = 0.17;
/** Quad size. A shoe is ~0.3 m; the rest is margin for the soft edge. */
const TRACK_SIZE = 0.46;
/** Per-player stride bookkeeping older than this (simulated s) is dropped. */
const TRACK_WALKER_TTL = 90;

/* ---------------------------------------------------------------- economy */

/**
 * A station restores dryness five times faster than standing still in the
 * shade does (`WATER.dryness.dryRate`, 3.2/s) — a full bar in about six
 * seconds. That is fast enough to be worth crossing open ground for and short
 * enough that holding one is a commitment rather than a camp.
 */
const STATION_RATE = WATER.dryness.dryRate * 5;
/** Metres of effect, and the fraction of it that runs at the full rate. */
const STATION_RADIUS = 4.6;
const STATION_CORE = 0.6;
/** Height of the visible warm-air column. Readable from a ridge line. */
const STATION_COLUMN_H = 9;

/** How fast each kind of source fills a tank, relative to the weapon's dunk time. */
const SOURCE_RATE: Record<WaterSource["kind"], number> = {
  sea: 1.0,
  pool: 1.15,
  hydrant: 1.5,
  tower: 1.9,
};

/** Radii at which each kind counts as "you are at it". */
const SOURCE_RADIUS: Record<WaterSource["kind"], number> = {
  sea: 3.0,
  pool: 5.4,
  hydrant: 2.2,
  tower: 3.4,
};

/* --------------------------------------------------------------- rendering */

/** Metres a decal is lifted off its surface, on top of the polygon offset. */
const PUDDLE_LIFT = 0.055;
const TRACK_LIFT = 0.04;
/**
 * Drawn before the vfx decal layer (renderOrder 6) so bullet holes and scorch
 * still land on top of standing water rather than under it.
 */
const PUDDLE_RENDER_ORDER = 4;
const TRACK_RENDER_ORDER = 5;

/** Spatial hash cell sizes. Puddles are big and few; prints are small and many. */
const PUDDLE_CELL = 12;
const TRACK_CELL = 8;

/* ------------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------------ */

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Smoothstep with the edges already normalised. */
const smooth01 = (t: number): number => t * t * (3 - 2 * t);

/**
 * A sparse uniform grid over the island.
 *
 * Both pools are queried by position far more often than they are written —
 * `frictionAt` runs every fixed step for every actor — so the linear scan that
 * would be fine at 64 puddles is not fine at 320 puddles times ten bots times
 * 120 Hz. Entries never move once inserted (a puddle's centre is fixed for its
 * whole life), which is what makes a hash this simple correct.
 */
class SpatialGrid {
  private cells = new Map<number, number[]>();

  constructor(private readonly size: number) {}

  key(x: number, z: number): number {
    // +2048 keeps both indices non-negative for a 4096 m half-world, so the
    // pair packs into one integer key without a string allocation.
    const ix = Math.floor(x / this.size) + 2048;
    const iz = Math.floor(z / this.size) + 2048;
    return ix * 4096 + iz;
  }

  add(key: number, index: number): void {
    const bucket = this.cells.get(key);
    if (bucket) bucket.push(index);
    else this.cells.set(key, [index]);
  }

  remove(key: number, index: number): void {
    const bucket = this.cells.get(key);
    if (!bucket) return;
    const at = bucket.indexOf(index);
    if (at >= 0) bucket.splice(at, 1);
    if (bucket.length === 0) this.cells.delete(key);
  }

  /** Visit every index whose cell overlaps the square of side 2*range at (x,z). */
  near(x: number, z: number, range: number, fn: (index: number) => void): void {
    const s = this.size;
    const x0 = Math.floor((x - range) / s);
    const x1 = Math.floor((x + range) / s);
    const z0 = Math.floor((z - range) / s);
    const z1 = Math.floor((z + range) / s);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const bucket = this.cells.get((ix + 2048) * 4096 + (iz + 2048));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) fn(bucket[i]);
      }
    }
  }

  clear(): void {
    this.cells.clear();
  }
}

/**
 * `mergeGeometries` refuses to merge geometries whose attribute sets differ,
 * and three's primitives have picked up and dropped attributes across
 * versions. Strip everything down to position/normal/uv before merging — the
 * same defence pois.ts, props.ts and loot.ts all had to grow.
 */
function normaliseGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
  }
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  if (!g.getAttribute("uv")) {
    const count = g.getAttribute("position").count;
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  return g;
}

/** Merge a list of already-transformed parts, tolerating an empty list. */
function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  const normalised = parts.map(normaliseGeometry);
  if (normalised.length === 1) return normalised[0];
  const merged = mergeGeometries(normalised, false);
  for (const p of normalised) p.dispose();
  return merged;
}

/** Never let a decal layer answer a raycast — weapons and build previews use it. */
const NO_RAYCAST = (): void => {};

/* ------------------------------------------------------------------------ *
 * Shaders
 *
 * Both decal layers use PREMULTIPLIED ALPHA, and that is the whole trick that
 * makes wet ground look wet in one pass:
 *
 *     result = rgb + dst * (1 - a)
 *
 * The alpha channel is *coverage*, and because the destination is multiplied
 * by `1 - a` it DARKENS whatever is underneath — which is what water actually
 * does to a surface. The colour channel is then free to be pure added light:
 * the sky reflected off an animated ripple normal, a very tight sun glint, and
 * a bright meniscus at the rim. Nothing is ever tinted blue; the blue you see
 * is the sky, reflected, which is where it comes from in life too.
 * ------------------------------------------------------------------------ */

/** Scene fog, reproduced so a decal at 400 m sits behind the haze. */
const FOG_PARS = /* glsl */ `
uniform vec3  uFogColor;
uniform vec3  uFogParams;  // near, far, density
uniform float uFogKind;    // 0 none, 1 linear, 2 exp2
float fogFactor(float viewZ) {
  if (uFogKind > 1.5) return 1.0 - exp(-uFogParams.z * uFogParams.z * viewZ * viewZ);
  if (uFogKind > 0.5) return smoothstep(uFogParams.x, uFogParams.y, viewZ);
  return 0.0;
}
`;

const PUDDLE_VERT = /* glsl */ `
attribute vec3 pPos;   // world centre, on the surface
attribute vec3 pNrm;   // surface normal (terrain or built floor)
attribute vec4 pData;  // radius, strength, seed, fade

varying vec3  vWorld;
varying vec3  vNrm;
varying vec3  vTan;
varying vec3  vBit;
varying vec2  vLocal;
varying float vStrength;
varying float vFade;
varying float vSeed;
varying float vViewZ;

void main() {
  float r = pData.x;
  float fade = pData.w;

  // Build a tangent frame on the surface normal so a puddle on a shallow
  // slope lies IN the slope instead of slicing through it. The reference
  // vector swaps near the pole so the cross product never degenerates.
  vec3 up = normalize(pNrm);
  vec3 ref = abs(up.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  // Not named 'tan'/'bitangent' — 'tan' shadows a GLSL builtin and some
  // drivers are stricter about that than the spec is.
  vec3 tgt = normalize(cross(ref, up));
  vec3 btg = cross(up, tgt);

  vec2 local = position.xz;
  vec3 world = pPos + (tgt * local.x + btg * local.y) * r + up * ${PUDDLE_LIFT.toFixed(4)};

  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  // Dead or collapsed instances are pushed outside the clip volume rather
  // than drawn transparent: zero-area geometry still costs a fragment quad.
  if (fade <= 0.0 || r <= 0.0001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

  vWorld = world;
  vNrm = up;
  vTan = tgt;
  vBit = btg;
  vLocal = local;
  vStrength = pData.y;
  vFade = fade;
  vSeed = pData.z;
  vViewZ = -mv.z;
}
`;

const PUDDLE_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3  uCamPos;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyHigh;
uniform vec3  uSkyLow;
uniform float uDaylight;

varying vec3  vWorld;
varying vec3  vNrm;
varying vec3  vTan;
varying vec3  vBit;
varying vec2  vLocal;
varying float vStrength;
varying float vFade;
varying float vSeed;
varying float vViewZ;

${FOG_PARS}

void main() {
  float r = length(vLocal);
  if (r > 1.0) discard;

  // Coverage, with a wobbled outline.
  //
  // A perfect circle reads as a decal no matter how good the shading is, and
  // eighty perfect circles read as soap bubbles — which is exactly what the
  // first capture of this shader came back as. Three harmonics of the polar
  // angle, seeded per puddle, break the edge into something water-shaped, and
  // because the seed differs per instance two overlapping puddles no longer
  // trace two concentric rings.
  float ang = atan(vLocal.y, vLocal.x);
  float wob = 0.070 * sin(ang * 3.0 + vSeed)
            + 0.045 * sin(ang * 5.0 - vSeed * 2.1)
            + 0.028 * sin(ang * 8.0 + vSeed * 3.3);
  float edge = 0.74 + wob;
  float cov = (1.0 - smoothstep(edge, edge + 0.24, r)) * vFade;
  if (cov < 0.004) discard;

  // ---- ripple normal --------------------------------------------------
  // Three scrolling sine sets, differentiated analytically rather than
  // sampled from a texture: it costs three cosines, needs no VRAM, and
  // because the phase is driven off WORLD position two puddles that overlap
  // ripple as one sheet of water instead of two discs with seams.
  vec2 p = vWorld.xz * 1.45;
  float a1 = p.x * 2.3 + uTime * 1.55 + vSeed;
  float a2 = p.y * 2.9 - uTime * 1.15 + vSeed * 1.7;
  float a3 = (p.x + p.y) * 4.1 + uTime * 2.40;
  float amp = 0.055 * (0.4 + 0.6 * vStrength);
  float dx = (0.50 * 2.3 * cos(a1) + 0.28 * 4.1 * cos(a3)) * amp;
  float dy = (0.50 * 2.9 * cos(a2) + 0.28 * 4.1 * cos(a3)) * amp;
  vec3 n = normalize(vNrm - vTan * dx - vBit * dy);

  vec3 V = normalize(uCamPos - vWorld);
  float ndv = max(dot(n, V), 0.0);
  // Schlick for water: almost nothing head-on, a mirror at a grazing angle.
  // This is the single term that makes it read as a surface rather than paint.
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  vec3 rd = reflect(-V, n);
  vec3 sky = mix(uSkyLow, uSkyHigh, clamp(rd.y * 0.5 + 0.5, 0.0, 1.0));

  vec3 H = normalize(uSunDir + V);
  float ndh = max(dot(n, H), 0.0);
  float sheen = pow(ndh, 240.0);
  float glint = pow(ndh, 1100.0);

  // A meniscus: water climbs the lip of its own puddle and catches the light
  // there. It has to be VERY quiet. The first pass gave it a third of the
  // frame's brightness and eighty puddles came back as eighty white rings —
  // the layer is additive and a firefight stacks four or five of them, so
  // every term in here is divided by how many can overlap, not by how it
  // looks on one disc in isolation.
  float rim = smoothstep(edge - 0.16, edge, r) * (1.0 - smoothstep(edge, edge + 0.22, r));

  // ---- composite ------------------------------------------------------
  // The alpha channel IS the darkening, and it is the loudest thing here:
  // soaked ground goes darker and glossier, never bluer. Everything added on
  // top is a highlight on that darker ground.
  float dark = cov * (0.34 + 0.40 * vStrength);
  vec3 rgb = vec3(0.040, 0.055, 0.070) * dark;
  // Reflection weighted by coverage squared: the soft outer skirt of a disc
  // is where overlaps pile up, so it contributes almost nothing and the
  // middle of the water does the reflecting.
  rgb += sky * fres * cov * cov * 0.34;
  rgb += uSunColor * (sheen * 1.4 + glint * 5.0) * cov * uDaylight;
  rgb += mix(uSkyLow, vec3(1.0), 0.5) * rim * cov * (0.035 + 0.040 * vStrength);

  // Aerial perspective: a decal three hundred metres out must fade into the
  // haze with everything else. Both channels go, because a premultiplied
  // surface that keeps its alpha keeps darkening the ground through the fog.
  float fg = fogFactor(vViewZ);
  rgb *= (1.0 - fg);
  dark *= (1.0 - fg);

  gl_FragColor = vec4(rgb, dark);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const TRACK_VERT = /* glsl */ `
attribute vec3 tPos;   // world position of the print
attribute vec4 tData;  // yaw, signed size (sign = which foot), strength, born

uniform float uTime;
uniform float uLife;

varying vec2  vUv;
varying vec3  vWorld;
varying float vAlpha;
varying float vStrength;
varying float vViewZ;

void main() {
  float age = uTime - tData.w;
  float size = abs(tData.y);
  float foot = tData.y < 0.0 ? -1.0 : 1.0;

  float c = cos(tData.x);
  float s = sin(tData.x);
  vec2 l = position.xz * size;
  vec3 world = tPos + vec3(l.x * c + l.y * s, ${TRACK_LIFT.toFixed(4)}, -l.x * s + l.y * c);

  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;

  // A print appears over one footfall, holds, then dries off. The tail is
  // deliberately long and shallow: a trail whose last third is invisible is a
  // trail you cannot follow, and following it is the entire mechanic.
  float t = age / max(uLife, 0.0001);
  float a = smoothstep(0.0, 0.06, t) * pow(max(1.0 - t, 0.0), 1.25) * tData.z;
  float dead = step(1.0, t) + step(age, -0.0001) + step(size, 0.0001);
  if (dead > 0.0 || a <= 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

  // Mirror the sole for the left foot so a trail reads as a pair of feet.
  vUv = vec2(position.x * foot, position.z);
  vWorld = world;
  vAlpha = a;
  vStrength = tData.z;
  vViewZ = -mv.z;
}
`;

const TRACK_FRAG = /* glsl */ `
uniform vec3  uCamPos;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyLow;
uniform float uDaylight;

varying vec2  vUv;
varying vec3  vWorld;
varying float vAlpha;
varying float vStrength;
varying float vViewZ;

${FOG_PARS}

void main() {
  // A foot, as two ellipses and three toes. Cheaper than a texture, and it
  // stays crisp when you are standing on top of it.
  vec2 uv = vUv;
  float sole = length((uv - vec2(0.0, -0.09)) / vec2(0.200, 0.285));
  float heel = length((uv - vec2(0.0,  0.255)) / vec2(0.150, 0.165));
  float m = min(sole, heel);
  float cov = 1.0 - smoothstep(0.86, 1.06, m);

  float toes = 1.0;
  toes = min(toes, length((uv - vec2(-0.115, -0.335)) / vec2(0.055, 0.052)));
  toes = min(toes, length((uv - vec2( 0.000, -0.360)) / vec2(0.058, 0.055)));
  toes = min(toes, length((uv - vec2( 0.115, -0.330)) / vec2(0.052, 0.050)));
  cov = max(cov, 1.0 - smoothstep(0.80, 1.10, toes));

  cov *= vAlpha;
  if (cov < 0.005) discard;

  // A fresh print is still standing water: enough of a sheen that a trail
  // catches the sun as you cross it, which is how you spot one at range.
  vec3 V = normalize(uCamPos - vWorld);
  vec3 n = vec3(0.0, 1.0, 0.0);
  vec3 H = normalize(uSunDir + V);
  float sheen = pow(max(dot(n, H), 0.0), 90.0);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);

  float dark = cov * (0.22 + 0.26 * vStrength);
  vec3 rgb = vec3(0.045, 0.060, 0.075) * dark;
  rgb += uSkyLow * fres * cov * 0.30;
  rgb += uSunColor * sheen * cov * uDaylight * 1.1;

  float fg = fogFactor(vViewZ);
  rgb *= (1.0 - fg);
  dark *= (1.0 - fg);

  gl_FragColor = vec4(rgb, dark);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * The warm-air column over a drying station. Additive, unlit, no depth write:
 * it is light in the air, not a surface. Rising streaks are keyed off world Y
 * so two stations never shimmer in lock step.
 */
const SHIMMER_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
varying float vViewZ;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const SHIMMER_FRAG = /* glsl */ `uniform float uTime;
uniform vec3  uWarm;
uniform float uIntensity;
uniform float uGround;   // 1 = flat ground glow, 0 = vertical column

varying vec2 vUv;
varying vec3 vWorld;
varying float vViewZ;

${FOG_PARS}

void main() {
  float a;
  if (uGround > 0.5) {
    // A soft pool of warm light on the ground with two slow swirling arms,
    // so the station reads as *running* from any angle without a moving mesh.
    float r = length(vUv * 2.0 - 1.0);
    float base = 1.0 - smoothstep(0.25, 1.0, r);
    float ang = atan(vUv.y - 0.5, vUv.x - 0.5);
    float swirl = 0.55 + 0.45 * sin(ang * 2.0 - uTime * 1.9 + r * 5.0);
    a = base * (0.55 + 0.45 * swirl);
  } else {
    // Column: fades out with height, pinches in at the top, and carries
    // rising bands of hot air.
    float h = vUv.y;
    float body = (1.0 - smoothstep(0.0, 1.0, h)) * smoothstep(0.0, 0.08, h);
    float streak = 0.5 + 0.5 * sin(vWorld.y * 2.6 - uTime * 3.4 + vUv.x * 26.0);
    float wobble = 0.5 + 0.5 * sin(vUv.x * 12.0 + uTime * 1.3);
    a = body * (0.35 + 0.45 * streak) * (0.6 + 0.4 * wobble);
  }
  a *= uIntensity;
  a *= 1.0 - fogFactor(vViewZ);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uWarm * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------------ *
 * Inert service — classic mode, and the fallback when we cannot boot
 * ------------------------------------------------------------------------ */

const EMPTY_STATIONS: readonly DryingStation[] = [];
const EMPTY_SOURCES: readonly WaterSource[] = [];

function inertService(): WetnessService {
  return {
    splash() {},
    wetnessAt: () => 0,
    // A constant 1 so the player system can multiply unconditionally: in
    // classic this is a no-op multiply, not a branch someone has to remember.
    frictionAt: () => 1,
    track() {},
    trailNear: () => null,
    stations: EMPTY_STATIONS,
    stationNear: () => null,
    dryingRateAt: () => 0,
    sources: EMPTY_SOURCES,
    sourceNear: () => null,
    puddleCount: 0,
    trackCount: 0,
    clear() {},
  };
}

/* ------------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------------ */

const createWetness: SystemFactory = (ctx: WorldCtx): System => {
  // ---- mode gate --------------------------------------------------------
  // `/drop-zero` is live and its loop is verified 18/18. Classic must behave
  // EXACTLY as it does today, so we allocate nothing and touch no scene.
  if (ctx.mode !== "water") {
    ctx.services.wetness = inertService();
    return {
      name: "wetness",
      dispose() {
        if (ctx.services.wetness) ctx.services.wetness = undefined;
      },
    };
  }

  const budget = BUDGETS[ctx.quality] ?? BUDGETS.high;

  /** Every geometry/material/texture we own, for an unambiguous teardown. */
  const ownedGeometries: THREE.BufferGeometry[] = [];
  const ownedMaterials: THREE.Material[] = [];
  const ownedObjects: THREE.Object3D[] = [];
  const colliderRemovers: (() => void)[] = [];
  const netUnsubs: (() => void)[] = [];

  const root = new THREE.Group();
  root.name = "soaked:wetness";
  root.matrixAutoUpdate = false;
  ctx.scene.add(root);

  // Our own RNG stream. Drawing from `ctx.rng` directly would shift every
  // other system's worldgen depending on whether we booted, which is exactly
  // the kind of thing that makes a "deterministic" seed useless.
  let rngState = (Math.floor(ctx.rng() * 0xffffffff) ^ 0x5f3a91c7) >>> 0;
  const rng = (): number => {
    rngState = (rngState + 0x6d2b79f5) >>> 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /* -------------------------------------------------------------- scratch */

  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpN = new THREE.Vector3();
  const tmpRayOrigin = new THREE.Vector3();
  const DOWN = new THREE.Vector3(0, -1, 0);
  const trailScratch: WetTrail = {
    playerId: "",
    point: new THREE.Vector3(),
    age: 0,
    strength: 0,
    yaw: 0,
  };

  /* ------------------------------------------------------------- services */

  /**
   * Terrain publishes more than the shared `TerrainService` contract. Those
   * extras are read structurally and optionally — a build where terrain is
   * the base interface still works, it just falls back to a normal-derived
   * slope and skips the coastline early-out.
   */
  interface TerrainExtras extends TerrainService {
    slopeAt?(x: number, z: number): number;
    coastDistanceAt?(x: number, z: number): number;
    waterDepthAt?(x: number, z: number): number;
  }

  /** The bits of the transport we touch. Everything optional; net may be absent. */
  interface NetLike {
    on?(kind: string, fn: (from: string, payload: unknown) => void): () => void;
  }

  const terrain = (): TerrainExtras | undefined => ctx.services.terrain as TerrainExtras | undefined;
  const collision = (): CollisionService | undefined => ctx.services.collision;
  const sky = (): SkyService | undefined => ctx.services.sky;
  const storm = (): StormService | undefined => ctx.services.storm;

  const seaLevel = (): number => terrain()?.seaLevel ?? 0;

  function groundY(x: number, z: number): number {
    return terrain()?.heightAt(x, z) ?? 0;
  }

  /** 0 flat, 1 vertical. Falls back to the surface normal when unpublished. */
  function slopeAt(x: number, z: number): number {
    const t = terrain();
    if (!t) return 0;
    if (typeof t.slopeAt === "function") return t.slopeAt(x, z);
    t.normalAt(x, z, tmpN);
    return clamp01(1 - Math.abs(tmpN.y));
  }

  /** Metres of standing sea water above the ground here, 0 on land. */
  function seaDepthAt(x: number, z: number): number {
    const t = terrain();
    if (!t) return 0;
    if (typeof t.waterDepthAt === "function") return Math.max(0, t.waterDepthAt(x, z));
    if (t.isWater(x, z)) return Math.max(0, t.seaLevel - t.heightAt(x, z));
    return 0;
  }

  /* ------------------------------------------------------------------------ *
   * Puddles
   *
   * Structure-of-arrays rather than an array of objects: the same numbers get
   * copied straight into the instance attributes every frame, and a match
   * writes them hundreds of times a second.
   * ------------------------------------------------------------------------ */

  const pCap = budget.puddles;
  const pX = new Float32Array(pCap);
  const pY = new Float32Array(pCap);
  const pZ = new Float32Array(pCap);
  const pNx = new Float32Array(pCap);
  const pNy = new Float32Array(pCap);
  const pNz = new Float32Array(pCap);
  const pVol = new Float32Array(pCap);
  const pRad = new Float32Array(pCap);
  const pMaxRad = new Float32Array(pCap);
  const pBorn = new Float32Array(pCap);
  const pSeed = new Float32Array(pCap);
  const pAlive = new Uint8Array(pCap);
  /** 1 = permanent (a pool). Never evaporates, never evicted, no radius cap. */
  const pPermanent = new Uint8Array(pCap);
  /** Grid cell this puddle was filed under, so removal is O(bucket). */
  const pCell = new Int32Array(pCap);

  const puddleGrid = new SpatialGrid(PUDDLE_CELL);
  let puddleLive = 0;
  /** Round-robin start for the eviction scan, so it is amortised O(1). */
  let puddleCursor = 0;

  for (let i = 0; i < pCap; i++) {
    pNy[i] = 1;
    pSeed[i] = rng() * 100;
  }

  function volumeToRadius(vol: number, cap: number): number {
    return Math.min(cap, PUDDLE_R_BASE + PUDDLE_R_SCALE * Math.sqrt(Math.max(0, vol)));
  }

  function killPuddle(i: number): void {
    if (!pAlive[i]) return;
    pAlive[i] = 0;
    pVol[i] = 0;
    pRad[i] = 0;
    puddleGrid.remove(pCell[i], i);
    puddleLive--;
  }

  /**
   * Claim a slot. Prefers a free one; when the pool is full it evicts the
   * smallest non-permanent puddle it can find in a bounded scan. Returns -1
   * when the caller should merge into an existing puddle instead — which is
   * what happens when everything alive is already bigger than what just fell.
   */
  function allocPuddle(incomingVolume: number): number {
    if (pCap === 0) return -1;
    if (puddleLive < pCap) {
      for (let n = 0; n < pCap; n++) {
        const i = (puddleCursor + n) % pCap;
        if (!pAlive[i]) {
          puddleCursor = (i + 1) % pCap;
          return i;
        }
      }
    }
    let worst = -1;
    let worstVol = Infinity;
    for (let i = 0; i < pCap; i++) {
      if (pPermanent[i]) continue;
      if (pVol[i] < worstVol) {
        worstVol = pVol[i];
        worst = i;
      }
    }
    if (worst < 0 || worstVol >= incomingVolume) return -1;
    killPuddle(worst);
    return worst;
  }

  /**
   * Resolve the surface a splash landed on.
   *
   * Terrain is the common case and costs one height sample. Only when the
   * splash is meaningfully above the terrain do we pay for a raycast, which is
   * how a puddle ends up on top of a player's built floor rather than on the
   * grass eight metres below it.
   */
  function resolveSurface(point: THREE.Vector3, out: THREE.Vector3, normal: THREE.Vector3): boolean {
    const t = terrain();
    const gy = t ? t.heightAt(point.x, point.z) : point.y;
    if (t) t.normalAt(point.x, point.z, normal);
    else normal.set(0, 1, 0);
    out.set(point.x, gy, point.z);

    const above = point.y - gy;
    const col = collision();
    if (col && above > 0.6) {
      tmpRayOrigin.set(point.x, point.y + 0.5, point.z);
      const hit = col.raycast(tmpRayOrigin, DOWN, above + 0.9);
      if (hit) {
        out.copy(hit.point);
        // A splash on a wall is running water, not a puddle; only near-flat
        // surfaces hold it.
        if (hit.normal.y < 0.72) return false;
        normal.copy(hit.normal);
        return true;
      }
    }
    // Sea and deep water are already water — no decal needed, and one would
    // z-fight with the ocean surface anyway.
    if (t && t.seaLevel - gy > 0.35) return false;
    return true;
  }

  function addPuddle(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    volume: number,
    maxRadius: number,
    permanent: boolean,
  ): number {
    const i = allocPuddle(volume);
    if (i < 0) return -1;
    pX[i] = x;
    pY[i] = y;
    pZ[i] = z;
    pNx[i] = nx;
    pNy[i] = ny;
    pNz[i] = nz;
    pVol[i] = volume;
    pMaxRad[i] = maxRadius;
    pRad[i] = volumeToRadius(volume, maxRadius);
    pBorn[i] = ctx.elapsed;
    pSeed[i] = rng() * 100;
    pAlive[i] = 1;
    pPermanent[i] = permanent ? 1 : 0;
    pCell[i] = puddleGrid.key(x, z);
    puddleGrid.add(pCell[i], i);
    puddleLive++;
    return i;
  }

  function splash(point: THREE.Vector3, radius: number, amount: number): void {
    if (!(amount > 0) || pCap === 0) return;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) return;

    const slope = slopeAt(point.x, point.z);
    // Water runs off a hillside. Discarding steep splashes is both correct and
    // what keeps the flat disc we draw from floating off the ground.
    if (slope > PUDDLE_MAX_SLOPE) return;

    if (!resolveSurface(point, tmpA, tmpN)) return;

    // The incoming footprint sets a floor on how wide the puddle can get, so a
    // wide balloon burst spreads immediately instead of growing from a dot.
    const cap = Math.max(
      0.5,
      Math.min(PUDDLE_R_MAX, Math.max(radius, 0.6)) * (1 - slope * 1.2),
    );

    // ---- merge into a neighbour ----------------------------------------
    let best = -1;
    let bestD = Infinity;
    puddleGrid.near(tmpA.x, tmpA.z, PUDDLE_R_MAX, (i) => {
      if (!pAlive[i]) return;
      const dx = pX[i] - tmpA.x;
      const dz = pZ[i] - tmpA.z;
      // Puddles on a built floor and puddles on the ground below it share an
      // XZ position; the vertical test is what keeps them separate.
      if (Math.abs(pY[i] - tmpA.y) > 1.6) return;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < pRad[i] * PUDDLE_MERGE_FRACTION + PUDDLE_MERGE_SLACK && d < bestD) {
        bestD = d;
        best = i;
      }
    });

    if (best >= 0) {
      if (pPermanent[best]) return; // A pool is already full of water.
      pVol[best] += amount;
      pMaxRad[best] = Math.max(pMaxRad[best], cap);
      pRad[best] = volumeToRadius(pVol[best], pMaxRad[best]);
      // Nudge the centre toward the new water so a stream walking across the
      // ground drags its puddle with it instead of leaving a fixed dot.
      const w = Math.min(0.28, amount / Math.max(pVol[best], 0.001));
      pX[best] += (tmpA.x - pX[best]) * w;
      pZ[best] += (tmpA.z - pZ[best]) * w;
      pY[best] += (tmpA.y - pY[best]) * w;
      return;
    }

    addPuddle(tmpA.x, tmpA.y, tmpA.z, tmpN.x, tmpN.y, tmpN.z, amount, cap, false);
  }

  /** 0..1 standing water. Max over overlapping puddles, plus the shallow sea. */
  function wetnessAt(x: number, z: number): number {
    let w = 0;
    puddleGrid.near(x, z, PUDDLE_R_MAX + 2, (i) => {
      if (!pAlive[i]) return;
      const r = pRad[i];
      if (r <= 0) return;
      const dx = pX[i] - x;
      const dz = pZ[i] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) return;
      const t = 1 - Math.sqrt(d2) / r;
      // Depth matters: a single squirt is damp, a pond is a skating rink.
      const depth = pPermanent[i]
        ? 1
        : 0.3 + 0.7 * clamp01(pVol[i] / PUDDLE_DEEP_VOLUME);
      const c = smooth01(clamp01(t * 1.25)) * depth;
      if (c > w) w = c;
    });
    if (w >= 1) return 1;

    // Standing in the surf is standing in water. Only the shallows count —
    // past wading depth the player is swimming and friction is moot.
    const depth = seaDepthAt(x, z);
    if (depth > 0.02) {
      const s = clamp01(depth / 0.8);
      if (s > w) w = s;
    }
    return w;
  }

  function frictionAt(x: number, z: number): number {
    const w = wetnessAt(x, z);
    if (w <= 0) return 1;
    return 1 - (1 - SLIP_FLOOR) * Math.pow(w, SLIP_CURVE);
  }

  /* ------------------------------------------------------------------------ *
   * Wet tracks
   * ------------------------------------------------------------------------ */

  const tCap = budget.tracks;
  const tX = new Float32Array(tCap);
  const tY = new Float32Array(tCap);
  const tZ = new Float32Array(tCap);
  const tYaw = new Float32Array(tCap);
  const tSize = new Float32Array(tCap);
  const tStrength = new Float32Array(tCap);
  const tBorn = new Float32Array(tCap);
  const tCellKey = new Int32Array(tCap);
  const tAlive = new Uint8Array(tCap);
  const tOwner: string[] = new Array(tCap).fill("");

  const trackGrid = new SpatialGrid(TRACK_CELL);
  let trackWrite = 0;
  let trackLive = 0;

  /** Per-player stride bookkeeping, so `track()` can be called every step. */
  interface Walker {
    x: number;
    z: number;
    /** +1 right, -1 left. */
    foot: number;
    /** `ctx.elapsed` of the last call, for pruning. */
    seen: number;
    /** True once the first position has been seeded. */
    started: boolean;
  }
  const walkers = new Map<string, Walker>();

  function killTrack(i: number): void {
    if (!tAlive[i]) return;
    tAlive[i] = 0;
    trackGrid.remove(tCellKey[i], i);
    trackLive--;
  }

  function emitTrack(
    playerId: string,
    x: number,
    y: number,
    z: number,
    yaw: number,
    strength: number,
  ): void {
    if (tCap === 0) return;
    const i = trackWrite;
    trackWrite = (trackWrite + 1) % tCap;
    // Ring buffer: the oldest print is always the one that goes. That is the
    // right eviction policy here, because a trail is only useful as its most
    // recent end.
    killTrack(i);
    tX[i] = x;
    tY[i] = y;
    tZ[i] = z;
    tYaw[i] = yaw;
    tSize[i] = TRACK_SIZE;
    tStrength[i] = strength;
    tBorn[i] = ctx.elapsed;
    tOwner[i] = playerId;
    tAlive[i] = 1;
    tCellKey[i] = trackGrid.key(x, z);
    trackGrid.add(tCellKey[i], i);
    trackLive++;
  }

  function track(playerId: string, point: THREE.Vector3, wetness: number): void {
    if (tCap === 0) return;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) return;

    let w = walkers.get(playerId);
    if (!w) {
      w = { x: point.x, z: point.z, foot: 1, seen: ctx.elapsed, started: false };
      walkers.set(playerId, w);
    }
    w.seen = ctx.elapsed;

    // Below the threshold we still track the position, so the first print
    // after a soaking lands a full stride from where they got wet rather than
    // wherever they happened to be standing when the water hit.
    if (wetness < TRACK_MIN_WETNESS) {
      w.x = point.x;
      w.z = point.z;
      w.started = true;
      return;
    }

    const dx = point.x - w.x;
    const dz = point.z - w.z;
    const dist = Math.hypot(dx, dz);
    if (w.started && dist < TRACK_STRIDE) return;
    if (!w.started) {
      w.started = true;
      w.x = point.x;
      w.z = point.z;
      return;
    }

    const yaw = Math.atan2(dx, dz);
    // Prints go either side of the line of travel. Perpendicular in XZ is
    // (cos yaw, -sin yaw) for yaw measured as atan2(dx, dz).
    const px = Math.cos(yaw) * TRACK_FOOT_OFFSET * w.foot;
    const pz = -Math.sin(yaw) * TRACK_FOOT_OFFSET * w.foot;
    const fx = point.x + px;
    const fz = point.z + pz;

    // Sit the print on the ground unless the caller is clearly on a built
    // floor, in which case their own Y is the better answer.
    const gy = groundY(fx, fz);
    const y = Math.abs(point.y - gy) < 1.2 ? gy : point.y;

    emitTrack(playerId, fx, y, fz, yaw, clamp01(wetness));

    // A dripping player also wets the ground they walk on — a very small
    // amount, so a trail is visible information without turning every corridor
    // anyone has run down into a slip hazard.
    if (wetness > 0.45) splash(tmpB.set(fx, y + 0.05, fz), 0.55, 0.05 * wetness);

    w.foot = -w.foot;
    w.x = point.x;
    w.z = point.z;
  }

  function trailNear(point: THREE.Vector3, range: number, excludeId?: string): WetTrail | null {
    if (tCap === 0 || range <= 0) return null;
    let best = -1;
    let bestBorn = -Infinity;
    trackGrid.near(point.x, point.z, range, (i) => {
      if (!tAlive[i]) return;
      if (excludeId && tOwner[i] === excludeId) return;
      const dx = tX[i] - point.x;
      const dz = tZ[i] - point.z;
      if (dx * dx + dz * dz > range * range) return;
      // Freshest wins, not nearest: a trail is followed forwards, and the
      // newest print is the end you want to chase.
      if (tBorn[i] > bestBorn) {
        bestBorn = tBorn[i];
        best = i;
      }
    });
    if (best < 0) return null;
    trailScratch.playerId = tOwner[best];
    trailScratch.point.set(tX[best], tY[best], tZ[best]);
    trailScratch.age = ctx.elapsed - tBorn[best];
    trailScratch.strength = tStrength[best];
    trailScratch.yaw = tYaw[best];
    return trailScratch;
  }

  /* ------------------------------------------------------------------------ *
   * Decal meshes
   * ------------------------------------------------------------------------ */

  /** Sun/sky uniforms, shared by both decal layers so they light identically. */
  const uTime = { value: 0 };
  const uCamPos = { value: new THREE.Vector3() };
  const uSunDir = { value: new THREE.Vector3(0.4, 0.78, 0.3).normalize() };
  const uSunColor = { value: new THREE.Color(1.0, 0.94, 0.82) };
  const uSkyHigh = { value: new THREE.Color(0.32, 0.58, 0.92) };
  const uSkyLow = { value: new THREE.Color(0.74, 0.87, 0.96) };
  const uDaylight = { value: 1 };
  const uFogColor = { value: new THREE.Color(0.62, 0.84, 0.92) };
  const uFogParams = { value: new THREE.Vector3(1, 1000, 0.00025) };
  const uFogKind = { value: 2 };

  /** Puddles and prints are far from the camera-space origin; never cull them. */
  const infiniteSphere = (): THREE.Sphere =>
    new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e7);

  // ---- puddle mesh ------------------------------------------------------
  const puddlePos = new Float32Array(pCap * 3);
  const puddleNrm = new Float32Array(pCap * 3);
  const puddleData = new Float32Array(pCap * 4);
  for (let i = 0; i < pCap; i++) puddleNrm[i * 3 + 1] = 1;

  const puddleGeo = new THREE.InstancedBufferGeometry();
  {
    const segs = budget.discSegs;
    const pos = new Float32Array((segs + 1) * 3);
    const idx = new Uint16Array(segs * 3);
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pos[(i + 1) * 3] = Math.cos(a);
      pos[(i + 1) * 3 + 1] = 0;
      pos[(i + 1) * 3 + 2] = Math.sin(a);
      idx[i * 3] = 0;
      idx[i * 3 + 1] = 1 + i;
      idx[i * 3 + 2] = 1 + ((i + 1) % segs);
    }
    puddleGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    puddleGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  }
  const aPuddlePos = new THREE.InstancedBufferAttribute(puddlePos, 3);
  const aPuddleNrm = new THREE.InstancedBufferAttribute(puddleNrm, 3);
  const aPuddleData = new THREE.InstancedBufferAttribute(puddleData, 4);
  for (const a of [aPuddlePos, aPuddleNrm, aPuddleData]) a.setUsage(THREE.DynamicDrawUsage);
  puddleGeo.setAttribute("pPos", aPuddlePos);
  puddleGeo.setAttribute("pNrm", aPuddleNrm);
  puddleGeo.setAttribute("pData", aPuddleData);
  puddleGeo.instanceCount = pCap;
  puddleGeo.boundingSphere = infiniteSphere();
  ownedGeometries.push(puddleGeo);

  const puddleMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime, uCamPos, uSunDir, uSunColor, uSkyHigh, uSkyLow, uDaylight,
      uFogColor, uFogParams, uFogKind,
    },
    vertexShader: PUDDLE_VERT,
    fragmentShader: PUDDLE_FRAG,
    transparent: true,
    // The whole composite depends on this: alpha darkens the ground, colour
    // adds light. See the shader header.
    premultipliedAlpha: true,
    depthWrite: false,
    // Millimetres off the surface is not enough at a grazing angle on a
    // 3 km island; the polygon offset is what actually stops the z-fight.
    polygonOffset: true,
    polygonOffsetFactor: -5,
    polygonOffsetUnits: -8,
    side: THREE.DoubleSide,
  });
  ownedMaterials.push(puddleMat);

  const puddleMesh = new THREE.Mesh(puddleGeo, puddleMat);
  puddleMesh.name = "soaked:puddles";
  puddleMesh.frustumCulled = false;
  puddleMesh.matrixAutoUpdate = false;
  puddleMesh.renderOrder = PUDDLE_RENDER_ORDER;
  puddleMesh.raycast = NO_RAYCAST;
  root.add(puddleMesh);

  // ---- track mesh -------------------------------------------------------
  const trackPos = new Float32Array(tCap * 3);
  const trackData = new Float32Array(tCap * 4);
  for (let i = 0; i < tCap; i++) trackData[i * 4 + 3] = -1e9;

  const trackGeo = new THREE.InstancedBufferGeometry();
  {
    const pos = new Float32Array([
      -0.5, 0, -0.5,
      0.5, 0, -0.5,
      0.5, 0, 0.5,
      -0.5, 0, 0.5,
    ]);
    trackGeo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    trackGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  }
  const aTrackPos = new THREE.InstancedBufferAttribute(trackPos, 3);
  const aTrackData = new THREE.InstancedBufferAttribute(trackData, 4);
  for (const a of [aTrackPos, aTrackData]) a.setUsage(THREE.DynamicDrawUsage);
  trackGeo.setAttribute("tPos", aTrackPos);
  trackGeo.setAttribute("tData", aTrackData);
  trackGeo.instanceCount = tCap;
  trackGeo.boundingSphere = infiniteSphere();
  ownedGeometries.push(trackGeo);

  const uTrackLife = { value: TRACK_LIFE };
  const trackMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime, uCamPos, uSunDir, uSunColor, uSkyLow, uDaylight, uLife: uTrackLife,
      uFogColor, uFogParams, uFogKind,
    },
    vertexShader: TRACK_VERT,
    fragmentShader: TRACK_FRAG,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -6,
    polygonOffsetUnits: -10,
    side: THREE.DoubleSide,
  });
  ownedMaterials.push(trackMat);

  const trackMesh = new THREE.Mesh(trackGeo, trackMat);
  trackMesh.name = "soaked:tracks";
  trackMesh.frustumCulled = false;
  trackMesh.matrixAutoUpdate = false;
  trackMesh.renderOrder = TRACK_RENDER_ORDER;
  trackMesh.raycast = NO_RAYCAST;
  root.add(trackMesh);

  /* ------------------------------------------------------------------------ *
   * The map economy: drying stations and water sources
   * ------------------------------------------------------------------------ */

  const stations: DryingStation[] = [];
  const sources: WaterSource[] = [];
  /** One reusable sea source; `sourceNear` retargets it rather than allocating. */
  const seaSource: WaterSource = {
    id: "sea",
    kind: "sea",
    position: new THREE.Vector3(),
    radius: SOURCE_RADIUS.sea,
    refillRate: SOURCE_RATE.sea,
    poi: null,
  };

  /**
   * Find a clear, level, above-water spot on a ring around a point.
   *
   * POI centres are full of buildings, so a station dropped at `poi.center`
   * lands inside a wall. Walk a ring, reject anything steep, wet or already
   * occupied by a collider, and give up rather than place something bad —
   * four good stations beat five with one inside a roof.
   */
  function findSpot(
    cx: number,
    cz: number,
    ringRadius: number,
    clearRadius: number,
    out: THREE.Vector3,
  ): boolean {
    const col = collision();
    const t = terrain();
    const start = rng() * Math.PI * 2;
    // A POI centre is solid buildings, so the first ring is usually a bust.
    // Widen the ring and relax the clearance in three passes rather than
    // giving up: an unplaced station is a POI with no way to dry off, which
    // is worse than a station tucked slightly closer to a wall than ideal.
    const passes: readonly [number, number, number][] = [
      [1.0, 1.0, 0.22],
      [1.45, 0.62, 0.3],
      [1.95, 0.4, 0.38],
    ];
    for (const [ringScale, clearScale, maxSlope] of passes) {
      for (let attempt = 0; attempt < 16; attempt++) {
        // Golden-angle walk around the ring: two consecutive attempts are
        // never adjacent, so a blocked arc is escaped in a couple of tries.
        const a = start + attempt * 2.39996;
        const r = ringRadius * ringScale * (0.7 + 0.36 * ((attempt % 4) / 3));
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        const y = groundY(x, z);
        if (t && y < t.seaLevel + 1.2) continue;
        if (slopeAt(x, z) > maxSlope) continue;
        if (col) {
          const hits = col.query(tmpB.set(x, y + 1.2, z), clearRadius * clearScale);
          if (hits.length > 0) continue;
        }
        out.set(x, y, z);
        return true;
      }
    }
    return false;
  }

  /* ---------------------------------------------------------- station props */

  const stationBodyParts: THREE.BufferGeometry[] = [];
  const stationAccentParts: THREE.BufferGeometry[] = [];
  const sourceBodyParts: THREE.BufferGeometry[] = [];
  const sourceAccentParts: THREE.BufferGeometry[] = [];

  const mat4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const eul = new THREE.Euler();
  const one = new THREE.Vector3(1, 1, 1);

  /** Push a primitive into a merge list, already transformed into world space. */
  function part(
    into: THREE.BufferGeometry[],
    geo: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
  ): void {
    eul.set(rx, ry, rz);
    quat.setFromEuler(eul);
    mat4.compose(tmpB.set(x, y, z), quat, one);
    geo.applyMatrix4(mat4);
    into.push(geo);
  }

  /**
   * One blower: a weighted base, a pedestal, a tilted drum, a grille and four
   * fan blades. Chunky, readable at 300 m, and unmistakably a machine that
   * blows hot air — the silhouette has to say "come here and dry off" from the
   * far side of a POI, because that is the entire point of a contested station.
   */
  function buildStationProp(px: number, py: number, pz: number, yaw: number): void {
    const B = stationBodyParts;
    const A = stationAccentParts;
    part(B, new THREE.CylinderGeometry(1.45, 1.6, 0.3, 16), px, py + 0.15, pz);
    part(A, new THREE.CylinderGeometry(1.5, 1.5, 0.08, 16), px, py + 0.32, pz);
    part(B, new THREE.BoxGeometry(0.95, 1.25, 0.95), px, py + 0.95, pz, 0, yaw, 0);
    // The drum: axis along +Z locally, tilted 18° up and turned to face out.
    const tilt = -0.31;
    part(B, new THREE.CylinderGeometry(0.92, 0.92, 1.5, 18), px, py + 2.05, pz, Math.PI / 2 + tilt, yaw, 0);
    // Grille ring at the mouth, pushed forward along the drum's facing.
    const fx = Math.sin(yaw) * 0.72;
    const fz = Math.cos(yaw) * 0.72;
    const fy = 0.24;
    part(A, new THREE.TorusGeometry(0.9, 0.11, 8, 20), px + fx, py + 2.05 + fy, pz + fz, tilt, yaw, 0);
    for (let b = 0; b < 4; b++) {
      const roll = (b / 4) * Math.PI;
      part(
        A,
        new THREE.BoxGeometry(1.55, 0.1, 0.26),
        px + fx * 0.86,
        py + 2.05 + fy * 0.86,
        pz + fz * 0.86,
        tilt,
        yaw,
        roll,
      );
    }
    // A short exhaust stack, purely for silhouette.
    part(B, new THREE.CylinderGeometry(0.16, 0.2, 1.1, 8), px - fx * 0.5, py + 2.6, pz - fz * 0.5);
  }

  /** A fire hydrant. Small, red, and the most common refill on the island. */
  function buildHydrantProp(px: number, py: number, pz: number, yaw: number): void {
    const A = sourceAccentParts;
    part(A, new THREE.CylinderGeometry(0.34, 0.4, 0.16, 10), px, py + 0.08, pz);
    part(A, new THREE.CylinderGeometry(0.22, 0.26, 0.78, 10), px, py + 0.55, pz);
    part(A, new THREE.SphereGeometry(0.23, 10, 7), px, py + 0.96, pz);
    part(A, new THREE.CylinderGeometry(0.07, 0.07, 0.16, 6), px, py + 1.12, pz);
    // Two side outlets, turned so they read from the approach.
    for (const s of [-1, 1]) {
      part(
        sourceBodyParts,
        new THREE.CylinderGeometry(0.11, 0.12, 0.34, 8),
        px + Math.cos(yaw) * 0.26 * s,
        py + 0.62,
        pz - Math.sin(yaw) * 0.26 * s,
        Math.PI / 2,
        0,
        yaw + (s > 0 ? 0 : Math.PI),
      );
    }
  }

  /**
   * A swimming pool: a low kerb and a disc of water. The water is registered
   * as a PERMANENT puddle rather than drawn here, which gets it the same
   * ripple, glint and refraction as every other body of water for free — and
   * means `wetnessAt` returns 1 inside it without a second code path.
   *
   * No collider on the kerb: it is 0.25 m tall and a pool you cannot walk into
   * is a prop, not a water source.
   */
  function buildPoolProp(px: number, py: number, pz: number, radius: number): void {
    part(sourceBodyParts, new THREE.TorusGeometry(radius, 0.16, 6, 28), px, py + 0.2, pz, Math.PI / 2);
    part(sourceBodyParts, new THREE.CylinderGeometry(radius + 0.34, radius + 0.34, 0.22, 28, 1, true), px, py + 0.11, pz);
    addPuddle(px, py + 0.12, pz, 0, 1, 0, 999, radius, true);
  }

  /** A water tower. The landmark of the water economy — visible from the bus. */
  function buildTowerProp(px: number, py: number, pz: number): void {
    const B = sourceBodyParts;
    const A = sourceAccentParts;
    const legH = 7.5;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      part(B, new THREE.CylinderGeometry(0.17, 0.22, legH, 6), px + Math.cos(a) * 2.1, py + legH / 2, pz + Math.sin(a) * 2.1, 0, 0, Math.cos(a) * 0.05);
    }
    // Cross-bracing at two heights so the tower is a lattice, not four sticks.
    for (const h of [legH * 0.36, legH * 0.72]) {
      part(B, new THREE.TorusGeometry(2.1, 0.07, 5, 16), px, py + h, pz, Math.PI / 2);
    }
    part(A, new THREE.CylinderGeometry(2.9, 2.9, 3.4, 20), px, py + legH + 1.7, pz);
    part(A, new THREE.ConeGeometry(3.05, 1.2, 20), px, py + legH + 3.95, pz);
    part(B, new THREE.CylinderGeometry(3.02, 3.02, 0.18, 20), px, py + legH + 0.12, pz);
    // The downpipe you actually stand under to fill a tank.
    part(B, new THREE.CylinderGeometry(0.19, 0.19, legH + 0.6, 8), px + 2.6, py + (legH + 0.6) / 2, pz);
  }

  /* ------------------------------------------------------------- placement */

  function placeEconomy(): void {
    const pois: Poi[] = ctx.services.pois ?? [];
    const t = terrain();
    const worldSize = t?.worldSize ?? 1500;
    const spot = new THREE.Vector3();

    // ---- drying stations ------------------------------------------------
    // Major and landmark POIs only, spread across the list rather than taken
    // from the front, so the stations are not all in one corner of the island.
    const majors = pois.filter((p) => p.tier !== "minor");
    const wanted = Math.min(budget.stations, Math.max(1, majors.length));
    const step = majors.length > 0 ? majors.length / wanted : 1;
    for (let i = 0; i < wanted; i++) {
      const poi = majors[Math.min(majors.length - 1, Math.floor(i * step))];
      let ok = false;
      if (poi) {
        ok = findSpot(poi.center.x, poi.center.z, poi.radius * 0.62, 2.4, spot);
      }
      if (!ok) {
        // Fallback ring: no POIs, or every candidate spot was blocked. A
        // station in an odd place still beats a mode with no way to dry off.
        const a = (i / wanted) * Math.PI * 2;
        const r = worldSize * 0.42;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        ok = findSpot(x, z, 40, 2.4, spot);
        if (!ok) continue;
      }
      const yaw = poi
        ? Math.atan2(poi.center.x - spot.x, poi.center.z - spot.z)
        : rng() * Math.PI * 2;
      buildStationProp(spot.x, spot.y, spot.z, yaw);
      const station: DryingStation = {
        id: `dry-${i}`,
        name: poi ? `${poi.name} Dryer` : `Blower ${i + 1}`,
        // The effect is centred a little in FRONT of the machine, where the
        // air actually goes, so standing in the warm glow is standing in the
        // effect. A station whose sweet spot is inside its own casing reads
        // as broken the first time someone tries to use it.
        position: new THREE.Vector3(
          spot.x + Math.sin(yaw) * 1.9,
          spot.y,
          spot.z + Math.cos(yaw) * 1.9,
        ),
        radius: STATION_RADIUS,
        rate: STATION_RATE,
        poi: poi?.name ?? null,
      };
      stations.push(station);

      // Collide the casing only — never the effect radius.
      const col = collision();
      if (col) {
        const box = new THREE.Box3(
          new THREE.Vector3(spot.x - 0.75, spot.y - 0.2, spot.z - 0.75),
          new THREE.Vector3(spot.x + 0.75, spot.y + 2.9, spot.z + 0.75),
        );
        colliderRemovers.push(
          col.addBox(box, { material: "metal", tag: "soaked:dryer" }),
        );
      }
    }

    // ---- water sources --------------------------------------------------
    // One tower at the biggest POI, a pool at each remaining major, a hydrant
    // everywhere else. Every POI gets exactly one refill, which is what ties
    // the ammo economy to the map instead of to the loot table.
    let placed = 0;
    const landmark = pois.find((p) => p.tier === "landmark") ?? pois[0];
    for (const poi of pois) {
      if (placed >= budget.sources) break;
      // A tower wants a lot of clear ground and a pool wants more. Rather
      // than skip a POI whose plaza is full, fall back down the list until
      // something fits — every POI must end up with a refill, because that is
      // what ties the ammo economy to the map.
      const prefer: readonly WaterSource["kind"][] =
        poi === landmark
          ? ["tower", "pool", "hydrant"]
          : poi.tier === "major"
            ? ["pool", "hydrant"]
            : ["hydrant"];
      const clearFor = (k: WaterSource["kind"]): number =>
        k === "tower" ? 4.5 : k === "pool" ? 6.5 : 1.4;
      let kind: WaterSource["kind"] | null = null;
      for (const candidate of prefer) {
        if (findSpot(poi.center.x, poi.center.z, poi.radius * 0.5, clearFor(candidate), spot)) {
          kind = candidate;
          break;
        }
      }
      if (!kind) continue;

      let radius = SOURCE_RADIUS[kind];
      if (kind === "hydrant") {
        buildHydrantProp(spot.x, spot.y, spot.z, rng() * Math.PI * 2);
      } else if (kind === "pool") {
        radius = 5.2;
        buildPoolProp(spot.x, spot.y, spot.z, radius);
      } else {
        buildTowerProp(spot.x, spot.y, spot.z);
      }

      sources.push({
        id: `src-${placed}`,
        kind,
        position: spot.clone(),
        radius,
        refillRate: SOURCE_RATE[kind],
        poi: poi.name,
      });
      placed++;

      const col = collision();
      if (col) {
        if (kind === "hydrant") {
          colliderRemovers.push(
            col.addBox(
              new THREE.Box3(
                new THREE.Vector3(spot.x - 0.35, spot.y - 0.1, spot.z - 0.35),
                new THREE.Vector3(spot.x + 0.35, spot.y + 1.2, spot.z + 0.35),
              ),
              { material: "metal", tag: "soaked:hydrant" },
            ),
          );
        } else if (kind === "tower") {
          // Four leg boxes rather than one big box: a tower you cannot walk
          // under is a wall, and the shade under it is half the appeal.
          for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
            const lx = spot.x + Math.cos(a) * 2.1;
            const lz = spot.z + Math.sin(a) * 2.1;
            colliderRemovers.push(
              col.addBox(
                new THREE.Box3(
                  new THREE.Vector3(lx - 0.3, spot.y - 0.1, lz - 0.3),
                  new THREE.Vector3(lx + 0.3, spot.y + 7.6, lz + 0.3),
                ),
                { material: "metal", tag: "soaked:tower" },
              ),
            );
          }
        }
      }
    }
  }

  placeEconomy();

  /* ------------------------------------------------------------- prop mesh */

  /**
   * Materials.
   *
   * The library's `tinted()` gives real PBR — roughness variation and an
   * env map — which is what keeps these props looking like they belong on the
   * island rather than like a Three.js demo. They are CACHED AND SHARED, so
   * they must never be disposed here; only materials we construct ourselves go
   * in `ownedMaterials`.
   */
  const materialsSvc: MaterialsService | undefined = ctx.services.materials;
  function surface(color: number, metalness: number, roughness: number): THREE.Material {
    if (materialsSvc) {
      try {
        return materialsSvc.tinted("metalPanel", color);
      } catch {
        /* fall through to our own */
      }
    }
    const m = new THREE.MeshStandardMaterial({
      color,
      metalness,
      roughness,
      envMap: materialsSvc?.env ?? null,
    });
    ownedMaterials.push(m);
    return m;
  }

  // Sunny block-party palette: cream housings, a hot orange for the warm-air
  // parts, hydrant red for the plumbing. Bright, not military.
  const bodyMat = surface(0xf2ece0, 0.15, 0.55);
  const warmMat = surface(0xff9f43, 0.2, 0.42);
  const plumbMat = surface(0xe2503c, 0.25, 0.45);
  const tankMat = surface(0xbfe4f2, 0.3, 0.35);

  function addMerged(
    parts: THREE.BufferGeometry[],
    material: THREE.Material,
    name: string,
  ): void {
    const merged = mergeParts(parts);
    if (!merged) return;
    merged.computeBoundingSphere();
    ownedGeometries.push(merged);
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // One merged mesh per material across ALL stations/sources: four draw
    // calls for the whole water economy, however many of them there are.
    root.add(mesh);
    ownedObjects.push(mesh);
  }

  addMerged(stationBodyParts, bodyMat, "soaked:dryers");
  addMerged(stationAccentParts, warmMat, "soaked:dryer-grilles");
  addMerged(sourceBodyParts, tankMat, "soaked:sources");
  addMerged(sourceAccentParts, plumbMat, "soaked:source-accents");

  /* ------------------------------------------------------------- shimmer */

  const uShimmerTime = { value: 0 };
  const uShimmerIntensity = { value: 0.34 };
  let columnGeo: THREE.CylinderGeometry | null = null;
  let glowGeo: THREE.CircleGeometry | null = null;
  let columnMat: THREE.ShaderMaterial | null = null;
  let glowMat: THREE.ShaderMaterial | null = null;

  if (budget.shimmer && stations.length > 0) {
    // Warmer and stronger than it looks like it should be on paper: additive
    // light competes with a noon sun on white plaster, and the first capture
    // had a station you could not pick out from ten metres away. The point of
    // the column is that you can see a station is running from a ridge line.
    const warm = new THREE.Color(0xffc478);
    const makeShimmer = (ground: number, intensity: number): THREE.ShaderMaterial =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: uShimmerTime,
          uWarm: { value: warm.clone() },
          uIntensity: { value: intensity },
          uGround: { value: ground },
          uFogColor, uFogParams, uFogKind,
        },
        vertexShader: SHIMMER_VERT,
        fragmentShader: SHIMMER_FRAG,
        transparent: true,
        // Additive: it is light in the air. Depth-tested so a wall in front
        // of a station occludes its column, but never depth-written.
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });

    columnMat = makeShimmer(0, 0.55);
    glowMat = makeShimmer(1, 1.05);
    ownedMaterials.push(columnMat, glowMat);

    columnGeo = new THREE.CylinderGeometry(2.4, 3.6, STATION_COLUMN_H, 14, 1, true);
    glowGeo = new THREE.CircleGeometry(STATION_RADIUS, 26);
    glowGeo.rotateX(-Math.PI / 2);
    ownedGeometries.push(columnGeo, glowGeo);

    for (const s of stations) {
      const column = new THREE.Mesh(columnGeo, columnMat);
      column.position.set(s.position.x, s.position.y + STATION_COLUMN_H * 0.5, s.position.z);
      column.renderOrder = 8;
      column.raycast = NO_RAYCAST;
      column.frustumCulled = true;
      root.add(column);
      ownedObjects.push(column);

      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.position.set(s.position.x, s.position.y + 0.07, s.position.z);
      glow.renderOrder = 7;
      glow.raycast = NO_RAYCAST;
      root.add(glow);
      ownedObjects.push(glow);
    }
  }

  /* ------------------------------------------------------------------------ *
   * Economy queries
   * ------------------------------------------------------------------------ */

  function stationNear(point: THREE.Vector3, range = Infinity): DryingStation | null {
    let best: DryingStation | null = null;
    let bestD = range * range;
    for (const s of stations) {
      const dx = s.position.x - point.x;
      const dy = s.position.y - point.y;
      const dz = s.position.z - point.z;
      // Vertical term included so a station is not "near" someone standing on
      // a ramp tower forty metres above it.
      const d2 = dx * dx + dy * dy * 4 + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = s;
      }
    }
    return best;
  }

  function dryingRateAt(point: THREE.Vector3): number {
    let rate = 0;
    for (const s of stations) {
      const dx = s.position.x - point.x;
      const dz = s.position.z - point.z;
      const dy = Math.abs(s.position.y - point.y);
      if (dy > 3) continue;
      const d = Math.hypot(dx, dz);
      if (d >= s.radius) continue;
      const core = s.radius * STATION_CORE;
      // Full rate in the core, tapering to nothing at the rim, so the sweet
      // spot is a place you stand rather than a circle you clip the edge of.
      const f = d <= core ? 1 : 1 - smooth01(clamp01((d - core) / (s.radius - core)));
      const r = s.rate * f;
      if (r > rate) rate = r;
    }
    return rate;
  }

  function sourceNear(point: THREE.Vector3, range: number): WaterSource | null {
    let best: WaterSource | null = null;
    let bestD = Infinity;
    for (const s of sources) {
      const dx = s.position.x - point.x;
      const dz = s.position.z - point.z;
      const dy = Math.abs(s.position.y - point.y);
      if (dy > 4) continue;
      const d = Math.hypot(dx, dz) - s.radius;
      if (d <= range && d < bestD) {
        bestD = d;
        best = s;
      }
    }

    // The sea is the source of last resort and it is everywhere, so it is
    // checked last and only when nothing plumbed is closer.
    const t = terrain();
    if (t) {
      const coast = typeof t.coastDistanceAt === "function" ? t.coastDistanceAt(point.x, point.z) : 0;
      if (coast <= range + 6) {
        // Sample the point and a ring around it; the first wet sample wins.
        if (seaDepthAt(point.x, point.z) > 0.05) {
          seaSource.position.set(point.x, t.seaLevel, point.z);
          return best && bestD < 0 ? best : seaSource;
        }
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const sx = point.x + Math.cos(a) * range;
          const sz = point.z + Math.sin(a) * range;
          if (seaDepthAt(sx, sz) > 0.05) {
            const d = range;
            if (d < bestD) {
              seaSource.position.set(sx, t.seaLevel, sz);
              return seaSource;
            }
            break;
          }
        }
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------------ *
   * Service
   * ------------------------------------------------------------------------ */

  function clear(): void {
    for (let i = 0; i < pCap; i++) if (pAlive[i] && !pPermanent[i]) killPuddle(i);
    for (let i = 0; i < tCap; i++) killTrack(i);
    walkers.clear();
    trackWrite = 0;
  }

  const service: WetnessService = {
    splash,
    wetnessAt,
    frictionAt,
    track,
    trailNear,
    stations,
    stationNear,
    dryingRateAt,
    sources,
    sourceNear,
    get puddleCount() {
      return puddleLive;
    },
    get trackCount() {
      return trackLive;
    },
    clear,
  };
  ctx.services.wetness = service;

  /* ------------------------------------------------------------------------ *
   * Net
   *
   * A remote player's stream landing on the ground has to leave the same mark
   * ours does, or the map only remembers half the fight. Subscribed lazily
   * because `net` may boot after us, and defensively because the payload is
   * authored by whoever sends it.
   * ------------------------------------------------------------------------ */

  let netBound = false;
  const netPoint = new THREE.Vector3();

  function bindNet(): void {
    if (netBound) return;
    const net = (ctx.services as unknown as { net?: NetLike }).net;
    if (!net || typeof net.on !== "function") return;
    netBound = true;
    const onSplash = (_from: string, payload: unknown): void => {
      const p = payload as { x?: number; y?: number; z?: number; r?: number; a?: number } | null;
      if (!p || typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") return;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
      const r = typeof p.r === "number" && Number.isFinite(p.r) ? Math.min(8, Math.max(0.2, p.r)) : 0.8;
      const a = typeof p.a === "number" && Number.isFinite(p.a) ? Math.min(20, Math.max(0.01, p.a)) : 0.35;
      splash(netPoint.set(p.x, p.y, p.z), r, a);
    };
    try {
      netUnsubs.push(net.on("splash", onSplash));
      netUnsubs.push(net.on("balloon", onSplash));
    } catch {
      /* a transport that refuses a subscription is not a reason to fail */
    }
  }

  /* ------------------------------------------------------------------------ *
   * Loop
   * ------------------------------------------------------------------------ */

  const hudEvent: WetEvent = {
    wetness: 0,
    friction: 1,
    stationName: null,
    stationDist: Infinity,
    inStation: false,
    sourceKind: null,
    sourceDist: Infinity,
    atSource: false,
    puddles: 0,
    tracks: 0,
  };

  /** Simulated seconds until the next walker prune and the next HUD push. */
  let pruneTimer = 0;
  let hudTimer = 0;

  const sys: System = {
    name: "wetness",

    /**
     * Physics. Accumulation, evaporation and expiry all measured in SIMULATED
     * seconds off the fixed step — never wall clock, which under SwiftSHADER
     * would run these hundreds of times too fast.
     */
    fixed(dt) {
      const s = sky();
      const daylight = s ? clamp01(s.daylight) : 1;
      // Sun dries things. At night a puddle sits there almost indefinitely,
      // which is both true and a quietly good reason to fight at dawn.
      const sun = PUDDLE_SUN_MIN + (PUDDLE_SUN_MAX - PUDDLE_SUN_MIN) * daylight;
      const st = storm();

      for (let i = 0; i < pCap; i++) {
        if (!pAlive[i] || pPermanent[i]) continue;

        // Inside the Downpour it is, definitionally, pouring: puddles grow
        // instead of drying, so the ring leaves a visibly wetter world behind
        // it as it closes. Costs one `isSafe` per puddle per step.
        let raining = false;
        if (st) {
          tmpB.set(pX[i], pY[i], pZ[i]);
          raining = !st.isSafe(tmpB);
        }

        if (raining) {
          pVol[i] += PUDDLE_RAIN_GAIN * dt;
        } else {
          pVol[i] -= (pVol[i] * PUDDLE_DECAY + PUDDLE_EVAP) * sun * dt;
        }

        if (pVol[i] <= PUDDLE_R_MIN_VOLUME) {
          killPuddle(i);
          continue;
        }
        pRad[i] = volumeToRadius(pVol[i], pMaxRad[i]);
      }

      // Footprints expire on their own clock. Cheap enough to sweep every
      // step, and sweeping keeps `trackLive` and the grid honest for `trailNear`.
      const now = ctx.elapsed;
      for (let i = 0; i < tCap; i++) {
        if (!tAlive[i]) continue;
        if (now - tBorn[i] >= TRACK_LIFE) killTrack(i);
      }

      pruneTimer -= dt;
      if (pruneTimer <= 0) {
        pruneTimer = 10;
        for (const [id, w] of walkers) {
          if (now - w.seen > TRACK_WALKER_TTL) walkers.delete(id);
        }
      }
    },

    /** Cosmetics: uniforms, instance buffers, the HUD push. */
    update(dt) {
      bindNet();

      const now = ctx.elapsed;
      uTime.value = now;
      uShimmerTime.value = now;
      uCamPos.value.copy(ctx.camera.position);

      // ---- lighting ------------------------------------------------------
      const s = sky();
      if (s) {
        uSunDir.value.copy(s.sunDirection).normalize();
        uSunColor.value.copy(s.sunColor);
        uDaylight.value = clamp01(s.daylight);
        // The sky the puddle reflects: warm near the horizon, deep overhead,
        // both dimmed with the sun so a puddle at dusk goes quiet rather than
        // staying a bright blue hole in the ground.
        const d = uDaylight.value;
        uSkyHigh.value.setRGB(0.16 + 0.20 * d, 0.34 + 0.28 * d, 0.62 + 0.34 * d);
        uSkyLow.value.setRGB(0.36 + 0.40 * d, 0.48 + 0.40 * d, 0.58 + 0.40 * d);
      }

      // Reproduce whatever fog the scene currently has — the storm swaps its
      // own in and out, and a decal that ignores that sits in front of the haze.
      const fog = ctx.scene.fog;
      if (fog instanceof THREE.FogExp2) {
        uFogKind.value = 2;
        uFogColor.value.copy(fog.color);
        uFogParams.value.z = fog.density;
      } else if (fog instanceof THREE.Fog) {
        uFogKind.value = 1;
        uFogColor.value.copy(fog.color);
        uFogParams.value.x = fog.near;
        uFogParams.value.y = fog.far;
      } else {
        uFogKind.value = 0;
      }

      // ---- puddle instances ----------------------------------------------
      for (let i = 0; i < pCap; i++) {
        const o3 = i * 3;
        const o4 = i * 4;
        if (!pAlive[i]) {
          puddleData[o4 + 3] = 0;
          continue;
        }
        puddlePos[o3] = pX[i];
        puddlePos[o3 + 1] = pY[i];
        puddlePos[o3 + 2] = pZ[i];
        puddleNrm[o3] = pNx[i];
        puddleNrm[o3 + 1] = pNy[i];
        puddleNrm[o3 + 2] = pNz[i];
        puddleData[o4] = pRad[i];
        puddleData[o4 + 1] = pPermanent[i]
          ? 1
          : clamp01(0.25 + 0.75 * (pVol[i] / PUDDLE_DEEP_VOLUME));
        puddleData[o4 + 2] = pSeed[i];
        // Water spreads into place; it does not pop. The fade also carries the
        // last of the evaporation so a puddle thins out instead of vanishing.
        const inT = clamp01((now - pBorn[i]) / PUDDLE_FADE_IN);
        const outT = pPermanent[i] ? 1 : clamp01(pVol[i] / 0.4);
        puddleData[o4 + 3] = smooth01(inT) * outT;
      }
      aPuddlePos.needsUpdate = true;
      aPuddleNrm.needsUpdate = true;
      aPuddleData.needsUpdate = true;

      // ---- track instances -----------------------------------------------
      for (let i = 0; i < tCap; i++) {
        const o3 = i * 3;
        const o4 = i * 4;
        if (!tAlive[i]) {
          trackData[o4 + 3] = -1e9;
          continue;
        }
        trackPos[o3] = tX[i];
        trackPos[o3 + 1] = tY[i];
        trackPos[o3 + 2] = tZ[i];
        trackData[o4] = tYaw[i];
        // The sign of the size carries which foot it is — one fewer attribute
        // for the same information, and the shader mirrors the sole on it.
        trackData[o4 + 1] = tSize[i];
        trackData[o4 + 2] = tStrength[i];
        trackData[o4 + 3] = tBorn[i];
      }
      aTrackPos.needsUpdate = true;
      aTrackData.needsUpdate = true;

      // ---- HUD -----------------------------------------------------------
      hudTimer -= dt;
      if (hudTimer <= 0) {
        hudTimer = 0.2;
        const player = ctx.services.player;
        const at = player ? player.position : ctx.camera.position;
        hudEvent.wetness = wetnessAt(at.x, at.z);
        hudEvent.friction = frictionAt(at.x, at.z);
        const st = stationNear(at);
        if (st) {
          hudEvent.stationName = st.name;
          hudEvent.stationDist = Math.hypot(st.position.x - at.x, st.position.z - at.z);
          hudEvent.inStation = dryingRateAt(at) > 0;
        } else {
          hudEvent.stationName = null;
          hudEvent.stationDist = Infinity;
          hudEvent.inStation = false;
        }
        const src = sourceNear(at, 40);
        if (src) {
          hudEvent.sourceKind = src.kind;
          hudEvent.sourceDist = Math.max(
            0,
            Math.hypot(src.position.x - at.x, src.position.z - at.z) - src.radius,
          );
          hudEvent.atSource = hudEvent.sourceDist <= 0.01;
        } else {
          hudEvent.sourceKind = null;
          hudEvent.sourceDist = Infinity;
          hudEvent.atSource = false;
        }
        hudEvent.puddles = puddleLive;
        hudEvent.tracks = trackLive;
        ctx.emit("dz:wet", hudEvent);
      }
    },

    dispose() {
      for (const un of netUnsubs) {
        try {
          un();
        } catch {
          /* a transport already torn down is not our problem */
        }
      }
      netUnsubs.length = 0;
      for (const remove of colliderRemovers) {
        try {
          remove();
        } catch {
          /* collision may already be gone */
        }
      }
      colliderRemovers.length = 0;

      for (const o of ownedObjects) o.removeFromParent();
      ownedObjects.length = 0;
      ctx.scene.remove(root);
      root.clear();

      for (const g of ownedGeometries) g.dispose();
      ownedGeometries.length = 0;
      // Only materials we constructed. `materials.tinted()` hands back a
      // cached, shared instance — disposing one here would blank the props of
      // whatever else asked for the same tint.
      for (const m of ownedMaterials) m.dispose();
      ownedMaterials.length = 0;

      puddleGrid.clear();
      trackGrid.clear();
      walkers.clear();
      stations.length = 0;
      sources.length = 0;

      if (ctx.services.wetness === service) ctx.services.wetness = undefined;
    },
  };

  return sys;
};

export default createWetness;
