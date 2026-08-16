/**
 * THE DUNE SEA — sandboarding a bowl of dunes, with the sunset as the clock.
 *
 * Thin page, same as Seafair, San Palmas and The Glass Lake: it owns the
 * title card, the HUD and the touch pad, and mounts a container the engine
 * renders into. Everything that moves lives in `src/dunes/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import type { DuneSeaWorld, DuneState } from "@/dunes/world";

export default function DuneSea() {
  useWorldStamp("/dunes", "The Dune Sea");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<DuneSeaWorld | null>(null);
  const [started, setStarted] = useState(false);
  const [booting, setBooting] = useState(false);
  const [state, setState] = useState<DuneState>({
    gates: 0,
    totalGates: 8,
    speed: 0,
    distance: 900,
    sun: 1,
    airTime: 0,
    bestAir: 0,
    arrived: false,
    benighted: false,
  });

  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  useEffect(() => () => worldRef.current?.dispose(), []);

  const start = useCallback(async () => {
    if (worldRef.current || booting) return;
    setBooting(true);
    const { createDuneSea } = await import("@/dunes/world");
    if (!containerRef.current) return;
    worldRef.current = createDuneSea({ container: containerRef.current, onState: setState });
    setBooting(false);
    setStarted(true);
  }, [booting]);

  useEffect(() => {
    if (shotMode) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotMode]);

  // ---- Touch pad --------------------------------------------------------
  const padRef = useRef<HTMLDivElement | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0, active: false });

  const padMove = useCallback((clientX: number, clientY: number) => {
    const pad = padRef.current;
    const world = worldRef.current;
    if (!pad || !world) return;
    const r = pad.getBoundingClientRect();
    const max = r.width / 2;
    let dx = (clientX - (r.left + r.width / 2)) / max;
    let dy = (clientY - (r.top + r.height / 2)) / max;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    world.stick.x = dx;
    world.stick.y = dy;
    setKnob({ x: dx, y: dy, active: true });
  }, []);

  const padEnd = useCallback(() => {
    const world = worldRef.current;
    if (world) {
      world.stick.x = 0;
      world.stick.y = 0;
    }
    setKnob({ x: 0, y: 0, active: false });
  }, []);

  const isTouch =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  // The sun bar is the clock. 1 = high, 0 = on the horizon.
  const sunPct = Math.max(0, Math.min(1, state.sun)) * 100;

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#1b2545] select-none">
      <div ref={containerRef} className="absolute inset-0" />

      {!started && !shotMode && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center">
          <div
            className="absolute inset-0 -z-10"
            style={{
              background:
                "linear-gradient(180deg, #23306a 0%, #7d5a8e 42%, #e88a4a 74%, #f6c179 100%)",
            }}
          />
          <div
            className="absolute inset-x-0 bottom-0 -z-10 h-[38%]"
            style={{ background: "linear-gradient(180deg, rgba(180,110,60,0) 0%, #8a4e28 100%)" }}
          />
          <p className="mb-3 text-[11px] uppercase tracking-[0.42em] text-amber-100/80">
            The vibeverse
          </p>
          <h1 className="font-heading text-4xl tracking-tight text-white sm:text-6xl">
            The Dune Sea
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-amber-50/90">
            Nine hundred metres of sand between you and the oasis, and about
            three minutes of sun. You never push — the slope is the engine.
            Hold the fall line, fly off the crests, and ride the gates: every
            one you take puts the sun back up.
          </p>
          <button
            onClick={start}
            disabled={booting}
            className="mt-8 rounded-full border border-amber-200/60 bg-amber-300/15 px-8 py-3 text-sm font-semibold text-amber-50 shadow-[0_0_40px_rgba(255,180,90,0.45)] transition-colors hover:bg-amber-300/25 disabled:opacity-60"
          >
            {booting ? "Raising the dunes…" : "Drop in"}
          </button>
          <p className="mt-5 text-[11px] text-amber-100/70">
            {isTouch
              ? "Stick to steer · tap ⤴ to jump"
              : "WASD to steer · Shift to tuck · Space to jump · drag to look"}
          </p>
          <Link
            to="/"
            className="mt-8 text-xs text-amber-100/70 underline-offset-4 hover:text-white hover:underline"
          >
            ← back to the vibeverse
          </Link>
        </div>
      )}

      {started && !shotMode && (
        <>
          {/* Under the app's home button, which every chromeless world gets. */}
          <div className="pointer-events-none absolute left-3 top-16 z-10 flex flex-col gap-2">
            <div className="rounded-2xl border border-white/15 bg-black/30 px-3 py-2 backdrop-blur-md">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-amber-100/85">
                <span>Sun</span>
                <span className="font-mono text-white">
                  {state.sun > 0 ? `${(state.sun * 100).toFixed(0)}%` : "down"}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-40 overflow-hidden rounded-full bg-black/40">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-rose-500 via-amber-400 to-yellow-200 transition-[width] duration-300"
                  style={{ width: `${sunPct}%` }}
                />
              </div>
            </div>
            <div className="rounded-2xl border border-white/15 bg-black/30 px-3 py-1.5 font-mono text-[11px] text-amber-50/90 backdrop-blur-md">
              {state.speed.toFixed(0).padStart(2, "0")} m/s
              <span className="ml-3 text-cyan-200/90">
                ◎ {state.gates}/{state.totalGates}
              </span>
              <span className="ml-3 text-amber-200/85">{state.distance.toFixed(0)} m</span>
            </div>
          </div>

          <div className="absolute right-3 top-3 z-10">
            <button
              onClick={() => worldRef.current?.restart()}
              className="rounded-full border border-white/15 bg-black/30 px-3 py-1.5 text-xs text-amber-50 backdrop-blur-md transition-colors hover:bg-black/50"
            >
              ↺ New run
            </button>
          </div>

          {/* Air time, while you have it. */}
          {state.airTime > 0.35 && (
            <div className="pointer-events-none absolute inset-x-0 top-1/4 z-10 flex justify-center">
              <div className="rounded-full border border-amber-200/50 bg-black/35 px-5 py-2 font-mono text-lg text-amber-100 backdrop-blur-md">
                {state.airTime.toFixed(1)}s air
              </div>
            </div>
          )}

          {(state.arrived || state.benighted) && (
            <div className="pointer-events-none absolute inset-x-0 top-1/4 z-10 flex justify-center px-6 animate-fade-in">
              <div
                className={`rounded-2xl border px-6 py-4 text-center backdrop-blur-md ${
                  state.arrived
                    ? "border-amber-200/50 bg-black/45 shadow-[0_0_50px_rgba(255,190,110,0.4)]"
                    : "border-indigo-300/40 bg-black/55"
                }`}
              >
                <div className="font-heading text-xl text-amber-50">
                  {state.arrived ? "The oasis, with light to spare" : "The sun is gone"}
                </div>
                <div className="mt-1 text-xs text-amber-100/80">
                  {state.arrived
                    ? `${state.gates}/${state.totalGates} gates · best air ${state.bestAir.toFixed(1)}s`
                    : "Ride on if you like — the dunes do not mind the dark."}
                </div>
              </div>
            </div>
          )}

          {isTouch && (
            <>
              <div
                ref={padRef}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  padMove(e.clientX, e.clientY);
                }}
                onPointerMove={(e) => {
                  if (knob.active) padMove(e.clientX, e.clientY);
                }}
                onPointerUp={padEnd}
                onPointerCancel={padEnd}
                className="absolute bottom-8 left-6 z-10 h-32 w-32 rounded-full border border-white/20 bg-black/25 backdrop-blur-sm"
              >
                <div
                  className="pointer-events-none absolute left-1/2 top-1/2 h-14 w-14 rounded-full border border-amber-200/60 bg-amber-300/25"
                  style={{
                    transform: `translate(calc(-50% + ${knob.x * 34}px), calc(-50% + ${knob.y * 34}px))`,
                    opacity: knob.active ? 1 : 0.6,
                  }}
                />
              </div>
              <button
                onPointerDown={() => worldRef.current?.jump()}
                className="absolute bottom-12 right-8 z-10 h-20 w-20 rounded-full border border-white/20 bg-black/30 text-2xl text-amber-100 backdrop-blur-sm active:bg-amber-300/25"
              >
                ⤴
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
