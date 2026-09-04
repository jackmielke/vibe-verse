/**
 * THE HALF-BLIND TRIATHLON: Lake Chelan, September 6, 2025, through goggles
 * that fogged on the first stroke.
 *
 * Thin page: title card, the HUD for whichever leg you are on, the voice-note
 * cards on the run, the finish sheet, and touch controls. Everything that
 * moves lives in `src/goggles/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import type { GogglesWorld } from "@/goggles/world";
import { AFTERWARDS, EXPECTED_SECONDS, fmtClock, type Pace, type RaceState } from "@/goggles/race";
import { REAL } from "@/goggles/course";

const LEG_NAME: Record<RaceState["leg"], string> = {
  swim: "Swim · 1.5 km",
  bike: "Bike · 40 km",
  run: "Run · 10 km",
  finish: "Finish",
};

export default function Goggles() {
  useWorldStamp("/goggles", "The Half-Blind Triathlon");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<GogglesWorld | null>(null);
  const [started, setStarted] = useState(false);
  const [booting, setBooting] = useState(false);
  const [state, setState] = useState<RaceState | null>(null);

  const shotParam =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("shot") : null;
  const shotMode = shotParam !== null;
  const shotLeg: true | RaceState["leg"] =
    shotParam === "bike" || shotParam === "run" || shotParam === "finish" || shotParam === "swim" ? shotParam : true;

  useEffect(() => () => worldRef.current?.dispose(), []);

  const start = useCallback(async () => {
    if (worldRef.current || booting) return;
    setBooting(true);
    const { createGogglesWorld } = await import("@/goggles/world");
    if (!containerRef.current) return;
    worldRef.current = createGogglesWorld({
      container: containerRef.current,
      onState: setState,
      shot: shotMode ? shotLeg : false,
    });
    setBooting(false);
    setStarted(true);
  }, [booting, shotMode, shotLeg]);

  useEffect(() => {
    if (shotMode) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotMode]);

  const isTouch =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  const hold = (set: () => void, clear: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      set();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
  });

  const meter = (label: string, value: number, colour: string, warnAbove?: number) => (
    <div className="flex items-center gap-2">
      <span className="w-20 text-[10px] uppercase tracking-[0.18em] text-white/70">{label}</span>
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-black/40">
        <div
          className="h-full rounded-full transition-[width] duration-150"
          style={{
            width: `${Math.max(0, Math.min(100, value))}%`,
            background: warnAbove !== undefined && value > warnAbove ? "#ff6b6b" : colour,
          }}
        />
      </div>
    </div>
  );

  const midAction = !!state && !state.finished && (state.leg !== "swim" || state.speed > 1);
  const over = state ? state.raceSeconds - EXPECTED_SECONDS : 0;

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#9fb9b3] select-none">
      <div ref={containerRef} className="absolute inset-0" />

      {!started && !shotMode && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center">
          <div
            className="absolute inset-0 -z-10"
            style={{
              background:
                "linear-gradient(180deg, #d9c8b6 0%, #f3cba6 30%, #c9a85a 52%, #2f8a80 70%, #145550 100%)",
            }}
          />
          <p className="mb-3 text-[11px] uppercase tracking-[0.42em] text-white/80">The vibeverse</p>
          <div className="text-6xl">🥽</div>
          <h1 className="mt-2 font-heading text-4xl tracking-tight text-white drop-shadow sm:text-6xl">
            The Half-Blind Triathlon
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-white/95 drop-shadow">
            Lake Chelan, September 6, 2025. Ten days&apos; notice, because Murph
            asked. The goggles fog on the first stroke and stay fogged: steer by
            orange blob, breathe on the beat and not into a wave, and stop to
            clear the lens when you must. Then a bike with no top gear and no
            brakes over 1,700 feet of rollers, and a run on shoes with no
            cushion left. Expected three hours. Closer to four. Finished.
          </p>
          <button
            onClick={start}
            disabled={booting}
            className="mt-8 rounded-full border border-white/60 bg-white/15 px-8 py-3 text-sm font-semibold text-white shadow-[0_0_40px_rgba(255,255,255,0.35)] backdrop-blur transition-colors hover:bg-white/25 disabled:opacity-60"
          >
            {booting ? "Fogging the goggles…" : "Get in the lake"}
          </button>
          <p className="mt-5 max-w-md text-[11px] text-white/80">
            {isTouch
              ? "◀ ▶ steer · GO to stroke, pedal, push · BREATHE on the beat · CLEAR the goggles · 1 2 3 pace on the run"
              : "A/D steer and lean · hold W or space to stroke, pedal, push · E breathe on the beat · Q stop and clear the goggles · 1/2/3 pace on the run"}
          </p>
          <Link to="/" className="mt-8 text-xs text-white/80 underline-offset-4 hover:text-white hover:underline">
            ← back to the vibeverse
          </Link>
        </div>
      )}

      {started && !shotMode && state && (
        <>
          <div className="pointer-events-none absolute left-3 top-16 z-10 flex flex-col gap-2">
            <div className="rounded-2xl border border-white/20 bg-black/35 px-3 py-2 backdrop-blur-md">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-heading text-base text-white">{LEG_NAME[state.leg]}</span>
                <span className="font-mono text-[12px] text-white/85">{fmtClock(state.raceSeconds)}</span>
              </div>
              {state.leg === "swim" && (
                <div className="mt-1 font-mono text-[11px] text-white/80">
                  {(state.s * REAL.swimMetres).toFixed(0)} m
                  {state.inChurn ? " · in the churn" : ""}
                  {state.splash > 0.4 ? " · kayaks!" : ""}
                  {state.clearing ? " · treading water" : ""}
                </div>
              )}
              {state.leg === "bike" && (
                <div className="mt-1 flex items-center justify-between gap-3 font-mono text-[11px] text-white/80">
                  <span>{(state.s * REAL.bikeKm).toFixed(1)} km · {state.section}</span>
                  <span>
                    {state.grade > 0.02 ? "▲" : state.grade < -0.02 ? "▼" : "flat"} {(Math.abs(state.grade) * 100).toFixed(0)}%
                  </span>
                  <span className={state.capped ? "text-amber-200" : ""}>
                    {(state.speed * 3.6 * 1.6).toFixed(0)} km/h{state.capped ? " · NO TOP GEAR" : ""}
                  </span>
                </div>
              )}
              {state.leg === "run" && (
                <div className="mt-1 font-mono text-[11px] text-white/80">
                  km {state.km.toFixed(1)} · {state.walking ? "WALKING" : ["", "EASY", "STEADY", "PUSH"][state.pace]}
                </div>
              )}
            </div>

            {state.leg === "swim" && (
              <div className="flex flex-col gap-1.5 rounded-2xl border border-white/20 bg-black/35 px-3 py-2 backdrop-blur-md">
                {meter("Lens fog", state.fog * 100, "#dfeeea", 80)}
                {meter("Air", Math.max(0, 100 - (state.airHunger / 5.3) * 100), "#8fd3ff")}
                <div className="flex items-center gap-2">
                  <span className="w-20 text-[10px] uppercase tracking-[0.18em] text-white/70">Lake Chelan</span>
                  <span className="font-mono text-[12px] text-teal-100">{state.lake.toFixed(1)}% ingested</span>
                </div>
                <div className="text-[10px] text-white/60">off the line: {(state.offMetres * REAL.swimMetres).toFixed(0)} m</div>
              </div>
            )}

            {state.leg === "bike" && (
              <div className="flex flex-col gap-1.5 rounded-2xl border border-white/20 bg-black/35 px-3 py-2 backdrop-blur-md">
                <div className="flex items-center gap-2 font-mono text-[11px] text-white/85">
                  {state.corner ? (
                    <span className={state.corner.distance < 40 ? "text-amber-200" : ""}>
                      {state.corner.dir < 0 ? "◀ LEFT" : "RIGHT ▶"} in {state.corner.distance.toFixed(0)} m
                      {state.corner.distance < 40 ? " · lean!" : ""}
                    </span>
                  ) : (
                    <span>straight</span>
                  )}
                </div>
                <div className="text-[10px] text-white/60">
                  {state.climbFeet.toFixed(0)} ft climbed · corners run wide: {state.cornersWide}
                </div>
              </div>
            )}

            {state.leg === "run" && (
              <div className="flex flex-col gap-1.5 rounded-2xl border border-white/20 bg-black/35 px-3 py-2 backdrop-blur-md">
                {meter("Ankles", state.ankle, "#ffb35c", 80)}
                <div className="text-[10px] text-white/60">1 easy · 2 steady · 3 push · full ankles means walking</div>
              </div>
            )}
          </div>

          <div className="absolute right-3 top-3 z-10 flex gap-2">
            {!midAction && (
              <Link
                to="/"
                className="rounded-full border border-white/15 bg-black/30 px-3 py-1.5 text-xs text-white backdrop-blur-md transition-colors hover:bg-black/50"
              >
                ← hub
              </Link>
            )}
            <button
              onClick={() => worldRef.current?.restart()}
              className="rounded-full border border-white/15 bg-black/30 px-3 py-1.5 text-xs text-white backdrop-blur-md transition-colors hover:bg-black/50"
            >
              ↺ Restart
            </button>
          </div>

          {state.note && !state.finished && (
            <div className="pointer-events-none absolute inset-x-0 top-[22%] z-10 flex justify-center px-6 animate-fade-in">
              <div className="max-w-md rounded-2xl border border-white/30 bg-black/45 px-5 py-3 text-center text-sm italic text-white backdrop-blur-md">
                {state.note}
              </div>
            </div>
          )}

          {state.card && state.leg === "run" && (
            <div className="pointer-events-none absolute inset-x-0 bottom-32 z-10 flex justify-center px-6 animate-fade-in">
              <div className="w-80 rounded-2xl border border-white/20 bg-[#1c1c1e]/90 px-4 py-3 text-left shadow-xl backdrop-blur-md">
                <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-white/50">
                  <span>Voice note · km {state.card.km}</span>
                  <span className="text-red-400">● REC</span>
                </div>
                <div className="my-2 flex h-6 items-end gap-[3px]">
                  {Array.from({ length: 36 }).map((_, i) => (
                    <div
                      key={i}
                      className="w-1 rounded-sm bg-white/70"
                      style={{ height: `${25 + Math.abs(Math.sin(i * 1.7 + state.card!.km)) * 75}%` }}
                    />
                  ))}
                </div>
                <div className="text-sm leading-snug text-white">&ldquo;{state.card.text}&rdquo;</div>
              </div>
            </div>
          )}

          {state.finished && (
            <div className="absolute inset-x-0 top-[14%] z-10 flex justify-center px-6 animate-fade-in">
              <div className="w-full max-w-md rounded-2xl border border-white/40 bg-black/55 px-6 py-5 text-center backdrop-blur-md">
                <div className="text-[10px] uppercase tracking-[0.3em] text-white/60">Lake Chelan · Olympic distance</div>
                <div className="mt-1 font-heading text-3xl text-white">{fmtClock(state.raceSeconds)}</div>
                <div className="font-mono text-xs text-white/70">
                  expected 3:00:00 · {over >= 0 ? "+" : "-"}
                  {fmtClock(Math.abs(over))}
                </div>
                <div className="mt-3 font-heading text-lg text-amber-100">Last in age group. Finished.</div>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-left font-mono text-[11px] text-white/80">
                  <span>Lake Chelan ingested</span>
                  <span className="text-right">{state.lake.toFixed(1)}%</span>
                  <span>Swum off course</span>
                  <span className="text-right">{(state.offMetres * REAL.swimMetres).toFixed(0)} m</span>
                  <span>Goggles cleared</span>
                  <span className="text-right">{state.clears}×</span>
                  <span>Corners run wide</span>
                  <span className="text-right">{state.cornersWide}</span>
                  <span>Walk breaks</span>
                  <span className="text-right">{state.walks}</span>
                </div>
                <div className="mt-3 text-sm italic text-white">&ldquo;{state.verdict}&rdquo;</div>
                <div className="mt-3 space-y-0.5 text-[11px] text-white/60">
                  {AFTERWARDS.map((l) => (
                    <div key={l}>{l}</div>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <Link
                    to="/"
                    className="rounded-full border border-amber-200/60 bg-amber-300/20 px-5 py-2 text-xs font-semibold text-amber-50 transition-colors hover:bg-amber-300/30"
                  >
                    Next: Escape from Alcatraz →
                  </Link>
                  <button
                    onClick={() => worldRef.current?.restart()}
                    className="rounded-full border border-white/30 bg-white/10 px-5 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/20"
                  >
                    Race it again
                  </button>
                </div>
              </div>
            </div>
          )}

          {isTouch && !state.finished && (
            <div className="absolute inset-x-0 bottom-5 z-10 flex items-end justify-between px-4">
              <div className="flex gap-2">
                <button
                  {...hold(() => (worldRef.current!.touch.steer = -1), () => (worldRef.current!.touch.steer = 0))}
                  className="h-16 w-16 rounded-2xl border border-white/30 bg-black/30 text-2xl text-white backdrop-blur-sm active:bg-white/30"
                >
                  ◀
                </button>
                <button
                  {...hold(() => (worldRef.current!.touch.steer = 1), () => (worldRef.current!.touch.steer = 0))}
                  className="h-16 w-16 rounded-2xl border border-white/30 bg-black/30 text-2xl text-white backdrop-blur-sm active:bg-white/30"
                >
                  ▶
                </button>
              </div>
              {state.leg === "run" ? (
                <div className="flex gap-2">
                  {([1, 2, 3] as Pace[]).map((p) => (
                    <button
                      key={p}
                      onPointerDown={() => worldRef.current?.setPace(p)}
                      className={`h-14 w-14 rounded-xl border text-sm font-semibold backdrop-blur-sm ${
                        state.pace === p ? "border-amber-200/70 bg-amber-300/40 text-amber-50" : "border-white/30 bg-black/30 text-white"
                      }`}
                    >
                      {["", "EASY", "STEADY", "PUSH"][p]}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex gap-2">
                  {state.leg === "swim" && (
                    <>
                      <button
                        onPointerDown={() => worldRef.current?.breathe()}
                        className="h-16 w-20 rounded-2xl border border-sky-200/50 bg-sky-300/20 text-xs font-semibold text-sky-50 backdrop-blur-sm active:bg-sky-300/40"
                      >
                        BREATHE
                      </button>
                      <button
                        {...hold(() => (worldRef.current!.touch.clear = true), () => (worldRef.current!.touch.clear = false))}
                        className="h-16 w-16 rounded-2xl border border-white/40 bg-white/15 text-xs font-semibold text-white backdrop-blur-sm active:bg-white/40"
                      >
                        CLEAR
                      </button>
                    </>
                  )}
                  <button
                    {...hold(() => (worldRef.current!.touch.stroke = true), () => (worldRef.current!.touch.stroke = false))}
                    className="h-16 w-24 rounded-2xl border border-amber-200/50 bg-amber-300/20 text-sm font-semibold text-amber-50 backdrop-blur-sm active:bg-amber-300/40"
                  >
                    {state.leg === "swim" ? "STROKE" : "PEDAL"}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
