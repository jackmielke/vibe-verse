/**
 * MARS COLLEGE, ten weeks in the desert on one wheel.
 *
 * Thin page: title card, the five meters, the day cards, the prompt at a
 * camp, touch controls, and a container the engine renders into. Everything
 * that moves lives in `src/mars/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import type { MarsState, MarsWorld } from "@/mars/world";

const PART_LABEL: Record<MarsState["part"], string> = {
  morning: "morning",
  afternoon: "afternoon",
  night: "night",
};

export default function Mars() {
  useWorldStamp("/mars", "Mars College");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<MarsWorld | null>(null);
  const [started, setStarted] = useState(false);
  const [booting, setBooting] = useState(false);
  const [state, setState] = useState<MarsState | null>(null);

  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  useEffect(() => () => worldRef.current?.dispose(), []);

  const start = useCallback(async () => {
    if (worldRef.current || booting) return;
    setBooting(true);
    const { createMars } = await import("@/mars/world");
    if (!containerRef.current) return;
    worldRef.current = createMars({ container: containerRef.current, onState: setState, shot: shotMode });
    setBooting(false);
    setStarted(true);
  }, [booting, shotMode]);

  useEffect(() => {
    if (shotMode) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotMode]);

  const isTouch =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  // A joystick for phones: one pad, lean on x, tilt on y.
  const padRef = useRef<HTMLDivElement | null>(null);
  const onPad = (e: React.PointerEvent) => {
    const el = padRef.current;
    const w = worldRef.current;
    if (!el || !w) return;
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 2 - 1;
    const y = -(((e.clientY - r.top) / r.height) * 2 - 1);
    w.stick.x = Math.max(-1, Math.min(1, x * 1.4));
    w.stick.y = Math.max(-1, Math.min(1, y * 1.4));
  };
  const clearPad = () => {
    const w = worldRef.current;
    if (!w) return;
    w.stick.x = 0;
    w.stick.y = 0;
  };

  const meter = (label: string, value: number, colour: string, warnBelow = 25) => (
    <div className="flex items-center gap-2">
      <span className="w-20 text-[10px] uppercase tracking-[0.18em] text-white/75">{label}</span>
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-black/40">
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{
            width: `${Math.max(0, Math.min(100, value))}%`,
            background: value < warnBelow ? "#ff6b6b" : colour,
          }}
        />
      </div>
    </div>
  );

  const busy = !!state && (state.phase !== "play" || !!state.card);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#d9c9a8] select-none">
      <div ref={containerRef} className="absolute inset-0" />

      {!started && !shotMode && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center">
          <div
            className="absolute inset-0 -z-10"
            style={{
              background:
                "linear-gradient(180deg, #b9c9d6 0%, #e9dcc4 40%, #f3e6cc 56%, #d9c9a8 62%, #c9b48c 100%)",
            }}
          />
          <p className="mb-3 text-[11px] uppercase tracking-[0.42em] text-[#5a4630]/80">The vibeverse</p>
          <div className="text-6xl">🏜️</div>
          <h1 className="mt-2 font-heading text-4xl tracking-tight text-[#2b1d0e] sm:text-6xl">Mars College</h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-[#3a2a1a]/90">
            Ten weeks off-grid near the Salton Sea, January to March. Fifty people,
            six camps, pallet racks, plywood, power drills all day, and one table in
            the middle so everybody eats together. You ride an electric unicycle
            with the music up. Water is in town. Solar dies every few days. The
            dust comes in over the sea as a brown wall. Build a shelter, cook
            dinner, get a hug, go for the long run, and when week ten ends it all
            comes down.
          </p>
          <button
            onClick={start}
            disabled={booting}
            className="mt-8 rounded-full border border-[#7a5a30]/50 bg-[#ff9a5c]/25 px-8 py-3 text-sm font-semibold text-[#2b1d0e] shadow-[0_0_40px_rgba(255,154,92,0.35)] transition-colors hover:bg-[#ff9a5c]/40 disabled:opacity-60"
          >
            {booting ? "Raising the pallet racks…" : "Step out onto the sand"}
          </button>
          <p className="mt-5 max-w-md text-[11px] leading-relaxed text-[#5a4630]/80">
            {isTouch
              ? "Pad: up to go, sideways to lean · E at a camp · Zz to sleep to the next part of the day · ♪ music"
              : "W/S tilt · A/D lean · E at a camp, the table or the water station · N sleeps to the next part of the day · M music · drag to look"}
          </p>
          <Link to="/" className="mt-8 text-xs text-[#5a4630]/80 underline-offset-4 hover:text-[#2b1d0e] hover:underline">
            ← back to the vibeverse
          </Link>
        </div>
      )}

      {started && !shotMode && state && (
        <>
          <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col gap-2">
            <div className="rounded-2xl border border-white/20 bg-black/35 px-3 py-2 backdrop-blur-md">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-heading text-base text-white">
                  Week {state.week} · day {state.day}
                </span>
                <span className="font-mono text-[11px] text-white/80">{PART_LABEL[state.part]}</span>
              </div>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/15">
                <div className="h-full bg-white/70" style={{ width: `${state.partT * 100}%` }} />
              </div>
              <div className="mt-1 flex items-center justify-between font-mono text-[11px] text-white/85">
                <span>{state.speedKmh.toFixed(0)} km/h</span>
                <span>{state.parts} parts</span>
                <span>{state.music ? "♪ on" : "♪ off"}</span>
              </div>
            </div>
            <div className="flex flex-col gap-1.5 rounded-2xl border border-white/20 bg-black/35 px-3 py-2 backdrop-blur-md">
              {meter("Water", state.water, "#8fd3ff")}
              {meter("Solar", state.power, "#ffd24a")}
              {meter("Shelter", state.shelter, "#c9a86a", 0)}
              {meter("Connection", state.connection, "#ff9ab8")}
              {meter("Purpose", state.purpose, "#7ee2a0")}
            </div>
            {(state.storm || state.stormWarning) && (
              <div className="rounded-2xl border border-amber-200/40 bg-[#5a3a1a]/60 px-3 py-1.5 text-[11px] text-amber-100 backdrop-blur-md">
                {state.storm ? "DUST STORM. Inside is the only place that counts today." : "A brown wall on the horizon. Tomorrow is a dust day."}
              </div>
            )}
          </div>

          <div className="absolute right-3 top-3 z-10 flex gap-2">
            {!busy && (
              <Link
                to="/"
                className="rounded-full border border-white/15 bg-black/30 px-3 py-1.5 text-xs text-white backdrop-blur-md transition-colors hover:bg-black/50"
              >
                ← vibeverse
              </Link>
            )}
            <button
              onClick={() => worldRef.current?.restart()}
              className="rounded-full border border-white/15 bg-black/30 px-3 py-1.5 text-xs text-white backdrop-blur-md transition-colors hover:bg-black/50"
            >
              ↺ Day one
            </button>
          </div>

          {state.prompt && !state.card && state.phase === "play" && (
            <div className="pointer-events-none absolute inset-x-0 bottom-32 z-10 flex justify-center px-4">
              <div className="rounded-full border border-amber-200/60 bg-black/45 px-4 py-1.5 text-center text-xs text-amber-50 backdrop-blur-md">
                <span className="text-amber-200">{state.prompt.place}</span> · {isTouch ? "tap E" : "press E"} to {state.prompt.label}
              </div>
            </div>
          )}

          {state.note && !state.card && (
            <div className="pointer-events-none absolute inset-x-0 top-1/4 z-10 flex justify-center px-6 animate-fade-in">
              <div className="max-w-md rounded-2xl border border-white/30 bg-black/45 px-5 py-3 text-center text-sm text-white backdrop-blur-md">
                {state.note}
              </div>
            </div>
          )}

          {state.card && (
            <div
              className="absolute inset-0 z-30 flex items-center justify-center bg-black/35 px-6"
              onClick={() => worldRef.current?.dismissCard()}
            >
              <div className="max-w-lg rounded-3xl border border-[#c9a86a]/60 bg-[#f2e8d0] px-7 py-6 text-[#2b1d0e] shadow-2xl animate-fade-in">
                <div className="flex items-baseline justify-between gap-4">
                  <div className="font-heading text-2xl">{state.card.title}</div>
                  <div className="font-mono text-xs text-[#7a5a30]">{state.card.date}</div>
                </div>
                <div className="mt-3 flex flex-col gap-2 text-sm leading-relaxed">
                  {state.card.lines.map((l, i) => (
                    <p key={i} className={i === state.card!.lines.length - 1 && state.phase === "done" ? "font-semibold" : ""}>
                      {l}
                    </p>
                  ))}
                </div>
                {state.phase === "done" && (
                  <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-[#c9a86a]/60 pt-3 font-mono text-xs text-[#4a3418] sm:grid-cols-3">
                    <span>{state.stats.dinners} dinners cooked</span>
                    <span>{state.stats.km.toFixed(1)} km ridden</span>
                    <span>{state.stats.kmRun} km run</span>
                    <span>{state.stats.storms} dust storms survived</span>
                    <span>{state.stats.waterRuns} water runs</span>
                    <span>{state.stats.hugs} hugs</span>
                    <span>{state.stats.builds} things built</span>
                    <span>{state.stats.falls} falls off the wheel</span>
                    <span>{state.stats.scorpions} scorpions</span>
                  </div>
                )}
                {state.phase === "done" && <p className="mt-3 text-xs italic text-[#7a5a30]">{state.grade}</p>}
                <p className="mt-4 text-[11px] text-[#7a5a30]">
                  {state.phase === "done" ? "Reintegrating with society is going to be a trip. ↺ rides it again." : isTouch ? "tap to carry on" : "E or click to carry on"}
                </p>
              </div>
            </div>
          )}

          {state.phase === "teardown" && (
            <div className="pointer-events-none absolute inset-x-0 top-1/3 z-10 flex justify-center px-6">
              <div className="rounded-2xl border border-white/30 bg-black/45 px-5 py-3 text-center text-sm text-white backdrop-blur-md">
                Teardown. Everything built from scratch comes down from scratch.
              </div>
            </div>
          )}

          {isTouch && !busy && (
            <div className="absolute inset-x-0 bottom-6 z-10 flex items-end justify-between px-6">
              <div
                ref={padRef}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  onPad(e);
                }}
                onPointerMove={onPad}
                onPointerUp={clearPad}
                onPointerCancel={clearPad}
                className="h-32 w-32 rounded-full border border-white/25 bg-black/30 backdrop-blur-sm"
              >
                <div className="flex h-full items-center justify-center text-[10px] uppercase tracking-widest text-white/50">lean · tilt</div>
              </div>
              <div className="flex gap-3">
                <button
                  onPointerDown={() => worldRef.current?.toggleMusic()}
                  className="h-14 w-14 rounded-full border border-white/25 bg-black/30 text-lg backdrop-blur-sm active:bg-amber-300/30"
                >
                  ♪
                </button>
                <button
                  onPointerDown={() => worldRef.current?.sleep()}
                  className="h-16 w-16 rounded-full border border-white/25 bg-black/30 text-sm font-semibold text-white backdrop-blur-sm active:bg-sky-300/30"
                >
                  Zz
                </button>
                <button
                  onPointerDown={() => worldRef.current?.interact()}
                  className="h-16 w-16 rounded-full border border-amber-200/50 bg-amber-300/20 text-xl font-semibold text-amber-50 backdrop-blur-sm active:bg-amber-300/40"
                >
                  E
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
