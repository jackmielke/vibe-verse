/**
 * Vibe Kart — a Mario-Kart-shaped arcade racer for the vibeverse.
 *
 * This file is only the shell: mount the canvas, run the boot sequence, hand
 * the live engine to the UI layer. Everything that moves lives in `src/kart/`.
 *
 * There is one Vibe Kart, not two. Single player and multiplayer used to be
 * separate routes with separate cards and separate copies of this shell, which
 * meant the first thing a player had to decide was one they could not yet have
 * an opinion about. Now the title screen asks — and `?room=CODE` on this URL
 * is the invite link, so a friend's link drops you straight into their lobby.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { bootKart } from "@/kart/boot";
import { detectKartQuality, isShotMode, type KartEngine } from "@/kart/engine/core";
import KartUI from "@/kart/ui/KartUI";
import { useWorldStamp } from "@/hooks/use-world-stamp";

export default function VibeKart() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/kart", "Vibe Kart");

  // Read once: after this the UI owns the room, and re-reading it would fight
  // the lobby for who decides which room you are in.
  const initialRoom = useRef(
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("room"),
  ).current;

  /**
   * Keep `?room=` in step so the address bar *is* the invite link.
   *
   * Written straight to history rather than through `useSearchParams`: this
   * fires while a WebGL race is running, and a router navigation would re-render
   * the tree that owns the canvas for a URL nobody navigated to.
   */
  const onRoomChange = useCallback((room: string | null) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (room) url.searchParams.set("room", room);
    else url.searchParams.delete("room");
    if (url.href !== window.location.href) window.history.replaceState(null, "", url);
  }, []);

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
        if (isShotMode() || import.meta.env.DEV) {
          // The screenshot harness drives the engine directly, and the same
          // handle is how a dev-server session inspects a live room — reading
          // `services.net.peers()` from the console beats guessing whether the
          // other kart on screen is a ghost or an AI.
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

      {engine && (
        <KartUI
          engine={engine}
          ready={ready}
          progress={progress}
          initialRoom={initialRoom}
          onRoomChange={onRoomChange}
        />
      )}

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
