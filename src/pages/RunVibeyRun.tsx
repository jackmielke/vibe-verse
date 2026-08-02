/**
 * RUN, VIBEY, RUN — the vibeverse's life-story runner.
 *
 * A thin page, per the house rules: it owns the title screen, mounts the
 * canvas and renders the HUD off engine snapshots. Everything that moves lives
 * in `src/gump/`, and `src/gump/README.md` explains why five very different
 * chapters are one file with different data in it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { GumpEngine } from "@/gump/engine";
import { CHAPTERS } from "@/gump/chapters";
import type { GumpSnapshot } from "@/gump/types";
import GumpHUD from "@/gump/ui/GumpHUD";
import { useWorldStamp } from "@/hooks/use-world-stamp";

const SAVE = "gump:cleared";

function loadCleared() {
  try {
    return Number(localStorage.getItem(SAVE) ?? "0") || 0;
  } catch {
    return 0;
  }
}

export default function RunVibeyRun() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/run", "Run, Vibey, Run");

  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<GumpEngine | null>(null);
  const [engine, setEngine] = useState<GumpEngine | null>(null);
  const [state, setState] = useState<GumpSnapshot | null>(null);
  const [unlocked, setUnlocked] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /**
   * Bumping this remounts the canvas and rebuilds the engine.
   *
   * A browser will refuse to hand out a WebGL context when it already has too
   * many live ones — open four worlds from the hub in four tabs and the fifth
   * gets `null` back and a page that says the world is broken. It isn't; it
   * just needs asking again, so the error state offers that instead of being
   * a dead end.
   */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => setUnlocked(loadCleared()), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let eng: GumpEngine | null = null;
    setError(null);
    try {
      eng = new GumpEngine(host);
      engineRef.current = eng;
      setEngine(eng);
      eng.start();
    } catch (err) {
      console.error("[Run Vibey Run] boot failed", err);
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    const off = eng.on(setState);
    const onResize = () => engineRef.current?.resize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    // The tear-down rule: a leaked WebGL context breaks the *next* world
    // somebody opens out of the hub, which is a miserable thing to debug.
    return () => {
      off();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [attempt]);

  // Clearing a chapter unlocks the next one, for good.
  useEffect(() => {
    if (!state?.cleared) return;
    if (state.cleared <= loadCleared()) return;
    try {
      localStorage.setItem(SAVE, String(state.cleared));
    } catch {
      /* private mode — the run still works, it just will not be remembered */
    }
    setUnlocked(state.cleared);
  }, [state?.cleared]);

  const begin = useCallback((i: number) => engineRef.current?.begin(i), []);

  /* Card-art capture drives the world without a human: ?shot=1 skips straight
     into a chapter, ?chapter=5 picks which. See scripts/route-shot.mjs. */
  useEffect(() => {
    if (!engine || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("shot")) return;
    engine.setMuted(true);
    const n = Number(params.get("chapter") ?? 0) || 0;
    engine.begin(n);
    window.setTimeout(() => engine.go(), 300);
    (window as unknown as Record<string, unknown>).__gump = engine;
    (window as unknown as Record<string, unknown>).__gumpReady = true;
  }, [engine]);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0b0d10]">
      {/* A container, not a canvas: the engine makes its own canvas inside
          this and removes it on teardown, so every mount gets a fresh one.
          See the note on the GumpEngine constructor. */}
      <div ref={hostRef} className="absolute inset-0" />

      {engine && state && state.phase !== "bench" && <GumpHUD engine={engine} state={state} />}

      {state?.phase === "bench" && !error && (
        <TitleScreen unlocked={unlocked} onStart={begin} />
      )}

      {error && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black/95 p-8 text-center">
          <h2 className="text-xl font-bold text-red-400">Run, Vibey, Run failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <p className="max-w-sm font-mono text-[11px] leading-relaxed text-white/35">
            Usually this is the browser refusing another 3D context because too
            many worlds are open. Closing another tab and trying again fixes it.
          </p>
          <button
            onClick={() => setAttempt((n) => n + 1)}
            className="mt-3 rounded-full bg-[#e0b53a] px-7 py-2.5 text-xs font-bold uppercase tracking-[0.24em] text-black transition active:scale-95"
          >
            Try again
          </button>
          <Link to="/" className="mt-2 font-mono text-xs uppercase tracking-widest text-emerald-300">
            ← back to the vibeverse
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * The bus stop. It sits on top of a live bench scene, so the scrim carries the
 * text on its own — and it scrolls, because on a tall narrow phone six chapter
 * cards plus a title is taller than the viewport.
 */
function TitleScreen({
  unlocked,
  onStart,
}: {
  unlocked: number;
  onStart: (i: number) => void;
}) {
  const next = Math.min(CHAPTERS.length - 1, unlocked);
  return (
    <div className="absolute inset-0 z-30 overflow-y-auto overscroll-contain bg-gradient-to-b from-black/45 via-black/25 to-black/80">
      <div
        className="relative flex min-h-full flex-col items-center justify-center px-5 text-center"
        style={{
          paddingTop: "max(2.5rem, env(safe-area-inset-top))",
          paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))",
        }}
      >
        <p className="text-[9px] uppercase tracking-[0.45em] text-[#e0b53a] drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)] sm:text-[10px]">
          The Vibeverse presents
        </p>
        <h1 className="mt-3 font-serif text-4xl font-black leading-[0.9] tracking-tight text-[#f4ecd8] drop-shadow-[0_4px_28px_rgba(0,0,0,0.8)] sm:text-7xl">
          RUN, VIBEY
          <span className="mt-1 block text-[#e0b53a]">RUN</span>
        </h1>
        <p className="mt-5 max-w-md text-balance font-serif text-sm italic leading-relaxed text-[#f4ecd8]/85 drop-shadow-[0_2px_10px_rgba(0,0,0,0.9)] sm:text-base">
          Life is like a box of chocolates. This one is mostly running. Six
          things happen to him and he runs through every single one.
        </p>

        <button
          onClick={() => onStart(next)}
          className="mt-7 rounded-full bg-[#e0b53a] px-10 py-3.5 text-xs font-bold uppercase tracking-[0.3em] text-black transition active:scale-95 hover:bg-[#f0c752]"
        >
          {unlocked > 0 ? `Continue · ${CHAPTERS[next].tab}` : "Start running"}
        </button>

        <div className="mt-9 grid w-full max-w-2xl grid-cols-2 gap-2 rounded-2xl bg-black/40 p-2 backdrop-blur-sm sm:grid-cols-3">
          {CHAPTERS.map((c, i) => {
            const locked = i > unlocked;
            return (
              <button
                key={c.id}
                disabled={locked}
                onClick={() => onStart(i)}
                className={`group rounded-xl border p-3 text-left transition ${
                  locked
                    ? "cursor-not-allowed border-white/8 opacity-35"
                    : "border-[#f4ecd8]/15 hover:border-[#f4ecd8]/45 active:scale-[0.98]"
                }`}
                style={locked ? undefined : { boxShadow: `inset 0 0 0 1px ${c.accent}22` }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-lg leading-none">{locked ? "🔒" : c.icon}</span>
                  <span
                    className="text-[10px] font-bold uppercase tracking-[0.16em]"
                    style={{ color: locked ? undefined : c.accent }}
                  >
                    {c.tab}
                  </span>
                </div>
                <div className="mt-1.5 font-serif text-sm font-bold text-[#f4ecd8]">{c.title}</div>
                <div className="text-[10px] uppercase tracking-[0.14em] text-[#f4ecd8]/35">
                  {c.where}
                </div>
              </button>
            );
          })}
        </div>

        <Link
          to="/"
          className="mt-9 text-[10px] uppercase tracking-[0.3em] text-[#f4ecd8]/35 transition hover:text-[#f4ecd8]/80"
        >
          ← back to the vibeverse
        </Link>
      </div>
    </div>
  );
}
