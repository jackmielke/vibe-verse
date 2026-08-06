/**
 * DROP ZERO — engine core.
 *
 * Owns the renderer, the scene root, the frame loop and the system registry.
 * Nothing here knows what the island looks like — that lives in world/.
 *
 * Two things differ from the San Palmas core they descend from:
 *
 *  - **Fixed-step simulation.** A battle royale's build placement, capsule
 *    resolution and projectile stepping all misbehave at variable dt — a
 *    frame spike used to let you walk through your own wall. Systems that
 *    care implement `fixed()` and get called at a hard 120 Hz with the
 *    render interpolating between; everything cosmetic stays on `update()`.
 *  - **Frame budget telemetry.** `stats` is read by the quality governor so
 *    the world can shed foliage and shadow cascades before the frame rate
 *    drops rather than after.
 */
import * as THREE from "three";
import type { InputState, QualityTier, System, SystemFactory, WorldCtx } from "../types";
import { makeRng } from "../types";

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  quality?: QualityTier;
  seed?: number;
}

/** Auto-detects a sane starting tier from the GPU + screen. */
export function detectQuality(): QualityTier {
  if (typeof navigator === "undefined") return "high";
  const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mobile || mem <= 2 || cores <= 2) return "low";
  if (mem <= 4 || cores <= 4) return "medium";
  if (mem >= 8 && cores >= 8) return "high";
  return "medium";
}

/** Pixel-ratio ceiling per tier — the single biggest perf lever we have. */
const PIXEL_RATIO_CAP: Record<QualityTier, number> = {
  low: 1,
  medium: 1.25,
  high: 1.5,
  ultra: 2,
};

const SHADOW_MAP_SIZE: Record<QualityTier, number> = {
  low: 1024,
  medium: 2048,
  high: 2048,
  ultra: 4096,
};

/** Simulation step. 120 Hz — fast enough that building never desyncs. */
const FIXED_DT = 1 / 120;
/** Never run more than this many sim steps in one frame. */
const MAX_STEPS = 6;

/** A system that wants deterministic stepping implements this. */
export interface FixedSystem extends System {
  fixed?(dt: number, ctx: WorldCtx): void;
}

export interface EngineStats {
  /** Smoothed frame time in ms. */
  frameMs: number;
  fps: number;
  drawCalls: number;
  triangles: number;
  programs: number;
}

export class Engine {
  readonly ctx: WorldCtx;
  readonly stats: EngineStats = { frameMs: 16, fps: 60, drawCalls: 0, triangles: 0, programs: 0 };

  private systems: FixedSystem[] = [];
  private clock = new THREE.Clock();
  private raf = 0;
  private running = false;
  private listeners = new Map<string, Set<(p: unknown) => void>>();
  private disposed = false;
  private accumulator = 0;

  /** Swapped in by the postfx system; falls back to a plain forward render. */
  renderOverride: ((dt: number) => void) | null = null;

  constructor(opts: EngineOptions) {
    const quality = opts.quality ?? detectQuality();

    const renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      // Post-processing owns AA above `low` (SMAA in the composer); only the
      // forward path asks the driver for MSAA.
      antialias: quality === "low",
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
      alpha: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP[quality]));
    renderer.setSize(window.innerWidth, window.innerHeight, false);

    // Physically-based setup. ACES + sRGB is the baseline every material in
    // this world is authored against — don't change it without re-grading.
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = quality === "low" ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.info.autoReset = false;

    const scene = new THREE.Scene();
    // 80° vertical-equivalent: Fortnite runs wide, and the build loop needs
    // peripheral vision to place a wall you are already looking away from.
    const camera = new THREE.PerspectiveCamera(
      80,
      window.innerWidth / window.innerHeight,
      0.1,
      8000,
    );
    camera.position.set(0, 60, 0);
    camera.rotation.order = "YXZ";

    this.ctx = {
      scene,
      camera,
      renderer,
      services: {},
      input: makeInputState(),
      elapsed: 0,
      quality,
      rng: makeRng(opts.seed ?? 0xd309ce0),
      shadowMapSize: SHADOW_MAP_SIZE[quality],
      emit: (event, payload) => this.emit(event, payload),
      on: (event, fn) => this.on(event, fn),
    };
  }

  /** Boot a system. Order matters — see boot.ts. */
  async add(factory: SystemFactory): Promise<System> {
    const sys = (await factory(this.ctx)) as FixedSystem;
    if (this.disposed) {
      sys.dispose?.();
      return sys;
    }
    this.systems.push(sys);
    return sys;
  }

  emit(event: string, payload?: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy: a listener that unsubscribes itself mid-dispatch is normal here
    // (one-shot HUD toasts do it) and must not corrupt the iteration.
    for (const fn of [...set]) fn(payload);
  }

  on(event: string, fn: (payload: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.clock.start();
    const tick = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      this.frame();
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private frame(): void {
    // Clamp dt so an alt-tab or a GC pause can't tunnel the player through
    // the world when the tab wakes back up.
    const dt = Math.min(this.clock.getDelta(), 1 / 15);
    this.ctx.elapsed += dt;

    // Fixed-step pass first: movement, building, projectiles. Leftover time
    // stays in the accumulator so the step rate is exactly FIXED_DT.
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
      for (const s of this.systems) s.fixed?.(FIXED_DT, this.ctx);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    // A tab that was backgrounded for a minute must not spend the next
    // several frames catching up — drop the debt.
    if (steps === MAX_STEPS) this.accumulator = 0;

    for (const s of this.systems) s.update?.(dt, this.ctx);
    for (const s of this.systems) s.lateUpdate?.(dt, this.ctx);

    const info = this.ctx.renderer.info;
    info.reset();
    if (this.renderOverride) this.renderOverride(dt);
    else this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);

    const ms = dt * 1000;
    this.stats.frameMs += (ms - this.stats.frameMs) * 0.08;
    this.stats.fps = 1000 / Math.max(this.stats.frameMs, 0.001);
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.programs = info.programs?.length ?? 0;

    // Edge-triggered input is consumed once per frame.
    const input = this.ctx.input;
    input.pressed.clear();
    input.lookX = 0;
    input.lookY = 0;
    input.slot = null;
    input.wheel = 0;
    input.rotate = false;
    input.drop = false;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.ctx.camera.aspect = w / h;
    this.ctx.camera.updateProjectionMatrix();
    this.ctx.renderer.setSize(w, h, false);
    for (const s of this.systems) s.resize?.(w, h);
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    for (const s of this.systems) {
      try {
        s.dispose?.();
      } catch (err) {
        // One system's bad teardown must not strand the renderer — browsers
        // cap live WebGL contexts and a leaked one breaks the next world.
        console.error("[Drop Zero] dispose failed for system", s.name, err);
      }
    }
    this.systems = [];
    this.listeners.clear();
    disposeSceneGraph(this.ctx.scene);
    this.ctx.renderer.dispose();
    this.ctx.renderer.forceContextLoss?.();
  }
}

export function makeInputState(): InputState {
  return {
    moveX: 0,
    moveZ: 0,
    lookX: 0,
    lookY: 0,
    jump: false,
    sprint: false,
    crouch: false,
    fire: false,
    aim: false,
    reload: false,
    interact: false,
    buildKind: null,
    rotate: false,
    drop: false,
    pressed: new Set<string>(),
    slot: null,
    wheel: 0,
    locked: false,
  };
}

/** Deep-dispose every geometry/material/texture under a root. */
export function disposeSceneGraph(root: THREE.Object3D): void {
  const seen = new Set<unknown>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    const mats = Array.isArray(mat) ? mat : [mat];
    for (const m of mats) {
      if (seen.has(m)) continue;
      seen.add(m);
      for (const key of Object.keys(m)) {
        const val = (m as unknown as Record<string, unknown>)[key];
        if (val && typeof val === "object" && (val as THREE.Texture).isTexture) {
          (val as THREE.Texture).dispose();
        }
      }
      m.dispose();
    }
  });
}
