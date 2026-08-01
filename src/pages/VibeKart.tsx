/**
 * Vibe Kart — a Mario-Kart-shaped arcade racer for the vibeverse.
 *
 * This file is only the shell: mount the canvas, run the boot sequence, hand
 * the live engine to the UI layer. Everything that moves lives in `src/kart/`.
 */
import { useEffect, useRef, useState } from "react";
import { bootKart } from "@/kart/boot";
import { detectKartQuality, isShotMode, type KartEngine } from "@/kart/engine/core";
import KartUI from "@/kart/ui/KartUI";

export default function VibeKart() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<KartEngine | null>(null);
  const [engine, setEngine] = useState<KartEngine | null>(null);
  const [progress, setProgress] = useState({ stage: "Booting", fraction: 0 });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    (async () => {
      try {
        const { engine: eng } = await bootKart(
          { canvas, quality: detectKartQuality() },
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
        if (isShotMode()) {
          // The screenshot harness drives the engine directly.
          (window as unknown as Record<string, unknown>).__kart = eng;
          (window as unknown as Record<string, unknown>).__kartReady = true;
        }
      } catch (err) {
        console.error("[Vibe Kart] boot failed", err);
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
    <div className="fixed inset-0 overflow-hidden bg-[#07101c]">
      <canvas ref={canvasRef} className="block h-full w-full touch-none select-none outline-none" />

      {engine && <KartUI engine={engine} ready={ready} progress={progress} />}

      {error && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/90 p-8 text-center">
          <h2 className="text-xl font-bold text-red-400">Vibe Kart failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <a href="/" className="mt-4 text-xs uppercase tracking-widest text-amber-300">
            ← back to the vibeverse
          </a>
        </div>
      )}
    </div>
  );
}
