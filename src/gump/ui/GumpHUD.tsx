/**
 * The HUD, and the cards between chapters.
 *
 * The timeline across the top is the whole pitch of this world in one strip:
 * six things that happen, in order, with the one you are in lit and the ones
 * you have cleared ticked. It is on screen the entire time you are playing,
 * because "which bit of the story is this" is the question a player has here,
 * and a scoreboard cannot answer it.
 *
 * Everything else is deliberately thin. Two readouts, a bar, a line of Vibey
 * talking, and — on a phone — one button. A runner where the screen is more
 * interesting than the road is a runner nobody looks at.
 */
import { CHAPTERS } from "@/gump/chapters";
import type { GumpEngine } from "@/gump/engine";
import type { GumpSnapshot } from "@/gump/types";
import { Link } from "react-router-dom";

const COARSE =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;

export default function GumpHUD({
  engine,
  state,
}: {
  engine: GumpEngine;
  state: GumpSnapshot;
}) {
  const meta = CHAPTERS[state.chapter];
  const { hud } = state;
  const playing = state.phase === "playing";

  return (
    <>
      {/* ---------------------------------------------------- the timeline */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div className="w-full max-w-2xl rounded-2xl border border-[#e8dcc0]/20 bg-black/45 px-2 py-2 backdrop-blur-md sm:px-3">
          <div className="flex items-end justify-between gap-0.5 sm:gap-1">
            {CHAPTERS.map((c, i) => {
              const done = i < state.cleared;
              const here = i === state.chapter;
              return (
                <div key={c.id} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                  <span
                    className={`text-base leading-none transition sm:text-lg ${
                      here ? "scale-125" : done ? "opacity-80" : "opacity-30 grayscale"
                    }`}
                    style={here ? { filter: `drop-shadow(0 0 8px ${c.accent})` } : undefined}
                  >
                    {c.icon}
                  </span>
                  <span
                    className={`hidden truncate text-[8.5px] font-semibold uppercase tracking-[0.14em] sm:block ${
                      here ? "text-[#f4ecd8]" : done ? "text-[#f4ecd8]/50" : "text-[#f4ecd8]/25"
                    }`}
                  >
                    {c.tab}
                  </span>
                  {/* Each chapter owns a slice of the bar: filled when cleared,
                      live when you are in it, empty ahead of you. */}
                  <span className="h-[3px] w-full overflow-hidden rounded-full bg-white/10">
                    <span
                      className="block h-full rounded-full transition-[width] duration-200"
                      style={{
                        width: done ? "100%" : here ? `${Math.round(hud.progress * 100)}%` : "0%",
                        background: c.accent,
                      }}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------- readouts */}
      {playing && (
        <div className="pointer-events-none absolute inset-x-0 top-[4.6rem] z-10 flex items-start justify-between px-3 sm:top-[5.4rem] sm:px-6">
          <Readout value={hud.stat} label={hud.statLabel} accent={meta.accent} />
          <div className="flex flex-col items-end gap-1.5">
            {hud.extra !== undefined && (
              <Readout value={hud.extra} label={hud.extraLabel ?? ""} accent={meta.accent} right />
            )}
            {/* Whatever is behind you, in its own colour. It is the only
                number on this screen that is bad news, and it should not have
                to compete with the one that is good news. */}
            {hud.danger !== undefined && (
              <Readout value={hud.danger} label={hud.dangerLabel ?? ""} accent="#e2574c" right small />
            )}
            {hud.lives !== undefined && hud.maxLives !== undefined && hud.maxLives <= 6 && (
              <div className="flex gap-1">
                {Array.from({ length: hud.maxLives }, (_, i) => (
                  <span
                    key={i}
                    className={`h-2 w-2 rounded-full ${
                      i < (hud.lives ?? 0) ? "bg-[#f4ecd8]" : "bg-white/15"
                    }`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- toast */}
      {playing && state.toast && (
        <div className="pointer-events-none absolute inset-x-0 bottom-24 z-10 flex justify-center px-6 sm:bottom-28">
          <p
            key={state.toast}
            className="animate-in fade-in slide-in-from-bottom-2 max-w-lg text-balance rounded-xl bg-black/55 px-4 py-2 text-center font-serif text-sm italic leading-snug text-[#f4ecd8] backdrop-blur-sm sm:text-base"
          >
            {state.toast}
          </p>
        </div>
      )}

      {/* ------------------------------------------------- touch controls */}
      {playing && COARSE && (
        <div className="absolute inset-x-0 bottom-0 z-20 flex items-end justify-between px-5 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            onPointerDown={(e) => {
              e.preventDefault();
              engine.setBoost(true);
            }}
            onPointerUp={() => engine.setBoost(false)}
            onPointerLeave={() => engine.setBoost(false)}
            className="h-16 w-16 select-none rounded-full border border-[#f4ecd8]/25 bg-black/40 text-[10px] font-bold uppercase tracking-[0.16em] text-[#f4ecd8]/80 backdrop-blur active:scale-95 active:bg-[#f4ecd8]/20"
          >
            Faster
          </button>
          <button
            onPointerDown={(e) => {
              e.preventDefault();
              engine.tap();
            }}
            className="h-20 w-20 select-none rounded-full border-2 text-[11px] font-bold uppercase tracking-[0.16em] backdrop-blur active:scale-95"
            style={{ borderColor: meta.accent, background: `${meta.accent}33`, color: "#f4ecd8" }}
          >
            {meta.id === "pingpong" ? "Hit" : meta.id === "shrimp" ? "Horn" : "Jump"}
          </button>
        </div>
      )}

      {/* ------------------------------------------------------- the cards */}
      {state.phase === "card" && (
        <Card accent={meta.accent}>
          <p className="text-[10px] uppercase tracking-[0.42em] text-[#f4ecd8]/45">
            Chapter {state.chapter + 1} · {meta.where}
          </p>
          <h2 className="mt-3 font-serif text-3xl font-black leading-none text-[#f4ecd8] sm:text-5xl">
            {meta.title}
          </h2>
          <p className="mt-4 max-w-md text-balance font-serif text-sm italic leading-relaxed text-[#f4ecd8]/75 sm:text-base">
            {meta.card}
          </p>
          <p className="mt-5 max-w-sm text-balance text-[11px] leading-relaxed tracking-wide text-[#f4ecd8]/45">
            {meta.how}
          </p>
          <Controls id={meta.id} />
          <button
            onClick={() => engine.go()}
            className="mt-7 rounded-full px-9 py-3 text-xs font-bold uppercase tracking-[0.28em] text-black transition active:scale-95"
            style={{ background: meta.accent }}
          >
            Run
          </button>
        </Card>
      )}

      {state.phase === "beat" && (
        <Card accent={meta.accent}>
          <p
            className="text-[10px] uppercase tracking-[0.42em]"
            style={{ color: hud.outcome === "won" ? meta.accent : "#d8756a" }}
          >
            {hud.outcome === "won" ? "Chapter cleared" : "That's the end of that"}
          </p>
          <h2 className="mt-3 font-serif text-2xl font-black leading-tight text-[#f4ecd8] sm:text-4xl">
            {meta.title}
          </h2>
          <p className="mt-4 max-w-md text-balance font-serif text-sm italic leading-relaxed text-[#f4ecd8]/75 sm:text-base">
            {state.narration}
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-7 gap-y-2 text-center">
            <Tally value={hud.stat} label={hud.statLabel} />
            {(hud.chocolates ?? 0) > 0 && <Tally value={String(hud.chocolates)} label="Chocolates" />}
            {state.money > 0 && <Tally value={`$${state.money.toLocaleString()}`} label="Fortune" />}
          </div>

          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            {hud.outcome === "won" ? (
              <button
                onClick={() => engine.next()}
                className="rounded-full px-8 py-3 text-xs font-bold uppercase tracking-[0.24em] text-black transition active:scale-95"
                style={{ background: meta.accent }}
              >
                {state.chapter + 1 < CHAPTERS.length ? "Keep going" : "Go home"}
              </button>
            ) : (
              <button
                onClick={() => engine.retry()}
                className="rounded-full px-8 py-3 text-xs font-bold uppercase tracking-[0.24em] text-black transition active:scale-95"
                style={{ background: meta.accent }}
              >
                Run it again
              </button>
            )}
            <button
              onClick={() => engine.toBench()}
              className="rounded-full border border-[#f4ecd8]/25 px-6 py-3 text-xs font-bold uppercase tracking-[0.24em] text-[#f4ecd8]/70 transition active:scale-95"
            >
              The bench
            </button>
          </div>
        </Card>
      )}

      {state.phase === "finale" && (
        <Card accent="#e0b53a">
          <p className="text-[10px] uppercase tracking-[0.42em] text-[#e0b53a]">
            Three years, two months, fourteen days
          </p>
          <h2 className="mt-3 font-serif text-3xl font-black leading-none text-[#f4ecd8] sm:text-5xl">
            And that's all I have to say about that.
          </h2>
          <p className="mt-4 max-w-md text-balance font-serif text-sm italic leading-relaxed text-[#f4ecd8]/75 sm:text-base">
            {state.narration}
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-2">
            <Tally value={state.miles.toFixed(1)} label="Miles run" />
            <Tally value={String(state.chocolates)} label="Chocolates" />
            <Tally value={`$${state.money.toLocaleString()}`} label="Fortune" />
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={() => engine.restart()}
              className="rounded-full bg-[#e0b53a] px-8 py-3 text-xs font-bold uppercase tracking-[0.24em] text-black transition active:scale-95"
            >
              Run it again
            </button>
            <Link
              to="/"
              className="rounded-full border border-[#f4ecd8]/25 px-6 py-3 text-xs font-bold uppercase tracking-[0.24em] text-[#f4ecd8]/70 transition active:scale-95"
            >
              Back to the vibeverse
            </Link>
          </div>
        </Card>
      )}

      {/* A way out, but never while something is chasing you. */}
      {!playing && state.phase !== "bench" && (
        <Link
          to="/"
          className="absolute bottom-4 left-4 z-30 text-[10px] uppercase tracking-[0.28em] text-[#f4ecd8]/35 transition hover:text-[#f4ecd8]/80"
        >
          ← the vibeverse
        </Link>
      )}

      <button
        onClick={() => engine.setMuted(!state.muted)}
        className="absolute bottom-4 right-4 z-30 text-[10px] uppercase tracking-[0.28em] text-[#f4ecd8]/35 transition hover:text-[#f4ecd8]/80"
      >
        {state.muted ? "Sound off" : "Sound on"}
      </button>
    </>
  );
}

function Readout({
  value,
  label,
  accent,
  right,
  small,
}: {
  value: string;
  label: string;
  accent: string;
  right?: boolean;
  small?: boolean;
}) {
  return (
    <div className={right ? "text-right" : ""}>
      <div
        className={`font-mono font-black leading-none tabular-nums ${
          small ? "text-base sm:text-xl" : "text-xl sm:text-3xl"
        }`}
        style={{ color: accent, textShadow: "0 2px 12px rgba(0,0,0,0.6)" }}
      >
        {value}
      </div>
      <div className="mt-1 text-[8.5px] font-semibold uppercase tracking-[0.24em] text-[#f4ecd8]/50">
        {label}
      </div>
    </div>
  );
}

function Tally({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-center">
      <div className="font-mono text-xl font-black tabular-nums text-[#f4ecd8]">{value}</div>
      <div className="text-[8.5px] uppercase tracking-[0.22em] text-[#f4ecd8]/45">{label}</div>
    </div>
  );
}

function Card({ accent, children }: { accent: string; children: React.ReactNode }) {
  return (
    /* The scrim is an inline rgba rather than a utility class on purpose: a
       card sits on top of a *live, sunlit* chapter, and it has to carry gold
       small-caps on its own. The first version leaned on a blur and a
       fractional-opacity class, and the result was cream text on a bright
       green field. */
    <div
      className="absolute inset-0 z-30 overflow-y-auto overscroll-contain backdrop-blur-md"
      style={{ background: "rgba(6,8,10,0.82)" }}
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: `radial-gradient(ellipse at center, ${accent}26, transparent 62%)` }}
      />
      <div
        className="relative flex min-h-full flex-col items-center justify-center px-6 text-center"
        style={{
          paddingTop: "max(4.5rem, env(safe-area-inset-top))",
          paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))",
        }}
      >
        {children}
      </div>
    </div>
  );
}

const KEYS: Record<string, Array<[string, string]>> = {
  pingpong: [
    ["A / D", "slide along the table"],
    ["SPACE", "swing"],
    ["SHIFT", "smash it"],
  ],
  shrimp: [
    ["A / D", "steer the Jenny"],
    ["SHIFT", "open her up"],
  ],
  default: [
    ["A / D", "steer"],
    ["SPACE", "jump — hold it for height"],
    ["SHIFT", "run flat out"],
  ],
};

const TOUCH: Record<string, Array<[string, string]>> = {
  pingpong: [
    ["DRAG", "slide along the table"],
    ["TAP", "swing"],
  ],
  shrimp: [["DRAG", "steer the Jenny"], ["SECOND FINGER", "open her up"]],
  default: [
    ["DRAG", "steer"],
    ["TAP", "jump"],
    ["SECOND FINGER", "run flat out"],
  ],
};

function Controls({ id }: { id: string }) {
  const rows = (COARSE ? TOUCH : KEYS)[id] ?? (COARSE ? TOUCH : KEYS).default;
  return (
    <div className="mt-6 grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 text-left text-[10px] tracking-[0.1em] text-[#f4ecd8]/35">
      {rows.map(([k, what]) => (
        <div key={k} className="contents">
          <span className="whitespace-nowrap font-mono text-[#f4ecd8]/60">{k}</span>
          <span>{what}</span>
        </div>
      ))}
    </div>
  );
}
