/**
 * weapons/effects.ts — everything that happens at the muzzle.
 *
 * A single pistol shot, in order, over about 400 milliseconds:
 *
 *   t+0ms    flash sprite (3 randomised layers) and a real point light
 *   t+0ms    tracer, if this round is a tracer, travelling at 320 m/s
 *   t+8ms    casing ejects, tumbling, with a floor found by raycast
 *   t+20ms   muzzle smoke starts, drifting with `frame.windDirection`
 *   t+40ms   light is gone
 *   t+300ms  casing lands and tinks
 *   t+2s     smoke has dispersed
 *
 * Almost all of that is instanced quads out of `ParticlePool`; the exceptions
 * are the light (one real light, pooled), the casings (real rigid bodies when
 * Rapier is up) and the ordnance in flight (three small instanced meshes).
 *
 * Public API
 * ----------
 *   WeaponEffects
 *   .group           add to the scene once
 *   .muzzleFlash(...)  .tracer(...)  .ejectCasing(...)  .muzzleSmoke(...)
 *   .explosion(...)  .update(dt, camera)  .dispose()
 */
import * as THREE from "three";
import { QUALITY, type QualityTier } from "../config";
import { frame } from "../state/store";
import { makeRng, clamp, clamp01, type Rng } from "../math/rng";
import { terrainHeight } from "../geo/sfGeo";
import {
  ALL_SOLID,
  GROUP,
  interactionGroups,
  makeRayHit,
  raycast,
  rigidBodyPool,
  type BodyHandle,
} from "../physics";
import { ParticlePool, pspec } from "./particles";
import { dustTexture, flashTexture, smokeTexture, sparkTexture } from "./textures";
import { forEachProjectile, type Projectile } from "./ballistics";
import type { WeaponDef } from "./types";

const CASING_MASK = interactionGroups(0xffff, ALL_SOLID & ~GROUP.PLAYER);

/* ------------------------------------------------------------------ *
 * Casings
 * ------------------------------------------------------------------ */

interface Casing {
  alive: boolean;
  /** Rapier handle, or 0 when we are simulating it ourselves. */
  handle: BodyHandle;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  qx: number; qy: number; qz: number; qw: number;
  /** Analytic tumble. */
  spinX: number;
  spinY: number;
  spinZ: number;
  rx: number;
  ry: number;
  rz: number;
  age: number;
  life: number;
  floor: number;
  bounces: number;
  /** Radius, length — casings are visibly different per calibre. */
  r: number;
  len: number;
  /** Brass or steel tint. */
  tint: number;
  restTimer: number;
}

const MAX_CASINGS = 40;

/* ------------------------------------------------------------------ *
 * Ordnance in flight
 * ------------------------------------------------------------------ */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _pose = new Float32Array(7);
const _hit = makeRayHit();
/* Scratch that would otherwise be allocated inside the frame loop. */
const _color = new THREE.Color();
const _euler = new THREE.Euler();
const _axisX = new THREE.Vector3(1, 0, 0);
const _fwd = new THREE.Vector3(0, 0, -1);
const _zAxis = new THREE.Vector3(0, 0, 1);

export class WeaponEffects {
  readonly group = new THREE.Group();

  private flashPool: ParticlePool;
  private sparkPool: ParticlePool;
  private smokePool: ParticlePool;
  private dustPool: ParticlePool;
  private tracerPool: ParticlePool;

  /** Two pooled muzzle lights — enough for a shot overlapping its predecessor. */
  private lights: THREE.PointLight[] = [];
  private lightLife: number[] = [];
  private lightPeak: number[] = [];
  private lightCursor = 0;

  private casings: Casing[] = [];
  private casingMesh: THREE.InstancedMesh;
  private casingCursor = 0;

  private grenadeMesh: THREE.InstancedMesh;
  private rocketMesh: THREE.InstancedMesh;
  private stickyMesh: THREE.InstancedMesh;
  private ordnanceCount = { grenade: 0, rocket: 0, sticky: 0 };

  /** Additive expanding rings for explosions and heavy muzzle blast. */
  private rings: THREE.Mesh[] = [];
  private ringLife: number[] = [];
  private ringMax: number[] = [];
  private ringCursor = 0;
  private ringMat: THREE.ShaderMaterial;

  /** Heat shimmer quad; the weapon component parents it to the barrel. */
  readonly heatQuad: THREE.Mesh;
  private heatMat: THREE.ShaderMaterial;

  private rng: Rng = makeRng("sf-weapon-fx");
  private disposed = false;
  private tier: QualityTier;

  constructor(tier: QualityTier = "high") {
    this.tier = tier;
    const q = QUALITY[tier];
    // Budget: weapons are allowed a slice of the global particle cap, not all
    // of it — explosions, weather and destruction want the rest.
    const budget = clamp(Math.round(q.maxParticles * 0.09), 240, 2600);

    this.flashPool = new ParticlePool(48, flashTexture(), true, 12);
    this.tracerPool = new ParticlePool(96, sparkTexture(), true, 11);
    this.sparkPool = new ParticlePool(Math.round(budget * 0.45), sparkTexture(), true, 11);
    this.smokePool = new ParticlePool(Math.round(budget * 0.3), smokeTexture(), false, 9);
    this.dustPool = new ParticlePool(Math.round(budget * 0.25), dustTexture(), false, 9);

    this.group.add(
      this.flashPool.mesh,
      this.tracerPool.mesh,
      this.sparkPool.mesh,
      this.smokePool.mesh,
      this.dustPool.mesh,
    );

    /* ---- muzzle lights ---- */
    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0xffd6a0, 0, 12, 2);
      l.castShadow = false; // a 40 ms light casting shadows is a stall, not a look
      l.visible = false;
      this.lights.push(l);
      this.lightLife.push(0);
      this.lightPeak.push(0);
      this.group.add(l);
    }

    /* ---- casings ---- */
    for (let i = 0; i < MAX_CASINGS; i++) {
      this.casings.push({
        alive: false, handle: 0,
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        qx: 0, qy: 0, qz: 0, qw: 1,
        spinX: 0, spinY: 0, spinZ: 0, rx: 0, ry: 0, rz: 0,
        age: 0, life: 9, floor: -1e9, bounces: 0,
        r: 0.005, len: 0.025, tint: 0xb8863c, restTimer: 0,
      });
    }
    const casingGeo = new THREE.CylinderGeometry(1, 0.92, 1, 7, 1, false);
    // Model space: a unit cylinder along +Y, scaled per instance so one
    // geometry serves 9 mm through 12 gauge.
    //
    // The white vertex-colour attribute is not decoration: three only folds
    // `instanceColor` into the fragment when USE_COLOR is defined (i.e. the
    // material has vertexColors), and USE_COLOR without a `color` attribute
    // reads the WebGL default of black. This is the pair that makes per-casing
    // tint and fade work at all.
    casingGeo.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(casingGeo.attributes.position.count * 3).fill(1), 3),
    );
    const casingMat = new THREE.MeshStandardMaterial({
      color: 0xb8863c,
      metalness: 0.92,
      roughness: 0.28,
      vertexColors: true,
    });
    this.casingMesh = new THREE.InstancedMesh(casingGeo, casingMat, MAX_CASINGS);
    this.casingMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_CASINGS * 3).fill(1), 3,
    );
    this.casingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.casingMesh.frustumCulled = false;
    this.casingMesh.count = 0;
    this.casingMesh.castShadow = false;
    this.casingMesh.receiveShadow = false;
    this.group.add(this.casingMesh);

    /* ---- ordnance ---- */
    const grenadeGeo = new THREE.IcosahedronGeometry(0.043, 1);
    const grenadeMat = new THREE.MeshStandardMaterial({
      color: 0x39412f, metalness: 0.5, roughness: 0.7,
      emissive: 0x220000, emissiveIntensity: 0.4,
    });
    this.grenadeMesh = new THREE.InstancedMesh(grenadeGeo, grenadeMat, 16);
    this.grenadeMesh.count = 0;
    this.grenadeMesh.frustumCulled = false;
    this.grenadeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const rocketGeo = new THREE.ConeGeometry(0.045, 0.34, 8);
    rocketGeo.rotateX(-Math.PI / 2); // point down -Z, matching the flight axis
    const rocketMat = new THREE.MeshStandardMaterial({
      color: 0x4a4b45, metalness: 0.6, roughness: 0.45,
      emissive: 0xff7a22, emissiveIntensity: 1.6,
    });
    this.rocketMesh = new THREE.InstancedMesh(rocketGeo, rocketMat, 16);
    this.rocketMesh.count = 0;
    this.rocketMesh.frustumCulled = false;
    this.rocketMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const stickyGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.035, 10);
    stickyGeo.rotateX(Math.PI / 2);
    const stickyMat = new THREE.MeshStandardMaterial({
      color: 0x22262a, metalness: 0.4, roughness: 0.55,
      emissive: 0x22ffcc, emissiveIntensity: 1.2,
    });
    this.stickyMesh = new THREE.InstancedMesh(stickyGeo, stickyMat, 24);
    this.stickyMesh.count = 0;
    this.stickyMesh.frustumCulled = false;
    this.stickyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.group.add(this.grenadeMesh, this.rocketMesh, this.stickyMesh);

    /* ---- shockwave rings ---- */
    this.ringMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xffbb70) } },
      vertexShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
#include <logdepthbuf_pars_fragment>
        uniform vec3 uColor;
        uniform float uAlpha;
        varying vec2 vUv;
        void main() {
  #include <logdepthbuf_fragment>
          float r = length(vUv - 0.5) * 2.0;
          // A thin shell with a soft inner falloff — a blast front, not a disc.
          float shell = smoothstep(0.72, 0.98, r) * (1.0 - smoothstep(0.98, 1.0, r));
          float inner = (1.0 - smoothstep(0.0, 0.95, r)) * 0.18;
          float a = (shell + inner) * uAlpha;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    (this.ringMat.uniforms as Record<string, THREE.IUniform>).uAlpha = { value: 0 };
    const ringGeo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < 4; i++) {
      const mat = this.ringMat.clone();
      const m = new THREE.Mesh(ringGeo, mat);
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 12;
      this.rings.push(m);
      this.ringLife.push(0);
      this.ringMax.push(1);
      this.group.add(m);
    }

    /* ---- barrel heat shimmer ---- */
    this.heatMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uHeat: { value: 0 },
      },
      vertexShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
#include <logdepthbuf_pars_fragment>
        uniform float uTime;
        uniform float uHeat;
        varying vec2 vUv;

        // Cheap value noise: the shimmer only needs to be plausible, and this
        // runs over a few hundred pixels of screen at most.
        float h(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
        float n(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1,0)), f.x),
                     mix(h(i + vec2(0,1)), h(i + vec2(1,1)), f.x), f.y);
        }

        void main() {
  #include <logdepthbuf_fragment>
          if (uHeat < 0.02) discard;
          vec2 uv = vUv;
          // Rising columns of hot air: scroll up, stretch vertically.
          float t = uTime * 1.6;
          float v = n(vec2(uv.x * 9.0, uv.y * 3.0 - t)) * 0.6
                  + n(vec2(uv.x * 21.0, uv.y * 6.0 - t * 1.7)) * 0.4;
          float mask = smoothstep(0.0, 0.28, uv.y) * (1.0 - smoothstep(0.55, 1.0, uv.y));
          mask *= smoothstep(0.0, 0.2, uv.x) * (1.0 - smoothstep(0.8, 1.0, uv.x));
          float a = mask * uHeat * (0.10 + v * 0.22);
          if (a < 0.004) discard;
          // Warm, nearly colourless: heat haze is a distortion, and without a
          // refraction buffer the honest fake is a faint warm veil.
          gl_FragColor = vec4(vec3(1.0, 0.72, 0.45) * (0.5 + v * 0.5), a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.heatQuad = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.34), this.heatMat);
    this.heatQuad.frustumCulled = false;
    this.heatQuad.renderOrder = 13;
    this.heatQuad.visible = false;
  }

  setQuality(tier: QualityTier): void {
    this.tier = tier;
  }

  /* ---------------------------------------------------------------- *
   * Muzzle
   * ---------------------------------------------------------------- */

  /**
   * Flash, light and unburnt powder.
   *
   * Three sprite layers with independent tiles, sizes and rotations, so the
   * same weapon never flashes identically twice: a wide short-lived corona, a
   * tight bright core, and a forward plume that scales with the calibre.
   */
  muzzleFlash(
    def: WeaponDef,
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
  ): void {
    if (def.flashScale <= 0) return;
    const rng = this.rng;
    const c = _color.setHex(def.flashColor);
    const s = def.flashScale;

    // Core.
    pspec.x = x + dx * 0.02; pspec.y = y + dy * 0.02; pspec.z = z + dz * 0.02;
    pspec.vx = dx * 1.5; pspec.vy = dy * 1.5; pspec.vz = dz * 1.5;
    pspec.life = 0.036 + rng.next() * 0.02;
    pspec.size = 0.19 * s * (0.85 + rng.next() * 0.35);
    pspec.sizeEnd = pspec.size * 1.45;
    pspec.r = c.r * 1.6; pspec.g = c.g * 1.5; pspec.b = c.b * 1.35;
    pspec.alpha = 1;
    pspec.rot = rng.next() * Math.PI * 2;
    pspec.spin = rng.gauss() * 6;
    pspec.drag = 2; pspec.gravity = 0; pspec.windPull = 0;
    pspec.tile = rng.int(0, 3);
    pspec.floor = -1e9; pspec.fadeIn = 0.02; pspec.stretch = 0;
    this.flashPool.emit();

    // Corona: bigger, dimmer, shorter.
    pspec.life = 0.028 + rng.next() * 0.016;
    pspec.size = 0.34 * s * (0.8 + rng.next() * 0.5);
    pspec.sizeEnd = pspec.size * 1.8;
    pspec.alpha = 0.55;
    pspec.rot = rng.next() * Math.PI * 2;
    pspec.tile = rng.int(0, 3);
    this.flashPool.emit();

    // Forward plume, stretched down the barrel line.
    pspec.x = x + dx * 0.12 * s; pspec.y = y + dy * 0.12 * s; pspec.z = z + dz * 0.12 * s;
    pspec.vx = dx * 26; pspec.vy = dy * 26; pspec.vz = dz * 26;
    pspec.life = 0.032;
    pspec.size = 0.1 * s;
    pspec.sizeEnd = 0.06 * s;
    pspec.alpha = 0.85;
    pspec.stretch = 0.5;
    pspec.tile = rng.int(0, 3);
    this.flashPool.emit();
    pspec.stretch = 0;

    // Unburnt powder: a handful of embers thrown forward and down.
    const embers = Math.round(3 + s * 5);
    for (let i = 0; i < embers; i++) {
      const sp = 4 + rng.next() * 13 * s;
      pspec.x = x; pspec.y = y; pspec.z = z;
      pspec.vx = dx * sp + rng.gauss() * 1.6;
      pspec.vy = dy * sp + rng.gauss() * 1.6 + 0.4;
      pspec.vz = dz * sp + rng.gauss() * 1.6;
      pspec.life = 0.12 + rng.next() * 0.3;
      pspec.size = 0.008 + rng.next() * 0.014;
      pspec.sizeEnd = 0.002;
      pspec.r = 1.7; pspec.g = 0.85; pspec.b = 0.35;
      pspec.alpha = 0.9;
      pspec.drag = 2.4; pspec.gravity = -8; pspec.windPull = 0.2;
      pspec.stretch = 0.85;
      pspec.tile = 0;
      pspec.fadeIn = 0.02;
      this.sparkPool.emit();
    }
    pspec.stretch = 0;

    /* ---- the light ---- */
    const i = this.lightCursor;
    this.lightCursor = (this.lightCursor + 1) % this.lights.length;
    const l = this.lights[i];
    l.position.set(x + dx * 0.15, y + dy * 0.15, z + dz * 0.15);
    l.color.setHex(def.flashColor);
    l.distance = def.flashRadius;
    l.decay = 2;
    this.lightPeak[i] = def.flashLight * (0.82 + rng.next() * 0.36);
    this.lightLife[i] = 0.055 + def.flashScale * 0.02;
    l.intensity = this.lightPeak[i];
    l.visible = true;

    // Heavy weapons throw a visible blast ring off the brake.
    if (def.flashScale >= 1.3) {
      this.ring(x + dx * 0.2, y + dy * 0.2, z + dz * 0.2, 0.35 + def.flashScale * 0.5, 0.12, def.flashColor);
    }
  }

  /** Powder smoke, drifting on the city wind. */
  muzzleSmoke(
    def: WeaponDef,
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
  ): void {
    if (def.smoke <= 0) return;
    const rng = this.rng;
    const n = Math.max(1, Math.round(def.smoke * 2.2));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const sp = 1.4 + rng.next() * 2.6;
      pspec.x = x + dx * (0.05 + t * 0.35);
      pspec.y = y + dy * (0.05 + t * 0.35);
      pspec.z = z + dz * (0.05 + t * 0.35);
      pspec.vx = dx * sp + rng.gauss() * 0.5;
      pspec.vy = dy * sp + rng.gauss() * 0.4 + 0.5;
      pspec.vz = dz * sp + rng.gauss() * 0.5;
      pspec.life = 0.7 + rng.next() * 1.1 * def.smoke;
      pspec.size = 0.05 + rng.next() * 0.06;
      pspec.sizeEnd = 0.36 + rng.next() * 0.5 * def.smoke;
      // Powder smoke is warm grey, not white, and it lifts as it cools.
      const v = 0.52 + rng.next() * 0.16;
      pspec.r = v * 1.02; pspec.g = v; pspec.b = v * 0.95;
      pspec.alpha = 0.22 + rng.next() * 0.16;
      pspec.rot = rng.next() * Math.PI * 2;
      pspec.spin = rng.gauss() * 0.7;
      pspec.drag = 1.9; pspec.gravity = 0.35; pspec.windPull = 0.8;
      pspec.tile = 0; pspec.floor = -1e9; pspec.fadeIn = 0.18; pspec.stretch = 0;
      this.smokePool.emit();
    }
  }

  /**
   * Tracer.
   *
   * Only fired for the fraction of rounds the weapon's belt actually carries
   * them, and — importantly — it travels at the real muzzle velocity, so at
   * 300 m the streak visibly arrives after the crack. Rounds that hit inside
   * ten metres get no tracer at all: at that range it is a strobe, not a
   * streak.
   */
  tracer(
    def: WeaponDef,
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    distance: number,
  ): void {
    if (distance < 9) return;
    const rng = this.rng;
    const c = _color.setHex(def.tracerColor);
    const speed = Math.max(140, def.muzzleVelocity);
    pspec.x = x; pspec.y = y; pspec.z = z;
    pspec.vx = dx * speed; pspec.vy = dy * speed; pspec.vz = dz * speed;
    pspec.life = clamp(distance / speed, 0.02, 2.4);
    pspec.size = 0.055 + rng.next() * 0.02;
    pspec.sizeEnd = pspec.size * 0.7;
    pspec.r = c.r * 2.2; pspec.g = c.g * 1.7; pspec.b = c.b * 1.2;
    pspec.alpha = 0.95;
    pspec.rot = 0; pspec.spin = 0;
    pspec.drag = 0; pspec.gravity = -1.2; pspec.windPull = 0;
    pspec.tile = 0; pspec.floor = -1e9; pspec.fadeIn = 0.02;
    pspec.stretch = 1;
    this.tracerPool.emit();
    pspec.stretch = 0;
  }

  /* ---------------------------------------------------------------- *
   * Casings
   * ---------------------------------------------------------------- */

  /**
   * Eject a shell.
   *
   * Rapier gets it when Rapier is up — a casing that bounces off the wall
   * behind you and rolls down the sidewalk is free comedy. When it is not, we
   * integrate it ourselves against a floor found by one downward raycast, so
   * shells still land on the roof you are standing on rather than the terrain
   * eighty metres below.
   */
  ejectCasing(
    def: WeaponDef,
    x: number, y: number, z: number,
    rightX: number, rightY: number, rightZ: number,
    upX: number, upY: number, upZ: number,
    inheritX = 0, inheritY = 0, inheritZ = 0,
  ): void {
    const view = def.view;
    if (view.casing[1] <= 0 || view.ejectSide === 0) return;
    const rng = this.rng;
    const c = this.casings[this.casingCursor];
    this.casingCursor = (this.casingCursor + 1) % MAX_CASINGS;
    if (c.alive && c.handle) rigidBodyPool.despawn(c.handle);

    const side = view.ejectSide;
    // Up and out, with the tumble every real ejection has.
    const sp = 2.1 + rng.next() * 1.5;
    const vx = rightX * side * sp + upX * (1.6 + rng.next()) + rng.gauss() * 0.35 + inheritX;
    const vy = rightY * side * sp + upY * (1.6 + rng.next()) + rng.gauss() * 0.35 + inheritY;
    const vz = rightZ * side * sp + upZ * (1.6 + rng.next()) + rng.gauss() * 0.35 + inheritZ;

    c.alive = true;
    c.x = x; c.y = y; c.z = z;
    c.vx = vx; c.vy = vy; c.vz = vz;
    c.age = 0;
    c.life = 7 + rng.next() * 3;
    c.bounces = 0;
    c.restTimer = 0;
    c.r = view.casing[0];
    c.len = view.casing[1];
    // Shotgun hulls are plastic with a brass head; rifle brass is brass.
    c.tint = def.cls === "shotgun" ? 0xa4241f : 0xc79a4a;
    c.rx = rng.next() * 6.28;
    c.ry = rng.next() * 6.28;
    c.rz = rng.next() * 6.28;
    c.spinX = rng.gauss() * 22;
    c.spinY = rng.gauss() * 14;
    c.spinZ = rng.gauss() * 26;

    c.handle = rigidBodyPool.spawn({
      shape: "cylinder",
      radius: c.r,
      hy: c.len * 0.5,
      x, y, z,
      vx, vy, vz,
      avx: c.spinX * 0.4, avy: c.spinY * 0.4, avz: c.spinZ * 0.4,
      density: 8400, // brass
      friction: 0.55,
      restitution: 0.42,
      linearDamping: 0.05,
      angularDamping: 0.12,
      lifetime: c.life,
      groups: CASING_MASK,
      kind: "debris",
      surface: "metal",
      priority: 0,
      interpolate: true,
    });

    if (!c.handle) {
      // Analytic path: find the floor once, then integrate.
      const found = raycast(x, y, z, 0, -1, 0, 40, _hit, { groups: CASING_MASK, skipSurface: true });
      c.floor = found ? _hit.py + c.r : terrainHeight(x, z) + c.r;
    }
  }

  /** Casing tink, called when a shell first contacts something. */
  private onCasingLand(c: Casing, speed: number): void {
    // Routed through the impacts module's audio path by the weapon component;
    // the effects layer only decides *that* it happened.
    this.casingLandHandler?.(c.x, c.y, c.z, clamp01(speed / 5));
  }

  /** Set by the weapon component so casing tinks reach the audio bridge. */
  casingLandHandler: ((x: number, y: number, z: number, strength: number) => void) | null = null;

  /* ---------------------------------------------------------------- *
   * Explosions
   * ---------------------------------------------------------------- */

  private ring(
    x: number, y: number, z: number,
    maxR: number, life: number, colour: number,
    ground = false,
  ): void {
    const i = this.ringCursor;
    this.ringCursor = (this.ringCursor + 1) % this.rings.length;
    const m = this.rings[i];
    m.position.set(x, y, z);
    m.scale.setScalar(0.2);
    m.visible = true;
    this.ringLife[i] = life;
    this.ringMax[i] = maxR;
    const mat = m.material as THREE.ShaderMaterial;
    (mat.uniforms.uColor.value as THREE.Color).setHex(colour);
    mat.uniforms.uAlpha.value = 1;
    m.userData.life0 = life;
    // A blast wave lies on the ground; a muzzle blast ring faces the player.
    m.userData.ground = ground;
  }

  /**
   * The full fireball.
   *
   * Four layers, because a single "orange puff" is the most obvious tell of an
   * amateur explosion: a white-hot core, a body of burning fuel that rises and
   * darkens, a ground-hugging dust ring, and a spray of ejecta that arcs and
   * lands. Plus a real light, and a shockwave ring on the ground plane.
   */
  explosion(x: number, y: number, z: number, radius: number, def?: WeaponDef): void {
    const rng = this.rng;
    const scale = clamp(radius / 8, 0.4, 2.4);

    // Core.
    for (let i = 0; i < 5; i++) {
      pspec.x = x + rng.gauss() * radius * 0.08;
      pspec.y = y + rng.gauss() * radius * 0.08;
      pspec.z = z + rng.gauss() * radius * 0.08;
      pspec.vx = rng.gauss() * 3; pspec.vy = 1.5 + rng.next() * 3; pspec.vz = rng.gauss() * 3;
      pspec.life = 0.14 + rng.next() * 0.12;
      pspec.size = radius * 0.3 * (0.7 + rng.next() * 0.5);
      pspec.sizeEnd = pspec.size * 1.9;
      pspec.r = 2.6; pspec.g = 1.9; pspec.b = 1.1;
      pspec.alpha = 1;
      pspec.rot = rng.next() * 6.28; pspec.spin = rng.gauss() * 2;
      pspec.drag = 2.2; pspec.gravity = 1.5; pspec.windPull = 0;
      pspec.tile = rng.int(0, 3); pspec.floor = -1e9; pspec.fadeIn = 0.04; pspec.stretch = 0;
      this.flashPool.emit();
    }

    // Burning body → smoke.
    const bodyCount = Math.round(10 * scale);
    for (let i = 0; i < bodyCount; i++) {
      const a = rng.next() * Math.PI * 2;
      const r = rng.next() * radius * 0.55;
      const sp = 2 + rng.next() * 7 * scale;
      pspec.x = x + Math.cos(a) * r;
      pspec.y = y + rng.next() * radius * 0.3;
      pspec.z = z + Math.sin(a) * r;
      pspec.vx = Math.cos(a) * sp; pspec.vy = 2 + rng.next() * 5 * scale; pspec.vz = Math.sin(a) * sp;
      pspec.life = 1.3 + rng.next() * 2.2 * scale;
      pspec.size = radius * 0.16 * (0.7 + rng.next() * 0.6);
      pspec.sizeEnd = radius * (0.6 + rng.next() * 0.7);
      const v = 0.2 + rng.next() * 0.22;
      pspec.r = v * 1.1; pspec.g = v; pspec.b = v * 0.94;
      pspec.alpha = 0.5 + rng.next() * 0.3;
      pspec.rot = rng.next() * 6.28; pspec.spin = rng.gauss() * 0.5;
      pspec.drag = 1.1; pspec.gravity = 0.8; pspec.windPull = 0.6;
      pspec.tile = 0; pspec.fadeIn = 0.1;
      this.smokePool.emit();
    }

    // Ground dust ring.
    const ground = terrainHeight(x, z);
    if (Math.abs(y - ground) < radius) {
      const dustCount = Math.round(12 * scale);
      for (let i = 0; i < dustCount; i++) {
        const a = (i / dustCount) * Math.PI * 2 + rng.gauss() * 0.2;
        const sp = 5 + rng.next() * 11 * scale;
        pspec.x = x + Math.cos(a) * radius * 0.2;
        pspec.y = ground + 0.25 + rng.next() * 0.5;
        pspec.z = z + Math.sin(a) * radius * 0.2;
        pspec.vx = Math.cos(a) * sp; pspec.vy = 0.7 + rng.next() * 1.6; pspec.vz = Math.sin(a) * sp;
        pspec.life = 1.6 + rng.next() * 2.4;
        pspec.size = radius * 0.14;
        pspec.sizeEnd = radius * (0.5 + rng.next() * 0.6);
        const v = 0.45 + rng.next() * 0.2;
        pspec.r = v * 1.06; pspec.g = v; pspec.b = v * 0.86;
        pspec.alpha = 0.3 + rng.next() * 0.2;
        pspec.rot = rng.next() * 6.28; pspec.spin = rng.gauss() * 0.4;
        pspec.drag = 1.4; pspec.gravity = -0.6; pspec.windPull = 0.7;
        pspec.floor = ground + 0.1;
        pspec.tile = 0; pspec.fadeIn = 0.12;
        this.dustPool.emit();
      }
    }

    // Ejecta.
    const ejecta = Math.round(18 * scale);
    for (let i = 0; i < ejecta; i++) {
      const a = rng.next() * Math.PI * 2;
      const el = rng.next() * 1.2;
      const sp = 8 + rng.next() * 26 * scale;
      pspec.x = x; pspec.y = y; pspec.z = z;
      pspec.vx = Math.cos(a) * Math.cos(el) * sp;
      pspec.vy = Math.sin(el) * sp;
      pspec.vz = Math.sin(a) * Math.cos(el) * sp;
      pspec.life = 0.5 + rng.next() * 1.4;
      pspec.size = 0.02 + rng.next() * 0.05;
      pspec.sizeEnd = 0.006;
      pspec.r = 2.2; pspec.g = 1.0 + rng.next() * 0.4; pspec.b = 0.35;
      pspec.alpha = 1;
      pspec.drag = 0.5; pspec.gravity = -14; pspec.windPull = 0.1;
      pspec.stretch = 0.9; pspec.tile = 0; pspec.floor = ground; pspec.fadeIn = 0.03;
      this.sparkPool.emit();
    }
    pspec.stretch = 0;
    pspec.floor = -1e9;

    this.ring(x, ground + 0.35, z, radius * 2.4, 0.5, 0xffc47a, true);

    // Light: bright, brief, and pooled with the muzzle lights.
    const i = this.lightCursor;
    this.lightCursor = (this.lightCursor + 1) % this.lights.length;
    const l = this.lights[i];
    l.position.set(x, y + 0.6, z);
    l.color.setHex(0xffa54a);
    l.distance = radius * 6;
    this.lightPeak[i] = 60 * scale;
    this.lightLife[i] = 0.42;
    l.intensity = this.lightPeak[i];
    l.visible = true;
    void def;
  }

  /* ---------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------- */

  update(dt: number, camera: THREE.Camera, heat: number): void {
    if (this.disposed) return;
    const windX = frame.windDirection.x * frame.windSpeed * 0.35;
    const windZ = frame.windDirection.y * frame.windSpeed * 0.35;

    this.flashPool.update(dt, 0, 0);
    this.tracerPool.update(dt, 0, 0);
    this.sparkPool.update(dt, windX * 0.3, windZ * 0.3);
    this.smokePool.update(dt, windX, windZ);
    this.dustPool.update(dt, windX, windZ);

    /* ---- lights ---- */
    for (let i = 0; i < this.lights.length; i++) {
      if (this.lightLife[i] <= 0) continue;
      this.lightLife[i] -= dt;
      const l = this.lights[i];
      if (this.lightLife[i] <= 0) {
        l.visible = false;
        l.intensity = 0;
        continue;
      }
      // Quadratic decay: a muzzle flash does not fade linearly, it snaps out.
      const t = clamp01(this.lightLife[i] / 0.42);
      l.intensity = this.lightPeak[i] * t * t;
    }

    /* ---- rings ---- */
    for (let i = 0; i < this.rings.length; i++) {
      if (this.ringLife[i] <= 0) continue;
      this.ringLife[i] -= dt;
      const m = this.rings[i];
      const life0 = (m.userData.life0 as number) || 0.5;
      if (this.ringLife[i] <= 0) {
        m.visible = false;
        continue;
      }
      const t = 1 - this.ringLife[i] / life0;
      const s = this.ringMax[i] * (0.15 + t * 0.85);
      m.scale.set(s, s, s);
      const mat = m.material as THREE.ShaderMaterial;
      mat.uniforms.uAlpha.value = (1 - t) * (1 - t) * 0.9;
      if (m.userData.ground) m.quaternion.setFromAxisAngle(_axisX, -Math.PI / 2);
      else m.quaternion.copy(camera.quaternion);
    }

    /* ---- casings ---- */
    this.updateCasings(dt);

    /* ---- ordnance ---- */
    this.updateOrdnance(dt);

    /* ---- heat shimmer ---- */
    this.heatMat.uniforms.uTime.value = frame.time;
    this.heatMat.uniforms.uHeat.value = heat;
    this.heatQuad.visible = heat > 0.05;
  }

  private updateCasings(dt: number): void {
    let count = 0;
    const colors = this.casingMesh.instanceColor!.array as Float32Array;
    for (let i = 0; i < this.casings.length; i++) {
      const c = this.casings[i];
      if (!c.alive) continue;
      c.age += dt;
      if (c.age > c.life) {
        if (c.handle) rigidBodyPool.despawn(c.handle);
        c.alive = false;
        c.handle = 0;
        continue;
      }

      if (c.handle) {
        if (!rigidBodyPool.sample(c.handle, _pose)) {
          c.alive = false;
          c.handle = 0;
          continue;
        }
        const body = rigidBodyPool.bodyOf(c.handle);
        if (body) {
          const lv = body.linvel();
          // First contact: the vertical velocity flips. Cheap, reliable, and
          // it costs nothing compared to subscribing to contact events for
          // forty pieces of brass.
          if (c.vy < -0.6 && lv.y > 0.15 && c.bounces < 2) {
            c.bounces++;
            this.onCasingLand(c, Math.abs(c.vy));
          }
          c.vy = lv.y;
        }
        c.x = _pose[0]; c.y = _pose[1]; c.z = _pose[2];
        _q.set(_pose[3], _pose[4], _pose[5], _pose[6]);
      } else {
        // Analytic tumble.
        c.vy -= 22 * dt;
        c.vx *= Math.exp(-0.6 * dt);
        c.vz *= Math.exp(-0.6 * dt);
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.z += c.vz * dt;
        if (c.y <= c.floor) {
          c.y = c.floor;
          if (c.vy < -0.35 && c.bounces < 3) {
            c.bounces++;
            this.onCasingLand(c, Math.abs(c.vy));
            c.vy = -c.vy * 0.36;
            c.vx *= 0.55;
            c.vz *= 0.55;
            c.spinX *= 0.5;
            c.spinZ *= 0.5;
          } else {
            c.vy = 0;
            c.vx *= 0.82;
            c.vz *= 0.82;
            c.spinX *= 0.7;
            c.spinY *= 0.7;
            c.spinZ *= 0.7;
            c.restTimer += dt;
          }
        }
        c.rx += c.spinX * dt;
        c.ry += c.spinY * dt;
        c.rz += c.spinZ * dt;
        _q.setFromEuler(_euler.set(c.rx, c.ry, c.rz));
      }

      // Fade the last half-second so despawn is not a pop.
      const remain = c.life - c.age;
      const fade = remain < 0.6 ? remain / 0.6 : 1;
      _v.set(c.x, c.y, c.z);
      _scale.set(c.r * 2, c.len, c.r * 2);
      _m.compose(_v, _q, _scale);
      this.casingMesh.setMatrixAt(count, _m);
      _color.setHex(c.tint);
      colors[count * 3] = _color.r * fade;
      colors[count * 3 + 1] = _color.g * fade;
      colors[count * 3 + 2] = _color.b * fade;
      count++;
    }
    this.casingMesh.count = count;
    if (count > 0) {
      this.casingMesh.instanceMatrix.needsUpdate = true;
      this.casingMesh.instanceColor!.needsUpdate = true;
    }
  }

  private updateOrdnance(dt: number): void {
    let ng = 0;
    let nr = 0;
    let ns = 0;
    const rng = this.rng;
    forEachProjectile((p: Projectile) => {
      _v.set(p.x, p.y, p.z);
      if (p.kind === "rocket") {
        _v2.set(p.vx, p.vy, p.vz);
        if (_v2.lengthSq() > 1e-6) {
          _v2.normalize();
          _q.setFromUnitVectors(_fwd, _v2);
        }
        _scale.set(1, 1, 1);
        _m.compose(_v, _q, _scale);
        if (nr < 16) this.rocketMesh.setMatrixAt(nr++, _m);

        // Motor plume: dense, short-lived, always behind the rocket.
        p.trail += dt;
        while (p.trail > 0.012) {
          p.trail -= 0.012;
          pspec.x = p.x - _v2.x * 0.18;
          pspec.y = p.y - _v2.y * 0.18;
          pspec.z = p.z - _v2.z * 0.18;
          pspec.vx = -_v2.x * 6 + rng.gauss() * 1.2;
          pspec.vy = -_v2.y * 6 + rng.gauss() * 1.2 + 0.4;
          pspec.vz = -_v2.z * 6 + rng.gauss() * 1.2;
          pspec.life = 0.8 + rng.next() * 1.1;
          pspec.size = 0.18;
          pspec.sizeEnd = 1.5 + rng.next();
          const v = 0.42 + rng.next() * 0.2;
          pspec.r = v; pspec.g = v * 0.98; pspec.b = v * 0.96;
          pspec.alpha = 0.3;
          pspec.rot = rng.next() * 6.28; pspec.spin = rng.gauss() * 0.5;
          pspec.drag = 1.2; pspec.gravity = 0.5; pspec.windPull = 0.9;
          pspec.tile = 0; pspec.floor = -1e9; pspec.fadeIn = 0.1; pspec.stretch = 0;
          this.smokePool.emit();

          if (p.burn > 0) {
            pspec.x = p.x - _v2.x * 0.2;
            pspec.y = p.y - _v2.y * 0.2;
            pspec.z = p.z - _v2.z * 0.2;
            pspec.vx = -_v2.x * 20; pspec.vy = -_v2.y * 20; pspec.vz = -_v2.z * 20;
            pspec.life = 0.06;
            pspec.size = 0.14;
            pspec.sizeEnd = 0.05;
            pspec.r = 2.4; pspec.g = 1.3; pspec.b = 0.5;
            pspec.alpha = 1;
            pspec.drag = 3; pspec.gravity = 0; pspec.stretch = 0.6;
            pspec.tile = rng.int(0, 3);
            this.flashPool.emit();
            pspec.stretch = 0;
          }
        }
      } else if (p.kind === "sticky") {
        if (p.stuck) {
          // Align the puck to the surface it stuck to.
          _v2.set(p.snx, p.sny, p.snz);
          _q.setFromUnitVectors(_zAxis, _v2);
        } else {
          _q.setFromEuler(_euler.set(p.spin, p.spin * 0.7, 0));
        }
        _scale.set(1, 1, 1);
        _m.compose(_v, _q, _scale);
        if (ns < 24) this.stickyMesh.setMatrixAt(ns++, _m);
        // Blinking arming light.
        if (p.stuck && Math.sin(frame.time * 9) > 0.7) {
          pspec.x = p.x + p.snx * 0.03;
          pspec.y = p.y + p.sny * 0.03;
          pspec.z = p.z + p.snz * 0.03;
          pspec.vx = 0; pspec.vy = 0; pspec.vz = 0;
          pspec.life = 0.09;
          pspec.size = 0.05; pspec.sizeEnd = 0.03;
          pspec.r = 0.3; pspec.g = 2.2; pspec.b = 1.6;
          pspec.alpha = 0.9;
          pspec.drag = 0; pspec.gravity = 0; pspec.tile = 0;
          pspec.stretch = 0; pspec.fadeIn = 0.1; pspec.floor = -1e9;
          this.flashPool.emit();
        }
      } else {
        _q.setFromEuler(_euler.set(p.spin, p.spin * 0.6, p.spin * 0.3));
        _scale.set(1, 1, 1);
        _m.compose(_v, _q, _scale);
        if (ng < 16) this.grenadeMesh.setMatrixAt(ng++, _m);
        // A live grenade smokes faintly from the fuse.
        p.trail += dt;
        if (p.trail > 0.05) {
          p.trail = 0;
          pspec.x = p.x; pspec.y = p.y + 0.03; pspec.z = p.z;
          pspec.vx = rng.gauss() * 0.3; pspec.vy = 0.8; pspec.vz = rng.gauss() * 0.3;
          pspec.life = 0.5 + rng.next() * 0.4;
          pspec.size = 0.03; pspec.sizeEnd = 0.16;
          pspec.r = 0.6; pspec.g = 0.58; pspec.b = 0.56;
          pspec.alpha = 0.18;
          pspec.rot = rng.next() * 6.28; pspec.spin = rng.gauss() * 0.6;
          pspec.drag = 1.6; pspec.gravity = 0.5; pspec.windPull = 0.9;
          pspec.tile = 0; pspec.fadeIn = 0.2; pspec.stretch = 0; pspec.floor = -1e9;
          this.smokePool.emit();
        }
      }
    });
    this.grenadeMesh.count = ng;
    this.rocketMesh.count = nr;
    this.stickyMesh.count = ns;
    if (ng) this.grenadeMesh.instanceMatrix.needsUpdate = true;
    if (nr) this.rocketMesh.instanceMatrix.needsUpdate = true;
    if (ns) this.stickyMesh.instanceMatrix.needsUpdate = true;
    this.ordnanceCount.grenade = ng;
    this.ordnanceCount.rocket = nr;
    this.ordnanceCount.sticky = ns;
  }

  /** Access for the impact system, which shares these pools. */
  get sparks(): ParticlePool {
    return this.sparkPool;
  }
  get smoke(): ParticlePool {
    return this.smokePool;
  }
  get dust(): ParticlePool {
    return this.dustPool;
  }
  get flashes(): ParticlePool {
    return this.flashPool;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.casings) {
      if (c.handle) rigidBodyPool.despawn(c.handle);
      c.alive = false;
    }
    this.flashPool.dispose();
    this.tracerPool.dispose();
    this.sparkPool.dispose();
    this.smokePool.dispose();
    this.dustPool.dispose();
    this.casingMesh.geometry.dispose();
    (this.casingMesh.material as THREE.Material).dispose();
    this.grenadeMesh.geometry.dispose();
    (this.grenadeMesh.material as THREE.Material).dispose();
    this.rocketMesh.geometry.dispose();
    (this.rocketMesh.material as THREE.Material).dispose();
    this.stickyMesh.geometry.dispose();
    (this.stickyMesh.material as THREE.Material).dispose();
    for (const r of this.rings) (r.material as THREE.Material).dispose();
    if (this.rings[0]) this.rings[0].geometry.dispose();
    this.ringMat.dispose();
    this.heatQuad.geometry.dispose();
    this.heatMat.dispose();
    this.group.clear();
  }
}
