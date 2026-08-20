/**
 * The sky control: pick the hour, pick the weather, or leave both running.
 *
 * The engine has had a full day cycle and five weather conditions since it was
 * built, and until now the only thing that could reach either was a debug hook
 * meant for a screenshot script. That is a strange thing to hide — the whole
 * argument for a world painted at one specific minute of one specific sunset
 * is that the light *is* the world, and being able to move it is being able to
 * see the place you are standing in five different ways.
 *
 * Three decisions that are worth the words:
 *
 * - **"Live" is a first-class choice, not the absence of one.** The world runs
 *   its own clock and its own weather cycle, dwelling near the sunset it was
 *   painted at. Pinning is a thing you do *to* that, and you have to be able
 *   to hand it back — otherwise the first tap on this panel permanently kills
 *   the best thing the world does on its own.
 * - **The chips read the world, not the last button pressed.** Weather takes
 *   half a second to arrive and the hour sweeps over a few, so the panel
 *   highlights what `EmpyreanState` says is true now. A chip that lights up
 *   before the snow starts is a chip nobody believes twice.
 * - **It closes when you play.** Any key that moves the body shuts the panel,
 *   because the one thing worse than not finding this control is finding it
 *   and then not being able to get rid of it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EmpyreanState } from "@/empyrean/types";

/* -------------------------------------------------------------------------
 * What you can pick
 * ---------------------------------------------------------------------- */

/**
 * Six hours and the sunset the world exists for.
 *
 * Phase is 0 at midnight, 0.25 at dawn, 0.5 at noon, 0.75 at sunset. The
 * spacing is deliberately uneven: the hours around the sunset are minutes
 * apart because that is where all the good light is, and the small hours get
 * one entry because they are all the same picture.
 */
export const HOURS: ReadonlyArray<{ id: string; label: string; phase: number }> = [
  { id: "dawn", label: "Dawn", phase: 0.235 },
  { id: "morning", label: "Morning", phase: 0.36 },
  { id: "noon", label: "Noon", phase: 0.5 },
  { id: "golden", label: "Golden", phase: 0.705 },
  { id: "sunset", label: "Sunset", phase: 0.75 },
  { id: "night", label: "Night", phase: 0.94 },
];

export const SKIES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "clear", label: "Clear" },
  { id: "high-cloud", label: "High cloud" },
  { id: "snow", label: "Snowfall" },
  { id: "mist", label: "Mist" },
  { id: "calm", label: "Still air" },
];

/** What the trigger shows at a glance. */
const GLYPH: Record<string, string> = {
  clear: "☀",
  "high-cloud": "⛅",
  snow: "❄",
  mist: "≋",
  calm: "◍",
};

const STORE = "empyrean.sky";

export interface SkyChoice {
  /** Pinned phase, or null for the world's own clock. */
  phase: number | null;
  /** Pinned condition, or null for the world's own cycle. */
  weather: string | null;
}

/**
 * What was chosen last time, if anything.
 *
 * Wrapped, because `localStorage` throws rather than returning null in a
 * private window in some browsers, and a world that will not boot in private
 * mode is a world that quietly loses the people most likely to be trying it
 * for the first time.
 */
export function readSkyChoice(): SkyChoice {
  try {
    const raw = window.localStorage.getItem(STORE);
    if (!raw) return { phase: null, weather: null };
    const v = JSON.parse(raw) as Partial<SkyChoice>;
    const phase = typeof v.phase === "number" && Number.isFinite(v.phase) ? v.phase : null;
    const weather =
      typeof v.weather === "string" && SKIES.some((s) => s.id === v.weather) ? v.weather : null;
    return { phase, weather };
  } catch {
    return { phase: null, weather: null };
  }
}

function writeSkyChoice(c: SkyChoice) {
  try {
    window.localStorage.setItem(STORE, JSON.stringify(c));
  } catch {
    /* Private mode is not an error. */
  }
}

/* -------------------------------------------------------------------------
 * The panel
 * ---------------------------------------------------------------------- */

const chip =
  "rounded-full border px-2.5 py-1 text-[11px] leading-none transition-colors " +
  "disabled:opacity-40";
const chipOn = "border-amber-200/60 bg-amber-200/20 text-amber-100";
const chipOff = "border-white/12 bg-white/[0.04] text-white/70 hover:bg-white/10 hover:text-white";

export interface EmpyreanSkyPanelProps {
  state: EmpyreanState;
  /** null hands the hour back to the world's clock. */
  onHour: (phase: number | null) => void;
  /** null hands the weather back to the world's cycle. */
  onWeather: (id: string | null) => void;
}

export default function EmpyreanSkyPanel({ state, onHour, onWeather }: EmpyreanSkyPanelProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  /* Close on Escape, on a click elsewhere, and on anything that moves the
     body. The last one matters most: this sits over the top-right corner of a
     world you fly through, and a panel you cannot dismiss by playing is a
     panel that has taken the screen away from you. */
  useEffect(() => {
    if (!open) return;
    const MOVES = new Set([
      "KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    ]);
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape" || MOVES.has(e.code)) setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  const pickHour = useCallback(
    (phase: number | null) => {
      onHour(phase);
      writeSkyChoice({ phase, weather: readSkyChoice().weather });
    },
    [onHour],
  );
  const pickWeather = useCallback(
    (id: string | null) => {
      onWeather(id);
      writeSkyChoice({ phase: readSkyChoice().phase, weather: id });
    },
    [onWeather],
  );

  /* Which hour chip is lit.
   *
   * Not "the one you pressed" — the one the sky is actually at, within a few
   * minutes. While the sweep is running none of them are lit, which is exactly
   * right: the world is between hours and saying otherwise is a lie you can
   * see out of the window. */
  const nearHour = state.dayPinned
    ? HOURS.find((h) => {
        let d = Math.abs(h.phase - state.dayPhase) % 1;
        if (d > 0.5) d = 1 - d;
        return d < 0.006;
      })?.id
    : undefined;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Time of day and weather"
        className={`rounded-full border px-3 py-1.5 font-mono text-xs backdrop-blur-md transition-colors ${
          open
            ? "border-amber-200/50 bg-amber-200/15 text-amber-100"
            : "border-white/10 bg-black/40 text-white/90 hover:bg-black/60"
        }`}
      >
        <span className="mr-1.5">{GLYPH[state.weather] ?? "☀"}</span>
        {state.clock}
      </button>

      {open && (
        <div className="absolute right-0 top-11 w-[19rem] rounded-2xl border border-white/12 bg-black/70 p-3 backdrop-blur-xl">
          <div className="flex items-baseline justify-between">
            <div className="text-[10px] uppercase tracking-[0.26em] text-amber-100/80">Hour</div>
            <button
              onClick={() => pickHour(null)}
              className={`${chip} ${state.dayPinned ? chipOff : chipOn}`}
              title="Let the world keep its own time"
            >
              Live
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {HOURS.map((h) => (
              <button
                key={h.id}
                onClick={() => pickHour(h.phase)}
                className={`${chip} ${nearHour === h.id ? chipOn : chipOff}`}
              >
                {h.label}
              </button>
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.002}
            value={state.dayPhase}
            onChange={(e) => pickHour(Number(e.target.value))}
            aria-label="Time of day"
            className="mt-3 h-1 w-full cursor-pointer appearance-none rounded-full bg-gradient-to-r from-[#0b1030] via-[#ffb35c] to-[#0b1030] accent-amber-200"
          />

          <div className="mt-4 flex items-baseline justify-between">
            <div className="text-[10px] uppercase tracking-[0.26em] text-cyan-100/80">Weather</div>
            <button
              onClick={() => pickWeather(null)}
              className={`${chip} ${state.weatherPinned ? chipOff : chipOn}`}
              title="Let the weather keep changing on its own"
            >
              Live
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {SKIES.map((w) => (
              <button
                key={w.id}
                onClick={() => pickWeather(w.id)}
                className={`${chip} ${
                  state.weatherPinned && state.weather === w.id ? chipOn : chipOff
                }`}
              >
                <span className="mr-1 opacity-70">{GLYPH[w.id]}</span>
                {w.label}
              </button>
            ))}
          </div>

          <p className="mt-3 text-[10px] leading-relaxed text-white/45">
            Live is the world's own clock — it lingers near the sunset it was painted at. Pick an
            hour and the sky sweeps to it; the shadows swing and the lamps come on on the way.
          </p>
        </div>
      )}
    </div>
  );
}
