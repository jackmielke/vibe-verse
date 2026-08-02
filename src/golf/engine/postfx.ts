/**
 * Vibe Golf — post-processing and colour grade.
 *
 * Owns the final image. The chain is deliberately short, because this is a
 * bright, high-contrast 2D game and readability beats spectacle: the player
 * must parse solid / hazard / ball in a single glance on a phone.
 *
 *   scene ──► RenderPass ──► GlowPass ──► GradePass ──► AA ──► screen
 *              (HDR linear)   (¼-res,      (bloom composite, key light,
 *                              threshold-   ACES, theme grade, aerial
 *                              gated)       recovery, vignette, CA, grain)
 *
 * The composer's buffers are half-float and *linear* — three only applies
 * `renderer.toneMapping` / output colour space when it draws to the default
 * framebuffer, so everything stays scene-referred until the grade pass
 * tonemaps and encodes it. One consequence worth knowing: a custom
 * `ShaderMaterial` that writes finished sRGB values straight to `gl_FragColor`
 * used to sneak past tone mapping entirely; now it gets ACES + sRGB like every
 * lit material does. Write *linear* values from custom shaders (a
 * `THREE.Color` uniform is already linear) and it lands where you meant it to.
 *
 * `postprocessing@6.39` is installed but peer-deps three >= 0.168 and breaks
 * against the pinned 0.160 — three's own EffectComposer is what's used here.
 * UnrealBloomPass is deliberately *not* used either: its five-mip pyramid is
 * a dozen render-target switches, and on a tiler each switch is a tile flush.
 * The glow below is three draws at quarter resolution and composites for free
 * inside the grade pass.
 *
 * Tiering: 'low' is grade + FXAA only. 'medium' adds glow, aberration, grain
 * and the impact wobble. 'high' widens the glow and swaps FXAA for SMAA. The
 * key light and the aerial/chroma work below are unconditional — they are the
 * look, not an effect, and they cost a handful of ALU with no extra samples.
 *
 * ── Grade contract (do not regress these; a director panel caught all of them) ──
 *  1. This is a *sunny* game. Exposure sits high enough that the sky reaches
 *     the top of the range and the fairway lands near mid-tone — never a
 *     dusk-blue wash with the grass crushed into the toe.
 *  2. The vignette is weighted to the TOP of the frame. The bottom third is
 *     the play area: the ball, its shadow and the lie live there and must stay
 *     legible, so the vignette is scaled to almost nothing below y≈0.2.
 *  3. ONE LIGHT, ONE FRAME. The panel's headline defect was a frame in two
 *     unrelated palettes — a flat desaturated overcast sky stacked on a
 *     near-primary sunlit fairway, with nothing above the horizon to justify
 *     the warm key below it. The fix is `key` + `sun`: a directional white
 *     balance anchored on the *same* screen-space sun the sky shader draws
 *     (see SUN_UV below), warm toward the source and cool away from it,
 *     applied in linear light across the entire frame — sky, mountains, sea
 *     and turf alike. Plus a veiling glare pooled around that source so the
 *     rim light on the grass has something visible to come from. Never grade
 *     the ground and the sky with separate looks again.
 *  4. Chroma is CEILED, not boosted. The fairway used to leave the grade at
 *     99-100% saturation — a near-primary green that could not belong to the
 *     same photograph as an 11%-saturation sky. `satCeil` is a filmic chroma
 *     roll-off with a soft knee: everything under the knee is untouched (sky,
 *     haze, sand, sea), everything over it compresses. That pulls the turf
 *     ~15-20% without touching the backdrop, which closes the palette gap
 *     from the saturated end instead of by washing the sky out further.
 *  5. The upper fifth of frame is not allowed to be the mushiest part of the
 *     image. `skyAmt` is a graduated density filter (bright, non-green content
 *     only) that puts a real ramp from a warm horizon to a deeper, cooler
 *     zenith, and `dehaze` restores chroma and contrast to aerial pixels the
 *     distance haze washed toward white, so far mountains keep hue and edge.
 *  6. Split tone carries what the geometry cannot: warm gain + warm highlight
 *     tint against a cool shadow lift. That two-tone is what separates the
 *     four parallax tiers into distance instead of flat bands.
 *  7. Bloom is for emissives only. The threshold is above anything the sky
 *     gradient or a lit cloud can reach, and the bright pass fades to black
 *     inside the buffer border so the clamp-to-edge blur can never replicate a
 *     bright row into a band along the edge of frame.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { Pass, FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import type { CourseTheme, Hole, System, SystemFactory } from "../types";

// ---------------------------------------------------------------------------
// Key light placement
// ---------------------------------------------------------------------------

/**
 * Screen-space uv of the sun disc, per theme.
 *
 * The sky shader parks the sun at infinity — `uSun` is rebuilt every frame as
 * `cam.pos + half * clamp(theme.sunAt / k)` against a quad spanning
 * `cam.pos ± half * 1.05` — so however the camera translates or zooms, the
 * disc lands at a *fixed fraction of the frame*. Which means the grade can
 * anchor its key on the same point with a constant, and the warm pool always
 * sits on the visible source rather than drifting off it.
 *
 * These are that fraction, evaluated once: `(clamp(sunAt.x / 58, ±0.72) +
 * 1.05) / 2.1` and `(clamp(sunAt.y / 46, -0.9, 0.86) + 1.05) / 2.1`, with
 * vUv.y measured from the bottom of frame. Verified against a capture: the
 * brightest pixel of the seaside sky sits at (0.237, 0.824) and the table says
 * (0.237, 0.811) — inside the corona, which is all a glow this soft needs.
 *
 * If the renderer ever moves a sun, move it here too; being a few percent out
 * is harmless, being on the wrong side of frame is not.
 */
const SUN_UV: Record<CourseTheme, [number, number]> = {
  seaside: [0.237, 0.811],
  jungle: [0.270, 0.852],
  canyon: [0.221, 0.769],
  neon: [0.204, 0.910],
  sky: [0.254, 0.852],
  volcano: [0.254, 0.748],
  glacier: [0.254, 0.831],
};

// ---------------------------------------------------------------------------
// Grade presets
// ---------------------------------------------------------------------------

type V2 = [number, number];
type V3 = [number, number, number];

/**
 * One filmic look. `gain` and `key` act in linear light before the tonemapper
 * (they are white balances); `lift` and `hi` act after it, in display space, so
 * they tint shadows and highlights without dragging the midtones around. That
 * split is what keeps a strong grade from eating the value separation between
 * the play surface and the backdrop.
 */
interface Grade {
  exposure: number;
  gain: V3;
  lift: V3;
  hi: V3;
  contrast: number;
  saturation: number;
  /**
   * Midtone S-curve amount. Applied with the toe masked off, so it widens the
   * separation between the background tiers (which all live in the mids) and
   * opens the upper mids in the sky, without re-crushing the shadows.
   */
  scurve: number;
  /**
   * Hue-targeted lift on green-dominant pixels. The fairway is the subject of
   * this game and has to be the brightest surface on screen; this guarantees
   * it regardless of how the lighting lands. It lifts *value*, not chroma —
   * the per-channel gammas in the shader are near-parallel with only a slight
   * warm lean, because the version that opened green two stops ahead of blue
   * is what drove the turf to a near-primary 99% saturation.
   */
  green: number;

  // --- key light (contract 3) ------------------------------------------------
  /** Screen uv of the sun, from SUN_UV. Drives the glare and the key ramp. */
  sun: V2;
  /**
   * Linear white balance *at* the sun. Its mirror about white (2 - key) is
   * applied at the far side of frame, so one vector gives both the warm key
   * and the cool fill and they can never drift apart.
   */
  key: V3;
  /** How much of that ramp to apply. 0 = flat, uniform grade. */
  keyWarm: number;
  /** Veiling glare pooled around the sun, added in linear light. */
  sunGlow: number;

  // --- atmosphere (contract 5) -----------------------------------------------
  /** Multiplicative zenith density + hue. Below 1 darkens; blue-leaning cools. */
  sky: V3;
  /** Strength of that graduated filter. */
  skyAmt: number;
  /** Chroma + contrast restored to aerial pixels the distance haze washed out. */
  dehaze: number;

  // --- chroma ceiling (contract 4) -------------------------------------------
  /** Saturation the roll-off asymptotes to. Knee sits at 65% of it. */
  satCeil: number;

  vignette: number;
  aberration: number;
  grain: number;
  /** Glow strength and its linear-light threshold. */
  bloom: number;
  threshold: number;
}

const GRADES: Record<CourseTheme, Grade> = {
  // Sunny tropical par 3. Warm key from the upper-left sun, cool sea-bounce
  // fill, turf held just under the chroma ceiling so it reads sunlit rather
  // than printed.
  seaside: {
    exposure: 1.33, gain: [1.07, 1.012, 0.915], lift: [0.010, 0.026, 0.046], hi: [1.10, 1.035, 0.925],
    contrast: 1.05, saturation: 1.05, scurve: 0.38, green: 0.62,
    sun: SUN_UV.seaside, key: [1.125, 1.020, 0.855], keyWarm: 0.50, sunGlow: 0.46,
    sky: [0.862, 0.900, 0.958], skyAmt: 0.92, dehaze: 0.62, satCeil: 0.84,
    vignette: 0.20, aberration: 0.0014, grain: 0.011,
    bloom: 0.42, threshold: 2.85,
  },
  // Humid and deep — sunlight punching through the canopy, shade stays green.
  jungle: {
    exposure: 1.30, gain: [1.00, 1.035, 0.935], lift: [0.010, 0.028, 0.032], hi: [1.10, 1.045, 0.90],
    contrast: 1.06, saturation: 1.03, scurve: 0.38, green: 0.58,
    sun: SUN_UV.jungle, key: [1.115, 1.035, 0.850], keyWarm: 0.46, sunGlow: 0.42,
    sky: [0.880, 0.915, 0.948], skyAmt: 0.78, dehaze: 0.56, satCeil: 0.86,
    vignette: 0.22, aberration: 0.0014, grain: 0.012,
    bloom: 0.36, threshold: 2.95,
  },
  // Baked red rock: amber highlights, violet shade.
  canyon: {
    exposure: 1.32, gain: [1.11, 1.00, 0.90], lift: [0.030, 0.010, 0.042], hi: [1.14, 1.00, 0.855],
    contrast: 1.06, saturation: 1.04, scurve: 0.36, green: 0.25,
    sun: SUN_UV.canyon, key: [1.150, 1.005, 0.845], keyWarm: 0.52, sunGlow: 0.62,
    sky: [0.865, 0.895, 0.960], skyAmt: 0.80, dehaze: 0.52, satCeil: 0.86,
    vignette: 0.22, aberration: 0.0018, grain: 0.013,
    bloom: 0.42, threshold: 2.80,
  },
  // Magenta-and-cyan. The one place the grade is allowed to shout, so the
  // ceiling sits high and the key is a cold moon instead of a sun.
  neon: {
    exposure: 1.20, gain: [1.04, 0.945, 1.11], lift: [0.004, 0.030, 0.062], hi: [1.15, 0.89, 1.15],
    contrast: 1.10, saturation: 1.16, scurve: 0.32, green: 0.28,
    sun: SUN_UV.neon, key: [0.860, 1.000, 1.140], keyWarm: 0.42, sunGlow: 0.50,
    sky: [0.900, 0.905, 0.985], skyAmt: 0.55, dehaze: 0.34, satCeil: 1.00,
    vignette: 0.30, aberration: 0.0030, grain: 0.018,
    bloom: 0.95, threshold: 1.95,
  },
  // Thin air: lifted blacks, low contrast, almost no vignette. The zenith
  // density is the strongest in the set because there is more sky than course.
  sky: {
    exposure: 1.36, gain: [1.00, 1.008, 1.035], lift: [0.020, 0.030, 0.044], hi: [1.06, 1.045, 1.045],
    contrast: 1.00, saturation: 1.00, scurve: 0.30, green: 0.42,
    sun: SUN_UV.sky, key: [1.075, 1.020, 0.905], keyWarm: 0.44, sunGlow: 0.52,
    sky: [0.855, 0.900, 0.975], skyAmt: 0.95, dehaze: 0.58, satCeil: 0.82,
    vignette: 0.14, aberration: 0.0010, grain: 0.010,
    bloom: 0.55, threshold: 2.60,
  },
  // Hot orange against blue-black; the strongest glow in the set.
  volcano: {
    exposure: 1.22, gain: [1.14, 0.965, 0.855], lift: [0.016, 0.004, 0.042], hi: [1.20, 0.935, 0.72],
    contrast: 1.10, saturation: 1.06, scurve: 0.34, green: 0.22,
    sun: SUN_UV.volcano, key: [1.175, 0.985, 0.815], keyWarm: 0.50, sunGlow: 0.66,
    sky: [0.880, 0.895, 0.945], skyAmt: 0.62, dehaze: 0.38, satCeil: 0.94,
    vignette: 0.28, aberration: 0.0026, grain: 0.016,
    bloom: 0.85, threshold: 2.05,
  },
  // Teal ice, crisp and slightly desaturated so the flag stays the only red.
  glacier: {
    exposure: 1.34, gain: [0.975, 1.008, 1.065], lift: [0.004, 0.020, 0.046], hi: [1.03, 1.04, 1.075],
    contrast: 1.05, saturation: 0.98, scurve: 0.32, green: 0.34,
    sun: SUN_UV.glacier, key: [1.055, 1.015, 0.930], keyWarm: 0.40, sunGlow: 0.46,
    sky: [0.860, 0.900, 0.970], skyAmt: 0.88, dehaze: 0.54, satCeil: 0.80,
    vignette: 0.18, aberration: 0.0016, grain: 0.011,
    bloom: 0.60, threshold: 2.55,
  },
};

const SCALARS = [
  "exposure", "contrast", "saturation", "scurve", "green",
  "keyWarm", "sunGlow", "skyAmt", "dehaze", "satCeil",
  "vignette", "aberration", "grain", "bloom", "threshold",
] as const;
/** Every array-valued field. Lerped component-wise, whatever the length. */
const VECTORS = ["gain", "lift", "hi", "key", "sky", "sun"] as const;

function cloneGrade(g: Grade): Grade {
  return {
    ...g,
    gain: [...g.gain], lift: [...g.lift], hi: [...g.hi],
    key: [...g.key], sky: [...g.sky], sun: [...g.sun],
  };
}

/** In-place exponential approach of `cur` toward `to`. */
function approachGrade(cur: Grade, to: Grade, k: number): void {
  for (const key of SCALARS) cur[key] += (to[key] - cur[key]) * k;
  for (const key of VECTORS) {
    const a = cur[key] as number[];
    const b = to[key] as number[];
    for (let i = 0; i < a.length; i++) a[i] += (b[i] - a[i]) * k;
  }
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * Soft-kneed bright pass. Nothing under `uThreshold` linear ever glows, and the
 * threshold is set above what the sky gradient, the horizon warm band or a lit
 * cloud can reach — only genuine emissives (powerups, the ball, lava, neon)
 * survive it.
 *
 * `uEdge` fades the bright pass to black inside the buffer border. The blur
 * below samples with clamp-to-edge, so without this a bright pixel touching the
 * frame edge gets its row/column replicated outward and lands as a flat band
 * hugging the top or side of the screen — which is exactly what a downsampled
 * pass "bleeding past the screen edge" looks like.
 */
const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uThreshold, uKnee, uEdge;
varying vec2 vUv;
void main() {
  vec3 c = max(texture2D(tDiffuse, vUv).rgb, vec3(0.0));
  float peak = max(c.r, max(c.g, c.b));
  vec2 e = min(vUv, 1.0 - vUv);
  float edge = smoothstep(0.0, uEdge, min(e.x, e.y));
  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + uKnee, peak) * edge, 1.0);
}`;

/** Separable 9-tap gaussian collapsed to 5 linear-filtered samples. */
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 s = texture2D(tDiffuse, vUv).rgb * 0.227027;
  s += (texture2D(tDiffuse, vUv + uDir * 1.3846154).rgb
      + texture2D(tDiffuse, vUv - uDir * 1.3846154).rgb) * 0.3162162;
  s += (texture2D(tDiffuse, vUv + uDir * 3.2307692).rgb
      + texture2D(tDiffuse, vUv - uDir * 3.2307692).rgb) * 0.0702703;
  gl_FragColor = vec4(s, 1.0);
}`;

const GRADE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform vec3 uGain, uLift, uHi, uKey, uSkyMul;
uniform float uExposure, uContrast, uSaturation, uSCurve, uGreen;
uniform float uKeyWarm, uSunGlow, uSkyAmt, uDehaze, uSatCeil;
uniform float uVignette, uAberration, uGrain, uBloom;
uniform float uTime, uShock, uAspect;
uniform vec2 uShockAt, uOverscan, uSunAt;
varying vec2 vUv;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Matches three's ACESFilmicToneMapping exactly, so lit geometry is unchanged
// from the un-composed path apart from the grade itself.
vec3 acesFilmic(vec3 color) {
  const mat3 ACESIn = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOut = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602));
  color = ACESIn * color;
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  return clamp(ACESOut * (a / b), 0.0, 1.0);
}

vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(0.41666)) - 0.055, step(0.0031308, c));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = vUv;

  // Radius normalised so the corner is 1.0 at any aspect — the vignette and
  // the aberration ramp then frame a 430x932 phone like they do a laptop.
  vec2 c = (uv - 0.5) * 2.0;
  c.x *= uAspect;
  float r = length(c) / length(vec2(uAspect, 1.0));

  float shock = 0.0;
#ifdef SHOCK
  shock = uShock;
  if (shock > 0.001) {
    vec2 d = uv - uShockAt;
    d.x *= uAspect;
    float rr = length(d) + 1e-4;
    float wave = sin(rr * 24.0 - uTime * 26.0) * exp(-rr * 3.2) * shock * 0.0075;
    uv += (d / rr) * wave;
  }
#endif

  // Overscan. A handful of pixels at the very border of the colour buffer are
  // not reliably covered by scene geometry — the sky quad is sized to the
  // frustum and a rounding pixel either way leaves the clear colour showing as
  // a flat desaturated strip up the edge of frame. Sampling a few pixels in
  // and stretching costs ~1% of framing and guarantees the border is picture.
  uv = 0.5 + (uv - 0.5) * uOverscan;

  vec3 col;
#ifdef ABERRATION
  // Radial split ramped by r^2, so the centre of frame — where the ball lives
  // — stays perfectly registered. A hard impact widens it for a few frames.
  vec2 off = (uv - 0.5) * (uAberration * r * r * (1.0 + shock * 4.0));
  col.r = texture2D(tDiffuse, uv + off).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - off).b;
#else
  col = texture2D(tDiffuse, uv).rgb;
#endif

#ifdef BLOOM
  col += texture2D(tBloom, uv).rgb * uBloom;
#endif

  // --- linear stage: exposure, key light, tonemap ---------------------------
  col = max(col, vec3(0.0)) * (uExposure / 0.6) * uGain;

  // Distance from the sun, measured in screen-height units so the pool stays
  // round on a 430x932 phone instead of stretching into a vertical smear.
  vec2 sd = vUv - uSunAt;
  sd.x *= uAspect;
  float sr = length(sd);

  // THE unifier (contract 3). A single directional white balance across the
  // whole frame: uKey at the source, its mirror about white at the far side.
  // Warm falls on the sky beside the sun, on the mountain flanks facing it and
  // on the fairway lip below it; the cool fill lands opposite. That gradient is
  // what makes the sky and the turf read as one exposure of one place, and it
  // is applied before the tonemapper so ACES rolls it off like real light.
  float away = smoothstep(0.10, 1.05, sr);
  col *= mix(vec3(1.0), mix(uKey, vec3(2.0) - uKey, away), uKeyWarm);

  // Veiling glare — the visible source the rim light was missing. Two lobes: a
  // tight corona and a broad atmospheric wash. Gated on local brightness so it
  // pools in the sky and over water and leaves the play surface alone; fogging
  // the lie to sell a sunbeam is not a trade this game makes.
  float lin = dot(col, LUMA);
  float glare = exp(-sr * 2.6) * 0.62 + exp(-sr * 8.0) * 0.38;
  col += uKey * (uSunGlow * glare * smoothstep(0.32, 0.95, lin));

  col = toSRGB(acesFilmic(col));

  // --- display stage --------------------------------------------------------
  float l = dot(col, LUMA);

  // Cool shadow lift against a warm highlight tint: the split-tone half of the
  // key/bounce read. It also pulls the deepest grass off the floor so the
  // bottom of frame keeps its texture instead of going to black.
  col += uLift * (1.0 - smoothstep(0.0, 0.62, l));
  col = mix(col, col * uHi, smoothstep(0.40, 1.0, l));
  col = clamp(col, 0.0, 1.0);

  // --- content mask ---------------------------------------------------------
  // Green dominance separates the play surface from everything else far more
  // reliably than any screen-space guess at where the horizon is: turf sits
  // 0.4+ above its own red and blue, while hazy sky, sea and sand are within a
  // hundredth of neutral on that axis. gdom is 1 on grass, ~0 on backdrop.
  float mx = max(col.r, max(col.g, col.b));
  float mn = min(col.r, min(col.g, col.b));
  float sat = (mx - mn) / max(mx, 1e-4);
  float gdom = clamp((col.g - max(col.r, col.b)) * 4.0, 0.0, 1.0);
  float lum = dot(col, LUMA);
  float bright = smoothstep(0.26, 0.54, lum);

  // Aerial = bright, non-green, up-frame. Two heights: the graduated filter
  // wants only the top of the sky, the haze recovery wants the whole backdrop
  // down to the ridge line. Both stop well above the ball, which is white,
  // bright and low in frame and must not pick up either.
  float aer = (1.0 - gdom) * bright;
  float grad = aer * smoothstep(0.54, 0.96, vUv.y);
  float far  = aer * smoothstep(0.42, 0.66, vUv.y);

  // Graduated density (contract 5). Multiplicative and slightly blue-leaning,
  // so the zenith deepens and cools while the horizon stays bright and warm —
  // a real top-to-bottom ramp where there used to be one flat mush, and the
  // gradient the sun's warmth is measured against.
  col *= mix(vec3(1.0), uSkyMul, uSkyAmt * grad);

  // Haze recovery. The distance fog washes far mountains toward white; this
  // puts back the chroma it took (luma-preserving, so nothing moves in value)
  // and expands contrast about the sky's own pivot so ridges keep an edge.
  // The wash gate is a band: near-neutral cloud and the ball stay neutral,
  // already-blue sky is left alone, and only the washed middle is recovered.
  float wash = smoothstep(0.03, 0.16, sat) * (1.0 - smoothstep(0.34, 0.62, sat));
  float rec = uDehaze * far * wash;
  float dl = dot(col, LUMA);
  col = mix(col, dl + (col - dl) * 1.55, rec);
  col = mix(col, (col - 0.70) * 1.22 + 0.70, rec * 0.85);
  col = clamp(col, 0.0, 1.0);

  // Fairway value lift. The play surface has to be the brightest thing on
  // screen, but the gammas below are near-parallel with only a slight warm
  // lean: the old version opened green two stops ahead of blue, which is what
  // printed the turf at a near-primary 99% saturation the sky could never
  // answer. It lifts a grass pixel sitting in shade far more than one in full
  // sun, so the dark side of the fairway keeps its blade texture. The
  // saturation gate is load-bearing: hazy sky and lit cloud sit a few points
  // green of neutral, and without it the whole upper frame turns olive.
  float gw = gdom * smoothstep(0.26, 0.56, sat);
  col = mix(col, pow(max(col, vec3(1e-4)), vec3(0.865, 0.845, 0.905)), gw * uGreen);
  col = clamp(col, 0.0, 1.0);

  // Midtone S. Weighted off the toe so it widens the gap between the parallax
  // tiers, and released again near white so the sky keeps its highlight range
  // instead of flattening into one blown mass.
  float sl = dot(col, LUMA);
  vec3 s = col * col * (3.0 - 2.0 * col);
  col = mix(col, s, uSCurve * smoothstep(0.10, 0.38, sl) * (1.0 - smoothstep(0.70, 0.97, sl)));

  col = (col - 0.5) * uContrast + 0.5;
  l = dot(col, LUMA);
  col = mix(vec3(l), col, uSaturation);
  col = clamp(col, 0.0, 1.0);

  // Chroma roll-off (contract 4). A filmic shoulder on saturation rather than
  // a global desaturate: under the knee nothing moves, so the sky, the haze,
  // the sand and the sea keep every point of the little chroma they have,
  // while the turf — which arrives here pinned at 99% — compresses toward
  // uSatCeil and lands ~15-20% down, in the same photograph as the backdrop.
  // Mixing toward luma is exact-luma-preserving, so this costs no brightness.
  mx = max(col.r, max(col.g, col.b));
  mn = min(col.r, min(col.g, col.b));
  sat = (mx - mn) / max(mx, 1e-4);
  float knee = uSatCeil * 0.65;
  float span = max(uSatCeil - knee, 1e-3);
  float over = max(sat - knee, 0.0);
  float rolled = knee + span * (1.0 - exp(-over / span));
  float sf = mix(1.0, rolled / max(sat, 1e-4), step(knee, sat));
  col = mix(vec3(dot(col, LUMA)), col, sf);

  // Vignette, biased hard to the top of frame. vUv.y is 0 at the bottom of the
  // screen, which is the play area — the ball, its lie and the contact shadow
  // live there, so the falloff is scaled to ~8% before it can touch them.
  float top = mix(0.08, 1.0, smoothstep(0.18, 0.86, vUv.y));
  col *= 1.0 - uVignette * smoothstep(0.44, 1.06, r) * top;

#ifdef GRAIN
  // Also breaks up banding in the big sky gradient, which is most of the frame.
  col += (hash12(gl_FragCoord.xy + uTime * 60.0) - 0.5) * uGrain;
#endif

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// ---------------------------------------------------------------------------
// Glow
// ---------------------------------------------------------------------------

/** Quarter-resolution downsample factor for the glow chain. */
const GLOW_DIV = 4;

/** Border, in ¼-res uv, over which the bright pass fades to black. */
const GLOW_EDGE = 0.035;

/** CSS pixels trimmed off each edge by the grade pass's overscan. */
const OVERSCAN_PX = 6;

/** Per-axis uv scale that trims `OVERSCAN_PX` from both edges of a w×h frame. */
function overscan(out: THREE.Vector2, w: number, h: number): THREE.Vector2 {
  const sx = 1 - (2 * OVERSCAN_PX) / Math.max(1, w);
  const sy = 1 - (2 * OVERSCAN_PX) / Math.max(1, h);
  return out.set(THREE.MathUtils.clamp(sx, 0.9, 1), THREE.MathUtils.clamp(sy, 0.9, 1));
}

/**
 * Threshold + separable blur into a private half-float target. `needsSwap` is
 * false: this pass reads the composer's colour buffer and leaves it alone, and
 * the grade pass composites the result. Three draws (or five, on 'high'), all
 * at 1/16 the pixel count.
 */
class GlowPass extends Pass {
  readonly texture: THREE.Texture;
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private bright: THREE.ShaderMaterial;
  private blur: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private iterations: number;

  constructor(width: number, height: number, iterations: number) {
    super();
    this.needsSwap = false;
    this.iterations = iterations;

    const opts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      // Explicit: the blur taps past the border and the grade samples the
      // result full-screen. Clamped + the bright pass's edge fade means the
      // border is guaranteed black rather than a replicated bright row.
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    };
    const w = Math.max(1, Math.floor(width / GLOW_DIV));
    const h = Math.max(1, Math.floor(height / GLOW_DIV));
    this.rtA = new THREE.WebGLRenderTarget(w, h, opts);
    this.rtB = new THREE.WebGLRenderTarget(w, h, opts);
    this.texture = this.rtA.texture;

    this.bright = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uThreshold: { value: 2.5 },
        uKnee: { value: 0.9 },
        uEdge: { value: GLOW_EDGE },
      },
      vertexShader: FS_VERT,
      fragmentShader: BRIGHT_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.blur = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: FS_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.bright);
  }

  set threshold(v: number) {
    this.bright.uniforms.uThreshold.value = v;
    this.bright.uniforms.uKnee.value = Math.max(0.25, v * 0.35);
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / GLOW_DIV));
    const h = Math.max(1, Math.floor(height / GLOW_DIV));
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const w = this.rtA.width;
    const h = this.rtA.height;

    this.quad.material = this.bright;
    this.bright.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.rtA);
    this.quad.render(renderer);

    this.quad.material = this.blur;
    const dir = this.blur.uniforms.uDir.value as THREE.Vector2;
    for (let i = 0; i < this.iterations; i++) {
      // Widen each iteration so two passes reach far without extra taps.
      const spread = 1 + i * 2;
      this.blur.uniforms.tDiffuse.value = this.rtA.texture;
      dir.set(spread / w, 0);
      renderer.setRenderTarget(this.rtB);
      this.quad.render(renderer);

      this.blur.uniforms.tDiffuse.value = this.rtB.texture;
      dir.set(0, spread / h);
      renderer.setRenderTarget(this.rtA);
      this.quad.render(renderer);
    }
  }

  dispose(): void {
    this.rtA.dispose();
    this.rtB.dispose();
    this.bright.dispose();
    this.blur.dispose();
    this.quad.dispose();
  }
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

const createPostFx: SystemFactory = async (ctx) => {
  const noop: System = { name: "postfx" };

  try {
    const q = ctx.quality;
    const wantBloom = q !== "low";
    const wantFancy = q !== "low";

    const size = ctx.renderer.getSize(new THREE.Vector2());
    const pr = ctx.renderer.getPixelRatio();

    const composer = new EffectComposer(ctx.renderer);
    composer.setPixelRatio(pr);
    composer.setSize(size.x, size.y);
    composer.addPass(new RenderPass(ctx.scene, ctx.camera));

    // --- Glow ----------------------------------------------------------------
    let glow: GlowPass | null = null;
    if (wantBloom) {
      glow = new GlowPass(size.x * pr, size.y * pr, q === "high" ? 2 : 1);
      composer.addPass(glow);
    }

    // --- Grade ---------------------------------------------------------------
    // The course fires `golf:hole` at boot stage 3, long before this system
    // exists, so seed from whatever is already loaded and snap to it — hole one
    // must open on its own grade, not fade in from a default.
    const first = ctx.services.course?.current?.theme;
    const seed = (first && GRADES[first]) || GRADES.seaside;
    const cur = cloneGrade(seed);
    let target = cloneGrade(seed);

    const defines: Record<string, string> = {};
    if (wantFancy) {
      defines.ABERRATION = "";
      defines.GRAIN = "";
      defines.SHOCK = "";
    }
    if (glow) defines.BLOOM = "";

    const gradePass = new ShaderPass({
      name: "GolfGradeShader",
      defines,
      uniforms: {
        tDiffuse: { value: null },
        tBloom: { value: glow ? glow.texture : null },
        uGain: { value: new THREE.Vector3(1, 1, 1) },
        uLift: { value: new THREE.Vector3(0, 0, 0) },
        uHi: { value: new THREE.Vector3(1, 1, 1) },
        uKey: { value: new THREE.Vector3(1, 1, 1) },
        uSkyMul: { value: new THREE.Vector3(1, 1, 1) },
        uExposure: { value: 1 },
        uContrast: { value: 1 },
        uSaturation: { value: 1 },
        uSCurve: { value: 0.38 },
        uGreen: { value: 0.55 },
        uKeyWarm: { value: 0 },
        uSunGlow: { value: 0 },
        uSkyAmt: { value: 0 },
        uDehaze: { value: 0 },
        uSatCeil: { value: 1 },
        uVignette: { value: 0.20 },
        uAberration: { value: 0.0014 },
        uGrain: { value: 0.011 },
        uBloom: { value: 0.42 },
        uTime: { value: 0 },
        uShock: { value: 0 },
        uAspect: { value: Math.max(0.01, size.x / Math.max(1, size.y)) },
        uShockAt: { value: new THREE.Vector2(0.5, 0.5) },
        uSunAt: { value: new THREE.Vector2(seed.sun[0], seed.sun[1]) },
        uOverscan: { value: overscan(new THREE.Vector2(), size.x, size.y) },
      },
      vertexShader: FS_VERT,
      fragmentShader: GRADE_FRAG,
    });
    composer.addPass(gradePass);
    const U = gradePass.uniforms;

    // --- Anti-aliasing -------------------------------------------------------
    // Extruded slabs are long, high-contrast diagonals; SMAA is worth its two
    // extra passes on desktop, FXAA is the right trade on a phone. MSAA is
    // deliberately not used — a 4x half-float multisample pair at DPR 2 costs
    // several hundred megabytes, which a golf game does not get to spend.
    let smaa: { setSize(w: number, h: number): void; dispose?: () => void } | null = null;
    let fxaa: ShaderPass | null = null;
    if (q === "high") {
      try {
        // Dynamic so SMAA's embedded lookup textures stay out of the main chunk.
        const mod = await import("three/examples/jsm/postprocessing/SMAAPass.js");
        const pass = new mod.SMAAPass(size.x * pr, size.y * pr);
        composer.addPass(pass);
        smaa = pass;
      } catch {
        smaa = null;
      }
    }
    if (!smaa) {
      fxaa = new ShaderPass(FXAAShader);
      fxaa.material.uniforms.resolution.value.set(1 / (size.x * pr), 1 / (size.y * pr));
      composer.addPass(fxaa);
    }

    // --- Theme cross-fade ----------------------------------------------------
    const offHole = ctx.on("golf:hole", (payload) => {
      const theme = (payload as { hole?: Hole } | undefined)?.hole?.theme as CourseTheme | undefined;
      if (theme && GRADES[theme]) target = cloneGrade(GRADES[theme]);
    });

    // --- Impact wobble -------------------------------------------------------
    let shock = 0;
    const shockAt = new THREE.Vector2(0.5, 0.5);

    /** Project a world point into 0..1 screen uv through the ortho frustum. */
    function worldToUv(x: number, y: number): void {
      const cam = ctx.camera;
      const w = cam.right - cam.left;
      const h = cam.top - cam.bottom;
      if (w <= 0 || h <= 0) return;
      shockAt.set(
        THREE.MathUtils.clamp((x - cam.position.x) / w + 0.5, 0, 1),
        THREE.MathUtils.clamp((y - cam.position.y) / h + 0.5, 0, 1),
      );
    }

    const offBounce = ctx.on("golf:bounce", (payload) => {
      if (!wantFancy) return;
      const p = payload as { at?: { x: number; y: number }; speed?: number } | undefined;
      const speed = p?.speed ?? 0;
      if (speed < 15) return; // only genuinely hard hits ring the frame
      const amt = Math.min(0.8, (speed - 15) / 30);
      if (amt <= shock) return;
      shock = amt;
      if (p?.at) worldToUv(p.at.x, p.at.y);
    });

    const offShake = ctx.on("golf:shake", (payload) => {
      if (!wantFancy) return;
      const amt = typeof payload === "number" ? payload : (payload as { amount?: number } | undefined)?.amount ?? 0;
      // vfx already translates the camera; postfx only adds the ripple, so the
      // two never compound into motion sickness.
      shock = Math.min(1, Math.max(shock, Math.abs(amt) * 0.45));
    });

    let bloomPulse = 0;
    const offHoled = ctx.on("golf:holed", () => {
      if (wantBloom) bloomPulse = 0.55;
    });

    // --- Frame ---------------------------------------------------------------
    let broken = false;

    function render(dt: number): void {
      if (broken) {
        ctx.renderer.render(ctx.scene, ctx.camera);
        return;
      }
      const step = Math.min(Math.max(dt, 0), 1 / 20);

      // ~0.5 s to settle onto a new theme; slow enough to read as a dissolve.
      // The sun uv rides the same lerp, so the key swings across frame as the
      // grade dissolves instead of snapping to the new hole's light.
      approachGrade(cur, target, 1 - Math.exp(-step / 0.16));

      (U.uGain.value as THREE.Vector3).set(cur.gain[0], cur.gain[1], cur.gain[2]);
      (U.uLift.value as THREE.Vector3).set(cur.lift[0], cur.lift[1], cur.lift[2]);
      (U.uHi.value as THREE.Vector3).set(cur.hi[0], cur.hi[1], cur.hi[2]);
      (U.uKey.value as THREE.Vector3).set(cur.key[0], cur.key[1], cur.key[2]);
      (U.uSkyMul.value as THREE.Vector3).set(cur.sky[0], cur.sky[1], cur.sky[2]);
      (U.uSunAt.value as THREE.Vector2).set(cur.sun[0], cur.sun[1]);
      // Tone mapping never ran on the buffer, so the renderer's exposure is
      // folded in here instead — anyone animating it still gets what they want.
      U.uExposure.value = cur.exposure * ctx.renderer.toneMappingExposure;
      U.uContrast.value = cur.contrast;
      U.uSaturation.value = cur.saturation;
      U.uSCurve.value = cur.scurve;
      U.uGreen.value = cur.green;
      U.uKeyWarm.value = cur.keyWarm;
      U.uSunGlow.value = cur.sunGlow;
      U.uSkyAmt.value = cur.skyAmt;
      U.uDehaze.value = cur.dehaze;
      U.uSatCeil.value = cur.satCeil;
      U.uVignette.value = cur.vignette;
      U.uAberration.value = cur.aberration;
      U.uGrain.value = cur.grain;
      U.uTime.value = ctx.elapsed;

      shock *= Math.exp(-step * 6.5);
      if (shock < 0.002) shock = 0;
      U.uShock.value = shock;
      (U.uShockAt.value as THREE.Vector2).copy(shockAt);

      if (glow) {
        bloomPulse *= Math.exp(-step * 3.2);
        U.uBloom.value = cur.bloom + bloomPulse;
        glow.threshold = cur.threshold;
      }

      try {
        composer.render(step);
      } catch (err) {
        // Never leave the player staring at a black screen.
        console.error("[Vibe Golf] postfx render failed, falling back:", err);
        broken = true;
        ctx.emit("golf:postfx", null);
        ctx.renderer.render(ctx.scene, ctx.camera);
      }
    }

    // Prove the chain actually draws before handing the frame over. If the
    // driver rejects half-float targets or a shader fails to compile, we find
    // out here and the player keeps the plain renderer.
    composer.render(1 / 60);
    ctx.emit("golf:postfx", render);

    return {
      name: "postfx",
      resize(w, h) {
        try {
          const ratio = ctx.renderer.getPixelRatio();
          composer.setPixelRatio(ratio);
          composer.setSize(w, h);
          U.uAspect.value = Math.max(0.01, w / Math.max(1, h));
          overscan(U.uOverscan.value as THREE.Vector2, w, h);
          fxaa?.material.uniforms.resolution.value.set(1 / (w * ratio), 1 / (h * ratio));
        } catch (err) {
          console.error("[Vibe Golf] postfx resize failed:", err);
        }
      },
      dispose() {
        offHole();
        offBounce();
        offShake();
        offHoled();
        ctx.emit("golf:postfx", null);
        try {
          glow?.dispose();
          smaa?.dispose?.();
          fxaa?.dispose?.();
          gradePass.dispose?.();
          composer.dispose?.();
        } catch {
          /* teardown is best-effort */
        }
      },
    } satisfies System;
  } catch (err) {
    // A missing addon or a shader compile error costs the grade, not the game.
    console.error("[Vibe Golf] postfx unavailable, rendering unprocessed:", err);
    return noop;
  }
};

export default createPostFx;
