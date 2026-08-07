/**
 * DROP ZERO — visual effects.
 *
 * Publishes `VfxService`. Every other system's feedback arrives on screen
 * through this module: the flash when you fire, the puff when you hit, the
 * number that tells you it counted, the shimmer when you swing a pickaxe, the
 * beam that says "loot here", the fireball when a grenade lands. A battle
 * royale with a weak VFX layer does not read as a hard game — it reads as a
 * tech demo, because nothing on screen confirms that anything happened.
 *
 * ── ARCHITECTURE ──────────────────────────────────────────────────────────
 * Eleven persistent draw calls, allocated once at boot and never grown:
 *
 *   bbAdd     instanced quads, additive   flash, fire, embers, energy, shimmer
 *   bbAlpha   instanced quads, normal     smoke, dust, splinters, chips
 *   streaks   velocity-aligned quads      sparks, tracers, droplets
 *   ringAdd   surface-aligned quads       shockwaves, metal pings, harvest ring
 *   ringDust  surface-aligned quads       ground dust walls, water ripples
 *   decals    surface-aligned quads       bullet holes, scorch, blood, cracks
 *   numbers   billboarded glyph quads     damage numbers (depth-test off)
 *   rubble    InstancedMesh (chamfered)   masonry chunks, dirt clods
 *   shards    InstancedMesh (chamfered)   planks, panels, build-break debris
 *   flashLit  fullscreen quad, normal     damage vignette
 *   flashAdd  fullscreen quad, additive   pickup / heal / elimination pops
 *
 * Every particle layer is a ring buffer of fixed capacity. A spawn writes a
 * dozen floats into one slot, marks a dirty span, and the GPU integrates
 * position, size, rotation, colour and alpha from `spawnTime + velocity +
 * drag + buoyancy` for the rest of that particle's life. The CPU never looks
 * at a live particle again. That is the whole reason a 3000-particle
 * explosion costs about a tenth of a millisecond of main-thread time.
 *
 * The two InstancedMesh layers are the exception — debris has to bounce off
 * the terrain, so it is genuinely simulated. It runs in `fixed()` at 120 Hz
 * with everything else physical in the game, because a chunk that integrates
 * at a variable dt visibly changes its bounce when the frame rate dips.
 *
 * ── WHY IT DOES NOT LOOK LIKE A THREE.JS DEMO ─────────────────────────────
 * Six specific things separate stylised-AAA particles from the default look,
 * and all six are load-bearing here:
 *
 *  1. **Smoke is lit.** Every alpha billboard is treated as a sphere
 *     impostor: the fragment shader reconstructs a normal from the sprite's
 *     own uv, rotates it by the particle's roll, and shades it against the
 *     sun direction in view space, with a separate back-lit rim term. A
 *     dust plume with a bright sun side, a dark shadow side and a hot rim
 *     when the sun is behind it is the difference between "volume" and
 *     "grey circle". Nothing here is flat-ambient.
 *  2. **Nothing has uniform roughness.** The debris materials carry a
 *     procedural roughness map *and* a normal map built from the same fbm
 *     height field, so a stone chunk has wet-looking flat spots and dull
 *     pitted ones on the same face. Uniform roughness is the single loudest
 *     "this is a demo" tell there is.
 *  3. **Nothing is an untextured solid colour.** Every sprite in the atlas
 *     is noise-warped; the rings are broken up by scrolling fbm; the decals
 *     are drawn with cracks, grit and spatter; the debris albedo is a grit
 *     texture multiplied by a per-instance colour.
 *  4. **Everything obeys aerial perspective.** All eight world-space shaders
 *     evaluate the scene's own fog (linear or exp2, whichever the sky system
 *     installed) and either dim toward it (additive) or mix toward it
 *     (alpha). A spark 400 m away that is as bright as one at 4 m destroys
 *     the depth of the whole frame.
 *  5. **Debris has bevel and thickness.** Chunks are chamfered boxes — six
 *     faces, twelve edge strips, eight corner triangles — not cubes. The
 *     chamfer catches a highlight along every edge, which is what makes a
 *     44-triangle lump read as a solid object.
 *  6. **There is small-scale detail everywhere.** Bullet decals carry
 *     radial cracks and ejecta specks; scorch decals have a warm inner rim
 *     because soot is never neutral black up close; damage numerals have a
 *     baked outline and a vertical fill gradient.
 *
 * ── DAMAGE NUMBERS ────────────────────────────────────────────────────────
 * The most-read piece of feedback in the game, so they get their own layer,
 * their own atlas and their own rules. Glyphs are rendered to a canvas atlas
 * with the fill mask in R, the outline mask in G and coverage in A, so one
 * texture can be tinted per-number without tinting its outline. They rise on
 * an arc, pop past their final scale and settle, fade over the last third of
 * their life, billboard to the camera, and render with `depthTest: false` at
 * a huge render order so a number is never swallowed by the wall you shot
 * the enemy through. White for health, blue for shield, bigger and
 * yellow-orange for headshots. Numbers landing on the same spot inside half
 * a second stack upward instead of overlapping into mush.
 *
 * ── SERVICES CONSUMED (all lazily, all null-checked) ──────────────────────
 * `terrain` (ground height + normal under a blast, debris collision, sea
 * level for splashes), `sky` (sun direction and colour — this is what makes
 * smoke agree with the rest of the lighting), `player` (camera for shake and
 * distance falloff), `audio` (one-shot cues). Every one of them may be
 * missing; none of them is fetched at factory time.
 *
 * ── EVENTS ────────────────────────────────────────────────────────────────
 *   listens "dz:shake"  number | { amount, point?, range? } — camera trauma
 *   listens "dz:flash"  { color?, strength?, duration?, additive?, dir? }
 *   listens "dz:hit"    the player took damage — red vignette + a shove
 *   listens "dz:depth"  a THREE.DepthTexture from postfx; enables soft particles
 *   emits   "dz:shake"  so anything else that wants trauma can hear it too
 *
 * NO EXTERNAL ASSETS: every texture in this file is synthesised at boot,
 * either as a DataTexture from a per-pixel callback or on a 2D canvas.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";
import type {
  HarvestKind,
  ImpactMaterial,
  QualityTier,
  Rarity,
  System,
  SystemFactory,
  VfxService,
  WorldCtx,
} from "../types";
import { RARITY_COLOR } from "../types";
import { WATER } from "../mode/water";

// ---------------------------------------------------------------------------
// SOAKED — the extended service
//
// `VfxService` in types.ts is Drop Zero's contract and stays exactly that.
// Water adds seven calls on top of it, published on the SAME object, so a
// water system reads them off `ctx.services.vfx` with a type-only import and
// no runtime coupling at all:
//
//     import type { WaterVfxService } from "../fx/vfx";
//     const wfx = ctx.services.vfx as (VfxService & Partial<WaterVfxService>) | undefined;
//     wfx?.splash?.(point, normal, { surface: "flesh", power: 1.4 });
//
// The `?.` on the method is not paranoia: in classic mode the object is a
// plain VfxService and these are genuinely absent.
// ---------------------------------------------------------------------------

export interface SplashOpts {
  /** Surface struck. Drives crown shape, ring, column and wet patch. */
  surface?: ImpactMaterial;
  /** 0.25..4. Scales every count, every radius and the wet patch. */
  power?: number;
  /** Water colour — pass the weapon's `streamColor`. Near-white reads best. */
  color?: number;
  /** Suppress the wet patch (mid-air bursts, moving targets). */
  noDecal?: boolean;
  /** Suppress the audio cue when the caller is already playing its own. */
  silent?: boolean;
}

export interface StreamOpts {
  /** Ribbon half-width at the head, metres. Default 0.07. */
  width?: number;
  /** Water colour — the weapon's `streamColor`. */
  color?: number;
  /** Downward acceleration, m/s². Pass the weapon's `arc`. Default 9. */
  arc?: number;
  /** Apparent travel speed, m/s. Default 78 — slower than a bullet on purpose. */
  speed?: number;
  /** 0.25..3. Scales droplet count, head size and brightness. */
  power?: number;
}

export interface BalloonBurstOpts {
  /** Blast radius, metres. Defaults to `WATER.balloon.radius`. */
  radius?: number;
  /** Latex colour of the balloon that popped — one of `WATER.balloon.colors`. */
  color?: number;
  /** Water colour. Defaults to `WATER.balloon.splashColor`. */
  waterColor?: number;
  /** Seconds the puddle stays on the ground. Defaults to `WATER.balloon.puddleTime`. */
  puddleTime?: number;
  /** Suppress the audio cue. */
  silent?: boolean;
}

/**
 * A live glue strand. The glue system owns the two endpoints and pushes them
 * in every frame; we own the geometry, the sag, the wobble and the snap.
 */
export interface GlueStrandHandle {
  /**
   * Push this frame's endpoints. `stretch` is 0..1 — 0 at the strand's rest
   * length, 1 at its breaking length — and drives how thin it goes.
   */
  set(a: THREE.Vector3, b: THREE.Vector3, stretch?: number): void;
  /** Break it visibly: the cord parts in the middle and recoils to both ends. */
  snap(): void;
  /** Remove it with no snap — the strand simply expired. */
  release(): void;
  /** False once the snap animation has finished or `release()` was called. */
  readonly alive: boolean;
}

export interface DryingShimmerOpts {
  /** Plume radius at the base, metres. Default 1.1. */
  radius?: number;
  /** Plume height, metres. Default 2.4. */
  height?: number;
  /** 0..2. Scales count and opacity. Default 1. */
  strength?: number;
}

/** Everything SOAKED adds to `VfxService`. */
export interface WaterVfxService {
  /** Water hitting something. Replaces `impact()` wholesale in water mode. */
  splash(point: THREE.Vector3, normal: THREE.Vector3, opts?: SplashOpts): void;
  /** A travelling arc of water with a bright head and a tapering tail. */
  waterStream(from: THREE.Vector3, to: THREE.Vector3, opts?: StreamOpts): void;
  /** The set piece. Replaces `explosion()` in water mode. */
  balloonBurst(point: THREE.Vector3, opts?: BalloonBurstOpts): void;
  /** Acquire a strand from the pool. Never returns null; may steal the oldest. */
  glueStrand(a: THREE.Vector3, b: THREE.Vector3): GlueStrandHandle;
  /** Floating soak number. `faceful` and `poncho` mirror headshot/shield. */
  soakNumber(point: THREE.Vector3, amount: number, faceful: boolean, poncho: boolean): void;
  /** Warm heat haze over a drying station. Call it repeatedly; it is cheap. */
  dryingShimmer(point: THREE.Vector3, opts?: DryingShimmerOpts): void;
  /** A wet patch on a surface with no splash around it. */
  wetPatch(point: THREE.Vector3, normal: THREE.Vector3, size?: number, seconds?: number): void;
}

// ---------------------------------------------------------------------------
// Budgets
//
// Capacities are per-layer and are allocated in full at boot — a ring buffer
// that never grows is the only way to guarantee we never allocate during a
// firefight. `density` scales every burst count, so "low" does not just draw
// fewer pixels, it spawns fewer particles.
// ---------------------------------------------------------------------------

interface VfxBudget {
  /** Capacity of each billboard layer (there are two). */
  billboards: number;
  streaks: number;
  rings: number;
  decals: number;
  /** Chunks per debris mesh (there are two: rubble and shards). */
  debris: number;
  /** Live damage numbers; each costs up to MAX_DIGITS quads. */
  numbers: number;
  /** Pooled point lights, kept in the scene forever so shaders never relink. */
  lights: number;
  /** Sprite atlas edge, px. */
  sprites: number;
  /** Decal atlas edge, px. */
  atlas: number;
  /** Loot beams alive at once before the oldest is recycled. */
  beams: number;
  /** Motes per loot beam — pure vertex-shader animation, so this is cheap. */
  motes: number;
  /** Multiplier applied to every burst count. */
  density: number;
  /** Debris casts shadows only where we can afford the extra shadow draw. */
  debrisShadows: boolean;
}

const BUDGETS: Record<QualityTier, VfxBudget> = {
  low: {
    billboards: 800, streaks: 220, rings: 28, decals: 44, debris: 20, numbers: 20,
    lights: 2, sprites: 256, atlas: 512, beams: 10, motes: 6, density: 0.42,
    debrisShadows: false,
  },
  medium: {
    billboards: 1700, streaks: 420, rings: 52, decals: 96, debris: 36, numbers: 28,
    lights: 3, sprites: 256, atlas: 512, beams: 16, motes: 10, density: 0.7,
    debrisShadows: false,
  },
  high: {
    billboards: 3400, streaks: 800, rings: 92, decals: 190, debris: 64, numbers: 40,
    lights: 4, sprites: 512, atlas: 1024, beams: 24, motes: 14, density: 1.0,
    debrisShadows: false,
  },
  ultra: {
    billboards: 6000, streaks: 1300, rings: 140, decals: 300, debris: 96, numbers: 56,
    lights: 6, sprites: 512, atlas: 1024, beams: 32, motes: 20, density: 1.35,
    debrisShadows: true,
  },
};

/** Damage numbers wider than this are clamped; 9999 is well past any weapon. */
const MAX_DIGITS = 4;
/**
 * Glyph slots reserved per number. SOAKED appends a droplet glyph after the
 * digits ("18💧"), so the pool has to be one wider than the digit count. Drop
 * Zero never spends the extra slot; it costs eight floats of buffer per number.
 */
const MAX_GLYPHS = MAX_DIGITS + 1;

// ---------------------------------------------------------------------------
// Colour-over-life ramps
//
// The row index doubles as a shader attribute, so "what colour is this
// particle at 40 % of its life" is one texture fetch instead of per-frame
// colour maths on the CPU.
//
// Rows 0-4 and 14-15 are authored for ADDITIVE blending: they may never reach
// black, because black is invisible under additive and the particle would
// simply pop out. Rows 5-13 and 16-23 are authored for ALPHA blending: they
// may reach black, and the fireball row deliberately does — that is how one
// particle turns from fire into smoke without a second emitter.
// ---------------------------------------------------------------------------

const RAMP = {
  fire: 0,
  ember: 1,
  flash: 2,
  spark: 3,
  haze: 4,
  fireSmoke: 5,
  smokeDark: 6,
  smokeLight: 7,
  dust: 8,
  concrete: 9,
  dirt: 10,
  wood: 11,
  blood: 12,
  water: 13,
  glass: 14,
  shock: 15,
  grass: 16,
  sand: 17,
  /** The harvest shimmer — Fortnite's pickaxe blue, cyan core to deep blue. */
  harvest: 18,
  /** Flat white with a fast attack, meant to be tinted by the iColor attribute. */
  tintAdd: 19,
  /** Soft white in/out for alpha layers that carry their own tint. */
  tintAlpha: 20,
  /** Hot metal fleck — white to straw to dull iron, never fully black. */
  metalChip: 21,
  /** Slow, faint additive drift — loot motes and floating ash. */
  mote: 22,
  /** Steam / light water vapour — near-white, high alpha, quick out. */
  steam: 23,

  // --- SOAKED ---------------------------------------------------------------
  // Water reads through TRANSPARENCY and SPARKLE, never as blue paint, so
  // every row below is authored near white with only a breath of cyan in it.
  // The moment a droplet ramp goes properly blue it stops looking like water
  // and starts looking like confetti, which is the single failure mode of
  // every water effect that has ever been shipped in a web game.
  /** Droplet body, ALPHA. Peaks well under 1 — you can see through water. */
  waterBody: 24,
  /** The sun on the leading edge, ADDITIVE. White core, cool falloff. */
  waterGlint: 25,
  /** Mist that hangs a moment, ALPHA. Very low alpha, long tail. */
  waterMist: 26,
  /** Cool sheen on a spray ring and the film on a freshly soaked surface. */
  wetSheen: 27,
  /** Glue body, ALPHA — chartreuse, the one colour in the game that is not water. */
  glueBody: 28,
  /** Glue glisten, ADDITIVE. */
  glueGlint: 29,
  /** Drying-station heat haze, ALPHA. Warm, faint, and it must never read blue. */
  heatHaze: 30,
} as const;

const RAMP_ROWS = 31;

/** [t, r, g, b, a], rgb/a in 0..1. Linearly interpolated into the LUT. */
type RampStop = [number, number, number, number, number];

const RAMPS: RampStop[][] = [];
RAMPS[RAMP.fire] = [
  [0.0, 1.0, 1.0, 0.96, 1.0],
  [0.08, 1.0, 0.92, 0.58, 1.0],
  [0.26, 1.0, 0.58, 0.16, 0.92],
  [0.55, 0.86, 0.22, 0.04, 0.55],
  [1.0, 0.3, 0.05, 0.01, 0.0],
];
RAMPS[RAMP.ember] = [
  [0.0, 1.0, 0.94, 0.7, 1.0],
  [0.3, 1.0, 0.52, 0.12, 0.9],
  [0.7, 0.72, 0.14, 0.02, 0.55],
  [1.0, 0.2, 0.02, 0.0, 0.0],
];
RAMPS[RAMP.flash] = [
  [0.0, 1.0, 1.0, 1.0, 1.0],
  [0.18, 1.0, 0.97, 0.86, 0.95],
  [0.5, 1.0, 0.8, 0.45, 0.42],
  [1.0, 0.9, 0.45, 0.15, 0.0],
];
RAMPS[RAMP.spark] = [
  [0.0, 1.0, 1.0, 0.92, 1.0],
  [0.22, 1.0, 0.86, 0.36, 1.0],
  [0.6, 1.0, 0.42, 0.06, 0.8],
  [1.0, 0.55, 0.08, 0.01, 0.0],
];
RAMPS[RAMP.haze] = [
  [0.0, 0.55, 0.34, 0.18, 0.0],
  [0.2, 0.5, 0.3, 0.16, 0.16],
  [0.6, 0.4, 0.26, 0.16, 0.1],
  [1.0, 0.3, 0.22, 0.16, 0.0],
];
// The signature fireball: incandescent white all the way down to cold soot.
RAMPS[RAMP.fireSmoke] = [
  [0.0, 1.0, 0.99, 0.93, 0.92],
  [0.05, 1.0, 0.86, 0.42, 1.0],
  [0.13, 1.0, 0.52, 0.1, 1.0],
  [0.24, 0.78, 0.2, 0.03, 1.0],
  [0.38, 0.34, 0.1, 0.05, 0.98],
  [0.55, 0.15, 0.13, 0.13, 0.92],
  [0.78, 0.11, 0.105, 0.1, 0.62],
  [1.0, 0.1, 0.1, 0.1, 0.0],
];
RAMPS[RAMP.smokeDark] = [
  [0.0, 0.26, 0.25, 0.24, 0.0],
  [0.07, 0.23, 0.22, 0.21, 0.82],
  [0.45, 0.19, 0.185, 0.18, 0.66],
  [1.0, 0.16, 0.16, 0.155, 0.0],
];
RAMPS[RAMP.smokeLight] = [
  [0.0, 0.86, 0.86, 0.87, 0.0],
  [0.1, 0.8, 0.8, 0.81, 0.5],
  [0.5, 0.66, 0.66, 0.68, 0.34],
  [1.0, 0.56, 0.57, 0.6, 0.0],
];
RAMPS[RAMP.dust] = [
  [0.0, 0.82, 0.74, 0.6, 0.0],
  [0.08, 0.78, 0.7, 0.56, 0.78],
  [0.45, 0.66, 0.59, 0.47, 0.48],
  [1.0, 0.55, 0.5, 0.41, 0.0],
];
RAMPS[RAMP.concrete] = [
  [0.0, 0.86, 0.86, 0.84, 0.0],
  [0.06, 0.78, 0.78, 0.76, 0.85],
  [0.4, 0.66, 0.66, 0.65, 0.52],
  [1.0, 0.58, 0.58, 0.57, 0.0],
];
RAMPS[RAMP.dirt] = [
  [0.0, 0.46, 0.35, 0.24, 0.0],
  [0.06, 0.4, 0.3, 0.2, 0.92],
  [0.45, 0.33, 0.25, 0.17, 0.62],
  [1.0, 0.28, 0.21, 0.14, 0.0],
];
RAMPS[RAMP.wood] = [
  [0.0, 0.76, 0.58, 0.35, 0.0],
  [0.06, 0.68, 0.5, 0.29, 0.95],
  [0.45, 0.53, 0.38, 0.22, 0.65],
  [1.0, 0.42, 0.3, 0.18, 0.0],
];
RAMPS[RAMP.blood] = [
  [0.0, 0.78, 0.08, 0.06, 0.0],
  [0.05, 0.6, 0.03, 0.03, 0.95],
  [0.45, 0.37, 0.02, 0.02, 0.7],
  [1.0, 0.2, 0.01, 0.01, 0.0],
];
RAMPS[RAMP.water] = [
  [0.0, 0.96, 0.99, 1.0, 0.0],
  [0.06, 0.9, 0.96, 0.98, 0.85],
  [0.45, 0.74, 0.88, 0.92, 0.5],
  [1.0, 0.66, 0.82, 0.88, 0.0],
];
RAMPS[RAMP.glass] = [
  [0.0, 1.0, 1.0, 1.0, 1.0],
  [0.25, 0.82, 0.95, 1.0, 0.85],
  [1.0, 0.55, 0.8, 0.95, 0.0],
];
RAMPS[RAMP.shock] = [
  [0.0, 1.0, 0.96, 0.88, 0.0],
  [0.08, 1.0, 0.92, 0.76, 0.95],
  [0.35, 1.0, 0.7, 0.35, 0.45],
  [1.0, 0.8, 0.4, 0.15, 0.0],
];
// Torn grass reads yellow-green, not lawn-green: the underside of a blade and
// the dirt that comes up with it are both warmer than the canopy.
RAMPS[RAMP.grass] = [
  [0.0, 0.55, 0.66, 0.28, 0.0],
  [0.07, 0.46, 0.58, 0.22, 0.92],
  [0.45, 0.36, 0.45, 0.18, 0.6],
  [1.0, 0.29, 0.34, 0.16, 0.0],
];
RAMPS[RAMP.sand] = [
  [0.0, 0.95, 0.88, 0.72, 0.0],
  [0.07, 0.9, 0.82, 0.64, 0.88],
  [0.45, 0.8, 0.71, 0.54, 0.55],
  [1.0, 0.7, 0.62, 0.47, 0.0],
];
RAMPS[RAMP.harvest] = [
  [0.0, 0.92, 0.99, 1.0, 1.0],
  [0.12, 0.55, 0.86, 1.0, 1.0],
  [0.45, 0.24, 0.58, 1.0, 0.85],
  [1.0, 0.1, 0.26, 0.85, 0.0],
];
RAMPS[RAMP.tintAdd] = [
  [0.0, 1.0, 1.0, 1.0, 0.0],
  [0.06, 1.0, 1.0, 1.0, 1.0],
  [0.4, 1.0, 1.0, 1.0, 0.66],
  [1.0, 1.0, 1.0, 1.0, 0.0],
];
RAMPS[RAMP.tintAlpha] = [
  [0.0, 1.0, 1.0, 1.0, 0.0],
  [0.12, 1.0, 1.0, 1.0, 0.92],
  [0.55, 0.94, 0.94, 0.94, 0.6],
  [1.0, 0.86, 0.86, 0.86, 0.0],
];
RAMPS[RAMP.metalChip] = [
  [0.0, 1.0, 0.98, 0.9, 1.0],
  [0.2, 0.95, 0.86, 0.62, 1.0],
  [0.6, 0.6, 0.58, 0.55, 0.8],
  [1.0, 0.34, 0.33, 0.32, 0.0],
];
RAMPS[RAMP.mote] = [
  [0.0, 1.0, 1.0, 1.0, 0.0],
  [0.25, 1.0, 1.0, 1.0, 0.7],
  [0.7, 0.95, 0.97, 1.0, 0.5],
  [1.0, 0.85, 0.9, 1.0, 0.0],
];
RAMPS[RAMP.steam] = [
  [0.0, 1.0, 1.0, 1.0, 0.0],
  [0.08, 0.97, 0.98, 1.0, 0.72],
  [0.5, 0.9, 0.93, 0.96, 0.4],
  [1.0, 0.82, 0.87, 0.92, 0.0],
];
// A droplet is a lens, not a bead of paint: the body never exceeds 0.66 alpha
// and never leaves the top corner of the colour cube. What sells it as water
// is the additive glint riding on top, not the colour of the body.
// Deliberately BELOW white. Against a bright sky a real droplet reads darker
// than its background, not brighter — it is a lens, and the only part of it
// that is brighter than the scene is the specular pin the glint layer adds. A
// droplet ramp at full white blows out against sunlit sand and the crown turns
// into one undifferentiated smear, which is exactly what the first pass did.
RAMPS[RAMP.waterBody] = [
  [0.0, 0.82, 0.92, 0.98, 0.0],
  [0.05, 0.72, 0.86, 0.95, 0.72],
  [0.45, 0.64, 0.8, 0.92, 0.5],
  [0.8, 0.58, 0.76, 0.89, 0.28],
  [1.0, 0.54, 0.73, 0.87, 0.0],
];
RAMPS[RAMP.waterGlint] = [
  [0.0, 1.0, 1.0, 1.0, 1.0],
  [0.14, 0.92, 0.99, 1.0, 0.92],
  [0.5, 0.62, 0.9, 1.0, 0.48],
  [1.0, 0.42, 0.76, 0.98, 0.0],
];
// Very low alpha on purpose. Airborne mist is a haze you see the world
// through; at a third of an alpha unit, eleven overlapping puffs composite
// into a solid white shell and the droplets inside it disappear.
RAMPS[RAMP.waterMist] = [
  [0.0, 1.0, 1.0, 1.0, 0.0],
  [0.16, 0.96, 0.99, 1.0, 0.19],
  [0.55, 0.91, 0.96, 0.99, 0.11],
  [1.0, 0.86, 0.94, 0.98, 0.0],
];
RAMPS[RAMP.wetSheen] = [
  [0.0, 0.94, 0.99, 1.0, 0.0],
  [0.09, 0.82, 0.96, 1.0, 0.85],
  [0.45, 0.56, 0.84, 0.99, 0.36],
  [1.0, 0.4, 0.72, 0.96, 0.0],
];
// GLUE.color / GLUE.glowColor from mode/water.ts, expressed as ramps.
RAMPS[RAMP.glueBody] = [
  [0.0, 0.96, 1.0, 0.75, 0.0],
  [0.07, 0.85, 0.95, 0.42, 0.94],
  [0.6, 0.73, 0.86, 0.31, 0.72],
  [1.0, 0.6, 0.75, 0.24, 0.0],
];
RAMPS[RAMP.glueGlint] = [
  [0.0, 1.0, 1.0, 0.93, 1.0],
  [0.2, 0.95, 1.0, 0.79, 0.9],
  [0.6, 0.76, 0.92, 0.43, 0.5],
  [1.0, 0.55, 0.75, 0.26, 0.0],
];
RAMPS[RAMP.heatHaze] = [
  [0.0, 1.0, 0.95, 0.84, 0.0],
  [0.18, 0.99, 0.91, 0.77, 0.24],
  [0.6, 0.96, 0.89, 0.75, 0.14],
  [1.0, 0.93, 0.87, 0.73, 0.0],
];

// ---------------------------------------------------------------------------
// Sprite atlas cells (4×4)
//
// One atlas for both billboard layers, so additive fire and alpha smoke each
// pick a shape per particle without a second texture bind or a second draw.
// ---------------------------------------------------------------------------

const SPRITE_DIV = 4;
const SPRITE = {
  /** Round soft core — glow, embers, droplets, generic chips. */
  glow: 0,
  /** Hot core with anisotropic spikes — muzzle and detonation flash. */
  flare: 1,
  /** Turbulent lumpy puff — the fireball body and heavy smoke. */
  smoke: 2,
  /** Wispy low-contrast puff — dust and grit. */
  dust: 3,
  /** Four-point twinkle — the harvest shimmer and loot sparkle. */
  sparkle: 4,
  /** Angular silhouette — glass shards and stone chips. */
  shard: 5,
  /** Elongated sliver — wood splinters. */
  splinter: 6,
  /** Teardrop — water spray. */
  droplet: 7,
  /** Rough pebble outline — dirt clods. */
  pebble: 8,
  /** Crescent wisp — smoke that has started to shear. */
  wisp: 9,
  /** Tiny bright dot with a wide halo — embers seen at distance. */
  spark: 10,
  /** Second lumpy puff, different seed, so plumes never visibly repeat. */
  smoke2: 11,
  /** Thin soft annulus — small impact ripples drawn as billboards. */
  halo: 12,
  /** Very fine dust, almost noise — the tail of every ground puff. */
  grit: 13,
  /** Two-spike lens streak — the wide part of a muzzle flash. */
  streakFlare: 14,
  /** Long angular sliver — metal spall and long glass shards. */
  spall: 15,
} as const;

const SPRITE_U: number[] = [];
const SPRITE_V: number[] = [];
for (let i = 0; i < SPRITE_DIV * SPRITE_DIV; i++) {
  SPRITE_U.push((i % SPRITE_DIV) / SPRITE_DIV);
  SPRITE_V.push(Math.floor(i / SPRITE_DIV) / SPRITE_DIV);
}

// ---------------------------------------------------------------------------
// Decal atlas cells (4×4)
// ---------------------------------------------------------------------------

const ATLAS_DIV = 4;
const DECAL = {
  holeConcrete: 0,
  holeConcrete2: 1,
  scuff: 2,
  holeMetal: 3,
  holeMetal2: 4,
  holeWood: 5,
  holeDirt: 6,
  glassWeb: 7,
  crackWeb: 8,
  blood: 9,
  blood2: 10,
  scorch: 11,
  scorchSmall: 12,
  soot: 13,
  grassScuff: 14,
  sandPit: 15,
} as const;

// ---------------------------------------------------------------------------
// Per-material impact recipes
//
// Nine materials, nine genuinely different reads. If concrete and metal throw
// the same puff, the player stops learning anything from a hit — and knowing
// "that was metal, I am shooting a car, not a wall" is real information in a
// game where every surface is either cover or loot.
// ---------------------------------------------------------------------------

interface ImpactProfile {
  puffRamp: number;
  puffSprite: number;
  puffCount: number;
  puffSize: number;
  puffSpeed: number;
  puffLife: number;
  puffDrag: number;
  /** Fine chips/splinters thrown as small alpha billboards. */
  chipCount: number;
  chipRamp: number;
  chipSprite: number;
  sparkCount: number;
  sparkRamp: number;
  sparkSpeed: number;
  sparkLife: number;
  sparkWidth: number;
  /** Additive flare brightness at the hit point; 0 = none. */
  flash: number;
  flashRamp: number;
  /** Expanding ring outer radius, 0 = none. */
  ring: number;
  ringRamp: number;
  ringAdditive: boolean;
  /** Solid chunks kicked out of the surface — 0 for most calibres. */
  rubble: number;
  rubbleColor: number;
  decals: number[];
  decalSize: number;
  decalTint: number;
  decalLife: number;
  sound: string;
}

const IMPACTS: Record<ImpactMaterial, ImpactProfile> = {
  concrete: {
    puffRamp: RAMP.concrete, puffSprite: SPRITE.dust, puffCount: 7, puffSize: 0.4,
    puffSpeed: 2.4, puffLife: 0.85, puffDrag: 3.2,
    chipCount: 5, chipRamp: RAMP.concrete, chipSprite: SPRITE.shard,
    sparkCount: 2, sparkRamp: RAMP.spark, sparkSpeed: 7, sparkLife: 0.22, sparkWidth: 0.03,
    flash: 0.5, flashRamp: RAMP.flash,
    ring: 0, ringRamp: RAMP.dust, ringAdditive: false,
    rubble: 1, rubbleColor: 0x9a968c,
    decals: [DECAL.holeConcrete, DECAL.holeConcrete2, DECAL.scuff], decalSize: 0.34,
    decalTint: 0xffffff, decalLife: 55, sound: "impact-concrete",
  },
  metal: {
    puffRamp: RAMP.smokeLight, puffSprite: SPRITE.wisp, puffCount: 2, puffSize: 0.22,
    puffSpeed: 1.6, puffLife: 0.5, puffDrag: 4,
    chipCount: 2, chipRamp: RAMP.metalChip, chipSprite: SPRITE.spall,
    sparkCount: 15, sparkRamp: RAMP.spark, sparkSpeed: 13, sparkLife: 0.55, sparkWidth: 0.028,
    flash: 2.0, flashRamp: RAMP.flash,
    ring: 0.85, ringRamp: RAMP.shock, ringAdditive: true,
    rubble: 0, rubbleColor: 0x8d949a,
    decals: [DECAL.holeMetal, DECAL.holeMetal2], decalSize: 0.3,
    decalTint: 0xffffff, decalLife: 55, sound: "impact-metal",
  },
  wood: {
    puffRamp: RAMP.wood, puffSprite: SPRITE.dust, puffCount: 5, puffSize: 0.32,
    puffSpeed: 2.0, puffLife: 0.7, puffDrag: 3.4,
    chipCount: 10, chipRamp: RAMP.wood, chipSprite: SPRITE.splinter,
    sparkCount: 0, sparkRamp: RAMP.spark, sparkSpeed: 6, sparkLife: 0.2, sparkWidth: 0.03,
    flash: 0.25, flashRamp: RAMP.flash,
    ring: 0, ringRamp: RAMP.dust, ringAdditive: false,
    rubble: 1, rubbleColor: 0xa87b47,
    decals: [DECAL.holeWood, DECAL.holeWood, DECAL.scuff], decalSize: 0.32,
    decalTint: 0xd9c2a0, decalLife: 55, sound: "impact-wood",
  },
  dirt: {
    puffRamp: RAMP.dirt, puffSprite: SPRITE.dust, puffCount: 8, puffSize: 0.55,
    puffSpeed: 2.6, puffLife: 1.0, puffDrag: 2.6,
    chipCount: 8, chipRamp: RAMP.dirt, chipSprite: SPRITE.pebble,
    sparkCount: 0, sparkRamp: RAMP.spark, sparkSpeed: 6, sparkLife: 0.2, sparkWidth: 0.03,
    flash: 0.12, flashRamp: RAMP.flash,
    ring: 0, ringRamp: RAMP.dust, ringAdditive: false,
    rubble: 2, rubbleColor: 0x59422b,
    decals: [DECAL.holeDirt, DECAL.holeDirt, DECAL.soot], decalSize: 0.5,
    decalTint: 0xffffff, decalLife: 45, sound: "impact-dirt",
  },
  grass: {
    puffRamp: RAMP.grass, puffSprite: SPRITE.dust, puffCount: 6, puffSize: 0.44,
    puffSpeed: 2.3, puffLife: 0.9, puffDrag: 3.0,
    chipCount: 9, chipRamp: RAMP.grass, chipSprite: SPRITE.splinter,
    sparkCount: 0, sparkRamp: RAMP.spark, sparkSpeed: 5, sparkLife: 0.2, sparkWidth: 0.03,
    flash: 0.1, flashRamp: RAMP.flash,
    ring: 0, ringRamp: RAMP.dust, ringAdditive: false,
    rubble: 1, rubbleColor: 0x4c5c26,
    decals: [DECAL.grassScuff, DECAL.holeDirt], decalSize: 0.46,
    decalTint: 0xffffff, decalLife: 30, sound: "impact-dirt",
  },
  sand: {
    puffRamp: RAMP.sand, puffSprite: SPRITE.grit, puffCount: 10, puffSize: 0.5,
    puffSpeed: 2.9, puffLife: 1.1, puffDrag: 2.4,
    chipCount: 6, chipRamp: RAMP.sand, chipSprite: SPRITE.pebble,
    sparkCount: 0, sparkRamp: RAMP.spark, sparkSpeed: 5, sparkLife: 0.2, sparkWidth: 0.03,
    flash: 0.1, flashRamp: RAMP.flash,
    ring: 0.5, ringRamp: RAMP.sand, ringAdditive: false,
    rubble: 0, rubbleColor: 0xc9b489,
    decals: [DECAL.sandPit, DECAL.sandPit, DECAL.scuff], decalSize: 0.55,
    decalTint: 0xffffff, decalLife: 30, sound: "impact-dirt",
  },
  water: {
    puffRamp: RAMP.water, puffSprite: SPRITE.droplet, puffCount: 10, puffSize: 0.48,
    puffSpeed: 3.4, puffLife: 0.8, puffDrag: 2.2,
    chipCount: 0, chipRamp: RAMP.water, chipSprite: SPRITE.droplet,
    sparkCount: 12, sparkRamp: RAMP.water, sparkSpeed: 6.5, sparkLife: 0.75, sparkWidth: 0.045,
    flash: 0, flashRamp: RAMP.flash,
    ring: 1.7, ringRamp: RAMP.water, ringAdditive: false,
    rubble: 0, rubbleColor: 0xffffff,
    decals: [], decalSize: 0, decalTint: 0xffffff, decalLife: 0, sound: "impact-water",
  },
  glass: {
    puffRamp: RAMP.smokeLight, puffSprite: SPRITE.wisp, puffCount: 3, puffSize: 0.28,
    puffSpeed: 2.2, puffLife: 0.5, puffDrag: 3.5,
    chipCount: 7, chipRamp: RAMP.glass, chipSprite: SPRITE.shard,
    sparkCount: 14, sparkRamp: RAMP.glass, sparkSpeed: 8.5, sparkLife: 0.9, sparkWidth: 0.035,
    flash: 1.1, flashRamp: RAMP.glass,
    ring: 0.5, ringRamp: RAMP.glass, ringAdditive: true,
    rubble: 0, rubbleColor: 0xbfe0ea,
    decals: [DECAL.glassWeb, DECAL.crackWeb], decalSize: 0.75,
    decalTint: 0xffffff, decalLife: 70, sound: "impact-glass",
  },
  flesh: {
    puffRamp: RAMP.blood, puffSprite: SPRITE.glow, puffCount: 9, puffSize: 0.28,
    puffSpeed: 3.0, puffLife: 0.55, puffDrag: 4.5,
    chipCount: 0, chipRamp: RAMP.blood, chipSprite: SPRITE.glow,
    sparkCount: 8, sparkRamp: RAMP.blood, sparkSpeed: 5.5, sparkLife: 0.6, sparkWidth: 0.035,
    flash: 0, flashRamp: RAMP.flash,
    ring: 0, ringRamp: RAMP.blood, ringAdditive: false,
    rubble: 0, rubbleColor: 0x7a1010,
    decals: [DECAL.blood, DECAL.blood2], decalSize: 0.85,
    decalTint: 0xffffff, decalLife: 50, sound: "impact-flesh",
  },
};

// ---------------------------------------------------------------------------
// Harvest + build-material recipes
//
// The three build materials each have a colour identity that has to survive
// from the pickaxe swing, through the flying chips, through the debris when
// the wall is shot down. If your wood wall shatters into grey chunks the
// player stops trusting the material colour, and the build loop reads worse.
// ---------------------------------------------------------------------------

interface MaterialLook {
  /** Base albedo for solid debris. */
  base: number;
  /** Secondary albedo, mixed per chunk so a pile is never one flat colour. */
  alt: number;
  /** Dust/chip ramp row. */
  ramp: number;
  chipSprite: number;
  /** Sparks when this material breaks (metal only, really). */
  sparks: number;
  /** Chunks are slabs (planks/panels) rather than lumps. */
  slab: boolean;
  /** Slab proportions: [long, thick] relative to the chunk size. */
  slabLong: number;
  slabThin: number;
  sound: string;
}

const MATERIAL_LOOK: Record<HarvestKind, MaterialLook> = {
  wood: {
    base: 0xb07a42, alt: 0x8a5c30, ramp: RAMP.wood, chipSprite: SPRITE.splinter,
    sparks: 0, slab: true, slabLong: 2.6, slabThin: 0.28, sound: "break-wood",
  },
  stone: {
    base: 0x9b968d, alt: 0x726d66, ramp: RAMP.concrete, chipSprite: SPRITE.shard,
    sparks: 2, slab: false, slabLong: 1.3, slabThin: 0.7, sound: "break-stone",
  },
  metal: {
    base: 0xa8b0b6, alt: 0x767f86, ramp: RAMP.metalChip, chipSprite: SPRITE.spall,
    sparks: 10, slab: true, slabLong: 2.0, slabThin: 0.16, sound: "break-metal",
  },
};

// ---------------------------------------------------------------------------
// Damage-number palette
//
// Three colours, and they must never be confused with each other. Shield blue
// is the same blue the HUD uses for the shield bar; headshot gold is the only
// warm number in the game, which is why it reads instantly.
// ---------------------------------------------------------------------------

const DAMAGE_WHITE = 0xf6f8fb;
const DAMAGE_SHIELD = 0x4fb8ff;
const DAMAGE_HEADSHOT = 0xffc23d;
/** Baked outline colour for numerals — near-black, slightly warm. */
const NUMERAL_OUTLINE = new THREE.Color(0x0a0b0d);

// ---------------------------------------------------------------------------
// SOAKED — soak numbers
//
// Same three-way split as damage numbers, restated in water. The rule the
// classic palette obeys still holds: exactly one warm colour, and it belongs
// to the shot you want the player to feel good about. A faceful is that shot.
// ---------------------------------------------------------------------------

const SOAK_PLAIN = 0xeafaff;
const SOAK_PONCHO = 0x74cdff;
const SOAK_FACEFUL = 0xffd166;
/** A cooler outline: near-black with a drop of deep sea in it. */
const SOAK_OUTLINE = new THREE.Color(0x061a26);
/** Atlas cell of the droplet glyph appended to every soak number. */
const NUMERAL_DROPLET = 14;

// ---------------------------------------------------------------------------
// SOAKED — splash recipes
//
// Splash replaces the whole impact family in water mode. Same principle as
// IMPACTS above: the surface has to be legible from the splash alone, because
// "that hit the wall, not him" is the most important read in a firefight and
// there is no blood in this game to tell you.
//
// The three shapes that matter:
//   hard surfaces  a FLAT crown — water hits stone and runs sideways
//   water          a real ring plus a vertical column
//   a person       a big, generous, unmistakable burst
// ---------------------------------------------------------------------------

interface SplashProfile {
  /** Droplets thrown outward, before the density multiplier. */
  crown: number;
  /** Launch elevation range off the surface, radians. Low = flat crown. */
  elev0: number;
  elev1: number;
  /** Droplet launch speed, m/s. */
  speed: number;
  /**
   * Droplet diameter, metres. The single biggest lever on how a splash reads:
   * fine spray off stone versus fat gouts off a person is a size difference,
   * not a count difference, and no amount of extra particles substitutes.
   */
  drop: number;
  /** Radius the spray ring expands to, metres. */
  ring: number;
  /** Hanging mist puffs. */
  mist: number;
  /** Contact-glint brightness. 0 = no flash at all. */
  flash: number;
  /** A vertical column of water, for surfaces that have water in them. */
  column: number;
  /** Wet-patch decal size in metres; 0 = leaves nothing behind. */
  decalSize: number;
  /** Seconds the wet patch takes to dry off the surface. */
  decalLife: number;
  /** Peak opacity of the wet patch. Water darkens, it never paints. */
  decalAlpha: number;
  sound: string;
}

const SPLASH_DEFAULT: SplashProfile = {
  crown: 9, elev0: 0.16, elev1: 0.62, speed: 6.5, drop: 0.055, ring: 0.5, mist: 3,
  flash: 1, column: 0, decalSize: 0.62, decalLife: 22, decalAlpha: 0.42,
  sound: "splash-hard",
};

const SPLASHES: Record<ImpactMaterial, SplashProfile> = {
  // Stone and metal shed water sideways: a wide, low, fast crown.
  concrete: { ...SPLASH_DEFAULT },
  metal: {
    ...SPLASH_DEFAULT,
    crown: 11, elev0: 0.1, elev1: 0.5, speed: 8.2, drop: 0.045, ring: 0.58, flash: 1.25,
    decalSize: 0.56, decalAlpha: 0.5, sound: "splash-metal",
  },
  glass: {
    ...SPLASH_DEFAULT,
    crown: 10, elev0: 0.08, elev1: 0.45, speed: 8.8, drop: 0.042, ring: 0.6, flash: 1.4,
    decalSize: 0.5, decalAlpha: 0.55, sound: "splash-metal",
  },
  // Wood and dirt drink some of it: less crown, a bigger and darker patch.
  wood: {
    ...SPLASH_DEFAULT,
    crown: 7, speed: 5.4, drop: 0.06, ring: 0.42, decalSize: 0.72, decalAlpha: 0.52,
    decalLife: 26, sound: "splash-soft",
  },
  dirt: {
    ...SPLASH_DEFAULT,
    crown: 6, elev0: 0.22, elev1: 0.8, speed: 4.6, drop: 0.07, ring: 0.4, mist: 2,
    flash: 0.6, decalSize: 0.85, decalAlpha: 0.58, decalLife: 30,
    sound: "splash-soft",
  },
  grass: {
    ...SPLASH_DEFAULT,
    crown: 6, elev0: 0.24, elev1: 0.9, speed: 4.4, drop: 0.07, ring: 0.36, mist: 2,
    flash: 0.55, decalSize: 0.7, decalAlpha: 0.4, decalLife: 24,
    sound: "splash-soft",
  },
  sand: {
    ...SPLASH_DEFAULT,
    crown: 7, elev0: 0.2, elev1: 0.85, speed: 4.8, drop: 0.065, ring: 0.44, mist: 2,
    flash: 0.6, decalSize: 0.95, decalAlpha: 0.62, decalLife: 34,
    sound: "splash-soft",
  },
  // Water into water: the ring and the column are the whole effect, and
  // nothing is left behind because the surface is already wet.
  water: {
    crown: 12, elev0: 0.5, elev1: 1.3, speed: 5.5, drop: 0.085, ring: 0.95, mist: 4,
    flash: 0.8, column: 1, decalSize: 0, decalLife: 0, decalAlpha: 0,
    sound: "splash-water",
  },
  // A person. The set piece of every trade in the game: big, wide, generous,
  // and no decal — people are not surfaces, they are targets.
  flesh: {
    crown: 22, elev0: 0.28, elev1: 1.25, speed: 7.6, drop: 0.11, ring: 1.15, mist: 7,
    flash: 1.6, column: 0.45, decalSize: 0, decalLife: 0, decalAlpha: 0,
    sound: "splash-body",
  },
};

/**
 * Darkens the surface it lands on rather than tinting it blue — and only just.
 * A wet patch is a 15-20 % darkening with a slightly cooler cast, nowhere near
 * the near-black this started at, which read as a scorch mark on a sunny deck.
 */
const WET_DECAL_TINT = 0x6d8b98;

// ---------------------------------------------------------------------------
// Procedural texture synthesis
//
// No Math.random anywhere in here: every texture is a pure function of a seed,
// so a reload regenerates a byte-identical atlas and a visual regression is
// always a code change rather than a dice roll.
// ---------------------------------------------------------------------------

/** Integer hash → 0..1. */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smoothFade = (t: number) => t * t * (3 - 2 * t);

/** Tiling value noise on a `period`-cell lattice. */
function valueNoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const w = (a: number) => ((a % period) + period) % period;
  const x0 = w(ix);
  const x1 = w(ix + 1);
  const y0 = w(iy);
  const y1 = w(iy + 1);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  const u = smoothFade(fx);
  const v = smoothFade(fy);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Tiling fbm over the unit domain. */
function fbm(x: number, y: number, oct: number, base: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let per = base;
  for (let i = 0; i < oct; i++) {
    sum += valueNoise(x * per, y * per, per, seed + i * 131) * amp;
    norm += amp;
    amp *= 0.5;
    per *= 2;
  }
  return sum / norm;
}

/** Ridged fbm — sharper filaments, used for the smoke silhouettes. */
function ridged(x: number, y: number, oct: number, base: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let per = base;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(valueNoise(x * per, y * per, per, seed + i * 197) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    per *= 2;
  }
  return sum / norm;
}

/** RGBA DataTexture from a per-pixel callback. `out` is [r,g,b,a] in 0..1. */
function dataTexture(
  size: number,
  fn: (u: number, v: number, out: Float32Array) => void,
  opts: { mips?: boolean; srgb?: boolean; wrap?: THREE.Wrapping; height?: number } = {},
): THREE.DataTexture {
  const h = opts.height ?? size;
  const data = new Uint8Array(size * h * 4);
  const out = new Float32Array(4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < size; x++) {
      out[0] = out[1] = out[2] = out[3] = 0;
      fn((x + 0.5) / size, (y + 0.5) / h, out);
      const i = (y * size + x) * 4;
      data[i] = Math.max(0, Math.min(255, out[0] * 255)) | 0;
      data[i + 1] = Math.max(0, Math.min(255, out[1] * 255)) | 0;
      data[i + 2] = Math.max(0, Math.min(255, out[2] * 255)) | 0;
      data[i + 3] = Math.max(0, Math.min(255, out[3] * 255)) | 0;
    }
  }
  const tex = new THREE.DataTexture(data, size, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = opts.wrap ?? THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = opts.mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = !!opts.mips;
  if (opts.srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The 4×4 particle sprite atlas.
 *
 * Alpha only — colour comes from the ramp LUT and the per-particle tint, so
 * one greyscale atlas serves fire, smoke, blood and rarity-coloured motes.
 * DataTexture is flipY:false, so data row 0 sits at v=0 and the cell layout
 * matches SPRITE_U / SPRITE_V directly with no flip.
 */
function makeSpriteAtlas(edge: number, seed: number): THREE.DataTexture {
  const inv = 1 / SPRITE_DIV;
  return dataTexture(edge, (u, v, out) => {
    const cx = Math.min(SPRITE_DIV - 1, Math.floor(u * SPRITE_DIV));
    const cy = Math.min(SPRITE_DIV - 1, Math.floor(v * SPRITE_DIV));
    const cell = cy * SPRITE_DIV + cx;
    // Local uv inside the cell, 0..1.
    const lu = (u - cx * inv) * SPRITE_DIV;
    const lv = (v - cy * inv) * SPRITE_DIV;
    const dx = lu - 0.5;
    const dy = lv - 0.5;
    const r = Math.hypot(dx, dy) * 2;
    const ang = Math.atan2(dy, dx);
    const s = seed + cell * 977;

    let a = 0;
    switch (cell) {
      case SPRITE.glow:
        a = Math.pow(Math.max(0, 1 - r), 2.4) * 0.85 + Math.exp(-r * r * 11) * 0.75;
        break;
      case SPRITE.flare: {
        a = Math.exp(-r * r * 30) + Math.exp(-r * r * 4.2) * 0.5;
        for (let k = 0; k < 3; k++) {
          const spike = Math.abs(Math.cos(ang - (k * Math.PI) / 3));
          a += Math.pow(spike, 90) * Math.exp(-r * 3.2) * 0.75;
        }
        break;
      }
      case SPRITE.smoke:
      case SPRITE.smoke2: {
        const n = fbm(lu, lv, 4, 4, s);
        const rr2 = ridged(lu * 1.4, lv * 1.4, 3, 5, s + 61);
        // Warping the falloff radius with noise is what makes the silhouette
        // lumpy. A disc with a noise texture painted on it still reads as a
        // disc, because the eye reads the outline first.
        const edgeR = 0.6 + n * 0.5 + rr2 * 0.12;
        const e = 1 - Math.min(1, r / edgeR);
        a = Math.pow(Math.max(0, e), 1.5) * (0.4 + n * 0.95);
        break;
      }
      case SPRITE.dust: {
        const n = fbm(lu, lv, 3, 3, s) * 0.75 + fbm(lu * 1.9, lv * 1.9, 2, 6, s + 7) * 0.35;
        const e = 1 - Math.min(1, r / (0.78 + n * 0.28));
        a = Math.pow(Math.max(0, e), 2.1) * (0.35 + n * 0.8);
        break;
      }
      case SPRITE.grit: {
        // Deliberately near-noise: this is the tail of a dust cloud, where
        // there is no shape left, only suspended particulate.
        const n = fbm(lu * 2.4, lv * 2.4, 4, 8, s);
        const e = 1 - Math.min(1, r / 0.94);
        a = Math.pow(Math.max(0, e), 2.6) * Math.pow(n, 1.7) * 2.1;
        break;
      }
      case SPRITE.sparkle: {
        // Four-point star: the classic "this is magic, not fire" shape.
        const core = Math.exp(-r * r * 90) * 1.2;
        const ax = Math.exp(-Math.abs(dy) * 46) * Math.max(0, 1 - Math.abs(dx) * 2.1);
        const ay = Math.exp(-Math.abs(dx) * 46) * Math.max(0, 1 - Math.abs(dy) * 2.1);
        const diag = Math.exp(-Math.abs(dx - dy) * 70) * Math.max(0, 1 - r) * 0.35 +
          Math.exp(-Math.abs(dx + dy) * 70) * Math.max(0, 1 - r) * 0.35;
        a = core + (ax + ay) * 0.85 + diag;
        break;
      }
      case SPRITE.shard: {
        // Convex polygon with jittered vertices — an angular silhouette that
        // still tumbles convincingly when the quad rolls.
        const sides = 5;
        const k = Math.floor(((ang + Math.PI) / (Math.PI * 2)) * sides);
        const j = 0.62 + hash2(k, 0, s) * 0.38;
        const local = ((ang + Math.PI) / (Math.PI * 2)) * sides - k;
        const j2 = 0.62 + hash2(k + 1, 0, s) * 0.38;
        const edgeR = j + (j2 - j) * local;
        a = r < edgeR ? 1 - Math.pow(r / edgeR, 8) * 0.25 : 0;
        // Bright facet on one side — a chip of glass or stone catches light.
        a *= 0.62 + 0.5 * Math.max(0, Math.cos(ang - 0.9));
        break;
      }
      case SPRITE.spall: {
        // Long thin sliver, tapered at both ends.
        const across = Math.abs(dy) / 0.16;
        const along = Math.abs(dx) / 0.48;
        const taper = 1 - Math.pow(Math.min(1, along), 2.2);
        a = Math.max(0, taper - across * 0.9) * (0.7 + fbm(lu * 3, lv * 3, 2, 5, s) * 0.6);
        break;
      }
      case SPRITE.splinter: {
        // Wood sliver: a wedge, fat at one end, with grain along it.
        const along = (dx + 0.5);
        const width = 0.055 + (1 - along) * 0.11;
        const inside = Math.abs(dy) < width && along > 0.02 && along < 0.98 ? 1 : 0;
        const grain = 0.7 + 0.5 * fbm(lu * 6, lv * 1.5, 2, 8, s);
        a = inside * grain * (1 - Math.pow(Math.abs(dy) / Math.max(width, 1e-4), 3) * 0.5);
        break;
      }
      case SPRITE.droplet: {
        // Teardrop: a disc pulled into a tail along -x.
        const tail = Math.max(0, -dx);
        const squash = 1 + tail * 2.4;
        const rd = Math.hypot(dx * squash, dy) * 2;
        a = Math.pow(Math.max(0, 1 - rd), 1.5) * 1.15;
        // A specular pip near the leading edge sells "liquid" over "blob".
        a += Math.exp(-((dx - 0.12) * (dx - 0.12) + (dy + 0.09) * (dy + 0.09)) * 420) * 0.7;
        break;
      }
      case SPRITE.pebble: {
        const n = fbm(lu * 1.6, lv * 1.6, 3, 4, s);
        const edgeR = 0.72 + n * 0.24;
        const inside = r < edgeR ? 1 : 0;
        // A crude lambert across the pebble so a flying clod has a lit side.
        const lit = 0.5 + 0.55 * Math.max(0, Math.cos(ang - 2.2)) * (1 - r * 0.4);
        a = inside * lit * (0.75 + n * 0.5);
        break;
      }
      case SPRITE.wisp: {
        // Crescent: smoke that has been sheared by its own motion.
        const inner = Math.hypot(dx + 0.16, dy) * 2;
        const n = fbm(lu * 1.3, lv * 1.3, 3, 4, s);
        const outer = 1 - Math.min(1, r / (0.86 + n * 0.2));
        const bite = Math.min(1, Math.max(0, (inner - 0.52) * 2.4));
        a = Math.pow(Math.max(0, outer), 1.8) * bite * (0.5 + n * 0.8);
        break;
      }
      case SPRITE.spark:
        a = Math.exp(-r * r * 190) * 1.4 + Math.exp(-r * r * 12) * 0.42;
        break;
      case SPRITE.halo: {
        const band = Math.exp(-Math.pow((r - 0.74) / 0.13, 2) * 2.4);
        a = band * (0.6 + fbm(lu * 2, lv * 2, 3, 6, s) * 0.8);
        break;
      }
      case SPRITE.streakFlare: {
        // Horizontal lens streak with a hot core — the wide part of a flash.
        const core = Math.exp(-r * r * 60) * 1.2;
        const bar = Math.exp(-Math.abs(dy) * 34) * Math.max(0, 1 - Math.abs(dx) * 2.05);
        a = core + bar * 0.9;
        break;
      }
      default:
        a = 0;
        break;
    }

    // Hard transparent gutter past the inscribed circle. Without it a mip
    // level smears one cell into the one next door and every particle grows a
    // faint square halo at distance.
    a *= Math.max(0, Math.min(1, (1.05 - r) * 9));
    out[0] = out[1] = out[2] = 1;
    out[3] = Math.min(1, a);
  }, { mips: true });
}

/** Streak sprite: bright head, soft tail, rounded caps. */
function makeStreakTexture(): THREE.DataTexture {
  return dataTexture(64, (u, v, out) => {
    // v runs across the ribbon, u runs tail(0) → head(1).
    const across = 1 - Math.abs(v - 0.5) * 2;
    const cap = Math.min(1, Math.min(u, 1 - u) * 14 + 0.15);
    // Squared head weighting: a tracer must be unmistakably brighter at the
    // point than at the tail or it reads as a static line, not a projectile.
    const head = Math.pow(u, 2.4) * 0.92 + 0.08;
    out[0] = out[1] = out[2] = 1;
    out[3] = Math.min(1, Math.pow(Math.max(0, across), 1.7) * head * cap);
  }, { height: 16 });
}

/** Tiling fbm, used to break up rings, beams and the ground glow. */
function makeNoiseTexture(size: number, seed: number): THREE.DataTexture {
  return dataTexture(size, (u, v, out) => {
    out[0] = fbm(u, v, 4, 4, seed);
    out[1] = fbm(u, v, 3, 8, seed + 811);
    out[2] = ridged(u, v, 3, 6, seed + 1607);
    out[3] = 1;
  }, { wrap: THREE.RepeatWrapping, mips: true });
}

/**
 * Vertical streak noise for the loot beam. Sampled scrolling upward, this is
 * what makes a beam look like light moving through dust rather than a
 * coloured cylinder with a gradient on it.
 */
function makeBeamNoiseTexture(size: number, seed: number): THREE.DataTexture {
  return dataTexture(size, (u, v, out) => {
    // Stretched vertically so the filaments are tall and thin.
    const a = fbm(u * 3.0, v * 0.6, 4, 8, seed);
    const b = ridged(u * 5.0, v * 0.35, 3, 12, seed + 331);
    const c = fbm(u * 1.4, v * 0.25, 2, 4, seed + 907);
    out[0] = a;
    out[1] = b;
    out[2] = c;
    out[3] = 1;
  }, { wrap: THREE.RepeatWrapping, mips: true });
}

/** 24-row colour-over-life LUT baked from RAMPS. */
function makeRampTexture(): THREE.DataTexture {
  const w = 128;
  return dataTexture(w, (u, v, out) => {
    const row = Math.min(RAMP_ROWS - 1, Math.floor(v * RAMP_ROWS));
    const stops = RAMPS[row] ?? RAMPS[RAMP.smokeDark];
    let i = 0;
    while (i < stops.length - 2 && stops[i + 1][0] < u) i++;
    const a = stops[i];
    const b = stops[Math.min(i + 1, stops.length - 1)];
    const span = Math.max(1e-4, b[0] - a[0]);
    const t = Math.max(0, Math.min(1, (u - a[0]) / span));
    out[0] = a[1] + (b[1] - a[1]) * t;
    out[1] = a[2] + (b[2] - a[2]) * t;
    out[2] = a[3] + (b[3] - a[3]) * t;
    out[3] = a[4] + (b[4] - a[4]) * t;
  }, { height: RAMP_ROWS, srgb: true });
}

/**
 * Grit detail for debris: albedo in RGB, a roughness field in A.
 *
 * This is the texture that stops chunks reading as plastic. The roughness
 * channel deliberately has large low-frequency blotches on top of the fine
 * grain, so one face of a chunk can be dull and another slightly polished —
 * uniform roughness is the loudest tell in the whole list.
 */
function makeGritTexture(size: number, seed: number): THREE.DataTexture {
  return dataTexture(size, (u, v, out) => {
    const fine = fbm(u, v, 4, 12, seed);
    const coarse = fbm(u, v, 3, 3, seed + 77);
    const speck = hash2((u * size) | 0, (v * size) | 0, seed + 401);
    const albedo = 0.72 + fine * 0.36 + coarse * 0.2 + (speck > 0.985 ? 0.35 : 0);
    out[0] = albedo * 1.0;
    out[1] = albedo * 0.985;
    out[2] = albedo * 0.96;
    // 0.42..1.0: wet-dark polished patches through to chalky.
    out[3] = 0.42 + coarse * 0.42 + fine * 0.2;
  }, { wrap: THREE.RepeatWrapping, mips: true, srgb: true });
}

/** Tangent-space normal map derived from the same fbm height field. */
function makeNormalTexture(size: number, seed: number): THREE.DataTexture {
  const h = (u: number, v: number) =>
    fbm(u, v, 4, 10, seed) * 0.7 + ridged(u, v, 3, 5, seed + 55) * 0.3;
  const e = 1 / size;
  return dataTexture(size, (u, v, out) => {
    const dx = (h(u + e, v) - h(u - e, v)) / (2 * e);
    const dy = (h(u, v + e) - h(u, v - e)) / (2 * e);
    // Strength is modest: chunky stylised debris wants a suggestion of
    // surface, not a sandpaper macro shot.
    const nx = -dx * 0.045;
    const ny = -dy * 0.045;
    const nz = 1;
    const len = Math.hypot(nx, ny, nz);
    out[0] = (nx / len) * 0.5 + 0.5;
    out[1] = (ny / len) * 0.5 + 0.5;
    out[2] = (nz / len) * 0.5 + 0.5;
    out[3] = 1;
  }, { wrap: THREE.RepeatWrapping, mips: true });
}

/**
 * Decal atlas — one of two Canvas2D textures in the module. Cracks, splinters
 * and blood spatter are far cheaper to draw with a path API than to evaluate
 * per pixel, and the result has crisper detail than any amount of fbm.
 *
 * Falls back to a blank texture when 2D canvas is unavailable (headless test
 * runs), so boot never throws and the world simply ships without decals.
 */
function makeDecalAtlas(edge: number, rng: () => number, splat: boolean): THREE.Texture {
  const cell = edge / ATLAS_DIV;
  let g: CanvasRenderingContext2D | null = null;
  let canvas: HTMLCanvasElement | null = null;
  if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
    canvas.width = edge;
    canvas.height = edge;
    g = canvas.getContext("2d");
  }
  if (!g || !canvas) {
    return dataTexture(4, (_u, _v, out) => {
      out[0] = out[1] = out[2] = 1;
      out[3] = 0;
    });
  }

  g.clearRect(0, 0, edge, edge);
  const rr = (a: number, b: number) => a + (b - a) * rng();

  /** Run `draw` with the origin at the centre of cell `i`, unit radius = r. */
  const inCell = (i: number, draw: (c: CanvasRenderingContext2D, r: number) => void) => {
    const cx = (i % ATLAS_DIV) * cell;
    const cy = Math.floor(i / ATLAS_DIV) * cell;
    g!.save();
    g!.beginPath();
    g!.rect(cx + 1, cy + 1, cell - 2, cell - 2);
    g!.clip();
    g!.translate(cx + cell / 2, cy + cell / 2);
    draw(g!, cell * 0.5);
    g!.restore();
  };

  const softDisc = (
    c: CanvasRenderingContext2D, r: number, inner: string, outer: string, p = 0.35,
  ) => {
    const grad = c.createRadialGradient(0, 0, r * p * 0.1, 0, 0, r);
    grad.addColorStop(0, inner);
    grad.addColorStop(p, inner);
    grad.addColorStop(1, outer);
    c.fillStyle = grad;
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.fill();
  };

  /** Lumpy blob built from overlapping discs — reads as an organic edge. */
  const blob = (
    c: CanvasRenderingContext2D, r: number, n: number, spread: number, fill: string,
  ) => {
    c.fillStyle = fill;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const d = Math.pow(rng(), 0.6) * r * spread;
      c.beginPath();
      c.arc(Math.cos(a) * d, Math.sin(a) * d, r * rr(0.1, 0.34), 0, Math.PI * 2);
      c.fill();
    }
  };

  const cracks = (
    c: CanvasRenderingContext2D, r: number, n: number, len: number,
    style: string, width: number,
  ) => {
    c.strokeStyle = style;
    c.lineCap = "round";
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rr(-0.35, 0.35);
      let x = Math.cos(a) * r * 0.1;
      let y = Math.sin(a) * r * 0.1;
      let ang = a;
      c.lineWidth = width * rr(0.6, 1.4);
      c.beginPath();
      c.moveTo(x, y);
      const segs = 3 + ((rng() * 3) | 0);
      for (let s = 0; s < segs; s++) {
        ang += rr(-0.4, 0.4);
        const step = (r * len) / segs;
        x += Math.cos(ang) * step;
        y += Math.sin(ang) * step;
        c.lineTo(x, y);
      }
      c.stroke();
    }
  };

  /** Scattered specks — the ejecta ring that sells a fresh impact. */
  const specks = (
    c: CanvasRenderingContext2D, r: number, n: number, r0: number, r1: number,
    size: number, fill: string,
  ) => {
    c.fillStyle = fill;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const d = rr(r0, r1) * r;
      const s = r * size * rr(0.5, 1.5);
      c.fillRect(Math.cos(a) * d, Math.sin(a) * d, s, s);
    }
  };

  // --- Concrete bullet holes ------------------------------------------------
  for (const id of [DECAL.holeConcrete, DECAL.holeConcrete2]) {
    inCell(id, (c, r) => {
      // Dust bloom first, so the crater and cracks sit on top of it.
      softDisc(c, r * 0.9, "rgba(214,210,200,0.42)", "rgba(214,210,200,0)", 0.15);
      cracks(c, r, 7, 0.72, "rgba(46,44,42,0.5)", r * 0.035);
      softDisc(c, r * 0.3, "rgba(18,16,15,0.95)", "rgba(30,28,26,0)", 0.45);
      specks(c, r, 14, 0.3, 0.9, 0.05, "rgba(236,233,226,0.5)");
    });
  }

  inCell(DECAL.scuff, (c, r) => {
    softDisc(c, r * 0.9, "rgba(120,118,112,0.35)", "rgba(120,118,112,0)", 0.1);
    cracks(c, r, 5, 0.6, "rgba(70,68,64,0.28)", r * 0.03);
  });

  // --- Metal dings ----------------------------------------------------------
  for (const id of [DECAL.holeMetal, DECAL.holeMetal2]) {
    inCell(id, (c, r) => {
      softDisc(c, r * 0.85, "rgba(30,28,26,0.62)", "rgba(30,28,26,0)", 0.2);
      // Bright radial scoring: bare metal exposed where the paint tore away.
      c.strokeStyle = "rgba(255,246,226,0.75)";
      c.lineWidth = r * 0.045;
      c.lineCap = "round";
      for (let i = 0; i < 9; i++) {
        const a = rng() * Math.PI * 2;
        const d0 = rr(0.12, 0.3) * r;
        const d1 = rr(0.45, 0.92) * r;
        c.beginPath();
        c.moveTo(Math.cos(a) * d0, Math.sin(a) * d0);
        c.lineTo(Math.cos(a) * d1, Math.sin(a) * d1);
        c.stroke();
      }
      softDisc(c, r * 0.22, "rgba(12,11,10,0.96)", "rgba(12,11,10,0)", 0.55);
    });
  }

  // --- Wood -----------------------------------------------------------------
  inCell(DECAL.holeWood, (c, r) => {
    softDisc(c, r * 0.8, "rgba(46,30,16,0.55)", "rgba(46,30,16,0)", 0.22);
    c.fillStyle = "rgba(214,182,132,0.72)";
    for (let i = 0; i < 12; i++) {
      const a = rng() * Math.PI * 2;
      const len = rr(0.35, 0.95) * r;
      const w = r * rr(0.03, 0.08);
      c.save();
      c.rotate(a);
      c.beginPath();
      c.moveTo(r * 0.12, -w);
      c.lineTo(len, 0);
      c.lineTo(r * 0.12, w);
      c.closePath();
      c.fill();
      c.restore();
    }
    softDisc(c, r * 0.24, "rgba(16,10,5,0.95)", "rgba(16,10,5,0)", 0.5);
  });

  // --- Dirt / grass / sand --------------------------------------------------
  inCell(DECAL.holeDirt, (c, r) => {
    softDisc(c, r * 0.95, "rgba(52,38,24,0.66)", "rgba(52,38,24,0)", 0.28);
    blob(c, r, 16, 0.7, "rgba(38,27,16,0.5)");
    softDisc(c, r * 0.34, "rgba(24,17,10,0.85)", "rgba(24,17,10,0)", 0.4);
  });

  inCell(DECAL.grassScuff, (c, r) => {
    // Torn turf: dark soil showing through, ringed by kicked-up blades.
    softDisc(c, r * 0.7, "rgba(44,34,20,0.62)", "rgba(44,34,20,0)", 0.3);
    blob(c, r * 0.62, 10, 0.66, "rgba(34,26,15,0.45)");
    c.strokeStyle = "rgba(96,116,48,0.55)";
    c.lineCap = "round";
    for (let i = 0; i < 18; i++) {
      const a = rng() * Math.PI * 2;
      const d0 = rr(0.35, 0.6) * r;
      const d1 = d0 + rr(0.12, 0.34) * r;
      c.lineWidth = r * rr(0.015, 0.035);
      c.beginPath();
      c.moveTo(Math.cos(a) * d0, Math.sin(a) * d0);
      c.lineTo(Math.cos(a + rr(-0.3, 0.3)) * d1, Math.sin(a + rr(-0.3, 0.3)) * d1);
      c.stroke();
    }
  });

  inCell(DECAL.sandPit, (c, r) => {
    // A crater in sand is a rim, not a hole: bright ejecta ring, soft centre.
    softDisc(c, r * 0.95, "rgba(226,208,168,0.5)", "rgba(226,208,168,0)", 0.55);
    softDisc(c, r * 0.52, "rgba(150,130,96,0.5)", "rgba(170,150,116,0)", 0.35);
    specks(c, r, 26, 0.5, 1.0, 0.045, "rgba(240,226,192,0.55)");
  });

  // --- Glass ----------------------------------------------------------------
  for (const id of [DECAL.glassWeb, DECAL.crackWeb]) {
    inCell(id, (c, r) => {
      cracks(c, r, 11, 0.92, "rgba(255,255,255,0.72)", r * 0.02);
      // Concentric fracture arcs — glass never cracks purely radially.
      c.strokeStyle = "rgba(230,244,255,0.35)";
      for (let k = 1; k <= 3; k++) {
        c.lineWidth = r * 0.014;
        c.beginPath();
        c.arc(0, 0, r * (0.2 + k * 0.22), rr(0, 1), rr(3.4, 6.0));
        c.stroke();
      }
      softDisc(c, r * 0.18, "rgba(255,255,255,0.8)", "rgba(255,255,255,0)", 0.3);
    });
  }

  // --- Blood, or in SOAKED, water splats -------------------------------------
  //
  // Nothing bleeds in SOAKED, so these two cells are dead weight there — and a
  // wet patch has nowhere else to live, because every other cell in the atlas
  // carries either radial cracks or a hard dark core and both of those read as
  // damage rather than as damp. Rather than grow the atlas past 4x4 (which the
  // shader's uCellScale and every cell index in this file assume), the two
  // blood cells become splash splats in water mode. Same sixteen cells, same
  // one texture bind, same one draw call.
  for (const id of [DECAL.blood, DECAL.blood2]) {
    inCell(id, splat
      ? (c, r) => {
          // Neutral and light: the tint at the call site does the colouring,
          // and anything dark baked in here becomes a stain no tint can lift.
          softDisc(c, r * 0.92, "rgba(196,206,212,0.5)", "rgba(196,206,212,0)", 0.2);
          blob(c, r * 0.66, 13, 0.85, "rgba(210,220,226,0.3)");
          // Satellite droplets thrown clear of the main patch. This is the
          // detail that makes a splat read as something that ARRIVED wet.
          c.fillStyle = "rgba(200,212,218,0.4)";
          for (let i = 0; i < 26; i++) {
            const a = rng() * Math.PI * 2;
            const d = rr(0.5, 1.0) * r;
            c.beginPath();
            c.arc(Math.cos(a) * d, Math.sin(a) * d, r * rr(0.012, 0.055), 0, Math.PI * 2);
            c.fill();
          }
          // Two or three runs. On a wall they read as water tracking down; on
          // the floor they just read as an irregular edge, which is fine.
          c.strokeStyle = "rgba(200,212,218,0.34)";
          c.lineCap = "round";
          for (let i = 0; i < 3; i++) {
            const a = rr(1.2, 1.94);
            c.lineWidth = r * rr(0.04, 0.09);
            c.beginPath();
            c.moveTo(Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3);
            c.lineTo(Math.cos(a) * r * rr(0.7, 1.0), Math.sin(a) * r * rr(0.7, 1.0));
            c.stroke();
          }
        }
      : (c, r) => {
          blob(c, r * 0.8, 14, 0.55, "rgba(96,6,6,0.82)");
          blob(c, r * 0.55, 10, 0.5, "rgba(140,10,8,0.6)");
          c.fillStyle = "rgba(110,7,6,0.7)";
          for (let i = 0; i < 22; i++) {
            const a = rng() * Math.PI * 2;
            const d = rr(0.45, 1.0) * r;
            c.beginPath();
            c.arc(Math.cos(a) * d, Math.sin(a) * d, r * rr(0.015, 0.06), 0, Math.PI * 2);
            c.fill();
          }
        });
  }

  // --- Scorch ---------------------------------------------------------------
  for (const id of [DECAL.scorch, DECAL.scorchSmall, DECAL.soot]) {
    const small = id !== DECAL.scorch;
    inCell(id, (c, r) => {
      softDisc(c, r * (small ? 0.72 : 0.96), "rgba(10,9,8,0.9)", "rgba(14,12,10,0)",
        small ? 0.2 : 0.34);
      blob(c, r * (small ? 0.7 : 0.95), 20, 0.72, "rgba(9,8,7,0.32)");
      // Warm inner rim — soot is never neutral black up close, and the warm
      // ring is the detail that makes a scorch read as heat damage.
      c.strokeStyle = "rgba(70,40,20,0.28)";
      c.lineWidth = r * 0.09;
      c.beginPath();
      c.arc(0, 0, r * (small ? 0.42 : 0.58), 0, Math.PI * 2);
      c.stroke();
      cracks(c, r, 10, 0.95, "rgba(10,9,8,0.35)", r * 0.05);
    });
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Numeral atlas — 4×4 cells, digits 0-9 plus a few symbols.
 *
 * Channel layout, and the reason there is one:
 *   R = fill mask, with a vertical gradient baked in (bright top, ~0.72 base)
 *   G = outline mask
 *   A = combined coverage
 *
 * That split is what lets a single texture serve white, blue and gold numbers
 * without the tint bleeding into the outline. Tint the R channel, keep the G
 * channel near-black, composite fill over outline in the shader. A number
 * whose outline turns gold with it is a number you cannot read against a
 * sunlit wall.
 */
function makeNumeralAtlas(edge: number): { texture: THREE.Texture; advance: number } {
  const div = 4;
  const cell = edge / div;
  let g: CanvasRenderingContext2D | null = null;
  let canvas: HTMLCanvasElement | null = null;
  if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
    canvas.width = edge;
    canvas.height = edge;
    g = canvas.getContext("2d");
  }
  if (!g || !canvas) {
    return {
      texture: dataTexture(4, (_u, _v, out) => {
        out[0] = out[1] = out[2] = 0;
        out[3] = 0;
      }),
      advance: 0.62,
    };
  }

  g.clearRect(0, 0, edge, edge);
  const glyphs = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "-", "!", "%", "", ""];
  const px = cell * 0.74;
  // Arial Black / Impact fall back sanely everywhere and both are heavy enough
  // that the baked outline never eats the counter of an 8 or a 0.
  g.font = `900 ${px}px "Arial Black", "Helvetica Neue", Impact, Haettenschweiler, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineJoin = "round";
  g.miterLimit = 2;

  for (let i = 0; i < glyphs.length; i++) {
    const ch = glyphs[i];
    if (!ch) continue;
    const cx = (i % div) * cell + cell / 2;
    const cy = Math.floor(i / div) * cell + cell / 2;
    g.save();
    g.translate(cx, cy);
    // Slight condense: damage numbers are read as a group, and tight tracking
    // makes a three-digit number read as one token rather than three glyphs.
    g.scale(0.92, 1.0);

    // Outline into the green channel. Two passes, wide then narrow, so the
    // silhouette stays smooth where a single heavy stroke would spike.
    g.strokeStyle = "rgb(0,255,0)";
    g.lineWidth = px * 0.26;
    g.strokeText(ch, 0, 0);
    g.lineWidth = px * 0.15;
    g.strokeText(ch, 0, 0);

    // Fill into the red channel, with a vertical gradient. The gradient is the
    // small-scale detail that keeps a flat glyph from looking like a sticker.
    const grad = g.createLinearGradient(0, -px * 0.55, 0, px * 0.55);
    grad.addColorStop(0, "rgb(255,0,0)");
    grad.addColorStop(0.55, "rgb(236,0,0)");
    grad.addColorStop(1, "rgb(184,0,0)");
    g.fillStyle = grad;
    g.fillText(ch, 0, 0);
    g.restore();
  }

  // Cell 14: a droplet, drawn as a path rather than a glyph because no font we
  // can rely on has one. Same channel convention as the digits — outline into
  // green, gradient fill into red — so the number shader treats it identically.
  // Path2D is everywhere a WebGL context is, but a headless 2D shim that
  // lacks it must cost us one glyph, not the entire effects layer.
  if (typeof Path2D !== "undefined") {
    const cx = (NUMERAL_DROPLET % div) * cell + cell / 2;
    const cy = Math.floor(NUMERAL_DROPLET / div) * cell + cell / 2;
    const r = px * 0.3;
    g.save();
    g.translate(cx, cy);
    const path = new Path2D();
    path.moveTo(0, -r * 1.4);
    path.bezierCurveTo(r * 0.98, -r * 0.22, r * 1.02, r * 0.6, 0, r * 1.1);
    path.bezierCurveTo(-r * 1.02, r * 0.6, -r * 0.98, -r * 0.22, 0, -r * 1.4);
    path.closePath();
    g.strokeStyle = "rgb(0,255,0)";
    g.lineWidth = px * 0.26;
    g.stroke(path);
    g.lineWidth = px * 0.15;
    g.stroke(path);
    const dgrad = g.createLinearGradient(0, -r * 1.4, 0, r * 1.1);
    dgrad.addColorStop(0, "rgb(255,0,0)");
    dgrad.addColorStop(0.6, "rgb(232,0,0)");
    dgrad.addColorStop(1, "rgb(178,0,0)");
    g.fillStyle = dgrad;
    g.fill(path);
    g.restore();
  }

  const tex = new THREE.CanvasTexture(canvas);
  // Linear, NOT sRGB: these are masks, not colour. Decoding them as sRGB
  // would crush the outline mask and the numbers would lose their edge.
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  // Glyph advance as a fraction of the cell: tuned so "100" kerns tight
  // without the zeros touching.
  return { texture: tex, advance: 0.58 };
}

// ---------------------------------------------------------------------------
// Shared shader fragments
// ---------------------------------------------------------------------------

/**
 * Aerial perspective. Mirrors whatever fog the sky system installed on the
 * scene, because a particle that ignores the haze is the fastest way to make
 * a 3 km island look like a 30 m diorama.
 */
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

/** Rotates a quaternion onto a vector — used by every surface-aligned layer. */
const QUAT_ROTATE = /* glsl */ `
vec3 qrot(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}
`;

const SOFT_PARS = /* glsl */ `
#ifdef SOFT
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform vec2 uCamRange;
uniform float uSoftness;
#endif
`;

/**
 * Depth-buffer fade. Compiled in only once postfx hands us a depth texture;
 * without it particles simply intersect geometry hard, which is correct but
 * unforgiving where a dust cloud meets the ground.
 */
const SOFT_APPLY = /* glsl */ `
#ifdef SOFT
{
  vec2 suv = gl_FragCoord.xy / uResolution;
  float rawDepth = texture2D(uDepth, suv).x;
  float sceneDist = -perspectiveDepthToViewZ(rawDepth, uCamRange.x, uCamRange.y);
  a *= clamp((sceneDist - vViewZ) / uSoftness, 0.0, 1.0);
}
#endif
`;

// ---------------------------------------------------------------------------
// Billboard particle layer
//
// Deliberately NOT gl.POINTS. Point sprites clip on their centre, so a 30 m
// fireball puff vanishes the instant its origin leaves the frustum, and every
// driver caps gl_PointSize somewhere around 1024 px — which a close-range
// explosion blows straight past. Instanced quads cost three extra vertices per
// particle and remove both problems.
//
// The whole trajectory is a closed-form function of age: exponential drag has
// an analytic integral, so position, size, roll, colour and alpha all fall out
// of `uTime - spawnTime` with no CPU integration anywhere.
// ---------------------------------------------------------------------------

const BILLBOARD_VERT = /* glsl */ `
uniform float uTime;
uniform vec3  uWind;

attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iLife;    // spawn, lifetime, seed, drag
attribute vec4 iStyle;   // size0, size1, rampRow, brightness
attribute vec4 iMotion;  // buoyancy (m/s^2), spin (rad/s), atlas cell u, v
attribute vec3 iColor;

varying vec2  vUv;
varying vec2  vLocal;
varying vec2  vRoll;
varying float vT;
varying float vRow;
varying float vBright;
varying float vViewZ;
varying vec3  vColor;

void main() {
  float age = uTime - iLife.x;
  float t = age / max(iLife.y, 0.0001);
  float dead = step(1.0, t) + step(age, -0.00001);

  // Exponential drag, integrated analytically: p = p0 + v0 * (1 - e^-kt) / k.
  float k = iLife.w;
  float damp = k > 0.001 ? (1.0 - exp(-k * age)) / k : age;
  vec3 p = iPos + iVel * damp;
  p.y += 0.5 * iMotion.x * age * age;
  // Wind only pushes what drag has already slowed — a spark travelling at
  // 30 m/s does not care about a 0.3 m/s breeze, but the smoke it leaves does.
  p += uWind * (0.5 * age * age) * clamp(k * 0.5, 0.0, 1.2);

  vec4 mv = viewMatrix * vec4(p, 1.0);

  // Face the camera by expanding in view space; roll the quad, not the uvs,
  // so the fragment stage never pays for a sin/cos or a uv clamp.
  float size = mix(iStyle.x, iStyle.y, clamp(t, 0.0, 1.0));
  float rot = iLife.z * 6.28318 + iMotion.y * age;
  float cr = cos(rot);
  float sr = sin(rot);
  mv.xy += vec2(position.x * cr - position.y * sr,
                position.x * sr + position.y * cr) * size;

  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
  // Park dead instances outside the clip volume: cheaper than a branch in the
  // fragment shader and it costs zero fill.
  if (dead > 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

  vUv = uv * 0.25 + iMotion.zw;
  vLocal = uv;
  vRoll = vec2(cr, sr);
  vT = clamp(t, 0.0, 1.0);
  vRow = iStyle.z;
  vBright = iStyle.w;
  vColor = iColor;
}
`;

/**
 * The alpha layer's LIT path is the single most important shader in this file.
 *
 * A smoke billboard is treated as a sphere impostor: reconstruct a normal from
 * the sprite's own uv, rotate it into view space by the particle's roll, and
 * shade it against the sun. That gives every puff a lit side, a shadow side
 * and — when the sun is behind it — a hot rim around the silhouette. Without
 * it, smoke is a flat grey circle no matter how good the texture is, and flat
 * ambient shading with no directional key is one of the loudest tells that a
 * scene was not lit by an artist.
 */
const BILLBOARD_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uRamp;
uniform vec3 uTint;
#ifdef LIT
uniform vec3 uSunView;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
#endif

varying vec2  vUv;
varying vec2  vLocal;
varying vec2  vRoll;
varying float vT;
varying float vRow;
varying float vBright;
varying float vViewZ;
varying vec3  vColor;

#include <packing>
${FOG_PARS}
${SOFT_PARS}

void main() {
  vec4 tex = texture2D(uMap, vUv);
  vec4 ramp = texture2D(uRamp, vec2(vT, vRow));
  float a = tex.a * ramp.a;
  if (a < 0.004) discard;

  vec3 col = ramp.rgb * uTint * vColor * vBright;

  #ifdef LIT
  {
    // Sprite-local direction, un-rolled back into view space.
    vec2 c = (vLocal - 0.5) * 2.0;
    vec2 cr = vec2(c.x * vRoll.x - c.y * vRoll.y, c.x * vRoll.y + c.y * vRoll.x);
    float r2 = min(dot(cr, cr), 0.98);
    vec3 nrm = vec3(cr, sqrt(1.0 - r2));
    float ndl = dot(normalize(nrm), uSunView);
    // Wide wrap: real smoke scatters, so the terminator is soft and the
    // shadow side is filled by the sky rather than going black.
    float wrap = smoothstep(-0.6, 0.95, ndl);
    vec3 lit = mix(uSkyColor, uSunColor, wrap);
    col *= lit;
    // Back-lit rim: sun behind the puff blows out its edge. This is the term
    // that makes a plume read as volume instead of a decal.
    float rim = smoothstep(0.25, 1.0, -ndl) * smoothstep(0.45, 1.0, sqrt(r2));
    col += uSunColor * rim * 0.55;
  }
  #endif

  ${SOFT_APPLY}

  float f = fogFactor(vViewZ);
  #ifdef ADDITIVE
    col *= (1.0 - f);
  #else
    col = mix(col, uFogColor, f);
  #endif

  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Velocity-aligned streaks (sparks, tracers, droplets)
// ---------------------------------------------------------------------------

const STREAK_VERT = /* glsl */ `
uniform float uTime;

attribute vec3 iPos;
attribute vec3 iVel;
attribute vec3 iAcc;
attribute vec4 iLife;   // spawn, lifetime, width, length
attribute vec2 iStyle;  // rampRow, brightness
attribute vec3 iColor;

varying vec2  vUv;
varying float vT;
varying float vRow;
varying float vBright;
varying float vViewZ;
varying vec3  vColor;

void main() {
  float age = uTime - iLife.x;
  float t = age / max(iLife.y, 0.0001);
  float dead = step(1.0, t) + step(age, -0.00001);

  vec3 head = iPos + iVel * age + 0.5 * iAcc * age * age;
  vec3 vel = iVel + iAcc * age;
  float sp = length(vel);
  vec3 dir = sp > 0.0001 ? vel / sp : vec3(0.0, 1.0, 0.0);
  // Faster sparks stretch longer — the classic trail-length speed cue, and
  // the reason a bouncing spark visibly slows down as it dies.
  float len = iLife.w * clamp(sp / 26.0, 0.22, 1.0);
  vec3 tail = head - dir * len;

  vec4 hv = viewMatrix * vec4(head, 1.0);
  vec4 tv = viewMatrix * vec4(tail, 1.0);
  vec3 c = mix(tv.xyz, hv.xyz, position.x);

  vec2 d = hv.xy - tv.xy;
  vec2 ax = length(d) > 0.00001 ? normalize(d) : vec2(1.0, 0.0);
  c.xy += vec2(-ax.y, ax.x) * position.y * iLife.z;

  vViewZ = -c.z;
  gl_Position = projectionMatrix * vec4(c, 1.0);
  if (dead > 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

  vUv = vec2(position.x, position.y + 0.5);
  vT = clamp(t, 0.0, 1.0);
  vRow = iStyle.x;
  vBright = iStyle.y;
  vColor = iColor;
}
`;

const STREAK_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uRamp;

varying vec2  vUv;
varying float vT;
varying float vRow;
varying float vBright;
varying float vViewZ;
varying vec3  vColor;

${FOG_PARS}

void main() {
  vec4 tex = texture2D(uMap, vUv);
  vec4 ramp = texture2D(uRamp, vec2(vT, vRow));
  float a = tex.a * ramp.a;
  if (a < 0.004) discard;
  vec3 col = ramp.rgb * vColor * vBright * (1.0 - fogFactor(vViewZ));
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Surface-hugging expanding rings (shockwave, dust wall, ripple, metal ping)
// ---------------------------------------------------------------------------

const RING_VERT = /* glsl */ `
uniform float uTime;

attribute vec3 iPos;
attribute vec4 iQuat;
attribute vec4 iLife;   // spawn, lifetime, r0, r1
attribute vec4 iStyle;  // rampRow, brightness, innerRadius, spin
attribute vec3 iColor;

varying vec2  vUv;
varying float vT;
varying float vRow;
varying float vBright;
varying float vInner;
varying float vViewZ;
varying vec2  vNoiseUv;
varying vec3  vColor;

${QUAT_ROTATE}

void main() {
  float age = uTime - iLife.x;
  float t = age / max(iLife.y, 0.0001);
  float dead = step(1.0, t) + step(age, -0.00001);

  // Ease-out expansion: violent in the first frames, then coasting. A ring
  // that expands linearly reads as an animation; this reads as a pressure wave.
  float e = 1.0 - pow(1.0 - clamp(t, 0.0, 1.0), 2.6);
  float r = mix(iLife.z, iLife.w, e);

  vec3 local = vec3(position.xy * 2.0 * r, 0.0);
  vec3 world = iPos + qrot(iQuat, local);
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
  if (dead > 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

  vUv = uv;
  vT = clamp(t, 0.0, 1.0);
  vRow = iStyle.x;
  vBright = iStyle.y;
  vInner = iStyle.z;
  vColor = iColor;
  // Scroll the breakup noise outward with the ring so the filaments travel
  // with the wave instead of sitting still inside it.
  vNoiseUv = uv * 2.4 + fract(vec2(iLife.x * 0.37, iLife.x * 0.19))
           + vec2(0.0, -e * iStyle.w);
}
`;

const RING_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform sampler2D uRamp;
uniform vec3 uTint;

varying vec2  vUv;
varying float vT;
varying float vRow;
varying float vBright;
varying float vInner;
varying float vViewZ;
varying vec2  vNoiseUv;
varying vec3  vColor;

${FOG_PARS}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  // Analytic annulus: soft ramp in, hard-ish outer edge.
  float a = smoothstep(vInner - 0.3, vInner + 0.04, r) * (1.0 - smoothstep(0.82, 1.0, r));
  vec3 n = texture2D(uNoise, vNoiseUv).rgb;
  // Two octaves of breakup: the low one makes lobes, the ridged one makes
  // the torn filaments at the leading edge.
  a *= 0.4 + n.r * 0.9 + n.b * 0.35;

  vec4 ramp = texture2D(uRamp, vec2(vT, vRow));
  a *= ramp.a;
  if (a < 0.004) discard;

  vec3 col = ramp.rgb * vColor * vBright;
  float f = fogFactor(vViewZ);
  #ifdef ADDITIVE
    col *= (1.0 - f);
  #else
    col *= uTint;
    col = mix(col, uFogColor, f);
  #endif
  gl_FragColor = vec4(col, min(a, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Decals
// ---------------------------------------------------------------------------

const DECAL_VERT = /* glsl */ `
uniform float uTime;
uniform float uCellScale;

attribute vec3 dPos;
attribute vec4 dQuat;
attribute vec4 dLife;   // spawn, lifetime, size, alphaMul
attribute vec2 dCell;
attribute vec3 dTint;

varying vec2  vUv;
varying float vFade;
varying vec3  vTint;
varying float vViewZ;

${QUAT_ROTATE}

void main() {
  float age = uTime - dLife.x;
  float t = age / max(dLife.y, 0.0001);
  float dead = step(1.0, t) + step(age, -0.00001);

  // A decal pops to full size in the first 40 ms. Growing it over a longer
  // window looks like a projector warming up rather than a bullet landing.
  float grow = clamp(age / 0.04, 0.0, 1.0);
  float size = dLife.z * (0.55 + 0.45 * grow);

  vec3 world = dPos + qrot(dQuat, vec3(position.xy * size, 0.0));
  vec4 mv = viewMatrix * vec4(world, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
  if (dead > 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

  vUv = uv * uCellScale + dCell;
  vFade = dLife.w * grow * (1.0 - smoothstep(0.72, 1.0, t));
  vTint = dTint;
}
`;

const DECAL_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uTint;

varying vec2  vUv;
varying float vFade;
varying vec3  vTint;
varying float vViewZ;

${FOG_PARS}

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vFade;
  if (a < 0.006) discard;
  vec3 col = tex.rgb * vTint * uTint;
  col = mix(col, uFogColor, fogFactor(vViewZ));
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Damage numbers
//
// One instanced quad per glyph. The whole number's motion is derived from the
// shared spawn time on every glyph of it, so the digits move as one token.
// ---------------------------------------------------------------------------

const NUMBER_VERT = /* glsl */ `
uniform float uTime;
uniform float uCellScale;
uniform float uAdvance;

attribute vec3 nPos;
attribute vec3 nVel;
attribute vec4 nLife;   // spawn, lifetime, size, gravity
attribute vec4 nStyle;  // cellU, cellV, glyphOffset (advances), brightness
attribute vec3 nColor;

varying vec2  vUv;
varying float vAlpha;
varying float vBright;
varying vec3  vColor;

void main() {
  float age = uTime - nLife.x;
  float t = age / max(nLife.y, 0.0001);
  float dead = step(1.0, t) + step(age, -0.00001);

  // Rise on an arc. Gravity is gentle and the initial rise is fast: the
  // number should be at the top of its travel by the time the player's eye
  // has found it, then hang there while it fades.
  vec3 p = nPos + nVel * age + vec3(0.0, 0.5 * nLife.w * age * age, 0.0);

  vec4 mv = viewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 0.001);

  // Scale pop: overshoot to 1.35x in ~60 ms, settle by ~180 ms. This is the
  // whole reason a damage number feels like an impact and not a subtitle.
  float pop = 1.0 + 0.36 * exp(-age * 26.0) * cos(age * 44.0)
                  + 0.5 * exp(-age * 34.0);
  // Distance compensation with a floor: a hit at 120 m must still be legible,
  // but a hit at 3 m must not fill the screen.
  float comp = clamp(dist / 14.0, 1.0, 3.4);
  float size = nLife.z * pop * comp;

  vec2 corner = position.xy;
  corner.x += nStyle.z * uAdvance;
  mv.xy += corner * size;

  gl_Position = projectionMatrix * mv;
  if (dead > 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

  vUv = uv * uCellScale + nStyle.xy;
  // Hold at full alpha for the first two thirds, then leave cleanly.
  vAlpha = smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.62, 1.0, t));
  vBright = nStyle.w;
  vColor = nColor;
}
`;

const NUMBER_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uOutline;

varying vec2  vUv;
varying float vAlpha;
varying float vBright;
varying vec3  vColor;

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vAlpha;
  if (a < 0.01) discard;
  // Fill over outline. R carries the fill mask with its baked gradient, G the
  // outline mask; compositing here rather than baking the colour is what lets
  // one atlas serve white, shield-blue and headshot-gold numbers.
  float fill = tex.r;
  vec3 col = mix(uOutline, vColor * vBright, clamp(fill * 1.35, 0.0, 1.0));
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// SOAKED — glue strand
//
// The one effect in this file that is not a particle. A strand connects two
// things that are both moving, so its shape has to be rebuilt every frame on
// the CPU — which is fine, because it is 34 vertices.
//
// The ribbon is expanded toward the camera on the CPU and handed to the GPU in
// world space, so one material serves every live strand and the "how bright is
// this bit right now" signal rides in as a per-vertex attribute rather than a
// per-strand uniform. That is what keeps a snapping strand, a taut strand and
// a slack strand in the same draw call.
// ---------------------------------------------------------------------------

const GLUE_VERT = /* glsl */ `
attribute float aGlow;

varying vec2  vUv;
varying float vGlow;
varying float vViewZ;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
  vUv = uv;
  vGlow = aGlow;
}
`;

/**
 * Three things make a flat ribbon read as a round, wet cord:
 *  1. a `sqrt(1 - x²)` cross-section term brightening the middle, which is
 *     exactly the shading a cylinder gives you,
 *  2. an off-centre specular band, so the highlight is a wet stripe rather
 *     than a symmetrical glow, and
 *  3. beads of glisten travelling along it, which is the detail that says
 *     "this is sticky and under tension" without any physics behind it.
 */
const GLUE_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3  uColor;
uniform vec3  uGlowColor;

varying vec2  vUv;
varying float vGlow;
varying float vViewZ;

${FOG_PARS}

void main() {
  float x = vUv.y * 2.0 - 1.0;
  float r = abs(x);
  float a = smoothstep(1.0, 0.68, r) * vGlow;
  if (a < 0.012) discard;

  float round_ = sqrt(max(0.0, 1.0 - r * r));
  float spec = pow(max(0.0, 1.0 - abs(x + 0.42) * 2.4), 3.0);
  float beads = 0.5 + 0.5 * sin(vUv.x * 38.0 - uTime * 3.1);

  // The body colour has to dominate: at the glow weights this started at, the
  // specular and the beads summed past the albedo and the cord rendered as a
  // pale hair instead of a fat, sticky, chartreuse rope.
  vec3 col = uColor * (0.3 + 0.85 * round_);
  // Occlude the lower edge. A cord lit from above with no darker underside
  // reads as a flat painted stripe no matter how good the highlight is.
  col *= mix(0.62, 1.0, smoothstep(-1.0, 0.35, x));
  col += uGlowColor * (spec * 0.45 + beads * 0.1 * round_);
  col = mix(col, uFogColor, fogFactor(vViewZ));
  gl_FragColor = vec4(col, min(1.0, a));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Loot beam
//
// A vertical additive cone. Four things keep it from looking like a coloured
// cylinder: the fbm scrolls upward at two different rates so the interior has
// motion, the silhouette edges are brightened by a view-space rim term so it
// reads as a volume, the base is hotter than the top, and the phase is derived
// from the object's own world position so a row of chests does not pulse in
// lockstep.
// ---------------------------------------------------------------------------

const BEAM_VERT = /* glsl */ `
varying vec2  vUv;
varying vec3  vNormalView;
varying vec3  vViewDir;
varying float vViewZ;
varying float vPhase;

void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewZ = -mv.z;
  vNormalView = normalize(normalMatrix * normal);
  vViewDir = normalize(-mv.xyz);
  vPhase = fract(dot(modelMatrix[3].xz, vec2(0.137, 0.271)));
  gl_Position = projectionMatrix * mv;
}
`;

const BEAM_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform vec3  uColor;
uniform float uTime;
uniform float uIntensity;

varying vec2  vUv;
varying vec3  vNormalView;
varying vec3  vViewDir;
varying float vViewZ;
varying float vPhase;

${FOG_PARS}

void main() {
  float ph = vPhase * 7.0;
  // Two scroll rates: the fast layer is the dust moving, the slow one is the
  // column itself breathing. Together they never visibly repeat.
  vec3 n1 = texture2D(uNoise, vec2(vUv.x * 1.0 + ph, vUv.y * 0.5 - uTime * 0.34)).rgb;
  vec3 n2 = texture2D(uNoise, vec2(vUv.x * 1.7 - ph, vUv.y * 0.8 - uTime * 0.13)).rgb;
  float streak = n1.g * 0.75 + n2.r * 0.55;

  // Vertical shape: hot at the base, gone by the top.
  float up = clamp(vUv.y, 0.0, 1.0);
  float fall = pow(1.0 - up, 1.7);
  float base = exp(-up * 9.0) * 0.85;

  // Rim: on a cylinder the silhouette is where you look through the most
  // volume, so it must be the brightest part.
  float rim = 1.0 - abs(dot(normalize(vNormalView), normalize(vViewDir)));
  rim = pow(clamp(rim, 0.0, 1.0), 1.6);

  float a = (fall * (0.32 + streak * 0.85) + base) * (0.45 + rim * 1.15);
  // Slow pulse so an idle beam is never completely static.
  a *= 0.85 + 0.15 * sin(uTime * 2.1 + vPhase * 6.283);
  a *= uIntensity;
  if (a < 0.004) discard;

  vec3 col = uColor * (0.75 + streak * 0.8 + base * 1.2);
  col *= (1.0 - fogFactor(vViewZ));
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Ground glow under a loot beam — pins the column to a spot on the floor. */
const BEAM_GLOW_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform vec3  uColor;
uniform float uTime;
uniform float uIntensity;

varying vec2  vUv;
varying float vViewZ;
varying float vPhase;

${FOG_PARS}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float ang = atan(p.y, p.x);
  // Rotating breakup so the pool of light shimmers rather than sitting there.
  vec3 n = texture2D(uNoise, vec2(ang * 0.159 + uTime * 0.05 + vPhase, r * 0.8)).rgb;
  float core = pow(1.0 - r, 2.6);
  float ring = exp(-pow((r - 0.62) / 0.2, 2.0) * 2.0) * 0.55;
  float a = (core * 1.15 + ring * (0.5 + n.r * 0.9)) * uIntensity;
  if (a < 0.004) discard;
  vec3 col = uColor * (0.8 + n.b * 0.7 + core * 0.9);
  col *= (1.0 - fogFactor(vViewZ));
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const BEAM_GLOW_VERT = /* glsl */ `
varying vec2  vUv;
varying float vViewZ;
varying float vPhase;

void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewZ = -mv.z;
  vPhase = fract(dot(modelMatrix[3].xz, vec2(0.137, 0.271)));
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * Rising motes around a loot beam. Entirely vertex-shader driven from a
 * per-instance seed — no CPU state, no per-beam buffers, and the whole set of
 * motes for a beam is one draw call that costs nothing to keep alive.
 */
const MOTE_VERT = /* glsl */ `
uniform float uTime;
uniform float uHeight;
uniform float uRadius;

attribute float iSeed;

varying float vAlpha;
varying vec2  vUv;
varying float vViewZ;

void main() {
  float phase = fract(dot(modelMatrix[3].xz, vec2(0.137, 0.271)));
  float s = fract(iSeed + phase);
  float speed = 0.16 + 0.22 * fract(iSeed * 7.13);
  float t = fract(s + uTime * speed);
  // Spiral up, tightening as it rises — convection, not a lift shaft.
  float ang = iSeed * 19.7 + phase * 6.283 + t * 2.4 * (0.5 + fract(iSeed * 3.31));
  float rad = uRadius * (0.3 + 0.7 * fract(iSeed * 11.7)) * (1.0 - 0.45 * t);
  vec3 local = vec3(cos(ang) * rad, t * uHeight, sin(ang) * rad);

  vec4 mv = modelViewMatrix * vec4(local, 1.0);
  float size = uRadius * (0.09 + 0.1 * fract(iSeed * 5.51));
  mv.xy += position.xy * size;
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;

  vUv = uv;
  // Fade in off the floor and out before the top, so nothing pops.
  vAlpha = smoothstep(0.0, 0.14, t) * (1.0 - smoothstep(0.55, 1.0, t));
}
`;

const MOTE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;

varying float vAlpha;
varying vec2  vUv;
varying float vViewZ;

${FOG_PARS}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float a = pow(1.0 - r2, 2.2) * vAlpha * uIntensity;
  if (a < 0.004) discard;
  vec3 col = uColor * (1.0 + (1.0 - r2) * 1.4);
  col *= (1.0 - fogFactor(vViewZ));
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Full-screen flash
//
// Written straight to clip space, so it needs no camera and survives whatever
// the postfx system does with the render path. Two instances exist: a normal
// blended one for the damage vignette (red, edges-in, directional) and an
// additive one for pickups and eliminations.
// ---------------------------------------------------------------------------

const FLASH_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
}
`;

const FLASH_FRAG = /* glsl */ `
uniform vec3  uColor;
uniform float uStrength;
uniform float uVignette;
uniform vec2  uDir;
uniform float uAspect;

varying vec2 vUv;

void main() {
  vec2 p = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0);
  float r = length(p) / max(uAspect, 1.0);
  // Edges-in falloff: the centre of the screen is where the player is
  // aiming and must never be washed out by feedback.
  float v = mix(1.0, smoothstep(0.12, 1.05, r), uVignette);
  // Directional bias so a hit from the left brightens the left edge — the
  // player reads the direction before they read the HUD wedge.
  float bias = 1.0;
  if (dot(uDir, uDir) > 0.0001) {
    bias += 1.1 * max(0.0, dot(normalize(p + vec2(1e-5)), normalize(uDir)));
  }
  float a = uStrength * v * bias;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, min(a, 0.94));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Pool plumbing
// ---------------------------------------------------------------------------

/**
 * Fixed-capacity ring allocator with a dirty span.
 *
 * The oldest slot is silently recycled when the buffer wraps, which means that
 * under a heavy firefight the newest effects always win. That is exactly the
 * behaviour you want when the budget is exhausted: the shot you just fired
 * matters more than the smoke from four seconds ago.
 */
class Ring {
  private cursor = 0;
  lo = Infinity;
  hi = -1;

  constructor(readonly cap: number) {}

  next(): number {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.cap;
    if (i < this.lo) this.lo = i;
    if (i > this.hi) this.hi = i;
    return i;
  }

  /** Uploads only the slots written since the last flush. */
  flush(attrs: THREE.BufferAttribute[]): void {
    if (this.hi < 0) return;
    const count = this.hi - this.lo + 1;
    for (const a of attrs) {
      a.addUpdateRange(this.lo * a.itemSize, count * a.itemSize);
      a.needsUpdate = true;
    }
    this.lo = Infinity;
    this.hi = -1;
  }
}

/** Four verts / six indices in XY. `x0..x1` lets streaks anchor at their tail. */
function quadArrays(x0: number, x1: number) {
  return {
    position: new Float32Array([x0, -0.5, 0, x1, -0.5, 0, x1, 0.5, 0, x0, 0.5, 0]),
    uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    index: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}

/**
 * A chamfered unit box: six inset faces, twelve edge strips, eight corner
 * triangles. 44 triangles.
 *
 * Why not BoxGeometry: a cube has no bevel, and a bevel is not decoration —
 * it is the only thing that puts a specular highlight along an edge. A cube
 * lit by a single sun shows three flat tones and reads as untextured
 * cardboard; the same shape with a 12 % chamfer shows three tones plus a hot
 * line down every edge and immediately reads as a solid object with weight.
 *
 * Non-indexed with flat normals, because debris is flat-shaded anyway and
 * duplicating 132 verts is cheaper than the smoothing groups would be.
 */
function chamferedBoxGeometry(chamfer: number): THREE.BufferGeometry {
  const h = 0.5;
  const c = Math.min(chamfer, h * 0.49);
  const inner = h - c;

  const pos: number[] = [];
  const uvs: number[] = [];
  const centroid = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  /** Emits a triangle, flipping the winding if it faces inward. */
  const tri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ) => {
    centroid.set((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3);
    ab.set(bx - ax, by - ay, bz - az);
    ac.set(cx - ax, cy - ay, cz - az);
    nrm.crossVectors(ab, ac);
    // The shape is convex and centred on the origin, so "outward" is simply
    // "away from the centroid" — no winding bookkeeping needed anywhere else.
    if (nrm.dot(centroid) < 0) {
      pos.push(ax, ay, az, cx, cy, cz, bx, by, bz);
    } else {
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    }
    // Planar uv from the two axes with the smallest normal component; good
    // enough for a grit/roughness detail map on a tumbling chunk.
    const an = Math.abs(nrm.x);
    const bn = Math.abs(nrm.y);
    const cn = Math.abs(nrm.z);
    for (let k = 0; k < 3; k++) {
      const px = pos[pos.length - 9 + k * 3];
      const py = pos[pos.length - 8 + k * 3];
      const pz = pos[pos.length - 7 + k * 3];
      if (an >= bn && an >= cn) uvs.push(pz + 0.5, py + 0.5);
      else if (bn >= cn) uvs.push(px + 0.5, pz + 0.5);
      else uvs.push(px + 0.5, py + 0.5);
    }
  };

  const quad = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
  ) => {
    tri(ax, ay, az, bx, by, bz, cx, cy, cz);
    tri(ax, ay, az, cx, cy, cz, dx, dy, dz);
  };

  // --- Six inset faces ------------------------------------------------------
  for (let axis = 0; axis < 3; axis++) {
    for (const s of [1, -1]) {
      // Build the face in a local (u, v) basis, then permute into world axes.
      const corners: [number, number][] = [
        [-inner, -inner], [inner, -inner], [inner, inner], [-inner, inner],
      ];
      const p: number[] = [];
      for (const [u, v] of corners) {
        if (axis === 0) p.push(s * h, u, v);
        else if (axis === 1) p.push(u, s * h, v);
        else p.push(u, v, s * h);
      }
      quad(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], p[10], p[11]);
    }
  }

  /** The chamfer vertex for corner (sx,sy,sz) that lies on the `axis` face. */
  const cv = (sx: number, sy: number, sz: number, axis: number): [number, number, number] => {
    if (axis === 0) return [sx * h, sy * inner, sz * inner];
    if (axis === 1) return [sx * inner, sy * h, sz * inner];
    return [sx * inner, sy * inner, sz * h];
  };

  // --- Twelve edge strips ---------------------------------------------------
  // Each edge is shared by two faces; the strip bridges their chamfer verts.
  const signs = [1, -1];
  for (let a = 0; a < 3; a++) {
    for (let b = a + 1; b < 3; b++) {
      // The third axis is the one the edge runs along.
      const along = 3 - a - b;
      for (const sa of signs) {
        for (const sb of signs) {
          const mk = (t: number, axis: number): [number, number, number] => {
            const s: [number, number, number] = [0, 0, 0];
            s[a] = sa;
            s[b] = sb;
            s[along] = t;
            return cv(s[0], s[1], s[2], axis);
          };
          const p0 = mk(-1, a);
          const p1 = mk(1, a);
          const p2 = mk(1, b);
          const p3 = mk(-1, b);
          quad(
            p0[0], p0[1], p0[2], p1[0], p1[1], p1[2],
            p2[0], p2[1], p2[2], p3[0], p3[1], p3[2],
          );
        }
      }
    }
  }

  // --- Eight corner triangles -----------------------------------------------
  for (const sx of signs) {
    for (const sy of signs) {
      for (const sz of signs) {
        const px = cv(sx, sy, sz, 0);
        const py = cv(sx, sy, sz, 1);
        const pz = cv(sx, sy, sz, 2);
        tri(px[0], px[1], px[2], py[0], py[1], py[2], pz[0], pz[1], pz[2]);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * A lumpy rock: an icosahedron with every vertex pushed around by a
 * deterministic hash. Flat-shaded this reads as rubble; a clean icosahedron
 * reads as a die.
 */
function rubbleGeometry(seed: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(0.5, 0);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const j0 = 0.55 + hash2(i, 0, seed) * 0.95;
    const j1 = 0.55 + hash2(i, 1, seed) * 0.95;
    const j2 = 0.55 + hash2(i, 2, seed) * 0.95;
    p.setXYZ(i, p.getX(i) * j0, p.getY(i) * j1, p.getZ(i) * j2);
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

const NO_RAYCAST = () => {};

/**
 * Handed back when a strand is asked for before the layer exists. Every method
 * is a no-op and `alive` is false, so the glue system's normal "has it broken
 * yet" check tidies it away on the next frame without a special case.
 */
const DEAD_STRAND: GlueStrandHandle = {
  set(): void {},
  snap(): void {},
  release(): void {},
  alive: false,
};
const INFINITE_SPHERE = () => new THREE.Sphere(new THREE.Vector3(), Infinity);

/** Loot-beam proportions, in metres. Tuned to read from ~120 m out. */
const BEAM_HEIGHT = 7.5;
const BEAM_RADIUS = 0.42;
const BEAM_SEGMENTS = 16;

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

/**
 * The engine steps `fixed()` at a hard 120 Hz; the shared `System` contract in
 * types.ts does not declare it (the engine's own `FixedSystem` does, and that
 * lives in engine/core.ts), so we redeclare the shape locally rather than
 * reach across into another module's file.
 */
interface FixedSystem extends System {
  fixed(dt: number, ctx: WorldCtx): void;
}

const createVfx: SystemFactory = (ctx: WorldCtx): FixedSystem => {
  const rng = ctx.rng;
  const budget = BUDGETS[ctx.quality] ?? BUDGETS.high;
  const D = budget.density;
  const rr = (a: number, b: number) => a + (b - a) * rng();
  /** Scales a burst count by the quality density, never below 1 when asked for >0. */
  const cnt = (n: number) => (n <= 0 ? 0 : Math.max(1, Math.round(n * D)));

  // Everything below the publish block is still in its temporal dead zone
  // until the factory finishes. Nothing should call us that early, but a
  // system that does must degrade rather than throw.
  let ready = false;

  /**
   * The mode seam. `classic` must come out of this file byte-for-byte the way
   * it went in — /drop-zero is live and its loop is verified — so every water
   * behaviour is either a new method nobody in classic calls, or a branch on
   * this flag at the top of an existing recipe.
   */
  const water = ctx.mode === "water";

  // =========================================================================
  // Service published FIRST, before any texture synthesis, so a later system
  // that grabs `ctx.services.vfx` during its own factory always finds it.
  // The methods delegate to hoisted function declarations further down.
  // =========================================================================

  const service: VfxService = {
    explosion(point: THREE.Vector3, scale = 1): void {
      if (ready) doExplosion(point, scale);
    },
    impact(point: THREE.Vector3, normal: THREE.Vector3, material: ImpactMaterial = "concrete"): void {
      if (ready) doImpact(point, normal, material);
    },
    tracer(
      from: THREE.Vector3,
      to: THREE.Vector3,
      opts?: { width?: number; color?: THREE.Color },
    ): void {
      if (ready) doTracer(from, to, opts);
    },
    muzzleFlash(matrix: THREE.Matrix4, scale = 1): void {
      if (ready) doMuzzleFlash(matrix, scale);
    },
    smoke(point: THREE.Vector3, amount = 1): void {
      if (ready) doSmoke(point, amount);
    },
    damageNumber(point: THREE.Vector3, amount: number, headshot: boolean, shield: boolean): void {
      if (ready) doDamageNumber(point, amount, headshot, shield);
    },
    harvestBurst(point: THREE.Vector3, kind: HarvestKind): void {
      if (ready) doHarvestBurst(point, kind);
    },
    buildBreak(box: THREE.Box3, kind: HarvestKind): void {
      if (ready) doBuildBreak(box, kind);
    },
    lootBeam(point: THREE.Vector3, rarity: Rarity): THREE.Object3D {
      if (!ready) return new THREE.Group();
      return doLootBeam(point, rarity);
    },
  };

  // The water half of the service. Attached to the same object rather than
  // published separately, so a caller only ever has to find one thing.
  const waterService: WaterVfxService = {
    splash(point, normal, opts): void {
      if (ready) doSplash(point, normal, opts);
    },
    waterStream(from, to, opts): void {
      if (ready) doWaterStream(from, to, opts);
    },
    balloonBurst(point, opts): void {
      if (ready) doBalloonBurst(point, opts);
    },
    glueStrand(a, b): GlueStrandHandle {
      return ready ? acquireStrand(a, b) : DEAD_STRAND;
    },
    soakNumber(point, amount, faceful, poncho): void {
      if (ready) doSoakNumber(point, amount, faceful, poncho);
    },
    dryingShimmer(point, opts): void {
      if (ready) doDryingShimmer(point, opts);
    },
    wetPatch(point, normal, size, seconds): void {
      if (ready) doWetPatch(point, normal, size, seconds);
    },
  };
  // Present in both modes. Classic never calls them and the extra keys cost
  // nothing; a mode-conditional service shape would only mean every water
  // caller needing a second null check for a case that cannot happen.
  Object.assign(service, waterService);
  ctx.services.vfx = service;

  const noiseSeed = (rng() * 0x7fffffff) | 0;

  // --- Textures (generated once, reused forever) ---------------------------
  const texSprites = makeSpriteAtlas(budget.sprites, noiseSeed);
  const texStreak = makeStreakTexture();
  const texNoise = makeNoiseTexture(64, noiseSeed + 4021);
  const texBeamNoise = makeBeamNoiseTexture(128, noiseSeed + 8123);
  const texRamp = makeRampTexture();
  // `water` swaps the two blood cells for water splats — see the note in
  // makeDecalAtlas. Classic gets the atlas it has always had, byte for byte.
  const texDecals = makeDecalAtlas(budget.atlas, rng, water);
  const texGrit = makeGritTexture(128, noiseSeed + 313);
  const texNormal = makeNormalTexture(128, noiseSeed + 313);
  const numerals = makeNumeralAtlas(512);

  // --- Shared uniform objects ----------------------------------------------
  // Shared by reference across every material, so one write per frame updates
  // the whole VFX layer instead of eleven.
  const uTime = { value: 0 };
  const uWind = { value: new THREE.Vector3(0.28, 0, -0.16) };
  const uFogColor = { value: new THREE.Color(0x9fd6ea) };
  const uFogParams = { value: new THREE.Vector3(500, 4200, 0.0006) };
  const uFogKind = { value: 1 };
  const uResolution = { value: new THREE.Vector2(1, 1) };
  const uCamRange = { value: new THREE.Vector2(0.1, 8000) };
  /** Sun-driven tint for everything that is lit rather than emissive. */
  const uLitTint = { value: new THREE.Color(1, 1, 1) };
  /** View-space sun direction, for the smoke impostor lighting. */
  const uSunView = { value: new THREE.Vector3(0, 1, 0) };
  const uSunColor = { value: new THREE.Color(1, 0.95, 0.86) };
  const uSkyColor = { value: new THREE.Color(0.34, 0.42, 0.55) };

  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const textures: THREE.Texture[] = [
    texSprites, texStreak, texNoise, texBeamNoise, texRamp, texDecals,
    texGrit, texNormal, numerals.texture,
  ];

  // =========================================================================
  // Billboard layers
  // =========================================================================

  interface BillboardLayer {
    mesh: THREE.Mesh;
    ring: Ring;
    attrs: THREE.InstancedBufferAttribute[];
    pos: Float32Array;
    vel: Float32Array;
    life: Float32Array;
    style: Float32Array;
    motion: Float32Array;
    color: Float32Array;
    material: THREE.ShaderMaterial;
  }

  function makeBillboardLayer(
    cap: number,
    additive: boolean,
    order: number,
    name: string,
  ): BillboardLayer {
    const geo = new THREE.InstancedBufferGeometry();
    const q = quadArrays(-0.5, 0.5);
    geo.setIndex(new THREE.BufferAttribute(q.index, 1));
    geo.setAttribute("position", new THREE.BufferAttribute(q.position, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(q.uv, 2));

    const pos = new Float32Array(cap * 3);
    const vel = new Float32Array(cap * 3);
    const life = new Float32Array(cap * 4);
    const style = new Float32Array(cap * 4);
    const motion = new Float32Array(cap * 4);
    const color = new Float32Array(cap * 3);
    // Dead until spawned: a spawn time far in the past with a zero lifetime
    // sends t past 1 on the very first frame, so nothing flashes at boot.
    for (let i = 0; i < cap; i++) {
      life[i * 4] = -1e9;
      color[i * 3] = color[i * 3 + 1] = color[i * 3 + 2] = 1;
    }

    const attrs = [
      new THREE.InstancedBufferAttribute(pos, 3),
      new THREE.InstancedBufferAttribute(vel, 3),
      new THREE.InstancedBufferAttribute(life, 4),
      new THREE.InstancedBufferAttribute(style, 4),
      new THREE.InstancedBufferAttribute(motion, 4),
      new THREE.InstancedBufferAttribute(color, 3),
    ];
    const names = ["iPos", "iVel", "iLife", "iStyle", "iMotion", "iColor"];
    attrs.forEach((a, i) => {
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(names[i], a);
    });
    geo.instanceCount = cap;
    geo.boundingSphere = INFINITE_SPHERE();

    const defines: Record<string, string> = {};
    if (additive) defines.ADDITIVE = "1";
    // Only the alpha layer is lit. Fire and sparks are emitters — shading them
    // by the sun would make an explosion dimmer at dusk, which is nonsense.
    else defines.LIT = "1";

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime, uWind, uFogColor, uFogParams, uFogKind,
        uResolution, uCamRange,
        uMap: { value: texSprites },
        uRamp: { value: texRamp },
        uTint: additive ? { value: new THREE.Color(1, 1, 1) } : uLitTint,
        uSunView, uSunColor, uSkyColor,
        uDepth: { value: null as THREE.Texture | null },
        uSoftness: { value: additive ? 1.6 : 2.8 },
      },
      vertexShader: BILLBOARD_VERT,
      fragmentShader: BILLBOARD_FRAG,
      defines,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = order;
    mesh.raycast = NO_RAYCAST;
    ctx.scene.add(mesh);
    materials.push(material);
    geometries.push(geo);

    return { mesh, ring: new Ring(cap), pos, vel, life, style, motion, color, material, attrs };
  }

  // Both layers sample the same sprite atlas; only the blend mode, the lighting
  // define and the ramp rows differ. That is what keeps this at exactly two
  // draw calls for every puff, chip, ember and flash in the game.
  const bbAdd = makeBillboardLayer(budget.billboards, true, 24, "vfx.billboards.additive");
  const bbAlpha = makeBillboardLayer(budget.billboards, false, 22, "vfx.billboards.alpha");

  /**
   * Spawn a billboard. Positional args on purpose: this is the hottest call in
   * the module and an options object here would allocate tens of thousands of
   * times a second during a firefight, which is exactly the garbage the whole
   * pooled design exists to avoid.
   */
  function emitBillboard(
    layer: BillboardLayer,
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    life: number, size0: number, size1: number,
    ramp: number, bright: number,
    buoyancy: number, drag: number, spin: number,
    sprite: number = SPRITE.smoke,
    delay = 0,
    tint: THREE.Color | null = null,
  ): void {
    const i = layer.ring.next();
    const i3 = i * 3;
    const i4 = i * 4;
    layer.pos[i3] = px; layer.pos[i3 + 1] = py; layer.pos[i3 + 2] = pz;
    layer.vel[i3] = vx; layer.vel[i3 + 1] = vy; layer.vel[i3 + 2] = vz;
    layer.life[i4] = uTime.value + delay;
    layer.life[i4 + 1] = life;
    layer.life[i4 + 2] = rng();
    layer.life[i4 + 3] = drag;
    layer.style[i4] = size0;
    layer.style[i4 + 1] = size1;
    layer.style[i4 + 2] = (ramp + 0.5) / RAMP_ROWS;
    layer.style[i4 + 3] = bright;
    layer.motion[i4] = buoyancy;
    layer.motion[i4 + 1] = spin;
    layer.motion[i4 + 2] = SPRITE_U[sprite];
    layer.motion[i4 + 3] = SPRITE_V[sprite];
    if (tint) {
      layer.color[i3] = tint.r;
      layer.color[i3 + 1] = tint.g;
      layer.color[i3 + 2] = tint.b;
    } else {
      layer.color[i3] = layer.color[i3 + 1] = layer.color[i3 + 2] = 1;
    }
  }

  // =========================================================================
  // Streaks — sparks, tracers, droplets, splinter trails
  // =========================================================================

  const streakCap = budget.streaks;
  const streakRing = new Ring(streakCap);
  const sPos = new Float32Array(streakCap * 3);
  const sVel = new Float32Array(streakCap * 3);
  const sAcc = new Float32Array(streakCap * 3);
  const sLife = new Float32Array(streakCap * 4);
  const sStyle = new Float32Array(streakCap * 2);
  const sColor = new Float32Array(streakCap * 3);
  for (let i = 0; i < streakCap; i++) {
    sLife[i * 4] = -1e9;
    sColor[i * 3] = sColor[i * 3 + 1] = sColor[i * 3 + 2] = 1;
  }

  const streakGeo = new THREE.InstancedBufferGeometry();
  {
    // Anchored at the tail (x from 0 to 1) so the head lands exactly on the
    // integrated position and a tracer terminates on the surface it hit.
    const q = quadArrays(0, 1);
    streakGeo.setIndex(new THREE.BufferAttribute(q.index, 1));
    streakGeo.setAttribute("position", new THREE.BufferAttribute(q.position, 3));
    streakGeo.setAttribute("uv", new THREE.BufferAttribute(q.uv, 2));
  }
  const sAttrs = [
    new THREE.InstancedBufferAttribute(sPos, 3),
    new THREE.InstancedBufferAttribute(sVel, 3),
    new THREE.InstancedBufferAttribute(sAcc, 3),
    new THREE.InstancedBufferAttribute(sLife, 4),
    new THREE.InstancedBufferAttribute(sStyle, 2),
    new THREE.InstancedBufferAttribute(sColor, 3),
  ];
  const sNames = ["iPos", "iVel", "iAcc", "iLife", "iStyle", "iColor"];
  sAttrs.forEach((a, i) => {
    a.setUsage(THREE.DynamicDrawUsage);
    streakGeo.setAttribute(sNames[i], a);
  });
  streakGeo.instanceCount = streakCap;
  streakGeo.boundingSphere = INFINITE_SPHERE();

  const streakMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime, uFogColor, uFogParams, uFogKind,
      uMap: { value: texStreak },
      uRamp: { value: texRamp },
    },
    vertexShader: STREAK_VERT,
    fragmentShader: STREAK_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const streakMesh = new THREE.Mesh(streakGeo, streakMat);
  streakMesh.name = "vfx.streaks";
  streakMesh.frustumCulled = false;
  streakMesh.matrixAutoUpdate = false;
  streakMesh.renderOrder = 25;
  streakMesh.raycast = NO_RAYCAST;
  ctx.scene.add(streakMesh);
  materials.push(streakMat);
  geometries.push(streakGeo);

  function emitStreak(
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    ax: number, ay: number, az: number,
    life: number, width: number, length: number,
    ramp: number, bright: number,
    delay = 0,
    tint: THREE.Color | null = null,
  ): void {
    const i = streakRing.next();
    const i3 = i * 3;
    const i4 = i * 4;
    const i2 = i * 2;
    sPos[i3] = px; sPos[i3 + 1] = py; sPos[i3 + 2] = pz;
    sVel[i3] = vx; sVel[i3 + 1] = vy; sVel[i3 + 2] = vz;
    sAcc[i3] = ax; sAcc[i3 + 1] = ay; sAcc[i3 + 2] = az;
    sLife[i4] = uTime.value + delay;
    sLife[i4 + 1] = life;
    sLife[i4 + 2] = width;
    sLife[i4 + 3] = length;
    sStyle[i2] = (ramp + 0.5) / RAMP_ROWS;
    sStyle[i2 + 1] = bright;
    if (tint) {
      sColor[i3] = tint.r; sColor[i3 + 1] = tint.g; sColor[i3 + 2] = tint.b;
    } else {
      sColor[i3] = sColor[i3 + 1] = sColor[i3 + 2] = 1;
    }
  }

  // =========================================================================
  // Rings
  // =========================================================================

  interface RingLayer {
    ring: Ring;
    pos: Float32Array;
    quat: Float32Array;
    life: Float32Array;
    style: Float32Array;
    color: Float32Array;
    attrs: THREE.InstancedBufferAttribute[];
    mesh: THREE.Mesh;
  }

  function makeRingLayer(cap: number, additive: boolean, order: number, name: string): RingLayer {
    const pos = new Float32Array(cap * 3);
    const quat = new Float32Array(cap * 4);
    const life = new Float32Array(cap * 4);
    const style = new Float32Array(cap * 4);
    const color = new Float32Array(cap * 3);
    for (let i = 0; i < cap; i++) {
      life[i * 4] = -1e9;
      quat[i * 4 + 3] = 1;
      color[i * 3] = color[i * 3 + 1] = color[i * 3 + 2] = 1;
    }
    const geo = new THREE.InstancedBufferGeometry();
    const q = quadArrays(-0.5, 0.5);
    geo.setIndex(new THREE.BufferAttribute(q.index, 1));
    geo.setAttribute("position", new THREE.BufferAttribute(q.position, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(q.uv, 2));
    const attrs = [
      new THREE.InstancedBufferAttribute(pos, 3),
      new THREE.InstancedBufferAttribute(quat, 4),
      new THREE.InstancedBufferAttribute(life, 4),
      new THREE.InstancedBufferAttribute(style, 4),
      new THREE.InstancedBufferAttribute(color, 3),
    ];
    const names = ["iPos", "iQuat", "iLife", "iStyle", "iColor"];
    attrs.forEach((a, i) => {
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(names[i], a);
    });
    geo.instanceCount = cap;
    geo.boundingSphere = INFINITE_SPHERE();

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime, uFogColor, uFogParams, uFogKind,
        uNoise: { value: texNoise },
        uRamp: { value: texRamp },
        uTint: uLitTint,
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      defines: additive ? { ADDITIVE: "1" } : {},
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      // Ground rings lie on the terrain; without the offset the far half of a
      // 20 m shockwave z-fights with the hillside it is expanding across.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = order;
    mesh.raycast = NO_RAYCAST;
    ctx.scene.add(mesh);
    materials.push(mat);
    geometries.push(geo);
    return { ring: new Ring(cap), pos, quat, life, style, color, attrs, mesh };
  }

  const ringAdd = makeRingLayer(
    Math.max(8, Math.round(budget.rings * 0.45)), true, 20, "vfx.rings.additive");
  const ringDust = makeRingLayer(
    Math.max(8, Math.round(budget.rings * 0.55)), false, 19, "vfx.rings.dust");

  const tmpQuat = new THREE.Quaternion();
  const tmpQuat2 = new THREE.Quaternion();
  const tmpVec = new THREE.Vector3();
  const tmpVec2 = new THREE.Vector3();
  const tmpVec3 = new THREE.Vector3();
  const tmpVec4 = new THREE.Vector3();
  const surfaceNormal = new THREE.Vector3();
  const UNIT_Z = new THREE.Vector3(0, 0, 1);
  const UNIT_Y = new THREE.Vector3(0, 1, 0);

  /**
   * Builds the quaternion that lays a +Z quad flat against `n`, with roll.
   * Side effect by design: leaves the normalised, guarded normal in `tmpVec`
   * so callers that also need to offset along it do not re-normalise.
   */
  function orientTo(n: THREE.Vector3, roll: number): THREE.Quaternion {
    tmpVec.copy(n);
    if (tmpVec.lengthSq() < 1e-8) tmpVec.copy(UNIT_Y);
    tmpVec.normalize();
    tmpQuat.setFromUnitVectors(UNIT_Z, tmpVec);
    tmpQuat2.setFromAxisAngle(UNIT_Z, roll);
    return tmpQuat.multiply(tmpQuat2);
  }

  function emitRing(
    layer: RingLayer,
    px: number, py: number, pz: number,
    n: THREE.Vector3,
    life: number, r0: number, r1: number,
    ramp: number, bright: number, inner: number,
    delay = 0,
    tint: THREE.Color | null = null,
    scroll = 0.6,
  ): void {
    const i = layer.ring.next();
    const i3 = i * 3;
    const i4 = i * 4;
    const q = orientTo(n, rng() * Math.PI * 2);
    layer.pos[i3] = px; layer.pos[i3 + 1] = py; layer.pos[i3 + 2] = pz;
    layer.quat[i4] = q.x; layer.quat[i4 + 1] = q.y;
    layer.quat[i4 + 2] = q.z; layer.quat[i4 + 3] = q.w;
    layer.life[i4] = uTime.value + delay;
    layer.life[i4 + 1] = life;
    layer.life[i4 + 2] = r0;
    layer.life[i4 + 3] = r1;
    layer.style[i4] = (ramp + 0.5) / RAMP_ROWS;
    layer.style[i4 + 1] = bright;
    layer.style[i4 + 2] = inner;
    layer.style[i4 + 3] = scroll;
    if (tint) {
      layer.color[i3] = tint.r; layer.color[i3 + 1] = tint.g; layer.color[i3 + 2] = tint.b;
    } else {
      layer.color[i3] = layer.color[i3 + 1] = layer.color[i3 + 2] = 1;
    }
  }

  // =========================================================================
  // Decals
  //
  // Capped and recycled oldest-first. A match writes thousands of bullet
  // holes; keeping 190 of them and fading the rest out is the difference
  // between a level that records the fight and a level that stops rendering.
  // =========================================================================

  const decalCap = budget.decals;
  const decalRing = new Ring(decalCap);
  const dPos = new Float32Array(decalCap * 3);
  const dQuat = new Float32Array(decalCap * 4);
  const dLife = new Float32Array(decalCap * 4);
  const dCell = new Float32Array(decalCap * 2);
  const dTint = new Float32Array(decalCap * 3);
  for (let i = 0; i < decalCap; i++) {
    dLife[i * 4] = -1e9;
    dQuat[i * 4 + 3] = 1;
  }
  const decalGeo = new THREE.InstancedBufferGeometry();
  {
    const q = quadArrays(-0.5, 0.5);
    decalGeo.setIndex(new THREE.BufferAttribute(q.index, 1));
    decalGeo.setAttribute("position", new THREE.BufferAttribute(q.position, 3));
    decalGeo.setAttribute("uv", new THREE.BufferAttribute(q.uv, 2));
  }
  const dAttrs = [
    new THREE.InstancedBufferAttribute(dPos, 3),
    new THREE.InstancedBufferAttribute(dQuat, 4),
    new THREE.InstancedBufferAttribute(dLife, 4),
    new THREE.InstancedBufferAttribute(dCell, 2),
    new THREE.InstancedBufferAttribute(dTint, 3),
  ];
  const dNames = ["dPos", "dQuat", "dLife", "dCell", "dTint"];
  dAttrs.forEach((a, i) => {
    a.setUsage(THREE.DynamicDrawUsage);
    decalGeo.setAttribute(dNames[i], a);
  });
  decalGeo.instanceCount = decalCap;
  decalGeo.boundingSphere = INFINITE_SPHERE();

  const decalMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime, uFogColor, uFogParams, uFogKind,
      uMap: { value: texDecals },
      uCellScale: { value: 1 / ATLAS_DIV },
      uTint: uLitTint,
    },
    vertexShader: DECAL_VERT,
    fragmentShader: DECAL_FRAG,
    transparent: true,
    depthWrite: false,
    // Decals sit millimetres off their surface; polygon offset stops the
    // z-fight that a pure position nudge still leaves at grazing angles.
    polygonOffset: true,
    polygonOffsetFactor: -6,
    polygonOffsetUnits: -6,
    side: THREE.DoubleSide,
  });
  const decalMesh = new THREE.Mesh(decalGeo, decalMat);
  decalMesh.name = "vfx.decals";
  decalMesh.frustumCulled = false;
  decalMesh.matrixAutoUpdate = false;
  decalMesh.renderOrder = 6;
  decalMesh.raycast = NO_RAYCAST;
  ctx.scene.add(decalMesh);
  materials.push(decalMat);
  geometries.push(decalGeo);

  const tintColor = new THREE.Color();

  function emitDecal(
    px: number, py: number, pz: number,
    n: THREE.Vector3,
    size: number, cell: number, life: number,
    tintHex = 0xffffff, alpha = 1,
  ): void {
    if (size <= 0 || decalCap === 0) return;
    const i = decalRing.next();
    const i3 = i * 3;
    const i4 = i * 4;
    const i2 = i * 2;
    const q = orientTo(n, rng() * Math.PI * 2);
    // orientTo left the normalised normal in tmpVec: lift off the surface so
    // the quad never sinks into the wall it is marking.
    dPos[i3] = px + tmpVec.x * 0.025;
    dPos[i3 + 1] = py + tmpVec.y * 0.025;
    dPos[i3 + 2] = pz + tmpVec.z * 0.025;
    dQuat[i4] = q.x; dQuat[i4 + 1] = q.y; dQuat[i4 + 2] = q.z; dQuat[i4 + 3] = q.w;
    dLife[i4] = uTime.value;
    dLife[i4 + 1] = life;
    dLife[i4 + 2] = size;
    dLife[i4 + 3] = alpha;
    dCell[i2] = (cell % ATLAS_DIV) / ATLAS_DIV;
    // CanvasTexture is flipY, so atlas row 0 lives at the top of UV space.
    dCell[i2 + 1] = 1 - (Math.floor(cell / ATLAS_DIV) + 1) / ATLAS_DIV;
    tintColor.setHex(tintHex, THREE.SRGBColorSpace);
    dTint[i3] = tintColor.r;
    dTint[i3 + 1] = tintColor.g;
    dTint[i3 + 2] = tintColor.b;
  }

  // =========================================================================
  // Damage numbers
  // =========================================================================

  const numberCap = budget.numbers * MAX_GLYPHS;
  const numberRing = new Ring(numberCap);
  const nPos = new Float32Array(numberCap * 3);
  const nVel = new Float32Array(numberCap * 3);
  const nLife = new Float32Array(numberCap * 4);
  const nStyle = new Float32Array(numberCap * 4);
  const nColor = new Float32Array(numberCap * 3);
  for (let i = 0; i < numberCap; i++) {
    nLife[i * 4] = -1e9;
    nColor[i * 3] = nColor[i * 3 + 1] = nColor[i * 3 + 2] = 1;
  }

  const numberGeo = new THREE.InstancedBufferGeometry();
  {
    const q = quadArrays(-0.5, 0.5);
    numberGeo.setIndex(new THREE.BufferAttribute(q.index, 1));
    numberGeo.setAttribute("position", new THREE.BufferAttribute(q.position, 3));
    numberGeo.setAttribute("uv", new THREE.BufferAttribute(q.uv, 2));
  }
  const nAttrs = [
    new THREE.InstancedBufferAttribute(nPos, 3),
    new THREE.InstancedBufferAttribute(nVel, 3),
    new THREE.InstancedBufferAttribute(nLife, 4),
    new THREE.InstancedBufferAttribute(nStyle, 4),
    new THREE.InstancedBufferAttribute(nColor, 3),
  ];
  const nNames = ["nPos", "nVel", "nLife", "nStyle", "nColor"];
  nAttrs.forEach((a, i) => {
    a.setUsage(THREE.DynamicDrawUsage);
    numberGeo.setAttribute(nNames[i], a);
  });
  numberGeo.instanceCount = numberCap;
  numberGeo.boundingSphere = INFINITE_SPHERE();

  const numberMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime,
      uMap: { value: numerals.texture },
      uCellScale: { value: 0.25 },
      uAdvance: { value: numerals.advance },
      // Water numbers get a slightly cooler outline so they sit in the same
      // light as everything else on a bright, sunny map.
      uOutline: { value: (water ? SOAK_OUTLINE : NUMERAL_OUTLINE).clone() },
    },
    vertexShader: NUMBER_VERT,
    fragmentShader: NUMBER_FRAG,
    transparent: true,
    depthWrite: false,
    // Depth test OFF, deliberately. A damage number that is occluded by the
    // wall you shot the enemy through is a damage number you did not read,
    // and the whole point of the layer is that it is never missed.
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });
  const numberMesh = new THREE.Mesh(numberGeo, numberMat);
  numberMesh.name = "vfx.numbers";
  numberMesh.frustumCulled = false;
  numberMesh.matrixAutoUpdate = false;
  numberMesh.renderOrder = 9000;
  numberMesh.raycast = NO_RAYCAST;
  ctx.scene.add(numberMesh);
  materials.push(numberMat);
  geometries.push(numberGeo);

  function emitGlyph(
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    life: number, size: number, gravity: number,
    cell: number, glyphOffset: number, bright: number,
    color: THREE.Color,
  ): void {
    const i = numberRing.next();
    const i3 = i * 3;
    const i4 = i * 4;
    nPos[i3] = px; nPos[i3 + 1] = py; nPos[i3 + 2] = pz;
    nVel[i3] = vx; nVel[i3 + 1] = vy; nVel[i3 + 2] = vz;
    nLife[i4] = uTime.value;
    nLife[i4 + 1] = life;
    nLife[i4 + 2] = size;
    nLife[i4 + 3] = gravity;
    nStyle[i4] = (cell % 4) / 4;
    // Canvas atlas is flipY like the decal atlas.
    nStyle[i4 + 1] = 1 - (Math.floor(cell / 4) + 1) / 4;
    nStyle[i4 + 2] = glyphOffset;
    nStyle[i4 + 3] = bright;
    nColor[i3] = color.r; nColor[i3 + 1] = color.g; nColor[i3 + 2] = color.b;
  }

  /**
   * Recent damage-number anchors, so several hits on the same target inside
   * half a second stack upward instead of piling into an unreadable smear.
   * Eight entries is plenty — beyond that the numbers have moved apart on
   * their own.
   */
  const RECENT_CAP = 8;
  const recentX = new Float32Array(RECENT_CAP);
  const recentY = new Float32Array(RECENT_CAP);
  const recentZ = new Float32Array(RECENT_CAP);
  const recentT = new Float32Array(RECENT_CAP).fill(-1e9);
  const recentStack = new Int32Array(RECENT_CAP);
  let recentCursor = 0;

  // =========================================================================
  // Debris — the only CPU-simulated layers, because chunks have to bounce
  //
  // Two meshes: lumpy rubble for masonry and dirt, chamfered slabs for planks
  // and panels. Both are InstancedMesh with per-instance colour, both carry a
  // grit albedo, a roughness map and a normal map so no two chunks in a pile
  // catch the light the same way.
  // =========================================================================

  interface Chunk {
    pos: THREE.Vector3;
    vel: THREE.Vector3;
    axis: THREE.Vector3;
    quat: THREE.Quaternion;
    spin: number;
    /** Per-axis scale, so a slab can be a plank and a lump can be a lump. */
    scale: THREE.Vector3;
    size: number;
    life: number;
    maxLife: number;
    /** 1 = leaves an ember trail (came out of a fire). */
    hot: number;
    trail: number;
    rest: boolean;
    /** Dust ramp used for the puff it leaves when it settles or expires. */
    ramp: number;
  }

  interface DebrisLayer {
    mesh: THREE.InstancedMesh;
    chunks: Chunk[];
    cursor: number;
    live: number;
    cap: number;
  }

  const debrisCap = budget.debris;
  const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  const tmpMatrix = new THREE.Matrix4();
  const chunkColor = new THREE.Color();

  function makeDebrisMaterial(name: string): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      name,
      color: 0xffffff,
      map: texGrit,
      // The alpha channel of the grit texture is the roughness field. Reusing
      // one texture for both is a VRAM win and guarantees the two agree: the
      // dark specks in the albedo are the same pits that are rough.
      roughnessMap: texGrit,
      normalMap: texNormal,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 1.0,
      metalness: 0.04,
      flatShading: true,
    });
    materials.push(mat);
    return mat;
  }

  function makeDebrisLayer(
    geo: THREE.BufferGeometry, mat: THREE.MeshStandardMaterial, name: string,
  ): DebrisLayer {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, debrisCap));
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.raycast = NO_RAYCAST;
    mesh.castShadow = budget.debrisShadows;
    mesh.receiveShadow = false;
    ctx.scene.add(mesh);
    geometries.push(geo);

    const chunks: Chunk[] = [];
    for (let i = 0; i < debrisCap; i++) {
      chunks.push({
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        axis: new THREE.Vector3(0, 1, 0),
        quat: new THREE.Quaternion(),
        scale: new THREE.Vector3(1, 1, 1),
        spin: 0, size: 0, life: 0, maxLife: 1, hot: 0, trail: 0, rest: false,
        ramp: RAMP.dust,
      });
      mesh.setMatrixAt(i, zeroMatrix);
      mesh.setColorAt(i, chunkColor.setHex(0x808080));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return { mesh, chunks, cursor: 0, live: 0, cap: debrisCap };
  }

  const rubbleGeo = rubbleGeometry(noiseSeed + 55);
  const slabGeo = chamferedBoxGeometry(0.11);
  const rubbleMat = makeDebrisMaterial("vfx.debris.rubble");
  const slabMat = makeDebrisMaterial("vfx.debris.slab");
  const debrisRubble = makeDebrisLayer(rubbleGeo, rubbleMat, "vfx.debris.rubble");
  const debrisSlab = makeDebrisLayer(slabGeo, slabMat, "vfx.debris.slab");
  const debrisLayers = [debrisRubble, debrisSlab];

  function emitDebris(
    layer: DebrisLayer,
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    size: number, sx: number, sy: number, sz: number,
    colorHex: number, hot: number, life: number, ramp: number,
  ): void {
    if (layer.cap === 0) return;
    const slot = layer.cursor;
    const c = layer.chunks[slot];
    layer.cursor = (layer.cursor + 1) % layer.cap;
    if (c.life <= 0) layer.live++;
    c.pos.set(px, py, pz);
    c.vel.set(vx, vy, vz);
    c.axis.set(rr(-1, 1), rr(-1, 1), rr(-1, 1));
    if (c.axis.lengthSq() < 1e-6) c.axis.set(0, 1, 0);
    c.axis.normalize();
    c.quat.set(rr(-1, 1), rr(-1, 1), rr(-1, 1), rr(-1, 1)).normalize();
    c.spin = rr(6, 22);
    c.scale.set(sx, sy, sz);
    c.size = size;
    c.maxLife = life;
    c.life = life;
    c.hot = hot;
    c.trail = 0;
    c.rest = false;
    c.ramp = ramp;
    layer.mesh.setColorAt(slot, chunkColor.setHex(colorHex, THREE.SRGBColorSpace));
    if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true;
  }

  // =========================================================================
  // Light pool
  //
  // Allocated once and left in the scene at zero intensity. Adding a light to
  // a live scene forces three to relink every material's program, which is a
  // multi-frame hitch — mid-firefight is the worst possible moment for it.
  // =========================================================================

  interface FlashLight {
    light: THREE.PointLight;
    life: number;
    dur: number;
    peak: number;
    flicker: number;
    /** Decorrelates simultaneous blasts so they never strobe in lockstep. */
    phase: number;
  }
  const lights: FlashLight[] = [];
  for (let i = 0; i < budget.lights; i++) {
    const l = new THREE.PointLight(0xffb060, 0, 30, 2);
    l.castShadow = false;
    l.visible = true;
    ctx.scene.add(l);
    lights.push({ light: l, life: 0, dur: 1, peak: 0, flicker: 0, phase: rng() * 6.283 });
  }

  /** Grabs the dimmest slot, so a new blast never steals a brighter one. */
  function flashLight(
    x: number, y: number, z: number,
    colorHex: number, peak: number, distance: number, duration: number, flicker = 0,
  ): void {
    if (lights.length === 0) return;
    let best = lights[0];
    let bestScore = Infinity;
    for (const fl of lights) {
      const score = fl.life <= 0 ? -1 : fl.light.intensity;
      if (score < bestScore) {
        bestScore = score;
        best = fl;
      }
    }
    best.light.position.set(x, y, z);
    best.light.color.setHex(colorHex, THREE.SRGBColorSpace);
    best.light.distance = distance;
    best.peak = peak;
    best.dur = duration;
    best.life = duration;
    best.flicker = flicker;
    best.phase = rng() * 6.283;
    best.light.intensity = peak;
  }

  // =========================================================================
  // Full-screen flash quads
  // =========================================================================

  interface FlashQuad {
    mesh: THREE.Mesh;
    material: THREE.ShaderMaterial;
    life: number;
    dur: number;
    peak: number;
  }

  function makeFlashQuad(additive: boolean, name: string): FlashQuad {
    const geo = new THREE.BufferGeometry();
    const q = quadArrays(-0.5, 0.5);
    geo.setIndex(new THREE.BufferAttribute(q.index, 1));
    geo.setAttribute("position", new THREE.BufferAttribute(q.position, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(q.uv, 2));
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(1, 0.15, 0.12) },
        uStrength: { value: 0 },
        uVignette: { value: 1 },
        uDir: { value: new THREE.Vector2(0, 0) },
        uAspect: { value: 1 },
      },
      vertexShader: FLASH_VERT,
      fragmentShader: FLASH_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 9500;
    mesh.raycast = NO_RAYCAST;
    mesh.visible = false;
    ctx.scene.add(mesh);
    materials.push(material);
    geometries.push(geo);
    return { mesh, material, life: 0, dur: 1, peak: 0 };
  }

  const flashLit = makeFlashQuad(false, "vfx.flash.normal");
  const flashAdd = makeFlashQuad(true, "vfx.flash.additive");

  /** Trigger a screen flash. `dir` is a screen-space bias, -1..1 per axis. */
  function screenFlash(
    colorHex: number, strength: number, duration: number,
    additive: boolean, vignette: number, dirX: number, dirY: number,
  ): void {
    const q = additive ? flashAdd : flashLit;
    // Never let a weaker flash interrupt a stronger one already playing.
    const current = q.life > 0 ? q.peak * (q.life / q.dur) : 0;
    if (strength < current) return;
    (q.material.uniforms.uColor.value as THREE.Color).setHex(colorHex, THREE.SRGBColorSpace);
    (q.material.uniforms.uDir.value as THREE.Vector2).set(dirX, dirY);
    q.material.uniforms.uVignette.value = vignette;
    q.peak = strength;
    q.dur = Math.max(0.03, duration);
    q.life = q.dur;
    q.material.uniforms.uStrength.value = strength;
    q.mesh.visible = true;
  }

  // =========================================================================
  // Loot beams
  //
  // Geometry is shared across every beam in the world; only the material
  // varies, and only by rarity, so five materials cover the whole map. The
  // per-beam phase comes out of the object's own world position inside the
  // shader, which means two beams are never in sync and no per-beam CPU state
  // exists at all.
  // =========================================================================

  const beamGeo = new THREE.CylinderGeometry(
    BEAM_RADIUS * 1.85, BEAM_RADIUS, BEAM_HEIGHT, BEAM_SEGMENTS, 1, true,
  );
  // Base at y = 0, so callers can drop the group straight onto the ground.
  beamGeo.translate(0, BEAM_HEIGHT / 2, 0);
  geometries.push(beamGeo);

  const beamGlowGeo = new THREE.PlaneGeometry(BEAM_RADIUS * 7.5, BEAM_RADIUS * 7.5);
  beamGlowGeo.rotateX(-Math.PI / 2);
  geometries.push(beamGlowGeo);

  const moteGeo = new THREE.InstancedBufferGeometry();
  {
    const q = quadArrays(-0.5, 0.5);
    moteGeo.setIndex(new THREE.BufferAttribute(q.index, 1));
    moteGeo.setAttribute("position", new THREE.BufferAttribute(q.position, 3));
    moteGeo.setAttribute("uv", new THREE.BufferAttribute(q.uv, 2));
    const seeds = new Float32Array(budget.motes);
    for (let i = 0; i < budget.motes; i++) seeds[i] = rng();
    moteGeo.setAttribute("iSeed", new THREE.InstancedBufferAttribute(seeds, 1));
    moteGeo.instanceCount = budget.motes;
    moteGeo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, BEAM_HEIGHT * 0.5, 0), BEAM_HEIGHT);
  }
  geometries.push(moteGeo);

  interface BeamMaterials {
    beam: THREE.ShaderMaterial;
    glow: THREE.ShaderMaterial;
    mote: THREE.ShaderMaterial;
  }
  const beamMaterials = new Map<Rarity, BeamMaterials>();

  function getBeamMaterials(rarity: Rarity): BeamMaterials {
    const cached = beamMaterials.get(rarity);
    if (cached) return cached;
    const hex = RARITY_COLOR[rarity] ?? RARITY_COLOR.common;
    const color = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
    // Push the beam colour well past its albedo. A beam is emissive light in
    // suspended dust — if it renders at the same value as the item card it
    // sits next to, it reads as painted plastic rather than as a light source.
    const beamColor = color.clone().multiplyScalar(1.9);
    const glowColor = color.clone().multiplyScalar(1.35);

    const beam = new THREE.ShaderMaterial({
      uniforms: {
        uTime, uFogColor, uFogParams, uFogKind,
        uNoise: { value: texBeamNoise },
        uColor: { value: beamColor },
        uIntensity: { value: 1 },
      },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const glow = new THREE.ShaderMaterial({
      uniforms: {
        uTime, uFogColor, uFogParams, uFogKind,
        uNoise: { value: texNoise },
        uColor: { value: glowColor },
        uIntensity: { value: 1 },
      },
      vertexShader: BEAM_GLOW_VERT,
      fragmentShader: BEAM_GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const mote = new THREE.ShaderMaterial({
      uniforms: {
        uTime, uFogColor, uFogParams, uFogKind,
        uHeight: { value: BEAM_HEIGHT * 0.85 },
        uRadius: { value: BEAM_RADIUS * 2.6 },
        uColor: { value: color.clone().multiplyScalar(2.4) },
        uIntensity: { value: 1 },
      },
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const set: BeamMaterials = { beam, glow, mote };
    materials.push(beam, glow, mote);
    beamMaterials.set(rarity, set);
    return set;
  }

  /**
   * Live beams, oldest first. Loot owns each Object3D once we hand it back —
   * we only keep the reference so that (a) a runaway caller cannot make an
   * unbounded number of them and (b) dispose() can detach any that are still
   * parented when the world tears down.
   */
  const liveBeams: THREE.Object3D[] = [];

  // =========================================================================
  // SOAKED — glue strands
  //
  // A small fixed pool, built at boot ONLY in water mode: the material is a
  // tenth ShaderMaterial and a program that only ever compiles on the first
  // glue shot is a program that fails mid-match. Building it at boot means a
  // compile problem shows up on the loading screen instead.
  // =========================================================================

  const STRAND_SEGMENTS = Math.max(6, Math.min(24, WATER.glue.segments));
  /** Strands live at once. Two per glued player, so this is ~4 pairs. */
  const strandCap = water
    ? (ctx.quality === "low" ? 4 : ctx.quality === "medium" ? 6 : 8)
    : 0;

  interface Strand {
    mesh: THREE.Mesh;
    geo: THREE.BufferGeometry;
    pos: Float32Array;
    glow: Float32Array;
    posAttr: THREE.BufferAttribute;
    glowAttr: THREE.BufferAttribute;
    a: THREE.Vector3;
    b: THREE.Vector3;
    stretch: number;
    active: boolean;
    /** -1 while intact; 0..1 through the snap animation. */
    snapT: number;
    /** Decorrelates the wobble so two strands never ripple in lockstep. */
    phase: number;
    /** Monotonic acquire order, so stealing takes genuinely the oldest. */
    stamp: number;
    handle: GlueStrandHandle;
  }

  const strands: Strand[] = [];
  let strandStamp = 0;
  let glueMat: THREE.ShaderMaterial | null = null;

  if (strandCap > 0) {
    glueMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime, uFogColor, uFogParams, uFogKind,
        uColor: { value: new THREE.Color().setHex(WATER.glue.color, THREE.SRGBColorSpace) },
        uGlowColor: {
          value: new THREE.Color().setHex(WATER.glue.glowColor, THREE.SRGBColorSpace),
        },
      },
      vertexShader: GLUE_VERT,
      fragmentShader: GLUE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    materials.push(glueMat);

    for (let s = 0; s < strandCap; s++) {
      const verts = (STRAND_SEGMENTS + 1) * 2;
      const pos = new Float32Array(verts * 3);
      const uvs = new Float32Array(verts * 2);
      const glow = new Float32Array(verts);
      const index = new Uint16Array(STRAND_SEGMENTS * 6);
      for (let i = 0; i <= STRAND_SEGMENTS; i++) {
        const u = i / STRAND_SEGMENTS;
        uvs[i * 4] = u; uvs[i * 4 + 1] = 0;
        uvs[i * 4 + 2] = u; uvs[i * 4 + 3] = 1;
      }
      for (let i = 0; i < STRAND_SEGMENTS; i++) {
        const v0 = i * 2;
        index.set([v0, v0 + 1, v0 + 3, v0, v0 + 3, v0 + 2], i * 6);
      }
      const geo = new THREE.BufferGeometry();
      const posAttr = new THREE.BufferAttribute(pos, 3);
      const glowAttr = new THREE.BufferAttribute(glow, 1);
      posAttr.setUsage(THREE.DynamicDrawUsage);
      glowAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      geo.setAttribute("position", posAttr);
      geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      geo.setAttribute("aGlow", glowAttr);
      geo.boundingSphere = INFINITE_SPHERE();

      const mesh = new THREE.Mesh(geo, glueMat);
      mesh.name = `vfx.glueStrand.${s}`;
      // Vertices are written in world space, so the model matrix stays
      // identity and `modelViewMatrix` in the shader is just the view matrix.
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.raycast = NO_RAYCAST;
      mesh.renderOrder = 21;
      mesh.visible = false;
      ctx.scene.add(mesh);
      geometries.push(geo);

      const strand: Strand = {
        mesh, geo, pos, glow, posAttr, glowAttr,
        a: new THREE.Vector3(), b: new THREE.Vector3(),
        stretch: 0, active: false, snapT: -1, phase: rng() * 6.283, stamp: 0,
        handle: null as unknown as GlueStrandHandle,
      };
      strand.handle = {
        set(a: THREE.Vector3, b: THREE.Vector3, stretch = 0): void {
          if (!strand.active || strand.snapT >= 0) return;
          strand.a.copy(a);
          strand.b.copy(b);
          strand.stretch = THREE.MathUtils.clamp(stretch, 0, 1);
        },
        snap(): void {
          if (!strand.active || strand.snapT >= 0) return;
          strand.snapT = 0;
          snapSpray(strand);
        },
        release(): void {
          strand.active = false;
          strand.snapT = -1;
          strand.mesh.visible = false;
        },
        get alive(): boolean {
          return strand.active;
        },
      };
      strands.push(strand);
    }
  }

  /**
   * Grab a strand. Prefers an idle slot; steals the oldest live one when the
   * pool is full, which is the same "newest effect wins" rule the particle
   * ring buffers use and is right for the same reason.
   */
  function acquireStrand(a: THREE.Vector3, b: THREE.Vector3): GlueStrandHandle {
    if (strands.length === 0) return DEAD_STRAND;
    let pick: Strand | null = null;
    for (const s of strands) {
      if (!s.active) { pick = s; break; }
    }
    if (!pick) {
      pick = strands[0];
      for (const s of strands) if (s.stamp < pick.stamp) pick = s;
    }
    pick.a.copy(a);
    pick.b.copy(b);
    pick.stretch = 0;
    pick.active = true;
    pick.snapT = -1;
    pick.phase = rng() * 6.283;
    pick.stamp = ++strandStamp;
    pick.mesh.visible = true;
    return pick.handle;
  }

  /** Globs of glue flicked off both ends the instant a strand parts. */
  function snapSpray(s: Strand): void {
    for (const end of [s.a, s.b]) {
      // Glue flicks back toward its own anchor — away from the other end.
      tmpVec4.subVectors(end, end === s.a ? s.b : s.a);
      if (tmpVec4.lengthSq() < 1e-6) tmpVec4.set(0, 1, 0);
      tmpVec4.normalize();
      emitBillboard(bbAdd, end.x, end.y, end.z, 0, 0, 0,
        0.16, 0.12, 0.7, RAMP.glueGlint, 2.6, 0, 0, rr(-3, 3), SPRITE.flare);
      for (let i = 0; i < cnt(5); i++) {
        scatter(tmpVec2, tmpVec4, 0.85);
        const sp = rr(2.5, 7);
        emitBillboard(bbAlpha, end.x, end.y, end.z,
          tmpVec2.x * sp, tmpVec2.y * sp + rr(0.5, 2.5), tmpVec2.z * sp,
          rr(0.5, 1.1), rr(0.04, 0.1), rr(0.02, 0.05),
          RAMP.glueBody, 1.0, -17, 0.5, rr(-8, 8), SPRITE.droplet);
      }
    }
    tmpVec4.addVectors(s.a, s.b).multiplyScalar(0.5);
    safeAudio(WATER.glue.soundSnap, tmpVec4, 0.45, rr(0.94, 1.08));
  }

  /**
   * Rebuild every live strand's ribbon. Camera-dependent (the ribbon expands
   * toward the viewer), so this runs once per FRAME, not per fixed step —
   * there is no physics in here, only shape.
   */
  function stepStrands(dt: number): void {
    if (strands.length === 0) return;
    const cam = ctx.services.player?.camera ?? ctx.camera;
    const t = ctx.elapsed;
    for (const s of strands) {
      if (!s.active) continue;

      if (s.snapT >= 0) {
        // 0.28 s of recoil. Long enough to see the flick, short enough that
        // the player is already moving again by the time it clears.
        s.snapT += dt / 0.28;
        if (s.snapT >= 1) {
          s.active = false;
          s.snapT = -1;
          s.mesh.visible = false;
          continue;
        }
      }

      const snap = s.snapT >= 0 ? s.snapT : 0;
      const span = tmpVec3.subVectors(s.b, s.a).length();
      // A cord under tension goes thin in the MIDDLE, not at its ends.
      // `strandRadius` in mode/water.ts is the physical cord radius; the
      // ribbon has to be a touch wider than that to survive being a flat quad
      // with a soft edge on both sides.
      const baseWidth = WATER.glue.strandRadius * 1.8 * (1 + 0.3 * (1 - s.stretch));
      const sagAmt = WATER.glue.sag * span * (1 - s.stretch) * 0.5;
      const wobble = 0.12 * (1 - s.stretch) * Math.min(1, span * 0.3);

      // The ribbon is widened across the CHORD, not across each segment's own
      // tangent. Over a metre or two of sag the difference is invisible, and
      // using one direction for the whole strand means the ribbon can never
      // twist through itself at an inflection point.
      tmpVec2.subVectors(s.b, s.a);
      if (tmpVec2.lengthSq() < 1e-8) tmpVec2.set(1, 0, 0);
      tmpVec2.normalize();

      for (let i = 0; i <= STRAND_SEGMENTS; i++) {
        const u = i / STRAND_SEGMENTS;
        const bulge = Math.sin(Math.PI * u);
        tmpVec.lerpVectors(s.a, s.b, u);
        tmpVec.y -= sagAmt * 4 * u * (1 - u);
        // Wobble across the strand, biggest at the middle, so a slack cord
        // swings instead of hanging like a wire.
        tmpVec.x += Math.sin(t * 6.1 + u * 9.4 + s.phase) * wobble * bulge;
        tmpVec.z += Math.cos(t * 5.3 + u * 8.1 + s.phase * 1.7) * wobble * bulge;
        if (snap > 0) {
          // Each half recoils to its own anchor, accelerating as it goes.
          tmpVec.lerp(u < 0.5 ? s.a : s.b, snap * snap);
        }

        // Ribbon side vector: perpendicular to both the strand and the view.
        tmpVec3.subVectors(cam.position, tmpVec);
        tmpVec4.crossVectors(tmpVec2, tmpVec3);
        if (tmpVec4.lengthSq() < 1e-8) tmpVec4.set(0, 1, 0);
        tmpVec4.normalize();

        const w = baseWidth * (1 - 0.55 * s.stretch * bulge) * (1 - snap * 0.5);
        const o = i * 6;
        s.pos[o] = tmpVec.x - tmpVec4.x * w;
        s.pos[o + 1] = tmpVec.y - tmpVec4.y * w;
        s.pos[o + 2] = tmpVec.z - tmpVec4.z * w;
        s.pos[o + 3] = tmpVec.x + tmpVec4.x * w;
        s.pos[o + 4] = tmpVec.y + tmpVec4.y * w;
        s.pos[o + 5] = tmpVec.z + tmpVec4.z * w;

        // Tension brightens it; the snap eats it from the middle outward so
        // the break is visibly a break and not a fade.
        let g = 0.85 + 0.5 * s.stretch;
        if (snap > 0) {
          const gap = snap * 1.15;
          g *= (1 - snap)
            * THREE.MathUtils.smoothstep(Math.abs(u - 0.5) * 2, gap * 0.5, gap + 0.03);
          g *= 1 + 2.4 * (1 - snap);
        }
        s.glow[i * 2] = g;
        s.glow[i * 2 + 1] = g;
      }
      s.posAttr.needsUpdate = true;
      s.glowAttr.needsUpdate = true;
    }
  }

  // =========================================================================
  // Camera feedback: trauma shake + FOV punch
  // =========================================================================

  let trauma = 0;
  let fovPunch = 0;
  let fovApplied = 0;
  const shakeOffset = new THREE.Vector3();

  /** Anything can request shake by emitting "dz:shake". */
  const offShake = ctx.on("dz:shake", (payload) => {
    if (typeof payload === "number") {
      trauma = Math.min(1, trauma + Math.max(0, payload));
      return;
    }
    const p = payload as { amount?: number; point?: THREE.Vector3; range?: number } | null;
    if (!p) return;
    const amount = Math.max(0, p.amount ?? 0);
    if (p.point) {
      addShakeFrom(p.point, amount, p.range ?? 40);
    } else {
      trauma = Math.min(1, trauma + amount);
    }
  });

  /** Adds trauma scaled by distance from the player — near blasts hit hardest. */
  function addShakeFrom(point: THREE.Vector3, strength: number, range: number): void {
    const cam = ctx.services.player?.camera ?? ctx.camera;
    const d = cam.position.distanceTo(point);
    const falloff = Math.max(0, 1 - d / Math.max(range, 0.001));
    if (falloff <= 0) return;
    // Squared falloff: a blast at the edge of the range should be a nudge,
    // not a tremor, or the whole screen shakes constantly in a busy fight.
    const amount = strength * falloff * falloff;
    trauma = Math.min(1, trauma + amount);
    fovPunch = Math.min(9, fovPunch + amount * 7);
  }

  const offFlash = ctx.on("dz:flash", (payload) => {
    const p = payload as {
      color?: number; strength?: number; duration?: number;
      additive?: boolean; vignette?: number; dir?: [number, number];
    } | null;
    if (!p) return;
    screenFlash(
      p.color ?? 0xffffff,
      Math.max(0, Math.min(1, p.strength ?? 0.4)),
      p.duration ?? 0.25,
      !!p.additive,
      p.vignette ?? 1,
      p.dir ? p.dir[0] : 0,
      p.dir ? p.dir[1] : 0,
    );
  });

  /**
   * The player took a hit. `angle` is the bearing to the shooter relative to
   * where the player is looking, which converts straight into a screen-space
   * direction for the vignette bias — so the flash is brighter on the side the
   * shot came from and the player turns the right way before reading the HUD.
   */
  const offHit = ctx.on("dz:hit", (payload) => {
    const p = payload as { amount?: number; angle?: number; shield?: boolean } | null;
    if (!p) return;
    const amount = Math.max(0, p.amount ?? 0);
    const strength = Math.min(0.62, 0.16 + amount / 190);
    const ang = p.angle ?? 0;
    screenFlash(
      p.shield ? 0x3f8fd6 : 0xd41f16,
      strength, 0.34, false, 1,
      Math.sin(ang), -Math.cos(ang) * 0.55,
    );
    trauma = Math.min(1, trauma + Math.min(0.28, amount * 0.0035));
  });

  // Soft particles need a scene depth texture; postfx publishes one if it has
  // it. Until then we render hard-edged, which is correct-looking — just less
  // forgiving where smoke meets the ground.
  const offDepth = ctx.on("dz:depth", (payload) => {
    const tex = (payload as THREE.Texture | null) ?? null;
    for (const layer of [bbAdd, bbAlpha]) {
      layer.material.uniforms.uDepth.value = tex;
      if (tex && !layer.material.defines.SOFT) {
        layer.material.defines.SOFT = "1";
        layer.material.needsUpdate = true;
      } else if (!tex && layer.material.defines.SOFT) {
        delete layer.material.defines.SOFT;
        layer.material.needsUpdate = true;
      }
    }
  });

  // =========================================================================
  // Helpers shared by the effect recipes
  // =========================================================================

  /** Ground height under a point, falling back to the point itself. */
  function groundY(x: number, z: number, fallback: number): number {
    const t = ctx.services.terrain;
    return t ? t.heightAt(x, z) : fallback;
  }

  /** Terrain normal, defaulting to straight up. */
  function groundNormal(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const t = ctx.services.terrain;
    if (t) return t.normalAt(x, z, out);
    return out.set(0, 1, 0);
  }

  /** Audio is another module's business; never let a missing bank throw here. */
  function safeAudio(name: string, position: THREE.Vector3, volume: number, rate = 1): void {
    const a = ctx.services.audio;
    if (!a) return;
    try {
      a.play(name, { position, volume, rate });
    } catch {
      /* a stub bank that does not know this cue is not our problem */
    }
  }

  /** Random unit vector, biased into the hemisphere around `n` when given. */
  function scatter(out: THREE.Vector3, n?: THREE.Vector3, spread = 1): THREE.Vector3 {
    const a = rng() * Math.PI * 2;
    const z = rr(-1, 1);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.set(Math.cos(a) * r, z, Math.sin(a) * r);
    if (n) {
      // Fold into the normal's hemisphere first — lerping an exactly opposed
      // direction would cancel to zero and normalize() would hand back NaN.
      if (out.dot(n) < 0) out.negate();
      out.lerp(n, 1 - spread * 0.5);
      if (out.lengthSq() < 1e-8) out.copy(n);
      out.normalize();
    }
    return out;
  }

  /** Squared distance from the active camera — used to cull distant detail. */
  function camDistSq(x: number, y: number, z: number): number {
    const cam = ctx.services.player?.camera ?? ctx.camera;
    const dx = cam.position.x - x;
    const dy = cam.position.y - y;
    const dz = cam.position.z - z;
    return dx * dx + dy * dy + dz * dz;
  }

  // A chain reaction must not be allowed to spend the entire particle budget
  // in a single tick, or the third barrel in a row spawns into a ring buffer
  // it has already overwritten and the whole burst flickers.
  let blastsThisFrame = 0;

  // =========================================================================
  // Effect recipes
  //
  // These are function declarations rather than consts so that the service
  // object published at the top of the factory can delegate to them.
  // =========================================================================

  /**
   * The set piece. Layered in the order the eye reads them, which is also the
   * order they must appear in time:
   *
   *   1. a core flash that expands and is gone inside 80 ms — the physical
   *      cue that light was emitted, and the thing that hides frame one
   *   2. a fireball of rolling noise-driven smoke that cools from
   *      incandescent white through orange to black over its whole life
   *   3. an additive glow riding on the same volume for the first moments
   *   4. a ground shockwave ring, a slower dust wall behind it, and a scorch
   *      decal that stays on the level long after the blast is gone
   *   5. radial sparks with gravity, and solid debris that bounces
   *   6. a lingering column of black smoke that rises and drifts on the wind
   *   7. a brief point light, camera trauma and a white screen pop
   */
  function doExplosion(point: THREE.Vector3, scale = 1): void {
    // In SOAKED there is no combustion anywhere on the island. Everything that
    // used to detonate bursts instead, at the same authored scale, so callers
    // that already pass a sensible blast size need no changes at all.
    if (water) {
      doBalloonBurst(point, { radius: WATER.balloon.radius * THREE.MathUtils.clamp(scale, 0.3, 4) });
      return;
    }
    const s = THREE.MathUtils.clamp(scale, 0.3, 7);
    blastsThisFrame++;
    // Chain reactions taper hard after the third blast in one frame.
    const busy = blastsThisFrame > 3 ? 0.3 : blastsThisFrame > 1 ? 0.68 : 1;
    const q = D * busy;
    const n = (v: number) => Math.max(1, Math.round(v * q));

    const px = point.x;
    const py = point.y;
    const pz = point.z;

    const terrain = ctx.services.terrain;
    const gy = groundY(px, pz, py);
    const nearGround = py - gy < 4.5 * s;
    const sea = terrain?.seaLevel ?? 0;
    const inWater = !!terrain?.isWater(px, pz) && py < sea + 2.5 * s;
    const gn = groundNormal(px, pz, surfaceNormal);

    // --- 1. Core flash ------------------------------------------------------
    // 110 ms at unit scale. Longer than that and it stops reading as a
    // detonation and starts reading as a flare being lit.
    emitBillboard(bbAdd, px, py, pz, 0, 0, 0,
      0.08 + 0.03 * s, 2.4 * s, 14 * s, RAMP.flash, 4.6, 0, 0, rr(-3, 3), SPRITE.flare);
    emitBillboard(bbAdd, px, py, pz, 0, 0, 0,
      0.06 + 0.02 * s, 1.2 * s, 22 * s, RAMP.flash, 3.2, 0, 0, rr(-3, 3), SPRITE.streakFlare);
    for (let i = 0; i < n(3); i++) {
      scatter(tmpVec2);
      emitBillboard(bbAdd,
        px + tmpVec2.x * s, py + tmpVec2.y * s * 0.6, pz + tmpVec2.z * s,
        tmpVec2.x * 6 * s, tmpVec2.y * 5 * s, tmpVec2.z * 6 * s,
        0.15 + 0.05 * s, 1.6 * s, 7 * s, RAMP.flash, 2.6, 0, 2.2, rr(-4, 4), SPRITE.glow);
    }

    // --- 2. Fireball, cooling into smoke ------------------------------------
    const ballCount = n(10 + 7 * s);
    for (let i = 0; i < ballCount; i++) {
      scatter(tmpVec2);
      const sp = rr(2.5, 9) * Math.pow(s, 0.75);
      const up = rr(0.15, 1.0);
      emitBillboard(bbAlpha,
        px + tmpVec2.x * s * 0.6, py + tmpVec2.y * s * 0.4 + 0.4 * s, pz + tmpVec2.z * s * 0.6,
        tmpVec2.x * sp, tmpVec2.y * sp * 0.55 + up * sp * 0.6, tmpVec2.z * sp,
        rr(1.5, 2.8) * Math.pow(s, 0.35),
        2.0 * s, rr(7, 11) * s,
        RAMP.fireSmoke, 1.05,
        2.6, 1.5, rr(-1.6, 1.6),
        // Alternate the two smoke sprites so the ball never visibly tiles.
        i % 2 === 0 ? SPRITE.smoke : SPRITE.smoke2);
    }
    // --- 3. Incandescent glow on the same volume ----------------------------
    for (let i = 0; i < n(7 + 4 * s); i++) {
      scatter(tmpVec2);
      const sp = rr(2, 8) * Math.pow(s, 0.7);
      emitBillboard(bbAdd,
        px + tmpVec2.x * s * 0.5, py + tmpVec2.y * s * 0.35 + 0.3 * s, pz + tmpVec2.z * s * 0.5,
        tmpVec2.x * sp, tmpVec2.y * sp * 0.5 + sp * 0.5, tmpVec2.z * sp,
        rr(0.4, 0.85), 2.2 * s, 6.5 * s, RAMP.fire, 2.0, 3.4, 1.9, rr(-2, 2), SPRITE.glow);
    }
    // Rising fire column — the part that keeps burning after the flash dies.
    for (let i = 0; i < n(3 + 2 * s); i++) {
      emitBillboard(bbAlpha,
        px + rr(-0.5, 0.5) * s, py + rr(0.2, 1.4) * s, pz + rr(-0.5, 0.5) * s,
        rr(-1, 1) * s, rr(2, 5) * s, rr(-1, 1) * s,
        rr(2.4, 3.6), 2.6 * s, rr(9, 14) * s,
        RAMP.fireSmoke, 0.95, 3.2, 1.1, rr(-1, 1), SPRITE.smoke, i * 0.045);
    }

    // --- 4. Point light -----------------------------------------------------
    // Tuned against the sky module's key sun: for a fraction of a second the
    // blast must visibly out-light the sun, or it reads as a decal.
    flashLight(px, py + 0.6 * s, pz, 0xffb367, 620 * s * s, 34 * s, 0.55 + 0.22 * s, 0.35);

    // --- 5. Ground / water interaction --------------------------------------
    if (inWater) {
      const wy = sea + 0.05;
      emitRing(ringAdd, px, wy, pz, UNIT_Y, 1.3 + 0.3 * s, 1.2 * s, 16 * s, RAMP.water, 1.1, 0.78);
      emitRing(ringDust, px, wy, pz, UNIT_Y, 2.2 + 0.4 * s, 1.6 * s, 24 * s, RAMP.water, 0.9, 0.86);
      for (let i = 0; i < n(16 + 8 * s); i++) {
        const a = rng() * Math.PI * 2;
        const rad = rr(0.2, 1.4) * s;
        const sp = rr(6, 20) * Math.pow(s, 0.6);
        emitStreak(px + Math.cos(a) * rad, wy, pz + Math.sin(a) * rad,
          Math.cos(a) * sp * 0.45, sp * rr(0.8, 1.5), Math.sin(a) * sp * 0.45,
          0, -24, 0, rr(0.8, 1.6), 0.06 * s, 2.2 * s, RAMP.water, 1.4);
      }
      for (let i = 0; i < n(12 + 6 * s); i++) {
        const a = rng() * Math.PI * 2;
        emitBillboard(bbAlpha,
          px + Math.cos(a) * rr(0, 2) * s, wy, pz + Math.sin(a) * rr(0, 2) * s,
          Math.cos(a) * rr(2, 9) * s, rr(4, 13) * s, Math.sin(a) * rr(2, 9) * s,
          rr(1.4, 2.6), 1.4 * s, 5 * s, RAMP.water, 1.0, -3.5, 1.2, rr(-1, 1), SPRITE.droplet);
      }
      // Steam where the fireball meets the surface.
      for (let i = 0; i < n(5 + 3 * s); i++) {
        emitBillboard(bbAlpha,
          px + rr(-1.5, 1.5) * s, wy + rr(0, 0.6), pz + rr(-1.5, 1.5) * s,
          rr(-1.5, 1.5), rr(1.5, 4), rr(-1.5, 1.5),
          rr(2.2, 4.0), 1.8 * s, rr(7, 11) * s,
          RAMP.steam, 1.0, 1.4, 1.2, rr(-0.8, 0.8), SPRITE.smoke2, 0.1 + i * 0.05);
      }
    } else if (nearGround) {
      // Fast white shockwave first, then the slow dust wall behind it — two
      // separate speeds is what makes a blast read as pressure rather than
      // as one animated ring.
      emitRing(ringAdd, px, gy + 0.08, pz, gn,
        0.32 + 0.08 * s, 1.0 * s, 22 * s, RAMP.shock, 2.4, 0.9, 0, null, 1.1);
      emitRing(ringDust, px, gy + 0.06, pz, gn,
        1.15 + 0.35 * s, 1.6 * s, 19 * s, RAMP.dust, 1.0, 0.5, 0, null, 0.7);
      emitRing(ringDust, px, gy + 0.05, pz, gn,
        1.9 + 0.4 * s, 3 * s, 27 * s, RAMP.dust, 0.7, 0.72, 0.18, null, 0.5);

      // Dust hugging the deck, thrown outward and low.
      for (let i = 0; i < n(12 + 6 * s); i++) {
        const a = rng() * Math.PI * 2;
        const sp = rr(7, 18) * Math.pow(s, 0.6);
        emitBillboard(bbAlpha,
          px + Math.cos(a) * s * 0.8, gy + rr(0.1, 0.8) * s, pz + Math.sin(a) * s * 0.8,
          Math.cos(a) * sp, rr(0.4, 2.4), Math.sin(a) * sp,
          rr(1.6, 3.2), 1.6 * s, rr(7, 12) * s,
          RAMP.dust, 1.0, 0.9, 2.4, rr(-1, 1), i % 3 === 0 ? SPRITE.grit : SPRITE.dust);
      }
      // Scorch the ground. This is the part of an explosion the player still
      // sees two minutes later, and it is what makes the level remember.
      emitDecal(px, gy, pz, gn,
        rr(3.2, 4.6) * s,
        s > 1.6 ? DECAL.scorch : DECAL.scorchSmall,
        110, 0xffffff, 0.92);
      if (s > 1.2) {
        for (let i = 0; i < n(3); i++) {
          const a = rng() * Math.PI * 2;
          const d = rr(1.5, 4) * s;
          const sx = px + Math.cos(a) * d;
          const sz = pz + Math.sin(a) * d;
          emitDecal(sx, groundY(sx, sz, gy), sz, gn,
            rr(1.2, 2.4) * s, DECAL.soot, 90, 0xffffff, 0.55);
        }
      }
    }

    // --- 6. Sparks + debris --------------------------------------------------
    for (let i = 0; i < n(18 + 10 * s); i++) {
      scatter(tmpVec2);
      const sp = rr(12, 42) * Math.pow(s, 0.45);
      emitStreak(px, py, pz,
        tmpVec2.x * sp, Math.abs(tmpVec2.y) * sp * 0.9 + rr(2, 9), tmpVec2.z * sp,
        0, -26, 0,
        rr(0.45, 1.35), rr(0.03, 0.07), rr(2.2, 4.5),
        RAMP.spark, rr(1.6, 3.0));
    }
    const chunkN = Math.min(debrisCap, n(4 + 4 * s));
    for (let i = 0; i < chunkN; i++) {
      scatter(tmpVec2);
      const sp = rr(9, 26) * Math.pow(s, 0.5);
      const size = rr(0.16, 0.44) * Math.pow(s, 0.4);
      emitDebris(debrisRubble, px, py + 0.4 * s, pz,
        tmpVec2.x * sp, Math.abs(tmpVec2.y) * sp * 0.8 + rr(4, 12), tmpVec2.z * sp,
        size, rr(0.7, 1.3), rr(0.7, 1.3), rr(0.7, 1.3),
        rng() < 0.4 ? 0x2a2724 : 0x6a625a,
        rng() < 0.55 ? 1 : 0,
        rr(3.5, 6.5), RAMP.dust);
    }

    // --- 7. Lingering smoke, embers and heat shimmer -------------------------
    const smokeN = n(6 + 4 * s);
    for (let i = 0; i < smokeN; i++) {
      scatter(tmpVec2);
      emitBillboard(bbAlpha,
        px + tmpVec2.x * s * 1.2, py + rr(0.3, 2.2) * s, pz + tmpVec2.z * s * 1.2,
        tmpVec2.x * rr(0.6, 2.6), rr(1.2, 3.4), tmpVec2.z * rr(0.6, 2.6),
        rr(4.5, 8.5), 3.5 * s, rr(13, 20) * s,
        RAMP.smokeDark, 1.0, 0.55, 0.75, rr(-0.5, 0.5),
        i % 2 === 0 ? SPRITE.smoke : SPRITE.wisp, 0.25 + i * 0.09);
    }
    for (let i = 0; i < n(2 + s); i++) {
      emitBillboard(bbAdd,
        px + rr(-1, 1) * s, py + rr(0.5, 2) * s, pz + rr(-1, 1) * s,
        rr(-0.6, 0.6), rr(1.5, 3.5), rr(-0.6, 0.6),
        rr(1.2, 2.2), 3 * s, 10 * s, RAMP.haze, 1.0, 2.2, 0.9, rr(-0.6, 0.6),
        SPRITE.dust);
    }
    for (let i = 0; i < n(6 + 3 * s); i++) {
      scatter(tmpVec2);
      emitBillboard(bbAdd,
        px + tmpVec2.x * s, py + rr(0, 1.5) * s, pz + tmpVec2.z * s,
        tmpVec2.x * rr(1, 5), rr(1.5, 6), tmpVec2.z * rr(1, 5),
        rr(1.4, 3.4), rr(0.1, 0.26) * s, rr(0.04, 0.1) * s,
        RAMP.ember, rr(1.8, 3.2), 1.2, 1.1, 0, SPRITE.spark);
    }

    // --- Player feedback ------------------------------------------------------
    // Emitted rather than applied directly: our own listener turns it into
    // trauma, and postfx/HUD get to hear the same event. Applying it here as
    // well would double every blast's shake.
    ctx.emit("dz:shake", { amount: 0.55 + 0.2 * s, point, range: 46 * s });
    // A close blast washes the screen for an instant. Additive and short:
    // long enough to punctuate, far too short to blind.
    const near = camDistSq(px, py, pz);
    const nearK = Math.max(0, 1 - Math.sqrt(near) / (26 * s));
    if (nearK > 0.02) {
      screenFlash(0xffd8a8, Math.min(0.55, 0.5 * nearK * s), 0.16, true, 0.25, 0, 0);
    }
    safeAudio("explosion", point, Math.min(1, 0.45 * s), rr(0.9, 1.1));
  }

  /**
   * Surface-specific hit. Nine materials, and every branch except water leaves
   * a decal, so a firefight writes its own history onto the level.
   */
  function doImpact(
    point: THREE.Vector3, normal: THREE.Vector3, material: ImpactMaterial = "concrete",
  ): void {
    // Splash replaces the impact family wholesale. Routing it here rather than
    // asking every caller to switch means weapons, bots, the player's own
    // footfalls and anything else that already reports a surface hit come out
    // wet with no changes on their side.
    if (water) {
      doSplash(point, normal, { surface: material });
      return;
    }
    const p = IMPACTS[material] ?? IMPACTS.concrete;
    const px = point.x;
    const py = point.y;
    const pz = point.z;
    const n = tmpVec3.copy(normal);
    if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
    n.normalize();

    // Impacts are the most frequent effect in the game by an order of
    // magnitude, so anything past 140 m gets a cut-down version: no chips, no
    // rubble, no decal. At that range none of it resolves anyway.
    const far = camDistSq(px, py, pz) > 140 * 140;

    // --- Hit flash: the readability cue that something was struck ------------
    if (p.flash > 0) {
      emitBillboard(bbAdd,
        px + n.x * 0.05, py + n.y * 0.05, pz + n.z * 0.05,
        0, 0, 0, 0.06, 0.35 * p.flash, 0.9 * p.flash,
        p.flashRamp, 2.4 * p.flash, 0, 0, rr(-3, 3), SPRITE.flare);
    }

    // --- Surface puff --------------------------------------------------------
    for (let i = 0; i < cnt(p.puffCount); i++) {
      scatter(tmpVec2, n, 0.75);
      const sp = p.puffSpeed * rr(0.5, 1.5);
      emitBillboard(bbAlpha,
        px + n.x * 0.06, py + n.y * 0.06, pz + n.z * 0.06,
        tmpVec2.x * sp, tmpVec2.y * sp + 0.6, tmpVec2.z * sp,
        p.puffLife * rr(0.7, 1.4),
        p.puffSize * rr(0.5, 0.9), p.puffSize * rr(2.4, 4.2),
        p.puffRamp, 1.0, material === "water" ? -1.5 : 0.35, p.puffDrag, rr(-2, 2),
        p.puffSprite);
    }

    // --- Chips / splinters / shards ------------------------------------------
    if (!far) {
      for (let i = 0; i < cnt(p.chipCount); i++) {
        scatter(tmpVec2, n, 0.9);
        const sp = rr(3, 9);
        emitBillboard(bbAlpha,
          px + n.x * 0.05, py + n.y * 0.05, pz + n.z * 0.05,
          tmpVec2.x * sp, tmpVec2.y * sp + rr(0.5, 3), tmpVec2.z * sp,
          rr(0.5, 1.1), rr(0.03, 0.08), rr(0.02, 0.05),
          p.chipRamp, 1.0, -14, 0.6, rr(-11, 11), p.chipSprite);
      }
    }

    // --- Sparks / droplets ---------------------------------------------------
    for (let i = 0; i < cnt(p.sparkCount); i++) {
      scatter(tmpVec2, n, 0.85);
      const sp = p.sparkSpeed * rr(0.45, 1.6);
      emitStreak(px + n.x * 0.04, py + n.y * 0.04, pz + n.z * 0.04,
        tmpVec2.x * sp, tmpVec2.y * sp + rr(0, 3), tmpVec2.z * sp,
        0, material === "water" ? -18 : -24, 0,
        p.sparkLife * rr(0.6, 1.4), p.sparkWidth * rr(0.7, 1.4), rr(1.4, 3.2),
        p.sparkRamp, rr(1.3, 2.6));
    }

    // --- Solid ejecta: only the materials that actually shed lumps ------------
    if (!far && p.rubble > 0) {
      for (let i = 0; i < cnt(p.rubble); i++) {
        scatter(tmpVec2, n, 0.8);
        const sp = rr(3, 8);
        emitDebris(debrisRubble,
          px + n.x * 0.06, py + n.y * 0.06, pz + n.z * 0.06,
          tmpVec2.x * sp, tmpVec2.y * sp + rr(1, 4), tmpVec2.z * sp,
          rr(0.05, 0.11), rr(0.7, 1.3), rr(0.7, 1.3), rr(0.7, 1.3),
          p.rubbleColor, 0, rr(1.6, 3.0), p.puffRamp);
      }
    }

    // --- Ring: metal ping, glass flash, water ripple, sand rim ----------------
    if (p.ring > 0) {
      const layer = p.ringAdditive ? ringAdd : ringDust;
      if (material === "water") {
        const sea = ctx.services.terrain?.seaLevel ?? py;
        emitRing(layer, px, sea + 0.03, pz, UNIT_Y, 1.5, 0.25, p.ring * 3.2,
          p.ringRamp, 0.8, 0.86);
        emitRing(layer, px, sea + 0.03, pz, UNIT_Y, 2.4, 0.4, p.ring * 5.5,
          p.ringRamp, 0.5, 0.9, 0.22);
      } else {
        emitRing(layer, px + n.x * 0.03, py + n.y * 0.03, pz + n.z * 0.03, n,
          0.28, 0.06, p.ring, p.ringRamp, 1.8, 0.7);
      }
    }

    // --- Decal ----------------------------------------------------------------
    if (!far && p.decals.length > 0) {
      const cell = p.decals[(rng() * p.decals.length) | 0];
      emitDecal(px, py, pz, n, p.decalSize * rr(0.8, 1.35), cell, p.decalLife,
        p.decalTint, rr(0.7, 1));
    }

    safeAudio(p.sound, point, 0.35, rr(0.88, 1.15));
  }

  /**
   * Tracer: a stretched additive bolt that TRAVELS the path over a few frames
   * rather than appearing along its whole length at once.
   *
   * The bolt also droops and drifts very slightly. Real tracers do, and more
   * importantly a dead-straight line at a constant width reads as a laser
   * pointer; a bolt that sags reads as a projectile with mass. The sag is
   * solved for rather than integrated, so the head still lands exactly on the
   * point the raycast reported:
   *
   *   p(t) = from + v·t + ½·a·t²   with   v = (to − from)/life − ½·a·life
   */
  function doTracer(
    from: THREE.Vector3, to: THREE.Vector3,
    opts?: { width?: number; color?: THREE.Color },
  ): void {
    // A soaker fires water, not a tracer round. Same two endpoints, same
    // solved-trajectory idea, entirely different read.
    if (water) {
      doWaterStream(from, to, {
        width: opts?.width,
        color: opts?.color ? opts.color.getHex(THREE.SRGBColorSpace) : undefined,
      });
      return;
    }

    tmpVec.subVectors(to, from);
    const dist = tmpVec.length();
    // Below a couple of metres the tracer is a single frame of a two-pixel
    // line: it costs a slot and reads as a glitch.
    if (dist < 2.5) return;
    // Roughly 460 m/s of apparent travel, clamped so a point-blank shot still
    // gets one visible frame and a 400 m shot does not hang in the air.
    const life = THREE.MathUtils.clamp(dist / 460, 0.028, 0.42);
    const width = opts?.width ?? 0.055;
    const color = opts?.color ?? null;

    tmpVec2.copy(tmpVec).normalize();
    tmpVec3.set(-tmpVec2.z, 0, tmpVec2.x);
    if (tmpVec3.lengthSq() < 1e-6) tmpVec3.set(1, 0, 0);
    tmpVec3.normalize();
    const sag = rr(-1, 1) * dist * 0.35;
    const ax = tmpVec3.x * sag;
    const ay = -9;
    const az = tmpVec3.z * sag;
    const vx = tmpVec.x / life - 0.5 * ax * life;
    const vy = tmpVec.y / life - 0.5 * ay * life;
    const vz = tmpVec.z / life - 0.5 * az * life;

    const len = Math.min(dist * 0.55, 7 + dist * 0.045);
    // Two passes: a hot narrow head and a wide dim core. The pair fakes a
    // bloom without needing the postfx system to have booted.
    emitStreak(from.x, from.y, from.z, vx, vy, vz, ax, ay, az,
      life, width, len, RAMP.spark, 2.8, 0, color);
    emitStreak(from.x, from.y, from.z, vx, vy, vz, ax, ay, az,
      life, width * 2.9, len * 0.7, RAMP.spark, 0.55, 0, color);
  }

  /**
   * Muzzle flash. `matrix` is the muzzle transform; three's convention puts an
   * object's forward on -Z, so that is the direction the gases go.
   */
  function doMuzzleFlash(matrix: THREE.Matrix4, scale = 1): void {
    if (water) {
      doNozzleSpritz(matrix, scale);
      return;
    }
    const e = matrix.elements;
    const px = e[12];
    const py = e[13];
    const pz = e[14];
    // -Z basis column, normalised (the matrix may carry scale).
    tmpVec.set(-e[8], -e[9], -e[10]);
    const fl = tmpVec.length();
    if (fl < 1e-6) tmpVec.set(0, 0, -1);
    else tmpVec.divideScalar(fl);
    const s = THREE.MathUtils.clamp(scale, 0.25, 4);

    // Star flare plus a horizontal lens streak, both with a random roll so
    // repeat fire never strobes into a single static shape.
    emitBillboard(bbAdd, px + tmpVec.x * 0.12, py + tmpVec.y * 0.12, pz + tmpVec.z * 0.12,
      tmpVec.x * 2, tmpVec.y * 2, tmpVec.z * 2,
      0.045, 0.75 * s, 1.15 * s, RAMP.flash, 4.8, 0, 0, rr(-8, 8), SPRITE.flare);
    emitBillboard(bbAdd, px + tmpVec.x * 0.16, py + tmpVec.y * 0.16, pz + tmpVec.z * 0.16,
      tmpVec.x * 2, tmpVec.y * 2, tmpVec.z * 2,
      0.04, 1.1 * s, 1.5 * s, RAMP.flash, 2.4, 0, 0, rr(-0.5, 0.5), SPRITE.streakFlare);
    emitBillboard(bbAdd, px + tmpVec.x * 0.3, py + tmpVec.y * 0.3, pz + tmpVec.z * 0.3,
      tmpVec.x * 6, tmpVec.y * 6, tmpVec.z * 6,
      0.07, 0.3 * s, 0.85 * s, RAMP.fire, 3.0, 0, 3, rr(-6, 6), SPRITE.glow);

    // Burnt propellant pushed down the barrel line.
    for (let i = 0; i < cnt(3); i++) {
      scatter(tmpVec2, tmpVec, 0.4);
      const sp = rr(3, 9) * s;
      emitBillboard(bbAlpha,
        px + tmpVec.x * 0.2, py + tmpVec.y * 0.2, pz + tmpVec.z * 0.2,
        tmpVec2.x * sp, tmpVec2.y * sp + 0.4, tmpVec2.z * sp,
        rr(0.35, 0.9), 0.1 * s, rr(0.5, 0.9) * s,
        RAMP.smokeLight, 1.0, 0.9, 3.4, rr(-2, 2), SPRITE.wisp);
    }
    // Unburnt powder, thrown forward and falling out fast.
    for (let i = 0; i < cnt(5); i++) {
      scatter(tmpVec2, tmpVec, 0.55);
      const sp = rr(5, 17) * s;
      emitStreak(px + tmpVec.x * 0.15, py + tmpVec.y * 0.15, pz + tmpVec.z * 0.15,
        tmpVec2.x * sp, tmpVec2.y * sp, tmpVec2.z * sp,
        0, -22, 0, rr(0.12, 0.32), 0.022, rr(0.8, 1.8), RAMP.spark, rr(1.4, 2.6));
    }

    flashLight(px + tmpVec.x * 0.3, py + tmpVec.y * 0.3, pz + tmpVec.z * 0.3,
      0xffd9a0, 34 * s * s, 13 * s, 0.055);
  }

  /**
   * Lingering smoke. Staggered spawn delays turn one call into a plume that
   * keeps feeding for a second or two — one call, no timers, no per-frame
   * emitter state to tear down.
   */
  function doSmoke(point: THREE.Vector3, amount = 1): void {
    if (water) {
      doWaterMist(point, amount);
      return;
    }
    const a = THREE.MathUtils.clamp(amount, 0.1, 6);
    const count = cnt(3 + a * 3);
    for (let i = 0; i < count; i++) {
      scatter(tmpVec2);
      emitBillboard(bbAlpha,
        point.x + tmpVec2.x * 0.5 * a, point.y + rr(0, 0.8) * a, point.z + tmpVec2.z * 0.5 * a,
        tmpVec2.x * rr(0.2, 1.1) * a, rr(0.8, 2.2) * a, tmpVec2.z * rr(0.2, 1.1) * a,
        rr(4, 9), rr(0.8, 1.6) * a, rr(4.5, 9) * a,
        RAMP.smokeLight, 1.0, 0.5, 0.9, rr(-0.4, 0.4),
        i % 3 === 0 ? SPRITE.wisp : i % 3 === 1 ? SPRITE.smoke : SPRITE.smoke2,
        i * rr(0.08, 0.24));
    }
  }

  /**
   * Damage numbers.
   *
   * Everything here exists to make the number readable in a quarter of a
   * second while the player is already looking somewhere else:
   *  - it spawns with lateral drift so consecutive hits fan out
   *  - repeats on the same spot stack upward instead of overlapping
   *  - headshots are 40 % larger, gold, and spawn with more rise, because the
   *    size difference is what the player actually registers, not the colour
   *  - the whole number scales past its final size and settles back
   */
  function doDamageNumber(
    point: THREE.Vector3, amount: number, headshot: boolean, shield: boolean,
  ): void {
    // headshot → faceful, shield → poncho. Same three-way split, same slots.
    if (water) {
      doSoakNumber(point, amount, headshot, shield);
      return;
    }
    const value = Math.max(1, Math.min(9999, Math.round(amount)));
    // Beyond ~110 m a damage number is a smudge and only adds clutter.
    if (camDistSq(point.x, point.y, point.z) > 110 * 110) return;

    // Find a recent number close enough to be confused with this one.
    let stack = 0;
    let slot = -1;
    const now = uTime.value;
    for (let i = 0; i < RECENT_CAP; i++) {
      if (now - recentT[i] > 0.55) continue;
      const dx = recentX[i] - point.x;
      const dy = recentY[i] - point.y;
      const dz = recentZ[i] - point.z;
      if (dx * dx + dy * dy + dz * dz < 1.6 * 1.6) {
        stack = Math.min(4, recentStack[i] + 1);
        slot = i;
        break;
      }
    }
    if (slot < 0) {
      slot = recentCursor;
      recentCursor = (recentCursor + 1) % RECENT_CAP;
    }
    recentX[slot] = point.x;
    recentY[slot] = point.y;
    recentZ[slot] = point.z;
    recentT[slot] = now;
    recentStack[slot] = stack;

    const color = tintColor.setHex(
      headshot ? DAMAGE_HEADSHOT : shield ? DAMAGE_SHIELD : DAMAGE_WHITE,
      THREE.SRGBColorSpace,
    );
    const size = (headshot ? 0.5 : 0.36) * (1 + Math.min(0.35, value / 900));
    const life = headshot ? 1.25 : 1.05;
    // Alternate the drift side per stack level so a burst fans out instead of
    // marching in one direction off the target.
    const side = stack % 2 === 0 ? 1 : -1;
    const driftX = rr(0.3, 0.9) * side;
    const driftZ = rr(-0.4, 0.4);
    const rise = (headshot ? 2.5 : 2.0) + stack * 0.25;

    const px = point.x;
    const py = point.y + 0.15 + stack * 0.34;
    const pz = point.z;

    const digits = String(value);
    const count = Math.min(MAX_DIGITS, digits.length);
    for (let i = 0; i < count; i++) {
      const cell = digits.charCodeAt(i) - 48;
      if (cell < 0 || cell > 9) continue;
      // Centre the whole token on the anchor.
      const offset = i - (count - 1) / 2;
      emitGlyph(px, py, pz, driftX, rise, driftZ,
        life, size, -3.4, cell, offset, headshot ? 1.35 : 1.0, color);
    }
  }

  /**
   * The harvest burst: Fortnite's blue shimmer plus flying chips of whatever
   * you just hit.
   *
   * The blue is deliberately not the material colour — it is the game telling
   * you "that swing counted", and it has to read identically on wood, stone
   * and metal. The material identity comes from the chips underneath it.
   */
  function doHarvestBurst(point: THREE.Vector3, kind: HarvestKind): void {
    const look = lookFor(kind);
    const px = point.x;
    const py = point.y;
    const pz = point.z;

    // --- The shimmer ---------------------------------------------------------
    emitBillboard(bbAdd, px, py, pz, 0, 0, 0,
      0.22, 0.35, 1.5, RAMP.harvest, 3.2, 0, 0, rr(-2, 2), SPRITE.flare);
    for (let i = 0; i < cnt(9); i++) {
      scatter(tmpVec2);
      const sp = rr(1.6, 5.5);
      emitBillboard(bbAdd,
        px + tmpVec2.x * 0.1, py + tmpVec2.y * 0.1, pz + tmpVec2.z * 0.1,
        tmpVec2.x * sp, tmpVec2.y * sp + rr(0.5, 2.5), tmpVec2.z * sp,
        rr(0.35, 0.8), rr(0.1, 0.24), rr(0.02, 0.06),
        RAMP.harvest, rr(2.0, 3.4), -1.2, 2.4, rr(-6, 6), SPRITE.sparkle);
    }
    // A small expanding ring on the struck surface, facing the player, so the
    // shimmer has a footprint rather than floating in space.
    const cam = ctx.services.player?.camera ?? ctx.camera;
    tmpVec4.subVectors(cam.position, point);
    if (tmpVec4.lengthSq() < 1e-6) tmpVec4.set(0, 1, 0);
    tmpVec4.normalize();
    emitRing(ringAdd, px + tmpVec4.x * 0.04, py + tmpVec4.y * 0.04, pz + tmpVec4.z * 0.04,
      tmpVec4, 0.34, 0.1, 1.15, RAMP.harvest, 1.9, 0.66);

    // --- The chips -----------------------------------------------------------
    for (let i = 0; i < cnt(8); i++) {
      scatter(tmpVec2, tmpVec4, 0.9);
      const sp = rr(3.5, 9);
      emitBillboard(bbAlpha,
        px, py, pz,
        tmpVec2.x * sp, Math.abs(tmpVec2.y) * sp * 0.6 + rr(1.5, 4.5), tmpVec2.z * sp,
        rr(0.55, 1.15), rr(0.05, 0.11), rr(0.03, 0.07),
        look.ramp, 1.0, -13, 0.7, rr(-12, 12), look.chipSprite);
    }
    // Sparks only where sparks make sense — metal, and a couple off stone.
    for (let i = 0; i < cnt(look.sparks); i++) {
      scatter(tmpVec2, tmpVec4, 0.85);
      const sp = rr(5, 13);
      emitStreak(px, py, pz,
        tmpVec2.x * sp, tmpVec2.y * sp + rr(0, 3), tmpVec2.z * sp,
        0, -24, 0, rr(0.18, 0.45), 0.026, rr(1.0, 2.2), RAMP.spark, rr(1.4, 2.6));
    }
    // One or two solid flecks that actually land on the floor.
    for (let i = 0; i < cnt(2); i++) {
      scatter(tmpVec2, tmpVec4, 0.9);
      const sp = rr(3, 7);
      const layer = look.slab ? debrisSlab : debrisRubble;
      emitDebris(layer, px, py, pz,
        tmpVec2.x * sp, Math.abs(tmpVec2.y) * sp * 0.5 + rr(2, 5), tmpVec2.z * sp,
        rr(0.05, 0.1),
        look.slab ? look.slabLong : rr(0.8, 1.2),
        look.slab ? look.slabThin : rr(0.8, 1.2),
        look.slab ? 1 : rr(0.8, 1.2),
        rng() < 0.5 ? look.base : look.alt, 0, rr(1.8, 3.2), look.ramp);
    }

    // Everything on this island is soaked already: a swing at a pool noodle
    // wrings water out of it. Small, cheap, and it ties the harvest loop into
    // the mode instead of leaving it the one dry thing in the game.
    if (water) {
      const tint = waterTint.setHex(WATER_DEFAULT, THREE.SRGBColorSpace);
      for (let i = 0; i < cnt(4); i++) {
        scatter(tmpVec2, tmpVec4, 0.85);
        const sp = rr(2, 6);
        droplet(px, py, pz,
          tmpVec2.x * sp, Math.abs(tmpVec2.y) * sp * 0.6 + rr(1, 3), tmpVec2.z * sp,
          19, rr(0.35, 0.8), rr(0.02, 0.06), tint, i === 0);
      }
    }

    safeAudio(water ? look.sound : "harvest", point, 0.4, rr(0.94, 1.08));
  }

  /**
   * A built piece died. The box shatters into material-correct debris that
   * falls, bounces and fades, with a dust cloud filling the volume it used to
   * occupy.
   *
   * The chunks are seeded on a lattice inside the box rather than at its
   * centre, and thrown outward from the box centre. That is what makes it read
   * as a wall coming apart instead of a firework going off where a wall was.
   */
  function doBuildBreak(box: THREE.Box3, kind: HarvestKind): void {
    const look = lookFor(kind);
    box.getCenter(tmpVec4);
    box.getSize(tmpVec3);
    const cx = tmpVec4.x;
    const cy = tmpVec4.y;
    const cz = tmpVec4.z;
    const sx = Math.max(0.2, tmpVec3.x);
    const sy = Math.max(0.2, tmpVec3.y);
    const sz = Math.max(0.2, tmpVec3.z);
    // Volume drives the count, so a floor sheds more than a fencepost.
    const vol = sx * sy * sz;
    const chunkN = Math.min(debrisCap, cnt(6 + Math.min(14, vol * 0.55)));
    const chunkSize = Math.min(0.55, Math.max(0.16, Math.cbrt(vol) * 0.16));

    const layer = look.slab ? debrisSlab : debrisRubble;
    for (let i = 0; i < chunkN; i++) {
      // Lattice-ish seeding: jittered stratification, so the chunks come from
      // all over the piece rather than clustering at its middle.
      const fx = (i % 3) / 2 - 0.5 + rr(-0.16, 0.16);
      const fy = (Math.floor(i / 3) % 3) / 2 - 0.5 + rr(-0.16, 0.16);
      const fz = (Math.floor(i / 9) % 3) / 2 - 0.5 + rr(-0.16, 0.16);
      const ox = fx * sx;
      const oy = fy * sy;
      const oz = fz * sz;
      // Outward from the centre, biased upward: a wall bursts, it does not
      // simply collapse, and the upward bias is what gives it a beat.
      tmpVec2.set(ox, oy * 0.5, oz);
      if (tmpVec2.lengthSq() < 1e-6) scatter(tmpVec2);
      else tmpVec2.normalize();
      const sp = rr(2.5, 7.5);
      emitDebris(layer,
        cx + ox, cy + oy, cz + oz,
        tmpVec2.x * sp, Math.abs(tmpVec2.y) * sp * 0.6 + rr(1.5, 5.5), tmpVec2.z * sp,
        chunkSize * rr(0.65, 1.4),
        look.slab ? look.slabLong * rr(0.8, 1.25) : rr(0.7, 1.35),
        look.slab ? look.slabThin * rr(0.7, 1.4) : rr(0.7, 1.35),
        look.slab ? rr(0.8, 1.2) : rr(0.7, 1.35),
        rng() < 0.5 ? look.base : look.alt, 0, rr(3.0, 5.5), look.ramp);
    }

    // Dust filling the volume the piece used to occupy.
    for (let i = 0; i < cnt(8 + vol * 0.4); i++) {
      const ox = rr(-0.5, 0.5) * sx;
      const oy = rr(-0.5, 0.5) * sy;
      const oz = rr(-0.5, 0.5) * sz;
      emitBillboard(bbAlpha,
        cx + ox, cy + oy, cz + oz,
        ox * rr(0.6, 1.8), rr(0.3, 1.8), oz * rr(0.6, 1.8),
        rr(1.1, 2.4), Math.max(sx, sz) * 0.28, Math.max(sx, sz) * rr(1.1, 1.9),
        look.ramp, 1.0, 0.5, 2.2, rr(-1.2, 1.2),
        i % 2 === 0 ? SPRITE.dust : SPRITE.grit);
    }
    // Splinters/spall thrown flat out of the plane of the piece.
    for (let i = 0; i < cnt(10); i++) {
      scatter(tmpVec2);
      const sp = rr(4, 12);
      emitBillboard(bbAlpha,
        cx + rr(-0.5, 0.5) * sx, cy + rr(-0.5, 0.5) * sy, cz + rr(-0.5, 0.5) * sz,
        tmpVec2.x * sp, Math.abs(tmpVec2.y) * sp * 0.7 + rr(1, 4), tmpVec2.z * sp,
        rr(0.6, 1.3), rr(0.06, 0.14), rr(0.04, 0.09),
        look.ramp, 1.0, -12, 0.6, rr(-14, 14), look.chipSprite);
    }
    for (let i = 0; i < cnt(look.sparks); i++) {
      scatter(tmpVec2);
      const sp = rr(6, 15);
      emitStreak(cx, cy, cz,
        tmpVec2.x * sp, tmpVec2.y * sp + rr(0, 4), tmpVec2.z * sp,
        0, -24, 0, rr(0.2, 0.5), 0.028, rr(1.2, 2.6), RAMP.spark, rr(1.3, 2.4));
    }

    // A soaked piece comes apart wet: water is wrung out of the foam and the
    // tarp as they tear, which is the whole reason `sparks` is zero above.
    if (water) {
      const tint = waterTint.setHex(WATER_DEFAULT, THREE.SRGBColorSpace);
      for (let i = 0; i < cnt(6 + vol * 0.2); i++) {
        scatter(tmpVec2);
        const sp = rr(3, 9);
        droplet(cx + rr(-0.5, 0.5) * sx, cy + rr(-0.5, 0.5) * sy, cz + rr(-0.5, 0.5) * sz,
          tmpVec2.x * sp, Math.abs(tmpVec2.y) * sp * 0.6 + rr(1, 4), tmpVec2.z * sp,
          20, rr(0.5, 1.1), rr(0.03, 0.08), tint, i % 2 === 0);
      }
      emitBillboard(bbAdd, cx, cy, cz, 0, 0, 0,
        0.12, 0.2, Math.max(sx, sz) * 1.2, RAMP.wetSheen, 1.6, 0, 0,
        rr(-2, 2), SPRITE.glow, 0, tint);
    }

    tmpVec4.set(cx, cy, cz);
    addShakeFrom(tmpVec4, 0.11, 22);
    safeAudio(look.sound, tmpVec4, 0.5, rr(0.9, 1.12));
  }

  /**
   * Rarity-coloured loot beam. Returns the Object3D so loot.ts owns placement,
   * visibility and removal — it knows which pickups are near enough to be
   * worth a beam and we do not.
   */
  function doLootBeam(point: THREE.Vector3, rarity: Rarity): THREE.Object3D {
    const mats = getBeamMaterials(rarity);
    const group = new THREE.Group();
    group.name = `vfx.lootBeam.${rarity}`;
    group.position.copy(point);

    const beam = new THREE.Mesh(beamGeo, mats.beam);
    beam.frustumCulled = true;
    beam.raycast = NO_RAYCAST;
    beam.renderOrder = 18;
    group.add(beam);

    const glow = new THREE.Mesh(beamGlowGeo, mats.glow);
    // A couple of centimetres off the deck: enough to clear the terrain's own
    // depth noise, not enough to look like it is hovering.
    glow.position.y = 0.03;
    glow.frustumCulled = true;
    glow.raycast = NO_RAYCAST;
    glow.renderOrder = 17;
    group.add(glow);

    const motes = new THREE.Mesh(moteGeo, mats.mote);
    motes.frustumCulled = false;
    motes.raycast = NO_RAYCAST;
    motes.renderOrder = 19;
    group.add(motes);

    liveBeams.push(group);
    // Hard cap. Geometry and materials are shared so a beam is nearly free,
    // but an unbounded list would still leak scene nodes over a long match.
    while (liveBeams.length > budget.beams * 4) {
      const old = liveBeams.shift();
      old?.parent?.remove(old);
    }
    return group;
  }

  // =========================================================================
  // SOAKED — the water recipes
  //
  // The whole look of this game is water, so this is the loudest section in
  // the file. Three rules govern everything below, and every one of them is a
  // rule about what NOT to do:
  //
  //  1. **Water is transparent, not blue.** Bodies come off `RAMP.waterBody`,
  //     which never leaves the top corner of the colour cube and never exceeds
  //     0.66 alpha. What makes a droplet read as water is the additive glint
  //     riding on its leading edge, not its colour. A droplet spawned as an
  //     opaque blue billboard is a piece of confetti, and no amount of motion
  //     tuning will rescue it.
  //  2. **Water falls.** Every droplet in here carries a real downward
  //     acceleration and every crown arcs. Particles that fly straight out and
  //     fade read as a spark effect with the hue changed.
  //  3. **Wet is darker and glossier, never bluer.** The patch a splash leaves
  //     behind is a dark cool grey at low alpha over the surface's own albedo.
  //     Painting the ground blue is the other half of failure mode 1.
  //
  // Nothing here allocates: the same pools, the same eleven draw calls.
  // =========================================================================

  const waterTint = new THREE.Color();
  const latexTint = new THREE.Color();
  /** Surface tangents, kept out of the shared tmp set — splash nests calls. */
  const wT1 = new THREE.Vector3();
  const wT2 = new THREE.Vector3();
  const wDir = new THREE.Vector3();
  const wPos = new THREE.Vector3();

  /** Default water colour when a caller does not name one. */
  const WATER_DEFAULT = WATER.balloon.splashColor;

  /** Orthonormal tangent frame on a surface. Both outputs are unit length. */
  function surfaceBasis(n: THREE.Vector3): void {
    wT1.set(0, 1, 0);
    if (Math.abs(n.y) > 0.9) wT1.set(1, 0, 0);
    wT1.crossVectors(wT1, n).normalize();
    wT2.crossVectors(n, wT1).normalize();
  }

  /**
   * A launch direction at a given elevation off the surface. This is what
   * makes a crown flat on stone (low elevation) and a burst wide on a person
   * (high elevation) with one code path.
   */
  function crownDir(n: THREE.Vector3, elev: number, azimuth: number): THREE.Vector3 {
    const ce = Math.cos(elev);
    const se = Math.sin(elev);
    return wDir
      .set(0, 0, 0)
      .addScaledVector(wT1, Math.cos(azimuth) * ce)
      .addScaledVector(wT2, Math.sin(azimuth) * ce)
      .addScaledVector(n, se)
      .normalize();
  }

  /**
   * One droplet: a translucent body plus, on the ones that will be seen, an
   * additive glint streak on the same trajectory.
   *
   * The two share a solved trajectory rather than being spawned independently,
   * so the sparkle sits exactly on the leading edge of the body instead of
   * drifting off it. Gravity is passed in because a balloon burst throws water
   * harder than a soaker does and both have to land believably.
   */
  function droplet(
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    gravity: number, life: number, size: number,
    tint: THREE.Color, glint: boolean,
  ): void {
    emitBillboard(bbAlpha, px, py, pz, vx, vy, vz,
      life, size, size * rr(0.5, 0.8), RAMP.waterBody, 1.0,
      -gravity, 0.12, rr(-5, 5), SPRITE.droplet, 0, tint);
    if (!glint) return;
    // Short, narrow and DIM. The sparkle is a specular pin on the droplet, not
    // a tracer: at the brightness this started at, a crown of thirty droplets
    // summed into a single white blob under additive blending and the whole
    // splash lost its shape.
    // Length is tied to the droplet's own size, not a fixed number. A fixed
    // length turns a 4 cm droplet into a 40 cm needle and the crown reads as a
    // spark shower — which is exactly what the first pass looked like.
    emitStreak(px, py, pz, vx, vy, vz, 0, -gravity, 0,
      life * 0.7, size * 0.5, size * rr(2.5, 5),
      RAMP.waterGlint, rr(0.55, 1.1), 0, tint);
  }

  /**
   * SPLASH — what replaces the impact family.
   *
   * Four layers, in the order the eye reads them: a contact glint that is gone
   * in 90 ms, a crown of droplets thrown outward with real gravity, an
   * expanding ring of spray on the surface, and fine mist that hangs a moment
   * and catches the sun. Hard surfaces also keep a wet patch afterwards, which
   * is the part that makes a firefight leave marks on the map.
   */
  function doSplash(
    point: THREE.Vector3, normal: THREE.Vector3, opts?: SplashOpts,
  ): void {
    const surface = opts?.surface ?? "concrete";
    const p = SPLASHES[surface] ?? SPLASHES.concrete;
    const power = THREE.MathUtils.clamp(opts?.power ?? 1, 0.25, 4);
    const px = point.x;
    const py = point.y;
    const pz = point.z;
    const n = tmpVec3.copy(normal);
    if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
    n.normalize();
    surfaceBasis(n);
    const tint = waterTint.setHex(opts?.color ?? WATER_DEFAULT, THREE.SRGBColorSpace);

    // Splashes are as frequent as impacts were: past 130 m the crown does not
    // resolve, so it collapses to a ring, a glint and nothing else.
    const dist2 = camDistSq(px, py, pz);
    const far = dist2 > 130 * 130;
    const scale = Math.pow(power, 0.55);

    // --- 1. Contact glint ---------------------------------------------------
    if (p.flash > 0) {
      emitBillboard(bbAdd, px + n.x * 0.04, py + n.y * 0.04, pz + n.z * 0.04,
        0, 0, 0, 0.08, 0.1 * p.flash * scale, 0.42 * p.flash * scale,
        RAMP.waterGlint, 1.15 * p.flash, 0, 0, rr(-3, 3), SPRITE.glow, 0, tint);
    }

    // --- 2. The crown -------------------------------------------------------
    const crown = far ? 0 : cnt(p.crown * power);
    for (let i = 0; i < crown; i++) {
      // Stratified azimuth with a jitter: an evenly spaced crown reads as a
      // crown, a purely random one reads as a puff with gaps in it.
      const az = ((i + rr(0, 0.85)) / Math.max(1, crown)) * Math.PI * 2;
      const dir = crownDir(n, rr(p.elev0, p.elev1), az);
      const sp = p.speed * rr(0.5, 1.5) * scale;
      droplet(
        px + dir.x * 0.05, py + dir.y * 0.05, pz + dir.z * 0.05,
        dir.x * sp, dir.y * sp + rr(0.2, 1.6) * scale, dir.z * sp,
        20, rr(0.4, 0.95), p.drop * rr(0.65, 1.45) * scale,
        tint, i % 2 === 0);
    }

    // --- 3. Spray ring on the surface ---------------------------------------
    // A thin travelling rim, not a disc. `inner` is high and the brightness is
    // low on purpose: an additive ring on a bright sunny map saturates to a
    // white doughnut the instant you give it any real intensity, and a white
    // doughnut is a force field, not a sheet of water leaving a surface.
    emitRing(ringAdd, px + n.x * 0.03, py + n.y * 0.03, pz + n.z * 0.03, n,
      0.24, 0.05, p.ring * scale, RAMP.wetSheen, 0.13, 0.93, 0, tint, 1.0);
    // A second, wider, fainter rim behind the first — two speeds is what makes
    // a ring read as spray leaving a surface rather than as one animated
    // circle. It stays on the ADDITIVE layer: an alpha ring of near-white mist
    // composites to a solid white doughnut over anything darker than paper,
    // and that is a force field, not water.
    if (!far) {
      emitRing(ringAdd, px + n.x * 0.02, py + n.y * 0.02, pz + n.z * 0.02, n,
        0.45, 0.09, p.ring * 1.7 * scale, RAMP.waterMist, 0.16, 0.86, 0, tint, 0.65);
    }

    // --- 4. Mist that hangs and catches the light ---------------------------
    const mist = cnt(p.mist * power);
    for (let i = 0; i < mist; i++) {
      const az = rng() * Math.PI * 2;
      const dir = crownDir(n, rr(0.2, 1.1), az);
      // Wide spreads on speed, size and delay, because mist puffs with similar
      // values expand into an even shell — a perfect white annulus that reads
      // as a smoke ring and swallows the droplets inside it.
      const sp = rr(0.25, 2.6) * scale;
      emitBillboard(bbAlpha,
        px + dir.x * rr(0.04, 0.3), py + dir.y * rr(0.04, 0.3), pz + dir.z * rr(0.04, 0.3),
        dir.x * sp, dir.y * sp + 0.3, dir.z * sp,
        rr(0.6, 1.7), rr(0.05, 0.16) * scale, rr(0.25, 0.9) * scale,
        RAMP.waterMist, 1.0, -0.5, 2.6, rr(-0.9, 0.9),
        i % 2 === 0 ? SPRITE.dust : SPRITE.grit, i * rr(0.005, 0.05), tint);
    }
    // A couple of airborne sparkles. Cheap, and they are what makes the mist
    // read as suspended water rather than as pale smoke.
    if (!far) {
      for (let i = 0; i < cnt(2 * power); i++) {
        const dir = crownDir(n, rr(0.3, 1.2), rng() * Math.PI * 2);
        emitBillboard(bbAdd,
          px + dir.x * 0.12, py + dir.y * 0.12, pz + dir.z * 0.12,
          dir.x * rr(0.8, 2.6), dir.y * rr(0.8, 2.6) + 0.6, dir.z * rr(0.8, 2.6),
          rr(0.25, 0.55), rr(0.05, 0.11) * scale, 0.02,
          RAMP.waterGlint, rr(0.9, 1.7), -6, 1.6, 0, SPRITE.sparkle, 0, tint);
      }
    }

    // --- 5. Column, for surfaces that have water in them ---------------------
    if (p.column > 0 && !far) {
      const terrain = ctx.services.terrain;
      const wy = surface === "water" ? (terrain?.seaLevel ?? py) + 0.04 : py;
      const cols = cnt(4 * p.column * power);
      for (let i = 0; i < cols; i++) {
        emitBillboard(bbAlpha,
          px + rr(-0.14, 0.14) * scale, wy, pz + rr(-0.14, 0.14) * scale,
          rr(-0.5, 0.5), rr(2.6, 6.2) * p.column * scale, rr(-0.5, 0.5),
          rr(0.5, 0.95), 0.12 * scale, rr(0.35, 0.6) * scale,
          RAMP.waterBody, 1.0, -18, 0.5, rr(-1, 1), SPRITE.smoke2, i * 0.02, tint);
      }
      if (surface === "water") {
        // A real ripple on the surface, separate from the spray ring — this is
        // the one that keeps travelling after the splash has gone.
        emitRing(ringDust, px, wy, pz, UNIT_Y,
          1.5, 0.12, p.ring * 3.4 * scale, RAMP.waterMist, 0.8, 0.88, 0, tint, 0.3);
      }
    }

    // --- 6. The wet patch ----------------------------------------------------
    if (!far && !opts?.noDecal && p.decalSize > 0) {
      doWetPatch(point, n, p.decalSize * power * rr(0.85, 1.3), p.decalLife,
        p.decalAlpha * rr(0.75, 1.0));
    }

    if (!opts?.silent) safeAudio(p.sound, point, 0.34, rr(0.9, 1.14));
  }

  /**
   * A wet patch and nothing else. Dark, cool and low-alpha over whatever the
   * surface already is — a soaked surface goes darker and glossier, and the
   * moment you tint it blue instead it stops being wet and starts being paint.
   */
  function doWetPatch(
    point: THREE.Vector3, normal: THREE.Vector3, size = 0.6, seconds = 22, alpha = 0.42,
  ): void {
    // Two authored splat cells in water mode (the repurposed blood pair), so
    // consecutive patches are not the same stamp twice. `scuff` is the classic
    // fallback and the closest thing the untouched atlas has to a damp mark.
    emitDecal(point.x, point.y, point.z, normal, size,
      water ? (rng() < 0.5 ? DECAL.blood : DECAL.blood2) : DECAL.scuff,
      seconds, WET_DECAL_TINT, alpha);
  }

  /**
   * STREAM — the travelling arc of water every soaker draws.
   *
   * The trick is that nothing here is animated by the CPU. Every droplet is
   * launched at the same instant with the same solved velocity, and the tail
   * exists purely because later droplets are given a spawn DELAY: they leave
   * the nozzle behind the head and chase it down the same parabola. One call,
   * no emitter state, no timers, and the head still lands exactly on the point
   * the weapon's raycast reported:
   *
   *   p(t) = from + v·t − ½·g·t²   with   v = (to − from)/life + ½·g·life
   */
  function doWaterStream(
    from: THREE.Vector3, to: THREE.Vector3, opts?: StreamOpts,
  ): void {
    wPos.subVectors(to, from);
    const dist = wPos.length();
    // Below a metre the whole stream is inside the muzzle spritz.
    if (dist < 1.0) return;
    const speed = Math.max(12, opts?.speed ?? 78);
    const arc = Math.max(0, opts?.arc ?? 9);
    const life = THREE.MathUtils.clamp(dist / speed, 0.035, 0.6);
    const width = Math.max(0.012, opts?.width ?? 0.07);
    const power = THREE.MathUtils.clamp(opts?.power ?? 1, 0.25, 3);
    const tint = waterTint.setHex(opts?.color ?? WATER_DEFAULT, THREE.SRGBColorSpace);

    const vx = wPos.x / life;
    const vy = wPos.y / life + 0.5 * arc * life;
    const vz = wPos.z / life;

    // Leading head: bright, additive, and wider than the tail. This is the
    // part the player tracks, so it is the only part that is allowed to glow.
    emitStreak(from.x, from.y, from.z, vx, vy, vz, 0, -arc, 0,
      life, width * 1.5 * power, 0.6 + dist * 0.09,
      RAMP.waterGlint, 1.5, 0, tint);
    emitBillboard(bbAdd, from.x, from.y, from.z, vx, vy, vz,
      life, width * 2.6 * power, width * 1.8 * power,
      RAMP.waterGlint, 0.85, -arc, 0, rr(-2, 2), SPRITE.glow, 0, tint);
    // A translucent body under the head, so the leading edge has water in it
    // rather than being a bare highlight travelling on its own.
    emitBillboard(bbAlpha, from.x, from.y, from.z, vx, vy, vz,
      life, width * 3.2 * power, width * 2.0 * power,
      RAMP.waterBody, 1.0, -arc, 0, rr(-2, 2), SPRITE.droplet, 0, tint);

    // Body and tail. Later droplets start later and are smaller and dimmer,
    // which is the taper.
    const segs = Math.max(4, cnt(9 * power));
    for (let i = 0; i < segs; i++) {
      const f = i / Math.max(1, segs - 1);
      // Tighter than it looks: the tail spans `speed * 0.5 * life` metres,
      // which is half the shot. Spread it wider and the ribbon comes apart
      // into separate beads with sky between them.
      const delay = f * life * 0.5;
      const w = width * (1 - 0.6 * f) * power;
      emitBillboard(bbAlpha, from.x, from.y, from.z, vx, vy, vz,
        life * (1 - 0.22 * f), w * 2.6, w * 1.3,
        RAMP.waterBody, 1.0, -arc, 0, rr(-4, 4), SPRITE.droplet, delay, tint);
      if (i % 2 === 0) {
        emitStreak(from.x, from.y, from.z, vx, vy, vz, 0, -arc, 0,
          life * (1 - 0.18 * f), w * 0.8, 0.5 + dist * 0.03,
          RAMP.waterGlint, 1.0 - 0.55 * f, delay, tint);
      }
    }
  }

  /**
   * BALLOON BURST — the set piece, and deliberately so.
   *
   * This is the most satisfying thing in the game and it is built like the
   * explosion it replaces: layered in the order the eye reads them, with
   * genuinely different speeds on each layer so it reads as a volume of water
   * coming apart rather than as one animated sphere.
   *
   *   1. the pop — a hard white-cyan flash, gone in 70 ms
   *   2. the bloom — big translucent lobes of water expanding and falling
   *   3. the crown — dozens of droplets on real parabolas that actually land
   *   4. the ground — a fast rim, a slow spray wall, and a puddle that stays
   *   5. mist hanging in the air a beat behind everything else
   *   6. shreds of latex, which is the detail that says "a balloon did this"
   */
  function doBalloonBurst(point: THREE.Vector3, opts?: BalloonBurstOpts): void {
    const def = WATER.balloon;
    const radius = THREE.MathUtils.clamp(opts?.radius ?? def.radius, 0.8, 26);
    const s = radius / def.radius;
    blastsThisFrame++;
    const busy = blastsThisFrame > 3 ? 0.3 : blastsThisFrame > 1 ? 0.68 : 1;
    const q = D * busy;
    const n = (v: number) => Math.max(1, Math.round(v * q));

    const px = point.x;
    const py = point.y;
    const pz = point.z;
    const tint = waterTint.setHex(
      opts?.waterColor ?? def.splashColor, THREE.SRGBColorSpace);
    const latexHex = opts?.color ?? def.colors[(rng() * def.colors.length) | 0];
    latexTint.setHex(latexHex, THREE.SRGBColorSpace);

    const terrain = ctx.services.terrain;
    const gy = groundY(px, pz, py);
    const nearGround = py - gy < 3.5 * s;
    const sea = terrain?.seaLevel ?? 0;
    const inWater = !!terrain?.isWater(px, pz) && py < sea + 2 * s;
    const gn = groundNormal(px, pz, surfaceNormal);

    // --- 1. The pop ---------------------------------------------------------
    emitBillboard(bbAdd, px, py, pz, 0, 0, 0,
      0.07, 0.5 * s, 1.6 * s, RAMP.waterGlint, 0.62, 0, 0, rr(-3, 3),
      SPRITE.flare, 0, tint);
    emitBillboard(bbAdd, px, py, pz, 0, 0, 0,
      0.05, 0.3 * s, 3.4 * s, RAMP.wetSheen, 0.55, 0, 0, rr(-3, 3),
      SPRITE.streakFlare, 0, tint);

    // --- 2. The bloom -------------------------------------------------------
    // Heavy drag and a strong downward pull: a body of water thrown outward
    // stops fast and then falls, where a fireball keeps rising. That contrast
    // is most of what stops this reading as a recoloured explosion.
    const lobes = n(13 + 8 * s);
    for (let i = 0; i < lobes; i++) {
      scatter(tmpVec2);
      const sp = rr(4, 13) * Math.pow(s, 0.7);
      emitBillboard(bbAlpha,
        px + tmpVec2.x * s * 0.35, py + tmpVec2.y * s * 0.3, pz + tmpVec2.z * s * 0.35,
        tmpVec2.x * sp, tmpVec2.y * sp * 0.7 + sp * 0.25, tmpVec2.z * sp,
        rr(0.6, 1.15), 0.6 * s, rr(2.2, 3.6) * s,
        RAMP.waterBody, 1.05, -7.5, 2.1, rr(-1.4, 1.4),
        i % 2 === 0 ? SPRITE.smoke : SPRITE.smoke2, 0, tint);
    }
    for (let i = 0; i < n(7 + 4 * s); i++) {
      scatter(tmpVec2);
      const sp = rr(3, 10) * Math.pow(s, 0.65);
      emitBillboard(bbAdd,
        px + tmpVec2.x * s * 0.3, py + tmpVec2.y * s * 0.25, pz + tmpVec2.z * s * 0.3,
        tmpVec2.x * sp, tmpVec2.y * sp * 0.6 + sp * 0.3, tmpVec2.z * sp,
        rr(0.2, 0.5), 0.7 * s, 2.6 * s, RAMP.wetSheen, 0.42, -5, 2.4,
        rr(-2, 2), SPRITE.glow, 0, tint);
    }

    // --- 3. The crown -------------------------------------------------------
    const crown = n(26 + 16 * s);
    for (let i = 0; i < crown; i++) {
      scatter(tmpVec2);
      // Bias upward and outward: water thrown at the deck arcs, and the arc
      // is what fills the volume the blast radius claims.
      const sp = rr(7, 22) * Math.pow(s, 0.55);
      // Seeded on the skin of the core rather than at a single point: dozens
      // of droplets all leaving the same pixel read as one blob no matter how
      // different their velocities are.
      droplet(
        px + tmpVec2.x * 0.45 * s, py + tmpVec2.y * 0.45 * s, pz + tmpVec2.z * 0.45 * s,
        tmpVec2.x * sp, Math.abs(tmpVec2.y) * sp * 0.75 + rr(2, 8) * s, tmpVec2.z * sp,
        // Every third droplet gets a glint, not every other one: at fifty-odd
        // droplets the specular pins otherwise sum into the white core the
        // burst is supposed to be throwing water OUT of.
        def.gravity, rr(0.7, 1.5), rr(0.08, 0.2) * Math.pow(s, 0.4),
        tint, i % 3 === 0);
    }

    // --- 4. Ground / water ---------------------------------------------------
    if (inWater) {
      const wy = sea + 0.05;
      emitRing(ringAdd, px, wy, pz, UNIT_Y,
        0.9, 0.6 * s, 8 * s, RAMP.wetSheen, 0.55, 0.9, 0, tint, 0.9);
      emitRing(ringDust, px, wy, pz, UNIT_Y,
        1.9, 1.0 * s, 14 * s, RAMP.waterMist, 0.8, 0.88, 0, tint, 0.4);
      for (let i = 0; i < n(8 + 4 * s); i++) {
        emitBillboard(bbAlpha,
          px + rr(-0.5, 0.5) * s, wy, pz + rr(-0.5, 0.5) * s,
          rr(-1.5, 1.5), rr(4, 11) * s, rr(-1.5, 1.5),
          rr(0.6, 1.2), 0.2 * s, 0.8 * s, RAMP.waterBody, 1.0, -18, 0.6,
          rr(-1, 1), SPRITE.smoke2, i * 0.02, tint);
      }
    } else if (nearGround) {
      emitRing(ringAdd, px, gy + 0.07, pz, gn,
        0.3, 0.5 * s, radius * 0.8, RAMP.wetSheen, 0.6, 0.9, 0, tint, 1.1);
      emitRing(ringDust, px, gy + 0.05, pz, gn,
        0.9, 0.8 * s, radius * 1.1, RAMP.waterMist, 0.8, 0.72, 0, tint, 0.5);
      // Sheet of spray running outward along the deck.
      // Kept deliberately sparse and small. A sheet built from eighteen
      // three-metre puffs is not a sheet, it is a solid white disc painted on
      // the ground, and it hides the entire crown behind it.
      for (let i = 0; i < n(7 + 3 * s); i++) {
        const a = rng() * Math.PI * 2;
        const sp = rr(6, 17) * Math.pow(s, 0.6);
        emitBillboard(bbAlpha,
          px + Math.cos(a) * s * 0.5, gy + rr(0.05, 0.5) * s, pz + Math.sin(a) * s * 0.5,
          Math.cos(a) * sp, rr(0.6, 3.2), Math.sin(a) * sp,
          rr(0.7, 1.5), 0.25 * s, rr(0.8, 1.9) * s,
          RAMP.waterMist, 1.0, -1.2, 2.6, rr(-1, 1),
          i % 3 === 0 ? SPRITE.grit : SPRITE.dust, 0, tint);
      }
      // The puddle. This is the part of a balloon the player still sees six
      // seconds later, and `puddleTime` is exactly how long it is slippery.
      const puddle = opts?.puddleTime ?? def.puddleTime;
      doWetPatch(tmpVec4.set(px, gy, pz), gn, radius * 0.7 * rr(0.9, 1.15),
        puddle, 0.6);
      for (let i = 0; i < n(3); i++) {
        const a = rng() * Math.PI * 2;
        const d = rr(0.35, 0.95) * radius;
        const sx = px + Math.cos(a) * d;
        const sz = pz + Math.sin(a) * d;
        doWetPatch(tmpVec4.set(sx, groundY(sx, sz, gy), sz), gn,
          rr(0.4, 1.0) * radius * 0.45, puddle * 0.8, 0.42);
      }
    }

    // --- 5. Hanging mist -----------------------------------------------------
    for (let i = 0; i < n(6 + 4 * s); i++) {
      scatter(tmpVec2);
      emitBillboard(bbAlpha,
        px + tmpVec2.x * s * 0.9, py + rr(0.1, 1.6) * s, pz + tmpVec2.z * s * 0.9,
        tmpVec2.x * rr(0.4, 1.8), rr(0.2, 1.1), tmpVec2.z * rr(0.4, 1.8),
        rr(1.4, 2.6), 1.0 * s, rr(3.5, 6) * s,
        RAMP.waterMist, 1.0, -0.35, 1.5, rr(-0.5, 0.5),
        i % 2 === 0 ? SPRITE.wisp : SPRITE.smoke, 0.12 + i * 0.05, tint);
    }
    // Sun on the falling water. Delayed, so the sparkle arrives after the
    // bloom rather than competing with the flash.
    for (let i = 0; i < n(5 + 3 * s); i++) {
      scatter(tmpVec2);
      emitBillboard(bbAdd,
        px + tmpVec2.x * s * 0.8, py + rr(0.2, 1.8) * s, pz + tmpVec2.z * s * 0.8,
        tmpVec2.x * rr(1, 4), rr(0.5, 3), tmpVec2.z * rr(1, 4),
        rr(0.35, 0.8), rr(0.08, 0.2) * s, 0.02,
        RAMP.waterGlint, rr(0.9, 1.8), -8, 1.3, 0, SPRITE.sparkle,
        0.08 + i * 0.03, tint);
    }

    // --- 6. Latex shreds -----------------------------------------------------
    const shreds = Math.min(debrisCap, n(4));
    for (let i = 0; i < shreds; i++) {
      scatter(tmpVec2);
      const sp = rr(5, 14) * Math.pow(s, 0.45);
      emitDebris(debrisSlab, px, py, pz,
        tmpVec2.x * sp, Math.abs(tmpVec2.y) * sp * 0.7 + rr(2, 7), tmpVec2.z * sp,
        rr(0.05, 0.11) * s, rr(1.6, 2.8), 0.08, rr(0.7, 1.3),
        latexHex, 0, rr(2.5, 4.5), RAMP.waterMist);
    }

    // --- 7. Player feedback ---------------------------------------------------
    // Cool light rather than warm, and a small fraction of a fireball's: a
    // balloon does not emit, it only catches. Anything stronger than this
    // paints a glowing pool onto the ground and the burst starts reading as a
    // detonation with the hue changed.
    flashLight(px, py + 0.4 * s, pz, 0xbfe9ff, 24 * s * s, 8 * s, 0.18, 0);
    ctx.emit("dz:shake", { amount: 0.22 + 0.1 * s, point, range: 26 * s });
    const near = camDistSq(px, py, pz);
    const nearK = Math.max(0, 1 - Math.sqrt(near) / (14 * s));
    if (nearK > 0.02) {
      // Pale, additive and very brief. Nobody gets hurt in this game — the
      // screen pop is a splash in the face, not a concussion.
      screenFlash(0xdff4ff, Math.min(0.4, 0.36 * nearK * s), 0.13, true, 0.35, 0, 0);
    }
    if (!opts?.silent) safeAudio(def.soundBurst, point, Math.min(1, 0.5 * s), rr(0.92, 1.1));
  }

  /**
   * SOAK NUMBERS — the same pooled billboard system, restated in water.
   *
   * Everything that made damage numbers readable still applies: the stack, the
   * fan, the size pop, the depth-test-off layer. What changes is the palette
   * (water-blue, with the one warm colour reserved for a faceful) and the
   * droplet glyph on the end, which is what makes "18" read as eighteen points
   * of soak rather than eighteen points of damage.
   */
  function doSoakNumber(
    point: THREE.Vector3, amount: number, faceful: boolean, poncho: boolean,
  ): void {
    const value = Math.max(1, Math.min(9999, Math.round(amount)));
    if (camDistSq(point.x, point.y, point.z) > 110 * 110) return;

    const now = uTime.value;
    let stack = 0;
    let slot = -1;
    for (let i = 0; i < RECENT_CAP; i++) {
      if (now - recentT[i] > 0.55) continue;
      const dx = recentX[i] - point.x;
      const dy = recentY[i] - point.y;
      const dz = recentZ[i] - point.z;
      if (dx * dx + dy * dy + dz * dz < 1.6 * 1.6) {
        stack = Math.min(4, recentStack[i] + 1);
        slot = i;
        break;
      }
    }
    if (slot < 0) {
      slot = recentCursor;
      recentCursor = (recentCursor + 1) % RECENT_CAP;
    }
    recentX[slot] = point.x;
    recentY[slot] = point.y;
    recentZ[slot] = point.z;
    recentT[slot] = now;
    recentStack[slot] = stack;

    const color = tintColor.setHex(
      faceful ? SOAK_FACEFUL : poncho ? SOAK_PONCHO : SOAK_PLAIN,
      THREE.SRGBColorSpace,
    );
    const size = (faceful ? 0.5 : 0.36) * (1 + Math.min(0.35, value / 900));
    const life = faceful ? 1.25 : 1.05;
    const side = stack % 2 === 0 ? 1 : -1;
    const driftX = rr(0.3, 0.9) * side;
    const driftZ = rr(-0.4, 0.4);
    const rise = (faceful ? 2.5 : 2.0) + stack * 0.25;

    const px = point.x;
    const py = point.y + 0.15 + stack * 0.34;
    const pz = point.z;

    const digits = String(value);
    const count = Math.min(MAX_DIGITS, digits.length);
    // The droplet is one more glyph in the same token, so the whole thing
    // centres on `count + 1` rather than on the digits alone.
    const total = count + 1;
    for (let i = 0; i < count; i++) {
      const cell = digits.charCodeAt(i) - 48;
      if (cell < 0 || cell > 9) continue;
      emitGlyph(px, py, pz, driftX, rise, driftZ,
        life, size, -3.4, cell, i - (total - 1) / 2, faceful ? 1.35 : 1.0, color);
    }
    // Same size as the digits on purpose: the shader scales the glyph offset
    // by the glyph's own size, so a smaller droplet would sit at the wrong
    // spacing and the token would come apart.
    emitGlyph(px, py, pz, driftX, rise, driftZ,
      life, size, -3.4, NUMERAL_DROPLET, count - (total - 1) / 2,
      faceful ? 1.35 : 1.0, color);
  }

  /**
   * DRYING SHIMMER — the warm plume over a drying station.
   *
   * Heat haze, not steam: warm, faint, and rising. It is the one warm effect
   * in a mode made of water, which is exactly why a player can spot a station
   * across a POI. Cheap enough to call every frame; the caller controls the
   * rate, we control the look.
   */
  function doDryingShimmer(point: THREE.Vector3, opts?: DryingShimmerOpts): void {
    const radius = Math.max(0.15, opts?.radius ?? 1.1);
    const height = Math.max(0.4, opts?.height ?? 2.4);
    const strength = THREE.MathUtils.clamp(opts?.strength ?? 1, 0.1, 2);
    const rise = height * 0.55;

    for (let i = 0; i < cnt(2 * strength); i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * radius;
      emitBillboard(bbAlpha,
        point.x + Math.cos(a) * r, point.y + rr(0, 0.25), point.z + Math.sin(a) * r,
        Math.cos(a) * rr(0.05, 0.3), rr(0.7, 1.4) * rise * 0.5, Math.sin(a) * rr(0.05, 0.3),
        rr(1.3, 2.3), radius * 0.35, radius * rr(1.1, 1.8),
        RAMP.heatHaze, strength, 1.15, 1.1, rr(-0.35, 0.35),
        i % 2 === 0 ? SPRITE.wisp : SPRITE.dust, i * 0.1);
    }
    // A faint additive core every few calls: the shimmer needs SOME light in
    // it or it is just a pale puff, but at full rate it would read as smoke.
    if (rng() < 0.35 * strength) {
      emitBillboard(bbAdd,
        point.x + rr(-0.3, 0.3) * radius, point.y + rr(0.1, 0.6),
        point.z + rr(-0.3, 0.3) * radius,
        rr(-0.15, 0.15), rr(0.8, 1.6) * rise * 0.5, rr(-0.15, 0.15),
        rr(0.8, 1.5), radius * 0.3, radius * 0.95,
        RAMP.heatHaze, 0.85 * strength, 1.0, 1.3, 0, SPRITE.dust);
    }
    // The odd flick of steam coming off something genuinely wet.
    if (rng() < 0.18 * strength) {
      emitBillboard(bbAlpha,
        point.x + rr(-0.4, 0.4) * radius, point.y + rr(0, 0.4),
        point.z + rr(-0.4, 0.4) * radius,
        rr(-0.2, 0.2), rr(1.0, 2.0), rr(-0.2, 0.2),
        rr(1.6, 2.6), radius * 0.25, radius * rr(1.4, 2.2),
        RAMP.steam, 0.75, 1.4, 1.0, rr(-0.3, 0.3), SPRITE.smoke2);
    }
  }

  /**
   * The nozzle, in place of a muzzle flash. A water gun does not burn
   * anything, so everything that made the classic flash read as combustion —
   * the star flare, the lens streak, the burnt propellant, the warm point
   * light — is wrong here and would fight the whole art direction.
   *
   * What is left is what actually happens at a nozzle: a bright bead of water
   * at the tip, a few stray drops falling out of it, and a breath of mist.
   */
  function doNozzleSpritz(matrix: THREE.Matrix4, scale = 1): void {
    const e = matrix.elements;
    const px = e[12];
    const py = e[13];
    const pz = e[14];
    tmpVec.set(-e[8], -e[9], -e[10]);
    const fl = tmpVec.length();
    if (fl < 1e-6) tmpVec.set(0, 0, -1);
    else tmpVec.divideScalar(fl);
    const s = THREE.MathUtils.clamp(scale, 0.25, 4);
    const tint = waterTint.setHex(WATER_DEFAULT, THREE.SRGBColorSpace);

    emitBillboard(bbAdd, px + tmpVec.x * 0.1, py + tmpVec.y * 0.1, pz + tmpVec.z * 0.1,
      tmpVec.x * 2, tmpVec.y * 2, tmpVec.z * 2,
      0.055, 0.12 * s, 0.34 * s, RAMP.waterGlint, 2.4, 0, 0, rr(-4, 4),
      SPRITE.glow, 0, tint);

    for (let i = 0; i < cnt(3); i++) {
      scatter(tmpVec2, tmpVec, 0.5);
      const sp = rr(1.5, 5) * s;
      droplet(px + tmpVec.x * 0.14, py + tmpVec.y * 0.14, pz + tmpVec.z * 0.14,
        tmpVec2.x * sp, tmpVec2.y * sp, tmpVec2.z * sp,
        16, rr(0.3, 0.7), rr(0.02, 0.05) * s, tint, i === 0);
    }
    for (let i = 0; i < cnt(2); i++) {
      scatter(tmpVec2, tmpVec, 0.45);
      const sp = rr(1, 3.5) * s;
      emitBillboard(bbAlpha,
        px + tmpVec.x * 0.16, py + tmpVec.y * 0.16, pz + tmpVec.z * 0.16,
        tmpVec2.x * sp, tmpVec2.y * sp + 0.2, tmpVec2.z * sp,
        rr(0.3, 0.7), 0.05 * s, rr(0.28, 0.5) * s,
        RAMP.waterMist, 1.0, -0.6, 3.2, rr(-1.5, 1.5), SPRITE.wisp, 0, tint);
    }
  }

  /**
   * Mist in place of smoke. Same staggered-delay plume, near-white and cool,
   * drifting rather than billowing. Grey smoke on a sunny block party map is
   * the fastest way to make SOAKED look like Drop Zero with a filter on it.
   */
  function doWaterMist(point: THREE.Vector3, amount = 1): void {
    const a = THREE.MathUtils.clamp(amount, 0.1, 6);
    const tint = waterTint.setHex(WATER_DEFAULT, THREE.SRGBColorSpace);
    const count = cnt(3 + a * 3);
    for (let i = 0; i < count; i++) {
      scatter(tmpVec2);
      emitBillboard(bbAlpha,
        point.x + tmpVec2.x * 0.5 * a, point.y + rr(0, 0.7) * a, point.z + tmpVec2.z * 0.5 * a,
        tmpVec2.x * rr(0.2, 1.0) * a, rr(0.5, 1.6) * a, tmpVec2.z * rr(0.2, 1.0) * a,
        rr(3, 7), rr(0.7, 1.4) * a, rr(4, 8) * a,
        RAMP.waterMist, 1.0, 0.2, 1.1, rr(-0.4, 0.4),
        i % 3 === 0 ? SPRITE.wisp : i % 3 === 1 ? SPRITE.smoke : SPRITE.smoke2,
        i * rr(0.08, 0.24), tint);
    }
    // One sparkle per plume, so even hanging mist has some sun in it.
    emitBillboard(bbAdd, point.x, point.y + 0.4 * a, point.z,
      rr(-0.4, 0.4), rr(0.4, 1.2), rr(-0.4, 0.4),
      rr(0.5, 1.1), 0.1 * a, 0.03, RAMP.waterGlint, rr(1.2, 2.2),
      0.4, 1.4, 0, SPRITE.sparkle, 0, tint);
  }

  /**
   * Harvest/break colours for the water build materials. Pool noodles, deck
   * planks and corrugated tarp, straight out of `WATER_MATERIALS` — the
   * material identity has to survive from the swing through the flying chips
   * to the debris when the wall comes down, exactly as it does in classic.
   */
  const WATER_LOOK: Record<HarvestKind, MaterialLook> = {
    wood: {
      ...MATERIAL_LOOK.wood,
      base: WATER.materials.wood.color,
      alt: WATER.materials.wood.accent,
      // Foam does not splinter into slivers, it tears into stubby lumps.
      chipSprite: SPRITE.pebble,
      slabLong: 2.2,
      slabThin: 0.55,
      sound: WATER.materials.wood.harvestSound,
    },
    stone: {
      ...MATERIAL_LOOK.stone,
      base: WATER.materials.stone.color,
      alt: WATER.materials.stone.accent,
      chipSprite: SPRITE.splinter,
      // Deck planks are planks: slabs, not rubble.
      slab: true,
      slabLong: 2.6,
      slabThin: 0.3,
      sparks: 0,
      sound: WATER.materials.stone.harvestSound,
    },
    metal: {
      ...MATERIAL_LOOK.metal,
      base: WATER.materials.metal.color,
      alt: WATER.materials.metal.accent,
      // Tarp does not spark. Nothing in this game sparks.
      sparks: 0,
      sound: WATER.materials.metal.harvestSound,
    },
  };

  /** The look table for the current mode. One lookup, no branch at the call. */
  function lookFor(kind: HarvestKind): MaterialLook {
    const table = water ? WATER_LOOK : MATERIAL_LOOK;
    return table[kind] ?? table.wood;
  }

  // Everything the service delegates to now exists.
  ready = true;

  // =========================================================================
  // Frame
  // =========================================================================

  const drawSize = new THREE.Vector2();
  const windPhase = { v: rng() * 100 };
  const nightTint = new THREE.Color(0x2c3a55);
  const sunTint = new THREE.Color();
  const skyFill = new THREE.Color();
  const tmpScale = new THREE.Vector3();
  /** Gravity for debris, in m/s². Heavier than real: chunks must settle fast. */
  const DEBRIS_GRAVITY = 26;

  function syncUniforms(dt: number): void {
    uTime.value = ctx.elapsed;

    const cam = ctx.services.player?.camera ?? ctx.camera;
    // Soft particles reconstruct scene depth from gl_FragCoord, so the
    // resolution must track the drawing buffer, not the CSS size.
    ctx.renderer.getDrawingBufferSize(drawSize);
    uResolution.value.set(drawSize.x, drawSize.y);
    uCamRange.value.set(cam.near, cam.far);
    const aspect = drawSize.y > 0 ? drawSize.x / drawSize.y : 1;
    flashLit.material.uniforms.uAspect.value = aspect;
    flashAdd.material.uniforms.uAspect.value = aspect;

    // Mirror whatever fog the sky system installed. Reading it every frame
    // rather than caching it means a storm that swaps the fog out takes the
    // whole particle layer with it, which is exactly what should happen.
    const fog = ctx.scene.fog;
    if (!fog) {
      uFogKind.value = 0;
    } else if ((fog as THREE.FogExp2).isFogExp2) {
      uFogKind.value = 2;
      uFogColor.value.copy(fog.color);
      uFogParams.value.z = (fog as THREE.FogExp2).density;
    } else {
      uFogKind.value = 1;
      uFogColor.value.copy(fog.color);
      uFogParams.value.set((fog as THREE.Fog).near, (fog as THREE.Fog).far, 0);
    }

    // Smoke, dust and decals are lit surfaces, not emitters — tint them by the
    // sun so the same puff reads warm at noon and cold blue at dusk.
    const sky = ctx.services.sky;
    const daylight = THREE.MathUtils.clamp(sky?.daylight ?? 1, 0, 1);
    if (sky?.sunColor) sunTint.copy(sky.sunColor);
    else sunTint.setHex(0xfff3e0);
    uLitTint.value.copy(nightTint).lerp(sunTint, daylight);
    uLitTint.value.multiplyScalar(0.42 + 0.72 * daylight);

    // Impostor lighting needs the sun in VIEW space. Prefer the light's own
    // position over the advertised direction vector: a DirectionalLight's
    // normalised position is unambiguously "toward the sun", where a bare
    // direction vector could mean either end of the same line.
    if (sky?.sun) {
      tmpVec.copy(sky.sun.position);
      if (tmpVec.lengthSq() < 1e-8 && sky.sunDirection) tmpVec.copy(sky.sunDirection);
    } else if (sky?.sunDirection) {
      tmpVec.copy(sky.sunDirection);
    } else {
      tmpVec.set(0.4, 0.85, 0.3);
    }
    if (tmpVec.lengthSq() < 1e-8) tmpVec.set(0, 1, 0);
    tmpVec.normalize().transformDirection(cam.matrixWorldInverse);
    uSunView.value.copy(tmpVec);
    // Direct sun, and a cool sky fill for the shadow side. The fill is pulled
    // off the fog colour so smoke sits in the same air as the island.
    uSunColor.value.copy(sunTint).multiplyScalar(0.75 + 0.65 * daylight);
    skyFill.copy(uFogColor.value).multiplyScalar(0.35 + 0.3 * daylight);
    uSkyColor.value.copy(skyFill).lerp(nightTint, 1 - daylight);

    // Lazy wind: a slow lissajous, so plumes never drift in a dead-straight
    // line and every smoke column on the island agrees on the direction.
    windPhase.v += dt * 0.08;
    const wx = Math.sin(windPhase.v) * 0.22 + Math.sin(windPhase.v * 0.37) * 0.12 + 0.26;
    const wz = Math.cos(windPhase.v * 0.71) * 0.2 - 0.14;
    uWind.value.set(wx, 0, wz);
  }

  /**
   * Debris integration. Lives in fixed() with the rest of the game's physics:
   * a chunk stepped at a variable dt visibly changes its bounce height when
   * the frame rate dips, and a pile of rubble that behaves differently on a
   * slow machine is a bug you cannot reproduce.
   */
  function stepDebris(dt: number): void {
    const terrain = ctx.services.terrain;
    for (const layer of debrisLayers) {
      if (layer.live <= 0) continue;
      let dirty = false;
      for (let i = 0; i < layer.cap; i++) {
        const c = layer.chunks[i];
        if (c.life <= 0) continue;
        c.life -= dt;
        if (c.life <= 0) {
          layer.live--;
          layer.mesh.setMatrixAt(i, zeroMatrix);
          dirty = true;
          // A puff where it finally settles hides the pop-out completely.
          emitBillboard(bbAlpha, c.pos.x, c.pos.y, c.pos.z, 0, 0.3, 0,
            0.9, c.size * 2, c.size * 7, c.ramp, 1, 0.4, 2.4, rr(-1, 1), SPRITE.grit);
          continue;
        }

        if (!c.rest) {
          c.vel.y -= DEBRIS_GRAVITY * dt;
          // Mild air drag so a chunk thrown hard does not sail forever.
          const drag = 1 - Math.min(0.6, 0.55 * dt);
          c.vel.multiplyScalar(drag);
          c.pos.addScaledVector(c.vel, dt);
          c.quat.multiply(tmpQuat2.setFromAxisAngle(c.axis, c.spin * dt));

          const gy = terrain ? terrain.heightAt(c.pos.x, c.pos.z) : -Infinity;
          if (c.pos.y - c.size < gy) {
            c.pos.y = gy + c.size;
            const impactSpeed = -c.vel.y;
            // Low restitution and heavy tangential friction: rubble does not
            // bounce like a ball, it thuds and skitters.
            c.vel.y = Math.abs(c.vel.y) * 0.3;
            c.vel.x *= 0.62;
            c.vel.z *= 0.62;
            c.spin *= 0.55;
            if (impactSpeed > 4) {
              emitBillboard(bbAlpha, c.pos.x, gy + 0.05, c.pos.z,
                rr(-1, 1), rr(0.4, 1.6), rr(-1, 1),
                rr(0.5, 1.0), c.size * 1.5, c.size * 8, c.ramp, 1, 0.3, 3,
                rr(-2, 2), SPRITE.dust);
            }
            if (c.vel.lengthSq() < 1.6) {
              c.rest = true;
              c.vel.set(0, 0, 0);
            }
          }

          // Hot chunks trail embers — the tell that this debris came out of a
          // fire rather than out of a spawner.
          if (c.hot > 0) {
            c.trail -= dt;
            if (c.trail <= 0) {
              c.trail = 0.045;
              emitStreak(c.pos.x, c.pos.y, c.pos.z,
                c.vel.x * 0.25, c.vel.y * 0.25 + 0.6, c.vel.z * 0.25,
                0, -3, 0, rr(0.25, 0.6), 0.03, 1.2, RAMP.ember, rr(1.2, 2.2));
              if (rng() < 0.5) {
                emitBillboard(bbAlpha, c.pos.x, c.pos.y, c.pos.z, 0, 0.7, 0,
                  rr(0.7, 1.5), c.size * 1.6, c.size * 7,
                  RAMP.smokeDark, 1, 0.9, 1.4, rr(-1, 1), SPRITE.smoke);
              }
            }
          }

          tmpScale.set(
            c.scale.x * c.size * 2,
            c.scale.y * c.size * 2,
            c.scale.z * c.size * 2,
          );
          tmpMatrix.compose(c.pos, c.quat, tmpScale);
          layer.mesh.setMatrixAt(i, tmpMatrix);
          dirty = true;
        }
      }
      if (dirty) layer.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  const sys: FixedSystem = {
    name: "vfx",

    fixed(dt) {
      stepDebris(dt);
    },

    update(dt) {
      syncUniforms(dt);
      blastsThisFrame = 0;
      // Shape only — the glue system owns where the endpoints are, and it
      // moves them in fixed(). Nothing physical happens in here, so a frame
      // step is the right step and a camera-facing ribbon needs one anyway.
      stepStrands(dt);

      // --- Light decay --------------------------------------------------------
      for (const fl of lights) {
        if (fl.life <= 0) {
          if (fl.light.intensity !== 0) fl.light.intensity = 0;
          continue;
        }
        fl.life -= dt;
        const remain = Math.max(0, fl.life / fl.dur);
        // Sharp peak, long ember tail — the actual shape of a fireball's
        // light output, and the reason a blast keeps glowing after the flash.
        let k = remain * remain * (0.35 + 0.65 * remain);
        if (fl.flicker > 0) k *= 1 + fl.flicker * Math.sin(ctx.elapsed * 47 + fl.phase);
        fl.light.intensity = Math.max(0, fl.peak * k);
      }

      // --- Screen flash decay -------------------------------------------------
      for (const q of [flashLit, flashAdd]) {
        if (q.life <= 0) {
          if (q.mesh.visible) {
            q.mesh.visible = false;
            q.material.uniforms.uStrength.value = 0;
          }
          continue;
        }
        q.life -= dt;
        const remain = Math.max(0, q.life / q.dur);
        // Cubic out: the flash is at full strength for barely a frame and is
        // most of the way gone before the player has finished registering it.
        q.material.uniforms.uStrength.value = q.peak * remain * remain * remain;
        if (q.life <= 0) {
          q.mesh.visible = false;
          q.material.uniforms.uStrength.value = 0;
        }
      }

      // --- Upload only what changed --------------------------------------------
      bbAdd.ring.flush(bbAdd.attrs);
      bbAlpha.ring.flush(bbAlpha.attrs);
      streakRing.flush(sAttrs);
      ringAdd.ring.flush(ringAdd.attrs);
      ringDust.ring.flush(ringDust.attrs);
      decalRing.flush(dAttrs);
      numberRing.flush(nAttrs);
    },

    /**
     * Camera feedback runs after the player controller has written its
     * transform, so we layer shake on top rather than fighting it. The weapons
     * module adds its recoil on top of ours the same way, and because the
     * controller rewrites pitch/yaw from its own state every frame, none of
     * these additive contributions accumulate.
     */
    lateUpdate(dt) {
      const camera = ctx.services.player?.camera ?? ctx.camera;

      if (trauma > 0) {
        trauma = Math.max(0, trauma - dt * 1.7);
        // Squared trauma: small hits barely register, big ones are violent.
        const k = trauma * trauma;
        const t = ctx.elapsed;
        // Sums of incommensurate frequencies, so the shake never finds a
        // period and never reads as a wobble.
        const rotX = Math.sin(t * 47.3) * 0.5 + Math.sin(t * 91.7) * 0.5;
        const rotY = Math.sin(t * 53.9 + 2.1) * 0.5 + Math.sin(t * 79.1 + 1.3) * 0.5;
        const rotZ = Math.sin(t * 61.7 + 4.7) * 0.5 + Math.sin(t * 103.3 + 0.7) * 0.5;
        camera.rotation.x += rotX * k * 0.05;
        camera.rotation.y += rotY * k * 0.05;
        // Roll is weighted highest: it is the axis that reads as impact
        // without costing the player their aim.
        camera.rotation.z += rotZ * k * 0.085;
        shakeOffset.set(rotY, rotZ, rotX).multiplyScalar(k * 0.2);
        camera.position.add(shakeOffset);
      }

      // FOV punch is applied as a delta so the player controller's own FOV
      // handling pulls it back out naturally instead of being overwritten.
      if (fovPunch > 0.001 || Math.abs(fovApplied) > 0.001) {
        fovPunch = Math.max(0, fovPunch - dt * fovPunch * 9 - dt * 0.4);
        const delta = fovPunch - fovApplied;
        fovApplied = fovPunch;
        if (Math.abs(delta) > 0.0005) {
          camera.fov += delta;
          camera.updateProjectionMatrix();
        }
      }
    },

    resize(width, height) {
      const aspect = height > 0 ? width / height : 1;
      flashLit.material.uniforms.uAspect.value = aspect;
      flashAdd.material.uniforms.uAspect.value = aspect;
    },

    dispose() {
      offShake();
      offFlash();
      offHit();
      offDepth();

      const roots: THREE.Object3D[] = [
        bbAdd.mesh, bbAlpha.mesh, streakMesh, decalMesh, numberMesh,
        ringAdd.mesh, ringDust.mesh, flashLit.mesh, flashAdd.mesh,
        debrisRubble.mesh, debrisSlab.mesh,
      ];
      for (const obj of roots) obj.parent?.remove(obj);
      for (const fl of lights) fl.light.parent?.remove(fl.light);
      // Strand geometries and the shared material are already in the
      // `geometries` / `materials` lists; only the scene nodes need detaching.
      for (const s of strands) {
        s.active = false;
        s.mesh.visible = false;
        s.mesh.parent?.remove(s.mesh);
      }
      strands.length = 0;
      glueMat = null;
      // Beams belong to loot once handed over, but a leaked scene node is
      // still a leaked scene node — detach anything still parented.
      for (const beam of liveBeams) beam.parent?.remove(beam);
      liveBeams.length = 0;

      for (const m of materials) m.dispose();
      for (const g of geometries) g.dispose();
      for (const t of textures) t.dispose();
      // InstancedMesh owns per-instance buffers of its own.
      debrisRubble.mesh.dispose();
      debrisSlab.mesh.dispose();

      materials.length = 0;
      geometries.length = 0;
      textures.length = 0;
      beamMaterials.clear();
      if (ctx.services.vfx === service) ctx.services.vfx = undefined;
      ready = false;
    },
  };

  return sys;
};

export default createVfx;
