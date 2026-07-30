/**
 * Vibe Golf — particles, splashes, rings and screen shake. Publishes `VfxService2`.
 *
 * Everything the player *feels* on impact lives here. The budget rule is that
 * a phone must never drop a frame because the ball landed in a bunker, so the
 * whole system is three draw calls and zero per-frame allocation:
 *
 *  1. an alpha-blended `Points` pool  — divots, grains, smoke, confetti, dust
 *  2. an additive `Points` pool       — sparks, embers, glints, wisps
 *  3. two tiny InstancedMesh quad pools for expanding rings and soft flashes
 *
 * Particle motion is integrated **on the GPU**. Each particle stores a spawn
 * time, a launch velocity, a linear-drag coefficient and a gravity scale; the
 * vertex shader evaluates the exact closed form of `v' = -kv + g` every frame.
 * The CPU only ever writes a particle once, at spawn, into a ring buffer — it
 * never walks the live set. Expired particles collapse to zero point size and
 * are clipped, so there is no compaction pass either.
 *
 * All art is procedural: one 256² sprite atlas plus a ring and a radial
 * falloff, painted into `DataTexture`s at boot. No canvas, no DOM, no network.
 *
 * Consumes `golf:bounce`, `golf:hazard`, `golf:shot`, `golf:holed`,
 * `golf:hole`, `golf:stick`, `golf:penalty`, `golf:ready`. Emits
 * `golf:shake` (0..1) and — on a hole-out — `golf:celebrate`, which carries
 * how long the world wants the frame before any UI dims it. It also nudges
 * the camera itself, so shake and the hole-out punch survive a missing post
 * stack.
 */
import * as THREE from "three";
import type {
  BallType,
  GolfQuality,
  SurfaceMaterial,
  System,
  SystemFactory,
  Vec2,
  VfxService2,
} from "../types";
import { BALL_TYPES } from "../types";
import { LAYER } from "../engine/core";
import type { GolfEngine } from "../engine/core";

// ---------------------------------------------------------------------------
// Sprite atlas
// ---------------------------------------------------------------------------

/** 4×4 tiles of 64 px. Index order is baked into `T_*` below. */
const ATLAS_TILES = 4;
const ATLAS_TILE_PX = 64;
const ATLAS_PX = ATLAS_TILES * ATLAS_TILE_PX;

const T_SOFT = 0;
const T_SPARK = 1;
const T_SMOKE = 2;
const T_CHIP = 3;
const T_BLADE = 4;
const T_GRAIN = 5;
const T_CRYSTAL = 6;
const T_CONFETTI = 7;
const T_DROP = 8;
const T_EMBER = 9;
const T_STAR = 10;
const T_DUST = 11;

const sat = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Paint one sprite tile. `u`/`v` are −0.5..0.5 with +v up; returns alpha in
 * `out[0]` and luminance (which the particle colour multiplies) in `out[1]`.
 * Every shape is padded inside ~0.45 of the tile so mip-mapping can't bleed
 * one sprite into its neighbour.
 */
function paintTile(tile: number, u: number, v: number, ph: Float32Array, out: Float32Array): void {
  const r = Math.hypot(u, v);
  let a = 0;
  let l = 1;
  switch (tile) {
    case T_SOFT: {
      a = Math.pow(sat(1 - r / 0.48), 2.0);
      break;
    }
    case T_DUST: {
      const ang = Math.atan2(v, u);
      const wob = 1 + 0.14 * Math.sin(3 * ang + ph[0]) + 0.09 * Math.sin(6 * ang + ph[1]);
      a = Math.pow(sat(1 - (r * wob) / 0.48), 3.1) * 0.8;
      l = 0.9;
      break;
    }
    case T_SMOKE: {
      const ang = Math.atan2(v, u);
      const wob =
        1 + 0.2 * Math.sin(3 * ang + ph[1]) + 0.13 * Math.sin(5 * ang + ph[2]) + 0.07 * Math.sin(9 * ang + ph[3]);
      const rr = r * wob;
      a = Math.pow(sat(1 - rr / 0.46), 1.7) * 0.92;
      l = 0.66 + 0.34 * sat(0.55 - rr * 1.3);
      break;
    }
    case T_SPARK: {
      // Capsule along +x, tapering toward the head so it reads directional.
      const hx = 0.38;
      const t = sat((u + hx) / (2 * hx));
      const th = 0.072 * (1 - t * 0.72) + 0.008;
      const d = Math.abs(u) <= hx ? Math.abs(v) : Math.hypot(Math.abs(u) - hx, v);
      a = Math.pow(sat(1 - d / th), 1.35);
      break;
    }
    case T_CHIP: {
      const ang = Math.atan2(v, u);
      const rad = 0.29 * (1 + 0.24 * Math.sin(3 * ang + ph[4]) + 0.13 * Math.sin(5 * ang + ph[5]));
      a = sat((rad - r) / 0.022);
      l = 0.5 + 0.5 * sat(0.5 + v * 1.8); // lit from above, dark underside
      break;
    }
    case T_BLADE: {
      const t = sat(v + 0.5);
      const bend = 0.26 * t * t - 0.12;
      const w = 0.082 * Math.pow(1 - t, 0.7);
      a = sat((w - Math.abs(u - bend)) / 0.014);
      l = 0.5 + 0.5 * t;
      break;
    }
    case T_GRAIN: {
      a = sat((0.15 - r) / 0.04);
      l = 0.86 + 0.14 * sat(0.5 + v * 2);
      break;
    }
    case T_CRYSTAL: {
      const d = Math.abs(u) / 0.2 + Math.abs(v) / 0.42;
      a = sat((1 - d) / 0.1);
      l = 0.58 + 0.42 * sat((d - 0.5) * 2.2); // bright facet edge
      break;
    }
    case T_CONFETTI: {
      const hx = 0.33;
      const hy = 0.145;
      const cr = 0.055;
      const dx = Math.max(Math.abs(u) - (hx - cr), 0);
      const dy = Math.max(Math.abs(v) - (hy - cr), 0);
      a = sat(-(Math.hypot(dx, dy) - cr) / 0.016);
      l = 0.72 + 0.28 * sat(0.5 + v * 3);
      break;
    }
    case T_DROP: {
      const cy = -0.12;
      const rr = 0.185;
      if (v <= cy) {
        a = sat((rr - Math.hypot(u, v - cy)) / 0.022);
      } else {
        const t = sat((v - cy) / 0.5);
        a = sat((rr * Math.pow(1 - t, 1.3) - Math.abs(u)) / 0.022);
      }
      l = 0.8 + 0.2 * sat(0.5 - u * 2.2 + v);
      break;
    }
    case T_EMBER: {
      a = sat((0.06 - r) / 0.025) + Math.pow(sat(1 - r / 0.44), 3.2) * 0.7;
      break;
    }
    case T_STAR: {
      const hx = Math.exp(-Math.abs(v) / 0.02) * Math.pow(sat(1 - Math.abs(u) / 0.44), 1.5);
      const hy = Math.exp(-Math.abs(u) / 0.02) * Math.pow(sat(1 - Math.abs(v) / 0.44), 1.5);
      a = sat(hx + hy + Math.pow(sat(1 - r / 0.13), 2.0));
      break;
    }
    default:
      a = 0;
  }
  out[0] = sat(a);
  out[1] = sat(l);
}

function buildAtlas(rng: () => number): THREE.DataTexture {
  const data = new Uint8Array(ATLAS_PX * ATLAS_PX * 4);
  const ph = new Float32Array(8);
  for (let i = 0; i < ph.length; i++) ph[i] = rng() * Math.PI * 2;
  const out = new Float32Array(2);
  for (let tile = 0; tile < 12; tile++) {
    const ox = (tile % ATLAS_TILES) * ATLAS_TILE_PX;
    const oy = Math.floor(tile / ATLAS_TILES) * ATLAS_TILE_PX;
    for (let py = 0; py < ATLAS_TILE_PX; py++) {
      for (let px = 0; px < ATLAS_TILE_PX; px++) {
        const u = (px + 0.5) / ATLAS_TILE_PX - 0.5;
        const v = 0.5 - (py + 0.5) / ATLAS_TILE_PX;
        paintTile(tile, u, v, ph, out);
        const o = ((oy + py) * ATLAS_PX + (ox + px)) * 4;
        const lum = (out[1] * 255) | 0;
        data[o] = lum;
        data[o + 1] = lum;
        data[o + 2] = lum;
        data[o + 3] = (out[0] * 255) | 0;
      }
    }
  }
  const tex = new THREE.DataTexture(data, ATLAS_PX, ATLAS_PX, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Thin expanding ring. Peak sits at 0.42 of the quad so the tail never clips. */
function buildRingTex(px = 128): THREE.DataTexture {
  const data = new Uint8Array(px * px * 4);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const u = (x + 0.5) / px - 0.5;
      const v = (y + 0.5) / px - 0.5;
      const r = Math.hypot(u, v);
      const g = Math.exp(-Math.pow((r - 0.42) / 0.052, 2));
      const a = sat(g + 0.06 * sat(1 - r / 0.42));
      const o = (y * px + x) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = (a * 255) | 0;
    }
  }
  const tex = new THREE.DataTexture(data, px, px, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Soft radial falloff for flashes and heat blooms. */
function buildRadialTex(px = 64): THREE.DataTexture {
  const data = new Uint8Array(px * px * 4);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const r = Math.hypot((x + 0.5) / px - 0.5, (y + 0.5) / px - 0.5);
      const a = Math.pow(sat(1 - r / 0.5), 2.6);
      const o = (y * px + x) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = (a * 255) | 0;
    }
  }
  const tex = new THREE.DataTexture(data, px, px, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

/**
 * Closed-form linear drag with gravity:
 *   v(t) = (v0 − v∞)·e^(−kt) + v∞,  v∞ = g/k
 *   p(t) = p0 + v∞·t + (v0 − v∞)·(1 − e^(−kt))/k
 * Exact, branch-free, and it means a spark and a smoke puff differ only by
 * two floats instead of by a CPU update path.
 */
const P_VERT = /* glsl */ `
  attribute vec2 aVel;
  attribute vec2 aTime;   // spawn, life
  attribute vec3 aDyn;    // drag k, gravity scale, spin rad/s
  attribute vec2 aSize;   // metres at birth, metres at death
  attribute vec3 aColor;
  attribute vec4 aParams; // tile, base rotation, align-to-velocity, alpha

  uniform float uTime;
  uniform float uPx;      // device pixels per world metre
  uniform float uMaxPx;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vAngle;
  varying vec2 vTile;

  void main() {
    float t = uTime - aTime.x;
    float u = t / max(aTime.y, 0.0001);
    if (u < 0.0 || u >= 1.0) {
      // Behind the camera and zero-sized: clipped before it costs a fragment.
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vAlpha = 0.0;
      vColor = vec3(0.0);
      vAngle = 0.0;
      vTile = vec2(0.0);
      return;
    }

    float k = clamp(aDyn.x, 0.15, 24.0);
    vec2 g = vec2(0.0, -22.0 * aDyn.y);
    vec2 vInf = g / k;
    float decay = exp(-k * t);
    vec2 p = position.xy + vInf * t + (aVel - vInf) * (1.0 - decay) / k;
    vec2 vNow = (aVel - vInf) * decay + vInf;

    vColor = aColor;
    vAlpha = aParams.w * smoothstep(0.0, 0.09, u) * pow(1.0 - u, 1.25);
    vAngle = aParams.z > 0.5 ? atan(vNow.y, vNow.x) + aParams.y : aParams.y + aDyn.z * t;
    vTile = vec2(mod(aParams.x, 4.0), floor(aParams.x / 4.0));

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, position.z, 1.0);
    gl_PointSize = clamp(mix(aSize.x, aSize.y, u) * uPx, 0.6, uMaxPx);
  }
`;

const P_FRAG = /* glsl */ `
  uniform sampler2D uAtlas;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vAngle;
  varying vec2 vTile;

  void main() {
    if (vAlpha <= 0.002) discard;
    vec2 pc = gl_PointCoord - 0.5;
    float c = cos(vAngle);
    float s = sin(vAngle);
    // Sprites are authored +x forward, so rotating the lookup aligns them.
    vec2 q = vec2(pc.x * c + pc.y * s, -pc.x * s + pc.y * c) + 0.5;
    if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) discard;
    vec2 uv = (vTile + clamp(q, 0.012, 0.988)) * 0.25;
    vec4 tex = texture2D(uAtlas, uv);
    float a = tex.a * vAlpha;
    if (a <= 0.004) discard;
    gl_FragColor = vec4(vColor * tex.r, a);
    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

interface Pool {
  points: THREE.Points;
  geo: THREE.BufferGeometry;
  mat: THREE.ShaderMaterial;
  cap: number;
  head: number;
  pos: Float32Array;
  vel: Float32Array;
  tim: Float32Array;
  dyn: Float32Array;
  siz: Float32Array;
  col: Float32Array;
  par: Float32Array;
  dirty: boolean;
  /** First slot written this frame, and how many — for partial GPU uploads. */
  first: number;
  wrote: number;
}

interface QuadPool {
  mesh: THREE.InstancedMesh;
  cap: number;
  head: number;
  /** x, y, z, r0, r1, aspect, life, age, rot, spin, alpha per slot. */
  s: Float32Array;
  col: Float32Array;
  live: number;
}

const QUAD_STRIDE = 11;

interface Budget {
  add: number;
  alpha: number;
  scale: number;
  perFrame: number;
  trailStep: number;
}

const BUDGETS: Record<GolfQuality, Budget> = {
  low: { add: 520, alpha: 380, scale: 0.42, perFrame: 90, trailStep: 0.075 },
  medium: { add: 1200, alpha: 820, scale: 0.72, perFrame: 170, trailStep: 0.05 },
  high: { add: 2400, alpha: 1500, scale: 1.0, perFrame: 280, trailStep: 0.032 },
};

// ---------------------------------------------------------------------------
// Impact recipes
// ---------------------------------------------------------------------------

interface Recipe {
  /** Base particle count at full impact speed. */
  n: number;
  /** Chunky bits: tile, colour, size, gravity. */
  chip: { tile: number; col: number; col2: number; size: number; grav: number; spin: number };
  /** Airborne haze: tile, colour, size. */
  haze: { tile: number; col: number; size: number; n: number } | null;
  /** Additive glints. */
  glint: { tile: number; col: number; size: number; n: number } | null;
  /** Ejection speed multiplier and cone half-angle. */
  speed: number;
  cone: number;
  ringCol: number;
  ringAlpha: number;
}

const RECIPES: Partial<Record<SurfaceMaterial, Recipe>> = {
  fairway: {
    n: 18,
    chip: { tile: T_BLADE, col: 0x86e88a, col2: 0x47a862, size: 0.9, grav: 1, spin: 9 },
    haze: { tile: T_DUST, col: 0xbfe3a8, size: 1.7, n: 3 },
    glint: null,
    speed: 0.55,
    cone: 1.0,
    ringCol: 0xa6f0a0,
    ringAlpha: 0.34,
  },
  green: {
    n: 14,
    chip: { tile: T_BLADE, col: 0x96f59c, col2: 0x4fb478, size: 0.74, grav: 1, spin: 8 },
    haze: { tile: T_DUST, col: 0xc4eeb0, size: 1.35, n: 2 },
    glint: null,
    speed: 0.42,
    cone: 1.0,
    ringCol: 0xb4f7b6,
    ringAlpha: 0.34,
  },
  rough: {
    n: 17,
    chip: { tile: T_BLADE, col: 0x5fb463, col2: 0x2f7548, size: 0.86, grav: 1, spin: 11 },
    haze: { tile: T_DUST, col: 0xa2c894, size: 1.9, n: 4 },
    glint: null,
    speed: 0.46,
    cone: 1.15,
    ringCol: 0x92d897,
    ringAlpha: 0.34,
  },
  sand: {
    n: 30,
    chip: { tile: T_GRAIN, col: 0xffeec4, col2: 0xe0c184, size: 0.44, grav: 1, spin: 0 },
    haze: { tile: T_SMOKE, col: 0xf2e2bc, size: 2.6, n: 7 },
    glint: null,
    speed: 0.46,
    cone: 1.3,
    ringCol: 0xffe9bc,
    ringAlpha: 0.45,
  },
  stone: {
    n: 14,
    chip: { tile: T_CHIP, col: 0xd2dae4, col2: 0x808c9c, size: 0.6, grav: 1, spin: 13 },
    haze: { tile: T_SMOKE, col: 0xcdd6e0, size: 2.2, n: 5 },
    glint: { tile: T_STAR, col: 0xfff0cf, size: 1.1, n: 2 },
    speed: 0.6,
    cone: 1.0,
    ringCol: 0xe4ecf5,
    ringAlpha: 0.5,
  },
  wood: {
    n: 13,
    chip: { tile: T_CHIP, col: 0xe2a968, col2: 0x9a6a3c, size: 0.64, grav: 1, spin: 12 },
    haze: { tile: T_DUST, col: 0xe8cfa8, size: 1.8, n: 3 },
    glint: null,
    speed: 0.54,
    cone: 1.05,
    ringCol: 0xf0c795,
    ringAlpha: 0.42,
  },
  metal: {
    n: 22,
    chip: { tile: T_SPARK, col: 0xffc36a, col2: 0xff7a34, size: 1.05, grav: 0.85, spin: 0 },
    haze: null,
    glint: { tile: T_STAR, col: 0xfff4d6, size: 1.7, n: 3 },
    speed: 1.15,
    cone: 1.35,
    ringCol: 0xffd89c,
    ringAlpha: 0.75,
  },
  ice: {
    n: 17,
    chip: { tile: T_CRYSTAL, col: 0xe2faff, col2: 0x92e0fa, size: 0.72, grav: 1, spin: 10 },
    haze: { tile: T_DUST, col: 0xeafaff, size: 1.9, n: 4 },
    glint: { tile: T_STAR, col: 0xe8fbff, size: 1.25, n: 3 },
    speed: 0.74,
    cone: 1.15,
    ringCol: 0xbdeeff,
    ringAlpha: 0.55,
  },
  rubber: {
    n: 9,
    chip: { tile: T_DUST, col: 0x93a8c0, col2: 0x51637a, size: 0.9, grav: 0.5, spin: 4 },
    haze: null,
    glint: null,
    speed: 0.4,
    cone: 1.4,
    ringCol: 0x7cf0d4,
    ringAlpha: 0.85,
  },
};

const DEFAULT_RECIPE = RECIPES.fairway as Recipe;

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export interface GolfVfxSystem extends System {
  attachEngine(e: GolfEngine): void;
}

const createVfx: SystemFactory = (ctx) => {
  const rng = ctx.rng;
  const q: GolfQuality = ctx.quality ?? "high";
  const B = BUDGETS[q] ?? BUDGETS.high;

  const group = new THREE.Group();
  group.name = "golf-vfx";
  group.matrixAutoUpdate = false;
  ctx.scene.add(group);

  const atlas = buildAtlas(rng);
  const ringTex = buildRingTex(128);
  const radialTex = buildRadialTex(64);

  // Point size is clamped to whatever the driver actually supports, otherwise
  // a big smoke puff silently vanishes on some mobile GL stacks.
  let maxPx = 320;
  try {
    const gl = ctx.renderer.getContext();
    const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | number[] | null;
    if (range && range.length > 1 && range[1] > 8) maxPx = Math.min(512, range[1]);
  } catch {
    /* keep the default */
  }

  const shared = {
    uTime: { value: 0 },
    uPx: { value: 30 },
    uMaxPx: { value: maxPx },
    uAtlas: { value: atlas as THREE.Texture },
  };

  function makePool(cap: number, blending: THREE.Blending, order: number): Pool {
    const pos = new Float32Array(cap * 3);
    const vel = new Float32Array(cap * 2);
    const tim = new Float32Array(cap * 2);
    const dyn = new Float32Array(cap * 3);
    const siz = new Float32Array(cap * 2);
    const col = new Float32Array(cap * 3);
    const par = new Float32Array(cap * 4);
    // Life 0 everywhere means every slot starts expired and clipped.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aVel", new THREE.BufferAttribute(vel, 2));
    geo.setAttribute("aTime", new THREE.BufferAttribute(tim, 2));
    geo.setAttribute("aDyn", new THREE.BufferAttribute(dyn, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(siz, 2));
    geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("aParams", new THREE.BufferAttribute(par, 4));
    for (const name of ["position", "aVel", "aTime", "aDyn", "aSize", "aColor", "aParams"]) {
      (geo.attributes[name] as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    }
    const mat = new THREE.ShaderMaterial({
      uniforms: shared,
      vertexShader: P_VERT,
      fragmentShader: P_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending,
      fog: false,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = order;
    points.position.set(0, 0, 0);
    group.add(points);
    return { points, geo, mat, cap, head: 0, pos, vel, tim, dyn, siz, col, par, dirty: false, first: -1, wrote: 0 };
  }

  const poolAlpha = makePool(B.alpha, THREE.NormalBlending, 17);
  const poolAdd = makePool(B.add, THREE.AdditiveBlending, 19);

  function makeQuadPool(cap: number, tex: THREE.Texture, order: number): QuadPool {
    const mesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
      cap,
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    mesh.visible = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const black = new THREE.Color(0, 0, 0);
    for (let i = 0; i < cap; i++) {
      mesh.setMatrixAt(i, zero);
      mesh.setColorAt(i, black);
    }
    group.add(mesh);
    return { mesh, cap, head: 0, s: new Float32Array(cap * QUAD_STRIDE), col: new Float32Array(cap * 3), live: 0 };
  }

  const RING_CAP = q === "low" ? 14 : 26;
  const FLASH_CAP = q === "low" ? 8 : 16;
  const rings = makeQuadPool(RING_CAP, ringTex, 20);
  const flashes = makeQuadPool(FLASH_CAP, radialTex, 18);

  // --- Spawn ---------------------------------------------------------------

  const tmpCol = new THREE.Color();
  let spawnedThisFrame = 0;
  /**
   * Per-frame spawn allowance. Normally the quality budget; the hole-out
   * celebration temporarily lifts it, because its beats are scheduled ~20 ms
   * apart and on a slow frame they all land together — with the ordinary cap
   * the burst would silently lose most of itself exactly when it matters.
   */
  let frameBudget = B.perFrame;

  /**
   * Write one particle into a pool's ring buffer. Positional args on purpose:
   * this is the hot path and it must never allocate an options object.
   */
  function push(
    pool: Pool,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    life: number,
    s0: number,
    s1: number,
    hex: number,
    alpha: number,
    tile: number,
    drag: number,
    grav: number,
    spin: number,
    align: number,
  ): void {
    if (pool.cap === 0 || spawnedThisFrame >= frameBudget) return;
    spawnedThisFrame++;
    const i = pool.head;
    pool.head = (i + 1) % pool.cap;
    if (pool.first < 0) pool.first = i;
    pool.wrote++;

    const i3 = i * 3;
    const i2 = i * 2;
    const i4 = i * 4;
    pool.pos[i3] = x;
    pool.pos[i3 + 1] = y;
    pool.pos[i3 + 2] = z;
    pool.vel[i2] = vx;
    pool.vel[i2 + 1] = vy;
    pool.tim[i2] = ctx.elapsed;
    pool.tim[i2 + 1] = life;
    pool.dyn[i3] = drag;
    pool.dyn[i3 + 1] = grav;
    pool.dyn[i3 + 2] = spin;
    pool.siz[i2] = s0;
    pool.siz[i2 + 1] = s1;
    tmpCol.setHex(hex);
    pool.col[i3] = tmpCol.r;
    pool.col[i3 + 1] = tmpCol.g;
    pool.col[i3 + 2] = tmpCol.b;
    pool.par[i4] = tile;
    pool.par[i4 + 1] = align > 0.5 ? 0 : rng() * Math.PI * 2;
    pool.par[i4 + 2] = align;
    pool.par[i4 + 3] = alpha;
    pool.dirty = true;
  }

  const POOL_ATTRS = ["position", "aVel", "aTime", "aDyn", "aSize", "aColor", "aParams"];

  /**
   * Upload only the slots written this frame. Pushes walk the ring buffer in
   * order, so the dirty region is one contiguous run unless it wrapped — at
   * ~19 floats a particle, this is the difference between a few hundred bytes
   * and a quarter-megabyte per frame while a trail is running.
   */
  function flush(pool: Pool): void {
    if (!pool.dirty) return;
    pool.dirty = false;
    const contiguous = pool.first >= 0 && pool.first + pool.wrote <= pool.cap;
    for (const name of POOL_ATTRS) {
      const attr = pool.geo.attributes[name] as THREE.BufferAttribute;
      attr.clearUpdateRanges();
      if (contiguous) attr.addUpdateRange(pool.first * attr.itemSize, pool.wrote * attr.itemSize);
      attr.needsUpdate = true;
    }
    pool.first = -1;
    pool.wrote = 0;
  }

  /** Push a quad-pool effect (ring or flash). `aspect` squashes it vertically. */
  function pushQuad(
    pool: QuadPool,
    x: number,
    y: number,
    z: number,
    r0: number,
    r1: number,
    aspect: number,
    life: number,
    hex: number,
    alpha: number,
    rot: number,
    spin: number,
  ): void {
    if (pool.cap === 0) return;
    const i = pool.head;
    pool.head = (i + 1) % pool.cap;
    const o = i * QUAD_STRIDE;
    const s = pool.s;
    s[o] = x;
    s[o + 1] = y;
    s[o + 2] = z;
    s[o + 3] = r0;
    s[o + 4] = r1;
    s[o + 5] = aspect;
    s[o + 6] = life;
    s[o + 7] = 0;
    s[o + 8] = rot;
    s[o + 9] = spin;
    s[o + 10] = alpha;
    tmpCol.setHex(hex);
    pool.col[i * 3] = tmpCol.r;
    pool.col[i * 3 + 1] = tmpCol.g;
    pool.col[i * 3 + 2] = tmpCol.b;
    pool.mesh.visible = true;
  }

  // --- Quad pool stepping --------------------------------------------------

  const qMat = new THREE.Matrix4();
  const qScale = new THREE.Vector3();
  const qCol = new THREE.Color();

  function stepQuads(pool: QuadPool, dt: number): void {
    if (!pool.mesh.visible) return;
    const s = pool.s;
    let live = 0;
    for (let i = 0; i < pool.cap; i++) {
      const o = i * QUAD_STRIDE;
      const life = s[o + 6];
      if (life <= 0) continue;
      const age = (s[o + 7] += dt);
      if (age >= life) {
        s[o + 6] = 0;
        qMat.makeScale(0, 0, 0);
        pool.mesh.setMatrixAt(i, qMat);
        qCol.setRGB(0, 0, 0);
        pool.mesh.setColorAt(i, qCol);
        continue;
      }
      live++;
      const u = age / life;
      // Ease-out expansion: fast open, slow settle — reads as a shockwave.
      const e = 1 - Math.pow(1 - u, 2.4);
      const r = s[o + 3] + (s[o + 4] - s[o + 3]) * e;
      const fade = Math.pow(1 - u, 1.7) * s[o + 10];
      qMat.makeRotationZ(s[o + 8] + s[o + 9] * age);
      qScale.set(r * 2, r * 2 * s[o + 5], 1);
      qMat.scale(qScale);
      qMat.setPosition(s[o], s[o + 1], s[o + 2]);
      pool.mesh.setMatrixAt(i, qMat);
      qCol.setRGB(pool.col[i * 3] * fade, pool.col[i * 3 + 1] * fade, pool.col[i * 3 + 2] * fade);
      pool.mesh.setColorAt(i, qCol);
    }
    pool.live = live;
    pool.mesh.instanceMatrix.needsUpdate = true;
    if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
    if (live === 0) pool.mesh.visible = false;
  }

  // --- Shake ---------------------------------------------------------------

  let engine: GolfEngine | null = null;
  let shake = 0;
  let shakeT = 0;

  function screenShake(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    shake = Math.min(1, Math.max(shake, Math.min(1, amount)));
    ctx.emit("golf:shake", Math.min(1, amount));
  }

  // --- Effects -------------------------------------------------------------

  const scaled = (n: number): number => Math.max(1, Math.round(n * B.scale));

  /** Nearest surface normal at a point, defaulting to "up" when nothing is near. */
  const nrm = { x: 0, y: 1 };
  function surfaceNormal(x: number, y: number, radius = 0.7): boolean {
    const hit = ctx.services.physics?.probe({ x, y }, radius) ?? null;
    if (!hit) {
      nrm.x = 0;
      nrm.y = 1;
      return false;
    }
    const L = Math.hypot(hit.normal.x, hit.normal.y) || 1;
    nrm.x = hit.normal.x / L;
    nrm.y = hit.normal.y / L;
    return true;
  }

  /**
   * Material impact. `k` (0..1) is the speed-derived intensity — the whole
   * point is that a 1 m/s roll and a 60 m/s slam do not look the same.
   */
  function impact(x: number, y: number, material: SurfaceMaterial, speed: number): void {
    const R = RECIPES[material] ?? DEFAULT_RECIPE;
    const k = sat((speed - 1.1) / 26);
    if (k <= 0.02) return;
    const k2 = k * k;
    surfaceNormal(x, y, 0.85);
    const nx = nrm.x;
    const ny = nrm.y;
    const px = x + nx * 0.12;
    const py = y + ny * 0.12;
    const base = Math.atan2(ny, nx);
    const eject = (3.2 + speed * 0.55) * R.speed;

    const n = scaled(R.n * (0.25 + 0.75 * k));
    for (let i = 0; i < n; i++) {
      const a = base + (rng() - 0.5) * 2 * R.cone;
      const sp = eject * (0.35 + rng() * 0.85);
      const c = R.chip;
      const hex = rng() < 0.5 ? c.col : c.col2;
      const sz = c.size * (0.6 + rng() * 0.8) * (0.7 + 0.5 * k);
      const isSpark = c.tile === T_SPARK;
      push(
        isSpark ? poolAdd : poolAlpha,
        px + (rng() - 0.5) * 0.18,
        py + (rng() - 0.5) * 0.18,
        LAYER.fx,
        Math.cos(a) * sp,
        Math.sin(a) * sp,
        (isSpark ? 0.26 : 0.62) + rng() * (isSpark ? 0.3 : 0.6),
        sz,
        isSpark ? sz * 0.35 : sz * 0.8,
        hex,
        isSpark ? 1 : 0.95,
        c.tile,
        isSpark ? 2.6 : 1.1 + rng() * 0.8,
        c.grav,
        (rng() - 0.5) * 2 * c.spin,
        isSpark ? 1 : 0,
      );
    }

    if (R.haze && k > 0.12) {
      const hn = scaled(R.haze.n * (0.4 + 0.6 * k));
      const wind = ctx.services.physics?.wind;
      for (let i = 0; i < hn; i++) {
        const a = base + (rng() - 0.5) * 2.4;
        const sp = eject * 0.22 * (0.4 + rng());
        push(
          poolAlpha,
          px + (rng() - 0.5) * 0.4,
          py + (rng() - 0.5) * 0.3,
          LAYER.fx - 0.5,
          Math.cos(a) * sp + (wind ? wind.x * 0.25 : 0),
          Math.sin(a) * sp + 0.5,
          0.65 + rng() * 0.85,
          R.haze.size * (0.55 + rng() * 0.5) * (0.6 + 0.6 * k),
          R.haze.size * (2.0 + rng()),
          R.haze.col,
          0.2 + 0.3 * k,
          R.haze.tile,
          2.4,
          -0.06,
          (rng() - 0.5) * 1.6,
          0,
        );
      }
    }

    if (R.glint && k > 0.25) {
      const gn = scaled(R.glint.n * k);
      for (let i = 0; i < gn; i++) {
        const a = base + (rng() - 0.5) * 2.2;
        push(
          poolAdd,
          px,
          py,
          LAYER.fx,
          Math.cos(a) * eject * 0.5,
          Math.sin(a) * eject * 0.5,
          0.14 + rng() * 0.16,
          R.glint.size * (0.6 + rng() * 0.7),
          R.glint.size * 0.2,
          R.glint.col,
          0.9,
          R.glint.tile,
          5,
          0.2,
          0,
          0,
        );
      }
    }

    // A contact ring flattened onto the surface sells the plane of impact.
    if (k > 0.14) {
      pushQuad(
        rings,
        px,
        py,
        LAYER.fx,
        0.18 + k * 0.3,
        (0.65 + k * 1.5) * (material === "rubber" ? 1.7 : 1),
        0.42,
        0.24 + k * 0.22,
        R.ringCol,
        R.ringAlpha * (0.35 + 0.65 * k),
        base - Math.PI / 2,
        0,
      );
    }
    if (material === "metal" && k > 0.3) {
      pushQuad(flashes, px, py, LAYER.fx, 0.4, 1.2 + k * 1.6, 1, 0.18, 0xffd9a0, 0.9 * k, 0, 0);
    }
    if (k2 > 0.16) screenShake(Math.min(0.55, k2 * 0.7));
  }

  /**
   * Find the lethal pool containing (or just under) a point and return its
   * water line. Scanning the hole's own surfaces is exact where a nearest-
   * surface probe is not: on a shoreline the bank is usually the closer edge,
   * which would otherwise make a real drowning render as a dry puff.
   */
  const lethalPool = { y: 0, material: "water" as SurfaceMaterial };
  function lethalPoolAt(x: number, y: number): boolean {
    const hole = ctx.services.course?.current;
    if (!hole) return false;
    for (const s of hole.surfaces) {
      if (s.material !== "water" && s.material !== "lava") continue;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of s.points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      if (x < minX - 0.6 || x > maxX + 0.6 || y < minY - 2.5 || y > maxY + 1.6) continue;
      lethalPool.y = maxY;
      lethalPool.material = s.material;
      // Refine the surface line to the segment actually under this x.
      for (let i = 0; i < s.points.length - 1; i++) {
        const a = s.points[i];
        const b = s.points[i + 1];
        if (x < Math.min(a.x, b.x) - 0.01 || x > Math.max(a.x, b.x) + 0.01) continue;
        const t = Math.abs(b.x - a.x) < 1e-5 ? 0 : (x - a.x) / (b.x - a.x);
        lethalPool.y = a.y + (b.y - a.y) * t;
        break;
      }
      return true;
    }
    return false;
  }

  /** Water crown + ripples, or lava embers + heat + smoke. */
  function splash(at: Vec2, material: SurfaceMaterial): void {
    splashAt(at.x, at.y, material);
  }

  function splashAt(x: number, y: number, material: SurfaceMaterial): void {
    const at = { x, y };
    const lethal = lethalPoolAt(at.x, at.y);
    const sx = at.x;
    const sy = lethal ? lethalPool.y : at.y;
    const kind: SurfaceMaterial = lethal ? lethalPool.material : material;

    // No hazard under the point: this is a drop or a reset marker, not a
    // splash. A crown of water in the middle of a fairway reads as a bug.
    if (!lethal) {
      const n = scaled(8);
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2;
        push(
          poolAlpha, at.x, at.y, LAYER.fx,
          Math.cos(a) * 2.4 * rng(), Math.sin(a) * 2.4 * rng() + 1.2,
          0.5 + rng() * 0.4, 0.85 + rng() * 0.5, 2.4, 0xd3dfef, 0.34, T_DUST, 2.6, -0.05, 0, 0,
        );
      }
      pushQuad(rings, at.x, at.y, LAYER.fx, 0.4, 2.2, 0.5, 0.4, 0x9fb4cc, 0.3, 0, 0);
      return;
    }

    if (kind === "lava") {
      // Heat flash first — the eye reads the bloom before the debris.
      pushQuad(flashes, sx, sy + 0.8, LAYER.fx, 1.0, 7.5, 0.85, 0.6, 0xff8a3c, 1, 0, 0);
      pushQuad(flashes, sx, sy + 0.4, LAYER.fx, 0.6, 3.2, 1, 0.3, 0xfff0c0, 0.9, 0, 0);
      pushQuad(rings, sx, sy, LAYER.fx, 0.5, 5.0, 0.32, 0.8, 0xffb347, 0.85, 0, 0);
      const n = scaled(32);
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (rng() - 0.5) * 2.0 + Math.PI; // upward fan
        const sp = 4 + rng() * 11;
        push(
          poolAdd, sx + (rng() - 0.5) * 0.9, sy + 0.15, LAYER.fx,
          Math.cos(a) * sp * 0.55, Math.abs(Math.sin(a)) * sp,
          0.7 + rng() * 0.9, 0.5 + rng() * 0.5, 0.08,
          rng() < 0.4 ? 0xfff0b0 : rng() < 0.6 ? 0xff9a3a : 0xff5a22,
          1, T_EMBER, 0.9, 1, 0, 0,
        );
      }
      const globs = scaled(7);
      for (let i = 0; i < globs; i++) {
        const a = -Math.PI / 2 + (rng() - 0.5) * 1.3 + Math.PI;
        const sp = 5 + rng() * 8;
        push(
          poolAdd, sx + (rng() - 0.5) * 0.6, sy + 0.2, LAYER.fx,
          Math.cos(a) * sp * 0.6, Math.abs(Math.sin(a)) * sp,
          0.9, 0.85, 0.3, 0xff7a2e, 0.95, T_DROP, 0.6, 1, 0, 1,
        );
      }
      const smoke = scaled(9);
      for (let i = 0; i < smoke; i++) {
        push(
          poolAlpha, sx + (rng() - 0.5) * 1.6, sy + 0.5 + rng(), LAYER.fx - 0.5,
          (rng() - 0.5) * 1.6, 1.4 + rng() * 2.4,
          1.5 + rng() * 1.4, 1.4 + rng() * 0.9, 5.0 + rng() * 2.5,
          rng() < 0.5 ? 0x3a2a2a : 0x1c1618, 0.42, T_SMOKE, 1.1, -0.1, (rng() - 0.5) * 1.2, 0,
        );
      }
      screenShake(0.5);
      return;
    }

    // --- Water: a crown, a droplet spray, foam, and expanding ripples ------
    const crown = scaled(11);
    for (let i = 0; i < crown; i++) {
      const t = (i / Math.max(1, crown - 1)) * 2 - 1; // −1..1 across the crown
      const lean = t * 0.9;
      push(
        poolAlpha, sx + t * 0.55, sy + 0.1, LAYER.fx,
        lean * 5.2, 7.5 + (1 - Math.abs(t)) * 5.5,
        0.5 + rng() * 0.22, 1.0 + (1 - Math.abs(t)) * 0.9, 0.3,
        0xeaf8ff, 0.85, T_DROP, 0.9, 1, 0, 1,
      );
    }
    const spray = scaled(20);
    for (let i = 0; i < spray; i++) {
      const a = Math.PI / 2 + (rng() - 0.5) * 1.9;
      const sp = 3.5 + rng() * 10;
      push(
        rng() < 0.35 ? poolAdd : poolAlpha,
        sx + (rng() - 0.5) * 1.1, sy + 0.1, LAYER.fx,
        Math.cos(a) * sp, Math.sin(a) * sp,
        0.6 + rng() * 0.6, 0.32 + rng() * 0.3, 0.1,
        rng() < 0.3 ? 0xffffff : 0xb2ecff, 0.9, T_DROP, 0.7, 1, 0, 1,
      );
    }
    const foam = scaled(8);
    for (let i = 0; i < foam; i++) {
      push(
        poolAlpha, sx + (rng() - 0.5) * 2.2, sy + 0.15 + rng() * 0.3, LAYER.fx,
        (rng() - 0.5) * 2.6, 0.6 + rng() * 1.4,
        0.8 + rng() * 0.5, 0.7 + rng() * 0.6, 2.0,
        0xeefbff, 0.5, T_DUST, 2.2, 0.12, 0, 0,
      );
    }
    // Ripples: squashed rings so they lie on the water rather than facing us.
    pushQuad(rings, sx, sy, LAYER.fx, 0.5, 4.6, 0.22, 0.9, 0xa5f0ff, 0.7, 0, 0);
    pushQuad(rings, sx, sy, LAYER.fx, 0.3, 7.4, 0.2, 1.35, 0x6fd8f5, 0.4, 0, 0);
    pushQuad(flashes, sx, sy + 0.5, LAYER.fx, 0.7, 3.4, 0.75, 0.34, 0xdff6ff, 0.7, 0, 0);
    screenShake(0.28);
  }

  /** Sticky-ball landing: a squash ring on the surface plus a few goo beads. */
  function stickAt(x: number, y: number): void {
    surfaceNormal(x, y, 0.8);
    const base = Math.atan2(nrm.y, nrm.x);
    pushQuad(rings, x, y, LAYER.fx, 0.2, 1.5, 0.4, 0.4, BALL_TYPES.sticky.tint, 0.7, base - Math.PI / 2, 0);
    const n = scaled(7);
    for (let i = 0; i < n; i++) {
      const a = base + (rng() - 0.5) * 2.4;
      push(
        poolAlpha, x, y, LAYER.fx,
        Math.cos(a) * 3 * rng(), Math.sin(a) * 3 * rng(),
        0.5, 0.34 + rng() * 0.2, 0.08, BALL_TYPES.sticky.tint, 0.9, T_DROP, 1.6, 1, 0, 1,
      );
    }
  }

  // --- Public service ------------------------------------------------------

  function burst(at: Vec2, count: number, opts?: { color?: number; speed?: number; spread?: number; life?: number }): void {
    const color = opts?.color ?? 0xfff0c0;
    const speed = opts?.speed ?? 6;
    const spread = opts?.spread ?? Math.PI * 2;
    const life = opts?.life ?? 0.45;
    // No direction in the contract, so aim the cone along whatever the ball is
    // doing — cannons and bumpers then spray the way the ball actually left.
    let ax = 0;
    let ay = 1;
    const ball = ctx.services.physics?.balls.find((b) => b.active);
    if (ball) {
      const sp = Math.hypot(ball.vel.x, ball.vel.y);
      if (sp > 3.5) {
        ax = ball.vel.x / sp;
        ay = ball.vel.y / sp;
      }
    }
    const base = Math.atan2(ay, ax);
    const half = Math.min(Math.PI, Math.max(0.05, spread * 0.5));
    const n = scaled(Math.max(1, Math.min(64, count)));
    for (let i = 0; i < n; i++) {
      const a = base + (rng() - 0.5) * 2 * half;
      const sp = speed * (0.3 + rng() * 0.9);
      // Additive throughout: a generic burst is light, not debris, so it
      // never muddies into a brown smear over a bright sky.
      const spark = rng() < 0.6;
      push(
        poolAdd,
        at.x + (rng() - 0.5) * 0.2,
        at.y + (rng() - 0.5) * 0.2,
        LAYER.fx,
        Math.cos(a) * sp,
        Math.sin(a) * sp,
        life * (0.6 + rng() * 0.7),
        spark ? 0.75 + rng() * 0.5 : 0.6 + rng() * 0.5,
        spark ? 0.12 : 0.1,
        color,
        spark ? 1 : 0.8,
        spark ? T_SPARK : T_SOFT,
        spark ? 2.2 : 2.8,
        spark ? 0.5 : 0.1,
        0,
        spark ? 1 : 0,
      );
    }
    pushQuad(flashes, at.x, at.y, LAYER.fx, 0.4, 1.6 + n * 0.07, 1, 0.2, color, 0.55, 0, 0);
  }

  function ring(at: Vec2, radius: number, color = 0x9beddf): void {
    const r = Math.max(0.2, radius);
    pushQuad(rings, at.x, at.y, LAYER.fx, r * 0.22, r * 1.35, 1, 0.34 + r * 0.05, color, 0.95, 0, 0);
    pushQuad(flashes, at.x, at.y, LAYER.fx, r * 0.2, r * 0.8, 1, 0.22, color, 0.45, 0, 0);
  }

  function trailPuff(at: Vec2, color = 0xbfc9d8): void {
    push(
      poolAlpha, at.x, at.y, LAYER.ball - 0.5,
      (rng() - 0.5) * 1.1, 0.5 + rng() * 0.9,
      0.42 + rng() * 0.3, 0.38 + rng() * 0.24, 1.3 + rng() * 0.6,
      color, 0.34, T_DUST, 2.8, -0.05, (rng() - 0.5) * 1.5, 0,
    );
  }

  const service: VfxService2 = { burst, splash, ring, trailPuff, screenShake };
  ctx.services.vfx = service;

  // --- Ball trails ---------------------------------------------------------

  /** Per-ball emission accumulators; the ball list never exceeds a handful. */
  const trailAcc = new Float32Array(8);

  function emitTrail(type: BallType, x: number, y: number, vx: number, vy: number, speed: number): void {
    const tint = BALL_TYPES[type]?.tint ?? 0xffffff;
    const dirx = vx / speed;
    const diry = vy / speed;
    switch (type) {
      case "nitro": {
        // Flame: hot core spat backwards, cooling into dark smoke.
        for (let n = 0; n < 2; n++) {
          push(
            poolAdd, x - dirx * 0.2, y - diry * 0.2, LAYER.ball - 0.5,
            -dirx * 3 + (rng() - 0.5) * 2.4, -diry * 3 + (rng() - 0.5) * 2.4 + 1.2,
            0.3 + rng() * 0.24, 1.05 + rng() * 0.5, 0.12,
            rng() < 0.35 ? 0xfff2c0 : rng() < 0.6 ? 0xff9a3a : 0xfb5a3c,
            1, T_EMBER, 3.2, -0.25, 0, 0,
          );
        }
        push(
          poolAlpha, x - dirx * 0.5, y - diry * 0.5, LAYER.ball - 0.6,
          -dirx * 1.2 + (rng() - 0.5), -diry * 1.2 + 0.9,
          0.6 + rng() * 0.4, 0.6, 2.4, 0x2a2028, 0.16, T_SMOKE, 2, -0.08, (rng() - 0.5) * 2, 0,
        );
        break;
      }
      case "ice": {
        push(
          poolAdd, x + (rng() - 0.5) * 0.4, y + (rng() - 0.5) * 0.4, LAYER.ball - 0.5,
          -dirx * 1.5 + (rng() - 0.5) * 2, -diry * 1.5 + (rng() - 0.5) * 2,
          0.55 + rng() * 0.4, 0.42 + rng() * 0.28, 0.06,
          rng() < 0.4 ? 0xffffff : tint, 0.95, T_CRYSTAL, 1.8, 0.25, (rng() - 0.5) * 8, 0,
        );
        if (rng() < 0.4) {
          push(
            poolAlpha, x, y, LAYER.ball - 0.6,
            (rng() - 0.5) * 1.2, -0.4 - rng(),
            0.7, 0.55, 1.5, 0xdff4ff, 0.24, T_DUST, 2.4, 0.15, 0, 0,
          );
        }
        break;
      }
      case "ghost": {
        // Wisps that lag, rise and swell — no gravity, long life, low alpha.
        push(
          poolAlpha, x - dirx * 0.3, y - diry * 0.3, LAYER.ball - 0.5,
          -dirx * 1.6 + (rng() - 0.5) * 0.8, -diry * 1.6 + 0.9 + rng() * 0.6,
          0.85 + rng() * 0.5, 0.75 + rng() * 0.4, 2.1,
          tint, 0.3, T_SMOKE, 1.6, -0.03, (rng() - 0.5) * 1.4, 0,
        );
        push(
          poolAdd, x, y, LAYER.ball - 0.5,
          (rng() - 0.5) * 1.4, 0.6 + rng(),
          0.6, 0.5, 0.08, 0xd8ddff, 0.55, T_SOFT, 2, -0.05, 0, 0,
        );
        break;
      }
      case "super":
      case "multi": {
        push(
          poolAdd, x + (rng() - 0.5) * 0.5, y + (rng() - 0.5) * 0.5, LAYER.ball - 0.5,
          (rng() - 0.5) * 2.2, (rng() - 0.5) * 2.2,
          0.35 + rng() * 0.25, 0.7 + rng() * 0.4, 0.06, tint, 0.95, T_STAR, 3, 0.1, 0, 0,
        );
        break;
      }
      case "heavy": {
        push(
          poolAlpha, x - dirx * 0.3, y - diry * 0.3, LAYER.ball - 0.5,
          -dirx * 1.4, -diry * 1.4 + 0.4,
          0.55, 0.55, 1.5, 0x8b98ac, 0.26, T_DUST, 2.6, 0.05, 0, 0,
        );
        break;
      }
      default: {
        // Standard ball only streaks when it's genuinely quick, so the effect
        // stays a speed cue rather than constant visual noise.
        if (speed > 26) {
          push(
            poolAdd, x - dirx * 0.25, y - diry * 0.25, LAYER.ball - 0.5,
            -dirx * 2, -diry * 2,
            0.18 + rng() * 0.1, 1.1, 0.2, 0xfff4d8,
            Math.min(0.55, (speed - 26) / 40), T_SPARK, 3.4, 0, 0, 1,
          );
        }
        break;
      }
    }
  }

  // --- Hole-out celebration ------------------------------------------------

  /**
   * The peak moment of a hole has to land in the *world*, not in a dialog.
   * The beat order is: the ball thumps into the cup → a radial spark ring
   * blows out of it → a rim flash runs across the green → a light column
   * climbs the pin and kicks the flag → three confetti waves tinted to the
   * score fall slowly for the next few seconds. A short camera punch-in on the
   * cup rides the whole thing.
   *
   * `CELEB_HOLD` is how long the world gets the frame to itself. It is
   * published on `golf:celebrate` so the HUD can hold its backdrop blur for
   * that long instead of wiping the celebration on frame one.
   */
  const CELEB_HOLD = 0.62;
  const CELEB_END = 4.6;

  /** Score-derived look. Better score → hotter palette and a bigger burst. */
  interface Tier {
    /** Confetti + debris colours. */
    cols: number[];
    /** Additive core colour for the spark ring and the flashes. */
    hot: number;
    /** Colour of the rim flash running out over the green. */
    rim: number;
    power: number;
  }

  const TIER_EAGLE: Tier = {
    cols: [0xfde68a, 0xfbbf24, 0xf59e0b, 0xfff7d6, 0xffd166, 0xc4b5fd],
    hot: 0xfff4cc,
    rim: 0xffc75a,
    power: 1.5,
  };
  const TIER_BIRDIE: Tier = {
    cols: [0x34d399, 0x6ee7b7, 0xfbbf24, 0xfff1c9, 0x2dd4bf, 0xa7f3d0],
    hot: 0xdefff2,
    rim: 0x5ce8b6,
    power: 1.22,
  };
  const TIER_PAR: Tier = {
    cols: [0xfff1c9, 0xfbbf24, 0x60a5fa, 0x34d399, 0xf472b6, 0xe2e8f0],
    hot: 0xfff0c0,
    rim: 0x9beddf,
    power: 1.0,
  };
  const TIER_OVER: Tier = {
    cols: [0xcbd5e1, 0x93c5fd, 0xa7f3d0, 0xe2e8f0, 0xfde68a],
    hot: 0xdbeafe,
    rim: 0x8fd6ea,
    power: 0.78,
  };

  function tierFor(rel: number): Tier {
    if (rel <= -2) return TIER_EAGLE;
    if (rel === -1) return TIER_BIRDIE;
    if (rel <= 0) return TIER_PAR;
    return TIER_OVER;
  }

  interface Step {
    at: number;
    kind: number;
  }
  /**
   * 0 = ball-drop thump, 1 = cup burst, 2 = rim flash on the green,
   * 3 = pin column + flag kick, 4 = confetti wave, 5 = rings, 6 = sparkles.
   */
  const CELEBRATION: Step[] = [
    { at: 0.0, kind: 0 },
    { at: 0.02, kind: 1 },
    { at: 0.04, kind: 2 },
    { at: 0.06, kind: 4 },
    { at: 0.1, kind: 3 },
    { at: 0.26, kind: 4 },
    { at: 0.32, kind: 5 },
    { at: 0.54, kind: 4 },
    { at: 0.66, kind: 6 },
    { at: 0.98, kind: 5 },
    { at: 1.15, kind: 4 },
    { at: 1.7, kind: 6 },
    { at: 2.15, kind: 4 },
  ];

  let tier: Tier = TIER_PAR;
  let celebT = -1;
  let celebStep = 0;
  let drizzle = 0;
  const celebAt = { x: 0, y: 0 };

  const pick = (cols: number[]): number => cols[(rng() * cols.length) | 0];

  /**
   * Half the visible width in metres. Celebration rings are sized in this
   * rather than in absolute metres: the camera fits the hole, so a fixed 11 m
   * shockwave is a tasteful ripple on a long par 4 and a screen-spanning yellow
   * band on a short one. Clamped so a survey zoom can't inflate it either.
   */
  function halfView(): number {
    const cam = ctx.camera;
    return Math.max(4, Math.min(22, (cam.right - cam.left) * 0.5));
  }

  /**
   * Confetti. Pieces are deliberately large and long-lived: the score card
   * puts a dimmed, blurred pane over the world a beat later, and only big
   * saturated shapes still read through that.
   */
  function confettiWave(x: number, y: number, power: number): void {
    const n = scaled(26 * power * tier.power);
    for (let i = 0; i < n; i++) {
      const a = Math.PI / 2 + (rng() - 0.5) * 2.3;
      const sp = (7 + rng() * 16) * power * (0.85 + tier.power * 0.25);
      push(
        poolAlpha,
        x + (rng() - 0.5) * 0.8,
        y + 0.3,
        LAYER.fx,
        Math.cos(a) * sp,
        Math.sin(a) * sp,
        2.4 + rng() * 2.0,
        0.78 + rng() * 0.58,
        0.7 + rng() * 0.5,
        pick(tier.cols),
        1,
        T_CONFETTI,
        // Low drag against a light gravity scale is what gives the fall its
        // slow, floaty read without touching the simulation clock.
        1.0 + rng() * 0.7,
        0.32,
        (rng() - 0.5) * 18,
        0,
      );
    }
  }

  /** The ball landing in the cup: turf out of the lip, dust, a tight ring. */
  function dropThump(x: number, y: number): void {
    const n = scaled(16);
    for (let i = 0; i < n; i++) {
      const a = Math.PI * 0.14 + rng() * Math.PI * 0.72;
      const sp = 2.4 + rng() * 6.5;
      push(
        poolAlpha, x + (rng() - 0.5) * 0.5, y + 0.12, LAYER.fx,
        Math.cos(a) * sp, Math.sin(a) * sp,
        0.55 + rng() * 0.5, 0.5 + rng() * 0.4, 0.34,
        rng() < 0.5 ? 0x8fe89a : 0x3f9c62, 0.95, T_BLADE, 1.6, 1, (rng() - 0.5) * 14, 0,
      );
    }
    const d = scaled(7);
    for (let i = 0; i < d; i++) {
      push(
        poolAlpha, x + (rng() - 0.5) * 1.0, y + 0.2, LAYER.fx - 0.5,
        (rng() - 0.5) * 2.2, 0.9 + rng() * 1.8,
        0.8 + rng() * 0.6, 0.9 + rng() * 0.5, 2.6,
        0xdff0d8, 0.3, T_DUST, 2.4, -0.05, (rng() - 0.5) * 1.4, 0,
      );
    }
    pushQuad(rings, x, y + 0.05, LAYER.fx, 0.25, 2.4, 0.34, 0.34, 0xf3fff4, 0.85, 0, 0);
    screenShake(0.26);
  }

  /** The burst itself: a full radial ring of sparks plus concentric shocks. */
  function cupBurst(x: number, y: number): void {
    const n = scaled(46 * tier.power);
    for (let i = 0; i < n; i++) {
      // Evenly spaced with a little jitter, so it reads as a *ring* rather
      // than a random cloud even when the count is cut on a low-end phone.
      const a = (i / n) * Math.PI * 2 + (rng() - 0.5) * 0.5;
      const sp = (10 + rng() * 20) * (0.75 + tier.power * 0.35);
      push(
        poolAdd, x + Math.cos(a) * 0.2, y + 0.25 + Math.sin(a) * 0.2, LAYER.fx,
        Math.cos(a) * sp, Math.sin(a) * sp * 0.85 + 1.6,
        0.3 + rng() * 0.34, 1.5 + rng() * 1.6, 0.16,
        rng() < 0.45 ? tier.hot : pick(tier.cols), 1, T_SPARK, 3.0, 0.35, 0, 1,
      );
    }
    const g = scaled(12 * tier.power);
    for (let i = 0; i < g; i++) {
      const a = rng() * Math.PI * 2;
      push(
        poolAdd, x, y + 0.3, LAYER.fx,
        Math.cos(a) * 6 * rng(), Math.abs(Math.sin(a)) * 7 * rng() + 1,
        0.3 + rng() * 0.3, 1.5 + rng() * 1.1, 0.1,
        tier.hot, 1, T_STAR, 2.6, 0.2, 0, 0,
      );
    }
    const hv = halfView();
    pushQuad(flashes, x, y + 0.5, LAYER.fx, 0.7, hv * 0.42, 1, 0.34, tier.hot, 1, 0, 0);
    // Radii are view-relative and deliberately *not* scaled by the tier: an
    // albatross gets more sparks and more confetti, not a ring wider than the
    // phone. Anything past ~half the visible width stops reading as a
    // shockwave and starts reading as a lens artefact.
    pushQuad(rings, x, y + 0.35, LAYER.fx, 0.3, hv * 0.28, 1, 0.44, tier.hot, 1, 0, 0);
    pushQuad(rings, x, y + 0.35, LAYER.fx, 0.3, hv * 0.46, 1, 0.7, tier.rim, 0.6, 0, 0);
    // A slow, soft afterglow under the confetti. It is the one part of the
    // celebration that is pure low frequency, so it is also the part that
    // survives being seen through a dimmed, blurred pane a beat later.
    pushQuad(flashes, x, y + 1.4, LAYER.fx - 1, hv * 0.16, hv * 0.72, 0.85, 2.2, tier.hot, 0.55, 0, 0);
    screenShake(0.52);
  }

  /** A flattened shock running out over the green, so the ground reacts too. */
  function rimFlash(x: number, y: number): void {
    const hv = halfView();
    pushQuad(rings, x, y + 0.06, LAYER.fx - 1, 1.0, hv * 0.5, 0.26, 0.7, tier.rim, 0.85, 0, 0);
    pushQuad(rings, x, y + 0.06, LAYER.fx - 1, 0.8, hv * 0.85, 0.2, 1.15, tier.rim, 0.32, 0, 0);
    pushQuad(flashes, x, y + 0.35, LAYER.fx - 1, 1.5, hv * 0.5, 0.42, 0.5, tier.hot, 0.6, 0, 0);
  }

  /** Light climbing the pin, a halo at the finial, and a kick to the cloth. */
  function pinColumn(x: number, y: number): void {
    pushQuad(flashes, x, y + 2.6, LAYER.fx - 1, 0.6, 3.0, 2.6, 0.55, tier.hot, 0.8, 0, 0);
    const n = scaled(14);
    for (let i = 0; i < n; i++) {
      push(
        poolAdd, x + (rng() - 0.5) * 0.5, y + 0.2 + rng() * 0.6, LAYER.fx,
        (rng() - 0.5) * 1.6, 7 + rng() * 9,
        0.5 + rng() * 0.35, 0.8 + rng() * 0.7, 0.1,
        rng() < 0.5 ? tier.hot : tier.rim, 1, T_STAR, 1.1, 0.12, 0, 0,
      );
    }
    pushQuad(rings, x, y + 4.4, LAYER.fx, 0.2, 2.8, 1, 0.5, tier.rim, 0.85, 0, 0);
    flagKick(1);
  }

  function celebrationStep(kind: number): void {
    const x = celebAt.x;
    const y = celebAt.y;
    switch (kind) {
      case 0:
        dropThump(x, y);
        break;
      case 1:
        cupBurst(x, y);
        break;
      case 2:
        rimFlash(x, y);
        break;
      case 3:
        pinColumn(x, y);
        break;
      case 4:
        confettiWave(x, y, 0.75 + rng() * 0.5);
        break;
      case 5: {
        const hv = halfView();
        pushQuad(rings, x, y + 0.4, LAYER.fx, 0.5, hv * (0.26 + rng() * 0.1), 1, 0.7, pick(tier.cols), 0.6, 0, 0);
        pushQuad(rings, x, y + 0.4, LAYER.fx, 0.4, hv * (0.44 + rng() * 0.12), 0.85, 1.1, tier.rim, 0.3, 0, 0);
        break;
      }
      default: {
        const n = scaled(16 * tier.power);
        const w = halfView() * 0.75;
        for (let i = 0; i < n; i++) {
          push(
            poolAdd, x + (rng() - 0.5) * w, y + rng() * 3.5, LAYER.fx,
            (rng() - 0.5) * 1.6, 1.6 + rng() * 2.6,
            1.2 + rng() * 0.9, 0.8 + rng() * 0.6, 0.08,
            pick(tier.cols), 0.95, T_STAR, 1.4, -0.08, 0, 0,
          );
        }
        break;
      }
    }
  }

  // --- Flag reaction -------------------------------------------------------

  /**
   * The pin belongs to the renderer, so this is a *lookup*, not a dependency:
   * find the flag cloth once per hole by its shape — a segmented plane hanging
   * a few metres above the cup — and, if it is there, swing it about the pole.
   * The renderer rewrites the cloth's vertices every frame but never its
   * transform, so a rotation is ours to keep. If the pin ever changes shape
   * this quietly finds nothing and the rest of the celebration is unaffected.
   */
  let flagRef: THREE.Object3D | null = null;
  let flagLooked = false;
  let flagAng = 0;
  let flagVel = 0;
  const flagTmp = new THREE.Vector3();

  function findFlag(): THREE.Object3D | null {
    if (flagLooked) return flagRef;
    const cup = ctx.services.course?.current?.cup;
    if (!cup) return null;
    flagLooked = true;
    try {
      ctx.scene.traverse((o) => {
        if (flagRef) return;
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const p = (m.geometry as { parameters?: Record<string, number> } | undefined)?.parameters;
        if (!p || (p.widthSegments ?? 0) < 4 || (p.heightSegments ?? 0) !== 1) return;
        m.getWorldPosition(flagTmp);
        const up = flagTmp.y - cup.y;
        if (Math.abs(flagTmp.x - cup.x) > 3 || up < 2 || up > 8) return;
        flagRef = m;
      });
    } catch {
      flagRef = null;
    }
    return flagRef;
  }

  function flagKick(amount: number): void {
    if (!findFlag()) return;
    flagVel -= amount * 3.5;
  }

  /** Damped spring back to rest; a couple of visible swings, then still. */
  function stepFlag(dt: number): void {
    if (!flagRef || (flagAng === 0 && flagVel === 0)) return;
    flagVel += (-flagAng * 120 - flagVel * 6) * dt;
    flagAng += flagVel * dt;
    if (Math.abs(flagAng) < 0.002 && Math.abs(flagVel) < 0.02) {
      flagAng = 0;
      flagVel = 0;
    }
    flagRef.rotation.z = Math.max(-0.5, Math.min(0.5, flagAng));
  }

  // --- Camera punch --------------------------------------------------------

  /**
   * A short push toward the cup. `engine.zoom` is written in `lateUpdate`
   * (after the camera system has had its say, before `applyCamera` reads it)
   * and put back in `update` before the camera next looks — the camera treats
   * any outside zoom write as a survey request, so it must never see ours.
   * vfx boots before the camera, so the restore always wins the race.
   */
  let punchBase = -1;

  const smooth = (x: number): number => {
    const t = sat(x);
    return t * t * (3 - 2 * t);
  };

  function punchAmount(t: number): number {
    if (t < 0) return 0;
    if (t < 0.16) return smooth(t / 0.16);
    if (t < 0.55) return 1;
    if (t < 1.7) return 1 - smooth((t - 0.55) / 1.15);
    return 0;
  }

  function releasePunch(): void {
    if (engine && punchBase > 0) engine.zoom = punchBase;
    punchBase = -1;
  }

  // --- Events --------------------------------------------------------------

  let warned = false;
  function safe<T>(fn: (p: T) => void): (p: unknown) => void {
    return (p) => {
      try {
        fn(p as T);
      } catch (err) {
        if (!warned) {
          warned = true;
          console.warn("[golf/vfx] handler failed", err);
        }
      }
    };
  }

  const offs: Array<() => void> = [];

  /**
   * Contact events are emitted from *inside* the physics contact loop, which
   * walks module-level scratch buffers that `physics.probe()` also writes. So
   * nothing here touches physics during a handler: contacts are queued and
   * drained in `update`, which runs after the solver has finished the frame.
   * (Physics boots before this system, so the queue still resolves same-frame.)
   */
  const QUEUE_MAX = 10;
  const qKind = new Uint8Array(QUEUE_MAX); // 0 impact, 1 splash, 2 stick
  const qX = new Float32Array(QUEUE_MAX);
  const qY = new Float32Array(QUEUE_MAX);
  const qSpeed = new Float32Array(QUEUE_MAX);
  const qMaterial: SurfaceMaterial[] = [];
  for (let i = 0; i < QUEUE_MAX; i++) qMaterial.push("fairway");
  let qN = 0;
  let bouncesThisFrame = 0;

  function enqueue(kind: number, x: number, y: number, material: SurfaceMaterial, speed: number): void {
    if (qN >= QUEUE_MAX) return;
    qKind[qN] = kind;
    qX[qN] = x;
    qY[qN] = y;
    qSpeed[qN] = speed;
    qMaterial[qN] = material;
    qN++;
  }

  function drainContacts(): void {
    for (let i = 0; i < qN; i++) {
      const k = qKind[i];
      if (k === 0) impact(qX[i], qY[i], qMaterial[i], qSpeed[i]);
      else if (k === 1) splashAt(qX[i], qY[i], qMaterial[i]);
      else stickAt(qX[i], qY[i]);
    }
    qN = 0;
  }

  offs.push(
    ctx.on(
      "golf:bounce",
      safe<{ at?: Vec2; material?: SurfaceMaterial; speed?: number }>((p) => {
        if (!p?.at || bouncesThisFrame >= 5) return;
        const speed = p.speed ?? 0;
        if (speed < 1.1) return;
        bouncesThisFrame++;
        enqueue(0, p.at.x, p.at.y, p.material ?? "fairway", speed);
      }),
    ),
  );

  offs.push(
    ctx.on(
      "golf:hazard",
      safe<{ at?: Vec2; material?: SurfaceMaterial }>((p) => {
        if (!p?.at) return;
        enqueue(1, p.at.x, p.at.y, p.material ?? "water", 0);
      }),
    ),
  );

  offs.push(
    ctx.on(
      "golf:shot",
      safe<{ power?: number; type?: BallType }>((p) => {
        const power = sat(p?.power ?? 0.6);
        const type = (p?.type ?? "standard") as BallType;
        const tint = BALL_TYPES[type]?.tint ?? 0xffffff;
        const ball = ctx.services.physics?.balls.find((b) => b.active);
        if (!ball) return;
        const x = ball.pos.x;
        const y = ball.pos.y;
        const sp = Math.hypot(ball.vel.x, ball.vel.y) || 1;
        const dx = ball.vel.x / sp;
        const dy = ball.vel.y / sp;

        // Turf kicked backwards out from under the club.
        surfaceNormal(x, y, 0.9);
        const n = scaled(6 + power * 14);
        for (let i = 0; i < n; i++) {
          const a = Math.atan2(-dy, -dx) + (rng() - 0.5) * 1.5;
          const s = (2 + power * 9) * (0.3 + rng());
          push(
            poolAlpha, x + nrm.x * 0.1, y + nrm.y * 0.1, LAYER.fx,
            Math.cos(a) * s, Math.sin(a) * s + 1.5,
            0.45 + rng() * 0.4, 0.5 + rng() * 0.35, 0.4,
            rng() < 0.5 ? 0x76d97a : 0x3d9457, 0.95, T_BLADE, 1.8, 1, (rng() - 0.5) * 12, 0,
          );
        }
        // Launch flare in the ball's own colour.
        const g = scaled(5 + power * 12);
        for (let i = 0; i < g; i++) {
          const a = Math.atan2(dy, dx) + (rng() - 0.5) * 1.1;
          const s = (4 + power * 16) * (0.35 + rng() * 0.9);
          push(
            poolAdd, x, y, LAYER.fx,
            Math.cos(a) * s, Math.sin(a) * s,
            0.24 + rng() * 0.26, 0.7 + power * 0.8, 0.08,
            tint === 0xffffff ? 0xfff0c8 : tint, 1, T_SPARK, 3.2, 0.2, 0, 1,
          );
        }
        // Swoosh: two stretched streaks riding the launch vector.
        for (let i = 0; i < 2; i++) {
          push(
            poolAdd, x + dx * (0.4 + i * 0.5), y + dy * (0.4 + i * 0.5), LAYER.fx,
            dx * sp * 0.42, dy * sp * 0.42,
            0.22 + i * 0.07, 2.4 + power * 3.6, 0.5,
            tint === 0xffffff ? 0xfff6dd : tint, 0.55 - i * 0.18, T_SPARK, 2.4, 0, 0, 1,
          );
        }
        pushQuad(rings, x, y, LAYER.fx, 0.3, 1.2 + power * 2.4, 1, 0.3, tint, 0.5 + power * 0.3, 0, 0);
        pushQuad(flashes, x, y, LAYER.fx, 0.3, 1.4 + power * 1.6, 1, 0.16, tint, 0.4, 0, 0);
        screenShake(0.05 + power * 0.2);
      }),
    ),
  );

  offs.push(
    ctx.on(
      "golf:holed",
      safe<{ strokes?: number; par?: number }>((p) => {
        const hole = ctx.services.course?.current;
        const ball = ctx.services.physics?.balls[0];
        celebAt.x = hole?.cup.x ?? ball?.pos.x ?? engine?.target.x ?? 0;
        celebAt.y = hole?.cup.y ?? ball?.pos.y ?? engine?.target.y ?? 0;
        const par = p?.par ?? hole?.par ?? 3;
        tier = tierFor((p?.strokes ?? par) - par);
        celebT = 0;
        celebStep = 0;
        drizzle = 0;
        // Tell anyone dressing the screen that the world is mid-celebration,
        // so the score card can hold its backdrop blur instead of wiping the
        // best half-second of the hole. Nobody has to listen.
        ctx.emit("golf:celebrate", {
          at: { x: celebAt.x, y: celebAt.y },
          hold: CELEB_HOLD,
          duration: CELEB_END,
          tint: tier.rim,
        });
      }),
    ),
  );

  // A new hole cancels anything still in flight and re-arms the pin lookup.
  offs.push(
    ctx.on(
      "golf:hole",
      safe(() => {
        celebT = -1;
        releasePunch();
        if (flagRef) flagRef.rotation.z = 0;
        flagRef = null;
        flagLooked = false;
        flagAng = 0;
        flagVel = 0;
      }),
    ),
  );

  offs.push(
    ctx.on(
      "golf:stick",
      safe<{ at?: Vec2 }>((p) => {
        if (!p?.at) return;
        enqueue(2, p.at.x, p.at.y, "rubber", 0);
      }),
    ),
  );

  offs.push(
    ctx.on(
      "golf:penalty",
      safe(() => {
        const ball = ctx.services.physics?.balls.find((b) => b.active);
        if (!ball) return;
        const n = scaled(9);
        for (let i = 0; i < n; i++) {
          const a = rng() * Math.PI * 2;
          push(
            poolAlpha, ball.pos.x, ball.pos.y, LAYER.fx,
            Math.cos(a) * 2.4 * rng(), Math.sin(a) * 2.4 * rng() + 1,
            0.6 + rng() * 0.4, 0.65 + rng() * 0.4, 2.0, 0xb6c2d4, 0.34, T_DUST, 2.4, 0.1, 0, 0,
          );
        }
        pushQuad(rings, ball.pos.x, ball.pos.y, LAYER.fx, 0.3, 2.2, 0.6, 0.45, 0xf87171, 0.45, 0, 0);
      }),
    ),
  );

  offs.push(
    ctx.on(
      "golf:ready",
      safe(() => {
        const ball = ctx.services.physics?.balls.find((b) => b.active);
        if (!ball) return;
        // Quiet — this is a "your turn" tell, not an event.
        pushQuad(rings, ball.pos.x, ball.pos.y, LAYER.fx, 0.35, 1.5, 0.85, 0.5, 0x35e0c0, 0.35, 0, 0);
      }),
    ),
  );

  // --- Frame ---------------------------------------------------------------

  const bufSize = new THREE.Vector2();
  let lastLate = ctx.elapsed;

  const sys: GolfVfxSystem = {
    name: "vfx",

    attachEngine(e) {
      engine = e;
    },

    update(dt) {
      // Hand the camera system back the zoom it wrote before it reads it again
      // (see `releasePunch`), then re-derive this frame's spawn allowance.
      releasePunch();
      frameBudget = celebT >= 0 && celebT < 1.4 ? B.perFrame * 4 : B.perFrame;

      // Contacts the solver queued this frame, replayed now that it is safe to
      // query physics again.
      drainContacts();

      // Themed trails, sampled off the live balls rather than the trail ring
      // buffer so emission stays tied to real speed.
      const balls = ctx.services.physics?.balls;
      if (balls) {
        const step = B.trailStep;
        for (let i = 0; i < balls.length && i < trailAcc.length; i++) {
          const b = balls[i];
          if (!b.active || b.resting || b.stuck) {
            trailAcc[i] = 0;
            continue;
          }
          const speed = Math.hypot(b.vel.x, b.vel.y);
          if (speed < 4.5) {
            trailAcc[i] = 0;
            continue;
          }
          // Faster ball, denser trail — clamped so a 60 m/s drive can't spam.
          const interval = step * Math.max(0.45, 1 - speed / 90);
          trailAcc[i] += dt;
          // Emit along the path travelled this frame rather than once at the
          // head, so a fast ball on a slow device still leaves a ribbon
          // instead of a dotted line.
          let emitted = 0;
          while (trailAcc[i] >= interval && emitted < 3) {
            trailAcc[i] -= interval;
            const back = trailAcc[i];
            emitTrail(b.type, b.pos.x - b.vel.x * back, b.pos.y - b.vel.y * back, b.vel.x, b.vel.y, speed);
            emitted++;
          }
          if (emitted >= 3) trailAcc[i] = 0;
        }
        for (let i = balls.length; i < trailAcc.length; i++) trailAcc[i] = 0;
      }

      // Celebration timeline.
      if (celebT >= 0) {
        celebT += dt;
        while (celebStep < CELEBRATION.length && celebT >= CELEBRATION[celebStep].at) {
          celebrationStep(CELEBRATION[celebStep].kind);
          celebStep++;
        }
        // A light drizzle between the scripted beats keeps the air busy. It is
        // metered in seconds, not frames, so 6 fps and 120 fps see the same
        // amount of confetti.
        if (celebT < 2.8) {
          drizzle += dt;
          while (drizzle >= 0.16) {
            drizzle -= 0.16;
            confettiWave(celebAt.x + (rng() - 0.5) * halfView() * 0.6, celebAt.y + 1.2, 0.3);
          }
        }
        if (celebT > CELEB_END) celebT = -1;
      }
      stepFlag(dt);

      shake *= Math.exp(-dt * 5.6);
      if (shake < 0.004) shake = 0;
      shakeT += dt;
    },

    lateUpdate() {
      const cam = ctx.camera;
      // Device pixels per world metre — gl_PointSize works in device pixels,
      // and the composer runs at the renderer's own pixel ratio.
      ctx.renderer.getDrawingBufferSize(bufSize);
      const viewH = Math.max(0.001, cam.top - cam.bottom);
      shared.uPx.value = bufSize.y / viewH;
      shared.uTime.value = ctx.elapsed;

      flush(poolAlpha);
      flush(poolAdd);

      // Quad pools are tiny and CPU-stepped; a fixed 60 Hz-ish step is plenty.
      const dt = Math.min(1 / 20, Math.max(0, ctx.elapsed - lastLate));
      lastLate = ctx.elapsed;
      stepQuads(rings, dt);
      stepQuads(flashes, dt);

      // Camera punch-in on the cup. Same trick as the shake: the camera system
      // rewrites `target` and `zoom` every `update`, so writing here is a pure
      // offset that can never accumulate.
      if (engine && celebT >= 0) {
        const e = punchAmount(celebT);
        if (e > 0.001) {
          punchBase = engine.zoom;
          engine.zoom = punchBase * (1 + 0.14 * e);
          // Clamped so a cup the camera has not caught up to yet can't yank
          // the frame across the hole.
          const dx = Math.max(-6, Math.min(6, celebAt.x - engine.target.x));
          const dy = Math.max(-5, Math.min(5, celebAt.y + 1.6 - engine.target.y));
          engine.target.x += dx * 0.5 * e;
          engine.target.y += dy * 0.5 * e;
        }
      }

      // Apply our own shake. The camera system writes `engine.target` during
      // `update`, so adding here is never cumulative — and it means shake
      // still works when nothing consumes `golf:shake`.
      if (engine && shake > 0) {
        const amp = viewH * 0.02 * shake * shake;
        engine.target.x += (Math.sin(shakeT * 61.3) + Math.sin(shakeT * 37.7) * 0.7) * amp;
        engine.target.y += (Math.sin(shakeT * 53.1 + 1.7) + Math.sin(shakeT * 29.3 + 0.4) * 0.7) * amp * 0.75;
      }

      // End of frame: hand the next one a fresh spawn allowance.
      spawnedThisFrame = 0;
      bouncesThisFrame = 0;
    },

    dispose() {
      for (const off of offs) off();
      offs.length = 0;
      releasePunch();
      if (flagRef) flagRef.rotation.z = 0;
      flagRef = null;
      ctx.scene.remove(group);
      for (const p of [poolAlpha, poolAdd]) {
        p.geo.dispose();
        p.mat.dispose();
      }
      for (const p of [rings, flashes]) {
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.Material).dispose();
        p.mesh.dispose();
      }
      atlas.dispose();
      ringTex.dispose();
      radialTex.dispose();
      if (ctx.services.vfx === service) ctx.services.vfx = undefined;
    },
  };

  return sys;
};

export default createVfx;
