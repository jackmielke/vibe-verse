/**
 * DROP ZERO — the storm.
 *
 * Publishes `StormService`. Eight circles, a wall you can see from anywhere
 * on the island, and the clock that turns twenty minutes of looting into a
 * fight. Of everything in this game the storm is the thing that is on screen
 * the longest, so it gets the most shader.
 *
 * ── Why the wall is built the way it is ───────────────────────────────────
 * The naive storm wall is a big cylinder with a scrolling texture and it
 * always reads as a big cylinder with a scrolling texture. Four things fix
 * that, and all four are in `WALL_FRAG`:
 *
 *  1. **It is lit by its own turbulence, not by a texture.** Two octaves of
 *     value-noise fbm scroll upward at different rates and *modulate* every
 *     other layer. Nothing in the wall has constant brightness, anywhere, at
 *     any time — which is the difference between "energy field" and "decal".
 *  2. **The hex lattice is world-scaled, not UV-scaled.** The circle goes
 *     from 1250 m to 30 m across a match. If the lattice were a fixed number
 *     of repeats around the cylinder, the cells would shrink from house-sized
 *     to fist-sized and the wall would visibly change material. Instead the
 *     repeat count is recomputed from the circumference every frame and
 *     rounded to an integer (so the tiling stays seamless), which keeps every
 *     hex ~26 m wide from the first circle to the last.
 *  3. **The base follows the ground.** A per-column `aGroundY` attribute is
 *     re-sampled off `TerrainService.heightAt` at 12 Hz, so the skirt sits on
 *     the hillside instead of slicing through it, and the contact glow — the
 *     hot band in the first ~25 m — lands where the wall actually meets the
 *     island. A wall that floats over a ridge is the single loudest tell that
 *     this is a cylinder.
 *  4. **It obeys aerial perspective.** The far side of a 2.5 km circle is
 *     three kilometres away and must sit *behind* the haze like everything
 *     else, so the fragment shader runs the scene's own `FogExp2` term and
 *     both dims the energy and pulls its colour toward the horizon.
 *
 * Z-fighting: at 3 km the depth buffer has nothing left to say, so the wall
 * writes no depth, takes a generous negative polygon offset, and is drawn
 * after the opaque island with additive blending. Double-sided, because you
 * spend the first third of a match looking at it from the outside.
 *
 * ── Navigation is the other half of the job ───────────────────────────────
 * Players do not read the minimap in a firefight; they read the ground. So
 * both circles are drawn as ribbons projected onto the terrain — the current
 * wall footprint in violet, the next circle in a bright cyan-white — with
 * every vertex height sampled from `heightAt` and the cross-slope gradient
 * measured so the ribbon banks with the hill instead of clipping into it.
 * The ribbon widens with distance (in the vertex shader, off the camera
 * distance) because a 6 m band 900 m away is one pixel, and one pixel is not
 * navigation.
 *
 * ── Being caught has to feel bad ──────────────────────────────────────────
 * Purple `FogExp2` swapped in over the sky's, a full-frame veil that drains
 * the colour out of the world, a thousand lit streaks tearing past the
 * camera, a filtered-noise roar with a sub under it, and a health tick once a
 * second at the phase's dps. The HUD gets `dz:in-storm` for its vignette and
 * `dz:storm` every frame for the timer and the distance-to-safe arrow.
 *
 * ── Consumes, all lazily and all null-checked ─────────────────────────────
 * `terrain` (ground heights, land bias for the next centre), `materials`
 * (the hex lattice — we generate our own if it is missing), `player`
 * (damage + where the camera is), `combat` (bots to damage), `match` (hold
 * the clock until the match is live), `pois` (bias late circles onto ground
 * worth fighting over), `audio` (one-shot stingers). Every one of them can be
 * absent and the storm still runs.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";
import type {
  CombatService,
  DamageSource,
  MaterialsService,
  MatchService,
  Poi,
  QualityTier,
  StormService,
  System,
  SystemFactory,
  TerrainService,
  WorldCtx,
} from "../types";

/* ------------------------------------------------------------------------ *
 * Contract shims
 *
 * `types.ts` is shared and is not ours to edit while twelve other systems
 * are compiling against it. Anything we want beyond the published interfaces
 * is read structurally, optionally, with a fallback for when it is missing.
 * ------------------------------------------------------------------------ */

/** The bits of the player we touch. `damage` is the only one we need. */
interface PlayerLike {
  position: THREE.Vector3;
  yaw: number;
  health: number;
  readonly controllable?: boolean;
  damage(amount: number, from: THREE.Vector3 | undefined, source: DamageSource): void;
}

/** Audio's one-shot surface — every method optional. */
interface AudioLike {
  play?(name: string, opts?: { position?: THREE.Vector3; volume?: number; rate?: number }): void;
  readonly ready?: boolean;
}

/** What the storm may reach for. */
interface StormServices {
  terrain?: TerrainService;
  materials?: MaterialsService;
  combat?: CombatService;
  match?: MatchService;
  player?: PlayerLike;
  audio?: AudioLike;
  pois?: Poi[];
  storm?: StormService;
}

/**
 * Our service: the shared contract plus the handful of things the HUD, the
 * bots and the match machine want and `StormService` does not carry. Anyone
 * reading `ctx.services.storm` as a plain `StormService` is unaffected.
 */
export interface DropZeroStormService extends StormService {
  /** How many circles the phase table holds. */
  readonly phaseCount: number;
  /** Metres from a point to the safe zone edge. Negative when already inside. */
  distanceToSafe(point: THREE.Vector3): number;
  /**
   * Unit XZ vector pointing at the nearest safe ground, or zero when safe.
   * Bots steer on this; the HUD draws an arrow with it.
   */
  safeDirection(point: THREE.Vector3, out?: THREE.Vector3): THREE.Vector3;
  /** 0..1 — how hard the storm is pressing on the camera right now. */
  readonly intensity: number;
  /** True once the clock is running. */
  readonly running: boolean;
  /** Start the clock (idempotent). `match` may call this; otherwise auto. */
  begin(): void;
  /** Stop/resume the clock without tearing anything down. */
  freeze(on: boolean): void;
  /** A random point inside the *next* circle, on land where we can find it. */
  sampleSafePoint(out?: THREE.Vector3): THREE.Vector3;
}

/** Payload shape emitted on `dz:storm` every frame. */
export interface StormEvent {
  circle: number;
  phaseCount: number;
  timer: number;
  closing: boolean;
  dps: number;
  radius: number;
  nextRadius: number;
  centerX: number;
  centerZ: number;
  nextX: number;
  nextZ: number;
  /** Metres to the safe edge. Negative inside. */
  distToSafe: number;
  /** Bearing to safety relative to where the player is looking, radians. */
  bearing: number;
  inStorm: boolean;
  intensity: number;
}

/** Payload on `dz:in-storm`, emitted only when the state actually flips. */
export interface InStormEvent {
  inside: boolean;
  intensity: number;
  dps: number;
}

/* ------------------------------------------------------------------------ *
 * Tuning — the phase table first, because it is the mode
 * ------------------------------------------------------------------------ */

interface StormPhase {
  /** Seconds the circle sits still before it starts moving. */
  wait: number;
  /** Seconds the wall takes to travel from the old circle to the new one. */
  close: number;
  /** New radius as a fraction of the old one. 0 closes to nothing. */
  ratio: number;
  /** Health per second lost outside the wall during this phase. */
  dps: number;
}

/**
 * Eight circles, ~16 minutes end to end.
 *
 * The shape of the table is the whole feel of the mode. Early circles are
 * long, generous and near-harmless — 0.5 dps is 200 seconds to kill a full
 * health bar, which is deliberately survivable, because the first storm you
 * get caught in should teach you rather than end you. From circle 5 the
 * waits collapse faster than the closes, so the pressure comes from *not
 * having time to loot* before it moves again. The last two are lethal: 8 and
 * 10 dps kill a 100 HP player in 12 and 10 seconds, which means the final
 * circle is fought inside the ring or not at all.
 *
 * Radii, starting from `START_RADIUS` = 1250:
 *   1250 → 850 → 561 → 348 → 209 → 121 → 67 → 33 → 0
 * The island's own radius is ~1155 m centred near (-40, 40), so circle 1
 * covers the whole landmass with a little coast to spare and the first move
 * is the first real decision of the match.
 */
const PHASES: readonly StormPhase[] = [
  { wait: 100, close: 90, ratio: 0.68, dps: 0.5 },
  { wait: 90, close: 80, ratio: 0.66, dps: 0.5 },
  { wait: 80, close: 70, ratio: 0.62, dps: 1 },
  { wait: 70, close: 60, ratio: 0.6, dps: 1 },
  { wait: 55, close: 50, ratio: 0.58, dps: 2 },
  { wait: 45, close: 40, ratio: 0.55, dps: 5 },
  { wait: 35, close: 32, ratio: 0.5, dps: 8 },
  { wait: 25, close: 45, ratio: 0.0, dps: 10 },
];

/** Radius of circle 1. Sized to swallow the island plus its beaches. */
const START_RADIUS = 1250;
/** Where circle 1 sits. Matches the island centre the terrain builds around. */
const START_CENTER_X = -40;
const START_CENTER_Z = 40;

/**
 * Seconds after the match goes live before circle 1's clock starts. Long
 * enough that a full bus route and a drop happen under a static wall — the
 * first thing a player should have to think about is loot, not rotation.
 */
const OPENING_GRACE = 18;

/**
 * Storm damage lands once a second in a whole tick rather than continuously.
 * Two reasons: the hit feedback (flash, sound, damage number) is a discrete
 * event and 120 of them a second is noise, and a visible 1 Hz drum on the
 * health bar is how a player learns the cost of the phase they are in.
 */
const DAMAGE_TICK = 1.0;

/**
 * The next centre is chosen so the new circle is fully inside the old one —
 * `|offset| <= radius - nextRadius`. This is how much of that budget it is
 * allowed to spend. 1.0 lets the circle hug the old edge, which is legal in
 * Fortnite but brutal for anyone on the far side; 0.82 keeps every rotation
 * inside a diagonal sprint.
 */
const CENTER_TRAVEL = 0.82;
/** Candidate centres scored per phase. Cheap — a few hundred `heightAt`. */
const CENTER_CANDIDATES = 24;
/** Points sampled inside a candidate circle to score how much of it is land. */
const CENTER_LAND_SAMPLES = 12;

/* ---------------------------------------------------------------- the wall */

/**
 * Metres of wall above the sampled ground line. Has to clear the tallest
 * thing a player can build on the tallest hill and still read as "goes up
 * forever" from sea level, without the top edge landing in frame when you
 * stand next to it.
 */
const WALL_HEIGHT = 900;
/**
 * The skirt starts this far *below* the sampled ground so the wall never
 * gaps against terrain that dips between angular samples. Everything under
 * the surface is depth-rejected by the island anyway.
 */
const WALL_BASE_DROP = 45;
/**
 * World size of ONE LATTICE TILE, held constant as the circle shrinks. The
 * tile the material library paints carries a 4x4 hex lattice, so this is
 * four cells wide — 44 m of tile is an 11 m hex, which is about a storey and
 * a half and reads at every range from touching it to two kilometres out.
 */
const HEX_WORLD_SIZE = 44;
/** Vertical size of one tile. Slightly taller than it is wide. */
const HEX_WORLD_HEIGHT = 56;

/** How often the per-column ground heights under the wall are re-sampled. */
const GROUND_RESAMPLE_HZ = 12;

/* ------------------------------------------------------------- ground rings */

/** Base width of a projected ring, in metres, before distance widening. */
const RING_WIDTH = 7;
/** Ring is lifted this far off the terrain to stay ahead of z-fighting. */
const RING_LIFT = 0.35;
/** Radial spread used to measure the cross-slope gradient under a ring. */
const RING_SLOPE_PROBE = 2.5;

/* --------------------------------------------------------------- interior */

/** Depth into the storm, in metres, at which the interior effect is full. */
const INTERIOR_RAMP = 55;
/** Purple the interior fog and veil converge on. */
const STORM_FOG_COLOR = 0x4b2a86;
/**
  * Fog density inside the storm at full intensity. Half-obscured at ~52 m and
  * effectively blind past ~110 m: enough that being caught is disorienting
  * and a fight inside the wall is a knife fight, but not so much that you
  * cannot see the ground you are running on.
  */
const STORM_FOG_DENSITY = 0.016;
/** Box the streak particles live in, camera-anchored. */
const PARTICLE_BOX = 110;
/** Seconds a streak lives before it recycles. */
const PARTICLE_LIFE = 1.7;

const TWO_PI = Math.PI * 2;

/* ------------------------------------------------------------------------ *
 * Quality tiers
 * ------------------------------------------------------------------------ */

interface StormTier {
  /** Radial segments around the wall cylinder. */
  wallSegments: number;
  /** Vertical segments. Nothing is displaced per-row, so this stays tiny. */
  wallRows: number;
  /** Segments in each projected ground ring. */
  ringSegments: number;
  /** Streak quads inside the storm. */
  particles: number;
  /** fbm octaves in the wall shader. */
  octaves: number;
  /** Whether the full-frame interior veil is drawn at all. */
  veil: boolean;
}

const TIERS: Record<QualityTier, StormTier> = {
  low: { wallSegments: 96, wallRows: 2, ringSegments: 128, particles: 0, octaves: 2, veil: true },
  medium: { wallSegments: 160, wallRows: 2, ringSegments: 192, particles: 420, octaves: 2, veil: true },
  high: { wallSegments: 256, wallRows: 3, ringSegments: 256, particles: 900, octaves: 3, veil: true },
  ultra: { wallSegments: 384, wallRows: 3, ringSegments: 320, particles: 1400, octaves: 4, veil: true },
};

/* ------------------------------------------------------------------------ *
 * Shared GLSL
 * ------------------------------------------------------------------------ */

/**
 * Value noise + fbm. Deliberately value noise and not gradient noise: the
 * storm wants soft blobby cells that read as pressure fronts, and simplex's
 * ridged character fights the hex lattice sitting on top of it.
 */
const GLSL_NOISE = /* glsl */ `
float dzHash(vec2 p) {
  p = fract(p * vec2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

float dzNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  // Quintic fade — the cubic one leaves visible second-derivative seams once
  // the noise is used to modulate something as high-contrast as the lattice.
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dzHash(i);
  float b = dzHash(i + vec2(1.0, 0.0));
  float c = dzHash(i + vec2(0.0, 1.0));
  float d = dzHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float dzFbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < OCTAVES; i++) {
    sum += amp * dzNoise(p);
    norm += amp;
    p *= 2.03;   // not exactly 2: an integer lacunarity re-aligns the lattice
    amp *= 0.52; // of every octave and the fbm grows a visible grid
  }
  return sum / max(norm, 0.0001);
}
`;

/**
 * The three-dimensional version, and the reason it has to exist.
 *
 * The wall is a closed loop. Any noise driven by a *linear* angle coordinate
 * jumps from f(N) back to f(0) at the seam, and because the wall is a
 * kilometre of continuous surface that discontinuity shows up as a hard
 * vertical band you can see from anywhere on the island — the single most
 * common way a cylindrical effect gives itself away.
 *
 * Sampling 3D noise along the *circle* `(cos a, sin a)` instead is exactly
 * periodic by construction, at any repeat count, with no wrapping arithmetic
 * and no constraint on how the scale changes as the circle shrinks. The third
 * axis carries height, so the field is genuinely volumetric rather than a
 * band smeared upward.
 */
const GLSL_NOISE3 = /* glsl */ `
float dzHash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.23));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float dzNoise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dzHash3(i + vec3(0.0, 0.0, 0.0));
  float n100 = dzHash3(i + vec3(1.0, 0.0, 0.0));
  float n010 = dzHash3(i + vec3(0.0, 1.0, 0.0));
  float n110 = dzHash3(i + vec3(1.0, 1.0, 0.0));
  float n001 = dzHash3(i + vec3(0.0, 0.0, 1.0));
  float n101 = dzHash3(i + vec3(1.0, 0.0, 1.0));
  float n011 = dzHash3(i + vec3(0.0, 1.0, 1.0));
  float n111 = dzHash3(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

float dzFbm3(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < OCTAVES; i++) {
    sum += amp * dzNoise3(p);
    norm += amp;
    p *= 2.07;
    amp *= 0.52;
  }
  return sum / max(norm, 0.0001);
}
`;

/**
 * The scene runs `FogExp2`, so the wall, the rings and the streaks all have
 * to reproduce its term rather than pick their own falloff — otherwise the
 * storm punches a hole through the aerial perspective at exactly the range
 * where the eye is most sensitive to it.
 */
const GLSL_FOG = /* glsl */ `
float dzFogAmount(float dist, float density) {
  float f = dist * density;
  return 1.0 - exp(-f * f);
}
`;

/* ------------------------------------------------------------------------ *
 * The wall
 * ------------------------------------------------------------------------ */

/**
 * The cylinder is authored as a unit ring (xz on the unit circle, y in 0..1)
 * and is re-projected here every frame from `uRadius`/`uCenter`, so shrinking
 * the circle costs two uniform writes rather than a geometry rebuild. The
 * model matrix is deliberately bypassed; the mesh sits at the origin with
 * `matrixAutoUpdate` off.
 */
const WALL_VERT = /* glsl */ `
uniform float uRadius;
uniform vec3 uCenter;
uniform float uHeight;
uniform float uBaseDrop;

attribute float aU;        // 0..1 around the circle
attribute float aGroundY;  // terrain height under this column, world Y

varying vec3 vWorld;
varying vec2 vSurf;        // (angle 0..1, height 0..1)
varying float vHeightM;    // metres above the ground line
varying float vDist;       // view distance, for fog and near-fade
varying vec3 vViewDir;     // fragment -> camera, world space

void main() {
  vec3 dir = vec3(position.x, 0.0, position.z);
  // The unit ring is already normalised, but a degenerate column would give
  // a NaN normal and a black hole in the wall; clamp it out.
  float len = max(length(dir), 0.0001);
  dir /= len;

  vec3 world;
  world.xz = uCenter.xz + dir.xz * uRadius;
  world.y = aGroundY - uBaseDrop + position.y * (uHeight + uBaseDrop);

  vWorld = world;
  vSurf = vec2(aU, position.y);
  vHeightM = world.y - aGroundY;

  vec4 mv = viewMatrix * vec4(world, 1.0);
  vDist = length(mv.xyz);
  vViewDir = cameraPosition - world;
  gl_Position = projectionMatrix * mv;
}
`;

const WALL_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3 uCenter;
uniform float uBaseDrop;

uniform sampler2D uHex;
uniform float uHexRepeatU;   // integer — seamless around the circumference
uniform float uHexRepeatV;

uniform vec3 uDeep;          // the body colour, deep indigo
uniform vec3 uMid;           // violet, where the energy sits
uniform vec3 uHot;           // near-white, only at the peaks
uniform float uOpacity;
uniform float uIntensity;    // rises while the wall is moving
uniform float uCharge;       // 0..1 pre-close warning charge
uniform float uInside;       // 1 while the camera is inside the safe zone

uniform vec3 uFogColor;
uniform float uFogDensity;

varying vec3 vWorld;
varying vec2 vSurf;
varying float vHeightM;
varying float vDist;
varying vec3 vViewDir;

${GLSL_NOISE3}
${GLSL_FOG}

void main() {
  float h = max(vHeightM, 0.0);

  // Everything angular is sampled on the unit circle rather than on a linear
  // u, which is what makes the whole field seamless at the wrap (see the
  // note on GLSL_NOISE3). Translating the sample point in the plane keeps it
  // seamless, so the animation is free.
  float ang = vSurf.x * 6.28318530718;
  vec2 ring = vec2(cos(ang), sin(ang));
  // Roughly one noise cell per pair of hexes, held there as the
  // circumference collapses so the turbulence never changes scale.
  float S = max(uHexRepeatU * 0.34, 0.7);

  // ---- turbulence ---------------------------------------------------------
  // "turb" is the detail field the lattice shimmers on; "slow" is a much
  // coarser, much slower one that rolls whole patches of the wall up and
  // down in brightness. Everything below is multiplied by one of them, which
  // is what stops any layer reading as a texture playing back on a loop.
  vec3 nuv = vec3(ring * S, h * 0.010);
  float turb = dzFbm3(nuv + vec3(uTime * 0.020, uTime * 0.013, -uTime * 0.085));
  float slow = dzNoise3(vec3(ring * S * 0.30, h * 0.0030) + vec3(0.0, 0.0, -uTime * 0.055));

  // ---- hex lattice --------------------------------------------------------
  // Two copies of the same seamless tile at 1x and 0.5x, scrolling upward at
  // different rates. The offsets are pure translation so the tiling stays
  // seamless no matter what the repeat count is doing.
  vec2 huv = vec2(vSurf.x * uHexRepeatU, h / uHexRepeatV);
  vec2 warp = vec2(turb - 0.5, slow - 0.5) * 0.06;
  float hexA = texture2D(uHex, huv + warp + vec2(uTime * 0.007, -uTime * 0.034)).a;
  float hexB = texture2D(uHex, huv * 0.5 - warp + vec2(-uTime * 0.004, -uTime * 0.013)).a;
  float hex = hexA * 0.85 + hexB * 0.40;
  // The lattice shimmers: cells brighten and die out in rolling patches
  // instead of the whole grid pulsing together.
  hex *= 0.30 + 1.35 * turb;

  // ---- vertical energy streaks -------------------------------------------
  // A per-column seed picks which columns are live, and a sawtooth in world
  // height gives each live column a bolt travelling up the wall.
  float colSeed = dzNoise3(vec3(ring * S * 1.35, 3.71));
  float colLive = smoothstep(0.46, 0.86, dzNoise3(vec3(ring * S * 1.35, uTime * 0.11)));
  float rise = h * 0.0055 - uTime * (0.34 + 0.42 * colSeed);
  // Both pulses are raised cosines rather than powers of fract(). A sawtooth
  // snaps from full to nothing in one pixel, and because the phase varies
  // with the column seed that snap draws a wavy horizontal line right across
  // the wall — which reads as clipped geometry rather than as light. The
  // exponent is what makes one a thin fast head and the other a slow curtain.
  float f1 = fract(rise + colSeed);
  float bolt = pow(0.5 - 0.5 * cos(6.28318530718 * f1), 12.0) * 1.9;
  float f2 = fract(rise * 0.31 + colSeed * 3.1);
  float bolt2 = pow(0.5 - 0.5 * cos(6.28318530718 * f2), 5.0) * 0.55;
  float streak = (bolt + bolt2) * colLive;

  // ---- fresnel ------------------------------------------------------------
  // The cylinder normal is purely radial, so this is exact without a normal
  // attribute. Grazing angles are where a field should be brightest — it is
  // the difference between a shell and a volume.
  vec3 N = normalize(vec3(vWorld.x - uCenter.x, 0.0, vWorld.z - uCenter.z));
  vec3 V = normalize(vViewDir);
  float ndv = abs(dot(N, V));
  float fres = pow(1.0 - ndv, 2.6);

  // ---- vertical profile ---------------------------------------------------
  // Hot and dense where it touches the island, thinning to a long tail; this
  // is the profile that makes the wall look like it is being *emitted* by the
  // ground rather than dropped onto it.
  float contact = exp(-h * 0.055);          // the first ~20 m
  float body = exp(-h * 0.0021);            // the long climb
  float topFade = 1.0 - smoothstep(0.62, 1.0, vSurf.y);
  // Soft bottom: below the ground line the wall is buried, but on a rise you
  // can see under the skirt, so it fades out rather than ending on a plane.
  float bottomFade = smoothstep(-uBaseDrop, -uBaseDrop * 0.25, vHeightM);

  // ---- assemble -----------------------------------------------------------
  // Two separate quantities, because a storm wall is two things at once: a
  // volume that HIDES what is behind it, and a light source. Additive
  // blending can only ever be the second, which is why a purely additive
  // wall turns the sky white instead of turning it violet — it was the first
  // thing this shader got wrong and the loudest. Premultiplied alpha buys
  // both out of one pass: "cover" occludes, and any light emitted above the
  // coverage glows on top of it.
  float energy =
      0.16 * body +
      0.80 * hex * body +
      1.20 * streak * body +
      0.52 * fres * (0.30 + 0.70 * body) +
      0.55 * contact;
  energy *= 0.58 + 0.86 * slow;
  // While the wall is charging up to move it gets visibly angrier. This is a
  // free, readable warning that costs no HUD real estate.
  energy *= 1.0 + 0.55 * uCharge;

  float cover = 0.30 + 0.44 * body + 0.34 * contact + 0.30 * hex * body + 0.22 * fres;
  cover *= 0.72 + 0.50 * slow;
  cover = clamp(cover, 0.0, 1.0) * uOpacity * topFade * bottomFade;

  vec3 col = mix(uDeep, uMid, clamp(energy * 0.90, 0.0, 1.0));
  col = mix(col, uHot, clamp(streak * 0.80 + fres * 0.26 + pow(energy, 2.4) * 0.35, 0.0, 1.0));
  // Contact keeps a warmer magenta so the base does not go the same blue as
  // the sky it is standing in front of.
  col = mix(col, vec3(0.92, 0.46, 1.0), contact * 0.28);

  // ---- aerial perspective -------------------------------------------------
  // An honest mix now that this is a real alpha blend: the far side of a
  // 2.5 km circle sits behind the same air the island does.
  // Graded by the haze, but floored: inside the storm the fog is dense
  // enough to erase the wall entirely, and the boundary you are running for
  // is the last thing in the frame allowed to disappear.
  float fogAmt = dzFogAmount(vDist, uFogDensity);
  col = mix(col, uFogColor, fogAmt * 0.45);
  cover *= mix(1.0, 0.62, fogAmt);
  energy *= mix(1.0, 0.34, fogAmt);

  // Standing with your nose against the wall should not white out the frame.
  float nearK = mix(0.28, 1.0, smoothstep(0.5, 14.0, vDist));
  cover *= nearK;
  energy *= nearK;
  // From outside the circle the wall is a landmark; from inside it is a
  // threat, and it wants to be a touch heavier.
  cover *= mix(0.86, 1.0, uInside);

  cover = clamp(cover, 0.0, 0.96);
  vec3 emit = col * (cover * 0.85 + clamp(energy, 0.0, 2.2) * 0.34 * uIntensity);
  gl_FragColor = vec4(emit, cover);
}
`;

/* ------------------------------------------------------------------------ *
 * The projected ground rings
 * ------------------------------------------------------------------------ */

/**
 * A ribbon of terrain-following quads. The CPU supplies a mid-line position
 * per angle plus the height gradient along the radius; the vertex shader does
 * the widening, so the ribbon can get wider with distance (screen legibility)
 * without the CPU having to re-sample the terrain at the new width.
 */
const RING_VERT = /* glsl */ `
uniform vec3 uCamPos;
uniform float uWidth;
uniform float uLift;
uniform float uWidenPerMetre;
uniform float uMaxWiden;

attribute float aSide;     // -1 inner .. +1 outer
attribute float aAngle;    // 0..1 around the ring
attribute vec2 aRadial;    // unit XZ pointing outward
attribute float aSlope;    // dY/dR under the mid-line

varying float vSide;
varying float vAngle;
varying float vDist;

void main() {
  float d = distance(uCamPos, position);
  // A 7 m band at 900 m is a pixel and a half. Widening with distance is a
  // lie the eye reads as perspective and it is what keeps the next circle
  // legible from the far side of the island.
  float widen = clamp(1.0 + d * uWidenPerMetre, 1.0, uMaxWiden);
  float off = aSide * uWidth * 0.5 * widen;

  vec3 p = position;
  p.xz += aRadial * off;
  // First-order terrain follow: the mid-line height plus the measured cross
  // gradient. Exact on a plane, close enough on anything the island builds.
  p.y += aSlope * off + uLift;

  vSide = aSide;
  vAngle = aAngle;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const RING_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3 uColorCore;
uniform vec3 uColorEdge;
uniform float uOpacity;
uniform float uDashes;      // dashes around the whole ring
uniform float uDashSpeed;
uniform float uPulse;       // 0 = steady, 1 = full breathing
uniform vec3 uFogColor;
uniform float uFogDensity;

varying float vSide;
varying float vAngle;
varying float vDist;

${GLSL_FOG}

void main() {
  // Cross-section: a hot core with soft shoulders. Two profiles multiplied so
  // the band has a bright filament in it rather than being a uniform smear.
  float a = abs(vSide);
  float band = 1.0 - smoothstep(0.20, 1.0, a);
  float core = pow(1.0 - smoothstep(0.0, 0.34, a), 2.0);

  // Dashes chase around the ring — a static ring reads as a decal, a moving
  // one reads as a live projection, and the direction of travel is a second
  // free cue that this is the boundary and not scenery.
  float dash = fract(vAngle * uDashes - uTime * uDashSpeed);
  float dashMask = smoothstep(0.06, 0.24, dash) * (1.0 - smoothstep(0.62, 0.90, dash));
  float lit = band * (0.42 + 0.58 * dashMask) + core * 0.9;

  // Slow breathing, in phase with the wall's own charge.
  lit *= 1.0 + uPulse * 0.28 * sin(uTime * 2.1 + vAngle * 6.2831);

  vec3 col = mix(uColorEdge, uColorCore, clamp(core + dashMask * 0.5, 0.0, 1.0));

  // The rings are held back from the haze harder than anything else in this
  // module. They are the navigation cue, and a boundary you cannot see
  // through the storm you are trying to leave is worse than no boundary — so
  // aerial perspective grades them without ever being allowed to erase them.
  float fogAmt = dzFogAmount(vDist, uFogDensity);
  col = mix(col, uFogColor * 1.15, fogAmt * 0.25);

  float alpha = clamp(lit, 0.0, 1.4) * uOpacity * mix(1.0, 0.55, fogAmt);
  // Kill the ring right under the camera; at 2 m it is a full-screen flash.
  alpha *= smoothstep(1.5, 9.0, vDist);

  gl_FragColor = vec4(col, alpha);
}
`;

/* ------------------------------------------------------------------------ *
 * Interior streak particles
 * ------------------------------------------------------------------------ */

/**
 * One draw call for the whole blizzard. Nothing is simulated on the CPU:
 * each quad derives its own position from a seed and a looping life, so the
 * only per-frame cost is four uniform writes. The field is anchored to the
 * camera and the wind direction is recomputed once per frame from where the
 * camera stands relative to the circle — inside a 110 m box that is
 * indistinguishable from a real curl field.
 */
const STREAK_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uAnchor;    // camera position, snapped
uniform vec3 uWind;      // metres/second, world space
uniform float uLife;
uniform float uBox;
uniform float uLength;
uniform float uWidth;
uniform float uIntensity;

attribute vec3 aSeed;    // 0..1 lattice coordinate + phase
attribute vec2 aCorner;  // (-1|1 across, -1|1 along)

varying float vFade;
varying vec2 vCorner;
varying float vTint;

void main() {
  float speed = 0.55 + 1.05 * aSeed.x;
  float life = fract(uTime / uLife + aSeed.z);

  vec3 start = (aSeed - 0.5) * uBox;
  // Break the lattice: an unjittered grid of start points shows up as banding
  // the moment the wind is anything but axis-aligned.
  start += vec3(
    sin(aSeed.z * 37.1) * uBox * 0.21,
    cos(aSeed.y * 51.7) * uBox * 0.17,
    sin(aSeed.x * 23.9) * uBox * 0.23
  );

  vec3 pos = uAnchor + start + uWind * (life * uLife * speed);

  // Billboard the streak so its long axis follows the wind and its short axis
  // faces the camera.
  vec3 toCam = normalize(cameraPosition - pos);
  vec3 along = normalize(uWind + vec3(0.0001));
  vec3 across = normalize(cross(along, toCam));

  float len = uLength * (0.5 + speed);
  pos += along * (aCorner.y * len * 0.5) + across * (aCorner.x * uWidth * (0.5 + aSeed.y));

  // Fade in and out over the life so nothing pops into or out of existence.
  vFade = sin(life * 3.14159265) * uIntensity;
  vCorner = aCorner;
  vTint = aSeed.y;

  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

const STREAK_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColorA;
uniform vec3 uColorB;

varying float vFade;
varying vec2 vCorner;
varying float vTint;

void main() {
  // Soft along the length, sharp across it: that asymmetry is what makes a
  // quad read as a streak of light rather than a rectangle.
  float across = 1.0 - abs(vCorner.x);
  float along = 1.0 - abs(vCorner.y);
  float shape = pow(across, 1.6) * pow(along, 0.55);
  // A hot filament down the middle of the bright ones.
  shape += pow(across, 7.0) * along * 0.8;

  vec3 col = mix(uColorA, uColorB, vTint);
  float alpha = shape * vFade;
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(col, alpha);
}
`;

/* ------------------------------------------------------------------------ *
 * The interior veil
 * ------------------------------------------------------------------------ */

/**
 * A true full-frame quad — the vertex shader ignores every matrix, so it
 * needs no camera bookkeeping and survives whatever the postfx stack does
 * with the view. It is drawn last, with normal blending, so it *removes*
 * saturation from the frame (out = (1-a)·scene + a·purple) rather than adding
 * light to it. Fog alone cannot do that: fog only reaches the distance, and
 * being inside the storm has to wash out the gun in your hands too.
 */
const VEIL_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const VEIL_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uIntensity;
uniform vec3 uTint;
uniform vec3 uEdge;
uniform float uAspect;

varying vec2 vUv;

${GLSL_NOISE}

void main() {
  vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(c) * 1.42;

  // Vignette: light haze in the middle, heavy in the corners. Keeping the
  // centre readable is what stops the effect from being unplayable.
  float vig = smoothstep(0.18, 1.05, r);

  // Drifting cloud so the veil is not flat. Two layers crossing gives the
  // sense of something blowing past the camera rather than a coloured pane.
  float n = dzFbm(vUv * vec2(uAspect, 1.0) * 3.1 + vec2(uTime * 0.06, -uTime * 0.11));
  float n2 = dzFbm(vUv * vec2(uAspect, 1.0) * 6.7 - vec2(uTime * 0.13, uTime * 0.04));
  float cloud = mix(n, n2, 0.4);

  float a = uIntensity * (0.10 + 0.34 * vig) * (0.62 + 0.76 * cloud);
  vec3 col = mix(uTint, uEdge, vig * 0.7 + cloud * 0.25);

  gl_FragColor = vec4(col, clamp(a, 0.0, 0.72));
}
`;

/* ------------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------------ */

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Signed shortest angular difference, for the HUD's safe-direction arrow. */
function angleDelta(from: number, to: number): number {
  let d = (to - from) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

/* ------------------------------------------------------------------------ *
 * The hex lattice texture (fallback)
 * ------------------------------------------------------------------------ */

/**
 * `MaterialsService` publishes a `stormGrid` texture and that is the one we
 * want — one texture library keeps the world looking like one place. But the
 * storm has to survive materials failing to boot, and a wall with no lattice
 * is a wall with no detail, so this generates an equivalent tile.
 *
 * The lattice is drawn twice: a wide, dim pass that acts as bloom around each
 * edge, then a thin bright pass on top. Alpha-only — the wall shader picks
 * its own colours, and baking a colour in here would fight the fog tint.
 */
function makeHexTexture(size: number): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d");
  if (!g) return new THREE.Texture();

  g.clearRect(0, 0, size, size);
  const cols = 4;
  const rows = 4;
  const cw = size / cols;
  const ch = size / rows;
  g.lineJoin = "round";
  g.lineCap = "round";

  // Pointy-top hexes on an offset lattice. The row offset of half a cell is
  // what makes the tile seamless in both axes at 4x4.
  const hex = (cx: number, cy: number, r: number): void => {
    g.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TWO_PI + Math.PI / 6;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r * 1.06;
      if (k === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.stroke();
  };

  for (let pass = 0; pass < 2; pass++) {
    g.strokeStyle = pass === 0 ? "rgba(190,215,255,0.22)" : "rgba(238,246,255,0.92)";
    g.lineWidth = pass === 0 ? Math.max(3, size * 0.028) : Math.max(1, size * 0.0075);
    for (let r = -1; r <= rows; r++) {
      for (let c = -1; c <= cols; c++) {
        const cx = c * cw + (r & 1 ? cw * 0.5 : 0);
        const cy = r * ch;
        hex(cx, cy, cw * 0.46);
      }
    }
  }

  // A sparse scatter of brighter nodes at the vertices. Real energy fields
  // have hot spots; a perfectly even lattice reads as a wireframe.
  g.fillStyle = "rgba(255,255,255,0.85)";
  for (let r = -1; r <= rows; r++) {
    for (let c = -1; c <= cols; c++) {
      if (((r * 7 + c * 13) & 3) !== 0) continue;
      const cx = c * cw + (r & 1 ? cw * 0.5 : 0);
      const cy = r * ch;
      g.beginPath();
      g.arc(cx, cy - ch * 0.46, Math.max(1.5, size * 0.012), 0, TWO_PI);
      g.fill();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------------ *
 * Wall geometry
 * ------------------------------------------------------------------------ */

interface WallGeometry {
  geometry: THREE.BufferGeometry;
  /** Per-vertex ground height, rewritten from the terrain at 12 Hz. */
  groundAttr: THREE.BufferAttribute;
  segments: number;
  rows: number;
}

/**
 * A unit ring extruded upward. Positions are never touched again — the
 * vertex shader scales the ring by `uRadius` and offsets it by `uCenter`, so
 * a circle that shrinks from 1250 m to nothing is two uniform writes.
 */
function buildWallGeometry(segments: number, rows: number): WallGeometry {
  const cols = segments + 1; // duplicate seam column so u runs 0..1 cleanly
  const count = cols * (rows + 1);

  const position = new Float32Array(count * 3);
  const aU = new Float32Array(count);
  const aGroundY = new Float32Array(count);

  let p = 0;
  for (let j = 0; j <= rows; j++) {
    const v = j / rows;
    for (let i = 0; i < cols; i++) {
      const u = i / segments;
      const a = u * TWO_PI;
      position[p * 3 + 0] = Math.cos(a);
      position[p * 3 + 1] = v;
      position[p * 3 + 2] = Math.sin(a);
      aU[p] = u;
      aGroundY[p] = 0;
      p++;
    }
  }

  const indices: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("aU", new THREE.BufferAttribute(aU, 1));
  const groundAttr = new THREE.BufferAttribute(aGroundY, 1);
  groundAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("aGroundY", groundAttr);
  geometry.setIndex(indices);
  // The wall is re-projected in the vertex shader, so the CPU-side bounds are
  // meaningless. Frustum culling is disabled on the mesh instead.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  return { geometry, groundAttr, segments, rows };
}

/* ------------------------------------------------------------------------ *
 * Terrain-projected ring
 * ------------------------------------------------------------------------ */

/**
 * The ribbon on the ground. Two vertices per angular sample sharing the same
 * mid-line position; the vertex shader pushes them apart along `aRadial` and
 * lifts each by the measured cross-slope, which is exact on a plane and
 * within a few centimetres on anything the island actually builds.
 *
 * Rebuilding costs two `heightAt` calls per segment. That is why the current
 * circle's ring is rebuilt at 12 Hz rather than per frame, and the next
 * circle's only when the phase flips.
 */
class GroundRing {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private readonly position: THREE.BufferAttribute;
  private readonly slope: THREE.BufferAttribute;
  private readonly radial: THREE.BufferAttribute;
  private readonly segments: number;

  constructor(segments: number, opts: {
    core: number;
    edge: number;
    dashes: number;
    dashSpeed: number;
    pulse: number;
    width: number;
    /** Metres of extra width per metre of camera distance. */
    widen: number;
    /** Ceiling on that widening. */
    maxWiden: number;
    renderOrder: number;
  }) {
    this.segments = segments;
    const cols = segments + 1;
    const count = cols * 2;

    const position = new Float32Array(count * 3);
    const aSide = new Float32Array(count);
    const aAngle = new Float32Array(count);
    const aRadial = new Float32Array(count * 2);
    const aSlope = new Float32Array(count);

    for (let i = 0; i < cols; i++) {
      const u = i / segments;
      const a = u * TWO_PI;
      for (let s = 0; s < 2; s++) {
        const k = i * 2 + s;
        aSide[k] = s === 0 ? -1 : 1;
        aAngle[k] = u;
        aRadial[k * 2 + 0] = Math.cos(a);
        aRadial[k * 2 + 1] = Math.sin(a);
      }
    }

    const indices: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, c, b, b, c, d);
    }

    const geometry = new THREE.BufferGeometry();
    this.position = new THREE.BufferAttribute(position, 3);
    this.position.setUsage(THREE.DynamicDrawUsage);
    this.slope = new THREE.BufferAttribute(aSlope, 1);
    this.slope.setUsage(THREE.DynamicDrawUsage);
    this.radial = new THREE.BufferAttribute(aRadial, 2);
    geometry.setAttribute("position", this.position);
    geometry.setAttribute("aSide", new THREE.BufferAttribute(aSide, 1));
    geometry.setAttribute("aAngle", new THREE.BufferAttribute(aAngle, 1));
    geometry.setAttribute("aRadial", this.radial);
    geometry.setAttribute("aSlope", this.slope);
    geometry.setIndex(indices);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geometry;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCamPos: { value: new THREE.Vector3() },
        uWidth: { value: opts.width },
        uLift: { value: RING_LIFT },
        uWidenPerMetre: { value: opts.widen },
        uMaxWiden: { value: opts.maxWiden },
        uColorCore: { value: new THREE.Color(opts.core) },
        uColorEdge: { value: new THREE.Color(opts.edge) },
        uOpacity: { value: 0 },
        uDashes: { value: opts.dashes },
        uDashSpeed: { value: opts.dashSpeed },
        uPulse: { value: opts.pulse },
        uFogColor: { value: new THREE.Color(0x9fd6ea) },
        uFogDensity: { value: 0.00025 },
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      // Additive so the ring survives being drawn over dark grass at dusk and
      // over bleached sand at noon without ever looking like paint.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      // A decal lying on a heightfield 900 m out is exactly the case the
      // depth buffer cannot resolve; the offset buys back the precision.
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -12,
      fog: false,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = "dz:storm-ring";
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = opts.renderOrder;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  /**
   * Re-project onto the terrain. `seaLevel` floats the ribbon on the water
   * where the circle edge crosses the sea — sinking it under an opaque ocean
   * would delete exactly the navigation cue a player swimming a channel
   * needs most.
   */
  rebuild(cx: number, cz: number, radius: number, terrain: TerrainService | undefined): void {
    const pos = this.position.array as Float32Array;
    const slope = this.slope.array as Float32Array;
    const rad = this.radial.array as Float32Array;
    const seaLevel = terrain ? terrain.seaLevel : 0;
    const probe = RING_SLOPE_PROBE;

    for (let i = 0; i <= this.segments; i++) {
      const k = i * 2;
      const dx = rad[k * 2 + 0];
      const dz = rad[k * 2 + 1];
      const x = cx + dx * radius;
      const z = cz + dz * radius;

      let y = seaLevel;
      let dydr = 0;
      if (terrain) {
        const hIn = terrain.heightAt(x - dx * probe, z - dz * probe);
        const hOut = terrain.heightAt(x + dx * probe, z + dz * probe);
        y = (hIn + hOut) * 0.5;
        dydr = (hOut - hIn) / (probe * 2);
        if (y < seaLevel + 0.5) {
          y = seaLevel + 0.5;
          dydr = 0;
        }
      }

      for (let s = 0; s < 2; s++) {
        const v = k + s;
        pos[v * 3 + 0] = x;
        pos[v * 3 + 1] = y;
        pos[v * 3 + 2] = z;
        slope[v] = dydr;
      }
    }

    this.position.needsUpdate = true;
    this.slope.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ------------------------------------------------------------------------ *
 * Interior streaks
 * ------------------------------------------------------------------------ */

/** One draw call of camera-anchored, wind-aligned light streaks. */
class StreakField {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;

  constructor(count: number, rng: () => number) {
    const verts = count * 4;
    const aSeed = new Float32Array(verts * 3);
    const aCorner = new Float32Array(verts * 2);
    const position = new Float32Array(verts * 3); // unused, but three wants it
    const indices = new Uint32Array(count * 6);

    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];

    for (let i = 0; i < count; i++) {
      const sx = rng();
      const sy = rng();
      const sz = rng();
      for (let c = 0; c < 4; c++) {
        const v = i * 4 + c;
        aSeed[v * 3 + 0] = sx;
        aSeed[v * 3 + 1] = sy;
        aSeed[v * 3 + 2] = sz;
        aCorner[v * 2 + 0] = corners[c][0];
        aCorner[v * 2 + 1] = corners[c][1];
      }
      const b = i * 4;
      const o = i * 6;
      indices[o + 0] = b;
      indices[o + 1] = b + 1;
      indices[o + 2] = b + 2;
      indices[o + 3] = b;
      indices[o + 4] = b + 2;
      indices[o + 5] = b + 3;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(aSeed, 3));
    geometry.setAttribute("aCorner", new THREE.BufferAttribute(aCorner, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geometry;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAnchor: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector3(1, 0, 0) },
        uLife: { value: PARTICLE_LIFE },
        uBox: { value: PARTICLE_BOX },
        uLength: { value: 3.2 },
        uWidth: { value: 0.085 },
        uIntensity: { value: 0 },
        // Cold violet through to a pale electric blue. Two ends of the same
        // hue family — a two-colour particle system with unrelated hues is
        // one of the fastest ways to make an effect look like clip art.
        uColorA: { value: new THREE.Color(0x8f5cff) },
        uColorB: { value: new THREE.Color(0xc9e6ff) },
      },
      vertexShader: STREAK_VERT,
      fragmentShader: STREAK_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = "dz:storm-streaks";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ------------------------------------------------------------------------ *
 * Audio
 * ------------------------------------------------------------------------ */

/**
 * The storm owns a small `AudioContext` of its own for the same reason loot
 * does: a continuous, distance-driven, filter-swept bed is not a `play()`
 * call, and `AudioService` publishes one-shots and named ambience loops.
 * Stingers still go through the service when it exists — those *are* one-shots
 * and they belong on the shared bus so the mix stays coherent.
 *
 * Three voices:
 *  - **roar**  — brown-ish noise through a lowpass that opens as you get
 *    closer. Low and wide; this is the "something enormous is nearby" layer.
 *  - **hiss**  — the same noise through a resonant bandpass, only audible
 *    within a few dozen metres of the wall or once you are inside it. This is
 *    the layer that tells you the wall is *right there*.
 *  - **sub**   — two detuned low sines with a slow tremolo, felt more than
 *    heard, ducked hard when you are safe so it never muddies a firefight.
 */
class StormAudio {
  private acx: AudioContext | null = null;
  private master: GainNode | null = null;
  private roarGain: GainNode | null = null;
  private hissGain: GainNode | null = null;
  private subGain: GainNode | null = null;
  private roarFilter: BiquadFilterNode | null = null;
  private hissFilter: BiquadFilterNode | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private oscillators: OscillatorNode[] = [];
  private noise: AudioBuffer | null = null;
  private failed = false;

  /** Safe to call every frame; only the first call after a gesture does work. */
  ensure(): void {
    if (this.acx || this.failed) return;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        this.failed = true;
        return;
      }
      const acx = new Ctor();
      const master = acx.createGain();
      master.gain.value = 0.85;
      master.connect(acx.destination);
      this.acx = acx;
      this.master = master;

      // Brown noise: integrated white, then DC-corrected. White noise sounds
      // like radio static; brown sounds like weather, and that difference is
      // most of the character of this bed.
      const len = Math.floor(acx.sampleRate * 3);
      const buf = acx.createBuffer(1, len, acx.sampleRate);
      const data = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.021 * white) / 1.021;
        data[i] = last * 3.4;
      }
      // Crossfade the tail into the head so the 3 s loop has no seam.
      const fade = Math.floor(acx.sampleRate * 0.12);
      for (let i = 0; i < fade; i++) {
        const k = i / fade;
        data[i] = data[i] * k + data[len - fade + i] * (1 - k);
      }
      this.noise = buf;

      // ---- roar
      const roarFilter = acx.createBiquadFilter();
      roarFilter.type = "lowpass";
      roarFilter.frequency.value = 220;
      roarFilter.Q.value = 0.9;
      const roarGain = acx.createGain();
      roarGain.gain.value = 0;
      roarFilter.connect(roarGain);
      roarGain.connect(master);
      this.roarFilter = roarFilter;
      this.roarGain = roarGain;
      this.sources.push(this.startNoise(acx, buf, roarFilter, 1));

      // ---- hiss
      const hissFilter = acx.createBiquadFilter();
      hissFilter.type = "bandpass";
      hissFilter.frequency.value = 1650;
      hissFilter.Q.value = 1.4;
      const hissGain = acx.createGain();
      hissGain.gain.value = 0;
      hissFilter.connect(hissGain);
      hissGain.connect(master);
      this.hissFilter = hissFilter;
      this.hissGain = hissGain;
      // A different playback rate so the two beds do not phase-lock into one
      // audible 3 s loop.
      this.sources.push(this.startNoise(acx, buf, hissFilter, 1.37));

      // ---- sub
      const subGain = acx.createGain();
      subGain.gain.value = 0;
      subGain.connect(master);
      for (const [freq, gain] of [
        [37, 0.7],
        [55.5, 0.32],
        [111, 0.09],
      ] as [number, number][]) {
        const osc = acx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        const g = acx.createGain();
        g.gain.value = gain;
        osc.connect(g);
        g.connect(subGain);
        osc.start();
        this.oscillators.push(osc);
      }
      // Slow tremolo on the sub. Without it the low end is a test tone.
      const lfo = acx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 0.19;
      const lfoGain = acx.createGain();
      lfoGain.gain.value = 0.35;
      lfo.connect(lfoGain);
      lfoGain.connect(subGain.gain);
      lfo.start();
      this.oscillators.push(lfo);
      this.subGain = subGain;
    } catch {
      this.failed = true;
    }
  }

  private startNoise(
    acx: AudioContext,
    buf: AudioBuffer,
    dest: AudioNode,
    rate: number,
  ): AudioBufferSourceNode {
    const src = acx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate;
    src.connect(dest);
    src.start();
    return src;
  }

  /** Browsers suspend the context until a gesture; the page drives this. */
  resume(): void {
    this.ensure();
    if (this.acx && this.acx.state === "suspended") void this.acx.resume().catch(() => undefined);
  }

  /**
   * `near` is 0 far from the wall, 1 with your face against it. `inside` is
   * how deep into the storm the listener is. Both drive gains *and* filters:
   * a bed that only changes volume reads as a slider, one that opens its
   * filter as you approach reads as approaching.
   */
  setLevels(near: number, inside: number): void {
    const acx = this.acx;
    if (!acx || !this.roarGain || !this.hissGain || !this.subGain) return;
    const t = acx.currentTime;
    const n = clamp01(near);
    const i = clamp01(inside);

    // setTargetAtTime rather than ramps: crossing the wall should swell, and
    // a linear ramp to a new value every frame is audibly stepped.
    this.roarGain.gain.setTargetAtTime(0.26 * n + 0.42 * i, t, 0.25);
    this.hissGain.gain.setTargetAtTime(0.035 * n * n + 0.11 * i, t, 0.18);
    this.subGain.gain.setTargetAtTime(0.10 * n + 0.26 * i, t, 0.35);

    if (this.roarFilter) {
      this.roarFilter.frequency.setTargetAtTime(160 + 520 * n + 700 * i, t, 0.3);
    }
    if (this.hissFilter) {
      this.hissFilter.frequency.setTargetAtTime(1250 + 900 * n + 500 * i, t, 0.3);
    }
  }

  /** Mute everything without tearing the graph down (menus, victory, death). */
  silence(): void {
    this.setLevels(0, 0);
  }

  private tone(freq: number, at: number, dur: number, type: OscillatorType, gain: number, sweep = 1): void {
    const acx = this.acx;
    const master = this.master;
    if (!acx || !master) return;
    const osc = acx.createOscillator();
    const g = acx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (sweep !== 1) osc.frequency.exponentialRampToValueAtTime(Math.max(freq * sweep, 1), at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  private noiseBurst(at: number, dur: number, freq: number, q: number, gain: number, sweepTo = 0): void {
    const acx = this.acx;
    const master = this.master;
    const buf = this.noise;
    if (!acx || !master || !buf) return;
    const src = acx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = acx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(freq, at);
    if (sweepTo > 0) filter.frequency.exponentialRampToValueAtTime(sweepTo, at + dur);
    filter.Q.value = q;
    const g = acx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + dur * 0.16);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(master);
    src.start(at);
    src.stop(at + dur + 0.05);
  }

  /** The countdown pip. `urgency` 0..1 pushes it up in pitch and forward. */
  warn(urgency: number): void {
    const acx = this.acx;
    if (!acx) return;
    const t0 = acx.currentTime + 0.01;
    const u = clamp01(urgency);
    this.tone(392 + 180 * u, t0, 0.16 + 0.06 * (1 - u), "triangle", 0.09 + 0.05 * u);
    this.tone((392 + 180 * u) * 1.5, t0 + 0.005, 0.12, "sine", 0.035);
  }

  /** The wall starting to move: a long descending swell with grit under it. */
  closeSweep(): void {
    const acx = this.acx;
    if (!acx) return;
    const t0 = acx.currentTime + 0.01;
    this.tone(220, t0, 1.5, "sawtooth", 0.055, 0.34);
    this.tone(110, t0 + 0.05, 1.9, "sine", 0.09, 0.5);
    this.noiseBurst(t0, 1.7, 900, 0.7, 0.10, 180);
  }

  /** The wall arriving at its new position: a short settling thud. */
  settle(): void {
    const acx = this.acx;
    if (!acx) return;
    const t0 = acx.currentTime + 0.01;
    this.tone(74, t0, 0.7, "sine", 0.12, 0.55);
    this.noiseBurst(t0, 0.5, 320, 0.9, 0.06);
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
    this.sources.length = 0;
    for (const o of this.oscillators) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
      o.disconnect();
    }
    this.oscillators.length = 0;
    this.roarGain?.disconnect();
    this.hissGain?.disconnect();
    this.subGain?.disconnect();
    this.roarFilter?.disconnect();
    this.hissFilter?.disconnect();
    this.master?.disconnect();
    this.roarGain = null;
    this.hissGain = null;
    this.subGain = null;
    this.roarFilter = null;
    this.hissFilter = null;
    this.master = null;
    this.noise = null;
    const acx = this.acx;
    this.acx = null;
    // close() returns a promise; a rejection here must never escape teardown.
    if (acx) void acx.close().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------------ *
 * The system
 * ------------------------------------------------------------------------ */

/** Attributed to the storm in the kill feed and the death card. */
const STORM_SOURCE: DamageSource = { by: "storm", name: "the storm", weapon: "storm" };

/** States the player is in where storm damage would be nonsense. */
const NO_DAMAGE_STATES = new Set(["bus", "skydive", "glide", "dead"]);

/** Seconds before the wall moves at which the countdown pips fire. */
const WARN_PIPS = [30, 10, 5, 4, 3, 2, 1];

/**
 * Mostly-linear with eased ends. Pure `smoothstep` makes the wall crawl for
 * the first fifteen seconds, which is exactly when a player is deciding
 * whether they have time to loot one more building — it lies to them. Pure
 * linear pops into and out of motion. 45/55 is the blend that reads as a
 * wall of energy being pushed rather than an animation curve.
 */
function closeEase(t: number): number {
  const s = t * t * (3 - 2 * t);
  return t * 0.45 + s * 0.55;
}

const createStorm: SystemFactory = (ctx: WorldCtx): System => {
  const services = ctx.services as StormServices;
  const tier = TIERS[ctx.quality] ?? TIERS.high;
  // Own RNG stream. Pulling from `ctx.rng` directly would make the circle
  // sequence depend on how many numbers every other system happened to draw
  // before us, and the storm is the one thing a player will want to be able
  // to reason about across a re-roll of the same seed.
  const rng = (() => {
    let a = (Math.floor(ctx.rng() * 0xffffffff) ^ 0x5721c0de) >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();

  // ------------------------------------------------------------------ state

  type Mode = "grace" | "wait" | "close" | "done";

  let mode: Mode = "grace";
  let phaseIndex = 0;
  let running = false;
  let frozen = false;
  /** Set once we have auto-started, so `begin()` stays idempotent. */
  let started = false;

  const fromCenter = new THREE.Vector3(START_CENTER_X, 0, START_CENTER_Z);
  let fromRadius = START_RADIUS;

  let damageAcc = 0;
  let pipCursor = 0;
  /** Smoothed 0..1 interior pressure — drives fog, veil, streaks and audio. */
  let intensity = 0;
  /** 0..1 how close the camera is to the wall, from either side. */
  let proximity = 0;
  let inStorm = false;

  const tmpA = new THREE.Vector3();
  /** Scratch for the sky's live fog colour, read before we blend over it. */
  const tmpColor = new THREE.Color();

  // --------------------------------------------------------------- service

  const service: DropZeroStormService = {
    center: new THREE.Vector3(START_CENTER_X, 0, START_CENTER_Z),
    radius: START_RADIUS,
    nextCenter: new THREE.Vector3(START_CENTER_X, 0, START_CENTER_Z),
    nextRadius: START_RADIUS * PHASES[0].ratio,
    timer: OPENING_GRACE,
    closing: false,
    circle: 1,
    dps: PHASES[0].dps,
    phaseCount: PHASES.length,

    isSafe(point: THREE.Vector3): boolean {
      const dx = point.x - service.center.x;
      const dz = point.z - service.center.z;
      return dx * dx + dz * dz <= service.radius * service.radius;
    },

    distanceToSafe(point: THREE.Vector3): number {
      const dx = point.x - service.center.x;
      const dz = point.z - service.center.z;
      return Math.sqrt(dx * dx + dz * dz) - service.radius;
    },

    safeDirection(point: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
      const dx = service.center.x - point.x;
      const dz = service.center.z - point.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-4) return out.set(0, 0, 0);
      return out.set(dx / len, 0, dz / len);
    },

    get intensity(): number {
      return intensity;
    },

    get running(): boolean {
      return running;
    },

    begin(): void {
      if (started) return;
      started = true;
      running = true;
    },

    freeze(on: boolean): void {
      frozen = on;
    },

    sampleSafePoint(out = new THREE.Vector3()): THREE.Vector3 {
      return sampleInCircle(service.nextCenter, service.nextRadius * 0.85, out);
    },
  };

  // Published FIRST, before a single byte of geometry is allocated, so any
  // system that boots after us finds it even if the rest of this factory
  // throws on a device that cannot compile the wall shader.
  ctx.services.storm = service;

  /* ------------------------------------------------------------------ *
   * Circle selection
   * ------------------------------------------------------------------ */

  /** Random point inside a circle, area-uniform, on land where we can find it. */
  function sampleInCircle(center: THREE.Vector3, radius: number, out: THREE.Vector3): THREE.Vector3 {
    const terrain = services.terrain;
    for (let attempt = 0; attempt < 14; attempt++) {
      const a = rng() * TWO_PI;
      const r = Math.sqrt(rng()) * radius;
      const x = center.x + Math.cos(a) * r;
      const z = center.z + Math.sin(a) * r;
      const last = attempt === 13;
      if (last || !terrain || !terrain.isWater(x, z)) {
        return out.set(x, terrain ? terrain.heightAt(x, z) : 0, z);
      }
    }
    return out.copy(center);
  }

  /**
   * Pick where circle `index + 1` closes to.
   *
   * The constraint is hard: the new circle must sit entirely inside the old
   * one, or a player standing on the old edge could be outside the new one
   * before the wall has moved at all. Within that budget the candidates are
   * scored on three things, in order of weight:
   *
   *  - **How much of the new circle is land.** A final circle centred on the
   *    bay is a coin flip decided by whoever happened to be swimming. This is
   *    the single most important term.
   *  - **How far the circle is asking people to run.** Every candidate is
   *    penalised by how much of its travel budget it spent, which is what
   *    "biased to stay reachable" means in practice.
   *  - **Whether it lands on somewhere worth fighting over.** A late circle
   *    over a named POI gives the endgame cover, high ground and loot instead
   *    of an empty field.
   */
  function pickNextCircle(index: number): void {
    const phase = PHASES[index];
    const terrain = services.terrain;
    const pois = services.pois;

    const nextR = service.radius * phase.ratio;
    const budget = Math.max(0, (service.radius - nextR) * CENTER_TRAVEL);

    let bestX = service.center.x;
    let bestZ = service.center.z;
    let bestScore = -Infinity;

    for (let c = 0; c < CENTER_CANDIDATES; c++) {
      const ang = rng() * TWO_PI;
      const spend = Math.pow(rng(), 0.75);
      const mag = budget * spend;
      const x = service.center.x + Math.cos(ang) * mag;
      const z = service.center.z + Math.sin(ang) * mag;

      // The reachability penalty is CUBIC, not linear, and that matters more
      // than it looks. Linear, it dominates every other term on an island
      // where nearly every candidate is equally dry, and the circle sits
      // still for eight phases — which is the failure mode that makes a
      // battle royale boring. Cubic leaves the inner two thirds of the
      // travel budget essentially free and only refuses the extreme edge,
      // so circles move a long way but never further than a rotation can
      // cover. The jitter is large for the same reason: it has to be able to
      // break ties between candidates the land term scores identically.
      let score = -Math.pow(spend, 3.0) * 0.85 + rng() * 0.7;

      if (terrain) {
        // Land fraction, sampled on a spiral so a handful of points still
        // covers the disc rather than clustering at the centre.
        let land = 0;
        for (let s = 0; s < CENTER_LAND_SAMPLES; s++) {
          const t = (s + 0.5) / CENTER_LAND_SAMPLES;
          const sa = t * TWO_PI * 3.883; // golden-ish turn count, no aliasing
          const sr = Math.sqrt(t) * nextR;
          if (!terrain.isWater(x + Math.cos(sa) * sr, z + Math.sin(sa) * sr)) land++;
        }
        score += (land / CENTER_LAND_SAMPLES) * 3.2;
        if (!terrain.isWater(x, z)) score += 1.4;

        // Keep the circle on the playable square even if the ratio table is
        // ever retuned to something that could push it off the map.
        const limit = terrain.worldSize - 40;
        if (Math.abs(x) > limit || Math.abs(z) > limit) score -= 6;
      }

      if (pois && pois.length > 0) {
        // Only the last few circles care; early ones covering half the island
        // always contain a POI and the term would be noise.
        const lateness = index / Math.max(1, PHASES.length - 1);
        if (lateness > 0.4) {
          let bonus = 0;
          for (const poi of pois) {
            const d = Math.hypot(poi.center.x - x, poi.center.z - z);
            if (d > nextR + poi.radius) continue;
            bonus += poi.tier === "landmark" ? 0.55 : poi.tier === "major" ? 0.35 : 0.15;
          }
          score += Math.min(bonus, 1.1) * lateness;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestZ = z;
      }
    }

    service.nextRadius = nextR;
    service.nextCenter.set(bestX, terrain ? terrain.heightAt(bestX, bestZ) : 0, bestZ);
    nextRingDirty = true;
  }

  /* ------------------------------------------------------------------ *
   * Assets
   * ------------------------------------------------------------------ */

  // The shared library owns `stormGrid` and that is the tile we want — one
  // texture library is what keeps the island looking like one place. It
  // booted sixteen stages before us, but "booted before" is an ordering
  // guarantee and not a success guarantee, so a local fallback covers it.
  let ownsHexTexture = false;
  let hexTexture: THREE.Texture | null = null;
  try {
    hexTexture = services.materials ? services.materials.texture("stormGrid") : null;
  } catch {
    hexTexture = null;
  }
  if (!hexTexture) {
    hexTexture = makeHexTexture(ctx.quality === "low" ? 128 : 256);
    ownsHexTexture = true;
  }

  // ------------------------------------------------------------------ wall

  const wall = buildWallGeometry(tier.wallSegments, tier.wallRows);

  const wallUniforms = {
    uTime: { value: 0 },
    uRadius: { value: START_RADIUS },
    uCenter: { value: new THREE.Vector3(START_CENTER_X, 0, START_CENTER_Z) },
    uHeight: { value: WALL_HEIGHT },
    uBaseDrop: { value: WALL_BASE_DROP },
    uHex: { value: hexTexture },
    uHexRepeatU: { value: 280 },
    uHexRepeatV: { value: HEX_WORLD_HEIGHT },
    // Three points on one hue ramp. The wall is never two colours at once by
    // accident: deep is the body, mid is where the energy lives, hot is only
    // ever reached by a bolt or a grazing edge.
    uDeep: { value: new THREE.Color(0x2a1160) },
    uMid: { value: new THREE.Color(0x7b3fe4) },
    uHot: { value: new THREE.Color(0xdcc4ff) },
    uOpacity: { value: 0.95 },
    uIntensity: { value: 1 },
    uCharge: { value: 0 },
    uInside: { value: 1 },
    uFogColor: { value: new THREE.Color(0x9fd6ea) },
    uFogDensity: { value: 0.00025 },
  };

  const wallMaterial = new THREE.ShaderMaterial({
    uniforms: wallUniforms,
    defines: { OCTAVES: tier.octaves },
    vertexShader: WALL_VERT,
    fragmentShader: WALL_FRAG,
    // You look at it from outside for the whole first act of a match.
    side: THREE.DoubleSide,
    transparent: true,
    // Premultiplied alpha, NOT additive — see the composite at the end of
    // WALL_FRAG. The shader hands back light already multiplied by coverage,
    // so one pass both hides the sky and glows over it.
    blending: THREE.NormalBlending,
    premultipliedAlpha: true,
    // At three kilometres the depth buffer has nothing left to say. Writing
    // no depth removes the sorting problem entirely and the polygon offset
    // keeps the *test* from flickering against distant terrain.
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
    fog: false,
  });

  const wallMesh = new THREE.Mesh(wall.geometry, wallMaterial);
  wallMesh.name = "dz:storm-wall";
  wallMesh.frustumCulled = false;
  wallMesh.castShadow = false;
  wallMesh.receiveShadow = false;
  // After the opaque island (0) and the sea (1), before the loot beams.
  wallMesh.renderOrder = 6;
  wallMesh.matrixAutoUpdate = false;
  ctx.scene.add(wallMesh);

  // ----------------------------------------------------------------- rings

  /**
   * The wall's own footprint — but really the contact glow. The wall meeting
   * the terrain on a hard line is the last thing that gives a cylinder away,
   * so this is a wide, soft pool of violet light bleeding onto the ground
   * either side of it rather than a thin marker. It barely widens with
   * distance because at range the wall itself is doing the talking.
   */
  const currentRing = new GroundRing(tier.ringSegments, {
    core: 0xe7d3ff,
    edge: 0x7b3fe4,
    dashes: 96,
    dashSpeed: 0.045,
    pulse: 0.35,
    width: RING_WIDTH * 3.2,
    widen: 0.004,
    maxWiden: 2.2,
    renderOrder: 5,
  });
  /**
   * The next circle. Deliberately cyan-white and not violet: it is the one
   * thing on the ground that must never be mistaken for the thing that is
   * about to hurt you, and hue is the only channel that survives being
   * glimpsed at 400 m through haze.
   */
  const nextRing = new GroundRing(tier.ringSegments, {
    core: 0xffffff,
    edge: 0x63d9ff,
    dashes: 64,
    dashSpeed: -0.075,
    pulse: 0.7,
    width: RING_WIDTH * 1.6,
    // A 11 m band 900 m away is a pixel and a half. Widening with distance is
    // a lie the eye reads as perspective, and it is what keeps the next
    // circle legible from the far side of the island.
    widen: 0.014,
    maxWiden: 6,
    renderOrder: 5,
  });
  ctx.scene.add(currentRing.mesh);
  ctx.scene.add(nextRing.mesh);

  // ------------------------------------------------------------- particles

  const streaks = tier.particles > 0 ? new StreakField(tier.particles, rng) : null;
  if (streaks) ctx.scene.add(streaks.mesh);

  // ------------------------------------------------------------------ veil

  let veilMesh: THREE.Mesh | null = null;
  let veilMaterial: THREE.ShaderMaterial | null = null;
  let veilGeometry: THREE.BufferGeometry | null = null;
  if (tier.veil) {
    veilGeometry = new THREE.PlaneGeometry(2, 2);
    veilMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uTint: { value: new THREE.Color(0x7a3fd6) },
        uEdge: { value: new THREE.Color(0x2d1350) },
        uAspect: { value: ctx.camera.aspect || 1 },
      },
      defines: { OCTAVES: Math.min(tier.octaves, 3) },
      vertexShader: VEIL_VERT,
      fragmentShader: VEIL_FRAG,
      transparent: true,
      // Normal blending, not additive: the point is to *remove* saturation
      // from the frame, and additive can only ever add light to it.
      blending: THREE.NormalBlending,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    veilMesh = new THREE.Mesh(veilGeometry, veilMaterial);
    veilMesh.name = "dz:storm-veil";
    veilMesh.frustumCulled = false;
    veilMesh.matrixAutoUpdate = false;
    veilMesh.renderOrder = 9990;
    veilMesh.visible = false;
    ctx.scene.add(veilMesh);
  }

  // ------------------------------------------------------------------ fog

  /**
   * Our own instance, swapped in over the sky's while the storm is pressing.
   * The sky keeps updating its own object the whole time it is detached, so
   * `hostFog.color` is a live read of what the sky would be showing and the
   * blend never snaps when we hand the scene back.
   */
  const stormFog = new THREE.FogExp2(STORM_FOG_COLOR, STORM_FOG_DENSITY);
  const stormFogColor = new THREE.Color(STORM_FOG_COLOR);
  let hostFog: THREE.FogBase | null = null;
  let fogInstalled = false;

  // ----------------------------------------------------------------- audio

  const audio = new StormAudio();
  const offLock = ctx.on("dz:lock", (locked) => {
    if (locked) audio.resume();
  });

  /* ------------------------------------------------------------------ *
   * Bookkeeping
   * ------------------------------------------------------------------ */

  let groundTimer = 0;
  let nextRingDirty = true;
  const groundHeights = new Float32Array(wall.segments + 1);

  /** Re-sample the terrain under the wall and push it into the attribute. */
  function resampleGround(): void {
    const terrain = services.terrain;
    const cx = service.center.x;
    const cz = service.center.z;
    const r = service.radius;
    const cols = wall.segments + 1;
    const seaLevel = terrain ? terrain.seaLevel : 0;

    for (let i = 0; i < cols; i++) {
      const a = (i / wall.segments) * TWO_PI;
      let h = seaLevel;
      if (terrain) {
        h = terrain.heightAt(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
        // Over water the skirt sits on the surface. Dropping it to the seabed
        // would open a 60 m gap under the wall out at sea, which you can see
        // from half the island.
        if (h < seaLevel) h = seaLevel;
      }
      groundHeights[i] = h;
    }

    const attr = wall.groundAttr.array as Float32Array;
    for (let j = 0; j <= wall.rows; j++) {
      const base = j * cols;
      for (let i = 0; i < cols; i++) attr[base + i] = groundHeights[i];
    }
    wall.groundAttr.needsUpdate = true;
  }

  function startClose(): void {
    mode = "close";
    service.closing = true;
    service.timer = PHASES[phaseIndex].close;
    fromCenter.copy(service.center);
    fromRadius = service.radius;
    audio.closeSweep();
    services.audio?.play?.("storm-close", { volume: 0.7 });
    ctx.emit("dz:storm-phase", { circle: service.circle, closing: true, dps: service.dps });
  }

  function finishClose(): void {
    service.center.copy(service.nextCenter);
    service.radius = service.nextRadius;
    service.closing = false;
    audio.settle();

    phaseIndex++;
    if (phaseIndex >= PHASES.length) {
      // Nothing left to shrink. The clock stops; the damage does not.
      mode = "done";
      service.timer = 0;
      service.circle = PHASES.length;
      service.nextRadius = 0;
      service.nextCenter.copy(service.center);
      nextRingDirty = true;
      ctx.emit("dz:storm-phase", { circle: service.circle, closing: false, dps: service.dps, final: true });
      return;
    }

    mode = "wait";
    service.circle = phaseIndex + 1;
    service.dps = PHASES[phaseIndex].dps;
    service.timer = PHASES[phaseIndex].wait;
    pipCursor = 0;
    pickNextCircle(phaseIndex);
    resampleGround();
    ctx.emit("dz:storm-phase", { circle: service.circle, closing: false, dps: service.dps });
  }

  /** Countdown pips through the last thirty seconds of a wait. */
  function servicePips(): void {
    while (pipCursor < WARN_PIPS.length && service.timer <= WARN_PIPS[pipCursor]) {
      const seconds = WARN_PIPS[pipCursor];
      pipCursor++;
      const urgency = 1 - seconds / WARN_PIPS[0];
      audio.warn(urgency);
      services.audio?.play?.("storm-warn", { volume: 0.35 + 0.3 * urgency });
      ctx.emit("dz:storm-warn", { seconds, circle: service.circle });
    }
  }

  // Circle 1's target is chosen up front so the preview ring is on the ground
  // before the bus has even taken off — the drop is a rotation decision and
  // it needs the information.
  pickNextCircle(0);
  resampleGround();

  /* ------------------------------------------------------------------ *
   * Frame payloads (reused — one object, no per-frame garbage)
   * ------------------------------------------------------------------ */

  const stormEvent: StormEvent = {
    circle: 1,
    phaseCount: PHASES.length,
    timer: OPENING_GRACE,
    closing: false,
    dps: PHASES[0].dps,
    radius: START_RADIUS,
    nextRadius: service.nextRadius,
    centerX: START_CENTER_X,
    centerZ: START_CENTER_Z,
    nextX: service.nextCenter.x,
    nextZ: service.nextCenter.z,
    distToSafe: -START_RADIUS,
    bearing: 0,
    inStorm: false,
    intensity: 0,
  };

  /* ------------------------------------------------------------------ *
   * Simulation
   * ------------------------------------------------------------------ */

  function matchLive(): boolean {
    const match = services.match;
    if (!match) return true; // no match machine (dev / sandbox): just run
    return match.phase === "live" || match.phase === "eliminated";
  }

  function applyStormDamage(amount: number): void {
    if (amount <= 0) return;

    const player = services.player;
    if (player) {
      const state = (player as unknown as { state?: string }).state ?? "ground";
      // Being "outside the circle" while strapped into the bus at 800 m is
      // not being caught in the storm.
      if (!NO_DAMAGE_STATES.has(state) && !service.isSafe(player.position)) {
        player.damage(amount, undefined, STORM_SOURCE);
      }
    }

    const combat = services.combat;
    if (!combat) return;
    // One sweep of the whole map. Called once a second at most, and the
    // alternative — the storm keeping its own register of actors — would
    // duplicate the one combat already maintains.
    const targets = combat.queryTargets(service.center, 4200);
    for (const t of targets) {
      if (!t.alive || t.faction !== "bot") continue;
      t.object.getWorldPosition(tmpA);
      if (service.isSafe(tmpA)) continue;
      t.onDamage(amount, tmpA.clone(), STORM_SOURCE, false);
    }
  }

  /**
   * `System` in `types.ts` does not carry `fixed` — the engine looks for it
   * structurally (see `FixedSystem` in `engine/core.ts`) and every other
   * simulation module widens the interface locally rather than editing the
   * shared contract mid-flight. Same here.
   */
  interface FixedSystem extends System {
    fixed(dt: number, ctx: WorldCtx): void;
  }

  const sys: FixedSystem = {
    name: "storm",

    fixed(dt, c) {
      const cc = c.services as StormServices;
      // Auto-start once the match goes live — or immediately, if nothing ever
      // published a match service. `begin()` is idempotent either way.
      if (!started) {
        const match = cc.match;
        if (!match || match.phase === "live") service.begin();
      }
      if (cc.match?.phase === "victory") {
        running = false;
        service.closing = false;
      }
      if (!running || frozen) return;

      service.timer = Math.max(0, service.timer - dt);

      if (mode === "grace") {
        if (service.timer <= 0) {
          mode = "wait";
          service.timer = PHASES[phaseIndex].wait;
          pipCursor = 0;
        }
      } else if (mode === "wait") {
        servicePips();
        if (service.timer <= 0) startClose();
      } else if (mode === "close") {
        const phase = PHASES[phaseIndex];
        const t = 1 - clamp01(service.timer / Math.max(phase.close, 0.001));
        const k = closeEase(t);
        service.radius = THREE.MathUtils.lerp(fromRadius, service.nextRadius, k);
        service.center.lerpVectors(fromCenter, service.nextCenter, k);
        if (service.timer <= 0) finishClose();
      }

      // ---- damage ---------------------------------------------------------
      damageAcc += dt;
      if (damageAcc >= DAMAGE_TICK) {
        const elapsed = damageAcc;
        damageAcc = 0;
        if (matchLive()) applyStormDamage(service.dps * elapsed);
      }
    },

    update(dt, c) {
      const cc = c.services as StormServices;
      const cam = c.camera.position;

      wallUniforms.uTime.value = c.elapsed;

      // ---- circle state → wall --------------------------------------------
      const r = service.radius;
      wallUniforms.uRadius.value = Math.max(r, 0.5);
      (wallUniforms.uCenter.value as THREE.Vector3).copy(service.center);
      // Hexes are held at a constant world size as the circle shrinks, and
      // the repeat count is rounded so the tile stays seamless. It changes by
      // one every few metres of radius, which shifts the pattern by a third
      // of a degree — far below the threshold where a jump is visible.
      wallUniforms.uHexRepeatU.value = Math.max(6, Math.round((TWO_PI * r) / HEX_WORLD_SIZE));

      // The wall is up from the loading screen onward — the first circle is
      // information the player needs while they are still choosing where to
      // jump. `running` gates the clock and the damage, never the picture.
      const visible = r > 2.5;
      wallMesh.visible = visible;

      // ---- charge ---------------------------------------------------------
      // The wall visibly winds up through the last twelve seconds of a wait
      // and stays lit while it moves. Free warning, no HUD real estate.
      let charge = 0;
      if (mode === "close") charge = 1;
      else if (mode === "wait") charge = 1 - smoothstep(0, 12, service.timer);
      wallUniforms.uCharge.value = charge;
      wallUniforms.uIntensity.value = 1 + 0.22 * charge;

      // ---- where is the camera --------------------------------------------
      const playerNow = cc.player;
      const playerState =
        (playerNow as unknown as { state?: string } | undefined)?.state ?? "ground";
      // Riding the bus at 800 m and gliding in are both technically "outside
      // the circle" and neither one is being caught in the storm — the whole
      // interior treatment stays off until the player is actually playing.
      const stormActive = running && matchLive() && !NO_DAMAGE_STATES.has(playerState);

      const distToEdge = service.distanceToSafe(cam);
      const outside = distToEdge > 0;
      wallUniforms.uInside.value = outside ? 0 : 1;
      // Proximity is symmetric: the wall is loud from either side of it.
      proximity = 1 - smoothstep(0, 90, Math.abs(distToEdge));

      const targetIntensity =
        outside && stormActive
          ? clamp01(0.28 + 0.72 * smoothstep(0, INTERIOR_RAMP, distToEdge))
          : 0;
      // Ease across the boundary — a hard cut on the fog and the veil reads
      // as a bug, and stepping in and out of the wall is common.
      intensity += (targetIntensity - intensity) * clamp01(dt * 3.2);
      if (intensity < 0.002) intensity = 0;

      const nowInStorm = outside && stormActive;
      if (nowInStorm !== inStorm) {
        inStorm = nowInStorm;
        const payload: InStormEvent = { inside: inStorm, intensity, dps: service.dps };
        c.emit("dz:in-storm", payload);
        cc.audio?.play?.(inStorm ? "storm-enter" : "storm-exit", { volume: 0.55 });
      }

      // ---- ground re-projection -------------------------------------------
      groundTimer -= dt;
      if (groundTimer <= 0) {
        groundTimer = 1 / GROUND_RESAMPLE_HZ;
        resampleGround();
        currentRing.rebuild(service.center.x, service.center.z, r, cc.terrain);
        if (nextRingDirty) {
          nextRingDirty = false;
          if (service.nextRadius > 4) {
            nextRing.rebuild(
              service.nextCenter.x,
              service.nextCenter.z,
              service.nextRadius,
              cc.terrain,
            );
          }
        }
      }

      // ---- fog ------------------------------------------------------------
      // Read the sky's live values first — whether or not our fog is
      // currently installed, `hostFog` is the object the sky keeps grading.
      const sceneFog = c.scene.fog;
      if (sceneFog && sceneFog !== stormFog) hostFog = sceneFog;
      // Defensive: if another system swapped its own fog in while ours was
      // installed and then handed ours back, do not hold a reference to
      // ourselves or the blend will run away.
      if (hostFog === stormFog) hostFog = null;

      let baseDensity = 0.00025;
      const baseColor = tmpColor.setRGB(0.62, 0.84, 0.92);
      if (hostFog) {
        baseColor.copy(hostFog.color);
        const exp = hostFog as THREE.FogExp2;
        if (typeof exp.density === "number") baseDensity = exp.density;
      }

      if (intensity > 0.004) {
        if (!fogInstalled) {
          fogInstalled = true;
          c.scene.fog = stormFog;
        }
        stormFog.color.copy(baseColor).lerp(stormFogColor, clamp01(intensity * 1.15));
        stormFog.density = THREE.MathUtils.lerp(baseDensity, STORM_FOG_DENSITY, intensity);
      } else if (fogInstalled) {
        fogInstalled = false;
        if (c.scene.fog === stormFog) c.scene.fog = hostFog;
      }

      // Every one of our shaders reproduces the scene's fog term, so they all
      // need whatever the fog currently is — storm or sky.
      const fogColorNow = fogInstalled ? stormFog.color : baseColor;
      const fogDensityNow = fogInstalled ? stormFog.density : baseDensity;
      (wallUniforms.uFogColor.value as THREE.Color).copy(fogColorNow);
      wallUniforms.uFogDensity.value = fogDensityNow;

      // ---- rings ----------------------------------------------------------
      for (const ring of [currentRing, nextRing]) {
        const u = ring.material.uniforms;
        u.uTime.value = c.elapsed;
        (u.uCamPos.value as THREE.Vector3).copy(cam);
        (u.uFogColor.value as THREE.Color).copy(fogColorNow);
        u.uFogDensity.value = fogDensityNow;
      }
      // The footprint ring fades out while the wall is moving: during a close
      // the wall itself is the boundary and a second violet line racing under
      // it is just noise.
      currentRing.material.uniforms.uOpacity.value = visible
        ? 0.85 * (1 - 0.65 * (mode === "close" ? 1 : 0))
        : 0;
      currentRing.mesh.visible = visible;

      // The preview ring is the navigation cue, so it is brightest exactly
      // when it matters: full through the wait, dimming as the wall arrives.
      const previewAlpha =
        mode === "close"
          ? 0.55 + 0.45 * clamp01(service.timer / Math.max(PHASES[phaseIndex].close, 0.001))
          : mode === "done"
            ? 0
            : 1;
      nextRing.material.uniforms.uOpacity.value = service.nextRadius > 4 ? previewAlpha : 0;
      nextRing.mesh.visible = service.nextRadius > 4 && previewAlpha > 0.01;

      // ---- streaks --------------------------------------------------------
      if (streaks) {
        const on = intensity > 0.02;
        streaks.mesh.visible = on;
        if (on) {
          const u = streaks.material.uniforms;
          u.uTime.value = c.elapsed;
          (u.uAnchor.value as THREE.Vector3).copy(cam);
          u.uIntensity.value = clamp01(intensity * 1.1);

          // Wind curls around the circle: mostly tangential, a little
          // outward, a little down. Inside a 110 m box the direction barely
          // changes, so one CPU-side vector per frame is indistinguishable
          // from a real curl field evaluated per particle.
          const dx = cam.x - service.center.x;
          const dz = cam.z - service.center.z;
          const len = Math.hypot(dx, dz) || 1;
          const ox = dx / len;
          const oz = dz / len;
          // Slow rotation so the storm never settles into one direction.
          const swirl = Math.sin(c.elapsed * 0.09) * 0.35;
          const wind = u.uWind.value as THREE.Vector3;
          wind.set(
            -oz * 24 + ox * (6 + swirl * 8),
            -5 - 3 * intensity,
            ox * 24 + oz * (6 + swirl * 8),
          );
        }
      }

      // ---- veil -----------------------------------------------------------
      if (veilMesh && veilMaterial) {
        const on = intensity > 0.01;
        veilMesh.visible = on;
        if (on) {
          veilMaterial.uniforms.uTime.value = c.elapsed;
          veilMaterial.uniforms.uIntensity.value = intensity;
        }
      }

      // ---- audio ----------------------------------------------------------
      audio.ensure();
      audio.setLevels(visible ? proximity : 0, intensity);

      // ---- HUD ------------------------------------------------------------
      const player = playerNow;
      const ref = player ? player.position : cam;
      const d = service.distanceToSafe(ref);
      stormEvent.circle = service.circle;
      stormEvent.timer = service.timer;
      stormEvent.closing = service.closing;
      stormEvent.dps = service.dps;
      stormEvent.radius = service.radius;
      stormEvent.nextRadius = service.nextRadius;
      stormEvent.centerX = service.center.x;
      stormEvent.centerZ = service.center.z;
      stormEvent.nextX = service.nextCenter.x;
      stormEvent.nextZ = service.nextCenter.z;
      stormEvent.distToSafe = d;
      stormEvent.inStorm = d > 0 && stormActive;
      stormEvent.intensity = intensity;
      if (player) {
        service.safeDirection(player.position, tmpA);
        // Same convention the hit indicator uses, so the HUD can rotate a
        // wedge by either without a second sign chart.
        stormEvent.bearing =
          tmpA.lengthSq() > 0 ? angleDelta(player.yaw, Math.atan2(-tmpA.x, -tmpA.z)) : 0;
      } else {
        stormEvent.bearing = 0;
      }
      c.emit("dz:storm", stormEvent);
    },

    resize(width, height) {
      if (veilMaterial) veilMaterial.uniforms.uAspect.value = width / Math.max(height, 1);
    },

    dispose() {
      offLock();
      if (ctx.scene.fog === stormFog) ctx.scene.fog = hostFog;
      fogInstalled = false;

      ctx.scene.remove(wallMesh);
      ctx.scene.remove(currentRing.mesh);
      ctx.scene.remove(nextRing.mesh);
      if (streaks) ctx.scene.remove(streaks.mesh);
      if (veilMesh) ctx.scene.remove(veilMesh);

      wall.geometry.dispose();
      wallMaterial.dispose();
      currentRing.dispose();
      nextRing.dispose();
      streaks?.dispose();
      veilGeometry?.dispose();
      veilMaterial?.dispose();
      // Only ours. `stormGrid` belongs to the material library and disposing
      // it here would blank the wall of the next world that asks for it.
      if (ownsHexTexture) hexTexture?.dispose();

      audio.dispose();
      if (ctx.services.storm === service) ctx.services.storm = undefined;
    },
  };

  return sys;
};

export default createStorm;
