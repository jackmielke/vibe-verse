/**
 * The Midnight Zone — engine core.
 *
 * Owns the renderer, the scene, the clock and the event bus, and knows nothing
 * about the ocean. Everything else is a `System` bolted on by `boot.ts`.
 *
 * Two things here are specific to a game made of darkness:
 *
 * **The clear colour is the fog colour, and it moves.** In a world where you
 * can never see the far plane, the background *is* the water — so the ocean
 * system rewrites `scene.fog.color` and the clear colour together every frame
 * as you descend. A fixed clear colour would put a hard horizon at the draw
 * distance, which is the one thing that would break the illusion of depth.
 *
 * **Tone mapping is ACES with a low exposure.** Bioluminescence only reads as
 * *light* if most of the frame is genuinely near black, and the naive thing —
 * a bright ambient so you can "see the models" — is exactly what kills it.
 */
import * as THREE from "three";
import {
  makeDeepInput,
  makeRng,
  type DeepCtx,
  type DeepQuality,
  type System,
  type SystemFactory,
} from "../types";

export interface DeepEngineOptions {
  canvas: HTMLCanvasElement;
  quality?: DeepQuality;
  seed?: number;
}

export function detectDeepQuality(): DeepQuality {
  if (typeof navigator === "undefined") return "high";
  const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mem <= 2 || cores <= 2) return "low";
  if (mobile || mem <= 4) return "medium";
  if (cores >= 8 && mem >= 8) return "ultra";
  return "high";
}

/** The screenshot harness drives the engine by hand with rAF stopped. */
export function isShotMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("shot");
}

/** How far the camera can ever see. Fog always closes in well before this. */
export const FAR_PLANE = 900;

export class DeepEngine {
  readonly ctx: DeepCtx;
  private systems: System[] = [];
  private clock = new THREE.Clock();
  private raf = 0;
  private running = false;
  private disposed = false;
  private listeners = new Map<string, Set<(p: never) => void>>();

  /** Set by the post-processing system to take over the final draw. */
  renderOverride: ((dt: number) => void) | null = null;

  /** Raised when the GPU takes the context away mid-dive. The page shows it. */
  contextLost = false;
  private canvas: HTMLCanvasElement | null = null;

  private onContextLost = (e: Event) => {
    // Preventing the default is what makes a restore even possible.
    e.preventDefault();
    this.contextLost = true;
    this.stop();
    this.emit("engine:contextlost");
  };

  private onContextRestored = () => {
    this.contextLost = false;
    this.emit("engine:contextrestored");
  };

  readonly stats = { fps: 0, frameMs: 0, frames: 0 };

  constructor(opts: DeepEngineOptions) {
    const quality = opts.quality ?? detectDeepQuality();
    const shot = isShotMode();

    /**
     * Ask for the context *first*, and say something useful when it is refused.
     *
     * Browsers cap the number of live WebGL contexts per page — Chrome allows
     * about sixteen — and every 3D world in the vibeverse takes one. Walk
     * through enough of them and `getContext` starts returning null, at which
     * point `new WebGLRenderer` dies deep inside `getMaxPrecision` with
     * "Cannot read properties of null (reading 'precision')". That is a real
     * failure a real visitor hits, and it is indistinguishable from a black
     * screen unless somebody names it — so this names it, and `TheDeep.tsx`
     * offers a reload rather than a corpse.
     */
    const probe =
      opts.canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false }) ??
      opts.canvas.getContext("webgl");
    if (!probe) {
      throw new Error(
        "This browser would not give the page another 3D context — usually because too many " +
          "worlds are open at once. Reloading the tab clears them.",
      );
    }

    const renderer = new THREE.WebGLRenderer({
      context: probe as WebGLRenderingContext,
      canvas: opts.canvas,
      antialias: quality === "low",
      powerPreference: "high-performance",
      alpha: false,
      stencil: false,
      depth: true,
      // The post stack reads the frame back; keeping the drawing buffer is
      // what stops the software rasteriser handing back a black screenshot.
      preserveDrawingBuffer: shot,
    });
    const dpr = Math.min(window.devicePixelRatio || 1, quality === "low" ? 1 : quality === "ultra" ? 2 : 1.5);
    renderer.setPixelRatio(shot ? 1 : dpr);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Deliberately dim. See the note at the top of the file.
    renderer.toneMappingExposure = 0.92;
    renderer.shadowMap.enabled = false; // Nothing down here casts a shadow worth the cost.

    const scene = new THREE.Scene();
    // Replaced every frame by the ocean system; this is only what the first
    // frame clears to, and it matters because the first frame is a first
    // impression.
    scene.fog = new THREE.FogExp2(0x2fb6c8, 0.0075);
    scene.background = new THREE.Color(0x2fb6c8);

    const camera = new THREE.PerspectiveCamera(
      62,
      window.innerWidth / Math.max(1, window.innerHeight),
      0.12,
      FAR_PLANE,
    );
    camera.position.set(0, -6, 14);
    camera.lookAt(0, -8, 0);
    scene.add(camera);

    // A context can also be taken away *after* boot — a GPU reset, a laptop
    // switching graphics cards, a background tab reclaimed under memory
    // pressure. Without a listener the world simply stops painting and the
    // player is looking at the last frame, or at nothing.
    opts.canvas.addEventListener("webglcontextlost", this.onContextLost);
    opts.canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.canvas = opts.canvas;

    this.ctx = {
      scene,
      camera,
      renderer,
      services: {},
      input: makeDeepInput(),
      elapsed: 0,
      dt: 0,
      quality,
      rng: makeRng(opts.seed ?? 0x0dee9517),
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
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.step();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** One frame. `forcedDt` is for the screenshot harness, which steps by hand. */
  step(forcedDt?: number): void {
    if (this.disposed) return;
    const t0 = performance.now();
    const raw = forcedDt ?? this.clock.getDelta();
    // A tab that was in the background hands back a delta of several seconds;
    // integrating that would fire the sub through the seafloor.
    const dt = Math.min(raw, 1 / 15);
    this.ctx.dt = dt;
    this.ctx.elapsed += dt;

    for (const s of this.systems) {
      try {
        s.update?.(dt, this.ctx);
      } catch (err) {
        console.error("[The Deep] a system threw in update:", err);
      }
    }
    for (const s of this.systems) {
      try {
        s.lateUpdate?.(dt, this.ctx);
      } catch (err) {
        console.error("[The Deep] a system threw in lateUpdate:", err);
      }
    }

    if (this.renderOverride) this.renderOverride(dt);
    else this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);

    // Edge-triggered input is cleared *after* the frame, so a system reading it
    // in `lateUpdate` still sees the press that `update` saw.
    this.ctx.input.scanPressed = false;
    this.ctx.input.lightsPressed = false;
    this.ctx.input.pausePressed = false;

    const ms = performance.now() - t0;
    this.stats.frameMs = ms;
    this.stats.frames++;
    this.stats.fps = dt > 0 ? 1 / dt : 0;
  }

  resize(): void {
    if (this.disposed) return;
    const w = window.innerWidth;
    const h = Math.max(1, window.innerHeight);
    this.ctx.renderer.setSize(w, h, false);
    this.ctx.camera.aspect = w / h;
    this.ctx.camera.updateProjectionMatrix();
    this.ctx.viewport.width = w;
    this.ctx.viewport.height = h;
    this.ctx.viewport.aspect = w / h;
    this.ctx.viewport.dpr = this.ctx.renderer.getPixelRatio();
    for (const s of this.systems) s.resize?.(w, h);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    for (const s of this.systems) {
      try {
        s.dispose?.();
      } catch (err) {
        console.error("[The Deep] a system threw while disposing:", err);
      }
    }
    this.systems = [];
    this.listeners.clear();
    this.canvas?.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas?.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.canvas = null;
    disposeTree(this.ctx.scene);
    this.ctx.renderer.dispose();
    // Browsers cap live WebGL contexts, and a leaked one breaks the *next*
    // world a visitor opens — which is a miserable thing to debug from there.
    this.ctx.renderer.forceContextLoss?.();
  }
}

/** Depth-first geometry/material/texture disposal. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      for (const value of Object.values(m as unknown as Record<string, unknown>)) {
        if (value && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose();
      }
      m.dispose();
    }
  });
}
