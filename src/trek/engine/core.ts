/**
 * Engine core — renderer, the two scenes, the clock, the event bus.
 *
 * The only interesting thing in here is the draw, and it is the reason the
 * world exists: every frame renders `space` from `viewCam` into an offscreen
 * target, hands that target to the viewscreen material, and *then* renders the
 * room. Two draws of two scenes, and the expensive one is the small one — the
 * offscreen target is 1280×544 no matter how big the window is, because it is
 * being shown on a rectangle four metres wide.
 *
 * Switch to an external camera and the first draw simply goes straight to the
 * canvas and the room is skipped. Same scene, same simulation; you have just
 * left the room.
 *
 * On depth — and on why this world does not use a logarithmic buffer despite
 * drawing a 289 m ship and a planet in the same frame — see `NEAR_PLANE` in
 * `types.ts`.
 */
import * as THREE from "three";
import {
  FAR_PLANE,
  FIXED_DT,
  NEAR_PLANE,
  makeInput,
  makeRng,
  type Quality,
  type System,
  type SystemFactory,
  type TrekCtx,
} from "../types";

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  quality?: Quality;
  seed?: number;
}

export function detectQuality(): Quality {
  if (typeof window !== "undefined") {
    try {
      const q = new URLSearchParams(window.location.search).get("q");
      if (q === "low" || q === "medium" || q === "high" || q === "ultra") return q;
    } catch {
      /* no search params */
    }
  }
  if (isShotMode()) return "low";
  if (typeof navigator === "undefined") return "high";
  const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mem <= 2 || cores <= 2) return "low";
  if (mobile || mem <= 4) return "medium";
  if (cores >= 8 && mem >= 8) return "ultra";
  return "high";
}

export function isShotMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).has("shot");
  } catch {
    return false;
  }
}

export class Engine {
  readonly ctx: TrekCtx;
  private systems: System[] = [];
  private clock = new THREE.Clock();
  private raf = 0;
  private running = false;
  private disposed = false;
  private accumulator = 0;
  private listeners = new Map<string, Set<(p: never) => void>>();

  readonly stats = { fps: 0, frameMs: 0, frames: 0 };

  constructor(opts: EngineOptions) {
    const quality = opts.quality ?? detectQuality();
    const shot = isShotMode();

    const renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: quality !== "low",
      powerPreference: "high-performance",
      alpha: false,
      stencil: false,
      depth: true,
      preserveDrawingBuffer: shot,
    });

    const dpr = Math.min(
      window.devicePixelRatio || 1,
      quality === "low" ? 1 : quality === "ultra" ? 2 : 1.5,
    );
    renderer.setPixelRatio(shot ? 1 : dpr);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // ACES on a scene lit by one white star and a lot of small emissive lamps
    // is the difference between "space" and "a grey model on black paper".
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = false;

    const space = new THREE.Scene();
    const bridge = new THREE.Scene();

    const width = window.innerWidth;
    const height = Math.max(1, window.innerHeight);
    const portrait = height > width;

    // The viewscreen is a fixed 2.35:1 rectangle on a wall, so its camera's
    // aspect is a property of the *set*, not of the window. It is corrected in
    // `resize` only when this camera is drawing the whole canvas instead.
    const viewCam = new THREE.PerspectiveCamera(52, 2.35, NEAR_PLANE, FAR_PLANE);
    viewCam.position.set(0, 0, 900);
    space.add(viewCam);

    // 56° rather than the usual 70: a wide lens in an eleven-metre room puts a
    // third of the frame on the ceiling and shrinks the viewscreen to a
    // postage stamp. Narrower reads as "sitting forward and paying attention",
    // which is the posture the whole world is about.
    const eyeCam = new THREE.PerspectiveCamera(
      portrait ? 64 : 56,
      width / height,
      0.05,
      120,
    );
    eyeCam.rotation.order = "YXZ";
    bridge.add(eyeCam);

    this.ctx = {
      renderer,
      space,
      bridge,
      viewCam,
      eyeCam,
      services: {},
      input: makeInput(),
      elapsed: 0,
      dt: 0,
      quality,
      rng: makeRng(opts.seed ?? 0x1701),
      viewport: {
        width,
        height,
        aspect: width / height,
        dpr: renderer.getPixelRatio(),
        portrait,
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

  /** Advance one frame with a supplied dt. The screenshot harness drives this. */
  step(dt: number, render = true): void {
    this.frame(dt, render);
  }

  private frame(forcedDt?: number, render = true): void {
    const t0 = performance.now();
    const raw = forcedDt ?? this.clock.getDelta();
    // A tab switch must never teleport a torpedo through a hull.
    const dt = Math.min(raw, 1 / 12);
    this.ctx.dt = dt;
    this.ctx.elapsed += dt;

    this.accumulator = Math.min(this.accumulator + dt, FIXED_DT * 8);
    while (this.accumulator >= FIXED_DT) {
      for (const s of this.systems) s.fixedUpdate?.(FIXED_DT, this.ctx);
      this.accumulator -= FIXED_DT;
    }

    for (const s of this.systems) s.update?.(dt, this.ctx);
    for (const s of this.systems) s.lateUpdate?.(dt, this.ctx);

    if (render) this.draw();

    const input = this.ctx.input;
    input.fireTorpedo = false;
    input.nextTarget = false;
    input.toggleAlert = false;
    input.evasive = false;
    input.cycleCamera = false;
    input.cycleMagnification = false;
    input.hail = false;
    input.scan = false;
    input.allStop = false;
    input.warp = false;
    input.advance = false;
    input.powerTo = -1;

    const ms = performance.now() - t0;
    this.stats.frameMs += (ms - this.stats.frameMs) * 0.1;
    this.stats.fps += (1 / Math.max(dt, 1e-4) - this.stats.fps) * 0.1;
    this.stats.frames++;
  }

  private draw(): void {
    const { renderer, space, bridge, viewCam, eyeCam, services } = this.ctx;
    const onBridge = (services.camera?.mode ?? "viewscreen") === "viewscreen";
    const screen = services.viewscreen;

    if (onBridge && screen) {
      renderer.setRenderTarget(screen.target);
      renderer.clear();
      renderer.render(space, viewCam);
      renderer.setRenderTarget(null);
      renderer.render(bridge, eyeCam);
    } else {
      renderer.setRenderTarget(null);
      renderer.render(space, viewCam);
    }
  }

  resize(): void {
    const w = window.innerWidth;
    const h = Math.max(1, window.innerHeight);
    const aspect = w / h;
    const portrait = h > w;
    this.ctx.renderer.setSize(w, h, false);
    this.ctx.eyeCam.aspect = aspect;
    this.ctx.eyeCam.fov = portrait ? 64 : 56;
    this.ctx.eyeCam.updateProjectionMatrix();
    this.ctx.viewport.width = w;
    this.ctx.viewport.height = h;
    this.ctx.viewport.aspect = aspect;
    this.ctx.viewport.portrait = portrait;
    for (const s of this.systems) s.resize?.(w, h, portrait);
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    for (const s of this.systems) {
      try {
        s.dispose?.();
      } catch (err) {
        console.error("[Final Frontier] system dispose failed", err);
      }
    }
    this.systems = [];
    this.listeners.clear();
    disposeGraph(this.ctx.space);
    disposeGraph(this.ctx.bridge);
    this.ctx.services.viewscreen?.target.dispose();
    this.ctx.renderer.dispose();
  }
}

/**
 * Free every GPU resource hanging off a subtree.
 *
 * Browsers cap live WebGL contexts at around sixteen, and this world holds two
 * scenes and a render target open. A visit that leaks breaks the *next* world
 * a visitor opens, which is a miserable thing to debug from a report that says
 * "the city is black now".
 */
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
