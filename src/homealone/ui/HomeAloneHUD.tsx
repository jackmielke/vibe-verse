/**
 * The overlay: objective, compass, traps, the two nerve bars, and — on a phone
 * — every control there is.
 *
 * The rule the whole layout obeys: **the middle of the screen belongs to the
 * house.** Everything here hugs an edge, because the thing you need to see is
 * a corridor with somebody at the end of it. The one exception is the action
 * prompt, which sits just under centre, because it is about the thing you are
 * standing in front of.
 *
 * The touch controls are not a port. The stick is a real stick with a dead
 * zone and a clamped radius, the action button is thumb-sized and lives where
 * a right thumb rests, and looking is a drag anywhere on the right-hand half
 * of the screen — the same gesture the stick's half does not use.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { HomeAloneEngine, Snapshot } from "../engine";

const COARSE =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;

export default function HomeAloneHUD({
  engine,
  state,
  onRetry,
  onNext,
  onMenu,
  onPick,
}: {
  engine: HomeAloneEngine;
  state: Snapshot;
  onRetry: () => void;
  onNext: () => void;
  onMenu: () => void;
  onPick: (n: number) => void;
}) {
  const playing = state.phase === "playing" || state.phase === "outro";

  return (
    <div className="pointer-events-none absolute inset-0 select-none font-mono text-white">
      {playing && <Vignette danger={state.danger} caught={state.caught} />}
      {playing && <TopBar state={state} />}
      {playing && state.compass !== null && <Compass state={state} />}
      {playing && <TrapRail state={state} />}
      {playing && <NerveBars state={state} />}
      {playing && <Speech state={state} />}
      {playing && <BurglarChatter state={state} />}
      {playing && state.banner && <Banner text={state.banner} />}
      {playing && state.action && <ActionPrompt label={state.action} touch={COARSE} />}
      {playing && COARSE && <TouchControls engine={engine} state={state} />}
      {playing && !COARSE && <KeyHint state={state} />}

      {playing && <ModeSwitch state={state} onPick={onPick} />}
      {state.phase === "brief" && <BriefCard state={state} onStart={() => engine.begin()} onMenu={onMenu} />}
      {state.phase === "won" && <EndCard state={state} win onRetry={onRetry} onNext={onNext} onMenu={onMenu} />}
      {state.phase === "lost" && <EndCard state={state} onRetry={onRetry} onNext={onNext} onMenu={onMenu} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Switch mode without going anywhere.
 *
 * Every level is open, always. Gating them behind each other is right for a
 * game somebody bought and wrong for one somebody opened from a link — the
 * person who wants to see the battle should get to see the battle, and the
 * person who just wants to walk round the house with the lights on should
 * never meet a locked door. It collapses to a chip so it costs one tap and no
 * screen space.
 */
const MODES: Array<[number, string]> = [
  [1, "Empty house"],
  [2, "Wet Bandits"],
  [3, "Set the traps"],
  [4, "The battle"],
  [5, "The zipline"],
  [6, "Free roam"],
];

function ModeSwitch({ state, onPick }: { state: Snapshot; onPick: (n: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="pointer-events-auto absolute left-2 top-2 z-20"
      style={{ top: "max(0.5rem, env(safe-area-inset-top))", left: "max(0.5rem, env(safe-area-inset-left))" }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-white/15 bg-black/55 px-2.5 py-1.5 text-[9px] uppercase tracking-[0.2em] text-white/55 backdrop-blur-sm transition hover:text-white/90"
      >
        {open ? "✕" : "☰"} Mode
      </button>
      {open && (
        <div className="mt-1.5 w-40 overflow-hidden rounded-lg border border-white/15 bg-black/80 backdrop-blur-md">
          {MODES.map(([n, label]) => (
            <button
              key={n}
              onClick={() => {
                setOpen(false);
                onPick(n);
              }}
              className={`block w-full px-3 py-2 text-left text-[10px] tracking-wide transition ${
                n === state.level ? "bg-amber-500/20 text-amber-100" : "text-white/60 hover:bg-white/10"
              }`}
            >
              {n <= 5 ? `${n}. ` : ""}
              {label}
            </button>
          ))}
          <Link
            to="/"
            className="block border-t border-white/10 px-3 py-2 text-left text-[10px] tracking-wide text-white/35 hover:bg-white/10"
          >
            ← the vibeverse
          </Link>
        </div>
      )}
    </div>
  );
}

function Vignette({ danger, caught }: { danger: number; caught: number }) {
  return (
    <>
      <div
        className="absolute inset-0 transition-opacity duration-300"
        style={{
          opacity: 0.25 + danger * 0.75,
          background:
            "radial-gradient(ellipse at center, rgba(0,0,0,0) 42%, rgba(6,8,16,0.55) 78%, rgba(3,4,10,0.9) 100%)",
        }}
      />
      {danger > 0.06 && (
        <div
          className="absolute inset-0"
          style={{
            opacity: danger * 0.5,
            background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(120,16,16,0.55) 100%)",
            animation: `ha-pulse ${Math.max(0.42, 1.25 - danger * 0.8).toFixed(2)}s ease-in-out infinite`,
          }}
        />
      )}
      {caught > 0 && (
        <div className="absolute inset-0 bg-black" style={{ opacity: Math.max(0, caught - 0.55) * 2.2 }} />
      )}
      <style>{`@keyframes ha-pulse{0%,100%{transform:scale(1);opacity:var(--o,.4)}50%{transform:scale(1.04);opacity:.12}}`}</style>
    </>
  );
}

function TopBar({ state }: { state: Snapshot }) {
  const pct = state.total ? (state.done / state.total) * 100 : 0;
  return (
    <div
      className="absolute inset-x-0 top-0 flex flex-col items-center gap-1 px-3 pt-2"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      <div className="flex w-full max-w-2xl items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/45 px-3 py-1.5 backdrop-blur-sm">
        <span className="truncate text-[9px] uppercase tracking-[0.22em] text-amber-200/70">
          {state.level <= 5 ? `Level ${state.level}` : "Free roam"} · {state.room}
        </span>
        {state.timeLeft !== null && (
          <span
            className={`shrink-0 text-sm font-bold tabular-nums ${state.timeLeft < 30 ? "text-red-400" : "text-white/85"}`}
          >
            {Math.floor(state.timeLeft / 60)}:{String(Math.floor(state.timeLeft % 60)).padStart(2, "0")}
          </span>
        )}
        {state.total > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums text-white/70">
            {state.done}/{state.total}
          </span>
        )}
      </div>
      <p className="max-w-xl text-balance text-center text-[10px] leading-snug tracking-wide text-white/45 sm:text-[11px]">
        {state.goal}
      </p>
      {state.total > 0 && (
        <div className="h-[3px] w-40 overflow-hidden rounded-full bg-white/10 sm:w-56">
          <div className="h-full rounded-full bg-amber-300/80 transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
      )}
      {state.kind === "lights" && (
        <div className="mt-0.5 flex items-center gap-2">
          <span className="text-[9px] uppercase tracking-[0.2em] text-red-300/60">They&apos;re watching</span>
          <div className="h-[4px] w-24 overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-red-500/80 transition-[width]" style={{ width: `${state.suspicion * 100}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The compass. A house with sixteen rooms on three floors is genuinely easy to
 * get lost in, and getting lost is not the game — so an arrow always points at
 * whatever the level wants next, with the distance under it.
 */
function Compass({ state }: { state: Snapshot }) {
  const deg = ((state.compass ?? 0) * 180) / Math.PI;
  return (
    <div className="absolute left-1/2 top-[92px] -translate-x-1/2 text-center sm:top-[104px]">
      <div className="mx-auto grid h-9 w-9 place-items-center rounded-full border border-amber-200/25 bg-black/35">
        <svg viewBox="0 0 24 24" className="h-5 w-5" style={{ transform: `rotate(${deg}deg)` }}>
          <path d="M12 3 L18 20 L12 16 L6 20 Z" fill="rgba(252,211,77,0.9)" />
        </svg>
      </div>
      <p className="mt-1 text-[9px] uppercase tracking-[0.16em] text-amber-100/55">
        {state.compassLabel} · {state.compassDist.toFixed(0)}m
      </p>
    </div>
  );
}

function TrapRail({ state }: { state: Snapshot }) {
  if (state.kind !== "traps" && state.kind !== "battle") return null;
  return (
    <div className="absolute left-2 top-1/2 flex -translate-y-1/2 flex-col gap-1">
      {state.traps.map((t) => (
        <div
          key={t.kind}
          className={`flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-[8px] uppercase tracking-[0.1em] backdrop-blur-sm transition ${
            t.spent
              ? "border-white/5 bg-black/25 text-white/20 line-through"
              : t.armed
                ? "border-amber-300/40 bg-amber-500/10 text-amber-100/90"
                : "border-white/10 bg-black/35 text-white/30"
          }`}
        >
          <span className="text-[11px] leading-none">{TRAP_ICON[t.kind] ?? "•"}</span>
          <span className="hidden max-w-[7.5rem] truncate sm:inline">{t.name}</span>
        </div>
      ))}
    </div>
  );
}

const TRAP_ICON: Record<string, string> = {
  cars: "🚗",
  tar: "🕳️",
  iron: "🧲",
  torch: "🔥",
  paint: "🪣",
  ornaments: "🎄",
  glue: "🪶",
  doorknob: "🚪",
};

function NerveBars({ state }: { state: Snapshot }) {
  if (state.kind !== "battle" && state.kind !== "escape") return null;
  return (
    <div
      className="absolute right-2 top-24 flex flex-col gap-1.5 sm:top-28"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {state.burglars.map((b) => (
        <div
          key={b.who}
          className={`w-28 rounded-md border px-2 py-1 backdrop-blur-sm transition ${
            b.state === "gone"
              ? "border-white/5 bg-black/20 opacity-40"
              : b.down
                ? "border-amber-300/50 bg-amber-500/15"
                : b.state === "hunt"
                  ? "border-red-500/50 bg-red-900/30"
                  : "border-white/10 bg-black/35"
          }`}
        >
          <div className="flex items-baseline justify-between">
            <span className="text-[9px] uppercase tracking-[0.16em] text-white/70">{b.who}</span>
            <span className="text-[8px] uppercase tracking-[0.1em] text-white/35">
              {b.state === "gone" ? "gone" : b.down ? "down" : b.state}
            </span>
          </div>
          <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-red-400/80 transition-[width] duration-300"
              style={{ width: `${b.nerve}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function Speech({ state }: { state: Snapshot }) {
  if (!state.say) return null;
  return (
    <div className="absolute inset-x-0 bottom-28 flex justify-center px-6 sm:bottom-24">
      <p className="max-w-md text-balance rounded-lg border border-amber-200/15 bg-black/55 px-3 py-2 text-center text-[11px] italic leading-snug text-amber-50/85 backdrop-blur-sm sm:text-sm">
        “{state.say}”
      </p>
    </div>
  );
}

/**
 * What Harry and Marv are shouting.
 *
 * Deliberately *not* in the middle: their lines are colour, not instructions,
 * and the middle of the screen belongs to the corridor. They sit at the top
 * corners under the nerve bars, one line each, and fade on their own.
 */
function BurglarChatter({ state }: { state: Snapshot }) {
  const talking = state.burglars.filter((b) => b.says);
  if (!talking.length) return null;
  return (
    <div className="absolute right-2 top-48 flex w-52 flex-col items-end gap-1.5 sm:top-52 sm:w-64">
      {talking.map((b) => (
        <p
          key={b.who}
          className={`rounded-lg border px-2.5 py-1.5 text-right text-[10px] italic leading-snug backdrop-blur-sm sm:text-[11px] ${
            b.who === "harry"
              ? "border-amber-700/40 bg-amber-950/50 text-amber-100/85"
              : "border-sky-700/40 bg-sky-950/50 text-sky-100/85"
          }`}
        >
          <span className="mr-1.5 text-[8px] uppercase not-italic tracking-[0.2em] opacity-50">{b.who}</span>
          “{b.says}”
        </p>
      ))}
    </div>
  );
}

function Banner({ text }: { text: string }) {
  return (
    <div className="absolute inset-x-0 top-1/3 flex justify-center px-6">
      <h2 className="text-balance text-center text-lg font-black uppercase tracking-[0.14em] text-amber-200 drop-shadow-[0_3px_18px_rgba(0,0,0,0.9)] sm:text-3xl">
        {text}
      </h2>
    </div>
  );
}

function ActionPrompt({ label, touch }: { label: string; touch: boolean }) {
  return (
    <div className="absolute inset-x-0 top-[58%] flex justify-center px-6">
      <div className="flex items-center gap-2 rounded-full border border-white/15 bg-black/55 px-3 py-1.5 backdrop-blur-sm">
        <kbd className="rounded border border-white/25 px-1.5 py-0.5 text-[9px] tracking-widest text-white/80">
          {touch ? "TAP ●" : "E"}
        </kbd>
        <span className="text-[11px] tracking-wide text-white/80">{label}</span>
      </div>
    </div>
  );
}

function KeyHint({ state }: { state: Snapshot }) {
  const fight = state.kind === "battle" || state.kind === "escape";
  return (
    <div className="absolute bottom-3 left-3 hidden text-[9px] leading-relaxed tracking-[0.16em] text-white/25 sm:block">
      <div>WASD MOVE · SHIFT RUN</div>
      <div>MOUSE LOOK · WHEEL ZOOM · E INTERACT</div>
      {fight && (
        <div className={state.tauntCooldown > 0 ? "text-white/15" : "text-amber-200/50"}>
          Q SHOUT{state.tauntCooldown > 0 ? ` (${state.tauntCooldown.toFixed(1)}s)` : ""}
        </div>
      )}
      {state.hasBB && <div className="text-amber-200/50">SPACE FIRE · {state.ammo} BBs</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Touch
 * ------------------------------------------------------------------ */

/**
 * Touch controls.
 *
 * The *stick is not here any more* — the engine owns every pointer on the
 * canvas, because a fixed pad in the corner and a look-drag on the canvas were
 * two owners fighting over the same thumb. What is left here is buttons, which
 * are real DOM elements sitting above the canvas and therefore swallow their
 * own pointer events, and a ring drawn wherever the engine says the thumb
 * currently is.
 */
function TouchControls({ engine, state }: { engine: HomeAloneEngine; state: Snapshot }) {
  const fight = state.kind === "battle" || state.kind === "escape";
  const stop = (fn: () => void) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
  return (
    <>
      {/* The floating stick: a ring at the touch origin, a knob at the thumb. */}
      {state.stick && (
        <>
          <div
            className="pointer-events-none absolute rounded-full border border-white/25 bg-white/[0.05]"
            style={{
              left: state.stick.ox - 68, top: state.stick.oy - 68, width: 136, height: 136,
            }}
          />
          <div
            className="pointer-events-none absolute rounded-full border border-white/40 bg-white/25"
            style={{
              left: clampKnob(state.stick.ox, state.stick.x) - 28,
              top: clampKnob(state.stick.oy, state.stick.y) - 28,
              width: 56, height: 56,
            }}
          />
        </>
      )}

      {/* A standing hint on the left, so the scheme is discoverable at all. */}
      {!state.stick && (
        <div
          className="pointer-events-none absolute text-[9px] uppercase leading-relaxed tracking-[0.18em] text-white/20"
          style={{ left: "max(1.2rem, env(safe-area-inset-left))", bottom: "max(1.6rem, env(safe-area-inset-bottom))" }}
        >
          <div>touch here to walk</div>
          <div>drag right to look</div>
          <div>pinch to zoom</div>
        </div>
      )}

      <div
        className="pointer-events-auto absolute flex flex-col items-end gap-2.5"
        style={{ right: "max(1rem, env(safe-area-inset-right))", bottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
      >
        {state.hasBB && (
          <button
            onPointerDown={stop(() => engine.fire())}
            disabled={state.ammo <= 0}
            className="h-14 w-14 touch-none rounded-full border border-sky-200/35 bg-sky-400/15 text-[9px] uppercase tracking-[0.1em] text-sky-100/80 active:bg-sky-400/35 disabled:opacity-30"
          >
            BB {state.ammo}
          </button>
        )}
        {fight && (
          <button
            onPointerDown={stop(() => engine.taunt())}
            disabled={state.tauntCooldown > 0}
            className="h-14 w-14 touch-none rounded-full border border-red-300/40 bg-red-500/20 text-[9px] uppercase tracking-[0.1em] text-red-100/85 active:bg-red-500/40 disabled:opacity-30"
          >
            {state.tauntCooldown > 0 ? state.tauntCooldown.toFixed(0) : "Shout"}
          </button>
        )}
        <button
          onPointerDown={stop(() => engine.setSprint(true))}
          onPointerUp={stop(() => engine.setSprint(false))}
          onPointerLeave={stop(() => engine.setSprint(false))}
          onPointerCancel={stop(() => engine.setSprint(false))}
          className="h-14 w-14 touch-none rounded-full border border-white/20 bg-white/10 text-[9px] uppercase tracking-[0.14em] text-white/70 active:bg-white/25"
        >
          Run
        </button>
        <button
          onPointerDown={stop(() => engine.act())}
          className="h-20 w-20 touch-none rounded-full border-2 border-amber-200/45 bg-amber-400/20 text-2xl text-amber-100 active:scale-95 active:bg-amber-400/40"
        >
          ●
        </button>
      </div>
    </>
  );
}

/** Keep the drawn knob inside its ring however far the thumb has travelled. */
function clampKnob(origin: number, at: number) {
  return origin + Math.max(-68, Math.min(68, at - origin));
}

/* ------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------ */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-30 overflow-y-auto overscroll-contain bg-black/78 backdrop-blur-md">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_20%,rgba(190,140,60,0.16),transparent_62%)]" />
      <div
        className="relative flex min-h-full flex-col items-center justify-center px-6 py-10 text-center"
        style={{ paddingTop: "max(2.5rem, env(safe-area-inset-top))", paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))" }}
      >
        {children}
      </div>
    </div>
  );
}

function BriefCard({ state, onStart, onMenu }: { state: Snapshot; onStart: () => void; onMenu: () => void }) {
  // Enter should start it — the brief is a beat, not a form.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.code === "Enter" || e.code === "Space") onStart();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onStart]);

  return (
    <Shell>
      <p className="text-[9px] uppercase tracking-[0.42em] text-amber-300/50">
        {state.level <= 5 ? `Level ${state.level} of 5` : "Free roam"}
      </p>
      <h2 className="mt-3 max-w-lg text-balance text-2xl font-black leading-tight tracking-tight text-[#f0e6d2] sm:text-4xl">
        {state.title}
      </h2>
      <p className="mt-3 max-w-md text-balance text-[11px] italic text-amber-200/50 sm:text-sm">{state.quote}</p>
      <div className="mt-6 max-w-md space-y-1.5">
        {state.brief.map((line) => (
          <p key={line} className="text-balance text-[11px] leading-relaxed text-white/60 sm:text-[13px]">
            {line}
          </p>
        ))}
      </div>
      <button
        onClick={onStart}
        className="mt-8 rounded-full border border-amber-300/45 bg-amber-500/15 px-8 py-3 text-[11px] font-bold uppercase tracking-[0.28em] text-amber-100 transition active:scale-95 hover:bg-amber-500/30"
      >
        Begin
      </button>
      <button onClick={onMenu} className="mt-4 text-[10px] uppercase tracking-[0.24em] text-white/25 hover:text-white/60">
        ← back to the levels
      </button>
    </Shell>
  );
}

function EndCard({
  state,
  win,
  onRetry,
  onNext,
  onMenu,
}: {
  state: Snapshot;
  win?: boolean;
  onRetry: () => void;
  onNext: () => void;
  onMenu: () => void;
}) {
  const last = state.level >= 5;
  return (
    <Shell>
      <p className="text-[9px] uppercase tracking-[0.42em] text-amber-300/45">Level {state.level}</p>
      <h2
        className={`mt-3 text-3xl font-black uppercase tracking-tight sm:text-5xl ${
          win ? "text-amber-200" : "text-red-400"
        }`}
      >
        {win ? (last ? "Merry Christmas" : "Cleared") : "Caught"}
      </h2>
      <p className="mt-3 max-w-md text-balance text-[12px] leading-relaxed text-white/55">
        {win
          ? last
            ? "The rope's cut, the police have them, and the house is still standing. Not bad for eight."
            : state.title
          : state.banner ?? "Try it again. This time, listen for them."}
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        {win && !last && (
          <button
            onClick={onNext}
            className="rounded-full border border-amber-300/45 bg-amber-500/15 px-7 py-3 text-[11px] font-bold uppercase tracking-[0.24em] text-amber-100 transition active:scale-95 hover:bg-amber-500/30"
          >
            Next level
          </button>
        )}
        <button
          onClick={onRetry}
          className="rounded-full border border-white/20 px-7 py-3 text-[11px] font-bold uppercase tracking-[0.24em] text-white/70 transition active:scale-95 hover:bg-white/10"
        >
          {win ? "Play again" : "Try again"}
        </button>
        <button
          onClick={onMenu}
          className="rounded-full border border-white/10 px-7 py-3 text-[11px] uppercase tracking-[0.24em] text-white/40 transition hover:text-white/80"
        >
          Levels
        </button>
      </div>
      <Link to="/" className="mt-8 text-[10px] uppercase tracking-[0.28em] text-white/25 transition hover:text-white/60">
        ← back to the vibeverse
      </Link>
    </Shell>
  );
}
