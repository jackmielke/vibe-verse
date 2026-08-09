/**
 * DROP ZERO — the vibeverse's battle royale.
 *
 * Hundred-player island, a bus, a closing storm and the build loop. The
 * React layer is deliberately thin: it mounts the canvas, runs the boot
 * sequence, and renders the HUD off engine events. Everything that moves
 * lives in `src/royale/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { boot } from "@/royale/boot";
import type { Engine } from "@/royale/engine/core";
import { detectQuality } from "@/royale/engine/core";
import HUD from "@/royale/ui/HUD";
import { useWorldStamp } from "@/hooks/use-world-stamp";

const CONTROLS: [string, string][] = [
  ["WASD", "move"],
  ["Shift", "sprint"],
  ["Space", "jump"],
  ["Mouse", "look / fire"],
  ["RMB", "aim"],
  ["Z X C V", "wall floor ramp cone"],
  ["G", "edit"],
  ["Q", "rotate"],
  ["E", "pick up"],
  ["R", "reload"],
  ["1–5", "inventory"],
  ["Esc", "pause"],
];

/** Water mode renames the two controls whose meaning actually changed. */
const WATER_CONTROLS: [string, string][] = CONTROLS.map(([k, a]) =>
  k === "Mouse" ? [k, "look / soak"] : k === "R" ? [k, "pump tank"] : [k, a],
) as [string, string][];

export default function DropZero() {
  // Passport: every world records that you were here. See lib/passport.ts.
  /* This route boots SPLASH ROYALE by default, so it stamps its passport entry.
     `?mode=classic` still plays the original build, but the classic mode is a
     variant of one world rather than a second world, and giving a variant its
     own stamp would make the passport count the same island twice. */
  useWorldStamp("/splash-royale", "Splash Royale");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [progress, setProgress] = useState({ stage: "Booting", fraction: 0 });
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `?shot=1` drops the entry veil and exposes the engine on `window` so the
  // automated capture harness can pose the camera and grab frames.
  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  /**
   * `?q=high` forces a quality tier.
   *
   * Capture runs in this container auto-detect `medium`, because the box has
   * no GPU and `detectQuality` reads deviceMemory and core count. Medium takes
   * terrain's cheap path — so every frame reviewed so far has been the
   * low-end rendering path, not the one a visitor with a real GPU gets. A
   * capture that is not representative of the shipped experience is worse
   * than no capture, because it sends you fixing the wrong renderer.
   */
  /**
   * Which game this route boots. WATER BY DEFAULT.
   *
   * Drop Zero and Soaked are the same 22 systems with `ctx.mode` flipped, and
   * the water fight is the one people actually want to play — soakers,
   * balloons, the glue gun, and last one dry wins. So /drop-zero opens the
   * water game like everything else, and `?mode=classic` is the way back to
   * the original bullets-and-health build for anyone who wants it.
   */
  const mode = (() => {
    if (typeof window === "undefined") return "water" as const;
    return new URLSearchParams(window.location.search).get("mode") === "classic"
      ? ("classic" as const)
      : ("water" as const);
  })();

  const water = mode === "water";

  const forcedQuality = (() => {
    if (typeof window === "undefined") return null;
    const q = new URLSearchParams(window.location.search).get("q");
    return q === "low" || q === "medium" || q === "high" || q === "ultra" ? q : null;
  })();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    (async () => {
      try {
        const { engine: eng } = await boot(
          { canvas, quality: forcedQuality ?? detectQuality(), mode },
          (stage, fraction) => {
            if (!cancelled) setProgress({ stage, fraction });
          },
        );
        if (cancelled) {
          eng.dispose();
          return;
        }
        engineRef.current = eng;
        setEngine(eng);
        eng.on("dz:lock", (v) => setLocked(Boolean(v)));
        eng.start();
        setReady(true);
        if (shotMode) {
          (window as unknown as Record<string, unknown>).__dz = eng;
          (window as unknown as Record<string, unknown>).__dzReady = true;
        }
      } catch (err) {
        console.error("[Drop Zero] boot failed", err);
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    const onResize = () => engineRef.current?.resize();
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [shotMode, forcedQuality, mode]);

  const enter = useCallback(() => {
    canvasRef.current?.requestPointerLock?.();
    // Browsers gate audio behind a gesture; this click is the only one we get.
    engineRef.current?.ctx.services.audio?.resume();
  }, []);

  return (
    <div className="fixed inset-0 bg-black">
      <canvas ref={canvasRef} className="block h-full w-full touch-none outline-none" />

      {ready && engine && <HUD engine={engine} locked={locked || shotMode} />}

      {/* Loading / pause veil */}
      {(!ready || !locked) && !shotMode && !error && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-gradient-to-b from-[#0b1230]/95 via-[#141a3a]/90 to-[#05060f]/96 backdrop-blur-sm">
          <p className="text-xs uppercase tracking-[0.5em] text-indigo-300/70">
            The Vibeverse presents
          </p>
          <h1 className="mt-3 bg-gradient-to-b from-white via-sky-200 to-indigo-400 bg-clip-text text-6xl font-black tracking-tight text-transparent drop-shadow-[0_2px_28px_rgba(99,102,241,0.45)] sm:text-8xl">
            {water ? "SPLASH ROYALE" : "DROP ZERO"}
          </h1>
          <p className="mt-2 max-w-md text-center text-sm text-indigo-100/70">
            {water
              ? "One island. One downpour. Soakers, water balloons and a glue gun — harvest, build, and be the last one dry when the rain closes in."
              : "One island. One storm. Harvest anything, build faster than they can shoot, and be the last one breathing when the circle closes."}
          </p>

          {!ready ? (
            <div className="mt-10 w-72">
              <div className="h-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-sky-300 to-violet-400 transition-[width] duration-300"
                  style={{ width: `${Math.round(progress.fraction * 100)}%` }}
                />
              </div>
              <p className="mt-2 text-center font-mono text-[11px] uppercase tracking-widest text-indigo-200/60">
                {progress.stage}…
              </p>
            </div>
          ) : (
            <>
              <button
                onClick={enter}
                className="mt-10 rounded-full bg-gradient-to-r from-sky-400 to-violet-500 px-10 py-3 text-sm font-bold uppercase tracking-[0.2em] text-white shadow-[0_0_44px_rgba(129,140,248,0.5)] transition hover:brightness-110"
              >
                {water ? "Get soaked" : "Drop in"}
              </button>
              <div className="mt-8 grid grid-cols-2 gap-x-10 gap-y-1.5 font-mono text-[11px] text-indigo-100/50 sm:grid-cols-3">
                {(water ? WATER_CONTROLS : CONTROLS).map(([key, action]) => (
                  <span key={key}>
                    <b className="text-sky-200/80">{key}</b> {action}
                  </span>
                ))}
              </div>
            </>
          )}

          <Link
            to="/"
            className="absolute bottom-6 text-[11px] uppercase tracking-[0.3em] text-white/30 transition hover:text-white/60"
          >
            ← back to the vibeverse
          </Link>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black/90 p-8 text-center">
          <h2 className="text-xl font-bold text-red-400">Drop Zero failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <Link to="/" className="mt-4 text-xs uppercase tracking-widest text-sky-300">
            ← back to the vibeverse
          </Link>
        </div>
      )}
    </div>
  );
}
