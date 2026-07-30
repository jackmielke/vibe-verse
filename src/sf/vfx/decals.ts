/**
 * vfx/decals.ts — projected decals: scorch, bullet holes, blood, oil, tyre
 * marks, graffiti.
 *
 * ## Why this is a vertex pool and not an InstancedMesh
 *
 * The obvious implementation — one InstancedMesh of quads — breaks the moment
 * a scorch mark lands on one of San Francisco's hills. A flat 10 m quad on a
 * 20° slope either floats a metre off the ground at one edge or buries itself
 * at the other, and no amount of depth bias hides that.
 *
 * So each decal is a small **conforming patch**: a 4×4 vertex grid whose
 * vertices are individually projected onto the surface. Ground decals sample
 * `walkableHeight` from `sfGeo` — the same function the player walks on, so the
 * decal and the collision surface cannot disagree. Surface decals (walls,
 * vehicles) are planar about the impact normal, which is correct because the
 * surface they landed on is planar.
 *
 * All patches live in one dynamic BufferGeometry: 256 decals × 16 vertices is
 * 4 096 vertices and one draw call. Spawning writes 16 vertices; nothing is
 * touched per frame, because ageing is done in the shader from a per-vertex
 * birth time.
 *
 * ## Normal clipping
 *
 * A projected decal must not wrap over a cliff edge or a kerb. Each vertex
 * compares the *local* surface normal against the decal's projection axis and
 * multiplies its own alpha by the agreement. A blood splat that reaches the
 * lip of a stair fades out at the lip instead of smearing down the riser.
 */
import * as THREE from "three";
import type { QualityTier } from "../config";
import { frame } from "../state/store";
import { clamp01, makeRng, type Rng } from "../math/rng";
import { terrainNormal, walkableHeight } from "../geo/sfGeo";
import { Decal, decalAtlas, decalTilePxForTier, type DecalIndex } from "./textures";

/* ================================================================== *
 * Geometry layout
 * ================================================================== */

/** Patch subdivision. 3 → a 4×4 vertex grid, 18 triangles. */
const SUB = 3;
const VERTS_PER = (SUB + 1) * (SUB + 1);
const TRIS_PER = SUB * SUB * 2;
const IDX_PER = TRIS_PER * 3;

const CAPACITY_BY_TIER: Record<QualityTier, number> = {
  low: 96,
  medium: 192,
  high: 320,
  ultra: 512,
};

/* ================================================================== *
 * Shader
 * ================================================================== */

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

uniform float uTime;
uniform vec2  uAtlas;

attribute vec4 aTile;    // tileIndex, birthTime, lifetime, fadeIn
attribute vec4 aColor;   // rgb tint, base alpha

varying vec2  vUv;
varying vec4  vColor;
varying float vFogDepth;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vFogDepth = -mv.z;

  float cols = uAtlas.x, rows = uAtlas.y;
  float idx = mod(aTile.x, cols * rows);
  vec2 tile = vec2(mod(idx, cols), floor(idx / cols));
  vUv = (uv + vec2(tile.x, rows - 1.0 - tile.y)) / uAtlas;

  // Ageing in the shader: the CPU writes birth + lifetime once and never
  // touches the decal again. A permanent decal passes lifetime < 0.
  float age = uTime - aTile.y;
  float fade = 1.0;
  if (aTile.z > 0.0) {
    fade = 1.0 - smoothstep(aTile.z * 0.62, aTile.z, age);
  }
  fade *= smoothstep(0.0, max(aTile.w, 1e-3), age);
  vColor = vec4(aColor.rgb, aColor.a * fade);

  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform sampler2D uMap;
uniform vec3 uFogColor;
uniform vec2 uFogRange;

varying vec2  vUv;
varying vec4  vColor;
varying float vFogDepth;

void main() {
  #include <logdepthbuf_fragment>
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vColor.a;
  if (a < 0.006) discard;
  vec3 rgb = tex.rgb * vColor.rgb;
  rgb = mix(rgb, uFogColor, smoothstep(uFogRange.x, uFogRange.y, vFogDepth));
  gl_FragColor = vec4(rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ================================================================== *
 * Options
 * ================================================================== */

export interface DecalOptions {
  /** Atlas tile. */
  tile: DecalIndex | number;
  /** Half-size on the ground/surface, metres. */
  size: number;
  /** Rotation about the projection axis, radians. Random if omitted. */
  rotation?: number;
  /** Seconds until fully faded. <= 0 means permanent (until recycled). */
  lifetime?: number;
  /** Seconds to fade in. Blood and oil spread; scorch appears instantly. */
  fadeIn?: number;
  /** Tint multiplied into the atlas colour. */
  r?: number; g?: number; b?: number;
  /** Peak opacity. */
  opacity?: number;
  /**
   * Projection axis. Omit for a ground decal (projects straight down and
   * conforms to the terrain); supply the surface normal for a wall decal.
   */
  nx?: number; ny?: number; nz?: number;
  /**
   * Cosine threshold for normal clipping. 0.35 (default) lets a decal wrap a
   * gentle kerb but cuts it off at a wall.
   */
  clip?: number;
  /** Priority 0..2 — higher survives recycling longer. Scorches are 2. */
  priority?: number;
}

/* ================================================================== *
 * Pool
 * ================================================================== */

interface Slot {
  index: number;
  /** Sim time this slot was written. Oldest low-priority slot recycles first. */
  born: number;
  dies: number;
  priority: number;
  used: boolean;
}

const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();

class DecalSystem {
  readonly mesh = new THREE.Mesh();
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private pos!: THREE.BufferAttribute;
  private uv!: THREE.BufferAttribute;
  private tile!: THREE.BufferAttribute;
  private color!: THREE.BufferAttribute;
  private slots: Slot[] = [];
  private capacity = 0;
  private cursor = 0;
  private started = false;
  private rng: Rng = makeRng("sf-vfx-decals-runtime");
  /** Height sampler; swapped by the world so decals sit on roads, not dirt. */
  private groundHeight: (x: number, z: number) => number = walkableHeight;

  init(tier: QualityTier, tilePx = decalTilePxForTier(tier)): void {
    if (this.started) return;
    this.capacity = CAPACITY_BY_TIER[tier] ?? 320;
    const cap = this.capacity;
    const g = new THREE.BufferGeometry();
    const position = new Float32Array(cap * VERTS_PER * 3);
    const uv = new Float32Array(cap * VERTS_PER * 2);
    const tileA = new Float32Array(cap * VERTS_PER * 4);
    const colorA = new Float32Array(cap * VERTS_PER * 4);
    const index = new Uint32Array(cap * IDX_PER);

    // Index buffer and UVs never change — bake them once.
    for (let d = 0; d < cap; d++) {
      const vbase = d * VERTS_PER;
      const ibase = d * IDX_PER;
      let k = 0;
      for (let y = 0; y < SUB; y++) {
        for (let x = 0; x < SUB; x++) {
          const a = vbase + y * (SUB + 1) + x;
          const b = a + 1;
          const c = a + (SUB + 1);
          const e = c + 1;
          index[ibase + k++] = a; index[ibase + k++] = c; index[ibase + k++] = b;
          index[ibase + k++] = b; index[ibase + k++] = c; index[ibase + k++] = e;
        }
      }
      for (let y = 0; y <= SUB; y++) {
        for (let x = 0; x <= SUB; x++) {
          const v = vbase + y * (SUB + 1) + x;
          uv[v * 2] = x / SUB;
          uv[v * 2 + 1] = y / SUB;
        }
      }
    }

    this.pos = new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage);
    this.uv = new THREE.BufferAttribute(uv, 2);
    this.tile = new THREE.BufferAttribute(tileA, 4).setUsage(THREE.DynamicDrawUsage);
    this.color = new THREE.BufferAttribute(colorA, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", this.pos);
    g.setAttribute("uv", this.uv);
    g.setAttribute("aTile", this.tile);
    g.setAttribute("aColor", this.color);
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    const m = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uMap: { value: decalAtlas(tilePx) },
        uTime: { value: 0 },
        uAtlas: { value: new THREE.Vector2(4, 4) },
        uFogColor: { value: new THREE.Color(0xb9c8d4) },
        uFogRange: { value: new THREE.Vector2(400, 9000) },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      // Decals are coplanar with the surface they sit on by construction, so
      // they need both a polygon offset and a small geometric lift. Offset
      // alone is not enough on a log-depth buffer at 4 km.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      side: THREE.DoubleSide,
      toneMapped: true,
    });

    this.mesh.geometry = g;
    this.mesh.material = m;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1500;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = "vfx-decals";
    this.geometry = g;
    this.material = m;

    this.slots = [];
    for (let i = 0; i < cap; i++) {
      this.slots.push({ index: i, born: -1e9, dies: -1e9, priority: 0, used: false });
    }
    // Nothing is drawn until something spawns.
    g.setDrawRange(0, 0);
    this.started = true;
  }

  /**
   * Override the ground sampler. The street system knows about kerb and
   * roadway heights that raw terrain does not; if it registers here, tyre
   * marks land on tarmac instead of one centimetre inside it.
   */
  setGroundSampler(fn: (x: number, z: number) => number): void {
    this.groundHeight = fn;
  }

  private pickSlot(now: number): Slot | null {
    // Prefer a genuinely free slot, then the oldest expired one, then the
    // oldest low-priority live one. Scanning `capacity` entries is fine; this
    // runs a handful of times per second, not per frame.
    let free: Slot | null = null;
    let victim: Slot | null = null;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.slots[(this.cursor + i) % this.capacity];
      if (!s.used || (s.dies > 0 && s.dies <= now)) {
        free = s;
        break;
      }
      if (!victim || s.priority < victim.priority ||
          (s.priority === victim.priority && s.born < victim.born)) {
        victim = s;
      }
    }
    const chosen = free ?? victim;
    if (chosen) this.cursor = (chosen.index + 1) % this.capacity;
    return chosen;
  }

  /**
   * Place a decal. Returns false when the system is not initialised (which is
   * a legitimate state — weapons can fire before the VFX root has mounted).
   */
  spawn(x: number, y: number, z: number, o: DecalOptions): boolean {
    if (!this.started || !this.geometry) return false;
    const now = frame.time;
    const slot = this.pickSlot(now);
    if (!slot) return false;

    const size = Math.max(0.02, o.size);
    const rot = o.rotation ?? this.rng.range(0, Math.PI * 2);
    const life = o.lifetime ?? -1;
    const fadeIn = o.fadeIn ?? 0.05;
    const opacity = o.opacity ?? 1;
    const clip = o.clip ?? 0.35;
    const ground = o.nx === undefined && o.ny === undefined && o.nz === undefined;

    if (ground) {
      _n.set(0, 1, 0);
    } else {
      _n.set(o.nx ?? 0, o.ny ?? 1, o.nz ?? 0);
      if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
      _n.normalize();
    }

    // Tangent basis about the projection axis, rotated by `rot`.
    if (Math.abs(_n.y) < 0.94) _t.set(0, 1, 0);
    else _t.set(1, 0, 0);
    _b.crossVectors(_n, _t).normalize();
    _t.crossVectors(_b, _n).normalize();
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const tx = _t.x * cr + _b.x * sr, ty = _t.y * cr + _b.y * sr, tz = _t.z * cr + _b.z * sr;
    const bx = -_t.x * sr + _b.x * cr, by = -_t.y * sr + _b.y * cr, bz = -_t.z * sr + _b.z * cr;

    // Lift scales with size: a 12 m scorch on a hill needs more clearance than
    // a 6 cm bullet hole, and a fixed epsilon cannot serve both.
    const lift = 0.012 + size * 0.006;

    const posArr = this.pos.array as Float32Array;
    const tileArr = this.tile.array as Float32Array;
    const colArr = this.color.array as Float32Array;
    const vbase = slot.index * VERTS_PER;

    const r = o.r ?? 1, g = o.g ?? 1, b = o.b ?? 1;
    const tileIdx = o.tile;
    const centreY = ground ? this.groundHeight(x, z) : y;

    for (let vy = 0; vy <= SUB; vy++) {
      for (let vx = 0; vx <= SUB; vx++) {
        const u = (vx / SUB - 0.5) * 2 * size;
        const v = (vy / SUB - 0.5) * 2 * size;
        let wx = x + tx * u + bx * v;
        let wy = y + ty * u + by * v;
        let wz = z + tz * u + bz * v;
        let agree = 1;
        if (ground) {
          // Project straight down onto the walkable surface. The tangent basis
          // is already horizontal for a +Y axis, so only the height changes.
          wy = this.groundHeight(wx, wz) + lift;
          // Normal clipping: fade where the ground turns away from vertical.
          const gn = terrainNormal(wx, wz, Math.max(0.6, size * 0.4));
          agree = clamp01((gn[1] - clip) / (1 - clip));
          // Also fade where the patch had to climb a long way — that is a wall
          // the projection cannot honestly cover.
          const dy = Math.abs(wy - (centreY + lift));
          agree *= clamp01(1 - dy / (size * 1.6 + 0.4));
        } else {
          wx += _n.x * lift;
          wy += _n.y * lift;
          wz += _n.z * lift;
        }
        const vi = vbase + vy * (SUB + 1) + vx;
        posArr[vi * 3] = wx;
        posArr[vi * 3 + 1] = wy;
        posArr[vi * 3 + 2] = wz;

        tileArr[vi * 4] = tileIdx;
        tileArr[vi * 4 + 1] = now;
        tileArr[vi * 4 + 2] = life;
        tileArr[vi * 4 + 3] = fadeIn;

        colArr[vi * 4] = r;
        colArr[vi * 4 + 1] = g;
        colArr[vi * 4 + 2] = b;
        colArr[vi * 4 + 3] = opacity * agree;
      }
    }

    slot.used = true;
    slot.born = now;
    slot.dies = life > 0 ? now + life : -1;
    slot.priority = o.priority ?? 1;

    this.pos.addUpdateRange(vbase * 3, VERTS_PER * 3);
    this.tile.addUpdateRange(vbase * 4, VERTS_PER * 4);
    this.color.addUpdateRange(vbase * 4, VERTS_PER * 4);
    this.pos.needsUpdate = true;
    this.tile.needsUpdate = true;
    this.color.needsUpdate = true;

    // Grow the draw range to the high-water slot. Decals are recycled, never
    // compacted, so the range only ever grows to capacity — and the shader
    // discards unused slots because their alpha is zero.
    const need = (slot.index + 1) * IDX_PER;
    const cur = this.geometry.drawRange.count;
    if (cur < need) this.geometry.setDrawRange(0, need);
    return true;
  }

  update(fog: THREE.Fog | THREE.FogExp2 | null): void {
    if (!this.material) return;
    const u = this.material.uniforms;
    u.uTime.value = frame.time;
    if (fog instanceof THREE.Fog) {
      (u.uFogRange.value as THREE.Vector2).set(fog.near, fog.far);
    }
    if (fog && "color" in fog) (u.uFogColor.value as THREE.Color).copy(fog.color);
  }

  clear(): void {
    if (!this.geometry) return;
    for (const s of this.slots) {
      s.used = false;
      s.dies = -1e9;
      s.born = -1e9;
    }
    (this.color.array as Float32Array).fill(0);
    this.color.needsUpdate = true;
    this.geometry.setDrawRange(0, 0);
  }

  get liveCount(): number {
    const now = frame.time;
    let n = 0;
    for (const s of this.slots) if (s.used && (s.dies < 0 || s.dies > now)) n++;
    return n;
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material?.dispose();
    this.geometry = null;
    this.material = null;
    this.slots = [];
    this.started = false;
  }
}

export const decals = new DecalSystem();

/* ================================================================== *
 * Convenience presets — the shapes gameplay actually calls
 * ================================================================== */

/** Blast scorch. `radius` is the explosion radius; the mark is a bit smaller. */
export function scorchDecal(x: number, y: number, z: number, radius: number): void {
  decals.spawn(x, y, z, {
    tile: radius > 5 ? Decal.ScorchLarge : Decal.ScorchSmall,
    size: Math.min(18, radius * 0.85),
    lifetime: -1,
    fadeIn: 0.25,
    opacity: 0.92,
    priority: 2,
    clip: 0.5,
  });
  // A second, smaller, darker core offset slightly — a real blast seat is not
  // a single uniform disc, and two overlapping marks read as one detailed one.
  decals.spawn(x, y, z, {
    tile: Decal.ScorchSmall,
    size: Math.min(7, radius * 0.34),
    lifetime: -1,
    fadeIn: 0.1,
    opacity: 1,
    priority: 2,
    r: 0.7, g: 0.7, b: 0.72,
    clip: 0.5,
  });
}

const HOLE_BY_SURFACE: Record<string, number> = {
  concrete: Decal.HoleConcrete,
  asphalt: Decal.HoleConcrete,
  stone: Decal.HoleConcrete,
  brick: Decal.HoleConcrete,
  stucco: Decal.HoleConcrete,
  metal: Decal.HoleMetal,
  thinMetal: Decal.HoleMetal,
  glass: Decal.HoleGlass,
  wood: Decal.HoleWood,
  plastic: Decal.HoleWood,
  dirt: Decal.DirtPatch,
  grass: Decal.DirtPatch,
  sand: Decal.DirtPatch,
  gravel: Decal.DirtPatch,
};

/** A bullet hole oriented to the surface it hit. */
export function bulletHoleDecal(
  x: number, y: number, z: number,
  nx: number, ny: number, nz: number,
  surface: string,
  scale = 1,
): void {
  const tile = HOLE_BY_SURFACE[surface] ?? Decal.HoleConcrete;
  decals.spawn(x, y, z, {
    tile,
    size: 0.11 * scale,
    nx, ny, nz,
    lifetime: 42,
    fadeIn: 0.0,
    opacity: 0.95,
    priority: 0,
  });
}

/** Blood. Splat on walls, pool on the ground. */
export function bloodDecal(
  x: number, y: number, z: number,
  nx: number, ny: number, nz: number,
  size = 0.6,
): void {
  const vertical = Math.abs(ny) < 0.6;
  decals.spawn(x, y, z, {
    tile: vertical ? Decal.BloodSplat : Decal.BloodPool,
    size,
    nx: vertical ? nx : undefined,
    ny: vertical ? ny : undefined,
    nz: vertical ? nz : undefined,
    lifetime: 90,
    fadeIn: vertical ? 0.08 : 1.6, // pools spread; splats arrive
    opacity: 0.9,
    priority: 0,
  });
}

/** Oil / fuel spill under a wrecked vehicle. */
export function oilDecal(x: number, y: number, z: number, size = 1.6): void {
  decals.spawn(x, y, z, {
    tile: Decal.Oil,
    size,
    lifetime: 120,
    fadeIn: 2.2,
    opacity: 0.85,
    priority: 1,
  });
}

/**
 * A tyre mark segment. Vehicles call this repeatedly along a skid; each call
 * is one short patch aligned to the travel direction, which is why `heading`
 * is required rather than random.
 */
export function tyreMarkDecal(
  x: number, y: number, z: number,
  heading: number,
  width = 0.24,
  length = 1.4,
  strength = 1,
): void {
  decals.spawn(x, y, z, {
    tile: Decal.TyreMark,
    // The patch is square; the caller gets an elongated mark by chaining short
    // segments, which also lets a skid follow a curve.
    size: Math.max(width, length) * 0.5,
    rotation: heading,
    lifetime: 55,
    fadeIn: 0,
    opacity: 0.55 * clamp01(strength),
    priority: 0,
  });
}

/** Graffiti — placed by the world generator on walls, permanent. */
export function graffitiDecal(
  x: number, y: number, z: number,
  nx: number, ny: number, nz: number,
  size: number,
  variant = 0,
): void {
  decals.spawn(x, y, z, {
    tile: variant % 2 === 0 ? Decal.GraffitiA : Decal.GraffitiB,
    size,
    nx, ny, nz,
    lifetime: -1,
    fadeIn: 0,
    opacity: 0.85,
    priority: 2,
  });
}

/** Impact cracking on hard surfaces — pairs with a bullet hole for big rounds. */
export function crackDecal(
  x: number, y: number, z: number,
  nx: number, ny: number, nz: number,
  size = 0.5,
): void {
  decals.spawn(x, y, z, { tile: Decal.Crack, size, nx, ny, nz, lifetime: 60, opacity: 0.7 });
}

/** Wet mark left by a splash or rain pooling. */
export function wetDecal(x: number, y: number, z: number, size = 1.2, life = 14): void {
  decals.spawn(x, y, z, {
    tile: Decal.WaterMark, size, lifetime: life, fadeIn: 0.1, opacity: 0.4, priority: 0,
  });
}

/** Soot streak above a burnt-out window or vent. */
export function sootDecal(
  x: number, y: number, z: number,
  nx: number, ny: number, nz: number,
  size = 2,
): void {
  decals.spawn(x, y, z, {
    tile: Decal.SootStreak, size, nx, ny, nz, lifetime: -1, fadeIn: 3, opacity: 0.8, priority: 2,
  });
}
