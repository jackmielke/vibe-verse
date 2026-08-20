/**
 * THE EMPYREAN — a city of glass on a rock that never landed.
 *
 * The React layer is deliberately thin, the way The Glass Lake and San Palmas
 * are: it owns the title card, the HUD and the touch controls, and mounts a
 * container the engine renders into. Everything that moves lives in
 * `src/empyrean/`.
 *
 * Two rules keep it thin, and both exist because they were broken once:
 *
 *  - **Nothing in the movement path touches React state.** The touch stick
 *    writes straight into the engine's input object. A `setState` per pointer
 *    move is a re-render per pointer move.
 *  - **The engine pushes state at about ten hertz, not per frame.** Everything
 *    on screen here is text and bars; none of it is worth sixty re-renders a
 *    second, and the difference is measurable on a phone.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import type { EmpyreanState } from "@/empyrean/types";
import type { EmpyreanWorld } from "@/empyrean/world";

import empyreanArt from "@/assets/empyrean-inspiration.png.asset.json";
import empyreanCity from "@/assets/empyrean-city.png.asset.json";

import EmpyreanSkyPanel, { readSkyChoice } from "@/components/EmpyreanSkyPanel";
// Type-only, so naming the five conditions here costs nothing at runtime and
// the panel's string ids are checked against the engine's own union.
import type { Condition } from "@/empyrean/weather";

const EMPTY: EmpyreanState = {
  altitude: 0,
  speed: 0,
  drop: 0,
  thrusting: false,
  who: "",
  place: "The Halo",
  placeAccent: "#ffd28a",
  clock: "18:40",
  dayPhase: 0.75,
  dayPinned: false,
  weather: "clear",
  weatherPinned: false,
  prompt: null,
  activity: null,
  toasts: [],
  earned: 0,
  found: { got: 0, total: 0 },
};

export default function Empyrean() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/empyrean", "The Empyrean");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<HTMLCanvasElement | null>(null);
  const worldRef = useRef<EmpyreanWorld | null>(null);
  const [started, setStarted] = useState(false);
  const [booting, setBooting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [hint, setHint] = useState(true);
  const [state, setState] = useState<EmpyreanState>(EMPTY);

  // `?shot=1` — the capture harness. Skips the title card and hides the HUD,
  // so the card art is a picture of the world rather than of its interface.
  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  // Teardown on unmount, always — a leaked WebGL context breaks whichever
  // world the visitor opens next, which is a miserable thing to debug.
  useEffect(() => () => worldRef.current?.dispose(), []);

  const start = useCallback(async () => {
    if (worldRef.current || booting) return;
    setBooting(true);
    // Three plus a city. It must not sit in the hub's chunk — pull it in only
    // once somebody actually steps onto the deck.
    const { createEmpyrean } = await import("@/empyrean/world");
    if (!containerRef.current) return;
    worldRef.current = createEmpyrean({
      container: containerRef.current,
      minimap: mapRef.current,
      onState: setState,
      muted,
      shot: shotMode,
    });
    /* Whatever hour and weather were chosen last time, applied before the
       first frame anybody sees. Restoring it a second later would mean the
       world opens at its own sunset and then visibly lurches to midnight,
       which reads as a bug rather than as a preference. */
    const saved = readSkyChoice();
    if (saved.phase !== null) worldRef.current.setDayPhase(saved.phase);
    if (saved.weather !== null) worldRef.current.setWeather(saved.weather as Condition);
    setBooting(false);
    setStarted(true);
    window.setTimeout(() => setHint(false), 14000);
  }, [booting, muted, shotMode]);

  useEffect(() => {
    if (shotMode) void start();
    // Once, on mount, when the harness asked for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotMode]);

  // H hides the interface. A world this pretty deserves a way to look at it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyH" && !e.repeat) setChrome((c) => !c);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      worldRef.current?.setMuted(!m);
      return !m;
    });
  }, []);

  /* ---- Touch controls ---------------------------------------------------
   * The stick writes straight into the engine's input object. The only React
   * state here is the knob's own position, and that is one small element. */
  const padRef = useRef<HTMLDivElement | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const padTouch = useRef<number | null>(null);

  const padMove = useCallback((clientX: number, clientY: number) => {
    const pad = padRef.current;
    const world = worldRef.current;
    if (!pad || !world) return;
    const r = pad.getBoundingClientRect();
    const max = r.width / 2;
    let dx = (clientX - (r.left + max)) / max;
    let dy = (clientY - (r.top + r.height / 2)) / max;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    world.stick.x = dx;
    world.stick.y = dy;
    // Full deflection runs, the way a full thumbstick does in Vibe City.
    world.stick.boost = len > 0.92;
    setKnob({ x: dx, y: dy });
  }, []);

  const padEnd = useCallback(() => {
    const world = worldRef.current;
    if (world) {
      world.stick.x = 0;
      world.stick.y = 0;
      world.stick.boost = false;
    }
    padTouch.current = null;
    setKnob({ x: 0, y: 0 });
  }, []);

  const setJet = useCallback((on: boolean) => {
    const w = worldRef.current;
    if (w) w.stick.jet = on;
  }, []);

  const isTouch =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  const showChrome = started && !shotMode && chrome;

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#150c22] select-none">
      <div ref={containerRef} className="absolute inset-0" />

      {/* ---- Title card -------------------------------------------------- */}
      {!started && !shotMode && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-start overflow-y-auto px-4 py-8 text-center [padding-bottom:calc(2rem+env(safe-area-inset-bottom))] [padding-top:calc(4.5rem+env(safe-area-inset-top))] sm:[padding-top:calc(2.5rem+env(safe-area-inset-top))] sm:justify-center sm:px-6 sm:py-10">
          {/* The painting this world was made from, with the old five-stop
              gradient beneath it as the fallback while it loads. */}
          <div
            className="fixed inset-0 -z-10"
            style={{
              background:
                "linear-gradient(180deg, #0b1342 0%, #1d3a72 24%, #2f8f9a 42%, #e8b45c 62%, #f2793f 76%, #e9628f 100%)",
            }}
          />
          <img
            src={empyreanArt.url}
            alt="A floating city of glass towers above a frozen lake at sunset"
            className="fixed inset-0 -z-10 h-full w-full object-cover"
          />
          <div
            className="fixed inset-0 -z-10"
            style={{
              background:
                "radial-gradient(90% 60% at 50% 40%, rgba(6,10,34,.18) 0%, rgba(6,10,34,.62) 100%)",
            }}
          />

          {/* Everything readable lives on one pane of glass. */}
          <div className="group w-full max-w-xl rounded-[1.75rem] border border-white/25 bg-white/10 px-5 py-6 shadow-[0_30px_120px_rgba(6,10,40,0.55)] backdrop-blur-2xl sm:rounded-[2rem] sm:px-6 sm:py-8">
            {/* The island itself, hung on the glass like a poster. */}
            <div className="relative mx-auto mb-4 w-36 sm:mb-6 sm:w-56">
              <div className="absolute -inset-3 rounded-[1.75rem] bg-[radial-gradient(60%_60%_at_50%_45%,rgba(120,220,255,.55),transparent_70%)] blur-2xl" />
              <img
                src={empyreanCity.url}
                alt="The Empyrean: a floating city of iridescent glass towers above a frozen lake"
                className="relative w-full rounded-[1.25rem] border border-white/35 shadow-[0_20px_60px_rgba(6,10,40,.6)] transition-transform duration-500 ease-out will-change-transform group-hover:-translate-y-1.5 group-hover:rotate-[1.5deg] sm:rounded-[1.5rem]"
              />
            </div>
            <p className="mb-2 text-[10px] uppercase tracking-[0.32em] text-cyan-100/85 sm:mb-3 sm:text-[11px] sm:tracking-[0.42em]">
              The vibeverse
            </p>

            <h1 className="font-heading text-[2rem] leading-tight tracking-tight text-white drop-shadow-[0_2px_30px_rgba(0,0,0,0.45)] sm:text-6xl">
              The Empyrean
            </h1>
            <p className="mx-auto mt-3 max-w-lg text-[13px] leading-relaxed text-white/90 sm:mt-4 sm:text-sm">
              Eight avenues, three ring roads and a city of glass, six hundred
              metres over a frozen lake that shows you all of it upside down.
              Walk the Bazaar, ride the tram, race the rings, or just put the
              pack on and go and look at the edge.
            </p>
            <button
              onClick={start}
              disabled={booting}
              className="mt-5 w-full rounded-full border border-white/50 bg-white/20 px-8 py-3.5 text-sm font-semibold text-white shadow-[0_0_50px_rgba(255,190,120,0.55)] backdrop-blur-sm transition-colors hover:bg-white/30 disabled:opacity-60 sm:mt-7 sm:w-auto sm:py-3"
            >
              {booting ? "Raising the island…" : "Arrive"}
            </button>
            <p className="mt-4 text-[11px] leading-relaxed text-white/80 sm:mt-5">
              {isTouch
                ? "Stick to move · hold the rocket to fly · drag to look · tap the clock for the hour"
                : "WASD · Space jetpack · Shift boost · E interact · drag to look · the clock sets the hour and the weather · H hides this"}
            </p>
          </div>


          <Link
            to="/"
            className="mt-6 text-xs text-white/70 underline-offset-4 hover:text-white hover:underline sm:mt-8"
          >
            ← back to the vibeverse
          </Link>

        </div>
      )}

      {/* ---- HUD --------------------------------------------------------- */}
      {/* The minimap canvas is mounted whenever the world is, not only when
          the chrome is showing: the engine holds a reference to it and
          unmounting the node under a running renderer is how you get a
          detached canvas being drawn into forever. Hidden, not removed. */}
      <div
        className={`pointer-events-none absolute bottom-4 right-4 z-20 transition-opacity duration-200 ${
          showChrome ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="rounded-2xl border border-white/12 bg-black/45 p-1.5 backdrop-blur-md">
          <canvas ref={mapRef} className="block rounded-xl" />
        </div>
      </div>

      {showChrome && (
        <>
          {/* Where you are. Below the app's own home button, which lives at
              left-3 top-3 in every fullscreen world. */}
          <div className="pointer-events-none absolute left-3 top-16 z-20 flex flex-col gap-2">
            <div className="rounded-2xl border border-white/10 bg-black/40 px-3 py-2 backdrop-blur-md">
              <div
                className="text-[10px] uppercase tracking-[0.28em]"
                style={{ color: state.placeAccent }}
              >
                {state.place}
              </div>
              <div className="mt-1 flex items-baseline gap-3 font-mono text-[11px] text-white/90">
                <span>{state.altitude.toFixed(0)} m</span>
                <span className="text-amber-200/90">{state.speed.toFixed(0)} m/s</span>
                <span className="text-white/45">{state.clock}</span>
              </div>
              {state.drop > 12 && Number.isFinite(state.drop) && (
                <div className="mt-0.5 font-mono text-[10px] text-rose-200/80">
                  ▼ {state.drop.toFixed(0)} m of air
                </div>
              )}
            </div>

            <div
              className={`rounded-2xl border px-3 py-1.5 font-mono text-[10px] backdrop-blur-md transition-colors ${
                state.thrusting
                  ? "border-amber-300/60 bg-amber-400/15 text-amber-100"
                  : "border-white/10 bg-black/40 text-white/45"
              }`}
            >
              JETPACK {state.thrusting ? "FIRING" : "READY"}
            </div>

            {(state.earned > 0 || state.found.got > 0) && (
              <div className="rounded-2xl border border-white/10 bg-black/40 px-3 py-1.5 font-mono text-[10px] text-white/80 backdrop-blur-md">
                <span className="text-amber-200">◎ {state.earned}</span>
                {state.found.total > 0 && (
                  <span className="ml-3 text-emerald-200/90">
                    ✦ {state.found.got}/{state.found.total}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Controls, top right. */}
          <div className="absolute right-3 top-3 z-20 flex items-center gap-2">
            {state.who && (
              <span className="hidden rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-white/70 backdrop-blur-md sm:inline">
                {state.who}
              </span>
            )}
            <EmpyreanSkyPanel
              state={state}
              onHour={(p) => worldRef.current?.setDayPhase(p)}
              onWeather={(c) => worldRef.current?.setWeather(c as Condition | null)}
            />
            <button
              onClick={toggleMute}
              className="rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-white/90 backdrop-blur-md transition-colors hover:bg-black/60"
              title="Mute"
            >
              {muted ? "🔇" : "🔊"}
            </button>
            <button
              onClick={() => worldRef.current?.recall()}
              className="rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-white/90 backdrop-blur-md transition-colors hover:bg-black/60"
            >
              ↺ Halo
            </button>
          </div>

          {/* The activity panel. Right side, above the map. */}
          {state.activity && (
            <div className="pointer-events-none absolute right-4 top-16 z-20 w-60">
              <div className="rounded-2xl border border-cyan-200/25 bg-black/50 px-3 py-2.5 backdrop-blur-md">
                <div className="text-[10px] uppercase tracking-[0.24em] text-cyan-200/90">
                  {state.activity.title}
                </div>
                {state.activity.lines.map((l, i) => (
                  <div key={i} className="mt-1 font-mono text-[11px] leading-snug text-white/85">
                    {l}
                  </div>
                ))}
                {state.activity.progress !== undefined && (
                  <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-amber-300 transition-[width] duration-300"
                      style={{ width: `${Math.max(0, Math.min(1, state.activity.progress)) * 100}%` }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Toasts. Centre, above the prompt. */}
          <div className="pointer-events-none absolute inset-x-0 top-[14%] z-20 flex flex-col items-center gap-1.5 px-6">
            {state.toasts.map((t) => (
              <div
                key={t.id}
                className={`rounded-full border px-4 py-1.5 text-center text-[12px] backdrop-blur-md ${
                  t.tone === "good"
                    ? "border-emerald-300/40 bg-emerald-400/15 text-emerald-100"
                    : t.tone === "warn"
                      ? "border-amber-300/40 bg-amber-400/15 text-amber-100"
                      : "border-white/15 bg-black/45 text-white/90"
                }`}
                style={{ opacity: Math.min(1, t.ttl * 2.5) }}
              >
                {t.text}
              </div>
            ))}
          </div>

          {/* The interact prompt. */}
          {state.prompt && (
            <div className="pointer-events-none absolute inset-x-0 bottom-24 z-20 flex justify-center px-6">
              <div className="rounded-2xl border border-white/20 bg-black/55 px-4 py-2 text-center backdrop-blur-md">
                <div className="text-[13px] text-white">
                  {!isTouch && (
                    <kbd className="mr-2 rounded border border-white/25 bg-white/10 px-1.5 py-0.5 font-mono text-[11px]">
                      E
                    </kbd>
                  )}
                  {state.prompt.label}
                </div>
                {state.prompt.detail && (
                  <div className="mt-0.5 text-[11px] text-white/60">{state.prompt.detail}</div>
                )}
              </div>
            </div>
          )}

          {hint && !state.prompt && (
            <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center px-6 sm:bottom-10">
              <div className="rounded-full border border-white/10 bg-black/40 px-4 py-2 text-center text-[11px] text-white/70 backdrop-blur-md">
                {isTouch
                  ? "Hold the rocket to climb · walk up to things and tap ✦"
                  : "Hold Space to climb · E at anything with a prompt · R returns you to the Halo · H hides the interface"}
              </div>
            </div>
          )}

          {/* ---- Touch controls ------------------------------------------ */}
          {isTouch && (
            <>
              <div
                ref={padRef}
                onPointerDown={(e) => {
                  padTouch.current = e.pointerId;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  padMove(e.clientX, e.clientY);
                }}
                onPointerMove={(e) => {
                  if (padTouch.current === e.pointerId) padMove(e.clientX, e.clientY);
                }}
                onPointerUp={padEnd}
                onPointerCancel={padEnd}
                className="absolute bottom-8 left-6 z-20 h-32 w-32 rounded-full border border-white/15 bg-black/25 backdrop-blur-sm"
              >
                <div
                  className="pointer-events-none absolute left-1/2 top-1/2 h-14 w-14 rounded-full border border-cyan-200/50 bg-cyan-300/20"
                  style={{
                    transform: `translate(calc(-50% + ${knob.x * 34}px), calc(-50% + ${knob.y * 34}px))`,
                  }}
                />
              </div>
              <div className="absolute bottom-10 right-6 z-20 flex flex-col items-center gap-3">
                {state.prompt && (
                  <button
                    onPointerDown={() => worldRef.current?.interact()}
                    className="h-16 w-16 rounded-full border border-cyan-200/40 bg-cyan-400/20 text-2xl text-cyan-50 backdrop-blur-sm active:bg-cyan-400/40"
                  >
                    ✦
                  </button>
                )}
                <button
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setJet(true);
                  }}
                  onPointerUp={() => setJet(false)}
                  onPointerCancel={() => setJet(false)}
                  onPointerLeave={() => setJet(false)}
                  className="h-24 w-24 rounded-full border border-amber-200/30 bg-amber-400/15 text-3xl text-amber-100 backdrop-blur-sm active:bg-amber-400/35"
                >
                  🚀
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
