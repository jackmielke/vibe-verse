/**
 * The Midnight Zone — a descent into the deep ocean.
 *
 * This file is only the shell: mount the canvas, run the boot sequence, hand
 * the live engine to the UI layer. Everything that moves lives in `src/deep/`.
 */
import { useEffect, useRef, useState } from "react";
import { bootDeep } from "@/deep/boot";
import { detectDeepQuality, isShotMode, type DeepEngine } from "@/deep/engine/core";
import DeepUI from "@/deep/ui/DeepUI";
import { useWorldStamp } from "@/hooks/use-world-stamp";

export default function TheDeep() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/deep", "The Midnight Zone");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<DeepEngine | null>(null);
  const [engine, setEngine] = useState<DeepEngine | null>(null);
  const [progress, setProgress] = useState({ stage: "Sealing the hatch", fraction: 0 });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by the retry button; re-runs the whole boot effect. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    (async () => {
      try {
        const { engine: eng } = await bootDeep(
          { canvas, quality: detectDeepQuality() },
          (stage, fraction) => !cancelled && setProgress({ stage, fraction }),
        );
        if (cancelled) {
          eng.dispose();
          return;
        }
        engineRef.current = eng;
        setEngine(eng);
        // A context lost mid-dive is not a crash and must not read like one.
        eng.on("engine:contextlost", (() => {
          setError(
            "The browser took the 3D context back — usually a GPU reset, or too many worlds " +
              "open in other tabs.",
          );
        }) as (p: never) => void);
        eng.start();
        setReady(true);
        if (isShotMode() || import.meta.env.DEV) {
          // The screenshot harness drives the engine directly, and the same
          // handle is how a dev session poses the sub from the console.
          (window as unknown as Record<string, unknown>).__deep = eng;
          (window as unknown as Record<string, unknown>).__deepReady = true;
        }
      } catch (err) {
        console.error("[The Deep] boot failed", err);
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
      // Browsers cap live WebGL contexts and audio contexts alike, and a world
      // that leaks one breaks the *next* world a visitor opens.
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [attempt]);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#020913]">
      <canvas ref={canvasRef} className="block h-full w-full touch-none select-none outline-none" />

      {engine && <DeepUI engine={engine} ready={ready} progress={progress} />}

      {/* A failure here is nearly always the browser refusing another WebGL
          context, which is temporary and fixable — so the screen says what
          happened and offers the two things that actually work, rather than
          being a black rectangle with a stack trace on it. */}
      {error && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-[#020913]/95 p-8 text-center">
          <h2 className="text-lg font-bold uppercase tracking-[0.3em] text-cyan-300">
            The dive could not start
          </h2>
          <p className="max-w-md text-sm leading-relaxed text-white/70">{error}</p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => {
                setError(null);
                setReady(false);
                setEngine(null);
                setAttempt((n) => n + 1);
              }}
              className="rounded-xl border border-cyan-300/40 bg-cyan-400/10 px-5 py-2 text-xs font-bold uppercase tracking-widest text-cyan-200 hover:bg-cyan-400/20"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-xl border border-white/20 px-5 py-2 text-xs font-bold uppercase tracking-widest text-white/70 hover:border-white/40"
            >
              Reload the page
            </button>
            <a
              href="/"
              className="rounded-xl border border-white/20 px-5 py-2 text-xs font-bold uppercase tracking-widest text-white/70 hover:border-white/40"
            >
              Back to the vibeverse
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
