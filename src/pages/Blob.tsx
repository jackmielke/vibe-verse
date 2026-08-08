/**
 * BLOB — the page.
 *
 * Thin, like every other world here: it mounts a canvas, hands it to the
 * engine, and renders chrome off engine events. Everything that moves lives in
 * `src/blob/`.
 *
 * The one thing worth knowing about this file is the split between what is
 * drawn and what is DOM. The dish, the leaderboard dots and the minimap are
 * canvas because they change every frame; the leaderboard *text*, the kill feed
 * and the buttons are DOM because they change ten times a second and want to be
 * selectable, tappable and readable by a screen reader. Drawing text at 60 Hz
 * to say "1,204" is how you spend a phone's battery on nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BlobEngine, MODES, SKILLS, type BlobStatus } from "@/blob/engine";
import type { ModeId, SkillId } from "@/blob/config";
import { useWorldStamp } from "@/hooks/use-world-stamp";

const NAME_KEY = "blob:name";
const PREFS_KEY = "blob:prefs";

const readName = (): string => {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
};

const readPrefs = (): { mode: ModeId; skill: SkillId } => {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return {
      mode: raw.mode === "blitz" ? "blitz" : "ffa",
      skill: raw.skill === "chill" || raw.skill === "frenzy" ? raw.skill : "standard",
    };
  } catch {
    return { mode: "ffa", skill: "standard" };
  }
};

/**
 * The scrim every menu sits on.
 *
 * The title screen runs a real match behind it, which is the best thing about
 * it and also the reason the first version was unreadable — a bot's name tag
 * drifted under the difficulty buttons and the two fought. Darkest in the
 * middle where the words are, clearest at the edges where the dish is, plus
 * enough blur to stop a moving blob pulling the eye off the copy.
 */
const SCRIM: React.CSSProperties = {
  background:
    "radial-gradient(ellipse at center, rgba(6,11,20,0.93) 0%, rgba(6,11,20,0.82) 45%, rgba(6,11,20,0.5) 100%)",
  backdropFilter: "blur(3px)",
  WebkitBackdropFilter: "blur(3px)",
};

const fmt = (n: number): string => Math.round(n).toLocaleString();

const clock = (s: number): string => {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
};

export default function Blob() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/blob", "BLOB");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<BlobEngine | null>(null);
  const [status, setStatus] = useState<BlobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(readName);
  const prefs = useMemo(readPrefs, []);
  const [mode, setMode] = useState<ModeId>(prefs.mode);
  const [skill, setSkill] = useState<SkillId>(prefs.skill);

  /* ?shot — scripts/route-shot.mjs wants the dish and nothing else: no title
     card over the frame, no HUD, just the world the way it plays. */
  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  // A phone should see its buttons before it has been touched, and a laptop
  // with a touchscreen should get them the moment a finger lands (the engine
  // reports that back as `status.touch`).
  const coarse = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches,
    [],
  );
  const touch = coarse || !!status?.touch;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let engine: BlobEngine | null = null;
    try {
      engine = new BlobEngine(canvas, {
        mode,
        skill,
        name: name || "you",
        demo: shotMode,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    engineRef.current = engine;
    const unsubscribe = engine.subscribe(setStatus);
    const onResize = () => engineRef.current?.resize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    // Hand the engine to the capture script so world-card art can be a real
    // frame from the running game instead of a drawing of one.
    if (shotMode) {
      (window as unknown as Record<string, unknown>).__blob = engine;
      engine.play();
    }
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      unsubscribe();
      engine?.dispose();
      engineRef.current = null;
    };
    // Built once. Mode and skill changes go through the engine rather than
    // rebuilding the canvas, so the title screen's live match never blinks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const savePrefs = useCallback((next: { mode?: ModeId; skill?: SkillId }) => {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ mode: next.mode ?? mode, skill: next.skill ?? skill }),
      );
    } catch {
      /* a browser that will not remember the setting still plays the game */
    }
  }, [mode, skill]);

  const pickMode = useCallback(
    (m: ModeId) => {
      setMode(m);
      savePrefs({ mode: m });
      engineRef.current?.setMode(m);
    },
    [savePrefs],
  );

  const pickSkill = useCallback(
    (s: SkillId) => {
      setSkill(s);
      savePrefs({ skill: s });
      engineRef.current?.setSkill(s);
    },
    [savePrefs],
  );

  const commitName = useCallback((value: string) => {
    const clean = value.slice(0, 14);
    setName(clean);
    try {
      localStorage.setItem(NAME_KEY, clean);
    } catch {
      /* see savePrefs */
    }
    engineRef.current?.setName(clean || "you");
  }, []);

  const play = useCallback(() => engineRef.current?.play(), []);
  const quit = useCallback(() => engineRef.current?.quit(), []);

  // Enter from the title screen starts a run, so a keyboard player never has to
  // reach for the mouse. Space is not bound here — it is the split key, and
  // binding it to "play" too means your first act every round is a split.
  useEffect(() => {
    const phase = status?.phase;
    if (phase !== "attract" && phase !== "dead" && phase !== "over") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Enter") return;
      if (document.activeElement?.tagName === "INPUT") return;
      e.preventDefault();
      play();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status?.phase, play]);

  const phase = status?.phase ?? "attract";
  const menu = !shotMode && phase !== "playing";
  const timed = MODES[mode].duration > 0;

  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-[#060b14]">
      <canvas ref={canvasRef} className="block h-full w-full touch-none outline-none" />

      {/* ── in-run HUD ──────────────────────────────────────────────────── */}
      {status && !shotMode && phase === "playing" && (
        <>
          {/* Mass, rank and the clock. Top centre, because that is where your
              eyes already are when you are steering. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-3 pt-3 sm:pt-5">
            <div className="flex items-center gap-4 rounded-full border border-white/10 bg-black/45 px-5 py-2 backdrop-blur">
              <div className="text-center">
                <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/40">
                  mass
                </div>
                <div className="font-mono text-xl font-black tabular-nums leading-none text-emerald-300">
                  {fmt(status.mass)}
                </div>
              </div>
              <div className="h-7 w-px bg-white/12" />
              <div className="text-center">
                <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/40">
                  rank
                </div>
                <div className="font-mono text-xl font-black tabular-nums leading-none text-white/90">
                  {status.rank}
                  <span className="text-xs font-normal text-white/35">/{status.alive}</span>
                </div>
              </div>
              {timed && (
                <>
                  <div className="h-7 w-px bg-white/12" />
                  <div className="text-center">
                    <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/40">
                      left
                    </div>
                    <div
                      className={`font-mono text-xl font-black tabular-nums leading-none ${
                        status.timeLeft < 30 ? "text-rose-300" : "text-white/90"
                      }`}
                    >
                      {clock(status.timeLeft)}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Leaderboard. Ten rows, you always visible even when you are 24th. */}
          <div className="pointer-events-none absolute right-3 top-16 z-20 w-36 sm:right-5 sm:top-5 sm:w-48">
            <div className="rounded-xl border border-white/10 bg-black/40 p-2.5 backdrop-blur">
              <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.3em] text-white/35">
                leaderboard
              </div>
              {status.standings.map((s, i) => (
                <div
                  key={s.id}
                  /* Five rows on a phone, ten on a desktop. Ten rows of 11px
                     type is a third of a phone screen spent on other people. */
                  className={`${i >= 5 ? "hidden sm:flex" : "flex"} items-baseline gap-1.5 py-[1px] font-mono text-[11px] ${
                    s.id === 0 ? "text-emerald-300" : "text-white/60"
                  }`}
                >
                  <span className="w-3.5 text-right tabular-nums text-white/30">{i + 1}</span>
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: `hsl(${s.hue}, 85%, 60%)` }}
                  />
                  <span className="flex-1 truncate">{s.name}</span>
                  <span className="tabular-nums text-white/40">{fmt(s.mass)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Kill feed, under the way home. */}
          <div className="pointer-events-none absolute left-3 top-16 z-20 max-w-[46vw] space-y-1 sm:left-5 sm:top-20">
            {status.feed.map((f) => (
              <div
                key={f.id}
                className="truncate rounded-full border border-white/10 bg-black/35 px-2.5 py-1 font-mono text-[10px] text-white/55 backdrop-blur"
                style={{ borderColor: `hsla(${f.hue}, 80%, 60%, 0.35)` }}
              >
                {f.text}
              </div>
            ))}
          </div>

          {/* Touch controls. Two big targets in the corner your thumb is
              already in; the other thumb drives from anywhere on the glass. */}
          {touch && (
            <div className="absolute bottom-6 right-5 z-20 flex flex-col items-center gap-3">
              <button
                onPointerDown={(e) => {
                  e.preventDefault();
                  engineRef.current?.ejectNow();
                }}
                aria-label="eject mass"
                className="flex h-14 w-14 items-center justify-center rounded-full border border-white/20 bg-white/10 font-mono text-[10px] uppercase tracking-[0.15em] text-white/70 backdrop-blur transition active:scale-90 disabled:opacity-30"
                disabled={!status.canEject}
              >
                feed
              </button>
              <button
                onPointerDown={(e) => {
                  e.preventDefault();
                  engineRef.current?.splitNow();
                }}
                aria-label="split"
                className="flex h-20 w-20 items-center justify-center rounded-full border border-emerald-300/40 bg-emerald-300/20 font-mono text-xs font-bold uppercase tracking-[0.15em] text-emerald-100 backdrop-blur transition active:scale-90 disabled:opacity-30"
                disabled={!status.canSplit}
              >
                split
              </button>
            </div>
          )}

          <div className="absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2">
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
        </>
      )}

      {/* ── death / round over ──────────────────────────────────────────── */}
      {status && menu && (phase === "dead" || phase === "over") && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center px-6" style={SCRIM}>
          <p className="font-mono text-[11px] uppercase tracking-[0.5em] text-emerald-300/70">
            {phase === "over" ? "time" : "you were eaten"}
          </p>
          <h2 className="mt-3 text-6xl font-black tabular-nums tracking-tight text-white drop-shadow-[0_0_40px_rgba(94,240,168,0.5)] sm:text-7xl">
            {fmt(status.peak)}
          </h2>
          <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.28em] text-white/40">
            peak mass · {status.kills} eaten · best {fmt(status.best)}
          </p>
          {status.peak >= status.best && status.peak > 0 && (
            <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.3em] text-amber-300/90">
              ★ personal best
            </p>
          )}
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <button
              onClick={play}
              className="rounded-full bg-emerald-300 px-12 py-3.5 text-xs font-bold uppercase tracking-[0.25em] text-black shadow-[0_0_50px_rgba(94,240,168,0.4)] transition active:scale-95"
            >
              again
            </button>
            <button
              onClick={quit}
              className="rounded-full border border-white/20 px-8 py-3.5 text-xs font-bold uppercase tracking-[0.2em] text-white/70 transition hover:text-white"
            >
              menu
            </button>
          </div>
        </div>
      )}

      {/* ── title screen ────────────────────────────────────────────────── */}
      {menu && phase === "attract" && (
        <div
          className="absolute inset-0 z-30 flex flex-col items-center justify-center overflow-y-auto px-6 py-10"
          style={SCRIM}
        >
          <p className="font-mono text-[10px] uppercase tracking-[0.5em] text-emerald-300/70">
            The vibeverse presents
          </p>
          <h1 className="mt-3 text-center text-6xl font-black tracking-tighter text-white drop-shadow-[0_0_50px_rgba(94,240,168,0.5)] sm:text-8xl">
            BLOB
          </h1>
          <p className="mt-2 max-w-md text-center text-sm leading-relaxed text-white/55">
            One dish, {SKILLS[skill].bots} rivals, and one rule: eat anything
            smaller, run from anything bigger.
          </p>

          {/* Name. First thing on the screen you can change, because the whole
              genre is watching your own name climb a list. */}
          <input
            value={name}
            onChange={(e) => commitName(e.target.value)}
            placeholder="your name"
            maxLength={14}
            aria-label="your name"
            className="mt-7 w-56 rounded-full border border-white/15 bg-white/5 px-5 py-2.5 text-center font-mono text-sm text-white placeholder:text-white/25 focus:border-emerald-300/60 focus:outline-none"
          />

          <div className="mt-6 flex flex-col items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-full border border-white/12 p-1">
              {(Object.keys(MODES) as ModeId[]).map((m) => (
                <button
                  key={m}
                  onClick={() => pickMode(m)}
                  className={`rounded-full px-5 py-1.5 font-mono text-[10px] uppercase tracking-[0.22em] transition ${
                    mode === m
                      ? "bg-emerald-300/20 text-emerald-200 shadow-[0_0_18px_rgba(94,240,168,0.25)]"
                      : "text-white/40 hover:text-white/80"
                  }`}
                >
                  {MODES[m].label}
                </button>
              ))}
            </div>
            <p className="max-w-xs text-center text-[11px] leading-relaxed text-white/30">
              {MODES[mode].blurb}
            </p>
          </div>

          <div className="mt-5 flex flex-col items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-full border border-white/12 p-1">
              {(Object.keys(SKILLS) as SkillId[]).map((s) => (
                <button
                  key={s}
                  onClick={() => pickSkill(s)}
                  className={`rounded-full px-5 py-1.5 font-mono text-[10px] uppercase tracking-[0.22em] transition ${
                    skill === s
                      ? "bg-sky-300/20 text-sky-200 shadow-[0_0_18px_rgba(125,211,252,0.25)]"
                      : "text-white/40 hover:text-white/80"
                  }`}
                >
                  {SKILLS[s].label}
                </button>
              ))}
            </div>
            <p className="max-w-xs text-center text-[11px] leading-relaxed text-white/30">
              {SKILLS[skill].blurb}
            </p>
          </div>

          <button
            onClick={play}
            className="mt-8 rounded-full bg-emerald-300 px-16 py-4 text-sm font-bold uppercase tracking-[0.3em] text-black shadow-[0_0_60px_rgba(94,240,168,0.45)] transition active:scale-95"
          >
            play
          </button>

          {!!status?.best && (
            <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.3em] text-white/40">
              best {fmt(status.best)}
            </p>
          )}

          <div className="mt-8 grid max-w-lg grid-cols-1 gap-1.5 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-white/35 sm:grid-cols-3">
            {touch ? (
              <>
                <span>drag anywhere — move</span>
                <span>split — lunge &amp; eat</span>
                <span>feed — spit mass</span>
              </>
            ) : (
              <>
                <span>mouse — move</span>
                <span>space — split</span>
                <span>W — eject mass</span>
              </>
            )}
          </div>
          <p className="mt-5 max-w-md text-center text-[11px] leading-relaxed text-white/35">
            Splitting throws half of you at whatever you are aiming at — it is
            how you catch anything that can outrun you, and it is how you end up
            in sixteen pieces with a whale between them. The green spiky ones
            burst anything bigger than they are, so they are cover when you are
            small and a minefield the moment you are not.
            {!touch && " Right-click splits too, if that is the hand you have free."}
          </p>

          <Link
            to="/"
            className="mt-8 font-mono text-[10px] uppercase tracking-[0.3em] text-white/25 transition hover:text-white/60"
          >
            ← back to the vibeverse
          </Link>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black/90 p-8 text-center">
          <h2 className="text-xl font-bold text-red-400">BLOB failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <Link to="/" className="mt-4 font-mono text-xs uppercase tracking-widest text-emerald-300">
            ← back to the vibeverse
          </Link>
        </div>
      )}
    </div>
  );
}
