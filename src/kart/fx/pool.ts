/**
 * Vibe Kart — the particle pool.
 *
 * One `ParticleBatch` is one draw call and one blend mode. The whole game runs
 * on two of them: an additive batch for anything that emits light (sparks,
 * flame, sparkles, star shimmer) and an alpha batch for anything that occludes
 * it (smoke, dust, grass, debris, confetti). Separating them is not an
 * optimisation, it is a correctness requirement — additive and alpha sprites
 * cannot be depth-sorted against each other in a single pass without one of
 * them looking wrong.
 *
 * Allocation policy, which is the reason this file exists:
 *
 * · Storage is a **ring buffer** of fixed capacity, allocated once. Emitting is
 *   a write to the slot under a cursor; there is no free list, no compaction
 *   and no death bookkeeping, because the shader already discards expired
 *   instances. Overrunning the ring recycles the oldest particle, which is the
 *   correct failure mode: under a firework of emissions you want the newest
 *   frame's worth to survive.
 *
 * · Emission parameters go through **one shared mutable struct** (`batch.p`).
 *   Passing an object literal per particle would allocate several thousand
 *   short-lived objects a second and hand the GC a sawtooth; writing fields on
 *   a struct that lives as long as the batch does not.
 *
 * · Uploads are **watermarked**. A frame that emits sixty particles uploads
 *   sixty particles' worth of each attribute, not the whole 400 KB buffer.
 */
import * as THREE from "three";
import { PARTICLE_FRAG, PARTICLE_VERT } from "./shaders";

/**
 * The emission struct. Every field is reset to its default by `reset()`, so a
 * caller only writes what it cares about — but note that `reset()` is *not*
 * automatic: emitters that fire many similar particles in a loop deliberately
 * set the shared fields once and only vary the rest.
 */
export interface ParticleParams {
  /** Spawn position, world space. */
  px: number;
  py: number;
  pz: number;
  /** Initial velocity, m/s, world space. */
  vx: number;
  vy: number;
  vz: number;
  /** Seconds the particle lives. */
  life: number;
  /** Sprite diameter in metres at birth and at death. */
  size0: number;
  size1: number;
  /** Linear colour and opacity at birth. */
  r0: number;
  g0: number;
  b0: number;
  a0: number;
  /** Linear colour and opacity at death. */
  r1: number;
  g1: number;
  b1: number;
  a1: number;
  /** Atlas cell — see `TILE`. */
  tile: number;
  /** Initial roll and roll rate, radians (ignored when stretched). */
  rot: number;
  spin: number;
  /** Linear drag coefficient, 1/s. ~0.1 coasts, ~9 stops dead. */
  drag: number;
  /** Vertical acceleration, m/s². Negative falls, positive rises (smoke). */
  gravity: number;
  /** Screen-space elongation along the velocity. 0 = round billboard. */
  stretch: number;
  /** Lateral wander amplitude in metres — confetti, leaves, ash. */
  flutter: number;
}

export function makeParticleParams(): ParticleParams {
  return {
    px: 0,
    py: 0,
    pz: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    life: 1,
    size0: 0.4,
    size1: 0.4,
    r0: 1,
    g0: 1,
    b0: 1,
    a0: 1,
    r1: 1,
    g1: 1,
    b1: 1,
    a1: 0,
    tile: 0,
    rot: 0,
    spin: 0,
    drag: 1,
    gravity: 0,
    stretch: 0,
    flutter: 0,
  };
}

export function resetParticleParams(p: ParticleParams): void {
  p.px = p.py = p.pz = 0;
  p.vx = p.vy = p.vz = 0;
  p.life = 1;
  p.size0 = p.size1 = 0.4;
  p.r0 = p.g0 = p.b0 = p.a0 = 1;
  p.r1 = p.g1 = p.b1 = 1;
  p.a1 = 0;
  p.tile = 0;
  p.rot = 0;
  p.spin = 0;
  p.drag = 1;
  p.gravity = 0;
  p.stretch = 0;
  p.flutter = 0;
}

export interface ParticleBatchOptions {
  name: string;
  capacity: number;
  atlas: THREE.Texture;
  grid: number;
  /** Half-texel inset in cell fractions, to stop mip bleed between cells. */
  inset: number;
  additive: boolean;
  /** Multiplier on emitted radiance. >1 pushes the batch into bloom. */
  intensity: number;
  /** Ceiling on velocity stretch, so a 90 m/s spark cannot become a wall. */
  maxStretch: number;
  renderOrder: number;
}

const FLOATS = { pos: 3, vel: 3, color0: 4, color1: 4, param: 4, misc: 4, extra: 4 } as const;

export class ParticleBatch {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly geometry: THREE.InstancedBufferGeometry;
  /** The shared emission struct. Write, then call `emit()`. */
  readonly p: ParticleParams = makeParticleParams();
  readonly capacity: number;

  /** Particles emitted since boot — the overlay reports throughput off this. */
  emitted = 0;

  private cursor = 0;
  private dirtyLo = Infinity;
  private dirtyHi = -1;
  private wrapped = false;
  private time = 0;

  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aVel: THREE.InstancedBufferAttribute;
  private readonly aColor0: THREE.InstancedBufferAttribute;
  private readonly aColor1: THREE.InstancedBufferAttribute;
  private readonly aParam: THREE.InstancedBufferAttribute;
  private readonly aMisc: THREE.InstancedBufferAttribute;
  private readonly aExtra: THREE.InstancedBufferAttribute;

  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly col0: Float32Array;
  private readonly col1: Float32Array;
  private readonly param: Float32Array;
  private readonly misc: Float32Array;
  private readonly extra: Float32Array;

  constructor(opts: ParticleBatchOptions) {
    const cap = (this.capacity = Math.max(16, Math.floor(opts.capacity)));

    this.pos = new Float32Array(cap * FLOATS.pos);
    this.vel = new Float32Array(cap * FLOATS.vel);
    this.col0 = new Float32Array(cap * FLOATS.color0);
    this.col1 = new Float32Array(cap * FLOATS.color1);
    this.param = new Float32Array(cap * FLOATS.param);
    this.misc = new Float32Array(cap * FLOATS.misc);
    this.extra = new Float32Array(cap * FLOATS.extra);

    // Every slot starts expired. `birth = -1, life = 0` fails the shader's
    // liveness test, so an untouched buffer draws nothing at all.
    for (let i = 0; i < cap; i++) this.param[i * 4] = -1e9;

    const geo = new THREE.InstancedBufferGeometry();
    geo.instanceCount = cap;
    // A bare quad: no uv, no normal. The shader derives its atlas coordinate
    // from `position.xy`, so shipping a uv attribute would be dead bandwidth
    // multiplied by four thousand instances.
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3,
      ),
    );
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    const mk = (arr: Float32Array, size: number) => {
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = mk(this.pos, FLOATS.pos);
    this.aVel = mk(this.vel, FLOATS.vel);
    this.aColor0 = mk(this.col0, FLOATS.color0);
    this.aColor1 = mk(this.col1, FLOATS.color1);
    this.aParam = mk(this.param, FLOATS.param);
    this.aMisc = mk(this.misc, FLOATS.misc);
    this.aExtra = mk(this.extra, FLOATS.extra);
    geo.setAttribute("aPos", this.aPos);
    geo.setAttribute("aVel", this.aVel);
    geo.setAttribute("aColor0", this.aColor0);
    geo.setAttribute("aColor1", this.aColor1);
    geo.setAttribute("aParam", this.aParam);
    geo.setAttribute("aMisc", this.aMisc);
    geo.setAttribute("aExtra", this.aExtra);

    // The batch lives at the origin and its particles are world-space, so the
    // bounding sphere is meaningless. Give it one anyway: three warns and
    // some code paths NaN without it.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const mat = new THREE.ShaderMaterial({
      name: opts.name,
      uniforms: {
        uTime: { value: 0 },
        uGrid: { value: opts.grid },
        uInset: { value: opts.inset },
        uMaxStretch: { value: opts.maxStretch },
        uSizeScale: { value: 1 },
        uIntensity: { value: opts.intensity },
        uMap: { value: opts.atlas },
        uFogColor: { value: new THREE.Color(0x9fc6e0) },
        uFogDensity: { value: 0 },
        uDepth: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uNearFar: { value: new THREE.Vector2(0.15, 4000) },
        uSoftness: { value: 0.6 },
      },
      defines: opts.additive ? { ADDITIVE: "" } : {},
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    mat.userData.own = true;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = opts.name;
    mesh.frustumCulled = false;
    mesh.renderOrder = opts.renderOrder;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    this.geometry = geo;
    this.material = mat;
    this.mesh = mesh;
  }

  /** Commit `this.p` into the ring. Allocation-free by construction. */
  emit(): void {
    const i = this.cursor;
    const p = this.p;

    const i3 = i * 3;
    this.pos[i3] = p.px;
    this.pos[i3 + 1] = p.py;
    this.pos[i3 + 2] = p.pz;
    this.vel[i3] = p.vx;
    this.vel[i3 + 1] = p.vy;
    this.vel[i3 + 2] = p.vz;

    const i4 = i * 4;
    this.col0[i4] = p.r0;
    this.col0[i4 + 1] = p.g0;
    this.col0[i4 + 2] = p.b0;
    this.col0[i4 + 3] = p.a0;
    this.col1[i4] = p.r1;
    this.col1[i4 + 1] = p.g1;
    this.col1[i4 + 2] = p.b1;
    this.col1[i4 + 3] = p.a1;

    this.param[i4] = this.time;
    this.param[i4 + 1] = p.life;
    this.param[i4 + 2] = p.size0;
    this.param[i4 + 3] = p.size1;

    this.misc[i4] = p.tile;
    this.misc[i4 + 1] = p.rot;
    this.misc[i4 + 2] = p.spin;
    this.misc[i4 + 3] = p.drag;

    this.extra[i4] = p.gravity;
    this.extra[i4 + 1] = p.stretch;
    this.extra[i4 + 2] = p.flutter;
    // The seed is the slot index scrambled: deterministic, free, and it never
    // correlates with anything else the particle is doing.
    this.extra[i4 + 3] = ((i * 2654435761) % 1024) / 1024;

    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;

    this.cursor = i + 1;
    if (this.cursor >= this.capacity) {
      this.cursor = 0;
      this.wrapped = true;
    }
    this.emitted++;
  }

  /** Advance the clock and flush whatever was emitted this frame. */
  update(elapsed: number): void {
    this.time = elapsed;
    this.material.uniforms.uTime.value = elapsed;
    if (this.dirtyHi < 0) return;

    const lo = this.wrapped ? 0 : this.dirtyLo;
    const hi = this.wrapped ? this.capacity - 1 : this.dirtyHi;
    const count = hi - lo + 1;
    this.range(this.aPos, lo, count, FLOATS.pos);
    this.range(this.aVel, lo, count, FLOATS.vel);
    this.range(this.aColor0, lo, count, FLOATS.color0);
    this.range(this.aColor1, lo, count, FLOATS.color1);
    this.range(this.aParam, lo, count, FLOATS.param);
    this.range(this.aMisc, lo, count, FLOATS.misc);
    this.range(this.aExtra, lo, count, FLOATS.extra);

    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
    this.wrapped = false;
  }

  private range(
    attr: THREE.InstancedBufferAttribute,
    lo: number,
    count: number,
    itemSize: number,
  ): void {
    attr.clearUpdateRanges();
    attr.addUpdateRange(lo * itemSize, count * itemSize);
    attr.needsUpdate = true;
  }

  /** Sync the fog the batch sits in. Called once a frame by the system. */
  setFog(color: THREE.Color, density: number): void {
    (this.material.uniforms.uFogColor.value as THREE.Color).copy(color);
    this.material.uniforms.uFogDensity.value = density;
  }

  /** Global size trim — how `low` quality buys back fill rate. */
  setSizeScale(scale: number): void {
    this.material.uniforms.uSizeScale.value = scale;
  }

  /**
   * Wire a depth buffer for soft particles. Recompiles the program, so it is
   * only ever called when a post stack actually offers one.
   */
  setDepth(depth: THREE.Texture | null, near: number, far: number, width: number, height: number): void {
    const want = depth !== null;
    const has = this.material.defines.SOFT_DEPTH !== undefined;
    this.material.uniforms.uDepth.value = depth;
    (this.material.uniforms.uNearFar.value as THREE.Vector2).set(near, far);
    (this.material.uniforms.uResolution.value as THREE.Vector2).set(width, height);
    if (want === has) return;
    if (want) this.material.defines.SOFT_DEPTH = "";
    else delete this.material.defines.SOFT_DEPTH;
    this.material.needsUpdate = true;
  }

  setResolution(width: number, height: number): void {
    (this.material.uniforms.uResolution.value as THREE.Vector2).set(width, height);
  }

  /** Kill everything in flight — a restart must not rain last race's sparks. */
  clear(): void {
    this.param.fill(0);
    for (let i = 0; i < this.capacity; i++) this.param[i * 4] = -1e9;
    this.aParam.clearUpdateRanges();
    this.aParam.needsUpdate = true;
    this.cursor = 0;
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
    this.wrapped = false;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
