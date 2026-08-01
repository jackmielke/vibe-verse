/**
 * FIVE NIGHTS AT VIBEY'S — the vibeverse's night-shift horror world.
 *
 * A thin page, per the house rules: it owns the menus, mounts the canvas, and
 * renders the HUD off engine snapshots. Everything that moves lives in
 * `src/fnaf/`, and `src/fnaf/README.md` explains why the office is one scene
 * rather than eleven.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
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

/** A phone has no keys, so on a touch device the key column is a lie. */
const COARSE_POINTER =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;

const KEYBOARD_CONTROLS: Array<[string, string]> = [
  ["MOUSE", "look around the office"],
  ["A / D", "west door / east door"],
  ["Q / E", "west light / east light"],
  ["SPACE", "raise and lower the monitor"],
  ["1 … 0 -", "switch cameras"],
  ["W / S", "nothing. you stay in the chair"],
];

const TOUCH_CONTROLS: Array<[string, string]> = [
  ["DRAG", "look around the office"],
  ["DOOR", "the button by each doorway"],
  ["LIGHT", "below it — shows who is stood there"],
  ["CAMERAS", "the tab at the bottom of the screen"],
  ["THE MAP", "tap a room to switch feed"],
  ["WALKING", "there isn't any. you stay in the chair"],
];

function TitleScreen({ cleared, onStart }: { cleared: number; onStart: (n: number) => void }) {
  const unlocked = Math.min(NIGHT_COUNT, cleared + 1);
  const controls = COARSE_POINTER ? TOUCH_CONTROLS : KEYBOARD_CONTROLS;
  return (
    /*
     * Two things this layout has to survive, both of which it previously did
     * not. It sits on top of a *live* office, so the scrim has to carry the
     * text on its own — a 3% gap was enough for a lit animatronic behind it to
     * read straight through the title. And on a tall narrow phone the content
     * is taller than the viewport, so it scrolls rather than piling on top of
     * itself.
     */
    <div className="absolute inset-0 z-30 overflow-y-auto overscroll-contain bg-black/80 backdrop-blur-md font-mono">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(120,20,20,0.18),transparent_65%)]" />
      <div
        className="relative flex min-h-full flex-col items-center justify-center gap-y-1 px-5 py-10"
        style={{ paddingTop: "max(2.5rem, env(safe-area-inset-top))", paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))" }}
      >
        <p className="text-center text-[9px] uppercase tracking-[0.45em] text-red-400/60 sm:text-[10px] sm:tracking-[0.5em]">
          The Vibeverse presents
        </p>
        <h1 className="mt-3 text-center text-[2.1rem] font-black leading-[0.95] tracking-tight text-[#e6ddc8] drop-shadow-[0_2px_30px_rgba(220,38,38,0.4)] sm:text-6xl">
          FIVE NIGHTS
          <span className="mt-1 block text-lg tracking-[0.28em] text-red-500/90 sm:text-3xl">
            AT VIBEY&apos;S
          </span>
        </h1>
        <p className="mt-4 max-w-md text-balance text-center text-[11px] leading-relaxed tracking-wide text-white/50">
          Midnight to six. Two doors, two lights, eleven cameras and one battery.
          The animatronics walk the building on their own — you only ever see
          where they were.
        </p>

        <div className="mt-7 flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
          {Array.from({ length: NIGHT_COUNT }, (_, i) => i + 1).map((n) => {
            const locked = n > unlocked;
            return (
              <button
                key={n}
                disabled={locked}
                onClick={() => onStart(n)}
                className={`h-11 w-11 rounded-md border text-sm font-bold transition sm:h-12 sm:w-12 ${
                  locked
                    ? "cursor-not-allowed border-white/10 text-white/15"
                    : "border-red-500/45 bg-red-600/20 text-red-200 active:scale-95 hover:bg-red-600/40"
                }`}
                title={locked ? "Survive the night before it" : `Night ${n}`}
              >
                {n === NIGHT_COUNT ? "★" : n}
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-center text-[10px] tracking-[0.25em] text-white/30">
          {cleared > 0 ? `NIGHTS CLEARED: ${cleared}` : "SELECT A NIGHT"}
        </p>

        <div className="mt-8 grid w-full max-w-md grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[10px] leading-snug tracking-[0.12em] text-white/35 sm:gap-x-8">
          {controls.map(([key, what]) => (
            <Fragment key={key}>
              <span className="whitespace-nowrap">{key}</span>
              <span className="text-white/55">{what}</span>
            </Fragment>
          ))}
        </div>

        <Link
          to="/"
          className="mt-9 text-[10px] uppercase tracking-[0.3em] text-white/30 transition hover:text-white/70"
        >
          ← back to the vibeverse
        </Link>
      </div>
    </div>
  );
}
