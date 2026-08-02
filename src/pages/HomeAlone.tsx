/**
 * HOME ALONE — the vibeverse's first film-as-a-world.
 *
 * A thin page, per the house rules: it owns the title screen, mounts the
 * canvas, and renders the HUD off engine snapshots. Everything that moves
 * lives in `src/homealone/`, and `src/homealone/README.md` explains why the
 * house is one continuous scene with real stairs in it.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { HomeAloneEngine, type Snapshot } from "@/homealone/engine";
import { LEVELS, LEVEL_COUNT } from "@/homealone/levels";
import HomeAloneHUD from "@/homealone/ui/HomeAloneHUD";
import { useWorldStamp } from "@/hooks/use-world-stamp";

export default function HomeAlone() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/home-alone", "Home Alone");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<HomeAloneEngine | null>(null);
  const [engine, setEngine] = useState<HomeAloneEngine | null>(null);
  const [state, setState] = useState<Snapshot | null>(null);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let eng: HomeAloneEngine | null = null;
    try {
      eng = new HomeAloneEngine(canvas);
      engineRef.current = eng;
      setEngine(eng);
      eng.resize();
      eng.start();
    } catch (err) {
      console.error("[Home Alone] boot failed", err);
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    const off = eng.on(setState);
    const onResize = () => engineRef.current?.resize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    // A leaked WebGL context breaks the *next* world somebody opens from the
    // hub, which is the whole reason this rule exists.
    return () => {
      off();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  const select = useCallback((n: number) => engineRef.current?.select(n), []);
  const retry = useCallback(() => engineRef.current?.retry(), []);
  const next = useCallback(() => engineRef.current?.next(), []);
  const menu = useCallback(() => engineRef.current?.toMenu(), []);
  /* Jump straight into a mode from the in-game switcher: pick it, and start
     it, without a brief card in between. Somebody who is already playing has
     read the brief once. */
  const pick = useCallback((n: number) => {
    engineRef.current?.select(n);
    engineRef.current?.begin();
  }, []);

  // Card-art capture drives the world without a human: ?shot=1 skips the menu.
  const shot = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");
  useEffect(() => {
    if (!shot || !engine || !state || state.phase !== "menu") return;
    const params = new URLSearchParams(window.location.search);
    engine.setMuted(true);
    engine.select(Number(params.get("level") ?? 6) || 6);
    const w = window as unknown as Record<string, unknown>;
    w.__homeAlone = engine;
    // `begin()` re-spawns the player, so the harness must not pose the camera
    // until after it has run — hence a separate ready flag rather than just
    // the engine handle. Racing this made every capture come out identical,
    // at the spawn point, which reads exactly like a broken camera.
    window.setTimeout(() => {
      engine.begin();
      w.__homeAloneReady = true;
    }, 250);
  }, [shot, engine, state]);

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full touch-none select-none outline-none" />

      {engine && state && state.phase !== "menu" && (
        <HomeAloneHUD engine={engine} state={state} onRetry={retry} onNext={next} onMenu={menu} onPick={pick} />
      )}

      {state?.phase === "menu" && !error && <TitleScreen cleared={state.cleared} onSelect={select} />}

      {state && state.phase !== "menu" && (
        <button
          onClick={() => {
            const m = !muted;
            setMuted(m);
            engineRef.current?.setMuted(m);
          }}
          className="absolute right-3 top-3 z-40 rounded-full border border-white/15 bg-black/50 px-2.5 py-1.5 font-mono text-[9px] tracking-[0.2em] text-white/45 transition hover:text-white/90"
          style={{ top: "max(0.75rem, env(safe-area-inset-top))" }}
        >
          {muted ? "SOUND OFF" : "SOUND ON"}
        </button>
      )}

      {error && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black/95 p-8 text-center">
          <h2 className="text-xl font-bold text-red-400">Home Alone failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <Link to="/" className="mt-4 font-mono text-xs uppercase tracking-widest text-amber-300">
            ← back to the vibeverse
          </Link>
        </div>
      )}
    </div>
  );
}

const COARSE =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;

const KEYS: Array<[string, string]> = [
  ["WASD", "walk — hold SHIFT to run"],
  ["MOUSE", "swing the camera round him"],
  ["E", "switches, traps, windows, ropes"],
  ["Q", "shout — makes them come to you"],
  ["SPACE", "Buzz's BB gun, once you've found it"],
  ["THE ARROW", "always points at what's next"],
];

const TOUCH: Array<[string, string]> = [
  ["STICK", "walk — the RUN pad makes him leg it"],
  ["DRAG RIGHT", "swing the camera round him"],
  ["● BUTTON", "switches, traps, windows, ropes"],
  ["SHOUT", "makes them come to you"],
  ["BB", "Buzz's gun, once you've found it"],
  ["THE ARROW", "always points at what's next"],
];

function TitleScreen({ cleared, onSelect }: { cleared: number; onSelect: (n: number) => void }) {
  /*
   * Nothing is locked.
   *
   * Gating level 4 behind level 3 is right for a game somebody bought and
   * wrong for one somebody opened from a link on a phone — the whole reason to
   * post this is "come and see the bit with the paint cans", and a person who
   * arrives wanting that should not first be made to light seven rooms. The
   * tick still marks what you have actually cleared, which is the part worth
   * keeping.
   */
  const controls = COARSE ? TOUCH : KEYS;
  return (
    /*
     * This sits on top of a *live* snowy street, so the scrim carries the text
     * on its own, and on a tall phone the content scrolls rather than piling
     * on top of itself. Both lessons are Five Nights', paid for once already.
     */
    <div className="absolute inset-0 z-30 overflow-y-auto overscroll-contain bg-black/72 font-mono backdrop-blur-[6px]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_28%,rgba(210,150,60,0.18),transparent_62%)]" />
      <div
        className="relative flex min-h-full flex-col items-center justify-center px-5 py-10"
        style={{ paddingTop: "max(2.5rem, env(safe-area-inset-top))", paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))" }}
      >
        <p className="text-center text-[9px] uppercase tracking-[0.44em] text-amber-300/50 sm:text-[10px]">
          The Vibeverse presents
        </p>
        <h1 className="mt-3 text-center text-[2.6rem] font-black leading-[0.9] tracking-tight text-[#f2e8d2] drop-shadow-[0_3px_36px_rgba(220,150,50,0.35)] sm:text-7xl">
          HOME
          <span className="mt-1 block text-[1.9rem] tracking-[0.22em] text-red-500/85 sm:text-5xl">ALONE</span>
        </h1>
        <p className="mt-5 max-w-md text-balance text-center text-[11px] leading-relaxed tracking-wide text-white/50">
          671 Lincoln Avenue, Winnetka, Illinois. Lights on the eaves, a tree
          in the window, three floors, sixteen rooms and a basement with a
          furnace in it — and two men outside who think the house is empty.
          It is not.
        </p>

        <div className="mt-8 flex w-full max-w-md flex-col gap-1.5">
          {LEVELS.filter((l) => l.n <= LEVEL_COUNT).map((l) => {
            return (
              <button
                key={l.n}
                onClick={() => onSelect(l.n)}
                className="flex items-center gap-3 rounded-lg border border-amber-200/20 bg-white/[0.03] px-3 py-2.5 text-left text-white/85 transition active:scale-[0.99] hover:border-amber-200/45 hover:bg-amber-500/10"
              >
                <span className="w-5 shrink-0 text-center text-sm font-black tabular-nums">{l.n}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-bold tracking-tight sm:text-sm">{l.title}</span>
                  <span className="block truncate text-[9px] uppercase tracking-[0.16em] text-white/30">{l.goal}</span>
                </span>
                {l.n <= cleared && <span className="shrink-0 text-[10px] text-amber-300/70">✓</span>}
              </button>
            );
          })}
          <button
            onClick={() => onSelect(6)}
            className="mt-1 rounded-lg border border-white/10 px-3 py-2.5 text-left text-white/60 transition hover:border-white/25 hover:bg-white/5"
          >
            <span className="block text-[12px] font-bold tracking-tight">Free roam</span>
            <span className="block text-[9px] uppercase tracking-[0.16em] text-white/25">
              No burglars, no clock. Just the house, the snow and the tree
            </span>
          </button>
        </div>

        <div className="mt-8 grid w-full max-w-md grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[10px] leading-snug tracking-[0.1em] text-white/30 sm:gap-x-8">
          {controls.map(([key, what]) => (
            <Fragment key={key}>
              <span className="whitespace-nowrap">{key}</span>
              <span className="text-white/50">{what}</span>
            </Fragment>
          ))}
        </div>

        <Link
          to="/"
          className="mt-9 text-[10px] uppercase tracking-[0.3em] text-white/25 transition hover:text-white/70"
        >
          ← back to the vibeverse
        </Link>
      </div>
    </div>
  );
}
