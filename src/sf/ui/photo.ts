/**
 * Photo mode runtime.
 *
 * Split into a mutable rig (60 Hz, no React) and a small set of pure helpers
 * for filtering and export. The rig is deliberately a plain object rather
 * than store state: the free camera is flown with WASD at frame rate, and
 * every keystroke re-rendering the settings panel would be absurd.
 *
 * `PhotoCameraRig` (a component in this directory) reads the rig from inside
 * the R3F tree and drives the actual camera. Everything else — the panel, the
 * marker projection, the exporter — reads it from the DOM side.
 */
import { frame } from "../state/store";
import { postFx, postfx, type GradeLook } from "../postfx/state";

export interface PhotoRig {
  /** True while photo mode owns the camera. */
  active: boolean;
  /** Free camera pose, world metres / radians. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** Dutch angle, radians. Purely a compositional tool. */
  roll: number;
  /** Vertical FOV, degrees. 14 = long lens, 110 = fisheye-ish wide. */
  fov: number;
  /** Metres per second of free-cam travel. */
  speed: number;
  /** Live input axes, written by the panel's key handler. */
  moveX: number;
  moveY: number;
  moveZ: number;
  /** Smoothed velocity so the camera glides instead of snapping. */
  vx: number;
  vy: number;
  vz: number;
  /** Lens. */
  focusDistance: number;
  aperture: number;
  autoFocus: boolean;
  dofBlend: number;
  /** Composition guides. */
  grid: "none" | "thirds" | "golden" | "centre";
  /** Hide the game HUD for the shot (independent of the global HUD toggle). */
  hideHud: boolean;
  /** Selected filter id. */
  filter: string;
  /** The WebGL canvas, registered by the rig component so export can read it. */
  canvas: HTMLCanvasElement | null;
  /** Incremented per export so filenames stay unique without a wall clock. */
  shotIndex: number;
  /** Saved player state, restored on exit. */
  savedFov: number;
  savedTod: number;
  savedFog: number;
  savedPaused: boolean;
}

export const photoRig: PhotoRig = {
  active: false,
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  fov: 45,
  speed: 14,
  moveX: 0,
  moveY: 0,
  moveZ: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  focusDistance: 24,
  aperture: 2.8,
  autoFocus: false,
  dofBlend: 0.85,
  grid: "none",
  hideHud: true,
  filter: "none",
  canvas: null,
  shotIndex: 0,
  savedFov: 74,
  savedTod: 12,
  savedFog: 0.3,
  savedPaused: false,
};

/* ------------------------------------------------------------------ *
 * Looks
 * ------------------------------------------------------------------ */

export interface PhotoFilter {
  id: string;
  name: string;
  /** A CSS filter string. Applied live to the canvas element AND replayed at
   *  export time through a 2D context, so what you see is what you get. */
  css: string;
  /** Optional pin on the engine's colour grade. */
  look?: GradeLook;
  /** Grain override while the filter is selected. */
  grain?: number;
}

/**
 * Named after how San Francisco actually looks at the hours you shoot it.
 * Each is a real photographic decision, not a random hue rotation.
 */
export const PHOTO_FILTERS: PhotoFilter[] = [
  { id: "none", name: "Neutral", css: "none" },
  {
    id: "karl",
    name: "Karl the Fog",
    css: "saturate(0.62) contrast(0.92) brightness(1.06) blur(0px)",
    grain: 0.35,
  },
  {
    id: "goldengate",
    name: "Golden Hour",
    css: "saturate(1.18) contrast(1.06) sepia(0.14) brightness(1.03)",
    look: "golden",
  },
  {
    id: "noir",
    name: "Bullitt Noir",
    css: "grayscale(1) contrast(1.34) brightness(0.94)",
    grain: 0.9,
  },
  {
    id: "kodachrome",
    name: "Kodachrome 64",
    css: "saturate(1.42) contrast(1.16) hue-rotate(-6deg)",
    grain: 0.7,
  },
  {
    id: "bleach",
    name: "Bleach Bypass",
    css: "saturate(0.42) contrast(1.5) brightness(1.05)",
    grain: 0.8,
  },
  {
    id: "neon",
    name: "Mission Neon",
    css: "saturate(1.6) contrast(1.12) hue-rotate(8deg) brightness(0.96)",
    look: "night",
  },
  {
    id: "cyanotype",
    name: "Cyanotype",
    css: "grayscale(1) sepia(1) hue-rotate(165deg) saturate(2.4) contrast(1.1)",
  },
  {
    id: "infra",
    name: "Infrared",
    css: "invert(1) hue-rotate(160deg) saturate(1.7) contrast(1.2)",
  },
];

export function filterById(id: string): PhotoFilter {
  return PHOTO_FILTERS.find((f) => f.id === id) ?? PHOTO_FILTERS[0];
}

/* ------------------------------------------------------------------ *
 * Enter / exit
 * ------------------------------------------------------------------ */

/**
 * Take the camera. Seeds the free cam from wherever the player is standing so
 * photo mode opens on the shot they were already looking at, rather than
 * dumping them at the origin.
 */
export function enterPhotoMode(): void {
  if (photoRig.active) return;
  photoRig.savedFov = frame.fov;
  photoRig.savedTod = frame.timeOfDay;
  photoRig.savedFog = frame.fogDensity;
  photoRig.savedPaused = frame.paused;

  photoRig.x = frame.position.x;
  photoRig.y = frame.position.y + 0.8;
  photoRig.z = frame.position.z;
  photoRig.yaw = frame.yaw;
  photoRig.pitch = frame.pitch;
  photoRig.roll = 0;
  photoRig.vx = photoRig.vy = photoRig.vz = 0;
  photoRig.moveX = photoRig.moveY = photoRig.moveZ = 0;
  photoRig.active = true;
  frame.paused = true;
  applyPhotoLens();
}

export function exitPhotoMode(): void {
  if (!photoRig.active) return;
  photoRig.active = false;
  frame.paused = photoRig.savedPaused;
  frame.fov = photoRig.savedFov;
  // Hand the lens back to gameplay: auto-focus on, DoF off until ADS asks.
  postFx.setAutoFocus(true);
  postfx.dofBlend = 0;
  postFx.setLook("auto", 1);
  const el = photoRig.canvas;
  if (el) el.style.filter = "";
}

/** Push the rig's lens settings into the post chain. Called on every change. */
export function applyPhotoLens(): void {
  if (!photoRig.active) return;
  if (photoRig.autoFocus) {
    postFx.setAutoFocus(true);
    postfx.aperture = photoRig.aperture;
    postfx.dofBlend = photoRig.dofBlend;
  } else {
    postFx.setFocus(photoRig.focusDistance, photoRig.dofBlend, photoRig.aperture, 35);
  }
  const f = filterById(photoRig.filter);
  if (f.look) postFx.setLook(f.look, 1);
  else postFx.setLook("auto", 1);
  if (f.grain !== undefined) postfx.grain = f.grain;
  const el = photoRig.canvas;
  if (el) el.style.filter = f.css === "none" ? "" : f.css;
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

function findCanvas(): HTMLCanvasElement | null {
  if (photoRig.canvas) return photoRig.canvas;
  if (typeof document === "undefined") return null;
  // The game canvas is the only <canvas> R3F mounts; anything else in the
  // Vibeverse chrome is not full-bleed.
  const list = Array.from(document.querySelectorAll("canvas"));
  let best: HTMLCanvasElement | null = null;
  let bestArea = 0;
  for (const c of list) {
    const area = c.width * c.height;
    if (area > bestArea) {
      bestArea = area;
      best = c;
    }
  }
  return best;
}

export interface ExportOptions {
  /** Burn a discreet title card into the corner. */
  watermark?: boolean;
  /** Letterbox to this aspect (e.g. 2.39). 0 = native. */
  aspect?: number;
  /** Extra vignette, 0..1, applied in the composite. */
  vignette?: number;
}

/**
 * Composite and download a PNG.
 *
 * The WebGL buffer is copied through a 2D context so the CSS filter the
 * player is previewing is actually baked into the file — a filter applied
 * only in CSS would silently vanish from the export, which is the single
 * most annoying bug a photo mode can have. `preserveDrawingBuffer` is already
 * on in the renderer config, so the read is valid outside the render tick.
 */
export function exportPhoto(opts: ExportOptions = {}): Promise<boolean> {
  const src = findCanvas();
  if (!src || typeof document === "undefined") return Promise.resolve(false);

  const filter = filterById(photoRig.filter);
  const aspect = opts.aspect ?? 0;

  let w = src.width;
  let h = src.height;
  let sx = 0;
  let sy = 0;
  let sw = w;
  let sh = h;
  if (aspect > 0) {
    const native = w / h;
    if (native > aspect) {
      sw = Math.round(h * aspect);
      sx = Math.round((w - sw) / 2);
      w = sw;
      h = sh;
    } else {
      sh = Math.round(w / aspect);
      sy = Math.round((h - sh) / 2);
      h = sh;
    }
  }

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) return Promise.resolve(false);

  if (filter.css !== "none") ctx.filter = filter.css;
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  ctx.filter = "none";

  const vig = opts.vignette ?? 0.18;
  if (vig > 0) {
    const g = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.28,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.72,
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${vig.toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  if (opts.watermark) {
    const s = Math.max(11, Math.round(h * 0.016));
    ctx.font = `600 ${s}px Sora, sans-serif`;
    ctx.textBaseline = "alphabetic";
    ctx.shadowColor = "rgba(0,0,0,0.75)";
    ctx.shadowBlur = s * 0.8;
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.fillText("SAN FRANCISCO: FREE FALL", s * 1.6, h - s * 1.7);
    ctx.fillStyle = "#ff6a2b";
    ctx.fillRect(s * 0.9, h - s * 2.6, 2, s * 1.4);
    ctx.shadowBlur = 0;
  }

  const index = ++photoRig.shotIndex;
  const name = `sf-freefall-${String(index).padStart(3, "0")}.png`;

  return new Promise<boolean>((resolve) => {
    out.toBlob((blob) => {
      if (!blob) {
        resolve(false);
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next macrotask; revoking synchronously races Safari.
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      resolve(true);
    }, "image/png");
  });
}
