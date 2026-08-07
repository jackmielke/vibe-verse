/**
 * SOAKED — the vibeverse's water fight.
 *
 * Same island and the same 22 systems as `/drop-zero`; the difference is one
 * word in the boot options. `mode: "water"` puts `ctx.mode === "water"` in
 * front of every system, and each of them looks up `mode/water.ts` instead of
 * its classic values: soakers instead of rifles, dryness instead of health,
 * the Downpour instead of the storm. Drop Zero is live and its loop is
 * verified, so nothing here forks it — a second battle royale would mean
 * every bug fixed twice.
 *
 * The React layer stays as thin as Drop Zero's: mount the canvas, run boot,
 * render the HUD off engine events. What is new is the lobby veil, because
 * this mode is meant to be played with friends and a game you cannot invite
 * anyone to is a single-player game with extra steps.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { boot } from "@/royale/boot";
import type { Engine } from "@/royale/engine/core";
import { detectQuality } from "@/royale/engine/core";
import HUD from "@/royale/ui/HUD";
import Lobby from "@/royale/ui/Lobby";
import { useVibeIdentity } from "@/hooks/use-vibe-identity";
import { useWorldStamp } from "@/hooks/use-world-stamp";

export default function Soaked() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/soaked", "Soaked");

  const { displayName } = useVibeIdentity();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [progress, setProgress] = useState({ stage: "Booting", fraction: 0 });
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `?shot=1` drops the lobby veil and exposes the engine on `window` so the
  // automated capture harness can pose the camera and grab frames.
  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  /**
   * `?q=high` forces a quality tier.
   *
   * Capture runs in this container auto-detect `medium`, because the box has
   * no GPU and `detectQuality` reads deviceMemory and core count — so every
   * automated frame is the low-end path, not the one a visitor with a real
   * GPU gets. Same reasoning as Drop Zero's; same escape hatch.
   */
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
          { canvas, quality: forcedQuality ?? detectQuality(), mode: "water" },
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
          // `__dz` is what scripts/dz-shot.mjs and dz-play.mjs already look
          // for; `__soaked` is the name this mode answers to. Both point at
          // the same engine so either harness works unchanged.
          (window as unknown as Record<string, unknown>).__dz = eng;
          (window as unknown as Record<string, unknown>).__soaked = eng;
          (window as unknown as Record<string, unknown>).__dzReady = true;
        }
      } catch (err) {
        console.error("[SOAKED] boot failed", err);
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
  }, [shotMode, forcedQuality]);

  const enter = useCallback(() => {
    // Input is gated on pointer lock — `player.controllable` is false without
    // it, so this click is what actually turns the controls on.
    canvasRef.current?.requestPointerLock?.();
    // Browsers gate audio behind a gesture; this click is the only one we get.
    engineRef.current?.ctx.services.audio?.resume();
  }, []);

  return (
    <div className="fixed inset-0 bg-[#3fb8ee]">
      <canvas ref={canvasRef} className="block h-full w-full touch-none outline-none" />

      {ready && engine && <HUD engine={engine} locked={locked || shotMode} />}

      {/* Lobby veil: entry, room code, roster. Unmounts once the pointer
          locks, which also stops its roster poll. */}
      {(!ready || !locked) && !shotMode && !error && (
        <Lobby
          engine={engine}
          ready={ready}
          progress={progress}
          onDropIn={enter}
          defaultName={displayName}
        />
      )}

      {error && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-[#04314b]/95 p-8 text-center">
          <h2 className="text-xl font-bold text-amber-300">SOAKED failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <Link to="/" className="mt-4 text-xs uppercase tracking-widest text-cyan-200">
            ← back to the vibeverse
          </Link>
        </div>
      )}
    </div>
  );
}
