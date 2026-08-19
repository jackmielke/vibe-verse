/**
 * THE EMPYREAN — a city of glass hanging over a frozen mirror, and a jetpack.
 *
 * The React layer is deliberately thin, the way The Glass Lake and San Palmas
 * are: it owns the title card, the HUD and the touch controls, and mounts a
 * container the engine renders into. Everything that moves lives in
 * `src/empyrean/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import type { EmpyreanState, EmpyreanWorld } from "@/empyrean/world";

export default function Empyrean() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/empyrean", "The Empyrean");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<EmpyreanWorld | null>(null);
  const [started, setStarted] = useState(false);
  const [booting, setBooting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [hint, setHint] = useState(true);
  const [state, setState] = useState<EmpyreanState>({
    altitude: 0,
    speed: 0,
    drop: 0,
    thrusting: false,
    who: "",
    place: "The Plaza",
  });

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
    // Three plus a pile of shaders. It must not sit in the hub's chunk — pull
    // it in only once somebody actually steps onto the plaza.
    const { createEmpyrean } = await import("@/empyrean/world");
    if (!containerRef.current) return;
    worldRef.current = createEmpyrean({
      container: containerRef.current,
      onState: setState,
      muted,
      shot: shotMode,
    });
    setBooting(false);
    setStarted(true);
    window.setTimeout(() => setHint(false), 11000);
  }, [booting, muted, shotMode]);

  useEffect(() => {
    if (shotMode) void start();
    // Once, on mount, when the harness asked for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotMode]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      worldRef.current?.setMuted(!m);
      return !m;
    });
  }, []);

  /* ---- Touch stick ------------------------------------------------------
   * Writes straight into the engine's input object — no React state anywhere
   * in the movement path. */
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
    const world = worldRef.current;
    if (world) world.stick.jet = on;
  }, []);

  const isTouch =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#150c22] select-none">
      <div ref={containerRef} className="absolute inset-0" />

      {/* ---- Title card -------------------------------------------------- */}
      {!started && !shotMode && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center">
          {/* A painted stand-in for the thing behind it — the same five stops
              the sky shader uses, so the cut to the live world is a reveal
              rather than a jump. */}
          <div
            className="absolute inset-0 -z-10"
            style={{
              background:
                "linear-gradient(180deg, #0b1342 0%, #1d3a72 24%, #2f8f9a 42%, #e8b45c 62%, #f2793f 76%, #e9628f 100%)",
            }}
          />
          <div
            className="absolute inset-0 -z-10 opacity-70"
            style={{
              background:
                "radial-gradient(75% 55% at 22% 88%, rgba(255,196,120,.85) 0%, rgba(255,140,110,0) 62%)",
            }}
          />
          <p className="mb-3 text-[11px] uppercase tracking-[0.42em] text-cyan-100/80">
            The vibeverse
          </p>
          <h1 className="font-heading text-4xl tracking-tight text-white drop-shadow-[0_2px_30px_rgba(0,0,0,0.45)] sm:text-6xl">
            The Empyrean
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-white/90 drop-shadow-[0_1px_12px_rgba(0,0,0,0.5)]">
            A city of glass on a rock that never landed, four hundred metres
            over a frozen lake that shows you all of it upside down. Strap the
            pack on and go and look at it — off the terraces, under the keel,
            out to the white ranges and back.
          </p>
          <button
            onClick={start}
            disabled={booting}
            className="mt-8 rounded-full border border-white/50 bg-white/15 px-8 py-3 text-sm font-semibold text-white shadow-[0_0_50px_rgba(255,190,120,0.55)] backdrop-blur-sm transition-colors hover:bg-white/25 disabled:opacity-60"
          >
            {booting ? "Raising the island…" : "Take off"}
          </button>
          <p className="mt-5 text-[11px] text-white/80">
            {isTouch
              ? "Stick to move · hold the rocket to fly · drag to look"
              : "WASD to move · hold Space for the jetpack · Shift to boost · drag to look"}
          </p>
          <Link
            to="/"
            className="mt-8 text-xs text-white/70 underline-offset-4 hover:text-white hover:underline"
          >
            ← back to the vibeverse
          </Link>
        </div>
      )}

      {/* ---- HUD --------------------------------------------------------- */}
      {started && !shotMode && (
        <>
          {/* Below, not beside: `chromeless: true` earns this world the app's
              one home button, and that lives at left-3 top-3 in every
              fullscreen world. */}
          <div className="pointer-events-none absolute left-3 top-16 z-10 flex flex-col gap-2">
            <div className="rounded-2xl border border-white/10 bg-black/35 px-3 py-2 backdrop-blur-md">
              <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-200/80">
                {state.place}
              </div>
              <div className="mt-1 font-mono text-[11px] text-white/90">
                {state.altitude.toFixed(0)} m
                <span className="ml-3 text-amber-200/90">{state.speed.toFixed(0)} m/s</span>
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
                  : "border-white/10 bg-black/35 text-white/50"
              }`}
            >
              JETPACK {state.thrusting ? "FIRING" : "READY"}
            </div>
          </div>

          <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
            {state.who && (
              <span className="hidden rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs text-white/70 backdrop-blur-md sm:inline">
                {state.who}
              </span>
            )}
            <button
              onClick={toggleMute}
              className="rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs text-white/90 backdrop-blur-md transition-colors hover:bg-black/55"
            >
              {muted ? "🔇" : "🔊"}
            </button>
            <button
              onClick={() => worldRef.current?.recall()}
              className="rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs text-white/90 backdrop-blur-md transition-colors hover:bg-black/55"
            >
              ↺ Plaza
            </button>
          </div>

          {hint && (
            <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center px-6 sm:bottom-10">
              <div className="rounded-full border border-white/10 bg-black/40 px-4 py-2 text-center text-[11px] text-white/75 backdrop-blur-md">
                {isTouch
                  ? "Hold the rocket to climb · let go to fall"
                  : "Hold Space to climb · let go to fall · R returns you to the plaza"}
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
                className="absolute bottom-8 left-6 z-10 h-32 w-32 rounded-full border border-white/15 bg-black/25 backdrop-blur-sm"
              >
                <div
                  className="pointer-events-none absolute left-1/2 top-1/2 h-14 w-14 rounded-full border border-cyan-200/50 bg-cyan-300/20"
                  style={{
                    transform: `translate(calc(-50% + ${knob.x * 34}px), calc(-50% + ${knob.y * 34}px))`,
                  }}
                />
              </div>
              <button
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setJet(true);
                }}
                onPointerUp={() => setJet(false)}
                onPointerCancel={() => setJet(false)}
                onPointerLeave={() => setJet(false)}
                className="absolute bottom-12 right-8 z-10 h-24 w-24 rounded-full border border-amber-200/30 bg-amber-400/15 text-3xl text-amber-100 backdrop-blur-sm active:bg-amber-400/35"
              >
                🚀
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
