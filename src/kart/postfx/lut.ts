/**
 * The colour grade, baked into a 3D lookup table.
 *
 * The maths below — lift / gamma / gain, a filmic contrast pivot, vibrance and
 * a split tone — is cheap enough to run per pixel, but baking it into a LUT is
 * strictly better: the shader cost collapses to two bilinear fetches whatever
 * the grade does, and it makes the look a *single artefact* that can be dumped,
 * diffed or swapped, rather than eleven uniforms scattered through a 400-line
 * composite shader.
 *
 * The look, stated plainly: sunny, saturated, high-contrast, and clean. Blacks
 * are lifted a hair toward cool blue so shadows read as sky-lit rather than as
 * holes; highlights roll off warm and are *never* allowed to reach flat 1.0, so
 * the sky keeps its gradient and white kerbs keep their shading. This is the
 * opposite of the crushed, teal-and-orange look — a Nintendo track at noon has
 * no crushed blacks anywhere in it.
 *
 * Layout is the standard horizontal strip: `size` slices of `size × size`, laid
 * left to right along blue. 32³ in a 1024×32 RGBA8 texture, 128 KB, built once.
 */
import * as THREE from "three";

export const LUT_SIZE = 32;

export interface GradeParams {
  /** Multiplied into shadows; the black point never goes below this. */
  lift: [number, number, number];
  /** Per-channel mid-tone power. <1 brightens. */
  gamma: [number, number, number];
  /** Per-channel white-point scale. */
  gain: [number, number, number];
  /** S-curve strength about the pivot, 0 = linear. */
  contrast: number;
  /** Tone pivot in display space — where the S-curve crosses unchanged. */
  pivot: number;
  /** Global saturation multiplier. */
  saturation: number;
  /** Extra saturation for already-dull colours only (protects skin and sky). */
  vibrance: number;
  /** Tint pushed into the shadows. */
  shadowTint: [number, number, number];
  /** Tint pushed into the highlights. */
  highlightTint: [number, number, number];
  /** How hard the split tone bites, 0..1. */
  splitStrength: number;
  /** Ceiling the grade rolls off toward, so nothing lands on flat white. */
  whiteCeiling: number;
}

/**
 * The shipping grade.
 *
 * Every number here was chosen against a bright track at golden hour: a warm
 * key, saturated primaries on the karts, a big blue sky, and white kerb paint
 * that must stay readable as *paint* rather than blowing to paper.
 */
export const KART_GRADE: GradeParams = {
  lift: [0.012, 0.014, 0.022],
  gamma: [0.98, 0.985, 1.0],
  gain: [1.045, 1.015, 0.975],
  contrast: 0.2,
  pivot: 0.44,
  saturation: 1.16,
  vibrance: 0.22,
  shadowTint: [0.86, 0.95, 1.1],
  highlightTint: [1.05, 1.0, 0.93],
  splitStrength: 0.16,
  whiteCeiling: 0.985,
};

/** A neutral identity grade — the "grade off" state, still a valid LUT. */
export const NEUTRAL_GRADE: GradeParams = {
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  contrast: 0,
  pivot: 0.44,
  saturation: 1,
  vibrance: 0,
  shadowTint: [1, 1, 1],
  highlightTint: [1, 1, 1],
  splitStrength: 0,
  whiteCeiling: 1,
};

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/**
 * Apply the grade to one display-space RGB triple, in place.
 *
 * Order matters and mirrors a colourist's: exposure-ish moves (lift/gamma/gain)
 * first because they are per-channel and want the raw signal; then contrast,
 * which is a shape change and must see the corrected channels; then chroma;
 * then the split tone, which is decoration on top of a finished tone curve.
 */
function gradePixel(rgb: [number, number, number], p: GradeParams): void {
  for (let c = 0; c < 3; c++) {
    const x = rgb[c];
    // Lift/gamma/gain in the ASC-CDL sense: slope, offset, power.
    const lifted = p.lift[c] + x * (1 - p.lift[c]);
    const gained = lifted * p.gain[c];
    rgb[c] = Math.pow(Math.max(gained, 0), p.gamma[c]);
  }

  // Filmic S about the pivot. A plain `pow` contrast pulls the whole image
  // dark; pivoting keeps the exposure where the DP put it and only steepens.
  if (p.contrast !== 0) {
    for (let c = 0; c < 3; c++) {
      const x = rgb[c];
      const d = x - p.pivot;
      // A smoothstep-weighted push: strongest at the pivot, tapering to nothing
      // at both ends, which is what stops it from crushing black or clipping.
      const taper = 1 - Math.abs(d) / Math.max(p.pivot, 1 - p.pivot);
      rgb[c] = x + d * p.contrast * Math.max(taper, 0);
    }
  }

  const luma = rgb[0] * LUMA_R + rgb[1] * LUMA_G + rgb[2] * LUMA_B;

  if (p.saturation !== 1) {
    for (let c = 0; c < 3; c++) rgb[c] = luma + (rgb[c] - luma) * p.saturation;
  }

  // Vibrance: saturate only what is not already saturated. Without it, pushing
  // enough saturation to make the grass and the sky sing turns every red shell
  // into a flat clipped blob.
  if (p.vibrance !== 0) {
    const maxC = Math.max(rgb[0], rgb[1], rgb[2]);
    const minC = Math.min(rgb[0], rgb[1], rgb[2]);
    const sat = maxC - minC;
    const boost = 1 + p.vibrance * (1 - Math.min(sat * 1.6, 1));
    for (let c = 0; c < 3; c++) rgb[c] = luma + (rgb[c] - luma) * boost;
  }

  // Split tone. The weights are complementary and sum to 1, so a mid grey is
  // untouched and the tint only ever appears where the image is committed.
  if (p.splitStrength > 0) {
    const l = Math.min(Math.max(luma, 0), 1);
    const shadowW = Math.pow(1 - l, 2.2);
    const highW = Math.pow(l, 2.2);
    for (let c = 0; c < 3; c++) {
      const tint = 1 + (p.shadowTint[c] - 1) * shadowW + (p.highlightTint[c] - 1) * highW;
      rgb[c] *= 1 + (tint - 1) * p.splitStrength * 6;
    }
  }

  // Soft ceiling. `x / (1 + x/headroom)` is a Reinhard shoulder applied only in
  // the top stop: below ~0.8 it is a no-op, above it nothing ever reaches 1.0.
  const ceiling = p.whiteCeiling;
  for (let c = 0; c < 3; c++) {
    const x = Math.max(rgb[c], 0);
    if (x <= 0.8) {
      rgb[c] = Math.min(x, ceiling);
      continue;
    }
    const over = x - 0.8;
    const head = Math.max(ceiling - 0.8, 1e-3);
    rgb[c] = 0.8 + head * (over / (over + head));
  }
}

/**
 * A bakeable LUT. Rebuilt only when the grade actually changes — a time-of-day
 * shift, a tunnel, the results screen — which is a handful of times a race.
 */
export class GradeLut {
  readonly texture: THREE.DataTexture;
  readonly size = LUT_SIZE;
  private readonly data: Uint8Array;

  constructor(params: GradeParams = KART_GRADE) {
    const size = LUT_SIZE;
    this.data = new Uint8Array(size * size * size * 4);
    this.texture = new THREE.DataTexture(this.data, size * size, size);
    this.texture.name = "KartGradeLut";
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    // The LUT stores display-space bytes and is sampled as raw data. Tagging it
    // sRGB would make three decode it on fetch and the grade would be applied
    // to a linearised copy of a display-space signal: a double conversion, and
    // exactly the bug this comment exists to prevent.
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.generateMipmaps = false;
    this.bake(params);
  }

  bake(params: GradeParams): void {
    const size = this.size;
    const inv = 1 / (size - 1);
    const rgb: [number, number, number] = [0, 0, 0];
    let i = 0;
    // Row-major over the strip: y is green, x walks blue-slice then red.
    for (let g = 0; g < size; g++) {
      for (let b = 0; b < size; b++) {
        for (let r = 0; r < size; r++) {
          rgb[0] = r * inv;
          rgb[1] = g * inv;
          rgb[2] = b * inv;
          gradePixel(rgb, params);
          i = (g * size * size + b * size + r) * 4;
          this.data[i + 0] = Math.round(Math.min(Math.max(rgb[0], 0), 1) * 255);
          this.data[i + 1] = Math.round(Math.min(Math.max(rgb[1], 0), 1) * 255);
          this.data[i + 2] = Math.round(Math.min(Math.max(rgb[2], 0), 1) * 255);
          this.data[i + 3] = 255;
        }
      }
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/**
 * The GLSL side of the lookup.
 *
 * Two bilinear fetches bracketing the input's blue value, blended manually.
 * The half-texel insets are not optional: without them the outermost red and
 * green samples bleed in from the neighbouring blue slice, and pure red comes
 * back slightly magenta.
 */
export const PF_LUT = /* glsl */ `
uniform sampler2D tLut;
uniform float uLutSize;
uniform float uLutAmount;

vec3 pfSampleLut(const in vec3 c) {
  vec3 col = clamp(c, 0.0, 1.0);
  float sz = uLutSize;
  float slice = col.b * (sz - 1.0);
  float s0 = floor(slice);
  float s1 = min(s0 + 1.0, sz - 1.0);
  float f = slice - s0;

  float x = col.r * (sz - 1.0) + 0.5;
  float y = (col.g * (sz - 1.0) + 0.5) / sz;
  float invStrip = 1.0 / (sz * sz);

  vec3 a = texture2D(tLut, vec2((s0 * sz + x) * invStrip, y)).rgb;
  vec3 b = texture2D(tLut, vec2((s1 * sz + x) * invStrip, y)).rgb;
  return mix(a, b, f);
}

vec3 pfGrade(const in vec3 display) {
  return mix(display, pfSampleLut(display), uLutAmount);
}
`;
