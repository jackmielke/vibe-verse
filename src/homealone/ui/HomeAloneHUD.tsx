/**
 * The overlay: the night's clock, the box of traps, who is in the house and
 * what they are carrying, and on a phone every control there is.
 *
 * The rule the whole layout obeys: **the middle of the screen belongs to the
 * house.** Everything here hugs an edge, because the thing you need to see is
 * a corridor with somebody at the end of it. The one exception is the action
 * prompt, which sits just under centre, because it is about the thing you are
 * standing in front of.
 *
 * The kit bar is the same thing on a laptop and a phone: a row of buttons
 * along the bottom. On a laptop the number keys pick from it, because the
 * mouse is busy being the camera.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { HomeAloneEngine, IntruderState, Snapshot } from "../engine";
import { EXPLORE, LIGHTS, ROAM } from "../levels";

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
  const playing = state.phase === "playing";
  const trapGame = state.kind === "night" || state.kind === "roam";

  return (
    <div className="pointer-events-none absolute inset-0 select-none font-mono text-white">
      {playing && <Vignette danger={state.danger} caught={state.caught} />}
      {playing && <TopBar state={state} engine={engine} />}
      {playing && state.compass !== null && <Compass state={state} />}
      {playing && trapGame && <LootRail state={state} />}
      {playing && trapGame && <IntruderList state={state} />}
      {playing && trapGame && <Feed state={state} />}
      {playing && <Speech state={state} />}
      {playing && state.banner && <Banner text={state.banner} />}
      {playing && state.action && <ActionPrompt label={state.action} touch={COARSE} />}
      {playing && trapGame && <KitBar engine={engine} state={state} />}
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
 * Every night is open, always. Gating them behind each other is right for a
 * game somebody bought and wrong for one somebody opened from a link: the
 * person who wants to see five of them come through both doors should get to
 * see that. It collapses to a chip so it costs one tap and no screen space.
 */
const MODES: Array<[number, string]> = [
  [1, "Night 1"],
  [2, "Night 2"],
  [3, "Night 3"],
  [4, "Night 4"],
  [5, "Night 5"],
  [ROAM, "Sandbox"],
  [EXPLORE, "The quiet house"],
  [LIGHTS, "Somebody's home"],
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

function clock(s: number) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function levelName(state: Snapshot) {
  if (state.kind === "night") return `Night ${state.level}`;
  if (state.kind === "roam") return "Sandbox";
  return state.title;
}

function TopBar({ state, engine }: { state: Snapshot; engine: HomeAloneEngine }) {
  const night = state.kind === "night";
  const planning = state.stage === "plan";
  const stop = (fn: () => void) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
  return (
    <div
      className="absolute inset-x-0 top-0 flex flex-col items-center gap-1 px-3 pt-2"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      <div className="flex w-full max-w-2xl items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/45 px-3 py-1.5 pl-20 pr-24 backdrop-blur-sm sm:pl-3 sm:pr-3">
        <span className="truncate text-[9px] uppercase tracking-[0.22em] text-amber-200/70">
          {levelName(state)} · {state.room}
        </span>
        {night && (
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] tabular-nums ${
              planning ? "bg-sky-500/20 text-sky-100" : "bg-red-500/25 text-red-100"
            }`}
          >
            {planning ? `Plan ${clock(state.planLeft)}` : `Scared off ${state.done}/${state.total}`}
          </span>
        )}
        {state.timeLeft !== null && (
          <span
            className={`shrink-0 text-sm font-bold tabular-nums ${state.timeLeft < 30 ? "text-red-400" : "text-white/85"}`}
          >
            {clock(state.timeLeft)}
          </span>
        )}
        {night && (
          <span className="shrink-0 text-[12px] tracking-[0.1em] text-red-400">
            {"♥".repeat(Math.max(0, state.hearts))}
            <span className="text-white/15">{"♥".repeat(Math.max(0, 3 - state.hearts))}</span>
          </span>
        )}
        {(night || state.sandbox) && (
          <span className="shrink-0 text-[11px] tabular-nums text-amber-100/85">
            ⚙ {state.sandbox ? "∞" : state.parts}
          </span>
        )}
        {night && <span className="shrink-0 text-[11px] tabular-nums text-white/70">{state.score}</span>}
        {!night && state.total > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums text-white/70">
            {state.done}/{state.total}
          </span>
        )}
      </div>
      <p className="max-w-xl text-balance text-center text-[10px] leading-snug tracking-wide text-white/45 sm:text-[11px]">
        {night && planning
          ? "Lay traps on the dotted routes. They walk to a valuable, then back out the door they came in by."
          : state.goal}
      </p>
      {night && planning && (
        <button
          onPointerDown={stop(() => engine.ready())}
          className="pointer-events-auto mt-0.5 rounded-full border border-red-300/40 bg-red-500/20 px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-red-100 transition active:scale-95 hover:bg-red-500/35"
        >
          Let them in{COARSE ? "" : " · G"}
        </button>
      )}
      {state.sandbox && (
        <button
          onPointerDown={stop(() => engine.callIn())}
          className="pointer-events-auto mt-0.5 rounded-full border border-red-300/40 bg-red-500/20 px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-red-100 transition active:scale-95 hover:bg-red-500/35"
        >
          Send one in{COARSE ? "" : " · B"}
        </button>
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
 * get lost in, and getting lost is not the game, so an arrow always points at
 * whatever the level wants next, with the distance under it.
 */
function Compass({ state }: { state: Snapshot }) {
  const deg = ((state.compass ?? 0) * 180) / Math.PI;
  return (
    <div className="absolute left-1/2 top-[112px] -translate-x-1/2 text-center sm:top-[124px]">
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

/** The valuables: what is still where you left it, and what is walking away. */
function LootRail({ state }: { state: Snapshot }) {
  if (!state.loot.length) return null;
  return (
    <div className="absolute left-2 top-[30%] flex flex-col gap-1">
      <span className="text-[8px] uppercase tracking-[0.2em] text-white/30">Valuables</span>
      {state.loot.map((l) => (
        <div
          key={l.id}
          className={`flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-[8px] uppercase tracking-[0.1em] backdrop-blur-sm transition ${
            l.state === "gone"
              ? "border-white/5 bg-black/25 text-white/20 line-through"
              : l.state === "taken"
                ? "border-red-400/60 bg-red-600/25 text-red-100"
                : "border-amber-300/25 bg-black/35 text-amber-100/70"
          }`}
        >
          <span className="text-[10px] leading-none">{l.state === "safe" ? "◆" : l.state === "taken" ? "!" : "✕"}</span>
          <span className="max-w-[6.5rem] truncate">{l.name.replace(/^(the|your) /, "")}</span>
        </div>
      ))}
    </div>
  );
}

function intruderLabel(b: IntruderState) {
  if (b.eta > 0) return `${b.entry} door · ${Math.ceil(b.eta)}s`;
  if (b.state === "gone") return b.nerve <= 0 ? "ran for it" : "gone";
  if (b.status === "flying") return "airborne";
  if (b.status === "stuck") return "stuck";
  if (b.status === "blind") return "blinded";
  if (b.down) return "down";
  if (b.carrying) return `has ${b.carrying.replace(/^(the|your) /, "")}`;
  if (b.state === "hunt") return "after you";
  if (b.state === "disarm") return "disarming";
  if (b.state === "flee") return "running";
  if (b.state === "search") return "listening";
  return "prowling";
}

/** Everybody on tonight's list: where they are coming from, and how they are doing. */
function IntruderList({ state }: { state: Snapshot }) {
  if (!state.intruders.length) return null;
  return (
    <div
      className="absolute right-2 top-24 flex flex-col gap-1 sm:top-28"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {state.intruders.map((b) => (
        <div key={b.id} className="flex flex-col items-end gap-1">
          <div
            className={`w-28 rounded-md border px-2 py-1 backdrop-blur-sm transition sm:w-32 ${
              b.eta > 0
                ? "border-white/10 bg-black/25 opacity-60"
                : b.state === "gone"
                  ? "border-white/5 bg-black/20 opacity-35"
                  : b.carrying
                    ? "border-red-400/70 bg-red-700/30"
                    : b.down || b.status
                      ? "border-amber-300/50 bg-amber-500/15"
                      : b.state === "hunt"
                        ? "border-red-500/50 bg-red-900/30"
                        : "border-white/10 bg-black/35"
            }`}
          >
            <div className="flex items-baseline justify-between gap-1">
              <span className="text-[9px] uppercase tracking-[0.14em] text-white/75">{b.name}</span>
              <span className="truncate text-[8px] uppercase tracking-[0.06em] text-white/45">{intruderLabel(b)}</span>
            </div>
            {b.eta <= 0 && b.state !== "gone" && (
              <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-red-400/80 transition-[width] duration-300"
                  style={{ width: `${b.nerve}%` }}
                />
              </div>
            )}
          </div>
          {b.says && (
            <p
              className={`max-w-[13rem] rounded-lg border px-2 py-1 text-right text-[10px] italic leading-snug backdrop-blur-sm ${
                b.voice === "gus"
                  ? "border-amber-700/40 bg-amber-950/50 text-amber-100/85"
                  : "border-sky-700/40 bg-sky-950/50 text-sky-100/85"
              }`}
            >
              “{b.says}”
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/** The running commentary: one line per chain, growing as the chain does. */
function Feed({ state }: { state: Snapshot }) {
  const lines = state.feed.slice(-3);
  if (!lines.length) return null;
  return (
    <div className="absolute inset-x-0 top-[21%] flex flex-col items-center gap-1 px-4 sm:top-[19%]">
      {lines.map((f) => (
        <p
          key={f.id}
          className={`max-w-[92vw] truncate rounded-md px-2 py-0.5 text-[10px] tracking-wide backdrop-blur-sm transition-opacity duration-500 sm:text-[11px] ${
            f.hot ? "opacity-100" : "opacity-30"
          } ${f.chain >= 2 ? "bg-amber-500/20 text-amber-100" : "bg-black/35 text-white/70"}`}
        >
          <span className="mr-1.5 text-[8px] uppercase tracking-[0.18em] opacity-60">{f.who}</span>
          {f.text}
          {f.chain >= 2 && <span className="ml-1.5 font-black text-amber-300">{f.chain}x</span>}
        </p>
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

/**
 * The box of traps.
 *
 * Tap one (or press its number) and a ghost of it appears on the floor in
 * front of you; the action button, F or a click lays it. Tap it again to put
 * it away.
 */
function KitBar({ engine, state }: { engine: HomeAloneEngine; state: Snapshot }) {
  if (!state.kit.length) return null;
  const picked = state.kit.find((k) => k.selected);
  const stop = (fn: () => void) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
  return (
    <div
      className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 px-2"
      style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
    >
      {(state.placeHint || picked) && (
        <p
          className={`max-w-[90vw] rounded-md px-2 py-1 text-center text-[10px] leading-snug backdrop-blur-sm ${
            state.placeHint ? "bg-red-900/50 text-red-100" : "bg-black/50 text-white/75"
          }`}
        >
          {state.placeHint ?? `${picked!.name}: ${picked!.blurb}`}
        </p>
      )}
      <div className="pointer-events-auto flex max-w-full gap-1 overflow-x-auto rounded-xl border border-white/10 bg-black/55 p-1 backdrop-blur-sm">
        {state.kit.map((k) => (
          <button
            key={k.kind}
            onPointerDown={stop(() => engine.selectKit(k.kind))}
            title={`${k.name}: ${k.blurb}`}
            className={`relative flex h-12 w-11 shrink-0 touch-none flex-col items-center justify-center rounded-lg border text-center transition sm:h-14 sm:w-14 ${
              k.selected
                ? "border-amber-300 bg-amber-400/30"
                : k.affordable
                  ? "border-white/15 bg-white/5 hover:bg-white/15"
                  : "border-white/5 bg-black/20 opacity-35"
            }`}
          >
            {!COARSE && <span className="absolute left-1 top-0.5 text-[7px] text-white/40">{k.key}</span>}
            <span className="text-base leading-none sm:text-lg">{k.icon}</span>
            <span className="mt-0.5 text-[8px] tabular-nums text-amber-100/80">⚙{k.cost}</span>
          </button>
        ))}
        {state.clocks > 0 && (
          <button
            onPointerDown={stop(() => engine.ring())}
            className="flex h-12 shrink-0 touch-none flex-col items-center justify-center rounded-lg border border-sky-300/50 bg-sky-500/20 px-2 text-[8px] uppercase tracking-[0.1em] text-sky-100 sm:h-14"
          >
            <span className="text-base leading-none">🔔</span>
            Ring{COARSE ? "" : " · R"}
          </button>
        )}
      </div>
    </div>
  );
}

function KeyHint({ state }: { state: Snapshot }) {
  const trapGame = state.kind === "night" || state.kind === "roam";
  return (
    <div className="absolute bottom-3 left-3 hidden text-[9px] leading-relaxed tracking-[0.16em] text-white/25 lg:block">
      <div>WASD MOVE · SHIFT RUN · MOUSE LOOK</div>
      <div>E LIGHTS, PICK UP, THE WIRE</div>
      {trapGame && <div className="text-amber-200/50">1-9, 0 PICK A TRAP · F OR CLICK LAYS IT</div>}
      {trapGame && (
        <div className={state.tauntCooldown > 0 ? "text-white/15" : "text-amber-200/50"}>
          Q SHOUT{state.tauntCooldown > 0 ? ` (${state.tauntCooldown.toFixed(1)}s)` : ""} · R RING A CLOCK
        </div>
      )}
      <div className="text-sky-200/50">SPACE OR CLICK FIRES THE BB GUN</div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Touch
 * ------------------------------------------------------------------ */

/**
 * Touch controls.
 *
 * The stick is not here: the engine owns every pointer on the canvas, because
 * a fixed pad in the corner and a look-drag on the canvas were two owners
 * fighting over the same thumb. What is left here is buttons, which are real
 * DOM elements above the canvas and so swallow their own pointer events, and
 * a ring drawn wherever the engine says the thumb currently is.
 */
function TouchControls({ engine, state }: { engine: HomeAloneEngine; state: Snapshot }) {
  const trapGame = state.kind === "night" || state.kind === "roam";
  const holding = state.kit.some((k) => k.selected);
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

      <div
        className="pointer-events-auto absolute flex flex-col items-end gap-2"
        style={{ right: "max(0.75rem, env(safe-area-inset-right))", bottom: "max(5rem, calc(env(safe-area-inset-bottom) + 4.5rem))" }}
      >
        <button
          onPointerDown={stop(() => engine.throwBrick())}
          disabled={state.brickCooldown > 0}
          className="h-14 w-14 touch-none rounded-full border border-sky-200/45 bg-sky-500/25 text-[8px] font-bold uppercase leading-tight tracking-[0.08em] text-sky-50 active:scale-95 active:bg-sky-500/50 disabled:opacity-40"
        >
          <span className="block text-base leading-none">🎯</span>
          Shoot
        </button>
        {trapGame && (
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
          className={`h-20 w-20 touch-none rounded-full border-2 text-amber-100 active:scale-95 ${
            holding
              ? "border-amber-200 bg-amber-400/45 text-[11px] font-black uppercase tracking-[0.12em]"
              : "border-amber-200/45 bg-amber-400/20 text-2xl active:bg-amber-400/40"
          }`}
        >
          {holding ? "Lay" : "●"}
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
    <div className="pointer-events-auto absolute inset-0 z-30 overflow-y-auto overscroll-contain bg-black/80 backdrop-blur-md">
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
  // Enter should start it: the brief is a beat, not a form.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.code === "Enter" || e.code === "Space") onStart();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onStart]);

  return (
    <Shell>
      <p className="text-[9px] uppercase tracking-[0.42em] text-amber-300/50">{levelName(state)}</p>
      <h2 className="mt-3 max-w-lg text-balance text-2xl font-black leading-tight tracking-tight text-[#f0e6d2] sm:text-4xl">
        {state.title}
      </h2>
      <div className="mt-5 max-w-md space-y-1.5">
        {state.brief.map((line) => (
          <p key={line} className="text-balance text-[11px] leading-relaxed text-white/60 sm:text-[13px]">
            {line}
          </p>
        ))}
      </div>

      {state.cast.length > 0 && (
        <div className="mt-6 flex w-full max-w-md flex-col gap-1.5 text-left">
          {state.cast.map((c, i) => (
            <div key={i} className="flex items-baseline gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5">
              <span className="w-16 shrink-0 text-[11px] font-bold uppercase tracking-[0.1em] text-red-200/85">{c.name}</span>
              <span className="min-w-0 flex-1 text-[10px] leading-snug text-white/50">{c.trait}</span>
              <span className="shrink-0 text-[8px] uppercase tracking-[0.14em] text-white/30">{c.entry}</span>
            </div>
          ))}
        </div>
      )}
      {state.newKit.length > 0 && (
        <div className="mt-4 flex w-full max-w-md flex-col gap-1.5 text-left">
          {state.newKit.map((k) => (
            <div key={k.name} className="flex items-baseline gap-2 rounded-lg border border-amber-300/25 bg-amber-500/10 px-3 py-1.5">
              <span className="shrink-0 text-sm">{k.icon}</span>
              <span className="shrink-0 text-[11px] font-bold tracking-tight text-amber-100">{k.name}</span>
              <span className="min-w-0 flex-1 text-[10px] leading-snug text-white/55">{k.blurb}</span>
              <span className="shrink-0 text-[8px] uppercase tracking-[0.14em] text-amber-300/70">new</span>
            </div>
          ))}
        </div>
      )}
      {state.kind === "night" && state.bestScore > 0 && (
        <p className="mt-4 text-[10px] uppercase tracking-[0.2em] text-white/30">Your best: {state.bestScore}</p>
      )}

      <button
        onClick={onStart}
        className="mt-7 rounded-full border border-amber-300/45 bg-amber-500/15 px-8 py-3 text-[11px] font-bold uppercase tracking-[0.28em] text-amber-100 transition active:scale-95 hover:bg-amber-500/30"
      >
        {state.kind === "night" ? "Start laying traps" : "Begin"}
      </button>
      <button onClick={onMenu} className="mt-4 text-[10px] uppercase tracking-[0.24em] text-white/25 hover:text-white/60">
        ← back to the nights
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
  const r = state.result;
  return (
    <Shell>
      <p className="text-[9px] uppercase tracking-[0.42em] text-amber-300/45">{levelName(state)}</p>
      <h2
        className={`mt-3 text-3xl font-black uppercase tracking-tight sm:text-5xl ${
          win ? "text-amber-200" : "text-red-400"
        }`}
      >
        {win ? (r ? "House held" : "Done") : r ? "They win this one" : "Not this time"}
      </h2>
      {r && (
        <>
          <p className="mt-3 text-4xl tracking-[0.2em] text-amber-300">
            {"★".repeat(r.stars)}
            <span className="text-white/15">{"★".repeat(3 - r.stars)}</span>
          </p>
          <p className="mt-2 text-xl font-black tabular-nums text-white/90">{r.score}</p>
          {state.bestScore > 0 && (
            <p className="text-[9px] uppercase tracking-[0.2em] text-white/30">Best {state.bestScore}</p>
          )}
          <div className="mt-4 flex max-w-sm flex-col gap-1 text-left">
            {r.lines.map((l) => (
              <p key={l.text} className={`text-[11px] leading-snug ${l.earned ? "text-amber-100/90" : "text-white/30"}`}>
                {l.earned ? "★" : "☆"} {l.text}
              </p>
            ))}
          </div>
          <p className="mt-3 text-[10px] uppercase tracking-[0.16em] text-white/40">
            Longest chain {state.bestChain}x · kept {state.loot.filter((l) => l.state === "safe").length} of{" "}
            {state.loot.length}
          </p>
        </>
      )}
      <p className="mt-3 max-w-md text-balance text-[12px] leading-relaxed text-white/55">
        {win
          ? r
            ? r.stars === 3
              ? "Nothing left the house, and something chained. That is the whole game."
              : "Three stars wants every valuable still here and a chain of three."
            : state.title
          : (state.banner ?? "Try it again. This time, listen for them.")}
      </p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        {win && state.hasNext && (
          <button
            onClick={onNext}
            className="rounded-full border border-amber-300/45 bg-amber-500/15 px-7 py-3 text-[11px] font-bold uppercase tracking-[0.24em] text-amber-100 transition active:scale-95 hover:bg-amber-500/30"
          >
            Next night
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
          Menu
        </button>
      </div>
      <Link to="/" className="mt-8 text-[10px] uppercase tracking-[0.28em] text-white/25 transition hover:text-white/60">
        ← back to the vibeverse
      </Link>
    </Shell>
  );
}
