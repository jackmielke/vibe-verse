/**
 * Engine core — renderer, two scenes, two cameras, fixed-step accumulator.
 *
 * The one thing here that is not boilerplate is the **two-pass draw**, and it
 * exists because this world has a problem the Blue Angels world dodged.
 *
 * Blue Angels draws its cockpit as a HUD overlay, so nothing in the scene is
 * ever closer than a metre and a near plane at 1.2 m covers ninety kilometres
 * of Washington on a plain 24-bit depth buffer. This world cannot do that: the
 * whole point is that you are sitting in a 707 flight deck with a glareshield
 * 60 cm from your face and a runway 12 km down the approach. One camera would
 * need a near:far ratio of about 1:400000, and depth precision falls off with
 * the *reciprocal* of distance — the far half of that range would collapse
 * into a handful of representable values and Chicago would z-fight with the
 * clouds.
 *
 * So the frame is drawn twice, the way real flight simulators do it:
 *
 *   1. the world, with `camera` (near 1 m, far 60 km),
 *   2. `clearDepth()`,
 *   3. the flight deck, with `cockpitCamera` (near 3 cm, far 30 m),
 *
 * both cameras sharing one position and orientation. Each pass gets the entire
 * depth buffer to itself, and the cockpit is always in front because it is
 * drawn second — which is also physically true, since you cannot see the world
 * through the back of the instrument panel.
 */
import * as THREE from "three";
import {
  FIXED_DT,
  clearEdges,
  makeInput,
  makeRng,
  type PlaneCtx,
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
  if (typeof window !== "undefined") {
    try {
      const q = new URLSearchParams(window.location.search).get("q");
      if (q === "low" || q === "medium" || q === "high" || q === "ultra") return q;
    } catch {
      /* no search params to read */
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

/** The screenshot harness rasterises on the CPU at low resolution. */
export function isShotMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).has("shot");
  } catch {
    return false;
  }
}

/** Far enough to hold the Chicago skyline 26 km down the approach. */
export const FAR_PLANE = 60000;
export const NEAR_PLANE = 1.0;
/** The flight deck pass. 3 cm covers the yoke, which is the nearest thing there is. */
export const COCKPIT_NEAR = 0.03;
export const COCKPIT_FAR = 30;

export class Engine {
  readonly ctx: PlaneCtx;
  private systems: System[] = [];
  private clock = new THREE.Clock();
  private raf = 0;
  private running = false;
  private disposed = false;
  private accumulator = 0;
  private listeners = new Map<string, Set<(p: never) => void>>();

  /** Paused by the menu, the pause key, or a lost tab. Physics stops; rendering does not. */
  paused = false;

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
    // Off for the same reason as Blue Angels: almost every material here is a
    // raw ShaderMaterial, which Three never splices its tone-mapping chunk
    // into. `outputColor()` in world/env.ts does the job where it reaches the
    // pixels. See that file — this is the single most load-bearing three lines
    // in the renderer setup and it is invisible until the picture comes out
    // dark and nobody can say why.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = false;
    // The two-pass draw does its own clearing, in `render()`.
    renderer.autoClear = false;
    renderer.info.autoReset = true;

    const scene = new THREE.Scene();
    const cockpitScene = new THREE.Scene();

    const width = window.innerWidth;
    const height = Math.max(1, window.innerHeight);
    const portrait = height > width;

    // 62° is roughly what a 707's windshield subtends from the left seat, and
    // it happens to be the lens that makes the panel read at phone size. In
    // portrait it goes narrower still: the same angle across a tall viewport
    // squeezes the horizon into a letterbox.
    const fov = portrait ? 58 : 64;
    const camera = new THREE.PerspectiveCamera(fov, width / height, NEAR_PLANE, FAR_PLANE);
    camera.rotation.order = "YXZ";
    camera.position.set(0, 2400, -20000);
    scene.add(camera);

    const cockpitCamera = new THREE.PerspectiveCamera(
      fov,
      width / height,
      COCKPIT_NEAR,
      COCKPIT_FAR,
    );
    cockpitCamera.rotation.order = "YXZ";
    cockpitScene.add(cockpitCamera);

    this.ctx = {
      scene,
      camera,
      cockpitCamera,
      cockpitScene,
      renderer,
      services: {},
      input: makeInput(),
      elapsed: 0,
      dt: 0,
      quality,
      rng: makeRng(opts.seed ?? 0x0209_1980),
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
    // Copy: a handler that unsubscribes itself would otherwise mutate the set
    // we are iterating, and the *next* handler silently never runs.
    for (const fn of [...set]) (fn as (p: unknown) => void)(payload);
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
   * `render: false` simulates without drawing. On the software rasteriser a
   * drawn frame of this world costs the better part of a second and a
   * simulated one costs under a millisecond, so the harness flies the whole
   * approach blind and only paints the last few frames.
   */
  step(dt: number, render = true): void {
    this.frame(dt, render);
  }

  private frame(forcedDt?: number, render = true): void {
    const t0 = performance.now();
    const raw = forcedDt ?? this.clock.getDelta();
    // A tab switch or a shader compile must never teleport the aeroplane
    // through the ground.
    const dt = this.paused ? 0 : Math.min(raw, 1 / 15);
    this.ctx.dt = dt;
    this.ctx.elapsed += dt;

    if (dt > 0) {
      this.accumulator = Math.min(this.accumulator + dt, FIXED_DT * 10);
      while (this.accumulator >= FIXED_DT) {
        for (const s of this.systems) s.fixedUpdate?.(FIXED_DT, this.ctx);
        this.accumulator -= FIXED_DT;
      }
      for (const s of this.systems) s.update?.(dt, this.ctx);
    }
    // lateUpdate runs even when paused: the camera still has to follow the
    // free-look and the menus still have to see fresh state behind them.
    for (const s of this.systems) s.lateUpdate?.(this.ctx.dt, this.ctx);

    if (render) this.render();

    clearEdges(this.ctx.input);

    const ms = performance.now() - t0;
    this.stats.frameMs += (ms - this.stats.frameMs) * 0.1;
    this.stats.fps += (1 / Math.max(raw, 1e-4) - this.stats.fps) * 0.1;
    this.stats.frames++;
  }

  /** The two-pass draw. See the file header for why. */
  render(): void {
    const { renderer, scene, camera, cockpitScene, cockpitCamera, services } = this.ctx;

    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    // The flight deck is only drawn when the lens is actually inside it.
    // Drawing it from the chase camera would wrap a 707 cockpit around the
    // outside of the aeroplane, which is exactly as funny as it sounds and
    // exactly as unshippable.
    const cam = services.camera as { inCockpit?: boolean } | undefined;
    if (cam?.inCockpit) {
      cockpitCamera.position.copy(camera.position);
      cockpitCamera.quaternion.copy(camera.quaternion);
      renderer.clearDepth();
      renderer.render(cockpitScene, cockpitCamera);
    }
  }

  resize(): void {
    const w = window.innerWidth;
    const h = Math.max(1, window.innerHeight);
    const aspect = w / h;
    const portrait = h > w;
    const fov = portrait ? 58 : 64;
    this.ctx.renderer.setSize(w, h, false);
    for (const cam of [this.ctx.camera, this.ctx.cockpitCamera]) {
      cam.aspect = aspect;
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
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
        console.error("[Flight 209] system dispose failed", err);
      }
    }
    this.systems = [];
    this.listeners.clear();
    disposeGraph(this.ctx.scene);
    disposeGraph(this.ctx.cockpitScene);
    this.ctx.renderer.dispose();
  }
}

/**
 * Free every GPU resource hanging off a subtree.
 *
 * Browsers cap live WebGL contexts at around sixteen, and a world that leaks
 * one breaks the *next* world a visitor opens — which arrives as a bug report
 * saying "the city is black now" and is a miserable thing to trace back here.
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
