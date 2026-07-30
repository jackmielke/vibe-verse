/**
 * Vibe Golf — engine core.
 *
 * Orthographic camera looking down -Z, world units in metres, +Y up. Depth is
 * used purely for parallax layering (background scenery sits at negative Z,
 * foreground framing at positive Z), which is what gives the flat 2D play
 * field its 2.5D presentation.
 */
import * as THREE from "three";
import type { GolfCtx, GolfInput, GolfQuality, System, SystemFactory } from "../types";
import { makeRng } from "../types";

/** Z positions for the parallax stack. Systems should use these, not raw Z. */
export const LAYER = {
  sky: -400,
  farScenery: -220,
  midScenery: -120,
  backdrop: -40,
  courseBack: -6,
  course: 0,
  props: 2,
  ball: 4,
  character: 5,
  fx: 8,
  foreground: 40,
} as const;

/** Vertical extent of the view in metres at zoom 1. */
export const BASE_VIEW_HEIGHT = 34;

export interface GolfEngineOptions {
  canvas: HTMLCanvasElement;
  quality?: GolfQuality;
  seed?: number;
}

export function detectGolfQuality(): GolfQuality {
  if (typeof navigator === "undefined") return "high";
  const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mem <= 2 || cores <= 2) return "low";
  if (mobile || mem <= 4) return "medium";
  return "high";
}

export class GolfEngine {
  readonly ctx: GolfCtx;
  private systems: System[] = [];
  private clock = new THREE.Clock();
  private raf = 0;
  private running = false;
  private listeners = new Map<string, Set<(p: unknown) => void>>();
  private disposed = false;

  /** Camera framing, driven by the camera system. */
  zoom = 1;
  readonly target = new THREE.Vector2(0, 0);

  /** Set by the post/render system to take over the final draw. */
  renderOverride: ((dt: number) => void) | null = null;

  constructor(opts: GolfEngineOptions) {
    const quality = opts.quality ?? detectGolfQuality();

    const renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: quality !== "low",
      powerPreference: "high-performance",
      alpha: false,
      stencil: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === "low" ? 1 : 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = quality !== "low";
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const halfH = BASE_VIEW_HEIGHT / 2;
    const camera = new THREE.OrthographicCamera(
      -halfH * aspect, halfH * aspect, halfH, -halfH, 0.1, 2000,
    );
    camera.position.set(0, 0, 500);
    camera.lookAt(0, 0, 0);

    this.ctx = {
      scene,
      camera,
      renderer,
      services: {},
      input: makeGolfInput(),
      elapsed: 0,
      quality,
      rng: makeRng(opts.seed ?? 0x9017f),
      emit: (e, p) => this.emit(e, p),
      on: (e, f) => this.on(e, f),
    };
  }

  /** Re-derive the ortho frustum from the current zoom + viewport. */
  applyCamera(): void {
    const cam = this.ctx.camera;
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const halfH = (BASE_VIEW_HEIGHT / 2) / this.zoom;
    cam.left = -halfH * aspect;
    cam.right = halfH * aspect;
    cam.top = halfH;
    cam.bottom = -halfH;
    cam.position.x = this.target.x;
    cam.position.y = this.target.y;
    cam.updateProjectionMatrix();
  }

  /** Convert a client-space pointer position into world metres. */
  screenToWorld(clientX: number, clientY: number, out = new THREE.Vector2()): THREE.Vector2 {
    const cam = this.ctx.camera;
    const nx = (clientX / window.innerWidth) * 2 - 1;
    const ny = -((clientY / window.innerHeight) * 2 - 1);
    out.x = cam.position.x + nx * (cam.right - cam.left) * 0.5;
    out.y = cam.position.y + ny * (cam.top - cam.bottom) * 0.5;
    return out;
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
    for (const fn of set) fn(payload);
  }

  on(event: string, fn: (payload: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
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
    const dt = Math.min(this.clock.getDelta(), 1 / 20);
    this.ctx.elapsed += dt;

    for (const s of this.systems) s.update?.(dt, this.ctx);
    for (const s of this.systems) s.lateUpdate?.(dt, this.ctx);

    this.applyCamera();

    if (this.renderOverride) this.renderOverride(dt);
    else this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);

    const input = this.ctx.input;
    input.pressed.clear();
    input.zoomDelta = 0;
    input.released = false;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.ctx.renderer.setSize(w, h, false);
    this.applyCamera();
    for (const s of this.systems) s.resize?.(w, h);
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    for (const s of this.systems) s.dispose?.();
    this.systems = [];
    this.listeners.clear();
    disposeGraph(this.ctx.scene);
    this.ctx.renderer.dispose();
  }
}

export function makeGolfInput(): GolfInput {
  return {
    pointer: null,
    dragging: false,
    dragStart: null,
    pressed: new Set<string>(),
    held: new Set<string>(),
    zoomDelta: 0,
    released: false,
  };
}

export function disposeGraph(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      for (const k of Object.keys(m)) {
        const val = (m as unknown as Record<string, unknown>)[k];
        if (val && typeof val === "object" && (val as THREE.Texture).isTexture) {
          (val as THREE.Texture).dispose();
        }
      }
      m.dispose();
    }
  });
}
