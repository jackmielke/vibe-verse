/**
 * THE GLASS LAKE — a frozen lake at night, under an aurora that is watching.
 *
 * The React layer is deliberately thin, the way Seafair and San Palmas are:
 * it owns the title card, the HUD and the touch pad, and mounts a container
 * the engine renders into. Everything that moves lives in `src/glasslake/`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import type { GlassLakeWorld, LakeState } from "@/glasslake/world";

const HINT_KEY = "glasslake.seen";

export default function GlassLake() {
  // Passport: every world records that you were here. See lib/passport.ts.
  useWorldStamp("/glass-lake", "The Glass Lake");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<GlassLakeWorld | null>(null);
  const [started, setStarted] = useState(false);
  const [booting, setBooting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [state, setState] = useState<LakeState>({
    shards: 0,
    total: 12,
    speed: 0,
    energy: 0,
    nearest: Infinity,
    complete: false,
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
    // The engine is Three plus a pile of shaders. It must not sit in the
    // hub's chunk — pull it in only once somebody steps onto the ice.
    const { createGlassLake } = await import("@/glasslake/world");
    if (!containerRef.current) return;
    worldRef.current = createGlassLake({
      container: containerRef.current,
      onState: setState,
      muted,
    });
    setBooting(false);
    setStarted(true);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* private mode is not an error */
    }
  }, [booting, muted]);

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

  // ---- Touch pad ---------------------------------------------------------
  // A stick that lives where the thumb already is, writing straight into the
  // engine's input object — no React state in the movement path.
  const padRef = useRef<HTMLDivElement | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0, active: false });
  const padTouch = useRef<number | null>(null);

  const padMove = useCallback((clientX: number, clientY: number) => {
    const pad = padRef.current;
    const world = worldRef.current;
    if (!pad || !world) return;
    const r = pad.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const max = r.width / 2;
    let dx = (clientX - cx) / max;
    let dy = (clientY - cy) / max;
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
    padTouch.current = null;
    setKnob({ x: 0, y: 0, active: false });
  }, []);

  const isTouch =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  const pct = state.total > 0 ? state.shards / state.total : 0;

  return (
    <div className="fixed inset-0 bg-[#02030a] overflow-hidden select-none">
      <div ref={containerRef} className="absolute inset-0" />

      {/* ---- Title card ------------------------------------------------ */}
      {!started && !shotMode && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 text-center">
          {/* A painted stand-in for the thing behind it: the same palette as
              the aurora, so the cut to the live world is a reveal and not a
              jump. */}
          <div
            className="absolute inset-0 -z-10"
            style={{
              background:
                "radial-gradient(120% 90% at 50% 108%, #0a2a2f 0%, #061428 42%, #02030a 78%)",
            }}
          />
          <div
            className="absolute inset-x-0 top-[18%] -z-10 h-[38%] opacity-70 blur-2xl"
            style={{
              background:
                "linear-gradient(180deg, rgba(60,240,180,0) 0%, rgba(60,240,180,.45) 38%, rgba(120,110,255,.35) 72%, rgba(0,0,0,0) 100%)",
            }}
          />
          <p className="text-[11px] uppercase tracking-[0.42em] text-emerald-200/70 mb-3">
            The vibeverse
          </p>
          <h1 className="font-heading text-4xl sm:text-6xl text-white tracking-tight">
            The Glass Lake
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-300/85">
            Black ice, a hundred and ninety metres of it, under an aurora that
            answers. Twelve shards of it fell. Skate them down — every one you
            take opens the sky further, and the lake shows you what you did.
          </p>
          <button
            onClick={start}
            disabled={booting}
            className="mt-8 rounded-full border border-emerald-300/50 bg-emerald-400/10 px-8 py-3 text-sm font-semibold text-emerald-100 shadow-[0_0_40px_rgba(60,240,180,0.35)] transition-colors hover:bg-emerald-400/20 disabled:opacity-60"
          >
            {booting ? "Freezing the lake…" : "Step onto the ice"}
          </button>
          <p className="mt-5 text-[11px] text-slate-400/80">
            {isTouch ? "Stick to skate · tap ⤴ to hop" : "WASD to skate · Shift to push · Space to hop · drag to look"}
          </p>
          <Link
            to="/"
            className="mt-8 text-xs text-slate-400/70 underline-offset-4 hover:text-slate-200 hover:underline"
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
              fullscreen world. Sitting under it keeps the exit where a
              visitor already knows to look. */}
          <div className="pointer-events-none absolute left-3 top-16 z-10 flex flex-col gap-2">
            <div className="rounded-2xl border border-white/10 bg-black/35 px-3 py-2 backdrop-blur-md">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-emerald-200/80">
                <span>Shards</span>
                <span className="font-mono text-white">
                  {state.shards}/{state.total}
                </span>
              </div>
              <div className="mt-1.5 h-1 w-36 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-300 to-violet-400 transition-[width] duration-500"
                  style={{ width: `${pct * 100}%` }}
                />
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/35 px-3 py-1.5 font-mono text-[11px] text-slate-200/90 backdrop-blur-md">
              {state.speed.toFixed(0).padStart(2, "0")} m/s
              {state.nearest !== Infinity && (
                <span className="ml-3 text-emerald-200/80">◈ {state.nearest.toFixed(0)} m</span>
              )}
            </div>
          </div>

          <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
            <button
              onClick={toggleMute}
              className="rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs text-slate-200 backdrop-blur-md transition-colors hover:bg-black/55"
            >
              {muted ? "🔇" : "🔊"}
            </button>
            <button
              onClick={() => worldRef.current?.restart()}
              className="rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs text-slate-200 backdrop-blur-md transition-colors hover:bg-black/55"
            >
              ↺ New night
            </button>
          </div>

          {/* The finale. The sky has already said it; this only names it. */}
          {state.complete && (
            <div className="pointer-events-none absolute inset-x-0 top-1/4 z-10 flex justify-center px-6 animate-fade-in">
              <div className="rounded-2xl border border-violet-300/40 bg-black/45 px-6 py-4 text-center backdrop-blur-md shadow-[0_0_50px_rgba(150,120,255,0.4)]">
                <div className="font-heading text-xl text-violet-100">The sky is whole</div>
                <div className="mt-1 text-xs text-slate-300/85">
                  Every shard is back where it fell from. Skate as long as you like.
                </div>
              </div>
            </div>
          )}

          {/* ---- Touch controls ---------------------------------------- */}
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
                  className="pointer-events-none absolute left-1/2 top-1/2 h-14 w-14 rounded-full border border-emerald-200/50 bg-emerald-300/20"
                  style={{
                    transform: `translate(calc(-50% + ${knob.x * 34}px), calc(-50% + ${knob.y * 34}px))`,
                    opacity: knob.active ? 1 : 0.6,
                  }}
                />
              </div>
              <button
                onPointerDown={() => worldRef.current?.hop()}
                className="absolute bottom-12 right-8 z-10 h-20 w-20 rounded-full border border-white/15 bg-black/30 text-2xl text-emerald-100 backdrop-blur-sm active:bg-emerald-400/20"
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
