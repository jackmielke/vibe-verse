/**
 * FIVE NIGHTS AT VIBEY'S — the vibeverse's night-shift horror world.
 *
 * A thin page, per the house rules: it owns the menus, mounts the canvas, and
 * renders the HUD off engine snapshots. Everything that moves lives in
 * `src/fnaf/`, and `src/fnaf/README.md` explains why the office is one scene
 * rather than eleven.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { FnafEngine, type FnafSnapshot } from "@/fnaf/engine";
import { NIGHT_COUNT } from "@/fnaf/ai";
import FnafHUD from "@/fnaf/ui/FnafHUD";
import { useWorldStamp } from "@/hooks/use-world-stamp";

function clearedNights() {
  try {
    return Number(localStorage.getItem("fnaf:cleared") ?? "0");
  } catch {
    return 0;
  }
}

export default function FiveNights() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/fnaf", "Five Nights at Vibey's");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<FnafEngine | null>(null);
  const [engine, setEngine] = useState<FnafEngine | null>(null);
  const [state, setState] = useState<FnafSnapshot | null>(null);
  const [started, setStarted] = useState(false);
  const [night, setNight] = useState(1);
  const [cleared, setCleared] = useState(0);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setCleared(clearedNights()), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let eng: FnafEngine | null = null;
    try {
      eng = new FnafEngine(canvas);
      engineRef.current = eng;
      setEngine(eng);
      eng.start();
    } catch (err) {
      console.error("[Five Nights] boot failed", err);
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    const off = eng.on(setState);
    const onResize = () => engineRef.current?.resize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    // The whole point of the tear-down rule: a leaked WebGL context breaks the
    // *next* world somebody opens from the hub.
    return () => {
      off();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  const begin = useCallback(
    (n: number) => {
      setNight(n);
      setStarted(true);
      engineRef.current?.startNight(n);
    },
    [],
  );

  const retry = useCallback(() => begin(night), [begin, night]);
  const next = useCallback(() => {
    const n = Math.min(NIGHT_COUNT, night + 1);
    setCleared(clearedNights());
    begin(n);
  }, [begin, night]);

  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  // Card-art capture drives the world without a human: ?shot=1 skips the menu.
  useEffect(() => {
    if (!shotMode || !engine || started) return;
    const params = new URLSearchParams(window.location.search);
    engine.setMuted(true);
    begin(Number(params.get("night") ?? 1) || 1);
    const cam = params.get("cam");
    if (cam) {
      window.setTimeout(() => {
        engine.toggleMonitor();
        engine.selectCamera(cam as never);
      }, 400);
    }
    (window as unknown as Record<string, unknown>).__fnaf = engine;
    (window as unknown as Record<string, unknown>).__fnafReady = true;
  }, [shotMode, engine, started, begin]);

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full touch-none select-none outline-none" />

      {engine && state && started && (
        <FnafHUD engine={engine} state={state} onRetry={retry} onNext={next} />
      )}

      {!started && !error && <TitleScreen cleared={cleared} onStart={begin} />}

      {/* Mute — the fan alone will drive a person out of a room. */}
      {started && (
        <button
          onClick={() => {
            const m = !muted;
            setMuted(m);
            engineRef.current?.setMuted(m);
          }}
          className="absolute right-6 bottom-6 z-20 rounded-full border border-white/15 bg-black/60 px-3 py-2 font-mono text-[10px] tracking-[0.25em] text-white/50 transition hover:text-white/90"
        >
          {muted ? "SOUND OFF" : "SOUND ON"}
        </button>
      )}

      {error && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black/95 p-8 text-center">
          <h2 className="text-xl font-bold text-red-400">Five Nights failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <Link to="/" className="mt-4 font-mono text-xs uppercase tracking-widest text-emerald-300">
            ← back to the vibeverse
          </Link>
        </div>
      )}
    </div>
  );
}

function TitleScreen({ cleared, onStart }: { cleared: number; onStart: (n: number) => void }) {
  const unlocked = Math.min(NIGHT_COUNT, cleared + 1);
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-gradient-to-b from-[#0b0a12]/97 via-[#120d10]/95 to-black/98 px-6 font-mono">
      <p className="text-[10px] uppercase tracking-[0.5em] text-red-400/60">The Vibeverse presents</p>
      <h1 className="mt-4 text-center text-4xl font-black leading-none tracking-tight text-[#e6ddc8] drop-shadow-[0_2px_30px_rgba(220,38,38,0.35)] sm:text-6xl">
        FIVE NIGHTS
        <span className="mt-1 block text-2xl tracking-[0.3em] text-red-500/90 sm:text-3xl">AT VIBEY&apos;S</span>
      </h1>
      <p className="mt-5 max-w-md text-center text-[11px] leading-relaxed tracking-wide text-white/45">
        Midnight to six. Two doors, two lights, eleven cameras and one battery.
        The animatronics walk the building on their own — you only ever see where
        they were.
      </p>

      <div className="mt-9 flex flex-wrap items-center justify-center gap-2">
        {Array.from({ length: NIGHT_COUNT }, (_, i) => i + 1).map((n) => {
          const locked = n > unlocked;
          return (
            <button
              key={n}
              disabled={locked}
              onClick={() => onStart(n)}
              className={`h-12 w-12 rounded border text-sm font-bold transition ${
                locked
                  ? "cursor-not-allowed border-white/8 text-white/15"
                  : "border-red-500/40 bg-red-600/15 text-red-200 hover:bg-red-600/35"
              }`}
              title={locked ? "Survive the night before it" : `Night ${n}`}
            >
              {n === 7 ? "★" : n}
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[10px] tracking-[0.25em] text-white/25">
        {cleared > 0 ? `NIGHTS CLEARED: ${cleared}` : "SELECT A NIGHT"}
      </p>

      <div className="mt-10 grid max-w-lg grid-cols-2 gap-x-8 gap-y-1.5 text-[10px] tracking-[0.14em] text-white/35">
        <span>MOUSE</span><span className="text-white/55">look around the office</span>
        <span>A / D</span><span className="text-white/55">west door / east door</span>
        <span>Q / E</span><span className="text-white/55">west light / east light</span>
        <span>SPACE</span><span className="text-white/55">raise and lower the monitor</span>
        <span>1 … 0 -</span><span className="text-white/55">switch cameras</span>
        <span>W / S</span><span className="text-white/55">nothing. you stay in the chair</span>
      </div>

      <Link
        to="/"
        className="absolute bottom-6 text-[10px] uppercase tracking-[0.35em] text-white/25 transition hover:text-white/60"
      >
        ← back to the vibeverse
      </Link>
    </div>
  );
}
