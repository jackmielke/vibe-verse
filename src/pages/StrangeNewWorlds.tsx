/**
 * STRANGE NEW WORLDS — the vibeverse's Star Trek exploration sim.
 *
 * The React layer is deliberately thin, exactly as `/trek`'s is: mount a
 * canvas, build the game, hand the game to the overlay, tear it down on
 * unmount. Everything that warps, orbits, rains or answers a hail lives under
 * `src/starfleet/`.
 *
 * The `cancelled` guard is not optional. React StrictMode double-mounts every
 * effect in development, and without it the first WebGL context is never
 * released — browsers cap live contexts at around sixteen, so the world that
 * leaks one breaks whichever world a visitor opens *next*, which is a
 * miserable thing to debug from the outside.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { createGame, type Game } from "@/starfleet/game";
import Lcars from "@/starfleet/ui/Lcars";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";

export default function StrangeNewWorlds() {
  useWorldStamp("/strange-new-worlds", "Strange New Worlds");
  // The one thing the hub knows that this world can use: your name. Starfleet
  // addresses the person in the chair, and it costs one string to do it.
  const { displayName } = useVibeIdentity();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gameRef = useRef<Game | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let g: Game | null = null;

    try {
      g = createGame({ canvas, captain: displayName });
      if (cancelled) {
        g.dispose();
        return;
      }
      gameRef.current = g;
      setGame(g);
      g.start();
      // The screenshot harness drives this handle; see scripts/route-shot.mjs.
      (window as unknown as Record<string, unknown>).__snw = g;
    } catch (err) {
      console.error("[Strange New Worlds] failed to boot", err);
      setError(err instanceof Error ? err.message : String(err));
    }

    const onResize = () => gameRef.current?.resize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      gameRef.current?.dispose();
      gameRef.current = null;
      delete (window as unknown as Record<string, unknown>).__snw;
    };
    // The name is read once at boot. A rename mid-mission is not worth tearing
    // the ship down and rebuilding her for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none select-none outline-none"
        onClick={() => gameRef.current?.requestPointerLock()}
      />

      {game && !error && <Lcars game={game} />}

      {error && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/92 p-8 text-center">
          <h2 className="text-xl font-bold text-red-400">Strange New Worlds failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <Link to="/" className="mt-4 font-mono text-[10px] uppercase tracking-[0.3em] text-amber-300">
            ← back to the vibeverse
          </Link>
        </div>
      )}
    </div>
  );
}
