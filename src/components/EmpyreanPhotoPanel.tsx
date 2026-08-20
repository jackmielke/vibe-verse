/**
 * The viewfinder.
 *
 * The Empyrean is a picture before it is anything else — one painting of a
 * floating city at sunset, an hour and a weather you can set, and a jetpack
 * that will put you anywhere in the frame. This is the interface for taking
 * the photograph: the framing, the lens, the look, and the shutter.
 *
 * Four decisions worth the words:
 *
 * - **The HUD goes away, all of it.** The page hides the place card, the
 *   prompts, the toasts and the minimap the moment photo mode opens, and the
 *   capture reads the WebGL canvas rather than the screen — so nothing here
 *   can end up in the file even if it is on top of it. What is left is a
 *   letterbox, a control bar and nothing else, and **H** takes the control bar
 *   away too.
 * - **The letterbox is the crop.** The bars are not decoration: the picture is
 *   cut to exactly the live rectangle they leave, so a 4:5 shot is a 4:5 file
 *   and not a 16:9 file with black in it.
 * - **The hour and the weather come with you.** `EmpyreanSkyPanel` is mounted
 *   inside the viewfinder rather than reimplemented, because the whole subject
 *   of this world is the light, and having to leave the shot to change it is
 *   the same as not being able to change it.
 * - **The looks live here, not in the engine.** Each one is a CSS filter
 *   string; it is previewed by filtering the canvas element and baked into the
 *   file by replaying the same string through a 2D context on the way out. One
 *   table, in the one place that has the words for it, and what you see is
 *   what you get.
 */
import { useEffect, useState } from "react";
import type { EmpyreanState, PhotoOptions, PhotoShot } from "@/empyrean/types";
import EmpyreanSkyPanel from "@/components/EmpyreanSkyPanel";

/* -------------------------------------------------------------------------
 * What you can pick
 * ---------------------------------------------------------------------- */

/**
 * Aspect ratios, as width ÷ height. `null` is the window's own.
 *
 * Three shapes and the frame you are already in, which is as many as anybody
 * uses: square for a grid, 16:9 for a landscape, 4:5 because it is the tallest
 * thing a phone will show you without cropping it again.
 */
export const PHOTO_ASPECTS: ReadonlyArray<{ id: string; label: string; value: number | null }> = [
  { id: "free", label: "Screen", value: null },
  { id: "square", label: "1:1", value: 1 },
  { id: "wide", label: "16:9", value: 16 / 9 },
  { id: "tall", label: "4:5", value: 4 / 5 },
  { id: "cine", label: "2.39", value: 2.39 },
];

/**
 * The looks.
 *
 * Named after what this world actually does at the hours you shoot it, and
 * each one is a real photographic decision rather than a hue rotation: the
 * grade in `postfx.ts` has already tone-mapped the frame, so these are small
 * on purpose. A filter that fights the tone map reads as a broken renderer.
 */
export const PHOTO_LOOKS: ReadonlyArray<{
  id: string;
  label: string;
  css: string;
  vignette: number;
}> = [
  { id: "none", label: "As it is", css: "none", vignette: 0.1 },
  {
    id: "empyrean",
    label: "Empyrean",
    css: "saturate(1.16) contrast(1.06) brightness(1.02)",
    vignette: 0.2,
  },
  {
    id: "amber",
    label: "Long sunset",
    css: "saturate(1.22) contrast(1.05) sepia(0.16) brightness(1.03)",
    vignette: 0.24,
  },
  {
    id: "ice",
    label: "Ice",
    css: "saturate(0.86) contrast(1.1) hue-rotate(-8deg) brightness(1.04)",
    vignette: 0.16,
  },
  {
    id: "silver",
    label: "Silver",
    css: "grayscale(1) contrast(1.28) brightness(0.98)",
    vignette: 0.3,
  },
  {
    id: "cyan",
    label: "Cyanotype",
    css: "grayscale(1) sepia(1) hue-rotate(168deg) saturate(2.2) contrast(1.08)",
    vignette: 0.26,
  },
];

/** What the viewfinder opens on. 50° is a normal lens; the world is wide enough. */
export const PHOTO_START: PhotoOptions = {
  fov: 50,
  aspect: null,
  showBody: true,
  filter: "none",
  vignette: 0.1,
  scale: 2,
};

/**
 * Vertical field of view as a focal length a photographer would recognise.
 *
 * 35 mm full frame is 24 mm tall, so the half-height is 12. Nobody thinks in
 * degrees and everybody has an opinion about a 24 and a 135.
 */
export function focalLength(fov: number): number {
  return Math.round(12 / Math.tan((fov * Math.PI) / 360));
}

/* -------------------------------------------------------------------------
 * The panel
 * ---------------------------------------------------------------------- */

const chip =
  "rounded-full border px-2.5 py-1 text-[11px] leading-none transition-colors disabled:opacity-40";
const chipOn = "border-amber-200/60 bg-amber-200/20 text-amber-100";
const chipOff = "border-white/12 bg-white/[0.04] text-white/70 hover:bg-white/10 hover:text-white";

export interface EmpyreanPhotoPanelProps {
  state: EmpyreanState;
  options: PhotoOptions;
  onOptions: (patch: Partial<PhotoOptions>) => void;
  /** Take the picture. */
  onShutter: () => void;
  /** Leave photo mode. */
  onClose: () => void;
  /** The last photograph, if there is one. */
  shot: PhotoShot | null;
  onDismissShot: () => void;
  /** True while a capture is in flight. */
  busy: boolean;
  /** False hides everything but the letterbox — H. */
  showControls: boolean;
  /** Composition guides, thirds. */
  guides: boolean;
  onGuides: (on: boolean) => void;
  /** Straight through to the sky panel, which is mounted inside here. */
  onHour: (phase: number | null) => void;
  onWeather: (id: string | null) => void;
  touch: boolean;
}

export default function EmpyreanPhotoPanel({
  state,
  options,
  onOptions,
  onShutter,
  onClose,
  shot,
  onDismissShot,
  busy,
  showControls,
  guides,
  onGuides,
  onHour,
  onWeather,
  touch,
}: EmpyreanPhotoPanelProps) {
  /* The letterbox has to be measured, not guessed: the crop is computed from
     the drawing buffer and the mask from the window, and if the two disagree
     the player frames a shot they do not get. Both are the same rectangle
     because both are `min(fit)` on the same aspect. */
  const [view, setView] = useState(() => ({
    w: typeof window === "undefined" ? 1 : window.innerWidth,
    h: typeof window === "undefined" ? 1 : window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight });
    onResize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  const frame = liveRect(view.w, view.h, options.aspect);
  const look = PHOTO_LOOKS.find((l) => l.css === options.filter) ?? PHOTO_LOOKS[0];

  return (
    <div className="pointer-events-none fixed inset-0 z-40">
      {/* The mask. One element: everything outside the live rectangle is this
          element's own shadow, which is both cheaper than four bars and
          impossible to get out of alignment with them. */}
      <div
        className="absolute"
        style={{
          left: frame.x,
          top: frame.y,
          width: frame.w,
          height: frame.h,
          boxShadow: "0 0 0 100vmax rgba(0,0,0,0.82)",
          outline: "1px solid rgba(255,255,255,0.22)",
        }}
      >
        {guides && (
          <>
            <div className="absolute inset-y-0 left-1/3 w-px bg-white/20" />
            <div className="absolute inset-y-0 left-2/3 w-px bg-white/20" />
            <div className="absolute inset-x-0 top-1/3 h-px bg-white/20" />
            <div className="absolute inset-x-0 top-2/3 h-px bg-white/20" />
          </>
        )}
        {/* Corner marks. They cost nothing and they are the difference between
            a dark screen and a viewfinder. */}
        <Corner className="left-0 top-0 border-l-2 border-t-2" />
        <Corner className="right-0 top-0 border-r-2 border-t-2" />
        <Corner className="bottom-0 left-0 border-b-2 border-l-2" />
        <Corner className="bottom-0 right-0 border-b-2 border-r-2" />
      </div>

      {showControls && (
        <>
          {/* Top left: what the lens is doing. Deliberately the only readout —
              altitude and speed are gameplay, and this is not gameplay. */}
          <div className="absolute left-3 top-16 rounded-2xl border border-white/10 bg-black/45 px-3 py-2 backdrop-blur-md">
            <div className="text-[10px] uppercase tracking-[0.28em] text-amber-100/85">
              Photo mode
            </div>
            <div className="mt-1 font-mono text-[11px] text-white/85">
              {options.fov.toFixed(0)}° · {focalLength(options.fov)} mm ·{" "}
              {options.aspect ? formatAspect(options.aspect) : "screen"}
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-white/45">
              {touch ? "stick flies the lens · drag to look" : "WASD fly · Space / C up & down · Shift fast"}
            </div>
          </div>

          {/* Top right: the sky, and the way out. The sky panel is the one from
              the ordinary HUD, mounted here rather than rebuilt — the light is
              the subject of this world and it has to be reachable from inside
              the viewfinder. */}
          <div className="pointer-events-auto absolute right-3 top-3 flex items-center gap-2">
            <EmpyreanSkyPanel state={state} onHour={onHour} onWeather={onWeather} />
            <button
              onClick={onClose}
              className="rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-white/90 backdrop-blur-md transition-colors hover:bg-black/60"
              title="Leave photo mode (Esc)"
            >
              ✕ Exit
            </button>
          </div>

          {/* The control bar. */}
          <div className="pointer-events-auto absolute inset-x-0 bottom-0 flex justify-center px-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            <div className="w-full max-w-[46rem] rounded-2xl border border-white/12 bg-black/65 p-3 backdrop-blur-xl">
              {/* Framing */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[10px] uppercase tracking-[0.22em] text-white/40">
                  Frame
                </span>
                {PHOTO_ASPECTS.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => onOptions({ aspect: a.value })}
                    className={`${chip} ${options.aspect === a.value ? chipOn : chipOff}`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>

              {/* The lens */}
              <div className="mt-3 flex items-center gap-3">
                <span className="text-[10px] uppercase tracking-[0.22em] text-white/40">Lens</span>
                <input
                  type="range"
                  min={12}
                  max={110}
                  step={1}
                  value={options.fov}
                  onChange={(e) => onOptions({ fov: Number(e.target.value) })}
                  aria-label="Field of view"
                  className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-white/15 accent-amber-200"
                />
                <span className="w-16 text-right font-mono text-[11px] text-white/70">
                  {focalLength(options.fov)} mm
                </span>
              </div>

              {/* The look */}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[10px] uppercase tracking-[0.22em] text-white/40">
                  Look
                </span>
                {PHOTO_LOOKS.map((l) => (
                  <button
                    key={l.id}
                    onClick={() => onOptions({ filter: l.css, vignette: l.vignette })}
                    className={`${chip} ${look.id === l.id ? chipOn : chipOff}`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>

              {/* The rest, and the shutter */}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => onOptions({ showBody: !options.showBody })}
                  className={`${chip} ${options.showBody ? chipOn : chipOff}`}
                  title="Whether your character is in the shot (B)"
                >
                  {options.showBody ? "◉ You in it" : "○ Landscape"}
                </button>
                <button
                  onClick={() => onGuides(!guides)}
                  className={`${chip} ${guides ? chipOn : chipOff}`}
                  title="Rule of thirds (G)"
                >
                  ⊞ Guides
                </button>
                <button
                  onClick={() => onOptions({ scale: options.scale > 1 ? 1 : 2 })}
                  className={`${chip} ${options.scale > 1 ? chipOn : chipOff}`}
                  title="Render the photograph at twice the screen's resolution"
                >
                  {options.scale > 1 ? "2× res" : "1× res"}
                </button>
                <span className="hidden flex-1 text-right font-mono text-[10px] text-white/35 sm:inline">
                  H hides this · Enter takes the shot
                </span>
                <button
                  onClick={onShutter}
                  disabled={busy}
                  className="ml-auto rounded-full border border-amber-200/60 bg-amber-200/20 px-5 py-2 text-[12px] font-semibold text-amber-50 transition-colors hover:bg-amber-200/30 disabled:opacity-50"
                >
                  {busy ? "Exposing…" : "◉ Shutter"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* The photograph. Stays until it is dismissed — a shutter with no
          receipt is a shutter nobody believes fired. */}
      {shot && (
        <div className="pointer-events-auto absolute right-3 top-16 w-56 rounded-2xl border border-white/15 bg-black/70 p-2 backdrop-blur-xl">
          <img
            src={shot.url}
            alt="The photograph you just took"
            className="w-full rounded-lg border border-white/10"
          />
          <div className="mt-1.5 px-0.5 font-mono text-[10px] text-white/50">
            {shot.width} × {shot.height}
          </div>
          <div className="mt-1.5 flex gap-1.5">
            <a
              href={shot.url}
              download={shot.name}
              className={`${chip} ${chipOn} flex-1 text-center`}
            >
              ↓ Save
            </a>
            {canShare() && (
              <button onClick={() => void share(shot)} className={`${chip} ${chipOff}`}>
                ↗ Share
              </button>
            )}
            <button onClick={onDismissShot} className={`${chip} ${chipOff}`}>
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Corner({ className }: { className: string }) {
  return <div className={`absolute h-5 w-5 border-white/60 ${className}`} />;
}

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

/**
 * The rectangle the picture will actually be, inside a `w`×`h` window.
 *
 * The same arithmetic as `cropRect` in `capture.ts`, in CSS pixels rather than
 * device ones: both are a centred fit of the aspect inside the frame, so the
 * mask and the file cannot disagree.
 */
export function liveRect(
  w: number,
  h: number,
  aspect: number | null,
): { x: number; y: number; w: number; h: number } {
  if (!aspect || !(aspect > 0)) return { x: 0, y: 0, w, h };
  if (w / h > aspect) {
    const lw = Math.round(h * aspect);
    return { x: Math.round((w - lw) / 2), y: 0, w: lw, h };
  }
  const lh = Math.round(w / aspect);
  return { x: 0, y: Math.round((h - lh) / 2), w, h: lh };
}

/** "16:9" for the ones people know, "1.85" for the ones they do not. */
export function formatAspect(a: number): string {
  const known = PHOTO_ASPECTS.find((p) => p.value !== null && Math.abs(p.value - a) < 0.002);
  return known ? known.label : a.toFixed(2);
}

function canShare(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.canShare === "function" &&
    typeof navigator.share === "function"
  );
}

/**
 * Hand the picture to the phone's own share sheet.
 *
 * This is where photo mode actually pays off — most sharing happens on a
 * phone, and a download on iOS lands in a folder nobody visits. Falls back to
 * nothing at all if the browser refuses: the Save link next to it always
 * works.
 */
async function share(shot: PhotoShot): Promise<void> {
  try {
    const blob = await (await fetch(shot.url)).blob();
    const file = new File([blob], shot.name, { type: "image/png" });
    if (!navigator.canShare?.({ files: [file] })) return;
    await navigator.share({ files: [file], title: "The Empyrean" });
  } catch {
    /* A cancelled share sheet is not an error. */
  }
}
