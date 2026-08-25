/**
 * vfx/particles.ts — the GPU particle engine.
 *
 * ## The shape of the thing
 *
 * Five draw calls, total, for every particle in San Francisco. Each is a
 * `Layer`: one `InstancedBufferGeometry` (a unit quad) plus one interleaved
 * per-instance buffer, one texture, one blend mode. Everything else — smoke,
 * fire, sparks, rain, blood, litter, birds, exhaust — is a tile index and a
 * colour ramp inside those five layers.
 *
 * ## Why the simulation lives in the vertex shader
 *
 * The CPU writes a particle exactly once, at spawn: origin, initial velocity,
 * drag, gravity, lifetime, size ramp, colour ramp, turbulence amplitude. After
 * that the vertex shader evaluates the closed-form solution of
 *
 *     dv/dt = a − k·v        →      p(t) = p₀ + (a/k)·t + (v₀ − a/k)·(1 − e^(−kt))/k
 *
 * every frame. There is no per-frame CPU write, no readback, and no per-frame
 * buffer upload beyond the handful of slots that were born or died this frame.
 * A 24 000-particle explosion costs the CPU one burst loop and then nothing.
 *
 * Two consequences you must respect when editing:
 *   - particles cannot collide, be steered, or react to anything after spawn.
 *     Anything that needs to react is a rigid body (see `debris.ts`), not a
 *     particle. This is the correct trade, not a limitation to route around.
 *   - `k` is clamped away from zero. `a/k` appears twice with opposite signs,
 *     so a tiny `k` is catastrophic float32 cancellation. Drag below 0.05 is
 *     silently 0.05; at that value a particle keeps 92 % of its speed over
 *     two seconds, which is as close to drag-free as anything needs.
 *
 * ## Lifetime management
 *
 * The instance buffer is kept *dense*: `geometry.instanceCount` is exactly the
 * live count, so a quiet frame draws nothing. Dead slots are removed by
 * swapping the last live particle down, which touches one stride and keeps the
 * dirty upload range small. A full compaction scan is a float compare per live
 * particle per frame — at the ultra cap that is 48 000 compares, well under
 * 0.1 ms, and far cheaper than any heap.
 *
 * On overflow we round-robin overwrite rather than dropping the spawn: an
 * explosion that silently loses its fireball is worse than one that recycles
 * some ambient dust.
 */
import * as THREE from "three";
import { QUALITY, type QualityTier } from "../config";
import { frame } from "../state/store";
import { makeRng, type Rng } from "../math/rng";
import {
  ATLAS_COLS, ATLAS_ROWS, Tile, fireFlipbook, particleAtlas, smokeFlipbook, tilePxForTier,
} from "./textures";

/* ================================================================== *
 * Layout
 * ================================================================== */

/** Floats per instance. 8 × vec4 — aligned, and there is room to grow. */
export const STRIDE = 32;

const O_SPAWN = 0;   // x, y, z, spawnTime
const O_VEL = 4;     // vx, vy, vz, drag
const O_LIFE = 8;    // lifetime, size0, size1, seed
const O_DYN = 12;    // rot0, rotSpeed, gravityY, turbAmp
const O_COL0 = 16;   // r, g, b, a  at birth
const O_COL1 = 20;   // r, g, b, a  at death
const O_SHEET = 24;  // frameStart, frameCount, fps, windScale
const O_FLAGS = 28;  // billboardMode, stretch, fadeIn, fadeOut

/** How a particle's quad is oriented. */
export const Billboard = {
  /** Faces the camera, rotates in screen plane. Default. */
  Camera: 0,
  /** Long axis follows the particle's current velocity. Sparks, rain, tracers. */
  Stretch: 1,
  /** Lies flat on the XZ plane. Ground dust rings, scorch flares, water rings. */
  Ground: 2,
  /** Y-locked billboard — stays vertical, spins to face you. Flame sheets. */
  Axis: 3,
} as const;
export type BillboardMode = (typeof Billboard)[keyof typeof Billboard];

/** Which of the five layers a particle goes into. */
export type LayerName = "add" | "alpha" | "mul" | "smoke" | "flame";

/**
 * Everything needed to spawn one particle.
 *
 * Emitters fill a shared scratch instance of this and call `emit` in a loop —
 * do the same in any hot path. Object literals are fine for one-offs.
 */
export interface ParticleDesc {
  layer: LayerName;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Linear drag coefficient, 1/s. 0.2 = ballistic-ish, 6 = stops dead. */
  drag: number;
  /** Vertical acceleration, m/s². Negative falls, positive is buoyant smoke. */
  gravity: number;
  /** How hard the turbulence field pushes, m/s. 0 for rain, 3+ for smoke. */
  turbulence: number;
  /** 0 = ignores wind, 1 = drifts at exactly `frame.windSpeed`. */
  wind: number;
  life: number;
  size0: number;
  size1: number;
  rot: number;
  rotSpeed: number;
  r0: number; g0: number; b0: number; a0: number;
  r1: number; g1: number; b1: number; a1: number;
  /** Atlas tile (static sprites) or first flipbook frame. */
  frame: number;
  /** 1 for a static sprite; 16 to play a whole flipbook. */
  frames: number;
  /** Flipbook playback rate. Ignored when `frames` is 1. */
  fps: number;
  mode: BillboardMode;
  /** Extra length along the velocity axis for `Billboard.Stretch`. */
  stretch: number;
  /** Fraction of life spent fading in / out. */
  fadeIn: number;
  fadeOut: number;
}

/** A fully-defaulted desc; emitters clone-by-assignment from this. */
const DEFAULTS: ParticleDesc = {
  layer: "alpha",
  x: 0, y: 0, z: 0,
  vx: 0, vy: 0, vz: 0,
  drag: 0.6, gravity: -9.81, turbulence: 0, wind: 0,
  life: 1, size0: 1, size1: 1, rot: 0, rotSpeed: 0,
  r0: 1, g0: 1, b0: 1, a0: 1,
  r1: 1, g1: 1, b1: 1, a1: 0,
  frame: Tile.Glow, frames: 1, fps: 0,
  mode: Billboard.Camera, stretch: 1,
  fadeIn: 0.06, fadeOut: 0.3,
};

/** Reusable scratch — fill and pass to `emit`. Never hold a reference to it. */
export const P: ParticleDesc = { ...DEFAULTS };

/** Reset the scratch desc to defaults. Call before every emitter setup. */
export function resetDesc(d: ParticleDesc = P): ParticleDesc {
  Object.assign(d, DEFAULTS);
  return d;
}

/* ================================================================== *
 * Shaders
 * ================================================================== */

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

uniform float uTime;
uniform vec3  uWind;
uniform vec2  uAtlas;      // cols, rows
uniform float uMaster;     // global alpha, for fade-outs and photo mode
uniform float uSizeScale;  // quality/pixel-density compensation

attribute vec4 aSpawn;
attribute vec4 aVel;
attribute vec4 aLife;
attribute vec4 aDyn;
attribute vec4 aCol0;
attribute vec4 aCol1;
attribute vec4 aSheet;
attribute vec4 aFlags;

varying vec4  vColor;
varying vec2  vUv;
varying float vFogDepth;
varying float vViewZ;

/*
 * Three offset sine lobes at two scales. Not curl noise — it is not
 * divergence-free — but it is six trig ops instead of nine gradient fetches
 * and at particle scale the difference is invisible. What matters is that
 * neighbouring particles get *correlated* displacement, so a smoke column
 * churns as a body instead of dissolving into independent jitter.
 */
vec3 vfxTurb(vec3 p, float t) {
  vec3 a = p * 0.34 + vec3(t * 0.61, t * 0.44, t * 0.53);
  vec3 b = p * 0.11 - vec3(t * 0.22, t * 0.17, t * 0.28);
  return vec3(
    sin(a.y) * cos(b.z) + 0.5 * sin(b.y * 2.3),
    cos(a.z) * sin(b.x) + 0.5 * cos(a.x * 1.7),
    sin(a.x) * cos(b.y) + 0.5 * sin(b.z * 2.1)
  );
}

void main() {
  float life = max(aLife.x, 1e-3);
  float raw  = uTime - aSpawn.w;
  float t    = clamp(raw, 0.0, life);
  float age  = t / life;
  float dead = step(life, raw) + step(raw, -1e-4);   // 1 if unborn or expired

  float k = max(aVel.w, 0.05);
  vec3  acc = vec3(0.0, aDyn.z, 0.0) + uWind * (aSheet.w * k);
  float e = exp(-k * t);
  vec3  ai = acc / k;
  vec3  wpos = aSpawn.xyz + ai * t + (aVel.xyz - ai) * ((1.0 - e) / k);

  // Turbulence displacement grows with age; the field is sampled at the
  // *spawn* point so a particle keeps its own eddy instead of swimming
  // through a static world-space pattern.
  wpos += vfxTurb(aSpawn.xyz * 0.09 + vec3(aLife.w * 13.7), uTime * 0.5 + aLife.w * 6.283) * (aDyn.w * t);

  vec3 vel = ai + (aVel.xyz - ai) * e;

  float sz = mix(aLife.y, aLife.z, age) * uSizeScale * (1.0 - dead);
  float rot = aDyn.x + aDyn.y * t;

  // Camera basis straight out of the view matrix rows — no uniforms, no CPU.
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camFwd   = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);

  float cr = cos(rot), sr = sin(rot);
  vec2 q = position.xy;
  vec2 qr = vec2(q.x * cr - q.y * sr, q.x * sr + q.y * cr);

  float mode = aFlags.x;
  vec3 offset;
  if (mode < 0.5) {
    offset = (camRight * qr.x + camUp * qr.y) * sz;
  } else if (mode < 1.5) {
    // Velocity-stretched: long axis along motion, short axis across the screen.
    float vlen = length(vel);
    vec3 dir = vlen > 1e-3 ? vel / vlen : camUp;
    vec3 side = cross(dir, camFwd);
    float sl = length(side);
    side = sl > 1e-4 ? side / sl : camRight;
    float stretch = 1.0 + aFlags.y * min(vlen, 140.0) * 0.02;
    offset = side * (q.x * sz) + dir * (q.y * sz * stretch);
  } else if (mode < 2.5) {
    // Ground-aligned: flat on XZ, spins about Y.
    offset = vec3(qr.x, 0.0, qr.y) * sz;
  } else {
    // Y-locked billboard for flame sheets and columns.
    vec3 toCam = cameraPosition - wpos;
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam + vec3(1e-4)));
    offset = right * (q.x * sz) + vec3(0.0, q.y * sz, 0.0);
  }

  vec4 mv = modelViewMatrix * vec4(wpos + offset, 1.0);
  gl_Position = projectionMatrix * mv;

  vFogDepth = -mv.z;
  vViewZ = -mv.z;

  // Envelope: birth ramp × death ramp. Doing it here rather than baking it
  // into the colour ramp means a particle can hold full opacity for most of
  // its life and still never pop in or out.
  float fi = max(aFlags.z, 1e-4);
  float fo = max(aFlags.w, 1e-4);
  float env = smoothstep(0.0, fi, age) * (1.0 - smoothstep(1.0 - fo, 1.0, age));

  vColor = mix(aCol0, aCol1, age);
  vColor.a *= env * uMaster * (1.0 - dead);

  // Flipbook: hold the last frame rather than looping, so a one-shot puff does
  // not snap back to frame 0 halfway through its fade.
  float f = aSheet.x + min(aSheet.y - 1.0, floor(t * aSheet.z));
  float cols = uAtlas.x, rows = uAtlas.y;
  float fi2 = mod(max(f, 0.0), cols * rows);
  vec2 tile = vec2(mod(fi2, cols), floor(fi2 / cols));
  vUv = (uv + vec2(tile.x, rows - 1.0 - tile.y)) / uAtlas;

  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform sampler2D uMap;
uniform vec3  uFogColor;
uniform vec2  uFogRange;   // near, far
uniform float uFogMode;    // 0 = blend toward fog colour, 1 = attenuate (additive)

#ifdef VFX_SOFT
uniform sampler2D uDepth;
uniform vec2  uCamPlanes;  // near, far
uniform vec2  uInvRes;
uniform float uSoftness;   // metres over which the particle fades into geometry
#endif

varying vec4  vColor;
varying vec2  vUv;
varying float vFogDepth;
varying float vViewZ;

void main() {
  #include <logdepthbuf_fragment>

  vec4 tex = texture2D(uMap, vUv);
  vec4 c = tex * vColor;
  if (c.a < 0.0035) discard;

  #ifdef VFX_SOFT
  {
    // Soft particles: fade where the sprite intersects opaque geometry, which
    // is the single cheapest fix for the "cardboard cut-out in the wall" look.
    vec2 suv = gl_FragCoord.xy * uInvRes;
    float d = texture2D(uDepth, suv).x;
    float n = uCamPlanes.x, f = uCamPlanes.y;
    float sceneZ = (2.0 * n * f) / (f + n - (d * 2.0 - 1.0) * (f - n));
    c.a *= clamp((sceneZ - vViewZ) / max(uSoftness, 1e-3), 0.0, 1.0);
    if (c.a < 0.0035) discard;
  }
  #endif

  float fogF = smoothstep(uFogRange.x, uFogRange.y, vFogDepth);
  if (uFogMode > 0.5) {
    // Additive light does not become fog-coloured at distance; it is simply
    // scattered away. Blending toward the fog colour would make every distant
    // explosion glow grey-blue, which is exactly wrong.
    c.rgb *= (1.0 - fogF);
    c.a *= (1.0 - fogF * 0.85);
  } else {
    c.rgb = mix(c.rgb, uFogColor, fogF);
  }

  #ifdef VFX_MULTIPLY
  // Multiply blending needs white where there is no coverage.
  gl_FragColor = vec4(mix(vec3(1.0), c.rgb, c.a), 1.0);
  #else
  gl_FragColor = c;
  #endif

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ================================================================== *
 * Layer
 * ================================================================== */

interface LayerSpec {
  name: LayerName;
  blending: THREE.Blending;
  /** Share of the tier's particle budget. */
  share: number;
  renderOrder: number;
  multiply?: boolean;
  atlas: [number, number];
  texture: (px: number) => THREE.Texture;
}

const LAYER_SPECS: LayerSpec[] = [
  // Multiply first: it darkens, and it must be under everything it darkens.
  { name: "mul", blending: THREE.MultiplyBlending, share: 0.05, renderOrder: 3000, multiply: true, atlas: [ATLAS_COLS, ATLAS_ROWS], texture: particleAtlas },
  { name: "smoke", blending: THREE.NormalBlending, share: 0.26, renderOrder: 3010, atlas: [4, 4], texture: smokeFlipbook },
  { name: "alpha", blending: THREE.NormalBlending, share: 0.27, renderOrder: 3020, atlas: [ATLAS_COLS, ATLAS_ROWS], texture: particleAtlas },
  { name: "flame", blending: THREE.AdditiveBlending, share: 0.10, renderOrder: 3030, atlas: [4, 4], texture: fireFlipbook },
  { name: "add", blending: THREE.AdditiveBlending, share: 0.32, renderOrder: 3040, atlas: [ATLAS_COLS, ATLAS_ROWS], texture: particleAtlas },
];

const QUAD_POS = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
const QUAD_UV = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const QUAD_IDX = new Uint16Array([0, 1, 2, 0, 2, 3]);

class Layer {
  readonly name: LayerName;
  readonly capacity: number;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  private readonly data: Float32Array;
  /** Absolute sim time at which each live slot dies. */
  private readonly death: Float32Array;
  private alive = 0;
  private overflow = 0;
  private dirtyLo = Infinity;
  private dirtyHi = -Infinity;
  /** Peak live count since the last stats read — for the debug overlay. */
  peak = 0;

  constructor(spec: LayerSpec, capacity: number, tilePx: number) {
    this.name = spec.name;
    this.capacity = Math.max(64, capacity);
    this.data = new Float32Array(this.capacity * STRIDE);
    this.death = new Float32Array(this.capacity);

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(QUAD_POS, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(QUAD_UV, 2));
    g.setIndex(new THREE.BufferAttribute(QUAD_IDX, 1));

    const buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("aSpawn", new THREE.InterleavedBufferAttribute(buf, 4, O_SPAWN));
    g.setAttribute("aVel", new THREE.InterleavedBufferAttribute(buf, 4, O_VEL));
    g.setAttribute("aLife", new THREE.InterleavedBufferAttribute(buf, 4, O_LIFE));
    g.setAttribute("aDyn", new THREE.InterleavedBufferAttribute(buf, 4, O_DYN));
    g.setAttribute("aCol0", new THREE.InterleavedBufferAttribute(buf, 4, O_COL0));
    g.setAttribute("aCol1", new THREE.InterleavedBufferAttribute(buf, 4, O_COL1));
    g.setAttribute("aSheet", new THREE.InterleavedBufferAttribute(buf, 4, O_SHEET));
    g.setAttribute("aFlags", new THREE.InterleavedBufferAttribute(buf, 4, O_FLAGS));
    g.instanceCount = 0;
    // Particles are scattered across the whole city; a bounding volume would
    // be the whole world, so culling can only cost us. Turn it off explicitly.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uMap: { value: spec.texture(tilePx) },
        uTime: { value: 0 },
        uWind: { value: new THREE.Vector3() },
        uAtlas: { value: new THREE.Vector2(spec.atlas[0], spec.atlas[1]) },
        uMaster: { value: 1 },
        uSizeScale: { value: 1 },
        uFogColor: { value: new THREE.Color(0xb9c8d4) },
        uFogRange: { value: new THREE.Vector2(400, 9000) },
        uFogMode: { value: spec.blending === THREE.AdditiveBlending ? 1 : 0 },
        uDepth: { value: null },
        uCamPlanes: { value: new THREE.Vector2(0.15, 9000) },
        uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uSoftness: { value: 1.2 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: spec.blending,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    if (spec.multiply) mat.defines = { VFX_MULTIPLY: "" };

    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = spec.renderOrder;
    mesh.matrixAutoUpdate = false;
    mesh.name = `vfx-particles-${spec.name}`;

    this.geometry = g;
    this.buffer = buf;
    this.material = mat;
    this.mesh = mesh;
  }

  get liveCount(): number {
    return this.alive;
  }

  private markDirty(slot: number): void {
    if (slot < this.dirtyLo) this.dirtyLo = slot;
    if (slot > this.dirtyHi) this.dirtyHi = slot;
  }

  write(d: ParticleDesc, now: number): void {
    let slot: number;
    if (this.alive < this.capacity) {
      slot = this.alive++;
      if (this.alive > this.peak) this.peak = this.alive;
    } else {
      // Full. Recycling round-robin keeps the damage spread out instead of
      // repeatedly killing whatever happens to sit at index 0.
      slot = this.overflow++ % this.capacity;
    }
    const o = slot * STRIDE;
    const a = this.data;
    a[o + O_SPAWN] = d.x; a[o + O_SPAWN + 1] = d.y; a[o + O_SPAWN + 2] = d.z; a[o + O_SPAWN + 3] = now;
    a[o + O_VEL] = d.vx; a[o + O_VEL + 1] = d.vy; a[o + O_VEL + 2] = d.vz; a[o + O_VEL + 3] = d.drag;
    a[o + O_LIFE] = d.life; a[o + O_LIFE + 1] = d.size0; a[o + O_LIFE + 2] = d.size1;
    a[o + O_LIFE + 3] = seedStream.next();
    a[o + O_DYN] = d.rot; a[o + O_DYN + 1] = d.rotSpeed; a[o + O_DYN + 2] = d.gravity; a[o + O_DYN + 3] = d.turbulence;
    a[o + O_COL0] = d.r0; a[o + O_COL0 + 1] = d.g0; a[o + O_COL0 + 2] = d.b0; a[o + O_COL0 + 3] = d.a0;
    a[o + O_COL1] = d.r1; a[o + O_COL1 + 1] = d.g1; a[o + O_COL1 + 2] = d.b1; a[o + O_COL1 + 3] = d.a1;
    a[o + O_SHEET] = d.frame; a[o + O_SHEET + 1] = d.frames; a[o + O_SHEET + 2] = d.fps; a[o + O_SHEET + 3] = d.wind;
    a[o + O_FLAGS] = d.mode; a[o + O_FLAGS + 1] = d.stretch; a[o + O_FLAGS + 2] = d.fadeIn; a[o + O_FLAGS + 3] = d.fadeOut;
    this.death[slot] = now + d.life;
    this.markDirty(slot);
  }

  /** Retire expired slots and push the dirty span to the GPU. */
  update(now: number): void {
    const a = this.data;
    const death = this.death;
    let i = 0;
    while (i < this.alive) {
      if (death[i] <= now) {
        const last = --this.alive;
        if (i !== last) {
          const src = last * STRIDE;
          const dst = i * STRIDE;
          for (let k = 0; k < STRIDE; k++) a[dst + k] = a[src + k];
          death[i] = death[last];
          this.markDirty(i);
          continue; // re-test the swapped-in particle
        }
      }
      i++;
    }
    this.geometry.instanceCount = this.alive;

    if (this.dirtyHi >= this.dirtyLo) {
      this.buffer.clearUpdateRanges();
      this.buffer.addUpdateRange(this.dirtyLo * STRIDE, (this.dirtyHi - this.dirtyLo + 1) * STRIDE);
      this.buffer.needsUpdate = true;
      this.dirtyLo = Infinity;
      this.dirtyHi = -Infinity;
    }
  }

  clear(): void {
    this.alive = 0;
    this.geometry.instanceCount = 0;
    this.dirtyLo = Infinity;
    this.dirtyHi = -Infinity;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ================================================================== *
 * System
 * ================================================================== */

/** Deterministic per-particle seed stream — never `Math.random`. */
let seedStream: Rng = makeRng("sf-vfx-particles");

class ParticleSystem {
  readonly group = new THREE.Group();
  private layers = new Map<LayerName, Layer>();
  private tier: QualityTier = "high";
  private started = false;
  private readonly wind = new THREE.Vector3();

  constructor() {
    this.group.name = "vfx-particles";
    this.group.frustumCulled = false;
  }

  get ready(): boolean {
    return this.started;
  }

  /** Build every layer for a tier. Safe to call again to change tier. */
  init(tier: QualityTier): void {
    if (this.started && this.tier === tier) return;
    this.dispose();
    this.tier = tier;
    seedStream = makeRng("sf-vfx-particles");
    reseedVfxRng();
    const budget = QUALITY[tier].maxParticles;
    const tilePx = tilePxForTier(tier);
    for (const spec of LAYER_SPECS) {
      const layer = new Layer(spec, Math.floor(budget * spec.share), tilePx);
      this.layers.set(spec.name, layer);
      this.group.add(layer.mesh);
    }
    this.started = true;
  }

  layer(name: LayerName): Layer | undefined {
    return this.layers.get(name);
  }

  /** Spawn one particle. No-ops before `init` — spawns from a system that has
   *  not been mounted yet are legitimate and must not throw. */
  emit(d: ParticleDesc): void {
    const layer = this.layers.get(d.layer);
    if (!layer) return;
    layer.write(d, frame.time);
  }

  /**
   * Per-frame maintenance. Must run after every emitter for the frame, and the
   * camera is needed for the soft-particle resolution + planes.
   */
  update(camera: THREE.PerspectiveCamera, fog: THREE.Fog | THREE.FogExp2 | null, drawW: number, drawH: number): void {
    if (!this.started) return;
    const now = frame.time;
    this.wind.set(frame.windDirection.x, 0, frame.windDirection.y).normalize().multiplyScalar(frame.windSpeed);
    const fogNear = fog instanceof THREE.Fog ? fog.near : 400;
    const fogFar = fog instanceof THREE.Fog ? fog.far : camera.far;
    for (const layer of this.layers.values()) {
      const u = layer.material.uniforms;
      u.uTime.value = now;
      (u.uWind.value as THREE.Vector3).copy(this.wind);
      (u.uCamPlanes.value as THREE.Vector2).set(camera.near, camera.far);
      (u.uInvRes.value as THREE.Vector2).set(1 / Math.max(1, drawW), 1 / Math.max(1, drawH));
      (u.uFogRange.value as THREE.Vector2).set(fogNear, fogFar);
      if (fog && "color" in fog) (u.uFogColor.value as THREE.Color).copy(fog.color);
      layer.update(now);
    }
  }

  /** Global alpha — used by photo mode and the death fade. */
  setMaster(a: number): void {
    for (const l of this.layers.values()) l.material.uniforms.uMaster.value = a;
  }

  /**
   * Bind a scene depth texture to enable soft particles.
   *
   * We do not own a depth prepass — the post-processing stack does — so this is
   * a setter rather than something the particle system arranges for itself.
   * Pass null to turn it back off.
   */
  setDepthTexture(tex: THREE.Texture | null, softness = 1.2): void {
    for (const l of this.layers.values()) {
      const m = l.material;
      m.uniforms.uDepth.value = tex;
      m.uniforms.uSoftness.value = softness;
      const defs: Record<string, unknown> = { ...(m.defines ?? {}) };
      const has = "VFX_SOFT" in defs;
      if (tex && !has) {
        defs.VFX_SOFT = "";
        m.defines = defs;
        m.needsUpdate = true;
      } else if (!tex && has) {
        delete defs.VFX_SOFT;
        m.defines = defs;
        m.needsUpdate = true;
      }
    }
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    let total = 0;
    for (const [k, l] of this.layers) {
      out[k] = l.liveCount;
      total += l.liveCount;
    }
    out.total = total;
    return out;
  }

  clear(): void {
    for (const l of this.layers.values()) l.clear();
  }

  dispose(): void {
    for (const l of this.layers.values()) {
      this.group.remove(l.mesh);
      l.dispose();
    }
    this.layers.clear();
    this.started = false;
  }
}

/** The one particle system. Every VFX module writes into this. */
export const particles = new ParticleSystem();

/* ================================================================== *
 * Emitters
 * ================================================================== */

/**
 * The randomness every emitter draws from. Seeded, never seeded from the
 * wall clock, and reset on `particles.init` — so a replay of the same spawn
 * calls produces the same explosion, which the screenshot harness depends on.
 *
 * That last clause used to be untrue in a way that is worth spelling out. The
 * stream was created once at module scope and never reset, so "the same spawn
 * calls" only reproduced on the *first* boot of a page; every reload, quality
 * change or respawn afterwards continued from wherever the previous world had
 * left the generator. `seedStream` two lines into `init()` was already reseeded
 * for exactly this reason and this one was missed.
 *
 * It is a `const` because half the vfx package imports the binding directly, so
 * the reseed swaps the generator *behind* a stable façade rather than rebinding
 * the export.
 */
const VFX_RNG_SEED = "sf-vfx-emitters";
let vfxRngInner: Rng = makeRng(VFX_RNG_SEED);

export const vfxRng: Rng = {
  next: () => vfxRngInner.next(),
  range: (min, max) => vfxRngInner.range(min, max),
  int: (min, max) => vfxRngInner.int(min, max),
  chance: (p) => vfxRngInner.chance(p),
  pick: (items) => vfxRngInner.pick(items),
  gauss: () => vfxRngInner.gauss(),
  fork: (salt) => vfxRngInner.fork(salt),
};

/** Put the emitter stream back to its first value. Called from `init`. */
export function reseedVfxRng(): void {
  vfxRngInner = makeRng(VFX_RNG_SEED);
}

/** Multiplier applied by `budget()`; set from the quality tier. */
let particleScale = 1;

/**
 * Emitters write into their *own* scratch, never into `P`. Callers routinely
 * build their base desc by mutating `P` (that is what it is for), so an
 * emitter that also used `P` would overwrite its own input halfway through the
 * loop and every particle after the first would inherit the previous one's
 * position. Learned the hard way.
 */
const _E: ParticleDesc = { ...DEFAULTS };

/** Shared scratch so shaped emitters allocate nothing. */
const _dir = new THREE.Vector3();
const _tanA = new THREE.Vector3();
const _tanB = new THREE.Vector3();

function orthoBasis(nx: number, ny: number, nz: number): void {
  _dir.set(nx, ny, nz);
  if (_dir.lengthSq() < 1e-8) _dir.set(0, 1, 0);
  _dir.normalize();
  // Pick the axis least aligned with the normal — the standard trick that
  // avoids a degenerate cross product without a branch per component.
  if (Math.abs(_dir.y) < 0.94) _tanA.set(0, 1, 0);
  else _tanA.set(1, 0, 0);
  _tanB.crossVectors(_dir, _tanA).normalize();
  _tanA.crossVectors(_tanB, _dir).normalize();
}

/** Options shared by all shaped emitters. `desc` supplies everything else. */
export interface EmitShapeOptions {
  count: number;
  /** Speed range along the shape's direction, m/s. */
  speed: [number, number];
  /** Per-particle multiplicative size jitter. */
  sizeJitter?: number;
  /** Per-particle multiplicative life jitter. */
  lifeJitter?: number;
  /** Randomise starting rotation. Default true. */
  spin?: boolean;
  /** Push the spawn point out along its own direction, metres. */
  offset?: number;
  /** Random positional scatter about the origin, metres. */
  jitter?: number;
}

function applyJitter(d: ParticleDesc, base: ParticleDesc, o: EmitShapeOptions): void {
  const sj = o.sizeJitter ?? 0.35;
  const lj = o.lifeJitter ?? 0.3;
  const s = 1 + vfxRng.range(-sj, sj);
  const l = 1 + vfxRng.range(-lj, lj);
  d.size0 = base.size0 * s;
  d.size1 = base.size1 * s;
  d.life = Math.max(0.02, base.life * l);
  if (o.spin !== false) {
    d.rot = vfxRng.range(0, Math.PI * 2);
    d.rotSpeed = base.rotSpeed * vfxRng.range(-1, 1);
  }
}

/**
 * Isotropic burst — the shape almost every explosion sub-layer wants.
 * Directions are uniform on the sphere (inverse-CDF on cos θ, not the naive
 * uniform-angle version that clumps at the poles).
 */
export function emitSphere(base: ParticleDesc, o: EmitShapeOptions): void {
  const jit = o.jitter ?? 0;
  const off = o.offset ?? 0;
  for (let i = 0; i < o.count; i++) {
    const u = vfxRng.range(-1, 1);
    const phi = vfxRng.range(0, Math.PI * 2);
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const dx = s * Math.cos(phi);
    const dy = u;
    const dz = s * Math.sin(phi);
    // Cube-root radius keeps the *volume* uniform; without it every burst is a
    // hollow shell with a dense core.
    const rr = Math.cbrt(vfxRng.next());
    const sp = vfxRng.range(o.speed[0], o.speed[1]) * (0.45 + 0.55 * rr);
    Object.assign(_E, base);
    applyJitter(_E, base, o);
    _E.x = base.x + dx * off + vfxRng.gauss() * jit;
    _E.y = base.y + dy * off + vfxRng.gauss() * jit;
    _E.z = base.z + dz * off + vfxRng.gauss() * jit;
    _E.vx = base.vx + dx * sp;
    _E.vy = base.vy + dy * sp;
    _E.vz = base.vz + dz * sp;
    particles.emit(_E);
  }
}

/**
 * Cone emitter. `angle` is the half-angle in radians; 0 is a pencil beam,
 * π/2 is a hemisphere. Muzzle blast, exhaust, jet wash, directional debris.
 */
export function emitCone(
  base: ParticleDesc,
  nx: number, ny: number, nz: number,
  angle: number,
  o: EmitShapeOptions,
): void {
  orthoBasis(nx, ny, nz);
  const ax = _dir.x, ay = _dir.y, az = _dir.z;
  const tx = _tanA.x, ty = _tanA.y, tz = _tanA.z;
  const bx = _tanB.x, by = _tanB.y, bz = _tanB.z;
  const cosA = Math.cos(angle);
  const jit = o.jitter ?? 0;
  const off = o.offset ?? 0;
  for (let i = 0; i < o.count; i++) {
    // Uniform on the spherical cap.
    const c = 1 - vfxRng.next() * (1 - cosA);
    const s = Math.sqrt(Math.max(0, 1 - c * c));
    const ph = vfxRng.range(0, Math.PI * 2);
    const cx = Math.cos(ph) * s;
    const cy = Math.sin(ph) * s;
    const dx = ax * c + tx * cx + bx * cy;
    const dy = ay * c + ty * cx + by * cy;
    const dz = az * c + tz * cx + bz * cy;
    const sp = vfxRng.range(o.speed[0], o.speed[1]);
    Object.assign(_E, base);
    applyJitter(_E, base, o);
    _E.x = base.x + dx * off + vfxRng.gauss() * jit;
    _E.y = base.y + dy * off + vfxRng.gauss() * jit;
    _E.z = base.z + dz * off + vfxRng.gauss() * jit;
    _E.vx = base.vx + dx * sp;
    _E.vy = base.vy + dy * sp;
    _E.vz = base.vz + dz * sp;
    particles.emit(_E);
  }
}

/**
 * Ring emitter: particles start on a circle of radius `radius` about `normal`
 * and fly *outward* in the plane. This is the ground dust wave of an explosion
 * and the water ring of a splash.
 */
export function emitRing(
  base: ParticleDesc,
  nx: number, ny: number, nz: number,
  radius: number,
  o: EmitShapeOptions & { rise?: number; radialBias?: number },
): void {
  orthoBasis(nx, ny, nz);
  const tx = _tanA.x, ty = _tanA.y, tz = _tanA.z;
  const bx = _tanB.x, by = _tanB.y, bz = _tanB.z;
  const rise = o.rise ?? 0;
  const jit = o.jitter ?? 0;
  for (let i = 0; i < o.count; i++) {
    // Stratified angle: an evenly-spaced ring with jitter reads as a wave, a
    // purely random one reads as a cloud.
    const a = ((i + vfxRng.range(0.15, 0.85)) / o.count) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const rx = tx * ca + bx * sa;
    const ry = ty * ca + by * sa;
    const rz = tz * ca + bz * sa;
    const rr = radius * vfxRng.range(0.82, 1.18);
    const sp = vfxRng.range(o.speed[0], o.speed[1]);
    Object.assign(_E, base);
    applyJitter(_E, base, o);
    _E.x = base.x + rx * rr + vfxRng.gauss() * jit;
    _E.y = base.y + ry * rr + vfxRng.gauss() * jit;
    _E.z = base.z + rz * rr + vfxRng.gauss() * jit;
    _E.vx = base.vx + rx * sp + _dir.x * rise;
    _E.vy = base.vy + ry * sp + _dir.y * rise;
    _E.vz = base.vz + rz * sp + _dir.z * rise;
    particles.emit(_E);
  }
}

/**
 * Emit along a segment — the primitive behind smoke trails, tracers and
 * anything that has to lay particles down where a fast object *was* rather
 * than where it is now. Without this, anything moving faster than
 * size/frametime leaves a dotted line.
 */
export function emitTrail(
  base: ParticleDesc,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  o: EmitShapeOptions & { spread?: number },
): void {
  const spread = o.spread ?? 0;
  const jit = o.jitter ?? 0;
  for (let i = 0; i < o.count; i++) {
    const t = (i + vfxRng.range(0, 1)) / o.count;
    Object.assign(_E, base);
    applyJitter(_E, base, o);
    _E.x = x0 + (x1 - x0) * t + vfxRng.gauss() * jit;
    _E.y = y0 + (y1 - y0) * t + vfxRng.gauss() * jit;
    _E.z = z0 + (z1 - z0) * t + vfxRng.gauss() * jit;
    const sp = vfxRng.range(o.speed[0], o.speed[1]);
    _E.vx = base.vx + vfxRng.gauss() * spread + vfxRng.gauss() * sp * 0.2;
    _E.vy = base.vy + vfxRng.gauss() * spread + vfxRng.gauss() * sp * 0.2;
    _E.vz = base.vz + vfxRng.gauss() * spread + vfxRng.gauss() * sp * 0.2;
    particles.emit(_E);
  }
}

/** Single particle, no shaping. For emitters that compute their own placement. */
export function emitOne(d: ParticleDesc): void {
  particles.emit(d);
}

/**
 * Scale a particle count by the tier budget so an explosion is a spectacle on
 * ultra and still an explosion on low. Every caller should route its counts
 * through this rather than hard-coding a number.
 */
export function budget(n: number): number {
  return Math.max(1, Math.round(n * particleScale));
}

/** Called by the VFX root when the quality tier changes. */
export function setParticleScale(tier: QualityTier): void {
  // Referenced against the "high" budget so `high` is exactly the authored
  // count and the other tiers scale from it.
  particleScale = QUALITY[tier].maxParticles / QUALITY.high.maxParticles;
  particleScale = Math.max(0.14, Math.min(1.6, particleScale));
}
