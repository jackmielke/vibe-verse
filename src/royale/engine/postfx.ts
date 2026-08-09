/**
 * DROP ZERO — post-processing.
 *
 * Everything else in this engine renders a *scene*. This module is what turns
 * it into a *frame*, and it is the difference between "a Three.js demo with
 * nice geometry" and something that reads as a shipped game. Six things are
 * doing that work here, in rough order of how much they matter:
 *
 *   1. The grade. ACES gets us a filmic curve; it does not get us a *look*.
 *      The three-way balance, the lifted-but-not-milky blacks, the cyan in the
 *      shadows and the warm shoulder are the Fortnite tell, and they are worth
 *      more than every other pass in this file combined.
 *   2. Contact occlusion. Without it, props sit *on top of* the ground rather
 *      than *in* it — the single most reliable giveaway in a web renderer.
 *   3. A high bloom threshold, so only the sun, muzzle flashes, loot beams and
 *      the storm wall glow. Scene-wide bloom is the classic amateur tell.
 *   4. God rays out of the treeline. Volume in the air; the README asks for it.
 *   5. Edge AA. Renderer MSAA is off above "low" (see core.ts) precisely so
 *      this pass can own it.
 *   6. Lens character — grain, vignette, a whisper of dispersion at the corners
 *      — which is what stops the image reading as mathematically clean CG.
 *
 * ## Why this is hand-rolled and not `postprocessing`
 *
 * The brief asks for pmndrs, and pmndrs does import cleanly here — every symbol
 * it pulls from three exists in 0.160 and a test composer renders. Three things
 * still argue against it, and all three are about this specific stack:
 *
 *   - `postprocessing@6.39` declares `three: ">= 0.168.0 < 0.186.0"` and this
 *     repo is pinned to 0.160.1. It happens to work today; it is not a contract
 *     anyone is honouring, and the failure mode is a black screen.
 *   - Its merge-into-one-pass advantage evaporates on exactly the effects we
 *     need. `ChromaticAberrationEffect`, `GodRaysEffect` and
 *     `DepthOfFieldEffect` are all convolution effects, and a convolution
 *     effect cannot be merged — each one forces its own full-screen `EffectPass`
 *     anyway. (Verified: adding CA to a shared `EffectPass` throws
 *     "Convolution effects cannot be merged".)
 *   - `SSAOEffect` needs a `NormalPass`, which is a **second full render of the
 *     scene geometry**. On a 3 km island at a 900-draw-call budget that is not
 *     a trade we can make. The AO below reconstructs its normals from depth and
 *     costs one half-res pass.
 *
 * So: one HDR scene render with a real depth attachment, five effects reading
 * that one depth buffer, and a single composite that does the lens, the tone
 * map and the grade in one dependent-texture-fetch-free pass. `SMAAPass` is
 * borrowed from three's own addons — it is a standalone `Pass` and drives fine
 * by hand.
 *
 * Because everything lands in a render target, three skips both its tone
 * mapping and its output colour-space conversion (`WebGLRenderer` only applies
 * either when `currentRenderTarget === null`). Every buffer in here is
 * genuinely scene-referred linear HDR, so the bloom threshold is a real
 * radiance value and ACES is applied exactly once, by us, at the end.
 *
 * Order of operations (high tier):
 *
 *   scene ─▶ HDR + depth
 *         ├─▶ AO       (half res, dual-radius, depth-only, bilateral blurred)
 *         ├─▶ bloom    (prefilter + 5-mip down/up pyramid)
 *         ├─▶ bokeh    (half res golden-angle disc — the ADS defocus)
 *         ├─▶ shafts   (quarter res, sky-masked radial blur from the sun)
 *         └─▶ composite: distortion, dispersion, motion blur, DOF, AO, sharpen,
 *                        bloom, shafts, exposure, ACES, GRADE, vignette,
 *                        hit wedges, low-health pulse, grain, sRGB
 *                    └─▶ SMAA ─▶ screen
 *
 * Consumes  "dz:sun"        {x,y,visible,strength,daylight} — god ray origin
 *           "dz:in-storm"   {inside,intensity,dps}          — purple veil
 *           "dz:underwater" boolean                          — blue + wobble
 *           "dz:hud"        {health,maxHealth,...}           — low-health pulse
 *           "dz:hit"        {angle,amount,shield,lethal}     — directional flash
 *           "dz:crosshair"  {ads}                            — the DOF gate
 *           "dz:shake"      {amount,point,range}             — lens character
 *           "dz:damage"     {amount}                         — hurt vignette
 *           "dz:death" / "dz:down" / "dz:victory"            — grade takeovers
 *           "dz:fx"         {effect,enabled}                  — the switchboard
 * Publishes "dz:postfx"     the render override the engine installs
 *           "dz:depth"      last frame's depth texture, for vfx soft particles
 *
 * ## The switchboard
 *
 * Every pass below can be turned off from outside at runtime, without a
 * rebuild, via `dz:fx {effect, enabled}` — see FX_EFFECTS for the full list and
 * `all` for the wildcard. This is not a debug nicety. Post-processing is the
 * one place in the engine where a wrong number produces a frame that is
 * obviously broken and gives you no clue which of eleven passes broke it, and
 * bisecting that from the outside in eleven captures beats reading this file.
 *
 * Camera motion blur is the one effect that starts **off**; it has to be asked
 * for. The reasoning is on MOTION_DEFAULT_ON.
 *
 * ## SPLASH ROYALE (`ctx.mode === "water"`)
 *
 * Nobody in SPLASH ROYALE gets hurt, so nothing on this lens is allowed to be
 * red. The chain does not change — same passes, same order, same buffers — only
 * what three of them are coloured with, plus two branches that exist nowhere
 * else: `runnel`, the lens getting drenched when YOU are soaked out, and
 * `wetlens`, the beaded, refracting rim as you run out of dry. Both compile out
 * of the classic shader entirely, both are on the `dz:fx` switchboard, and the
 * expensive halves of both are off on `low`. See the block above LOW_HEALTH.
 *
 * Nothing in here is allowed to be fatal. The whole build is wrapped, every
 * frame is wrapped, and a throw at any point hands rendering straight back to
 * the forward path — losing the grade should cost you the grade, not the game.
 *
 * Convention: +X east, +Z south, +Y up. 1 unit = 1 metre.
 */
import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { WATER } from "../mode/water";
import type { QualityTier, System, SystemFactory, WorldCtx } from "../types";

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

interface FxTier {
  /** Attach a depth texture and light up everything that reads it. */
  depth: boolean;
  /** Double-buffer the scene target so vfx can read *last* frame's depth. */
  softDepth: boolean;
  /** Mip count in the bloom pyramid. 0 disables bloom entirely. */
  bloomMips: number;
  /** Occlusion taps per pixel, half res. 0 disables AO. */
  aoTaps: number;
  /** Aim-down-sights defocus. */
  dof: boolean;
  /** Camera-reprojection motion blur taps. 0 disables. */
  mbTaps: number;
  /** Radial-blur samples for the god rays. 0 disables. */
  raySamples: number;
  chromatic: boolean;
  /** Contrast-adaptive sharpen. Cheap, but four extra taps is four too many
   *  on a machine that is already missing frame time. */
  sharpen: boolean;
}

/**
 * "low" is deliberately just AA, the grade and the gameplay-critical screen
 * overlays. The tone curve is 95% of the look and costs nothing beyond the one
 * composite pass we are paying for regardless; the overlays (storm, underwater,
 * low health, hit direction) are *feedback*, not polish, and a player who
 * cannot tell they are standing in the storm is playing a different game.
 */
const TIERS: Record<QualityTier, FxTier> = {
  low: {
    depth: false, softDepth: false, bloomMips: 0, aoTaps: 0,
    dof: false, mbTaps: 0, raySamples: 0, chromatic: false, sharpen: false,
  },
  medium: {
    depth: true, softDepth: true, bloomMips: 4, aoTaps: 6,
    dof: false, mbTaps: 0, raySamples: 12, chromatic: true, sharpen: false,
  },
  high: {
    depth: true, softDepth: true, bloomMips: 5, aoTaps: 10,
    dof: true, mbTaps: 5, raySamples: 18, chromatic: true, sharpen: true,
  },
  ultra: {
    depth: true, softDepth: true, bloomMips: 6, aoTaps: 16,
    dof: true, mbTaps: 9, raySamples: 26, chromatic: true, sharpen: true,
  },
};

// ---------------------------------------------------------------------------
// The grade
//
// This is the most important block of numbers in the module. Read the comment
// on GRADE_DAY before touching any of them.
// ---------------------------------------------------------------------------

/**
 * A full film grade as plain data, applied *after* ACES in display-referred
 * linear. Up to three of these are blended on the CPU every frame (daylight →
 * dusk, then → storm, then → underwater) and the result is pushed into one set
 * of uniforms, so the shader only ever evaluates a single curve.
 */
interface Grade {
  /** Scene-referred exposure multiplier, applied before the tone curve. */
  exposure: number;
  /** Pre-tonemap white balance, as a linear RGB gain. */
  filter: [number, number, number];
  /** Contrast slope about the pivot. */
  contrast: number;
  /** How much of the smooth toe/shoulder S to blend on top of the slope. */
  scurve: number;
  /** Flat brightness offset, post-contrast. */
  offset: number;
  /** Matte black lift. Tinted, and it must stay small or the image goes milky. */
  lift: [number, number, number];
  /** Three-way colour balance. Weights sum to 1 across the luma range. */
  shadowTint: [number, number, number];
  midTint: [number, number, number];
  highTint: [number, number, number];
  saturation: number;
  /** Extra saturation applied only to already-*unsaturated* pixels. */
  vibrance: number;
  /** How hard the top of the range walks toward paper white. */
  bleach: number;
  vignette: number;
  grain: number;
}

/**
 * The house look, and the reference every other grade lerps from.
 *
 * Fortnite's image, decomposed, is four decisions:
 *
 *  - **Blacks are lifted, but not milky.** ~0.014 of lift, tinted blue-cyan.
 *    Enough that no pixel in the frame is dead 0 (which is what makes a web
 *    render look like it is missing a bounce pass), nowhere near enough to read
 *    as fog. This is the single value most likely to be got wrong in both
 *    directions.
 *  - **Cyan shadows, warm highlights.** Complementary split-tone is what gives
 *    a stylised palette its depth without touching albedo. The sun is already
 *    warm; pushing the shade the other way widens the whole gamut for free.
 *  - **Saturated midtones, protected extremes.** Saturation 1.22 with 0.32 of
 *    vibrance on top: the terracotta roofs and grass greens get pulled, the
 *    already-screaming legendary-gold loot beam does not clip to neon.
 *  - **A gentle S, not a contrast crank.** 1.12 of slope about a pivot *below*
 *    mid-grey, plus a real smoothstep S at 0.30. Shadows move more than
 *    highlights, which is what a print curve actually does, and the shoulder
 *    keeps the sky off the clipping ceiling.
 *
 * Verified on paper, not by eye. A mid-green albedo of (0.25, 0.45, 0.18)
 * through `exposure → filter → ACES → grade()` lands on (0.298, 0.578, 0.144),
 * i.e. #93c76a — green channel dominant by a wide margin and *more* saturated
 * than it went in. A deep foliage green (0.10, 0.22, 0.07) lands on #218b00.
 * A sky blue (0.22, 0.42, 0.85) lands on #8fc0eb and a terracotta roof
 * (0.42, 0.13, 0.07) on #cb5721. Those four numbers are the acceptance test
 * for this block: if a change to any value below moves a green off green, the
 * change is wrong no matter how good the frame looked.
 */
const GRADE_DAY: Grade = {
  exposure: 1.05,
  filter: [1.018, 1.0, 0.978],
  contrast: 1.12,
  scurve: 0.3,
  offset: -0.006,
  lift: [0.011, 0.016, 0.027],
  // Shadows cyan, mids dead neutral-to-faintly-green, highlights warm. The old
  // mid was warm (1.012, 1.0, 0.992), which quietly pushed every midtone in the
  // frame — which on a landscape is *the grass* — a step toward magenta.
  shadowTint: [0.93, 1.004, 1.072],
  midTint: [1.004, 1.006, 0.986],
  highTint: [1.062, 1.016, 0.938],
  saturation: 1.22,
  vibrance: 0.32,
  bleach: 0.09,
  vignette: 0.3,
  grain: 0.018,
};

/**
 * Golden hour rolling into dusk. Cooler, flatter, grainier, and the vignette
 * closes down — a pushed stock. Blended in off `sky.daylight`, so a match that
 * runs long walks into this on its own.
 */
const GRADE_DUSK: Grade = {
  exposure: 1.14,
  filter: [0.955, 0.99, 1.07],
  contrast: 1.05,
  scurve: 0.16,
  offset: 0.004,
  lift: [0.018, 0.026, 0.044],
  shadowTint: [0.85, 0.96, 1.16],
  midTint: [1.0, 1.0, 1.01],
  highTint: [1.03, 1.005, 0.985],
  saturation: 0.92,
  vibrance: 0.2,
  bleach: 0.05,
  vignette: 0.42,
  grain: 0.042,
};

/**
 * Inside the wall. Violet, cooled and closed in.
 *
 * ## This grade is why every DROP ZERO frame ever captured came out lavender
 *
 * The previous version of this block was a *replacement* look rather than an
 * overlay: `filter` cut green to 0.62 while lifting blue to 1.24, all three
 * tint zones cut green by another ~0.27, saturation fell to 0.42 and the black
 * lift went to (0.078, 0.03, 0.118). Run a mid-green (0.25, 0.45, 0.18)
 * through it at full strength and it comes out #968b9a — a dead mauve grey
 * with the green channel now the *smallest* of the three. Grass, trees,
 * terrain and roofs all converged on the same pastel violet, which is exactly
 * what the first capture pass shows.
 *
 * Two things made that fire on every single frame:
 *
 *   1. `updateStormIntensity` had no phase gate, so the bus phase — where the
 *      player is *definitionally* outside the safe zone, 2 km up and 90 s from
 *      the circle mattering — drove it straight to full.
 *   2. Its floor was 0.35 the instant you crossed the wall, so even the mildest
 *      "you are out" state was a third of the way into a look that destroys hue.
 *
 * Both are fixed below and at the call site. This grade is now a tint you look
 * *through*: green stays green (a mid-green lands #9db490 at the 0.8 cap, still
 * green-dominant), neutrals go clearly violet (#7c6c88), saturation drops a
 * little rather than collapsing, and the vignette and grain do most of the
 * "get out" work because they cost no hue at all.
 */
const GRADE_STORM: Grade = {
  exposure: 0.95,
  filter: [1.02, 0.9, 1.1],
  contrast: 1.06,
  scurve: 0.22,
  offset: 0.004,
  lift: [0.03, 0.014, 0.048],
  shadowTint: [1.1, 0.92, 1.22],
  midTint: [1.06, 0.94, 1.16],
  highTint: [1.04, 0.96, 1.1],
  saturation: 0.8,
  vibrance: 0.1,
  bleach: 0.02,
  vignette: 0.55,
  grain: 0.04,
};

/**
 * Ceiling on how far the storm grade is ever allowed to blend in, however deep
 * past the wall the player is. Standing 400 m into the storm should be
 * unmistakable and *still legible* — you have to be able to see the person
 * shooting at you. The screen warp, the grain and the vignette keep ramping
 * past this; only the hue-destroying part is capped.
 */
const STORM_GRADE_MAX = 0.8;

/**
 * Match phases during which the storm grade is suppressed outright, no matter
 * what the storm service says about the player's position. On the bus and
 * under canopy the player is always outside the circle and Fortnite shows no
 * storm treatment at all — veiling the drop is both wrong and the single most
 * damaging thing this module can do to a first impression.
 */
const NO_STORM_PHASES = new Set(["warmup", "bus", "dropping"]);

/** Below the waterline: everything the water absorbed on the way in. */
const GRADE_WATER: Grade = {
  exposure: 0.86,
  filter: [0.36, 0.84, 1.02],
  contrast: 1.02,
  scurve: 0.1,
  offset: 0.008,
  lift: [0.006, 0.03, 0.042],
  shadowTint: [0.62, 1.0, 1.14],
  midTint: [0.7, 1.0, 1.1],
  highTint: [0.8, 1.02, 1.06],
  saturation: 0.8,
  vibrance: 0.1,
  bleach: 0.03,
  vignette: 0.6,
  grain: 0.03,
};

/**
 * Knocked down, and dying. Desaturating toward monochrome with the blood
 * pushed back in — the standard "you are about to be eliminated" language, and
 * it costs nothing because it is the same shader path as everything else.
 */
const GRADE_DOWN: Grade = {
  exposure: 0.9,
  filter: [1.06, 0.9, 0.88],
  contrast: 1.16,
  scurve: 0.34,
  offset: -0.01,
  lift: [0.02, 0.008, 0.008],
  shadowTint: [1.1, 0.9, 0.88],
  midTint: [1.06, 0.9, 0.9],
  highTint: [1.08, 0.94, 0.9],
  saturation: 0.32,
  vibrance: 0.0,
  bleach: 0.06,
  vignette: 0.72,
  grain: 0.06,
};

/**
 * SPLASH ROYALE's replacement for GRADE_DOWN.
 *
 * Same slot in the chain, opposite message. Being soaked out is not dying: the
 * frame goes *brighter*, cooler and a little washed — the look of a photograph
 * taken through a wet window on a sunny day — instead of draining to grey with
 * the blood pushed back in. Saturation falls to 0.62 rather than 0.32 (the
 * island stays an island), the vignette closes to 0.5 rather than 0.72, and the
 * bleach goes *up*, which is what sells "there is water on the lens" without
 * spending a single pixel on hue.
 */
const GRADE_SOAKED: Grade = {
  exposure: 1.04,
  filter: [0.82, 0.98, 1.14],
  contrast: 1.03,
  scurve: 0.18,
  offset: 0.012,
  lift: [0.012, 0.03, 0.052],
  shadowTint: [0.84, 1.0, 1.2],
  midTint: [0.88, 1.0, 1.14],
  highTint: [0.94, 1.02, 1.1],
  saturation: 0.62,
  vibrance: 0.14,
  bleach: 0.14,
  vignette: 0.5,
  grain: 0.02,
};

function mixGrade(a: Grade, b: Grade, t: number, out: Grade): void {
  const l = (x: number, y: number) => x + (y - x) * t;
  const l3 = (
    x: [number, number, number],
    y: [number, number, number],
    o: [number, number, number],
  ) => {
    o[0] = l(x[0], y[0]);
    o[1] = l(x[1], y[1]);
    o[2] = l(x[2], y[2]);
  };
  out.exposure = l(a.exposure, b.exposure);
  l3(a.filter, b.filter, out.filter);
  out.contrast = l(a.contrast, b.contrast);
  out.scurve = l(a.scurve, b.scurve);
  out.offset = l(a.offset, b.offset);
  l3(a.lift, b.lift, out.lift);
  l3(a.shadowTint, b.shadowTint, out.shadowTint);
  l3(a.midTint, b.midTint, out.midTint);
  l3(a.highTint, b.highTint, out.highTint);
  out.saturation = l(a.saturation, b.saturation);
  out.vibrance = l(a.vibrance, b.vibrance);
  out.bleach = l(a.bleach, b.bleach);
  out.vignette = l(a.vignette, b.vignette);
  out.grain = l(a.grain, b.grain);
}

/** Overwrite `out` in place. Used by the `dz:fx` grade bypass. */
function copyGrade(src: Grade, out: Grade): void {
  mixGrade(src, src, 0, out);
}

function cloneGrade(g: Grade): Grade {
  return {
    ...g,
    filter: [...g.filter] as [number, number, number],
    lift: [...g.lift] as [number, number, number],
    shadowTint: [...g.shadowTint] as [number, number, number],
    midTint: [...g.midTint] as [number, number, number],
    highTint: [...g.highTint] as [number, number, number],
  };
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Bloom threshold, in scene-referred linear radiance. 1.0 is roughly "a white
 * surface in full sun", so at 1.15 the only things that get through are actual
 * emitters: the sun disc, specular glints off the sea, muzzle flashes,
 * explosions, rarity loot beams and the storm wall. Dropping this below 1 is
 * the fastest way to make a whole island look like it is behind gauze.
 */
const BLOOM_THRESHOLD = 1.15;
const BLOOM_KNEE = 0.55;
/** Ceiling on one prefiltered texel, so the sun cannot bleach the frame. */
const BLOOM_CLAMP = 16;
/** Per-level gain on the way back up; < 1 keeps the widest mips subtle. */
const BLOOM_MIP_GAIN = 0.66;

const BLOOM_STRENGTH: Record<QualityTier, number> = {
  low: 0, medium: 0.04, high: 0.052, ultra: 0.058,
};

/**
 * Occlusion radii, in metres. Two of them: the small one is the *contact*
 * darkening that welds a crate to the floor it is standing on, and it is the
 * one that actually stops things looking pasted; the large one is broad ambient
 * shadowing under eaves and inside doorways. Running both from one tap loop is
 * nearly free and reads far better than either alone.
 */
const AO_RADIUS_NEAR = 0.42;
const AO_RADIUS_FAR = 2.1;
const AO_STRENGTH: Record<QualityTier, number> = {
  low: 0, medium: 0.44, high: 0.56, ultra: 0.62,
};

/**
 * Depth of field is ADS-only and deliberately shallow. A permanently soft
 * battle royale is unplayable — you cannot spot a player at 150 m through a
 * bokeh buffer — so there is no always-on far field here at all. Distance
 * softness is the sky system's aerial fog's job, and it does it in-scene where
 * it belongs.
 */
const DOF_ADS_STRENGTH = 0.72;
/** Half-res pixels of blur in the bokeh buffer. */
const DOF_BOKEH_RADIUS = 5.0;
/** Focus is re-cast at this rate, not every frame — a raycast is not free. */
const DOF_REFOCUS_HZ = 12;

/** A 180° shutter at 30 fps. Scaling to this keeps smear length framerate-independent. */
const MOTION_SHUTTER = 1 / 60;
const MOTION_STRENGTH: Record<QualityTier, number> = {
  low: 0, medium: 0, high: 0.22, ultra: 0.26,
};

/**
 * Camera motion blur is **off by default** and must be switched on with
 * `dz:fx {effect:"motion", enabled:true}`.
 *
 * It is the effect with the worst risk/reward ratio in the whole module. At
 * best it is something you have to look for; at worst — and this is what the
 * first capture pass produced — it renders the frame illegible. The old
 * velocity path had no notion of a teleport: it *clamped* the reprojection
 * vector to a 0.045-uv ceiling rather than rejecting it, so a camera that had
 * been posed rather than flown (which is exactly what a capture harness does,
 * and what a respawn, a vehicle exit or a spectator switch does in the game)
 * produced not "no blur" but the **maximum possible blur**, in whatever
 * direction the jump happened to point. Every frame after a pose was smeared
 * by 72 px at 1600 wide.
 *
 * Everything below is now guarded — see `MOTION_MAX_*` and the CPU gate in
 * `renderFrame` — so turning it on is safe. It stays off because a sharp frame
 * beats a smeared one and a still capture gains nothing from it.
 */
const MOTION_DEFAULT_ON = false;

/**
 * A camera that moved further than this in one frame did not *move*, it was
 * *placed*. Reject the frame's reprojection entirely rather than blurring
 * along a vector that describes a cut. 12 m is well past any legitimate
 * single-frame translation: a sprint is ~8 m/s and even the bus at 60 m/s
 * covers 3.3 m in a 18 fps frame.
 */
const MOTION_MAX_STEP = 12;
/** Same idea for rotation. ~34°, far past any mouse flick inside one frame. */
const MOTION_MAX_TURN = 0.6;
/**
 * Hard ceiling on the smear, in uv. Was 0.045 — 4.5% of the frame, which at
 * 1600 px is 72 px of streak and reads as a broken driver. 0.010 is ~16 px:
 * present when you pan, invisible when you do not.
 */
const MOTION_MAX_UV = 0.01;
/**
 * Above this raw reprojection length the shader treats the pixel as a
 * discontinuity — a disocclusion, a depth-buffer miss, or a camera cut the CPU
 * gate did not catch — and leaves it alone. Belt and braces for the gate.
 */
const MOTION_REJECT_UV = 0.2;

const RAY_STRENGTH: Record<QualityTier, number> = {
  low: 0, medium: 0.24, high: 0.3, ultra: 0.34,
};
/** How far down the screen a single shaft is allowed to travel, in uv. */
const RAY_DENSITY = 0.78;
const RAY_DECAY = 0.958;

/** Lens dispersion at the extreme corner, in uv. Zero at the centre by design. */
const CHROMATIC = 0.0038;

/** Unsharp amount. Above ~0.35 it starts ringing on the roofline against sky. */
const SHARPEN = 0.28;

/** Concurrent directional hit indicators. Three is more than anyone survives. */
const HIT_SLOTS = 3;

/** Health fraction below which the low-health pulse starts. */
const LOW_HEALTH = 0.36;

// ---------------------------------------------------------------------------
// SPLASH ROYALE — the same three screen effects, restated in water
//
// Drop Zero's lens speaks the language of a shooter: blood in the corners, a
// red wedge in the bearing of whoever shot you, a dark red breath at the edge
// when you are nearly dead. In a game whose entire promise is that NOBODY GETS
// HURT, every one of those is a lie. The passes stay exactly where they are —
// same shader, same slots, same cost — and only their colour changes, which is
// why all three are uniforms below rather than literals in the fragment.
//
// Every water colour is read out of `mode/water.ts` rather than picked here, so
// the wedge at the edge of the frame is the same blue as the Downpour's rim in
// the world and the pulse is the same blue as the DRENCHED band on the bar.
// ---------------------------------------------------------------------------

const DOWN_PALETTE = WATER.downpour.palette;

/** `0x4c9fe0` → `[0.298, 0.624, 0.878]`, in the same space the classic literals
 *  beside it were picked in (display-referred, post-grade, pre-sRGB). */
function rgbOf(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/** A *multiply* tint of the same hue, scaled so its brightest channel is `peak`.
 *  The hurt vignette multiplies rather than mixes, so it needs a gain triple and
 *  not a colour — this keeps that gain honest to the palette it came from. */
function gainOf(hex: number, peak: number): [number, number, number] {
  const c = rgbOf(hex);
  const m = Math.max(c[0], c[1], c[2]) || 1;
  return [(c[0] / m) * peak, (c[1] / m) * peak, (c[2] / m) * peak];
}

/** Corners on taking a hit. Classic pulls blood; water pulls the Downpour's own
 *  blue at exactly the same weight, so the effect reads identically strong. */
const HURT_TINT_CLASSIC: [number, number, number] = [1.4, 0.28, 0.24];
const HURT_TINT_WATER = gainOf(DOWN_PALETTE.wall, 1.4);

/** The directional wedge. Water takes the bright rim colour where the Downpour
 *  meets the ground — the brightest, most obviously *wet* value in the table. */
const HIT_TINT_CLASSIC: [number, number, number] = [1.0, 0.14, 0.1];
const HIT_TINT_WATER = rgbOf(DOWN_PALETTE.rim);

/** The edge breath. Water uses the DRENCHED band, which is the colour the
 *  dryness bar is showing at the same instant — one warning, one colour. */
const LOW_TINT_CLASSIC: [number, number, number] = [0.62, 0.03, 0.03];
const LOW_TINT_WATER = rgbOf(
  WATER.bands.find((b) => b.key === "drenched")?.color ?? 0x4c9fe0,
);

/**
 * Simulated seconds the soak-out runnel takes to sheet down the lens and clear.
 *
 * SIMULATED, not wall clock: this container runs the sim ~400x slower than real
 * time under SwiftSHADER, and a drench timed off `performance.now()` would be
 * over before the first frame of it ever rendered.
 */
const RUNNEL_TIME = 2.6;

// ---------------------------------------------------------------------------
// The switchboard
// ---------------------------------------------------------------------------

/**
 * Every effect in the chain, independently switchable at runtime via
 * `dz:fx {effect, enabled}`.
 *
 * This exists because of how the first capture pass went. Six frames came back
 * washed violet and streaked, and answering "which pass did that?" required
 * reading 2000 lines and reasoning about a shader nobody could step through.
 * With this, a capture pass can bisect the whole chain from the outside without
 * a rebuild:
 *
 *     world.emit("dz:fx", { effect: "grade",  enabled: false });  // raw ACES
 *     world.emit("dz:fx", { effect: "motion", enabled: true  });  // opt back in
 *     world.emit("dz:fx", { effect: "all",    enabled: false });  // scene only
 *
 * A switch can only ever turn something *off* that the tier already allows —
 * enabling `bloom` on the "low" tier does nothing, because the pyramid does not
 * exist there. `all` is a wildcard that hits every key at once.
 */
const FX_EFFECTS = [
  "bloom",
  "ao",
  "dof",
  "motion",
  "rays",
  "chromatic",
  "sharpen",
  "grade",
  "storm",
  "water",
  "vignette",
  "grain",
  "hits",
  "lowhealth",
  "aa",
  // SPLASH ROYALE only. Both compile out of the shader entirely in classic, but
  // they are switchable for the same reason everything else here is: when a
  // capture comes back wrong, bisecting from the outside beats reading GLSL.
  "runnel",
  "wetlens",
] as const;

type FxEffect = (typeof FX_EFFECTS)[number];

function defaultFxState(): Record<FxEffect, boolean> {
  const out = {} as Record<FxEffect, boolean>;
  for (const k of FX_EFFECTS) out[k] = true;
  // The one effect that is opt-in rather than opt-out. See MOTION_DEFAULT_ON.
  out.motion = MOTION_DEFAULT_ON;
  return out;
}

/** The identity grade: what "grade off" means. Straight ACES, nothing else. */
const GRADE_OFF: Grade = {
  exposure: 1,
  filter: [1, 1, 1],
  contrast: 1,
  scurve: 0,
  offset: 0,
  lift: [0, 0, 0],
  shadowTint: [1, 1, 1],
  midTint: [1, 1, 1],
  highTint: [1, 1, 1],
  saturation: 1,
  vibrance: 0,
  bleach: 0,
  vignette: 0,
  grain: 0,
};

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Depth reconstruction, shared by AO, DOF, motion blur and the shafts. */
const DEPTH_CHUNK = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 uPlanes;    // near, far
uniform vec2 uUvToView;  // tan(fov/2) * aspect, tan(fov/2)

/** Window-space depth (0..1) to a positive distance along the view axis. */
float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uPlanes.x * uPlanes.y) /
         (uPlanes.y + uPlanes.x - z * (uPlanes.y - uPlanes.x));
}

/** View-space position of a pixel, from its uv and its linear depth. */
vec3 viewPosition(vec2 uv, float vz) {
  return vec3((uv * 2.0 - 1.0) * uUvToView * vz, -vz);
}
`;

const LUMA_CHUNK = /* glsl */ `
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c) { return dot(c, LUMA); }
`;

const HASH_CHUNK = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
`;

// ---------------------------------------------------------------------------
// Ambient occlusion — depth only, no normal buffer, no second scene pass
// ---------------------------------------------------------------------------

/**
 * Alchemy-style obscurance over a golden-angle spiral, with the surface normal
 * reconstructed from the *closest* depth difference on each axis so a
 * silhouette does not smear a false normal across its own discontinuity.
 *
 * The dual-radius trick: the spiral's sample index decides which radius a tap
 * uses, alternating between the tight contact radius and the wide ambient one,
 * and the two occlusion sums are combined with the near term weighted heavier.
 * One loop, one depth fetch per tap, two very different-looking effects — the
 * hard dark line where a crate meets the ground, *and* the soft gloom under an
 * awning.
 *
 * Output: R = occlusion, G = linear depth (carried so the blur can be bilateral
 * without paying for a second depth fetch).
 */
function buildAoFragment(taps: number): string {
  return /* glsl */ `
precision highp float;
varying vec2 vUv;
${DEPTH_CHUNK}
${HASH_CHUNK}
uniform vec2 uDepthTexel;  // 1 / full-resolution depth buffer
uniform vec2 uRadius;      // contact, ambient — metres
uniform float uProjScale;
uniform float uAspect;
uniform float uIntensity;

#define TAPS ${Math.max(2, Math.round(taps))}
/**
 * Angle bias, as the sine of a sample's elevation above the tangent plane —
 * about 9°.
 *
 * An *angle* bias rather than a metric one, because a metric bias has to be
 * tuned against both the depth buffer's precision and the local viewing angle,
 * and it always loses somewhere: too small and a floor seen edge-on
 * self-occludes into visible bands, too large and a crate stops touching the
 * ground it is standing on. This one number holds from a doorframe to the far
 * side of a POI.
 */
#define UBIAS 0.16
const float GOLDEN = 2.39996323;

void main() {
  // This pass runs at half resolution against a full-resolution depth buffer,
  // and a half-res pixel centre lands *exactly on a full-res texel boundary*.
  // NEAREST filtering there is a coin flip that can resolve differently on
  // adjacent rows; the reconstructed normal then wobbles row to row and paints
  // periodic horizontal bands across any large near-ground surface. Nudging by
  // half a full-res texel puts every fetch squarely inside one texel. This is
  // not a micro-optimisation — without it the ground in front of the player is
  // visibly striped.
  vec2 uv = vUv + uDepthTexel * 0.5;

  float d = texture2D(tDepth, uv).x;
  // The sky writes no depth. Occluding it would ring every roofline in the
  // frame with a dark halo, which is the tell of a badly clamped AO pass.
  if (d >= 0.99999) { gl_FragColor = vec4(1.0, 1e4, 0.0, 1.0); return; }

  float vz = linearDepth(d);
  vec3 p = viewPosition(uv, vz);

  // Derivative stencil in exact multiples of the *depth* texel, for the same
  // reason: a 1.5-texel offset rounds inconsistently and re-introduces the
  // wobble the half-texel nudge above just removed.
  vec2 ex = vec2(uDepthTexel.x * 2.0, 0.0);
  vec2 ey = vec2(0.0, uDepthTexel.y * 2.0);
  float zl = linearDepth(texture2D(tDepth, uv - ex).x);
  float zr = linearDepth(texture2D(tDepth, uv + ex).x);
  float zd = linearDepth(texture2D(tDepth, uv - ey).x);
  float zu = linearDepth(texture2D(tDepth, uv + ey).x);
  vec3 dpx = abs(zr - vz) < abs(vz - zl)
    ? viewPosition(uv + ex, zr) - p
    : p - viewPosition(uv - ex, zl);
  vec3 dpy = abs(zu - vz) < abs(vz - zd)
    ? viewPosition(uv + ey, zu) - p
    : p - viewPosition(uv - ey, zd);
  vec3 n = normalize(cross(dpx, dpy));
  if (n.z < 0.0) n = -n;

  // World radius projected to screen, then capped: a wall 40 cm from the eye
  // would otherwise ask for a quarter-screen gather and stall the warp.
  vec2 radiusUv = min(uRadius * uProjScale / vz, vec2(0.02, 0.07));
  float rot = hash12(gl_FragCoord.xy) * 6.2831853;
  vec2 r2 = uRadius * uRadius;

  vec2 occ = vec2(0.0);
  for (int i = 0; i < TAPS; i++) {
    float fi = (float(i) + 0.5) / float(TAPS);
    float ang = rot + float(i) * GOLDEN;
    // Even taps take the contact radius, odd taps the ambient one.
    float far = mod(float(i), 2.0);
    float rad = mix(radiusUv.x, radiusUv.y, far) * sqrt(fi);
    vec2 suv = uv + vec2(cos(ang) / uAspect, sin(ang)) * rad;
    float sd = texture2D(tDepth, suv).x;
    if (sd >= 0.99999) continue;

    vec3 v = viewPosition(suv, linearDepth(sd)) - p;
    float vv = dot(v, v);
    float ndv = dot(n, v) * inversesqrt(vv + 1e-6);
    // Falls off to nothing at the radius, which is what kills the far-field
    // halo an unbounded estimator produces.
    float rr = mix(r2.x, r2.y, far);
    float fade = clamp(1.0 - vv / rr, 0.0, 1.0);
    float o = max(0.0, ndv - UBIAS) * fade;
    occ += vec2(o * (1.0 - far), o * far);
  }

  // Twice the weight on the contact term. That is the one doing the work of
  // gluing objects to the ground; the wide term is atmosphere.
  float sum = occ.x * 2.0 + occ.y * 0.9;
  float ao = max(0.0, 1.0 - sum * (4.4 * uIntensity / float(TAPS)));
  ao = pow(ao, 1.4);
  // Contact darkening is a *contact* effect. Past a couple of blocks it is
  // sub-pixel and only contributes noise, so retire it into the aerial haze.
  ao = mix(ao, 1.0, smoothstep(90.0, 240.0, vz));
  gl_FragColor = vec4(ao, vz, 0.0, 1.0);
}
`;
}

/** 3x3 cross-bilateral blur that respects the linear depth carried in G. */
const AO_BLUR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tAO;
uniform vec2 uTexel;

void main() {
  vec2 c = texture2D(tAO, vUv).rg;
  float sum = 0.0;
  float wsum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 s = texture2D(tAO, vUv + vec2(float(x), float(y)) * uTexel * 1.5).rg;
      // Depth similarity, relative to the centre distance — a 20 cm gap matters
      // at arm's length and is meaningless across the bay.
      float w = exp(-abs(s.y - c.y) / max(0.06 * c.y, 0.05));
      sum += s.x * w;
      wsum += w;
    }
  }
  gl_FragColor = vec4(sum / max(wsum, 1e-4), c.y, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Bloom pyramid
// ---------------------------------------------------------------------------

/** Soft-knee highpass with a 4-tap box prefilter to kill single-pixel fireflies. */
const BLOOM_PREFILTER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
uniform float uClamp;

void main() {
  vec3 c = texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb
         + texture2D(tSrc, vUv + vec2( 1.0, -1.0) * uTexel).rgb
         + texture2D(tSrc, vUv + vec2(-1.0,  1.0) * uTexel).rgb
         + texture2D(tSrc, vUv + vec2( 1.0,  1.0) * uTexel).rgb;
  c = max(c * 0.25, vec3(0.0));
  c = min(c, vec3(uClamp));

  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  gl_FragColor = vec4(c * (max(soft, br - uThreshold) / max(br, 1e-4)), 1.0);
}
`;

/** 13-tap downsample. Costs more than a box and has no visible pyramid banding. */
const BLOOM_DOWN_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;

vec3 s(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }

void main() {
  vec3 a = s(vec2(-2.0,  2.0)); vec3 b = s(vec2( 0.0,  2.0)); vec3 c = s(vec2( 2.0,  2.0));
  vec3 d = s(vec2(-2.0,  0.0)); vec3 e = s(vec2( 0.0,  0.0)); vec3 f = s(vec2( 2.0,  0.0));
  vec3 g = s(vec2(-2.0, -2.0)); vec3 h = s(vec2( 0.0, -2.0)); vec3 i = s(vec2( 2.0, -2.0));
  vec3 j = s(vec2(-1.0,  1.0)); vec3 k = s(vec2( 1.0,  1.0));
  vec3 l = s(vec2(-1.0, -1.0)); vec3 m = s(vec2( 1.0, -1.0));
  gl_FragColor = vec4(
    e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125,
    1.0);
}
`;

/** 3x3 tent upsample, blended additively into the level above. */
const BLOOM_UP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uGain;

vec3 s(vec2 o) { return texture2D(tSrc, vUv + o * uTexel * uRadius).rgb; }

void main() {
  vec3 c = s(vec2(-1.0,  1.0)) + s(vec2(0.0,  1.0)) * 2.0 + s(vec2(1.0,  1.0))
         + s(vec2(-1.0,  0.0)) * 2.0 + s(vec2(0.0, 0.0)) * 4.0 + s(vec2(1.0, 0.0)) * 2.0
         + s(vec2(-1.0, -1.0)) + s(vec2(0.0, -1.0)) * 2.0 + s(vec2(1.0, -1.0));
  gl_FragColor = vec4(c * (uGain / 16.0), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Bokeh — the ADS defocus
// ---------------------------------------------------------------------------

/**
 * Thirteen taps on a golden-angle disc at half resolution. A disc, not a
 * gaussian: an out-of-focus highlight has to keep a round shape or the whole
 * far field reads as a smudge instead of as a lens.
 */
const BOKEH_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;

#define TAPS 13
const float GOLDEN = 2.39996323;

void main() {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < TAPS; i++) {
    float fi = (float(i) + 0.5) / float(TAPS);
    float a = float(i) * GOLDEN;
    vec2 off = vec2(cos(a), sin(a)) * sqrt(fi) * uRadius * uTexel;
    vec3 c = texture2D(tSrc, vUv + off).rgb;
    // Energy-weighted: bright taps dominate, which is what makes a highlight
    // bloom into a disc rather than being averaged into grey.
    float w = 1.0 / (1.0 + max(c.r, max(c.g, c.b)) * 0.35);
    acc += c * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc / max(wsum, 1e-4), 1.0);
}
`;

// ---------------------------------------------------------------------------
// God rays
// ---------------------------------------------------------------------------

/**
 * The occlusion buffer. Only pixels that are both *sky* (nothing wrote depth)
 * and *bright* survive, so the island's own geometry becomes the occluder for
 * free — the shafts stripe correctly between trees, through a roofline, and
 * around the storm wall without a single extra draw call.
 */
const RAY_MASK_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform sampler2D tDepth;
uniform float uThreshold;
uniform vec2 uSunUv;
${LUMA_CHUNK}

void main() {
  float sky = step(0.99999, texture2D(tDepth, vUv).x);
  vec3 c = texture2D(tSrc, vUv).rgb;
  float w = smoothstep(uThreshold, uThreshold * 3.0, luma(c));
  // Weight toward the sun: sky brightness a long way from the disc is just
  // sky, and letting it into the mask turns the shafts into a screen-wide
  // radial smear, which is the amateur version of this effect.
  float d = distance(vUv, uSunUv);
  w *= 1.0 - smoothstep(0.16, 0.88, d);
  gl_FragColor = vec4(min(c, vec3(28.0)) * w * sky, 1.0);
}
`;

function buildRayFragment(samples: number): string {
  return /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uSunUv;
uniform float uDensity;
uniform float uDecay;
uniform float uJitter;
${HASH_CHUNK}

#define SAMPLES ${Math.max(4, Math.round(samples))}

void main() {
  vec2 delta = (vUv - uSunUv) * (uDensity / float(SAMPLES));
  // Jittering the ray start by one step breaks the banding a fixed march
  // produces across a smooth sky gradient. Cheaper than doubling SAMPLES.
  vec2 uv = vUv - delta * hash12(gl_FragCoord.xy + uJitter);
  float illum = 1.0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < SAMPLES; i++) {
    uv -= delta;
    // Taps that walk off screen must contribute nothing, or clamp-to-edge
    // smears the border texel into a false shaft along the whole frame edge.
    vec2 inb = step(vec2(0.0), uv) * step(uv, vec2(1.0));
    acc += texture2D(tSrc, uv).rgb * illum * inb.x * inb.y;
    illum *= uDecay;
  }
  gl_FragColor = vec4(acc / float(SAMPLES), 1.0);
}
`;
}

// ---------------------------------------------------------------------------
// Composite — lens, tonemap, grade, overlays
// ---------------------------------------------------------------------------

interface CompositeFlags {
  depth: boolean;
  bloom: boolean;
  ao: boolean;
  dof: boolean;
  mbTaps: number;
  rays: boolean;
  chromatic: boolean;
  sharpen: boolean;
  /** SPLASH ROYALE: compile the wet-lens branches in at all. */
  wet: boolean;
  /** …and the per-rivulet refraction, which is the part `low` does without. */
  wetRich: boolean;
}

function buildCompositeFragment(f: CompositeFlags): string {
  const def = (name: string, on: boolean) => (on ? `#define ${name}` : `// no ${name}`);
  return /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tAO;
uniform sampler2D tBokeh;
uniform sampler2D tRays;

uniform vec2  uTexel;
uniform float uAspect;
uniform float uTime;

uniform float uBloom;
uniform float uAO;
uniform float uRays;
uniform vec3  uRayTint;
uniform vec2  uDof;        // focus distance, focus range (metres)
uniform float uAds;
uniform float uMotion;
uniform float uSharpen;
uniform mat4  uInvViewProj;
uniform mat4  uPrevViewProj;

// --- screen-space overlays ------------------------------------------------
uniform float uWater;      // 0..1 submerged
uniform float uStorm;      // 0..1 inside the wall
uniform float uHurt;       // decaying damage flash
uniform float uShake;      // decaying trauma, lens character only
uniform float uLowHealth;  // 0..1 ramp below LOW_HEALTH
uniform vec3  uHit[${HIT_SLOTS}];  // xy = screen direction, z = strength
uniform float uChromatic;

// The three feedback colours. Uniforms rather than literals so SPLASH ROYALE can
// restate the whole language of the lens without a second shader variant; the
// classic values are pushed in unchanged, so classic's frame is untouched.
uniform vec3  uHurtTint;   // multiplied into the corners on taking a hit
uniform vec3  uHitTint;    // the directional wedge
uniform vec3  uLowTint;    // the edge breath as the bar empties

// --- grade ----------------------------------------------------------------
uniform float uExposure;
uniform vec3  uFilter;
uniform float uContrast;
uniform float uScurve;
uniform float uOffset;
uniform vec3  uLift;
uniform vec3  uShadowTint;
uniform vec3  uMidTint;
uniform vec3  uHighTint;
uniform float uSaturation;
uniform float uVibrance;
uniform float uBleach;
uniform float uVignette;
uniform float uGrain;

${def("USE_DEPTH", f.depth)}
${def("USE_BLOOM", f.bloom)}
${def("USE_AO", f.ao)}
${def("USE_DOF", f.dof)}
${def("USE_RAYS", f.rays)}
${def("USE_CA", f.chromatic)}
${def("USE_SHARPEN", f.sharpen)}
${def("USE_WET", f.wet)}
${def("USE_WET_RICH", f.wetRich)}
${f.mbTaps > 0 ? `#define USE_MB\n#define MB_TAPS ${Math.round(f.mbTaps)}` : "// no USE_MB"}

#ifdef USE_WET
uniform float uRunnel;   // 0..1, your own soaking, sheeting down the glass
uniform float uWetEdge;  // 0..1, beading at the rim as you get closer to soaked
#endif

${LUMA_CHUNK}
${HASH_CHUNK}
#ifdef USE_DEPTH
${DEPTH_CHUNK}
#endif

/**
 * The tone curve pivots here rather than at 0.5. Below mid-grey means the
 * shadows travel further than the highlights for a given slope, which is what
 * a print curve does and what keeps a contrast bump from clipping the sky.
 */
const float PIVOT = 0.435;

/** three's ACES fit, verbatim, so the composed path matches the forward path. */
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFilmic(vec3 color) {
  const mat3 ACESInput = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutput = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602));
  color /= 0.6;
  color = ACESInput * color;
  color = RRTAndODTFit(color);
  color = ACESOutput * color;
  return clamp(color, 0.0, 1.0);
}

vec3 linearToSRGB(vec3 v) {
  return mix(pow(max(v, vec3(0.0)), vec3(0.41666)) * 1.055 - 0.055,
             v * 12.92,
             vec3(lessThanEqual(v, vec3(0.0031308))));
}

/**
 * The grade. Display-referred linear in, display-referred linear out. This is
 * the function that decides whether the island looks like a game or like a
 * tech demo; see the comment on GRADE_DAY for what each stage is buying.
 */
vec3 grade(vec3 c) {
  // 1. Slope about the pivot, then a real S on top of the straight line for
  //    the toe and the shoulder. Both, not either: the slope sets the punch,
  //    the S stops the extremes from clipping flat.
  c = (c - PIVOT) * uContrast + PIVOT + uOffset;
  c = clamp(c, 0.0, 1.0);
  c = mix(c, c * c * (3.0 - 2.0 * c), uScurve);

  // 2. Three-way balance. Weights are built to sum to exactly 1 across the
  //    luma range, so a neutral set of tints is a guaranteed no-op — that is
  //    what makes these numbers safe to tune one at a time.
  float l0 = luma(c);
  float wS = 1.0 - smoothstep(0.0, 0.42, l0);
  float wH = smoothstep(0.46, 1.0, l0);
  float wM = clamp(1.0 - wS - wH, 0.0, 1.0);
  c *= uShadowTint * wS + uMidTint * wM + uHighTint * wH;

  // 3. Lift, *after* contrast — applied before, the contrast would simply
  //    crush it away again and the blacks would go back to dead zero.
  c = uLift + c * (1.0 - uLift);

  // 4. Saturation plus vibrance. Vibrance is what protects an already-vivid
  //    legendary loot beam or the storm wall from going radioactive while
  //    still pulling colour out of the grass and the terracotta.
  float l = luma(c);
  float chroma = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
  float sat = uSaturation + uVibrance * (1.0 - smoothstep(0.0, 0.5, chroma));
  c = mix(vec3(l), c, sat);

  // 5. Highlight bleach: the very top of the range walks toward paper white
  //    instead of clipping in its own hue. Sells hard sun on a pale roof.
  c = mix(c, vec3(1.0), smoothstep(0.88, 1.02, luma(c)) * uBleach);
  return clamp(c, 0.0, 1.0);
}

#ifdef USE_WET
/**
 * SPLASH ROYALE — the lens drench.
 *
 * Entirely procedural: no extra buffer, no extra tap, one evaluation per pixel
 * folded into the composite that was already running. \`.xy\` is a refraction
 * offset in uv and \`.z\` is how much water is sitting on that pixel.
 *
 * \`amount\` runs 1 → 0 over RUNNEL_TIME as the drench drains. Two layers:
 *
 *  - a **sheet** whose top edge falls off the bottom of the frame, which is
 *    what a windscreen actually does when it stops being rained on; and
 *  - **rivulets**, one per column, each with its own width, speed and head, so
 *    the frame never clears as a single flat wipe.
 *
 * The offset is what makes it read as water rather than as a blue overlay: a
 * rivulet is a cylindrical lens, so it bends the image across its own width
 * (the \`f * width\` term) and drags it along the direction it is running.
 */
vec3 wetSheet(vec2 uv, float amount, float time) {
  float drain = 1.0 - amount;
  // Wet BELOW a top edge that starts above the frame and falls out of the
  // bottom of it. uv.y is 0 at the bottom, so the clearing runs top-down.
  float top = 1.3 - drain * 1.65;
  float sheet = amount * smoothstep(0.0, -0.26, uv.y - top);
#ifdef USE_WET_RICH
  float x = uv.x * 8.0;
  float seed = hash12(vec2(floor(x), 17.0));
  float f = fract(x) - 0.5;
  float width = exp(-f * f * (16.0 + seed * 40.0));
  // The head is the lowest point of the rivulet; the body trails above it and
  // thins out, so each column reads as one drop with a tail rather than a bar.
  float head = 1.4 - fract(time * (0.45 + seed * 0.55) + seed) * 1.8;
  float dy = uv.y - head;
  float body = smoothstep(0.0, 0.2, dy) * (1.0 - smoothstep(0.5, 1.05, dy));
  float wet = clamp(sheet * 0.7 + body * width * amount, 0.0, 1.4);
  return vec3(f * width * 0.055 * amount, -wet * 0.03, wet);
#else
  // "low": the sheet alone, no refraction and no per-column work. It still
  // says "you got drenched", which is the part that is feedback.
  return vec3(0.0, 0.0, sheet * 0.8);
#endif
}
#endif

void main() {
  vec2 uv = vUv;

#ifdef USE_WET
  // ---- the wet lens (SPLASH ROYALE only) ----------------------------------
  // Both of these MOVE the image rather than tinting it, which is why they can
  // be this strong without costing a single degree of hue.
  float wetRad = length(vUv - 0.5) * 1.4142;
  vec3 sheet = vec3(0.0);
  if (uRunnel > 0.0) {
    sheet = wetSheet(vUv, uRunnel, uTime);
    uv += sheet.xy;
  }
#ifdef USE_WET_RICH
  if (uWetEdge > 0.0) {
    // Beading, at the rim only. The centre third of the frame stays clean for
    // exactly the reason the pulse never touches it: an effect that hides the
    // person soaking you is a bug, however pretty it is.
    float ring = pow(smoothstep(0.46, 1.12, wetRad), 2.0);
    uv += vec2(sin(vUv.y * 38.0 + uTime * 1.3), cos(vUv.x * 31.0 - uTime * 1.05))
        * 0.0026 * ring * uWetEdge;
  }
#endif
#endif

  // ---- screen-space distortion -------------------------------------------
  // Underwater: the whole frame breathes on two out-of-phase sines, which is
  // enough to read as refraction without ever becoming nauseating.
  if (uWater > 0.0) {
    uv += vec2(sin(uv.y * 22.0 + uTime * 1.9),
               cos(uv.x * 18.0 + uTime * 1.45)) * 0.0038 * uWater;
  }
  // Inside the wall the image itself is unstable — a slow, coarse warp, an
  // order of magnitude gentler than the water so it disturbs without blinding.
  if (uStorm > 0.0) {
    uv += vec2(sin(uv.y * 7.0 - uTime * 2.6), cos(uv.x * 6.0 + uTime * 2.1))
        * 0.0016 * uStorm;
  }
  uv = clamp(uv, vec2(0.0005), vec2(0.9995));

  // ---- lens dispersion ----------------------------------------------------
  vec2 cc = uv - 0.5;
  float rr = dot(cc, cc);
  vec3 color;
#ifdef USE_CA
  // Zero at the optical centre, quadratic to the corners — that is how a real
  // lens misbehaves, and it leaves the crosshair perfectly clean, which is
  // non-negotiable in a shooter.
  float ca = uChromatic * rr * (1.0 + uWater * 2.0 + uHurt * 2.2 + uShake * 1.6);
  color.r = texture2D(tScene, 0.5 + cc * (1.0 + ca)).r;
  color.g = texture2D(tScene, uv).g;
  color.b = texture2D(tScene, 0.5 + cc * (1.0 - ca)).b;
#else
  color = texture2D(tScene, uv).rgb;
#endif

#ifdef USE_DEPTH
  float rawZ = texture2D(tDepth, uv).x;
  float vz = linearDepth(rawZ);
#endif

  // ---- contrast-adaptive sharpen -----------------------------------------
  // Held back for the defocus below to scale down, so aiming does not produce
  // a crisp halo around a blurred silhouette.
  vec3 sharpenDelta = vec3(0.0);
#ifdef USE_SHARPEN
  {
    vec3 n0 = texture2D(tScene, uv + vec2(uTexel.x, 0.0)).rgb;
    vec3 n1 = texture2D(tScene, uv - vec2(uTexel.x, 0.0)).rgb;
    vec3 n2 = texture2D(tScene, uv + vec2(0.0, uTexel.y)).rgb;
    vec3 n3 = texture2D(tScene, uv - vec2(0.0, uTexel.y)).rgb;
    vec3 mn = min(min(n0, n1), min(n2, n3));
    vec3 mx = max(max(n0, n1), max(n2, n3));
    vec3 d = color * 4.0 - (n0 + n1 + n2 + n3);
    // Local contrast gate: flat regions (sky, a painted wall) get nothing, so
    // sharpening never amplifies grain or compression noise into a texture.
    float gate = clamp(luma(mx - mn) * 3.0, 0.0, 1.0);
    sharpenDelta = clamp(d * 0.25, -mx, mx) * uSharpen * gate;
  }
#endif

  // ---- camera motion blur -------------------------------------------------
  // uMotion is zero unless the effect is explicitly enabled AND the CPU-side
  // gate in renderFrame agreed this frame's camera delta describes motion
  // rather than a cut, so the common path costs one compare.
#ifdef USE_MB
  if (uMotion > 0.0) {
    vec4 wp = uInvViewProj * vec4(uv * 2.0 - 1.0, rawZ * 2.0 - 1.0, 1.0);
    wp /= wp.w;
    vec4 pp = uPrevViewProj * wp;
    // Guard the perspective divide before it happens. A w at or behind the eye
    // reprojects to garbage, and garbage here is a full-screen streak.
    vec2 rawVel = vec2(0.0);
    if (pp.w > 1e-4) rawVel = uv - (pp.xy / pp.w * 0.5 + 0.5);

    // A teleport is not motion. Reject outright — do NOT clamp, because
    // clamping a teleport hands back a *maximum-length* velocity pointing
    // wherever the jump did, which is precisely how a posed camera ends up
    // producing the most smeared frame the effect can generate.
    float rawLen = length(rawVel);
    // Sky pixels sit at the far plane where the reprojection is numerically
    // meaningless; they also have no parallax worth smearing.
    bool ok = rawLen < ${MOTION_REJECT_UV.toFixed(3)} && rawZ < 0.99999;

    if (ok) {
      // Never smear anything inside arm's reach: the viewmodel and the held
      // pickaxe are rigidly attached to the camera, so their reprojected
      // velocity is a lie and smearing them looks like a driver bug.
      vec2 vel = rawVel * uMotion * smoothstep(0.6, 3.2, vz);
      float len = length(vel);
      if (len > 0.0012) {
        vel *= min(1.0, ${MOTION_MAX_UV.toFixed(4)} / len);
        vec3 acc = color;
        for (int i = 1; i <= MB_TAPS; i++) {
          float t = float(i) / float(MB_TAPS + 1) - 0.5;
          acc += texture2D(tScene, clamp(uv + vel * t, vec2(0.001), vec2(0.999))).rgb;
        }
        color = acc / float(MB_TAPS + 1);
      }
    }
  }
#endif

  // ---- depth of field (aiming only) --------------------------------------
  float coc = 0.0;
#ifdef USE_DOF
  if (uAds > 0.01) {
    // Circle of confusion from the *relative* distance error, so the depth of
    // field scales with the focus distance the way a real lens does: tight on
    // a target at 20 m, forgiving on one at 300.
    float err = abs(vz - uDof.x) / max(uDof.y, 0.5);
    coc = smoothstep(0.3, 1.25, err) * uAds * ${DOF_ADS_STRENGTH.toFixed(3)};
    color = mix(color, texture2D(tBokeh, uv).rgb, clamp(coc, 0.0, 0.8));
  }
#endif
  color += sharpenDelta * (1.0 - clamp(coc * 1.6, 0.0, 1.0));

  // ---- ambient occlusion --------------------------------------------------
#ifdef USE_AO
  {
    float ao = texture2D(tAO, uv).r;
    // Occlusion belongs to the *ambient* term only. Letting it multiply the
    // directly sunlit range as well is exactly what makes over-cooked AO read
    // as dirt smeared into every corner.
    ao = mix(ao, 1.0, clamp(luma(color) * 0.72, 0.0, 0.82));
    color *= mix(1.0, ao, uAO);
  }
#endif

  // ---- emissive spread ----------------------------------------------------
#ifdef USE_BLOOM
  color += texture2D(tBloom, uv).rgb * uBloom;
#endif
#ifdef USE_RAYS
  color += texture2D(tRays, uv).rgb * uRayTint * uRays;
#endif

  // ---- underwater absorption ----------------------------------------------
  // Physically the right place for this: before the tone curve, in scene
  // radiance, so the water eats light rather than painting over the result.
  if (uWater > 0.0) {
#ifdef USE_DEPTH
    float t = 1.0 - exp(-min(vz, 400.0) * 0.022);
#else
    float t = 0.45;
#endif
    color = mix(color, vec3(0.024, 0.108, 0.142) * (0.4 + 0.9 * luma(color)),
                t * uWater * 0.85);
  }

  // ---- exposure, tone curve, grade ----------------------------------------
  color *= uExposure * uFilter;
  color = acesFilmic(color);
  color = grade(color);

  // ---- lens character -----------------------------------------------------
  // Deliberately *not* aspect-corrected. The falloff follows the frame, so it
  // reads as a lens rather than as a circle painted over a widescreen image.
  float rad = length(vUv - 0.5) * 1.4142;
  float vigMask = pow(smoothstep(0.42, 1.06, rad), 1.75);
  float vig = 1.0 - uVignette * vigMask;
  color *= vig;

  // Taking a hit pulls blood into the corners; the storm pulls violet. In
  // SPLASH ROYALE uHurtTint is the Downpour's blue at the same gain, so the
  // corners go cold and wet instead of bloody.
  color = mix(color, color * uHurtTint, uHurt * vigMask * 1.1);

  // Directional hit indicators. A soft angular wedge at the frame edge in the
  // bearing of the shooter — the one piece of screen feedback that changes
  // what a player does next, so it gets to be the brightest thing here.
  {
    vec2 dir = normalize(vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5) + 1e-6);
    for (int i = 0; i < ${HIT_SLOTS}; i++) {
      vec3 h = uHit[i];
      if (h.z <= 0.0) continue;
      float cone = smoothstep(0.35, 0.94, dot(dir, h.xy));
#ifdef USE_WET_RICH
      // Break the wedge up so it reads as water THROWN at you from that
      // bearing rather than as a wound opening at the edge of the frame. The
      // hash re-rolls a few times a second, which is what makes it sparkle.
      cone *= 0.7 + 0.6 * hash12(floor(vUv * 190.0) + floor(uTime * 16.0));
#endif
      color = mix(color, uHitTint, cone * vigMask * h.z * 0.62);
    }
  }

  // Low health: a slow breath at the very edge that speeds up as it gets worse.
  // Never touches the centre third of the frame — a HUD effect that obscures
  // the target it is warning you about is a bug. Classic breathes dark red;
  // SPLASH ROYALE breathes the DRENCHED blue, and the beading above is already
  // refracting the same rim, so the two land as one "you are soaked" event.
  if (uLowHealth > 0.0) {
    float rate = 3.0 + 7.0 * uLowHealth;
    float pulse = 0.5 + 0.5 * sin(uTime * rate);
    float edge = pow(smoothstep(0.55, 1.15, rad), 2.0);
    color = mix(color, uLowTint, edge * uLowHealth * (0.15 + 0.26 * pulse));
  }

#ifdef USE_WET
  // The drench itself, painted after the grade so the water sits ON the image
  // rather than being graded as part of it. Water on glass scatters: it LIFTS
  // and cools what is behind it, and the second term is the specular rim where
  // a rivulet catches the sky. Nothing here goes dark — this is the player's
  // own soaking and it is supposed to be funny.
  if (uRunnel > 0.0) {
    float w = clamp(sheet.z, 0.0, 1.0);
    color = mix(color, vec3(0.74, 0.9, 1.0), w * 0.42);
    color += vec3(0.06, 0.12, 0.16) * w * w;
  }
#endif

  color = linearToSRGB(color);

  // Fine grain, heaviest in the shadows where film actually shows it. Doubles
  // as the dither that keeps the sky gradient off the banding stairs — an
  // eight-bit sky with no dither is a visible tell on any decent panel.
  float g = hash13(vec3(gl_FragCoord.xy, floor(uTime * 24.0))) - 0.5;
  color += g * uGrain * (0.3 + 0.7 * (1.0 - smoothstep(0.0, 0.55, luma(color))));

  gl_FragColor = vec4(color, 1.0);
}
`;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

const createPostFx: SystemFactory = (ctx) => {
  try {
    return buildPostFx(ctx);
  } catch (err) {
    // A missing extension, a stub renderer, a shader that would not compile —
    // none of it is worth a black screen. Hand rendering back and move on.
    console.warn("[Drop Zero] post-processing disabled, forward path retained:", err);
    try {
      ctx.emit("dz:postfx", null);
    } catch {
      /* the engine may not be listening yet; nothing to do. */
    }
    return { name: "postfx" };
  }
};

function buildPostFx(ctx: WorldCtx): System {
  const tier = TIERS[ctx.quality] ?? TIERS.high;
  /**
   * SPLASH ROYALE. The only branch in this module, and it changes three
   * uniforms, one grade and two compiled-in branches — never a pass, never a
   * buffer, never an order. Classic gets the same shader it always had with the
   * same numbers in it.
   */
  const waterMode = ctx.mode === "water";
  /** The rivulet refraction and the wedge sparkle. `low` ships neither. */
  const wetRich = waterMode && ctx.quality !== "low";
  const renderer = ctx.renderer;
  const scene = ctx.scene;
  const camera = ctx.camera;

  // ---- Targets -------------------------------------------------------------
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  let width = Math.max(2, Math.floor(size.x));
  let height = Math.max(2, Math.floor(size.y));

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(o: T): T => {
    disposables.push(o);
    return o;
  };

  const colorRT = (w: number, h: number, depth = false): THREE.WebGLRenderTarget => {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: depth,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    return track(rt);
  };

  /** Depth textures live alongside their scene target and resize with it. */
  const makeDepth = (w: number, h: number): THREE.DepthTexture => {
    const d = new THREE.DepthTexture(Math.max(1, w), Math.max(1, h), THREE.UnsignedIntType);
    d.format = THREE.DepthFormat;
    d.minFilter = THREE.NearestFilter;
    d.magFilter = THREE.NearestFilter;
    return track(d);
  };

  // The scene target is double-buffered whenever we publish depth for vfx's
  // soft particles: those shaders sample *last* frame's depth, so they can
  // never be reading the attachment they are currently being drawn into. A
  // framebuffer feedback loop is undefined behaviour and a black screen on a
  // depressing number of drivers.
  const sceneCount = tier.depth && tier.softDepth ? 2 : 1;
  const sceneRTs: THREE.WebGLRenderTarget[] = [];
  for (let i = 0; i < sceneCount; i++) {
    const rt = colorRT(width, height, true);
    if (tier.depth) rt.depthTexture = makeDepth(width, height);
    sceneRTs.push(rt);
  }
  let sceneIndex = 0;

  const halfW = () => Math.max(1, width >> 1);
  const halfH = () => Math.max(1, height >> 1);
  const quartW = () => Math.max(1, width >> 2);
  const quartH = () => Math.max(1, height >> 2);

  const aoRT = tier.aoTaps > 0 ? colorRT(halfW(), halfH()) : null;
  const aoBlurRT = tier.aoTaps > 0 ? colorRT(halfW(), halfH()) : null;
  const bokehRT = tier.dof ? colorRT(halfW(), halfH()) : null;
  const rayMaskRT = tier.raySamples > 0 ? colorRT(quartW(), quartH()) : null;
  const rayRT = tier.raySamples > 0 ? colorRT(quartW(), quartH()) : null;

  const bloomRTs: THREE.WebGLRenderTarget[] = [];
  for (let i = 0; i < tier.bloomMips; i++) {
    bloomRTs.push(colorRT(Math.max(1, width >> (i + 1)), Math.max(1, height >> (i + 1))));
  }

  // The graded frame, in display space, waiting for SMAA. Eight bits is exactly
  // right here — the signal is already sRGB-encoded and dithered, and anything
  // wider is bandwidth spent on precision we threw away one line earlier.
  const ldrRT = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  track(ldrRT);

  // ---- Materials -----------------------------------------------------------
  const mat = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
    track(
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: QUAD_VERT,
        fragmentShader: frag,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
        // Critical: every one of these writes into a render target, and three
        // would skip tone mapping there anyway — but the final composite lands
        // on screen and must NOT be tone-mapped twice.
        toneMapped: false,
      }),
    );

  const planes = new THREE.Vector2(camera.near, camera.far);
  const uvToView = new THREE.Vector2(1, 1);
  const sunUv = new THREE.Vector2(0.5, 0.5);

  const aoMat = tier.aoTaps
    ? mat(buildAoFragment(tier.aoTaps), {
        tDepth: { value: null },
        uPlanes: { value: planes },
        uUvToView: { value: uvToView },
        uDepthTexel: { value: new THREE.Vector2() },
        uRadius: { value: new THREE.Vector2(AO_RADIUS_NEAR, AO_RADIUS_FAR) },
        uProjScale: { value: 1 },
        uAspect: { value: 1 },
        uIntensity: { value: 1.1 },
      })
    : null;

  const aoBlurMat = tier.aoTaps
    ? mat(AO_BLUR_FRAG, { tAO: { value: null }, uTexel: { value: new THREE.Vector2() } })
    : null;

  const prefilterMat = tier.bloomMips
    ? mat(BLOOM_PREFILTER_FRAG, {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uThreshold: { value: BLOOM_THRESHOLD },
        uKnee: { value: BLOOM_KNEE },
        uClamp: { value: BLOOM_CLAMP },
      })
    : null;

  const downMat = tier.bloomMips
    ? mat(BLOOM_DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } })
    : null;

  const upMat = tier.bloomMips
    ? mat(BLOOM_UP_FRAG, {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: 1.0 },
        uGain: { value: BLOOM_MIP_GAIN },
      })
    : null;
  if (upMat) upMat.blending = THREE.AdditiveBlending;

  const bokehMat = tier.dof
    ? mat(BOKEH_FRAG, {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: DOF_BOKEH_RADIUS },
      })
    : null;

  const rayMaskMat = tier.raySamples
    ? mat(RAY_MASK_FRAG, {
        tSrc: { value: null },
        tDepth: { value: null },
        uThreshold: { value: 1.5 },
        uSunUv: { value: sunUv },
      })
    : null;

  const rayMat = tier.raySamples
    ? mat(buildRayFragment(tier.raySamples), {
        tSrc: { value: null },
        uSunUv: { value: sunUv },
        uDensity: { value: RAY_DENSITY },
        uDecay: { value: RAY_DECAY },
        uJitter: { value: 0 },
      })
    : null;

  const hitSlots: THREE.Vector3[] = [];
  for (let i = 0; i < HIT_SLOTS; i++) hitSlots.push(new THREE.Vector3(0, 1, 0));

  const compositeMat = mat(
    buildCompositeFragment({
      depth: tier.depth,
      bloom: tier.bloomMips > 0,
      ao: tier.aoTaps > 0,
      dof: tier.dof,
      mbTaps: tier.mbTaps,
      rays: tier.raySamples > 0,
      chromatic: tier.chromatic,
      sharpen: tier.sharpen,
      wet: waterMode,
      wetRich,
    }),
    {
      tScene: { value: null },
      tBloom: { value: null },
      tAO: { value: null },
      tBokeh: { value: null },
      tRays: { value: null },
      tDepth: { value: null },
      uPlanes: { value: planes },
      uUvToView: { value: uvToView },
      uTexel: { value: new THREE.Vector2() },
      uAspect: { value: 1 },
      uTime: { value: 0 },
      uBloom: { value: BLOOM_STRENGTH[ctx.quality] ?? 0 },
      uAO: { value: AO_STRENGTH[ctx.quality] ?? 0 },
      uRays: { value: 0 },
      uRayTint: { value: new THREE.Color(1, 0.87, 0.68) },
      uDof: { value: new THREE.Vector2(60, 20) },
      uAds: { value: 0 },
      uMotion: { value: 0 },
      uSharpen: { value: tier.sharpen ? SHARPEN : 0 },
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uWater: { value: 0 },
      uStorm: { value: 0 },
      uHurt: { value: 0 },
      uShake: { value: 0 },
      uLowHealth: { value: 0 },
      uHit: { value: hitSlots },
      uChromatic: { value: tier.chromatic ? CHROMATIC : 0 },
      uHurtTint: {
        value: new THREE.Vector3(...(waterMode ? HURT_TINT_WATER : HURT_TINT_CLASSIC)),
      },
      uHitTint: {
        value: new THREE.Vector3(...(waterMode ? HIT_TINT_WATER : HIT_TINT_CLASSIC)),
      },
      uLowTint: {
        value: new THREE.Vector3(...(waterMode ? LOW_TINT_WATER : LOW_TINT_CLASSIC)),
      },
      // Declared in classic too and simply never sampled: the shader compiles
      // both branches out, and three skips a uniform the program does not have.
      uRunnel: { value: 0 },
      uWetEdge: { value: 0 },
      uExposure: { value: 1 },
      uFilter: { value: new THREE.Vector3(1, 1, 1) },
      uContrast: { value: GRADE_DAY.contrast },
      uScurve: { value: GRADE_DAY.scurve },
      uOffset: { value: GRADE_DAY.offset },
      uLift: { value: new THREE.Vector3() },
      uShadowTint: { value: new THREE.Vector3(1, 1, 1) },
      uMidTint: { value: new THREE.Vector3(1, 1, 1) },
      uHighTint: { value: new THREE.Vector3(1, 1, 1) },
      uSaturation: { value: GRADE_DAY.saturation },
      uVibrance: { value: GRADE_DAY.vibrance },
      uBleach: { value: GRADE_DAY.bleach },
      uVignette: { value: GRADE_DAY.vignette },
      uGrain: { value: GRADE_DAY.grain },
    },
  );

  // A real 1x1 black texture for every optional sampler. Binding an unbacked
  // render-target texture — the shaft buffer, on any frame before the first one
  // that has any shafts in it — gives an incomplete sampler and a console full
  // of driver warnings, and on some mobile drivers it is a hard error.
  const blackTex = track(
    new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat),
  );
  blackTex.needsUpdate = true;
  for (const key of ["tBloom", "tAO", "tBokeh", "tRays"]) {
    compositeMat.uniforms[key].value = blackTex;
  }

  const quad = new FullScreenQuad(compositeMat);

  // SMAA is optional in a way nothing else here is: it decodes two embedded
  // PNGs through `Image`, which does not exist in a headless harness. Losing it
  // costs edge quality, not the frame.
  let smaa: SMAAPass | null = null;
  try {
    smaa = new SMAAPass(width, height);
    smaa.renderToScreen = true;
  } catch (err) {
    console.warn("[Drop Zero] SMAA unavailable:", err);
    smaa = null;
  }

  // ---- Live state ----------------------------------------------------------
  const grade = cloneGrade(GRADE_DAY);
  const gradeA = cloneGrade(GRADE_DAY);
  const gradeB = cloneGrade(GRADE_DAY);

  /** Each of these is a target the render loop eases toward. A hard cut on any
   *  of the grade blends reads as a bug, and crossing the storm boundary or a
   *  waterline is common enough that the ease has to be there. */
  let waterTarget = 0;
  let water = 0;
  let stormTarget = 0;
  let storm = 0;
  let downTarget = 0;
  let down = 0;

  /** Aim-down-sights blend, from "dz:crosshair". Gates the whole DOF branch. */
  let ads = 0;
  /** Decaying hit feedback, from "dz:damage" / "dz:hit". */
  let hurt = 0;
  /** Decaying trauma, borrowed from combat purely for lens character — the
   *  camera displacement itself belongs to vfx and is none of our business. */
  let shake = 0;
  /** 0..1 ramp below LOW_HEALTH, driven by the HUD payload. */
  let lowHealth = 0;
  /** 1 → 0 over RUNNEL_TIME after your own soaking. Water mode only. */
  let runnel = 0;
  let focus = 60;
  let focusTimer = 0;
  let broken = false;
  let elapsed = 0;

  /** Live directional hit indicators, in the player's *look* frame. */
  const hits = Array.from({ length: HIT_SLOTS }, () => ({
    angle: 0,
    strength: 0,
    ttl: 0,
    age: 0,
  }));

  const viewProj = new THREE.Matrix4();
  const prevViewProj = new THREE.Matrix4();
  const invViewProj = new THREE.Matrix4();
  let hasPrev = false;

  /** Runtime effect switchboard, driven by "dz:fx". */
  const fx = defaultFxState();

  /**
   * Camera transform as of the *previous* frame, kept so we can tell motion
   * from a cut. This is deliberately measured off the camera itself rather
   * than inferred from the reprojection matrices: by the time a bogus delta
   * has reached the matrices it is already a full-screen streak, and the
   * matrices cannot distinguish "moved 40 m" from "was placed 40 m away".
   */
  const prevCamPos = new THREE.Vector3();
  const prevCamQuat = new THREE.Quaternion();
  /** True when this frame's camera delta looks like a pose, not a move. */
  let cameraCut = true;

  /** Latest "dz:sun" snapshot. Sky recomputes this every frame; we only cache
   *  it, so a sky that failed to boot simply means no shafts. */
  const sun = { x: 0.5, y: 0.5, visible: false, strength: 0, daylight: 1 };
  let sawSunEvent = false;

  const tmpVec = new THREE.Vector3();
  const camForward = new THREE.Vector3();
  const rayDir = new THREE.Vector3();

  // ---- Events --------------------------------------------------------------
  const offs: (() => void)[] = [];

  offs.push(
    ctx.on("dz:sun", (p) => {
      const s = p as Partial<typeof sun> | undefined;
      if (!s || typeof s.x !== "number" || typeof s.y !== "number") return;
      sun.x = s.x;
      sun.y = s.y;
      sun.visible = !!s.visible;
      sun.strength = typeof s.strength === "number" ? s.strength : 0;
      sun.daylight = typeof s.daylight === "number" ? s.daylight : 1;
      sawSunEvent = true;
    }),
  );

  offs.push(
    ctx.on("dz:underwater", (p) => {
      waterTarget = p ? 1 : 0;
    }),
  );

  offs.push(
    ctx.on("dz:fx", (p) => {
      const e = p as { effect?: string; enabled?: unknown } | undefined;
      if (!e || typeof e.effect !== "string") return;
      const on = !!e.enabled;
      const key = e.effect.trim().toLowerCase();
      if (key === "all") {
        for (const k of FX_EFFECTS) fx[k] = on;
        return;
      }
      if ((FX_EFFECTS as readonly string[]).includes(key)) {
        fx[key as FxEffect] = on;
        // Turning motion blur on mid-flight must not smear against a stale
        // matrix from whenever it was last enabled.
        if (key === "motion" && on) hasPrev = false;
      }
    }),
  );

  offs.push(
    ctx.on("dz:in-storm", (p) => {
      // The storm emits this only on the flip, and carries the intensity it
      // had at that instant. We take the boolean and drive our own ramp — the
      // continuous value comes from the service, polled per frame.
      //
      // The phase gate is repeated here and not left to updateStormIntensity:
      // that poll returns early when the storm or player service is missing,
      // which would leave a stale `inside:true` from the event latched on with
      // nothing left to clear it. The overlay defaults off and every path that
      // can turn it on has to earn it.
      const e = p as { inside?: boolean; intensity?: number } | undefined;
      if (!e?.inside || NO_STORM_PHASES.has(ctx.services.match?.phase ?? "")) {
        stormTarget = 0;
        return;
      }
      stormTarget = THREE.MathUtils.clamp(
        Math.max(0.35, typeof e.intensity === "number" ? e.intensity : 1), 0, 1);
    }),
  );

  offs.push(
    ctx.on("dz:crosshair", (p) => {
      const v = (p as { ads?: number })?.ads;
      if (typeof v === "number" && Number.isFinite(v)) {
        ads = THREE.MathUtils.clamp(v, 0, 1);
      }
    }),
  );

  offs.push(
    ctx.on("dz:hud", (p) => {
      const h = p as
        | { health?: number; maxHealth?: number; down?: number; dry?: number; maxDry?: number }
        | undefined;
      if (!h) return;
      // In SPLASH ROYALE the bar is DRYNESS. The water player rides the same
      // service and usually publishes it as `health` too, so this is a
      // preference and not a requirement — same fallback the HUD uses.
      const max = waterMode
        ? (h.maxDry && h.maxDry > 0 ? h.maxDry : h.maxHealth && h.maxHealth > 0 ? h.maxHealth : 100)
        : h.maxHealth && h.maxHealth > 0
          ? h.maxHealth
          : 100;
      const level = waterMode ? (h.dry ?? h.health ?? max) : (h.health ?? max);
      const frac = THREE.MathUtils.clamp(level / max, 0, 1);
      // Ramps in over the last third of the health bar and reaches full only
      // at literally-one-more-bullet. A pulse that starts at 60% is noise.
      lowHealth = 1 - THREE.MathUtils.smoothstep(frac, 0.06, LOW_HEALTH);
      // `down` is the bleed-out timer; any non-zero value means knocked.
      downTarget = (h.down ?? 0) > 0 ? 1 : 0;
    }),
  );

  offs.push(
    ctx.on("dz:hit", (p) => {
      const h = p as
        | { angle?: number; amount?: number; shield?: boolean; lethal?: boolean }
        | undefined;
      if (!h) return;
      const amount = Math.max(0, h.amount ?? 0);
      hurt = Math.min(1, hurt + THREE.MathUtils.clamp(amount / 42, 0.14, 0.7));
      // Shield hits are real information but they are not *urgent* — the wedge
      // is dimmer so a full-shield poke never reads like a lethal burst.
      const strength = THREE.MathUtils.clamp(amount / 45, 0.3, 1) * (h.shield ? 0.6 : 1);

      // Recycle the faintest slot so a big new hit always beats a dying one.
      let slot = hits[0];
      for (const s of hits) {
        const life = s.ttl > 0 ? 1 - s.age / s.ttl : 0;
        const best = slot.ttl > 0 ? 1 - slot.age / slot.ttl : 0;
        if (life * s.strength < best * slot.strength) slot = s;
      }
      slot.angle = Number.isFinite(h.angle) ? (h.angle as number) : 0;
      slot.strength = strength;
      slot.ttl = 1.15;
      slot.age = 0;
    }),
  );

  offs.push(
    ctx.on("dz:damage", (p) => {
      // Combat's generic damage event — fired for bots too, so only the local
      // player's own damage should reach the lens.
      const d = p as { amount?: number; target?: string; faction?: string } | undefined;
      if (!d) return;
      if (d.target && d.target !== "player") return;
      if (d.faction && d.faction !== "player") return;
      hurt = Math.min(1, hurt + THREE.MathUtils.clamp((d.amount ?? 0) / 60, 0.05, 0.4));
    }),
  );

  offs.push(
    ctx.on("dz:shake", (p) => {
      const amount =
        typeof p === "number" ? p : ((p as { amount?: number } | undefined)?.amount ?? 0);
      shake = Math.min(1, shake + Math.max(0, amount));
    }),
  );

  offs.push(
    ctx.on("dz:down", () => {
      downTarget = 1;
    }),
  );
  offs.push(
    ctx.on("dz:death", () => {
      downTarget = 1;
      lowHealth = 1;
      // Your own soaking, on your own lens: the camera gets drenched and then
      // drains. Water mode only — in classic this is a death, and the grade
      // takeover is the thing that is supposed to say so.
      if (waterMode) runnel = 1;
    }),
  );
  offs.push(
    ctx.on("dz:heal", () => {
      // A heal is the one thing that should clear the dying grade instantly
      // rather than waiting for the next HUD tick.
      downTarget = 0;
    }),
  );
  offs.push(
    ctx.on("dz:victory", () => {
      downTarget = 0;
      lowHealth = 0;
      stormTarget = 0;
      runnel = 0;
    }),
  );

  // ---- Pass plumbing -------------------------------------------------------
  const draw = (material: THREE.Material, target: THREE.WebGLRenderTarget | null): void => {
    quad.material = material;
    renderer.setRenderTarget(target);
    quad.render(renderer);
  };

  const setTexel = (m: THREE.ShaderMaterial | null, w: number, h: number): void => {
    if (!m) return;
    (m.uniforms.uTexel.value as THREE.Vector2).set(1 / Math.max(1, w), 1 / Math.max(1, h));
  };

  /** Uniform bookkeeping that only changes when the camera or the size does. */
  function updateCameraUniforms(): void {
    // The camera may have been moved by a system whose update ran after the
    // last render; everything below wants this frame's transform, not the one
    // the previous render left behind.
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const aspect = width / height;
    planes.set(camera.near, camera.far);
    uvToView.set(tanHalf * camera.aspect, tanHalf);

    if (aoMat) {
      aoMat.uniforms.uProjScale.value = 0.5 / Math.max(tanHalf, 1e-4);
      aoMat.uniforms.uAspect.value = aspect;
      // Full-resolution texel: the AO pass runs at half res but every one of
      // its fetches lands in the full-res depth buffer.
      (aoMat.uniforms.uDepthTexel.value as THREE.Vector2).set(1 / width, 1 / height);
    }
    compositeMat.uniforms.uAspect.value = aspect;
    setTexel(compositeMat, width, height);

    // ---- motion vs. a cut ---------------------------------------------------
    // Measured here, at the top of the frame, off the camera's own transform.
    // A capture harness poses the camera and renders; so does a respawn, a
    // spectator switch and stepping out of a vehicle. All four look identical
    // to a reprojection-based velocity estimator, and all four used to produce
    // a full-length streak because the old code clamped the resulting vector
    // instead of throwing it away.
    camera.getWorldPosition(tmpVec);
    const moved = tmpVec.distanceTo(prevCamPos);
    // Quaternion dot → half-angle; 2*acos(|dot|) is the shortest rotation
    // between the two orientations regardless of which hemisphere they are in.
    const dot = Math.min(1, Math.abs(camera.quaternion.dot(prevCamQuat)));
    const turned = 2 * Math.acos(dot);
    cameraCut = moved > MOTION_MAX_STEP || turned > MOTION_MAX_TURN;
    prevCamPos.copy(tmpVec);
    prevCamQuat.copy(camera.quaternion);
  }

  /**
   * Folds daylight, storm, water and the down state into one live grade.
   *
   * Order matters and is not arbitrary: time of day is the base look, the
   * storm sits on top of whatever the sky is doing, water sits on top of that
   * (you can be underwater inside the wall), and the dying desaturation wins
   * over everything because it is the one that has to be unmistakable.
   */
  function updateGrade(dt: number): void {
    const stormFx = fx.storm ? storm : 0;
    const waterFx = fx.water ? water : 0;

    const daylight = THREE.MathUtils.clamp(ctx.services.sky?.daylight ?? sun.daylight, 0, 1);
    mixGrade(GRADE_DAY, GRADE_DUSK, 1 - daylight, gradeA);
    // Capped, not raw: past STORM_GRADE_MAX the storm stops eating hue and
    // lets the warp, the grain and the vignette carry the message instead.
    mixGrade(gradeA, GRADE_STORM, stormFx * STORM_GRADE_MAX, gradeB);
    mixGrade(gradeB, GRADE_WATER, waterFx, gradeA);
    // The dying grade, or its water counterpart. Same slot, same blend, and the
    // one place a red literal would otherwise survive the re-theme: GRADE_DOWN
    // is explicitly "desaturate toward monochrome with the blood pushed in".
    mixGrade(gradeA, waterMode ? GRADE_SOAKED : GRADE_DOWN, down, grade);
    if (!fx.grade) copyGrade(GRADE_OFF, grade);

    const u = compositeMat.uniforms;
    // Respect whatever the engine has done to exposure; ours multiplies it.
    u.uExposure.value = grade.exposure * (renderer.toneMappingExposure || 1);
    (u.uFilter.value as THREE.Vector3).set(grade.filter[0], grade.filter[1], grade.filter[2]);
    u.uContrast.value = grade.contrast;
    u.uScurve.value = grade.scurve;
    u.uOffset.value = grade.offset;
    (u.uLift.value as THREE.Vector3).set(grade.lift[0], grade.lift[1], grade.lift[2]);
    (u.uShadowTint.value as THREE.Vector3).set(
      grade.shadowTint[0], grade.shadowTint[1], grade.shadowTint[2]);
    (u.uMidTint.value as THREE.Vector3).set(
      grade.midTint[0], grade.midTint[1], grade.midTint[2]);
    (u.uHighTint.value as THREE.Vector3).set(
      grade.highTint[0], grade.highTint[1], grade.highTint[2]);
    u.uSaturation.value = grade.saturation;
    u.uVibrance.value = grade.vibrance;
    u.uBleach.value = grade.bleach;
    // Getting hit closes the iris down; so does aiming, very slightly, which
    // is a cheap way to make ADS feel like it committed to something.
    u.uVignette.value = fx.vignette ? grade.vignette + hurt * 0.32 + ads * 0.09 : 0;
    u.uGrain.value = fx.grain ? grade.grain * (1 + hurt * 1.4 + stormFx * 0.6) : 0;
    u.uWater.value = waterFx;
    // The screen warp keeps ramping on the *uncapped* storm value — it costs no
    // hue, so it can carry the depth information the grade cap gives up.
    u.uStorm.value = stormFx;
    u.uHurt.value = fx.vignette ? hurt : 0;
    u.uShake.value = shake;
    u.uLowHealth.value = fx.lowhealth ? lowHealth : 0;
    // The wet lens. Both are ignored by the classic program, which has neither
    // uniform, so there is no cost to writing them unconditionally.
    u.uRunnel.value = fx.runnel ? runnel : 0;
    // The beading rides the same ramp as the pulse rather than a second one:
    // going blue at the edge and going wet at the edge are one event.
    u.uWetEdge.value = fx.wetlens ? lowHealth : 0;
    u.uAds.value = fx.dof ? ads : 0;
    u.uTime.value = elapsed;
    // A switch can only take away what the tier already granted; it can never
    // light up a pass whose buffers were never allocated.
    u.uAO.value = fx.ao && tier.aoTaps > 0 ? (AO_STRENGTH[ctx.quality] ?? 0) : 0;
    u.uBloom.value = fx.bloom && tier.bloomMips > 0 ? (BLOOM_STRENGTH[ctx.quality] ?? 0) : 0;
    u.uChromatic.value = fx.chromatic && tier.chromatic ? CHROMATIC : 0;
    u.uSharpen.value = fx.sharpen && tier.sharpen ? SHARPEN : 0;

    // Shutter-correct motion blur: the per-frame reprojection vector is scaled
    // back to a fixed exposure time, so the smear length is the same at 30 fps
    // as at 144 and never becomes a framerate tell.
    //
    // Three gates in front of it, and all three have to pass. `cameraCut` is
    // the one that matters: a posed camera contributes zero this frame rather
    // than the maximum-length smear the old clamp handed back.
    const usable = fx.motion && tier.mbTaps > 0 && hasPrev && !cameraCut;
    const strength = MOTION_STRENGTH[ctx.quality] ?? 0;
    u.uMotion.value = usable
      ? strength * Math.min(2.5, MOTION_SHUTTER / Math.max(dt, 1e-4))
      : 0;
  }

  /**
   * Continuous storm intensity, polled off the service rather than the event.
   * `dz:in-storm` only fires on the flip; a player who walks 200 m deeper into
   * the wall should keep getting darker, and only the service knows that.
   */
  function updateStormIntensity(): void {
    // Phase first. On the bus and under canopy the player is outside the
    // circle by definition, and veiling the drop in violet — which is what
    // every frame of the first capture pass did — is both wrong and the worst
    // possible first impression of the island.
    if (NO_STORM_PHASES.has(ctx.services.match?.phase ?? "")) {
      stormTarget = 0;
      return;
    }
    const st = ctx.services.storm;
    const pl = ctx.services.player;
    if (!st || !pl) return;
    if (st.isSafe(pl.position)) {
      stormTarget = 0;
      return;
    }
    // Ramp with depth past the wall. 220 m out is fully committed; beyond that
    // the grade would only get harder to see through for no extra information.
    const d = pl.position.distanceTo(st.center) - st.radius;
    stormTarget = THREE.MathUtils.clamp(0.35 + 0.65 * THREE.MathUtils.smoothstep(d, 0, 220), 0, 1);
  }

  /** Focus distance for the ADS pull: whatever is actually under the crosshair. */
  function updateFocus(dt: number): void {
    if (!tier.dof) return;
    focusTimer -= dt;
    let target = focus;
    if (ads > 0.02) {
      if (focusTimer <= 0) {
        focusTimer = 1 / DOF_REFOCUS_HZ;
        camera.getWorldDirection(rayDir);
        let hit: { distance: number } | null = null;
        try {
          hit = ctx.services.collision?.raycast(camera.position, rayDir, 500) ?? null;
        } catch {
          hit = null;
        }
        // Nothing under the crosshair means open ground or sky; focus at the
        // distance a player is realistically shooting at rather than infinity,
        // so an ADS over open water still defocuses the ground at your feet.
        target = hit ? THREE.MathUtils.clamp(hit.distance, 1.5, 500) : 180;
      }
    } else {
      target = 60;
    }
    // A real focus puller takes about a third of a second.
    focus += (target - focus) * Math.min(1, dt * 7);
    (compositeMat.uniforms.uDof.value as THREE.Vector2).set(
      focus,
      // Depth of field widens with distance, the way a lens does: 30% of the
      // focus distance keeps a target at 20 m tight and one at 300 m forgiving.
      Math.max(3.5, focus * 0.3),
    );
  }

  /** Ages the directional hit wedges and rotates them into screen space. */
  function updateHits(dt: number): void {
    for (let i = 0; i < HIT_SLOTS; i++) {
      const h = hits[i];
      const slot = hitSlots[i];
      if (h.ttl <= 0) {
        slot.set(0, 1, 0);
        continue;
      }
      h.age += dt;
      if (h.age >= h.ttl) {
        h.ttl = 0;
        slot.set(0, 1, 0);
        continue;
      }
      // A wedge that fades linearly reads as a slow smear; squared gives the
      // sharp stab-then-vanish that actually communicates "just now".
      const life = 1 - h.age / h.ttl;
      // angle 0 = the shooter is dead ahead, which is the top of the screen.
      slot.set(
        Math.sin(h.angle),
        Math.cos(h.angle),
        fx.hits ? h.strength * life * life : 0,
      );
    }
  }

  /**
   * Where the sun lands on screen, and how much of a shaft it has earned.
   *
   * Sky already does this projection every frame and publishes it on "dz:sun"
   * complete with its own edge/altitude/off-axis fade, so the common path is
   * free. The fallback exists because boot order is a guarantee about ordering,
   * not about success.
   */
  function updateShafts(): number {
    if (!rayMat || !rayMaskMat || !fx.rays) return 0;
    const sky = ctx.services.sky;

    let amount = 0;
    if (sawSunEvent) {
      if (!sun.visible) return 0;
      sunUv.set(sun.x, sun.y);
      amount = sun.strength;
    } else if (sky) {
      camera.getWorldDirection(camForward);
      const facing = camForward.dot(sky.sunDirection);
      if (facing <= 0.02) return 0;
      tmpVec.copy(camera.position).addScaledVector(sky.sunDirection, 6000).project(camera);
      if (tmpVec.z > 1) return 0;
      sunUv.set(tmpVec.x * 0.5 + 0.5, tmpVec.y * 0.5 + 0.5);
      const edge = Math.max(Math.abs(tmpVec.x), Math.abs(tmpVec.y));
      amount =
        (1 - THREE.MathUtils.smoothstep(edge, 0.85, 1.6)) *
        THREE.MathUtils.smoothstep(sky.sunDirection.y, -0.02, 0.16) *
        THREE.MathUtils.smoothstep(facing, 0.05, 0.45);
    } else {
      return 0;
    }
    if (amount <= 0.001) return 0;

    if (sky) (compositeMat.uniforms.uRayTint.value as THREE.Color).copy(sky.sunColor);
    // Underwater there is no dry-air scattering to make a shaft out of, and the
    // storm's own veil already owns the sky it would be marching through.
    const occluded = (1 - water) * (1 - storm * 0.6);
    return amount * (RAY_STRENGTH[ctx.quality] ?? 0) * occluded;
  }

  // ---- The frame -----------------------------------------------------------
  // `renderer.info` is reset by the engine immediately before it calls us and
  // has `autoReset` off, so every pass below accumulates into one honest set of
  // counters for the quality governor to read.
  function renderFrame(dt: number): void {
    if (broken) return;
    const clampedDt = Math.min(Math.max(dt, 1e-4), 0.2);
    elapsed += clampedDt;

    const oldAutoClear = renderer.autoClear;
    try {
      // ---- per-frame state --------------------------------------------------
      updateStormIntensity();
      const ease = (v: number, target: number, rate: number) =>
        v + (target - v) * Math.min(1, clampedDt * rate);
      water = ease(water, waterTarget, 6);
      storm = ease(storm, stormTarget, 3.2);
      down = ease(down, downTarget, 4.5);
      hurt = Math.max(0, hurt - clampedDt * 1.4);
      shake = Math.max(0, shake - clampedDt * 1.9);
      // Simulated seconds, off the same clamped dt everything else here uses.
      runnel = Math.max(0, runnel - clampedDt / RUNNEL_TIME);

      updateCameraUniforms();
      updateHits(clampedDt);
      updateFocus(clampedDt);
      updateGrade(clampedDt);

      // ---- scene ------------------------------------------------------------
      // Flip first, then publish the *other* buffer's depth: the particle
      // shaders about to run sample last frame's depth, never the attachment
      // they are being drawn into.
      const prevScene = sceneRTs[sceneIndex];
      sceneIndex = (sceneIndex + 1) % sceneRTs.length;
      const sceneRT = sceneRTs[sceneIndex];
      if (tier.softDepth && prevScene !== sceneRT && prevScene.depthTexture) {
        ctx.emit("dz:depth", prevScene.depthTexture);
      }

      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);

      const sceneTex = sceneRT.texture;
      const depthTex = sceneRT.depthTexture ?? null;

      // Reprojection matrices for motion blur, captured after the scene render
      // so they describe exactly what was drawn.
      if (tier.mbTaps > 0) {
        camera.updateMatrixWorld();
        viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        invViewProj.copy(viewProj).invert();
        (compositeMat.uniforms.uInvViewProj.value as THREE.Matrix4).copy(invViewProj);
        (compositeMat.uniforms.uPrevViewProj.value as THREE.Matrix4).copy(
          hasPrev ? prevViewProj : viewProj,
        );
        prevViewProj.copy(viewProj);
        hasPrev = true;
      }

      // ---- ambient occlusion ------------------------------------------------
      if (aoMat && aoBlurMat && aoRT && aoBlurRT && depthTex) {
        aoMat.uniforms.tDepth.value = depthTex;
        draw(aoMat, aoRT);

        aoBlurMat.uniforms.tAO.value = aoRT.texture;
        setTexel(aoBlurMat, aoBlurRT.width, aoBlurRT.height);
        draw(aoBlurMat, aoBlurRT);
        compositeMat.uniforms.tAO.value = aoBlurRT.texture;
      }

      // ---- bloom pyramid ----------------------------------------------------
      if (prefilterMat && downMat && upMat && bloomRTs.length > 0) {
        prefilterMat.uniforms.tSrc.value = sceneTex;
        setTexel(prefilterMat, width, height);
        draw(prefilterMat, bloomRTs[0]);

        for (let i = 1; i < bloomRTs.length; i++) {
          const src = bloomRTs[i - 1];
          downMat.uniforms.tSrc.value = src.texture;
          setTexel(downMat, src.width, src.height);
          draw(downMat, bloomRTs[i]);
        }
        // Back up the pyramid, accumulating additively — a wide, soft,
        // energy-preserving glow instead of one fat gaussian with a visible
        // radius, which is the difference between a sun and a lens smudge.
        renderer.autoClear = false;
        for (let i = bloomRTs.length - 1; i > 0; i--) {
          const src = bloomRTs[i];
          upMat.uniforms.tSrc.value = src.texture;
          setTexel(upMat, src.width, src.height);
          draw(upMat, bloomRTs[i - 1]);
        }
        renderer.autoClear = oldAutoClear;
        compositeMat.uniforms.tBloom.value = bloomRTs[0].texture;
      }

      // ---- bokeh ------------------------------------------------------------
      // Skipped entirely when not aiming. This is the whole reason DOF is
      // affordable: it costs nothing for the 95% of a match spent not scoped.
      if (bokehMat && bokehRT && fx.dof && ads > 0.01) {
        bokehMat.uniforms.tSrc.value = sceneTex;
        setTexel(bokehMat, bokehRT.width, bokehRT.height);
        draw(bokehMat, bokehRT);
        compositeMat.uniforms.tBokeh.value = bokehRT.texture;
      }

      // ---- god rays ---------------------------------------------------------
      let rayAmount = 0;
      if (rayMat && rayMaskMat && rayRT && rayMaskRT && depthTex) {
        rayAmount = updateShafts();
        if (rayAmount > 0.001) {
          rayMaskMat.uniforms.tSrc.value = sceneTex;
          rayMaskMat.uniforms.tDepth.value = depthTex;
          draw(rayMaskMat, rayMaskRT);

          rayMat.uniforms.tSrc.value = rayMaskRT.texture;
          rayMat.uniforms.uJitter.value = elapsed * 60;
          draw(rayMat, rayRT);
          compositeMat.uniforms.tRays.value = rayRT.texture;
        }
      }
      compositeMat.uniforms.uRays.value = rayAmount;

      // ---- composite + AA ---------------------------------------------------
      compositeMat.uniforms.tScene.value = sceneTex;
      compositeMat.uniforms.tDepth.value = depthTex;

      if (smaa && fx.aa) {
        draw(compositeMat, ldrRT);
        smaa.render(renderer, null as unknown as THREE.WebGLRenderTarget, ldrRT, clampedDt, false);
      } else {
        draw(compositeMat, null);
      }

      renderer.setRenderTarget(null);
    } catch (err) {
      // One bad frame is a bug; a hundred is a black screen. Bail out for good
      // and let the engine's forward path take over from the next frame.
      broken = true;
      renderer.autoClear = oldAutoClear;
      renderer.setRenderTarget(null);
      console.warn("[Drop Zero] post-processing failed mid-frame, reverting:", err);
      try {
        ctx.emit("dz:depth", null);
        ctx.emit("dz:postfx", null);
      } catch {
        /* nothing left to do. */
      }
    }
  }

  // ---- Resize --------------------------------------------------------------
  function resize(): void {
    const s = renderer.getDrawingBufferSize(new THREE.Vector2());
    width = Math.max(2, Math.floor(s.x));
    height = Math.max(2, Math.floor(s.y));

    for (const rt of sceneRTs) {
      rt.setSize(width, height);
      // `WebGLRenderTarget.setSize` does not carry the depth attachment with
      // it — the texture has to be resized and invalidated by hand or the AO
      // pass samples a stale, differently-sized buffer.
      const d = rt.depthTexture;
      if (d) {
        d.image.width = width;
        d.image.height = height;
        d.needsUpdate = true;
      }
    }
    ldrRT.setSize(width, height);
    aoRT?.setSize(halfW(), halfH());
    aoBlurRT?.setSize(halfW(), halfH());
    bokehRT?.setSize(halfW(), halfH());
    rayMaskRT?.setSize(quartW(), quartH());
    rayRT?.setSize(quartW(), quartH());
    for (let i = 0; i < bloomRTs.length; i++) {
      bloomRTs[i].setSize(Math.max(1, width >> (i + 1)), Math.max(1, height >> (i + 1)));
    }
    smaa?.setSize(width, height);
    updateCameraUniforms();
    // The previous frame's view-projection describes a differently shaped
    // frame; reusing it would smear the whole image for exactly one frame.
    hasPrev = false;
  }

  updateCameraUniforms();

  // Published last, once everything above is real. `weapons` listens for this
  // and re-emits its own wrapper (it composites the viewmodel over our finished
  // frame with a depth clear), so the engine may end up installing that instead
  // — which is correct, and why this is an event rather than a service.
  ctx.emit("dz:postfx", renderFrame);

  const sys: System = {
    name: "postfx",

    resize() {
      if (broken) return;
      try {
        resize();
      } catch (err) {
        console.warn("[Drop Zero] post-processing resize failed:", err);
        broken = true;
        ctx.emit("dz:postfx", null);
      }
    },

    dispose() {
      // Hand rendering back *first*. Anything that throws below must not leave
      // the engine calling into a composer whose targets are already gone.
      try {
        ctx.emit("dz:depth", null);
        ctx.emit("dz:postfx", null);
      } catch {
        /* the engine may already be gone. */
      }
      broken = true;
      for (const off of offs) {
        try {
          off();
        } catch {
          /* listener list already torn down. */
        }
      }
      quad.dispose();
      smaa?.dispose();
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          /* a target may already have been reclaimed by a context loss. */
        }
      }
    },
  };

  return sys;
}

export default createPostFx;
