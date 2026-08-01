/**
 * Vibe Kart — engine core.
 *
 * Owns the renderer, the scene graph root, the clock, the fixed-step
 * accumulator and the event bus. Everything else is a `System` bolted on by
 * `boot.ts`. The core deliberately knows nothing about karts.
 */
import * as THREE from "three";
import {
  FIXED_DT,
  makeKartInput,
  makeRng,
  type KartCtx,
  type KartQuality,
  type System,
  type SystemFactory,
} from "../types";

export interface KartEngineOptions {
  canvas: HTMLCanvasElement;
  quality?: KartQuality;
  seed?: number;
}

export function detectKartQuality(): KartQuality {
  if (typeof navigator === "undefined") return "high";
  const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mem <= 2 || cores <= 2) return "low";
  if (mobile || mem <= 4) return "medium";
  if (cores >= 8 && mem >= 8) return "ultra";
  return "high";
}

/** Software-rendered screenshot runs need the heavy path at a low resolution. */
export function isShotMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("shot");
}

export class KartEngine {
  readonly ctx: KartCtx;
  private systems: System[] = [];
  private clock = new THREE.Clock();
  private raf = 0;
  private running = false;
  private disposed = false;
  private accumulator = 0;
  private listeners = new Map<string, Set<(p: never) => void>>();

  /** Set by the post-processing system to take over the final draw. */
  renderOverride: ((dt: number) => void) | null = null;

  /** Frame-time telemetry, surfaced by the debug HUD and the shot harness. */
  readonly stats = { fps: 0, frameMs: 0, frames: 0 };

  constructor(opts: KartEngineOptions) {
    const quality = opts.quality ?? detectKartQuality();
    const shot = isShotMode();

    const renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: quality === "low",
      powerPreference: "high-performance",
      alpha: false,
      stencil: false,
      depth: true,
      // The post stack reads the frame back; keeping the drawing buffer avoids
      // a black screenshot on the software rasteriser.
      preserveDrawingBuffer: shot,
    });
    const dpr = Math.min(window.devicePixelRatio || 1, quality === "low" ? 1 : quality === "ultra" ? 2 : 1.5);
    renderer.setPixelRatio(shot ? 1 : dpr);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = quality !== "low";
    renderer.shadowMap.type = quality === "ultra" ? THREE.VSMShadowMap : THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.info.autoReset = true;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      68,
      window.innerWidth / Math.max(1, window.innerHeight),
      0.15,
      4000,
    );
    camera.position.set(0, 4, 10);
    camera.lookAt(0, 1, 0);
    scene.add(camera);

    this.ctx = {
      scene,
      camera,
      renderer,
      services: {},
      input: makeKartInput(),
      elapsed: 0,
      dt: 0,
      quality,
      rng: makeRng(opts.seed ?? 0x4b41_5254),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        aspect: window.innerWidth / Math.max(1, window.innerHeight),
        dpr: renderer.getPixelRatio(),
      },
      emit: (e, p) => this.emit(e, p),
      on: (e, f) => this.on(e, f),
    };
  }

  async add(factory: SystemFactory): Promise<System> {
    const sys = await factory(this.ctx);
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
    for (const fn of set) (fn as (p: unknown) => void)(payload);
  }

  on(event: string, fn: (payload: never) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
    };
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

  /** Advance exactly one frame with a supplied dt — used by the shot harness. */
  step(dt: number): void {
    this.frame(dt);
  }

  private frame(forcedDt?: number): void {
    const t0 = performance.now();
    const raw = forcedDt ?? this.clock.getDelta();
    // A long stall (tab switch, shader compile) must never teleport the field.
    const dt = Math.min(raw, 1 / 15);
    this.ctx.dt = dt;
    this.ctx.elapsed += dt;

    // Fixed-step physics, capped so a slow frame cannot spiral.
    this.accumulator = Math.min(this.accumulator + dt, FIXED_DT * 8);
    while (this.accumulator >= FIXED_DT) {
      for (const s of this.systems) s.fixedUpdate?.(FIXED_DT, this.ctx);
      this.accumulator -= FIXED_DT;
    }

    for (const s of this.systems) s.update?.(dt, this.ctx);
    for (const s of this.systems) s.lateUpdate?.(dt, this.ctx);

    if (this.renderOverride) this.renderOverride(dt);
    else this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);

    // Edge-triggered input is consumed once per frame.
    const input = this.ctx.input;
    input.driftPressed = false;
    input.itemPressed = false;
    input.pausePressed = false;
    input.trick = 0;

    const ms = performance.now() - t0;
    this.stats.frameMs += (ms - this.stats.frameMs) * 0.1;
    this.stats.fps += (1 / Math.max(dt, 1e-4) - this.stats.fps) * 0.1;
    this.stats.frames++;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const aspect = w / Math.max(1, h);
    this.ctx.renderer.setSize(w, h, false);
    this.ctx.camera.aspect = aspect;
    this.ctx.camera.updateProjectionMatrix();
    this.ctx.viewport.width = w;
    this.ctx.viewport.height = h;
    this.ctx.viewport.aspect = aspect;
    for (const s of this.systems) s.resize?.(w, h);
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    for (const s of this.systems) {
      try {
        s.dispose?.();
      } catch (err) {
        console.error("[Vibe Kart] system dispose failed", err);
      }
    }
    this.systems = [];
    this.listeners.clear();
    disposeGraph(this.ctx.scene);
    this.ctx.renderer.dispose();
  }
}

/** Free every GPU resource hanging off a subtree. */
export function disposeGraph(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      for (const key of Object.keys(m)) {
        const value = (m as unknown as Record<string, unknown>)[key];
        if (value && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose();
      }
      m.dispose();
    }
  });
}
