/**
 * Engine core — renderer, scene, clock, fixed-step accumulator, event bus.
 *
 * Deliberately knows nothing about aeroplanes. Everything that does is a
 * `System` bolted on by `boot.ts`.
 *
 * The one thing worth reading twice is the camera's depth range. This world
 * has to draw a wingtip two metres from the lens and Mount Rainier ninety
 * kilometres past it, in the same frame, which is a 1:100000 depth ratio and
 * the classic way to get a mountain that z-fights with the sky. The fix here
 * is a near plane at 1.2 m rather than the usual 0.1 — nothing in this world is
 * ever closer than that, because the cockpit "interior" is drawn as a HUD
 * overlay rather than as geometry — which buys back three orders of magnitude
 * of precision and lets a plain 24-bit depth buffer cover the whole state of
 * Washington.
 */
import * as THREE from "three";
import {
  FIXED_DT,
  makeInput,
  makeRng,
  type AngelsCtx,
  type Quality,
  type System,
  type SystemFactory,
} from "../types";

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  quality?: Quality;
  seed?: number;
}

export function detectQuality(): Quality {
  // `?q=` overrides everything — the screenshot harness uses it to review the
  // world at the tier a real GPU would give it.
  if (typeof window !== "undefined") {
    try {
      const q = new URLSearchParams(window.location.search).get("q");
      if (q === "low" || q === "medium" || q === "high" || q === "ultra") return q;
    } catch {
      /* no search params to read */
    }
  }
  // The screenshot harness rasterises on the CPU. At "ultra" that is a
  // sixteen-thousand-building city drawn by SwiftShader, which takes minutes
  // per frame — so by default the harness gets the cheap world.
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

/** The screenshot harness renders on a software rasteriser at low resolution. */
export function isShotMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).has("shot");
  } catch {
    return false;
  }
}

/** How far you can see. Rainier is 90 km out and has to be in it. */
export const FAR_PLANE = 240000;
export const NEAR_PLANE = 1.2;

export class Engine {
  readonly ctx: AngelsCtx;
  private systems: System[] = [];
  private clock = new THREE.Clock();
  private raf = 0;
  private running = false;
  private disposed = false;
  private accumulator = 0;
  private listeners = new Map<string, Set<(p: never) => void>>();

  /** Set by the post-processing system to take over the final draw. */
  renderOverride: ((dt: number) => void) | null = null;

  readonly stats = { fps: 0, frameMs: 0, frames: 0 };

  constructor(opts: EngineOptions) {
    const quality = opts.quality ?? detectQuality();
    const shot = isShotMode();

    const renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      // Cheap MSAA is worth more here than anywhere else in the vibeverse: a
      // jet is mostly long thin edges against a flat sky, which is the exact
      // case aliasing is most visible in.
      antialias: quality !== "ultra",
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
    // Off, deliberately. Three only splices its tone-mapping chunk into the
    // materials it wrote, and every material in this world is a raw
    // ShaderMaterial — so the curve is applied in `OUTPUT_GLSL` instead, where
    // it actually reaches the pixels. Leaving this on would tone-map the two
    // built-in materials (a decal and a prop disc) and nothing else, which is
    // worse than tone-mapping none of them.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = false; // nothing casts a useful shadow from 2 km up
    renderer.info.autoReset = true;

    const scene = new THREE.Scene();
    const width = window.innerWidth;
    const height = Math.max(1, window.innerHeight);
    const portrait = height > width;

    // A narrower lens in portrait: the same 70° across a phone held upright
    // crams the horizon into a letterbox and makes the jet look like a toy.
    const camera = new THREE.PerspectiveCamera(
      portrait ? 62 : 70,
      width / height,
      NEAR_PLANE,
      FAR_PLANE,
    );
    camera.rotation.order = "YXZ";
    camera.position.set(0, 800, 0);
    scene.add(camera);

    this.ctx = {
      scene,
      camera,
      renderer,
      services: {},
      input: makeInput(),
      elapsed: 0,
      dt: 0,
      quality,
      rng: makeRng(opts.seed ?? 0x424c_5545),
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
    // A factory that resolves after teardown must not leave a system running.
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

  /**
   * Advance exactly one frame with a supplied dt — used by the shot harness.
   *
   * `render: false` runs the simulation without drawing, which is how the
   * harness fast-forwards three hundred frames of formation flying on a
   * software rasteriser without taking twenty minutes to do it.
   */
  step(dt: number, render = true): void {
    this.frame(dt, render);
  }

  private frame(forcedDt?: number, render = true): void {
    const t0 = performance.now();
    const raw = forcedDt ?? this.clock.getDelta();
    // A tab switch or a shader compile must never teleport a jet across the lake.
    const dt = Math.min(raw, 1 / 15);
    this.ctx.dt = dt;
    this.ctx.elapsed += dt;

    this.accumulator = Math.min(this.accumulator + dt, FIXED_DT * 10);
    while (this.accumulator >= FIXED_DT) {
      for (const s of this.systems) s.fixedUpdate?.(FIXED_DT, this.ctx);
      this.accumulator -= FIXED_DT;
    }

    for (const s of this.systems) s.update?.(dt, this.ctx);
    for (const s of this.systems) s.lateUpdate?.(dt, this.ctx);

    if (render) {
      if (this.renderOverride) this.renderOverride(dt);
      else this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);
    }

    // Edge-triggered input is consumed exactly once per frame.
    //
    // The two the React layer cares about are announced on the way past. It
    // used to poll these flags on a 60 ms timer, which is a race it loses more
    // often than it wins: the flag is raised in a DOM handler and cleared at
    // the end of the very next frame, so it exists for about sixteen
    // milliseconds. Escape opened the menu roughly one press in three.
    const input = this.ctx.input;
    if (input.pausePressed) this.emit("angels:pause");
    if (input.helpPressed) this.emit("angels:help");
    input.gearToggle = false;
    input.smokeToggle = false;
    input.viewPressed = false;
    input.pausePressed = false;
    input.resetPressed = false;
    input.helpPressed = false;
    input.levelPressed = false;
    input.lookX = 0;
    input.lookY = 0;

    const ms = performance.now() - t0;
    this.stats.frameMs += (ms - this.stats.frameMs) * 0.1;
    this.stats.fps += (1 / Math.max(dt, 1e-4) - this.stats.fps) * 0.1;
    this.stats.frames++;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = Math.max(1, window.innerHeight);
    const aspect = w / h;
    const portrait = h > w;
    this.ctx.renderer.setSize(w, h, false);
    this.ctx.camera.aspect = aspect;
    this.ctx.camera.fov = portrait ? 62 : 70;
    this.ctx.camera.updateProjectionMatrix();
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
        console.error("[Blue Angels] system dispose failed", err);
      }
    }
    this.systems = [];
    this.listeners.clear();
    disposeGraph(this.ctx.scene);
    this.ctx.renderer.dispose();
  }
}

/**
 * Free every GPU resource hanging off a subtree.
 *
 * Browsers cap live WebGL contexts at around sixteen. A world that leaks one
 * breaks the *next* world a visitor opens, which is a miserable thing to debug
 * from a bug report that says "the city is black now".
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
