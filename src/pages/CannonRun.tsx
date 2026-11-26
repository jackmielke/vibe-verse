/**
 * /cannon-run: a night chase down a desert highway. You ride in the bed of a
 * pickup behind an old ship's cannon, looking back over the tailgate at Mad
 * Mort, who wants it back. The game is in src/cannonrun; this page is the
 * door, the HUD and the phone controls.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Joystick } from "@/magician/ui/Joystick";
import type { CannonRun as Game, ChaseHud } from "@/cannonrun/engine";

type Phase = "splash" | "loading" | "playing" | "failed";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export default function CannonRun() {
  const mountRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [phase, setPhase] = useState<Phase>(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("go") ? "loading" : "splash",
  );
  const [hud, setHud] = useState<ChaseHud | null>(null);
  const [muted, setMuted] = useState(false);
  const [phone] = useState(() => typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches ?? false));
  const bare = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("shot");

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    if (phase !== "loading") return;
    let game: Game | null = null;
    let cancelled = false;
    const t = window.setTimeout(() => {
      void import("@/cannonrun/engine").then(({ createCannonRun }) => {
        if (cancelled || !mountRef.current) return;
        try {
          game = createCannonRun(mountRef.current, { onHud: setHud, onReady: () => setPhase("playing") });
          gameRef.current = game;
        } catch (e) {
          console.error(e);
          setPhase("failed");
        }
      }).catch((e) => { console.error(e); setPhase("failed"); });
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      game?.dispose();
      gameRef.current = null;
    };
    // Mount once; the phase only moves forward from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase === "loading" || phase === "playing"]);

  const onStick = useCallback((x: number, y: number) => gameRef.current?.setStick(x, y), []);

  const card = "rounded-xl bg-black/55 ring-1 ring-white/10 backdrop-blur-sm";
  const over = hud?.phase === "over";

  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-[#0b0f1c] text-white" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      <div ref={mountRef} className="absolute inset-0" />

      {phase === "playing" && hud && !bare ? (
        <>
          {/* Top left: your truck. */}
          <div className={`pointer-events-none absolute ${card} px-3 py-2`} style={{ left: "max(env(safe-area-inset-left), 12px)", top: "max(env(safe-area-inset-top), 60px)", minWidth: 150 }}>
            <div className="text-[22px] font-semibold leading-none tracking-tight text-[#ffd36a]" style={{ fontFamily: MONO }}>
              {hud.score.toLocaleString()}
            </div>
            <div className="mt-1 text-[10px] text-white/45" style={{ fontFamily: MONO }}>
              {(hud.meters / 1000).toFixed(1)} km · best {hud.best.toLocaleString()}
            </div>
            <Bar label="TRUCK" value={hud.hull / 100} color={hud.hull > 35 ? "#4de0a8" : "#ff5a4a"} />
            <Bar label="NITRO" value={hud.boost} color="#5ab4ff" />
            <Bar label="CANNON" value={hud.reload} color={hud.reload >= 1 ? "#ffd36a" : "#8a7a5a"} />
          </div>

          {/* Top centre: him. */}
          <div
            className={`pointer-events-none absolute flex flex-col gap-2 ${phone ? "right-3 items-end" : "inset-x-0 items-center px-3"}`}
            style={{ top: "max(env(safe-area-inset-top), 14px)" }}
          >
            <div className={`${card} px-3 py-1.5 text-center`}>
              <div className="text-[11px] font-bold tracking-[0.18em] text-[#ff7a5a]">
                MAD MORT{phone ? null : <span className="font-medium tracking-normal text-white/60"> in {hud.ride}</span>}
              </div>
              <div className="mt-1 flex max-w-[180px] flex-wrap justify-center gap-1">
                {Array.from({ length: hud.foeMax }, (_, i) => (
                  <span key={i} className="h-2 w-3.5 rounded-sm" style={{ background: i < hud.foeHp ? "#ff5a3a" : "rgba(255,255,255,0.14)" }} />
                ))}
              </div>
              <div className="mt-1 text-[10px] text-white/45" style={{ fontFamily: MONO }}>
                {hud.foeWrecked ? "wrecked, for now" : `${Math.max(0, hud.gap)} m behind`}
              </div>
            </div>
            {hud.toast ? <div style={phone ? { position: "fixed", left: 12, right: 12, top: 262 } : undefined} className="rounded-full bg-white px-4 py-1.5 text-center text-[13px] font-semibold text-black shadow-lg">{hud.toast}</div> : null}
          </div>

          {!phone && hud.phase !== "over" ? (
            <div className={`pointer-events-none absolute left-1/2 -translate-x-1/2 ${card} px-4 py-2 text-center text-[11px] text-white/70`} style={{ bottom: "max(env(safe-area-inset-bottom), 16px)" }}>
              Click the road to fire · A / D to swerve · Shift for nitro · shoot what he throws
            </div>
          ) : null}

          <div className="absolute flex gap-2" style={{ left: "max(env(safe-area-inset-left), 12px)", bottom: phone ? undefined : "max(env(safe-area-inset-bottom), 16px)", top: phone ? 214 : undefined }}>
            <button className={`${card} px-2.5 py-1.5 text-[12px]`} onClick={() => { const m = !muted; setMuted(m); gameRef.current?.setMuted(m); }}>
              {muted ? "🔇" : "🔊"}
            </button>
          </div>

          {phone && !over ? (
            <>
              {/* Tap anywhere above the stick to aim there and fire. */}
              <div
                className="absolute inset-0"
                style={{ touchAction: "none" }}
                onPointerDown={(e) => { if (e.pointerType !== "mouse") gameRef.current?.aimAt(e.clientX, e.clientY, true); }}
              />
              <div className="absolute" style={{ left: "max(env(safe-area-inset-left), 22px)", bottom: "max(env(safe-area-inset-bottom), 26px)" }}>
                <Joystick onMove={onStick} size={124} />
              </div>
              <button
                className="absolute flex h-20 w-20 items-center justify-center rounded-full bg-[#5ab4ff]/30 text-[13px] font-bold ring-2 ring-[#5ab4ff]/60"
                style={{ right: "max(env(safe-area-inset-right), 22px)", bottom: "max(env(safe-area-inset-bottom), 30px)", touchAction: "none" }}
                onPointerDown={(e) => { e.stopPropagation(); gameRef.current?.hold("boost", true); }}
                onPointerUp={() => gameRef.current?.hold("boost", false)}
                onPointerCancel={() => gameRef.current?.hold("boost", false)}
              >
                NITRO
              </button>
            </>
          ) : null}

          {over ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/45 px-6">
              <div className="w-full max-w-sm rounded-2xl bg-[#121728]/95 p-6 text-center ring-1 ring-white/10">
                <div className="text-[12px] font-bold tracking-[0.22em] text-[#ff7a5a]">HE GOT YOU</div>
                <div className="mt-2 text-4xl font-semibold" style={{ fontFamily: MONO }}>{hud.score.toLocaleString()}</div>
                <div className="mt-2 text-[13px] text-white/60">
                  {(hud.meters / 1000).toFixed(2)} km · {hud.hits} hits · {hud.wrecks} {hud.wrecks === 1 ? "truck" : "trucks"} wrecked
                </div>
                {hud.score >= hud.best && hud.score > 0 ? <div className="mt-2 text-[13px] font-semibold text-[#ffd36a]">New best!</div> : <div className="mt-2 text-[12px] text-white/40">Best {hud.best.toLocaleString()}</div>}
                <div className="mt-5 flex justify-center gap-2">
                  <button className="rounded-full bg-[#ffd36a] px-5 py-2 text-[14px] font-semibold text-black" onClick={() => gameRef.current?.restart()}>
                    Again
                  </button>
                  <Link to="/" className="rounded-full bg-white/10 px-5 py-2 text-[14px] font-semibold">Hub</Link>
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {phase === "splash" ? (
        <div className="absolute inset-0 flex items-center justify-center px-6" style={{ background: "radial-gradient(ellipse at 50% 70%, #3a2a1c 0%, #0b0f1c 65%)" }}>
          <div className="max-w-md text-center">
            <div className="text-6xl">💣🛻</div>
            <h1 className="mt-4 text-4xl font-bold tracking-tight">Cannon Run</h1>
            <p className="mt-3 text-[15px] leading-relaxed text-white/70">
              Midnight, a desert highway, and an old ship's cannon bolted into the bed of your pickup. Mad Mort says it's his. His headlights are right behind you.
            </p>
            <p className="mt-3 text-[13px] text-white/45">
              {phone ? "Tap the road to fire. Stick to swerve. Hold nitro to pull away." : "Click the road to fire. A and D to swerve. Shift for nitro."}
            </p>
            <div className="mt-6 flex justify-center gap-2">
              <button className="rounded-full bg-[#ffd36a] px-6 py-2.5 text-[15px] font-semibold text-black" onClick={() => setPhase("loading")}>
                Light the fuse
              </button>
              <Link to="/" className="rounded-full bg-white/10 px-5 py-2.5 text-[15px] font-semibold">Hub</Link>
            </div>
          </div>
        </div>
      ) : null}

      {phase === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center text-[13px] tracking-[0.2em] text-white/50">STARTING THE ENGINE…</div>
      ) : null}

      {phase === "failed" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="text-[15px] text-white/70">The truck would not start on this device (WebGL failed to load).</div>
          <Link to="/" className="rounded-full bg-white/10 px-5 py-2 text-[14px] font-semibold">Back to the hub</Link>
        </div>
      ) : null}
    </div>
  );
}

function Bar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="mt-2">
      <div className="text-[9px] font-bold tracking-[0.2em] text-white/50">{label}</div>
      <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full transition-[width] duration-100" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color }} />
      </div>
    </div>
  );
}
