/**
 * COIL — the page.
 *
 * Thin, like every other world here: it mounts a canvas, hands it to the
 * engine, and renders chrome off engine events. Everything that moves lives in
 * `src/coil/`.
 *
 * The one thing this page does that BLOB's does not is talk to the wardrobe.
 * The character on the front of your snake is the character you are wearing
 * everywhere else in the vibeverse, so the title screen shows it, lets you swap
 * to anything you own, and writes that choice back through the same `equip`
 * the shop uses — change your face here and the city, the karts and the shop
 * all agree with you a second later.
 */
import { reportArcadeScore } from "@/arcade/report";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CoilEngine, SKILLS, type CoilStatus } from "@/coil/engine";
import type { SkillId } from "@/coil/config";
import { PORTRAIT_IDS, lookFor } from "@/coil/roster";
import { SHOP_CHARACTERS } from "@/lib/characterShop";
import { characterArt } from "@/lib/characterArt";
import { equip, owns } from "@/lib/wardrobe";
import { useWardrobe } from "@/hooks/use-wardrobe";
import { useWorldStamp } from "@/hooks/use-world-stamp";

const NAME_KEY = "coil:name";
const SKILL_KEY = "coil:skill";

const readName = (): string => {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
};

const readSkill = (): SkillId => {
  try {
    const s = localStorage.getItem(SKILL_KEY);
    return s === "cruise" || s === "swarm" ? s : "standard";
  } catch {
    return "standard";
  }
};

/** The scrim every menu sits on: darkest in the middle where the words are,
 *  clearest at the edges where the live arena is. */
const SCRIM: React.CSSProperties = {
  background:
    "radial-gradient(ellipse at center, rgba(8,5,20,0.93) 0%, rgba(8,5,20,0.82) 45%, rgba(8,5,20,0.5) 100%)",
  backdropFilter: "blur(3px)",
  WebkitBackdropFilter: "blur(3px)",
};

const fmt = (n: number): string => Math.round(n).toLocaleString();

export default function Coil() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/coil", "COIL");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<CoilEngine | null>(null);
  const [status, setStatus] = useState<CoilStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(readName);
  const [skill, setSkill] = useState<SkillId>(readSkill);
  const wardrobe = useWardrobe();

  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");
  const probeMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("probe");

  const coarse = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches,
    [],
  );
  const touch = coarse || !!status?.touch;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let engine: CoilEngine | null = null;
    try {
      engine = new CoilEngine(canvas, { skill, name: name || undefined, demo: shotMode });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    engineRef.current = engine;
    const unsubscribe = engine.subscribe(setStatus);
    const onResize = () => engineRef.current?.resize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    if (shotMode || probeMode) {
      (window as unknown as Record<string, unknown>).__coil = engine;
      if (shotMode) engine.play();
    }
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      unsubscribe();
      engine?.dispose();
      engineRef.current = null;
    };
    // Built once. Skill changes go through the engine rather than rebuilding
    // the canvas, so the title screen's live arena never blinks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* The wardrobe answers from cache on the first frame and reconciles with the
     server a moment later. When it does, the snake's face has to follow. */
  useEffect(() => {
    engineRef.current?.syncLook();
  }, [wardrobe.loadout.character]);

  const play = useCallback(() => engineRef.current?.play(), []);
  const quit = useCallback(() => engineRef.current?.quit(), []);

  const commitName = useCallback((value: string) => {
    const clean = value.slice(0, 14);
    setName(clean);
    try {
      localStorage.setItem(NAME_KEY, clean);
    } catch {
      /* a browser that will not remember it still plays the game */
    }
    engineRef.current?.setName(clean);
  }, []);

  const pickSkill = useCallback((s: SkillId) => {
    setSkill(s);
    try {
      localStorage.setItem(SKILL_KEY, s);
    } catch {
      /* see commitName */
    }
    engineRef.current?.setSkill(s);
  }, []);

  /**
   * Everything you are allowed to wear, portraits only.
   *
   * "Allowed" is the shop's rule, inverted the way the shop states it: being in
   * `SHOP_CHARACTERS` means you must own it, and being absent means it is free.
   * So this is every portrait minus the priced ones you have not bought.
   */
  const wearable = useMemo(() => {
    const priced = new Map(SHOP_CHARACTERS.map((c) => [c.id, c.price]));
    return PORTRAIT_IDS.filter((id) => {
      const price = priced.get(id);
      return price === undefined || owns("character", id, price);
    });
    /* `owns` reads the wardrobe module's own store rather than this hook's
       value, so the linter cannot see the dependency — but it is real: buying
       something in another tab has to add it here without a reload. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wardrobe.owned]);

  // A run's length goes to the Vibe Arcade's wall when you die.
  const deadRef = useRef(false);
  useEffect(() => {
    const dead = status?.phase === "dead";
    if (dead && !deadRef.current && status && status.peak > 0) reportArcadeScore("coil", status.peak);
    deadRef.current = dead;
  }, [status]);

  const wearCharacter = useCallback((id: string) => {
    engineRef.current?.setCharacter(id);
    void equip({ character: id });
  }, []);

  // Enter from the title screen starts a run. Space is not bound — it is boost,
  // and binding it here means your first act every round is to burn length.
  useEffect(() => {
    const phase = status?.phase;
    if (phase !== "attract" && phase !== "dead") return;
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
  const wearing = lookFor(status?.charId ?? wardrobe.loadout.character ?? "flux");

  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-[#0a0714]">
      <canvas ref={canvasRef} className="block h-full w-full touch-none outline-none" />

      {/* ── in-run HUD ──────────────────────────────────────────────────── */}
      {status && !shotMode && phase === "playing" && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-3 pt-3 sm:pt-5">
            <div className="flex items-center gap-4 rounded-full border border-white/10 bg-black/45 px-5 py-2 backdrop-blur">
              <div className="text-center">
                <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/40">
                  length
                </div>
                <div
                  className="font-mono text-xl font-black tabular-nums leading-none"
                  style={{ color: status.color }}
                >
                  {fmt(status.score)}
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
            </div>
          </div>

          <div className="pointer-events-none absolute right-3 top-16 z-20 w-36 sm:right-5 sm:top-5 sm:w-52">
            <div className="rounded-xl border border-white/10 bg-black/40 p-2.5 backdrop-blur">
              <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.3em] text-white/35">
                longest
              </div>
              {status.standings.map((s, i) => (
                <div
                  key={s.id}
                  className={`${i >= 5 ? "hidden sm:flex" : "flex"} items-center gap-1.5 py-[1px] font-mono text-[11px] ${
                    s.id === 0 ? "text-white" : "text-white/60"
                  }`}
                >
                  <span className="w-3.5 text-right tabular-nums text-white/30">{i + 1}</span>
                  {characterArt(s.charId) ? (
                    <img
                      src={characterArt(s.charId)}
                      alt=""
                      className="h-4 w-4 shrink-0 rounded-full object-cover"
                      style={{ background: s.color }}
                    />
                  ) : (
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ background: s.color }}
                    />
                  )}
                  <span className="flex-1 truncate">{s.name}</span>
                  <span className="tabular-nums text-white/40">{fmt(s.score)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="pointer-events-none absolute left-3 top-16 z-20 max-w-[46vw] space-y-1 sm:left-5 sm:top-20">
            {status.feed.map((f) => (
              <div
                key={f.id}
                className="truncate rounded-full border bg-black/35 px-2.5 py-1 font-mono text-[10px] text-white/60 backdrop-blur"
                style={{ borderColor: `${f.color}55` }}
              >
                {f.text}
              </div>
            ))}
          </div>

          {touch && (
            <div className="absolute bottom-6 right-5 z-20">
              <button
                onPointerDown={(e) => {
                  e.preventDefault();
                  engineRef.current?.setBoostButton(true);
                }}
                onPointerUp={() => engineRef.current?.setBoostButton(false)}
                onPointerLeave={() => engineRef.current?.setBoostButton(false)}
                onPointerCancel={() => engineRef.current?.setBoostButton(false)}
                aria-label="boost"
                disabled={!status.canBoost}
                className="flex h-24 w-24 items-center justify-center rounded-full border-2 font-mono text-xs font-bold uppercase tracking-[0.15em] backdrop-blur transition active:scale-90 disabled:opacity-25"
                style={{
                  borderColor: `${status.color}88`,
                  background: `${status.color}22`,
                  color: status.color,
                }}
              >
                boost
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

      {/* ── death ───────────────────────────────────────────────────────── */}
      {status && menu && phase === "dead" && (
        <div
          className="absolute inset-0 z-30 flex flex-col items-center justify-center px-6"
          style={SCRIM}
        >
          <p className="font-mono text-[11px] uppercase tracking-[0.5em] text-fuchsia-300/70">
            you ran into {status.lastKiller ?? "somebody"}
          </p>
          <h2 className="mt-3 text-6xl font-black tabular-nums tracking-tight text-white drop-shadow-[0_0_40px_rgba(255,106,213,0.5)] sm:text-7xl">
            {fmt(status.peak)}
          </h2>
          <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.28em] text-white/40">
            longest · {status.kills} ran into you · best {fmt(status.best)}
          </p>
          {status.peak >= status.best && status.peak > 0 && (
            <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.3em] text-amber-300/90">
              ★ personal best
            </p>
          )}
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <button
              onClick={play}
              className="rounded-full bg-fuchsia-400 px-12 py-3.5 text-xs font-bold uppercase tracking-[0.25em] text-black shadow-[0_0_50px_rgba(255,106,213,0.4)] transition active:scale-95"
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

      {/* ── title ───────────────────────────────────────────────────────── */}
      {menu && phase === "attract" && (
        <div
          className="absolute inset-0 z-30 flex flex-col items-center justify-center overflow-y-auto px-6 py-10"
          style={SCRIM}
        >
          <p className="font-mono text-[10px] uppercase tracking-[0.5em] text-fuchsia-300/70">
            The vibeverse presents
          </p>
          <h1 className="mt-3 text-center text-6xl font-black tracking-tighter text-white drop-shadow-[0_0_50px_rgba(255,106,213,0.5)] sm:text-8xl">
            COIL
          </h1>
          <p className="mt-2 max-w-md text-center text-sm leading-relaxed text-white/55">
            Nobody here is too big to kill. Get in front of them and let them
            run into you.
          </p>

          {/* Who is on the front. This is the whole hook of the world, so it is
              the first thing under the title. */}
          <div className="mt-7 flex flex-col items-center">
            <div
              className="flex h-20 w-20 items-center justify-center rounded-full ring-2"
              style={{
                background: `${wearing.color}22`,
                borderColor: wearing.color,
                boxShadow: `0 0 34px ${wearing.color}55`,
              }}
            >
              {wearing.art ? (
                <img src={wearing.art} alt={wearing.name} className="h-16 w-16 object-contain" />
              ) : (
                <span className="text-3xl">{wearing.emoji}</span>
              )}
            </div>
            <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.25em] text-white/60">
              {wearing.name} rides the front
            </div>
          </div>

          {/* Swap to anything you own, right here — it is the same equipped
              character the rest of the vibeverse reads. */}
          <div className="mt-4 flex max-w-md flex-wrap justify-center gap-1.5">
            {wearable.slice(0, 18).map((id) => {
              const look = lookFor(id);
              const on = id === wearing.charId;
              return (
                <button
                  key={id}
                  onClick={() => wearCharacter(id)}
                  title={look.name}
                  aria-label={`wear ${look.name}`}
                  className={`h-9 w-9 rounded-full border transition ${
                    on ? "scale-110" : "border-white/12 opacity-60 hover:opacity-100"
                  }`}
                  style={{
                    borderColor: on ? look.color : undefined,
                    background: `${look.color}22`,
                  }}
                >
                  {look.art ? (
                    <img src={look.art} alt="" className="h-full w-full object-contain p-0.5" />
                  ) : (
                    <span className="text-sm">{look.emoji}</span>
                  )}
                </button>
              );
            })}
          </div>
          <Link
            to="/shop"
            className="mt-2 font-mono text-[10px] uppercase tracking-[0.22em] text-white/30 transition hover:text-white/70"
          >
            more faces in the shop →
          </Link>

          <input
            value={name}
            onChange={(e) => commitName(e.target.value)}
            placeholder={wearing.name}
            maxLength={14}
            aria-label="your name"
            className="mt-6 w-56 rounded-full border border-white/15 bg-white/5 px-5 py-2.5 text-center font-mono text-sm text-white placeholder:text-white/25 focus:border-fuchsia-300/60 focus:outline-none"
          />

          <div className="mt-5 flex flex-col items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-full border border-white/12 p-1">
              {(Object.keys(SKILLS) as SkillId[]).map((s) => (
                <button
                  key={s}
                  onClick={() => pickSkill(s)}
                  className={`rounded-full px-5 py-1.5 font-mono text-[10px] uppercase tracking-[0.22em] transition ${
                    skill === s
                      ? "bg-fuchsia-300/20 text-fuchsia-200 shadow-[0_0_18px_rgba(255,106,213,0.25)]"
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
            className="mt-8 rounded-full bg-fuchsia-400 px-16 py-4 text-sm font-bold uppercase tracking-[0.3em] text-black shadow-[0_0_60px_rgba(255,106,213,0.45)] transition active:scale-95"
          >
            play
          </button>

          {!!status?.best && (
            <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.3em] text-white/40">
              longest ever {fmt(status.best)}
            </p>
          )}

          <div className="mt-8 grid max-w-lg grid-cols-1 gap-1.5 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-white/35 sm:grid-cols-2">
            {touch ? (
              <>
                <span>drag — set a course</span>
                <span>hold boost — burn length for speed</span>
              </>
            ) : (
              <>
                <span>mouse — steer</span>
                <span>hold click or space — boost</span>
              </>
            )}
          </div>
          <p className="mt-5 max-w-md text-center text-[11px] leading-relaxed text-white/35">
            You cannot stop and you cannot reverse — you can only turn, at one
            fixed rate, however long you get. Length is score and never armour:
            run your head into anybody&apos;s body and you burst, and the whole
            of you becomes orbs for whoever was patient. Boost to close a gap or
            escape one, but it burns the length you are trying to keep and drops
            it on the floor behind you.
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
          <h2 className="text-xl font-bold text-red-400">COIL failed to boot</h2>
          <p className="max-w-lg font-mono text-xs text-white/60">{error}</p>
          <Link to="/" className="mt-4 font-mono text-xs uppercase tracking-widest text-fuchsia-300">
            ← back to the vibeverse
          </Link>
        </div>
      )}
    </div>
  );
}
