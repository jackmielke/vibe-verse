/**
 * San Palmas — a tropical San Francisco, and the vibeverse's first FPS.
 *
 * The React layer is deliberately thin: it mounts the canvas, runs the boot
 * sequence, and renders the HUD off engine events. Everything that moves
 * lives in `src/palmas/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { boot } from "@/palmas/boot";
import type { Engine } from "@/palmas/engine/core";
import { detectQuality } from "@/palmas/engine/core";
import HUD from "@/palmas/ui/HUD";
import { useWorldStamp } from "@/hooks/use-world-stamp";

export default function SanPalmas() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/san-palmas", "San Palmas");

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    (async () => {
      try {
        const { engine: eng } = await boot(
          { canvas, quality: detectQuality() },
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
        eng.on("palmas:lock", (v) => setLocked(Boolean(v)));
        eng.start();
        setReady(true);
        if (shotMode) {
          (window as unknown as Record<string, unknown>).__palmas = eng;
          (window as unknown as Record<string, unknown>).__palmasReady = true;
        }
      } catch (err) {
        console.error("[San Palmas] boot failed", err);
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
  }, [shotMode]);

  const enter = useCallback(() => {
    canvasRef.current?.requestPointerLock?.();
  }, []);

  return (
    <div className="fixed inset-0 bg-black">
      <canvas ref={canvasRef} className="block h-full w-full touch-none outline-none" />

      {ready && engine && <HUD engine={engine} locked={locked || shotMode} />}

      {/* Loading / pause veil */}
      {(!ready || !locked) && !shotMode && !error && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-gradient-to-b from-[#04121c]/95 via-[#06202c]/90 to-[#02090f]/95 backdrop-blur-sm">
          <p className="text-xs uppercase tracking-[0.5em] text-teal-300/70">The Vibeverse presents</p>
          <h1 className="mt-3 bg-gradient-to-b from-amber-100 to-amber-400 bg-clip-text text-6xl font-black tracking-tight text-transparent drop-shadow-[0_2px_24px_rgba(251,191,36,0.35)] sm:text-8xl">
            SAN PALMAS
          </h1>
          <p className="mt-2 max-w-md text-center text-sm text-teal-100/70">
            Tropical San Francisco. Grapple the towers, wingsuit the bay, and leave
            the cartel's fuel depots as smoke on the horizon.
          </p>

          {!ready ? (
            <div className="mt-10 w-72">
              <div className="h-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-teal-300 to-amber-300 transition-[width] duration-300"
                  style={{ width: `${Math.round(progress.fraction * 100)}%` }}
                />
              </div>
              <p className="mt-2 text-center font-mono text-[11px] uppercase tracking-widest text-teal-200/60">
                {progress.stage}…
              </p>
            </div>
          ) : (
            <>
              <button
                onClick={enter}
                className="mt-10 rounded-full bg-amber-400 px-10 py-3 text-sm font-bold uppercase tracking-[0.2em] text-slate-900 shadow-[0_0_40px_rgba(251,191,36,0.4)] transition hover:bg-amber-300"
              >
                Drop in
              </button>
              <div className="mt-8 grid grid-cols-2 gap-x-10 gap-y-1.5 font-mono text-[11px] text-teal-100/50 sm:grid-cols-3">
                <span><b className="text-teal-200/80">WASD</b> move</span>
                <span><b className="text-teal-200/80">Shift</b> sprint</span>
                <span><b className="text-teal-200/80">Space</b> jump</span>
                <span><b className="text-teal-200/80">Mouse</b> look / fire</span>
                <span><b className="text-teal-200/80">Q</b> grapple</span>
                <span><b className="text-teal-200/80">F</b> wingsuit</span>
                <span><b className="text-teal-200/80">R</b> reload</span>
                <span><b className="text-teal-200/80">E</b> interact</span>
                <span><b className="text-teal-200/80">1-9</b> weapons</span>
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
          <h2 className="text-xl font-bold text-red-400">San Palmas failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <Link to="/" className="mt-4 text-xs uppercase tracking-widest text-teal-300">
            ← back to the vibeverse
          </Link>
        </div>
      )}
    </div>
  );
}
