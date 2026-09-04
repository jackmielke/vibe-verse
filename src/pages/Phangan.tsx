/**
 * FLOW PHANGAN: a month on Koh Phangan, as one afternoon on a scooter.
 *
 * Thin page: title card, HUD, the speech bubbles, a minimap, touch controls,
 * and a container the engine renders into. Everything that moves lives in
 * `src/phangan/`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import type { PhanganState, PhanganWorld } from "@/phangan/world";
import { ROADS, coastRadius, CHECKPOINT } from "@/phangan/island";

const MAP = 150;
const MAP_SCALE = MAP / 780;
const mx = (x: number) => MAP / 2 + x * MAP_SCALE;
const mz = (z: number) => MAP / 2 + z * MAP_SCALE;

export default function Phangan() {
  useWorldStamp("/phangan", "Flow Phangan");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<PhanganWorld | null>(null);
  const [started, setStarted] = useState(false);
  const [booting, setBooting] = useState(false);
  const [state, setState] = useState<PhanganState | null>(null);

  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const shotMode = !!params?.has("shot");
  const seedParam = params?.get("seed");

  useEffect(() => () => worldRef.current?.dispose(), []);

  const start = useCallback(async () => {
    if (worldRef.current || booting) return;
    setBooting(true);
    const { createPhangan } = await import("@/phangan/world");
    if (!containerRef.current) return;
    worldRef.current = createPhangan({
      container: containerRef.current,
      onState: setState,
      seed: shotMode ? 7 : seedParam ? Number(seedParam) : undefined,
      shot: shotMode,
    });
    setBooting(false);
    setStarted(true);
  }, [booting, shotMode, seedParam]);

  useEffect(() => {
    if (shotMode) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotMode]);

  const isTouch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  // The island outline and the roads, drawn once for the minimap.
  const mapStatic = useMemo(() => {
    const coast: string[] = [];
    for (let i = 0; i < 72; i++) {
      const th = (i / 72) * Math.PI * 2;
      const r = coastRadius(th);
      coast.push(`${mx(Math.cos(th) * r).toFixed(1)},${mz(Math.sin(th) * r).toFixed(1)}`);
    }
    const roads = ROADS.map((road) => {
      const pts = road.closed ? [...road.points, road.points[0]] : road.points;
      return { d: pts.map((p) => `${mx(p.x).toFixed(1)},${mz(p.z).toFixed(1)}`).join(" "), steep: road.steep };
    });
    return { coast: coast.join(" "), roads };
  }, []);

  const hold = (set: () => void, clear: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      set();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
  });

  // A thumb stick for the lean. Horizontal only; the throttle is a button.
  const stickRef = useRef<{ id: number; x0: number } | null>(null);
  const onStickDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    stickRef.current = { id: e.pointerId, x0: e.clientX };
  };
  const onStickMove = (e: React.PointerEvent) => {
    if (!stickRef.current || stickRef.current.id !== e.pointerId || !worldRef.current) return;
    worldRef.current.stick.x = Math.max(-1, Math.min(1, (e.clientX - stickRef.current.x0) / 45));
  };
  const onStickUp = () => {
    stickRef.current = null;
    if (worldRef.current) worldRef.current.stick.x = 0;
  };

  const midAction = !!state && state.phase === "ride" && state.riding !== null;

  const meter = (label: string, value: number, colour: string, warnBelow?: number) => (
    <div className="flex items-center gap-2">
      <span className="w-14 text-[10px] uppercase tracking-[0.18em] text-white/70">{label}</span>
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
    <div className="fixed inset-0 overflow-hidden bg-[#6ec6c0] select-none">
      <div ref={containerRef} className="absolute inset-0" />

      {!started && !shotMode && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center">
          <div
            className="absolute inset-0 -z-10"
            style={{
              background: "linear-gradient(180deg, #7fd0ee 0%, #ffd9a0 34%, #2ec4c6 52%, #6fae4a 70%, #2f6b34 100%)",
            }}
          />
          <p className="mb-3 text-[11px] uppercase tracking-[0.42em] text-white/85">The vibeverse</p>
          <div className="text-6xl">🛵</div>
          <h1 className="mt-2 font-heading text-4xl tracking-tight text-white drop-shadow sm:text-6xl">Flow Phangan</h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-white/95 drop-shadow">
            April 2025, Koh Phangan. A villa on the west side with a forty-five foot pool, eighty
            builders within a ten-minute scooter ride, and a weekly meetup at a secret location
            because the police started shutting down events, even the free ones. Tonight it is your
            job to get everybody there: one on the back at a time, before the rain comes in from
            the east, before dark, and before Muay Thai at 8:30, whether you are ready or not.
            Scooter is five dollars a day. Pad thai is three.
          </p>
          <button
            onClick={start}
            disabled={booting}
            className="mt-8 rounded-full border border-white/60 bg-white/15 px-8 py-3 text-sm font-semibold text-white shadow-[0_0_40px_rgba(255,255,255,0.35)] backdrop-blur transition-colors hover:bg-white/25 disabled:opacity-60"
          >
            {booting ? "Renting the scooter…" : "Ride"}
          </button>
          <p className="mt-5 max-w-md text-[11px] leading-relaxed text-white/85">
            {isTouch
              ? "Drag the stick to lean · GO to throttle · BOOST drains energy · E picks up and drops off"
              : "W/S throttle and brake · A/D lean · E pick up or drop · Shift boost (drains energy) · R restart"}
          </p>
          <Link to="/" className="mt-8 text-xs text-white/85 underline-offset-4 hover:text-white hover:underline">
            ← back to the vibeverse
          </Link>
        </div>
      )}

      {started && !shotMode && state && (
        <>
          {/* Top left: the day. */}
          <div className="pointer-events-none absolute left-3 top-16 z-10 flex flex-col gap-2">
            <div className="rounded-2xl border border-white/20 bg-black/35 px-3 py-2 backdrop-blur-md">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-heading text-lg text-white">{state.clock}</span>
                <span className="font-mono text-[11px] text-white/80">{state.speedKmh.toFixed(0)} km/h{state.boosting ? " ⚡" : ""}</span>
              </div>
              <div className="relative mt-1 h-2 w-64 overflow-hidden rounded-full bg-black/40">
                <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-sky-300 via-amber-300 to-indigo-500" style={{ width: `${state.progress * 100}%` }} />
                <div className="absolute inset-y-0 w-px bg-orange-200" style={{ left: `${state.sunsetAt * 100}%` }} title="sunset" />
                <div className="absolute inset-y-0 w-px bg-sky-200" style={{ left: `${state.rainAt * 100}%` }} title="rain" />
              </div>
              <div className="mt-0.5 flex w-64 justify-between font-mono text-[9px] text-white/60">
                <span>4 pm</span>
                <span>🌅 sunset</span>
                <span>🌧 rain</span>
                <span>🥊 8:30</span>
              </div>
              <div className="mt-2 flex flex-col gap-1">
                {meter("Energy", state.energy, "#7ee2a0", 25)}
              </div>
            </div>
            <div className="rounded-2xl border border-white/20 bg-black/35 px-3 py-2 backdrop-blur-md">
              <div className="text-[10px] uppercase tracking-[0.18em] text-amber-200/90">Secret location</div>
              <div className="font-heading text-sm text-white">{state.placeName}</div>
              <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10px]">
                {state.guests.map((g) => (
                  <span
                    key={g.name}
                    style={{ color: g.phase === "delivered" ? "#7ee2a0" : g.colour, opacity: g.phase === "delivered" ? 0.8 : 1 }}
                  >
                    {g.phase === "delivered" ? "✓" : g.phase === "riding" ? "🛵" : "●"} {g.name}
                  </span>
                ))}
              </div>
              <div className="mt-1 font-mono text-[10px] text-white/70">
                {state.delivered}/{state.total} at the meetup · 🍜 {state.padThai}
              </div>
            </div>
          </div>

          {/* Top right: restart, home. */}
          <div className="absolute right-3 top-3 z-10 flex gap-2">
            {!midAction && (
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
              ↺ New day
            </button>
          </div>

          {/* Bottom right: the map and the compass. */}
          <div className="pointer-events-none absolute bottom-3 right-3 z-10 flex flex-col items-end gap-1">
            {state.compass && state.phase === "ride" && (
              <div className="flex items-center gap-2 rounded-full border border-white/20 bg-black/35 px-3 py-1 backdrop-blur-md">
                <span
                  className="inline-block text-lg text-amber-200"
                  style={{ transform: `rotate(${state.compass.angle}rad)`, transition: "transform 120ms linear" }}
                >
                  ↑
                </span>
                <span className="font-mono text-[10px] text-white/85">
                  {state.compass.label} · {state.compass.distance < 950 ? `${Math.round(state.compass.distance / 10) * 10} m` : `${(state.compass.distance / 1000).toFixed(1)} km`}
                </span>
              </div>
            )}
            <svg width={MAP} height={MAP} viewBox={`0 0 ${MAP} ${MAP}`} className="rounded-2xl border border-white/20 bg-[#1b7f9c]/70 backdrop-blur-md">
              <polygon points={mapStatic.coast} fill="#5f9a44" stroke="#e9d9a4" strokeWidth="1.5" />
              {mapStatic.roads.map((r, i) => (
                <polyline key={i} points={r.d} fill="none" stroke={r.steep ? "#cfcabc" : "#3a3835"} strokeWidth={r.steep ? 1 : 1.6} />
              ))}
              {state.rainHere < 1 && state.rainX < 600 && (
                <rect x={mx(state.rainX)} y={0} width={MAP} height={MAP} fill="rgba(40,50,64,0.55)" />
              )}
              <circle cx={mx(CHECKPOINT.pos.x)} cy={mz(CHECKPOINT.pos.z)} r="3" fill="#3b7bff" stroke="#fff" strokeWidth="0.8" />
              {state.guests
                .filter((g) => g.phase === "waiting")
                .map((g) => (
                  <circle key={g.name} cx={mx(g.x)} cy={mz(g.z)} r="3.2" fill={g.colour} stroke="#000" strokeWidth="0.6" />
                ))}
              <text x={mx(state.place.x)} y={mz(state.place.z) + 4} textAnchor="middle" fontSize="11">
                ⭐
              </text>
              <g transform={`translate(${mx(state.player.x)},${mz(state.player.z)}) rotate(${(state.player.heading * 180) / Math.PI})`}>
                <polygon points="0,-6 4,4 0,2 -4,4" fill="#ffffff" stroke="#000" strokeWidth="0.8" />
              </g>
            </svg>
          </div>

          {/* Prompts. */}
          {state.phase === "ride" && (state.nearGuest || (state.atMeetup && state.riding) || state.held || state.checkpointNear) && (
            <div className="pointer-events-none absolute inset-x-0 bottom-28 z-10 flex flex-col items-center gap-1">
              {state.held && (
                <div className="rounded-full border border-blue-200/60 bg-blue-900/60 px-4 py-1.5 text-xs text-blue-50 backdrop-blur-md">
                  🚔 Checkpoint. "Where is the party?" You do not know about any party.
                </div>
              )}
              {!state.held && state.checkpointNear && (
                <div className="rounded-full border border-red-200/60 bg-red-900/50 px-4 py-1.5 text-xs text-red-50 backdrop-blur-md">
                  🚔 Checkpoint ahead. Do not lead a convoy past it. Take the long way.
                </div>
              )}
              {state.nearGuest && !state.riding && (
                <div className="rounded-full border border-emerald-200/60 bg-black/40 px-4 py-1.5 text-xs text-emerald-100 backdrop-blur-md">
                  {isTouch ? "tap E" : "press E"} to pick up {state.nearGuest}
                </div>
              )}
              {state.atMeetup && state.riding && (
                <div className="rounded-full border border-amber-200/60 bg-black/40 px-4 py-1.5 text-xs text-amber-100 backdrop-blur-md">
                  {isTouch ? "tap E" : "press E"} to drop {state.riding.name} at {state.placeName}
                </div>
              )}
            </div>
          )}

          {/* Narration. */}
          {state.note && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-6 animate-fade-in">
              <div className="max-w-md rounded-2xl border border-white/30 bg-black/45 px-5 py-2.5 text-center text-sm text-white backdrop-blur-md">
                {state.note}
              </div>
            </div>
          )}

          {/* The passenger talks. */}
          {state.bubble && state.phase === "ride" && (
            <div className="pointer-events-none absolute inset-x-0 bottom-40 z-10 flex justify-center px-6 sm:bottom-44">
              <div
                className="max-w-lg rounded-2xl border bg-black/55 px-5 py-3 text-sm text-white backdrop-blur-md animate-fade-in"
                style={{ borderColor: state.bubble.colour }}
              >
                <span className="mr-2 font-semibold" style={{ color: state.bubble.colour }}>
                  {state.bubble.name}
                </span>
                {state.bubble.text}
              </div>
            </div>
          )}

          {/* 8:30. Muay Thai. */}
          {state.phase === "muaythai" && state.rhythm && (
            <div className="pointer-events-none absolute inset-x-0 top-[22%] z-10 flex flex-col items-center px-6">
              <div className="font-heading text-2xl text-white drop-shadow">8:30. Muay Thai.</div>
              <div className="mt-1 text-xs text-white/80">
                {isTouch ? "tap PUNCH on the beat" : "W A S D or Space on the beat"} · ten hits · ready or not
              </div>
              <div className="relative mt-4 h-16 w-full max-w-lg overflow-hidden rounded-2xl border border-white/25 bg-black/45 backdrop-blur-md">
                <div className="absolute inset-y-2 left-[14%] w-1 rounded bg-amber-200" />
                {state.rhythm.beats.map((b, i) => {
                  const x = 14 + (b.at - state.rhythm!.t) * 22;
                  if (x < -10 || x > 110) return null;
                  const colour = b.result === "perfect" ? "#7ee2a0" : b.result === "good" ? "#ffd27f" : b.result === "miss" ? "#ff6b6b" : "#ffffff";
                  return (
                    <div key={i} className="absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center" style={{ left: `${x}%` }}>
                      <div className="h-7 w-7 rounded-full border-2" style={{ borderColor: colour, background: b.result === "pending" ? "transparent" : colour, opacity: b.result === "pending" ? 1 : 0.6 }} />
                      <div className="mt-0.5 text-[9px] uppercase tracking-wider text-white/70">{b.move}</div>
                    </div>
                  );
                })}
              </div>
              {state.lastHit && (
                <div
                  className="mt-3 font-heading text-xl"
                  style={{ color: state.lastHit.result === "perfect" ? "#7ee2a0" : state.lastHit.result === "good" ? "#ffd27f" : "#ff6b6b" }}
                >
                  {state.lastHit.result === "perfect" ? "PERFECT" : state.lastHit.result === "good" ? "good" : "miss"}
                </div>
              )}
            </div>
          )}

          {/* End card. */}
          {state.phase === "done" && state.summary && (
            <div className="absolute inset-x-0 top-[16%] z-10 flex justify-center px-6 animate-fade-in">
              <div className="w-full max-w-md rounded-2xl border border-white/40 bg-black/60 px-6 py-5 text-center backdrop-blur-md">
                <div className="text-[10px] uppercase tracking-[0.3em] text-amber-200/90">Flow Phangan · one day</div>
                <div className="mt-1 font-heading text-2xl text-white">
                  {state.summary.delivered} of {state.summary.total} at {state.summary.place}
                </div>
                <div className="mt-2 text-sm text-white/85">{state.summary.line}</div>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-left font-mono text-[11px] text-white/85">
                  <span>Stories heard in full</span>
                  <span className="text-right">{state.summary.fullStories}</span>
                  <span>Beat the story to the bar</span>
                  <span className="text-right">{state.summary.fastRides}</span>
                  <span>Pad thai</span>
                  <span className="text-right">
                    {state.summary.padThai} · ${state.summary.dollars}
                  </span>
                  <span>Beat the rain</span>
                  <span className="text-right">{state.summary.beatRain ? "yes" : "no"}</span>
                  <span>Checkpoint stops</span>
                  <span className="text-right">{state.summary.checkpointStops}</span>
                  <span>Monkey swerves</span>
                  <span className="text-right">{state.summary.swerves}</span>
                  <span>Muay Thai</span>
                  <span className="text-right">{state.summary.muayThai}/10</span>
                </div>
                <div className="mt-2 text-xs text-white/75">{state.summary.ready}</div>
                <div className="mt-4 font-heading text-lg text-amber-100">{state.summary.outro}</div>
                <div className="mt-4 flex justify-center gap-3">
                  <button
                    onClick={() => worldRef.current?.restart()}
                    className="rounded-full border border-white/40 bg-white/15 px-5 py-2 text-xs font-semibold text-white hover:bg-white/25"
                  >
                    Another day
                  </button>
                  <Link to="/" className="rounded-full border border-white/20 bg-black/30 px-5 py-2 text-xs text-white hover:bg-black/50">
                    ← vibeverse
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* Touch controls. */}
          {isTouch && state.phase === "ride" && (
            <div className="absolute inset-x-0 bottom-5 z-10 flex items-end justify-between px-5">
              <div
                onPointerDown={onStickDown}
                onPointerMove={onStickMove}
                onPointerUp={onStickUp}
                onPointerCancel={onStickUp}
                className="flex h-24 w-40 items-center justify-center rounded-3xl border border-white/25 bg-black/30 text-xs text-white/70 backdrop-blur-sm"
                style={{ touchAction: "none" }}
              >
                ◀ lean ▶
              </div>
              <div className="flex items-end gap-2">
                <button
                  onPointerDown={() => worldRef.current?.act()}
                  className="h-14 w-14 rounded-full border border-emerald-200/50 bg-emerald-300/20 text-sm font-semibold text-emerald-50 backdrop-blur-sm active:bg-emerald-300/40"
                >
                  E
                </button>
                <button
                  {...hold(
                    () => (worldRef.current!.stick.boost = true),
                    () => (worldRef.current!.stick.boost = false),
                  )}
                  className="h-14 w-16 rounded-2xl border border-amber-200/50 bg-amber-300/20 text-xs font-semibold text-amber-50 backdrop-blur-sm active:bg-amber-300/40"
                >
                  BOOST
                </button>
                <button
                  {...hold(
                    () => (worldRef.current!.stick.y = -1),
                    () => (worldRef.current!.stick.y = 0),
                  )}
                  className="h-14 w-16 rounded-2xl border border-red-200/50 bg-red-300/20 text-xs font-semibold text-red-50 backdrop-blur-sm active:bg-red-300/40"
                >
                  BRAKE
                </button>
                <button
                  {...hold(
                    () => (worldRef.current!.stick.y = 1),
                    () => (worldRef.current!.stick.y = 0),
                  )}
                  className="h-20 w-20 rounded-full border border-white/40 bg-white/20 text-sm font-semibold text-white backdrop-blur-sm active:bg-white/40"
                >
                  GO
                </button>
              </div>
            </div>
          )}
          {isTouch && state.phase === "muaythai" && (
            <div className="absolute inset-x-0 bottom-8 z-10 flex justify-center">
              <button
                onPointerDown={() => worldRef.current?.hit()}
                className="h-24 w-24 rounded-full border border-red-200/60 bg-red-400/30 text-base font-semibold text-white backdrop-blur-sm active:bg-red-400/60"
              >
                PUNCH
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
