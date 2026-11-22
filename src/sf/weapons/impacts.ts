/**
 * weapons/impacts.ts — what the world does when it is shot.
 *
 * Impact response is entirely surface-driven. The physics layer already
 * resolves a hit to a `SurfaceTag` (it knows a Victorian is clapboard and a
 * tower's podium is stone), so this module never asks "what did I hit" in
 * gameplay terms — it looks the tag up in one table and plays the response:
 *
 *   concrete   grey puff, chips, a dark crater decal, a dry slap
 *   brick      redder dust, more of it, deeper crater
 *   metal      a cone of sparks, a bright dented decal, a ricochet whine
 *   thinMetal  fewer sparks, a punched hole, a loud oil-drum bang
 *   glass      shards, no decal on the far side, a shatter
 *   wood       splinters that tumble, pale dust, a hollow knock
 *   dirt/sand  a big lazy puff, low dust, almost no sound
 *   water      a vertical splash column and a ring, no decal
 *   flesh      a short red spray, a wet slap, a dark decal
 *   foliage    leaf scatter, no decal, a rustle
 *
 * The decal system is a hard-capped ring per surface family: when the pool
 * wraps, the oldest hole is reused, and the last two seconds of its life are a
 * fade so decals never pop out of existence in front of the player.
 *
 * Public API
 * ----------
 *   ImpactSystem(effects, tier)
 *   .group  .spawn(hit, def)  .update(dt)  .clear()  .dispose()
 */
import * as THREE from "three";
import { QUALITY, type QualityTier } from "../config";
import { SURFACE_PROPS, rigidBodyPool, type SurfaceTag } from "../physics";
import { clamp, clamp01, makeRng, type Rng } from "../math/rng";
import { frame } from "../state/store";
import { playImpactSound } from "./bridge";
import type { WeaponEffects } from "./effects";
import { pspec } from "./particles";
import { decalTexture, type DecalFamily } from "./textures";
import type { WeaponDef, WeaponHit } from "./types";

/* ------------------------------------------------------------------ *
 * Surface response table
 * ------------------------------------------------------------------ */

interface SurfaceResponse {
  decal: DecalFamily | null;
  /** Base decal radius, metres. */
  decalSize: number;
  /** Seconds a decal survives before fading. */
  decalLife: number;
  /** Dust puff count and colour. */
  dust: number;
  dustColor: number;
  dustSize: number;
  /** Spark count. */
  sparks: number;
  sparkColor: number;
  /** Solid chips/splinters flung out of the hole. */
  chips: number;
  chipColor: number;
  /** Chip lifetime multiplier — splinters tumble longer than stone chips. */
  chipLife: number;
  /** Audio bank key (the tag itself, unless something reads better). */
  audio: string;
  /** Pitch nudge so two surfaces never sound identical. */
  pitch: number;
  /** Emit a lingering smoke wisp (hot metal, scorched concrete). */
  smoke: number;
}

const RESPONSE: Record<SurfaceTag, SurfaceResponse> = {
  concrete: {
    decal: "hard", decalSize: 0.075, decalLife: 34,
    dust: 5, dustColor: 0xa8a49c, dustSize: 0.16,
    sparks: 1, sparkColor: 0xffcf8a,
    chips: 4, chipColor: 0x8d8981, chipLife: 1,
    audio: "concrete", pitch: 1, smoke: 0.2,
  },
  asphalt: {
    decal: "hard", decalSize: 0.08, decalLife: 30,
    dust: 4, dustColor: 0x6f6c68, dustSize: 0.15,
    sparks: 0, sparkColor: 0xffbb70,
    chips: 3, chipColor: 0x4a4744, chipLife: 0.9,
    audio: "asphalt", pitch: 0.92, smoke: 0.15,
  },
  metal: {
    decal: "metal", decalSize: 0.055, decalLife: 40,
    dust: 1, dustColor: 0x8a8a8a, dustSize: 0.07,
    sparks: 14, sparkColor: 0xfff0c8,
    chips: 0, chipColor: 0xbcbcbc, chipLife: 0.6,
    audio: "metal", pitch: 1.08, smoke: 0.05,
  },
  thinMetal: {
    decal: "metal", decalSize: 0.05, decalLife: 40,
    dust: 1, dustColor: 0x8a8a8a, dustSize: 0.06,
    sparks: 9, sparkColor: 0xffe8b4,
    chips: 1, chipColor: 0xa9a9a9, chipLife: 0.6,
    audio: "thinMetal", pitch: 1.02, smoke: 0.05,
  },
  glass: {
    decal: "glass", decalSize: 0.14, decalLife: 60,
    dust: 1, dustColor: 0xcfe0ea, dustSize: 0.08,
    sparks: 0, sparkColor: 0xffffff,
    chips: 10, chipColor: 0xd6ecf7, chipLife: 1.4,
    audio: "glass", pitch: 1, smoke: 0,
  },
  wood: {
    decal: "hard", decalSize: 0.06, decalLife: 34,
    dust: 3, dustColor: 0xb59a72, dustSize: 0.12,
    sparks: 0, sparkColor: 0xffbb70,
    chips: 7, chipColor: 0x8a6a44, chipLife: 1.6,
    audio: "wood", pitch: 0.96, smoke: 0.25,
  },
  brick: {
    decal: "hard", decalSize: 0.08, decalLife: 34,
    dust: 6, dustColor: 0xb08064, dustSize: 0.18,
    sparks: 1, sparkColor: 0xffc078,
    chips: 5, chipColor: 0x8e5a44, chipLife: 1,
    audio: "brick", pitch: 1.04, smoke: 0.2,
  },
  stucco: {
    decal: "hard", decalSize: 0.085, decalLife: 32,
    dust: 7, dustColor: 0xd8d2c4, dustSize: 0.2,
    sparks: 0, sparkColor: 0xffcf8a,
    chips: 4, chipColor: 0xbdb6a6, chipLife: 0.9,
    audio: "stucco", pitch: 0.98, smoke: 0.15,
  },
  stone: {
    decal: "hard", decalSize: 0.07, decalLife: 40,
    dust: 5, dustColor: 0xb6b2aa, dustSize: 0.15,
    sparks: 3, sparkColor: 0xffdca0,
    chips: 5, chipColor: 0x8f8b84, chipLife: 1,
    audio: "stone", pitch: 1.06, smoke: 0.2,
  },
  dirt: {
    decal: "soft", decalSize: 0.1, decalLife: 22,
    dust: 8, dustColor: 0x8a7256, dustSize: 0.24,
    sparks: 0, sparkColor: 0xffbb70,
    chips: 3, chipColor: 0x6a5540, chipLife: 0.8,
    audio: "dirt", pitch: 0.9, smoke: 0,
  },
  grass: {
    decal: "soft", decalSize: 0.09, decalLife: 18,
    dust: 5, dustColor: 0x7b7a4e, dustSize: 0.18,
    sparks: 0, sparkColor: 0xffbb70,
    chips: 5, chipColor: 0x5d7040, chipLife: 1.1,
    audio: "grass", pitch: 1, smoke: 0,
  },
  sand: {
    decal: "soft", decalSize: 0.12, decalLife: 14,
    dust: 10, dustColor: 0xd6c295, dustSize: 0.28,
    sparks: 0, sparkColor: 0xffbb70,
    chips: 2, chipColor: 0xc0ad84, chipLife: 0.7,
    audio: "sand", pitch: 0.88, smoke: 0,
  },
  gravel: {
    decal: "hard", decalSize: 0.09, decalLife: 24,
    dust: 6, dustColor: 0x9c968c, dustSize: 0.19,
    sparks: 1, sparkColor: 0xffd090,
    chips: 7, chipColor: 0x77726b, chipLife: 1,
    audio: "gravel", pitch: 1.02, smoke: 0,
  },
  water: {
    decal: null, decalSize: 0, decalLife: 0,
    dust: 8, dustColor: 0xbcd2dd, dustSize: 0.2,
    sparks: 0, sparkColor: 0xffffff,
    chips: 0, chipColor: 0xffffff, chipLife: 0,
    audio: "water", pitch: 1, smoke: 0,
  },
  flesh: {
    decal: "soft", decalSize: 0.055, decalLife: 26,
    dust: 0, dustColor: 0x6a1414, dustSize: 0.08,
    sparks: 0, sparkColor: 0xffffff,
    chips: 9, chipColor: 0x8c1414, chipLife: 0.7,
    audio: "flesh", pitch: 1, smoke: 0,
  },
  foliage: {
    decal: null, decalSize: 0, decalLife: 0,
    dust: 2, dustColor: 0x6f8a4a, dustSize: 0.1,
    sparks: 0, sparkColor: 0xffffff,
    chips: 8, chipColor: 0x4e6b30, chipLife: 1.8,
    audio: "foliage", pitch: 1.1, smoke: 0,
  },
  plastic: {
    decal: "hard", decalSize: 0.05, decalLife: 30,
    dust: 2, dustColor: 0xc8c8c8, dustSize: 0.09,
    sparks: 0, sparkColor: 0xffffff,
    chips: 5, chipColor: 0xb0b0b0, chipLife: 1.1,
    audio: "plastic", pitch: 1.14, smoke: 0.1,
  },
  rubber: {
    decal: "hard", decalSize: 0.055, decalLife: 30,
    dust: 2, dustColor: 0x39393b, dustSize: 0.1,
    sparks: 0, sparkColor: 0xffffff,
    chips: 3, chipColor: 0x2c2c2e, chipLife: 0.9,
    audio: "rubber", pitch: 0.86, smoke: 0.2,
  },
  fabric: {
    decal: "soft", decalSize: 0.06, decalLife: 24,
    dust: 3, dustColor: 0xa89c8c, dustSize: 0.11,
    sparks: 0, sparkColor: 0xffffff,
    chips: 2, chipColor: 0x8e8478, chipLife: 1.2,
    audio: "fabric", pitch: 1, smoke: 0,
  },
};

/* ------------------------------------------------------------------ *
 * Decal layer
 * ------------------------------------------------------------------ */

const DECAL_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aPos;
attribute vec3 aNrm;
attribute float aRot;
attribute float aSize;
attribute float aAlpha;
attribute float aTile;
attribute vec3 aColor;

varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;

void main() {
  // Build a tangent frame from the surface normal. The up reference flips on
  // near-horizontal surfaces so a decal on the ground is not degenerate.
  vec3 n = normalize(aNrm);
  vec3 ref = abs(n.y) > 0.94 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 t = normalize(cross(ref, n));
  vec3 b = cross(n, t);

  float c = cos(aRot);
  float s = sin(aRot);
  vec2 p = position.xy * aSize;
  vec2 r = vec2(p.x * c - p.y * s, p.x * s + p.y * c);

  vec3 world = aPos + t * r.x + b * r.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  #include <logdepthbuf_vertex>

  float col = mod(aTile, 2.0);
  float row = floor(aTile * 0.5);
  vUv = uv * 0.5 + vec2(col * 0.5, row * 0.5);
  vAlpha = aAlpha;
  vColor = aColor;
}
`;

const DECAL_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;

void main() {
  #include <logdepthbuf_fragment>
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vAlpha;
  if (a < 0.006) discard;
  gl_FragColor = vec4(t.rgb * vColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class DecalLayer {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private cap: number;
  private cursor = 0;
  private live = 0;

  private age: Float32Array;
  private life: Float32Array;
  private aPos: THREE.InstancedBufferAttribute;
  private aNrm: THREE.InstancedBufferAttribute;
  private aRot: THREE.InstancedBufferAttribute;
  private aSize: THREE.InstancedBufferAttribute;
  private aAlpha: THREE.InstancedBufferAttribute;
  private aTile: THREE.InstancedBufferAttribute;
  private aColor: THREE.InstancedBufferAttribute;
  private peak: Float32Array;

  constructor(capacity: number, texture: THREE.Texture, additive: boolean) {
    this.cap = capacity;
    this.age = new Float32Array(capacity).fill(1e9);
    this.life = new Float32Array(capacity).fill(1);
    this.peak = new Float32Array(capacity).fill(1);

    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;
    geo.attributes.uv = base.attributes.uv;
    base.dispose();

    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aNrm = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aRot = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aAlpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aTile = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    for (const a of [this.aPos, this.aNrm, this.aRot, this.aSize, this.aAlpha, this.aTile, this.aColor]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    geo.setAttribute("aPos", this.aPos);
    geo.setAttribute("aNrm", this.aNrm);
    geo.setAttribute("aRot", this.aRot);
    geo.setAttribute("aSize", this.aSize);
    geo.setAttribute("aAlpha", this.aAlpha);
    geo.setAttribute("aTile", this.aTile);
    geo.setAttribute("aColor", this.aColor);
    geo.instanceCount = 0;

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: texture } },
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      // Decals sit a few millimetres off the wall *and* get a depth bias:
      // the offset alone breaks down at grazing angles and long distances.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
    });

    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.matrixAutoUpdate = false;
  }

  add(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    size: number, rot: number, life: number, tile: number,
    r: number, g: number, b: number, alpha: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.cap;
    const p = this.aPos.array as Float32Array;
    const n = this.aNrm.array as Float32Array;
    const i3 = i * 3;
    // Lift off the surface by a fraction of the decal size — enough to clear
    // depth precision at range without floating visibly up close.
    const lift = 0.006 + size * 0.03;
    p[i3] = x + nx * lift;
    p[i3 + 1] = y + ny * lift;
    p[i3 + 2] = z + nz * lift;
    n[i3] = nx; n[i3 + 1] = ny; n[i3 + 2] = nz;
    (this.aRot.array as Float32Array)[i] = rot;
    (this.aSize.array as Float32Array)[i] = size;
    (this.aTile.array as Float32Array)[i] = tile;
    const c = this.aColor.array as Float32Array;
    c[i3] = r; c[i3 + 1] = g; c[i3 + 2] = b;
    this.age[i] = 0;
    this.life[i] = life;
    this.peak[i] = alpha;
    (this.aAlpha.array as Float32Array)[i] = alpha;
    if (i >= this.live) this.live = i + 1;
    this.aPos.needsUpdate = true;
    this.aNrm.needsUpdate = true;
    this.aRot.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aTile.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.geo.instanceCount = this.live;
  }

  update(dt: number): void {
    const n = this.live;
    if (n === 0) return;
    const alpha = this.aAlpha.array as Float32Array;
    let dirty = false;
    for (let i = 0; i < n; i++) {
      const a = this.age[i];
      if (a >= this.life[i]) {
        if (alpha[i] !== 0) {
          alpha[i] = 0;
          dirty = true;
        }
        continue;
      }
      this.age[i] = a + dt;
      const remain = this.life[i] - this.age[i];
      // Two-second fade-out. Long enough to be invisible, short enough that a
      // wrapped pool does not leave ghosts.
      const f = remain < 2 ? clamp01(remain / 2) : 1;
      const want = this.peak[i] * f;
      if (alpha[i] !== want) {
        alpha[i] = want;
        dirty = true;
      }
    }
    if (dirty) this.aAlpha.needsUpdate = true;
  }

  clear(): void {
    this.age.fill(1e9);
    (this.aAlpha.array as Float32Array).fill(0);
    this.aAlpha.needsUpdate = true;
    this.live = 0;
    this.cursor = 0;
    this.geo.instanceCount = 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

/* ------------------------------------------------------------------ *
 * Impact system
 * ------------------------------------------------------------------ */

const _color = new THREE.Color();

export class ImpactSystem {
  readonly group = new THREE.Group();
  private layers = new Map<DecalFamily, DecalLayer>();
  private fx: WeaponEffects;
  private rng: Rng = makeRng("sf-weapon-impacts");
  private tier: QualityTier;
  /** Impacts processed this frame — a hard rate limit on a 900 RPM firefight. */
  private budget = 0;
  private debrisBudget = 0;

  constructor(fx: WeaponEffects, tier: QualityTier = "high") {
    this.fx = fx;
    this.tier = tier;
    const q = QUALITY[tier];
    // Decal caps scale with the tier: on Low a corridor firefight should not
    // be maintaining three hundred quads it will never look at again.
    const scale = q.maxParticles >= 20000 ? 1 : q.maxParticles >= 8000 ? 0.6 : 0.35;
    const cap = (n: number) => Math.max(12, Math.round(n * scale));
    this.layers.set("hard", new DecalLayer(cap(128), decalTexture("hard"), false));
    this.layers.set("metal", new DecalLayer(cap(48), decalTexture("metal"), false));
    this.layers.set("glass", new DecalLayer(cap(48), decalTexture("glass"), false));
    this.layers.set("soft", new DecalLayer(cap(48), decalTexture("soft"), false));
    this.layers.set("scorch", new DecalLayer(cap(24), decalTexture("scorch"), false));
    for (const l of this.layers.values()) this.group.add(l.mesh);
  }

  /**
   * The full impact response for one hit.
   *
   * `strength` folds together the round's remaining energy and the weapon's
   * calibre so a .45 at 60 m does not throw the same debris as a .338 at
   * contact range.
   */
  spawn(h: WeaponHit, def: WeaponDef): void {
    if (this.budget > 26) return;
    this.budget++;

    const r = RESPONSE[h.surface] ?? RESPONSE.concrete;
    const props = SURFACE_PROPS[h.surface] ?? SURFACE_PROPS.concrete;
    const rng = this.rng;

    // Calibre weight, 0..1: a pistol is 0.25, a .338 is ~0.9.
    const calibre = clamp01((def.damage[0]?.dmg ?? 30) / 90 + (def.view.casing[0] ?? 0.005) * 40);
    const strength = clamp(h.energy * (0.45 + calibre), 0.15, 1.6);
    const nx = h.nx;
    const ny = h.ny;
    const nz = h.nz;

    /* ---------------- decal ---------------- */
    if (r.decal && props.decal > 0 && h.damage >= 0) {
      const layer = this.layers.get(r.decal);
      if (layer) {
        _color.setHex(0xffffff);
        const size = r.decalSize * (0.75 + rng.next() * 0.55) * (0.7 + calibre * 0.8);
        layer.add(
          h.x, h.y, h.z, nx, ny, nz,
          size,
          rng.next() * Math.PI * 2,
          r.decalLife * props.decal,
          rng.int(0, 3),
          1, 1, 1,
          clamp01(0.55 + strength * 0.45),
        );
        // Explosives leave a scorch ring under the crater.
        if (def.explosive) {
          const scorch = this.layers.get("scorch");
          scorch?.add(
            h.x, h.y, h.z, nx, ny, nz,
            (def.explosive.radius ?? 6) * 0.34,
            rng.next() * 6.28, 60, rng.int(0, 3), 1, 1, 1, 0.75,
          );
        }
      }
    }

    /* ---------------- dust ---------------- */
    const dustCount = Math.round(r.dust * strength * props.dust);
    if (dustCount > 0) {
      _color.setHex(r.dustColor);
      for (let i = 0; i < dustCount; i++) {
        const sp = 0.6 + rng.next() * 2.6 * strength;
        pspec.x = h.x + nx * 0.03;
        pspec.y = h.y + ny * 0.03;
        pspec.z = h.z + nz * 0.03;
        // Cone around the surface normal, biased back along the incoming ray.
        pspec.vx = nx * sp + rng.gauss() * 0.9 - h.dx * 0.5;
        pspec.vy = ny * sp + rng.gauss() * 0.9 - h.dy * 0.5 + 0.3;
        pspec.vz = nz * sp + rng.gauss() * 0.9 - h.dz * 0.5;
        pspec.life = 0.45 + rng.next() * 0.9;
        pspec.size = r.dustSize * (0.35 + rng.next() * 0.5);
        pspec.sizeEnd = r.dustSize * (1.4 + rng.next() * 1.5);
        pspec.r = _color.r * (0.85 + rng.next() * 0.3);
        pspec.g = _color.g * (0.85 + rng.next() * 0.3);
        pspec.b = _color.b * (0.85 + rng.next() * 0.3);
        pspec.alpha = 0.22 + rng.next() * 0.22;
        pspec.rot = rng.next() * 6.28;
        pspec.spin = rng.gauss() * 1.2;
        pspec.drag = 2.4;
        pspec.gravity = h.surface === "water" ? -7 : -1.4;
        pspec.windPull = 0.55;
        pspec.tile = 0;
        pspec.floor = -1e9;
        pspec.fadeIn = 0.06;
        pspec.stretch = 0;
        this.fx.dust.emit();
      }
    }

    /* ---------------- sparks ---------------- */
    const sparkCount = Math.round(r.sparks * strength * (0.4 + props.sparks));
    if (sparkCount > 0) {
      _color.setHex(r.sparkColor);
      for (let i = 0; i < sparkCount; i++) {
        // Sparks leave along the *reflection*, not the normal: that is why a
        // grazing hit on a car door throws a fan and a square-on hit does not.
        const d = h.dx * nx + h.dy * ny + h.dz * nz;
        const rx = h.dx - 2 * d * nx;
        const ry = h.dy - 2 * d * ny;
        const rz = h.dz - 2 * d * nz;
        const sp = 3 + rng.next() * 11 * strength;
        pspec.x = h.x + nx * 0.02;
        pspec.y = h.y + ny * 0.02;
        pspec.z = h.z + nz * 0.02;
        pspec.vx = rx * sp + rng.gauss() * 2.2;
        pspec.vy = ry * sp + rng.gauss() * 2.2 + 0.6;
        pspec.vz = rz * sp + rng.gauss() * 2.2;
        pspec.life = 0.18 + rng.next() * 0.55;
        pspec.size = 0.01 + rng.next() * 0.017;
        pspec.sizeEnd = 0.002;
        pspec.r = _color.r * 2.2; pspec.g = _color.g * 1.6; pspec.b = _color.b * 0.9;
        pspec.alpha = 1;
        pspec.drag = 0.9;
        pspec.gravity = -13;
        pspec.windPull = 0.1;
        pspec.tile = 0;
        pspec.floor = -1e9;
        pspec.fadeIn = 0.02;
        pspec.stretch = 0.95;
        this.fx.sparks.emit();
      }
      pspec.stretch = 0;
    }

    /* ---------------- chips / splinters / shards ---------------- */
    const chipCount = Math.round(r.chips * strength);
    if (chipCount > 0) {
      _color.setHex(r.chipColor);
      const wet = h.surface === "flesh";
      for (let i = 0; i < chipCount; i++) {
        const sp = 1.5 + rng.next() * 6.5 * strength;
        pspec.x = h.x + nx * 0.02;
        pspec.y = h.y + ny * 0.02;
        pspec.z = h.z + nz * 0.02;
        pspec.vx = nx * sp + rng.gauss() * 2.4 - h.dx * 1.2;
        pspec.vy = ny * sp + rng.gauss() * 2.4 - h.dy * 1.2 + 1.2;
        pspec.vz = nz * sp + rng.gauss() * 2.4 - h.dz * 1.2;
        pspec.life = (0.5 + rng.next() * 0.9) * r.chipLife;
        pspec.size = 0.012 + rng.next() * 0.026;
        pspec.sizeEnd = pspec.size * (wet ? 0.4 : 0.85);
        pspec.r = _color.r; pspec.g = _color.g; pspec.b = _color.b;
        pspec.alpha = wet ? 0.85 : 1;
        pspec.rot = rng.next() * 6.28;
        pspec.spin = rng.gauss() * 14;
        pspec.drag = wet ? 1.6 : 0.35;
        pspec.gravity = -16;
        pspec.windPull = 0.05;
        pspec.tile = 0;
        pspec.floor = -1e9;
        pspec.fadeIn = 0.03;
        pspec.stretch = wet ? 0.6 : 0;
        this.fx.dust.emit();
      }
      pspec.stretch = 0;
    }

    /* ---------------- water column ---------------- */
    if (h.surface === "water") {
      for (let i = 0; i < 6; i++) {
        pspec.x = h.x + rng.gauss() * 0.06;
        pspec.y = h.y;
        pspec.z = h.z + rng.gauss() * 0.06;
        pspec.vx = rng.gauss() * 1.1;
        pspec.vy = 3.4 + rng.next() * 4.5 * strength;
        pspec.vz = rng.gauss() * 1.1;
        pspec.life = 0.5 + rng.next() * 0.5;
        pspec.size = 0.05 + rng.next() * 0.05;
        pspec.sizeEnd = 0.16;
        pspec.r = 1.4; pspec.g = 1.5; pspec.b = 1.55;
        pspec.alpha = 0.5;
        pspec.drag = 0.6;
        pspec.gravity = -11;
        pspec.windPull = 0.2;
        pspec.tile = 0;
        pspec.fadeIn = 0.05;
        pspec.stretch = 0.7;
        this.fx.sparks.emit();
      }
      pspec.stretch = 0;
    }

    /* ---------------- lingering smoke ---------------- */
    if (r.smoke > 0 && strength > 0.5 && rng.chance(0.45)) {
      pspec.x = h.x + nx * 0.05;
      pspec.y = h.y + ny * 0.05;
      pspec.z = h.z + nz * 0.05;
      pspec.vx = nx * 0.5 + rng.gauss() * 0.2;
      pspec.vy = ny * 0.5 + 0.5;
      pspec.vz = nz * 0.5 + rng.gauss() * 0.2;
      pspec.life = 0.9 + rng.next() * 1.4;
      pspec.size = 0.05;
      pspec.sizeEnd = 0.4 + rng.next() * 0.4;
      const v = 0.5 + rng.next() * 0.16;
      pspec.r = v; pspec.g = v; pspec.b = v * 0.97;
      pspec.alpha = 0.12 * r.smoke * 3;
      pspec.rot = rng.next() * 6.28;
      pspec.spin = rng.gauss() * 0.5;
      pspec.drag = 1.8;
      pspec.gravity = 0.4;
      pspec.windPull = 0.9;
      pspec.tile = 0;
      pspec.fadeIn = 0.2;
      this.fx.smoke.emit();
    }

    /* ---------------- physical debris ---------------- */
    // Real rigid bodies, sparingly: only heavy hits on hard surfaces, and only
    // a couple per second, because every one of these is a solver island.
    if (
      this.debrisBudget < 2 &&
      strength > 0.85 &&
      (h.surface === "concrete" || h.surface === "brick" || h.surface === "stone" || h.surface === "wood") &&
      rng.chance(0.3)
    ) {
      this.debrisBudget++;
      const s = 0.02 + rng.next() * 0.035;
      rigidBodyPool.spawn({
        shape: "box",
        hx: s, hy: s * (0.5 + rng.next() * 0.6), hz: s * (0.6 + rng.next() * 0.7),
        x: h.x + nx * 0.05, y: h.y + ny * 0.05, z: h.z + nz * 0.05,
        vx: nx * 3 + rng.gauss() * 2,
        vy: ny * 3 + rng.gauss() * 2 + 1.5,
        vz: nz * 3 + rng.gauss() * 2,
        avx: rng.gauss() * 12, avy: rng.gauss() * 12, avz: rng.gauss() * 12,
        density: h.surface === "wood" ? 620 : 2300,
        friction: 0.8,
        restitution: 0.18,
        lifetime: 6 + rng.next() * 4,
        kind: "debris",
        surface: h.surface,
        priority: 0,
      });
    }

    /* ---------------- audio ---------------- */
    const dx = h.x - frame.position.x;
    const dy = h.y - frame.position.y;
    const dz = h.z - frame.position.z;
    const dist = Math.hypot(dx, dy, dz);
    // Distance rolloff plus a floor so a hit at 200 m is a faint slap rather
    // than silence — the player needs to hear that they connected.
    const vol = clamp(strength * (1 - clamp01(dist / 140)) * 0.9 + 0.05, 0, 1.2);
    if (vol > 0.06) {
      playImpactSound(r.audio, {
        x: h.x, y: h.y, z: h.z,
        volume: vol,
        pitch: r.pitch * (0.92 + this.rng.next() * 0.16),
        loudness: 90,
      });
    }
  }

  /** Casing landing tink, routed here so all impact audio shares one path. */
  casingLanded(x: number, y: number, z: number, strength: number): void {
    playImpactSound("casing", {
      x, y, z,
      volume: 0.16 + strength * 0.3,
      pitch: 1.4 + this.rng.next() * 0.5,
      loudness: 24,
    });
  }

  update(dt: number): void {
    this.budget = 0;
    this.debrisBudget = 0;
    for (const l of this.layers.values()) l.update(dt);
  }

  clear(): void {
    for (const l of this.layers.values()) l.clear();
  }

  dispose(): void {
    for (const l of this.layers.values()) l.dispose();
    this.layers.clear();
    this.group.clear();
  }
}
