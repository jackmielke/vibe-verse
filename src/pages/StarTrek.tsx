/**
 * THE FINAL FRONTIER — the vibeverse's bridge simulator.
 *
 * The React layer is deliberately thin: mount a canvas, run the boot sequence,
 * hand the engine to the overlay. Everything that flies, shoots or reports a
 * shield percentage lives in `src/trek/`.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { boot } from "@/trek/boot";
import { detectQuality, isShotMode, type Engine } from "@/trek/engine/core";
import BridgeUI from "@/trek/ui/BridgeUI";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";

export default function StarTrek() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/trek", "The Final Frontier");
  // The one thing the hub knows that this world can use: your name. Starfleet
  // addresses the person in the chair, and it costs one string to do it.
  const { displayName } = useVibeIdentity();

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
        (eng.ctx.services as Record<string, unknown>).captain = displayName;
        engineRef.current = eng;
        setEngine(eng);
        eng.start();
        setReady(true);
        if (isShotMode()) {
          (window as unknown as Record<string, unknown>).__trek = eng;
          (window as unknown as Record<string, unknown>).__trekReady = true;
        }
      } catch (err) {
        console.error("[Final Frontier] boot failed", err);
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
    // The name is read once at boot; a rename mid-episode is not worth tearing
    // the ship down and rebuilding her for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full touch-none select-none outline-none" />

      {engine && !error && <BridgeUI engine={engine} ready={ready} progress={progress} />}

      {error && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/92 p-8 text-center">
          <h2 className="text-xl font-bold text-red-400">The Final Frontier failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <Link to="/" className="mt-4 font-mono text-[10px] uppercase tracking-[0.3em] text-amber-300">
            ← back to the vibeverse
          </Link>
        </div>
      )}
    </div>
  );
}
