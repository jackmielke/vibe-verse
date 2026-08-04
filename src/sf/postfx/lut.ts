/**
 * Filmic colour grading — three authored looks baked into 32³ lattices.
 *
 * A grade is not "tint the image blue". It is a per-colour mapping: what
 * happens to a skin tone, what happens to a sodium streetlight, where the
 * shadows go, how far the highlights are allowed to desaturate before they
 * clip. That is exactly what a 3D lookup table encodes, and evaluating it as a
 * table costs one texture fetch instead of a dozen instructions per pixel.
 *
 * Three looks, blended by time of day:
 *   day    — clean, slightly cool shadows, warm neutral highlights. SF at noon
 *            under a marine layer is a *cool* city; the sun is not Los Angeles.
 *   golden — the 18:00-19:40 window the whole game is art-directed around:
 *            orange key, magenta-lifted shadows, generous saturation.
 *   night  — sodium and LED street lighting against cyan shadow. Crushed
 *            blacks, desaturated mids, protected neon highlights.
 *
 * Output format: we sample a horizontal *strip* (1024×32) rather than a
 * `sampler3D`. The lattice really is 32³ — the strip is just how it is bound —
 * and a `Data3DTexture` of the same data is exported for callers that want it.
 * The reason is compatibility: `sampler3D` in a GLSL ES 1.00 shader is not
 * universally supported, and the failure mode is the entire screen going black
 * on somebody's machine, which is not a trade worth one texture lerp.
 */
import * as THREE from "three";
import { clamp01, mix, smoothstep } from "../math/rng";
import { sunDirection } from "../sky/Sky";

export const LUT_SIZE = 32;

export type LookName = "day" | "golden" | "night";

interface GradeSpec {
  /** RGB gains for white balance. */
  balance: [number, number, number];
  /** ASC-CDL slope / offset / power, per channel. */
  slope: [number, number, number];
  offset: [number, number, number];
  power: [number, number, number];
  /** Contrast around a pivot, applied in a log-ish space. */
  contrast: number;
  pivot: number;
  saturation: number;
  /** Split toning: colour pushed into shadows and highlights. */
  shadowTint: [number, number, number];
  shadowAmount: number;
  highlightTint: [number, number, number];
  highlightAmount: number;
  /** Extra toe (shadow crush) and shoulder (highlight rolloff). */
  toe: number;
  shoulder: number;
  /** Pull saturation out of the very brightest values, like film does. */
  highlightDesat: number;
}

const LOOKS: Record<LookName, GradeSpec> = {
  day: {
    balance: [0.992, 1.0, 1.020],
    slope: [1.0, 1.004, 1.010],
    offset: [-0.003, -0.001, 0.004],
    power: [1.012, 1.0, 0.992],
    contrast: 1.12,
    pivot: 0.435,
    saturation: 1.04,
    shadowTint: [0.42, 0.5, 0.72],
    shadowAmount: 0.1,
    highlightTint: [1.0, 0.96, 0.88],
    highlightAmount: 0.07,
    toe: 0.06,
    shoulder: 0.1,
    highlightDesat: 0.2,
  },
  golden: {
    balance: [1.048, 1.0, 0.932],
    slope: [1.04, 1.0, 0.958],
    offset: [0.006, 0.0, 0.012],
    power: [0.96, 1.0, 1.06],
    contrast: 1.16,
    pivot: 0.42,
    saturation: 1.16,
    shadowTint: [0.52, 0.4, 0.62],
    shadowAmount: 0.18,
    highlightTint: [1.0, 0.78, 0.5],
    highlightAmount: 0.2,
    toe: 0.09,
    shoulder: 0.16,
    highlightDesat: 0.3,
  },
  night: {
    balance: [0.952, 0.99, 1.072],
    slope: [0.962, 0.982, 1.038],
    offset: [-0.014, -0.01, 0.004],
    power: [1.09, 1.05, 0.96],
    contrast: 1.24,
    pivot: 0.33,
    saturation: 0.92,
    shadowTint: [0.22, 0.42, 0.6],
    shadowAmount: 0.24,
    highlightTint: [1.0, 0.62, 0.86],
    highlightAmount: 0.16,
    toe: 0.17,
    shoulder: 0.06,
    highlightDesat: 0.12,
  },
};

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

const LOG_A = 0.1;

/** Perceptual-ish log space; contrast pivots read far better here than in linear. */
const toLog = (v: number) => Math.log(Math.max(v, 0) + LOG_A) ;
const fromLog = (v: number) => Math.exp(v) - LOG_A;

function gradePixel(spec: GradeSpec, rgb: [number, number, number], out: Float32Array, o: number): void {
  let r = rgb[0] * spec.balance[0];
  let g = rgb[1] * spec.balance[1];
  let b = rgb[2] * spec.balance[2];

  // ASC CDL.
  r = Math.pow(Math.max(r * spec.slope[0] + spec.offset[0], 0), spec.power[0]);
  g = Math.pow(Math.max(g * spec.slope[1] + spec.offset[1], 0), spec.power[1]);
  b = Math.pow(Math.max(b * spec.slope[2] + spec.offset[2], 0), spec.power[2]);

  // Contrast around the pivot, in log space.
  const lp = toLog(spec.pivot);
  r = fromLog((toLog(r) - lp) * spec.contrast + lp);
  g = fromLog((toLog(g) - lp) * spec.contrast + lp);
  b = fromLog((toLog(b) - lp) * spec.contrast + lp);
  r = Math.max(r, 0);
  g = Math.max(g, 0);
  b = Math.max(b, 0);

  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

  // Split toning. Shadow weight peaks at black, highlight weight at white, and
  // they deliberately overlap in the mids so nothing gets a hard transition.
  const sw = Math.pow(1 - clamp01(luma), 2.2) * spec.shadowAmount;
  const hw = Math.pow(clamp01(luma), 2.0) * spec.highlightAmount;
  r = mix(r, spec.shadowTint[0] * luma + r * 0.35, sw);
  g = mix(g, spec.shadowTint[1] * luma + g * 0.35, sw);
  b = mix(b, spec.shadowTint[2] * luma + b * 0.35, sw);
  r = mix(r, spec.highlightTint[0] * (0.6 + 0.4 * luma), hw);
  g = mix(g, spec.highlightTint[1] * (0.6 + 0.4 * luma), hw);
  b = mix(b, spec.highlightTint[2] * (0.6 + 0.4 * luma), hw);

  // Saturation about the re-measured luma.
  const l2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r = l2 + (r - l2) * spec.saturation;
  g = l2 + (g - l2) * spec.saturation;
  b = l2 + (b - l2) * spec.saturation;

  // Film-like highlight desaturation: as a channel approaches clipping, pull it
  // toward white. Without this, a saturated neon sign clips to pure primary,
  // which is the single most "video game" thing an image can do.
  const hd = spec.highlightDesat * smoothstep(0.55, 1.05, l2);
  r = mix(r, mix(r, l2 * 0.35 + 0.65, 0.75), hd);
  g = mix(g, mix(g, l2 * 0.35 + 0.65, 0.75), hd);
  b = mix(b, mix(b, l2 * 0.35 + 0.65, 0.75), hd);

  // Toe + shoulder.
  //
  // The shoulder term deliberately vanishes at t = 1: a film shoulder
  // compresses the upper mids, it does not cap white at 0.92. Capping white is
  // how a sun disc ends up looking like a grey circle.
  const curve = (v: number) => {
    const t = clamp01(v);
    const toed = t * t * (3 - 2 * t) * spec.toe + t * (1 - spec.toe);
    return toed - spec.shoulder * toed * toed * (1 - toed);
  };
  out[o + 0] = clamp01(curve(r));
  out[o + 1] = clamp01(curve(g));
  out[o + 2] = clamp01(curve(b));
}

/** Build a 32³ lattice for a named look. Values are display-referred [0,1]. */
export function buildLookLattice(name: LookName, size = LUT_SIZE): Float32Array {
  const out = new Float32Array(size * size * size * 3);
  const inv = 1 / (size - 1);
  const rgb: [number, number, number] = [0, 0, 0];
  let o = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        rgb[0] = r * inv;
        rgb[1] = g * inv;
        rgb[2] = b * inv;
        gradePixel(LOOKS[name], rgb, out, o);
        o += 3;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Packing
 * ------------------------------------------------------------------ */

/**
 * A blendable LUT: three lattices in memory, one uploaded strip texture.
 *
 * Blending on the CPU and uploading 96 KB occasionally beats two 3D fetches per
 * pixel per frame, and it keeps the fragment shader to a single tap. The upload
 * is throttled — the grade only changes when the sun moves.
 */
export class BlendableLut {
  readonly size: number;
  readonly texture: THREE.DataTexture;
  /** The same lattice as a real 32³ volume, for callers that want sampler3D. */
  readonly volume: THREE.Data3DTexture;

  private readonly lattices: Record<LookName, Float32Array>;
  private readonly bytes: Uint8Array;
  private readonly volumeBytes: Uint8Array;
  private lastWeights: [number, number, number] = [-1, -1, -1];

  constructor(size = LUT_SIZE) {
    this.size = size;
    this.lattices = {
      day: buildLookLattice("day", size),
      golden: buildLookLattice("golden", size),
      night: buildLookLattice("night", size),
    };

    // Strip layout: slice b laid out left to right, so u = (r + b*size)/(size*size).
    this.bytes = new Uint8Array(size * size * size * 4);
    this.texture = new THREE.DataTexture(
      this.bytes as unknown as Uint8Array<ArrayBuffer>,
      size * size,
      size,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.name = "SfGradeLUT";

    this.volumeBytes = new Uint8Array(size * size * size * 4);
    this.volume = new THREE.Data3DTexture(this.volumeBytes as unknown as Uint8Array<ArrayBuffer>, size, size, size);
    this.volume.format = THREE.RGBAFormat;
    this.volume.type = THREE.UnsignedByteType;
    this.volume.minFilter = THREE.LinearFilter;
    this.volume.magFilter = THREE.LinearFilter;
    this.volume.wrapS = THREE.ClampToEdgeWrapping;
    this.volume.wrapT = THREE.ClampToEdgeWrapping;
    this.volume.wrapR = THREE.ClampToEdgeWrapping;
    this.volume.generateMipmaps = false;
    this.volume.name = "SfGradeLUT3D";

    this.setWeights(1, 0, 0, true);
  }

  /**
   * Re-bake the strip. Returns true if an upload actually happened — callers
   * can use that to avoid touching `needsUpdate` on a static frame.
   */
  setWeights(day: number, golden: number, night: number, force = false): boolean {
    const sum = day + golden + night || 1;
    const wd = day / sum;
    const wg = golden / sum;
    const wn = night / sum;
    const [pd, pg, pn] = this.lastWeights;
    // 1/128 is below the quantisation floor of an 8-bit LUT, so anything
    // smaller than that cannot change a single output byte.
    if (
      !force &&
      Math.abs(wd - pd) < 0.008 &&
      Math.abs(wg - pg) < 0.008 &&
      Math.abs(wn - pn) < 0.008
    ) {
      return false;
    }
    this.lastWeights = [wd, wg, wn];

    const size = this.size;
    const d = this.lattices.day;
    const g = this.lattices.golden;
    const n = this.lattices.night;
    const bytes = this.bytes;
    const vol = this.volumeBytes;
    const rowStride = size * size * 4;

    let li = 0;
    for (let bz = 0; bz < size; bz++) {
      for (let gy = 0; gy < size; gy++) {
        for (let rx = 0; rx < size; rx++) {
          const r = d[li] * wd + g[li] * wg + n[li] * wn;
          const gg = d[li + 1] * wd + g[li + 1] * wg + n[li + 1] * wn;
          const bb = d[li + 2] * wd + g[li + 2] * wg + n[li + 2] * wn;
          li += 3;

          const R = r * 255 + 0.5;
          const G = gg * 255 + 0.5;
          const B = bb * 255 + 0.5;

          // Strip: x = rx + bz * size, y = gy.
          const si = gy * rowStride + (rx + bz * size) * 4;
          bytes[si] = R;
          bytes[si + 1] = G;
          bytes[si + 2] = B;
          bytes[si + 3] = 255;

          // Volume: standard (x=r, y=g, z=b) voxel order.
          const vi = ((bz * size + gy) * size + rx) * 4;
          vol[vi] = R;
          vol[vi + 1] = G;
          vol[vi + 2] = B;
          vol[vi + 3] = 255;
        }
      }
    }
    this.texture.needsUpdate = true;
    this.volume.needsUpdate = true;
    return true;
  }

  dispose(): void {
    this.texture.dispose();
    this.volume.dispose();
  }
}

/* ------------------------------------------------------------------ *
 * Time-of-day blending
 * ------------------------------------------------------------------ */

/**
 * Pick look weights from the sun's actual elevation rather than the clock.
 *
 * Using the hour directly means the grade flips at a fixed time regardless of
 * where the sun is; using elevation means "golden" happens exactly when the
 * light is golden, which is the whole point.
 */
export function lookWeightsForHour(hour: number): [number, number, number] {
  const elev = sunDirection(hour).y;
  // Night below the horizon, golden in the first ~14° of elevation, full day above.
  const night = 1 - smoothstep(-0.09, 0.045, elev);
  const dayness = smoothstep(0.05, 0.26, elev);
  const golden = (1 - night) * (1 - dayness);
  const day = (1 - night) * dayness;
  return [day, golden, night];
}
