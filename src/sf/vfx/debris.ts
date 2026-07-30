/**
 * vfx/debris.ts — destruction debris.
 *
 * Debris is the one part of the VFX system that is *not* a particle, and that
 * is the whole point. A chunk of concrete has to bounce off a kerb, roll into
 * the gutter and stay there; the GPU particle path in `particles.ts` gives up
 * all of that by construction. So chunks are real Rapier rigid bodies from
 * `@/sf/physics`, and this module is the renderer for them.
 *
 * ## Structure
 *
 *   spawnDebrisBurst()  →  N rigid bodies (pooled) + N instance slots
 *   update()            →  sample poses, drive dust trails, settle, fade, free
 *
 * One InstancedMesh, one draw call, per-instance colour, a shared irregular
 * chunk geometry that is non-uniformly scaled per instance so no two chunks are
 * the same shape.
 *
 * ## Physics is optional
 *
 * Rapier boots asynchronously, and a bullet can hit a wall before it is up. In
 * that case the same call falls back to ballistic *visual* chunks in the
 * particle system. The player must never be able to tell which path ran, so
 * the fallback matches the physical version's speeds, sizes and lifetimes.
 *
 * ## Settling
 *
 * A chunk that has been slow for `SETTLE_TIME` is frozen and its body is
 * released back to the pool immediately — holding 200 sleeping bodies to render
 * 200 static chunks is a waste of a budget that the next explosion needs. The
 * instance keeps drawing at its final pose until its lifetime expires, then
 * shrinks to nothing over `FADE_TIME`.
 */
import * as THREE from "three";
import type { QualityTier } from "../config";
import { frame } from "../state/store";
import { clamp01, makeRng, type Rng } from "../math/rng";
import { walkableHeight } from "../geo/sfGeo";
import {
  Billboard, P, budget, emitCone, particles, resetDesc, vfxRng,
} from "./particles";
import { Tile } from "./textures";

/* ================================================================== *
 * Appearance
 * ================================================================== */

/**
 * Per-surface chunk look. `rough` and `metal` feed the shared standard
 * material's per-instance colour only — three has no per-instance roughness —
 * so the visual difference between steel and concrete debris is carried by
 * colour and by size distribution, which turns out to be enough at the
 * distances debris is actually seen from.
 */
interface SurfaceLook {
  r: number; g: number; b: number;
  /** Colour jitter, 0..1. Concrete varies a lot, painted steel barely at all. */
  variance: number;
  /** Density kg/m³ — drives how the chunk moves, not how it looks. */
  density: number;
  /** Dust colour trailing off the chunk. */
  dr: number; dg: number; db: number;
  /** How much dust. Glass makes none; masonry makes a lot. */
  dust: number;
  restitution: number;
}

const LOOKS: Record<string, SurfaceLook> = {
  concrete: { r: 0.60, g: 0.585, b: 0.555, variance: 0.24, density: 2400, dr: 0.72, dg: 0.70, db: 0.66, dust: 1.0, restitution: 0.12 },
  asphalt: { r: 0.20, g: 0.198, b: 0.198, variance: 0.20, density: 2300, dr: 0.45, dg: 0.43, db: 0.41, dust: 0.75, restitution: 0.08 },
  brick: { r: 0.47, g: 0.24, b: 0.18, variance: 0.30, density: 1900, dr: 0.66, dg: 0.48, db: 0.40, dust: 1.0, restitution: 0.10 },
  stone: { r: 0.55, g: 0.53, b: 0.50, variance: 0.22, density: 2700, dr: 0.70, dg: 0.68, db: 0.65, dust: 0.9, restitution: 0.14 },
  stucco: { r: 0.74, g: 0.71, b: 0.65, variance: 0.18, density: 1600, dr: 0.82, dg: 0.79, db: 0.74, dust: 1.15, restitution: 0.10 },
  metal: { r: 0.42, g: 0.43, b: 0.45, variance: 0.14, density: 7800, dr: 0.4, dg: 0.4, db: 0.42, dust: 0.15, restitution: 0.26 },
  thinMetal: { r: 0.50, g: 0.51, b: 0.53, variance: 0.20, density: 2400, dr: 0.4, dg: 0.4, db: 0.42, dust: 0.15, restitution: 0.34 },
  glass: { r: 0.72, g: 0.80, b: 0.84, variance: 0.10, density: 2500, dr: 0.8, dg: 0.86, db: 0.9, dust: 0.05, restitution: 0.22 },
  wood: { r: 0.38, g: 0.26, b: 0.16, variance: 0.28, density: 620, dr: 0.55, dg: 0.44, db: 0.32, dust: 0.55, restitution: 0.20 },
  plastic: { r: 0.30, g: 0.32, b: 0.34, variance: 0.30, density: 950, dr: 0.5, dg: 0.5, db: 0.52, dust: 0.1, restitution: 0.30 },
  rubber: { r: 0.11, g: 0.11, b: 0.12, variance: 0.10, density: 1100, dr: 0.3, dg: 0.3, db: 0.3, dust: 0.1, restitution: 0.42 },
  dirt: { r: 0.34, g: 0.27, b: 0.20, variance: 0.30, density: 1500, dr: 0.5, dg: 0.42, db: 0.32, dust: 1.3, restitution: 0.05 },
  foliage: { r: 0.20, g: 0.30, b: 0.14, variance: 0.34, density: 400, dr: 0.35, dg: 0.42, db: 0.26, dust: 0.2, restitution: 0.10 },
};
const DEFAULT_LOOK = LOOKS.concrete;

function lookFor(surface: string | undefined): SurfaceLook {
  return (surface && LOOKS[surface]) || DEFAULT_LOOK;
}

/* ================================================================== *
 * Chunk geometry
 * ================================================================== */

/**
 * An irregular chunk: an icosahedron with every vertex pushed along its own
 * normal by seeded noise, then flat-shaded. Flat shading matters — a smooth
 * chunk reads as a pebble, a faceted one reads as something that was broken.
 */
function makeChunkGeometry(rng: Rng): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, 1);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  // Vertices are shared per-face after IcosahedronGeometry (non-indexed), so
  // displace by a hash of the rounded position to keep the mesh watertight.
  const seen = new Map<string, number>();
  for (let i = 0; i < arr.length; i += 3) {
    const key = `${arr[i].toFixed(3)},${arr[i + 1].toFixed(3)},${arr[i + 2].toFixed(3)}`;
    let f = seen.get(key);
    if (f === undefined) {
      f = 1 + rng.range(-0.34, 0.34);
      seen.set(key, f);
    }
    arr[i] *= f; arr[i + 1] *= f; arr[i + 2] *= f;
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/* ================================================================== *
 * Pool
 * ================================================================== */

const SETTLE_SPEED = 0.55;   // m/s below which a chunk counts as "at rest"
const SETTLE_TIME = 0.65;    // seconds at rest before we free its body
const FADE_TIME = 1.4;       // seconds to shrink away at end of life

interface Chunk {
  /** Its own index in the pool — avoids an O(n) indexOf on every spawn. */
  i: number;
  active: boolean;
  /** Rapier handle, or -1 for the visual-only fallback. */
  body: number;
  /** World pose, updated from physics or integrated locally. */
  x: number; y: number; z: number;
  qx: number; qy: number; qz: number; qw: number;
  /** Fallback integration state. */
  vx: number; vy: number; vz: number;
  ax: number; ay: number; az: number;   // angular velocity, rad/s
  sx: number; sy: number; sz: number;   // per-axis scale
  born: number;
  dies: number;
  restFor: number;
  settled: boolean;
  dust: number;
  look: SurfaceLook;
  /** Distance travelled since the last dust puff. */
  sinceDust: number;
  lastX: number; lastY: number; lastZ: number;
}

const CAPACITY_BY_TIER: Record<QualityTier, number> = {
  low: 48, medium: 110, high: 220, ultra: 380,
};

export interface DebrisBurstOptions {
  x: number; y: number; z: number;
  count: number;
  /** Peak ejection speed, m/s. */
  speed: number;
  /** Cone half-angle for the throw. π/2 = hemisphere, π = everywhere. */
  spread?: number;
  /** Direction of the throw. Defaults to straight up. */
  dx?: number; dy?: number; dz?: number;
  /** Mean chunk half-size, metres. */
  size: number;
  surface?: string;
  lifetime?: number;
  /** Emit dust trails behind fast chunks. Off on low. */
  dustTrails?: boolean;
  /** 0..1 — how much of the burst is small fast shrapnel vs. big slow lumps. */
  shrapnel?: number;
}

const _pose = new Float32Array(7);
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _q2 = new THREE.Quaternion();
const _col = new THREE.Color();

class DebrisSystem {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.MeshStandardMaterial | null = null;
  private chunks: Chunk[] = [];
  private capacity = 0;
  private cursor = 0;
  private started = false;
  private rng: Rng = makeRng("sf-vfx-debris");
  private tier: QualityTier = "high";
  /** Set by the VFX root once Rapier is up; null means "use the fallback". */
  private physics: {
    spawn: (d: Record<string, unknown>) => number;
    sample: (h: number, out: Float32Array) => boolean;
    despawn: (h: number) => void;
    isAlive: (h: number) => boolean;
  } | null = null;

  constructor() {
    this.group.name = "vfx-debris";
  }

  init(tier: QualityTier): void {
    if (this.started) return;
    this.tier = tier;
    this.capacity = CAPACITY_BY_TIER[tier] ?? 220;
    this.rng = makeRng("sf-vfx-debris");
    this.geometry = makeChunkGeometry(this.rng.fork("chunk"));

    // Deliberately *not* the material lab's concrete. Two reasons: pulling a
    // texture set here would force a synchronous multi-second bake if debris
    // initialised before `materials.preload()` had run, and a 20 cm chunk
    // tumbling at 12 m/s resolves to a handful of pixels where a 2 k albedo map
    // is indistinguishable from flat shading. Per-instance colour plus the
    // faceted geometry carries the whole read.
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.88,
      metalness: 0.02,
      flatShading: true,
      vertexColors: false,
      name: "vfx-debris",
    });

    const mesh = new THREE.InstancedMesh(this.geometry, mat, this.capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.castShadow = tier !== "low";
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = "vfx-debris-chunks";
    // instanceColor has to exist before the first write or three will not
    // compile the USE_INSTANCING_COLOR path.
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3).fill(1), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    this.mesh = mesh;
    this.material = mat;
    this.group.add(mesh);

    this.chunks = [];
    for (let i = 0; i < this.capacity; i++) {
      this.chunks.push({
        i, active: false, body: -1,
        x: 0, y: -1e6, z: 0, qx: 0, qy: 0, qz: 0, qw: 1,
        vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0,
        sx: 1, sy: 1, sz: 1,
        born: 0, dies: 0, restFor: 0, settled: false, dust: 0,
        look: DEFAULT_LOOK, sinceDust: 0, lastX: 0, lastY: 0, lastZ: 0,
      });
    }
    this.started = true;
  }

  /**
   * Hand the debris system a physics backend. Kept as an injected shim rather
   * than a hard import so this module can be unit-tested and so a build with
   * physics disabled still renders debris.
   */
  setPhysics(api: DebrisSystem["physics"]): void {
    this.physics = api;
  }

  private take(): Chunk | null {
    for (let i = 0; i < this.capacity; i++) {
      const c = this.chunks[(this.cursor + i) % this.capacity];
      if (!c.active) {
        this.cursor = (c.i + 1) % this.capacity;
        return c;
      }
    }
    // Full: steal the oldest. A fresh explosion matters more than the tail of
    // the last one.
    let oldest = this.chunks[0];
    for (const c of this.chunks) if (c.born < oldest.born) oldest = c;
    this.retire(oldest);
    return oldest;
  }

  private retire(c: Chunk): void {
    if (c.body >= 0 && this.physics) this.physics.despawn(c.body);
    c.body = -1;
    c.active = false;
    c.y = -1e6;
  }

  /** Throw a burst of chunks. The primitive every destruction path calls. */
  burst(o: DebrisBurstOptions): void {
    if (!this.started) return;
    const look = lookFor(o.surface);
    const spread = o.spread ?? 1.1;
    const life = o.lifetime ?? 9;
    const shrapnel = o.shrapnel ?? 0.45;
    let dx = o.dx ?? 0, dy = o.dy ?? 1, dz = o.dz ?? 0;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;

    // Orthonormal basis about the throw axis, for the cone sampling below.
    let tx: number, ty: number, tz: number;
    if (Math.abs(dy) < 0.94) { tx = 0; ty = 1; tz = 0; } else { tx = 1; ty = 0; tz = 0; }
    let bxx = dy * tz - dz * ty, byy = dz * tx - dx * tz, bzz = dx * ty - dy * tx;
    const bl = Math.hypot(bxx, byy, bzz) || 1;
    bxx /= bl; byy /= bl; bzz /= bl;
    const cxx = byy * dz - bzz * dy, cyy = bzz * dx - bxx * dz, czz = bxx * dy - byy * dx;

    const cosA = Math.cos(Math.min(Math.PI, spread));
    const n = Math.max(1, Math.round(o.count * (this.tier === "low" ? 0.45 : 1)));

    for (let i = 0; i < n; i++) {
      const c = this.take();
      if (!c) return;

      const cc = 1 - vfxRng.next() * (1 - cosA);
      const ss = Math.sqrt(Math.max(0, 1 - cc * cc));
      const ph = vfxRng.range(0, Math.PI * 2);
      const ux = Math.cos(ph) * ss, uy = Math.sin(ph) * ss;
      const ex = dx * cc + bxx * ux + cxx * uy;
      const ey = dy * cc + byy * ux + cyy * uy;
      const ez = dz * cc + bzz * ux + czz * uy;

      // Bimodal size: mostly small fast shrapnel with a few big slow lumps.
      // A single size distribution always looks like gravel or like boulders.
      const small = vfxRng.chance(shrapnel);
      const scale = o.size * (small ? vfxRng.range(0.28, 0.6) : vfxRng.range(0.85, 1.9));
      const speed = o.speed * (small ? vfxRng.range(0.8, 1.5) : vfxRng.range(0.35, 0.8));

      c.sx = scale * vfxRng.range(0.65, 1.35);
      c.sy = scale * vfxRng.range(0.65, 1.35);
      c.sz = scale * vfxRng.range(0.65, 1.35);
      c.x = o.x + ex * scale * 0.6;
      c.y = o.y + ey * scale * 0.6;
      c.z = o.z + ez * scale * 0.6;
      c.vx = ex * speed;
      c.vy = ey * speed;
      c.vz = ez * speed;
      c.ax = vfxRng.range(-9, 9);
      c.ay = vfxRng.range(-9, 9);
      c.az = vfxRng.range(-9, 9);
      _q.setFromAxisAngle(_pv.set(vfxRng.gauss(), vfxRng.gauss(), vfxRng.gauss()).normalize(), vfxRng.range(0, 6.283));
      c.qx = _q.x; c.qy = _q.y; c.qz = _q.z; c.qw = _q.w;
      c.born = frame.time;
      c.dies = frame.time + life * vfxRng.range(0.75, 1.3);
      c.restFor = 0;
      c.settled = false;
      c.look = look;
      c.dust = (o.dustTrails === false ? 0 : 1) * look.dust;
      c.sinceDust = 0;
      c.lastX = c.x; c.lastY = c.y; c.lastZ = c.z;
      c.active = true;

      if (this.physics) {
        const h = this.physics.spawn({
          shape: "box",
          hx: c.sx * 0.5, hy: c.sy * 0.5, hz: c.sz * 0.5,
          x: c.x, y: c.y, z: c.z,
          qx: c.qx, qy: c.qy, qz: c.qz, qw: c.qw,
          vx: c.vx, vy: c.vy, vz: c.vz,
          avx: c.ax, avy: c.ay, avz: c.az,
          density: look.density,
          friction: 0.72,
          restitution: look.restitution,
          angularDamping: 0.22,
          linearDamping: 0.02,
          lifetime: life,
          kind: "debris",
          surface: o.surface,
          priority: 0,
        });
        c.body = h ?? -1;
      } else {
        c.body = -1;
      }

      // Colour: the surface tint, jittered per chunk. Uniform-coloured debris
      // is the single most obvious tell of a cheap destruction system.
      const j = look.variance;
      _col.setRGB(
        clamp01(look.r * (1 + vfxRng.range(-j, j))),
        clamp01(look.g * (1 + vfxRng.range(-j, j))),
        clamp01(look.b * (1 + vfxRng.range(-j, j))),
      );
      this.setColor(c.i, _col);
    }
  }

  private setColor(i: number, col: THREE.Color): void {
    const m = this.mesh;
    if (!m || !m.instanceColor || i < 0) return;
    const a = m.instanceColor.array as Float32Array;
    a[i * 3] = col.r; a[i * 3 + 1] = col.g; a[i * 3 + 2] = col.b;
    m.instanceColor.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------- */

  update(dt: number): void {
    const mesh = this.mesh;
    if (!this.started || !mesh) return;
    const now = frame.time;
    let high = 0;

    for (let i = 0; i < this.capacity; i++) {
      const c = this.chunks[i];
      if (!c.active) {
        // Park inactive instances at the origin with zero scale — cheaper than
        // compacting, and the vertex shader discards them for free.
        _m.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, _m);
        continue;
      }

      let speed: number;
      if (c.body >= 0 && this.physics && this.physics.isAlive(c.body)) {
        if (this.physics.sample(c.body, _pose)) {
          const dx = _pose[0] - c.x, dy = _pose[1] - c.y, dz = _pose[2] - c.z;
          speed = Math.hypot(dx, dy, dz) / Math.max(dt, 1e-4);
          c.x = _pose[0]; c.y = _pose[1]; c.z = _pose[2];
          c.qx = _pose[3]; c.qy = _pose[4]; c.qz = _pose[5]; c.qw = _pose[6];
        } else {
          speed = 0;
        }
      } else {
        // Fallback integration: drag + gravity + a hard ground stop. Not a
        // physics engine, but a chunk that lands and stops is enough.
        c.body = -1;
        const k = 0.12;
        const damp = Math.exp(-k * dt);
        c.vy += -19.6 * dt;
        c.vx *= damp; c.vy *= damp; c.vz *= damp;
        c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
        const g = walkableHeight(c.x, c.z) + c.sy * 0.45;
        if (c.y <= g) {
          c.y = g;
          if (c.vy < 0) {
            c.vy = -c.vy * c.look.restitution;
            c.vx *= 0.55; c.vz *= 0.55;
            c.ax *= 0.4; c.ay *= 0.4; c.az *= 0.4;
            if (Math.abs(c.vy) < 0.6) { c.vy = 0; c.vx *= 0.2; c.vz *= 0.2; }
          }
        }
        const ang = Math.hypot(c.ax, c.ay, c.az);
        if (ang > 1e-4) {
          _q.setFromAxisAngle(_pv.set(c.ax / ang, c.ay / ang, c.az / ang), ang * dt);
          _q2.set(c.qx, c.qy, c.qz, c.qw).premultiply(_q);
          c.qx = _q2.x; c.qy = _q2.y; c.qz = _q2.z; c.qw = _q2.w;
        }
        c.ax *= Math.exp(-0.9 * dt); c.ay *= Math.exp(-0.9 * dt); c.az *= Math.exp(-0.9 * dt);
        speed = Math.hypot(c.vx, c.vy, c.vz);
      }

      // Dust trail: a puff every 0.6 m while the chunk is genuinely moving.
      // Distance-gated, not time-gated, so a slow chunk does not smoke.
      if (c.dust > 0 && speed > 3.5) {
        const dx = c.x - c.lastX, dy = c.y - c.lastY, dz = c.z - c.lastZ;
        c.sinceDust += Math.hypot(dx, dy, dz);
        if (c.sinceDust > 0.6) {
          c.sinceDust = 0;
          resetDesc();
          P.layer = "alpha";
          P.x = c.x; P.y = c.y; P.z = c.z;
          P.drag = 2.4; P.gravity = 0.4; P.turbulence = 0.7; P.wind = 0.5;
          P.life = 0.7 + vfxRng.range(0, 0.6);
          P.size0 = c.sx * 1.6;
          P.size1 = c.sx * 5.5;
          P.frame = Tile.Dust;
          P.rot = vfxRng.range(0, 6.283);
          P.rotSpeed = vfxRng.range(-0.7, 0.7);
          P.r0 = c.look.dr; P.g0 = c.look.dg; P.b0 = c.look.db; P.a0 = 0.34 * c.dust;
          P.r1 = c.look.dr; P.g1 = c.look.dg; P.b1 = c.look.db; P.a1 = 0;
          P.fadeIn = 0.1; P.fadeOut = 0.7;
          particles.emit(P);
        }
      }
      c.lastX = c.x; c.lastY = c.y; c.lastZ = c.z;

      // Settling: free the rigid body once the chunk has stopped mattering.
      if (!c.settled) {
        if (speed < SETTLE_SPEED) {
          c.restFor += dt;
          if (c.restFor > SETTLE_TIME) {
            c.settled = true;
            if (c.body >= 0 && this.physics) {
              this.physics.despawn(c.body);
              c.body = -1;
            }
          }
        } else {
          c.restFor = 0;
        }
      }

      // Death: shrink out rather than blink out.
      const remain = c.dies - now;
      let fade = 1;
      if (remain <= 0) {
        this.retire(c);
        _m.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, _m);
        continue;
      } else if (remain < FADE_TIME) {
        fade = clamp01(remain / FADE_TIME);
        fade = fade * fade;
      }

      _q.set(c.qx, c.qy, c.qz, c.qw);
      _s.set(c.sx * fade, c.sy * fade, c.sz * fade);
      _pv.set(c.x, c.y, c.z);
      _m.compose(_pv, _q, _s);
      mesh.setMatrixAt(i, _m);
      if (i + 1 > high) high = i + 1;
    }

    // Draw only up to the high-water slot. Slots below it that are inactive
    // are already zero-scaled, so they cost a vertex shader invocation and no
    // fragments; slots above it are not drawn at all.
    mesh.count = high;
    mesh.instanceMatrix.needsUpdate = true;
  }

  get liveCount(): number {
    let n = 0;
    for (const c of this.chunks) if (c.active) n++;
    return n;
  }

  clear(): void {
    for (const c of this.chunks) if (c.active) this.retire(c);
  }

  dispose(): void {
    this.clear();
    this.mesh?.dispose();
    this.geometry?.dispose();
    this.material?.dispose();
    this.group.clear();
    this.mesh = null;
    this.geometry = null;
    this.material = null;
    this.chunks = [];
    this.started = false;
  }
}

export const debris = new DebrisSystem();

/* ================================================================== *
 * Public API
 * ================================================================== */

/** Throw physical debris. Used by explosions, destruction and heavy impacts. */
export function spawnDebrisBurst(o: DebrisBurstOptions): void {
  debris.burst(o);
}

/**
 * Small, cheap, purely visual chips — the right answer for a rifle round on
 * concrete, where a rigid body would be a waste of a physics slot for
 * something that lives 400 ms.
 */
export function spawnImpactChips(
  x: number, y: number, z: number,
  nx: number, ny: number, nz: number,
  surface: string,
  strength = 1,
): void {
  const look = lookFor(surface);
  resetDesc();
  P.layer = "alpha";
  P.x = x; P.y = y; P.z = z;
  P.drag = 0.5;
  P.gravity = -20;
  P.turbulence = 0;
  P.wind = 0.1;
  P.life = 0.55;
  P.size0 = 0.05 * strength;
  P.size1 = 0.035 * strength;
  P.frame = Tile.Speck;
  P.mode = Billboard.Stretch;
  P.stretch = 0.8;
  P.r0 = look.r * 1.25; P.g0 = look.g * 1.25; P.b0 = look.b * 1.25; P.a0 = 1;
  P.r1 = look.r; P.g1 = look.g; P.b1 = look.b; P.a1 = 0;
  P.fadeIn = 0.02; P.fadeOut = 0.4;
  emitCone(P, nx, ny, nz, 0.85, {
    count: budget(Math.round(5 + 7 * strength)),
    speed: [3, 11 * strength],
    sizeJitter: 0.5, lifeJitter: 0.6,
    offset: 0.04,
  });
}

/**
 * A collapsing-structure dust fall: a wide, slow, heavy curtain. Called by the
 * destruction system when a large volume goes, and by nothing else — it is
 * expensive and it should read as an event.
 */
export function spawnCollapseDust(
  x: number, y: number, z: number,
  radius: number,
  height: number,
  surface = "concrete",
): void {
  const look = lookFor(surface);
  resetDesc();
  P.layer = "smoke";
  P.x = x; P.y = y; P.z = z;
  P.drag = 1.2;
  P.gravity = -0.6;           // masonry dust is heavy; it falls, then spreads
  P.turbulence = 1.6;
  P.wind = 0.6;
  P.life = 6.5;
  P.size0 = radius * 0.5;
  P.size1 = radius * 2.4;
  P.frames = 16; P.fps = 3.6; P.frame = 0;
  P.rotSpeed = 0.3;
  P.r0 = look.dr * 0.95; P.g0 = look.dg * 0.95; P.b0 = look.db * 0.95; P.a0 = 0.9;
  P.r1 = look.dr * 0.7; P.g1 = look.dg * 0.7; P.b1 = look.db * 0.7; P.a1 = 0;
  P.fadeIn = 0.08; P.fadeOut = 0.55;
  const n = budget(Math.round(10 + radius * 1.6));
  for (let i = 0; i < n; i++) {
    const a = vfxRng.range(0, Math.PI * 2);
    const rr = radius * Math.sqrt(vfxRng.next());
    const px = x + Math.cos(a) * rr;
    const pz = z + Math.sin(a) * rr;
    const py = y + vfxRng.range(0, height);
    resetDesc(P);
    P.layer = "smoke";
    P.x = px; P.y = py; P.z = pz;
    P.drag = 1.2; P.gravity = -0.6; P.turbulence = 1.6; P.wind = 0.6;
    P.life = 5 + vfxRng.range(0, 3.5);
    P.size0 = radius * vfxRng.range(0.3, 0.7);
    P.size1 = radius * vfxRng.range(1.6, 3.0);
    P.frames = 16; P.fps = 3.6; P.frame = 0;
    P.rot = vfxRng.range(0, 6.283);
    P.rotSpeed = vfxRng.range(-0.35, 0.35);
    P.r0 = look.dr * 0.95; P.g0 = look.dg * 0.95; P.b0 = look.db * 0.95; P.a0 = 0.85;
    P.r1 = look.dr * 0.7; P.g1 = look.dg * 0.7; P.b1 = look.db * 0.7; P.a1 = 0;
    P.fadeIn = 0.08; P.fadeOut = 0.55;
    P.vx = Math.cos(a) * vfxRng.range(1, 5);
    P.vy = vfxRng.range(-2, 2);
    P.vz = Math.sin(a) * vfxRng.range(1, 5);
    particles.emit(P);
  }
}
