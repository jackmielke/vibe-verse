/**
 * DUCK ON MY HEAD — a house party, from the robot's camera.
 *
 * Thin page: title card, the robot's HUD (which is to say, its context), the
 * speech bubbles, and a container the engine renders into. Everything that
 * moves lives in `src/duck/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import type { DuckState, DuckWorld } from "@/duck/world";

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Duck() {
  useWorldStamp("/duck", "Duck On My Head");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<DuckWorld | null>(null);
  const [started, setStarted] = useState(false);
  const [booting, setBooting] = useState(false);
  const [state, setState] = useState<DuckState | null>(null);

  const shotMode =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  useEffect(() => () => worldRef.current?.dispose(), []);

  const start = useCallback(async () => {
    if (worldRef.current || booting) return;
    setBooting(true);
    const { createDuckWorld } = await import("@/duck/world");
    if (!containerRef.current) return;
    worldRef.current = createDuckWorld({ container: containerRef.current, onState: setState });
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

  const grade = (s: DuckState) => {
    if (s.vibe >= 85) return "Crowd favourite. The duck gets its own Telegram.";
    if (s.vibe >= 65) return "Good robot. Somebody asked where to buy one.";
    if (s.vibe >= 45) return "It was fine. The Wi-Fi got most of the blame.";
    if (s.vibe >= 25) return "Mostly a very expensive paperweight with a duck on it.";
    return "Unplugged before the biryani. Claude Code is debugging it now.";
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#14100c] select-none">
      <div ref={containerRef} className="absolute inset-0" />

      {/* The robot's camera has a frame. */}
      {started && state && (
        <div className="pointer-events-none absolute inset-0 z-[5]" style={{ boxShadow: "inset 0 0 120px rgba(0,0,0,0.55)" }}>
          {state.feedDown && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70">
              <div className="text-center">
                <div className="font-mono text-2xl text-red-300 animate-pulse">NO SIGNAL</div>
                <div className="mt-2 font-mono text-xs text-red-200/70">hotspot ⇄ wi-fi · press H</div>
              </div>
            </div>
          )}
          <div className="absolute left-4 top-16 font-mono text-[10px] text-red-300/90">● REC {fmtTime(state.timeLeft)}</div>
          <div className="absolute right-4 top-16 font-mono text-[10px] text-white/60">{state.duckOn ? "🦆 on head" : "🦆 on floor"}</div>
        </div>
      )}

      {!started && !shotMode && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center">
          <div
            className="absolute inset-0 -z-10"
            style={{ background: "radial-gradient(ellipse at 70% 30%, #6b4a2a 0%, #2a1c12 45%, #0d0a07 100%)" }}
          />
          <p className="mb-3 text-[11px] uppercase tracking-[0.42em] text-amber-100/70">The vibeverse</p>
          <div className="text-6xl">🦆</div>
          <h1 className="mt-2 font-heading text-4xl tracking-tight text-amber-50 sm:text-6xl">Duck On My Head</h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-amber-50/85">
            Wednesday, late, somebody's living room. You are Vibey, a Reachy Mini
            on the coffee table, and somebody has put a rubber duck on your head.
            Six people want your attention. Look at whoever is talking. The
            hotspot keeps dropping the feed; the volume keeps defaulting low; and
            your sub-agents keep finishing things and posting them into your
            context, which you must not read out over anybody's sentence. Two and
            a half minutes until the biryani arrives.
          </p>
          <button
            onClick={start}
            disabled={booting}
            className="mt-8 rounded-full border border-amber-200/60 bg-amber-300/15 px-8 py-3 text-sm font-semibold text-amber-50 shadow-[0_0_40px_rgba(255,200,120,0.35)] transition-colors hover:bg-amber-300/25 disabled:opacity-60"
          >
            {booting ? "Booting the robot…" : "Wake up"}
          </button>
          <p className="mt-5 max-w-md text-[11px] leading-relaxed text-amber-100/65">
            {isTouch
              ? "◀ ▶ to turn · H hotspot · V volume · SAY reads the next message"
              : "A/D or drag to turn · H switch hotspot/wi-fi · V volume up · Enter read the next message aloud · R restart"}
          </p>
          <Link to="/" className="mt-8 text-xs text-amber-100/60 underline-offset-4 hover:text-white hover:underline">
            ← back to the vibeverse
          </Link>
        </div>
      )}

      {started && !shotMode && state && (
        <>
          {/* Speech bubble over whoever is talking. */}
          {state.speaker !== null && state.line && state.guests[state.speaker].onScreen && !state.feedDown && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full"
              style={{ left: `${state.guests[state.speaker].sx * 100}%`, top: `${state.guests[state.speaker].sy * 100}%` }}
            >
              <div className="relative max-w-[220px] rounded-2xl bg-white px-3 py-2 text-[13px] leading-snug text-black shadow-lg">
                <span className="mr-1 font-semibold" style={{ color: state.guests[state.speaker].colour }}>
                  {state.guests[state.speaker].name}:
                </span>
                {state.line}
                <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-black/10">
                  <div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${state.attention * 100}%` }} />
                </div>
                {state.needsVolume && <div className="mt-1 text-[10px] text-red-600">they cannot hear you · press V</div>}
                <div className="absolute left-1/2 top-full h-0 w-0 -translate-x-1/2 border-x-8 border-t-8 border-x-transparent border-t-white" />
              </div>
            </div>
          )}
          {state.speaker !== null && state.line && !state.guests[state.speaker].onScreen && !state.feedDown && (
            <div className="pointer-events-none absolute inset-x-0 top-24 z-10 flex justify-center">
              <div className="rounded-full bg-white/90 px-4 py-1.5 text-xs text-black">
                <span className="font-semibold" style={{ color: state.guests[state.speaker].colour }}>
                  {state.guests[state.speaker].name}
                </span>{" "}
                is talking to you, {state.guests[state.speaker].sx < 0.5 ? "← to your left" : "to your right →"}
              </div>
            </div>
          )}

          {/* Context: what the robot knows, bottom left. */}
          <div className="pointer-events-none absolute bottom-3 left-3 z-10 w-72 rounded-2xl border border-emerald-300/20 bg-black/55 px-3 py-2 font-mono text-[10px] text-emerald-200/90 backdrop-blur-md">
            <div className="mb-1 flex items-center justify-between text-emerald-100/60">
              <span>vibey · context</span>
              <span>vibe {Math.round(state.vibe)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-12 text-emerald-100/60">link</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full" style={{ width: `${state.connection}%`, background: state.connection < 40 ? "#f87171" : "#34d399" }} />
              </div>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="w-12 text-emerald-100/60">volume</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full" style={{ width: `${state.volume}%`, background: state.volume < 40 ? "#fbbf24" : "#34d399" }} />
              </div>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="w-12 text-emerald-100/60">vibe</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-fuchsia-400" style={{ width: `${state.vibe}%` }} />
              </div>
            </div>
            <div className="mt-2 border-t border-emerald-300/15 pt-1.5 text-emerald-100/60">inbox · {state.inbox.length ? "⏎ to say aloud" : "empty"}</div>
            {state.inbox.map((m, i) => (
              <div key={i} className={`truncate ${i === 0 ? "text-emerald-200" : "text-emerald-200/50"}`}>
                › {m}
              </div>
            ))}
            {state.speaker !== null && state.inbox.length > 0 && (
              <div className="mt-1 text-amber-200/80">someone is talking. wait for the gap.</div>
            )}
          </div>

          {/* Who is in the room. */}
          <div className="pointer-events-none absolute bottom-3 right-3 z-10 hidden rounded-2xl border border-white/10 bg-black/45 px-3 py-2 font-mono text-[10px] text-white/70 backdrop-blur-md sm:block">
            {state.guests.map((g) => (
              <div key={g.name} className="flex items-center gap-2">
                <span style={{ color: g.colour }}>●</span>
                <span className={g.talking ? "text-white" : ""}>{g.name}</span>
                <span className="ml-auto">{"♥".repeat(Math.round(g.mood * 4))}</span>
              </div>
            ))}
          </div>

          <div className="absolute right-3 top-3 z-10">
            <button
              onClick={() => worldRef.current?.restart()}
              className="rounded-full border border-white/15 bg-black/30 px-3 py-1.5 text-xs text-amber-50 backdrop-blur-md transition-colors hover:bg-black/50"
            >
              ↺ Reboot
            </button>
          </div>

          {state.note && (
            <div className="pointer-events-none absolute inset-x-0 top-[30%] z-10 flex justify-center px-6 animate-fade-in">
              <div className="max-w-md rounded-2xl border border-amber-200/30 bg-black/55 px-5 py-3 text-center text-sm text-amber-50 backdrop-blur-md">
                {state.note}
              </div>
            </div>
          )}

          {state.over && (
            <div className="pointer-events-none absolute inset-x-0 top-[42%] z-10 flex justify-center px-6 animate-fade-in">
              <div className="rounded-2xl border border-amber-200/40 bg-black/65 px-6 py-4 text-center backdrop-blur-md">
                <div className="font-heading text-2xl text-amber-50">Biryani</div>
                <div className="mt-1 text-sm text-amber-100/90">{grade(state)}</div>
                <div className="mt-2 font-mono text-[11px] text-white/70">
                  {state.answered} answered · {state.missed} missed · {state.wellTimed} well-timed · {state.interruptions} interruptions · duck fell {state.duckDrops}×
                </div>
              </div>
            </div>
          )}

          {isTouch && (
            <div className="absolute inset-x-0 bottom-36 z-10 flex items-end justify-between px-4">
              <div className="flex gap-2">
                <button {...hold(() => (worldRef.current!.touch.turn = 1), () => (worldRef.current!.touch.turn = 0))} className="h-16 w-16 rounded-full border border-white/25 bg-black/35 text-2xl text-white backdrop-blur-sm active:bg-white/20">◀</button>
                <button {...hold(() => (worldRef.current!.touch.turn = -1), () => (worldRef.current!.touch.turn = 0))} className="h-16 w-16 rounded-full border border-white/25 bg-black/35 text-2xl text-white backdrop-blur-sm active:bg-white/20">▶</button>
              </div>
              <div className="flex gap-2">
                <button onPointerDown={() => worldRef.current?.reconnect()} className="h-14 w-14 rounded-xl border border-red-200/40 bg-red-300/20 text-xs font-semibold text-red-50 backdrop-blur-sm active:bg-red-300/40">H</button>
                <button onPointerDown={() => worldRef.current?.volumeUp()} className="h-14 w-14 rounded-xl border border-amber-200/40 bg-amber-300/20 text-xs font-semibold text-amber-50 backdrop-blur-sm active:bg-amber-300/40">V</button>
                <button onPointerDown={() => worldRef.current?.surface()} className="h-14 w-16 rounded-xl border border-emerald-200/40 bg-emerald-300/20 text-xs font-semibold text-emerald-50 backdrop-blur-sm active:bg-emerald-300/40">SAY</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
