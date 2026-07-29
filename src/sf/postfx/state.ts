/**
 * Post-processing runtime state + the imperative handle gameplay talks to.
 *
 * Everything here is mutated at 60 Hz, so — same rule as `frame` in
 * state/store.ts — none of it goes anywhere near React. Gameplay systems call
 * `postFx.triggerDamageFlash(...)` from inside their own frame loop and the
 * pipeline reads the numbers out on its next render. A zustand round-trip for
 * "the screen should be 4% redder" would cost a full React tree diff per hit.
 *
 * The handle is a module singleton *as well as* being exposed through
 * `Pipeline`'s ref, because the systems that need it most (damage, weapons,
 * wingsuit, water) live in other modules and should not have to thread a ref
 * through five components to tint the screen.
 */

/** Hard cap on simultaneous heat-haze emitters. Eight is plenty on screen. */
export const MAX_HEAT_SOURCES = 8;

export type GradeLook = "auto" | "day" | "golden" | "night";

export interface PostFxRuntime {
  /** Master switch. When false the pipeline falls back to a plain render. */
  enabled: boolean;

  /* ---- damage ---- */
  /** 0..1 red vignette intensity. Decays on its own. */
  damage: number;
  /** Direction the hit came from, radians in world space (0 = -Z / north). */
  damageDirection: number;
  /** 0..1 sustained low-health tint, independent of the per-hit flash. */
  lowHealth: number;

  /* ---- depth of field ---- */
  /** Metres. */
  focusDistance: number;
  /** f-number. 2.8 is a cinematic default; 16 is effectively everything sharp. */
  aperture: number;
  /** Millimetres. 35 mm-equivalent focal length of the virtual lens. */
  focalLength: number;
  /** 0..1 master blend — 0 disables the DoF pass entirely. */
  dofBlend: number;
  /** When true the focus distance chases whatever is under the crosshair. */
  autoFocus: boolean;
  /** Metres, written by the pipeline each frame from the centre depth tap. */
  measuredFocus: number;

  /* ---- motion / speed ---- */
  /** 0..1 radial speed lines + radial blur. Wingsuit dives drive this. */
  speedBlur: number;
  /** Multiplier on the velocity-buffer motion blur, 0..2. */
  motionBlurScale: number;

  /* ---- environment overlays ---- */
  /** 0..1 underwater tint + caustic distortion. */
  underwater: number;
  /** 0..1 night-vision (green gain + scanlines + bloom boost). */
  nightVision: number;
  /** 0..1 thermal false-colour. */
  thermal: number;
  /** 0..1 how wet the streets are — drives SSR reflectivity on horizontals. */
  wetness: number;
  /** 0..1 how mirror-like curtain-wall glass is. */
  glassiness: number;

  /* ---- exposure & look ---- */
  /** Manual exposure multiplier applied before the tonemap. */
  exposure: number;
  /** Extra exposure from eye adaptation, converged by the pipeline. */
  adaptedExposure: number;
  /** Full-screen white flash 0..1 (muzzle flash, explosions, respawn). */
  flash: number;
  /** Which graded look to use; "auto" blends by time of day. */
  look: GradeLook;
  /** 0..1 override strength when `look` is not "auto". */
  lookBlend: number;

  /* ---- lens ---- */
  grain: number;
  chromaticAberration: number;
  vignette: number;
  lensDirt: number;
  bloomIntensity: number;
  sharpen: number;

  /* ---- heat haze emitters ---- */
  /** Packed x,y,z,radius per source. */
  heatSources: Float32Array;
  /** Per-source strength, 0..1. */
  heatStrength: Float32Array;
  heatCount: number;

  /* ---- diagnostics ---- */
  /** Frames of accumulated TAA history. The shot harness waits on this. */
  taaFrames: number;
}

export const postfx: PostFxRuntime = {
  enabled: true,

  damage: 0,
  damageDirection: 0,
  lowHealth: 0,

  focusDistance: 12,
  aperture: 4.0,
  focalLength: 35,
  dofBlend: 0,
  autoFocus: true,
  measuredFocus: 12,

  speedBlur: 0,
  motionBlurScale: 1,

  underwater: 0,
  nightVision: 0,
  thermal: 0,
  wetness: 0.28,
  glassiness: 0.85,

  exposure: 1,
  adaptedExposure: 1,
  flash: 0,
  look: "auto",
  lookBlend: 1,

  grain: 0.55,
  chromaticAberration: 0.6,
  vignette: 0.65,
  lensDirt: 0.5,
  bloomIntensity: 1,
  sharpen: 0.35,

  heatSources: new Float32Array(MAX_HEAT_SOURCES * 4),
  heatStrength: new Float32Array(MAX_HEAT_SOURCES),
  heatCount: 0,

  taaFrames: 0,
};

/* ------------------------------------------------------------------ *
 * Imperative handle
 * ------------------------------------------------------------------ */

export interface PostFxHandle {
  /**
   * Punch the damage vignette. `amount` is 0..1 (roughly damage/40 feels
   * right); `direction` is a world-space heading in radians so the red bloom
   * appears on the side the shot came from.
   */
  triggerDamageFlash(amount: number, direction?: number): void;
  /** Sustained low-health tint, 0..1. Call when health crosses a threshold. */
  setLowHealth(v: number): void;

  /**
   * Focus the virtual lens. `distance` in metres; optional `aperture`
   * (f-number) and `focalLength` (mm) let ADS, photo mode and cinematics each
   * pick their own lens. `blend` 0..1 fades the whole effect in.
   */
  setFocus(distance: number, blend?: number, aperture?: number, focalLength?: number): void;
  /** Let the pipeline pick the focus distance from the centre of the screen. */
  setAutoFocus(on: boolean): void;

  /** Wingsuit / vehicle speed lines + radial blur, 0..1. */
  setSpeedBlur(v: number): void;
  /** 0..1 underwater tint and caustic warp. */
  setUnderwater(v: number): void;
  setNightVision(v: number): void;
  setThermal(v: number): void;
  /** How wet the roads look, 0..1 — this is the SSR knob after rain/fog. */
  setWetness(v: number): void;
  /** Manual exposure multiplier. */
  setExposure(v: number): void;
  /** Full-screen white flash, 0..1. Decays automatically. */
  flash(v: number): void;
  /** Pin the colour grade, or return it to time-of-day blending. */
  setLook(look: GradeLook, blend?: number): void;
  /** Bypass the whole chain (debug / very low-end fallback). */
  setEnabled(v: boolean): void;

  /**
   * Register a heat-haze emitter for this frame. Call every frame it should be
   * visible; the list is cleared by the pipeline after each render, exactly
   * like an immediate-mode debug draw.
   */
  addHeatSource(x: number, y: number, z: number, radius: number, strength: number): void;

  /** Frames of converged TAA history — the screenshot harness reads this. */
  readonly taaFrames: number;
  /** True once the image is temporally stable enough to screenshot. */
  readonly converged: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const postFx: PostFxHandle = {
  triggerDamageFlash(amount, direction) {
    // Take the max rather than accumulate: three hits in one frame should not
    // white out the screen, they should read as one solid hit.
    postfx.damage = Math.max(postfx.damage, clamp01(amount));
    if (direction !== undefined) postfx.damageDirection = direction;
  },
  setLowHealth(v) {
    postfx.lowHealth = clamp01(v);
  },
  setFocus(distance, blend, aperture, focalLength) {
    postfx.focusDistance = Math.max(0.1, distance);
    postfx.autoFocus = false;
    if (blend !== undefined) postfx.dofBlend = clamp01(blend);
    if (aperture !== undefined) postfx.aperture = Math.max(0.7, aperture);
    if (focalLength !== undefined) postfx.focalLength = Math.max(8, focalLength);
  },
  setAutoFocus(on) {
    postfx.autoFocus = on;
  },
  setSpeedBlur(v) {
    postfx.speedBlur = clamp01(v);
  },
  setUnderwater(v) {
    postfx.underwater = clamp01(v);
  },
  setNightVision(v) {
    postfx.nightVision = clamp01(v);
  },
  setThermal(v) {
    postfx.thermal = clamp01(v);
  },
  setWetness(v) {
    postfx.wetness = clamp01(v);
  },
  setExposure(v) {
    postfx.exposure = Math.max(0.01, v);
  },
  flash(v) {
    postfx.flash = Math.max(postfx.flash, clamp01(v));
  },
  setLook(look, blend) {
    postfx.look = look;
    if (blend !== undefined) postfx.lookBlend = clamp01(blend);
  },
  setEnabled(v) {
    postfx.enabled = v;
  },
  addHeatSource(x, y, z, radius, strength) {
    if (postfx.heatCount >= MAX_HEAT_SOURCES) return;
    const i = postfx.heatCount++;
    postfx.heatSources[i * 4 + 0] = x;
    postfx.heatSources[i * 4 + 1] = y;
    postfx.heatSources[i * 4 + 2] = z;
    postfx.heatSources[i * 4 + 3] = radius;
    postfx.heatStrength[i] = clamp01(strength);
  },
  get taaFrames() {
    return postfx.taaFrames;
  },
  get converged() {
    return postfx.taaFrames >= 10;
  },
};

/** Reset transient state — called on respawn and level load. */
export function resetPostFx(): void {
  postfx.damage = 0;
  postfx.lowHealth = 0;
  postfx.speedBlur = 0;
  postfx.underwater = 0;
  postfx.nightVision = 0;
  postfx.thermal = 0;
  postfx.flash = 0;
  postfx.dofBlend = 0;
  postfx.autoFocus = true;
  postfx.heatCount = 0;
  postfx.taaFrames = 0;
}
