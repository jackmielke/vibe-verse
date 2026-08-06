/**
 * I SPY — the page.
 *
 * Thin, like every other world here: it mounts a canvas, hands it to the
 * engine, and renders chrome off engine events. Everything that moves lives
 * in `src/ispy/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  DIFFICULTIES, ISpyEngine, levelProgress, type Difficulty, type ISpyStatus,
} from "@/ispy/engine";
import { LEVELS } from "@/ispy/levels";
import { useWorldStamp } from "@/hooks/use-world-stamp";

export default function ISpy() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/i-spy", "I Spy");

  // ?level=<id> deep-links a level; the picker rebuilds the engine on change.
  const [levelId, setLevelId] = useState(() => {
    if (typeof window === "undefined") return LEVELS[0].id;
    const want = new URLSearchParams(window.location.search).get("level");
    return LEVELS.find((l) => l.id === want)?.id ?? "i-spy";
  });
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
      engine = new ISpyEngine(canvas, levelId);
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
  }, [levelId]);

  /** Switch levels: tear the engine down and build the new one. */
  const pickLevel = useCallback((id: string) => {
    setLevelId(id);
    setMenu(true);
    const url = new URL(window.location.href);
    url.searchParams.set("level", id);
    window.history.replaceState(null, "", url);
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

  const marks = engineRef.current?.checkpointPercents ?? [];
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
                {/* Checkpoint notches — practice only, lit once past them. */}
                {status.practice &&
                  marks.map((m, i) => (
                    <div
                      key={m}
                      className={`absolute inset-y-0 w-[2px] ${
                        i < status.banked ? "bg-emerald-300" : "bg-white/30"
                      }`}
                      style={{ left: `${m}%` }}
                    />
                  ))}
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
              <span>
                {status.difficulty !== "normal" && (
                  <span className="mr-3 text-sky-300/80">
                    {DIFFICULTIES[status.difficulty].label.toLowerCase()}
                  </span>
                )}
                {status.chapter}
              </span>
              <span className="flex items-center gap-3">
                {/* Three coins, always shown, so you know what you are missing
                    long before you know where they are. */}
                <span className="flex items-center gap-1">
                  {Array.from({ length: status.totalCoins }, (_, i) => (
                    <span
                      key={i}
                      className={`inline-block h-2 w-2 rounded-full ${
                        i < status.coins
                          ? "bg-amber-300 shadow-[0_0_8px_rgba(255,212,0,0.9)]"
                          : "bg-white/20"
                      }`}
                    />
                  ))}
                </span>
                {status.practice && (
                  <span className="text-emerald-300/80">
                    practice · ckpt {status.banked}/{status.checkpoints}
                  </span>
                )}
                <span>attempt {status.attempts}</span>
              </span>
            </div>
          </div>

          {/* Sonar: the only thing in the game that tells you the truth, and
              it does it with a sound rather than with an eye. */}
          <button
            onClick={() => engineRef.current?.fireSonar()}
            disabled={status.pings === 0 || status.phase !== "playing"}
            aria-label={`sonar ping, ${status.pings} left`}
            className="absolute bottom-5 right-5 z-20 flex h-16 w-16 flex-col items-center justify-center rounded-full border border-white/25 bg-white/10 backdrop-blur transition active:scale-90 disabled:opacity-25 sm:bottom-8 sm:right-8"
          >
            {/* Three arcs leaving a point — a ping going out. */}
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden="true">
              <circle cx="5" cy="12" r="2" fill="currentColor" />
              <path
                d="M10 7.5a6.5 6.5 0 0 1 0 9M14 4a11 11 0 0 1 0 16M18 1a15.5 15.5 0 0 1 0 22"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
            <span className="mt-0.5 font-mono text-[10px] tabular-nums text-white/70">
              {Number.isFinite(status.pings) ? status.pings : "∞"}
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
                {status.difficulty !== "normal"
                  ? ` · ${DIFFICULTIES[status.difficulty].label.toLowerCase()}`
                  : ""}
                {status.practice ? " · practice" : ""}
              </p>
              <p className="mt-4 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-amber-200/90">
                {Array.from({ length: status.totalCoins }, (_, i) => (
                  <span
                    key={i}
                    className={`inline-block h-3.5 w-3.5 rounded-full ${
                      i < status.coinsEarned
                        ? "bg-amber-300 shadow-[0_0_14px_rgba(255,212,0,0.9)]"
                        : "border border-white/25"
                    }`}
                  />
                ))}
                <span className="ml-1 text-white/45">
                  {status.coinsEarned === status.totalCoins
                    ? "every coin"
                    : `${status.coinsEarned} of ${status.totalCoins} coins`}
                </span>
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
          <h1 className="mt-3 text-center text-5xl font-black tracking-tighter text-white drop-shadow-[0_0_50px_rgba(255,47,191,0.55)] sm:text-7xl">
            {status?.levelName?.toUpperCase() ?? "I SPY"}
          </h1>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.35em] text-white/40">
            {LEVELS.find((l) => l.id === levelId)?.world}
          </p>
          <p className="mt-3 max-w-md text-center text-sm leading-relaxed text-white/60">
            {LEVELS.find((l) => l.id === levelId)?.tagline}
          </p>

          {/* Eleven levels, one per corner of the vibeverse. Each has its own
              tempo, gravity and palette — they are different games, not skins. */}
          <div className="mt-6 grid w-full max-w-3xl grid-cols-2 gap-1.5 px-2 sm:grid-cols-3">
            {LEVELS.map((l) => {
              const p = levelProgress(l.id);
              const on = l.id === levelId;
              return (
                <button
                  key={l.id}
                  onClick={() => pickLevel(l.id)}
                  className={`group rounded-lg border px-3 py-2 text-left transition ${
                    on
                      ? "border-fuchsia-300/60 bg-fuchsia-300/12"
                      : "border-white/10 hover:border-white/30 hover:bg-white/5"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={`font-mono text-[11px] uppercase tracking-[0.14em] ${
                        on ? "text-fuchsia-200" : "text-white/70"
                      }`}
                    >
                      {l.name}
                    </span>
                    <span className="font-mono text-[9px] tabular-nums text-white/35">
                      {p.best > 0 ? `${p.best.toFixed(0)}%` : ""}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className="truncate font-mono text-[9px] uppercase tracking-[0.12em] text-white/30">
                      {l.world}
                    </span>
                    {p.coins > 0 && (
                      <span className="font-mono text-[9px] text-amber-300/80">
                        {"●".repeat(p.coins)}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

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

          {/* Three secret coins, hidden off the safe line. Shown from the
              first visit, because "there are three of something" is the hook. */}
          <div className="mt-4 flex items-center gap-2">
            {Array.from({ length: status?.totalCoins ?? 3 }, (_, i) => (
              <span
                key={i}
                className={`inline-block h-3.5 w-3.5 rounded-full ${
                  i < (status?.coinsEarned ?? 0)
                    ? "bg-amber-300 shadow-[0_0_14px_rgba(255,212,0,0.9)]"
                    : "border border-white/25"
                }`}
              />
            ))}
            <span className="ml-1 font-mono text-[10px] uppercase tracking-[0.25em] text-white/35">
              secret coins
            </span>
          </div>

          {/* Difficulty. Chill and Easy slow the simulation *and* the tempo by
              the same factor, so the level stays welded to its music. */}
          <div className="mt-8 flex items-center gap-1.5 rounded-full border border-white/12 p-1">
            {(Object.keys(DIFFICULTIES) as Difficulty[]).map((d) => (
              <button
                key={d}
                onClick={() => engineRef.current?.setDifficulty(d)}
                className={`rounded-full px-4 py-1.5 font-mono text-[10px] uppercase tracking-[0.22em] transition ${
                  status?.difficulty === d
                    ? "bg-sky-300/20 text-sky-200 shadow-[0_0_18px_rgba(125,211,252,0.25)]"
                    : "text-white/40 hover:text-white/80"
                }`}
              >
                {DIFFICULTIES[d].label}
              </button>
            ))}
          </div>
          <p className="mt-2 max-w-xs text-center text-[11px] leading-relaxed text-white/30">
            {DIFFICULTIES[status?.difficulty ?? "normal"].blurb}
          </p>

          <button
            onClick={() => engineRef.current?.setPractice(!status?.practice)}
            className={`mt-6 rounded-full border px-5 py-2 font-mono text-[10px] uppercase tracking-[0.25em] transition ${
              status?.practice
                ? "border-emerald-300/60 bg-emerald-300/15 text-emerald-200"
                : "border-white/15 text-white/45 hover:text-white/80"
            }`}
          >
            practice mode {status?.practice ? "on" : "off"}
          </button>
          <p className="mt-2 max-w-xs text-center text-[11px] leading-relaxed text-white/30">
            {status?.practice
              ? `${status?.checkpoints ?? 11} checkpoints. Die after one and you resume from it — but coins do not count in practice.`
              : "One mistake and you are back at the start. Checkpoints live in practice mode."}
          </p>

          <div className="mt-8 grid max-w-md grid-cols-1 gap-1.5 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-white/35 sm:grid-cols-3">
            <span>space / tap — jump &amp; fly</span>
            <span>E / right-click — sonar</span>
            <span>R — restart</span>
          </div>
          <p className="mt-5 max-w-sm text-center text-[11px] leading-relaxed text-white/35">
            Three sonar pings per attempt. A ping goes out as a sound, and for
            a second and a half what comes back is the shape of the level —
            the scenery drops away and every hazard lights up, including the
            one you cannot see. Three coins are hidden off the safe line; you
            keep the ones you finish a normal run holding.
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
