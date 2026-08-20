/**
 * PHOTO MODE — the lens comes off the body.
 *
 * This world is, before it is anything else, a picture: it was built from one
 * painting of a floating city at sunset, the hour and the weather are the
 * player's to set, and the jetpack will take them anywhere in the frame. This
 * file is the last piece of that — a free camera, a set of framing controls,
 * and a shutter that produces a real PNG.
 *
 * ## What lives here and what does not
 *
 * The engine owns the lens; the page owns the menus. So this file holds the
 * free camera's pose, the flight that moves it, and the capture path — and it
 * holds *no* opinion about which looks exist or what they are called. The
 * grade arrives as a CSS filter string in `PhotoOptions`, because the list of
 * looks is a thing a person reads and pick from, which makes it the panel's,
 * and the engine's only job is to bake into the file exactly what the
 * viewfinder is showing.
 *
 * The house rule holds: this imports `types.ts` and `three` and nothing else
 * from this directory. It is handed the renderer, the camera, the canvas, the
 * body and two callbacks — `draw` and `resize` — which is everything the
 * capture needs to know about a post chain it may not import.
 *
 * ## The one trap, and which way out of it this takes
 *
 * A WebGL drawing buffer is cleared the moment the browser composites it,
 * unless the context was made with `preserveDrawingBuffer: true`. So the
 * obvious implementation — click a button, `toDataURL()` the canvas — reads
 * back a frame that no longer exists and writes a black PNG. Every test you
 * can write passes; the file is black.
 *
 * The flag is not the fix. It is a real cost on *every frame of the whole
 * session*, paid by every visitor who never takes a photograph, in a world
 * that is already asking for 2.7 M triangles.
 *
 * So `shoot()` draws the frame itself and reads it back in the same
 * synchronous task, with no `await` and no `requestAnimationFrame` between the
 * two: nothing composites in the middle of a JavaScript task, so the buffer is
 * still there. That also happens to be what makes the 2× capture possible —
 * since we are drawing the frame anyway, we can draw it bigger first.
 *
 * ## Supersampling
 *
 * `scale: 2` doubles the renderer's pixel ratio, redraws, reads back, and puts
 * it straight back. The post chain's targets are reallocated twice per shot,
 * which is a spike rather than a cost — and `captureScale` refuses to ask for
 * a buffer past the driver's maximum texture size or past a fixed pixel
 * budget, because a phone at devicePixelRatio 3 in portrait is already close
 * to both and the failure mode of asking for too much is a lost context, which
 * takes the whole world down with it.
 */
import * as THREE from "three";
import type { PhotoOptions, PhotoShot } from "./types";

/* -------------------------------------------------------------------------
 * Numbers
 * ---------------------------------------------------------------------- */

/** Metres a second the free camera flies at, before the modifiers. */
const SPEED = 18;
/** Shift. Big enough to cross the island while you are still interested. */
const FAST = 4.5;
/** Ctrl. Small enough to inch along a parapet. */
const SLOW = 0.22;
/** How fast the camera reaches the speed you asked for, per second. */
const EASE = 6.5;

/** The lens. 14 mm-ish to 400 mm-ish, in the only units three understands. */
export const FOV_MIN = 12;
export const FOV_MAX = 110;

/** Just under a right angle, so the horizon never rolls over the top. */
const PITCH_LIMIT = 1.52;

/**
 * The most pixels a capture may ask the driver for.
 *
 * A hair over 4K. The scene target in `postfx.ts` is half-float RGBA, so this
 * is about 66 MB for that one buffer and roughly twice that once the bloom
 * chain and the AO targets are counted — a spike a desktop absorbs and a phone
 * mostly does. Past it, the honest outcome is a lost context.
 */
export const MAX_CAPTURE_PIXELS = 8_300_000;

/* -------------------------------------------------------------------------
 * Pure helpers — everything here is testable without a GL context
 * ---------------------------------------------------------------------- */

export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * The centre crop of a `w`×`h` buffer at a given aspect.
 *
 * The viewfinder letterboxes with black bars over the live canvas; the file
 * gets the crop rather than the bars, because a PNG with black bars baked into
 * it is not a 4:5 photograph, it is a 16:9 photograph nobody can use.
 */
export function cropRect(w: number, h: number, aspect: number | null): CropRect {
  if (!aspect || !(aspect > 0) || !Number.isFinite(aspect)) return { sx: 0, sy: 0, sw: w, sh: h };
  const native = w / h;
  if (native > aspect) {
    const sw = Math.max(1, Math.round(h * aspect));
    return { sx: Math.round((w - sw) / 2), sy: 0, sw, sh: h };
  }
  const sh = Math.max(1, Math.round(w / aspect));
  return { sx: 0, sy: Math.round((h - sh) / 2), sw: w, sh };
}

/**
 * How much of the requested supersample the device can actually take.
 *
 * Steps down by halves rather than failing, so "2×" on a phone quietly becomes
 * 1.5× or 1× instead of a black frame or a dead context. `maxTexture` is
 * `renderer.capabilities.maxTextureSize`, which is 4096 on a great many mobile
 * GPUs and is the wall you hit first in portrait.
 */
export function captureScale(
  cssW: number,
  cssH: number,
  baseRatio: number,
  want: number,
  maxTexture = 4096,
): number {
  const w0 = Math.max(1, cssW * baseRatio);
  const h0 = Math.max(1, cssH * baseRatio);
  let s = Math.min(4, Math.max(1, Number.isFinite(want) ? want : 1));
  while (
    s > 1 &&
    (w0 * s > maxTexture || h0 * s > maxTexture || w0 * h0 * s * s > MAX_CAPTURE_PIXELS)
  ) {
    s = Math.max(1, s - 0.5);
  }
  return s;
}

/** `empyrean-20260820-184207.png`. Sorts by when it was taken. */
export function shotName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `empyrean-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.png`
  );
}

/** What the engine starts with. The page pushes its own on the way in. */
export const PHOTO_DEFAULTS: PhotoOptions = {
  fov: 50,
  aspect: null,
  showBody: true,
  filter: "none",
  vignette: 0.12,
  scale: 2,
};

/* -------------------------------------------------------------------------
 * The rig
 * ---------------------------------------------------------------------- */

/** What the engine hands photo mode. Structural on purpose: no system imports. */
export interface PhotoHost {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /** The player's body, so it can be taken out of the shot. */
  body: THREE.Object3D;
  /** Draw one whole frame of the world, through the post chain, to the canvas. */
  draw(): void;
  /** Tell the post chain the CSS size changed. */
  resize(w: number, h: number): void;
  /** Fired once a photograph exists. The engine makes the noise; we cannot. */
  onShutter?: () => void;
}

/** Axes the free camera is flown with. The engine already has the key set. */
export interface PhotoInput {
  x: number;
  y: number;
  jet: boolean;
  boost: boolean;
}

export interface PhotoMode {
  readonly active: boolean;
  readonly options: Readonly<PhotoOptions>;
  /** Take the camera, seeded from wherever it is now. */
  enter(): void;
  /** Give it back. The rig picks the camera up on the next frame. */
  exit(): void;
  set(patch: Partial<PhotoOptions>): void;
  /** A look drag, in CSS pixels, with the world's own sign convention. */
  look(dx: number, dy: number): void;
  /** Called from the loop instead of the camera rig. Must not allocate. */
  update(dt: number, keys: ReadonlySet<string>, stick: PhotoInput): void;
  /** Render one frame at capture resolution and hand back a PNG. */
  shoot(): Promise<PhotoShot | null>;
  dispose(): void;
}

/* Scratch. `update` runs every frame in a file whose header says not to
 * allocate in the loop, and a Vector3 per frame is a collector pause you can
 * see on a phone. */
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
const move = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, "YXZ");
const size = new THREE.Vector2();

export function createPhotoMode(host: PhotoHost): PhotoMode {
  const opts: PhotoOptions = { ...PHOTO_DEFAULTS };
  const pos = new THREE.Vector3();
  const vel = new THREE.Vector3();
  let yaw = 0;
  let pitch = 0;
  let active = false;
  /** What the body's visibility was before we took it away. */
  let bodyWas = true;

  /* The look is previewed by filtering the canvas element itself, and baked at
   * capture time by replaying the same string through a 2D context. One
   * string, two places, and what you see is what lands in the file — a filter
   * that exists only in the preview is the single most annoying bug a photo
   * mode can have. */
  const applyFilter = () => {
    const css = active && opts.filter && opts.filter !== "none" ? opts.filter : "";
    if (host.canvas.style.filter !== css) host.canvas.style.filter = css;
  };

  const applyBody = () => {
    host.body.visible = active ? opts.showBody : bodyWas;
  };

  return {
    get active() {
      return active;
    },
    get options() {
      return opts;
    },

    enter() {
      if (active) return;
      /* Seeded from the camera's own matrix rather than from the rig's yaw and
       * pitch: the rig's angles describe a boom, not a lens, and the two differ
       * by half a turn and a sign. Reading the matrix means photo mode opens on
       * exactly the shot that was on screen, whatever moved the camera there. */
      const cam = host.camera;
      pos.copy(cam.position);
      cam.getWorldDirection(fwd);
      pitch = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
      yaw = Math.atan2(-fwd.x, -fwd.z);
      vel.set(0, 0, 0);
      bodyWas = host.body.visible;
      active = true;
      applyBody();
      applyFilter();
    },

    exit() {
      if (!active) return;
      active = false;
      applyBody();
      applyFilter();
    },

    set(patch) {
      Object.assign(opts, patch);
      opts.fov = THREE.MathUtils.clamp(opts.fov, FOV_MIN, FOV_MAX);
      opts.vignette = THREE.MathUtils.clamp(opts.vignette, 0, 1);
      applyBody();
      applyFilter();
    },

    look(dx, dy) {
      /* The same rates and the same signs as the third-person rig, so the
       * world turns under your hand at the speed it did a second ago. The rig
       * measures pitch as boom elevation and this measures it as where the
       * lens is pointing, which is why the sign flips here and nowhere else. */
      yaw -= dx * 0.0085;
      pitch = THREE.MathUtils.clamp(pitch - dy * 0.0062, -PITCH_LIMIT, PITCH_LIMIT);
    },

    update(dt, keys, stick) {
      if (!active) return;
      const cam = host.camera;

      let f = 0;
      let s = 0;
      let u = 0;
      if (keys.has("KeyW") || keys.has("ArrowUp")) f += 1;
      if (keys.has("KeyS") || keys.has("ArrowDown")) f -= 1;
      if (keys.has("KeyD") || keys.has("ArrowRight")) s += 1;
      if (keys.has("KeyA") || keys.has("ArrowLeft")) s -= 1;
      if (keys.has("Space")) u += 1;
      if (keys.has("KeyC")) u -= 1;
      // The touch stick flies the lens too — on a phone it is the only thing
      // that can, and a photo mode you cannot move is a screenshot key.
      f = THREE.MathUtils.clamp(f - stick.y, -1, 1);
      s = THREE.MathUtils.clamp(s + stick.x, -1, 1);
      if (stick.jet) u += 1;

      const fast = keys.has("ShiftLeft") || keys.has("ShiftRight") || stick.boost;
      const slow = keys.has("ControlLeft") || keys.has("ControlRight");

      euler.set(pitch, yaw, 0);
      // Forward is where the lens points, pitch included: you fly into the
      // shot you are framing rather than along the ground under it.
      fwd.set(0, 0, -1).applyEuler(euler);
      right.set(1, 0, 0).applyEuler(euler);
      move.set(0, 0, 0).addScaledVector(fwd, f).addScaledVector(right, s);
      move.y += u;
      const len = move.length();
      if (len > 1) move.multiplyScalar(1 / len);

      const speed = SPEED * (fast ? FAST : 1) * (slow ? SLOW : 1);
      /* Eased rather than snapped. A free camera that starts and stops dead
       * makes every hand-flown move look like a mistake; a third of a second
       * of glide at each end is the whole difference between a camera and a
       * cursor. */
      const k = 1 - Math.exp(-EASE * dt);
      vel.x += (move.x * speed - vel.x) * k;
      vel.y += (move.y * speed - vel.y) * k;
      vel.z += (move.z * speed - vel.z) * k;
      pos.addScaledVector(vel, dt);

      cam.position.copy(pos);
      cam.quaternion.setFromEuler(euler);
      if (Math.abs(cam.fov - opts.fov) > 0.001) {
        cam.fov = opts.fov;
        cam.updateProjectionMatrix();
      }
    },

    async shoot() {
      if (typeof document === "undefined") return null;
      const r = host.renderer;
      const base = r.getPixelRatio();
      r.getSize(size);
      const cssW = Math.max(1, Math.round(size.x));
      const cssH = Math.max(1, Math.round(size.y));
      const scale = captureScale(
        cssW,
        cssH,
        base,
        opts.scale,
        r.capabilities.maxTextureSize || 4096,
      );

      let out: HTMLCanvasElement | null = null;
      try {
        if (scale !== 1) {
          // `false` leaves the CSS size alone — the canvas keeps filling the
          // window while its drawing buffer is twice the size, which is why
          // there is nothing to see while this happens.
          r.setPixelRatio(base * scale);
          r.setSize(cssW, cssH, false);
          host.resize(cssW, cssH);
        }
        /* Draw and read back with nothing between them.
         *
         * No await, no rAF, no yield: the drawing buffer survives exactly as
         * long as this task does, because the browser cannot composite in the
         * middle of one. This is the whole reason `preserveDrawingBuffer` is
         * off — see the header. */
        host.draw();
        out = compose(host.canvas, opts);
      } finally {
        if (scale !== 1) {
          r.setPixelRatio(base);
          r.setSize(cssW, cssH, false);
          host.resize(cssW, cssH);
        }
      }
      if (!out) return null;

      const canvas = out;
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/png"),
      );
      if (!blob) return null;
      host.onShutter?.();
      return {
        url: URL.createObjectURL(blob),
        width: canvas.width,
        height: canvas.height,
        name: shotName(),
      };
    },

    dispose() {
      if (active) {
        active = false;
        applyBody();
      }
      host.canvas.style.filter = "";
    },
  };
}

/* -------------------------------------------------------------------------
 * The composite
 * ---------------------------------------------------------------------- */

/**
 * Crop, grade and vignette the drawing buffer into a 2D canvas.
 *
 * Must be called in the same task as the draw — see `shoot`. Everything after
 * this point is an ordinary 2D canvas, which keeps its pixels, so the encode
 * can take as long as it likes.
 */
function compose(src: HTMLCanvasElement, opts: PhotoOptions): HTMLCanvasElement | null {
  const rect = cropRect(src.width, src.height, opts.aspect);
  const out = document.createElement("canvas");
  out.width = rect.sw;
  out.height = rect.sh;
  const ctx = out.getContext("2d");
  if (!ctx) return null;

  /* The grade is a property of the photograph, not of the world.
   *
   * `postfx.ts` is the one place this world tone maps and it is not ours to
   * touch, which turns out to be the honest arrangement anyway: nobody
   * standing in the Bazaar should see it go monochrome because a menu is open
   * somewhere. So the look is applied here, to the picture, on the way out. */
  if (opts.filter && opts.filter !== "none") ctx.filter = opts.filter;
  ctx.drawImage(src, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.sw, rect.sh);
  ctx.filter = "none";

  const v = opts.vignette;
  if (v > 0.001) {
    const w = out.width;
    const h = out.height;
    const g = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.3,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.74,
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${v.toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  return out;
}
