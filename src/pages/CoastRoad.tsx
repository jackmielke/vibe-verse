/**
 * COAST ROAD: one road down to the sea, in two looks.
 *
 * Thin page: a title card that picks the look, a HUD that is mostly the wind,
 * touch controls, and a container the engine renders into. Everything that
 * moves lives in `src/coastroad/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import type { CoastState, CoastWorld, Style } from "@/coastroad/world";

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const LOOKS: { style: Style; name: string; line: string; swatch: string }[] = [
  {
    style: "painted",
    name: "Painted",
    line: "A cumulus stack over a bay, cel-shaded hills, a town at the bottom. The wind is seeds and petals.",
    swatch: "linear-gradient(180deg,#1c4fb6 0%,#b7e0f7 45%,#8fcf4a 60%,#0c3fa8 100%)",
  },
  {
    style: "lens",
    name: "Lens",
    line: "Action-camera wide, the double yellow line, houses up the hill and trees that smear when you are fast.",
    swatch: "linear-gradient(180deg,#7fb1e2 0%,#e4edf3 45%,#6f6f6f 62%,#7b9d47 100%)",
  },
];

export default function CoastRoad() {
  useWorldStamp("/coast-road", "Coast Road");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<CoastWorld | null>(null);
  const [style, setStyle] = useState<Style | null>(null);
  const [booting, setBooting] = useState(false);
  // Synchronous guard: StrictMode fires the shot effect twice before state settles.
  const startingRef = useRef(false);
  const [state, setState] = useState<CoastState | null>(null);

  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const shotMode = !!params?.has("shot");
  const shotStyle: Style = params?.get("shot") === "lens" ? "lens" : "painted";

  useEffect(() => () => worldRef.current?.dispose(), []);

  const start = useCallback(
    async (s: Style, autopilot = false) => {
      if (booting || startingRef.current) return;
      startingRef.current = true;
      setBooting(true);
      worldRef.current?.dispose();
      worldRef.current = null;
      setState(null);
      const { createCoastRoad } = await import("@/coastroad/world");
      startingRef.current = false;
      if (!containerRef.current) return;
      worldRef.current?.dispose();
      const startS = autopilot ? Number(params?.get("s") ?? 0) || 0 : 0;
      worldRef.current = createCoastRoad({ container: containerRef.current, style: s, autopilot, startS, onState: setState });
      setStyle(s);
      setBooting(false);
    },
    [booting],
  );

  useEffect(() => {
    if (shotMode) void start(shotStyle, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotMode]);

  const isTouch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  const hold = (dir: -1 | 1) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      if (worldRef.current) worldRef.current.stick.x = dir;
    },
    onPointerUp: () => {
      if (worldRef.current) worldRef.current.stick.x = 0;
    },
    onPointerCancel: () => {
      if (worldRef.current) worldRef.current.stick.x = 0;
    },
    onPointerLeave: () => {
      if (worldRef.current) worldRef.current.stick.x = 0;
    },
  });

  const windDeg = state ? Math.max(-60, Math.min(60, state.windLat * 70)) : 0;
  const ui = style === "lens" ? "border-white/25 bg-black/45" : "border-white/30 bg-[#0c2a5a]/35";

  return (
    <div className="fixed inset-0 overflow-hidden select-none" style={{ background: style === "lens" ? "#dbe6ee" : "#bfe2f6" }}>
      <div ref={containerRef} className="absolute inset-0" />

      {!style && !shotMode && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center">
          <div className="absolute inset-0 -z-10" style={{ background: "linear-gradient(180deg,#1c4fb6 0%,#6fb0e6 40%,#cfe9f7 58%,#8fcf4a 72%,#3f7f2d 100%)" }} />
          <p className="mb-3 text-[11px] uppercase tracking-[0.42em] text-white/85">The vibeverse</p>
          <h1 className="font-heading text-5xl tracking-tight text-white drop-shadow sm:text-7xl">Coast Road</h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-white/95 drop-shadow">
            Two and a half kilometres downhill to the sea on a longboard. Left and right carve, a jump
            clears a crack, a tuck goes faster. The wind is in the grass, in the air, in your ears, and
            sometimes it leans on you. Nothing here can hurt you. Pick a look.
          </p>
          <div className="mt-8 grid w-full max-w-lg grid-cols-1 gap-3 sm:grid-cols-2">
            {LOOKS.map((l) => (
              <button
                key={l.style}
                onClick={() => start(l.style)}
                disabled={booting}
                className="group overflow-hidden rounded-2xl border border-white/50 bg-white/10 text-left backdrop-blur transition hover:bg-white/20 disabled:opacity-60"
              >
                <div className="h-20 w-full" style={{ background: l.swatch }} />
                <div className="px-4 py-3">
                  <div className="font-heading text-lg text-white">{booting ? "Raising the headland…" : l.name}</div>
                  <div className="mt-1 text-xs leading-relaxed text-white/85">{l.line}</div>
                </div>
              </button>
            ))}
          </div>
          <p className="mt-5 text-[11px] text-white/85">
            {isTouch ? "◀ ▶ carve · JUMP · hold TUCK to go faster" : "A / D carve · Space jump · Shift tuck · S foot brake · R restart"}
          </p>
          <Link to="/" className="mt-8 text-xs text-white/85 underline-offset-4 hover:text-white hover:underline">
            ← back to the vibeverse
          </Link>
        </div>
      )}

      {style && !shotMode && state && (
        <>
          <div className="pointer-events-none absolute left-3 top-16 z-10 flex flex-col gap-2">
            <div className={`rounded-2xl border px-3 py-2 backdrop-blur-md ${ui}`}>
              <div className="flex items-baseline gap-3">
                <span className="font-heading text-3xl tabular-nums text-white">{state.speedKmh.toFixed(0)}</span>
                <span className="text-[11px] uppercase tracking-[0.2em] text-white/75">km/h</span>
                <span className="ml-auto font-mono text-[11px] text-white/80">{fmtTime(state.elapsed)}</span>
              </div>
              <div className="mt-1.5 h-1.5 w-56 overflow-hidden rounded-full bg-black/35">
                <div className="h-full rounded-full bg-white/85 transition-[width] duration-200" style={{ width: `${state.progress * 100}%` }} />
              </div>
              <div className="mt-1 flex justify-between font-mono text-[11px] text-white/80">
                <span>{(state.remaining / 1000).toFixed(2)} km to the sand</span>
                <span className={state.tuck ? "text-amber-200" : ""}>{state.tuck ? "TUCK" : state.onGrass ? "GRASS" : "ROLL"}</span>
              </div>
            </div>
            <div className={`flex items-center gap-3 rounded-2xl border px-3 py-2 backdrop-blur-md ${ui}`}>
              <svg width="44" height="44" viewBox="-22 -22 44 44" className="shrink-0">
                <circle r="20" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
                <g transform={`rotate(${windDeg})`}>
                  <line x1="0" y1="14" x2="0" y2={-4 - state.wind * 14} stroke={state.gust ? "#ffd36a" : "#fff"} strokeWidth="2.2" strokeLinecap="round" />
                  <polygon points={`0,${-9 - state.wind * 14} -4,${-2 - state.wind * 14} 4,${-2 - state.wind * 14}`} fill={state.gust ? "#ffd36a" : "#fff"} />
                </g>
              </svg>
              <div className="font-mono text-[11px] leading-relaxed text-white/85">
                <div>
                  wind <span className="text-white">{Math.round(state.wind * 100)}</span>
                  {state.gust && <span className="ml-2 text-amber-200">GUST</span>}
                </div>
                <div>
                  flow <span className="text-white">{Math.round(state.flow)}</span> · cleared <span className="text-white">{state.jumped}</span>
                </div>
              </div>
            </div>
          </div>

          {state.note && (
            <div className="pointer-events-none absolute inset-x-0 top-[62%] z-10 flex justify-center px-6">
              <div className={`rounded-full border px-4 py-1.5 text-sm text-white backdrop-blur-md ${ui}`}>{state.note}</div>
            </div>
          )}

          <div className="absolute right-3 top-16 z-10 flex flex-col items-end gap-2">
            <div className="flex gap-1 rounded-full border border-white/30 bg-black/30 p-1 backdrop-blur-md">
              {LOOKS.map((l) => (
                <button
                  key={l.style}
                  onClick={() => l.style !== style && start(l.style)}
                  className={`rounded-full px-3 py-1 text-[11px] uppercase tracking-[0.16em] ${l.style === style ? "bg-white text-black" : "text-white/80 hover:text-white"}`}
                >
                  {l.name}
                </button>
              ))}
            </div>
            {!state.finished && (
              <Link to="/" className="rounded-full border border-white/30 bg-black/30 px-3 py-1 text-[11px] text-white/85 backdrop-blur-md hover:text-white">
                ← hub
              </Link>
            )}
          </div>

          {state.finished && (
            <div className="absolute inset-0 z-20 flex items-center justify-center px-6">
              <div className={`w-full max-w-sm rounded-3xl border px-6 py-6 text-center text-white backdrop-blur-md ${ui}`}>
                <p className="text-[11px] uppercase tracking-[0.35em] text-white/75">The sand</p>
                <h2 className="font-heading mt-1 text-3xl">You made it down.</h2>
                <div className="mt-4 grid grid-cols-2 gap-2 font-mono text-[12px] text-white/85">
                  <div>time</div>
                  <div className="text-right text-white">{fmtTime(state.elapsed)}</div>
                  <div>top speed</div>
                  <div className="text-right text-white">{state.topKmh.toFixed(0)} km/h</div>
                  <div>flow</div>
                  <div className="text-right text-white">{Math.round(state.flow)}</div>
                  <div>cracks cleared</div>
                  <div className="text-right text-white">{state.jumped}</div>
                  <div>cracks found</div>
                  <div className="text-right text-white">{state.hits}</div>
                  <div>wind at your back</div>
                  <div className="text-right text-white">{Math.round(state.tailwind * 100)}% of the way</div>
                </div>
                <div className="mt-5 flex justify-center gap-3">
                  <button onClick={() => worldRef.current?.restart()} className="rounded-full border border-white/60 bg-white/15 px-5 py-2 text-sm font-semibold hover:bg-white/25">
                    Again
                  </button>
                  <button onClick={() => start(style === "painted" ? "lens" : "painted")} className="rounded-full border border-white/40 px-5 py-2 text-sm hover:bg-white/10">
                    Other look
                  </button>
                </div>
                <Link to="/" className="mt-4 block text-xs text-white/80 underline-offset-4 hover:underline">
                  ← back to the vibeverse
                </Link>
              </div>
            </div>
          )}

          {isTouch && !state.finished && (
            <div className="absolute inset-x-0 bottom-4 z-10 flex items-end justify-between px-4">
              <div className="flex gap-2">
                <button {...hold(-1)} className="h-16 w-16 rounded-full border border-white/40 bg-black/30 text-2xl text-white backdrop-blur-md active:bg-white/30">
                  ◀
                </button>
                <button {...hold(1)} className="h-16 w-16 rounded-full border border-white/40 bg-black/30 text-2xl text-white backdrop-blur-md active:bg-white/30">
                  ▶
                </button>
              </div>
              <div className="flex gap-2">
                <button
                  onPointerDown={(e) => {
                    e.preventDefault();
                    worldRef.current?.setTuck(true);
                  }}
                  onPointerUp={() => worldRef.current?.setTuck(false)}
                  onPointerCancel={() => worldRef.current?.setTuck(false)}
                  onPointerLeave={() => worldRef.current?.setTuck(false)}
                  className="h-16 w-16 rounded-full border border-amber-200/60 bg-amber-300/20 text-[11px] font-semibold uppercase tracking-wider text-white backdrop-blur-md active:bg-amber-300/40"
                >
                  tuck
                </button>
                <button
                  onPointerDown={(e) => {
                    e.preventDefault();
                    worldRef.current?.jump();
                  }}
                  className="h-16 w-16 rounded-full border border-white/40 bg-white/20 text-[11px] font-semibold uppercase tracking-wider text-white backdrop-blur-md active:bg-white/40"
                >
                  jump
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
