/**
 * weapons/particles.ts — one instanced, CPU-simulated quad pool.
 *
 * Every particle the weapons stack spawns — muzzle smoke, impact dust, sparks,
 * blood, splinters, water spray — comes out of one of two instances of this
 * class (an additive one and an alpha one). That is two draw calls for the
 * entire gunplay particle budget.
 *
 * Why CPU simulation rather than a GPU solver: these particles need to know
 * about the ground plane, the wind vector and per-surface drag, they die in
 * the low thousands rather than the millions, and the moment a designer wants
 * "sparks that bounce off the floor" a transform-feedback system becomes a
 * research project. A flat Float32Array sim of 2 000 quads costs well under a
 * millisecond and can do whatever we want.
 *
 * Layout is struct-of-arrays: one typed array per property. Interleaving them
 * into a single buffer would be marginally more cache-friendly for the write
 * pass but would make every field access an offset computation, and this is
 * already not the bottleneck.
 *
 * Public API
 * ----------
 *   ParticlePool(capacity, texture, additive)
 *   .mesh  .emit(spec)  .update(dt, windX, windZ)  .clear()  .dispose()
 *   pspec   shared scratch descriptor — fill it, then emit
 */
import * as THREE from "three";

export interface ParticleSpec {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Seconds. */
  life: number;
  /** Metres, at birth and at death — interpolated. */
  size: number;
  sizeEnd: number;
  r: number; g: number; b: number;
  /** Peak alpha. The fade curve is fixed: fast in, slow out. */
  alpha: number;
  /** Radians and radians/second. */
  rot: number;
  spin: number;
  /** Per-second velocity damping, 0 = none. */
  drag: number;
  /** Metres/second². Negative falls. */
  gravity: number;
  /** 0..3 atlas tile. */
  tile: number;
  /** 0..1 how much the wind pushes it. Smoke 1, sparks 0. */
  windPull: number;
  /** Metres. Below this height above the spawn plane the particle sticks. */
  floor: number;
  /** Fraction of the life spent fading in. */
  fadeIn: number;
  /** Stretch along velocity — 0 round, 1 fully elongated (sparks). */
  stretch: number;
}

/** Shared scratch: fill and emit, never allocate a spec per particle. */
export const pspec: ParticleSpec = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
  life: 1, size: 0.2, sizeEnd: 0.4,
  r: 1, g: 1, b: 1, alpha: 1,
  rot: 0, spin: 0, drag: 1, gravity: -9.8,
  tile: 0, windPull: 0, floor: -1e9, fadeIn: 0.08, stretch: 0,
};

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aPos;
attribute vec3 aVel;
attribute float aSize;
attribute float aRot;
attribute vec3 aColor;
attribute float aAlpha;
attribute float aTile;
attribute float aStretch;

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);

  vec2 corner = position.xy * aSize;

  // Stretch along the view-space velocity. Screen-space elongation is the
  // standard cheat for tracer-like sparks and is stable except when the
  // particle flies directly at the camera, where the length collapses —
  // which is exactly what a real streak does too.
  if (aStretch > 0.001) {
    vec3 v = (modelViewMatrix * vec4(aVel, 0.0)).xyz;
    vec2 dir = length(v.xy) > 1e-5 ? normalize(v.xy) : vec2(0.0, 1.0);
    vec2 perp = vec2(-dir.y, dir.x);
    float len = 1.0 + aStretch * min(length(aVel) * 0.06, 16.0);
    corner = dir * (position.y * aSize * len) + perp * (position.x * aSize);
  } else {
    float c = cos(aRot);
    float s = sin(aRot);
    corner = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
  }

  mv.xy += corner;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>

  // 2x2 atlas.
  float col = mod(aTile, 2.0);
  float row = floor(aTile * 0.5);
  vUv = uv * 0.5 + vec2(col * 0.5, row * 0.5);
  vColor = aColor;
  vAlpha = aAlpha;
}
`;

const FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;

void main() {
  #include <logdepthbuf_fragment>
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(t.rgb * vColor, a);

  // Custom ShaderMaterials still get three's tone-mapping and output-colour
  // prefixes, and they must use them: a particle that skips the encode is a
  // different colour from every lit surface next to it.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class ParticlePool {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private cap: number;

  /* ---- simulation state ---- */
  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private rot: Float32Array;
  private spin: Float32Array;
  private cr: Float32Array;
  private cg: Float32Array;
  private cb: Float32Array;
  private a0: Float32Array;
  private drag: Float32Array;
  private grav: Float32Array;
  private wind: Float32Array;
  private floorY: Float32Array;
  private fadeIn: Float32Array;
  private stretch: Float32Array;
  private tile: Float32Array;

  /* ---- render attributes ---- */
  private aPos: THREE.InstancedBufferAttribute;
  private aVel: THREE.InstancedBufferAttribute;
  private aSize: THREE.InstancedBufferAttribute;
  private aRot: THREE.InstancedBufferAttribute;
  private aColor: THREE.InstancedBufferAttribute;
  private aAlpha: THREE.InstancedBufferAttribute;
  private aTile: THREE.InstancedBufferAttribute;
  private aStretch: THREE.InstancedBufferAttribute;

  /** Ring cursor. Oldest particle is overwritten when the pool is full. */
  private cursor = 0;
  /** High-water mark of live instances, so we never draw empty slots. */
  live = 0;

  constructor(capacity: number, texture: THREE.Texture, additive: boolean, renderOrder = 10) {
    this.cap = capacity;
    const n = capacity;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.age = new Float32Array(n).fill(1e9);
    this.life = new Float32Array(n).fill(1);
    this.s0 = new Float32Array(n);
    this.s1 = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.spin = new Float32Array(n);
    this.cr = new Float32Array(n);
    this.cg = new Float32Array(n);
    this.cb = new Float32Array(n);
    this.a0 = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.wind = new Float32Array(n);
    this.floorY = new Float32Array(n).fill(-1e9);
    this.fadeIn = new Float32Array(n).fill(0.08);
    this.stretch = new Float32Array(n);
    this.tile = new Float32Array(n);

    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;
    geo.attributes.uv = base.attributes.uv;
    base.dispose();

    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.aRot = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aAlpha = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.aTile = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.aStretch = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    for (const a of [this.aPos, this.aVel, this.aSize, this.aRot, this.aColor, this.aAlpha, this.aTile, this.aStretch]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    geo.setAttribute("aPos", this.aPos);
    geo.setAttribute("aVel", this.aVel);
    geo.setAttribute("aSize", this.aSize);
    geo.setAttribute("aRot", this.aRot);
    geo.setAttribute("aColor", this.aColor);
    geo.setAttribute("aAlpha", this.aAlpha);
    geo.setAttribute("aTile", this.aTile);
    geo.setAttribute("aStretch", this.aStretch);
    geo.instanceCount = 0;

    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: texture } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: true,
    });

    this.geo = geo;
    this.mat = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false; // instances live anywhere in the city
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false;
  }

  /** Spawn one particle from the shared `pspec`. */
  emit(s: ParticleSpec = pspec): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.cap;
    this.px[i] = s.x; this.py[i] = s.y; this.pz[i] = s.z;
    this.vx[i] = s.vx; this.vy[i] = s.vy; this.vz[i] = s.vz;
    this.age[i] = 0;
    this.life[i] = Math.max(0.02, s.life);
    this.s0[i] = s.size;
    this.s1[i] = s.sizeEnd;
    this.rot[i] = s.rot;
    this.spin[i] = s.spin;
    this.cr[i] = s.r; this.cg[i] = s.g; this.cb[i] = s.b;
    this.a0[i] = s.alpha;
    this.drag[i] = s.drag;
    this.grav[i] = s.gravity;
    this.wind[i] = s.windPull;
    this.floorY[i] = s.floor;
    this.fadeIn[i] = s.fadeIn;
    this.stretch[i] = s.stretch;
    this.tile[i] = s.tile;
    if (i >= this.live) this.live = i + 1;
  }

  /**
   * Integrate and upload.
   *
   * One pass, no branching beyond the dead test. Dead particles get their
   * alpha zeroed rather than being compacted out: compaction would reorder the
   * buffer every frame and cost more than the handful of degenerate quads the
   * GPU rejects instantly.
   */
  update(dt: number, windX: number, windZ: number): void {
    const n = this.live;
    if (n === 0) return;
    const pos = this.aPos.array as Float32Array;
    const vel = this.aVel.array as Float32Array;
    const size = this.aSize.array as Float32Array;
    const rot = this.aRot.array as Float32Array;
    const col = this.aColor.array as Float32Array;
    const alp = this.aAlpha.array as Float32Array;
    const til = this.aTile.array as Float32Array;
    const str = this.aStretch.array as Float32Array;

    let anyAlive = false;
    for (let i = 0; i < n; i++) {
      const age = this.age[i];
      const life = this.life[i];
      if (age >= life) {
        alp[i] = 0;
        continue;
      }
      const na = age + dt;
      this.age[i] = na;
      anyAlive = true;

      let vX = this.vx[i];
      let vY = this.vy[i];
      let vZ = this.vz[i];

      const d = this.drag[i];
      if (d > 0) {
        const k = Math.exp(-d * dt);
        vX *= k; vY *= k; vZ *= k;
      }
      vY += this.grav[i] * dt;
      const w = this.wind[i];
      if (w > 0) {
        vX += (windX - vX) * w * dt;
        vZ += (windZ - vZ) * w * dt;
      }

      let x = this.px[i] + vX * dt;
      let y = this.py[i] + vY * dt;
      let z = this.pz[i] + vZ * dt;

      // Ground contact: settle rather than fall through. Sparks that reach
      // the floor skitter; smoke just stops descending.
      const f = this.floorY[i];
      if (y < f) {
        y = f;
        if (vY < 0) {
          vY = -vY * 0.28;
          vX *= 0.55;
          vZ *= 0.55;
          if (Math.abs(vY) < 0.4) vY = 0;
        }
      }

      this.px[i] = x; this.py[i] = y; this.pz[i] = z;
      this.vx[i] = vX; this.vy[i] = vY; this.vz[i] = vZ;
      this.rot[i] += this.spin[i] * dt;

      const t = na / life;
      // Fast attack, long decay — the shape of every real particle fade.
      const fi = this.fadeIn[i];
      let fade: number;
      if (t < fi) {
        fade = t / Math.max(1e-4, fi);
      } else {
        const k = 1 - (t - fi) / Math.max(1e-4, 1 - fi);
        fade = k * k * (3 - 2 * k); // smooth tail, no linear pop at death
      }
      const a = this.a0[i] * (fade > 0 ? fade : 0);

      const i3 = i * 3;
      pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
      vel[i3] = vX; vel[i3 + 1] = vY; vel[i3 + 2] = vZ;
      col[i3] = this.cr[i]; col[i3 + 1] = this.cg[i]; col[i3 + 2] = this.cb[i];
      size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      rot[i] = this.rot[i];
      alp[i] = a;
      til[i] = this.tile[i];
      str[i] = this.stretch[i];
    }

    this.geo.instanceCount = n;
    this.aPos.needsUpdate = true;
    this.aVel.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aRot.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aAlpha.needsUpdate = true;
    this.aTile.needsUpdate = true;
    this.aStretch.needsUpdate = true;

    // Shrink the drawn range once everything has died, so an idle scene costs
    // an empty draw rather than 2 000 discarded quads.
    if (!anyAlive) {
      this.live = 0;
      this.geo.instanceCount = 0;
      this.cursor = 0;
    }
  }

  clear(): void {
    this.age.fill(1e9);
    this.live = 0;
    this.cursor = 0;
    this.geo.instanceCount = 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
