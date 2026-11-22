/**
 * /fogcity: an open-world San Francisco you can walk and drive, built to run
 * fast first. The game is in src/fogcity; this page is the door, the HUD and
 * the phone controls.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Joystick } from "@/magician/ui/Joystick";
import type { FogCity as Game, FogHud } from "@/fogcity/engine";

type Phase = "splash" | "loading" | "playing" | "failed";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export default function FogCity() {
  const mountRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [phase, setPhase] = useState<Phase>(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("go") ? "loading" : "splash",
  );
  const [hud, setHud] = useState<FogHud | null>(null);
  const [muted, setMuted] = useState(false);
  const [help, setHelp] = useState(true);
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
    // Let the loading screen paint before the city is built under it.
    const t = window.setTimeout(() => {
      void import("@/fogcity/engine").then(({ createFogCity }) => {
        if (cancelled || !mountRef.current) return;
        try {
          game = createFogCity(mountRef.current, { onHud: setHud, onReady: () => setPhase("playing") });
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

  // The map is drawn by the game, a few times a second, with the HUD.
  useEffect(() => {
    const c = mapRef.current;
    const ctx = c?.getContext("2d");
    if (c && ctx && gameRef.current) gameRef.current.drawMap(ctx, c.width);
  }, [hud]);

  useEffect(() => {
    if (phase !== "playing") return;
    const t = window.setTimeout(() => setHelp(false), 14000);
    return () => window.clearTimeout(t);
  }, [phase]);

  const onStick = useCallback((x: number, y: number) => gameRef.current?.setStick(x, y), []);

  // Right half of a phone screen: drag to look.
  const lookId = useRef<number | null>(null);
  const lookAt = useRef({ x: 0, y: 0 });
  const lookDown = (e: React.PointerEvent) => {
    if (lookId.current !== null) return;
    lookId.current = e.pointerId;
    lookAt.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const lookMove = (e: React.PointerEvent) => {
    if (lookId.current !== e.pointerId) return;
    gameRef.current?.look((e.clientX - lookAt.current.x) * 1.6, (e.clientY - lookAt.current.y) * 1.6);
    lookAt.current = { x: e.clientX, y: e.clientY };
  };
  const lookUp = (e: React.PointerEvent) => { if (lookId.current === e.pointerId) lookId.current = null; };

  const driving = hud?.speed !== null && hud?.speed !== undefined;
  const heat = hud ? Math.ceil(hud.heat) : 0;
  const card = "rounded-xl bg-black/55 ring-1 ring-white/10 backdrop-blur-sm";

  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-[#0d1218] text-white" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      <div ref={mountRef} className="absolute inset-0" />

      {phase === "playing" && hud && !bare ? (
        <>
          {/* Top left: money, heat, the clock. */}
          <div
            className={`pointer-events-none absolute ${card} px-3 py-2`}
            style={{ left: "max(env(safe-area-inset-left), 12px)", top: "max(env(safe-area-inset-top), 60px)" }}
          >
            <div className="text-[22px] font-semibold leading-none tracking-tight text-[#8ff0b4]" style={{ fontFamily: MONO }}>
              ${hud.cash.toLocaleString()}
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              <span className="text-[9px] font-bold tracking-[0.22em] text-white/50">HEAT</span>
              {[1, 2, 3, 4, 5].map((n) => (
                <span
                  key={n}
                  className="h-2.5 w-4 rounded-sm transition-colors"
                  style={{ background: n <= heat ? (n > 3 ? "#ff3d2e" : "#ff9a2e") : "rgba(255,255,255,0.14)" }}
                />
              ))}
            </div>
            <div className="mt-1.5 text-[10px] text-white/45" style={{ fontFamily: MONO }}>
              {hud.clock} · {hud.found}/{hud.places} found
            </div>
          </div>

          {/* Top right: the map. North is up. */}
          <div
            className="pointer-events-none absolute overflow-hidden rounded-2xl ring-2 ring-white/15"
            style={{ right: "max(env(safe-area-inset-right), 12px)", top: "max(env(safe-area-inset-top), 12px)", width: phone ? 118 : 172, height: phone ? 118 : 172 }}
          >
            <canvas ref={mapRef} width={172} height={172} className="h-full w-full" />
            <div className="absolute left-1/2 top-1 -translate-x-1/2 text-[9px] font-bold text-white/70">N</div>
          </div>

          {/* The job, and whatever just happened. */}
          <div className="pointer-events-none absolute inset-x-0 flex flex-col items-center gap-2 px-3" style={{ top: "max(env(safe-area-inset-top), 14px)" }}>
            <div className={`${card} max-w-[60vw] px-3 py-1.5 text-center text-[12px] text-white/85`}>
              {hud.job}
              {hud.jobTime !== null ? (
                <span className="ml-2 font-semibold" style={{ fontFamily: MONO, color: hud.jobTime < 15 ? "#ff6b5a" : "#4de0a8" }}>
                  {Math.max(0, Math.ceil(hud.jobTime))}s
                </span>
              ) : null}
            </div>
            {hud.toast ? (
              <div className="rounded-full bg-white px-4 py-1.5 text-[13px] font-semibold text-black shadow-lg">{hud.toast}</div>
            ) : null}
          </div>

          {/* Bottom: the prompt, and the speed when there is one. */}
          <div className="pointer-events-none absolute inset-x-0 flex flex-col items-center gap-2" style={{ bottom: "max(env(safe-area-inset-bottom), 18px)" }}>
            {hud.prompt && !phone ? <div className={`${card} px-3 py-1.5 text-[13px] font-medium`}>{hud.prompt}</div> : null}
            {help && !phone ? (
              <div className={`${card} mx-4 px-4 py-2 text-center text-[11px] leading-relaxed text-white/70`}>
                Click to look · WASD to move · Shift to run · Space to jump or brake · F to get in and out · T skips time · G brings the fog · R if you get stuck
              </div>
            ) : null}
          </div>
          {driving ? (
            <div
              className={`pointer-events-none absolute ${card} px-3 py-1.5 text-right`}
              style={{ right: "max(env(safe-area-inset-right), 12px)", bottom: phone ? 150 : "max(env(safe-area-inset-bottom), 18px)" }}
            >
              <span className="text-[26px] font-semibold leading-none" style={{ fontFamily: MONO }}>{Math.round(hud.speed ?? 0)}</span>
              <span className="ml-1 text-[10px] text-white/50">km/h</span>
            </div>
          ) : null}

          {/* Small buttons under the hub's home button. */}
          <div className="absolute flex gap-2" style={{ left: "max(env(safe-area-inset-left), 12px)", bottom: phone ? undefined : "max(env(safe-area-inset-bottom), 18px)", top: phone ? 150 : undefined }}>
            <button
              className={`${card} px-2.5 py-1.5 text-[12px]`}
              onClick={() => { const m = !muted; setMuted(m); gameRef.current?.setMuted(m); }}
            >
              {muted ? "🔇" : "🔊"}
            </button>
            {phone ? (
              <>
                <button className={`${card} px-2.5 py-1.5 text-[12px]`} onClick={() => gameRef.current?.press("time")}>🕒</button>
                <button className={`${card} px-2.5 py-1.5 text-[12px]`} onClick={() => gameRef.current?.press("fog")}>🌫</button>
                <button className={`${card} px-2.5 py-1.5 text-[12px]`} onClick={() => gameRef.current?.press("reset")}>↺</button>
              </>
            ) : null}
          </div>

          {phone ? (
            <>
              <div
                className="absolute bottom-0 right-0 top-0 w-1/2"
                style={{ touchAction: "none" }}
                onPointerDown={lookDown}
                onPointerMove={lookMove}
                onPointerUp={lookUp}
                onPointerCancel={lookUp}
              />
              <div className="absolute" style={{ left: "max(env(safe-area-inset-left), 22px)", bottom: "max(env(safe-area-inset-bottom), 26px)" }}>
                <Joystick onMove={onStick} size={124} />
              </div>
              <div className="absolute flex flex-col items-end gap-3" style={{ right: "max(env(safe-area-inset-right), 18px)", bottom: "max(env(safe-area-inset-bottom), 26px)" }}>
                {hud.prompt || driving ? (
                  <button
                    className="h-14 rounded-full bg-[#ffc83d] px-5 text-[13px] font-bold text-black shadow-lg active:scale-95"
                    onClick={() => gameRef.current?.press("use")}
                  >
                    {driving ? "GET OUT" : "DRIVE"}
                  </button>
                ) : null}
                <button
                  className="h-16 w-16 rounded-full bg-white/20 text-[12px] font-bold ring-1 ring-white/30 backdrop-blur-sm active:bg-white/40"
                  style={{ touchAction: "none" }}
                  onPointerDown={() => { if (driving) gameRef.current?.hold("brake", true); else gameRef.current?.press("jump"); }}
                  onPointerUp={() => gameRef.current?.hold("brake", false)}
                  onPointerCancel={() => gameRef.current?.hold("brake", false)}
                >
                  {driving ? "BRAKE" : "JUMP"}
                </button>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {phase === "splash" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center" style={{ background: "linear-gradient(180deg, #23344a 0%, #c9785a 62%, #f1c08a 100%)" }}>
          <div className="text-[11px] font-bold tracking-[0.5em] text-white/70">SAN FRANCISCO</div>
          <h1 className="mt-2 text-[64px] font-black leading-none tracking-tight sm:text-[104px]" style={{ textShadow: "0 6px 0 rgba(0,0,0,0.25)" }}>
            FOG CITY
          </h1>
          <p className="mt-4 max-w-md text-[14px] leading-relaxed text-white/85">
            Seven hills, a grid of steep streets, a bridge and a bay. Borrow a car, run packages across town, and try not to make the evening news.
          </p>
          <button
            className="mt-8 rounded-full bg-white px-10 py-3.5 text-[15px] font-bold text-black shadow-xl transition-transform hover:scale-105 active:scale-95"
            onClick={() => setPhase("loading")}
          >
            Play
          </button>
          <Link to="/" className="mt-5 text-[12px] text-white/70 underline-offset-4 hover:underline">Back to the Vibeverse</Link>
        </div>
      ) : null}

      {phase === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#16202c] text-[13px] tracking-[0.3em] text-white/70">BUILDING THE CITY</div>
      ) : null}

      {phase === "failed" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#16202c] px-6 text-center">
          <p className="max-w-sm text-[14px] text-white/80">Fog City could not start on this device. It needs WebGL, which this browser has switched off or does not have.</p>
          <Link to="/" className="rounded-full bg-white px-6 py-2 text-[13px] font-semibold text-black">Back to the Vibeverse</Link>
        </div>
      ) : null}
    </div>
  );
}
