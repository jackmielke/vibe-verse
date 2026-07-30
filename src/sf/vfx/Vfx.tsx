/**
 * vfx/Vfx.tsx — the VFX root and the module-level imperative API.
 *
 * Mount `<Vfx />` once inside the canvas. Everything else in the game calls
 * `vfx.spawnExplosion(...)`, `vfx.spawnImpact(...)`, `vfx.spawnDecal(...)`
 * from anywhere, with no props, no context and no React involvement — a weapon
 * firing at 900 rounds per minute must not touch the React tree.
 *
 * ## Why a singleton and not a context
 *
 * The consumers are the weapon system, the vehicle system, the destruction
 * system and the AI. None of them are React components; most of them run
 * inside `useFrame` callbacks or physics callbacks. A context would force each
 * of them to become a component or to be handed a ref through five layers of
 * props. The singleton is the honest shape of the dependency.
 *
 * Calls made before the component mounts are safe no-ops. That is deliberate:
 * physics and weapons boot on their own schedule and must not have to check.
 *
 * ## Frame order
 *
 * `Vfx` runs at r3f priority 0 like everything else, so within a frame it
 * updates after whatever mounted before it. That is fine: particle motion is
 * evaluated on the GPU from a spawn timestamp, so a spawn that lands after the
 * update is simply uploaded on the next frame and starts from the correct
 * point in its life. Nothing drifts.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { QualityTier } from "../config";
import { frame, useSfStore } from "../state/store";
import { walkableHeight } from "../geo/sfGeo";

import {
  Billboard, P, budget, emitCone, emitRing, emitSphere, emitTrail, particles,
  resetDesc, setParticleScale, vfxRng, type ParticleDesc,
} from "./particles";
import { Tile, disposeVfxTextures, preloadVfxTextures } from "./textures";
import {
  decals, bloodDecal, bulletHoleDecal, crackDecal, graffitiDecal, oilDecal,
  scorchDecal, sootDecal, tyreMarkDecal, wetDecal, type DecalOptions,
} from "./decals";
import { trails, tracerTrail, rocketTrail, wingtipTrail, grappleTrail, smokeTrail } from "./trails";
import { debris, spawnDebrisBurst, spawnImpactChips, spawnCollapseDust } from "./debris";
import {
  fire, igniteFire, extinguishFire, isBurningNear, registerFlammable,
  spawnFuelFire, spawnSmallFire, spawnVehicleFire, flameBurst, clearFlammables,
} from "./fire";
import {
  environment, weather, setWeather, emitExhaust, emitTyreSmoke, emitPowerlineSpark,
  emitWaterSplash, emitFootDust, emitRotorWash,
} from "./environmental";
import {
  explosions, spawnExplosion, shockwaveBuffer, shockwaveCount,
  type ExplosionOptions, type ExplosionYield,
} from "./explosion";

/* ================================================================== *
 * Impact effects
 * ================================================================== */

/** Per-surface impact recipe. Keys match `SurfaceTag` from `@/sf/physics`. */
interface ImpactLook {
  sparks: number;
  dust: number;
  dr: number; dg: number; db: number;
  /** 0 = none, 1 = a puff of smoke on top of the dust. */
  smoke: number;
  chips: number;
  wet: boolean;
}

const IMPACTS: Record<string, ImpactLook> = {
  concrete: { sparks: 0.15, dust: 1.0, dr: 0.74, dg: 0.72, db: 0.68, smoke: 0.35, chips: 1, wet: false },
  asphalt: { sparks: 0.1, dust: 0.8, dr: 0.45, dg: 0.44, db: 0.42, smoke: 0.3, chips: 0.8, wet: false },
  brick: { sparks: 0.1, dust: 1.1, dr: 0.68, dg: 0.48, db: 0.4, smoke: 0.35, chips: 1, wet: false },
  stone: { sparks: 0.35, dust: 0.9, dr: 0.7, dg: 0.68, db: 0.64, smoke: 0.3, chips: 1, wet: false },
  stucco: { sparks: 0, dust: 1.3, dr: 0.85, dg: 0.82, db: 0.76, smoke: 0.25, chips: 0.9, wet: false },
  metal: { sparks: 1.5, dust: 0.1, dr: 0.5, dg: 0.5, db: 0.52, smoke: 0.1, chips: 0.5, wet: false },
  thinMetal: { sparks: 1.2, dust: 0.1, dr: 0.5, dg: 0.5, db: 0.52, smoke: 0.1, chips: 0.6, wet: false },
  glass: { sparks: 0.05, dust: 0.2, dr: 0.85, dg: 0.9, db: 0.95, smoke: 0, chips: 1.6, wet: false },
  wood: { sparks: 0, dust: 0.5, dr: 0.55, dg: 0.44, db: 0.32, smoke: 0.2, chips: 1.2, wet: false },
  dirt: { sparks: 0, dust: 1.5, dr: 0.5, dg: 0.42, db: 0.32, smoke: 0.1, chips: 0.4, wet: false },
  grass: { sparks: 0, dust: 0.9, dr: 0.4, dg: 0.45, db: 0.28, smoke: 0.1, chips: 0.5, wet: false },
  sand: { sparks: 0, dust: 1.7, dr: 0.82, dg: 0.75, db: 0.6, smoke: 0.05, chips: 0.3, wet: false },
  gravel: { sparks: 0.2, dust: 1.2, dr: 0.62, dg: 0.6, db: 0.56, smoke: 0.1, chips: 1.1, wet: false },
  water: { sparks: 0, dust: 0, dr: 1, dg: 1, db: 1, smoke: 0, chips: 0, wet: true },
  flesh: { sparks: 0, dust: 0, dr: 0.4, dg: 0.05, db: 0.04, smoke: 0, chips: 0, wet: false },
  foliage: { sparks: 0, dust: 0.3, dr: 0.32, dg: 0.42, db: 0.24, smoke: 0, chips: 0.8, wet: false },
  plastic: { sparks: 0.1, dust: 0.3, dr: 0.5, dg: 0.5, db: 0.52, smoke: 0.15, chips: 0.9, wet: false },
  rubber: { sparks: 0, dust: 0.2, dr: 0.3, dg: 0.3, db: 0.3, smoke: 0.3, chips: 0.5, wet: false },
  fabric: { sparks: 0, dust: 0.6, dr: 0.6, dg: 0.58, db: 0.55, smoke: 0.05, chips: 0.4, wet: false },
};

/**
 * The full impact stack for a bullet or a small fragment: sparks, dust, smoke,
 * chips and a hole. Every weapon in the game routes through this so a rifle
 * round on brick reads the same wherever it was fired from.
 */
export function spawnImpact(
  x: number, y: number, z: number,
  nx: number, ny: number, nz: number,
  surface = "concrete",
  strength = 1,
): void {
  if (surface === "water") {
    emitWaterSplash(x, y, z, 0.35 * strength);
    return;
  }
  const look = IMPACTS[surface] ?? IMPACTS.concrete;

  // --- sparks (metal only, really) ---
  if (look.sparks > 0.02) {
    resetDesc();
    P.layer = "add";
    P.x = x; P.y = y; P.z = z;
    P.drag = 1.1;
    P.gravity = -24;
    P.turbulence = 0.3;
    P.wind = 0.15;
    P.life = 0.34;
    P.size0 = 0.075 * strength;
    P.size1 = 0.012;
    P.frame = Tile.Spark;
    P.mode = Billboard.Stretch;
    P.stretch = 2.4;
    P.r0 = 3.0; P.g0 = 2.0; P.b0 = 0.9; P.a0 = 1;
    P.r1 = 1.5; P.g1 = 0.4; P.b1 = 0.05; P.a1 = 0;
    P.fadeIn = 0.01; P.fadeOut = 0.35;
    emitCone(P, nx, ny, nz, 1.15, {
      count: budget(Math.round(6 + 14 * look.sparks * strength)),
      speed: [4, 17 * strength],
      lifeJitter: 0.6, sizeJitter: 0.5,
      offset: 0.03,
    });
  }

  // --- dust puff ---
  if (look.dust > 0.05) {
    resetDesc();
    P.layer = "alpha";
    P.x = x; P.y = y; P.z = z;
    P.drag = 3.4;
    P.gravity = -0.4;
    P.turbulence = 0.9;
    P.wind = 0.5;
    P.life = 0.85 + strength * 0.3;
    P.size0 = 0.1 * strength;
    P.size1 = 0.85 * strength * look.dust;
    P.frame = Tile.Dust;
    P.rotSpeed = 1.1;
    P.r0 = look.dr; P.g0 = look.dg; P.b0 = look.db; P.a0 = 0.42 * look.dust;
    P.r1 = look.dr * 0.9; P.g1 = look.dg * 0.9; P.b1 = look.db * 0.9; P.a1 = 0;
    P.fadeIn = 0.06; P.fadeOut = 0.6;
    emitCone(P, nx, ny, nz, 1.3, {
      count: budget(Math.round(2 + 4 * look.dust)),
      speed: [0.6, 3.4 * strength],
      sizeJitter: 0.4, lifeJitter: 0.4,
      offset: 0.02,
    });
  }

  // --- lingering smoke wisp ---
  if (look.smoke > 0.05 && vfxRng.chance(0.5)) {
    resetDesc();
    P.layer = "alpha";
    P.x = x + nx * 0.05; P.y = y + ny * 0.05; P.z = z + nz * 0.05;
    P.vx = nx * 0.4; P.vy = ny * 0.4 + 0.35; P.vz = nz * 0.4;
    P.drag = 1.6;
    P.gravity = 0.7;
    P.turbulence = 1.1;
    P.wind = 0.8;
    P.life = 1.6;
    P.size0 = 0.14;
    P.size1 = 1.1;
    P.frame = Tile.Smoke;
    P.rot = vfxRng.range(0, 6.283);
    P.rotSpeed = 0.5;
    P.r0 = 0.6; P.g0 = 0.58; P.b0 = 0.55; P.a0 = 0.2 * look.smoke;
    P.r1 = 0.55; P.g1 = 0.55; P.b1 = 0.55; P.a1 = 0;
    P.fadeIn = 0.14; P.fadeOut = 0.6;
    particles.emit(P);
  }

  // --- chips + hole ---
  if (look.chips > 0.05) spawnImpactChips(x, y, z, nx, ny, nz, surface, strength * look.chips);
  if (surface === "flesh") {
    bloodDecal(x, y, z, nx, ny, nz, 0.35 * strength);
    bloodSpray(x, y, z, nx, ny, nz, strength);
  } else {
    bulletHoleDecal(x, y, z, nx, ny, nz, surface, strength);
    if (strength > 1.6) crackDecal(x, y, z, nx, ny, nz, 0.3 * strength);
  }
}

/** Arterial spray — the particle half of a flesh impact. */
export function bloodSpray(
  x: number, y: number, z: number,
  nx: number, ny: number, nz: number,
  strength = 1,
): void {
  resetDesc();
  P.layer = "alpha";
  P.x = x; P.y = y; P.z = z;
  P.drag = 1.4;
  P.gravity = -17;
  P.turbulence = 0.4;
  P.wind = 0.2;
  P.life = 0.7;
  P.size0 = 0.07 * strength;
  P.size1 = 0.16 * strength;
  P.frame = Tile.Blood;
  P.mode = Billboard.Stretch;
  P.stretch = 1.4;
  P.r0 = 0.55; P.g0 = 0.05; P.b0 = 0.04; P.a0 = 0.95;
  P.r1 = 0.32; P.g1 = 0.03; P.b1 = 0.03; P.a1 = 0;
  P.fadeIn = 0.02; P.fadeOut = 0.4;
  // Spray goes *out the back* — along the impact direction, not the normal.
  emitCone(P, -nx, -ny, -nz, 0.7, {
    count: budget(Math.round(6 + 10 * strength)),
    speed: [2.5, 10 * strength],
    sizeJitter: 0.5, lifeJitter: 0.5,
    offset: 0.05,
  });
}

/** Muzzle flash: a flash star, a hot cone of gas, and a whip of smoke. */
export function spawnMuzzleFlash(
  x: number, y: number, z: number,
  dx: number, dy: number, dz: number,
  scale = 1,
): void {
  const len = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / len, uy = dy / len, uz = dz / len;

  resetDesc();
  P.layer = "add";
  P.x = x + ux * 0.06; P.y = y + uy * 0.06; P.z = z + uz * 0.06;
  P.drag = 8; P.gravity = 0; P.turbulence = 0; P.wind = 0;
  P.life = 0.045;
  P.size0 = 0.38 * scale;
  P.size1 = 0.62 * scale;
  P.frame = Tile.Flash;
  P.rot = vfxRng.range(0, 6.283);
  P.r0 = 3.4; P.g0 = 2.5; P.b0 = 1.4; P.a0 = 1;
  P.r1 = 2.0; P.g1 = 1.0; P.b1 = 0.35; P.a1 = 0;
  P.fadeIn = 0.01; P.fadeOut = 0.6;
  particles.emit(P);

  // Propellant gas: a short, fast cone that dies almost immediately.
  resetDesc();
  P.layer = "flame";
  P.x = x; P.y = y; P.z = z;
  P.drag = 7;
  P.gravity = 1.5;
  P.turbulence = 0.8;
  P.wind = 0.2;
  P.life = 0.09;
  P.size0 = 0.12 * scale;
  P.size1 = 0.42 * scale;
  P.frames = 16; P.fps = 60; P.frame = vfxRng.int(0, 8);
  P.r0 = 2.8; P.g0 = 1.9; P.b0 = 0.9; P.a0 = 1;
  P.r1 = 1.2; P.g1 = 0.4; P.b1 = 0.08; P.a1 = 0;
  P.fadeIn = 0.02; P.fadeOut = 0.55;
  emitCone(P, ux, uy, uz, 0.42, {
    count: budget(Math.round(4 + 4 * scale)),
    speed: [6, 22 * scale],
    sizeJitter: 0.4, lifeJitter: 0.4,
    offset: 0.08,
  });

  // Unburnt powder sparks, only sometimes.
  if (vfxRng.chance(0.55)) {
    resetDesc();
    P.layer = "add";
    P.x = x; P.y = y; P.z = z;
    P.drag = 1.4; P.gravity = -18; P.turbulence = 0.2; P.wind = 0.2;
    P.life = 0.3;
    P.size0 = 0.045 * scale; P.size1 = 0.008;
    P.frame = Tile.Spark;
    P.mode = Billboard.Stretch;
    P.stretch = 2;
    P.r0 = 2.6; P.g0 = 1.5; P.b0 = 0.5; P.a0 = 1;
    P.r1 = 1.0; P.g1 = 0.2; P.b1 = 0.02; P.a1 = 0;
    emitCone(P, ux, uy, uz, 0.6, {
      count: budget(Math.round(3 + 4 * scale)),
      speed: [3, 13],
      lifeJitter: 0.6,
      offset: 0.1,
    });
  }

  // Smoke curl off the muzzle — the thing that says the gun is hot.
  resetDesc();
  P.layer = "alpha";
  P.x = x + ux * 0.12; P.y = y + uy * 0.12; P.z = z + uz * 0.12;
  P.vx = ux * 1.4; P.vy = uy * 1.4 + 0.3; P.vz = uz * 1.4;
  P.drag = 2.4;
  P.gravity = 0.6;
  P.turbulence = 1.1;
  P.wind = 0.7;
  P.life = 0.9 + vfxRng.range(0, 0.6);
  P.size0 = 0.08 * scale;
  P.size1 = 0.9 * scale;
  P.frame = Tile.Smoke;
  P.rot = vfxRng.range(0, 6.283);
  P.rotSpeed = vfxRng.range(-1, 1);
  P.r0 = 0.72; P.g0 = 0.71; P.b0 = 0.7; P.a0 = 0.22;
  P.r1 = 0.66; P.g1 = 0.66; P.b1 = 0.66; P.a1 = 0;
  P.fadeIn = 0.15; P.fadeOut = 0.6;
  particles.emit(P);
}

/** A shell casing's ping of light — cheap, and it sells automatic fire. */
export function spawnCasingGlint(x: number, y: number, z: number): void {
  resetDesc();
  P.layer = "add";
  P.x = x; P.y = y; P.z = z;
  P.drag = 0.6; P.gravity = -19; P.turbulence = 0; P.wind = 0;
  P.life = 0.55;
  P.size0 = 0.035; P.size1 = 0.02;
  P.frame = Tile.Glow;
  P.r0 = 1.6; P.g0 = 1.2; P.b0 = 0.5; P.a0 = 0.7;
  P.r1 = 0.8; P.g1 = 0.55; P.b1 = 0.2; P.a1 = 0;
  P.vx = vfxRng.range(1.5, 3.5) * (vfxRng.chance(0.5) ? 1 : -1);
  P.vy = vfxRng.range(1, 3);
  P.vz = vfxRng.gauss() * 1.5;
  particles.emit(P);
}

/* ================================================================== *
 * The singleton
 * ================================================================== */

let initialised = false;
let currentTier: QualityTier | null = null;

function initVfx(tier: QualityTier): void {
  if (initialised && currentTier === tier) return;
  if (initialised) disposeVfx();
  setParticleScale(tier);
  particles.init(tier);
  decals.init(tier);
  trails.init(tier);
  debris.init(tier);
  fire.init(tier);
  explosions.init(tier);
  environment.init(tier);
  initialised = true;
  currentTier = tier;
}

function disposeVfx(): void {
  particles.dispose();
  decals.dispose();
  trails.dispose();
  debris.dispose();
  fire.dispose();
  explosions.dispose();
  environment.dispose();
  clearFlammables();
  initialised = false;
  currentTier = null;
}

/** Wipe every live effect without tearing the system down (respawn, teleport). */
function clearVfx(): void {
  particles.clear();
  decals.clear();
  trails.clear();
  debris.clear();
  fire.clear();
  explosions.clear();
}

/**
 * The public VFX surface. Import `vfx` from `@/sf/vfx` and call it from
 * anywhere — weapons, vehicles, physics callbacks, AI.
 */
export const vfx = {
  /* --- lifecycle --- */
  init: initVfx,
  /** Bake every texture ahead of time; call from the loading screen. */
  preloadTextures: preloadVfxTextures,
  dispose: disposeVfx,
  clear: clearVfx,
  get ready() {
    return initialised;
  },

  /* --- explosions --- */
  spawnExplosion,
  /** Live shockwave data for a post-processing refraction pass. */
  shockwaves: shockwaveBuffer,
  get shockwaveCount() {
    return shockwaveCount;
  },

  /* --- impacts + weapons --- */
  spawnImpact,
  spawnImpactChips,
  spawnMuzzleFlash,
  spawnCasingGlint,
  bloodSpray,

  /* --- fire --- */
  igniteFire,
  extinguishFire,
  isBurningNear,
  registerFlammable,
  spawnSmallFire,
  spawnVehicleFire,
  spawnFuelFire,
  flameBurst,

  /* --- debris --- */
  spawnDebris: spawnDebrisBurst,
  spawnCollapseDust,

  /* --- decals --- */
  spawnDecal: (x: number, y: number, z: number, o: DecalOptions) => decals.spawn(x, y, z, o),
  scorchDecal,
  bulletHoleDecal,
  bloodDecal,
  oilDecal,
  tyreMarkDecal,
  graffitiDecal,
  sootDecal,
  wetDecal,
  crackDecal,
  setDecalGroundSampler: (fn: (x: number, z: number) => number) => decals.setGroundSampler(fn),

  /* --- trails --- */
  acquireTrail: (x: number, y: number, z: number, o: Parameters<typeof trails.acquire>[3]) =>
    trails.acquire(x, y, z, o),
  moveTrail: (h: number, x: number, y: number, z: number) => trails.move(h, x, y, z),
  releaseTrail: (h: number) => trails.release(h),
  killTrail: (h: number) => trails.kill(h),
  rocketTrail,
  tracerTrail,
  wingtipTrail,
  grappleTrail,
  smokeTrail,

  /* --- environment --- */
  setWeather,
  weather,
  emitExhaust,
  emitTyreSmoke,
  emitPowerlineSpark,
  emitWaterSplash,
  emitFootDust,
  emitRotorWash,

  /* --- low-level particle access, for systems with bespoke needs --- */
  particles,
  emit: (d: ParticleDesc) => particles.emit(d),
  emitSphere,
  emitCone,
  emitRing,
  emitTrail,
  desc: P,
  resetDesc,

  /* --- integration hooks --- */
  /** Bind a scene depth texture to enable soft particles. */
  setDepthTexture: (tex: THREE.Texture | null, softness?: number) =>
    particles.setDepthTexture(tex, softness),
  /** Global alpha, for photo mode and death fades. */
  setMasterAlpha: (a: number) => particles.setMaster(a),

  /* --- stats --- */
  stats: () => ({
    particles: particles.counts(),
    decals: decals.liveCount,
    trails: trails.liveCount,
    debris: debris.liveCount,
    fires: fire.liveCount,
  }),
};

/* ================================================================== *
 * Component
 * ================================================================== */

export interface VfxProps {
  /** Override the store's quality tier (the screenshot harness uses this). */
  quality?: QualityTier;
  /** Bridge to `@/sf/physics` for rigid-body debris + destruction events. */
  physics?: boolean;
}

export default function Vfx({ quality, physics = true }: VfxProps) {
  const storeTier = useSfStore((s) => s.quality);
  const tier = quality ?? storeTier;
  const { scene, gl, camera } = useThree();
  const size = useRef(new THREE.Vector2(1920, 1080));

  // Build (or rebuild) every subsystem when the tier changes.
  const root = useMemo(() => {
    initVfx(tier);
    const g = new THREE.Group();
    g.name = "sf-vfx";
    g.matrixAutoUpdate = false;
    g.add(particles.group);
    g.add(decals.mesh);
    g.add(trails.group);
    g.add(debris.group);
    g.add(fire.group);
    g.add(explosions.group);
    g.add(environment.group);
    return g;
  }, [tier]);

  useEffect(() => {
    return () => {
      disposeVfx();
      disposeVfxTextures();
    };
  }, []);

  /* --- physics bridge ------------------------------------------------ *
   * Dynamic, so a build that never boots Rapier does not pay for it, and so
   * the VFX system is fully functional (with ballistic fallback debris) if
   * physics fails to load at all.
   * ------------------------------------------------------------------ */
  useEffect(() => {
    if (!physics) return;
    let disposed = false;
    const offs: Array<() => void> = [];
    import("../physics")
      .then((mod) => {
        if (disposed) return;
        debris.setPhysics({
          spawn: (d) => mod.rigidBodyPool.spawn(d as never),
          sample: (h, out) => mod.rigidBodyPool.sample(h, out),
          despawn: (h) => mod.rigidBodyPool.despawn(h),
          isAlive: (h) => mod.rigidBodyPool.isAlive(h),
        });

        // Every explosion the destruction system produces — including chained
        // ones — gets the full visual treatment. This is why a fuel depot
        // going up looks like a chain reaction rather than one big pop.
        offs.push(mod.onExplosion((e) => {
          spawnExplosion(e.x, e.y, e.z, {
            power: e.radius,
            // Deeper links in a chain are visually smaller, which reads as
            // distance and stops a six-tank depot from being a white screen.
            burn: e.chainDepth < 2,
            debris: e.chainDepth < 3,
          });
        }));

        offs.push(mod.onDestructionStage((e) => {
          if (e.stage !== "destroyed") return;
          const surface = e.target.desc.material ?? "concrete";
          const extent = Math.max(e.target.desc.hx, e.target.desc.hy, e.target.desc.hz);
          spawnDebrisBurst({
            x: e.x, y: e.y, z: e.z,
            count: Math.round(4 + extent * 2),
            speed: 4 + extent * 2.5,
            spread: 1.3,
            dx: e.dx, dy: Math.max(0.35, e.dy), dz: e.dz,
            size: Math.max(0.12, extent * 0.22),
            surface,
            lifetime: 8,
          });
          spawnCollapseDust(e.x, e.y, e.z, Math.max(1.2, extent), Math.max(1, extent * 1.4), surface);
        }));
      })
      .catch(() => {
        // No physics: debris falls back to its own integrator. Nothing to do.
      });
    return () => {
      disposed = true;
      for (const off of offs) off();
      debris.setPhysics(null);
    };
  }, [physics]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 20);
    if (frame.paused) return;

    gl.getDrawingBufferSize(size.current);
    const fog = (scene.fog as THREE.Fog | THREE.FogExp2 | null) ?? null;

    // Order matters: everything that *emits* runs before the particle system
    // compacts and uploads, so a frame's spawns are visible on that frame.
    explosions.update(dt, fog);
    fire.update(dt, camera);
    debris.update(dt);
    environment.update(dt, camera);

    trails.update(fog);
    decals.update(fog);
    particles.update(camera as THREE.PerspectiveCamera, fog, size.current.x, size.current.y);
  });

  return <primitive object={root} />;
}

/** Ground-height sampler the decal system uses by default. Exported for tests. */
export { walkableHeight as vfxGroundSampler };
export type { ExplosionOptions, ExplosionYield };
