/**
 * /frisco — VIBE FRANCISCO
 *
 * San Francisco as a toy you can fly around. Real downtown, real street grids,
 * real hills; painted in flat colour and built as one resident diorama rather
 * than a streamed simulation.
 *
 * The page owns the chrome and nothing else. Everything that moves is in
 * `src/frisco/`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { useActiveCharacter } from "@/hooks/use-active-character";
import { LANDMARK_SITES, SPAWNS } from "@/frisco/map";
import type { FriscoHandle } from "@/frisco/engine";
import type { PlayEvent, PlaySnapshot } from "@/frisco/play";
import type { Stance } from "@/frisco/player";

const CHIP =
  "pointer-events-auto inline-flex min-h-[42px] items-center gap-1.5 rounded-xl bg-black/40 px-3 " +
  "text-[11px] font-semibold uppercase tracking-[0.16em] text-white/85 backdrop-blur-sm " +
  "ring-1 ring-white/15 transition active:scale-95 hover:bg-black/55 hover:text-white";

interface Hud {
  fuel: number;
  stance: Stance;
  altitude: number;
  speed: number;
  fps: number;
}

export default function VibeFrancisco() {
  useWorldStamp("/frisco", "Vibe Francisco");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shotRef = useRef(false);
  const handleRef = useRef<FriscoHandle | null>(null);
  const [params, setParams] = useSearchParams();
  const spawn = params.get("at") ?? "market";
  /* `?shot` is the attract mode the capture harnesses drive: the camera goes on
     rails, the input layer stops listening, and the chrome comes off so the
     frame is the world and nothing else. `route-gif.mjs` measures whether what
     comes out actually moves, so this is a claim the repo checks rather than
     one this file gets to make. */
  const shot = params.has("shot");
  const { charId, character } = useActiveCharacter();
  shotRef.current = params.has("shot");

  const [phase, setPhase] = useState<"loading" | "playing" | "failed">("loading");
  const [progress, setProgress] = useState("Waking up the city");
  const [sheet, setSheet] = useState<"char" | "go" | "log" | null>(null);
  const [hud, setHud] = useState<Hud>({ fuel: 1, stance: "ground", altitude: 0, speed: 0, fps: 0 });
  const [touch, setTouch] = useState(false);
  const [hint, setHint] = useState(true);
  const [play, setPlay] = useState<PlaySnapshot | null>(null);
  const [toast, setToast] = useState<{ id: number; title: string; body: string } | null>(null);
  const toastId = useRef(0);

  /* One toast at a time, and the newest wins.
     Flying through a line of coins fires an event a frame apart; a queue would
     make the HUD narrate a thing that finished four seconds ago, which is the
     opposite of what a toast is for. */
  const say = useCallback((title: string, body: string) => {
    toastId.current += 1;
    const id = toastId.current;
    setToast({ id, title, body });
    window.setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), 3800);
  }, []);

  useEffect(() => {
    setTouch(window.matchMedia("(hover: none), (pointer: coarse)").matches);
    const t = window.setTimeout(() => setHint(false), 11000);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  /* ---- mount the world ---- *
   * Keyed on nothing: the world is built once and the character is swapped in
   * place. Rebuilding eleven hundred buildings because somebody put on a
   * different hat would be an odd thing to do. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let handle: FriscoHandle | null = null;

    // The engine is heavy and the page is not; import it only once we are here.
    void (async () => {
      try {
        const { mountFrisco } = await import("@/frisco/engine");
        if (cancelled) return;
        handle = mountFrisco({
          canvas,
          charId,
          spawn,
          attract: shotRef.current,
          onProgress: (label) => !cancelled && setProgress(label),
        });
        handleRef.current = handle;
        let acc = 0;
        handle.onFrame = (dt) => {
          acc += dt;
          // The HUD is React and the world is not; refreshing it ten times a
          // second instead of sixty is invisible and keeps the reconciler out
          // of the frame budget entirely.
          if (acc < 0.1) return;
          acc = 0;
          const s = handle!.player.state;
          setHud({
            fuel: s.fuel,
            stance: s.stance,
            altitude: s.altitude,
            speed: s.speed,
            fps: handle!.fps,
          });
          setPlay(handle!.play.snapshot());
        };
        handle.onPlay = (events: PlayEvent[]) => {
          for (const e of events) {
            if (e.kind === "landmark") {
              sayRef.current(`${e.name} — ${e.found}/${e.total}`, e.blurb);
            } else if (e.kind === "course") {
              sayRef.current(
                e.record ? "New best time!" : "Course complete",
                `${e.seconds.toFixed(1)}s · best ${e.best.toFixed(1)}s`,
              );
            } else if (e.kind === "course-start") {
              sayRef.current("Market Street run", "Fourteen rings, from the water to the hill.");
            }
          }
        };
        setPhase("playing");
      } catch (err) {
        console.warn("[frisco] failed to start:", err);
        if (!cancelled) setPhase("failed");
      }
    })();

    return () => {
      cancelled = true;
      handle?.dispose();
      handleRef.current = null;
    };
    // Mount once. Character and spawn changes are applied imperatively below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `say` is stable but the mount effect runs once and must not close over a
  // stale copy of anything, so it reads through a ref.
  const sayRef = useRef(say);
  useEffect(() => {
    sayRef.current = say;
  }, [say]);

  /* ---- apply changes without a rebuild ---- */
  useEffect(() => {
    handleRef.current?.setCharacter(charId);
  }, [charId]);

  const toggleCourse = useCallback(() => {
    const h = handleRef.current;
    if (!h) return;
    if (h.play.snapshot().ring >= 0) h.play.stopCourse();
    else h.onPlay?.(h.play.startCourse());
    setSheet(null);
  }, []);

  const goTo = useCallback(
    (key: string) => {
      handleRef.current?.goTo(key);
      const next = new URLSearchParams(params);
      next.set("at", key);
      setParams(next, { replace: true });
      setSheet(null);
    },
    [params, setParams],
  );

  return (
    <div className="fixed inset-0 bg-[#8fd0f0]">
      <canvas ref={canvasRef} className="h-full w-full touch-none" />

      {phase === "loading" ? <Loading progress={progress} /> : null}
      {phase === "failed" ? <Failed /> : null}

      {phase === "playing" && !shot ? (
        <>
          <TopChrome
            charLabel={`${character.emoji} ${character.label}`}
            onChar={() => setSheet("char")}
            onGo={() => setSheet("go")}
          />
          <FuelGauge hud={hud} />
          <Scoreboard play={play} onLog={() => setSheet("log")} onCourse={toggleCourse} />
          <Toast toast={toast} />
          {touch ? <JetPad /> : null}
          <Hint show={hint && !toast} touch={touch} />
        </>
      ) : null}

      {sheet === "char" ? <CharacterSheet onClose={() => setSheet(null)} /> : null}
      {sheet === "go" ? <GoSheet onPick={goTo} onClose={() => setSheet(null)} /> : null}
      {sheet === "log" ? (
        <LogSheet play={play} onCourse={toggleCourse} onClose={() => setSheet(null)} />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

function Loading({ progress }: { progress: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center bg-[#8fd0f0]">
      <div className="text-[11px] font-bold uppercase tracking-[0.42em] text-white/70">Vibeverse</div>
      <h1 className="mt-2 text-center text-5xl font-black uppercase leading-[0.9] tracking-tight text-white drop-shadow-[0_3px_0_rgba(0,0,0,0.18)] sm:text-7xl">
        Vibe
        <span className="block text-[#ff8a3d]">Francisco</span>
      </h1>
      <div className="mt-7 h-[3px] w-52 overflow-hidden rounded-full bg-white/30">
        <div className="h-full w-1/3 animate-[fsweep_1.3s_ease-in-out_infinite] rounded-full bg-white" />
      </div>
      <p className="mt-4 text-xs font-medium tracking-wide text-white/80">{progress}…</p>
      <style>{`@keyframes fsweep{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}`}</style>
    </div>
  );
}

function Failed() {
  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-[#0d1520] px-6 text-center">
      <h1 className="text-2xl font-black uppercase tracking-tight text-white">
        Vibe Francisco could not start
      </h1>
      <p className="max-w-sm text-sm text-white/60">
        This world needs WebGL. If another tab is running a 3D world, closing it usually frees
        up what this one needs.
      </p>
      <Link to="/worlds" className={CHIP}>
        ← Back to the worlds
      </Link>
    </div>
  );
}

function TopChrome({
  charLabel,
  onChar,
  onGo,
}: {
  charLabel: string;
  onChar: () => void;
  onGo: () => void;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-wrap items-center gap-2"
      style={{
        paddingTop: "max(env(safe-area-inset-top), 10px)",
        paddingLeft: "max(env(safe-area-inset-left), 10px)",
        paddingRight: "max(env(safe-area-inset-right), 10px)",
      }}
    >
      <Link to="/worlds" className={CHIP} style={{ WebkitTapHighlightColor: "transparent" }}>
        ← Worlds
      </Link>
      <button onClick={onChar} className={CHIP} style={{ WebkitTapHighlightColor: "transparent" }}>
        {charLabel}
      </button>
      <button onClick={onGo} className={CHIP} style={{ WebkitTapHighlightColor: "transparent" }}>
        📍 Go
      </button>
    </div>
  );
}

/** Fuel, altitude and speed — the three numbers that matter with a jetpack on. */
function FuelGauge({ hud }: { hud: Hud }) {
  const pct = Math.round(hud.fuel * 100);
  const low = hud.fuel < 0.25;
  return (
    <div
      className="pointer-events-none absolute left-0 z-20 flex flex-col gap-1.5"
      style={{
        bottom: "max(env(safe-area-inset-bottom), 14px)",
        paddingLeft: "max(env(safe-area-inset-left), 14px)",
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/80 drop-shadow">
          Jet
        </span>
        <div className="h-2.5 w-32 overflow-hidden rounded-full bg-black/40 ring-1 ring-white/20">
          <div
            className={`h-full rounded-full transition-[width] duration-100 ${
              low ? "bg-[#ff6b5a]" : "bg-[#7dfce0]"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div className="flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/70 drop-shadow">
        <span>{Math.round(hud.altitude)} m</span>
        <span>{Math.round(hud.speed * 3.6)} km/h</span>
        {hud.stance === "jet" ? <span className="text-[#7dfce0]">▲ burning</span> : null}
      </div>
    </div>
  );
}

/**
 * The scoreboard: coins, the logbook count, and the course clock.
 *
 * Top right, deliberately small, and it disappears into the corner when
 * nothing is happening. The temptation with a world like this is a permanent
 * quest panel, and it is the wrong instinct — the thing you are meant to be
 * looking at is the city.
 */
function Scoreboard({
  play,
  onLog,
  onCourse,
}: {
  play: PlaySnapshot | null;
  onLog: () => void;
  onCourse: () => void;
}) {
  if (!play) return null;
  const running = play.ring >= 0;
  return (
    <div
      className="pointer-events-none absolute right-0 z-20 flex flex-col items-end gap-1.5"
      style={{
        top: "max(env(safe-area-inset-top), 62px)",
        paddingRight: "max(env(safe-area-inset-right), 12px)",
      }}
    >
      <button
        onClick={onLog}
        className={`${CHIP} !min-h-[34px] !px-2.5 !text-[10px]`}
        style={{ WebkitTapHighlightColor: "transparent" }}
      >
        🪙 {play.coins}
        <span className="mx-1 text-white/25">·</span>
        📖 {play.found.length}/{play.totalLandmarks}
      </button>
      {running ? (
        <button
          onClick={onCourse}
          className={`${CHIP} !min-h-[34px] !px-2.5 !text-[10px] !bg-[#0e5f52]/70`}
          style={{ WebkitTapHighlightColor: "transparent" }}
        >
          ⏱ {play.clock.toFixed(1)}s · ring {play.ring + 1}/{play.totalRings}
        </button>
      ) : null}
      {play.nearest && !play.nearest.found && play.nearest.metres < 420 ? (
        <div className="rounded-lg bg-black/35 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/60 backdrop-blur-sm">
          {play.nearest.name} · {play.nearest.metres} m
        </div>
      ) : null}
    </div>
  );
}

/** What just happened. One at a time — see `say` in the page. */
function Toast({ toast }: { toast: { id: number; title: string; body: string } | null }) {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 z-20 flex justify-center transition-all duration-300 ${
        toast ? "translate-y-0 opacity-100" : "-translate-y-3 opacity-0"
      }`}
      style={{ top: "max(env(safe-area-inset-top), 108px)" }}
    >
      <div className="mx-4 max-w-sm rounded-2xl bg-black/60 px-4 py-2.5 text-center backdrop-blur-sm ring-1 ring-white/15">
        <div className="text-[12px] font-black uppercase tracking-[0.14em] text-[#ffcf6b]">
          {toast?.title}
        </div>
        <div className="mt-0.5 text-[11px] leading-snug text-white/70">{toast?.body}</div>
      </div>
    </div>
  );
}

/**
 * The logbook: all twelve landmarks, with the ones you have not found kept
 * secret except for their name.
 *
 * Showing the name and hiding the blurb is the balance this needs. A blank
 * row gives you nothing to aim at; a full description means there is no
 * reason to go. The name is a destination and the blurb is the reward.
 */
function LogSheet({
  play,
  onCourse,
  onClose,
}: {
  play: PlaySnapshot | null;
  onCourse: () => void;
  onClose: () => void;
}) {
  const found = new Set(play?.found ?? []);
  return (
    <Sheet title="Logbook" onClose={onClose}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="rounded-lg bg-white/5 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/70 ring-1 ring-white/10">
          🪙 {play?.coins ?? 0} / {play?.totalCoins ?? 0} coins this visit
        </span>
        <button onClick={onCourse} className={CHIP}>
          {play && play.ring >= 0 ? "Stop the run" : "⏱ Fly the Market Street run"}
        </button>
        {play?.bestCourse != null ? (
          <span className="text-[11px] text-white/45">best {play.bestCourse.toFixed(1)}s</span>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {LANDMARK_SITES.map((l) => {
          const got = found.has(l.key);
          return (
            <div
              key={l.key}
              className={`rounded-xl p-3 ring-1 ${
                got ? "bg-white/10 ring-white/20" : "bg-white/[0.03] ring-white/5"
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span className={got ? "text-[#7dfce0]" : "text-white/20"}>{got ? "✓" : "○"}</span>
                <span className={`text-sm font-bold ${got ? "text-white" : "text-white/45"}`}>
                  {l.name}
                </span>
              </div>
              <div className="mt-0.5 pl-6 text-[11px] leading-snug text-white/50">
                {got ? l.blurb : "Not found yet — fly over and take a look."}
              </div>
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}

/**
 * The touch throttle.
 *
 * Purely a painted target: the input layer decides what a touch in this corner
 * means, and this is the thing that tells a thumb where the corner is. Drawing
 * it in the DOM rather than in the canvas means it never costs a frame and it
 * scales with the device's own text size.
 */
function JetPad() {
  return (
    <div
      className="pointer-events-none absolute z-20 flex items-center justify-center rounded-full
                 bg-white/10 text-[11px] font-black uppercase tracking-[0.18em] text-white/80
                 ring-2 ring-white/25 backdrop-blur-sm"
      style={{
        right: "max(env(safe-area-inset-right), 18px)",
        bottom: "max(env(safe-area-inset-bottom), 18px)",
        width: 108,
        height: 108,
      }}
    >
      JET
    </div>
  );
}

function Hint({ show, touch }: { show: boolean; touch: boolean }) {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 z-20 flex justify-center transition-opacity duration-700 ${
        show ? "opacity-100" : "opacity-0"
      }`}
      style={{ bottom: "max(env(safe-area-inset-bottom), 74px)" }}
    >
      <p className="mx-4 rounded-full bg-black/45 px-4 py-2 text-center text-[11px] leading-relaxed text-white/85 backdrop-blur-sm ring-1 ring-white/15">
        {touch
          ? "Left thumb to move · right thumb to look · hold JET to fly"
          : "Click to look around · WASD to move · Shift to run · Space to jump, hold to fly"}
      </p>
    </div>
  );
}

function CharacterSheet({ onClose }: { onClose: () => void }) {
  const { charId, setCharId, all } = useActiveCharacter();
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? all.filter((c) => c.label.toLowerCase().includes(t)) : all;
  }, [all, q]);
  return (
    <Sheet title="Who's flying" onClose={onClose}
      extra={
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          className="ml-auto w-28 rounded-lg bg-white/10 px-3 py-2 text-xs text-white placeholder:text-white/35 outline-none ring-1 ring-white/15 focus:ring-white/35"
        />
      }
    >
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-8">
        {shown.map((c) => (
          <button
            key={c.id}
            onClick={() => setCharId(c.id)}
            className={`flex min-h-[80px] flex-col items-center justify-center gap-1 rounded-xl p-2 text-center transition active:scale-95 ${
              c.id === charId ? "bg-white/15" : "bg-white/5 ring-1 ring-white/10 hover:bg-white/10"
            }`}
            style={c.id === charId ? { boxShadow: `0 0 0 2px ${c.accent}` } : undefined}
          >
            <span className="text-2xl leading-none">{c.emoji}</span>
            <span className="text-[10px] leading-tight text-white/70">{c.label}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

function GoSheet({ onPick, onClose }: { onPick: (k: string) => void; onClose: () => void }) {
  return (
    <Sheet title="Go somewhere" onClose={onClose}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
        {SPAWNS.map((s) => (
          <button
            key={s.key}
            onClick={() => onPick(s.key)}
            className="rounded-xl bg-white/5 p-3 text-left ring-1 ring-white/10 transition active:scale-95 hover:bg-white/10"
          >
            <div className="text-sm font-bold text-white">{s.name}</div>
            <div className="mt-0.5 text-[11px] leading-snug text-white/50">{s.blurb}</div>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

function Sheet({
  title,
  onClose,
  children,
  extra,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  extra?: React.ReactNode;
}) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-black/80 backdrop-blur-md">
      <div className="flex items-center gap-3 px-4 pt-[max(env(safe-area-inset-top),14px)]">
        <h2 className="text-sm font-black uppercase tracking-[0.22em] text-white">{title}</h2>
        {extra}
        <button onClick={onClose} className={`${CHIP} ${extra ? "" : "ml-auto"}`}>
          Done
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
    </div>
  );
}
