/**
 * vfx/explosion.ts — the hero effect.
 *
 * In a Just Cause game the explosion *is* the product, so this is built the way
 * a film explosion is built: as a stack of layers with different timings, not
 * as one "explosion sprite". The order below is the order they read on screen,
 * and every one of them is doing a job the others cannot:
 *
 *   t = 0.000  FLASH        one huge additive star, 60 ms. Sells the energy.
 *   t = 0.000  LIGHT        a real point light, 4 ms of overexposure, then decay.
 *   t = 0.005  SHOCKWAVE    ground ring + air shell, expands at ~340 m/s.
 *   t = 0.010  FIREBALL     additive hot core, expands and cools.
 *   t = 0.030  EMBERS       velocity-stretched sparks, the fastest a few with ribbons.
 *   t = 0.040  DEBRIS       real rigid bodies (debris.ts), thrown on the blast vector.
 *   t = 0.050  GROUND DUST  radial wave along the surface — reads the *size*.
 *   t = 0.080  SMOKE        alpha-blended flipbook, rises, cools, billows.
 *   t = 0.120  HEAT HAZE    slow, near-invisible distortion sprites.
 *   t = 0.150  SCORCH       permanent decal.
 *   t = 0.900  SECONDARY    the delayed column of black smoke that lingers.
 *
 * ## Yield
 *
 * Everything scales from one number, `power` (roughly "blast radius in metres"),
 * because the alternative — hand-tuning six separate presets — guarantees they
 * drift apart. The named yields are just constants feeding that number, plus a
 * few genuinely categorical differences: a fuel tank burns afterwards, a
 * grenade does not; a helicopter throws a rotor.
 *
 * ## Shockwave distortion
 *
 * Real screen-space refraction needs the scene colour buffer, which belongs to
 * the post-processing stack, not here. So this module publishes its live
 * shockwaves into `shockwaveBuffer` — a fixed Float32Array any post pass can
 * read with zero coupling — *and* draws a self-sufficient compression shell so
 * the effect is complete even if nothing ever consumes that buffer.
 */
import * as THREE from "three";
import { QUALITY, type QualityTier } from "../config";
import { frame } from "../state/store";
import { clamp01, smoothstep } from "../math/rng";
import { isWater, walkableHeight } from "../geo/sfGeo";
import {
  Billboard, P, budget, emitCone, emitRing, emitSphere, particles, resetDesc, vfxRng,
} from "./particles";
import { Tile } from "./textures";
import { scorchDecal, oilDecal } from "./decals";
import { spawnDebrisBurst } from "./debris";
import { igniteFire } from "./fire";
import { trails, rocketTrail } from "./trails";

/* ================================================================== *
 * Yields
 * ================================================================== */

export type ExplosionYield =
  | "grenade"
  | "rocket"
  | "drum"       // 55-gallon fuel drum
  | "car"
  | "tank"       // fuel storage tank
  | "helicopter"
  | "generator";

export interface ExplosionOptions {
  /** Named preset. Ignored if `power` is given. */
  yield?: ExplosionYield;
  /** Blast radius in metres. Overrides the preset. */
  power?: number;
  /**
   * Directional bias — a shaped charge, or a tank venting through a split
   * seam. Unit-ish vector; length scales the bias. Omit for isotropic.
   */
  dx?: number; dy?: number; dz?: number;
  /** Leave a lingering fire. Defaults on for fuel yields. */
  burn?: boolean;
  /** Spawn physical debris. Defaults on above `power` 3. */
  debris?: boolean;
  /** Surface tag under the blast, for debris colouring. */
  surface?: string;
  /** Suppress the ground layers when the blast is airborne. */
  airburst?: boolean;
}

interface YieldPreset {
  power: number;
  burn: boolean;
  burnTime: number;
  /** Extra smoke column height multiplier. */
  column: number;
  /** Debris chunk count multiplier. */
  debris: number;
  /** Peak light intensity multiplier. */
  light: number;
}

const PRESETS: Record<ExplosionYield, YieldPreset> = {
  grenade: { power: 4.5, burn: false, burnTime: 0, column: 0.4, debris: 0.6, light: 0.8 },
  rocket: { power: 6.5, burn: false, burnTime: 1.5, column: 0.6, debris: 0.9, light: 1.0 },
  drum: { power: 9, burn: true, burnTime: 9, column: 1.2, debris: 0.7, light: 1.15 },
  car: { power: 11, burn: true, burnTime: 16, column: 1.35, debris: 1.5, light: 1.25 },
  tank: { power: 22, burn: true, burnTime: 26, column: 2.4, debris: 1.8, light: 1.9 },
  helicopter: { power: 16, burn: true, burnTime: 14, column: 1.8, debris: 2.4, light: 1.5 },
  generator: { power: 14, burn: true, burnTime: 11, column: 1.5, debris: 1.3, light: 2.2 },
};

/* ================================================================== *
 * Shockwave publication
 * ================================================================== */

/** Max simultaneous shockwaves published to the post stack. */
export const MAX_SHOCKWAVES = 6;

/**
 * Live shockwaves, packed as [x, y, z, radius, strength, thickness] × N.
 * `strength` is 0 for an empty slot. A post-processing refraction pass can read
 * this every frame with no imports beyond this array.
 */
export const shockwaveBuffer = new Float32Array(MAX_SHOCKWAVES * 6);
/** How many slots at the head of `shockwaveBuffer` are live this frame. */
export let shockwaveCount = 0;

/* ================================================================== *
 * The visible shockwave shell
 * ================================================================== */

const SHELL_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aWave;    // birthTime, power, speed, seed
attribute vec3 aOrigin;
varying float vAge;
varying float vFres;
varying float vFogDepth;
void main() {
  float t = max(uTimeShell - aWave.x, 0.0);
  float life = aWave.y * 0.055 + 0.16;
  vAge = clamp(t / life, 0.0, 1.0);
  // Blast radius grows fast then asymptotes — a Sedov-ish t^0.4, not linear.
  float radius = aWave.y * pow(vAge, 0.42) * 1.35;
  vec3 wpos = aOrigin + normal * radius;
  vec3 toCam = normalize(cameraPosition - wpos);
  // Grazing angles see the most compressed air; that rim is the whole read.
  vFres = pow(1.0 - abs(dot(normalize(normal), toCam)), 2.6);
  vec4 mv = modelViewMatrix * vec4(wpos, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const SHELL_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying float vAge;
varying float vFres;
varying float vFogDepth;
uniform vec2 uFogRange;
void main() {
  #include <logdepthbuf_fragment>
  float envelope = (1.0 - smoothstep(0.0, 1.0, vAge)) * smoothstep(0.0, 0.05, vAge);
  float a = vFres * envelope * 0.55;
  if (a < 0.004) discard;
  // Slightly warm — the shell is compressed air lit by the fireball behind it.
  vec3 c = mix(vec3(0.85, 0.9, 1.0), vec3(1.0, 0.86, 0.62), 1.0 - vAge);
  a *= (1.0 - smoothstep(uFogRange.x, uFogRange.y, vFogDepth));
  gl_FragColor = vec4(c * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ================================================================== *
 * Light pool
 * ================================================================== */

interface FlashLight {
  light: THREE.PointLight;
  born: number;
  life: number;
  peak: number;
  active: boolean;
}

const LIGHTS_BY_TIER: Record<QualityTier, number> = { low: 2, medium: 4, high: 6, ultra: 8 };

/* ================================================================== *
 * System
 * ================================================================== */

interface Wave {
  x: number; y: number; z: number;
  born: number;
  power: number;
  active: boolean;
}

const _c = new THREE.Color();

class ExplosionSystem {
  readonly group = new THREE.Group();
  private lights: FlashLight[] = [];
  private waves: Wave[] = [];
  private shell: THREE.Mesh | null = null;
  private shellMat: THREE.ShaderMaterial | null = null;
  private shellGeo: THREE.InstancedBufferGeometry | null = null;
  private shellBuf: THREE.InstancedInterleavedBuffer | null = null;
  private shellData: Float32Array | null = null;
  private shellCursor = 0;
  private started = false;
  private tier: QualityTier = "high";
  /** Delayed sub-events: secondary smoke columns, chained pops. */
  private pending: Array<{ at: number; run: () => void }> = [];

  constructor() {
    this.group.name = "vfx-explosions";
  }

  init(tier: QualityTier): void {
    if (this.started) return;
    this.tier = tier;

    // --- lights ---
    const n = LIGHTS_BY_TIER[tier] ?? 6;
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffb066, 0, 120, 2);
      l.visible = false;
      l.castShadow = false; // a 4-frame light does not justify a shadow pass
      this.group.add(l);
      this.lights.push({ light: l, born: -1e9, life: 0, peak: 0, active: false });
    }

    // --- shockwave shell ---
    // An icosphere expanded along its own normals in the vertex shader. One
    // instanced mesh handles every simultaneous blast.
    const src = new THREE.IcosahedronGeometry(1, 3);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute("position", src.getAttribute("position"));
    g.setAttribute("normal", src.getAttribute("normal"));
    g.setIndex(src.getIndex());
    const data = new Float32Array(MAX_SHOCKWAVES * 8);
    const buf = new THREE.InstancedInterleavedBuffer(data, 8, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("aWave", new THREE.InterleavedBufferAttribute(buf, 4, 0));
    g.setAttribute("aOrigin", new THREE.InterleavedBufferAttribute(buf, 3, 4));
    g.instanceCount = MAX_SHOCKWAVES;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    src.dispose();

    const mat = new THREE.ShaderMaterial({
      vertexShader: `uniform float uTimeShell;\n${SHELL_VERT}`,
      fragmentShader: SHELL_FRAG,
      uniforms: {
        uTimeShell: { value: 0 },
        uFogRange: { value: new THREE.Vector2(400, 9000) },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide, // we are usually inside the shell
      toneMapped: true,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3050;
    mesh.matrixAutoUpdate = false;
    mesh.name = "vfx-shockwave-shell";
    this.group.add(mesh);

    this.shell = mesh;
    this.shellMat = mat;
    this.shellGeo = g;
    this.shellBuf = buf;
    this.shellData = data;

    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      this.waves.push({ x: 0, y: 0, z: 0, born: -1e9, power: 0, active: false });
      // Park unused shells far in the past so their envelope is zero.
      data[i * 8] = -1e9;
    }
    buf.needsUpdate = true;

    this.started = true;
  }

  private takeLight(x: number, y: number, z: number, power: number, mult: number): void {
    let best: FlashLight | null = null;
    for (const l of this.lights) {
      if (!l.active) { best = l; break; }
      if (!best || l.born < best.born) best = l;
    }
    if (!best) return;
    best.born = frame.time;
    // Big blasts glow longer, but never long enough to look like a lamp.
    best.life = 0.28 + power * 0.022;
    best.peak = (900 + power * 900) * mult;
    best.active = true;
    best.light.position.set(x, y, z);
    best.light.distance = Math.min(400, 30 + power * 9);
    best.light.color.setRGB(1.0, 0.72, 0.36);
    best.light.visible = true;
    best.light.intensity = best.peak;
  }

  private takeWave(x: number, y: number, z: number, power: number): void {
    let slot = this.shellCursor % MAX_SHOCKWAVES;
    // Prefer a genuinely dead slot before stealing a live one.
    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      const w = this.waves[i];
      if (!w.active) { slot = i; break; }
    }
    this.shellCursor = (slot + 1) % MAX_SHOCKWAVES;
    const w = this.waves[slot];
    w.x = x; w.y = y; w.z = z; w.power = power; w.born = frame.time; w.active = true;
    const d = this.shellData;
    if (d && this.shellBuf) {
      const o = slot * 8;
      d[o] = frame.time;
      d[o + 1] = power;
      d[o + 2] = 340;
      d[o + 3] = vfxRng.next();
      d[o + 4] = x; d[o + 5] = y; d[o + 6] = z;
      this.shellBuf.needsUpdate = true;
    }
  }

  /* ---------------------------------------------------------------- *
   * The spawn
   * ---------------------------------------------------------------- */

  spawn(x: number, y: number, z: number, opts: ExplosionOptions = {}): void {
    // Spawns before the root has mounted are legitimate (physics boots on its
    // own schedule) and must be silently dropped, not crash.
    if (!this.started) return;
    const preset = PRESETS[opts.yield ?? "grenade"];
    const power = Math.max(0.8, opts.power ?? preset.power);
    // Normalised scale against the grenade, used to interpolate everything
    // that should not simply grow linearly (counts, speeds, lifetimes).
    const s = power / 4.5;
    const sq = Math.sqrt(s);

    const ground = walkableHeight(x, z);
    const agl = y - ground;
    const nearGround = !opts.airburst && agl < power * 0.85;
    const overWater = isWater(x, z);

    // Directional bias: a shaped blast puts more of everything one way.
    let bx = opts.dx ?? 0, by = opts.dy ?? 0, bz = opts.dz ?? 0;
    const blen = Math.hypot(bx, by, bz);
    const biased = blen > 1e-3;
    if (biased) { bx /= blen; by /= blen; bz /= blen; }
    const bias = biased ? Math.min(1, blen) : 0;

    this.takeLight(x, y + power * 0.35, z, power, preset.light);
    this.takeWave(x, y, z, power);

    /* --- 1. FLASH ------------------------------------------------- */
    // One enormous, extremely short additive star. It is on screen for four
    // frames; its whole job is to blow out the exposure before the eye has
    // resolved anything else.
    resetDesc();
    P.layer = "add";
    P.x = x; P.y = y; P.z = z;
    P.vx = P.vy = P.vz = 0;
    P.drag = 8; P.gravity = 0; P.turbulence = 0; P.wind = 0;
    P.life = 0.075 + s * 0.012;
    P.size0 = power * 1.1;
    P.size1 = power * 2.4;
    P.frame = Tile.Flash;
    P.rot = vfxRng.range(0, 6.283);
    P.r0 = 3.2; P.g0 = 2.7; P.b0 = 2.1; P.a0 = 1;
    P.r1 = 2.0; P.g1 = 1.1; P.b1 = 0.42; P.a1 = 0;
    P.fadeIn = 0.02; P.fadeOut = 0.55;
    particles.emit(P);

    // A second, wider, dimmer flash bloom — this is what the bloom pass grabs.
    P.life = 0.2 + s * 0.05;
    P.size0 = power * 2.2;
    P.size1 = power * 5.0;
    P.frame = Tile.Haze;
    P.r0 = 1.6; P.g0 = 1.0; P.b0 = 0.5; P.a0 = 0.85;
    P.r1 = 0.9; P.g1 = 0.35; P.b1 = 0.1; P.a1 = 0;
    particles.emit(P);

    /* --- 2. FIREBALL CORE ---------------------------------------- */
    // Additive, expanding, cooling. Emitted as a volume-filled sphere so the
    // core is dense and the outside is ragged, which is what makes a fireball
    // read as a *volume* rather than as a disc.
    resetDesc();
    P.layer = "flame";
    P.x = x; P.y = y + power * 0.1; P.z = z;
    P.drag = 2.6 + s * 0.35;
    P.gravity = 3.2 + s * 1.6;      // hot gas is buoyant, and fast
    P.turbulence = 1.4 + s * 0.5;
    P.wind = 0.12;
    P.life = 0.5 + sq * 0.42;
    P.size0 = power * 0.55;
    P.size1 = power * 1.5;
    P.frames = 16; P.fps = 26; P.frame = 0;
    P.rotSpeed = 1.2;
    P.mode = Billboard.Camera;
    P.r0 = 2.6; P.g0 = 2.0; P.b0 = 1.35; P.a0 = 1;
    P.r1 = 1.0; P.g1 = 0.22; P.b1 = 0.05; P.a1 = 0;
    P.fadeIn = 0.03; P.fadeOut = 0.5;
    emitSphere(P, {
      count: budget(Math.round(10 + s * 16)),
      speed: [power * 0.9, power * 2.4],
      sizeJitter: 0.4, lifeJitter: 0.35,
      jitter: power * 0.12,
    });

    if (biased) {
      // The shaped lobe: a cone of much faster fire down the bias axis.
      P.life = 0.42 + sq * 0.3;
      P.size0 = power * 0.4;
      P.size1 = power * 1.0;
      emitCone(P, bx, by, bz, 0.5, {
        count: budget(Math.round(6 + s * 10 * bias)),
        speed: [power * 3.0, power * 6.5],
        jitter: power * 0.1,
      });
    }

    /* --- 3. EMBERS ------------------------------------------------ */
    // Velocity-stretched sparks. Low drag so they carry, high gravity so they
    // arc — the arc is what makes them read as *thrown matter* and not as a
    // radial gradient.
    resetDesc();
    P.layer = "add";
    P.x = x; P.y = y; P.z = z;
    P.drag = 0.42;
    P.gravity = -16;
    P.turbulence = 0.5;
    P.wind = 0.35;
    P.life = 1.1 + sq * 1.5;
    P.size0 = 0.16 + s * 0.05;
    P.size1 = 0.05;
    P.frame = Tile.Spark;
    P.mode = Billboard.Stretch;
    P.stretch = 1.6;
    P.r0 = 3.0; P.g0 = 1.7; P.b0 = 0.6; P.a0 = 1;
    P.r1 = 1.2; P.g1 = 0.22; P.b1 = 0.03; P.a1 = 0;
    P.fadeIn = 0.01; P.fadeOut = 0.45;
    emitSphere(P, {
      count: budget(Math.round(30 + s * 55)),
      speed: [power * 1.6, power * 6.0],
      sizeJitter: 0.5, lifeJitter: 0.55,
      jitter: power * 0.08,
    });

    // Slow, drifting embers that survive long after the fireball is gone. Only
    // a handful, but they are the detail that says "this was a fuel fire".
    P.life = 2.6 + sq * 2.4;
    P.drag = 1.4;
    P.gravity = -3.2;
    P.turbulence = 2.2;
    P.wind = 0.75;
    P.size0 = 0.09; P.size1 = 0.02;
    P.frame = Tile.Ember;
    P.mode = Billboard.Camera;
    P.r0 = 2.2; P.g0 = 0.75; P.b0 = 0.18;
    P.r1 = 0.8; P.g1 = 0.1; P.b1 = 0.02;
    emitSphere(P, {
      count: budget(Math.round(8 + s * 22)),
      speed: [power * 0.4, power * 1.6],
      lifeJitter: 0.6,
    });

    // A few genuinely fast ejecta get ribbon trails — six of them are worth
    // more than sixty stretched sprites, and the pool is small on purpose.
    const ribbons = this.tier === "low" ? 0 : Math.min(4, Math.round(1 + s * 1.4));
    for (let i = 0; i < ribbons; i++) {
      const h = rocketTrail(x, y, z);
      if (h < 0) break;
      const u = vfxRng.range(-0.2, 1);
      const ph = vfxRng.range(0, 6.283);
      const sp = Math.sqrt(Math.max(0, 1 - u * u));
      const dx = sp * Math.cos(ph), dy = u, dz = sp * Math.sin(ph);
      const speed = power * vfxRng.range(3.5, 7.5);
      this.animateEjecta(h, x, y, z, dx * speed, dy * speed, dz * speed, 1.1 + sq * 0.5);
    }

    /* --- 4. SMOKE ------------------------------------------------- */
    // The layer that lasts. Alpha-blended flipbook, buoyant, heavily
    // turbulent, cooling from lit-orange to soot over its life. It starts dim
    // and fades *in* so it does not compete with the fireball.
    resetDesc();
    P.layer = "smoke";
    P.x = x; P.y = y + power * 0.12; P.z = z;
    P.drag = 1.5;
    P.gravity = 2.6 + s * 1.1;
    P.turbulence = 1.9 + s * 0.6;
    P.wind = 0.55;
    P.life = 3.4 + sq * 3.6;
    P.size0 = power * 0.7;
    P.size1 = power * 3.1;
    P.frames = 16; P.fps = 5.5; P.frame = 0;
    P.rotSpeed = 0.5;
    // Born lit by the fireball behind it, dying as cold soot.
    P.r0 = 0.72; P.g0 = 0.42; P.b0 = 0.22; P.a0 = 0.95;
    P.r1 = 0.075; P.g1 = 0.07; P.b1 = 0.068; P.a1 = 0;
    P.fadeIn = 0.09; P.fadeOut = 0.5;
    // Large sprites are fillrate, not vertex work: a dozen 60 m billows costs
    // far more than a hundred 2 m ones. Count grows sub-linearly with yield
    // and size carries the rest.
    emitSphere(P, {
      count: budget(Math.round(8 + s * 7)),
      speed: [power * 0.55, power * 1.9],
      sizeJitter: 0.45, lifeJitter: 0.45,
      jitter: power * 0.2,
    });

    /* --- 5. GROUND LAYERS ----------------------------------------- */
    if (nearGround) {
      const gy = (overWater ? 0 : ground) + 0.12;

      // Radial dust wave. Ground-aligned quads that scrape outward — this is
      // the single layer that communicates the *scale* of the blast, because
      // it is the only one the viewer can compare against the street.
      resetDesc();
      P.layer = "alpha";
      P.x = x; P.y = gy; P.z = z;
      P.drag = 1.9;
      P.gravity = overWater ? -5 : 0.55;
      P.turbulence = 1.0;
      P.wind = 0.4;
      P.life = 1.8 + sq * 2.2;
      P.size0 = power * 0.35;
      P.size1 = power * 1.9;
      P.frame = overWater ? Tile.Splash : Tile.Dust;
      P.mode = Billboard.Camera;
      P.rotSpeed = 0.6;
      if (overWater) {
        P.r0 = 0.92; P.g0 = 0.96; P.b0 = 1.0; P.a0 = 0.85;
        P.r1 = 0.8; P.g1 = 0.86; P.b1 = 0.92; P.a1 = 0;
      } else {
        P.r0 = 0.58; P.g0 = 0.52; P.b0 = 0.44; P.a0 = 0.8;
        P.r1 = 0.42; P.g1 = 0.39; P.b1 = 0.35; P.a1 = 0;
      }
      P.fadeIn = 0.05; P.fadeOut = 0.55;
      emitRing(P, 0, 1, 0, power * 0.35, {
        count: budget(Math.round(12 + s * 20)),
        speed: [power * 1.4, power * 3.4],
        rise: power * 0.35,
        sizeJitter: 0.4, lifeJitter: 0.4,
        jitter: power * 0.08,
      });

      // A flat, fast, very wide ground-aligned sheet at t=0 — the "skirt".
      resetDesc();
      P.layer = "alpha";
      P.x = x; P.y = gy + 0.05; P.z = z;
      P.drag = 3.2; P.gravity = 0; P.turbulence = 0; P.wind = 0.2;
      P.life = 0.9 + sq * 0.6;
      P.size0 = power * 0.6;
      P.size1 = power * 2.6;
      P.frame = Tile.Wisp;
      P.mode = Billboard.Ground;
      P.rotSpeed = 0.35;
      P.r0 = 0.66; P.g0 = 0.58; P.b0 = 0.48; P.a0 = 0.6;
      P.r1 = 0.5; P.g1 = 0.47; P.b1 = 0.44; P.a1 = 0;
      P.fadeIn = 0.04; P.fadeOut = 0.6;
      emitRing(P, 0, 1, 0, power * 0.2, {
        count: budget(Math.round(6 + s * 8)),
        speed: [power * 2.2, power * 4.2],
        sizeJitter: 0.3, lifeJitter: 0.3,
      });

      if (overWater) {
        // Water column: a vertical jet, then the falling curtain.
        resetDesc();
        P.layer = "alpha";
        P.x = x; P.y = 0.2; P.z = z;
        P.drag = 0.35; P.gravity = -18; P.turbulence = 0.6; P.wind = 0.25;
        P.life = 1.6 + sq;
        P.size0 = power * 0.24; P.size1 = power * 0.7;
        P.frame = Tile.Splash;
        P.r0 = 1.0; P.g0 = 1.0; P.b0 = 1.0; P.a0 = 0.9;
        P.r1 = 0.78; P.g1 = 0.85; P.b1 = 0.9; P.a1 = 0;
        emitCone(P, 0, 1, 0, 0.42, {
          count: budget(Math.round(14 + s * 22)),
          speed: [power * 2.2, power * 5.5],
          sizeJitter: 0.5, lifeJitter: 0.5,
          jitter: power * 0.15,
        });
      } else {
        scorchDecal(x, ground, z, power);
        if (preset.burn) oilDecal(x, ground, z, power * 0.28);
      }
    }

    /* --- 6. HEAT HAZE --------------------------------------------- */
    if (this.tier !== "low") {
      resetDesc();
      P.layer = "add";
      P.x = x; P.y = y + power * 0.2; P.z = z;
      P.drag = 1.1;
      P.gravity = 2.4;
      P.turbulence = 1.6;
      P.wind = 0.5;
      P.life = 1.4 + sq * 1.2;
      P.size0 = power * 0.9;
      P.size1 = power * 2.6;
      P.frame = Tile.Haze;
      P.rotSpeed = 0.4;
      // Barely there on purpose: heat haze that you can *see* is a bug.
      P.r0 = 0.10; P.g0 = 0.075; P.b0 = 0.05; P.a0 = 0.5;
      P.r1 = 0.05; P.g1 = 0.045; P.b1 = 0.04; P.a1 = 0;
      P.fadeIn = 0.12; P.fadeOut = 0.6;
      emitSphere(P, {
        count: budget(Math.round(4 + s * 7)),
        speed: [power * 0.4, power * 1.3],
        sizeJitter: 0.35, lifeJitter: 0.4,
      });
    }

    /* --- 7. DEBRIS ------------------------------------------------ */
    const wantDebris = opts.debris ?? power > 3;
    if (wantDebris && !overWater) {
      spawnDebrisBurst({
        x, y: y + 0.4, z,
        count: Math.round((3 + s * 5) * preset.debris),
        speed: power * 2.6,
        spread: 1.05,
        size: 0.16 + s * 0.16,
        surface: opts.surface ?? "concrete",
        lifetime: 7 + sq * 4,
        dustTrails: this.tier !== "low",
      });
    }

    /* --- 8. LINGERING FIRE ---------------------------------------- */
    if ((opts.burn ?? preset.burn) && !overWater) {
      igniteFire(x, nearGround ? ground + 0.1 : y, z, {
        radius: power * 0.42,
        duration: preset.burnTime,
        intensity: 0.7 + s * 0.2,
        spread: power > 8,
      });
    }

    /* --- 9. DELAYED SECONDARY COLUMN ------------------------------ */
    // A real explosion's silhouette is written by what happens a second later:
    // the fireball has gone, the debris has landed, and a slow black column is
    // still climbing. Without this an explosion is over in 1.5 s and feels
    // like a firework.
    if (power > 5) {
      const cy = nearGround ? ground : y;
      this.pending.push({
        at: frame.time + 0.85,
        run: () => this.secondaryColumn(x, cy, z, power, preset.column),
      });
      this.pending.push({
        at: frame.time + 1.9,
        run: () => this.secondaryColumn(x, cy, z, power * 0.75, preset.column * 0.8),
      });
    }
  }

  /** The slow black column, emitted as its own delayed event. */
  private secondaryColumn(x: number, y: number, z: number, power: number, column: number): void {
    const s = power / 4.5;
    const sq = Math.sqrt(s);
    resetDesc();
    P.layer = "smoke";
    P.x = x; P.y = y + power * 0.25; P.z = z;
    P.drag = 0.9;
    P.gravity = 1.5 + column * 0.9;
    P.turbulence = 2.4;
    P.wind = 0.85;              // the column bends with the wind, hard
    P.life = 7 + sq * 6 * column;
    P.size0 = power * 0.55;
    P.size1 = power * 3.4 * column;
    P.frames = 16; P.fps = 3.2; P.frame = 0;
    P.rotSpeed = 0.32;
    P.r0 = 0.15; P.g0 = 0.135; P.b0 = 0.128; P.a0 = 0.82;
    P.r1 = 0.34; P.g1 = 0.33; P.b1 = 0.33; P.a1 = 0;
    P.fadeIn = 0.16; P.fadeOut = 0.5;
    emitSphere(P, {
      count: budget(Math.round(5 + s * 7 * column)),
      speed: [power * 0.25, power * 1.0],
      sizeJitter: 0.45, lifeJitter: 0.5,
      jitter: power * 0.22,
    });
  }

  /**
   * Fly a ribbon-trailed ejectum on a ballistic arc for `life` seconds.
   *
   * This is the one place the VFX system integrates something on the CPU, and
   * it is deliberate: a ribbon *needs* per-frame head positions, so there is no
   * GPU-side version of it. Four of these per explosion, at most.
   */
  private animateEjecta(
    h: number, x: number, y: number, z: number,
    vx: number, vy: number, vz: number, life: number,
  ): void {
    const start = frame.time;
    const state = { x, y, z, vx, vy, vz };
    const step = (dt: number): boolean => {
      const k = 0.55;
      state.vy += -19 * dt;
      const damp = Math.exp(-k * dt);
      state.vx *= damp; state.vy *= damp; state.vz *= damp;
      state.x += state.vx * dt;
      state.y += state.vy * dt;
      state.z += state.vz * dt;
      trails.move(h, state.x, state.y, state.z);
      const ground = walkableHeight(state.x, state.z);
      if (state.y <= ground + 0.15 || frame.time - start > life) {
        trails.release(h);
        return false;
      }
      return true;
    };
    this.ejecta.push(step);
  }

  private ejecta: Array<(dt: number) => boolean> = [];

  /* ---------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------- */

  update(dt: number, fog: THREE.Fog | THREE.FogExp2 | null): void {
    if (!this.started) return;
    const now = frame.time;

    // Lights: an instantaneous rise and a sharp exponential-ish decay. A
    // linear fade reads as a dimmer switch, which is the opposite of a blast.
    for (const l of this.lights) {
      if (!l.active) continue;
      const k = (now - l.born) / l.life;
      if (k >= 1) {
        l.active = false;
        l.light.visible = false;
        l.light.intensity = 0;
        continue;
      }
      const decay = Math.pow(1 - k, 3.1);
      const flicker = 0.86 + 0.14 * Math.sin(now * 61 + l.born * 13);
      l.light.intensity = l.peak * decay * flicker;
      _c.setRGB(1.0, 0.72 - k * 0.18, 0.36 - k * 0.2);
      l.light.color.copy(_c);
    }

    // Shockwaves: age them out and republish the buffer for the post stack.
    shockwaveCount = 0;
    for (let i = 0; i < this.waves.length; i++) {
      const w = this.waves[i];
      if (!w.active) continue;
      const life = w.power * 0.055 + 0.16;
      const age = (now - w.born) / life;
      if (age >= 1) {
        w.active = false;
        continue;
      }
      const radius = w.power * Math.pow(clamp01(age), 0.42) * 1.35;
      const strength = (1 - smoothstep(0, 1, age)) * clamp01(w.power / 10);
      const o = shockwaveCount * 6;
      shockwaveBuffer[o] = w.x;
      shockwaveBuffer[o + 1] = w.y;
      shockwaveBuffer[o + 2] = w.z;
      shockwaveBuffer[o + 3] = radius;
      shockwaveBuffer[o + 4] = strength;
      shockwaveBuffer[o + 5] = Math.max(0.6, w.power * 0.18);
      shockwaveCount++;
    }
    for (let i = shockwaveCount * 6; i < shockwaveBuffer.length; i++) shockwaveBuffer[i] = 0;

    if (this.shellMat) {
      this.shellMat.uniforms.uTimeShell.value = now;
      if (fog instanceof THREE.Fog) {
        (this.shellMat.uniforms.uFogRange.value as THREE.Vector2).set(fog.near, fog.far);
      }
    }

    // Ribbon ejecta.
    for (let i = this.ejecta.length - 1; i >= 0; i--) {
      if (!this.ejecta[i](dt)) {
        this.ejecta[i] = this.ejecta[this.ejecta.length - 1];
        this.ejecta.pop();
      }
    }

    // Delayed sub-events.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at <= now) {
        const p = this.pending[i];
        this.pending[i] = this.pending[this.pending.length - 1];
        this.pending.pop();
        p.run();
      }
    }
  }

  clear(): void {
    for (const l of this.lights) {
      l.active = false;
      l.light.visible = false;
      l.light.intensity = 0;
    }
    for (const w of this.waves) w.active = false;
    this.pending.length = 0;
    this.ejecta.length = 0;
    shockwaveCount = 0;
    shockwaveBuffer.fill(0);
  }

  dispose(): void {
    this.clear();
    for (const l of this.lights) {
      this.group.remove(l.light);
      l.light.dispose();
    }
    this.lights.length = 0;
    this.shellGeo?.dispose();
    this.shellMat?.dispose();
    if (this.shell) this.group.remove(this.shell);
    this.shell = null;
    this.shellGeo = null;
    this.shellMat = null;
    this.shellBuf = null;
    this.shellData = null;
    this.waves.length = 0;
    this.started = false;
  }
}

export const explosions = new ExplosionSystem();

/**
 * Fire an explosion. The imperative entry point every other system calls.
 *
 *   spawnExplosion(x, y, z, "tank")
 *   spawnExplosion(x, y, z, { power: 30, dx: 0, dy: 1, dz: 0, surface: "metal" })
 */
export function spawnExplosion(
  x: number, y: number, z: number,
  opts: ExplosionYield | ExplosionOptions = "grenade",
): void {
  explosions.spawn(x, y, z, typeof opts === "string" ? { yield: opts } : opts);
}

/** Quality-tier ceiling on simultaneous blast lights — exported for the HUD. */
export function explosionLightBudget(tier: QualityTier): number {
  return LIGHTS_BY_TIER[tier] ?? 6;
}

/** Total particle budget, re-exported so callers can sanity-check their counts. */
export function particleBudget(tier: QualityTier): number {
  return QUALITY[tier].maxParticles;
}
