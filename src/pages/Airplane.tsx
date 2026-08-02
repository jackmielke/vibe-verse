/**
 * AIRPLANE! — Trans American Flight 209.
 *
 * The React layer is deliberately thin: mount a canvas, run the boot sequence,
 * hand the engine to the UI. Everything that flies lives in `src/airplane/`.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { boot } from "@/airplane/boot";
import { detectQuality, isShotMode, type Engine } from "@/airplane/engine/core";
import AirplaneUI from "@/airplane/ui/AirplaneUI";
import { useWorldStamp } from "@/hooks/use-world-stamp";

export default function Airplane() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/airplane", "Airplane!");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [progress, setProgress] = useState({ stage: "Boarding", fraction: 0 });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        // StrictMode double-mounts in development; without this guard the
        // first engine keeps its WebGL context for ever and the next world a
        // visitor opens renders black.
        if (cancelled) {
          eng.dispose();
          return;
        }
        engineRef.current = eng;
        setEngine(eng);
        eng.start();
        setReady(true);
        if (isShotMode()) {
          (window as unknown as Record<string, unknown>).__flight209 = eng;
          (window as unknown as Record<string, unknown>).__flight209Ready = true;
        }
      } catch (err) {
        console.error("[Flight 209] boot failed", err);
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    const onResize = () => engineRef.current?.resize();
    // A tab nobody is looking at should not burn a phone's battery flying an
    // aeroplane into Illinois.
    const onVisibility = () => {
      const eng = engineRef.current;
      if (eng) eng.paused = document.hidden;
    };

    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#07080c]">
      <canvas ref={canvasRef} className="block h-full w-full touch-none select-none outline-none" />

      {engine && !error && <AirplaneUI engine={engine} ready={ready} progress={progress} />}

      {error && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black/90 p-8 text-center">
          <h2 className="text-xl font-bold text-red-400">Flight 209 failed to board</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <Link to="/" className="mt-4 text-xs uppercase tracking-widest text-amber-300">
            ← back to the vibeverse
          </Link>
        </div>
      )}
    </div>
  );
}
