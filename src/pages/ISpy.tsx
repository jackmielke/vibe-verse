/**
 * I SPY — the page.
 *
 * Thin, like every other world here: it mounts a canvas, hands it to the
 * engine, and renders chrome off engine events. Everything that moves lives
 * in `src/ispy/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ISpyEngine, type ISpyStatus } from "@/ispy/engine";
import { useWorldStamp } from "@/hooks/use-world-stamp";

export default function ISpy() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/i-spy", "I Spy");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<ISpyEngine | null>(null);
  const [status, setStatus] = useState<ISpyStatus | null>(null);
  // ?shot — scripts/ispy-shot.mjs wants the game and nothing else: no title
  // card over the frame, no HUD, just the world the way it plays.
  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");
  const [menu, setMenu] = useState(!shotMode);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let engine: ISpyEngine | null = null;
    try {
      engine = new ISpyEngine(canvas);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    engineRef.current = engine;
    // Hand the engine to the capture script so world-card art can be a real
    // frame from the running game instead of a drawing of one.
    if (new URLSearchParams(window.location.search).has("shot")) {
      (window as unknown as Record<string, unknown>).__ispy = engine;
    }
    const unsubscribe = engine.subscribe(setStatus);
    const onResize = () => engineRef.current?.resize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      unsubscribe();
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  const start = useCallback(() => {
    setMenu(false);
    engineRef.current?.play();
  }, []);

  const quit = useCallback(() => {
    setMenu(true);
    engineRef.current?.attract();
  }, []);

  // Enter / Space from the title screen starts a run, so a keyboard player
  // never has to reach for the mouse.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Enter" || e.code === "Space") {
        e.preventDefault();
        start();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, start]);

  const pct = status ? status.percent : 0;
  const best = status ? status.best : 0;
  const won = status?.phase === "won";

  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full touch-none outline-none" />

      {/* ── in-run HUD ────────────────────────────────────────────────── */}
      {!menu && status && !shotMode && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 px-3 pt-3 sm:px-6 sm:pt-5">
            <div className="mx-auto flex max-w-3xl items-center gap-3">
              <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-white/12 ring-1 ring-white/20">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-fuchsia-400 via-pink-400 to-amber-300 transition-[width] duration-75"
                  style={{ width: `${pct}%` }}
                />
                {best > 1 && best < 100 && (
                  <div
                    className="absolute inset-y-0 w-[2px] bg-white/80"
                    style={{ left: `${best}%` }}
                    title={`best ${best.toFixed(0)}%`}
                  />
                )}
              </div>
              <span className="w-12 text-right font-mono text-sm font-bold tabular-nums text-white/90">
                {pct.toFixed(0)}%
              </span>
            </div>
            <div className="mx-auto mt-1.5 flex max-w-3xl items-center justify-between font-mono text-[10px] uppercase tracking-[0.25em] text-white/45">
              <span>{status.chapter}</span>
              <span>attempt {status.attempts}</span>
            </div>
          </div>

          {/* Spy pulse: the only thing in the game that tells you the truth. */}
          <button
            onClick={() => engineRef.current?.firePulse()}
            disabled={status.pulses === 0 || status.phase !== "playing"}
            className="absolute bottom-5 right-5 z-20 flex h-16 w-16 flex-col items-center justify-center rounded-full border border-white/25 bg-white/10 backdrop-blur transition active:scale-90 disabled:opacity-25 sm:bottom-8 sm:right-8"
          >
            <span className="text-xl leading-none">👁</span>
            <span className="mt-0.5 font-mono text-[10px] tabular-nums text-white/70">
              {status.pulses}
            </span>
          </button>

          <div className="absolute bottom-5 left-5 z-20 flex items-center gap-2 sm:bottom-8 sm:left-8">
            <button
              onClick={quit}
              className="rounded-full border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-white/50 backdrop-blur transition hover:text-white/90"
            >
              menu
            </button>
            <button
              onClick={() => engineRef.current?.toggleMute()}
              className="rounded-full border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-white/50 backdrop-blur transition hover:text-white/90"
            >
              {status.muted ? "unmute" : "mute"}
            </button>
          </div>

          {won && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70 px-6 backdrop-blur-sm">
              <p className="font-mono text-[11px] uppercase tracking-[0.5em] text-fuchsia-300">
                you saw it coming
              </p>
              <h2 className="mt-3 text-6xl font-black tracking-tight text-white drop-shadow-[0_0_40px_rgba(255,47,191,0.6)]">
                100%
              </h2>
              <p className="mt-3 font-mono text-xs text-white/50">
                {status.attempts} attempt{status.attempts === 1 ? "" : "s"}
                {status.practice ? " · practice" : ""}
              </p>
              <div className="mt-8 flex gap-3">
                <button
                  onClick={start}
                  className="rounded-full bg-fuchsia-400 px-8 py-3 text-xs font-bold uppercase tracking-[0.2em] text-black transition active:scale-95"
                >
                  again
                </button>
                <Link
                  to="/"
                  className="rounded-full border border-white/20 px-8 py-3 text-xs font-bold uppercase tracking-[0.2em] text-white/70 transition hover:text-white"
                >
                  the vibeverse
                </Link>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── title screen ──────────────────────────────────────────────── */}
      {menu && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center px-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.5em] text-fuchsia-300/70">
            The vibeverse presents
          </p>
          <h1 className="mt-3 text-center text-6xl font-black tracking-tighter text-white drop-shadow-[0_0_50px_rgba(255,47,191,0.55)] sm:text-8xl">
            I SPY
          </h1>
          <p className="mt-4 max-w-md text-center text-sm leading-relaxed text-white/60">
            A one-button auto-runner where most of what you can see is a lie.
            Two thirds of the spikes on screen cannot hurt you, and the ones
            that can are hiding in with them.
          </p>

          <button
            onClick={start}
            className="mt-9 rounded-full bg-fuchsia-400 px-14 py-4 text-sm font-bold uppercase tracking-[0.25em] text-black shadow-[0_0_50px_rgba(255,47,191,0.45)] transition active:scale-95"
          >
            {best > 0 ? "attempt again" : "attempt"}
          </button>

          {best > 0 && (
            <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.3em] text-white/40">
              best {best.toFixed(0)}%
            </p>
          )}

          <button
            onClick={() => engineRef.current?.setPractice(!status?.practice)}
            className={`mt-7 rounded-full border px-5 py-2 font-mono text-[10px] uppercase tracking-[0.25em] transition ${
              status?.practice
                ? "border-emerald-300/60 bg-emerald-300/15 text-emerald-200"
                : "border-white/15 text-white/45 hover:text-white/80"
            }`}
          >
            practice mode {status?.practice ? "on" : "off"}
          </button>
          <p className="mt-2 max-w-xs text-center text-[11px] leading-relaxed text-white/30">
            Practice rewinds you a second instead of back to the start.
          </p>

          <div className="mt-8 grid max-w-md grid-cols-1 gap-1.5 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-white/35 sm:grid-cols-3">
            <span>space / tap — jump &amp; fly</span>
            <span>E / right-click — spy pulse</span>
            <span>R — restart</span>
          </div>
          <p className="mt-5 max-w-sm text-center text-[11px] leading-relaxed text-white/35">
            Three pulses per attempt. A pulse dims every decoy on screen and
            outlines everything that is actually going to kill you.
          </p>

          <Link
            to="/"
            className="absolute bottom-6 font-mono text-[10px] uppercase tracking-[0.3em] text-white/25 transition hover:text-white/60"
          >
            ← back to the vibeverse
          </Link>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black/90 p-8 text-center">
          <h2 className="text-xl font-bold text-red-400">I Spy failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <Link to="/" className="mt-4 font-mono text-xs uppercase tracking-widest text-fuchsia-300">
            ← back to the vibeverse
          </Link>
        </div>
      )}
    </div>
  );
}
