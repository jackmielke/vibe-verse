/**
 * San Palmas — engine core.
 *
 * Owns the renderer, the scene graph root, the frame loop and the system
 * registry. Systems are booted in dependency order (terrain before anything
 * that needs to sit on the ground, sky before anything that reads the sun)
 * and each one publishes its service into `ctx.services` as it comes up.
 *
 * Nothing here knows what San Palmas looks like — that all lives in the
 * world/ and play/ modules.
 */
import * as THREE from "three";
import { releaseRenderer } from "@/lib/quality";
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

export class Engine {
  readonly ctx: WorldCtx;
  private systems: System[] = [];
  private clock = new THREE.Clock();
  private raf = 0;
  private running = false;
  private listeners = new Map<string, Set<(p: unknown) => void>>();
  private disposed = false;

  /** Swapped in by the postfx system; falls back to a plain forward render. */
  renderOverride: ((dt: number) => void) | null = null;

  constructor(opts: EngineOptions) {
    const quality = opts.quality ?? detectQuality();

    const renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: quality === "low",
      powerPreference: "high-performance",
      stencil: false,
      // Post-processing owns the depth buffer; keep the default framebuffer lean.
      depth: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP[quality]));
    renderer.setSize(window.innerWidth, window.innerHeight, false);

    // Physically-based setup. ACES + sRGB output is the baseline every
    // material in this world is authored against — don't change it without
    // re-grading the whole palette.
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = quality === "low" ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.info.autoReset = true;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      68,
      window.innerWidth / window.innerHeight,
      0.08,
      12000,
    );
    camera.position.set(0, 40, 0);
    camera.rotation.order = "YXZ";

    this.ctx = {
      scene,
      camera,
      renderer,
      services: {},
      input: makeInputState(),
      elapsed: 0,
      quality,
      rng: makeRng(opts.seed ?? 0x5a17ba1),
      emit: (event, payload) => this.emit(event, payload),
      on: (event, fn) => this.on(event, fn),
    };
  }

  get shadowMapSize(): number {
    return SHADOW_MAP_SIZE[this.ctx.quality];
  }

  /** Boot a system. Order matters — see `bootAll` in world.ts. */
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
    for (const fn of set) fn(payload);
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
    const dt = Math.min(this.clock.getDelta(), 1 / 20);
    this.ctx.elapsed += dt;

    for (const s of this.systems) s.update?.(dt, this.ctx);
    for (const s of this.systems) s.lateUpdate?.(dt, this.ctx);

    if (this.renderOverride) this.renderOverride(dt);
    else this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);

    // Edge-triggered input is consumed once per frame.
    this.ctx.input.pressed.clear();
    this.ctx.input.lookX = 0;
    this.ctx.input.lookY = 0;
    this.ctx.input.weaponSlot = null;
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
    for (const s of this.systems) s.dispose?.();
    this.systems = [];
    this.listeners.clear();
    disposeSceneGraph(this.ctx.scene);
    /* releaseRenderer, not dispose: three r160's dispose() drops its own caches and
       leaves the GL context to the garbage collector. See docs/performance.md. */
    releaseRenderer(this.ctx.renderer);
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
    grapple: false,
    wingsuit: false,
    pressed: new Set<string>(),
    weaponSlot: null,
  };
}

/** Deep-dispose every geometry/material/texture under a root. */
export function disposeSceneGraph(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    const mats = Array.isArray(mat) ? mat : [mat];
    for (const m of mats) {
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
