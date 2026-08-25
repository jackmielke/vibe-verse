/**
 * vfx/environmental.ts — the ambient layer.
 *
 * Explosions get the attention, but this is the file that decides whether the
 * city is *alive* between them. Nothing here is triggered by gameplay; it all
 * runs off where the camera is and what `sfGeo` says is underneath it.
 *
 * ## Everything is camera-local and hash-anchored
 *
 * The world is 9.8 × 9.6 km. Simulating ambient effects across it is absurd, so
 * every system here works in a shell around the camera: pick candidate points
 * in a radius, ask `sfGeo` what is there (water? road? park? which district?),
 * and emit. Where an effect must stay *put* between visits — a steaming
 * manhole, a specific bench with litter under it — the position comes from a
 * spatial hash of the world cell, not from a random draw, so walking away and
 * back finds the same manhole steaming.
 *
 * ## Budgets
 *
 * Each subsystem has an emission rate in particles/second that scales with the
 * quality tier and is *accumulated*, not sampled per frame. At 20 fps a
 * fractional rate would round to zero every frame and the effect would vanish
 * exactly when the machine is struggling and the player is looking for
 * reassurance that the game is still running.
 *
 * ## Rain
 *
 * Rain is the one thing here that is not a pooled particle: it is a dedicated
 * instanced mesh of ~8 000 streaks whose positions are computed entirely in the
 * vertex shader by wrapping a fixed random point set into a box that follows
 * the camera. Zero CPU per frame, infinite rain, no pool pressure. Splashes on
 * the ground *are* pooled particles, because those need surface queries.
 */
import * as THREE from "three";
import { QUALITY, type QualityTier } from "../config";
import { frame } from "../state/store";
import { clamp01, hashSeed, makeRng, smoothstep, type Rng } from "../math/rng";
import {
  WORLD, districtAt, isPark, isRoad, isWater, landSDF, terrainSlope, walkableHeight,
} from "../geo/sfGeo";
import { Billboard, P, particles, resetDesc, vfxRng } from "./particles";
import { Tile, particleAtlas, tilePxForTier } from "./textures";
import { contrail, trails, type TrailHandle } from "./trails";
import { wetDecal } from "./decals";

/* ================================================================== *
 * Weather state
 * ================================================================== */

export interface WeatherState {
  /** 0..1 rain intensity. */
  rain: number;
  /** 0..1 how wet surfaces are. Lags `rain` — puddles do not dry instantly. */
  wetness: number;
  /** 0..1 low marine-layer fog at ground level. Distinct from `frame.fogDensity`. */
  groundFog: number;
  /** 0..1 airborne dust/haze — dry offshore days. */
  haze: number;
}

/**
 * The live weather. Mutated in place; read directly by the wet-surface shaders
 * in the material lab if they want it. Never put this in zustand.
 */
export const weather: WeatherState = { rain: 0, wetness: 0, groundFog: 0, haze: 0 };

/** Set target weather. Wetness follows rain with a long tail. */
export function setWeather(w: Partial<Pick<WeatherState, "rain" | "groundFog" | "haze">>): void {
  if (w.rain !== undefined) weather.rain = clamp01(w.rain);
  if (w.groundFog !== undefined) weather.groundFog = clamp01(w.groundFog);
  if (w.haze !== undefined) weather.haze = clamp01(w.haze);
}

/* ================================================================== *
 * Rain
 * ================================================================== */

const RAIN_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

uniform float uTime;
uniform vec3  uCam;
uniform vec3  uBox;      // half extents of the wrap volume
uniform vec3  uWind;
uniform float uFall;     // fall speed, m/s
uniform float uAmount;   // 0..1, culls instances above the threshold
uniform float uLength;   // streak length, metres
uniform float uWidth;

attribute vec4 aSeed;    // x,y,z in [0,1), w = per-drop size/alpha jitter

varying float vAlpha;
varying vec2  vUv;

void main() {
  // Cull by instance rather than by count so the drops that remain keep their
  // positions — ramping rain in must not teleport every drop.
  if (aSeed.w > uAmount) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0; vUv = vec2(0.0);
    return;
  }

  vec3 drift = uWind * uTime;
  vec3 base = aSeed.xyz * (uBox * 2.0);
  // Wrap into a box that follows the camera: mod() of (world - camera) means a
  // drop that leaves the far side reappears on the near side, and the field is
  // continuous no matter how fast the camera moves.
  vec3 p = base + vec3(drift.x, -uFall * uTime, drift.z) - (uCam - uBox);
  p = mod(p, uBox * 2.0) + (uCam - uBox);

  // Velocity direction: down plus wind. The streak lies along it.
  vec3 vel = normalize(vec3(uWind.x, -uFall, uWind.z));
  vec3 toCam = normalize(uCam - p);
  vec3 side = normalize(cross(vel, toCam));

  float jitter = 0.55 + aSeed.w * 1.6;
  vec3 wpos = p + side * (position.x * uWidth * jitter) + vel * (position.y * uLength * jitter);

  vec4 mv = modelViewMatrix * vec4(wpos, 1.0);
  gl_Position = projectionMatrix * mv;

  // Fade at the edges of the wrap box so drops do not pop into existence, and
  // fade very close drops out so the camera is never inside one.
  float d = length(p - uCam);
  vAlpha = smoothstep(1.2, 4.0, d) * (1.0 - smoothstep(uBox.x * 0.62, uBox.x, d));
  vUv = uv;

  #include <logdepthbuf_vertex>
}
`;

const RAIN_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
uniform vec3 uTint;
uniform float uOpacity;
varying float vAlpha;
varying vec2  vUv;
void main() {
  #include <logdepthbuf_fragment>
  // The drop tile lives at atlas index 10 (Tile.Drop) of a 4x4 sheet.
  vec2 uv = (vUv + vec2(2.0, 4.0 - 1.0 - 2.0)) / 4.0;
  vec4 t = texture2D(uMap, uv);
  float a = t.a * vAlpha * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uTint * t.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const RAIN_COUNT_BY_TIER: Record<QualityTier, number> = {
  low: 1800, medium: 4000, high: 9000, ultra: 16000,
};

class RainSystem {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private mat: THREE.ShaderMaterial | null = null;
  private geo: THREE.InstancedBufferGeometry | null = null;
  private started = false;

  constructor() {
    this.group.name = "vfx-rain";
  }

  init(tier: QualityTier): void {
    if (this.started) return;
    const n = RAIN_COUNT_BY_TIER[tier] ?? 9000;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    const seeds = new Float32Array(n * 4);
    const rng = makeRng("sf-vfx-rain");
    for (let i = 0; i < n; i++) {
      seeds[i * 4] = rng.next();
      seeds[i * 4 + 1] = rng.next();
      seeds[i * 4 + 2] = rng.next();
      seeds[i * 4 + 3] = rng.next();
    }
    g.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    g.instanceCount = n;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    const mat = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(38, 26, 38) },
        uWind: { value: new THREE.Vector3() },
        uFall: { value: 17 },
        uAmount: { value: 0 },
        uLength: { value: 0.75 },
        uWidth: { value: 0.035 },
        uMap: { value: particleAtlas(tilePxForTier(tier)) },
        uTint: { value: new THREE.Color(0.78, 0.85, 0.95) },
        uOpacity: { value: 0.5 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3060;
    mesh.matrixAutoUpdate = false;
    mesh.name = "vfx-rain";
    mesh.visible = false;
    this.group.add(mesh);
    this.mesh = mesh;
    this.mat = mat;
    this.geo = g;
    this.started = true;
  }

  update(camPos: THREE.Vector3): void {
    if (!this.mat || !this.mesh) return;
    const amount = weather.rain;
    this.mesh.visible = amount > 0.005;
    if (!this.mesh.visible) return;
    const u = this.mat.uniforms;
    u.uTime.value = frame.time;
    (u.uCam.value as THREE.Vector3).copy(camPos);
    // Rain leans into the wind, hard. A vertical curtain in a 10 m/s onshore
    // breeze is the classic tell of a bolted-on weather system.
    (u.uWind.value as THREE.Vector3).set(
      frame.windDirection.x * frame.windSpeed * 0.55,
      0,
      frame.windDirection.y * frame.windSpeed * 0.55,
    );
    u.uAmount.value = amount;
    u.uFall.value = 14 + amount * 9;
    u.uLength.value = 0.5 + amount * 0.7;
    u.uOpacity.value = 0.28 + amount * 0.42;
  }

  dispose(): void {
    this.geo?.dispose();
    this.mat?.dispose();
    this.group.clear();
    this.geo = null;
    this.mat = null;
    this.mesh = null;
    this.started = false;
  }
}

/* ================================================================== *
 * Flock — birds and distant aircraft
 * ================================================================== */

const FLOCK_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uTime;
attribute vec4 aPos;    // xyz, size
attribute vec4 aAnim;   // flapRate, phase, heading, alpha
varying vec2  vUv;
varying float vAlpha;
void main() {
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  // Wing beat: squash vertically. At the ranges birds are seen from, a
  // vertical squash is indistinguishable from an articulated wing and costs
  // one sin().
  float flap = aAnim.x > 0.0 ? 0.45 + 0.55 * abs(sin(uTime * aAnim.x + aAnim.y)) : 1.0;
  float c = cos(aAnim.z), s = sin(aAnim.z);
  vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
  vec3 wpos = aPos.xyz + (camRight * q.x + camUp * q.y * flap) * aPos.w;
  vec4 mv = modelViewMatrix * vec4(wpos, 1.0);
  gl_Position = projectionMatrix * mv;
  vUv = uv;
  vAlpha = aAnim.w;
  #include <logdepthbuf_vertex>
}
`;

const FLOCK_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
uniform vec3 uTint;
varying vec2 vUv;
varying float vAlpha;
void main() {
  #include <logdepthbuf_fragment>
  // Bird tile is index 12 of the 4x4 atlas → col 0, row 3.
  vec2 uv = (vUv + vec2(0.0, 4.0 - 1.0 - 3.0)) / 4.0;
  vec4 t = texture2D(uMap, uv);
  float a = t.a * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(t.rgb * uTint, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface Bird {
  /** Anchor the flock circles. */
  cx: number; cy: number; cz: number;
  r: number;
  phase: number;
  rate: number;
  bob: number;
  size: number;
  flap: number;
  alpha: number;
}

interface Aircraft {
  x: number; y: number; z: number;
  vx: number; vz: number;
  trail: TrailHandle;
  active: boolean;
}

const FLOCK_BY_TIER: Record<QualityTier, number> = { low: 24, medium: 60, high: 120, ultra: 200 };

class FlockSystem {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private mat: THREE.ShaderMaterial | null = null;
  private geo: THREE.InstancedBufferGeometry | null = null;
  private data: Float32Array | null = null;
  private buf: THREE.InstancedInterleavedBuffer | null = null;
  private birds: Bird[] = [];
  private aircraft: Aircraft[] = [];
  private capacity = 0;
  private started = false;
  private rng: Rng = makeRng("sf-vfx-flock");
  private reseedAt = 0;

  constructor() {
    this.group.name = "vfx-flock";
  }

  init(tier: QualityTier): void {
    if (this.started) return;
    this.capacity = FLOCK_BY_TIER[tier] ?? 120;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    const data = new Float32Array(this.capacity * 8);
    const buf = new THREE.InstancedInterleavedBuffer(data, 8, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("aPos", new THREE.InterleavedBufferAttribute(buf, 4, 0));
    g.setAttribute("aAnim", new THREE.InterleavedBufferAttribute(buf, 4, 4));
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    const mat = new THREE.ShaderMaterial({
      vertexShader: FLOCK_VERT,
      fragmentShader: FLOCK_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: particleAtlas(tilePxForTier(tier)) },
        uTint: { value: new THREE.Color(1, 1, 1) },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2900;
    mesh.matrixAutoUpdate = false;
    mesh.name = "vfx-flock";
    this.group.add(mesh);
    this.mesh = mesh;
    this.mat = mat;
    this.geo = g;
    this.data = data;
    this.buf = buf;
    this.aircraft = [
      { x: 0, y: 0, z: 0, vx: 0, vz: 0, trail: -1, active: false },
      { x: 0, y: 0, z: 0, vx: 0, vz: 0, trail: -1, active: false },
    ];
    this.started = true;
  }

  /** Re-seat the flocks around a new camera position. */
  private reseed(cx: number, cz: number): void {
    this.birds.length = 0;
    const rng = this.rng.fork(`flock:${Math.round(cx / 400)}:${Math.round(cz / 400)}`);
    const flocks = rng.int(3, 6);
    const perFlock = Math.max(3, Math.floor((this.capacity - 4) / flocks));
    for (let f = 0; f < flocks; f++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(60, 420);
      const ax = cx + Math.cos(a) * d;
      const az = cz + Math.sin(a) * d;
      // Gulls hug the waterfront; pigeons work the plazas. Both are true of SF
      // and the height difference alone makes the two read differently.
      const overWater = isWater(ax, az);
      const base = walkableHeight(ax, az);
      const ay = base + (overWater ? rng.range(6, 30) : rng.range(22, 90));
      const r = rng.range(8, 34);
      for (let i = 0; i < perFlock; i++) {
        this.birds.push({
          cx: ax, cy: ay, cz: az, r: r * rng.range(0.5, 1.3),
          phase: rng.range(0, Math.PI * 2),
          rate: rng.range(0.10, 0.24) * (overWater ? 0.8 : 1.2),
          bob: rng.range(0.6, 3.2),
          size: rng.range(0.7, 1.5) * (overWater ? 1.5 : 1.0),
          flap: rng.range(5.5, 11),
          alpha: rng.range(0.55, 0.95),
        });
      }
    }
  }

  update(camPos: THREE.Vector3): void {
    if (!this.started || !this.data || !this.buf || !this.geo) return;
    const now = frame.time;
    const d = this.data;

    if (now > this.reseedAt) {
      this.reseed(camPos.x, camPos.z);
      this.reseedAt = now + 22;
    }

    let n = 0;
    for (const b of this.birds) {
      if (n >= this.capacity - 2) break;
      const a = b.phase + now * b.rate;
      const x = b.cx + Math.cos(a) * b.r;
      const z = b.cz + Math.sin(a) * b.r;
      const y = b.cy + Math.sin(now * 0.4 + b.phase) * b.bob;
      const dist = Math.hypot(x - camPos.x, y - camPos.y, z - camPos.z);
      // Angular-size clamp: a bird at 400 m would be sub-pixel and would
      // shimmer, so it grows a little with distance and fades out instead.
      const size = b.size * (1 + dist * 0.0016);
      const o = n * 8;
      d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = size;
      d[o + 4] = b.flap;
      d[o + 5] = b.phase;
      // Heading follows the tangent of the circle so the silhouette banks.
      d[o + 6] = -a + Math.PI * 0.5;
      d[o + 7] = b.alpha * (1 - smoothstep(500, 900, dist)) * (1 - smoothstep(0, 14, -dist + 14));
      n++;
    }

    // Aircraft: two slots, crossing the sky slowly, each pulling a contrail.
    for (const ac of this.aircraft) {
      if (!ac.active) {
        if (!vfxRng.chance(frame.dt * 0.02)) continue;
        const a = vfxRng.range(0, Math.PI * 2);
        ac.x = camPos.x + Math.cos(a) * 3200;
        ac.z = camPos.z + Math.sin(a) * 3200;
        ac.y = WORLD.skyCeiling * vfxRng.range(0.55, 0.95);
        const hd = a + Math.PI + vfxRng.range(-0.4, 0.4);
        const sp = vfxRng.range(120, 190);
        ac.vx = Math.cos(hd) * sp;
        ac.vz = Math.sin(hd) * sp;
        ac.trail = contrail(ac.x, ac.y, ac.z);
        ac.active = true;
      }
      ac.x += ac.vx * frame.dt;
      ac.z += ac.vz * frame.dt;
      if (ac.trail >= 0) trails.move(ac.trail, ac.x, ac.y, ac.z);
      const dist = Math.hypot(ac.x - camPos.x, ac.z - camPos.z);
      if (dist > 6000) {
        if (ac.trail >= 0) trails.release(ac.trail);
        ac.trail = -1;
        ac.active = false;
        continue;
      }
      if (n < this.capacity) {
        const o = n * 8;
        d[o] = ac.x; d[o + 1] = ac.y; d[o + 2] = ac.z;
        d[o + 3] = 6 + dist * 0.004;
        d[o + 4] = 0;                       // no flap
        d[o + 5] = 0;
        d[o + 6] = Math.atan2(ac.vz, ac.vx);
        d[o + 7] = 0.55;
        n++;
      }
    }

    this.geo.instanceCount = n;
    this.buf.needsUpdate = true;
    if (this.mat) this.mat.uniforms.uTime.value = now;
  }

  dispose(): void {
    for (const ac of this.aircraft) {
      if (ac.trail >= 0) trails.kill(ac.trail);
    }
    this.geo?.dispose();
    this.mat?.dispose();
    this.group.clear();
    this.geo = null;
    this.mat = null;
    this.mesh = null;
    this.data = null;
    this.buf = null;
    this.birds.length = 0;
    this.aircraft.length = 0;
    this.started = false;
  }
}

/* ================================================================== *
 * Ambient particle emitters
 * ================================================================== */

/**
 * Spatially-hashed "is there a feature in this cell" test. Deterministic, so a
 * given manhole steams every time you walk past it, and free — no storage.
 */
function cellHash(cx: number, cz: number, salt: number): number {
  return (hashSeed(`${cx}:${cz}:${salt}`) >>> 8) / 0x1000000;
}

class AmbientSystem {
  private acc = {
    fog: 0, spray: 0, steam: 0, litter: 0, devil: 0, rainSplash: 0,
  };
  private tier: QualityTier = "high";
  private scale = 1;
  private started = false;
  /** Rolling cursor so the per-frame scatter loops sample different cells. */
  private cursor = 0;

  init(tier: QualityTier): void {
    this.tier = tier;
    this.scale = QUALITY[tier].maxParticles / QUALITY.high.maxParticles;
    this.scale = Math.max(0.15, Math.min(1.5, this.scale));
    // Clear the fractional emission budget and the scatter cursor. `take()`
    // carries a remainder between frames so a rate below one particle per
    // frame still emits, and neither `dispose()` nor this used to reset it —
    // so a level reload, a respawn or a quality change inherited however much
    // of a particle the previous world had left over, and the first frames
    // after it emitted a different amount than a cold boot would.
    //
    // Invisible in play, and it made `vfx.smoke`'s determinism check pass by
    // coincidence: two identical runs agreed only because the leftover
    // happened to land on the same floor at the fog density of the day. It
    // stopped agreeing the moment the default fog moved.
    for (const k of Object.keys(this.acc) as (keyof AmbientSystem["acc"])[]) {
      this.acc[k] = 0;
    }
    this.cursor = 0;
    this.started = true;
  }

  private take(key: keyof AmbientSystem["acc"], rate: number, dt: number, cap: number): number {
    this.acc[key] += rate * dt * this.scale;
    const n = Math.min(cap, Math.floor(this.acc[key]));
    this.acc[key] -= n;
    return n;
  }

  update(dt: number, cam: THREE.Vector3): void {
    if (!this.started) return;
    this.cursor++;

    this.groundFog(dt, cam);
    this.baySpray(dt, cam);
    this.manholeSteam(dt, cam);
    this.litter(dt, cam);
    this.dustDevils(dt, cam);
    this.rainSplashes(dt, cam);
  }

  /* ---- ground fog ------------------------------------------------ */
  /**
   * SF's signature. Thin, fast-moving wisps that lie *along* the ground and
   * pour over ridges. Driven by `frame.fogDensity` so it agrees with the
   * atmospheric fog the sky system is already applying.
   */
  private groundFog(dt: number, cam: THREE.Vector3): void {
    const density = Math.max(frame.fogDensity * 0.8, weather.groundFog);
    if (density < 0.06) return;
    // Ground fog is pure fillrate — 40 m sprites at 5 % alpha. The rate is
    // deliberately low and the *size* does the work; doubling the count buys
    // nothing visible and costs a third of the frame on an integrated GPU.
    const n = this.take("fog", 1.2 + density * 7, dt, 4);
    for (let i = 0; i < n; i++) {
      const a = vfxRng.range(0, Math.PI * 2);
      const r = 30 + Math.sqrt(vfxRng.next()) * 190;
      const x = cam.x + Math.cos(a) * r;
      const z = cam.z + Math.sin(a) * r;
      if (isWater(x, z) && vfxRng.chance(0.5)) continue;
      const g = walkableHeight(x, z);
      // Wisps hug the ground; steep ground gets none, because fog pools in the
      // hollows and spills off the ridges rather than clinging to a 30° slope.
      if (terrainSlope(x, z) > 0.55 && vfxRng.chance(0.7)) continue;
      resetDesc();
      P.layer = "alpha";
      P.x = x;
      P.y = g + vfxRng.range(0.2, 5.5);
      P.z = z;
      P.drag = 0.28;
      P.gravity = 0.05;
      P.turbulence = 1.2;
      P.wind = 1.0;
      P.life = 9 + vfxRng.range(0, 6);
      P.size0 = vfxRng.range(8, 16);
      P.size1 = vfxRng.range(20, 38);
      P.frame = Tile.Wisp;
      P.rot = vfxRng.range(0, 6.283);
      P.rotSpeed = vfxRng.range(-0.05, 0.05);
      const bright = 0.86 + vfxRng.range(-0.06, 0.06);
      P.r0 = bright; P.g0 = bright * 1.005; P.b0 = bright * 1.03;
      P.a0 = 0.055 * density;
      P.r1 = bright; P.g1 = bright; P.b1 = bright * 1.02;
      P.a1 = 0;
      P.fadeIn = 0.22; P.fadeOut = 0.55;
      particles.emit(P);
    }
  }

  /* ---- bay spray ------------------------------------------------- */
  /**
   * Spray where the water meets a hard edge. `landSDF` gives the signed
   * distance to the coastline, so "the seawall" is simply |sdf| < a few metres
   * with a steep bank behind it — no authored spline required.
   */
  private baySpray(dt: number, cam: THREE.Vector3): void {
    if (cam.y > 220) return;
    const n = this.take("spray", 9, dt, 6);
    for (let i = 0; i < n; i++) {
      const a = vfxRng.range(0, Math.PI * 2);
      const r = 20 + Math.sqrt(vfxRng.next()) * 170;
      const x = cam.x + Math.cos(a) * r;
      const z = cam.z + Math.sin(a) * r;
      const sdf = landSDF(x, z);
      if (Math.abs(sdf) > 7) continue;

      // Wave energy: the exposed western/northern shore gets more than the
      // sheltered eastern waterfront. Wind direction supplies the bias.
      const exposure = clamp01(0.35 + frame.windSpeed * 0.045);
      const burst = 2 + Math.round(vfxRng.next() * 5 * exposure);
      for (let k = 0; k < burst; k++) {
        resetDesc();
        P.layer = "alpha";
        P.x = x + vfxRng.gauss() * 2.2;
        P.y = WORLD.seaLevel + vfxRng.range(0, 1.2);
        P.z = z + vfxRng.gauss() * 2.2;
        P.vx = vfxRng.gauss() * 1.6 + frame.windDirection.x * frame.windSpeed * 0.3;
        P.vy = vfxRng.range(2.5, 9) * exposure;
        P.vz = vfxRng.gauss() * 1.6 + frame.windDirection.y * frame.windSpeed * 0.3;
        P.drag = 1.5;
        P.gravity = -9.5;
        P.turbulence = 0.9;
        P.wind = 0.7;
        P.life = 1.6 + vfxRng.range(0, 1.8);
        P.size0 = vfxRng.range(0.5, 1.8);
        P.size1 = vfxRng.range(2.4, 6.0);
        P.frame = vfxRng.chance(0.4) ? Tile.Splash : Tile.Dust;
        P.rot = vfxRng.range(0, 6.283);
        P.rotSpeed = vfxRng.range(-0.5, 0.5);
        P.r0 = 0.97; P.g0 = 0.99; P.b0 = 1.0; P.a0 = 0.42;
        P.r1 = 0.9; P.g1 = 0.94; P.b1 = 0.97; P.a1 = 0;
        P.fadeIn = 0.06; P.fadeOut = 0.5;
        particles.emit(P);
      }
    }
  }

  /* ---- manhole steam --------------------------------------------- */
  private manholeSteam(dt: number, cam: THREE.Vector3): void {
    if (cam.y > 90) return;
    const n = this.take("steam", 7, dt, 5);
    const CELL = 34;
    for (let i = 0; i < n; i++) {
      // Pick a cell near the camera; the hash decides whether it has a vent.
      const cx = Math.round(cam.x / CELL) + vfxRng.int(-4, 4);
      const cz = Math.round(cam.z / CELL) + vfxRng.int(-4, 4);
      if (cellHash(cx, cz, 7717) > 0.16) continue;
      const jx = cellHash(cx, cz, 31) - 0.5;
      const jz = cellHash(cx, cz, 97) - 0.5;
      const x = cx * CELL + jx * CELL * 0.7;
      const z = cz * CELL + jz * CELL * 0.7;
      if (!isRoad(x, z)) continue;
      const g = walkableHeight(x, z);
      resetDesc();
      P.layer = "alpha";
      P.x = x + vfxRng.gauss() * 0.35;
      P.y = g + 0.06;
      P.z = z + vfxRng.gauss() * 0.35;
      P.vx = vfxRng.gauss() * 0.25;
      P.vy = vfxRng.range(0.9, 2.4);
      P.vz = vfxRng.gauss() * 0.25;
      P.drag = 0.9;
      P.gravity = 1.6;               // steam is buoyant
      P.turbulence = 1.3;
      P.wind = 0.9;
      P.life = 3.4 + vfxRng.range(0, 2.6);
      P.size0 = vfxRng.range(0.5, 1.1);
      P.size1 = vfxRng.range(3.5, 7.5);
      P.frame = Tile.Smoke;
      P.rot = vfxRng.range(0, 6.283);
      P.rotSpeed = vfxRng.range(-0.35, 0.35);
      P.r0 = 0.93; P.g0 = 0.94; P.b0 = 0.96; P.a0 = 0.3;
      P.r1 = 0.88; P.g1 = 0.9; P.b1 = 0.93; P.a1 = 0;
      P.fadeIn = 0.12; P.fadeOut = 0.6;
      particles.emit(P);
    }
  }

  /* ---- drifting litter ------------------------------------------- */
  private litter(dt: number, cam: THREE.Vector3): void {
    if (cam.y > 60) return;
    const d = districtAt(cam.x, cam.z);
    const urban = clamp01(d.density);
    if (urban < 0.25) return;
    const n = this.take("litter", 1.1 * urban + frame.windSpeed * 0.16 * urban, dt, 2);
    for (let i = 0; i < n; i++) {
      const a = vfxRng.range(0, Math.PI * 2);
      const r = 8 + vfxRng.next() * 42;
      const x = cam.x + Math.cos(a) * r;
      const z = cam.z + Math.sin(a) * r;
      if (isWater(x, z)) continue;
      const g = walkableHeight(x, z);
      resetDesc();
      P.layer = "alpha";
      P.x = x; P.y = g + vfxRng.range(0.05, 1.2); P.z = z;
      P.vx = frame.windDirection.x * frame.windSpeed * vfxRng.range(0.3, 0.8);
      P.vy = vfxRng.range(0.2, 1.6);
      P.vz = frame.windDirection.y * frame.windSpeed * vfxRng.range(0.3, 0.8);
      P.drag = 2.4;
      P.gravity = -1.6;              // just heavy enough to tumble back down
      P.turbulence = 3.2;
      P.wind = 0.85;
      P.life = 5 + vfxRng.range(0, 5);
      P.size0 = vfxRng.range(0.14, 0.34);
      P.size1 = vfxRng.range(0.14, 0.34);
      P.frame = Tile.Litter;
      P.rot = vfxRng.range(0, 6.283);
      P.rotSpeed = vfxRng.range(-4.5, 4.5);
      const tint = vfxRng.range(0.75, 1.0);
      P.r0 = tint; P.g0 = tint * 0.99; P.b0 = tint * 0.95; P.a0 = 0.9;
      P.r1 = tint; P.g1 = tint * 0.99; P.b1 = tint * 0.95; P.a1 = 0;
      P.fadeIn = 0.1; P.fadeOut = 0.25;
      particles.emit(P);
    }
  }

  /* ---- dust devils ----------------------------------------------- */
  /**
   * Dry, open, breezy ground only — the park lawns and the sand. A rising
   * spiral of dust, emitted as a short-lived column with a rotational velocity
   * bias so it visibly turns.
   */
  private dustDevils(dt: number, cam: THREE.Vector3): void {
    if (weather.rain > 0.15 || cam.y > 120) return;
    const n = this.take("devil", 0.9, dt, 1);
    for (let i = 0; i < n; i++) {
      const a = vfxRng.range(0, Math.PI * 2);
      const r = 25 + vfxRng.next() * 160;
      const x = cam.x + Math.cos(a) * r;
      const z = cam.z + Math.sin(a) * r;
      if (isWater(x, z)) continue;
      const open = isPark(x, z) || !isRoad(x, z);
      if (!open) continue;
      const g = walkableHeight(x, z);
      const height = vfxRng.range(3, 11);
      const spin = vfxRng.chance(0.5) ? 1 : -1;
      const k = 9;
      for (let j = 0; j < k; j++) {
        const t = j / k;
        const ang = t * Math.PI * 4 * spin + vfxRng.range(0, 0.6);
        const rr = 0.5 + t * 2.2;
        resetDesc();
        P.layer = "alpha";
        P.x = x + Math.cos(ang) * rr;
        P.y = g + t * height;
        P.z = z + Math.sin(ang) * rr;
        // Tangential velocity is what makes it a devil and not a puff.
        P.vx = -Math.sin(ang) * spin * (2.2 + t * 2) + frame.windDirection.x * frame.windSpeed * 0.4;
        P.vy = 1.4 + t * 2.5;
        P.vz = Math.cos(ang) * spin * (2.2 + t * 2) + frame.windDirection.y * frame.windSpeed * 0.4;
        P.drag = 0.7;
        P.gravity = 0.3;
        P.turbulence = 1.4;
        P.wind = 0.6;
        P.life = 2.4 + vfxRng.range(0, 1.8);
        P.size0 = 0.7 + t * 1.6;
        P.size1 = 3.0 + t * 4.0;
        P.frame = Tile.Dust;
        P.rot = vfxRng.range(0, 6.283);
        P.rotSpeed = spin * vfxRng.range(0.5, 1.4);
        P.r0 = 0.68; P.g0 = 0.62; P.b0 = 0.50; P.a0 = 0.2;
        P.r1 = 0.62; P.g1 = 0.58; P.b1 = 0.50; P.a1 = 0;
        P.fadeIn = 0.15; P.fadeOut = 0.55;
        particles.emit(P);
      }
    }
  }

  /* ---- rain splashes --------------------------------------------- */
  private rainSplashes(dt: number, cam: THREE.Vector3): void {
    if (weather.rain < 0.08 || cam.y > 45) return;
    const n = this.take("rainSplash", 40 * weather.rain, dt, 24);
    for (let i = 0; i < n; i++) {
      const a = vfxRng.range(0, Math.PI * 2);
      const r = vfxRng.next() * 26;
      const x = cam.x + Math.cos(a) * r;
      const z = cam.z + Math.sin(a) * r;
      const g = isWater(x, z) ? WORLD.seaLevel : walkableHeight(x, z);
      resetDesc();
      P.layer = "alpha";
      P.x = x; P.y = g + 0.02; P.z = z;
      P.drag = 5;
      P.gravity = -3;
      P.turbulence = 0;
      P.wind = 0;
      P.life = 0.28;
      P.size0 = 0.05;
      P.size1 = 0.42;
      P.frame = Tile.Ring;
      P.mode = Billboard.Ground;
      P.r0 = 0.9; P.g0 = 0.95; P.b0 = 1.0; P.a0 = 0.45;
      P.r1 = 0.9; P.g1 = 0.95; P.b1 = 1.0; P.a1 = 0;
      P.fadeIn = 0.05; P.fadeOut = 0.6;
      particles.emit(P);

      // A rare crown of droplets — one in eight, or it costs too much for a
      // detail nobody consciously registers.
      if (vfxRng.chance(0.12)) {
        resetDesc();
        P.layer = "alpha";
        P.x = x; P.y = g + 0.03; P.z = z;
        P.vy = vfxRng.range(0.8, 2.0);
        P.vx = vfxRng.gauss() * 0.5;
        P.vz = vfxRng.gauss() * 0.5;
        P.drag = 1.2; P.gravity = -12; P.turbulence = 0; P.wind = 0.1;
        P.life = 0.34;
        P.size0 = 0.05; P.size1 = 0.03;
        P.frame = Tile.Splash;
        P.r0 = 0.92; P.g0 = 0.96; P.b0 = 1.0; P.a0 = 0.6;
        P.r1 = 0.9; P.g1 = 0.94; P.b1 = 0.98; P.a1 = 0;
        particles.emit(P);
      }
    }
  }
}

/* ================================================================== *
 * The environmental root
 * ================================================================== */

const _camPos = new THREE.Vector3();

class EnvironmentalSystem {
  readonly group = new THREE.Group();
  readonly rain = new RainSystem();
  readonly flock = new FlockSystem();
  private ambient = new AmbientSystem();
  private started = false;
  private wetTimer = 0;

  constructor() {
    this.group.name = "vfx-environment";
  }

  init(tier: QualityTier): void {
    if (this.started) return;
    this.rain.init(tier);
    this.flock.init(tier);
    this.ambient.init(tier);
    this.group.add(this.rain.group);
    this.group.add(this.flock.group);
    this.started = true;
  }

  update(dt: number, camera: THREE.Camera): void {
    if (!this.started) return;
    camera.getWorldPosition(_camPos);

    // Wetness lags rain both ways — surfaces stay wet long after the shower.
    const target = weather.rain > 0.05 ? 1 : 0;
    const rate = target > weather.wetness ? 0.28 : 0.035;
    weather.wetness += (target - weather.wetness) * Math.min(1, rate * dt * 3);

    this.rain.update(_camPos);
    this.flock.update(_camPos);
    this.ambient.update(dt, _camPos);

    // Occasional puddle marks while it rains, so the ground reads as wet even
    // where the material system has no wetness input wired up.
    if (weather.rain > 0.35) {
      this.wetTimer -= dt;
      if (this.wetTimer <= 0) {
        this.wetTimer = 0.45;
        const a = vfxRng.range(0, Math.PI * 2);
        const r = vfxRng.next() * 22;
        const x = _camPos.x + Math.cos(a) * r;
        const z = _camPos.z + Math.sin(a) * r;
        if (!isWater(x, z)) wetDecal(x, walkableHeight(x, z), z, vfxRng.range(0.8, 2.4), 9);
      }
    }
  }

  dispose(): void {
    this.rain.dispose();
    this.flock.dispose();
    this.group.clear();
    this.started = false;
  }
}

export const environment = new EnvironmentalSystem();

/* ================================================================== *
 * Imperative hooks for other systems
 * ================================================================== */

/**
 * Vehicle exhaust. `cold` puffs white condensate (a cold morning, or a fresh
 * start); a warm engine emits almost nothing, which is correct and is also why
 * this must be called with a low rate rather than every frame.
 */
export function emitExhaust(
  x: number, y: number, z: number,
  dx: number, dz: number,
  load = 0.3,
  cold = false,
  diesel = false,
): void {
  resetDesc();
  P.layer = "alpha";
  P.x = x; P.y = y; P.z = z;
  P.vx = dx * (0.9 + load * 2.6) + vfxRng.gauss() * 0.25;
  P.vy = vfxRng.range(0.15, 0.7);
  P.vz = dz * (0.9 + load * 2.6) + vfxRng.gauss() * 0.25;
  P.drag = 2.6;
  P.gravity = cold ? 0.9 : 0.35;
  P.turbulence = 1.1;
  P.wind = 0.8;
  P.life = cold ? 1.5 : 0.85;
  P.size0 = 0.16;
  P.size1 = cold ? 2.4 : 1.4;
  P.frame = Tile.Smoke;
  P.rot = vfxRng.range(0, 6.283);
  P.rotSpeed = vfxRng.range(-0.8, 0.8);
  if (diesel) {
    P.r0 = 0.15; P.g0 = 0.145; P.b0 = 0.14; P.a0 = 0.34 + load * 0.4;
    P.r1 = 0.25; P.g1 = 0.25; P.b1 = 0.25; P.a1 = 0;
  } else {
    const w = cold ? 0.94 : 0.6;
    P.r0 = w; P.g0 = w; P.b0 = w * 1.02; P.a0 = (cold ? 0.3 : 0.1) + load * 0.16;
    P.r1 = w; P.g1 = w; P.b1 = w; P.a1 = 0;
  }
  P.fadeIn = 0.1; P.fadeOut = 0.6;
  particles.emit(P);
}

/** Tyre smoke from a burnout or a hard skid. */
export function emitTyreSmoke(x: number, y: number, z: number, slip: number): void {
  resetDesc();
  P.layer = "alpha";
  P.x = x; P.y = y + 0.1; P.z = z;
  P.vx = vfxRng.gauss() * 1.4;
  P.vy = vfxRng.range(0.5, 2.2);
  P.vz = vfxRng.gauss() * 1.4;
  P.drag = 1.7;
  P.gravity = 0.8;
  P.turbulence = 1.4;
  P.wind = 0.7;
  P.life = 1.4 + vfxRng.range(0, 1.2);
  P.size0 = 0.35;
  P.size1 = 3.4;
  P.frame = Tile.Smoke;
  P.rot = vfxRng.range(0, 6.283);
  P.rotSpeed = vfxRng.range(-0.6, 0.6);
  const g = 0.82;
  P.r0 = g; P.g0 = g; P.b0 = g * 0.99; P.a0 = 0.16 * clamp01(slip);
  P.r1 = g * 0.9; P.g1 = g * 0.9; P.b1 = g * 0.9; P.a1 = 0;
  P.fadeIn = 0.12; P.fadeOut = 0.6;
  particles.emit(P);
}

/** A shorted power line or a sparking junction box. */
export function emitPowerlineSpark(x: number, y: number, z: number, strength = 1): void {
  resetDesc();
  P.layer = "add";
  P.x = x; P.y = y; P.z = z;
  P.drag = 0.9;
  P.gravity = -22;
  P.turbulence = 0.4;
  P.wind = 0.2;
  P.life = 0.5;
  P.size0 = 0.09 * strength;
  P.size1 = 0.02;
  P.frame = Tile.Spark;
  P.mode = Billboard.Stretch;
  P.stretch = 2.2;
  // Arc flash is blue-white, not orange — this is copper and air, not fuel.
  P.r0 = 2.4; P.g0 = 2.6; P.b0 = 3.2; P.a0 = 1;
  P.r1 = 1.4; P.g1 = 0.9; P.b1 = 0.5; P.a1 = 0;
  P.fadeIn = 0.01; P.fadeOut = 0.4;
  const n = Math.round(6 + vfxRng.next() * 12 * strength);
  for (let i = 0; i < n; i++) {
    P.x = x + vfxRng.gauss() * 0.06;
    P.y = y + vfxRng.gauss() * 0.06;
    P.z = z + vfxRng.gauss() * 0.06;
    const sp = vfxRng.range(2, 11) * strength;
    const a = vfxRng.range(0, Math.PI * 2);
    const u = vfxRng.range(-1, 0.5);
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    P.vx = Math.cos(a) * s * sp;
    P.vy = u * sp;
    P.vz = Math.sin(a) * s * sp;
    P.life = 0.28 + vfxRng.range(0, 0.5);
    particles.emit(P);
  }
  // The flash itself.
  resetDesc();
  P.layer = "add";
  P.x = x; P.y = y; P.z = z;
  P.drag = 6; P.gravity = 0; P.life = 0.09;
  P.size0 = 0.5 * strength; P.size1 = 1.4 * strength;
  P.frame = Tile.Flash;
  P.r0 = 2.0; P.g0 = 2.3; P.b0 = 3.0; P.a0 = 1;
  P.r1 = 0.8; P.g1 = 0.9; P.b1 = 1.2; P.a1 = 0;
  P.fadeIn = 0.02; P.fadeOut = 0.6;
  particles.emit(P);
}

/** A splash where something entered the water. */
export function emitWaterSplash(x: number, y: number, z: number, energy = 1): void {
  resetDesc();
  P.layer = "alpha";
  P.x = x; P.y = y; P.z = z;
  P.drag = 1.6;
  P.gravity = -14;
  P.turbulence = 0.5;
  P.wind = 0.3;
  P.life = 1.1 + energy * 0.5;
  P.size0 = 0.25 * energy;
  P.size1 = 1.6 * energy;
  P.frame = Tile.Splash;
  P.r0 = 1; P.g0 = 1; P.b0 = 1; P.a0 = 0.8;
  P.r1 = 0.86; P.g1 = 0.92; P.b1 = 0.96; P.a1 = 0;
  P.fadeIn = 0.03; P.fadeOut = 0.5;
  const n = Math.round(8 + energy * 16);
  for (let i = 0; i < n; i++) {
    const a = vfxRng.range(0, Math.PI * 2);
    const sp = vfxRng.range(1.5, 7) * energy;
    const lift = vfxRng.range(0.5, 1.0);
    P.x = x + vfxRng.gauss() * 0.3 * energy;
    P.y = y + vfxRng.range(0, 0.3);
    P.z = z + vfxRng.gauss() * 0.3 * energy;
    P.vx = Math.cos(a) * sp * 0.5;
    P.vy = sp * lift;
    P.vz = Math.sin(a) * sp * 0.5;
    P.size0 = vfxRng.range(0.15, 0.5) * energy;
    P.size1 = vfxRng.range(0.9, 2.2) * energy;
    particles.emit(P);
  }
  // Expanding surface ring.
  resetDesc();
  P.layer = "alpha";
  P.x = x; P.y = WORLD.seaLevel + 0.04; P.z = z;
  P.drag = 3.2; P.gravity = 0;
  P.life = 1.4 + energy * 0.4;
  P.size0 = 0.4 * energy;
  P.size1 = 5.0 * energy;
  P.frame = Tile.Ring;
  P.mode = Billboard.Ground;
  P.r0 = 0.95; P.g0 = 0.98; P.b0 = 1.0; P.a0 = 0.5;
  P.r1 = 0.9; P.g1 = 0.95; P.b1 = 1.0; P.a1 = 0;
  P.fadeIn = 0.04; P.fadeOut = 0.6;
  particles.emit(P);
}

/** Dust under a footstep or a landing. */
export function emitFootDust(x: number, y: number, z: number, strength = 1): void {
  if (weather.wetness > 0.5) return;   // wet ground does not puff
  resetDesc();
  P.layer = "alpha";
  P.x = x; P.y = y + 0.03; P.z = z;
  P.drag = 3.0;
  P.gravity = -0.6;
  P.turbulence = 0.6;
  P.wind = 0.5;
  P.life = 0.7 + vfxRng.range(0, 0.6);
  P.size0 = 0.14 * strength;
  P.size1 = 0.9 * strength;
  P.frame = Tile.Dust;
  P.r0 = 0.66; P.g0 = 0.62; P.b0 = 0.55; P.a0 = 0.22 * strength;
  P.r1 = 0.62; P.g1 = 0.6; P.b1 = 0.56; P.a1 = 0;
  P.fadeIn = 0.1; P.fadeOut = 0.6;
  const n = Math.round(2 + 4 * strength);
  for (let i = 0; i < n; i++) {
    const a = vfxRng.range(0, Math.PI * 2);
    const sp = vfxRng.range(0.3, 1.6) * strength;
    P.x = x + vfxRng.gauss() * 0.12;
    P.z = z + vfxRng.gauss() * 0.12;
    P.vx = Math.cos(a) * sp;
    P.vy = vfxRng.range(0.2, 0.9);
    P.vz = Math.sin(a) * sp;
    particles.emit(P);
  }
}

/** Rotor wash — a helicopter close to the ground. */
export function emitRotorWash(x: number, y: number, z: number, radius = 6, strength = 1): void {
  const g = walkableHeight(x, z);
  if (y - g > radius * 3) return;
  const water = isWater(x, z);
  const n = Math.round(3 + 5 * strength);
  for (let i = 0; i < n; i++) {
    const a = vfxRng.range(0, Math.PI * 2);
    const rr = radius * (0.4 + vfxRng.next() * 0.8);
    resetDesc();
    P.layer = "alpha";
    P.x = x + Math.cos(a) * rr;
    P.y = (water ? WORLD.seaLevel : g) + 0.1;
    P.z = z + Math.sin(a) * rr;
    P.vx = Math.cos(a) * (5 + 8 * strength);
    P.vy = vfxRng.range(0.4, 2.2) * strength;
    P.vz = Math.sin(a) * (5 + 8 * strength);
    P.drag = 1.6;
    P.gravity = water ? -6 : 0.4;
    P.turbulence = 1.2;
    P.wind = 0.5;
    P.life = 1.2 + vfxRng.range(0, 0.9);
    P.size0 = radius * 0.2;
    P.size1 = radius * 1.1;
    P.frame = water ? Tile.Splash : Tile.Dust;
    P.rot = vfxRng.range(0, 6.283);
    P.rotSpeed = vfxRng.range(-1.2, 1.2);
    if (water) { P.r0 = 0.96; P.g0 = 0.98; P.b0 = 1.0; P.a0 = 0.3; }
    else { P.r0 = 0.68; P.g0 = 0.63; P.b0 = 0.55; P.a0 = 0.24; }
    P.r1 = P.r0 * 0.92; P.g1 = P.g0 * 0.92; P.b1 = P.b0 * 0.92; P.a1 = 0;
    P.fadeIn = 0.1; P.fadeOut = 0.6;
    particles.emit(P);
  }
}
