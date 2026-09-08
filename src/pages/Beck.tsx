/**
 * BECK ROAD: the neighbourhood around 8330 NE Beck Road, Bainbridge Island,
 * from Blakely Elementary to Lytle Beach, rebuilt 1:1 from map data.
 * Thin page: a title card, an address card, presets, touch controls, and a
 * container the engine renders into. Everything else is in `src/beck/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import type { BeckState, BeckWorld, Weather } from "@/beck/world";

export default function Beck() {
  useWorldStamp("/beck-road", "Beck Road");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<BeckWorld | null>(null);
  const [started, setStarted] = useState(false);
  const [booting, setBooting] = useState(false);
  const [state, setState] = useState<BeckState | null>(null);
  const [presets, setPresets] = useState<string[]>([]);

  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const shotMode = !!params?.has("shot");

  useEffect(() => () => worldRef.current?.dispose(), []);

  const start = useCallback(
    async (weather: Weather = "sun") => {
      if (worldRef.current || booting) return;
      setBooting(true);
      const { createBeck } = await import("@/beck/world");
      if (!containerRef.current) return;
      worldRef.current = createBeck({
        container: containerRef.current,
        weather,
        lite: !!params?.has("lite"),
        onState: (s) => {
          setState(s);
          if (s.ready && worldRef.current) setPresets((p) => (p.length ? p : worldRef.current!.presets()));
        },
      });
      setBooting(false);
      setStarted(true);
    },
    [booting],
  );

  useEffect(() => {
    if (shotMode) void start((params?.get("weather") as Weather) || "sun");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotMode]);

  const isTouch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  // Touch: left half moves, right half looks.
  const stickRef = useRef<{ id: number; x0: number; y0: number } | null>(null);
  const lookRef = useRef<{ id: number; x0: number; y0: number } | null>(null);
  const onTouchStart = (e: React.PointerEvent) => {
    if (!isTouch) return;
    const half = window.innerWidth / 2;
    if (e.clientX < half && !stickRef.current) stickRef.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY };
    else if (!lookRef.current) lookRef.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY };
  };
  const onTouchMove = (e: React.PointerEvent) => {
    const w = worldRef.current;
    if (!w) return;
    if (stickRef.current?.id === e.pointerId) {
      w.stick.x = Math.max(-1, Math.min(1, (e.clientX - stickRef.current.x0) / 60));
      w.stick.y = Math.max(-1, Math.min(1, -(e.clientY - stickRef.current.y0) / 60));
    } else if (lookRef.current?.id === e.pointerId) {
      w.look.x = Math.max(-1, Math.min(1, (e.clientX - lookRef.current.x0) / 80));
      w.look.y = Math.max(-1, Math.min(1, (e.clientY - lookRef.current.y0) / 80));
    }
  };
  const onTouchEnd = (e: React.PointerEvent) => {
    const w = worldRef.current;
    if (stickRef.current?.id === e.pointerId) {
      stickRef.current = null;
      if (w) w.stick.x = w.stick.y = 0;
    }
    if (lookRef.current?.id === e.pointerId) {
      lookRef.current = null;
      if (w) w.look.x = w.look.y = 0;
    }
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#c9d0d6] select-none" onPointerDown={onTouchStart} onPointerMove={onTouchMove} onPointerUp={onTouchEnd} onPointerCancel={onTouchEnd}>
      <div ref={containerRef} className="absolute inset-0" />

      {!started && !shotMode && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center">
          <div className="absolute inset-0 -z-10" style={{ background: "linear-gradient(180deg,#8fb0d2 0%,#d6dfe6 45%,#5f7d40 70%,#2f4a2a 100%)" }} />
          <p className="mb-3 text-[11px] uppercase tracking-[0.42em] text-white/85">The vibeverse · Bainbridge Island</p>
          <h1 className="font-heading text-5xl tracking-tight text-white drop-shadow sm:text-7xl">Beck Road</h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-white/95 drop-shadow">
            The neighbourhood around 8330 NE Beck Road, from Blakely Elementary to Lytle Beach, rebuilt one to
            one from the map: every road down to the driveways, every building on its real footprint, the
            mailboxes with the real numbers, the street signs, the power lines, the firs. Walk it.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button onClick={() => start("sun")} disabled={booting} className="rounded-full border border-white/60 bg-white/15 px-7 py-3 text-sm font-semibold text-white shadow-[0_0_40px_rgba(255,255,255,0.35)] backdrop-blur transition-colors hover:bg-white/25 disabled:opacity-60">
              {booting ? "Loading the island…" : "Walk to 8330"}
            </button>
            <button onClick={() => start("overcast")} disabled={booting} className="rounded-full border border-white/40 bg-black/15 px-7 py-3 text-sm text-white backdrop-blur transition-colors hover:bg-black/25 disabled:opacity-60">
              A grey day
            </button>
          </div>
          <p className="mt-5 text-[11px] text-white/85">{isTouch ? "Left thumb walks · right thumb looks" : "WASD walk · drag to look · Shift run · F fly · T weather"}</p>
          <Link to="/" className="mt-8 text-xs text-white/85 underline-offset-4 hover:text-white hover:underline">
            ← back to the vibeverse
          </Link>
        </div>
      )}

      {started && !shotMode && state && (
        <>
          <div className="pointer-events-none absolute left-3 top-16 z-10 flex flex-col gap-2">
            <div className="rounded-2xl border border-white/25 bg-black/40 px-3 py-2 backdrop-blur-md">
              <div className="font-heading text-xl text-white">{state.address || (state.ready ? "Between houses" : "Loading…")}</div>
              <div className="mt-0.5 font-mono text-[11px] text-white/80">
                {state.road ? `on ${state.road}` : ""} · facing {state.heading} · {state.mode === "fly" ? "flying" : "walking"} · {state.weather === "sun" ? "sun" : "overcast"}
              </div>
            </div>
          </div>
          <div className="absolute right-3 top-16 z-10 flex flex-col items-end gap-2">
            <select
              className="rounded-full border border-white/30 bg-black/40 px-3 py-1.5 text-[12px] text-white backdrop-blur-md"
              onChange={(e) => worldRef.current?.preset(e.target.value)}
              defaultValue=""
            >
              <option value="" disabled>
                Go to…
              </option>
              {presets.map((p) => (
                <option key={p} value={p} className="text-black">
                  {p}
                </option>
              ))}
            </select>
            <div className="flex gap-1 rounded-full border border-white/30 bg-black/40 p-1 backdrop-blur-md">
              {(["sun", "overcast"] as Weather[]).map((w) => (
                <button key={w} onClick={() => worldRef.current?.setWeather(w)} className={`rounded-full px-3 py-1 text-[11px] uppercase tracking-[0.14em] ${state.weather === w ? "bg-white text-black" : "text-white/80"}`}>
                  {w}
                </button>
              ))}
            </div>
            <button onClick={() => worldRef.current?.setMode(state.mode === "walk" ? "fly" : "walk")} className="rounded-full border border-white/30 bg-black/40 px-3 py-1 text-[11px] uppercase tracking-[0.14em] text-white/85 backdrop-blur-md">
              {state.mode === "walk" ? "fly" : "walk"}
            </button>
            <Link to="/" className="rounded-full border border-white/30 bg-black/40 px-3 py-1 text-[11px] text-white/85 backdrop-blur-md hover:text-white">
              ← hub
            </Link>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 text-center text-[10px] text-white/70">
            Roads, footprints, addresses and land from Overture Maps and OpenStreetMap contributors · terrain from Mapzen and AWS Open Data
          </div>
        </>
      )}
    </div>
  );
}
