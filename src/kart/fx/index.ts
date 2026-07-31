/**
 * Vibe Kart — particle VFX: sparks, flame, dust, smoke, explosions.
 *
 * The whole visual effects layer of the game is six draw calls:
 *
 *   1. additive particles   sparks, flame, sparkle, energy, star shimmer
 *   2. alpha particles      smoke, dust, grass, sand, water, debris, confetti
 *   3. skid ribbons         rubber laid on the road, fading over eight seconds
 *   4. star ribbon          the rainbow trail behind an invincible kart
 *   5. additive rings       shockwaves, ripples, boost pops
 *   6. dust rings           landing rings and scorch marks
 *
 * Everything is pooled at boot into fixed-size ring buffers, simulated in the
 * vertex shader, and emitted through shared mutable parameter structs. Steady
 * state allocates nothing: a four-minute race adds zero bytes to the heap from
 * this module. That is not fussiness — a particle system that allocates is a
 * particle system that hitches, and a racer hitching at 200 km/h is the most
 * visible frame-time problem a game can have.
 *
 * Service contract
 * ----------------
 * `ctx.services.vfx` is published *synchronously*, before the atlas is baked,
 * so a system that boots after us and immediately fires a burst is never
 * talking to `undefined`.
 *
 * Dependencies, all optional and all degraded rather than required:
 *   · `services.physics` — the racer list we drive emitters from. Without it we
 *     still service `burst()` and whatever calls `setRacerEmitters` directly.
 *   · `services.models`  — wheel and exhaust anchors. Without it we fall back
 *     to a wheelbase derived from `TUNING`, and the sparks land in the right
 *     place to within a few centimetres.
 *   · `services.track`   — the surface probe that pins skid marks and spray to
 *     the road. Without it we use the kart's own contact estimate.
 *   · a post stack offering a depth texture — soft particles. Without it the
 *     sprites intersect geometry hard, which is what every game did until 2008.
 */
import * as THREE from "three";
import {
  TUNING,
  type ItemKind,
  type KartCtx,
  type KartQuality,
  type RacerState,
  type SurfaceSample,
  type System,
  type VfxBurst,
  type VfxService,
} from "../types";
import { createParticleAtlas, createRainbowTexture, createSkidTexture, TILE } from "./atlas";
import { playBurst } from "./bursts";
import {
  makeRacerFx,
  updateRacerFx,
  updateWindStreaks,
  type RacerFx,
  type SurfaceProbe,
  type WheelLocal,
} from "./emitters";
import { FX_COLORS } from "./palette";
import { ParticleBatch } from "./pool";
import { RibbonPool } from "./ribbons";
import { RingPool } from "./rings";
import { clamp01, type FxStage } from "./stage";

/**
 * Additive handles on top of `VfxService`. Declared here rather than in
 * `types.ts` — that file is shared law and this module does not get to rewrite
 * it. Consumers should feature-detect before calling.
 */
export interface KartVfxService extends VfxService {
  /**
   * Hand the particle batches a depth buffer so sprites fade instead of
   * slicing into geometry. Recompiles two programs; call it once.
   */
  attachDepth(depth: THREE.Texture, near: number, far: number): void;
  detachDepth(): void;
  /** Wipe every live particle, ribbon and ring — a race restart. */
  clear(): void;
  /** Global density trim, 0..1.5, on top of the quality preset. */
  setDensity(scale: number): void;
  /** Live counters for the debug overlay. */
  stats: { additive: number; alpha: number; draws: number; budget: number };
}

interface Caps {
  additive: number;
  alpha: number;
  skid: number;
  star: number;
  rings: number;
  dustRings: number;
  density: number;
  /** Fraction of total particle capacity a single frame may claim. */
  frameShare: number;
}

const CAPS: Record<KartQuality, Caps> = {
  low: { additive: 900, alpha: 700, skid: 420, star: 80, rings: 8, dustRings: 8, density: 0.4, frameShare: 0.3 },
  medium: { additive: 1800, alpha: 1300, skid: 900, star: 140, rings: 12, dustRings: 12, density: 0.7, frameShare: 0.3 },
  high: { additive: 3400, alpha: 2400, skid: 2000, star: 200, rings: 20, dustRings: 16, density: 1.0, frameShare: 0.28 },
  ultra: { additive: 5000, alpha: 3400, skid: 3000, star: 260, rings: 28, dustRings: 22, density: 1.25, frameShare: 0.26 },
};

/** Items whose hit is a detonation rather than a knock. */
const EXPLOSIVE: ReadonlySet<string> = new Set<ItemKind>(["bobomb", "blueShell", "fireflower"]);

export default function createVfx(ctx: KartCtx): System {
  const caps = CAPS[ctx.quality] ?? CAPS.high;

  const root = new THREE.Group();
  root.name = "kart/fx";
  root.matrixAutoUpdate = false;
  root.updateMatrix();
  root.frustumCulled = false;
  ctx.scene.add(root);

  const aniso = Math.min(4, ctx.renderer.capabilities.getMaxAnisotropy?.() ?? 1);
  const atlas = createParticleAtlas(ctx.quality, aniso);
  const skidTex = createSkidTexture(ctx.quality);
  const rainbowTex = createRainbowTexture();

  // Half a texel of inset. The atlas cells already carry a 12% transparent
  // margin; this covers the last case, a mip level where two cells share a
  // texel outright.
  const cellPixels = (atlas.texture.image as HTMLCanvasElement).width / atlas.grid;
  const inset = 0.5 / cellPixels;

  const additive = new ParticleBatch({
    name: "kart/fx/additive",
    capacity: caps.additive,
    atlas: atlas.texture,
    grid: atlas.grid,
    inset,
    additive: true,
    intensity: 1,
    maxStretch: 9,
    renderOrder: 24,
  });
  const alpha = new ParticleBatch({
    name: "kart/fx/alpha",
    capacity: caps.alpha,
    atlas: atlas.texture,
    grid: atlas.grid,
    inset,
    additive: false,
    intensity: 1,
    maxStretch: 7,
    renderOrder: 22,
  });
  const skid = new RibbonPool({
    name: "kart/fx/skid",
    capacity: caps.skid,
    map: skidTex,
    color: new THREE.Color().setHex(0x15171d, THREE.SRGBColorSpace),
    opacity: 1,
    intensity: 1,
    life: 8,
    additive: false,
    renderOrder: 4,
    polygonOffset: 6,
  });
  const star = new RibbonPool({
    name: "kart/fx/star",
    capacity: caps.star,
    map: rainbowTex,
    color: new THREE.Color(1, 1, 1),
    opacity: 0.9,
    intensity: 0.95,
    life: 0.6,
    additive: true,
    renderOrder: 23,
    polygonOffset: 0,
  });
  const rings = new RingPool({
    name: "kart/fx/rings",
    capacity: caps.rings,
    atlas: atlas.texture,
    grid: atlas.grid,
    inset,
    additive: true,
    intensity: 1,
    renderOrder: 21,
  });
  const dustRings = new RingPool({
    name: "kart/fx/dustRings",
    capacity: caps.dustRings,
    atlas: atlas.texture,
    grid: atlas.grid,
    inset,
    additive: false,
    intensity: 1,
    renderOrder: 5,
  });

  root.add(additive.mesh, alpha.mesh, skid.mesh, star.mesh, rings.mesh, dustRings.mesh);

  // Low quality buys back fill rate by shrinking every sprite slightly rather
  // than by dropping populations — a thinner plume still reads as a plume, a
  // missing one reads as a bug.
  if (ctx.quality === "low") {
    additive.setSizeScale(0.85);
    alpha.setSizeScale(0.85);
  }

  const frameBudget = Math.round((caps.additive + caps.alpha) * caps.frameShare);

  const stage: FxStage = {
    additive,
    alpha,
    rings,
    dustRings,
    skid,
    star,
    rng: ctx.rng,
    quality: ctx.quality,
    density: caps.density,
    camera: ctx.camera,
    elapsed: 0,
    budget: frameBudget,
  };

  const racerFx = new Map<number, RacerFx>();
  const fogColor = new THREE.Color(0x9fc6e0);
  const burstNormal = new THREE.Vector3(0, 1, 0);
  const scratchPos = new THREE.Vector3();
  let windAcc = 0;
  let userDensity = 1;

  // --- surface probe -------------------------------------------------------
  // Resolved lazily and latched off on the first throw: a track service that
  // cannot answer a query must cost us accuracy, never the frame.
  let probe: SurfaceProbe = null;
  let probeBroken = false;
  function resolveProbe(): SurfaceProbe {
    if (probe || probeBroken) return probe;
    const track = ctx.services.track;
    if (!track) return null;
    probe = (position: THREE.Vector3, out: SurfaceSample): SurfaceSample => {
      try {
        return track.surfaceAt(position, undefined, out);
      } catch {
        probeBroken = true;
        probe = null;
        out.height = position.y;
        return out;
      }
    };
    return probe;
  }

  function fxFor(racer: RacerState): RacerFx {
    let fx = racerFx.get(racer.id);
    if (!fx) {
      fx = makeRacerFx(racer.id, skid, star);
      racerFx.set(racer.id, fx);
    }
    return fx;
  }

  /**
   * Pull wheel and exhaust anchors off the models system. Retried on a timer
   * because a racer can exist in physics a frame or two before its rig does.
   */
  function ensureAnchors(fx: RacerFx, dt: number): void {
    if (fx.wheels) return;
    fx.anchorRetry -= dt;
    if (fx.anchorRetry > 0) return;
    fx.anchorRetry = 0.5;
    const models = ctx.services.models as
      | { anchors?(id: number): { wheels: WheelLocal[]; exhausts: THREE.Object3D[] } | null }
      | undefined;
    const anchors = models?.anchors?.(fx.id) ?? null;
    if (!anchors) return;
    if (anchors.wheels && anchors.wheels.length >= 4) fx.wheels = anchors.wheels;
    if (anchors.exhausts && anchors.exhausts.length > 0) fx.exhausts = anchors.exhausts;
  }

  function racerById(id: number): RacerState | null {
    const racers = ctx.services.physics?.racers;
    if (!racers) return null;
    for (const r of racers) if (r.id === id) return r;
    return null;
  }

  /** Ground normal of a racer, defaulting to up. */
  function normalOf(racer: RacerState): THREE.Vector3 {
    burstNormal.copy(racer.groundNormal);
    if (burstNormal.lengthSq() < 1e-5) burstNormal.set(0, 1, 0);
    return burstNormal;
  }

  const service: KartVfxService = {
    burst(kind: VfxBurst, position: THREE.Vector3, normal?: THREE.Vector3, scale?: number) {
      playBurst(stage, kind, position, normal, scale ?? 1);
    },

    setRacerEmitters(racer: RacerState) {
      // Both the race loop and this system's own lateUpdate call this; the
      // stamp keeps a double call from doubling every emission rate.
      const fx = fxFor(racer);
      if (fx.stamp === ctx.elapsed) return;
      fx.stamp = ctx.elapsed;
      const dt = ctx.dt > 0 ? Math.min(ctx.dt, 1 / 15) : 1 / 60;
      ensureAnchors(fx, dt);
      updateRacerFx(fx, racer, dt, stage, resolveProbe());
    },

    attachDepth(depth: THREE.Texture, near: number, far: number) {
      const w = ctx.viewport.width * ctx.viewport.dpr;
      const h = ctx.viewport.height * ctx.viewport.dpr;
      additive.setDepth(depth, near, far, w, h);
      alpha.setDepth(depth, near, far, w, h);
    },

    detachDepth() {
      additive.setDepth(null, 0.15, 4000, 1, 1);
      alpha.setDepth(null, 0.15, 4000, 1, 1);
    },

    clear() {
      additive.clear();
      alpha.clear();
      rings.clear();
      dustRings.clear();
      skid.clear();
      star.clear();
      for (const fx of racerFx.values()) {
        for (const w of fx.skid) w.end();
        fx.trail.end();
      }
    },

    setDensity(scale: number) {
      userDensity = clamp01(scale / 1.5) * 1.5;
      stage.density = caps.density * userDensity;
    },

    stats: { additive: 0, alpha: 0, draws: 6, budget: frameBudget },
  };

  // Published before anything heavy so a late-booting system always finds us.
  ctx.services.vfx = service;

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  const offs: Array<() => void> = [];
  const on = (event: string, fn: (payload: unknown) => void) => {
    offs.push(ctx.on(event, fn as (p: never) => void));
  };

  on("kart:boost", (payload) => {
    const { racer: id, source } = (payload ?? {}) as { racer?: number; source?: string };
    const racer = typeof id === "number" ? racerById(id) : null;
    if (!racer) return;
    // Fire the plume out of the exhausts if we know where they are, otherwise
    // off the tail. Two jets read as a kart; one reads as a rocket.
    const fx = fxFor(racer);
    const dirBack = scratchPos.set(0, 0, 1).applyQuaternion(racer.quaternion);
    if (fx.exhausts && fx.exhausts.length > 0) {
      for (const node of fx.exhausts) {
        node.getWorldPosition(burstNormal);
        playBurst(stage, "boostFlame", burstNormal, dirBack, 0.85);
      }
      burstNormal.set(0, 1, 0);
    } else {
      playBurst(stage, "boostFlame", racer.position, dirBack, 1);
    }
    if (source === "miniTurbo" || source === "pad" || source === "start") {
      playBurst(stage, "shockwave", racer.position, normalOf(racer), 0.55);
    }
  });

  on("kart:miniTurbo", (payload) => {
    const { racer: id, tier } = (payload ?? {}) as { racer?: number; tier?: number };
    const racer = typeof id === "number" ? racerById(id) : null;
    if (!racer) return;
    playBurst(stage, "boostFlame", racer.position, normalOf(racer), 0.6 + (tier ?? 1) * 0.18);
  });

  on("kart:land", (payload) => {
    const { racer: id, impact } = (payload ?? {}) as { racer?: number; impact?: number };
    const racer = typeof id === "number" ? racerById(id) : null;
    if (!racer) return;
    const force = clamp01((impact ?? 1) / 14);
    if (force < 0.08) return;
    scratchPos.copy(racer.position);
    scratchPos.y -= TUNING.wheelRadius * 0.8;
    playBurst(stage, racer.surface === "water" ? "splash" : "landing", scratchPos, normalOf(racer), 0.6 + force * 1.5);
  });

  on("kart:hit", (payload) => {
    const { racer: id, by } = (payload ?? {}) as { racer?: number; by?: string };
    const racer = typeof id === "number" ? racerById(id) : null;
    if (!racer) return;
    if (by && EXPLOSIVE.has(by)) {
      playBurst(stage, "explosion", racer.position, normalOf(racer), 1);
    } else {
      scratchPos.copy(racer.position);
      scratchPos.y += 0.25;
      playBurst(stage, "impact", scratchPos, normalOf(racer), by === "wall" ? 1.1 : 0.8);
    }
  });

  on("kart:collide", (payload) => {
    const { a, b, impulse } = (payload ?? {}) as { a?: number; b?: number; impulse?: number };
    const ra = typeof a === "number" ? racerById(a) : null;
    const rb = typeof b === "number" ? racerById(b) : null;
    if (!ra || !rb) return;
    const force = clamp01((impulse ?? 1) / 18);
    if (force < 0.15) return;
    scratchPos.copy(ra.position).add(rb.position).multiplyScalar(0.5);
    scratchPos.y += 0.3;
    playBurst(stage, "impact", scratchPos, normalOf(ra), 0.4 + force);
  });

  on("kart:trick", (payload) => {
    const { racer: id } = (payload ?? {}) as { racer?: number };
    const racer = typeof id === "number" ? racerById(id) : null;
    if (!racer) return;
    playBurst(stage, "coin", racer.position, undefined, 0.7);
  });

  on("coin:pickup", (payload) => {
    const { racer: id } = (payload ?? {}) as { racer?: number };
    const racer = typeof id === "number" ? racerById(id) : null;
    if (!racer) return;
    scratchPos.copy(racer.position);
    scratchPos.y += 0.7;
    playBurst(stage, "coin", scratchPos, undefined, 1);
  });

  on("item:spawn", (payload) => {
    const { position } = (payload ?? {}) as { position?: THREE.Vector3 };
    if (!position) return;
    playBurst(stage, "smokePuff", position, undefined, 0.35);
  });

  on("race:respawn", (payload) => {
    const { racer: id } = (payload ?? {}) as { racer?: number };
    const racer = typeof id === "number" ? racerById(id) : null;
    if (!racer) return;
    playBurst(stage, "smokePuff", racer.position, undefined, 1.2);
    const fx = fxFor(racer);
    for (const w of fx.skid) w.end();
    fx.trail.end();
  });

  on("race:finish", (payload) => {
    const { racer: id, place } = (payload ?? {}) as { racer?: number; place?: number };
    const racer = typeof id === "number" ? racerById(id) : null;
    if (!racer) return;
    // Confetti for the podium and always for the player, whatever they managed.
    if (!racer.isPlayer && (place ?? 9) > 3) return;
    scratchPos.copy(racer.position);
    scratchPos.y += 3;
    playBurst(stage, "confetti", scratchPos, undefined, 1);
  });

  on("race:results", () => {
    scratchPos.copy(ctx.camera.position);
    ctx.camera.getWorldDirection(burstNormal);
    scratchPos.addScaledVector(burstNormal, 9);
    scratchPos.y += 5;
    burstNormal.set(0, 1, 0);
    playBurst(stage, "confetti", scratchPos, undefined, 1.4);
  });

  on("race:countdown", (payload) => {
    const { count } = (payload ?? {}) as { count?: number };
    if (count !== 0) return;
    const player = ctx.services.physics?.player;
    if (!player) return;
    playBurst(stage, "shockwave", player.position, normalOf(player), 0.8);
  });

  on("race:start", () => {
    service.clear();
  });

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  function syncFog(): void {
    const fog = ctx.scene.fog;
    let density = 0;
    if (fog && (fog as THREE.FogExp2).isFogExp2) {
      density = (fog as THREE.FogExp2).density;
      fogColor.copy(fog.color);
    } else if (fog) {
      fogColor.copy(fog.color);
    }
    additive.setFog(fogColor, density);
    alpha.setFog(fogColor, density);
    rings.setFog(fogColor, density);
    dustRings.setFog(fogColor, density);
    skid.setFog(fogColor, density);
    star.setFog(fogColor, density);
  }

  const system: System = {
    lateUpdate(dt) {
      stage.elapsed = ctx.elapsed;
      stage.budget = frameBudget;
      stage.density = caps.density * userDensity;

      // Emitters run in lateUpdate so every kart transform for the frame is
      // final: sparks pinned to last frame's wheel position lag visibly at
      // 28 m/s.
      const racers = ctx.services.physics?.racers;
      if (racers) {
        for (const racer of racers) service.setRacerEmitters(racer);
      }

      const player = ctx.services.physics?.player;
      if (player) {
        const speedFrac = Math.abs(player.speed) / TUNING.topSpeed;
        windAcc = updateWindStreaks(stage, dt, speedFrac, windAcc);
      }

      syncFog();
      // The star ribbon's texture scroll is what makes it shimmer rather than
      // sit there as a static rainbow decal.
      star.setScroll(-ctx.elapsed * 0.85);

      additive.update(ctx.elapsed);
      alpha.update(ctx.elapsed);
      rings.update(ctx.elapsed);
      dustRings.update(ctx.elapsed);
      skid.update(ctx.elapsed);
      star.update(ctx.elapsed);

      service.stats.additive = additive.emitted;
      service.stats.alpha = alpha.emitted;
      service.stats.budget = stage.budget;
    },

    resize(width, height) {
      const w = width * ctx.viewport.dpr;
      const h = height * ctx.viewport.dpr;
      additive.setResolution(w, h);
      alpha.setResolution(w, h);
    },

    dispose() {
      for (const off of offs) off();
      offs.length = 0;
      root.removeFromParent();
      additive.dispose();
      alpha.dispose();
      rings.dispose();
      dustRings.dispose();
      skid.dispose();
      star.dispose();
      atlas.dispose();
      skidTex.dispose();
      rainbowTex.dispose();
      racerFx.clear();
      if (ctx.services.vfx === service) delete ctx.services.vfx;
    },
  };

  return system;
}

export { TILE, FX_COLORS };
