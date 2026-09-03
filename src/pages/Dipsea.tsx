/**
 * THE DIPSEA — Mill Valley to Stinson Beach, on foot, over the mountain.
 *
 * Thin page, same shape as the Dune Sea: title card, HUD, touch controls,
 * and a container the engine renders into. Everything that moves lives in
 * `src/dipsea/`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import type { DipseaState, DipseaWorld, Mode } from "@/dipsea/world";
import { COURSE_MILES, SECTIONS, elevationFeet } from "@/dipsea/trail";

const PROFILE_W = 320;
const PROFILE_H = 64;

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Dipsea() {
  useWorldStamp("/dipsea", "The Dipsea");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<DipseaWorld | null>(null);
  const [started, setStarted] = useState(false);
  const [booting, setBooting] = useState(false);
  const [mode, setMode] = useState<Mode>("single");
  const [state, setState] = useState<DipseaState | null>(null);

  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  useEffect(() => () => worldRef.current?.dispose(), []);

  const start = useCallback(
    async (m: Mode) => {
      if (worldRef.current || booting) return;
      setBooting(true);
      setMode(m);
      const { createDipsea } = await import("@/dipsea/world");
      if (!containerRef.current) return;
      worldRef.current = createDipsea({ container: containerRef.current, mode: m, onState: setState });
      setBooting(false);
      setStarted(true);
    },
    [booting],
  );

  useEffect(() => {
    if (shotMode) void start("single");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotMode]);

  const isTouch =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  // The elevation profile, drawn once.
  const profile = useMemo(() => {
    const n = 120;
    const pts: string[] = [];
    let max = 0;
    for (let i = 0; i <= n; i++) max = Math.max(max, elevationFeet((i / n) * COURSE_MILES));
    for (let i = 0; i <= n; i++) {
      const x = (i / n) * PROFILE_W;
      const y = PROFILE_H - (elevationFeet((i / n) * COURSE_MILES) / max) * (PROFILE_H - 6) - 3;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return { path: pts.join(" "), max };
  }, []);

  const dotY = (mile: number) =>
    PROFILE_H - (elevationFeet(mile) / profile.max) * (PROFILE_H - 6) - 3;
  const dotX = (mile: number) => (mile / COURSE_MILES) * PROFILE_W;

  const meter = (label: string, value: number, colour: string, warnBelow?: number) => (
    <div className="flex items-center gap-2">
      <span className="w-16 text-[10px] uppercase tracking-[0.18em] text-white/70">{label}</span>
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-black/40">
        <div
          className="h-full rounded-full transition-[width] duration-200"
          style={{
            width: `${Math.max(0, Math.min(100, value))}%`,
            background: warnBelow !== undefined && value < warnBelow ? "#ff6b6b" : colour,
          }}
        />
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#d8e3ea] select-none">
      <div ref={containerRef} className="absolute inset-0" />

      {!started && !shotMode && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center">
          <div
            className="absolute inset-0 -z-10"
            style={{
              background:
                "linear-gradient(180deg, #5b8fc9 0%, #a9c4d8 38%, #e6ecef 60%, #7d8a4a 78%, #3d4a2a 100%)",
            }}
          />
          <p className="mb-3 text-[11px] uppercase tracking-[0.42em] text-white/80">The vibeverse</p>
          <h1 className="font-heading text-4xl tracking-tight text-white drop-shadow sm:text-6xl">
            The Dipsea
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-white/95 drop-shadow">
            Mill Valley to Stinson Beach: 7.3 miles over Mount Tam, with the real
            profile under your feet. 688 stairs, Muir Woods, Cardiac, the Swoop,
            Steep Ravine, Insult, the ocean. Effort is the only control. Stamina
            goes with the hills, the bottle has six sips, and if you push on empty
            you will find out what happened at mile four. Touch a tree. It helps.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={() => start("single")}
              disabled={booting}
              className="rounded-full border border-white/60 bg-white/15 px-7 py-3 text-sm font-semibold text-white shadow-[0_0_40px_rgba(255,255,255,0.35)] backdrop-blur transition-colors hover:bg-white/25 disabled:opacity-60"
            >
              {booting ? "Raising the mountain…" : "Run the Dipsea"}
            </button>
            <button
              onClick={() => start("quad")}
              disabled={booting}
              className="rounded-full border border-amber-200/70 bg-amber-300/20 px-7 py-3 text-sm font-semibold text-amber-50 backdrop-blur transition-colors hover:bg-amber-300/30 disabled:opacity-60"
            >
              Quad Dipsea · 28 miles
            </button>
          </div>
          <p className="mt-5 text-[11px] text-white/80">
            {isTouch
              ? "Stick up to push, down to walk · 💧 sip · 🌲 touch a tree"
              : "Hold W or Shift to push · S to walk · Q to sip · E to touch a tree · drag to look"}
          </p>
          <Link
            to="/"
            className="mt-8 text-xs text-white/80 underline-offset-4 hover:text-white hover:underline"
          >
            ← back to the vibeverse
          </Link>
        </div>
      )}

      {started && !shotMode && state && (
        <>
          <div className="pointer-events-none absolute left-3 top-16 z-10 flex flex-col gap-2">
            <div className="rounded-2xl border border-white/20 bg-black/35 px-3 py-2 backdrop-blur-md">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-heading text-base text-white">{state.section.name}</span>
                <span className="font-mono text-[11px] text-white/80">
                  mi {state.mile.toFixed(2)} · {fmtTime(state.elapsed)}
                </span>
              </div>
              <svg
                width={PROFILE_W}
                height={PROFILE_H}
                viewBox={`0 0 ${PROFILE_W} ${PROFILE_H}`}
                className="mt-1 block"
              >
                <polyline points={profile.path} fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="1.5" />
                <polyline
                  points={`0,${PROFILE_H} ${profile.path} ${PROFILE_W},${PROFILE_H}`}
                  fill="rgba(255,255,255,0.12)"
                  stroke="none"
                />
                {SECTIONS.filter((s) => ["The Stairs", "Muir Woods", "Cardiac", "Steep Ravine", "Insult"].includes(s.name)).map((s) => (
                  <text
                    key={s.name}
                    x={dotX(s.mile)}
                    y={dotY(s.mile) - 4}
                    fill="rgba(255,255,255,0.6)"
                    fontSize="7"
                    textAnchor="middle"
                  >
                    {s.name}
                  </text>
                ))}
                {state.ghosts.map((g) => (
                  <circle key={g.name} cx={dotX(g.mile)} cy={dotY(g.mile)} r="2.4" fill={g.colour} opacity="0.9" />
                ))}
                <circle cx={dotX(state.mile)} cy={dotY(state.mile)} r="3.6" fill="#ffffff" stroke="#000" strokeWidth="0.8" />
              </svg>
              <div className="mt-1 flex items-center justify-between font-mono text-[11px] text-white/85">
                <span>
                  {state.grade > 0.02 ? "▲" : state.grade < -0.02 ? "▼" : "—"} {(Math.abs(state.grade) * 100).toFixed(0)}%
                </span>
                <span>{state.speedMph.toFixed(1)} mph</span>
                <span className={state.effort === "push" ? "text-amber-200" : state.effort === "walk" ? "text-sky-200" : ""}>
                  {state.stopped ? "STOPPED" : state.effort.toUpperCase()}
                </span>
                {state.mode === "quad" && <span>leg {state.leg}/4</span>}
              </div>
            </div>
            <div className="flex flex-col gap-1.5 rounded-2xl border border-white/20 bg-black/35 px-3 py-2 backdrop-blur-md">
              {meter("Stamina", state.stamina, "#7ee2a0", 25)}
              {meter("Nausea", state.nausea, "#ffb35c")}
              {meter("Grounded", state.grounded, "#8fd3ff")}
              <div className="flex items-center gap-2">
                <span className="w-16 text-[10px] uppercase tracking-[0.18em] text-white/70">Bottle</span>
                <span className="font-mono text-[12px] tracking-widest text-sky-200">
                  {"💧".repeat(state.water)}
                  <span className="opacity-30">{"💧".repeat(Math.max(0, 6 - state.water))}</span>
                </span>
              </div>
            </div>
            <div className="rounded-2xl border border-white/15 bg-black/30 px-3 py-1.5 font-mono text-[10px] text-white/80 backdrop-blur-md">
              {state.ghosts.map((g) => (
                <span key={g.name} className="mr-3">
                  <span style={{ color: g.colour }}>●</span> {g.name} {g.mile.toFixed(1)}
                </span>
              ))}
            </div>
          </div>

          <div className="absolute right-3 top-3 z-10 flex gap-2">
            <button
              onClick={() => worldRef.current?.restart(mode === "single" ? "quad" : "single")}
              className="rounded-full border border-white/15 bg-black/30 px-3 py-1.5 text-xs text-white backdrop-blur-md transition-colors hover:bg-black/50"
            >
              {mode === "single" ? "Try the quad" : "Just one Dipsea"}
            </button>
            <button
              onClick={() => worldRef.current?.restart()}
              className="rounded-full border border-white/15 bg-black/30 px-3 py-1.5 text-xs text-white backdrop-blur-md transition-colors hover:bg-black/50"
            >
              ↺ Restart
            </button>
          </div>

          {state.treeNear && !state.finished && (
            <div className="pointer-events-none absolute inset-x-0 bottom-28 z-10 flex justify-center">
              <div className="rounded-full border border-emerald-200/60 bg-black/40 px-4 py-1.5 text-xs text-emerald-100 backdrop-blur-md">
                🌲 {isTouch ? "tap 🌲" : "press E"} to touch the tree
              </div>
            </div>
          )}

          {state.note && (
            <div className="pointer-events-none absolute inset-x-0 top-1/4 z-10 flex justify-center px-6 animate-fade-in">
              <div className="max-w-md rounded-2xl border border-white/30 bg-black/45 px-5 py-3 text-center text-sm text-white backdrop-blur-md">
                {state.note}
              </div>
            </div>
          )}

          {state.finished && (
            <div className="pointer-events-none absolute inset-x-0 top-[38%] z-10 flex justify-center px-6 animate-fade-in">
              <div className="rounded-2xl border border-white/40 bg-black/50 px-6 py-4 text-center backdrop-blur-md">
                <div className="font-heading text-2xl text-white">
                  {state.mode === "quad" ? "Quad Dipsea" : "Stinson Beach"}
                </div>
                <div className="mt-1 font-mono text-sm text-white/85">
                  {state.totalMiles.toFixed(1)} miles · {fmtTime(state.elapsed)}
                </div>
                <div className="mt-2 text-xs text-white/70">
                  {state.ghosts.filter((g) => g.progress >= 0.999).length === 0
                    ? "You beat everybody. Even Liv."
                    : `${state.ghosts.filter((g) => g.progress >= 0.999).map((g) => g.name).join(", ")} got here first.`}
                </div>
              </div>
            </div>
          )}

          {isTouch && (
            <div className="absolute inset-x-0 bottom-6 z-10 flex items-end justify-between px-6">
              <div className="flex flex-col gap-2">
                <button
                  onPointerDown={() => (worldRef.current!.stick.y = -1)}
                  onPointerUp={() => (worldRef.current!.stick.y = 0)}
                  onPointerCancel={() => (worldRef.current!.stick.y = 0)}
                  className="h-16 w-24 rounded-2xl border border-amber-200/50 bg-amber-300/20 text-sm font-semibold text-amber-50 backdrop-blur-sm active:bg-amber-300/40"
                >
                  PUSH
                </button>
                <button
                  onPointerDown={() => (worldRef.current!.stick.y = 1)}
                  onPointerUp={() => (worldRef.current!.stick.y = 0)}
                  onPointerCancel={() => (worldRef.current!.stick.y = 0)}
                  className="h-16 w-24 rounded-2xl border border-sky-200/50 bg-sky-300/20 text-sm font-semibold text-sky-50 backdrop-blur-sm active:bg-sky-300/40"
                >
                  WALK
                </button>
              </div>
              <div className="flex gap-3">
                <button
                  onPointerDown={() => worldRef.current?.sip()}
                  className="h-16 w-16 rounded-full border border-white/25 bg-black/30 text-2xl backdrop-blur-sm active:bg-sky-300/30"
                >
                  💧
                </button>
                <button
                  onPointerDown={() => worldRef.current?.touchTree()}
                  className="h-16 w-16 rounded-full border border-white/25 bg-black/30 text-2xl backdrop-blur-sm active:bg-emerald-300/30"
                >
                  🌲
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
