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
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#020913]">
      <canvas ref={canvasRef} className="block h-full w-full touch-none select-none outline-none" />

      {engine && <DeepUI engine={engine} ready={ready} progress={progress} />}

      {error && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/90 p-8 text-center">
          <h2 className="text-xl font-bold text-red-400">The Midnight Zone failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <a href="/" className="mt-4 text-xs uppercase tracking-widest text-cyan-300">
            ← back to the vibeverse
          </a>
        </div>
      )}
    </div>
  );
}
