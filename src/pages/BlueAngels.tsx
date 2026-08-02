/**
 * BLUE ANGELS — Seafair over Seattle.
 *
 * The React layer is deliberately thin: mount a canvas, run the boot sequence,
 * hand the engine to the UI. Everything that flies lives in `src/angels/`.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { boot } from "@/angels/boot";
import { detectQuality, isShotMode, type Engine } from "@/angels/engine/core";
import AngelsUI from "@/angels/ui/AngelsUI";
import { useWorldStamp } from "@/hooks/use-world-stamp";

export default function BlueAngels() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/blue-angels", "Blue Angels");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [progress, setProgress] = useState({ stage: "Booting", fraction: 0 });
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
          (window as unknown as Record<string, unknown>).__angels = eng;
          (window as unknown as Record<string, unknown>).__angelsReady = true;
        }
      } catch (err) {
        console.error("[Blue Angels] boot failed", err);
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
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#040a18]">
      <canvas ref={canvasRef} className="block h-full w-full touch-none select-none outline-none" />

      {engine && !error && <AngelsUI engine={engine} ready={ready} progress={progress} />}

      {error && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black/90 p-8 text-center">
          <h2 className="text-xl font-bold text-red-400">Blue Angels failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <Link to="/" className="mt-4 text-xs uppercase tracking-widest text-sky-300">
            ← back to the vibeverse
          </Link>
        </div>
      )}
    </div>
  );
}
