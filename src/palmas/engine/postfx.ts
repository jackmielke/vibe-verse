/**
 * San Palmas — post-processing.
 *
 * This module owns the final image. Everything else in the engine renders a
 * *scene*; this is what turns it into a *frame*.
 *
 * The chain is hand-rolled rather than driven by `EffectComposer`, for three
 * reasons that all matter here:
 *
 *   1. The scene is rendered into an HDR half-float target with a real depth
 *      texture attached, and that depth is then read by AO, depth of field,
 *      camera motion blur, the light shafts and the heat-haze — one scene pass
 *      feeding five effects. A composer's ping-pong would eventually bind that
 *      depth attachment as the write target while it is still bound as a
 *      sampler, which is a framebuffer feedback loop and a black screen on some
 *      drivers.
 *   2. `renderer.toneMapping` is *skipped* by three whenever the destination is
 *      a render target (see WebGLRenderer's `toneMapping` parameter selection),
 *      so everything arriving in our buffer is genuinely scene-referred HDR.
 *      Bloom thresholds and the grade therefore operate on real radiance, and
 *      ACES is applied exactly once, by us, at the very end. The forward
 *      fallback path in `core.ts` tone-maps per-material and lands in the same
 *      place, so the two paths agree.
 *   3. `postprocessing@6.39` declares a peer dependency on three >= 0.168 and
 *      this repo is pinned to 0.160. Only `SMAAPass` is borrowed from three's
 *      own addons — it is a standalone `Pass` and drives fine by hand.
 *
 * Order of operations (high tier):
 *
 *   scene ─▶ HDR + depth
 *         ├─▶ AO       (half res, depth-only, bilateral blurred)
 *         ├─▶ bloom    (prefilter + 5-mip down/up pyramid, half res)
 *         ├─▶ bokeh    (half res golden-angle disc, the DOF far field)
 *         ├─▶ shafts   (quarter res, sky-masked radial blur from the sun)
 *         └─▶ composite: distortion, chromatic aberration, motion blur, DOF,
 *                        AO, bloom, shafts, exposure, ACES, film grade,
 *                        vignette, grain, sRGB
 *                    └─▶ SMAA ─▶ screen
 *
 * Consumes  "palmas:distort"   {point, radius, strength, duration} — heat haze
 *           "palmas:submerged" boolean — swaps to the underwater grade
 *           "palmas:shake"     number  — lens character only, not camera motion
 *           "palmas:crosshair" {ads}   — drives the aim-down-sights focus pull
 *           "palmas:damage"    {health}— hurt vignette
 * Publishes "palmas:postfx"    the render override the engine installs
 *           "palmas:depth"     last frame's depth texture, for soft particles
 *
 * Nothing in here is allowed to be fatal: the whole build is wrapped, and a
 * throw at any point hands rendering straight back to the forward path.
 */
import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import type { QualityTier, System, SystemFactory, WorldCtx } from "../types";

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

interface FxTier {
  /** Attach a depth texture and light up everything that reads it. */
  depth: boolean;
  /** Double-buffer the scene target so soft particles can read last frame's depth. */
  softDepth: boolean;
  /** Mip count in the bloom pyramid. 0 disables bloom entirely. */
  bloomMips: number;
  /** Occlusion taps per pixel (half res). 0 disables AO. */
  aoTaps: number;
  dof: boolean;
  /** Motion blur taps. 0 disables. */
  mbTaps: number;
  /** Radial-blur samples for the light shafts. 0 disables. */
  raySamples: number;
  chromatic: boolean;
}

/**
 * 'low' is deliberately just AA and the grade — the tone curve is 95% of the
 * look and costs one full-screen pass, so it is the last thing to go.
 */
const TIERS: Record<QualityTier, FxTier> = {
  low: {
    depth: false, softDepth: false, bloomMips: 0, aoTaps: 0,
    dof: false, mbTaps: 0, raySamples: 0, chromatic: false,
  },
  medium: {
    depth: true, softDepth: false, bloomMips: 4, aoTaps: 6,
    dof: false, mbTaps: 0, raySamples: 12, chromatic: true,
  },
  high: {
    depth: true, softDepth: true, bloomMips: 5, aoTaps: 10,
    dof: true, mbTaps: 5, raySamples: 16, chromatic: true,
  },
  ultra: {
    depth: true, softDepth: true, bloomMips: 6, aoTaps: 14,
    dof: true, mbTaps: 9, raySamples: 24, chromatic: true,
  },
};

// ---------------------------------------------------------------------------
// The grade
// ---------------------------------------------------------------------------

/**
 * A full film grade as plain data, applied *after* ACES in display-referred
 * linear. Three of these are blended on the CPU every frame (daylight → night,
 * then → underwater) and the result is pushed into a single set of uniforms, so
 * the shader only ever evaluates one curve.
 *
 * The house look: warm, slightly lifted highlights; shadows pushed teal; a
 * gentle S about a 0.435 pivot; saturation up but vibrance doing most of the
 * work so the already-saturated turquoise water does not clip to neon.
 */
interface Grade {
  /** Scene-referred exposure multiplier, applied before the tone curve. */
  exposure: number;
  /** Pre-tonemap white balance, linear RGB gain. */
  filter: [number, number, number];
  /** Contrast slope about the pivot. */
  contrast: number;
  /** How much of the smooth toe/shoulder S to blend in on top. */
  scurve: number;
  /** Flat brightness offset, post-contrast. */
  offset: number;
  /** Matte black lift — the printed-film toe. Tinted, and it must be small. */
  lift: [number, number, number];
  /** Split-tone multipliers for the low and high ends of the luma range. */
  shadowTint: [number, number, number];
  highTint: [number, number, number];
  saturation: number;
  /** Extra saturation applied only to *unsaturated* pixels. */
  vibrance: number;
  /** How hard the top of the range bleaches toward paper white. */
  bleach: number;
  vignette: number;
  grain: number;
}

/** Tropical golden hour. This is the reference look; everything else is a lerp. */
const GRADE_DAY: Grade = {
  exposure: 1.03,
  filter: [1.035, 1.0, 0.955],
  contrast: 1.11,
  scurve: 0.24,
  offset: -0.004,
  lift: [0.006, 0.011, 0.019],
  shadowTint: [0.9, 0.985, 1.075],
  highTint: [1.055, 1.012, 0.945],
  saturation: 1.08,
  vibrance: 0.22,
  bleach: 0.14,
  vignette: 0.3,
  grain: 0.022,
};

/** After dusk: cooler, flatter, grainier — a pushed film stock. */
const GRADE_NIGHT: Grade = {
  exposure: 1.12,
  filter: [0.93, 0.985, 1.09],
  contrast: 1.04,
  scurve: 0.12,
  offset: 0.004,
  lift: [0.012, 0.02, 0.036],
  shadowTint: [0.82, 0.95, 1.16],
  highTint: [1.0, 1.005, 1.03],
  saturation: 0.86,
  vibrance: 0.16,
  bleach: 0.05,
  vignette: 0.42,
  grain: 0.055,
};

/** Below the waterline: everything the water absorbed on the way in. */
const GRADE_WATER: Grade = {
  exposure: 0.82,
  filter: [0.34, 0.86, 0.98],
  contrast: 1.03,
  scurve: 0.1,
  offset: 0.008,
  lift: [0.006, 0.028, 0.038],
  shadowTint: [0.62, 1.0, 1.12],
  highTint: [0.78, 1.02, 1.06],
  saturation: 0.82,
  vibrance: 0.1,
  bleach: 0.04,
  vignette: 0.62,
  grain: 0.03,
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
  l3(a.highTint, b.highTint, out.highTint);
  out.saturation = l(a.saturation, b.saturation);
  out.vibrance = l(a.vibrance, b.vibrance);
  out.bleach = l(a.bleach, b.bleach);
  out.vignette = l(a.vignette, b.vignette);
  out.grain = l(a.grain, b.grain);
}

function cloneGrade(g: Grade): Grade {
  return {
    ...g,
    filter: [...g.filter] as [number, number, number],
    lift: [...g.lift] as [number, number, number],
    shadowTint: [...g.shadowTint] as [number, number, number],
    highTint: [...g.highTint] as [number, number, number],
  };
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Bloom threshold in scene-referred linear. 1.0 is "as bright as a white
 * surface in full sun", so only genuine light sources — the sun disc, specular
 * glints off the bay, glass, muzzle flashes, explosions — get past it. Setting
 * this below 1 is the classic way to make an entire image look foggy.
 */
const BLOOM_THRESHOLD = 1.05;
const BLOOM_KNEE = 0.6;
/** Ceiling on a single prefiltered texel: stops the sun bleaching the frame. */
const BLOOM_CLAMP = 14;
/** Per-level gain in the upsample chain; < 1 keeps the widest mips subtle. */
const BLOOM_MIP_GAIN = 0.62;

const BLOOM_STRENGTH: Record<QualityTier, number> = {
  low: 0, medium: 0.036, high: 0.046, ultra: 0.05,
};

/** Occlusion radius in metres — roughly the width of a doorway reveal. */
const AO_RADIUS = 1.6;
const AO_STRENGTH: Record<QualityTier, number> = {
  low: 0, medium: 0.4, high: 0.5, ultra: 0.55,
};

/** Where the always-on far field starts to defocus, in metres. */
const DOF_FAR_START = 190;
const DOF_FAR_STRENGTH = 0.32;
/** Half-res pixels of blur in the bokeh buffer. */
const DOF_BOKEH_RADIUS = 5.5;

/** Shutter angle, expressed as an exposure time. 1/60 s is a 180° shutter @30. */
const MOTION_SHUTTER = 1 / 60;
const MOTION_STRENGTH = 0.85;

const RAY_STRENGTH: Record<QualityTier, number> = {
  low: 0, medium: 0.22, high: 0.3, ultra: 0.34,
};

/** Lens dispersion at the extreme corner, in uv. Zero at the centre by design. */
const CHROMATIC = 0.0042;

/** Concurrent heat-haze sources. Four is plenty — they overlap into mush past that. */
const DISTORT_SLOTS = 4;

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

/** View-space position of a pixel, given its uv and its linear depth. */
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
 * reconstructed from the *closest* depth difference on each axis so silhouettes
 * do not smear a false normal across the discontinuity.
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
uniform vec2 uTexel;
uniform float uRadius;
uniform float uProjScale;
uniform float uAspect;
uniform float uIntensity;

#define TAPS ${Math.max(1, Math.round(taps))}
const float GOLDEN = 2.39996323;

void main() {
  float d = texture2D(tDepth, vUv).x;
  // The sky writes no depth; occluding it would ring every roofline.
  if (d >= 0.99999) { gl_FragColor = vec4(1.0, 1e4, 0.0, 1.0); return; }

  float vz = linearDepth(d);
  vec3 p = viewPosition(vUv, vz);

  vec2 ex = vec2(uTexel.x, 0.0);
  vec2 ey = vec2(0.0, uTexel.y);
  float zl = linearDepth(texture2D(tDepth, vUv - ex).x);
  float zr = linearDepth(texture2D(tDepth, vUv + ex).x);
  float zd = linearDepth(texture2D(tDepth, vUv - ey).x);
  float zu = linearDepth(texture2D(tDepth, vUv + ey).x);
  vec3 dpx = abs(zr - vz) < abs(vz - zl)
    ? viewPosition(vUv + ex, zr) - p
    : p - viewPosition(vUv - ex, zl);
  vec3 dpy = abs(zu - vz) < abs(vz - zd)
    ? viewPosition(vUv + ey, zu) - p
    : p - viewPosition(vUv - ey, zd);
  vec3 n = normalize(cross(dpx, dpy));
  if (n.z < 0.0) n = -n;

  // World radius projected to screen, capped so a wall two metres from the eye
  // cannot ask for a quarter-screen gather.
  float radiusUv = min(uRadius * uProjScale / vz, 0.055);
  float rot = hash12(gl_FragCoord.xy) * 6.2831853;
  float r2 = uRadius * uRadius;

  float occ = 0.0;
  for (int i = 0; i < TAPS; i++) {
    float fi = (float(i) + 0.5) / float(TAPS);
    float ang = rot + float(i) * GOLDEN;
    float rad = radiusUv * sqrt(fi);
    vec2 suv = vUv + vec2(cos(ang) / uAspect, sin(ang)) * rad;
    float sd = texture2D(tDepth, suv).x;
    if (sd >= 0.99999) continue;

    vec3 v = viewPosition(suv, linearDepth(sd)) - p;
    float vv = dot(v, v);
    // Falls off to nothing at the radius, which is what stops the far-field
    // halo you get from an unbounded estimator.
    float fade = clamp(1.0 - vv / r2, 0.0, 1.0);
    occ += max(0.0, dot(n, v) - 0.0035 * vz) / (vv + 0.02) * fade;
  }

  float ao = max(0.0, 1.0 - occ * (2.0 * uIntensity / float(TAPS)));
  ao = pow(ao, 1.45);
  // Contact darkening is a *contact* effect; past a couple of blocks it is
  // sub-pixel and only adds noise, so retire it into the aerial perspective.
  ao = mix(ao, 1.0, smoothstep(85.0, 210.0, vz));
  gl_FragColor = vec4(ao, vz, 0.0, 1.0);
}
`;
}

/** 3x3 cross-bilateral blur that respects the depth carried in G. */
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
      vec2 s = texture2D(tAO, vUv + vec2(float(x), float(y)) * uTexel * 1.4).rg;
      // Depth similarity, relative to the centre distance - a 20 cm gap matters
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
// Bokeh (the DOF far field)
// ---------------------------------------------------------------------------

/**
 * Thirteen taps on a golden-angle disc at half resolution. A disc, not a
 * gaussian: out-of-focus highlights need to keep a round shape or the far field
 * reads as a smudge instead of a lens.
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
  for (int i = 0; i < TAPS; i++) {
    float fi = (float(i) + 0.5) / float(TAPS);
    float a = float(i) * GOLDEN;
    vec2 off = vec2(cos(a), sin(a)) * sqrt(fi) * uRadius * uTexel;
    acc += texture2D(tSrc, vUv + off).rgb;
  }
  gl_FragColor = vec4(acc / float(TAPS), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Light shafts
// ---------------------------------------------------------------------------

/**
 * The occlusion buffer: only pixels that are both *sky* (nothing wrote depth)
 * and *bright* survive. That is what makes the shafts stripe correctly between
 * towers and through the gaps in the cumulus deck — the geometry itself is the
 * occluder, for free.
 */
const RAY_MASK_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform sampler2D tDepth;
uniform float uThreshold;
${LUMA_CHUNK}

void main() {
  float sky = step(0.99999, texture2D(tDepth, vUv).x);
  vec3 c = texture2D(tSrc, vUv).rgb;
  float w = smoothstep(uThreshold, uThreshold * 3.0, luma(c));
  gl_FragColor = vec4(min(c, vec3(24.0)) * w * sky, 1.0);
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

#define SAMPLES ${Math.max(4, Math.round(samples))}

void main() {
  vec2 delta = (vUv - uSunUv) * (uDensity / float(SAMPLES));
  vec2 uv = vUv;
  float illum = 1.0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < SAMPLES; i++) {
    uv -= delta;
    // Taps that walk off screen must contribute nothing, or clamp-to-edge
    // smears the border pixel into a false shaft.
    vec2 inb = step(vec2(0.0), uv) * step(uv, vec2(1.0));
    acc += texture2D(tSrc, uv).rgb * illum * inb.x * inb.y;
    illum *= uDecay;
  }
  gl_FragColor = vec4(acc / float(SAMPLES), 1.0);
}
`;
}

// ---------------------------------------------------------------------------
// Composite — distortion, lens, tonemap, grade
// ---------------------------------------------------------------------------

interface CompositeFlags {
  depth: boolean;
  bloom: boolean;
  ao: boolean;
  dof: boolean;
  mbTaps: number;
  rays: boolean;
  chromatic: boolean;
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
uniform vec2  uResolution;
uniform float uAspect;
uniform float uTime;

uniform float uBloom;
uniform float uAO;
uniform float uRays;
uniform vec3  uRayTint;
uniform vec4  uDof;        // focus, range, far start, far strength
uniform float uAds;
uniform float uMotion;
uniform mat4  uInvViewProj;
uniform mat4  uPrevViewProj;
uniform vec4  uDistort[${DISTORT_SLOTS}];
uniform float uWater;
uniform float uHurt;
uniform float uShake;
uniform float uChromatic;

// --- grade ---------------------------------------------------------------
uniform float uExposure;
uniform vec3  uFilter;
uniform float uContrast;
uniform float uScurve;
uniform float uOffset;
uniform vec3  uLift;
uniform vec3  uShadowTint;
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
${f.mbTaps > 0 ? `#define USE_MB\n#define MB_TAPS ${Math.round(f.mbTaps)}` : "// no USE_MB"}

${LUMA_CHUNK}
${HASH_CHUNK}
#ifdef USE_DEPTH
${DEPTH_CHUNK}
#endif

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

/** The film grade. Display-referred linear in, display-referred linear out. */
vec3 grade(vec3 c) {
  // Contrast about a pivot below mid-grey - the shadows move more than the
  // highlights, which is what a print curve does.
  c = (c - PIVOT) * uContrast + PIVOT + uOffset;
  c = clamp(c, 0.0, 1.0);
  // ...then a real S on top of the straight line, for the toe and the shoulder.
  c = mix(c, c * c * (3.0 - 2.0 * c), uScurve);

  // Split tone: teal in the low end, warm in the high end.
  c *= mix(uShadowTint, uHighTint, smoothstep(0.0, 0.78, luma(c)));

  // Lift after contrast, or the contrast would just crush it away again.
  c = uLift + c * (1.0 - uLift);

  // Vibrance protects the turquoise shallows from going radioactive while
  // still pulling colour out of the stucco and the hills.
  float l = luma(c);
  float chroma = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
  float sat = uSaturation + uVibrance * (1.0 - smoothstep(0.0, 0.5, chroma));
  c = mix(vec3(l), c, sat);

  // Highlight bleach: the top of the range walks to paper white, not to its
  // own hue clipped. Sells hot tropical sun on white stucco.
  c = mix(c, vec3(1.0), smoothstep(0.86, 1.02, luma(c)) * uBleach);
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;

  // ---- screen-space refraction -------------------------------------------
  // Explosion heat haze, driven by "palmas:distort". Each source is a radial
  // ripple whose amplitude decays with age and with distance from its centre.
  for (int i = 0; i < ${DISTORT_SLOTS}; i++) {
    vec4 s = uDistort[i];
    if (s.w <= 0.0) continue;
    vec2 d = (uv - s.xy) * vec2(uAspect, 1.0);
    float r = length(d) + 1e-5;
    float k = 1.0 - smoothstep(0.0, max(s.z, 1e-4), r);
    if (k <= 0.0) continue;
    float wave = sin(r * 52.0 - uTime * 11.0) + 0.5 * sin(r * 121.0 - uTime * 17.0);
    uv += (d / r) * wave * k * k * s.w * 0.018 / vec2(uAspect, 1.0);
  }
  // Underwater: the whole frame breathes.
  uv += vec2(sin(uv.y * 21.0 + uTime * 1.7), cos(uv.x * 17.0 + uTime * 1.3)) * 0.0035 * uWater;
  uv = clamp(uv, vec2(0.0005), vec2(0.9995));

  // ---- lens dispersion ----------------------------------------------------
  vec2 cc = uv - 0.5;
  float rr = dot(cc, cc);
  vec3 color;
#ifdef USE_CA
  // Zero at the optical centre, quadratic to the corners - that is how a real
  // lens misbehaves, and it keeps the crosshair perfectly clean.
  float ca = uChromatic * rr * (1.0 + uWater * 2.0 + uHurt * 2.5 + uShake * 1.5);
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

  // ---- camera motion blur -------------------------------------------------
#ifdef USE_MB
  {
    vec4 wp = uInvViewProj * vec4(uv * 2.0 - 1.0, rawZ * 2.0 - 1.0, 1.0);
    wp /= wp.w;
    vec4 pp = uPrevViewProj * wp;
    vec2 vel = (uv - (pp.xy / pp.w * 0.5 + 0.5)) * uMotion;
    // Never smear the viewmodel: it is rigidly attached to the camera, so its
    // reprojected velocity is a lie. Anything inside arm's reach holds still.
    vel *= smoothstep(0.55, 3.0, vz);
    float len = length(vel);
    if (len > 0.0012) {
      vel *= min(1.0, 0.05 / len);
      vec3 acc = color;
      for (int i = 1; i <= MB_TAPS; i++) {
        float t = float(i) / float(MB_TAPS + 1) - 0.5;
        acc += texture2D(tScene, clamp(uv + vel * t, vec2(0.001), vec2(0.999))).rgb;
      }
      color = acc / float(MB_TAPS + 1);
    }
  }
#endif

  // ---- depth of field -----------------------------------------------------
#ifdef USE_DOF
  {
    // Always-on far field, so the horizon sits behind glass rather than being
    // stencilled onto it...
    float coc = smoothstep(uDof.z, uDof.z * 3.2, vz) * uDof.w;
    // ...plus a focus pull that only exists while aiming down sights.
    float pull = smoothstep(0.25, 1.0, abs(vz - uDof.x) / max(uDof.y, 0.5));
    coc = max(coc, pull * uAds * 0.85);
    color = mix(color, texture2D(tBokeh, uv).rgb, clamp(coc * coc, 0.0, 0.85));
  }
#endif

  // ---- ambient occlusion --------------------------------------------------
#ifdef USE_AO
  {
    float ao = texture2D(tAO, uv).r;
    // Occlusion belongs to the ambient term. Letting it multiply the sunlit
    // range too is what makes over-cooked AO look like dirt in the corners.
    ao = mix(ao, 1.0, clamp(luma(color) * 0.7, 0.0, 0.8));
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
  if (uWater > 0.0) {
#ifdef USE_DEPTH
    float t = 1.0 - exp(-min(vz, 400.0) * 0.02);
#else
    float t = 0.45;
#endif
    color = mix(color, vec3(0.028, 0.115, 0.135) * (0.4 + 0.9 * luma(color)), t * uWater * 0.85);
  }

  // ---- exposure, tone curve, grade ----------------------------------------
  color *= uExposure * uFilter;
  color = acesFilmic(color);
  color = grade(color);

  // ---- lens character -----------------------------------------------------
  // Deliberately *not* aspect-corrected: the falloff follows the frame, so it
  // reads as a lens and not as a circle painted over a widescreen image.
  float rad = length(vUv - 0.5) * 1.4142;
  float vig = 1.0 - uVignette * pow(smoothstep(0.45, 1.06, rad), 1.8);
  color *= vig;
  // Taking a hit pulls the blood into the corners.
  color = mix(color, color * vec3(1.35, 0.3, 0.26), uHurt * (1.0 - vig) * 2.2);

  color = linearToSRGB(color);

  // Fine grain, heaviest in the shadows where film actually shows it. Doubles
  // as the dither that keeps the sky gradient off the banding stairs.
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
    console.warn("[San Palmas] post-processing disabled, forward path retained:", err);
    try {
      ctx.emit("palmas:postfx", null);
    } catch {
      /* the engine may not be listening yet; nothing to do. */
    }
    return { name: "postfx" };
  }
};

function buildPostFx(ctx: WorldCtx): System {
  const tier = TIERS[ctx.quality] ?? TIERS.high;
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

  // The scene target is double-buffered when we publish depth for soft
  // particles: the particle shader samples *last* frame's depth, so it can
  // never be reading the attachment it is currently rendering into.
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

  const aoRT = tier.aoTaps > 0 ? colorRT(halfW(), halfH()) : null;
  const aoBlurRT = tier.aoTaps > 0 ? colorRT(halfW(), halfH()) : null;
  const bokehRT = tier.dof ? colorRT(halfW(), halfH()) : null;
  const rayMaskRT = tier.raySamples > 0 ? colorRT(width >> 2, height >> 2) : null;
  const rayRT = tier.raySamples > 0 ? colorRT(width >> 2, height >> 2) : null;

  const bloomRTs: THREE.WebGLRenderTarget[] = [];
  for (let i = 0; i < tier.bloomMips; i++) {
    bloomRTs.push(colorRT(Math.max(1, width >> (i + 1)), Math.max(1, height >> (i + 1))));
  }

  // The graded frame, in display space, waiting for SMAA. Eight bits is exactly
  // right here — anything wider is wasted on a signal that is already encoded.
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
        toneMapped: false,
      }),
    );

  const planes = new THREE.Vector2(camera.near, camera.far);
  const uvToView = new THREE.Vector2(1, 1);

  const aoMat = tier.aoTaps
    ? mat(buildAoFragment(tier.aoTaps), {
        tDepth: { value: null },
        uPlanes: { value: planes },
        uUvToView: { value: uvToView },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: AO_RADIUS },
        uProjScale: { value: 1 },
        uAspect: { value: 1 },
        uIntensity: { value: 1.05 },
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
        uThreshold: { value: 1.4 },
      })
    : null;

  const rayMat = tier.raySamples
    ? mat(buildRayFragment(tier.raySamples), {
        tSrc: { value: null },
        uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
        uDensity: { value: 0.72 },
        uDecay: { value: 0.955 },
      })
    : null;

  const distortSlots: THREE.Vector4[] = [];
  for (let i = 0; i < DISTORT_SLOTS; i++) distortSlots.push(new THREE.Vector4(0, 0, 0, 0));

  const compositeMat = mat(
    buildCompositeFragment({
      depth: tier.depth,
      bloom: tier.bloomMips > 0,
      ao: tier.aoTaps > 0,
      dof: tier.dof,
      mbTaps: tier.mbTaps,
      rays: tier.raySamples > 0,
      chromatic: tier.chromatic,
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
      uResolution: { value: new THREE.Vector2() },
      uAspect: { value: 1 },
      uTime: { value: 0 },
      uBloom: { value: BLOOM_STRENGTH[ctx.quality] ?? 0 },
      uAO: { value: AO_STRENGTH[ctx.quality] ?? 0 },
      uRays: { value: 0 },
      uRayTint: { value: new THREE.Color(1, 0.86, 0.66) },
      uDof: { value: new THREE.Vector4(60, 22, DOF_FAR_START, DOF_FAR_STRENGTH) },
      uAds: { value: 0 },
      uMotion: { value: 0 },
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uDistort: { value: distortSlots },
      uWater: { value: 0 },
      uHurt: { value: 0 },
      uShake: { value: 0 },
      uChromatic: { value: tier.chromatic ? CHROMATIC : 0 },
      uExposure: { value: 1 },
      uFilter: { value: new THREE.Vector3(1, 1, 1) },
      uContrast: { value: GRADE_DAY.contrast },
      uScurve: { value: GRADE_DAY.scurve },
      uOffset: { value: GRADE_DAY.offset },
      uLift: { value: new THREE.Vector3() },
      uShadowTint: { value: new THREE.Vector3(1, 1, 1) },
      uHighTint: { value: new THREE.Vector3(1, 1, 1) },
      uSaturation: { value: GRADE_DAY.saturation },
      uVibrance: { value: GRADE_DAY.vibrance },
      uBleach: { value: GRADE_DAY.bleach },
      uVignette: { value: GRADE_DAY.vignette },
      uGrain: { value: GRADE_DAY.grain },
    },
  );

  // A real 1x1 black texture for every optional sampler. Binding an unbacked
  // render-target texture (the shafts, before the first frame that has any)
  // gives an incomplete sampler and a console full of driver warnings.
  const blackTex = track(
    new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat),
  );
  blackTex.needsUpdate = true;
  for (const key of ["tBloom", "tAO", "tBokeh", "tRays"]) {
    compositeMat.uniforms[key].value = blackTex;
  }

  const quad = new FullScreenQuad(compositeMat);

  // SMAA is optional in the way nothing else is: it decodes two embedded PNGs
  // through `Image`, which does not exist in a headless harness. Losing it
  // costs us edge quality, not the frame.
  let smaa: SMAAPass | null = null;
  try {
    smaa = new SMAAPass(width, height);
    smaa.renderToScreen = true;
  } catch (err) {
    console.warn("[San Palmas] SMAA unavailable:", err);
    smaa = null;
  }

  // ---- Live state ----------------------------------------------------------
  const grade = cloneGrade(GRADE_DAY);
  const gradeBase = cloneGrade(GRADE_DAY);

  /** 0..1 lerp toward the underwater grade, driven by "palmas:submerged". */
  let waterTarget = 0;
  let water = 0;
  /** Aim-down-sights blend, from "palmas:crosshair". */
  let ads = 0;
  /** Decaying hit feedback, from "palmas:damage". */
  let hurt = 0;
  /** Decaying trauma, borrowed from vfx purely for lens character. */
  let shake = 0;
  let focus = 60;
  let focusTimer = 0;
  let broken = false;
  let elapsed = 0;

  const distortSources = Array.from({ length: DISTORT_SLOTS }, () => ({
    point: new THREE.Vector3(),
    radius: 10,
    strength: 0,
    age: 0,
    ttl: 0,
  }));

  const viewProj = new THREE.Matrix4();
  const prevViewProj = new THREE.Matrix4();
  const invViewProj = new THREE.Matrix4();
  let hasPrev = false;

  const tmpVec = new THREE.Vector3();
  const camForward = new THREE.Vector3();
  const rayDir = new THREE.Vector3();
  const sunUv = new THREE.Vector2(0.5, 0.5);

  // ---- Events --------------------------------------------------------------
  const offSubmerged = ctx.on("palmas:submerged", (p) => {
    waterTarget = p ? 1 : 0;
  });

  const offCrosshair = ctx.on("palmas:crosshair", (p) => {
    const v = (p as { ads?: number })?.ads;
    if (typeof v === "number" && Number.isFinite(v)) ads = THREE.MathUtils.clamp(v, 0, 1);
  });

  const offDamage = ctx.on("palmas:damage", (p) => {
    const amount = (p as { amount?: number })?.amount ?? 0;
    hurt = Math.min(1, hurt + THREE.MathUtils.clamp(amount / 45, 0.12, 0.7));
  });

  const offShake = ctx.on("palmas:shake", (p) => {
    const amount = typeof p === "number" ? p : ((p as { amount?: number })?.amount ?? 0);
    shake = Math.min(1, shake + Math.max(0, amount));
  });

  const offDistort = ctx.on("palmas:distort", (p) => {
    const d = p as { point?: unknown; radius?: number; strength?: number; duration?: number };
    if (!d) return;
    const pt = d.point;
    let x = 0;
    let y = 0;
    let z = 0;
    if (Array.isArray(pt) && pt.length >= 3) {
      x = Number(pt[0]);
      y = Number(pt[1]);
      z = Number(pt[2]);
    } else if (pt && typeof pt === "object" && "x" in (pt as THREE.Vector3)) {
      const v = pt as THREE.Vector3;
      x = v.x;
      y = v.y;
      z = v.z;
    } else {
      return;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

    // Recycle the weakest slot, so a big new blast always beats a dying one.
    let slot = distortSources[0];
    for (const s of distortSources) {
      const life = s.ttl > 0 ? 1 - s.age / s.ttl : 0;
      const best = slot.ttl > 0 ? 1 - slot.age / slot.ttl : 0;
      if (life * s.strength < best * slot.strength) slot = s;
    }
    slot.point.set(x, y, z);
    slot.radius = Math.max(1, d.radius ?? 12);
    slot.strength = THREE.MathUtils.clamp(d.strength ?? 0.4, 0, 1);
    slot.ttl = Math.max(0.05, d.duration ?? 0.45);
    slot.age = 0;
  });

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
    // Everything below (and the two screen-space projections that follow it)
    // wants this frame's camera, not the one the last render left behind.
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const aspect = width / height;
    planes.set(camera.near, camera.far);
    uvToView.set(tanHalf * camera.aspect, tanHalf);

    if (aoMat) {
      aoMat.uniforms.uProjScale.value = 0.5 / Math.max(tanHalf, 1e-4);
      aoMat.uniforms.uAspect.value = aspect;
    }
    compositeMat.uniforms.uAspect.value = aspect;
    (compositeMat.uniforms.uResolution.value as THREE.Vector2).set(width, height);
    setTexel(compositeMat, width, height);
  }

  /** Blends the three reference grades into the live uniform set. */
  function updateGrade(dt: number): void {
    const daylight = ctx.services.sky?.daylight ?? 1;
    mixGrade(GRADE_DAY, GRADE_NIGHT, 1 - THREE.MathUtils.clamp(daylight, 0, 1), gradeBase);
    mixGrade(gradeBase, GRADE_WATER, water, grade);

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
    (u.uHighTint.value as THREE.Vector3).set(
      grade.highTint[0], grade.highTint[1], grade.highTint[2]);
    u.uSaturation.value = grade.saturation;
    u.uVibrance.value = grade.vibrance;
    u.uBleach.value = grade.bleach;
    // Getting hit closes the iris down; so does aiming, slightly.
    u.uVignette.value = grade.vignette + hurt * 0.35 + ads * 0.08;
    u.uGrain.value = grade.grain * (1 + hurt * 1.5);
    u.uWater.value = water;
    u.uHurt.value = hurt;
    u.uShake.value = shake;
    u.uAds.value = ads;
    u.uTime.value = elapsed;

    // Shutter-correct motion blur: the per-frame reprojection vector is scaled
    // back to a fixed exposure time, so the smear length is the same at 30 fps
    // as at 144 and never becomes a framerate tell.
    u.uMotion.value = tier.mbTaps
      ? MOTION_STRENGTH * Math.min(2.5, MOTION_SHUTTER / Math.max(dt, 1e-4))
      : 0;
  }

  /** Focus distance for the ADS pull: what is actually under the crosshair. */
  function updateFocus(dt: number): void {
    if (!tier.dof) return;
    focusTimer -= dt;
    let target = focus;
    if (ads > 0.02) {
      if (focusTimer <= 0) {
        focusTimer = 0.08;
        camera.getWorldDirection(rayDir);
        let hit: { distance: number } | null = null;
        try {
          hit = ctx.services.collision?.raycast(camera.position, rayDir, 400) ?? null;
        } catch {
          hit = null;
        }
        target = hit ? THREE.MathUtils.clamp(hit.distance, 1.5, 400) : 220;
      }
    } else {
      target = 60;
    }
    // A real focus puller takes about a third of a second.
    focus += (target - focus) * Math.min(1, dt * 7);
    (compositeMat.uniforms.uDof.value as THREE.Vector4).set(
      focus,
      Math.max(4, focus * 0.32),
      DOF_FAR_START,
      DOF_FAR_STRENGTH,
    );
  }

  /** Projects each live heat-haze source into screen space. */
  function updateDistortion(dt: number): void {
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    for (let i = 0; i < DISTORT_SLOTS; i++) {
      const s = distortSources[i];
      const slot = distortSlots[i];
      if (s.ttl <= 0) {
        slot.set(0, 0, 0, 0);
        continue;
      }
      s.age += dt;
      if (s.age >= s.ttl) {
        s.ttl = 0;
        slot.set(0, 0, 0, 0);
        continue;
      }
      tmpVec.copy(s.point);
      const dist = tmpVec.distanceTo(camera.position);
      tmpVec.project(camera);
      // Behind the camera, or so far away the shockwave is a single pixel.
      if (tmpVec.z > 1 || dist < 0.2 || dist > 400) {
        slot.set(0, 0, 0, 0);
        continue;
      }
      // Angular radius of the sphere, converted into uv-height units.
      const radiusUv = s.radius / (2 * dist * Math.max(tanHalf, 1e-4));
      const life = 1 - s.age / s.ttl;
      slot.set(
        tmpVec.x * 0.5 + 0.5,
        tmpVec.y * 0.5 + 0.5,
        Math.min(radiusUv, 1.2),
        s.strength * life * life,
      );
    }
  }

  /** Where the sun lands on screen, and how much of a shaft it earns. */
  function updateShafts(): number {
    if (!rayMat || !rayMaskMat) return 0;
    const sky = ctx.services.sky;
    if (!sky) return 0;

    camera.getWorldDirection(camForward);
    const facing = camForward.dot(sky.sunDirection);
    if (facing <= 0.02) return 0;

    tmpVec.copy(camera.position).addScaledVector(sky.sunDirection, 6000).project(camera);
    if (tmpVec.z > 1) return 0;
    sunUv.set(tmpVec.x * 0.5 + 0.5, tmpVec.y * 0.5 + 0.5);
    (rayMat.uniforms.uSunUv.value as THREE.Vector2).copy(sunUv);

    // Fade with: the sun leaving frame, the sun leaving the sky, and looking
    // away from it. Shafts that pop in and out at the frame edge read as a bug.
    const edge = Math.max(Math.abs(tmpVec.x), Math.abs(tmpVec.y));
    const offscreen = 1 - THREE.MathUtils.smoothstep(edge, 0.85, 1.6);
    const altitude = THREE.MathUtils.smoothstep(sky.sunDirection.y, -0.02, 0.16);
    const aim = THREE.MathUtils.smoothstep(facing, 0.05, 0.45);
    const amount = offscreen * altitude * aim;
    if (amount > 0) {
      (compositeMat.uniforms.uRayTint.value as THREE.Color).copy(sky.sunColor);
    }
    return amount * (RAY_STRENGTH[ctx.quality] ?? 0);
  }

  // ---- The frame -----------------------------------------------------------
  // `renderer.info` resets itself on every `render()` call, and a composer makes
  // a dozen of those a frame. Take ownership so the counters stay honest.
  const hadAutoReset = renderer.info.autoReset;
  renderer.info.autoReset = false;

  function renderFrame(dt: number): void {
    if (broken) return;
    const clampedDt = Math.min(Math.max(dt, 1e-4), 0.2);
    elapsed += clampedDt;

    const oldAutoClear = renderer.autoClear;
    try {
      renderer.info.reset();

      // ---- per-frame state --------------------------------------------------
      water += (waterTarget - water) * Math.min(1, clampedDt * 6);
      hurt = Math.max(0, hurt - clampedDt * 1.35);
      shake = Math.max(0, shake - clampedDt * 1.8);
      updateCameraUniforms();
      updateDistortion(clampedDt);
      updateFocus(clampedDt);
      updateGrade(clampedDt);

      // ---- scene ------------------------------------------------------------
      // Flip first, then publish the *other* buffer's depth: the particle
      // shaders about to run sample last frame's depth, never the attachment
      // they are drawing into.
      const prevScene = sceneRTs[sceneIndex];
      sceneIndex = (sceneIndex + 1) % sceneRTs.length;
      const sceneRT = sceneRTs[sceneIndex];
      if (tier.softDepth && prevScene !== sceneRT && prevScene.depthTexture) {
        ctx.emit("palmas:depth", prevScene.depthTexture);
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
        setTexel(aoMat, aoRT.width, aoRT.height);
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
        // Upsample back down the pyramid, accumulating additively — a wide,
        // soft, energy-preserving glow instead of a single fat gaussian.
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
      if (bokehMat && bokehRT) {
        bokehMat.uniforms.tSrc.value = sceneTex;
        setTexel(bokehMat, bokehRT.width, bokehRT.height);
        draw(bokehMat, bokehRT);
        compositeMat.uniforms.tBokeh.value = bokehRT.texture;
      }

      // ---- light shafts -----------------------------------------------------
      let rayAmount = 0;
      if (rayMat && rayMaskMat && rayRT && rayMaskRT && depthTex) {
        rayAmount = updateShafts();
        if (rayAmount > 0.001) {
          rayMaskMat.uniforms.tSrc.value = sceneTex;
          rayMaskMat.uniforms.tDepth.value = depthTex;
          draw(rayMaskMat, rayMaskRT);

          rayMat.uniforms.tSrc.value = rayMaskRT.texture;
          draw(rayMat, rayRT);
          compositeMat.uniforms.tRays.value = rayRT.texture;
        }
      }
      compositeMat.uniforms.uRays.value = rayAmount;

      // ---- composite + AA ---------------------------------------------------
      compositeMat.uniforms.tScene.value = sceneTex;
      compositeMat.uniforms.tDepth.value = depthTex;

      if (smaa) {
        draw(compositeMat, ldrRT);
        smaa.render(
          renderer,
          null as unknown as THREE.WebGLRenderTarget,
          ldrRT,
          clampedDt,
          false,
        );
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
      console.warn("[San Palmas] post-processing failed mid-frame, reverting:", err);
      try {
        ctx.emit("palmas:depth", null);
        ctx.emit("palmas:postfx", null);
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
      // RenderTarget.setSize does not carry the depth attachment with it.
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
    rayMaskRT?.setSize(Math.max(1, width >> 2), Math.max(1, height >> 2));
    rayRT?.setSize(Math.max(1, width >> 2), Math.max(1, height >> 2));
    for (let i = 0; i < bloomRTs.length; i++) {
      bloomRTs[i].setSize(Math.max(1, width >> (i + 1)), Math.max(1, height >> (i + 1)));
    }
    smaa?.setSize(width, height);
    updateCameraUniforms();
    hasPrev = false;
  }

  updateCameraUniforms();
  ctx.emit("palmas:postfx", renderFrame);

  const sys: System = {
    name: "postfx",

    resize() {
      if (broken) return;
      try {
        resize();
      } catch (err) {
        console.warn("[San Palmas] post-processing resize failed:", err);
        broken = true;
        ctx.emit("palmas:postfx", null);
      }
    },

    dispose() {
      offSubmerged();
      offCrosshair();
      offDamage();
      offShake();
      offDistort();
      try {
        ctx.emit("palmas:depth", null);
        ctx.emit("palmas:postfx", null);
      } catch {
        /* the engine may already be gone. */
      }
      renderer.info.autoReset = hadAutoReset;
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
