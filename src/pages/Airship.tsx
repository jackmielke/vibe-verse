/**
 * PATHFINDER — a 406-foot airship, the Bay, and five places that need help.
 *
 * Thin page: title card, instrument strip, touch controls, and the container
 * the engine renders into. Everything that flies lives in `src/airship/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import type { AirshipState, AirshipWorld } from "@/airship/world";

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const arrow = (bearing: number) => {
  // Bearing relative to the nose, radians, positive right.
  const deg = (bearing * 180) / Math.PI;
  return <span style={{ display: "inline-block", transform: `rotate(${deg}deg)` }}>↑</span>;
};

export default function Airship() {
  useWorldStamp("/airship", "Pathfinder");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<AirshipWorld | null>(null);
  const [started, setStarted] = useState(false);
  const [booting, setBooting] = useState(false);
  const [state, setState] = useState<AirshipState | null>(null);

  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  useEffect(() => () => worldRef.current?.dispose(), []);

  const start = useCallback(async () => {
    if (worldRef.current || booting) return;
    setBooting(true);
    const { createAirship } = await import("@/airship/world");
    if (!containerRef.current) return;
    worldRef.current = createAirship({ container: containerRef.current, onState: setState });
    setBooting(false);
    setStarted(true);
  }, [booting]);

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

  const gauge = (label: string, value: string, sub?: string) => (
    <div className="flex min-w-[64px] flex-col items-center">
      <span className="text-[9px] uppercase tracking-[0.2em] text-amber-100/70">{label}</span>
      <span className="font-mono text-base text-white">{value}</span>
      {sub && <span className="font-mono text-[10px] text-amber-100/70">{sub}</span>}
    </div>
  );

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#f0c8a0] select-none">
      <div ref={containerRef} className="absolute inset-0" />

      {!started && !shotMode && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center">
          <div
            className="absolute inset-0 -z-10"
            style={{
              background:
                "linear-gradient(180deg, #23407a 0%, #6b6fa8 30%, #f2a36a 62%, #fbd9a8 78%, #1c2a3a 100%)",
            }}
          />
          <p className="mb-3 text-[11px] uppercase tracking-[0.42em] text-amber-100/80">The vibeverse</p>
          <h1 className="font-heading text-4xl tracking-tight text-white sm:text-6xl">Pathfinder</h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-amber-50/95">
            A 406-foot rigid airship, thirteen bags of helium, and a Bay that has
            had a bad week. Five relief drops: Sausalito, Alcatraz, Treasure
            Island, Angel Island, Berkeley. She does everything twenty seconds
            after you ask, the wind has opinions, and every pallet you drop makes
            her two and a half tonnes lighter, which means up. Vent before you
            drop. Then bring her home to Moffett.
          </p>
          <button
            onClick={start}
            disabled={booting}
            className="mt-8 rounded-full border border-amber-200/60 bg-amber-300/15 px-8 py-3 text-sm font-semibold text-amber-50 shadow-[0_0_40px_rgba(255,190,110,0.45)] transition-colors hover:bg-amber-300/25 disabled:opacity-60"
          >
            {booting ? "Walking her out of the hangar…" : "Cast off"}
          </button>
          <p className="mt-5 max-w-md text-[11px] leading-relaxed text-amber-100/75">
            {isTouch
              ? "Throttle and rudder pads · Q/E pads for nose · B ballast · V vent · DROP over a ring"
              : "W/S throttle · A/D rudder · Q/E nose up/down · B drop ballast · V vent helium · Space drop cargo · drag to look"}
          </p>
          <Link to="/" className="mt-8 text-xs text-amber-100/70 underline-offset-4 hover:text-white hover:underline">
            ← back to the vibeverse
          </Link>
        </div>
      )}

      {started && !shotMode && state && (
        <>
          {/* Instruments, along the bottom like a gondola panel. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
            <div className="flex flex-wrap items-center justify-center gap-4 rounded-2xl border border-amber-200/25 bg-black/45 px-4 py-2 backdrop-blur-md">
              {gauge("Alt", `${Math.round(state.altitude)} m`, `${state.verticalSpeed >= 0 ? "+" : ""}${state.verticalSpeed.toFixed(1)} m/s`)}
              {gauge("Air", `${state.airspeed.toFixed(0)} m/s`, `thr ${Math.round(state.throttle * 100)}%`)}
              {gauge("Hdg", `${Math.round(state.heading).toString().padStart(3, "0")}°`)}
              {gauge("Helium", `${Math.round(state.helium * 100)}%`, `${Math.round(state.helium * 13)} cells`)}
              {gauge("Ballast", "💧".repeat(state.ballast) || "none")}
              {gauge("Cargo", "📦".repeat(state.cargo) || "empty")}
              {gauge("Trim", `${state.trim >= 0 ? "+" : ""}${(state.trim * 100).toFixed(0)}%`, state.trim > 0.02 ? "light" : state.trim < -0.02 ? "heavy" : "level")}
              {gauge("Wind", `${state.wind.speed.toFixed(0)} m/s`, "from the Gate")}
            </div>
          </div>

          {/* Targets, top left under the home button. */}
          <div className="pointer-events-none absolute left-3 top-16 z-10 w-64 rounded-2xl border border-amber-200/25 bg-black/40 px-3 py-2 backdrop-blur-md">
            <div className="flex items-baseline justify-between">
              <span className="font-heading text-sm text-white">{state.homeward ? "Home to Moffett" : "Relief drops"}</span>
              <span className="font-mono text-[11px] text-amber-100/80">{fmtTime(state.elapsed)}</span>
            </div>
            <ul className="mt-1 space-y-0.5">
              {state.targets.map((t, i) => (
                <li
                  key={t.name}
                  className={`flex items-center justify-between font-mono text-[11px] ${t.done ? "text-emerald-300/70 line-through" : i === state.nearest ? "text-amber-100" : "text-white/70"}`}
                >
                  <span>
                    {t.done ? "✓" : arrow(t.bearing)} {t.name}
                  </span>
                  <span>{t.done ? "" : `${(t.distance / 1000).toFixed(1)} km`}</span>
                </li>
              ))}
              {state.homeward && (
                <li className="flex items-center justify-between font-mono text-[11px] text-sky-200">
                  <span>{arrow(state.home.bearing)} Moffett Field</span>
                  <span>{(state.home.distance / 1000).toFixed(1)} km</span>
                </li>
              )}
            </ul>
            {state.nearest >= 0 && !state.homeward && (
              <p className="mt-1.5 text-[10px] leading-snug text-amber-100/70">
                {state.targets[state.nearest].cargo} · {state.targets[state.nearest].why}
              </p>
            )}
            <p className={`mt-1.5 text-[10px] ${state.canDrop ? "text-emerald-300" : "text-white/60"}`}>{state.dropHint}</p>
          </div>

          <div className="absolute right-3 top-3 z-10">
            <button
              onClick={() => worldRef.current?.restart()}
              className="rounded-full border border-white/15 bg-black/30 px-3 py-1.5 text-xs text-amber-50 backdrop-blur-md transition-colors hover:bg-black/50"
            >
              ↺ Back to the mast
            </button>
          </div>

          {state.note && (
            <div className="pointer-events-none absolute inset-x-0 top-[22%] z-10 flex justify-center px-6 animate-fade-in">
              <div className="max-w-lg rounded-2xl border border-amber-200/40 bg-black/50 px-5 py-3 text-center text-sm text-amber-50 backdrop-blur-md">
                {state.note}
              </div>
            </div>
          )}

          {state.landed && (
            <div className="pointer-events-none absolute inset-x-0 top-[40%] z-10 flex justify-center px-6 animate-fade-in">
              <div className="rounded-2xl border border-sky-200/50 bg-black/55 px-6 py-4 text-center backdrop-blur-md">
                <div className="font-heading text-2xl text-white">Down at Moffett</div>
                <div className="mt-1 font-mono text-sm text-sky-100/90">five drops · {fmtTime(state.elapsed)}</div>
              </div>
            </div>
          )}

          {isTouch && (
            <div className="absolute inset-x-0 bottom-24 z-10 flex items-end justify-between px-4">
              <div className="grid grid-cols-3 gap-2">
                <button {...hold(() => (worldRef.current!.touch.elevator = 1), () => (worldRef.current!.touch.elevator = 0))} className="h-14 w-14 rounded-xl border border-white/25 bg-black/35 text-xs text-white backdrop-blur-sm active:bg-white/20">nose ↑</button>
                <button {...hold(() => (worldRef.current!.touch.throttle = 1), () => (worldRef.current!.touch.throttle = 0))} className="h-14 w-14 rounded-xl border border-amber-200/40 bg-amber-300/20 text-xs text-amber-50 backdrop-blur-sm active:bg-amber-300/40">THR</button>
                <button {...hold(() => (worldRef.current!.touch.vent = true), () => (worldRef.current!.touch.vent = false))} className="h-14 w-14 rounded-xl border border-white/25 bg-black/35 text-xs text-white backdrop-blur-sm active:bg-white/20">vent</button>
                <button {...hold(() => (worldRef.current!.touch.rudder = -1), () => (worldRef.current!.touch.rudder = 0))} className="h-14 w-14 rounded-xl border border-white/25 bg-black/35 text-lg text-white backdrop-blur-sm active:bg-white/20">◀</button>
                <button {...hold(() => (worldRef.current!.touch.elevator = -1), () => (worldRef.current!.touch.elevator = 0))} className="h-14 w-14 rounded-xl border border-white/25 bg-black/35 text-xs text-white backdrop-blur-sm active:bg-white/20">nose ↓</button>
                <button {...hold(() => (worldRef.current!.touch.rudder = 1), () => (worldRef.current!.touch.rudder = 0))} className="h-14 w-14 rounded-xl border border-white/25 bg-black/35 text-lg text-white backdrop-blur-sm active:bg-white/20">▶</button>
              </div>
              <div className="flex flex-col gap-2">
                <button onPointerDown={() => worldRef.current?.ballast()} className="h-14 w-20 rounded-xl border border-sky-200/40 bg-sky-300/20 text-xs font-semibold text-sky-50 backdrop-blur-sm active:bg-sky-300/40">BALLAST</button>
                <button onPointerDown={() => worldRef.current?.drop()} className="h-16 w-20 rounded-xl border border-emerald-200/50 bg-emerald-300/20 text-sm font-semibold text-emerald-50 backdrop-blur-sm active:bg-emerald-300/40">DROP</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
