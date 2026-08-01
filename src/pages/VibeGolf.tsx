/**
 * Vibe Golf — a Super-Stickman-Golf-shaped physics golf game for the
 * vibeverse. Phone-first: the whole game is one drag gesture.
 *
 * The React layer mounts the canvas, runs the boot sequence, and renders the
 * HUD off engine events. Everything that moves lives in `src/golf/`.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { bootGolf } from "@/golf/boot";
import { detectGolfQuality, type GolfEngine } from "@/golf/engine/core";
import GolfHUD from "@/golf/ui/GolfHUD";
import { useWorldStamp } from "@/hooks/use-world-stamp";

export default function VibeGolf() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/golf", "Vibe Golf");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<GolfEngine | null>(null);
  const [engine, setEngine] = useState<GolfEngine | null>(null);
  const [progress, setProgress] = useState({ stage: "Booting", fraction: 0 });
  const [ready, setReady] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    (async () => {
      try {
        const { engine: eng } = await bootGolf(
          { canvas, quality: detectGolfQuality() },
          (stage, fraction) => !cancelled && setProgress({ stage, fraction }),
        );
        if (cancelled) {
          eng.dispose();
          return;
        }
        engineRef.current = eng;
        setEngine(eng);
        eng.start();
        setReady(true);
        if (shotMode) {
          (window as unknown as Record<string, unknown>).__golf = eng;
          (window as unknown as Record<string, unknown>).__golfReady = true;
          setStarted(true);
        }
      } catch (err) {
        console.error("[Vibe Golf] boot failed", err);
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    const onResize = () => engineRef.current?.resize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [shotMode]);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#06121c]">
      <canvas ref={canvasRef} className="block h-full w-full touch-none select-none outline-none" />

      {ready && engine && started && <GolfHUD engine={engine} />}

      {(!ready || !started) && !error && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-gradient-to-b from-[#0a2540]/95 via-[#0d3b52]/92 to-[#06121c]/96 px-6 backdrop-blur-sm">
          <p className="text-[10px] uppercase tracking-[0.5em] text-emerald-300/70">The Vibeverse presents</p>
          <h1 className="mt-3 bg-gradient-to-b from-emerald-100 to-emerald-400 bg-clip-text text-center text-5xl font-black tracking-tight text-transparent drop-shadow-[0_2px_24px_rgba(52,211,153,0.35)] sm:text-7xl">
            VIBE GOLF
          </h1>
          <p className="mt-3 max-w-sm text-center text-sm text-emerald-100/70">
            Physics golf with portals, jetpacks and a bag full of very silly balls.
          </p>

          {!ready ? (
            <div className="mt-10 w-64">
              <div className="h-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-300 to-amber-300 transition-[width] duration-300"
                  style={{ width: `${Math.round(progress.fraction * 100)}%` }}
                />
              </div>
              <p className="mt-2 text-center font-mono text-[10px] uppercase tracking-widest text-emerald-200/60">
                {progress.stage}…
              </p>
            </div>
          ) : (
            <>
              <button
                onClick={() => setStarted(true)}
                className="mt-10 rounded-full bg-emerald-400 px-12 py-4 text-sm font-bold uppercase tracking-[0.2em] text-slate-900 shadow-[0_0_40px_rgba(52,211,153,0.4)] transition active:scale-95"
              >
                Tee off
              </button>
              <p className="mt-8 max-w-xs text-center text-[11px] leading-relaxed text-emerald-100/45">
                Drag back from the ball and release — like a slingshot.
                Pinch or scroll to zoom.
              </p>
            </>
          )}

          <Link
            to="/"
            className="absolute bottom-6 text-[10px] uppercase tracking-[0.3em] text-white/30 transition hover:text-white/60"
          >
            ← back to the vibeverse
          </Link>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black/90 p-8 text-center">
          <h2 className="text-xl font-bold text-red-400">Vibe Golf failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <Link to="/" className="mt-4 text-xs uppercase tracking-widest text-emerald-300">
            ← back to the vibeverse
          </Link>
        </div>
      )}
    </div>
  );
}
