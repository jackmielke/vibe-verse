/**
 * vfx/trails.ts — camera-facing ribbon trails.
 *
 * Rockets, tracers, wingsuit wingtip vortices, the grapple cable's whip, ember
 * streaks. Anything that needs a *continuous* streak rather than a string of
 * billboards, because a billboard chain on something moving at 200 m/s is a
 * dotted line no matter how many you spawn.
 *
 * ## Design
 *
 * One pool, one geometry, one draw call. Each trail owns a fixed run of
 * `POINTS × 2` vertices in a shared buffer — two vertices per centreline point,
 * one on each side of the ribbon. The CPU only ever writes the *centreline*
 * (position + tangent + age); the vertex shader does the screen-facing
 * expansion:
 *
 *     side = normalize(cross(tangent, eyeToPoint)) · aSide · width
 *
 * That keeps the ribbon flat-on to the camera from every angle without the CPU
 * knowing where the camera is, and it means a trail costs 24 point-writes per
 * frame instead of 48 vertex-writes plus a cross product each.
 *
 * ## Point history
 *
 * Points are appended when the emitter has moved far enough (`minStep`), never
 * per frame — otherwise a stationary rocket piles a hundred coincident points
 * into the head of the ribbon and the tangent becomes garbage. Between
 * appends, the head point tracks the emitter continuously, so the trail stays
 * glued to the object with no visible stepping.
 *
 * A released trail keeps rendering until its last point has aged out, then
 * frees its slot. Nothing pops.
 */
import * as THREE from "three";
import type { QualityTier } from "../config";
import { frame } from "../state/store";
import { fireRampTexture, trailProfileTexture } from "./textures";

/** Centreline points per trail. 32 at 0.4 m spacing is ~12 m of ribbon. */
const POINTS = 32;
const VERTS_PER = POINTS * 2;
const TRIS_PER = (POINTS - 1) * 2;
const IDX_PER = TRIS_PER * 3;

const CAPACITY_BY_TIER: Record<QualityTier, number> = {
  low: 12,
  medium: 24,
  high: 48,
  ultra: 80,
};

/* ================================================================== *
 * Shader
 * ================================================================== */

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

uniform float uTime;

attribute vec3  aTangent;
attribute vec4  aParam;   // side(-1/1), birthTime, width, along(0..1)
attribute vec4  aColor;   // rgb, alpha
attribute vec2  aLife;    // lifetime, colourRampU0

varying vec4  vColor;
varying vec2  vUv;
varying float vFogDepth;

void main() {
  float age = uTime - aParam.y;
  float life = max(aLife.x, 1e-3);
  float k = clamp(age / life, 0.0, 1.0);

  vec3 eye = cameraPosition - position;
  vec3 tan = aTangent;
  float tl = length(tan);
  tan = tl > 1e-5 ? tan / tl : vec3(0.0, 1.0, 0.0);

  vec3 side = cross(tan, eye);
  float sl = length(side);
  // Degenerate when looking straight down the trail — fall back to any vector
  // orthogonal to the tangent so the ribbon collapses gracefully to a line
  // instead of exploding to NaN.
  side = sl > 1e-4 ? side / sl : normalize(cross(tan, vec3(0.0, 1.0, 0.0) + vec3(1e-3)));

  // Ribbons widen as they age (a rocket plume expands) and thin to nothing at
  // the very tail so there is no hard chopped-off end.
  float widen = 1.0 + k * 1.6;
  float taper = 1.0 - smoothstep(0.72, 1.0, k);
  float w = aParam.z * widen * taper;

  vec3 wpos = position + side * (aParam.x * w);
  vec4 mv = modelViewMatrix * vec4(wpos, 1.0);
  gl_Position = projectionMatrix * mv;
  vFogDepth = -mv.z;

  vUv = vec2(aParam.x * 0.5 + 0.5, mix(aLife.y, 1.0, k));
  vColor = vec4(aColor.rgb, aColor.a * (1.0 - k) * step(0.0, age));

  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform sampler2D uProfile;   // 1D cross-section alpha
uniform sampler2D uRamp;      // 1D colour-over-age ramp
uniform float uRampMix;       // 0 = pure tint, 1 = pure ramp
uniform vec3  uFogColor;
uniform vec2  uFogRange;
uniform float uFogMode;

varying vec4  vColor;
varying vec2  vUv;
varying float vFogDepth;

void main() {
  #include <logdepthbuf_fragment>
  float profile = texture2D(uProfile, vec2(vUv.x, 0.5)).a;
  vec3 ramp = texture2D(uRamp, vec2(vUv.y, 0.5)).rgb;
  vec3 rgb = mix(vColor.rgb, vColor.rgb * ramp * 2.2, uRampMix);
  float a = profile * vColor.a;
  if (a < 0.004) discard;

  float fogF = smoothstep(uFogRange.x, uFogRange.y, vFogDepth);
  if (uFogMode > 0.5) { rgb *= (1.0 - fogF); a *= (1.0 - fogF * 0.85); }
  else { rgb = mix(rgb, uFogColor, fogF); }

  gl_FragColor = vec4(rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ================================================================== *
 * Public options
 * ================================================================== */

export interface TrailOptions {
  /** Ribbon half-width at the head, metres. */
  width: number;
  /** Seconds a point survives after it is laid down. */
  life: number;
  /** Minimum distance between laid points, metres. Smaller = smoother curve. */
  minStep?: number;
  r?: number; g?: number; b?: number; a?: number;
  /** 0 uses the tint alone; 1 maps age through the fire ramp. */
  ramp?: number;
  /** Additive for anything glowing; alpha for smoke and vapour. */
  additive?: boolean;
}

/** Opaque, generation-tagged handle. Stale handles are safe — they no-op. */
export type TrailHandle = number;

const SLOT_BITS = 12;
const SLOT_MASK = (1 << SLOT_BITS) - 1;

interface TrailSlot {
  index: number;
  gen: number;
  active: boolean;
  /** Released trails stop accepting points but keep rendering until empty. */
  releasing: boolean;
  count: number;
  headX: number; headY: number; headZ: number;
  lastX: number; lastY: number; lastZ: number;
  opts: Required<TrailOptions>;
  additive: boolean;
  /** Sim time of the oldest live point, for cheap expiry checks. */
  oldest: number;
}

const DEFAULT_OPTS: Required<TrailOptions> = {
  width: 0.35, life: 1.2, minStep: 0.5,
  r: 1, g: 1, b: 1, a: 1, ramp: 0, additive: true,
};

class TrailPool {
  readonly group = new THREE.Group();
  private geoAdd: THREE.BufferGeometry | null = null;
  private geoAlpha: THREE.BufferGeometry | null = null;
  private matAdd: THREE.ShaderMaterial | null = null;
  private matAlpha: THREE.ShaderMaterial | null = null;
  private slots: TrailSlot[] = [];
  private capacity = 0;
  private started = false;

  // One buffer set per blend mode. A trail lives in exactly one of them, and
  // the other's slots are simply zero-width — cheaper than re-indexing.
  private bufs: Record<"add" | "alpha", {
    pos: THREE.BufferAttribute;
    tan: THREE.BufferAttribute;
    par: THREE.BufferAttribute;
    col: THREE.BufferAttribute;
    lif: THREE.BufferAttribute;
  }> | null = null;

  constructor() {
    this.group.name = "vfx-trails";
  }

  init(tier: QualityTier): void {
    if (this.started) return;
    this.capacity = CAPACITY_BY_TIER[tier] ?? 48;
    const cap = this.capacity;

    const build = (additive: boolean) => {
      const g = new THREE.BufferGeometry();
      const pos = new THREE.BufferAttribute(new Float32Array(cap * VERTS_PER * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const tan = new THREE.BufferAttribute(new Float32Array(cap * VERTS_PER * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const par = new THREE.BufferAttribute(new Float32Array(cap * VERTS_PER * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const col = new THREE.BufferAttribute(new Float32Array(cap * VERTS_PER * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const lif = new THREE.BufferAttribute(new Float32Array(cap * VERTS_PER * 2), 2).setUsage(THREE.DynamicDrawUsage);
      const idx = new Uint32Array(cap * IDX_PER);
      for (let t = 0; t < cap; t++) {
        const vb = t * VERTS_PER;
        let k = t * IDX_PER;
        for (let i = 0; i < POINTS - 1; i++) {
          const a = vb + i * 2, b = a + 1, c = a + 2, d = a + 3;
          idx[k++] = a; idx[k++] = c; idx[k++] = b;
          idx[k++] = b; idx[k++] = c; idx[k++] = d;
        }
        // Side sign is fixed per vertex and never rewritten.
        for (let i = 0; i < POINTS; i++) {
          par.array[(vb + i * 2) * 4] = -1;
          par.array[(vb + i * 2 + 1) * 4] = 1;
        }
      }
      g.setAttribute("position", pos);
      g.setAttribute("aTangent", tan);
      g.setAttribute("aParam", par);
      g.setAttribute("aColor", col);
      g.setAttribute("aLife", lif);
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

      const m = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uTime: { value: 0 },
          uProfile: { value: trailProfileTexture() },
          uRamp: { value: fireRampTexture() },
          uRampMix: { value: 1 },
          uFogColor: { value: new THREE.Color(0xb9c8d4) },
          uFogRange: { value: new THREE.Vector2(400, 9000) },
          uFogMode: { value: additive ? 1 : 0 },
        },
        transparent: true,
        depthTest: true,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        side: THREE.DoubleSide,
        toneMapped: true,
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = additive ? 3035 : 3015;
      mesh.matrixAutoUpdate = false;
      mesh.name = additive ? "vfx-trails-add" : "vfx-trails-alpha";
      this.group.add(mesh);
      return { g, m, pos, tan, par, col, lif };
    };

    const a = build(true);
    const b = build(false);
    this.geoAdd = a.g; this.matAdd = a.m;
    this.geoAlpha = b.g; this.matAlpha = b.m;
    this.bufs = {
      add: { pos: a.pos, tan: a.tan, par: a.par, col: a.col, lif: a.lif },
      alpha: { pos: b.pos, tan: b.tan, par: b.par, col: b.col, lif: b.lif },
    };
    a.g.setDrawRange(0, 0);
    b.g.setDrawRange(0, 0);

    this.slots = [];
    for (let i = 0; i < cap; i++) {
      this.slots.push({
        index: i, gen: 1, active: false, releasing: false, count: 0,
        headX: 0, headY: 0, headZ: 0, lastX: 0, lastY: 0, lastZ: 0,
        opts: { ...DEFAULT_OPTS }, additive: true, oldest: 0,
      });
    }
    this.started = true;
  }

  private slotOf(h: TrailHandle): TrailSlot | null {
    const i = h & SLOT_MASK;
    const gen = h >>> SLOT_BITS;
    const s = this.slots[i];
    if (!s || s.gen !== gen || !s.active) return null;
    return s;
  }

  /**
   * Claim a trail. Returns -1 when the pool is exhausted; callers must treat
   * that as "no trail this time", not as an error — a rocket without a ribbon
   * is still a rocket.
   */
  acquire(x: number, y: number, z: number, opts: TrailOptions): TrailHandle {
    if (!this.started) return -1;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.slots[i];
      if (s.active) continue;
      s.active = true;
      s.releasing = false;
      s.gen = (s.gen + 1) & ((1 << (31 - SLOT_BITS)) - 1) || 1;
      s.count = 0;
      s.opts = { ...DEFAULT_OPTS, ...opts };
      s.additive = s.opts.additive;
      s.headX = s.lastX = x;
      s.headY = s.lastY = y;
      s.headZ = s.lastZ = z;
      s.oldest = frame.time;
      this.clearSlot(s);
      // Seed with two coincident points so the very first frame already has a
      // valid tangent instead of a one-frame flicker.
      this.push(s, x, y, z, true);
      this.push(s, x, y, z, true);
      this.growDrawRange(s);
      return ((s.gen << SLOT_BITS) | s.index) >>> 0;
    }
    return -1;
  }

  /** Move a trail's head. Call once per frame per live emitter. */
  move(h: TrailHandle, x: number, y: number, z: number): void {
    const s = this.slotOf(h);
    if (!s || s.releasing) return;
    s.headX = x; s.headY = y; s.headZ = z;
    const dx = x - s.lastX, dy = y - s.lastY, dz = z - s.lastZ;
    const step = s.opts.minStep;
    if (dx * dx + dy * dy + dz * dz >= step * step) {
      this.push(s, x, y, z, false);
      s.lastX = x; s.lastY = y; s.lastZ = z;
    } else {
      // Between appends the newest point tracks the emitter so the ribbon
      // stays attached; only its birth time is left alone.
      this.setPoint(s, s.count - 1, x, y, z, this.pointBirth(s, s.count - 1));
      this.retangent(s);
    }
  }

  /** Stop feeding a trail; it fades out and frees itself. */
  release(h: TrailHandle): void {
    const s = this.slotOf(h);
    if (!s) return;
    s.releasing = true;
  }

  /** Kill a trail immediately — for a rocket that detonated. */
  kill(h: TrailHandle): void {
    const s = this.slotOf(h);
    if (!s) return;
    this.clearSlot(s);
    s.active = false;
    s.releasing = false;
  }

  private buf(s: TrailSlot) {
    return this.bufs![s.additive ? "add" : "alpha"];
  }

  private pointBirth(s: TrailSlot, i: number): number {
    if (i < 0) return frame.time;
    const b = this.buf(s);
    const vi = (s.index * VERTS_PER + i * 2) * 4;
    return (b.par.array as Float32Array)[vi + 1];
  }

  private setPoint(s: TrailSlot, i: number, x: number, y: number, z: number, born: number): void {
    if (i < 0 || i >= POINTS) return;
    const b = this.buf(s);
    const base = s.index * VERTS_PER + i * 2;
    const pos = b.pos.array as Float32Array;
    const par = b.par.array as Float32Array;
    for (let k = 0; k < 2; k++) {
      const v = base + k;
      pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
      par[v * 4 + 1] = born;
      par[v * 4 + 2] = s.opts.width;
      par[v * 4 + 3] = i / (POINTS - 1);
    }
    b.pos.needsUpdate = true;
    b.par.needsUpdate = true;
  }

  /** Append a point, shifting the history down when the ribbon is full. */
  private push(s: TrailSlot, x: number, y: number, z: number, seeding: boolean): void {
    const b = this.buf(s);
    const pos = b.pos.array as Float32Array;
    const par = b.par.array as Float32Array;
    const col = b.col.array as Float32Array;
    const lif = b.lif.array as Float32Array;
    const base = s.index * VERTS_PER;

    if (s.count >= POINTS) {
      // Shift everything down one point. 32 points × 2 verts × 3 floats is
      // 192 float moves — trivial, and it keeps index buffers static.
      for (let i = 0; i < POINTS - 1; i++) {
        const dst = (base + i * 2) * 3;
        const src = (base + (i + 1) * 2) * 3;
        for (let k = 0; k < 6; k++) pos[dst + k] = pos[src + k];
        const dp = (base + i * 2) * 4;
        const sp = (base + (i + 1) * 2) * 4;
        par[dp + 1] = par[sp + 1]; par[dp + 5] = par[sp + 5];
        par[dp + 2] = par[sp + 2]; par[dp + 6] = par[sp + 6];
      }
      s.count = POINTS - 1;
    }

    const i = s.count++;
    const now = frame.time;
    this.setPoint(s, i, x, y, z, now);

    // Colour/lifetime are constant per trail but must be present on every
    // vertex; writing them on push costs nothing and avoids a uniform per
    // trail (which would mean a draw call per trail).
    const o = s.opts;
    for (let p = 0; p < POINTS; p++) {
      for (let k = 0; k < 2; k++) {
        const v = base + p * 2 + k;
        col[v * 4] = o.r; col[v * 4 + 1] = o.g; col[v * 4 + 2] = o.b; col[v * 4 + 3] = o.a;
        lif[v * 2] = o.life;
        lif[v * 2 + 1] = 0;
      }
    }
    b.col.needsUpdate = true;
    b.lif.needsUpdate = true;

    if (!seeding) this.retangent(s);
  }

  /** Recompute per-point tangents from neighbours (central difference). */
  private retangent(s: TrailSlot): void {
    const b = this.buf(s);
    const pos = b.pos.array as Float32Array;
    const tan = b.tan.array as Float32Array;
    const base = s.index * VERTS_PER;
    const n = s.count;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const c = Math.min(n - 1, i + 1);
      const va = (base + a * 2) * 3;
      const vc = (base + c * 2) * 3;
      const dx = pos[vc] - pos[va];
      const dy = pos[vc + 1] - pos[va + 1];
      const dz = pos[vc + 2] - pos[va + 2];
      const v0 = (base + i * 2) * 3;
      const v1 = (base + i * 2 + 1) * 3;
      tan[v0] = dx; tan[v0 + 1] = dy; tan[v0 + 2] = dz;
      tan[v1] = dx; tan[v1 + 1] = dy; tan[v1 + 2] = dz;
    }
    b.tan.needsUpdate = true;
  }

  private clearSlot(s: TrailSlot): void {
    if (!this.bufs) return;
    for (const key of ["add", "alpha"] as const) {
      const b = this.bufs[key];
      const col = b.col.array as Float32Array;
      const base = s.index * VERTS_PER;
      for (let v = base; v < base + VERTS_PER; v++) col[v * 4 + 3] = 0;
      b.col.needsUpdate = true;
    }
    s.count = 0;
  }

  private growDrawRange(s: TrailSlot): void {
    const g = s.additive ? this.geoAdd : this.geoAlpha;
    if (!g) return;
    const need = (s.index + 1) * IDX_PER;
    if (g.drawRange.count < need) g.setDrawRange(0, need);
  }

  /**
   * Retire trails whose oldest point has aged out. Trails that are still being
   * fed need no work here at all — the shader does their ageing.
   */
  update(fog: THREE.Fog | THREE.FogExp2 | null): void {
    if (!this.started) return;
    const now = frame.time;
    for (const s of this.slots) {
      if (!s.active) continue;
      if (s.releasing) {
        const newest = this.pointBirth(s, s.count - 1);
        if (now - newest > s.opts.life) {
          this.clearSlot(s);
          s.active = false;
          s.releasing = false;
        }
      }
    }
    for (const m of [this.matAdd, this.matAlpha]) {
      if (!m) continue;
      m.uniforms.uTime.value = now;
      if (fog instanceof THREE.Fog) (m.uniforms.uFogRange.value as THREE.Vector2).set(fog.near, fog.far);
      if (fog && "color" in fog) (m.uniforms.uFogColor.value as THREE.Color).copy(fog.color);
    }
  }

  get liveCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.active) n++;
    return n;
  }

  clear(): void {
    for (const s of this.slots) {
      if (!s.active) continue;
      this.clearSlot(s);
      s.active = false;
      s.releasing = false;
    }
  }

  dispose(): void {
    this.geoAdd?.dispose();
    this.geoAlpha?.dispose();
    this.matAdd?.dispose();
    this.matAlpha?.dispose();
    this.group.clear();
    this.geoAdd = this.geoAlpha = null;
    this.matAdd = this.matAlpha = null;
    this.bufs = null;
    this.slots = [];
    this.started = false;
  }
}

export const trails = new TrailPool();

/* ================================================================== *
 * Presets
 * ================================================================== */

/** A rocket's white-hot plume. Additive, wide, short-lived, ramped. */
export function rocketTrail(x: number, y: number, z: number): TrailHandle {
  return trails.acquire(x, y, z, {
    width: 0.5, life: 0.9, minStep: 0.9,
    r: 1.0, g: 0.72, b: 0.38, a: 0.9, ramp: 1, additive: true,
  });
}

/** A tracer round: thin, very short, very bright. */
export function tracerTrail(x: number, y: number, z: number): TrailHandle {
  return trails.acquire(x, y, z, {
    width: 0.055, life: 0.11, minStep: 2.2,
    r: 1.0, g: 0.78, b: 0.4, a: 1, ramp: 0, additive: true,
  });
}

/**
 * Wingtip vortex. Alpha-blended white vapour, not additive — a vortex is
 * condensation, and additive condensation looks like a laser.
 */
export function wingtipTrail(x: number, y: number, z: number): TrailHandle {
  return trails.acquire(x, y, z, {
    width: 0.16, life: 1.5, minStep: 1.1,
    r: 1, g: 1, b: 1, a: 0.42, ramp: 0, additive: false,
  });
}

/** The faint whip a grapple cable leaves as it snaps taut. */
export function grappleTrail(x: number, y: number, z: number): TrailHandle {
  return trails.acquire(x, y, z, {
    width: 0.09, life: 0.32, minStep: 1.4,
    r: 0.72, g: 0.84, b: 1.0, a: 0.55, ramp: 0, additive: true,
  });
}

/** Thin dark smoke off a burning vehicle or a wounded helicopter. */
export function smokeTrail(x: number, y: number, z: number): TrailHandle {
  return trails.acquire(x, y, z, {
    width: 1.1, life: 3.2, minStep: 1.6,
    r: 0.14, g: 0.13, b: 0.13, a: 0.5, ramp: 0, additive: false,
  });
}

/** A high-altitude contrail. Very long-lived, very thin, pure white. */
export function contrail(x: number, y: number, z: number): TrailHandle {
  return trails.acquire(x, y, z, {
    width: 2.2, life: 9, minStep: 24,
    r: 1, g: 1, b: 1, a: 0.32, ramp: 0, additive: false,
  });
}
